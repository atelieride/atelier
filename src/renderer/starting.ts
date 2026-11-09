import type { TerminalInfo } from '@shared/protocol';

// Terminals launched as Claude sessions (New Session, Resume, a conversation from the history): until Claude's
// SessionStart arrives they are "starting" sessions, listed and drawn as sessions — never a plain terminal that jumps
// to Sessions a moment later.

/** Without a session this long after the launch, Claude did not start: it is a plain terminal (atelierd's window too). */
export const STARTING_MS = 30_000;

/** Terminal id → when it was launched as a session. */
export type Starting = Readonly<Record<string, number>>;

export function markStarting(starting: Starting, id: string, now: number): Starting {
  return { ...starting, [id]: now };
}

export function isStarting(term: Pick<TerminalInfo, 'id' | 'session'>, starting: Starting): boolean {
  return !term.session && starting[term.id] !== undefined;
}

/**
 * Drops the terminals whose session arrived and those past the window; the same object when nothing changes. A terminal
 * not in the list yet is kept (the create reply comes before atelierd's list); one that exited goes with the window.
 */
export function pruneStarting(starting: Starting, terminals: TerminalInfo[], now: number): Starting {
  const withSession = new Set(terminals.filter((x) => x.session).map((x) => x.id));
  const keep = Object.entries(starting).filter(([id, at]) => !withSession.has(id) && now - at < STARTING_MS);
  return keep.length === Object.keys(starting).length ? starting : Object.fromEntries(keep);
}
