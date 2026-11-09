import { afterEach, expect, test } from 'vitest';
import { MAX_LAYOUT_PROJECTS, loadLayout, parseLayouts, saveLayout } from './layout-store';
import type { SavedLayout } from './split';
import type { TabKey } from './tabs-model';

const g = globalThis as { localStorage?: unknown };
const prev = g.localStorage;
afterEach(() => { g.localStorage = prev; });
const memory = () => {
  const saved = new Map<string, string>();
  g.localStorage = { getItem: (k: string) => saved.get(k) ?? null, setItem: (k: string, v: string) => void saved.set(k, v) };
  return saved;
};
const layout = (a: TabKey, b: TabKey, fractions = [0.5, 0.5], focus = 0): SavedLayout => ({ v: 2, panes: [{ tabs: [a], front: a }, { tabs: [b], front: b }], fractions, focus });
const L = layout('t:a', 't:b', [0.4, 0.6], 1);

test('saved per project root under atelier.splitLayout; one project does not touch another', () => {
  const saved = memory();
  saveLayout('/p', L);
  saveLayout('/q', layout('t:c', 't:d'));
  expect(loadLayout('/p')).toEqual(L);
  expect(loadLayout('/q')).toEqual(layout('t:c', 't:d'));
  expect(loadLayout('/r')).toBeNull();
  expect(JSON.parse(saved.get('atelier.splitLayout')!)).toHaveProperty(['/p']);
});

test('null (one pane) removes the project\'s entry', () => {
  memory();
  saveLayout('/p', L);
  saveLayout('/p', null);
  expect(loadLayout('/p')).toBeNull();
});

test('broken or foreign data reads as nothing saved (the shape itself is checked by restoreLayout)', () => {
  expect(parseLayouts(null)).toEqual({});
  expect(parseLayouts('{oops')).toEqual({});
  expect(parseLayouts('[1,2]')).toEqual({});
  expect(parseLayouts('"x"')).toEqual({});
  expect(parseLayouts('{"/p": 3, "/q": [1], "/r": {"panes": []}}')).toEqual({ '/r': { panes: [] } });
});

test('storage unavailable: nothing saved, nothing thrown', () => {
  g.localStorage = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } };
  expect(() => saveLayout('/p', L)).not.toThrow();
  expect(loadLayout('/p')).toBeNull();
});

test('projects past the cap: the least recently saved are forgotten', () => {
  memory();
  for (let i = 0; i <= MAX_LAYOUT_PROJECTS; i++) saveLayout(`/p${i}`, layout('t:a', 't:b'));
  expect(loadLayout('/p0')).toBeNull();
  expect(loadLayout(`/p${MAX_LAYOUT_PROJECTS}`)).not.toBeNull();
});
