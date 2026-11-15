import { describe, expect, test } from 'vitest';
import { gridTemplate, paneBox, HEAD_PX, STRIP_PX } from './pane-place';
import { layoutPanes } from './split-layout';
import type { LayoutNode } from './split-tree';

// The split view's grid: every pane's edges and bands become named lines of the workspace body's grid, so a view placed
// in pane i keeps the same placement however the layout changes; only the template changes.

const L: LayoutNode = { kind: 'pane' };
const R = (children: LayoutNode[], sizes = children.map(() => 1 / children.length)): LayoutNode => ({ kind: 'group', dir: 'row', children, sizes });
const C = (children: LayoutNode[], sizes = children.map(() => 1 / children.length)): LayoutNode => ({ kind: 'group', dir: 'column', children, sizes });

/** The template's tracks as px numbers and each line's names, parsed back. */
function parse(t: string): { tracks: number[]; names: string[][] } {
  const names: string[][] = [];
  const tracks: number[] = [];
  for (const part of t.match(/\[[^\]]*\]|\S+/g) ?? []) {
    if (part.startsWith('[')) names.push(part.slice(1, -1).split(/\s+/).filter(Boolean));
    else tracks.push(Number(part.replace('px', '')));
  }
  return { tracks, names };
}
/** Where line `name` is, in px from the start. */
function at(t: string, name: string): number {
  const { tracks, names } = parse(t);
  const i = names.findIndex((n) => n.includes(name));
  expect(i).toBeGreaterThanOrEqual(0);
  return tracks.slice(0, i).reduce((a, b) => a + b, 0);
}

describe('paneBox', () => {
  test('bands are placed between the pane\'s own named lines', () => {
    expect(paneBox(0, 'strip')).toEqual({ gridColumn: 'p0l / p0r', gridRow: 'p0t / p0s' });
    expect(paneBox(2, 'head')).toEqual({ gridColumn: 'p2l / p2r', gridRow: 'p2s / p2h' });
    expect(paneBox(1, 'body')).toEqual({ gridColumn: 'p1l / p1r', gridRow: 'p1h / p1b' });
    expect(paneBox(3, 'full')).toEqual({ gridColumn: 'p3l / p3r', gridRow: 'p3s / p3b' });
  });
  test('the same object every time, so placed views never re-render for it', () => {
    expect(paneBox(1, 'body')).toBe(paneBox(1, 'body'));
  });
});

describe('gridTemplate', () => {
  test('tracks add up to the body and every pane edge is a named line, at its px position', () => {
    const { panes } = layoutPanes(R([L, C([L, L])]), 1001, 601);
    const t = gridTemplate(panes, 1001, 601, STRIP_PX);
    expect(parse(t.columns).tracks.reduce((a, b) => a + b, 0)).toBe(1001);
    expect(parse(t.rows).tracks.reduce((a, b) => a + b, 0)).toBe(601);
    expect(at(t.columns, 'p0l')).toBe(0);
    expect(at(t.columns, 'p0r')).toBe(500);
    expect(at(t.columns, 'p1l')).toBe(501);
    expect(at(t.columns, 'p2r')).toBe(1001);
    expect(at(t.rows, 'p1t')).toBe(0);
    expect(at(t.rows, 'p1b')).toBe(300);
    expect(at(t.rows, 'p2t')).toBe(301);
    expect(at(t.rows, 'p0b')).toBe(601);
  });
  test('the strip and head bands sit under each pane\'s top', () => {
    const { panes } = layoutPanes(C([L, L]), 800, 601);
    const t = gridTemplate(panes, 800, 601, STRIP_PX);
    expect(at(t.rows, 'p1s')).toBe(301 + STRIP_PX);
    expect(at(t.rows, 'p1h')).toBe(301 + STRIP_PX + HEAD_PX);
    expect(at(t.rows, 'p0s')).toBe(STRIP_PX);
  });
  test('without strips in the body, the strip band is empty (its two lines coincide)', () => {
    const { panes } = layoutPanes(R([L, L]), 800, 600);
    const t = gridTemplate(panes, 800, 600, 0);
    expect(at(t.rows, 'p0s')).toBe(0);
    expect(at(t.rows, 'p0h')).toBe(HEAD_PX);
  });
  test('a pane shorter than its bands: the band lines stop at its bottom, no track is negative', () => {
    const { panes } = layoutPanes(C([L, L, L, L]), 400, 120);
    const t = gridTemplate(panes, 400, 120, STRIP_PX);
    for (const v of parse(t.rows).tracks) expect(v).toBeGreaterThanOrEqual(0);
    expect(at(t.rows, 'p0h')).toBeLessThanOrEqual(at(t.rows, 'p0b'));
    expect(parse(t.rows).tracks.reduce((a, b) => a + b, 0)).toBe(120);
  });
});
