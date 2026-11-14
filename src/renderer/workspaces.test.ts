import { describe, expect, test } from 'vitest';
import type { TerminalInfo } from '@shared/protocol';
import type { TabKey } from './tabs-model';
import {
  MAX_NAME, MAX_WORKSPACES, PROJECT_KEYS, absorb, assign, create, dots, initial, isProjectKey, memberOf, moveKey, nextColor, parseWorkspaces,
  isOpen, projectLast, prune, recolor, relink, remove, rename, renameKeys, reorder, toFront, toggleOpen, union, viewOf, withView,
  type WorkspacesState
} from './workspaces';

// Workspaces: the pure model the store swaps views with.

const k = (...keys: string[]) => keys as TabKey[];
/** Two workspaces: A (auth, tok, a file) active, B (bill, invoice.ts). */
function two(): WorkspacesState {
  return {
    on: true, active: 'A',
    list: [
      { id: 'A', name: 'Auth', color: 1, folder: null, order: k('t:auth', 't:tok', 'f:/p/session.ts'), active: 't:auth', layout: null },
      { id: 'B', name: 'Billing', color: 2, folder: null, order: k('t:bill', 'f:/p/invoice.ts'), active: 't:bill', layout: null }
    ],
    members: { auth: 'A', tok: 'A', bill: 'B' }
  };
}
const term = (id: string, state: string | null, unread = false, extra: Partial<TerminalInfo> = {}): TerminalInfo => ({
  id, projectRoot: '/p', cwd: '/p', title: id, name: null, color: '#B794F6', foreground: 'claude', createdAt: 0,
  session: state ? ({ state, unread, updatedAt: 0 } as unknown as TerminalInfo['session']) : null, ...extra
});

describe('project keys', () => {
  test('the Sessions views are project keys; terminals, files, revisions and the other spaces\' tabs are not', () => {
    expect(PROJECT_KEYS).toEqual(['services', 'review', 'history', 'background']);
    for (const x of ['services', 'review', 'history', 'background']) expect(isProjectKey(x as TabKey)).toBe(true);
    // Docker, Redis, Databases and Automations have spaces of their own.
    for (const x of ['t:a', 'f:/p/x.ts', 'rev:abc:x.ts', 'dk:overview', 'rd:keys', 'au:all', 'db:c0123456789ab']) expect(isProjectKey(x as TabKey)).toBe(false);
  });
  test('projectLast moves them to the end, keeping both orders; an order already right is returned as is', () => {
    expect(projectLast(k('t:a', 'review', 'f:/p/x', 'services', 't:b'))).toEqual(k('t:a', 'f:/p/x', 't:b', 'review', 'services'));
    const ok = k('t:a', 'review');
    expect(projectLast(ok)).toBe(ok);
  });
  test('a workspace holds only Sessions\' tabs: another space\'s keys stay out of its view, its saved entry and the union', () => {
    const s = two();
    const live = k('t:auth', 'db:c0123456789ab', 'dk:overview', 't:tok');
    expect(withView(s, live, 'db:c0123456789ab', null).list[0]).toMatchObject({ order: k('t:auth', 't:tok'), active: null });
    expect(union(s, live)).not.toContain('db:c0123456789ab');
    expect(viewOf({ ...s, list: s.list.map((w, i) => (i === 0 ? { ...w, order: [...w.order, 'db:c0123456789ab' as TabKey, 'rd:keys' as TabKey] } : w)) }, 'A', () => true).order).toEqual(k('t:auth', 't:tok', 'f:/p/session.ts'));
    expect(initial('W1', live, 'dk:overview', ['auth', 'tok']).list[0]).toMatchObject({ order: k('t:auth', 't:tok'), active: null });
  });
});

describe('turning on', () => {
  test('the first time: one workspace holds every tab but the project views, and every live terminal', () => {
    const s = initial('W1', k('t:a', 'dk:overview', 'f:/p/x'), 't:a', ['a', 'b']);
    expect(s.on).toBe(true);
    expect(s.list).toHaveLength(1);
    expect(s.list[0]).toMatchObject({ id: 'W1', name: 'Workspace 1', color: 1, folder: null, order: k('t:a', 'f:/p/x'), active: 't:a' });
    expect(s.members).toEqual({ a: 'W1', b: 'W1' });
    expect(s.active).toBe('W1');
    // Its activities will wear colors of their own from the start: reading it never converts them.
    expect(s.ownColors).toBe(true);
  });
  test('a project view in front is not a workspace tab: the workspace keeps no front', () => {
    expect(initial('W1', k('t:a', 'dk:overview'), 'dk:overview', ['a']).list[0]!.active).toBeNull();
  });
});

