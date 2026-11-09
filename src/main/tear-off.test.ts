import { beforeEach, expect, test } from 'vitest';
import { placeWindow, type Bounds, type Point } from '@shared/popout';
import { TearOff, type GhostWin, type TearDeps, type TearStart } from './tear-off';

// Tab tear-off: while a tab is dragged, a ghost window follows the pointer outside
// the project window, the pop-out takes its place when released there, and nothing is left once the drag ends.

class FakeGhost implements GhostWin {
  bounds: Bounds;
  opacity = 0;
  destroyed = false;
  filled: unknown[] = [];
  shots: string[] = [];
  constructor(b: Bounds) { this.bounds = { ...b }; }
  setBounds(b: Bounds) { this.bounds = { ...b }; }
  setOpacity(o: number) { this.opacity = o; }
  destroy() { this.destroyed = true; }
  isDestroyed() { return this.destroyed; }
  fill(info: unknown) { this.filled.push(info); }
  snapshot(url: string) { this.shots.push(url); }
}

class Clock {
  now = 0;
  private items: { at: number; every: number | null; fn: () => void; live: boolean }[] = [];
  timer(fn: () => void, ms: number, every = false) {
    const item = { at: this.now + ms, every: every ? ms : null, fn, live: true };
    this.items.push(item);
    return { clear: () => { item.live = false; } };
  }
  live() { return this.items.filter((i) => i.live).length; }
  tick(ms: number) {
    const end = this.now + ms;
    for (;;) {
      const next = this.items.filter((i) => i.live && i.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!next) break;
      this.now = next.at;
      if (next.every === null) next.live = false; else next.at += next.every;
      next.fn();
    }
    this.now = end;
  }
}

const ROOT = '/p/alpha';
const AREAS: Bounds[] = [{ x: 0, y: 25, width: 1920, height: 1055 }];
const MAIN: Bounds = { x: 900, y: 100, width: 900, height: 700 };
const START: TearStart = { key: 't:a', title: 'Alfa', icon: 'session', color: 'violet', size: { width: 600, height: 400 }, rect: { x: 300, y: 80, width: 600, height: 354 } };

let clock: Clock;
let cursor: Point;
let project: Bounds | null;
let ghosts: FakeGhost[];
let ready: Map<number, () => void>;
let shots: { root: string; rect: Bounds; resolve: (u: string | null) => void }[];
let failCreate: boolean;
let created: number;
let tear: TearOff;

beforeEach(() => {
  clock = new Clock();
  cursor = { x: 1200, y: 300 };
  project = { ...MAIN };
  ghosts = [];
  ready = new Map();
  shots = [];
  failCreate = false;
  created = 0;
  const deps: TearDeps = {
    cursor: () => ({ ...cursor }),
    displays: () => AREAS,
    projectBounds: () => (project ? { ...project } : null),
    createGhost: (b) => { created++; if (failCreate) return null; const g = new FakeGhost(b); ghosts.push(g); return g; },
    snapshot: (root, rect) => new Promise((resolve) => { shots.push({ root, rect, resolve }); }),
    onceReady: (id, fn) => { ready.set(id, fn); },
    setInterval: (fn, ms) => clock.timer(fn, ms, true),
    setTimer: (fn, ms) => clock.timer(fn, ms)
  };
  tear = new TearOff(deps);
});

const at = (x: number, y: number) => { cursor = { x, y }; clock.tick(16); };
const placed = (c: Point) => placeWindow({ cursor: c, size: START.size, main: MAIN, areas: AREAS, cascade: 0 });
const settle = () => clock.tick(200);

test('inside the project window: no ghost at all (a reorder never makes one)', () => {
  tear.start(ROOT, START);
  at(1300, 400);
  settle();
  expect(ghosts).toHaveLength(0);
  tear.end(ROOT);
  expect(clock.live()).toBe(0);
});

