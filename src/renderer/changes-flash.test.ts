import { expect, test } from 'vitest';
import { nextFlash, type FlashBaseline } from './changes-flash';

// Which Changes rows flash in. Rows are { path, repo }.
const r = (path: string, repo = '/p') => ({ path: `${repo}/${path}`, repo });
const step = (prev: FlashBaseline | null, rows: { path: string; repo: string }[], project = '/p') => nextFlash(prev, rows, project);

test('the first list sets the baseline: nothing flashes', () => {
  const s = step(null, [r('a.ts'), r('b.ts')]);
  expect([...s.fresh]).toEqual([]);
});

test('a path that was not listed before flashes; the ones already there do not', () => {
  const a = step(null, [r('a.ts')]);
  const b = step(a.baseline, [r('a.ts'), r('b.ts'), r('c.ts')]);
  expect([...b.fresh].sort()).toEqual(['/p/b.ts', '/p/c.ts']);
  const c = step(b.baseline, [r('a.ts'), r('b.ts'), r('c.ts')]);
  expect([...c.fresh]).toEqual([]);
});

test('a file that leaves the list and comes back flashes again', () => {
  const a = step(null, [r('a.ts'), r('b.ts')]);
  const b = step(a.baseline, [r('a.ts')]);
  const c = step(b.baseline, [r('a.ts'), r('b.ts')]);
  expect([...c.fresh]).toEqual(['/p/b.ts']);
});

test('a repo that shows up later (loaded, added) sets its own baseline: its rows do not flash', () => {
  const a = step(null, [r('a.ts')]);
  const b = step(a.baseline, [r('a.ts'), r('x.ts', '/p/sub')]);
  expect([...b.fresh]).toEqual([]);
  const c = step(b.baseline, [r('a.ts'), r('x.ts', '/p/sub'), r('y.ts', '/p/sub')]);
  expect([...c.fresh]).toEqual(['/p/sub/y.ts']);
});

test('an empty repo seen first still counts as seen: its first file flashes', () => {
  const a = nextFlash(null, [], '/p', ['/p']);
  const b = nextFlash(a.baseline, [r('a.ts')], '/p', ['/p']);
  expect([...b.fresh]).toEqual(['/p/a.ts']);
});

test('another project starts over: nothing flashes', () => {
  const a = step(null, [r('a.ts')]);
  const b = step(a.baseline, [r('z.ts', '/q')], '/q');
  expect([...b.fresh]).toEqual([]);
});

test('the same path twice (two session groups) counts once', () => {
  const a = step(null, [r('a.ts')]);
  const b = step(a.baseline, [r('a.ts'), r('b.ts'), r('b.ts')]);
  expect([...b.fresh]).toEqual(['/p/b.ts']);
});

// A collapsed group (or the closed "maybe" subgroup) pulses for any of its rows, nested worktrees
// included; a row remounted mid-flash (it moved group) carries on from where it was instead of replaying.
import { collapsedFlash, flashOffset } from './changes-flash';

test('collapsedFlash: closed and one of its rows flashing → that row; open, or none flashing → null', () => {
  const rows = [{ path: '/p/a' }, { path: '/p/wt/b' }];
  const flashing = new Map([['/p/wt/b', 100]]);
  expect(collapsedFlash(rows, flashing, false)).toEqual({ path: '/p/wt/b' });
  expect(collapsedFlash(rows, flashing, true)).toBeNull();
  expect(collapsedFlash(rows, new Map(), false)).toBeNull();
});

test('flashOffset: how far into its flash a row is (a negative animation delay), never in the future', () => {
  expect(flashOffset(1000, 1000)).toBe(0);
  expect(flashOffset(1000, 1600)).toBe(-600);
  expect(flashOffset(1000, 900)).toBe(0);
});
