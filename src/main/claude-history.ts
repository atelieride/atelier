import { constants, lstatSync, readdirSync } from 'node:fs';
import { lstat, open, readdir, type FileHandle } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from './cpath';
import { HISTORY_ACTIVE_MS, HISTORY_LIMIT, SESSION_ID, encodeProjectPath, type ClaudeConversation } from '@shared/history';
import { isInside } from '@shared/paths';
import type { PathStyle } from '@shared/platform';
import { PROMPT_SKIP_PREFIXES, promptText } from '@shared/prompt-text';
import { redactSecrets } from '@shared/session';
import { devEnv } from './dev-env';
import { terminalCwd } from './fs/files';

// Claude Code's own conversation history: ~/.claude/projects/<encoded cwd>/<sessionId>.jsonl, read-only,
// only the folders of the open project, and only small reads (the head and the tail of each file).

const HEAD_BYTES = 64 * 1024;
const TAIL_BYTES = 32 * 1024;
/** How far the head is read on when the first prompt is in a line longer than it (an inline screenshot). */
const FIRST_PROMPT_MAX = 8 * 1024 * 1024;
const CHUNK = 256 * 1024;
const TITLE_MAX = 160;
const SESSION_FILE = /^(.+)\.jsonl$/;

export { encodeProjectPath };

/**
 * The history folders that may hold the project's conversations: those of the root and of its subfolders. The encoding
 * can't be decoded (a dash may have been anything), so the encoded roots are matched as prefixes; the cwd recorded in
 * each conversation decides in the end (a sibling folder "app-other" matches "app" here and is dropped there).
 */
export function projectFolders(names: string[], roots: string[]): string[] {
  const prefixes = [...new Set(roots.map(encodeProjectPath))];
  return names.filter((n) => prefixes.some((p) => n === p || n.startsWith(p + '-')));
}

/** ~/.claude/projects, or $CLAUDE_CONFIG_DIR/projects when the app's environment sets it. */
export function claudeProjectsDir(env: Record<string, string | undefined>, home: string): string {
  return join(env.CLAUDE_CONFIG_DIR || join(home, '.claude'), 'projects');
}

/** Where the history is read from; tests point it at a fake folder (never the user's ~/.claude). */
export function historyRoot(): string {
  return devEnv('ATELIER_TEST_CLAUDE_PROJECTS') ?? claudeProjectsDir(process.env, homedir());
}

type Entry = Record<string, unknown>;
const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();

export { promptText };

/**
 * A session's transcript, `<projects>/<encoded cwd>/<sessionId>.jsonl`: its account's dir, else the default projects
 * root the history reads. Only a valid session id, an absolute cwd and an absolute (or no) config dir make a path.
 */
export function transcriptFile(o: { sessionId: string; cwd: string; configDir: string | null }): string | null {
  const projects = projectsDirOf(o);
  return projects === null ? null : join(projects, encodeProjectPath(o.cwd), `${o.sessionId}.jsonl`);
}

function projectsDirOf(o: { sessionId: string; cwd: string; configDir: string | null }): string | null {
  if (!SESSION_ID.test(o.sessionId) || !isAbsolute(o.cwd) || (o.configDir !== null && !isAbsolute(o.configDir))) return null;
  return o.configDir !== null ? join(o.configDir, 'projects') : historyRoot();
}

const isRegularFile = (p: string) => { try { return lstatSync(p).isFile(); } catch { return false; } };

/**
 * Where the session's transcript is now. Claude Code moves a session's file into the folder of the worktree it enters
 * (EnterWorktree, `.claude/worktrees/<name>`), while the cwd its hooks first reported stays the folder it started in.
 * So: `transcriptFile`'s path when a regular file is there; else `<id>.jsonl` in another history folder of `roots`
 * (the project: its subfolders' folders too), the newest if several; else `transcriptFile`'s path all the same (a
 * session with no prompt yet has no file). Symlinks are never followed; null when the session makes no path.
 */
