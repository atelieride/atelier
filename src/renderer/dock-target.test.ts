import { afterEach, beforeEach, expect, test } from 'vitest';
import { useApp } from './store';
import { single } from './split';
import { dockTargetAt, paneSize, tabDropAt } from './dock-target';
import { DEFAULT_SETTINGS } from '@shared/settings';

// Tab pop-out windows: a tab popped out from the menu opens as big as it was shown.
const g = globalThis as { document?: unknown };
let els: Record<string, { width: number; height: number }>;

// A tiny stand-in for the main window's DOM (no jsdom here): the elements dockTargetAt reads, with their client rects.
interface Box { left: number; top: number; width: number; height: number }
interface FakeEl { getBoundingClientRect(): DOMRect; querySelectorAll(sel: string): FakeEl[]; querySelector(sel: string): FakeEl | null; dataset: Record<string, string> }
const rect = (b: Box) => ({ ...b, x: b.left, y: b.top, right: b.left + b.width, bottom: b.top + b.height, toJSON: () => b }) as DOMRect;
const el = (b: Box, dataset: Record<string, string> = {}, children: Record<string, FakeEl[]> = {}): FakeEl =>
  ({ getBoundingClientRect: () => rect(b), querySelectorAll: (sel: string) => children[sel] ?? [], querySelector: (sel: string) => children[sel]?.[0] ?? null, dataset });
const fakeDoc = (parts: Record<string, FakeEl>, lists: Record<string, FakeEl[]> = {}) =>
  ({ querySelector: (sel: string) => parts[sel] ?? null, querySelectorAll: (sel: string) => lists[sel] ?? [] }) as unknown as Document;
/** The main window: a sidebar up to x 300, the strip (tabs a, b, c, 100 px each from x 310) on y 46–80, the body below. */
const mainWindow = (frames: FakeEl[] = []) => fakeDoc({
  '.tab-strip': el({ left: 300, top: 46, width: 600, height: 34 }, {}, {
    '.tab[data-key]': ['t:a', 't:b', 't:c'].map((k, i) => el({ left: 310 + i * 100, top: 50, width: 100, height: 30 }, { key: k }))
  }),
  '.workspace-body': el({ left: 300, top: 80, width: 900, height: 600 }, {}, { ':scope > .pane-frame': frames })
});

beforeEach(() => {
  els = {};
  g.document = { querySelector: (sel: string) => (els[sel] ? { getBoundingClientRect: () => els[sel] } : null), hasFocus: () => true };
  useApp.setState({ split: single(), settings: DEFAULT_SETTINGS, tabDrag: null, tabDragTarget: null });
});
afterEach(() => { delete g.document; });

test('one pane: the workspace body plus the pop-out\'s 46 px bar, rounded', () => {
  els['.workspace-body'] = { width: 812.4, height: 590.6 };
  expect(paneSize()).toEqual({ width: 812, height: 637 });
});

test('split: the focused pane (plus the bar)', () => {
  useApp.setState({ tabOrder: ['t:a', 't:b'], split: { panes: [{ tabs: ['t:a'], front: 't:a' }, { tabs: ['t:b'], front: 't:b' }], focus: 1, fractions: [0.5, 0.5] } });
  expect(useApp.getState().split.panes).toHaveLength(2);
  els['.workspace-body'] = { width: 1200, height: 700 };
  els['.pane-frame[data-pane="1"]'] = { width: 599.5, height: 664 };
  expect(paneSize()).toEqual({ width: 600, height: 710 });
});

test('interface size: CSS pixels scaled to window pixels (the bar scales with them)', () => {
  useApp.setState({ settings: { ...DEFAULT_SETTINGS, interfaceSize: 'large' } });
  els['.workspace-body'] = { width: 800, height: 600 };
  expect(paneSize()).toEqual({ width: 880, height: 711 });
  useApp.setState({ settings: { ...DEFAULT_SETTINGS, interfaceSize: 'small' } });
  expect(paneSize()).toEqual({ width: 720, height: 581 });
  useApp.setState({ settings: DEFAULT_SETTINGS });
});

test('nothing on screen (or nothing measurable): the default size', () => {
  expect(paneSize()).toEqual({ width: 900, height: 620 });
  els['.workspace-body'] = { width: 0, height: 0 };
  expect(paneSize()).toEqual({ width: 900, height: 620 });
});

// Drag back: where a pop-out dragged over the main window would land, from the client point.
test('over the strip: before the tab under the pointer (its left half), the next one (right half), the end after the last', () => {
  useApp.setState({ tabOrder: ['t:a', 't:b', 't:c'] });
  const doc = mainWindow();
  expect(dockTargetAt({ x: 420, y: 60 }, doc)).toEqual({ kind: 'strip', pane: 0, before: 't:b' });
  expect(dockTargetAt({ x: 480, y: 60 }, doc)).toEqual({ kind: 'strip', pane: 0, before: 't:c' });
  expect(dockTargetAt({ x: 590, y: 60 }, doc)).toEqual({ kind: 'strip', pane: 0, before: null });
});

