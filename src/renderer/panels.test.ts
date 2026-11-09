import { expect, test } from 'vitest';
import { PANEL_DEFAULTS, clampPanel, parseLayout } from './panels';

test('panel widths: within limits, integers', () => {
  expect(clampPanel('sidebar', 100)).toBe(200);
  expect(clampPanel('sidebar', 900)).toBe(480);
  expect(clampPanel('sidebar', 300.6)).toBe(301);
  expect(clampPanel('changes', 100)).toBe(240);
  expect(clampPanel('changes', 1000)).toBe(560);
});

test('larghezze salvate: valori sbagliati o mancanti tornano ai default', () => {
  expect(parseLayout(null)).toEqual(PANEL_DEFAULTS);
  expect(parseLayout('rotto')).toEqual(PANEL_DEFAULTS);
  expect(parseLayout(JSON.stringify({ sidebar: 320, changes: 'x' }))).toEqual({ sidebar: 320, changes: PANEL_DEFAULTS.changes });
  expect(parseLayout(JSON.stringify({ sidebar: 5000, changes: 300 }))).toEqual({ sidebar: 480, changes: 300 });
});

test('side panels: sidebar left and Changes right, or swapped', async () => {
  const { resizeDir } = await import('./panels');
  // Dragging an edge away from its panel's side widens it.
  expect([resizeDir('sidebar', false), resizeDir('changes', false)]).toEqual([1, -1]);
  expect([resizeDir('sidebar', true), resizeDir('changes', true)]).toEqual([-1, 1]);
});

test('resizing a panel a small window draws narrower: narrower from what is drawn, never below its saved width when widened', async () => {
  const { resizedWidth } = await import('./panels');
  // Saved 480, drawn 430: 40 px narrower is 390 at once (not 440, which would still draw 430).
  expect(resizedWidth(480, 430, -40)).toBe(390);
  // Widened with no room: the saved 480 stays (430 + 30 would lower it).
  expect(resizedWidth(480, 430, 30)).toBe(480);
  // Drawn as saved: plain arithmetic both ways.
  expect(resizedWidth(300, 300, 16)).toBe(316);
  expect(resizedWidth(300, 300, -16)).toBe(284);
  // A press on the edge that doesn't move it (a click, a vertical wobble) keeps the saved width.
  expect(resizedWidth(480, 430, 0)).toBe(480);
});