describe('creating, renaming, colors, order', () => {
  test('create adds a workspace with the next unused color; the active one does not change', () => {
    const r = create(two(), { name: '  DB migration  ' }, 'C')!;
    expect(r.list.at(-1)).toMatchObject({ id: 'C', name: 'DB migration', color: 3, folder: null, order: [], active: null });
    expect(r.active).toBe('A');
  });
  test('create keeps a folder and a chosen color; an empty name is refused; past the limit nothing is created', () => {
    expect(create(two(), { name: 'X', color: 7, folder: '/p/wt' }, 'C')!.list.at(-1)).toMatchObject({ color: 7, folder: '/p/wt' });
    expect(create(two(), { name: '   ' }, 'C')).toBeNull();
    let s = two();
    for (let i = 0; i < MAX_WORKSPACES - 2; i++) s = create(s, { name: `w${i}` }, `id${i}`)!;
    expect(s.list).toHaveLength(MAX_WORKSPACES);
    expect(create(s, { name: 'one more' }, 'Z')).toBeNull();
  });
  test('names are trimmed and cut to the limit; an empty rename keeps the old name', () => {
    expect(rename(two(), 'B', 'x'.repeat(MAX_NAME + 10)).list[1]!.name).toHaveLength(MAX_NAME);
    expect(rename(two(), 'B', '   ').list[1]!.name).toBe('Billing');
    expect(rename(two(), 'B', ' Payments ').list[1]!.name).toBe('Payments');
  });
  test('nextColor: the first one no workspace uses, then round again', () => {
    expect(nextColor(two().list)).toBe(3);
    const all = Array.from({ length: 8 }, (_, i) => ({ ...two().list[0]!, id: `c${i}`, color: i + 1 }));
    expect(nextColor(all)).toBe(1);
  });
  test('recolor keeps colors in range', () => {
    expect(recolor(two(), 'A', 5).list[0]!.color).toBe(5);
    expect(recolor(two(), 'A', 42).list[0]!.color).toBe(1);
  });
  test('reorder swaps with the neighbour; at an end nothing moves', () => {
    expect(reorder(two(), 'B', -1).list.map((w) => w.id)).toEqual(['B', 'A']);
    const s = two();
    expect(reorder(s, 'A', -1)).toBe(s);
    expect(reorder(s, 'B', 1)).toBe(s);
  });
});

describe('membership', () => {
  test('assign gives new terminals a workspace and never moves one that has it', () => {
    const s = assign(two(), ['bill', 'new1', 'new2'], 'A');
    expect(s.members).toMatchObject({ bill: 'B', new1: 'A', new2: 'A' });
    const same = two();
    expect(assign(same, ['auth', 'bill'], 'A')).toBe(same);
  });
  test('memberOf: its workspace; unknown (or of a workspace that is gone) → the active one', () => {
    expect(memberOf(two(), 'bill')).toBe('B');
    expect(memberOf(two(), 'zzz')).toBe('A');
    expect(memberOf({ ...two(), members: { x: 'gone' } }, 'x')).toBe('A');
  });
  test('relink: a resumed session keeps its workspace under its new id', () => {
    const s = relink(two(), 'bill', 'bill2');
    expect(s.members.bill2).toBe('B');
    expect(s.members.bill).toBeUndefined();
    expect(s.list[1]!.order).toEqual(k('t:bill2', 'f:/p/invoice.ts'));
    expect(s.list[1]!.active).toBe('t:bill2');
  });
  test('prune drops terminals that are neither running nor resumable; nothing to drop → the same state', () => {
    const s = two();
    expect(prune(s, ['auth', 'tok', 'bill'])).toBe(s);
    expect(prune(s, ['auth', 'bill']).members).toEqual({ auth: 'A', bill: 'B' });
  });
});

