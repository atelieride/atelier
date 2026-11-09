import { BASH_SLACK_MS, CHANGE_LOOKBACK_MS, type FileState } from './bash-attribution';
import { readOnlyCommand } from './readonly-command';
import type { ToolCallWindow } from './tool-calls';

/**
 * Who changed a file, from atelierd's tool-call windows: the one session with a writing
 * call running when the file changed, else unclear between all of them; foreground calls first.
 */

/** atelierd's event-loop delay around a hook: same machine, same clock. */
export const CALL_SLACK_MS = 300;

/** Every call may write, except a Bash or Monitor call whose command is proven read-only. */
export function mayWrite(c: ToolCallWindow): boolean {
  return !((c.tool === 'Bash' || c.tool === 'Monitor') && c.command !== undefined && readOnlyCommand(c.command));
}

const overlaps = (c: ToolCallWindow, lo: number, hi: number, slack: number) =>
  c.start - slack <= hi && (c.end === null || c.end + slack >= lo);

/** Whether an eligible session had a writing call between `from` and `to` (else nothing is worth a stat). */
export function writingCallBetween(calls: ToolCallWindow[], from: number, to: number, eligible: (terminalId: string) => boolean, slack = CALL_SLACK_MS): boolean {
  return calls.some((c) => eligible(c.terminalId) && overlaps(c, from, to, slack) && mayWrite(c));
}

/** When the file changed: its mtime when that falls in the status interval (`from`..`to`, with the slacks), else null. */
export function changeTime(change: FileState, from: number, to: number, slack = CALL_SLACK_MS): number | null {
  return change.mtime !== null && change.mtime >= from - BASH_SLACK_MS && change.mtime <= to + slack ? change.mtime : null;
}

export type CallCulprit =
  | { kind: 'one'; call: ToolCallWindow }
  | { kind: 'maybe'; call: ToolCallWindow }
  | { kind: 'unclear'; calls: ToolCallWindow[] };

/**
 * The change time is the file's mtime when it falls in the status interval (`from`..`to`, with BASH_SLACK_MS before
 * it, as `changedFiles` counts after an unknown snapshot); otherwise (deleted file, mtime kept by mv or cp -p) the
 * last seconds before `to`. One call per terminal (its latest), sorted by terminal id. A writing call of a terminal
 * that is not `known` (it may be ours, we cannot tell) overlapping the change: no culprit. Background shells count
 * only when no foreground call matches, and one alone is a `maybe`: a dev server or watcher runs for hours, the
 * change may as well be the user's.
 */
export function callCulprit(change: FileState, from: number, to: number, calls: ToolCallWindow[], eligible: (terminalId: string) => boolean, slack = CALL_SLACK_MS, lookback = CHANGE_LOOKBACK_MS, known: (terminalId: string) => boolean = () => true): CallCulprit | null {
  const at = changeTime(change, from, to, slack);
  const lo = at ?? Math.max(from, to - lookback);
  const hi = at ?? to;
  if (calls.some((c) => !known(c.terminalId) && overlaps(c, lo, hi, slack) && mayWrite(c))) return null;
  const hits = calls.filter((c) => eligible(c.terminalId) && overlaps(c, lo, hi, slack) && mayWrite(c));
  const foreground = hits.filter((c) => !c.background);
  const pool = foreground.length > 0 ? foreground : hits;
  const byTerminal = new Map<string, ToolCallWindow>();
  for (const c of pool) {
    const seen = byTerminal.get(c.terminalId);
    if (!seen || c.start >= seen.start) byTerminal.set(c.terminalId, c);
  }
  const picked = [...byTerminal.values()].sort((a, b) => a.terminalId.localeCompare(b.terminalId));
  if (picked.length === 0) return null;
  if (picked.length > 1) return { kind: 'unclear', calls: picked };
  return foreground.length > 0 ? { kind: 'one', call: picked[0]! } : { kind: 'maybe', call: picked[0]! };
}