export function sessionTranscript(o: { sessionId: string; cwd: string; configDir: string | null }, roots: readonly string[]): string | null {
  const file = transcriptFile(o);
  if (file === null || isRegularFile(file)) return file;
  const projects = projectsDirOf(o)!;
  const own = encodeProjectPath(o.cwd);
  let folders: string[];
  try { folders = readdirSync(projects, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch { return file; }
  let best: { path: string; mtimeMs: number } | null = null;
  for (const folder of projectFolders(folders, [...roots])) {
    if (folder === own) continue;
    const path = join(projects, folder, `${o.sessionId}.jsonl`);
    try {
      const s = lstatSync(path);
      if (s.isFile() && (best === null || s.mtimeMs > best.mtimeMs)) best = { path, mtimeMs: s.mtimeMs };
    } catch { /* not in this folder */ }
  }
  return best?.path ?? file;
}

/** How much of a conversation's end `lastPrompts` reads. */
export const PROMPTS_TAIL_BYTES = 256 * 1024;
const LAST_PROMPT_MAX = 1536;

/**
 * A prompt the person typed, kept whole for ✦: a user entry with string content (array content
 * is tool results or pasted images), not meta or an agent's, and not a message Claude Code submits itself (commands,
 * task notifications, bash mode, caveats: they start with a tag or a fixed prefix). Lines kept, invisible characters
 * dropped, token-like runs redacted, cut to 1.5 KB.
 */
function typedPrompt(e: Entry): string | null {
  if (e.type !== 'user' || e.isMeta === true || e.isSidechain === true) return null;
  const content = (e.message as Entry | undefined)?.content;
  if (typeof content !== 'string') return null;
  const text = content.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim();
  if (!text || text.startsWith('<') || PROMPT_SKIP_PREFIXES.some((p) => text.startsWith(p))) return null;
  // Redacted before the cut, on a wider window, so a token is never cut into a piece too short to be recognised.
  const clean = redactSecrets(text.slice(0, 16 * 1024).replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, (c) => (c === '\n' ? c : ' ')));
  return [...clean].slice(0, LAST_PROMPT_MAX).join('').trim() || null;
}

/**
 * The last `n` prompts typed in a conversation, newest last, from at most its last 256 KB (a running session's file
 * too). Never through a symlink; a file that can't be read has none.
 */
export async function lastPrompts(file: string, n = 5): Promise<string[]> {
  const tail = await tailEntries(file);
  if (tail === null) return [];
  const prompts = tail.map(typedPrompt).filter((p): p is string => p !== null);
  return n > 0 ? prompts.slice(-n) : [];
}

/** The entries in a regular file's last 256 KB, never through a symlink; null when it can't be read. */
async function tailEntries(file: string): Promise<Entry[] | null> {
  let fh: FileHandle;
  try { fh = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW); } catch { return null; }
  try {
    const st = await fh.stat();
    if (!st.isFile()) return null;
    const start = Math.max(0, st.size - PROMPTS_TAIL_BYTES);
    // One byte before the tail tells whether it starts a line; a partial first line is dropped.
    const from = start > 0 ? start - 1 : 0;
    const b = Buffer.alloc(st.size - from);
    const r = await fh.read(b, 0, b.length, from);
    const buf = b.subarray(0, r.bytesRead);
    const text = start > 0 ? buf.subarray(1).toString('utf8') : buf.toString('utf8');
    return entries(text, start > 0 && buf[0] !== 10);
  } catch {
    return null;
  } finally {
    await fh.close();
  }
}

const tokens = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);

/**
 * Context usage, from the transcript's last 256 KB: the folder of its last
 * entry (where the session is now: EnterWorktree moves it; null when not an absolute path) and the input of the last
 * main-chain reply that has one (input + cache creation + cache read: the context Claude last sent). Null when the file
 * can't be read.
 */
export async function transcriptTail(file: string): Promise<{ cwd: string | null; usage: number | null } | null> {
  const tail = await tailEntries(file);
  if (tail === null) return null;
  let cwd: string | null = null;
  let usage: number | null = null;
  for (let i = tail.length - 1; i >= 0 && (cwd === null || usage === null); i--) {
    const e = tail[i]!;
    if (cwd === null && typeof e.cwd === 'string' && isAbsolute(e.cwd)) cwd = e.cwd;
    if (usage !== null || e.type !== 'assistant' || e.isSidechain === true) continue;
    const m = e.message;
    const u = m && typeof m === 'object' ? (m as Record<string, unknown>).usage : null;
    if (!u || typeof u !== 'object') continue;
    const r = u as Record<string, unknown>;
    const total = tokens(r.input_tokens) + tokens(r.cache_creation_input_tokens) + tokens(r.cache_read_input_tokens);
    if (total > 0) usage = total;
  }
  return { cwd, usage };
}