describe('moving a tab', () => {
  test('a terminal changes workspace: out of its order, into the other one\'s', () => {
    const s = moveKey(two(), 't:tok', 'B');
    expect(s.members.tok).toBe('B');
    expect(s.list[0]!.order).toEqual(k('t:auth', 'f:/p/session.ts'));
    expect(s.list[1]!.order).toEqual(k('t:bill', 'f:/p/invoice.ts', 't:tok'));
  });
  test('a file leaves the source and joins the target once (files can be in several)', () => {
    const s = moveKey(two(), 'f:/p/session.ts', 'B');
    expect(s.list[0]!.order).toEqual(k('t:auth', 't:tok'));
    expect(s.list[1]!.order).toEqual(k('t:bill', 'f:/p/invoice.ts', 'f:/p/session.ts'));
    const twice = moveKey({ ...two(), list: two().list.map((w) => (w.id === 'B' ? { ...w, order: k(...w.order, 'f:/p/session.ts') } : w)) }, 'f:/p/session.ts', 'B');
    expect(twice.list[1]!.order.filter((x) => x === 'f:/p/session.ts')).toHaveLength(1);
  });
  test('a file moved from one workspace stays open in a third one that also shows it', () => {
    const three = create(two(), { name: 'C' }, 'C')!;
    const s = moveKey({ ...three, list: three.list.map((w) => (w.id === 'C' ? { ...w, order: k('f:/p/session.ts') } : w)) }, 'f:/p/session.ts', 'B', 'A');
    expect(s.list.find((w) => w.id === 'C')!.order).toEqual(k('f:/p/session.ts'));
    expect(s.list[0]!.order).toEqual(k('t:auth', 't:tok'));
  });
  test('the moved tab in front of its source leaves the front', () => {
    expect(moveKey(two(), 't:auth', 'B').list[0]!.active).toBeNull();
  });
});

describe('a file renamed or moved', () => {
  test('its key changes in every workspace: order, front and split layout', () => {
    const s = { ...two(), list: two().list.map((w) => (w.id === 'B' ? { ...w, order: k('t:bill', 'f:/p/session.ts'), active: 'f:/p/session.ts' as TabKey, layout: { panes: ['t:bill', 'f:/p/session.ts'], fractions: [0.5, 0.5], focus: 1 } } : w)) };
    const r = renameKeys(s, (x) => (x === 'f:/p/session.ts' ? 'f:/p/auth/session.ts' : x));
    expect(r.list[0]!.order).toEqual(k('t:auth', 't:tok', 'f:/p/auth/session.ts'));
    expect(r.list[1]).toMatchObject({ order: k('t:bill', 'f:/p/auth/session.ts'), active: 'f:/p/auth/session.ts', layout: { panes: ['t:bill', 'f:/p/auth/session.ts'] } });
  });
  test('a v2 layout (every pane\'s tabs) follows the rename too — tabs and front', () => {
    const layout = { v: 2, panes: [{ tabs: ['t:bill'], front: 't:bill' }, { tabs: ['f:/p/x.md', 'f:/p/z.md'], front: 'f:/p/x.md' }], fractions: [0.5, 0.5], focus: 1 };
    const s = { ...two(), list: two().list.map((w) => (w.id === 'B' ? { ...w, order: k('t:bill', 'f:/p/x.md', 'f:/p/z.md'), active: 't:bill' as TabKey, layout } : w)) };
    const r = renameKeys(s, (x) => (x === 'f:/p/x.md' ? 'f:/p/y.md' : x));
    expect(r.list[1]!.layout).toEqual({ ...layout, panes: [{ tabs: ['t:bill'], front: 't:bill' }, { tabs: ['f:/p/y.md', 'f:/p/z.md'], front: 'f:/p/y.md' }] });
  });
  test('nothing renamed: the same state', () => {
    const s = two();
    expect(renameKeys(s, (x) => x)).toBe(s);
  });
});

describe('closing a workspace', () => {
  test('Move: its terminals join the target (members and order); its files close; the active one follows', () => {
    const s = remove(two(), 'A', 'B')!;
    expect(s.list.map((w) => w.id)).toEqual(['B']);
    expect(s.members).toEqual({ auth: 'B', tok: 'B', bill: 'B' });
    expect(s.list[0]!.order).toEqual(k('t:bill', 'f:/p/invoice.ts', 't:auth', 't:tok'));
    expect(s.active).toBe('B');
  });
  test('Stop (no target): its members go; another workspace becomes active', () => {
    const s = remove(two(), 'A', null)!;
    expect(s.members).toEqual({ bill: 'B' });
    expect(s.active).toBe('B');
  });
  test('closing one that is not active keeps the active one', () => {
    expect(remove(two(), 'B', 'A')!.active).toBe('A');
  });
  test('the last workspace cannot be closed', () => {
    const one = remove(two(), 'B', 'A')!;
    expect(remove(one, 'A', null)).toBeNull();
  });
});

