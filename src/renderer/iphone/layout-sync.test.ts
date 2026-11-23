import { expect, test, vi } from 'vitest';
import type { RemoteLayout } from '@shared/remote';
import { useApp } from '../store';
import type { Workspace, WorkspacesState } from '../workspaces';
import { LAYOUT_SYNC_MS, installLayoutSync, layoutOf } from './layout-sync';

const w = (o: Partial<Workspace> & { id: string }): Workspace => ({ name: o.id, color: 1, folder: null, order: [], active: null, layout: null, ...o });
const base = { groupByState: true, pins: ['t1'], rowOrder: { sessions: ['t2', 't1'], terminals: ['t3'] }, activities: true };

test('workspaces off: grouping, pins and the manual order, no workspaces', () => {
  const off: WorkspacesState = { on: false, active: 'w1', list: [w({ id: 'w1' })], members: { t1: 'w1' } };
  expect(layoutOf({ ...base, ws: off })).toEqual({ groupByState: true, pins: ['t1'], order: { sessions: ['t2', 't1'], terminals: ['t3'] } });
  expect(layoutOf({ ...base, ws: null })).not.toHaveProperty('workspaces');
});

test('workspaces on: every place in the sidebar\'s order, activities after their workspace, folded or open, folders by name only', () => {
  const ws: WorkspacesState = {
    on: true, active: 'a1',
    // Made in this order: the second workspace's activity comes after it in the sidebar, not where it was made.
    list: [w({ id: 'w1', name: 'Main', color: 2, open: false }), w({ id: 'a2', name: 'Docs', color: 6, parent: 'w2' }), w({ id: 'a1', name: 'SSO', color: 3, parent: 'w1', open: true }), w({ id: 'w2', name: 'API', color: 4, folder: '/work/app/.claude/worktrees/api-v2' })],
    members: { t1: 'a1', t2: 'w2', gone: 'w9' }
  };
  const l = layoutOf({ ...base, ws });
  expect(l.workspaces).toEqual({
    active: 'a1', activities: true,
    places: [
      { id: 'w1', name: 'Main', color: 2, open: false },
      { id: 'a1', name: 'SSO', color: 3, parent: 'w1', open: true },
      { id: 'w2', name: 'API', color: 4, folder: 'api-v2', open: false },
      { id: 'a2', name: 'Docs', color: 6, parent: 'w2', open: false }
    ],
    members: { t1: 'a1', t2: 'w2', gone: 'w9' }
  });
  expect(JSON.stringify(l)).not.toContain('/');
});

test('the workspace in front is open unless its chevron folded it', () => {
  const ws: WorkspacesState = { on: true, active: 'w2', list: [w({ id: 'w1' }), w({ id: 'w2' })], members: {} };
  expect(layoutOf({ ...base, ws }).workspaces!.places.map((p) => [p.id, p.open])).toEqual([['w1', false], ['w2', true]]);
});

// Loaded once iPhone access is on (out of the first paint): installed then, it sends the layout as it is, then each
// change, settled; turned off, nothing.
test('installed while access is on, the current layout goes at once, then each change; access off, none', async () => {
  vi.useFakeTimers();
  const sent: RemoteLayout[] = [];
  const g = globalThis as { window?: unknown };
  const had = g.window;
  g.window = { atelier: { remote: { layout: async (l: RemoteLayout) => { sent.push(l); } } } };
  const before = useApp.getState();
  useApp.setState({ project: { root: '/p', name: 'p', realRoot: '/p' }, popout: null, groupByState: true, pins: [], rowOrder: { sessions: [], terminals: [] }, ws: null, settings: { ...before.settings, remoteAccess: true } });
  const off = installLayoutSync();
  try {
    await vi.advanceTimersByTimeAsync(LAYOUT_SYNC_MS);
    expect(sent).toEqual([{ groupByState: true, pins: [], order: { sessions: [], terminals: [] } }]);
    useApp.setState({ pins: ['t1'] });
    await vi.advanceTimersByTimeAsync(LAYOUT_SYNC_MS);
    expect(sent.map((l) => l.pins)).toEqual([[], ['t1']]);
    useApp.setState({ settings: { ...useApp.getState().settings, remoteAccess: false } });
    useApp.setState({ pins: ['t2'] });
    await vi.advanceTimersByTimeAsync(LAYOUT_SYNC_MS);
    expect(sent).toHaveLength(2);
  } finally {
    off();
    useApp.setState(before, true);
    g.window = had;
    vi.useRealTimers();
  }
});
