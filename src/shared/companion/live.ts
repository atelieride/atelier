// Ask companion: the facts of the live strip, from what the app already knows about the session.
import { effectiveState, workSummary } from '../background';
import type { TerminalInfo } from '../protocol';
import { isWaiting } from '../session-view';

export interface LiveFacts {
  state: 'working' | 'waiting' | 'idle' | 'done' | 'error' | 'ended';
  since: number | null;
  work: string | null;
  files: number;
  added: number;
  removed: number;
}

export function liveFacts(term: TerminalInfo | null, o: { since: number | null; files: number; now: number /* part of the contract; the strip derives "since" itself */ }): LiveFacts {
  const base = { since: o.since, files: o.files };
  const session = term?.session ?? null;
  if (!term || !session) return { ...base, state: 'ended', work: null, added: 0, removed: 0 };
  const eff = effectiveState(term);
  const state: LiveFacts['state'] = eff === 'error' ? 'error' : isWaiting(session) ? 'waiting' : eff === 'running' ? 'working' : eff === 'done' ? 'done' : 'idle';
  return {
    ...base, state,
    work: term.work ? workSummary(term.work) : null,
    added: session.cost?.linesAdded ?? 0,
    removed: session.cost?.linesRemoved ?? 0,
  };
}