test('outside: one ghost, where the pop-out will open, filled with the tab, shown; it follows the pointer', () => {
  tear.start(ROOT, START);
  at(400, 300);
  expect(ghosts).toHaveLength(1);
  const g = ghosts[0]!;
  expect(g.bounds).toEqual(placed({ x: 400, y: 300 }));
  expect(g.filled).toEqual([{ title: 'Alfa', icon: 'session', color: 'violet' }]);
  settle();
  expect(g.opacity).toBe(1);
  at(420, 330);
  expect(g.bounds).toEqual(placed({ x: 420, y: 330 }));
});

test('the tab\'s snapshot is asked once, from its view\'s rect, a moment after the ghost (not on the tick that makes it), and shown when it comes', async () => {
  tear.start(ROOT, START);
  at(400, 300);
  expect(shots).toHaveLength(0);
  at(410, 300);
  clock.tick(60);
  expect(shots).toEqual([{ root: ROOT, rect: START.rect, resolve: expect.any(Function) }]);
  shots[0]!.resolve('data:image/jpeg;base64,AAAA');
  await Promise.resolve();
  expect(ghosts[0]!.shots).toEqual(['data:image/jpeg;base64,AAAA']);
});

test('no rect (the tab is not on screen): no snapshot asked', () => {
  tear.start(ROOT, { ...START, rect: undefined });
  at(400, 300);
  clock.tick(200);
  expect(shots).toHaveLength(0);
});

test('back over the project window it fades away, out again it shows: still one ghost', () => {
  tear.start(ROOT, START);
  at(400, 300);
  settle();
  at(1300, 400);
  settle();
  expect(ghosts[0]!.opacity).toBe(0);
  at(300, 300);
  settle();
  expect(ghosts).toHaveLength(1);
  expect(ghosts[0]!.opacity).toBe(1);
});

test('the drag ends (released inside, Esc, lost pointer): the ghost is destroyed and the loop stops', () => {
  tear.start(ROOT, START);
  at(400, 300);
  clock.tick(60);
  tear.end(ROOT);
  expect(ghosts[0]!.destroyed).toBe(true);
  expect(clock.live()).toBe(0);
  // A late snapshot never touches a destroyed ghost.
  shots[0]!.resolve('data:x');
});

test('the project window goes (closed, reloading): the drag ends by itself', () => {
  tear.start(ROOT, START);
  at(400, 300);
  project = null;
  clock.tick(16);
  expect(ghosts[0]!.destroyed).toBe(true);
  expect(clock.live()).toBe(0);
});

test('a new drag ends the previous one: never two ghosts', () => {
  tear.start(ROOT, START);
  at(400, 300);
  tear.start('/p/beta', { ...START, key: 't:b' });
  expect(ghosts[0]!.destroyed).toBe(true);
  at(410, 300);
  expect(ghosts.filter((g) => !g.destroyed)).toHaveLength(1);
});

test('end for another project leaves this drag alone', () => {
  tear.start(ROOT, START);
  at(400, 300);
  tear.end('/p/beta');
  expect(ghosts[0]!.destroyed).toBe(false);
});

test('released outside: the pop-out takes the ghost\'s bounds; the ghost stays until that window is ready', () => {
  tear.start(ROOT, START);
  at(400, 300);
  settle();
  const h = tear.takeOver(ROOT)!;
  expect(h.bounds).toEqual(placed({ x: 400, y: 300 }));
  expect(clock.live()).toBe(0);
  h.done(42);
  // The renderer's tearEnd after its popOut finds nothing to end.
  tear.end(ROOT);
  expect(ghosts[0]!.destroyed).toBe(false);
  ready.get(42)!();
  expect(ghosts[0]!.destroyed).toBe(true);
});

test('a window that never gets ready: the ghost goes after a grace', () => {
  tear.start(ROOT, START);
  at(400, 300);
  tear.takeOver(ROOT)!.done(42);
  clock.tick(2000);
  expect(ghosts[0]!.destroyed).toBe(true);
});

