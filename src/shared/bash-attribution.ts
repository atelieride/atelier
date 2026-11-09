import type { Attribution } from './attribution';
import type { SessionInfo } from './session';
import { isBelow, samePath, trimOneSep } from './paths';

/**
 * Files changed through Bash. atelierd only attributes Edit/Write hooks; the app records when each
 * session was running a Bash command and, at every git status, gives a file that changed meanwhile to the one session
 * that was in Bash then. Two or more (or none): no guess. A daemon attribution for the same path always wins.
 *
 * The signal is the session's activity from the hooks ("Bash: …" after PreToolUse, "waiting: Bash …" on a permission
 * request); PostToolUse does not change it, so a window ends at the next hook that does (next tool, Stop, prompt).
 * A session with subagents running counts as in Bash throughout: their tool calls do not show in its activity.
 */

/** Bash windows older than this are forgotten. */
export const BASH_KEEP_MS = 10 * 60_000;
/** Tolerance around a file's mtime (clocks are the same machine's; hooks arrive a few ms apart from the command). */
export const BASH_SLACK_MS = 1000;
/** Without a usable mtime, how far before a status a change can have happened (the watcher asks for it promptly). */
export const CHANGE_LOOKBACK_MS = 10_000;
/** At most this many Bash attributions are kept (the newest). */
export const MAX_BASH_ATTRIBUTIONS = 2000;
const MAX_WINDOWS = 200;

export interface BashWindow { terminalId: string; sessionId: string; start: number; end: number | null }
export interface FileState { path: string; mtime: number | null }

const BASH = /^(waiting: )?Bash(:? |$)/;

/**
 * Whether the session is running (or about to run, once approved) a Bash call, or may be: while subagents run, the
 * activity shows only one agent's tool, and none at all for a background subagent after the main turn is over.
 */
export function inBash(s: SessionInfo | null): boolean {
  if (!s) return false;
  if ((s.subagents ?? 0) > 0) return true;
  return (s.state === 'running' || s.state === 'waiting') && !!s.activity && BASH.test(s.activity);
}

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

/**
 * The Bash windows after a new terminal list: a window opens at the hook that entered Bash (the session's last hook
 * time) and closes at the hook that left it; a terminal gone or a new session in it closes it now.
 */
export function trackBashWindows(prev: BashWindow[], terminals: { id: string; session: SessionInfo | null }[], now: number, keepMs = BASH_KEEP_MS): BashWindow[] {
  const byId = new Map(terminals.map((t) => [t.id, t.session]));
  const out: BashWindow[] = [];
  const open = new Set<string>();
  for (const w of prev) {
    if (w.end !== null) { out.push(w); continue; }
    const s = byId.get(w.terminalId) ?? null;
    if (s && s.sessionId === w.sessionId) {
      if (inBash(s)) { out.push(w); open.add(w.terminalId); continue; }
      out.push({ ...w, end: clamp(s.updatedAt, w.start, now) });
    } else {
      out.push({ ...w, end: now });
    }
  }
  for (const t of terminals) {
    if (!open.has(t.id) && t.session && inBash(t.session)) out.push({ terminalId: t.id, sessionId: t.session.sessionId, start: Math.min(t.session.updatedAt, now), end: null });
  }
  const kept = out.filter((w) => w.end === null || w.end >= now - keepMs);
  if (kept.length <= MAX_WINDOWS) return kept;
  // Too many: the oldest closed ones go first (open ones are always kept).
  const closed = kept.filter((w) => w.end !== null);
  const drop = new Set(closed.slice(0, kept.length - MAX_WINDOWS));
  return kept.filter((w) => !drop.has(w));
}

/**
 * Files that became dirty, or whose mtime changed, since the previous status (undefined: none yet, a baseline). When
 * the previous status's mtimes were not read (`unknownSince`: its time), a file it had counts only if its mtime is
 * after that time; one gone since (no mtime) does not (when it went is unknown: no guess).
 */
export function changedFiles(prev: ReadonlyMap<string, number | null> | undefined, current: FileState[], unknownSince?: number): FileState[] {
  if (!prev) return [];
  if (unknownSince !== undefined) return current.filter((f) => !prev.has(f.path) || (f.mtime !== null && f.mtime >= unknownSince));
  return current.filter((f) => !prev.has(f.path) || prev.get(f.path) !== f.mtime);
}

/** Whether an eligible terminal was in Bash at some point between `from` and `to` (with the slack around both). */
export function bashBetween(windows: BashWindow[], from: number, to: number, eligible: (terminalId: string) => boolean, slack = BASH_SLACK_MS): boolean {
  return windows.some((w) => eligible(w.terminalId) && w.start <= to + slack && (w.end === null || w.end >= from - slack));
}

/**
 * The window of the one terminal that was in Bash when `change` happened, between the statuses at `from` and `to`.
 * The change time is the file's mtime when it falls in that interval; otherwise (deleted file, mtime kept by mv or
 * cp -p) the last seconds before `to`. null when no eligible terminal or two or more were in Bash then.
 */
export function bashCulprit(change: FileState, from: number, to: number, windows: BashWindow[], eligible: (terminalId: string) => boolean, slack = BASH_SLACK_MS, lookback = CHANGE_LOOKBACK_MS): BashWindow | null {
  let lo = Math.max(from, to - lookback);
  let hi = to;
  if (change.mtime !== null && change.mtime >= from - slack && change.mtime <= to + slack) {
    lo = change.mtime - slack;
    hi = change.mtime + slack;
  }
  const byTerminal = new Map<string, BashWindow>();
  for (const w of windows) {
    if (!eligible(w.terminalId)) continue;
    if (w.start > hi || (w.end !== null && w.end < lo)) continue;
    const seen = byTerminal.get(w.terminalId);
    if (!seen || w.start >= seen.start) byTerminal.set(w.terminalId, w);
  }
  return byTerminal.size === 1 ? [...byTerminal.values()][0]! : null;
}

/** Whether two folders are the same or one contains the other (a project and one of its repos, either way). */
export function relatedRoots(a: string, b: string): boolean {
  const under = (x: string, y: string) => isBelow(trimOneSep(y), x);
  return samePath(a, b) || under(a, b) || under(b, a);
}

/** Adds Bash attributions (one per file and terminal, the newest wins), marked `via: 'bash'` unless they say otherwise, keeping the newest `max`. */
export function addBashAttributions(list: Attribution[], adds: Attribution[], max = MAX_BASH_ATTRIBUTIONS): Attribution[] {
  let out = list;
  for (const a of adds) out = [...out.filter((x) => !(x.path === a.path && x.terminalId === a.terminalId)), { ...a, via: a.via ?? ('bash' as const) }];
  if (out.length <= max) return out;
  return [...out].sort((x, y) => x.at - y.at).slice(out.length - max);
}

/** Daemon attributions plus the Bash ones for paths no daemon attribution covers (an Edit/Write always wins). */
export function mergeAttributions(daemon: Attribution[], bash: Attribution[]): Attribution[] {
  const edited = new Set(daemon.map((a) => a.path));
  return [...daemon, ...bash.filter((a) => !edited.has(a.path))];
}
