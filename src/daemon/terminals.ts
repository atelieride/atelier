import { EventEmitter } from 'node:events';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, realpathSync, statSync } from 'node:fs';
import { homedir, release } from 'node:os';
import * as pty from 'node-pty';
import { Terminal as Headless } from '@xterm/headless';
import { SerializeAddon } from '@xterm/addon-serialize';
import { basename, dirname, join, win32 } from 'node:path';
import type { Resumable, TerminalInfo, TerminalProfile } from '@shared/protocol';
import { applyStatusLine, configDirOf, expireBackground, expireSubagents, markSeen, onShellForeground, publicSession, reduceHook, seedLastMessage, stampUsage, type SessionInfo, type Usage } from '@shared/session';
import { claudeVersion, confirmLimitPause, openLimitPause, sweepLimitPause } from '@shared/limit-pause';
import { attributionFromHook, type Attribution } from '@shared/attribution';
import { NO_NAME, onNameHook, onNameStatus, renamed, terminalTitle, visibleSync, type NameReply, type NameState } from '@shared/session-name';
import { isShell } from '@shared/shells';
import { DraftTracker, typesSomething } from '@shared/drafts';
import { isWaiting } from '@shared/session-view';
import { pathListJoin, pathListSplit } from '@shared/env';
import { currentPlatform, pathStyle } from '@shared/platform';
import { windowsPtyFor } from '@shared/windows-pty';
import { toCanonical, toNative } from '@shared/paths';
import type { RegistryTerminal } from './registry';
import { snapshotOf } from './snapshot-modes';
import type { PtyProcess, SpawnFor, SpawnPty } from './session-pty';

// Eight identity colors designed for graphite: same luminance, widely spaced hues.
export const SESSION_COLORS = ['#B794F6', '#4FC3D9', '#F28FAD', '#A3D977', '#F2A766', '#7CC4FF', '#E8A0E8', '#E6D06E'];


/** Fixed terminal data; name, title and session are computed in toInfo. */
type TermBase = Omit<TerminalInfo, 'title' | 'name' | 'session'>;

interface Term {
  info: TermBase;
  /** Default "Terminal N" number: the last one this terminal showed, preferred when it shows one again. */
  n: number | null;
  /** `n` is held: the terminal has kept showing it since it got it (a name or a session in front releases it). */
  holdsN: boolean;
  /** Started with a `claude` command: until its session arrives (or the starting window passes) it is no plain terminal. */
  launchedAsSession: boolean;
  /** The starting window is over without a session: from now on it falls back to the default title. */
  startExpired: boolean;
  startTimer: NodeJS.Timeout | null;
  /** The terminal's name and where Claude stands on it (session name sync). */
  name: NameState;
  /** A resumed session's last title, shown until Claude reports a name; never sent to Claude. */
  label: string | null;
  session: TerminalInfo['session'];
  shellPolls: number;
  proc: PtyProcess;
  screen: Headless;
  serializer: SerializeAddon;
  listeners: Set<(data: string) => void>;
  /** Closed by Atelier (user or service shutdown), did not die on its own. */
  closing: boolean;
  /** The resumable this terminal resumes, given back if its shell dies at once without Claude ever starting. */
  resumeOf?: Resumable;
  /**
   * Closed with a resume entry (a window closing): built when asked, given back when the
   * shell exits even if Claude's SessionEnd cleared the session in between.
   */
  keepAs?: Resumable;
  sessionSeen: boolean;
  /** A resumed conversation's last message time, for its first session; then dropped. */
  seedAt?: number;
  /** The Claude config dir of the last Claude seen here; it outlives the session. */
  configDir?: string;
  /** The limits of its last status line, stamped (stampUsage): when they last moved tells fresh numbers from repeats. */
  limits?: Usage;
  /** The config dir (account) those limits belong to: another account's Claude in this terminal never uses them. */
  limitsDir?: string | null;
  /** The first status line for a session no hook announced (session id, when); `logged` once it was reported. */
  orphan?: { sessionId: string; at: number } | 'logged';
  /**
   * Windows: the shell's name (`pwsh`). node-pty reports a fixed name there, so the foreground is derived: `claude`
   * while a session runs in the terminal, else the shell.
   */
  shellName?: string;
  /** The last input from an app (scheduled prompts' typing gate) and the last output (their Enter waits for quiet). */
  lastInputAt: number;
  lastOutputAt: number;
}

