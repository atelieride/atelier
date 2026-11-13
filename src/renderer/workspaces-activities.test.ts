import { describe, expect, test } from 'vitest';
import type { TabKey } from './tabs-model';
import {
  MAX_ACTIVITIES, MAX_NAME, MAX_WORKSPACES, activitiesOf, create, createWsActivity, forget, isOpen, isWsActivity, moveKey, moveWsActivity,
  parkWsActivities, parseWorkspaces, placeOnReturn, placesInOrder, prune, recolor, relink, remove, removeWsActivity, renameKeys, reorder,
  toFront, toggleOpen, union, unparkWsActivities, workspaceOf, workspacesOf, type Workspace, type WorkspacesState
} from './workspaces';
import { loadWorkspaces, saveWorkspaces } from './workspaces-save';

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

describe('switching places', () => {
  const entry = (s: WorkspacesState, id: string) => s.list.find((w) => w.id === id)!;
  test('own tabs → an activity of the same workspace: nothing folds or opens, the workspace records where it is', () => {
    const s = toFront(mixed(), 'a1');
    expect(s.active).toBe('a1');
    expect(entry(s, 'A').place).toBe('a1');
    expect('open' in entry(s, 'A')).toBe(false);
    expect('open' in entry(s, 'a1')).toBe(false);
    expect(isOpen(s, 'A')).toBe(true);
    expect(isOpen(s, 'a1')).toBe(false);
  });
  test('an activity → another workspace\'s activity: the workspace left keeps showing as it was, the other opens', () => {
    const s = toFront(toFront(mixed(), 'a1'), 'b1');
    expect(s.active).toBe('b1');
    expect(entry(s, 'A')).toMatchObject({ open: true, place: 'a1' });
    expect(entry(s, 'B').place).toBe('b1');
    expect('open' in entry(s, 'B')).toBe(false);
    expect(isOpen(s, 'B')).toBe(true);
    // A folded by its chevron before leaving stays folded.
    const folded = toFront(toggleOpen(toFront(mixed(), 'a1'), 'A'), 'b1');
    expect(isOpen(folded, 'A')).toBe(false);
  });
  test('an activity → its own workspace\'s tabs: the place is cleared', () => {
    const s = toFront(toFront(mixed(), 'a2'), 'A');
    expect(s.active).toBe('A');
    expect('place' in entry(s, 'A')).toBe(false);
  });
  test('a folded activity stays folded coming forward; an open one stays open', () => {
    expect(isOpen(toFront(mixed(), 'b1'), 'b1')).toBe(false);
    const open = toggleOpen(mixed(), 'a2');
    expect(isOpen(toFront(open, 'a2'), 'a2')).toBe(true);
  });
  test('workspaces alone switch as before: no place is ever written', () => {
    const s = toFront(mixed(), 'B');
    expect('place' in entry(s, 'B')).toBe(false);
    expect('place' in entry(s, 'A')).toBe(false);
  });
});

