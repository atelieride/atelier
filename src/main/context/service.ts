import { lstatSync, realpathSync } from 'node:fs';
import { join, relative, sep, toOut } from '../cpath';
import { contextArgs, contextModel, parseContextUsage, type ContextProgress, type ContextResult } from '@shared/context-usage';
import { homeLabel } from '@shared/files';
import type { TerminalInfo } from '@shared/protocol';
import { sessionTranscript, transcriptTail } from '../claude-history';
import { polishEnv } from '../dictation/polish';
import { insideProject, terminalCwd } from '../fs/files';
import { runProbe } from './probe';

// Context usage: which session to copy, where, as which account and with
// which environment; the last report per terminal (the files the view may open); one run per terminal at a time.

export interface ContextDeps {
  /** A terminal atelierd lists, any project; null otherwise. */
  terminal(id: string): TerminalInfo | null;
  /** The terminal's configured account's launch dir; undefined for the default account (never named explicitly). */
  accountDir(project: string, terminalId: string): string | undefined;
  /** Whether a config dir is the default account's (a session on a dir that is neither that nor an account is refused). */
  isDefaultDir(dir: string): boolean;
  claudeBin(): string | null;
  /** The user's shell environment (git writes' capture), or the app's with the common PATH folders. */
  userEnv(): Promise<NodeJS.ProcessEnv>;
  /** The account's `.claude.json` (undefined: the default account's). */
  globalFile(dir: string | undefined): string;
  /** Grants a file outside the project read-only to it: its real path, null when refused. */
  grant(project: string, path: string): string | null;
  home: string;
  now(): number;
  run?: typeof runProbe;
  transcript?: typeof sessionTranscript;
  tail?: typeof transcriptTail;
}

interface Running { sessionId: string; ac: AbortController; promise: Promise<ContextResult> }

const regularFile = (p: string): string | null => { try { return lstatSync(p).isFile() ? p : null; } catch { return null; } };

export class ContextService {
  private readonly running = new Map<string, Running>();
  /** Per terminal: the session its last report is of, and the files that report lets the view open. */
  private readonly last = new Map<string, { sessionId: string; files: Set<string> }>();

  constructor(private readonly deps: ContextDeps) {}

  /** The terminal, when it belongs to the project and runs a Claude session now. */
  private live_(project: string, terminalId: string): TerminalInfo | null {
    const t = this.deps.terminal(terminalId);
    return t && t.projectRoot === project && t.session ? t : null;
  }

  /**
   * Analyses the session. A request while the same session is being analysed joins that run (its progress
   * goes to the first asker only); one for another session in the terminal stops the old run first.
   */
  analyze(project: string, terminalId: string, onProgress?: (p: ContextProgress) => void): Promise<ContextResult> {
    this.prune();
    const term = this.live_(project, terminalId);
    if (!term) return Promise.resolve({ ok: false, kind: 'no-session', message: 'This terminal runs no Claude session' });
    const sessionId = term.session!.sessionId;
    const now = this.running.get(terminalId);
    if (now && now.sessionId === sessionId) return now.promise;
    now?.ac.abort();
    const ac = new AbortController();
    const entry: Running = { sessionId, ac, promise: Promise.resolve({ ok: false, kind: 'exit', message: 'Stopped' }) };
    entry.promise = this.run(project, term, ac.signal, onProgress).finally(() => {
      if (this.running.get(terminalId) === entry) this.running.delete(terminalId);
    });
    this.running.set(terminalId, entry);
    return entry.promise;
  }

  private transcriptOf(project: string, term: TerminalInfo, account: string | undefined): string | null {
    const start = term.session!.cwd ?? term.cwd;
    return (this.deps.transcript ?? sessionTranscript)({ sessionId: term.session!.sessionId, cwd: start, configDir: account ?? null }, [project, start]);
  }

