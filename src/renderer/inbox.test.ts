import { afterEach, expect, test } from 'vitest';
import type { TerminalInfo } from '@shared/protocol';
import type { SessionInfo, SessionState } from '@shared/session';
import type { BackgroundWork } from '@shared/background';
import { groupSessions, inboxSection, loadGroupByState, saveGroupByState, trackSections } from './inbox';

const s = (id: string, state: SessionState, opts: { unread?: boolean; updatedAt?: number; createdAt?: number } = {}): TerminalInfo => ({
  id, projectRoot: '/p', cwd: '/p', title: id, name: null, color: '#fff', foreground: 'claude', createdAt: opts.createdAt ?? 0,
  session: { sessionId: id, state, title: null, activity: null, contextPct: null, unread: opts.unread ?? false, updatedAt: opts.updatedAt ?? 0 }
});

const work = (counting: boolean): BackgroundWork => ({ counting, agents: 0, shells: 0, monitors: 0, other: 0, idle: 0, items: [], crons: [], entries: [], nextChange: null });
const withWork = (x: TerminalInfo, counting: boolean): TerminalInfo => ({ ...x, work: work(counting) });

test('background work counts as working', () => {
  // Counting beats Ready for review and Idle; only the Needs you section wins over it.
  expect(inboxSection(withWork(s('a', 'done', { unread: true }), true))).toBe('working');
  expect(inboxSection(withWork(s('a', 'idle'), true))).toBe('working');
  expect(inboxSection(withWork(s('a', 'waiting'), true))).toBe('needs');
  // Capped-only work does not count: back to the main state.
  expect(inboxSection(withWork(s('a', 'done', { unread: true }), false))).toBe('review');
  expect(inboxSection(withWork(s('a', 'idle'), false))).toBe('idle');
});

test('every state goes to its section', () => {
  expect(inboxSection(s('a', 'waiting'))).toBe('needs');
  expect(inboxSection(s('a', 'error'))).toBe('needs');
  expect(inboxSection(s('a', 'error', { unread: true }))).toBe('needs');
  expect(inboxSection(s('a', 'done', { unread: true }))).toBe('review');
  expect(inboxSection(s('a', 'running'))).toBe('working');
  expect(inboxSection(s('a', 'idle'))).toBe('idle');
  // A finished session already seen is just idle.
  expect(inboxSection(s('a', 'done'))).toBe('idle');
});

test('sections in order, empty ones left out, each with its rows', () => {
  const list = [s('i', 'idle'), s('r', 'running'), s('w', 'waiting'), s('d', 'done', { unread: true })];
  expect(groupSessions(list, []).map((g) => [g.key, g.items.map((x) => x.id)])).toEqual([
    ['needs', ['w']], ['review', ['d']], ['working', ['r']], ['idle', ['i']]
  ]);
  expect(groupSessions([s('r', 'running')], []).map((g) => g.key)).toEqual(['working']);
  expect(groupSessions([], [])).toEqual([]);
});

test('inside a section: pinned first in pin order, then most recently updated first', () => {
  const list = [
    s('old', 'waiting', { updatedAt: 1 }), s('new', 'waiting', { updatedAt: 9 }), s('mid', 'error', { updatedAt: 5 }),
    s('p1', 'waiting', { updatedAt: 0 }), s('p2', 'waiting', { updatedAt: 3 })
  ];
  expect(groupSessions(list, ['p2', 'p1'])[0]!.items.map((x) => x.id)).toEqual(['p2', 'p1', 'new', 'mid', 'old']);
});

test('Idle follows the manual order after the unplaced; other sections ignore it', () => {
  const list = [
    s('a', 'idle', { updatedAt: 1 }), s('b', 'idle', { updatedAt: 2 }), s('c', 'idle', { updatedAt: 3 }), s('d', 'idle', { updatedAt: 4 }),
    s('r1', 'running', { updatedAt: 1 }), s('r2', 'running', { updatedAt: 2 }), s('p', 'idle', { updatedAt: 0 })
  ];
  const shown = (order?: string[]) => groupSessions(list, ['p'], undefined, order).map((g) => [g.key, g.items.map((x) => x.id)]);
  // Unplaced first (the latest to arrive on top, as without an order), then the placed ones in their order; pins first.
  expect(shown(['d', 'b', 'r1'])).toEqual([['working', ['r2', 'r1']], ['idle', ['p', 'c', 'a', 'd', 'b']]]);
  expect(shown([])).toEqual(shown());
});

test('ties on updatedAt keep creation order (stable rows)', () => {
  const list = [s('a', 'idle', { createdAt: 1 }), s('b', 'idle', { createdAt: 2 })];
  expect(groupSessions(list, [])[0]!.items.map((x) => x.id)).toEqual(['a', 'b']);
});

