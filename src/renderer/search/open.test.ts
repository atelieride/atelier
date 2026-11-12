import { EditorSelection, EditorState } from '@codemirror/state';
import { afterAll, beforeAll, expect, test, vi } from 'vitest';

const app = vi.hoisted(() => ({ state: {} as Record<string, unknown>, reads: 0 }));
vi.mock('../store', () => ({ useApp: { getState: () => { app.reads++; return app.state; } } }));
const search = vi.hoisted(() => ({ focusField: vi.fn() }));
vi.mock('./store', () => ({ useSearch: { getState: () => search } }));

import { RESULT_SELECT, resultSelection } from '../editor/result-select';
import { cardHandsOver, f4Action, findInFilesCommand, hasSearchResults, installSearchKeys, searchLoaded, selectionSeed, stepFromPopout } from './open';

// The page as these tests need it: an element that knows which selectors it sits inside, the window and document.
class FakeEl {
  constructor(private readonly inside: string[] = []) {}
  closest(sel: string): FakeEl | null { return sel.split(',').some((s) => this.inside.includes(s.trim())) ? this : null; }
}
const g = globalThis as Record<string, unknown>;
const saved = { window: g.window, document: g.document, input: g.HTMLInputElement, area: g.HTMLTextAreaElement };
beforeAll(() => { g.HTMLInputElement = class {}; g.HTMLTextAreaElement = class {}; });
afterAll(() => { g.window = saved.window; g.document = saved.document; g.HTMLInputElement = saved.input; g.HTMLTextAreaElement = saved.area; });
const PLAIN = { query: '', matchCase: false, wholeWord: false, regex: false };

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
  searchLoaded({ hasResults: () => results, spec: () => ({ query: 'x', matchCase: false, wholeWord: false, regex: true }), step: () => null });
  expect(hasSearchResults()).toBe(true);
  results = false;
  expect(hasSearchResults()).toBe(false);
  expect(selectionSeed({ text: 'a.b' })).toBe('a\\.b');
});

test('the match a result selected is not a selection to search from: the query that found it stays; the user\'s own is', () => {
  const doc = 'const store = new TokenStore();';
  const at = doc.indexOf('TokenStore');
  const base = EditorState.create({ doc, extensions: [resultSelection] });
  const shown = base.update({ selection: EditorSelection.single(at, at + 10), userEvent: RESULT_SELECT }).state;
  expect(selectionSeed({ state: shown }, true)).toBeNull();
  // An edit elsewhere moves it along: still the result's.
  const edited = shown.update({ changes: { from: 0, insert: '// x\n' } }).state;
  expect(selectionSeed({ state: edited }, false)).toBeNull();
  // The user selects something: that is the query, and so is the same text selected again by them.
  const mine = edited.update({ selection: EditorSelection.single(5, 10), userEvent: 'select' }).state;
  expect(selectionSeed({ state: mine }, false)).toBe('const');
  const again = mine.update({ selection: EditorSelection.single(at + 5, at + 15), userEvent: 'select' }).state;
  expect(selectionSeed({ state: again }, false)).toBe('TokenStore');
});