  private async run(project: string, term: TerminalInfo, signal: AbortSignal, onProgress?: (p: ContextProgress) => void): Promise<ContextResult> {
    const claudeBin = this.deps.claudeBin();
    if (!claudeBin) return { ok: false, kind: 'not-found', message: 'Claude Code was not found' };
    const session = term.session!;
    const account = this.deps.accountDir(project, term.id);
    // A session on a dir that is no configured account and not the default one: its transcript, MCP servers and
    // memory are elsewhere — refused, never analysed as the default account's.
    if (account === undefined && term.configDir && !this.deps.isDefaultDir(term.configDir)) {
      return { ok: false, kind: 'account', message: "This session runs on a Claude account Atelier doesn't know" };
    }
    const transcript = this.transcriptOf(project, term, account);
    const tail = transcript ? await (this.deps.tail ?? transcriptTail)(transcript) : null;
    // Where the session is now: the transcript's last folder when inside the project, else where it started.
    const cwd = [tail?.cwd, session.cwd, term.cwd].map((c) => (c ? terminalCwd(project, c) : null)).find((c): c is string => c !== null) ?? null;
    if (cwd === null) return { ok: false, kind: 'no-session', message: "The session's folder isn't there any more" };

    // The user's shell environment (stdio MCP servers need its PATH); its CLAUDE_CONFIG_DIR never stands for the
    // default account, another account's dir is set explicitly.
    const shell = { ...(await this.deps.userEnv()) };
    delete shell.CLAUDE_CONFIG_DIR;
    const env = { ...polishEnv(claudeBin, shell, account), CLAUDE_CODE_ENTRYPOINT: 'atelier-context' };
    const args = contextArgs({ resume: tail ? session.sessionId : null, model: contextModel(session.model) });
    if (signal.aborted) return { ok: false, kind: 'exit', message: 'Stopped' };
    const out = await (this.deps.run ?? runProbe)({ claudeBin, args, cwd, env, signal, onProgress: (p) => onProgress?.({ terminalId: term.id, ...p }) });
    if (!out.ok) return out;
    const report = parseContextUsage(out.usage, out.status, this.deps.now());
    if (!report) return { ok: false, kind: 'unsupported', message: "Claude Code's answer couldn't be read" };
    report.resumed = tail !== null;

    // The file that sets up each server, when Atelier can tell; only those and the memory files may open.
    const globalFile = regularFile(this.deps.globalFile(account));
    const mcpFile = regularFile(join(cwd, '.mcp.json'));
    for (const s of report.servers) {
      s.configFile = s.scope === 'project' ? mcpFile : s.scope === 'user' || s.scope === 'local' ? globalFile : null;
      s.configShown = s.configFile ? homeLabel(s.configFile, this.deps.home) : null;
    }
    for (const m of report.memory) m.shown = homeLabel(m.path, this.deps.home);
    const files = new Set<string>([...report.memory.map((m) => m.path), ...report.servers.flatMap((s) => (s.configFile ? [s.configFile] : []))]);
    this.last.set(term.id, { sessionId: session.sessionId, files });
    return { ok: true, report };
  }

  /** The transcript's last reply's input, for counting what came after the analysis; null when unknown. */
  async live(project: string, terminalId: string): Promise<number | null> {
    const term = this.live_(project, terminalId);
    if (!term) return null;
    const transcript = this.transcriptOf(project, term, this.deps.accountDir(project, terminalId));
    if (!transcript) return null;
    return (await (this.deps.tail ?? transcriptTail)(transcript))?.usage ?? null;
  }

  /**
   * A file the terminal's last report listed, a regular file now (never a link): inside the project as it is,
   * outside granted read-only to the project. Null for anything else.
   */
  open(project: string, terminalId: string, path: string): { path: string; rel: string } | null {
    this.prune();
    const term = this.live_(project, terminalId);
    const last = this.last.get(terminalId);
    if (!term || !last || last.sessionId !== term.session!.sessionId || !last.files.has(path) || !regularFile(path)) return null;
    const inside = insideProject(project, path);
    if (inside) {
      let root = project;
      try { root = toOut(realpathSync.native(project)); } catch { /* as spelled */ }
      return { path, rel: relative(root, inside).split(sep).join('/') };
    }
    const real = this.deps.grant(project, path);
    return real ? { path: real, rel: homeLabel(real, this.deps.home) } : null;
  }

  /** Reports kept for terminals still running the session they were made of: a closed terminal's go. */
  private prune(): void {
    for (const [id, r] of this.last) if (this.deps.terminal(id)?.session?.sessionId !== r.sessionId) this.last.delete(id);
  }

  /** How many reports are kept (tests). */
  reports(): number { this.prune(); return this.last.size; }

  /** Stops every run (the app quits). */
  dispose(): void {
    for (const r of this.running.values()) r.ac.abort();
    this.running.clear();
  }
}