function entries(text: string, skipFirst: boolean): Entry[] {
  const lines = text.split('\n');
  if (skipFirst) lines.shift();
  const out: Entry[] = [];
  for (const l of lines) {
    if (!l.trim()) continue;
    try { const v = JSON.parse(l) as unknown; if (v && typeof v === 'object' && !Array.isArray(v)) out.push(v as Entry); } catch { /* partial or broken line */ }
  }
  return out;
}

const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v : null);

export interface ParsedConversation { cwd: string | null; prompt: string | null; title: string | null; branch: string | null; at: number | null }

/**
 * What a conversation shows, from the start of its file and (for a big file) its end. `tail` may start mid-line: a
 * first line that doesn't start an entry is skipped. `id` is the file's session id (null: not checked).
 */
export function parseConversation(head: string, tail: string, id: string | null = null): ParsedConversation {
  return fromEntries(entries(head, false), entries(tail, tail.length > 0 && !tail.startsWith('{')), tail.length > 0, id);
}

/**
 * The title as Claude's own /resume picker shows it: agent name, custom title (/rename, --name), AI title (generated
 * after the first prompt), Claude's summary of this conversation, then the first prompt; the last entry wins. Claude
 * Code writes summaries of the project's other conversations at the top of a file too, mapped by `leafUuid`: only a
 * summary whose leaf is an entry read here counts. With a tail, the last activity comes from the tail only (a head
 * timestamp of a big file is stale; none in the tail: null, the caller uses the mtime).
 */
function fromEntries(head: Entry[], tail: Entry[], hasTail: boolean, id: string | null): ParsedConversation {
  const all = [...head, ...tail];
  const uuids = new Set(all.map((e) => e.uuid).filter((u): u is string => typeof u === 'string'));
  let cwd: string | null = null;
  let prompt: string | null = null;
  let summary: string | null = null;
  let custom: string | null = null;
  let agent: string | null = null;
  let ai: string | null = null;
  let branch: string | null = null;
  for (const e of all) {
    const mine = id === null || e.sessionId === id;
    if (e.type === 'summary' && typeof e.leafUuid === 'string' && uuids.has(e.leafUuid)) summary = str(e.summary) ?? summary;
    if (e.type === 'custom-title' && mine) custom = str(e.customTitle) ?? custom;
    if (e.type === 'agent-name' && mine) agent = str(e.agentName) ?? agent;
    if (e.type === 'ai-title' && mine) ai = str(e.aiTitle) ?? ai;
    if (e.isSidechain === true) continue;
    if (cwd === null && str(e.cwd)) cwd = e.cwd as string;
    if (str(e.gitBranch)) branch = e.gitBranch as string;
    if (prompt === null) prompt = promptText(e);
  }
  let at: number | null = null;
  for (const e of hasTail ? tail : head) {
    if (e.isSidechain === true) continue;
    const ts = typeof e.timestamp === 'string' ? Date.parse(e.timestamp) : NaN;
    if (Number.isFinite(ts)) at = Math.max(at ?? 0, ts);
  }
  const title = agent ?? custom ?? ai ?? summary ?? prompt;
  return { cwd, prompt, title: title ? oneLine(title).slice(0, TITLE_MAX) : null, branch, at };
}

/**
 * Conversations not to offer: those running in an Atelier terminal, and those just resumed (sessionId → terminal id)
 * whose Claude hasn't reported its session yet. Resumes whose terminal is gone are forgotten.
 */
export function runningSessions(terminals: { id: string; session: { sessionId: string } | null }[], started: Map<string, string>): Set<string> {
  const ids = new Set(terminals.map((t) => t.id));
  for (const [sid, term] of started) if (!ids.has(term)) started.delete(sid);
  return new Set([...terminals.flatMap((t) => (t.session ? [t.session.sessionId] : [])), ...started.keys()]);
}

interface Cached { size: number; mtimeMs: number; parsed: ParsedConversation }
interface FileRef { path: string; id: string; size: number; mtimeMs: number; account: string }

/**
 * A conversation of Ask's own: its cwd is in Ask's folder (ATELIER_HOME/companion), which a
 * project may contain when it is a home folder. Windows: main's C:/… folder against the transcript's C:\… cwd, any case.
 */
