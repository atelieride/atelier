import { z } from 'zod';
import type { SessionInfo, Usage, UsageEntry } from './session';
import type { Attribution } from './attribution';
import type { ToolCallWindow } from './tool-calls';
import type { BackgroundWork } from './background';
import type { RecentItem } from './background-recent';
import type { NameSync } from './session-name';
import { isCleanAbsPath } from './clean-path';
import { pathStyle } from './platform';
import { scheduleAddFields, scheduleUpdateFields, type ScheduledPrompt } from './scheduled-prompts';
import type { SignalBookView } from './claude-signals';

export const MAX_LINE_CHARS = 4 * 1024 * 1024;
export const MAX_HOOK_PAYLOAD_CHARS = 1024 * 1024;

/**
 * How a terminal's shell starts: 'atelier' = zsh with Atelier's own clean config and the user's captured environment;
 * 'user' = zsh with the user's own config (the default when absent, as before profiles existed); { shell } = a shell
 * listed in /etc/shells.
 */
export type TerminalProfile = 'atelier' | 'user' | { shell: string };

export interface TerminalInfo {
  id: string;
  projectRoot: string;
  cwd: string;
  /** Displayed name, computed: given name > session title > session's first prompt (autoTitle) > "Claude · folder" > "Terminal N". */
  title: string;
  /** Name given by the user ("New session" button or rename), otherwise null. */
  name: string | null;
  /** Identity color, fixed for the whole life of the terminal. */
  color: string;
  /** Foreground process (zsh, node, tmux, claude…). */
  foreground: string;
  createdAt: number;
  /** Claude session running in this terminal, if any. */
  session: SessionInfo | null;
  /** Profile the shell started with; absent from an atelierd older than profiles. */
  profile?: TerminalProfile;
  /**
   * Atelier-profile terminals of an atelierd with v2.0 command blocks: the random nonce its shell adds to every OSC 133
   * mark (`atelier=<nonce>`), so marks printed by programs are told apart. Absent: marks are taken as they are.
   */
  markNonce?: string;
  /**
   * The pid of the terminal's shell (node-pty's), from which the app reads listening ports over its process tree
   *. Absent from an atelierd older than v2.1: no ports are shown until it restarts.
   */
  pid?: number;
  /**
   * The session's background work, computed by main from atelierd's `background` field and its
   * own work scan, never sent by atelierd. Absent when the session has no background field.
   */
  work?: BackgroundWork;
  /** Background items that ended in this app run, newest first; main-side only. */
  recent?: RecentItem[];
  /**
   * Session name sync (capability 'names'): 'pending' = a name given in Atelier that Claude gets with the session's next
   * prompt (or start); 'kept' = Claude didn't take it, it stays an Atelier-only name. Absent otherwise.
   */
  nameSync?: 'pending' | 'kept';
  /**
   * The Claude config dir of the last Claude seen in this terminal (capability 'config-dirs'):
   * kept after Claude exits, replaced by a later Claude with another dir. Absent until one reports it.
   */
  configDir?: string;
}

/**
 * Claude session left without a process (Mac or service restart), resumable with --resume. name and nameSync: the
 * terminal's name and where Claude stood on it (capability 'names'; session-name.ts); absent from older atelierds.
 */
/** lastMessageAt: the session's last message time when it ended (capability 'lastmessage'). */
/** configDir: the Claude config dir the session ran with (capability 'resume-config-dir'; absent when unknown). */
export interface Resumable { id: string; projectRoot: string; cwd: string; title: string; color: string; sessionId: string; endedAt: number; profile?: TerminalProfile; name?: string | null; nameSync?: NameSync; lastMessageAt?: number; configDir?: string }

/**
 * The capture of the user's shell environment for Atelier-profile terminals. Sent by an atelierd with profiles after
 * welcome and on every change (an older app ignores unknown messages). 'off' = no capture (tests only); while
 * 'capturing' with no earlier capture, or after 'failed', Atelier terminals open in the user's own zsh.
 * aliases: how many of the user's aliases the capture in use found (capability 'aliases'; 0 when left out as too
 * large).
 */
export interface ShellEnvState { state: 'off' | 'capturing' | 'ready' | 'failed'; error?: string; capturedAt?: number; aliases?: number }

export interface DaemonInfo {
  pid: number;
  version: string;
  sock: string;
  token: string;
  startedAt: number;
  /** Windows: the folder atelierd runs from (its runtime copy, or the package): the copy pruning keeps it. */
  runtime?: string;
}

