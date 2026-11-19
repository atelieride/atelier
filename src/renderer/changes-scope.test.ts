import { expect, test } from 'vitest';
import type { WorkspacesState } from './workspaces';
import { changesInWorkspace } from './workspace-view';
import { changesInScope, frontSessionNext, scopeInEffect, scopesOffered, shownChanges, type ScopeView } from './changes-scope';

// Changes' Show choices: which are offered, the session in front, and the rows each one keeps.

/** Auth (own: a; SSO a1: o, sh, old ended; Reset a2: empty), Billing (own: b). SSO in front. */
const WS: WorkspacesState = {
  on: true, active: 'a1',
  list: [
    { id: 'A', name: 'Auth', color: 1, folder: null, order: [], active: null, layout: null },
    { id: 'B', name: 'Billing', color: 2, folder: null, order: [], active: null, layout: null },
    { id: 'a1', parent: 'A', name: 'SSO', color: 3, folder: null, order: [], active: null, layout: null },
    { id: 'a2', parent: 'A', name: 'Reset', color: 4, folder: null, order: [], active: null, layout: null }
  ],
  members: { a: 'A', o: 'a1', sh: 'a1', b: 'B', old: 'a1' }
};
/** Live terminals: `new` is running and not placed yet; `old` and `gone2` ended. */
const LIVE = new Set(['a', 'o', 'sh', 'b', 'new']);

type Row = { path: string; by: { terminalId: string; ids?: string[] }[] };
const sure = (...ids: string[]): Row => ({ path: ids.join('+'), by: ids.map((terminalId) => ({ terminalId })) });
const unsure: Row = { path: 'either', by: [{ terminalId: 'b', ids: ['b', 'o'] }, { terminalId: 'o', ids: ['b', 'o'] }] };
const unknown: Row = { path: 'by-hand', by: [] };
const paths = (rows: Row[] | null) => rows?.map((r) => r.path) ?? null;
const view = (v: Partial<ScopeView>): ScopeView => ({ scope: 'all', ws: WS, session: null, live: LIVE, ...v });

test('Show offers All and This session always, This workspace with workspaces on, This activity with activities on too; a pop-out only All', () => {
  expect(scopesOffered({ wsOn: false, activities: true, popout: false })).toEqual(['all', 'session']);
  expect(scopesOffered({ wsOn: true, activities: false, popout: false })).toEqual(['all', 'ws', 'session']);
  expect(scopesOffered({ wsOn: true, activities: true, popout: false })).toEqual(['all', 'ws', 'activity', 'session']);
  expect(scopesOffered({ wsOn: true, activities: true, popout: true })).toEqual(['all']);
});

test('a choice no longer offered behaves as All', () => {
  expect(scopeInEffect('activity', ['all', 'ws', 'session'])).toBe('all');
  expect(scopeInEffect('ws', ['all', 'session'])).toBe('all');
  expect(scopeInEffect('session', ['all', 'ws', 'session'])).toBe('session');
});

test('the session in front: the selected Claude session, else the last one while its terminal lives', () => {
  const terms = [{ id: 'o', session: {} }, { id: 'sh', session: null }, { id: 'b', session: {} }];
  expect(frontSessionNext(null, 'o', terms)).toBe('o');
  expect(frontSessionNext('o', 'b', terms)).toBe('b');
  // A plain terminal (or nothing) selected: the last session stays.
  expect(frontSessionNext('o', 'sh', terms)).toBe('o');
  expect(frontSessionNext('o', null, terms)).toBe('o');
  expect(frontSessionNext(null, 'sh', terms)).toBeNull();
  // Its terminal gone: none in front, never a stale one.
  expect(frontSessionNext('gone', 'sh', terms)).toBeNull();
  // A session whose Claude exited keeps its place while its terminal lives (its files are still its own).
  expect(frontSessionNext('o', 'o', [{ id: 'o', session: null }])).toBe('o');
});

test('This session: the rows it touched, for sure or as one of the candidates; never another session\'s or unknown origin', () => {
  const rows = [sure('o'), sure('o', 'b'), unsure, sure('b'), unknown];
  expect(paths(changesInScope(view({ scope: 'session', session: 'o' }), rows))).toEqual(['o', 'o+b', 'either']);
  expect(paths(changesInScope(view({ scope: 'session', session: 'b' }), rows))).toEqual(['o+b', 'either', 'b']);
  // No session in front: nothing.
  expect(changesInScope(view({ scope: 'session', session: null }), rows)).toEqual([]);
});

test('This activity: its sessions\' rows (an ended one keeping its place, a running one not placed yet); unknown origin hidden', () => {
  const rows = [sure('a'), sure('o'), sure('sh'), sure('old'), sure('new'), sure('b'), sure('gone2'), unsure, unknown];
  expect(paths(changesInScope(view({ scope: 'activity' }), rows))).toEqual(['o', 'sh', 'old', 'new', 'either']);
  // The workspace's own place in front: the sessions that sit in no activity.
  expect(paths(changesInScope(view({ scope: 'activity', ws: { ...WS, active: 'A' } }), rows))).toEqual(['a', 'new']);
  // An empty activity: nothing of the others'.
  expect(paths(changesInScope(view({ scope: 'activity', ws: { ...WS, active: 'a2' } }), rows))).toEqual(['new']);
});

test('This workspace is today\'s filter; All shows everything (null)', () => {
  const rows = [sure('a'), sure('o'), sure('b'), unknown];
  expect(changesInScope(view({ scope: 'ws' }), rows)).toEqual(changesInWorkspace(WS, rows));
  expect(changesInScope(view({ scope: 'all' }), rows)).toBeNull();
});

test('from the store: a scope whose feature is off shows everything', () => {
  const terminals = [...LIVE].map((id) => ({ id, session: {} })) as never[];
  const base = { ws: WS, popout: false, changesSession: 'o', terminals, settings: { wsActivities: true } };
  const rows = [sure('a'), sure('o'), sure('b'), unknown];
  expect(paths(shownChanges({ ...base, changesScope: 'activity' }, rows))).toEqual(['o']);
  expect(shownChanges({ ...base, changesScope: 'activity', settings: { wsActivities: false } }, rows)).toBeNull();
  expect(shownChanges({ ...base, changesScope: 'ws', ws: { ...WS, on: false } }, rows)).toBeNull();
  expect(paths(shownChanges({ ...base, changesScope: 'session', ws: null }, rows))).toEqual(['o']);
  expect(shownChanges({ ...base, changesScope: 'session', popout: true }, rows)).toBeNull();
});