describe('creating an activity', () => {
  test('a new activity: last among its workspace\'s, its color, no folder, nothing inside, folded; the front stays', () => {
    const s = createWsActivity(mixed(), 'A', '  Rate limits  ', 'a3')!;
    expect(s.list.at(-1)).toEqual({ id: 'a3', parent: 'A', name: 'Rate limits', color: 1, folder: null, order: [], active: null, layout: null });
    expect(activitiesOf(s, 'A').map((w) => w.id)).toEqual(['a1', 'a2', 'a3']);
    expect(isOpen(s, 'a3')).toBe(false);
    expect(s.active).toBe('A');
    expect(createWsActivity(mixed(), 'B', 'x', 'b2')!.list.at(-1)!.color).toBe(2);
  });
  test('recoloring a workspace recolors its activities', () => {
    const s = recolor(mixed(), 'A', 6);
    expect(s.list.filter((w) => w.id === 'A' || w.parent === 'A').map((w) => w.color)).toEqual([6, 6, 6]);
    expect(s.list.find((w) => w.id === 'b1')!.color).toBe(2);
  });
  test('an empty name becomes "New activity"; a long one is cut', () => {
    expect(createWsActivity(mixed(), 'A', '   ', 'a3')!.list.at(-1)!.name).toBe('New activity');
    expect(createWsActivity(mixed(), 'A', 'x'.repeat(MAX_NAME + 5), 'a3')!.list.at(-1)!.name).toHaveLength(MAX_NAME);
  });
  test('refused: inside an activity, in a workspace that is not there, past twenty, with an id already used', () => {
    expect(createWsActivity(mixed(), 'a1', 'x', 'z')).toBeNull();
    expect(createWsActivity(mixed(), 'nope', 'x', 'z')).toBeNull();
    expect(createWsActivity(mixed(), 'A', 'x', 'B')).toBeNull();
    let s = mixed();
    for (let i = 0; i < MAX_ACTIVITIES - 2; i++) s = createWsActivity(s, 'A', `x${i}`, `ax${i}`)!;
    expect(activitiesOf(s, 'A')).toHaveLength(MAX_ACTIVITIES);
    expect(createWsActivity(s, 'A', 'one more', 'z')).toBeNull();
    // Another workspace still has room.
    expect(createWsActivity(s, 'B', 'fine', 'z')).not.toBeNull();
  });
});

describe('moving tabs between places', () => {
  test('a terminal from an activity to its workspace\'s own tabs', () => {
    const s = moveKey(mixed(), 't:mock', 'A');
    expect(s.members.mock).toBe('A');
    expect(s.list.find((w) => w.id === 'a1')!.order).toEqual(k('t:okta', 'f:/p/okta.ts'));
    expect(s.list.find((w) => w.id === 'A')!.order).toEqual(k('t:tok', 'f:/p/session.ts', 't:mock'));
  });
  test('a terminal from an activity to another workspace\'s activity', () => {
    const s = moveKey(mixed(), 't:okta', 'b1');
    expect(s.members.okta).toBe('b1');
    expect(s.list.find((w) => w.id === 'b1')!.order).toEqual(k('t:hook', 't:okta'));
    expect(s.list.find((w) => w.id === 'a1')!.order).toEqual(k('t:mock', 'f:/p/okta.ts'));
  });
  test('a file leaves the activity it was moved from and joins another place once', () => {
    const s = moveKey({ ...mixed(), active: 'a1' }, 'f:/p/okta.ts', 'a2');
    expect(s.list.find((w) => w.id === 'a1')!.order).toEqual(k('t:okta', 't:mock'));
    expect(s.list.find((w) => w.id === 'a2')!.order).toEqual(k('t:mail', 'f:/p/okta.ts'));
  });
});

describe('moving an activity to another workspace', () => {
  test('it changes workspace with everything in it, takes that workspace\'s color and goes last among its activities', () => {
    const s = moveWsActivity(mixed(), 'a1', 'B');
    const a1 = s.list.find((w) => w.id === 'a1')!;
    expect(a1).toMatchObject({ parent: 'B', color: 2, order: k('t:okta', 't:mock', 'f:/p/okta.ts') });
    expect(activitiesOf(s, 'B').map((w) => w.id)).toEqual(['b1', 'a1']);
    expect(activitiesOf(s, 'A').map((w) => w.id)).toEqual(['a2']);
    expect(s.members).toEqual(mixed().members);
  });
  test('the workspace it left forgets it as its place', () => {
    const left: WorkspacesState = { ...mixed(), list: mixed().list.map((w) => (w.id === 'A' ? { ...w, place: 'a1' } : w)) };
    expect('place' in moveWsActivity(left, 'a1', 'B').list.find((w) => w.id === 'A')!).toBe(false);
  });
  test('the activity in front moves too, still in front', () => {
    const s = moveWsActivity({ ...mixed(), active: 'a1' }, 'a1', 'B');
    expect(s.active).toBe('a1');
    expect(workspaceOf(s, s.active)).toBe('B');
  });
  test('refused (the same state): into an activity, into its own workspace, into a full one, an unknown id, a workspace', () => {
    const s = mixed();
    expect(moveWsActivity(s, 'a1', 'b1')).toBe(s);
    expect(moveWsActivity(s, 'a1', 'A')).toBe(s);
    expect(moveWsActivity(s, 'nope', 'B')).toBe(s);
    expect(moveWsActivity(s, 'B', 'A')).toBe(s);
    let full = s;
    for (let i = 0; i < MAX_ACTIVITIES - 1; i++) full = createWsActivity(full, 'B', `x${i}`, `bx${i}`)!;
    expect(moveWsActivity(full, 'a1', 'B')).toBe(full);
  });
});