test('F4 at the window: no other key is looked at; it yields to the palette, Settings, a sheet or a menu and a terminal; a pop-out always asks its project window', () => {
  const listeners: ((e: KeyboardEvent) => void)[] = [];
  const forward = vi.fn(() => Promise.resolve());
  const doc = { activeElement: new FakeEl() as unknown };
  g.window = {
    addEventListener: (_t: string, fn: (e: KeyboardEvent) => void) => listeners.push(fn),
    removeEventListener: (_t: string, fn: (e: KeyboardEvent) => void) => { listeners.splice(listeners.indexOf(fn), 1); },
    atelier: { popout: { forward } }
  };
  g.document = doc;
  const step = vi.fn();
  let results = false;
  searchLoaded({ hasResults: () => results, spec: () => PLAIN, step });
  const off = installSearchKeys();
  /** Whether the window took the key (and stopped it). */
  const press = (k: Partial<KeyboardEvent> = {}): boolean => {
    const e = { ...key(k), preventDefault: vi.fn(), stopPropagation: vi.fn() };
    listeners[0]!(e as unknown as KeyboardEvent);
    return e.preventDefault.mock.calls.length > 0;
  };
  app.state = {};
  app.reads = 0;
  expect(press({ key: 'a' })).toBe(false);
  expect(press({ key: 'Enter' })).toBe(false);
  expect(app.reads).toBe(0);
  // No results (and no pop-out): the key is not taken.
  expect(press()).toBe(false);
  results = true;
  expect(press()).toBe(true);
  expect(step).toHaveBeenLastCalledWith(1, false);
  // From the list or the field the keyboard stays there.
  doc.activeElement = new FakeEl(['.sidebar.is-search']);
  expect(press({ shiftKey: true })).toBe(true);
  expect(step).toHaveBeenLastCalledWith(-1, true);
  step.mockClear();
  // Something in front of the results has the keyboard, or a terminal does: the key is theirs.
  app.state = { paletteOpen: true };
  expect(press()).toBe(false);
  app.state = { settingsOpen: 'appearance' };
  expect(press()).toBe(false);
  app.state = {};
  for (const where of ['[role="dialog"]', '[role="menu"]', '[aria-modal="true"]', '.xterm']) {
    doc.activeElement = new FakeEl([where]);
    expect(press(), where).toBe(false);
  }
  expect(step).not.toHaveBeenCalled();
  // A pop-out has no results of its own: its project window walks them, whatever the pop-out shows.
  results = false;
  doc.activeElement = new FakeEl(['.cm-editor']);
  app.state = { popout: { key: 'f:/p/a.ts' }, mdVisit: {} };
  expect(press()).toBe(true);
  expect(forward).toHaveBeenLastCalledWith('next-search-result');
  expect(press({ shiftKey: true })).toBe(true);
  expect(forward).toHaveBeenLastCalledWith('prev-search-result');
  expect(step).not.toHaveBeenCalled();
  off();
  expect(listeners).toEqual([]);
});

test('F4 sent from a pop-out: this window comes forward only when the result opened in it', () => {
  const front = vi.fn(() => Promise.resolve());
  g.window = { atelier: { popout: { front } } };
  let next: string | null = '/p/b.ts';
  searchLoaded({ hasResults: () => true, spec: () => PLAIN, step: () => next });
  app.state = { poppedOut: ['f:/p/a.ts'] };
  stepFromPopout(1);
  expect(front).toHaveBeenCalledTimes(1);
  // In the pop-out's own file: that window shows it, this one stays behind.
  next = '/p/a.ts';
  stepFromPopout(1);
  next = null;
  stepFromPopout(-1);
  expect(front).toHaveBeenCalledTimes(1);
});

test('⌘⇧F in a window without the keyboard (sent from a pop-out) starts from no selection, nor a find card\'s query', async () => {
  const go = vi.fn();
  const card = new FakeEl(['.find-card']);
  cardHandsOver(card as unknown as Element, go);
  searchLoaded({ hasResults: () => false, spec: () => PLAIN, step: () => null });
  g.window = { getSelection: () => ({ toString: () => 'picked' }) };
  app.state = { setActivity: vi.fn() };
  const opened = async () => { await vi.waitFor(() => expect(search.focusField).toHaveBeenCalled()); return search.focusField.mock.lastCall?.[0] as unknown; };
  g.document = { activeElement: card, hasFocus: () => false };
  findInFilesCommand();
  expect(await opened()).toBeUndefined();
  expect(go).not.toHaveBeenCalled();
  g.document = { activeElement: new FakeEl(), hasFocus: () => false };
  search.focusField.mockClear();
  findInFilesCommand();
  expect(await opened()).toBeUndefined();
  // With the keyboard: the card hands its query over; elsewhere the page's selection is the query.
  g.document = { activeElement: card, hasFocus: () => true };
  findInFilesCommand();
  expect(go).toHaveBeenCalledTimes(1);
  g.document = { activeElement: new FakeEl(), hasFocus: () => true };
  search.focusField.mockClear();
  findInFilesCommand();
  expect(await opened()).toEqual({ ...PLAIN, query: 'picked' });
  // Given in a pop-out: never this window's selection, even with the keyboard here by the time it arrives.
  search.focusField.mockClear();
  findInFilesCommand(true);
  expect(await opened()).toBeUndefined();
  g.document = { activeElement: card, hasFocus: () => true };
  findInFilesCommand(true);
  expect(go).toHaveBeenCalledTimes(1);
});
