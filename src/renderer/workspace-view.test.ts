import { expect, test } from 'vitest';
import type { Resumable, TerminalInfo } from '@shared/protocol';
import type { WorkspacesState } from './workspaces';
import { t } from './i18n/en';
import { cardOf, changesInWorkspace, headDot, inWorkspace, resumablesIn, rowClickAction, wsChangeCount, wsColorVar } from './workspace-view';

// What the sidebar, the cards and the empty state show of a workspace.

const term = (id: string, state: string | null = null, unread = false): TerminalInfo => ({
  id, projectRoot: '/p', cwd: '/p', title: id, name: null, color: '#fff', foreground: 'zsh', createdAt: 1,
  session: state ? ({ state, unread, updatedAt: 0 } as unknown as TerminalInfo['session']) : null
});
const res = (id: string, projectRoot = '/p'): Resumable => ({ id, projectRoot, cwd: projectRoot, title: id, color: '#fff', sessionId: id, endedAt: 1 });
const WS: WorkspacesState = {
  on: true, active: 'A',
  list: [
    { id: 'A', name: 'Auth', color: 1, folder: null, order: ['t:a', 'f:/p/x.ts'], active: 't:a', layout: null },
    { id: 'B', name: 'Billing', color: 2, folder: '/p/wt/billing', order: ['t:b', 't:sh', 'f:/p/y.ts', 'f:/p/z.ts'], active: null, layout: null }
  ],
  members: { a: 'A', b: 'B', sh: 'B', old: 'B' }
};

test('inWorkspace: a workspace\'s terminals; one without a workspace is the active one\'s', () => {
  const list = [term('a'), term('b'), term('sh'), term('new')];
  expect(inWorkspace(WS, 'A', list).map((x) => x.id)).toEqual(['a', 'new']);
  expect(inWorkspace(WS, 'B', list).map((x) => x.id)).toEqual(['b', 'sh']);
});

test('resumablesIn: this project\'s, by workspace (a gone or unknown one: the active one)', () => {
  const list = [res('old'), res('orphan'), res('else', '/q')];
  expect(resumablesIn(WS, 'B', list, '/p').map((r) => r.id)).toEqual(['old']);
  expect(resumablesIn(WS, 'A', list, '/p').map((r) => r.id)).toEqual(['orphan']);
});

test('a card: state dots, sessions / terminals / file tabs, the folder\'s name; "empty" when nothing is in it', () => {
  const list = [term('a', 'waiting'), term('b', 'running'), term('sh')];
  const c = cardOf(WS, 'B', list, [res('old')], '/p', ['/p/y.ts', '/p/z.ts'], []);
  expect(c).toMatchObject({ sessions: 1, terminals: 1, files: 2, folder: 'billing', empty: false });
  expect(c.dots).toEqual([{ kind: 'working', n: 1 }, { kind: 'resume', n: 1 }]);
  expect(c.label).toBe('Billing · 1 working, 1 to resume');
  const none = cardOf({ ...WS, members: {} , list: [WS.list[0]!, { ...WS.list[1]!, order: [] }] }, 'B', [], [], '/p', [], []);
  expect(none).toMatchObject({ sessions: 0, terminals: 0, files: 0, empty: true, label: 'Billing · empty' });
});

test('a card counts only file tabs that are still open', () => {
  expect(cardOf(WS, 'B', [], [], '/p', ['/p/y.ts'], []).files).toBe(1);
});

test('a card counts its files at a commit still open as tabs: a workspace holding only those is not empty; tables are never a workspace\'s', () => {
  const orders = 'db:c0123456789ab/public/orders';
  const rev = 'rev:abc:a.ts';
  const only = { ...WS, members: {}, list: [WS.list[0]!, { ...WS.list[1]!, order: [orders, rev, 'db:c0123456789ab/public/gone'] as WorkspacesState['list'][number]['order'] }] };
  const c = cardOf(only, 'B', [], [], '/p', [], [orders, rev]);
  expect(c).toMatchObject({ files: 0, tabs: 1, empty: false, label: 'Billing · idle' });
  // A table an older version left in a workspace's order counts for nothing.
  expect(cardOf({ ...only, list: [WS.list[0]!, { ...WS.list[1]!, order: [orders] as WorkspacesState['list'][number]['order'] }] }, 'B', [], [], '/p', [], [orders])).toMatchObject({ tabs: 0, empty: true });
  // Not open any more: nothing to count.
  expect(cardOf(only, 'B', [], [], '/p', [], [])).toMatchObject({ tabs: 0, empty: true });
  // Close Workspace says they close too (file tabs alone: as before).
  expect(t.ws.closeBody(0, 0, 0, 2)).toBe('Nothing is running in it. Its 2 tabs close unless another workspace shows them; nothing on disk changes.');
  expect(t.ws.closeBody(0, 0, 1, 1)).toBe('Nothing is running in it. Its 2 tabs close unless another workspace shows them; nothing on disk changes.');
  expect(t.ws.closeBody(0, 0, 0, 1)).toBe('Nothing is running in it. Its tab closes unless another workspace shows it; nothing on disk changes.');
  expect(t.ws.closeBody(0, 0, 2)).toBe('Nothing is running in it. Its 2 file tabs close unless another workspace shows them; nothing on disk changes.');
  expect(t.ws.closeBody(0, 0, 1)).toBe('Nothing is running in it. Its file tab closes unless another workspace shows it; nothing on disk changes.');
});