describe('views', () => {
  test('withView stores the active workspace\'s live order (project views out), its front and layout', () => {
    const s = withView(two(), k('t:tok', 'dk:overview', 't:auth'), 't:tok', { panes: 2 });
    expect(s.list[0]).toMatchObject({ order: k('t:tok', 't:auth'), active: 't:tok', layout: { panes: 2 } });
    expect(withView(two(), k('t:auth'), 'dk:overview', null).list[0]!.active).toBeNull();
  });
  test('viewOf: its keys that still live, its terminals only (membership wins), its front only if it lives', () => {
    const s = { ...two(), members: { ...two().members, tok: 'B' } };
    const alive = (x: TabKey) => x !== 'f:/p/session.ts';
    expect(viewOf(s, 'A', alive)).toEqual({ order: k('t:auth'), active: 't:auth', layout: null });
    const gone = { ...two(), list: two().list.map((w) => (w.id === 'B' ? { ...w, active: 't:gone' as TabKey } : w)) };
    expect(viewOf(gone, 'B', () => true).active).toBeNull();
  });
  test('union: every workspace in order, the active one\'s live order in its place, project views last, files once', () => {
    const s = { ...two(), list: two().list.map((w) => (w.id === 'B' ? { ...w, order: k(...w.order, 'f:/p/session.ts') } : w)) };
    expect(union(s, k('t:tok', 'review', 't:auth', 'f:/p/session.ts'))).toEqual(k('t:tok', 't:auth', 'f:/p/session.ts', 't:bill', 'f:/p/invoice.ts', 'review'));
  });
  test('absorb: a live key nobody holds joins the active workspace; a terminal joins its own workspace\'s order', () => {
    const s = { ...two(), list: two().list.map((w) => (w.id === 'B' ? { ...w, order: k('f:/p/invoice.ts') } : w)) };
    const r = absorb(s, k('t:auth', 't:bill', 't:new', 'f:/p/new.ts', 'dk:overview'));
    expect(r.members.new).toBe('A');
    expect(r.list[0]!.order).toEqual(k('t:auth', 't:tok', 'f:/p/session.ts', 't:new', 'f:/p/new.ts'));
    expect(r.list[1]!.order).toEqual(k('f:/p/invoice.ts', 't:bill'));
  });
});

describe('state dots', () => {
  test('one per state present: waiting, working, done (finished, not seen), to resume; idle shows none', () => {
    const list = [term('a', 'waiting'), term('b', 'running'), term('c', 'running'), term('d', 'done', true), term('e', 'done', false), term('f', 'idle'), term('g', null)];
    expect(dots(list, 1)).toEqual([{ kind: 'waiting', n: 1 }, { kind: 'working', n: 2 }, { kind: 'done', n: 1 }, { kind: 'resume', n: 1 }]);
    expect(dots([term('f', 'idle')], 0)).toEqual([]);
  });
});

