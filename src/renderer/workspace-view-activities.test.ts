import { expect, test } from 'vitest';
import type { Resumable, TerminalInfo } from '@shared/protocol';
import type { WorkspacesState } from './workspaces';
import { cardOf, changesInWorkspace, inWorkspace, inWorkspaceTree, resumablesIn, wsActivityCard } from './workspace-view';
import { attentionReach } from './attention-nav';

// What the sidebar, the heads and Changes show of workspaces that hold activities.

const term = (id: string, state: string | null = null, unread = false): TerminalInfo => ({
  id, projectRoot: '/p', cwd: '/p', title: id, name: null, color: '#fff', foreground: 'zsh', createdAt: 1,
  session: state ? ({ state, unread, updatedAt: 0 } as unknown as TerminalInfo['session']) : null
});
const res = (id: string): Resumable => ({ id, projectRoot: '/p', cwd: '/p', title: id, color: '#fff', sessionId: id, endedAt: 1 });
/** Auth (own: a; SSO a1: o, sh, okta.ts; Reset a2: empty), Billing (own: b; Webhooks b1: h). SSO in front. */
const WS: WorkspacesState = {
  on: true, active: 'a1',
  list: [
    { id: 'A', name: 'Auth', color: 1, folder: null, order: ['t:a', 'f:/p/x.ts'], active: 't:a', layout: null, place: 'a1' },
    { id: 'B', name: 'Billing', color: 2, folder: null, order: ['t:b'], active: 't:b', layout: null },
    { id: 'a1', parent: 'A', name: 'SSO', color: 1, folder: null, order: ['t:o', 't:sh', 'f:/p/okta.ts', 'f:/p/x.ts'], active: 't:o', layout: null },
    { id: 'a2', parent: 'A', name: 'Reset', color: 1, folder: null, order: [], active: null, layout: null },
    { id: 'b1', parent: 'B', name: 'Webhooks', color: 2, folder: null, order: ['t:h'], active: 't:h', layout: null }
  ],
  members: { a: 'A', o: 'a1', sh: 'a1', b: 'B', h: 'b1', old: 'a1', gone: 'b1' }
};
const LIST = [term('a', 'running'), term('o', 'waiting'), term('sh'), term('b'), term('h', 'done', true), term('new')];
const FILES = ['/p/x.ts', '/p/okta.ts'];

test('inWorkspace and resumablesIn keep to exactly one place; the tree is the workspace and its activities', () => {
  expect(inWorkspace(WS, 'A', LIST).map((x) => x.id)).toEqual(['a']);
  // A terminal with no place yet is the place in front's.
  expect(inWorkspace(WS, 'a1', LIST).map((x) => x.id)).toEqual(['o', 'sh', 'new']);
  expect(inWorkspaceTree(WS, 'A', LIST).map((x) => x.id)).toEqual(['a', 'o', 'sh', 'new']);
  expect(inWorkspaceTree(WS, 'B', LIST).map((x) => x.id)).toEqual(['b', 'h']);
  expect(resumablesIn(WS, 'A', [res('old'), res('gone')], '/p')).toEqual([]);
  expect(resumablesIn(WS, 'a1', [res('old'), res('gone')], '/p').map((r) => r.id)).toEqual(['old']);
});

test('a workspace\'s card counts every place of it: its folded dot says what its activities hold too', () => {
  const c = cardOf(WS, 'A', LIST, [res('old')], '/p', FILES, []);
  expect(c).toMatchObject({ sessions: 2, terminals: 2, files: 2, empty: false });
  expect(c.dots).toEqual([{ kind: 'waiting', n: 1 }, { kind: 'working', n: 1 }, { kind: 'resume', n: 1 }]);
  expect(cardOf(WS, 'B', LIST, [], '/p', FILES, []).dots).toEqual([{ kind: 'done', n: 1 }]);
});

test('an activity\'s head: its dots and its tooltip — the name, then what is inside, or "empty"', () => {
  const c = wsActivityCard(WS, 'a1', LIST, [res('old')], '/p', FILES, []);
  expect(c.dots).toEqual([{ kind: 'waiting', n: 1 }, { kind: 'resume', n: 1 }]);
  expect(c.empty).toBe(false);
  expect(c.label).toBe('SSO · 1 needs you · 2 terminals · 2 file tabs · 1 to resume');
  const e = wsActivityCard(WS, 'a2', LIST, [], '/p', FILES, []);
  expect(e).toMatchObject({ dots: [], empty: true, label: 'Reset · empty' });
  const w = wsActivityCard(WS, 'b1', [term('h', 'done', true), term('i', 'idle')], [], '/p', [], []);
  expect(w.label).toBe('Webhooks · 1 done');
});

test('Changes\' "This workspace" is the workspace\'s, all its places together', () => {
  const row = (...ids: string[]) => ({ path: ids.join('+'), by: ids.map((terminalId) => ({ terminalId })) });
  const rows = [row('a'), row('o'), row('b'), row('h'), row('o', 'b')];
  expect(changesInWorkspace(WS, rows).map((r) => r.path)).toEqual(['a', 'o', 'o+b']);
  expect(changesInWorkspace({ ...WS, active: 'A' }, rows).map((r) => r.path)).toEqual(['a', 'o', 'o+b']);
});

test('⌘J with "follows" off keeps to the workspace in front, every place of it; on, everywhere', () => {
  expect(attentionReach(WS, LIST, false).map((x) => x.id)).toEqual(['a', 'o', 'sh', 'new']);
  expect(attentionReach({ ...WS, active: 'B' }, LIST, false).map((x) => x.id)).toEqual(['b', 'h', 'new']);
  expect(attentionReach(WS, LIST, true)).toBe(LIST);
  expect(attentionReach(null, LIST, false)).toBe(LIST);
});