test('over the strip\'s padding: at the end after the last tab, before the first left of it', () => {
  useApp.setState({ tabOrder: ['t:a', 't:b', 't:c'] });
  const doc = mainWindow();
  expect(dockTargetAt({ x: 800, y: 60 }, doc)).toEqual({ kind: 'strip', pane: 0, before: null });
  expect(dockTargetAt({ x: 304, y: 60 }, doc)).toEqual({ kind: 'strip', pane: 0, before: 't:a' });
});

test('over the "+" or the empty tab bar right of the strip: at the end (the caret shows on "+")', () => {
  useApp.setState({ tabOrder: ['t:a', 't:b', 't:c'] });
  // The tab bar (y 46–80) holds the strip (to x 900), "+" (900–930), then empty space and the Changes toggle.
  const doc = fakeDoc({
    '.tabs': el({ left: 300, top: 46, width: 900, height: 34 }),
    '.tab-strip': el({ left: 300, top: 46, width: 600, height: 34 }, {}, {
      '.tab[data-key]': ['t:a', 't:b', 't:c'].map((k, i) => el({ left: 310 + i * 100, top: 50, width: 100, height: 30 }, { key: k }))
    }),
    '.workspace-body': el({ left: 300, top: 80, width: 900, height: 600 })
  });
  expect(dockTargetAt({ x: 915, y: 60 }, doc)).toEqual({ kind: 'strip', pane: 0, before: null });
  expect(dockTargetAt({ x: 1100, y: 60 }, doc)).toEqual({ kind: 'strip', pane: 0, before: null });
  // Below the bar: the workspace as before.
  expect(dockTargetAt({ x: 750, y: 300 }, doc)).toEqual({ kind: 'pane', pane: 0, zone: 'middle' });
});

test('over a single pane: its middle shows it there, an edge band opens a pane on that side', () => {
  const doc = mainWindow();
  expect(dockTargetAt({ x: 750, y: 300 }, doc)).toEqual({ kind: 'pane', pane: 0, zone: 'middle' });
  expect(dockTargetAt({ x: 1180, y: 300 }, doc)).toEqual({ kind: 'pane', pane: 0, zone: 'right' });
  expect(dockTargetAt({ x: 310, y: 300 }, doc)).toEqual({ kind: 'pane', pane: 0, zone: 'left' });
});

test('split: the pane frame under the pointer, by its data-pane', () => {
  useApp.setState({ tabOrder: ['t:a', 't:b'], split: { panes: [{ tabs: ['t:a'], front: 't:a' }, { tabs: ['t:b'], front: 't:b' }], focus: 0, fractions: [0.5, 0.5] } });
  const doc = mainWindow([
    el({ left: 300, top: 80, width: 449, height: 600 }, { pane: '0' }),
    el({ left: 750, top: 80, width: 450, height: 600 }, { pane: '1' })
  ]);
  expect(dockTargetAt({ x: 975, y: 300 }, doc)).toEqual({ kind: 'pane', pane: 1, zone: 'middle' });
  expect(dockTargetAt({ x: 1190, y: 300 }, doc)).toEqual({ kind: 'pane', pane: 1, zone: 'right' });
  expect(dockTargetAt({ x: 520, y: 300 }, doc)).toEqual({ kind: 'pane', pane: 0, zone: 'middle' });
  // The 1 px gap between two frames: the nearest one.
  expect(dockTargetAt({ x: 749.5, y: 300 }, doc)).toMatchObject({ kind: 'pane', pane: 0 });
});

test('elsewhere in the window (sidebar, header, session bar): the focused pane\'s middle, so it always lands somewhere shown', () => {
  useApp.setState({ tabOrder: ['t:a', 't:b'], split: { panes: [{ tabs: ['t:a'], front: 't:a' }, { tabs: ['t:b'], front: 't:b' }], focus: 1, fractions: [0.5, 0.5] } });
  const doc = mainWindow();
  expect(dockTargetAt({ x: 120, y: 400 }, doc)).toEqual({ kind: 'pane', pane: 1, zone: 'middle' });
  expect(dockTargetAt({ x: 700, y: 20 }, doc)).toEqual({ kind: 'pane', pane: 1, zone: 'middle' });
});