/** A resumed terminal whose shell ends this soon, before any Claude session, failed to launch. */
const LAUNCH_FAILURE_MS = 5000;

/**
 * Status lines for a session no hook announced, this long: Claude's hooks are not reaching atelierd (more than the
 * Windows hook timeout, so a status line that only beat its SessionStart is never reported).
 */
const ORPHAN_STATUS_MS = 10_000;

/** A terminal launched as a Claude session with no session this long after it started is a plain terminal (as the app's). */
export const STARTING_MS = 30_000;

/**
 * The command New Session / Resume send: Claude itself, with or without options, maybe for another Claude account
 * (`CLAUDE_CONFIG_DIR='<dir>' claude …`, always single-quoted by the app).
 */
const CLAUDE_COMMAND = /^(CLAUDE_CONFIG_DIR='(?:[^']|'\\'')*' )?claude(\s|$)/;
/** Windows: the same in PowerShell, another account's dir set for the one command (shared/shell.ts withConfigDir). */
const POWERSHELL_CLAUDE_COMMAND = /^(& \{ \$p = \$env:CLAUDE_CONFIG_DIR; \$env:CLAUDE_CONFIG_DIR = '(?:[^'‘’‚‛]|['‘’‚‛]{2})*'; try \{ )?claude(\s|$)/;

/** How to start a terminal's shell for a profile. */
export interface Launch {
  file: string;
  args: string[];
  env: Record<string, string>;
  /**
   * Variable used to pass the initial command to the shell (Atelier's zsh integration runs it before the first
   * prompt). Without it, the command is typed into the terminal once the shell looks ready (shell without integration).
   */
  initCommandEnv?: string;
  /** The profile this launch really is, when it differs from the one asked for. */
  profile?: TerminalProfile;
  /**
   * Windows, a shell with Atelier's integration other than the built-in profiles (Git Bash): it prints OSC 133;P with
   * ATELIER_PROMPT_NONCE at each prompt, and wants Atelier's bin first on PATH (the bridge by name).
   */
  promptSignal?: boolean;
}

export interface TerminalManagerOptions {
  /** May throw (e.g. a shell not allowed): the terminal is then not created. */
  launch: (id: string, profile: TerminalProfile, o: { aliases?: boolean }) => Launch;
  scrollback?: number;
  /** Starting window of a terminal launched as a Claude session (tests shorten it). */
  startingMs?: number;
  /** How a terminal's shell starts: isolated launchd jobs (session-pty.ts) or, by default, node-pty's spawn. */
  spawnFor?: SpawnFor;
  /** atelierd's log (what the app's logs can't see: hooks that never arrive). */
  log?: (msg: string) => void;
  /** Whether a process still runs (tests replace it); default: signal 0. */
  isAlive?: (pid: number) => boolean;
  /**
   * A Claude config dir's limits as atelierd merged them across its terminals (usageByDir), for the usage-limit pause;
   * default none.
   */
  usageFor?: (configDir: string | null) => Usage | null;
  /** Whether Claude Code continues by itself at a usage limit's reset (its autoContinueAtUsageLimit); default yes. */
  autoContinue?: (configDir: string | null) => boolean;
  /**
   * Windows where closing the console waits for every program in it (closeWaitsForPrograms): starts ending the shell's
   * process tree (`image`: the shell's own executable name), right before the console closes. Absent: nothing first.
   */
  endTree?: (pid: number, image: string) => void;
}

const nodePtySpawn: SpawnPty = (file, args, o) => pty.spawn(file, args, o);

export interface CreateTerminal {
  projectRoot: string; cwd: string; cols: number; rows: number; name?: string; command?: string;
  /** Absent = 'user', the shell as it was before profiles existed (an older app doesn't send it). */
  profile?: TerminalProfile;
  /** false = an Atelier-profile shell without the user's aliases (absent = with them). */
  aliases?: boolean;
  /** Color to keep (resumed session); otherwise the next one in the palette. */
  color?: string;
  /** The resumable being resumed: it comes back if the shell dies at once, before Claude starts. */
  resumeOf?: Resumable;
  /** Display-only title until Claude reports a name (a resumed session's last title); never sent to Claude. */
  label?: string;
  /** A resumed terminal's name state, restored as saved (instead of `name`): an adopted Claude name stays exact. */
  nameState?: NameState;
  /** A resumed conversation's last message time: its new session starts with it. */
  lastMessageAt?: number;
}

/** Real path (symlinks resolved) as git reports it; for a file that no longer exists the folder is resolved. */
function realPath(p: string): string {
  try { return realpathSync(p); } catch { /* file deleted or renamed */ }
  try { return join(realpathSync(dirname(p)), basename(p)); } catch { return p; }
}

/** Closes a terminal's shell: SIGHUP on POSIX; ConPTY takes no signal name (it throws), a plain kill on Windows. */
function hangUp(proc: PtyProcess): void {
  if (pathStyle() === 'win32') proc.kill(); else proc.kill('SIGHUP');
}

function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (err) { return (err as NodeJS.ErrnoException).code === 'EPERM'; }
}

function isDir(p: string): boolean {
  try { return existsSync(p) && statSync(p).isDirectory(); } catch { return false; }
}

export class TerminalManager extends EventEmitter {
  private terms = new Map<string, Term>();
  private colorIndex = 0;
  /** Text typed into each prompt and not sent (scheduled prompts never type over it). */
  private drafts = new DraftTracker();

  constructor(private readonly opts: TerminalManagerOptions) { super(); }

  create(o: CreateTerminal): TerminalInfo {
    const id = randomUUID();
    // Canonical for the app (`C:/…` on Windows), native for the shell.
    const cwd = toCanonical(isDir(o.cwd) ? o.cwd : isDir(o.projectRoot) ? o.projectRoot : homedir());
    const launch = this.opts.launch(id, o.profile ?? 'user', { aliases: o.aliases });
    // The profile the shell really started with (an Atelier terminal without a captured environment is the user's).
    const profile = launch.profile ?? o.profile ?? 'user';
    const env = launch.env;
    if (o.command && launch.initCommandEnv) env[launch.initCommandEnv] = o.command;
    // Atelier's zsh adds this nonce to its OSC 133 marks (and drops the variable at once, so its programs never see
    // it): the app tells them from marks a program prints.
    const markNonce = profile === 'atelier' ? randomBytes(16).toString('hex') : undefined;
    if (markNonce) env.ATELIER_MARK_NONCE = markNonce;
    // Windows' PowerShell (your profile) runs atelier.ps1 too, without command marks, and Git Bash its own integration:
    // their prompt sends atelierd alone a signal (OSC 133;P, which the app ignores) with this nonce, kept out of the
    // terminal's info.
    const builtIn = profile === 'user' || profile === 'atelier';
    const promptNonce = pathStyle() === 'win32' && (profile === 'user' || launch.promptSignal) ? randomBytes(16).toString('hex') : undefined;
    if (promptNonce) env.ATELIER_PROMPT_NONCE = promptNonce;
    if (pathStyle() === 'win32' && (builtIn || launch.promptSignal)) {
      // Claude's settings may call atelier-bridge by name (a home that needs quoting): this Atelier's bin first, before
      // $PROFILE runs, so another Atelier's bin (a dev build started from a terminal) or a relative entry never answers.
      const pathKey = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'Path';
      if (env.ATELIER_HOME) {
        const bin = win32.join(env.ATELIER_HOME, 'bin');
        const rest = pathListSplit(env[pathKey] ?? '', 'win32').filter((d) => d && d.toLowerCase() !== bin.toLowerCase());
        env[pathKey] = pathListJoin([bin, ...rest], 'win32');
      }
      // atelier.ps1 runs after your $PROFILE: it adds to PATH only folders Windows' settings gained since this one,
      // never one your profile took off. (Git Bash keeps atelierd's environment.)
      if (builtIn) env.ATELIER_START_PATH = env[pathKey] ?? '';
    }
    const spawn = this.opts.spawnFor ? this.opts.spawnFor(id) : nodePtySpawn;
    const proc = spawn(launch.file, launch.args, {
      name: 'xterm-256color', cols: o.cols, rows: o.rows, cwd: toNative(cwd), env, encoding: 'utf8'
    });
    const shellName = pathStyle() === 'win32' ? win32.basename(launch.file).toLowerCase().replace(/\.exe$/, '') : undefined;
    // Every Windows terminal is node-pty's ConPTY (winpty before build 18309): told so, the screen doesn't reflow on a
    // resize the way ConPTY doesn't expect (it redraws itself).
    const windowsPty = windowsPtyFor(currentPlatform(), release());
    const screen = new Headless({ cols: o.cols, rows: o.rows, scrollback: this.opts.scrollback ?? 10000, allowProposedApi: true, ...(windowsPty ? { windowsPty } : {}) });
    const serializer = new SerializeAddon();
    screen.loadAddon(serializer);
    const info: TermBase = {
      id, projectRoot: o.projectRoot, cwd,
      color: o.color ?? SESSION_COLORS[this.colorIndex++ % SESSION_COLORS.length]!,
      foreground: shellName ?? proc.process, createdAt: Date.now(), profile, ...(markNonce ? { markNonce } : {}),
      ...(Number.isInteger(proc.pid) && proc.pid > 0 ? { pid: proc.pid } : {})
    };
    const command = o.command?.trim();
    const launchedAsSession = !!command && (CLAUDE_COMMAND.test(command) || (pathStyle() === 'win32' && POWERSHELL_CLAUDE_COMMAND.test(command)));
    const term: Term = { info, n: null, holdsN: false, launchedAsSession, startExpired: false, startTimer: null, name: o.nameState ?? renamed(o.name), label: renamed(o.label).name, session: null, shellPolls: 0, proc, screen, serializer, listeners: new Set(), closing: false, resumeOf: o.resumeOf, sessionSeen: false, lastInputAt: 0, lastOutputAt: 0, ...(shellName ? { shellName } : {}), ...(o.lastMessageAt !== undefined ? { seedAt: o.lastMessageAt } : {}) };
    if (launchedAsSession) {
      // Claude never started (no session in the window): the terminal falls back to its default title, and says so.
      term.startTimer = setTimeout(() => {
        term.startTimer = null;
        term.startExpired = true;
        if (!term.sessionSeen && this.terms.has(id)) this.emit('changed');
      }, this.opts.startingMs ?? STARTING_MS);
      term.startTimer.unref?.();
    }
    // An isolated terminal's shell reports its pid a moment after create (ports, work scan and cwd read it).
    proc.onPid?.((pid) => {
      if (!this.terms.has(id) || !Number.isInteger(pid) || pid <= 0) return;
      info.pid = pid;
      this.emit('changed');
    });
    // Windows: no process to watch, so a Claude killed without SessionEnd is noticed when the shell draws its own prompt
    // again (the Atelier profile's OSC 133 A, your profile's 133 P, with this terminal's nonce: no program can print it).
    const promptMark = !shellName ? null : markNonce ? `\x1b]133;A;atelier=${markNonce}` : promptNonce ? `\x1b]133;P;atelier=${promptNonce}` : null;
    let markTail = '';
    proc.onData((data) => {
      term.lastOutputAt = Date.now();
      screen.write(data);
      for (const l of term.listeners) l(data);
      if (!promptMark) return;
      const seen = markTail + data;
      markTail = seen.slice(-(promptMark.length - 1));
      if (term.session && seen.includes(promptMark)) {
        term.session = onShellForeground(term.session);
        term.info.foreground = shellName!;
        this.emit('changed');
      }
    });
    proc.onExit(({ exitCode }) => {
      // Shell died with Claude still open and without anyone closing it (Mac restart, kill):
      // the session stays resumable, as after a service shutdown.
      if (term.keepAs) {
        this.emit('lost', { ...term.keepAs, endedAt: Date.now() });
      } else if (!term.closing && term.session) {
        this.emit('lost', this.resumableOf(term));
      } else if (!term.closing && term.resumeOf && !term.sessionSeen && Date.now() - info.createdAt < LAUNCH_FAILURE_MS) {
        this.emit('lost', { ...this.givenBack(term), endedAt: Date.now() });
      }
      if (term.startTimer) clearTimeout(term.startTimer);
      this.terms.delete(id);
      this.drafts.forget(id);
      screen.dispose();
      this.emit('exit', id, exitCode ?? null);
      this.emit('changed');
    });
    this.terms.set(id, term);
    if (o.command && !launch.initCommandEnv) this.writeWhenReady(term, o.command);
    this.emit('changed');
    return this.toInfo(term);
  }

  /**
   * The initial command is written as if the user typed it, but only once the shell is ready
   * (first output followed by a moment of quiet): written earlier, the terminal would echo it twice.
   */
  private writeWhenReady(t: Term, command: string): void {
    let quiet: NodeJS.Timeout | null = null;
    let done = false;
    const fire = () => {
      if (done) return;
      done = true;
      sub.dispose();
      clearTimeout(limit);
      if (quiet) clearTimeout(quiet);
      if (this.terms.has(t.info.id)) t.proc.write(command + '\r');
    };
    const sub = t.proc.onData(() => {
      if (quiet) clearTimeout(quiet);
      quiet = setTimeout(fire, 250);
    });
    const limit = setTimeout(fire, 5000);
  }

  /** Metadata to save to disk (never the terminals' content). */
  snapshotForRegistry(): RegistryTerminal[] {
    return [...this.terms.values()].map((t) => {
      const i = this.toInfo(t);
      return { id: i.id, projectRoot: i.projectRoot, cwd: i.session?.cwd ?? i.cwd, name: i.name, title: i.title, color: i.color, sessionId: i.session?.sessionId ?? null, state: i.session?.state ?? null, createdAt: i.createdAt, profile: i.profile, ...(t.name.name ? { nameSync: t.name.sync } : {}), ...(i.session?.lastMessageAt != null ? { lastMessageAt: i.session.lastMessageAt } : {}), ...(t.configDir ? { configDir: t.configDir } : {}) };
    });
  }

  list(): TerminalInfo[] {
    return [...this.terms.values()].map((t) => this.toInfo(t));
  }

  private toInfo(t: Term): TerminalInfo {
    const title = terminalTitle(t.name, t.label, t.session, () => (this.showsClaude(t) ? `Claude · ${basename(t.info.cwd)}` : `Terminal ${this.numberOf(t)}`));
    const nameSync = visibleSync(t.name, !!t.session);
    return { ...t.info, title, name: t.name.name, session: t.session ? publicSession(t.session) : null, ...(nameSync ? { nameSync } : {}), ...(t.configDir ? { configDir: t.configDir } : {}) };
  }

  /** A session, or a terminal launched as one while Claude starts (no number taken for a title nobody sees). */
  private showsClaude(t: Term): boolean {
    return !!t.session || (t.launchedAsSession && !t.sessionSeen && !t.startExpired);
  }

  /** The title is "Terminal N" right now (no name, label or session in front). */
  private showsNumber(t: Term): boolean {
    let shown = false;
    terminalTitle(t.name, t.label, t.session, () => { shown = !this.showsClaude(t); return ''; });
    return shown;
  }

  /**
   * The terminal's default number: the smallest not shown by another live terminal of the same project. A terminal
   * keeps its number while it shows it and gets it back after a name or a session if it is still free; one that has
   * kept showing a number wins it over one coming back to it.
   */
  private numberOf(t: Term): number {
    const taken = new Set<number>();
    for (const o of this.terms.values()) {
      if (o === t || o.info.projectRoot !== t.info.projectRoot) continue;
      if (!this.showsNumber(o)) o.holdsN = false;
      else if (o.holdsN && o.n !== null) taken.add(o.n);
    }
    if (t.n === null || taken.has(t.n)) {
      let n = 1;
      while (taken.has(n)) n += 1;
      t.n = n;
    }
    t.holdsN = true;
    return t.n;
  }

  /**
   * Hook event for a terminal: updates the session and, for file changes, returns the attribution; reply = what the
   * bridge prints back to Claude (a pending name), or null.
   */
  applyHook(id: string, payload: unknown): { ok: boolean; attribution: Attribution | null; reply: NameReply | null } {
    const t = this.terms.get(id);
    if (!t) return { ok: false, attribution: null, reply: null };
    const now = Date.now();
    let next = reduceHook(t.session, payload, now);
    if (next === undefined) return { ok: false, attribution: null, reply: null };
    // A resumed conversation's first session starts with the conversation's last message time, when it really is that
    // conversation resuming (a resume that failed, then a fresh claude, is not); later ones (/clear) don't.
    if (next && t.seedAt !== undefined) {
      if ((payload as { source?: unknown }).source === 'resume') next = seedLastMessage(next, t.seedAt, now);
      t.seedAt = undefined;
    }
    // The account this hook's Claude runs with: its limits and its settings decide a usage-limit pause.
    const configDir = configDirOf((payload as { transcript_path?: unknown }).transcript_path) ?? t.configDir;
    if (next && (payload as { hook_event_name?: unknown }).hook_event_name === 'StopFailure') next = this.openPause(t, next, payload, configDir ?? null, now);
    // A new conversation in this terminal (/clear, another `claude`): a name synced with the previous one doesn't follow
    // it (a pending or Atelier-only name does: it is what the user called this terminal).
    if (t.session && next && next.sessionId !== t.session.sessionId && t.name.sync === 'synced') t.name = NO_NAME;
    t.session = next;
    if (next) t.sessionSeen = true;
    t.configDir = configDir;
    t.shellPolls = 0;
    const named = onNameHook(t.name, payload);
    t.name = named.state;
    this.emit('changed');
    // Current color and name: they stay even if the session closes later.
    const attribution = attributionFromHook(payload, { id, color: t.info.color, title: this.toInfo(t).title }, Date.now());
    return { ok: true, attribution: attribution && { ...attribution, path: toCanonical(realPath(attribution.path)) }, reply: named.reply };
  }

  /**
   * A rate_limit stop that Claude Code will continue at the reset reads as a pause:
   * its version from the foreground, its setting from the config dir, the evidence from the account's limits (as
   * merged, and this terminal's own) or Claude Code's words. Only a rate_limit stop reads the settings file.
   */
  private openPause(t: Term, s: SessionInfo, payload: unknown, configDir: string | null, now: number): SessionInfo {
    if (s.state !== 'error' || s.errorReason !== 'rate_limit') return s;
    const opened = openLimitPause(s, {
      usages: [this.opts.usageFor?.(configDir) ?? null, this.ownLimits(t, configDir)],
      message: (payload as { last_assistant_message?: unknown }).last_assistant_message,
      version: claudeVersion(t.info.foreground),
      autoContinue: this.opts.autoContinue?.(configDir) ?? true
    }, now);
    this.noteUnconfirmed(t, s, opened);
    return opened;
  }

  /**
   * The terminal's own limits when they belong to `configDir` (that dir's merged entry, else the terminal's
   * own): a Claude on another account here (`CLAUDE_CONFIG_DIR=B claude`) never pauses on the previous account's limit.
   */
  private ownLimits(t: Term, configDir: string | null): Usage | null {
    return t.limits && (t.limitsDir ?? null) === configDir ? t.limits : null;
  }

  /** A pause that just ended as unconfirmed, logged once per episode: a real limit Atelier missed can be diagnosed. */
  private noteUnconfirmed(t: Term, before: SessionInfo | null, after: SessionInfo | null): void {
    if (after?.limitPause?.over !== 'unconfirmed' || before?.limitPause?.over === 'unconfirmed') return;
    this.opts.log?.(`terminal ${t.info.id}: rate_limit stop without a usage limit in sight: shown as an error`);
  }

  /** Status line data: updates the session context and returns the limits, if any, with the config dir they belong to. */
  applyStatus(id: string, payload: unknown): { usage: Usage; configDir: string | null } | null {
    const t = this.terms.get(id);
    if (!t) return null;
    const now = Date.now();
    this.noteOrphanStatus(t, payload, now);
    const r = applyStatusLine(t.session, payload, now);
    const name = r.session ? onNameStatus(t.name, payload, r.session.sessionId) : t.name;
    const dir = r.configDir ?? t.configDir;
    if (r.usage) { t.limits = stampUsage(t.limits ?? null, r.usage, now); t.limitsDir = dir ?? null; }
    // Claude Code's status line runs just after its error message: its limits, or the account's as atelierd merged them
    // so far, may prove a rate_limit stop a usage limit within its first seconds.
    const session = confirmLimitPause(r.session, [this.ownLimits(t, dir ?? null), this.opts.usageFor?.(dir ?? null) ?? null], now);
    this.noteUnconfirmed(t, r.session, session);
    if (session !== t.session || name !== t.name || dir !== t.configDir) {
      t.session = session; t.name = name; t.configDir = dir;
      if (session) t.sessionSeen = true;
      this.emit('changed');
    }
    if (!r.usage) return null;
    // A status line without its own path counts for the dir this terminal already knows.
    return { usage: t.limits!, configDir: dir ?? null };
  }

  /**
   * A status line for a session no hook announced never makes a session (only hooks do), so a terminal whose hooks
   * never reach atelierd stays "Starting…" with no word anywhere: logged once per terminal, when such status lines for
   * one session keep coming past ORPHAN_STATUS_MS.
   */
  private noteOrphanStatus(t: Term, payload: unknown, now: number): void {
    if (t.orphan === 'logged') return;
    const sessionId = typeof payload === 'object' && payload !== null ? (payload as { session_id?: unknown }).session_id : undefined;
    if (typeof sessionId !== 'string' || !sessionId || t.session?.sessionId === sessionId) { t.orphan = undefined; return; }
    if (t.orphan?.sessionId !== sessionId) { t.orphan = { sessionId, at: now }; return; }
    if (now - t.orphan.at < ORPHAN_STATUS_MS) return;
    t.orphan = 'logged';
    this.opts.log?.(`terminal ${t.info.id}: status line without SessionStart: Claude's hooks are not reaching atelierd`);
  }

  /** A name given in Atelier: shown at once, handed to Claude with the session's next prompt or start. */
  rename(id: string, name: string | null): void {
    const t = this.must(id);
    t.name = renamed(name);
    this.emit('changed');
  }

  markSeen(id: string): void {
    const t = this.must(id);
    if (!t.session) return;
    const s = markSeen(t.session);
    if (s !== t.session) { t.session = s; this.emit('changed'); }
  }

  has(id: string): boolean {
    return this.terms.has(id);
  }

  /** The process in front of a terminal (Claude Code's native binary is named after its version); null when gone. */
  foregroundOf(id: string): string | null {
    return this.terms.get(id)?.info.foreground ?? null;
  }

  /**
   * Attaches a listener: first the serialized screen (onSnapshot), then the following data (onData).
   * Writing to xterm is asynchronous: an empty marker is queued and the screen is serialized once it has
   * been parsed. Whatever arrives before the marker is in the screen, whatever arrives after goes into the queue
   * and is delivered right after the screen: nothing lost, nothing duplicated.
   */
  attach(id: string, onSnapshot: (snapshot: string) => void, onData: (data: string) => void): () => void {
    const t = this.must(id);
    let ready = false;
    let detached = false;
    const queue: string[] = [];
    const listener = (data: string) => { if (ready) onData(data); else queue.push(data); };
    t.listeners.add(listener);
    t.screen.write('', () => {
      if (detached) return;
      onSnapshot(snapshotOf(t.screen, t.serializer));
      for (const d of queue.splice(0)) onData(d);
      ready = true;
    });
    return () => { detached = true; t.listeners.delete(listener); };
  }

  // A closing terminal is never typed into, resized or killed again: on Windows its ConPTY console is already freed,
  // and node-pty would free it twice (atelierd dies, every terminal with it).
  input(id: string, data: string): void {
    const t = this.terms.get(id);
    if (!t || t.closing) return;
    // In a permission or question dialog the Enter answers it: it sends no draft (drafts.ts).
    this.drafts.note(id, data, isWaiting(t.session));
    // Only what types into the prompt is typing: focus, mouse and terminal reports flow all the time.
    if (typesSomething(data)) t.lastInputAt = Date.now();
    t.proc.write(data);
  }

  /** atelierd's own write (a scheduled prompt): no one's input, no draft. False when the terminal is gone or closing. */
  writeOwn(id: string, data: string): boolean {
    const t = this.terms.get(id);
    if (!t || t.closing) return false;
    // Followed like any input: a paste left without its Enter shows up as a draft, so nothing is typed over it.
    this.drafts.note(id, data, false);
    t.proc.write(data);
    return true;
  }

  /** What a scheduled prompt checks before typing into this terminal; null when gone. */
  promptState(id: string): { bracketed: boolean; draft: boolean; lastInputAt: number; lastOutputAt: number } | null {
    const t = this.terms.get(id);
    if (!t || t.closing) return null;
    return { bracketed: t.screen.modes.bracketedPasteMode, draft: this.drafts.has(id), lastInputAt: t.lastInputAt, lastOutputAt: t.lastOutputAt };
  }

  resize(id: string, cols: number, rows: number): void {
    const t = this.terms.get(id);
    if (!t || t.closing) return;
    t.proc.resize(cols, rows);
    t.screen.resize(cols, rows);
  }

  /** resumable: its Claude session (if any) comes back under Resume once the shell exits (capability 'kill-resumable'). */
  kill(id: string, o: { resumable?: boolean } = {}): void {
    const t = this.terms.get(id);
    if (!t || t.closing) return;
    // A resume whose Claude has not started yet gives its own entry back.
    if (o.resumable) t.keepAs = t.session ? this.resumableOf(t) : t.resumeOf && !t.sessionSeen ? this.givenBack(t) : undefined;
    this.close(t);
  }

  /**
   * The entry a resume gives back when its Claude never started: under this terminal's id, like every resume entry —
   * the app moved the session's task link and pin to it when the resume replied.
   */
  private givenBack(t: Term): Resumable {
    return { ...t.resumeOf!, id: t.info.id };
  }

  /** The resume entry of a terminal's Claude session, as it stands now. */
  private resumableOf(t: Term): Resumable {
    const session = t.session!;
    const i = this.toInfo(t);
    return { id: i.id, projectRoot: i.projectRoot, cwd: session.cwd ?? i.cwd, title: i.title, color: i.color, sessionId: session.sessionId, endedAt: Date.now(), profile: i.profile, name: i.name, ...(t.name.name ? { nameSync: t.name.sync } : {}), ...(session.lastMessageAt != null ? { lastMessageAt: session.lastMessageAt } : {}), ...(t.configDir ? { configDir: t.configDir } : {}) };
  }

  /**
   * Hangs a terminal up once. A hang-up that throws because the shell already exited counts (its exit removes it); one
   * that throws with the shell still running on POSIX leaves it open again, or it would stay "Closing…" for good. On
   * Windows a throw always counts: node-pty may throw after it freed the ConPTY console, the shell still running for a
   * moment, and a second free kills atelierd with every terminal.
   *
   * Where closing the console waits for its programs (`endTree`), taskkill on the shell's tree starts first: the close
   * then waits only for it ending them.
   */
  private close(t: Term): void {
    t.closing = true;
    const pid = t.info.pid;
    if (this.opts.endTree && pid !== undefined && t.shellName) {
      try { this.opts.endTree(pid, `${t.shellName}.exe`); } catch { /* the console closes all the same */ }
    }
    try { hangUp(t.proc); } catch {
      if (pathStyle() !== 'win32' && pid !== undefined && (this.opts.isAlive ?? processAlive)(pid)) { t.closing = false; t.keepAs = undefined; }
    }
  }

  /** Updates the foreground process; emits 'changed' only if something changed. */
  pollForeground(): void {
    let changed = false;
    for (const t of this.terms.values()) {
      let fg = t.info.foreground;
      if (t.shellName) fg = t.session ? 'claude' : t.shellName;
      else try { fg = t.proc.process; } catch { /* process just exited */ }
      if (fg !== t.info.foreground) { t.info.foreground = fg; changed = true; }
      // Claude exited without SessionEnd (kill, crash): the shell is back in the foreground for two reads in a row.
      if (t.session && isShell(fg)) {
        t.shellPolls += 1;
        if (t.shellPolls >= 2) { t.session = onShellForeground(t.session); t.shellPolls = 0; changed = true; }
      } else {
        t.shellPolls = 0;
      }
    }
    if (changed) this.emit('changed');
    this.sweepSessions(Date.now());
  }

  /**
   * Drops the subagents with no event for 2 hours (a lost SubagentStop) and the background tasks unconfirmed for 24
   * hours; ends the usage-limit pauses nothing confirmed in time, or whose reset passed long ago;
   * emits 'changed' only if any was.
   */
  sweepSessions(now: number): void {
    let changed = false;
    for (const t of this.terms.values()) {
      if (!t.session) continue;
      const s = sweepLimitPause(expireBackground(expireSubagents(t.session, now), now), now);
      this.noteUnconfirmed(t, t.session, s);
      if (s !== t.session) { t.session = s; changed = true; }
    }
    if (changed) this.emit('changed');
  }

  disposeAll(): void {
    for (const t of this.terms.values()) {
      if (t.startTimer) { clearTimeout(t.startTimer); t.startTimer = null; }
      if (t.closing) continue;
      this.close(t);
    }
  }

  private must(id: string): Term {
    const t = this.terms.get(id);
    if (!t) throw new Error(`unknown terminal: ${id}`);
    return t;
  }
}