describe('closing an activity', () => {
  test('move: its terminals and tabs join its workspace\'s own tabs (once), the entry goes', () => {
    const base = mixed();
    const withFile: WorkspacesState = { ...base, list: base.list.map((w) => (w.id === 'A' ? { ...w, order: k(...w.order, 'f:/p/okta.ts') } : w)) };
    const s = removeWsActivity(withFile, 'a1', 'move');
    expect(s.list.some((w) => w.id === 'a1')).toBe(false);
    expect(s.members).toMatchObject({ okta: 'A', mock: 'A' });
    expect(s.list.find((w) => w.id === 'A')!.order).toEqual(k('t:tok', 'f:/p/session.ts', 'f:/p/okta.ts', 't:okta', 't:mock'));
  });
  test('stop: its terminals belong to its workspace (its sessions wait under Resume there); its tabs don\'t join it', () => {
    const s = removeWsActivity(mixed(), 'a1', 'stop');
    expect(s.list.some((w) => w.id === 'a1')).toBe(false);
    expect(s.members).toMatchObject({ okta: 'A', mock: 'A' });
    expect(s.list.find((w) => w.id === 'A')!.order).toEqual(k('t:tok', 'f:/p/session.ts'));
  });
  test('in front: its workspace\'s own tabs come forward; a workspace left at it forgets it', () => {
    const base = toFront(mixed(), 'a1');
    const s = removeWsActivity(base, 'a1', 'move');
    expect(s.active).toBe('A');
    expect('place' in s.list.find((w) => w.id === 'A')!).toBe(false);
  });
  test('an unknown id or a workspace: the same state', () => {
    const s = mixed();
    expect(removeWsActivity(s, 'nope', 'move')).toBe(s);
    expect(removeWsActivity(s, 'B', 'stop')).toBe(s);
  });
});