export function isAskConversation(askDir: string | null, cwd: string, style?: PathStyle): boolean {
  return askDir !== null && isInside(askDir, cwd, style);
}

/** A Claude account's projects folder; the default account's comes first. */
export interface HistoryRoot { account: string; dir: string }
const DEFAULT_ACCOUNT = 'default';

export interface HistoryQuery {
  /** The window's project root and its real path. */
  root: string; realRoot: string;
  /** Session ids not to list (running in an Atelier terminal). */
  exclude: ReadonlySet<string>;
  limit?: number;
}

export class ClaudeHistory {
  private cache = new Map<string, Cached>();
  /** Bytes read from history files (for tests: a big file is never read whole, a cached one not at all). */
  bytesRead = 0;

  /** `roots`: the accounts' projects folders, the default first (a bare folder is the default account's alone). */
  constructor(
    private readonly roots: () => string | HistoryRoot[] = historyRoot,
    /** A folder whose conversations are never listed (Ask's own, in ATELIER_HOME/companion): null when none. */
    private readonly exclude: () => string | null = () => null,
  ) {}

  private rootList(): HistoryRoot[] {
    const r = this.roots();
    return typeof r === 'string' ? [{ account: DEFAULT_ACCOUNT, dir: r }] : r;
  }

  async list(q: HistoryQuery): Promise<ClaudeConversation[]> {
    const limit = q.limit ?? HISTORY_LIMIT;
    const out: ClaudeConversation[] = [];
    const seen = new Set<string>();
    const now = Date.now();
    for (const f of await this.files(q)) {
      if (out.length >= limit) break;
      if (seen.has(f.id)) continue;
      const c = await this.conversation(q, f, now);
      if (!c) continue;
      seen.add(f.id);
      out.push(c);
    }
    if (this.cache.size > 5000) this.cache.clear();
    return out;
  }

  /**
   * A conversation the list would show for this project, or null: what the renderer asks to resume is checked here.
   * Only `<folder>/<id>.jsonl` of the project's folders is looked at (same checks as the list).
   */
  async find(q: HistoryQuery, sessionId: string, account: string = DEFAULT_ACCOUNT): Promise<ClaudeConversation | null> {
    if (!SESSION_ID.test(sessionId)) return null;
    const now = Date.now();
    for (const f of await this.files(q, sessionId, account)) {
      const c = await this.conversation(q, f, now);
      if (c) return c;
    }
    return null;
  }

  /**
   * Whether this session has a conversation in the project, in any account, running or not (the query's exclusion is
   * ignored): closing a session resumed in place keeps it under Resume.
   */
  async hasConversation(q: HistoryQuery, sessionId: string): Promise<boolean> {
    if (!SESSION_ID.test(sessionId)) return false;
    const all = { ...q, exclude: new Set<string>() };
    const now = Date.now();
    for (const f of await this.files(all, sessionId)) if (await this.conversation(all, f, now)) return true;
    return false;
  }

  /**
   * The project's conversation files (all, or only `<id>.jsonl` of one account), newest first, across the accounts. A
   * session id found in an earlier account (the default first) is not taken again from a later one.
   */
  private async files(q: HistoryQuery, only?: string, account?: string): Promise<FileRef[]> {
    const out: FileRef[] = [];
    const taken = new Set<string>();
    for (const r of this.rootList()) {
      if (account !== undefined && r.account !== account) continue;
      const mine = (await this.filesIn(r, q, only)).filter((f) => !taken.has(f.id));
      for (const f of mine) { taken.add(f.id); out.push(f); }
    }
    return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  }