// Tab groups: one strip over each pane; a tab lands in the strip it is dropped on.
/** Two strips: pane 0's (a, c) over x 300–749, its tabs from x 310; pane 1's (b) over x 750–1200, its tab at 760. */
const splitWindow = () => {
  const tabsOf = (keys: string[], left: number) => keys.map((k, i) => el({ left: left + i * 100, top: 50, width: 100, height: 30 }, { key: k }));
  const strip0 = el({ left: 300, top: 46, width: 400, height: 34 }, {}, { '.tab[data-key]': tabsOf(['t:a', 't:c'], 310) });
  const strip1 = el({ left: 750, top: 46, width: 400, height: 34 }, {}, { '.tab[data-key]': tabsOf(['t:b'], 760) });
  const frames = [el({ left: 300, top: 80, width: 449, height: 600 }, { pane: '0' }), el({ left: 750, top: 80, width: 450, height: 600 }, { pane: '1' })];
  return fakeDoc({ '.workspace-body': el({ left: 300, top: 80, width: 900, height: 600 }, {}, { ':scope > .pane-frame': frames }) }, {
    '.pane-strip': [el({ left: 300, top: 46, width: 449, height: 34 }, { pane: '0' }, { '.tab-strip': [strip0] }), el({ left: 750, top: 46, width: 450, height: 34 }, { pane: '1' }, { '.tab-strip': [strip1] })]
  });
};
const twoPanes = () => useApp.setState({ tabOrder: ['t:a', 't:c', 't:b'], split: { panes: [{ tabs: ['t:a', 't:c'], front: 't:a' }, { tabs: ['t:b'], front: 't:b' }], focus: 0, fractions: [0.5, 0.5] } });

test('split: each pane\'s strip takes the tab before the tab under the pointer, in that pane', () => {
  twoPanes();
  const doc = splitWindow();
  expect(dockTargetAt({ x: 430, y: 60 }, doc)).toEqual({ kind: 'strip', pane: 0, before: 't:c' });
  expect(dockTargetAt({ x: 480, y: 60 }, doc)).toEqual({ kind: 'strip', pane: 0, before: null });
  expect(dockTargetAt({ x: 850, y: 60 }, doc)).toEqual({ kind: 'strip', pane: 1, before: null });
  expect(dockTargetAt({ x: 770, y: 60 }, doc)).toEqual({ kind: 'strip', pane: 1, before: 't:b' });
});

test('split: right of a strip in its bar ("+", the pane tools, the Changes toggle): the end of that pane\'s strip', () => {
  twoPanes();
  const doc = splitWindow();
  expect(dockTargetAt({ x: 720, y: 60 }, doc)).toEqual({ kind: 'strip', pane: 0, before: null });
  expect(dockTargetAt({ x: 1180, y: 60 }, doc)).toEqual({ kind: 'strip', pane: 1, before: null });
});

test('a dragged tab: no zone over its own pane\'s middle, no edge for a tab alone in its pane; other panes as usual', () => {
  twoPanes();
  const doc = splitWindow();
  expect(tabDropAt({ x: 520, y: 300 }, doc, 't:a')).toBeNull();
  expect(tabDropAt({ x: 310, y: 300 }, doc, 't:a')).toEqual({ kind: 'pane', pane: 0, zone: 'left' });
  expect(tabDropAt({ x: 975, y: 300 }, doc, 't:a')).toEqual({ kind: 'pane', pane: 1, zone: 'middle' });
  expect(tabDropAt({ x: 1190, y: 300 }, doc, 't:b')).toBeNull();
  expect(tabDropAt({ x: 1190, y: 300 }, doc, 't:a')).toEqual({ kind: 'pane', pane: 1, zone: 'right' });
  // A pop-out dragged back (no key in any pane): every zone.
  expect(dockTargetAt({ x: 975, y: 300 }, doc)).toEqual({ kind: 'pane', pane: 1, zone: 'middle' });
});

test('one pane: a dragged tab\'s own pane has no middle; its edge needs company', () => {
  useApp.setState({ tabOrder: ['t:a', 't:b', 't:c'] });
  const doc = mainWindow();
  expect(tabDropAt({ x: 750, y: 300 }, doc, 't:a')).toBeNull();
  expect(tabDropAt({ x: 1180, y: 300 }, doc, 't:a')).toEqual({ kind: 'pane', pane: 0, zone: 'right' });
  useApp.setState({ tabOrder: ['t:a'] });
  expect(tabDropAt({ x: 1180, y: 300 }, doc, 't:a')).toBeNull();
});

test('Review Focus 2: a pane that closes mid-drag clears the drop target (the next move computes a new one)', () => {
  twoPanes();
  useApp.setState({ tabDrag: 't:a', tabDragTarget: { kind: 'pane', pane: 1, zone: 'middle' }, activeTab: 'term', selectedId: 'a' });
  useApp.getState().closePane(1);
  expect(useApp.getState().tabDragTarget).toBeNull();
  expect(useApp.getState().tabDrag).toBe('t:a');
  useApp.setState({ tabDrag: null });
});

test('no workspace on screen (welcome, no project): nowhere', () => {
  expect(dockTargetAt({ x: 100, y: 100 }, fakeDoc({}))).toBeNull();
});