describe('closing a workspace that has activities', () => {
  test('move: its activities go to the target as activities, folded, in its color; its own tabs join the target\'s', () => {
    const open = toggleOpen(mixed(), 'a1');
    const s = remove(open, 'A', 'B')!;
    expect(workspacesOf(s).map((w) => w.id)).toEqual(['B']);
    expect(activitiesOf(s, 'B').map((w) => w.id)).toEqual(['b1', 'a1', 'a2']);
    for (const id of ['a1', 'a2']) expect(s.list.find((w) => w.id === id)).toMatchObject({ parent: 'B', color: 2, open: false });
    expect(s.members).toMatchObject({ tok: 'B', okta: 'a1', mail: 'a2' });
    expect(s.list.find((w) => w.id === 'B')!.order).toEqual(k('t:bill', 't:tok'));
  });
  test('stop: its activities and every membership in it go', () => {
    const s = remove(mixed(), 'A', null)!;
    expect(s.list.map((w) => w.id)).toEqual(['B', 'b1']);
    expect(s.members).toEqual({ bill: 'B', hook: 'b1' });
  });
  test('one of its activities in front: the target comes forward', () => {
    expect(remove({ ...mixed(), active: 'a2' }, 'A', 'B')!.active).toBe('B');
    expect(remove({ ...mixed(), active: 'a2' }, 'A', null)!.active).toBe('B');
  });
  test('past twenty in the target: the extra activities\' terminals and tabs join the target\'s own tabs', () => {
    let s = mixed();
    // B holds 19: room for one more.
    for (let i = 0; i < MAX_ACTIVITIES - 2; i++) s = createWsActivity(s, 'B', `x${i}`, `bx${i}`)!;
    const r = remove(s, 'A', 'B')!;
    expect(activitiesOf(r, 'B')).toHaveLength(MAX_ACTIVITIES);
    // a1 fits (the 20th), a2 does not: its terminal and tab land in B's own tabs.
    expect(r.list.some((w) => w.id === 'a1')).toBe(true);
    expect(r.list.some((w) => w.id === 'a2')).toBe(false);
    expect(r.members.mail).toBe('B');
    expect(r.list.find((w) => w.id === 'B')!.order).toEqual(k('t:bill', 't:tok', 't:mail'));
  });
  test('the last workspace still can\'t be closed, whatever activities it has', () => {
    const s = remove(mixed(), 'A', null)!;
    expect(remove(s, 'B', null)).toBeNull();
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

describe('one strip for every place (off, ⌘J, what tabs.json saves)', () => {
  test('each workspace\'s own tabs, then its activities\', in the sidebar\'s order; the live order in its place', () => {
    expect(union(mixed(), k('t:tok', 'f:/p/session.ts', 'review'))).toEqual(
      k('t:tok', 'f:/p/session.ts', 't:okta', 't:mock', 'f:/p/okta.ts', 't:mail', 't:bill', 't:hook', 'review')
    );
    // An activity in front: its live order in its place.
    expect(union({ ...mixed(), active: 'a1' }, k('t:mock', 't:okta'))).toEqual(
      k('t:tok', 'f:/p/session.ts', 't:mock', 't:okta', 't:mail', 't:bill', 't:hook')
    );
  });
  test('a file in two places comes once, where it first is', () => {
    const s: WorkspacesState = { ...mixed(), list: mixed().list.map((w) => (w.id === 'a2' ? { ...w, order: k('t:mail', 'f:/p/session.ts') } : w)) };
    expect(union(s, k('t:tok', 'f:/p/session.ts')).filter((x) => x === 'f:/p/session.ts')).toHaveLength(1);
  });
});

describe('activities kept aside (the setting off) and back', () => {
  const LAYOUT = { v: 2, panes: [{ tabs: ['t:okta'], front: 't:okta' }, { tabs: ['t:mock'], front: 't:mock' }], focus: 1 };
  /** SSO in front, its mock in front there, split in two. */
  const atSso = (): WorkspacesState => {
    const s = toFront(mixed(), 'a1');
    return { ...s, list: s.list.map((w) => (w.id === 'a1' ? { ...w, active: 't:mock' as TabKey, layout: LAYOUT } : w)) };
  };
  const entry = (s: WorkspacesState, id: string) => s.list.find((w) => w.id === id)!;

  test('nothing to keep aside: the same state', () => {
    const s = mixed();
    const plain: WorkspacesState = { ...s, list: workspacesOf(s), members: { tok: 'A', bill: 'B' } };
    expect(parkWsActivities(plain)).toBe(plain);
  });
  test('parked: only workspaces stay; each holds its activities\' tabs after its own; every terminal is its workspace\'s', () => {
    const s = parkWsActivities(atSso());
    expect(s.list.map((w) => w.id)).toEqual(['A', 'B']);
    expect(entry(s, 'A').order).toEqual(k('t:tok', 'f:/p/session.ts', 't:okta', 't:mock', 'f:/p/okta.ts', 't:mail'));
    expect(entry(s, 'B').order).toEqual(k('t:bill', 't:hook'));
    expect(s.members).toEqual({ tok: 'A', okta: 'A', mock: 'A', bill: 'B', mail: 'A', hook: 'B' });
    expect(s.parked!.members).toEqual({ okta: 'a1', mock: 'a1', mail: 'a2', hook: 'b1' });
    expect(s.parked!.list.map((w) => w.id)).toEqual(['a1', 'a2', 'b1']);
  });
  test('the activity in front: its workspace\'s own tabs come forward with its tab in front and its split', () => {
    const s = parkWsActivities(atSso());
    expect(s.active).toBe('A');
    expect(entry(s, 'A')).toMatchObject({ active: 't:mock', layout: LAYOUT });
    expect('place' in entry(s, 'A')).toBe(false);
  });
  test('a key the workspace already held comes once, and stays its own when the activities come back', () => {
    const base = atSso();
    const s = { ...base, list: base.list.map((w) => (w.id === 'A' ? { ...w, order: k(...w.order, 'f:/p/okta.ts') } : w)) };
    const parked = parkWsActivities(s);
    expect(entry(parked, 'A').order.filter((x) => x === 'f:/p/okta.ts')).toHaveLength(1);
    const back = unparkWsActivities(parked);
    expect(entry(back, 'A').order).toContain('f:/p/okta.ts');
    expect(entry(back, 'a1').order).toContain('f:/p/okta.ts');
  });
  test('back on: the activities, their tabs and their terminals come back as they were; the place in front stays', () => {
    const s = unparkWsActivities(parkWsActivities(atSso()));
    expect(s.parked).toBeUndefined();
    expect(s.list.map((w) => w.id)).toEqual(['A', 'B', 'a1', 'a2', 'b1']);
    expect(activitiesOf(s, 'A').map((w) => w.id)).toEqual(['a1', 'a2']);
    expect(s.members).toEqual(mixed().members);
    expect(entry(s, 'A').order).toEqual(k('t:tok', 'f:/p/session.ts'));
    expect(entry(s, 'a1')).toMatchObject({ order: k('t:okta', 't:mock', 'f:/p/okta.ts'), active: 't:mock', layout: LAYOUT, parent: 'A' });
    expect(s.active).toBe('A');
  });
  test('a terminal moved to another workspace meanwhile stays there; a file opened meanwhile stays in the own tabs', () => {
    let s = parkWsActivities(atSso());
    s = moveKey(s, 't:okta', 'B', 'A');
    s = { ...s, list: s.list.map((w) => (w.id === 'A' ? { ...w, order: k(...w.order, 'f:/p/new.ts') } : w)) };
    const back = unparkWsActivities(s);
    expect(back.members.okta).toBe('B');
    expect(entry(back, 'B').order).toContain('t:okta');
    expect(entry(back, 'a1').order).toEqual(k('t:mock', 'f:/p/okta.ts'));
    expect(entry(back, 'A').order).toEqual(k('t:tok', 'f:/p/session.ts', 'f:/p/new.ts'));
  });
  test('a file closed meanwhile does not come back into its activity', () => {
    let s = parkWsActivities(atSso());
    s = { ...s, list: s.list.map((w) => (w.id === 'A' ? { ...w, order: w.order.filter((x) => x !== 'f:/p/okta.ts') } : w)) };
    expect(entry(unparkWsActivities(s), 'a1').order).toEqual(k('t:okta', 't:mock'));
  });
  test('a workspace closed with Move meanwhile: its activities kept aside come back in the target, with their terminals', () => {
    let s = parkWsActivities(atSso());
    s = remove(s, 'B', 'A')!;
    const back = unparkWsActivities(s);
    expect(back.list.find((w) => w.id === 'b1')).toMatchObject({ parent: 'A', color: 1 });
    expect(back.members.hook).toBe('b1');
  });
  test('a workspace recolored meanwhile: its activities wear the new color', () => {
    const s = recolor(parkWsActivities(atSso()), 'A', 7);
    expect(entry(unparkWsActivities(s), 'a2').color).toBe(7);
  });
  test('nothing parked: the same state', () => {
    const s = mixed();
    expect(unparkWsActivities(s)).toBe(s);
  });
  test('a workspace left at an activity gets its own tab in front and split back when the activities return', () => {
    const OWN = { v: 2, panes: [{ tabs: ['t:tok'], front: 't:tok' }, { tabs: ['f:/p/session.ts'], front: 'f:/p/session.ts' }], focus: 1 };
    const base = atSso();
    const s = { ...base, list: base.list.map((w) => (w.id === 'A' ? { ...w, active: 'f:/p/session.ts' as TabKey, layout: OWN } : w)) };
    const back = unparkWsActivities(parkWsActivities(s));
    expect(entry(back, 'A')).toMatchObject({ active: 'f:/p/session.ts', layout: OWN });
  });
  test('a workspace closed with Move meanwhile: its activities kept aside go with it, and come back in the target', () => {
    const s = remove(parkWsActivities(atSso()), 'A', 'B')!;
    expect(s.parked!.list.filter((w) => w.parent === 'B').map((w) => w.id).sort()).toEqual(['a1', 'a2', 'b1']);
    const back = unparkWsActivities(s);
    expect(activitiesOf(back, 'B').map((w) => w.id).sort()).toEqual(['a1', 'a2', 'b1']);
    expect(back.members).toMatchObject({ okta: 'a1', mock: 'a1', mail: 'a2', hook: 'b1', tok: 'B' });
    // Closed with Stop: they go.
    expect(remove(parkWsActivities(atSso()), 'A', null)!.parked!.list.map((w) => w.id)).toEqual(['b1']);
  });
  test('a resumed session, a renamed file, a pruned terminal and a forgotten tab reach the activities kept aside', () => {
    const parked = parkWsActivities(atSso());
    const relinked = unparkWsActivities(relink(parked, 'okta', 'okta2'));
    expect(relinked.members.okta2).toBe('a1');
    expect(entry(relinked, 'a1').order).toEqual(k('t:okta2', 't:mock', 'f:/p/okta.ts'));
    const renamed = renameKeys(parked, (x) => (x === 'f:/p/okta.ts' ? ('f:/p/okta2.ts' as TabKey) : x));
    expect(renamed.parked!.list[0]!.order).toEqual(k('t:okta', 't:mock', 'f:/p/okta2.ts'));
    expect(entry(unparkWsActivities(renamed), 'a1').order).toEqual(k('t:okta', 't:mock', 'f:/p/okta2.ts'));
    expect(prune(parked, ['tok', 'okta', 'bill', 'mail', 'hook']).parked!.members).toEqual({ okta: 'a1', mail: 'a2', hook: 'b1' });
    expect(forget(parked, (x) => x === 'f:/p/okta.ts').parked!.list[0]!.order).toEqual(k('t:okta', 't:mock'));
  });
});

describe('reading a saved state with activities', () => {
  const raw = () => JSON.parse(JSON.stringify(toFront(mixed(), 'a2'))) as Record<string, unknown>;
  test('parents, the place a workspace was left at and the place in front survive', () => {
    const s = parseWorkspaces(raw())!;
    expect(s.list.map((w) => [w.id, w.parent ?? null])).toEqual([['A', null], ['a1', 'A'], ['B', null], ['a2', 'A'], ['b1', 'B']]);
    expect(s.active).toBe('a2');
    expect(s.list[0]!.place).toBe('a2');
    expect(s.members).toEqual(mixed().members);
  });
  test('an activity whose workspace is missing, or that sits in an activity, is dropped with its memberships', () => {
    const r = raw();
    const list = r.list as Record<string, unknown>[];
    list.push({ id: 'x1', parent: 'gone', name: 'x', order: [] }, { id: 'x2', parent: 'a1', name: 'y', order: [] });
    r.members = { ...(r.members as object), q: 'x1', w: 'x2' };
    const s = parseWorkspaces(r)!;
    expect(s.list.some((w) => w.id === 'x1' || w.id === 'x2')).toBe(false);
    expect('q' in s.members || 'w' in s.members).toBe(false);
  });
  test('at most twenty activities per workspace and twenty workspaces, activities aside', () => {
    const list: unknown[] = [];
    for (let i = 0; i < 22; i++) list.push({ id: `w${i}`, name: `w${i}`, order: [] });
    for (let i = 0; i < 22; i++) list.push({ id: `a${i}`, parent: 'w0', name: `a${i}`, order: [] });
    const s = parseWorkspaces({ on: true, active: 'w0', list, members: {} })!;
    expect(workspacesOf(s)).toHaveLength(MAX_WORKSPACES);
    expect(activitiesOf(s, 'w0')).toHaveLength(MAX_ACTIVITIES);
  });
  test('a place naming no activity of that workspace is dropped; a bad parent is no parent', () => {
    const r = raw();
    const list = r.list as Record<string, unknown>[];
    list[2] = { ...list[2], place: 'a1' };
    list[0] = { ...list[0], place: 'nope' };
    list.push({ id: 'z', parent: 42, name: 'z', order: [] });
    const s = parseWorkspaces(r)!;
    expect('place' in s.list[0]!).toBe(false);
    expect('place' in s.list.find((w) => w.id === 'B')!).toBe(false);
    expect(s.list.find((w) => w.id === 'z')!.parent).toBeUndefined();
  });
  test('activities kept aside are read the same way; junk there never drops the state', () => {
    const parked = JSON.parse(JSON.stringify(parkWsActivities(toFront(mixed(), 'a1')))) as Record<string, unknown>;
    const s = parseWorkspaces(parked)!;
    expect(s.parked!.list.map((w) => w.id)).toEqual(['a1', 'a2', 'b1']);
    expect(s.parked!.members).toEqual({ okta: 'a1', mock: 'a1', mail: 'a2', hook: 'b1' });
    expect(unparkWsActivities(s).members).toEqual(mixed().members);
    const bad = parseWorkspaces({ ...parked, parked: { list: [{ id: 'p', parent: 'gone', name: 'p' }, 'junk'], members: { okta: 'p', x: 3 } } })!;
    expect(bad.list.map((w) => w.id)).toEqual(['A', 'B']);
    expect(bad.parked).toBeUndefined();
    expect(parseWorkspaces({ ...parked, parked: 'junk' })!.list).toHaveLength(2);
  });
  test('a state saved by an older version (no parents) reads as before', () => {
    const old = { on: true, active: 'B', list: [{ id: 'A', name: 'a', order: ['t:x'] }, { id: 'B', name: 'b', order: [] }], members: { x: 'A' } };
    const s = parseWorkspaces(old)!;
    expect(s.list.every((w) => !('parent' in w) && !('place' in w))).toBe(true);
    expect('parked' in s).toBe(false);
  });
  test('saved and loaded: parents, places, folds and activities kept aside survive', () => {
    const g = globalThis as { localStorage?: unknown };
    const prev = g.localStorage;
    const saved = new Map<string, string>();
    g.localStorage = { getItem: (key: string) => saved.get(key) ?? null, setItem: (key: string, v: string) => void saved.set(key, v) };
    try {
      const live = toggleOpen(toFront(mixed(), 'a2'), 'a1');
      saveWorkspaces('/p', live);
      expect(loadWorkspaces('/p')).toEqual(live);
      const off = parkWsActivities(live);
      saveWorkspaces('/p', off);
      expect(loadWorkspaces('/p')).toEqual(off);
    } finally { g.localStorage = prev; }
  });
});
