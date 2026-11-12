import { EditorSelection, EditorState } from '@codemirror/state';
import { expect, test, vi } from 'vitest';

vi.mock('../store', () => ({ useApp: { getState: () => ({}) } }));

import { f4Action, hasSearchResults, searchLoaded, selectionSeed } from './open';

const key = (k: Partial<KeyboardEvent> = {}) => ({ key: 'F4', metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, isComposing: false, ...k });

test('F4 steps to the next result, ⇧F4 to the previous; any other modifier, a terminal or no results leave the key alone', () => {
  expect(f4Action(key(), false, true)).toBe(1);
  expect(f4Action(key({ shiftKey: true }), false, true)).toBe(-1);
  for (const mod of ['metaKey', 'ctrlKey', 'altKey'] as const) {
    expect(f4Action(key({ [mod]: true }), false, true), mod).toBeNull();
    expect(f4Action(key({ [mod]: true, shiftKey: true }), false, true), `${mod}+shift`).toBeNull();
  }
  // In a terminal F4 is the program's (mc, htop).
  expect(f4Action(key(), true, true)).toBeNull();
  expect(f4Action(key({ shiftKey: true }), true, true)).toBeNull();
  expect(f4Action(key(), false, false)).toBeNull();
  expect(f4Action(key({ key: 'F3' }), false, true)).toBeNull();
  expect(f4Action(key({ isComposing: true }), false, true)).toBeNull();
});

const at = (doc: string, from: number, to = from) => EditorState.create({ doc, selection: EditorSelection.single(from, to) });

test('the selection a search starts from: one line of at most 100 characters, escaped as the find card escapes it', () => {
  // A plain query still reads \n and \t as escapes: a selected backslash is doubled to find itself.
  expect(selectionSeed({ text: 'a\\nb' }, false)).toBe('a\\\\nb');
  expect(selectionSeed({ text: 'a.b(c)' }, false)).toBe('a.b(c)');
  // Regular expressions on: the selection is escaped to match itself.
  expect(selectionSeed({ text: 'a.b(c)' }, true)).toBe('a\\.b\\(c\\)');
  expect(selectionSeed({ text: 'x'.repeat(100) }, false)).toBe('x'.repeat(100));
  expect(selectionSeed({ text: 'x'.repeat(101) }, false)).toBeNull();
  expect(selectionSeed({ text: 'one\ntwo' }, false)).toBeNull();
  expect(selectionSeed({ text: '' }, false)).toBeNull();
  expect(selectionSeed(null, false)).toBeNull();
  // The editor's selection, by the find card's own rule.
  const src = 'const re = /a\\d+/;';
  const from = src.indexOf('a\\d');
  expect(selectionSeed({ state: at(src, from, from + 4) }, false)).toBe('a\\\\d+');
  expect(selectionSeed({ state: at(src, from, from + 4) }, true)).toBe('a\\\\d\\+');
  expect(selectionSeed({ state: at(src, from) }, false)).toBeNull();
  expect(selectionSeed({ state: at('one\ntwo', 0, 6) }, false)).toBeNull();
  expect(selectionSeed({ state: at('y'.repeat(300), 0, 150) }, false)).toBeNull();
});

test('before Find in Files has loaded nothing is walked and plain options apply; once loaded, its own say', () => {
  expect(hasSearchResults()).toBe(false);
  expect(selectionSeed({ text: 'a.b' })).toBe('a.b');
  let results = true;
  searchLoaded({ hasResults: () => results, spec: () => ({ query: 'x', matchCase: false, wholeWord: false, regex: true }), step: () => {} });
  expect(hasSearchResults()).toBe(true);
  results = false;
  expect(hasSearchResults()).toBe(false);
  expect(selectionSeed({ text: 'a.b' })).toBe('a\\.b');
});
