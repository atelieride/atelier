// Live files (spec git writes, Vocabulary): files a session surely changed during its current turn. The drawer, the
// Commit all cards, Pull, Switch, Stash and Discard warn about them; nothing blocks on them.
import { isUnsure, type Attribution } from '@shared/attribution';
import { effectiveState } from '@shared/background';
import { waitKind } from '@shared/session-view';
import type { TerminalInfo } from '@shared/protocol';

export interface LiveBy { terminalId: string; title: string; color: string }

/**
 * A session's turn is current while it runs, waits on a permission or a question, or is done with background work
 * still counting (effectiveState). Waiting for a new prompt, idle, error and plain done are not.
 */
export function inTurn(t: Pick<TerminalInfo, 'session' | 'work'>): boolean {
  if (!t.session) return false;
  return effectiveState(t) === 'running' || waitKind(t.session) !== null;
}

/**
 * path → the session editing it now. "During its current turn": the attribution is at or after the session's last
 * message; without lastMessageAt (an older atelierd) any of its attributions counts. An attribution of another
 * conversation that ran in the same terminal never does. Two live sessions on one file: the latest edit names it.
 */
export function liveFiles(terminals: readonly Pick<TerminalInfo, 'id' | 'session' | 'work'>[], attributions: readonly Attribution[]): Map<string, LiveBy> {
  const live = new Map(terminals.filter(inTurn).map((t) => [t.id, t.session!]));
  const out = new Map<string, LiveBy & { at: number }>();
  for (const a of attributions) {
    const s = live.get(a.terminalId);
    if (!s || isUnsure(a)) continue;
    if (a.sessionId && s.sessionId && a.sessionId !== s.sessionId) continue;
    if (s.lastMessageAt != null && a.at < s.lastMessageAt) continue;
    const prev = out.get(a.path);
    if (!prev || a.at >= prev.at) out.set(a.path, { terminalId: a.terminalId, title: a.title, color: a.color, at: a.at });
  }
  return new Map([...out].map(([path, { at: _at, ...by }]) => [path, by]));
}

/** The incoming paths (relative to `root`) a live session is changing, and the sessions, in order of appearance. */
export function overlapFiles(root: string, incoming: readonly string[], live: ReadonlyMap<string, LiveBy>): { files: string[]; who: LiveBy[] } {
  const files: string[] = [];
  const who = new Map<string, LiveBy>();
  for (const rel of incoming) {
    const by = live.get(`${root}/${rel}`);
    if (!by) continue;
    files.push(rel);
    if (!who.has(by.terminalId)) who.set(by.terminalId, by);
  }
  return { files, who: [...who.values()] };
}
