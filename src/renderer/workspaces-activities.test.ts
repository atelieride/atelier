import { describe, expect, test } from 'vitest';
import type { TabKey } from './tabs-model';
import {
  MAX_ACTIVITIES, MAX_WORKSPACES, activitiesOf, create, isOpen, isWsActivity, placeOnReturn, placesInOrder, reorder, workspaceOf,
  workspacesOf, type Workspace, type WorkspacesState
} from './workspaces';

// Activities: entries of the workspaces' list with a parent, each a place with its own tabs.

const k = (...keys: string[]) => keys as TabKey[];
const ws = (id: string, name: string, color: number, order: TabKey[] = [], extra: Partial<Workspace> = {}): Workspace =>
  ({ id, name, color, folder: null, order, active: order[0] ?? null, layout: null, ...extra });
const act = (id: string, parent: string, name: string, color: number, order: TabKey[] = [], extra: Partial<Workspace> = {}): Workspace =>
  ws(id, name, color, order, { parent, ...extra });

/**
 * Auth (A) with activities SSO (a1) and Reset (a2), Billing (B) with Webhooks (b1). The list mixes them as creation
 * leaves it. A's own tabs are in front.
 */
function mixed(): WorkspacesState {
  return {
    on: true, active: 'A',
    list: [
      ws('A', 'Auth', 1, k('t:tok', 'f:/p/session.ts')),
      act('a1', 'A', 'SSO', 1, k('t:okta', 't:mock', 'f:/p/okta.ts')),
      ws('B', 'Billing', 2, k('t:bill')),
      act('a2', 'A', 'Reset', 1, k('t:mail')),
      act('b1', 'B', 'Webhooks', 2, k('t:hook'))
    ],
    members: { tok: 'A', okta: 'a1', mock: 'a1', bill: 'B', mail: 'a2', hook: 'b1' }
  };
}

describe('lookups', () => {
  test('an activity is an entry with a parent; workspacesOf keeps the others in list order', () => {
    const s = mixed();
    expect(s.list.filter(isWsActivity).map((w) => w.id)).toEqual(['a1', 'a2', 'b1']);
    expect(workspacesOf(s).map((w) => w.id)).toEqual(['A', 'B']);
  });
  test('activitiesOf: a workspace\'s activities in list order; none for an activity or an unknown id', () => {
    const s = mixed();
    expect(activitiesOf(s, 'A').map((w) => w.id)).toEqual(['a1', 'a2']);
    expect(activitiesOf(s, 'B').map((w) => w.id)).toEqual(['b1']);
    expect(activitiesOf(s, 'a1')).toEqual([]);
    expect(activitiesOf(s, 'nope')).toEqual([]);
  });
  test('workspaceOf: an activity\'s parent, a workspace itself, an unknown id as it is', () => {
    const s = mixed();
    expect(workspaceOf(s, 'a2')).toBe('A');
    expect(workspaceOf(s, 'b1')).toBe('B');
    expect(workspaceOf(s, 'A')).toBe('A');
    expect(workspaceOf(s, 'nope')).toBe('nope');
  });
  test('placesInOrder: each workspace, then its activities', () => {
    expect(placesInOrder(mixed()).map((w) => w.id)).toEqual(['A', 'a1', 'a2', 'B', 'b1']);
  });
  test('placeOnReturn: the activity a workspace was left at while it still exists, else its own tabs', () => {
    const s = mixed();
    expect(placeOnReturn(s, 'A')).toBe('A');
    const left: WorkspacesState = { ...s, list: s.list.map((w) => (w.id === 'A' ? { ...w, place: 'a2' } : w)) };
    expect(placeOnReturn(left, 'A')).toBe('a2');
    const gone: WorkspacesState = { ...left, list: left.list.filter((w) => w.id !== 'a2') };
    expect(placeOnReturn(gone, 'A')).toBe('A');
    // Another workspace's activity is no place of A's.
    const wrong: WorkspacesState = { ...s, list: s.list.map((w) => (w.id === 'A' ? { ...w, place: 'b1' } : w)) };
    expect(placeOnReturn(wrong, 'A')).toBe('A');
  });
});

describe('the workspace list ignores activities', () => {
  test('twenty workspaces can be made however many activities there are; colors count workspaces only', () => {
    let s = mixed();
    expect(create(s, { name: 'Hotfix' }, 'C')!.list.at(-1)!.color).toBe(3);
    for (let i = 0; i < MAX_WORKSPACES - 2; i++) s = create(s, { name: `w${i}` }, `id${i}`)!;
    expect(workspacesOf(s)).toHaveLength(MAX_WORKSPACES);
    expect(create(s, { name: 'one more' }, 'Z')).toBeNull();
    expect(MAX_ACTIVITIES).toBe(20);
  });
  test('reorder swaps two workspaces across the activities between them, which keep their places', () => {
    const s = reorder(mixed(), 'B', -1);
    expect(s.list.map((w) => w.id)).toEqual(['B', 'a1', 'A', 'a2', 'b1']);
    expect(workspacesOf(s).map((w) => w.id)).toEqual(['B', 'A']);
    expect(reorder(mixed(), 'A', -1)).toEqual(mixed());
    expect(reorder(mixed(), 'B', 1)).toEqual(mixed());
  });
  test('an activity starts folded, and being in front never opens it: only its chevron does', () => {
    const s: WorkspacesState = { ...mixed(), active: 'a1' };
    expect(isOpen(s, 'a1')).toBe(false);
    expect(isOpen({ ...s, list: s.list.map((w) => (w.id === 'a1' ? { ...w, open: true } : w)) }, 'a1')).toBe(true);
  });
  test('a workspace whose activity is in front shows its rows as when its own tabs are, unless its chevron folded it', () => {
    const s: WorkspacesState = { ...mixed(), active: 'a1' };
    expect(isOpen(s, 'A')).toBe(true);
    expect(isOpen(s, 'B')).toBe(false);
    expect(isOpen({ ...s, list: s.list.map((w) => (w.id === 'A' ? { ...w, open: false } : w)) }, 'A')).toBe(false);
  });
});
