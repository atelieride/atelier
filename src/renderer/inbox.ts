// Inbox: the sessions list grouped by what they need from you.
import type { TerminalInfo } from '@shared/protocol';
import { pinnedFirst } from './pins';
import { isLimitPaused, needsYou } from '@shared/session-view';
import { effectiveState } from '@shared/background';

export type InboxSection = 'needs' | 'review' | 'working' | 'idle';
export const INBOX_ORDER: InboxSection[] = ['needs', 'review', 'working', 'idle'];

/**
 * Needs you: waiting for a permission or an answer, or stopped by an error (the idle notice, waitingFor 'input', is not:
 * that session is finished or idle). Ready for review: finished and not seen yet.
 * Working: running, or counting background work (it beats review: the work isn't over), or paused at a usage limit
 *. Idle: everything else
 * (idle, finished and already seen).
 */
export function inboxSection(term: TerminalInfo): InboxSection {
  const s = term.session;
  if (!s) return 'idle';
  if (needsYou(s)) return 'needs';
  if (isLimitPaused(s)) return 'working';
  const state = effectiveState(term);
  if (state === 'done' && s.unread) return 'review';
  if (state === 'running') return 'working';
  return 'idle';
}

/** The section a row is in, and when it entered it. */
export interface Entered { section: InboxSection; at: number }

/**
 * When each row entered its current section: kept while it stays there (a tool call doesn't move it), `now` when it
 * changes section; a row seen for the first time entered when it was last updated (a starting one: when it was launched).
 * Rows that are gone are forgotten.
 */
export function trackSections(prev: Map<string, Entered>, sessions: TerminalInfo[], now: number): Map<string, Entered> {
  const next = new Map<string, Entered>();
  for (const x of sessions) {
    const section = inboxSection(x);
    const was = prev.get(x.id);
    // A starting session (no session yet) entered when it was launched.
    next.set(x.id, was?.section === section ? was : { section, at: was ? now : x.session?.updatedAt ?? x.createdAt });
  }
  return next;
}

/**
 * Non-empty sections in order; inside each, pinned rows first (pin order), then the row that entered the section last
 * (`entered`, from trackSections; without it, the most recently updated).
 */
export function groupSessions(sessions: TerminalInfo[], pins: string[], entered?: Map<string, Entered>): { key: InboxSection; items: TerminalInfo[] }[] {
  const by = new Map<InboxSection, TerminalInfo[]>(INBOX_ORDER.map((k) => [k, []]));
  for (const x of sessions) by.get(inboxSection(x))!.push(x);
  const since = (x: TerminalInfo) => entered?.get(x.id)?.at ?? x.session?.updatedAt ?? 0;
  return INBOX_ORDER
    .map((key) => {
      // Ties keep creation order, so rows don't swap places on every list.
      const sorted = [...by.get(key)!].sort((a, b) => since(b) - since(a) || a.createdAt - b.createdAt);
      return { key, items: pinnedFirst(sorted, pins) };
    })
    .filter((g) => g.items.length > 0);
}

// A new key since grouping became the default: a choice saved under the old one ('atelier.groupByState') was made when
// it was off by default, so it is not carried over.
const KEY = 'atelier.groupByState.v2';

/** Group by state, remembered per viewer (on by default, and whenever storage is missing). */
export function loadGroupByState(): boolean {
  try { return typeof localStorage === 'undefined' || localStorage.getItem(KEY) !== '0'; } catch { return true; }
}

export function saveGroupByState(on: boolean): void {
  try { localStorage.setItem(KEY, on ? '1' : '0'); } catch { /* not saved: stays for this session */ }
}