test('Changes, This workspace: all but the rows only other workspaces\' sessions touched (sure, unclear or maybe); changes made by hand show everywhere', () => {
  // As buildRows makes them: an unclear entry names its candidates by title (`unclear`) and by terminal id (`ids`).
  const title = (id: string) => ({ a: 'Auth 1', b: 'Billing 1', sh: 'Billing shell' })[id] ?? id;
  const row = (path: string, by: { terminalId: string; ids?: string[]; maybe?: true }[]) =>
    ({ path, rel: path, kind: 'modified', stage: 'none', repo: '/p', by: by.map((b) => ({ color: '#fff', title: title(b.terminalId), ...(b.ids ? { unclear: b.ids.map(title) } : {}), ...b })) }) as never;
  const rows = [
    row('/p/a.ts', [{ terminalId: 'a' }]),
    row('/p/b.ts', [{ terminalId: 'b' }]),
    row('/p/u.ts', [{ terminalId: 'b', ids: ['a', 'b'] }, { terminalId: 'a', ids: ['a', 'b'] }]),
    row('/p/bb.ts', [{ terminalId: 'b', ids: ['b', 'sh'] }, { terminalId: 'sh', ids: ['b', 'sh'] }]),
    row('/p/m.ts', [{ terminalId: 'a', maybe: true }]),
    row('/p/hand.ts', [])
  ];
  const paths = (active: string) => changesInWorkspace({ ...WS, active }, rows).map((x: { path: string }) => x.path);
  // Changes are every change, not only the ones Claude made.
  expect(paths('A')).toEqual(['/p/a.ts', '/p/u.ts', '/p/m.ts', '/p/hand.ts']);
  // Unclear between two of Billing's sessions: Billing's, hidden from Auth, shown in Billing.
  expect(paths('B')).toEqual(['/p/b.ts', '/p/u.ts', '/p/bb.ts', '/p/hand.ts']);
});

test('Changes, This workspace: a session that ended (no workspace kept) or a new running one belongs to no other workspace: its rows show', () => {
  const row = (path: string, id: string) => ({ path, stage: 'none', by: [{ terminalId: id }] }) as never;
  const rows = [row('/p/old.ts', 'ended'), row('/p/new.ts', 'fresh'), row('/p/b.ts', 'b')];
  expect(changesInWorkspace(WS, rows).map((x: { path: string }) => x.path)).toEqual(['/p/old.ts', '/p/new.ts']);
});

test('the strip\'s count under This workspace: the active workspace\'s rows, computed again only when its inputs change', () => {
  const repos = [{ root: '/p', changes: [{ path: '/p/a.ts', rel: 'a.ts', kind: 'modified', stage: 'none' }, { path: '/p/b.ts', rel: 'b.ts', kind: 'modified', stage: 'none' }] }] as never[];
  const attributions = [{ path: '/p/a.ts', terminalId: 'a', sessionId: 's', color: '#fff', title: 'a', at: 1 }, { path: '/p/b.ts', terminalId: 'b', sessionId: 's', color: '#fff', title: 'b', at: 1 }];
  expect(wsChangeCount(WS, repos, attributions)).toBe(1);
  expect(wsChangeCount({ ...WS, active: 'B' }, repos, attributions)).toBe(1);
  // Nobody's (made by hand): counted in every workspace.
  expect(wsChangeCount(WS, repos, [])).toBe(2);
});

test('colors are theme tokens', () => {
  expect(wsColorVar(3)).toBe('var(--ws-3)');
});

test('a row\'s click: ⌥ opens to the side; in front, or from the keyboard, at once; another workspace\'s row waits for a double-click', () => {
  expect(rowClickAction(false, 1, true)).toBe('side');
  expect(rowClickAction(true, 1, true)).toBe('side');
  expect(rowClickAction(false, 1, false)).toBe('now');
  expect(rowClickAction(false, 2, false)).toBe('now');
  expect(rowClickAction(true, 0, false)).toBe('now');
  expect(rowClickAction(true, 1, false)).toBe('wait');
  expect(rowClickAction(true, 2, false)).toBe('none');
});

test('a folded head shows one dot, the most urgent', () => {
  expect(headDot([])).toBeNull();
  expect(headDot([{ kind: 'resume', n: 2 }])).toEqual({ kind: 'resume', n: 2 });
  expect(headDot([{ kind: 'working', n: 1 }, { kind: 'done', n: 3 }, { kind: 'resume', n: 1 }])).toEqual({ kind: 'working', n: 1 });
  expect(headDot([{ kind: 'done', n: 3 }, { kind: 'waiting', n: 2 }])).toEqual({ kind: 'waiting', n: 2 });
});