describe('parse', () => {
  test('a saved state comes back; junk entries are dropped, never the whole state', () => {
    const raw = JSON.parse(JSON.stringify({ ...two(), list: [...two().list, { id: 3 }, { id: 'A', name: 'dup', color: 1, order: [] }], members: { auth: 'A', x: 7, y: 'nope' } }));
    const s = parseWorkspaces(raw)!;
    expect(s.list.map((w) => w.id)).toEqual(['A', 'B']);
    expect(s.members).toEqual({ auth: 'A' });
    expect(s.on).toBe(true);
  });
  test('bad keys, colors and names are cleaned; an unknown active becomes the first', () => {
    const s = parseWorkspaces({ on: false, active: 'nope', list: [{ id: 'A', name: 'x'.repeat(200), color: 99, folder: 5, order: ['t:a', 'bogus', 'f:rel', 7], active: 'bogus', layout: { a: 1 } }], members: {} })!;
    expect(s.active).toBe('A');
    expect(s.on).toBe(false);
    expect(s.list[0]).toMatchObject({ name: 'x'.repeat(MAX_NAME), color: 1, folder: null, order: k('t:a'), active: null, layout: { a: 1 } });
  });
  test('table tabs saved in a workspace by an older version are left out: tables live in Databases now', () => {
    const orders = 'db:c0123456789ab/public/orders';
    const s = parseWorkspaces({ on: true, active: 'A', list: [{ id: 'A', name: 'a', order: ['t:a', orders, 'db:c0123456789ab', 'db:nope', 'db:c0123456789ab/public'], active: orders }], members: {} })!;
    expect(s.list[0]).toMatchObject({ order: k('t:a'), active: null });
  });
  test('"turned on by the setting for every project" comes back only with workspaces on (2026-11-02)', () => {
    expect(parseWorkspaces({ ...two(), on: true, forced: true })!.forced).toBe(true);
    expect(parseWorkspaces({ ...two(), on: false, forced: true })!.forced).toBeUndefined();
    expect(parseWorkspaces({ ...two(), on: true, forced: 'yes' })!.forced).toBeUndefined();
    expect('forced' in parseWorkspaces({ ...two(), on: true })!).toBe(false);
  });
  test('not a state, or one with no workspace: null', () => {
    for (const raw of [null, 3, 'x', [], {}, { on: true, active: 'A', list: [], members: {} }]) expect(parseWorkspaces(raw)).toBeNull();
  });
});

describe('open or folded in the sidebar', () => {
  test('unset: the active workspace is open, the others folded', () => {
    const s = two();
    expect(isOpen(s, 'A')).toBe(true);
    expect(isOpen(s, 'B')).toBe(false);
  });
  test('the chevron writes the explicit value, folding the active one or opening another', () => {
    let s = toggleOpen(two(), 'B');
    expect(isOpen(s, 'B')).toBe(true);
    expect(s.list.find((w) => w.id === 'B')!.open).toBe(true);
    s = toggleOpen(s, 'A');
    expect(isOpen(s, 'A')).toBe(false);
    s = toggleOpen(s, 'A');
    expect(isOpen(s, 'A')).toBe(true);
    expect(toggleOpen(s, 'nope')).toBe(s);
  });
  test('coming to the front clears its value and opens it', () => {
    // B folded on purpose, then brought to the front: open, its value gone.
    const s = toFront(toggleOpen(toggleOpen(two(), 'B'), 'B'), 'B');
    expect(s.active).toBe('B');
    expect(s.list.find((w) => w.id === 'B')!.open).toBeUndefined();
    expect(isOpen(s, 'B')).toBe(true);
  });
  test('the one left keeps showing what it showed: open stays open, folded stays folded (revised 2026-11-08)', () => {
    // A, open only because it was in front, stays open once B comes forward: switching never folds anything.
    const s = toFront(two(), 'B');
    expect(isOpen(s, 'A')).toBe(true);
    expect(s.list.find((w) => w.id === 'A')!.open).toBe(true);
    // A folded by its chevron while in front stays folded.
    expect(isOpen(toFront(toggleOpen(two(), 'A'), 'B'), 'A')).toBe(false);
    // Back and forth: both open; a third never opened stays folded.
    const three: WorkspacesState = { ...two(), list: [...two().list, { id: 'C', name: 'Hotfix', color: 3, folder: null, order: [], active: null, layout: null }] };
    const back = toFront(toFront(three, 'B'), 'A');
    expect([isOpen(back, 'A'), isOpen(back, 'B'), isOpen(back, 'C')]).toEqual([true, true, false]);
  });
  test('the one in front or an unknown id: the same state', () => {
    const s = two();
    expect(toFront(s, 'A')).toBe(s);
    expect(toFront(s, 'nope')).toBe(s);
  });
  test('a saved state keeps a boolean open and drops anything else', () => {
    const s = parseWorkspaces({ on: true, active: 'A', list: [{ id: 'A', name: 'a', open: false }, { id: 'B', name: 'b', open: true }, { id: 'C', name: 'c', open: 'yes' }], members: {} })!;
    expect(s.list.map((w) => w.open)).toEqual([false, true, undefined]);
    expect('open' in s.list[2]!).toBe(false);
  });
});
