import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { TerminalInfo } from '@shared/protocol';
import { STARTING_MS, isStarting, markStarting, pruneStarting } from './starting';
import { splitTerminals } from './selectors';
import { groupSessions, trackSections } from './inbox';
import { useApp } from './store';
import { single } from './split';

// A terminal launched as a Claude session is shown as a starting session until Claude's SessionStart arrives: never a
// plain terminal that jumps to Sessions a moment later.

const term = (id: string, createdAt = 0, session = false): TerminalInfo => ({
  id, projectRoot: '/p', cwd: '/p', title: id, name: null, color: '#B794F6', foreground: 'zsh', createdAt,
  session: session ? { sessionId: id, state: 'idle', title: null, activity: null, contextPct: null, unread: false, updatedAt: createdAt } : null
});

test('isStarting: launched as a session and still session-less', () => {
  const starting = markStarting({}, 'a', 1000);
  expect(isStarting(term('a'), starting)).toBe(true);
  expect(isStarting(term('a', 0, true), starting)).toBe(false);
  expect(isStarting(term('b'), starting)).toBe(false);
});

test('pruneStarting: the session arrived, or the window passed; otherwise the same object', () => {
  let s = markStarting(markStarting(markStarting({}, 'a', 1000), 'b', 1000), 'c', 5000);
  // Not in the list yet (the reply comes before atelierd's list): kept.
  expect(pruneStarting(s, [term('a'), term('b')], 2000)).toBe(s);
  s = pruneStarting(s, [term('a', 0, true), term('b'), term('c')], 2000);
  expect(Object.keys(s).sort()).toEqual(['b', 'c']);
  s = pruneStarting(s, [term('b'), term('c')], 1000 + STARTING_MS);
  expect(Object.keys(s)).toEqual(['c']);
});

test('splitTerminals: a starting terminal is listed with the sessions (by age), never with the terminals', () => {
  const list = [term('shell', 1), term('s', 2, true), term('new', 3)];
  const r = splitTerminals(list, markStarting({}, 'new', 0));
  expect(r.sessions.map((x) => x.id)).toEqual(['s', 'new']);
  expect(r.shells.map((x) => x.id)).toEqual(['shell']);
  expect(splitTerminals(list).shells.map((x) => x.id)).toEqual(['shell', 'new']);
});

test('inbox: a starting session is idle (not waiting), newest first, and keeps its place when its session arrives', () => {
  const old = { ...term('old', 1, true), session: { ...term('old', 1, true).session!, updatedAt: 50 } };
  let entered = trackSections(new Map(), [old, term('new', 100)], 200);
  expect(groupSessions([old, term('new', 100)], [], entered)).toEqual([{ key: 'idle', items: [term('new', 100), old] }]);
  const arrived = { ...term('new', 100, true), session: { ...term('new', 100, true).session!, updatedAt: 300 } };
  entered = trackSections(entered, [old, arrived], 300);
  expect(groupSessions([old, arrived], [], entered)[0]!.items.map((x) => x.id)).toEqual(['new', 'old']);
});

const st = () => useApp.getState();
beforeEach(() => {
  vi.useFakeTimers();
  useApp.setState({ project: null, terminals: [], selectedId: null, activeTab: 'term', tabOrder: [], hidden: [], pins: [], openFiles: [], preview: null, pendingAnchor: null, split: single(), toast: null, dirty: {}, starting: {} });
});
afterEach(() => { vi.useRealTimers(); });

test('store: launched() shows the terminal as a starting session; the session arriving ends it', () => {
  st().launched(term('n', 1));
  expect(st().selectedId).toBe('n');
  expect(isStarting(st().terminals[0]!, st().starting)).toBe(true);
  st().setTerminals([term('n', 1, true)]);
  expect(st().starting).toEqual({});
});

test('store: 30 s without a session, it becomes a plain terminal (Claude failed to start)', () => {
  st().launched(term('n', 1));
  vi.advanceTimersByTime(STARTING_MS - 1000);
  expect(splitTerminals(st().terminals, st().starting).sessions.map((x) => x.id)).toEqual(['n']);
  vi.advanceTimersByTime(2000);
  expect(st().starting).toEqual({});
  expect(splitTerminals(st().terminals, st().starting).shells.map((x) => x.id)).toEqual(['n']);
});

test('store: a session that ends later goes back to a plain terminal (never "starting" again)', () => {
  st().launched(term('n', 1));
  st().setTerminals([term('n', 1, true)]);
  st().setTerminals([term('n', 1)]);
  expect(isStarting(st().terminals[0]!, st().starting)).toBe(false);
});