  /**
   * One account's conversation files of the project. Symlinks under the projects root are never followed: real
   * folders and regular files only. A folder that can't be read (an account never used here) has none.
   */
  private async filesIn(root: HistoryRoot, q: HistoryQuery, only?: string): Promise<FileRef[]> {
    const dir = root.dir;
    let folders: string[];
    try { folders = (await readdir(dir, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name); } catch { return []; }
    const out: FileRef[] = [];
    for (const folder of projectFolders(folders, [q.root, q.realRoot])) {
      let names: string[];
      if (only !== undefined) names = [`${only}.jsonl`];
      else {
        try { names = (await readdir(join(dir, folder), { withFileTypes: true })).filter((d) => d.isFile()).map((d) => d.name); } catch { continue; }
      }
      for (const n of names) {
        const id = SESSION_FILE.exec(n)?.[1];
        if (!id || !SESSION_ID.test(id) || q.exclude.has(id)) continue;
        try {
          const s = await lstat(join(dir, folder, n));
          if (s.isFile()) out.push({ path: join(dir, folder, n), id, size: s.size, mtimeMs: s.mtimeMs, account: root.account });
        } catch { /* missing, or gone meanwhile */ }
      }
    }
    return out;
  }

  private async conversation(q: HistoryQuery, f: FileRef, now: number): Promise<ClaudeConversation | null> {
    const p = await this.parsed(f);
    if (!p || !p.prompt || !p.cwd || !p.title) return null;
    if (isAskConversation(this.exclude(), p.cwd)) return null;
    // Inside the project's real root, still there, never inside .git. Canonical, as every path crossing IPC (the
    // transcript has Windows' C:\…: the palette's folder chip read apps\web/).
    const cwd = terminalCwd(q.realRoot, p.cwd);
    if (!cwd) return null;
    // A conversation written in the last minute is only marked (it may run outside Atelier), not hidden.
    return { sessionId: f.id, cwd, title: p.title, prompt: p.prompt, branch: p.branch, at: p.at ?? f.mtimeMs, active: f.mtimeMs > now - HISTORY_ACTIVE_MS, ...(f.account !== DEFAULT_ACCOUNT ? { account: f.account } : {}) };
  }

  private async read(fh: FileHandle, pos: number, len: number): Promise<Buffer> {
    const b = Buffer.alloc(len);
    const r = await fh.read(b, 0, len, pos);
    this.bytesRead += r.bytesRead;
    return b.subarray(0, r.bytesRead);
  }

  private async parsed(f: FileRef): Promise<ParsedConversation | null> {
    const hit = this.cache.get(f.path);
    if (hit && hit.size === f.size && hit.mtimeMs === f.mtimeMs) return hit.parsed;
    let fh: FileHandle;
    // Never through a symlink put there since the listing.
    try { fh = await open(f.path, constants.O_RDONLY | constants.O_NOFOLLOW); } catch { return null; }
    try {
      const head = await this.read(fh, 0, Math.min(f.size, HEAD_BYTES));
      let pos = head.length;
      let headEntries: Entry[];
      if (pos >= f.size) headEntries = entries(head.toString('utf8'), false);
      else {
        // A head cut mid-line just loses that line (it does not parse)…
        const complete = head.lastIndexOf(10) + 1;
        headEntries = entries(head.subarray(0, complete).toString('utf8'), false);
        // …unless no prompt came before it: the first prompt may be a line longer than the head (an inline
        // screenshot). So: read on to whole lines, up to 8 MB, and parse them as JSON; beyond, the tail decides.
        const parts = [head.subarray(complete)];
        while (!headEntries.some((e) => promptText(e) !== null) && pos < f.size && pos < FIRST_PROMPT_MAX) {
          const c = await this.read(fh, pos, Math.min(CHUNK, f.size - pos, FIRST_PROMPT_MAX - pos));
          if (c.length === 0) break;
          pos += c.length;
          const nl = c.lastIndexOf(10);
          if (nl < 0) { parts.push(c); continue; }
          parts.push(c.subarray(0, nl + 1));
          headEntries.push(...entries(Buffer.concat(parts).toString('utf8'), false));
          parts.length = 0;
          parts.push(c.subarray(nl + 1));
        }
        if (pos >= f.size) headEntries.push(...entries(Buffer.concat(parts).toString('utf8'), false));
      }
      let tailEntries: Entry[] = [];
      const start = Math.max(pos, f.size - TAIL_BYTES);
      if (start < f.size) {
        // One byte before the tail tells whether it starts a line; a partial first line is skipped.
        const t = await this.read(fh, start - 1, f.size - start + 1);
        tailEntries = entries(t.subarray(1).toString('utf8'), t[0] !== 10);
      }
      const parsed = fromEntries(headEntries, tailEntries, start < f.size, f.id);
      this.cache.set(f.path, { size: f.size, mtimeMs: f.mtimeMs, parsed });
      return parsed;
    } catch {
      return null;
    } finally {
      await fh.close();
    }
  }
}