test('rows keep their place while they stay in a section: ordered by when they entered it, not by every update', () => {
  // First sight: a row entered its section when it was last updated.
  let entered = trackSections(new Map(), [s('a', 'running', { updatedAt: 1 }), s('b', 'running', { updatedAt: 2 })], 100);
  expect(groupSessions([s('a', 'running', { updatedAt: 1 }), s('b', 'running', { updatedAt: 2 })], [], entered)[0]!.items.map((x) => x.id)).toEqual(['b', 'a']);
  // A tool call updates a (updatedAt 50): it does not jump above b.
  let list = [s('a', 'running', { updatedAt: 50 }), s('b', 'running', { updatedAt: 2 })];
  entered = trackSections(entered, list, 200);
  expect(groupSessions(list, [], entered)[0]!.items.map((x) => x.id)).toEqual(['b', 'a']);
  // c starts working later: it entered the section now, so it is the newest there.
  list = [...list, s('c', 'waiting', { updatedAt: 60 })];
  entered = trackSections(entered, list, 300);
  list = list.map((x) => (x.id === 'c' ? s('c', 'running', { updatedAt: 70 }) : x));
  entered = trackSections(entered, list, 400);
  expect(entered.get('c')).toEqual({ section: 'working', at: 400 });
  expect(groupSessions(list, [], entered)[0]!.items.map((x) => x.id)).toEqual(['c', 'b', 'a']);
  // Needs you: the one that entered it last comes first; pins still first.
  list = list.map((x) => (x.id === 'a' ? s('a', 'waiting', { updatedAt: 80 }) : x.id === 'b' ? s('b', 'waiting', { updatedAt: 81 }) : x));
  entered = trackSections(entered, list.map((x) => (x.id === 'b' ? s('b', 'running', { updatedAt: 2 }) : x)), 500);
  entered = trackSections(entered, list, 600);
  expect(groupSessions(list, [], entered)[0]!.items.map((x) => x.id)).toEqual(['b', 'a']);
  expect(groupSessions(list, ['a'], entered)[0]!.items.map((x) => x.id)).toEqual(['a', 'b']);
  // Rows that are gone are forgotten.
  expect([...trackSections(entered, [list[0]!], 700).keys()]).toEqual(['a']);
});

const store = new Map<string, string>();
const fakeStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) };
afterEach(() => { store.clear(); delete (globalThis as { localStorage?: unknown }).localStorage; });

test('the preference is remembered; on by default and when storage is missing or broken', () => {
  expect(loadGroupByState()).toBe(true);
  (globalThis as { localStorage?: unknown }).localStorage = fakeStorage;
  expect(loadGroupByState()).toBe(true);
  saveGroupByState(false);
  expect(loadGroupByState()).toBe(false);
  saveGroupByState(true);
  expect(loadGroupByState()).toBe(true);
  (globalThis as { localStorage?: unknown }).localStorage = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } };
  expect(loadGroupByState()).toBe(true);
  expect(() => saveGroupByState(true)).not.toThrow();
});

test('the choice saved when grouping was off by default is not carried over: everyone starts grouped once', () => {
  (globalThis as { localStorage?: unknown }).localStorage = fakeStorage;
  store.set('atelier.groupByState', '0');
  expect(loadGroupByState()).toBe(true);
});

test('states2: Needs you = a permission or a question (or an error); the idle notice goes to Ready for review / Idle', () => {
  const w = (state: SessionState, waitingFor: 'permission' | 'question' | 'input', unread = false): TerminalInfo => ({ ...s('a', state, { unread }), session: { ...s('a', state, { unread }).session!, waitingFor } });
  expect(inboxSection(w('waiting', 'permission'))).toBe('needs');
  expect(inboxSection(w('waiting', 'question'))).toBe('needs');
  expect(inboxSection(w('idle', 'input'))).toBe('idle');
  expect(inboxSection(w('done', 'input', true))).toBe('review');
  expect(inboxSection(w('waiting', 'input'))).toBe('idle');
});

// Claude Code goes on by itself when the limit resets.
test('a session paused at its usage limit sits under Working; once the pause ends without a continuation it needs you', () => {
  const limited = (limitPause?: SessionInfo['limitPause']): TerminalInfo => {
    const x = s('a', 'error', { unread: true });
    return { ...x, session: { ...x.session!, errorReason: 'rate_limit', ...(limitPause ? { limitPause } : {}) } };
  };
  expect(inboxSection(limited({ since: 1, resetsAt: 9 }))).toBe('working');
  // Checking (atelierd still looking for proof): already paused.
  expect(inboxSection(limited({ since: 1, resetsAt: null }))).toBe('working');
  expect(inboxSection(limited({ since: 1, resetsAt: 9, over: 'expired' }))).toBe('needs');
  // An older atelierd never sends the pause: today's error.
  expect(inboxSection(limited())).toBe('needs');
});