// Tab tear-off: a tab dragged inside the window lands where the drag back would, except elsewhere in the
// window (sidebar, header, session bar), where it lands nowhere: released there, nothing changes.
test('a dragged tab: the strip and the panes as the drag back; elsewhere nowhere', () => {
  useApp.setState({ tabOrder: ['t:a', 't:b', 't:c'] });
  const doc = mainWindow();
  expect(tabDropAt({ x: 420, y: 60 }, doc, 't:a')).toEqual({ kind: 'strip', pane: 0, before: 't:b' });
  expect(tabDropAt({ x: 1180, y: 300 }, doc, 't:a')).toEqual({ kind: 'pane', pane: 0, zone: 'right' });
  expect(tabDropAt({ x: 120, y: 400 }, doc)).toBeNull();
  expect(tabDropAt({ x: 700, y: 20 }, doc)).toBeNull();
  expect(tabDropAt({ x: 100, y: 100 }, fakeDoc({}))).toBeNull();
});

// The Shelf: a file tab dragged over the Sessions sidebar's shelf lands on it.
const withShelf = () => fakeDoc({
  '.tab-strip': el({ left: 300, top: 46, width: 600, height: 34 }, {}, { '.tab[data-key]': [] }),
  '.workspace-body': el({ left: 300, top: 80, width: 900, height: 600 }),
  '.shelf': el({ left: 0, top: 400, width: 300, height: 120 }, {}, {
    '.shelf-row[data-path]': ['/p/a.ts', '/p/b.ts'].map((path, i) => el({ left: 8, top: 430 + i * 34, width: 284, height: 32 }, { path }))
  })
});

test('a project file tab over the shelf: before the row under its middle, else last; the pop-out drag back never lands there', () => {
  // A dragged tab is one of the strip's (the store drops a drag whose tab is gone).
  useApp.setState({ project: { root: '/p', name: 'p', realRoot: '/p' }, activity: 'sessions', tabOrder: ['f:/p/c.ts'], tabDrag: 'f:/p/c.ts' });
  const doc = withShelf();
  expect(tabDropAt({ x: 100, y: 405 }, doc)).toEqual({ kind: 'shelf', before: '/p/a.ts' });
  expect(tabDropAt({ x: 100, y: 455 }, doc)).toEqual({ kind: 'shelf', before: '/p/b.ts' });
  expect(tabDropAt({ x: 100, y: 510 }, doc)).toEqual({ kind: 'shelf', before: null });
  // Off the shelf in the sidebar: nothing, as before.
  expect(tabDropAt({ x: 100, y: 300 }, doc)).toBeNull();
  expect(dockTargetAt({ x: 100, y: 455 }, doc)).toEqual({ kind: 'pane', pane: 0, zone: 'middle' });
});

test('the shelf takes no session, terminal, untitled or commit tab, and nothing while another activity is shown', () => {
  const keys = ['t:a', 'review', 'f:untitled:Untitled-1', 'f:/elsewhere/x.ts', 'rev:/p/a.ts@abc', 'f:/p/c.ts'];
  useApp.setState({ project: { root: '/p', name: 'p', realRoot: '/p' }, activity: 'sessions', tabOrder: keys as never });
  const doc = withShelf();
  for (const key of ['t:a', 'review', 'f:untitled:Untitled-1', 'rev:/p/a.ts@abc'] as const) {
    useApp.setState({ tabDrag: key as never });
    expect(useApp.getState().tabDrag).toBe(key);
    expect(tabDropAt({ x: 100, y: 455 }, doc)).toBeNull();
  }
  useApp.setState({ tabDrag: 'f:/p/c.ts' });
  expect(tabDropAt({ x: 100, y: 455 }, doc)).toEqual({ kind: 'shelf', before: '/p/b.ts' });
  // A file outside the project lands too.
  useApp.setState({ tabDrag: 'f:/elsewhere/x.ts' });
  expect(tabDropAt({ x: 100, y: 455 }, doc)).toEqual({ kind: 'shelf', before: '/p/b.ts' });
  useApp.setState({ activity: 'files' });
  expect(tabDropAt({ x: 100, y: 455 }, doc)).toBeNull();
  useApp.setState({ activity: 'sessions', tabDrag: null });
});

test('the release reads the shelf with the dragged key it is given (the store has let go of the drag by then)', () => {
  useApp.setState({ project: { root: '/p', name: 'p', realRoot: '/p' }, activity: 'sessions', tabOrder: ['f:/p/c.ts'], tabDrag: null });
  expect(tabDropAt({ x: 100, y: 455 }, withShelf())).toBeNull();
  expect(tabDropAt({ x: 100, y: 455 }, withShelf(), 'f:/p/c.ts')).toEqual({ kind: 'shelf', before: '/p/b.ts' });
});