test('the open failed (or was inside after all): the ghost goes at once', () => {
  tear.start(ROOT, START);
  at(400, 300);
  tear.takeOver(ROOT)!.done(null);
  expect(ghosts[0]!.destroyed).toBe(true);
});

test('take over with no ghost on screen (never left, or faded back): none, and the drag ends', () => {
  tear.start(ROOT, START);
  at(1300, 400);
  expect(tear.takeOver(ROOT)).toBeNull();
  expect(clock.live()).toBe(0);
  tear.start(ROOT, START);
  at(400, 300);
  at(1300, 400);
  expect(tear.takeOver(ROOT)).toBeNull();
  expect(ghosts[0]!.destroyed).toBe(true);
  expect(tear.takeOver('/p/none')).toBeNull();
});

test('a ghost that can\'t be made is not tried again during that drag', () => {
  failCreate = true;
  tear.start(ROOT, START);
  at(400, 300);
  at(420, 300);
  settle();
  expect(created).toBe(1);
  expect(tear.takeOver(ROOT)).toBeNull();
});

test('a still pointer moves nothing', () => {
  tear.start(ROOT, START);
  at(400, 300);
  const g = ghosts[0]!;
  let moves = 0;
  const set = g.setBounds.bind(g);
  g.setBounds = (b) => { moves++; set(b); };
  settle();
  expect(moves).toBe(0);
  at(401, 300);
  expect(moves).toBe(1);
});

test('reduced motion: the ghost shows and hides at once, and its page is told', () => {
  tear.start(ROOT, { ...START, reduced: true });
  at(400, 300);
  expect(ghosts[0]!.opacity).toBe(1);
  expect(ghosts[0]!.filled).toEqual([{ title: 'Alfa', icon: 'session', color: 'violet', reduced: true }]);
  at(1300, 400);
  expect(ghosts[0]!.opacity).toBe(0);
});

test('a drag the renderer never ends (it forgot): the tear stops by itself after ten minutes', () => {
  tear.start(ROOT, START);
  at(400, 300);
  clock.tick(599_000);
  expect(ghosts[0]!.destroyed).toBe(false);
  clock.tick(1_000);
  expect(ghosts[0]!.destroyed).toBe(true);
  expect(clock.live()).toBe(0);
});

test('the ghost is drawn in the theme on screen', () => {
  tear.start(ROOT, { ...START, theme: 'paper' });
  at(400, 300);
  expect(ghosts[0]!.filled).toEqual([{ title: 'Alfa', icon: 'session', color: 'violet', theme: 'paper' }]);
});

// Over another project's window that can take the tab, the ghost fades
// out and that window shows where it would land; leaving it, or the drag ending, clears its hint.
test('over another project\'s window that takes the tab: no ghost, the hint there; away again: the ghost, the hint cleared', () => {
  const hints: (Point | null)[] = [];
  let over = false;
  const deps = (tear as unknown as { deps: TearDeps }).deps;
  tear = new TearOff({ ...deps, across: (root, key, c) => (over && root === ROOT && key === START.key ? { root: '/p/beta', point: { x: c.x - 100, y: c.y - 50 }, hover: (p) => hints.push(p) } : null) });
  tear.start(ROOT, START);
  cursor = { x: 300, y: 300 };
  clock.tick(16 * 6);
  expect(ghosts[0]!.opacity).toBe(1);
  over = true;
  clock.tick(16 * 6);
  expect(ghosts[0]!.opacity).toBe(0);
  expect(hints).toEqual([{ x: 200, y: 250 }]);
  cursor = { x: 310, y: 300 };
  clock.tick(16);
  expect(hints).toEqual([{ x: 200, y: 250 }, { x: 210, y: 250 }]);
  over = false;
  clock.tick(16 * 6);
  expect(ghosts[0]!.opacity).toBe(1);
  expect(hints.at(-1)).toBeNull();
  over = true;
  clock.tick(16);
  tear.end(ROOT);
  expect(hints.at(-1)).toBeNull();
  expect(ghosts[0]!.destroyed).toBe(true);
});