const dim = z.number().int().min(2).max(1000);
const id = z.string().min(1).max(64);
/** An absolute path in the canonical form: `/…` on POSIX, `C:/…` on Windows (no `\\`, no NUL). */
const isProtocolAbs = (p: string): boolean => (pathStyle() === 'win32' ? /^[A-Za-z]:\//.test(p) && !/[\\\0]/.test(p) : p.startsWith('/'));
const absPath = z.string().min(1).max(4096).refine(isProtocolAbs);
export const profileSchema: z.ZodType<TerminalProfile> = z.union([z.literal('atelier'), z.literal('user'), z.object({ shell: absPath }).strict()]);

/**
 * What this atelierd can do beyond the protocol version, sent in welcome. Additions stay backward compatible:
 * an older atelierd strips unknown fields (e.g. create's profile) and would answer unknown requests with an error,
 * so the app checks a capability before relying on it. 'profiles' = create/resume accept profile, reloadEnv exists.
 * 'states2' (v2.0) = SessionInfo carries waitingFor, compacting, subagents, errorReason, permissionMode and autoTitle
 * (TerminalInfo.title already falls back to autoTitle), and the Atelier profile's zsh emits OSC 133 command marks.
 * Without it (an older atelierd) those fields are absent: the app keeps today's behavior and offers a restart.
 * 'background' = SessionInfo carries `background` (the session's background subagents, shells, monitors and other
 * tasks, and its crons); without it the app strips the field and behaves as before.
 * 'toolcalls' = atelierd streams tool-call windows ({ t: 'toolCalls', list, full }: the whole list on connect, then the
 * windows that changed, at once); without it the app keeps the v1.7 Bash heuristic.
 * 'aliases' = Atelier-profile terminals get the user's aliases from the capture unless create/resume say
 * `aliases: false`, and ShellEnvState carries their count (spec Atelier profile aliases).
 * 'names' = session name sync: a name given in Atelier reaches Claude through the hook reply,
 * TerminalInfo.title follows Claude's live name, create accepts `label` (a display-only title until Claude reports one),
 * TerminalInfo carries nameSync and Resumable carries name. Without it: names stay in Atelier, as before.
 * 'lastmessage' = SessionInfo.lastMessageAt: Resumable carries it, and create accepts `lastMessageAt`
 * (a resumed conversation's last message time, for its new session). Without it: rows show no last message time.
 * 'resume-config-dir' = Resumable carries the session's `configDir`, and resume accepts `configDir`:
 * the dir the app picked (null: the default account), prefixed as `CLAUDE_CONFIG_DIR='<dir>'`. Without it
 * the field is stripped and a resume runs plain `claude --resume`, as before.
 * 'schedules' = scheduled prompts: the sched* requests and the `schedules`
 * message (after welcome and on every change). Without it the app shows the feature disabled until atelierd restarts.
 * 'kill-resumable' = kill accepts `resumable: true`: the terminal's Claude
 * session comes back under Resume once its shell exits. Without it a window closing keeps its sessions running.
 * 'signals' = the Claude Code signals notebook: the `signals` message (after
 * welcome and on every change, debounced 2 s) and the signalsClear request. Without it Settings › Claude shows the row
 * disabled until atelierd restarts.
 */
export const DAEMON_CAPABILITIES = ['profiles', 'states2', 'background', 'toolcalls', 'aliases', 'names', 'lastmessage', 'config-dirs', 'resume-config-dir', 'schedules', 'kill-resumable', 'signals'] as const;
export type DaemonCapability = (typeof DAEMON_CAPABILITIES)[number];

/** Capabilities from a welcome message; an atelierd older than capabilities sends none. */
export function daemonCapabilities(welcome: unknown): string[] {
  const c = (welcome as { capabilities?: unknown } | null)?.capabilities;
  return Array.isArray(c) ? c.filter((x): x is string => typeof x === 'string') : [];
}

export const clientRequestSchema = z.discriminatedUnion('t', [
  z.object({ t: z.literal('list'), rid: z.number().int() }),
  z.object({
    t: z.literal('create'), rid: z.number().int(), projectRoot: absPath, cwd: absPath,
    cols: dim, rows: dim, name: z.string().max(200).optional(), command: z.string().max(10000).optional(),
    profile: profileSchema.optional(), aliases: z.boolean().optional(), label: z.string().max(200).optional(),
    lastMessageAt: z.number().optional()
  }),
  z.object({ t: z.literal('attach'), rid: z.number().int(), id }),
  z.object({ t: z.literal('detach'), rid: z.number().int(), id }),
  z.object({ t: z.literal('input'), id, data: z.string().max(1024 * 1024) }),
  z.object({ t: z.literal('resize'), id, cols: dim, rows: dim }),
  // resumable (capability 'kill-resumable'): its Claude session comes back under Resume.
  z.object({ t: z.literal('kill'), rid: z.number().int(), id, resumable: z.boolean().optional() }),
  z.object({ t: z.literal('shutdown'), rid: z.number().int() }),
  z.object({ t: z.literal('rename'), rid: z.number().int(), id, name: z.string().max(200).nullable() }),
  z.object({ t: z.literal('markSeen'), rid: z.number().int(), id }),
  // configDir (capability 'resume-config-dir'): another Claude account's dir to resume with, null for the default one.
  z.object({ t: z.literal('resume'), rid: z.number().int(), id, cols: dim, rows: dim, profile: profileSchema.optional(), aliases: z.boolean().optional(), configDir: z.string().max(4096).refine(isCleanAbsPath).nullable().optional() }),
  z.object({ t: z.literal('dismiss'), rid: z.number().int(), id }),
  // Captures the user's shell environment again for Atelier-profile terminals (replies when done, up to ~10 s).
  z.object({ t: z.literal('reloadEnv'), rid: z.number().int() }),
  z.object({ t: z.literal('attrPrune'), rid: z.number().int(), root: absPath, dirty: z.array(absPath).max(100000), exclude: z.array(absPath).max(1000).optional(), before: z.number().optional() }),
  // Scheduled prompts (capability 'schedules'). schedRestore's prompt is checked by atelierd's own schema.
  z.object({ t: z.literal('schedAdd'), rid: z.number().int(), ...scheduleAddFields }),
  z.object({ t: z.literal('schedUpdate'), rid: z.number().int(), ...scheduleUpdateFields }),
  z.object({ t: z.literal('schedRemove'), rid: z.number().int(), id }),
  z.object({ t: z.literal('schedRestore'), rid: z.number().int(), prompt: z.unknown() }),
  z.object({ t: z.literal('schedFire'), rid: z.number().int(), id, force: z.literal('usage').optional() }),
  z.object({ t: z.literal('schedSnooze'), rid: z.number().int(), id, minutes: z.number().int().min(1).max(1440) }),
  // The signals notebook (capability 'signals'): empties its entries, keeps the last Claude Code version.
  z.object({ t: z.literal('signalsClear'), rid: z.number().int() })
]);
export type ClientRequest = z.infer<typeof clientRequestSchema>;

export const headerSchema = z.discriminatedUnion('t', [
  z.object({ t: z.literal('hello'), token: z.string().max(256), v: z.number().int() }),
  // Stops atelierd whatever the client's protocol version: the control token only. Windows has
  // no graceful signal for an atelierd that speaks another version.
  z.object({ t: z.literal('stop'), token: z.string().max(256) }),
  z.object({ t: z.literal('hook'), token: z.string().max(256), term: id }),
  z.object({ t: z.literal('status'), token: z.string().max(256), term: id })
]);
export type Header = z.infer<typeof headerSchema>;

export type ServerMessage =
  | { t: 'welcome'; v: number; version: string; pid: number; capabilities?: string[] }
  /** The answer to a `stop` header, right before atelierd stops. */
  | { t: 'stopping' }
  | { t: 'incompatible'; v: number }
  | { t: 'reply'; rid: number; ok: true; result?: unknown }
  | { t: 'reply'; rid: number; ok: false; error: string }
  | { t: 'snapshot'; id: string; data: string; done: boolean }
  | { t: 'data'; id: string; data: string }
  | { t: 'exit'; id: string; code: number | null }
  | { t: 'terminals'; list: TerminalInfo[] }
  | { t: 'usage'; usage: Usage | null }
  | { t: 'usageByConfigDir'; list: UsageEntry[] }
  | { t: 'attributions'; list: Attribution[] }
  | { t: 'toolCalls'; list: ToolCallWindow[]; full: boolean }
  | { t: 'resumables'; list: Resumable[] }
  | ({ t: 'shellEnv' } & ShellEnvState)
  | { t: 'schedules'; list: ScheduledPrompt[] }
  | { t: 'signals'; book: SignalBookView };

export function encode(msg: unknown): string {
  return JSON.stringify(msg) + '\n';
}

/** Splits a text stream into NDJSON lines, with a cap on the line in progress. */
export class LineDecoder {
  private buf = '';
  constructor(private readonly max = MAX_LINE_CHARS) {}

  push(chunk: string): string[] {
    this.buf += chunk;
    const lines: string[] = [];
    let i: number;
    while ((i = this.buf.indexOf('\n')) !== -1) {
      lines.push(this.buf.slice(0, i));
      this.buf = this.buf.slice(i + 1);
    }
    if (this.buf.length > this.max) throw new Error('line too long');
    return lines;
  }

  /** What arrived after the last complete line. */
  rest(): string {
    return this.buf;
  }
}
