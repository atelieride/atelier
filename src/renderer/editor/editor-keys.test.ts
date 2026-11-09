import { afterEach, describe, expect, test, vi } from 'vitest';
import { EditorState, Transaction, type TransactionSpec } from '@codemirror/state';
import { keymap, runScopeHandlers, type EditorView } from '@codemirror/view';
import { foldedRanges } from '@codemirror/language';
import { defaultKeymap } from '@codemirror/commands';
import { searchKeymap } from '@codemirror/search';
import { initPlatform, resetPlatformForTests } from '@shared/platform';
import { jsonEditorExtensions } from './json-ext';
import { defaultKeys, searchKeys, stopAltGrTyping } from './editor-keys';
import { findExtensions } from './find/find-ext';

// CodeMirror reads its platform from navigator when it loads (Node reports the machine's): it runs as on Windows here,
// where Mod is Ctrl and Ctrl+Alt may be AltGr.
vi.hoisted(() => { Object.defineProperty(globalThis, 'navigator', { value: { platform: 'Win32', userAgent: 'Windows', vendor: '' }, configurable: true }); });

afterEach(() => resetPlatformForTests());

interface Key {
  key: string; code: string; keyCode: number; ctrlKey?: boolean; altKey?: boolean; shiftKey?: boolean; metaKey?: boolean;
  altGraph?: boolean; isComposing?: boolean;
}

/** A keydown as Chromium on Windows reports it: AltGr is Ctrl+Alt, AltGraph set only for the right Alt key. */
const keydown = (k: Key) => {
  const calls = { stopped: false, prevented: false };
  const e = {
    key: k.key, code: k.code, keyCode: k.keyCode, ctrlKey: !!k.ctrlKey, altKey: !!k.altKey, shiftKey: !!k.shiftKey, metaKey: !!k.metaKey,
    isComposing: !!k.isComposing, defaultPrevented: false,
    getModifierState: (m: string) => m === 'AltGraph' && !!k.altGraph,
    stopPropagation: () => { calls.stopped = true; },
    preventDefault: () => { calls.prevented = true; e.defaultPrevented = true; }
  };
  return { e, calls };
};

const altGr = (key: string, code: string, keyCode: number, extra: Partial<Key> = {}) => keydown({ key, code, keyCode, ctrlKey: true, altKey: true, altGraph: true, ...extra });

/** Enough of a view for CodeMirror's keymap and commands to run on a state (no DOM in unit tests). */
const fakeView = (state: EditorState) => {
  const v = {
    state,
    lineBlockAt(pos: number) { const l = v.state.doc.lineAt(pos); return { from: l.from, to: l.to }; },
    dispatch(...specs: (Transaction | TransactionSpec)[]) {
      v.state = specs[0] instanceof Transaction ? specs[0].state : v.state.update(...(specs as TransactionSpec[])).state;
    }
  };
  return v;
};

const JSON_DOC = '{\n  "a": {\n    "b": 1\n  }\n}';
const jsonView = () => {
  const s = EditorState.create({ doc: JSON_DOC, extensions: [jsonEditorExtensions(), keymap.of([...searchKeys(), ...defaultKeymap])], selection: { anchor: 2 } });
  return fakeView(s);
};
const folds = (s: EditorState) => { let n = 0; foldedRanges(s).between(0, s.doc.length, () => { n++; }); return n; };

describe('AltGr typing in the editor (Windows)', () => {
  test('Italian AltGr+è types [ and AltGr++ types ]: the keymaps never see them, the character is left to the browser', () => {
    initPlatform('win32');
    for (const [key, code, keyCode] of [['[', 'BracketLeft', 219], [']', 'BracketRight', 221]] as const) {
      const { e, calls } = altGr(key, code, keyCode);
      expect(stopAltGrTyping(e)).toBe(true);
      expect(calls).toEqual({ stopped: true, prevented: false });
    }
  });

  test('the bug: CodeMirror reads Italian AltGr+è as Ctrl+Alt+[ and folds the JSON', () => {
    initPlatform('win32');
    const v = jsonView();
    const { e } = altGr('[', 'BracketLeft', 219);
    expect(runScopeHandlers(v as unknown as EditorView, e as unknown as KeyboardEvent, 'editor')).toBe(true);
    expect(folds(v.state)).toBeGreaterThan(0);
  });

  test('German AltGr+ß types a backslash, with AltGraph or through left Ctrl+Alt', () => {
    initPlatform('win32');
    expect(stopAltGrTyping(altGr('\\', 'Minus', 219).e)).toBe(true);
    expect(stopAltGrTyping(altGr('\\', 'Minus', 219, { altGraph: false }).e)).toBe(true);
  });

  test('Polish AltGr letters are typed, with or without AltGraph, lower and upper case', () => {
    initPlatform('win32');
    for (const [key, code] of [['ś', 'KeyS'], ['ą', 'KeyA'], ['ł', 'KeyL'], ['ż', 'KeyZ'], ['Ś', 'KeyS']] as const) {
      expect(stopAltGrTyping(altGr(key, code, 65, { shiftKey: key === 'Ś' }).e)).toBe(true);
      expect(stopAltGrTyping(altGr(key, code, 65, { altGraph: false, shiftKey: key === 'Ś' }).e)).toBe(true);
    }
  });

  test('a real Ctrl+Alt+[ on a US layout is a shortcut: not stopped, and it still folds', () => {
    initPlatform('win32');
    const { e, calls } = keydown({ key: '[', code: 'BracketLeft', keyCode: 219, ctrlKey: true, altKey: true });
    expect(stopAltGrTyping(e)).toBe(false);
    expect(calls.stopped).toBe(false);
    const v = jsonView();
    expect(runScopeHandlers(v as unknown as EditorView, e as unknown as KeyboardEvent, 'editor')).toBe(true);
    expect(folds(v.state)).toBeGreaterThan(0);
  });

  test('other US Ctrl+Alt shortcuts stay shortcuts (Find and Replace, indent, Shift and digits, Space)', () => {
    initPlatform('win32');
    for (const k of [
      { key: 'f', code: 'KeyF', keyCode: 70 }, { key: '\\', code: 'Backslash', keyCode: 220 }, { key: '{', code: 'BracketLeft', keyCode: 219, shiftKey: true },
      { key: 'C', code: 'KeyC', keyCode: 67, shiftKey: true }, { key: '1', code: 'Digit1', keyCode: 49 }, { key: ' ', code: 'Space', keyCode: 32 },
      { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 }
    ]) expect(stopAltGrTyping(keydown({ ...k, ctrlKey: true, altKey: true }).e)).toBe(false);
  });

  test('a letter of another script is the layout\'s own (Russian Ctrl+Alt+ы): the physical key decides, as in the menu', () => {
    initPlatform('win32');
    expect(stopAltGrTyping(keydown({ key: 'ы', code: 'KeyS', keyCode: 83, ctrlKey: true, altKey: true }).e)).toBe(false);
  });

  test('plain keys, Ctrl alone and IME composition are never touched', () => {
    initPlatform('win32');
    expect(stopAltGrTyping(keydown({ key: '[', code: 'BracketLeft', keyCode: 219 }).e)).toBe(false);
    expect(stopAltGrTyping(keydown({ key: 's', code: 'KeyS', keyCode: 83, ctrlKey: true }).e)).toBe(false);
    expect(stopAltGrTyping(altGr('[', 'BracketLeft', 229, { isComposing: true }).e)).toBe(false);
  });

  test('macOS: ⌘⌥[ and ⌥ characters are unchanged (⌥ is never AltGr there)', () => {
    initPlatform('darwin');
    expect(stopAltGrTyping(keydown({ key: '“', code: 'BracketLeft', keyCode: 219, metaKey: true, altKey: true }).e)).toBe(false);
    expect(stopAltGrTyping(altGr('[', 'BracketLeft', 219).e)).toBe(false);
  });
});

describe('Ctrl+Shift+G is Source Control off macOS', () => {
  const ctrlShiftG = () => keydown({ key: 'G', code: 'KeyG', keyCode: 71, ctrlKey: true, shiftKey: true }).e;

  test('Windows: the search keymap leaves Ctrl+Shift+G to the menu; Ctrl+G and Shift+F3 still search', () => {
    initPlatform('win32');
    const s = EditorState.create({ doc: 'abc abc', extensions: keymap.of(searchKeys()) });
    const v = fakeView(s);
    expect(runScopeHandlers(v as unknown as EditorView, ctrlShiftG() as unknown as KeyboardEvent, 'editor')).toBe(false);
    const keys = searchKeys();
    expect(keys.find((b) => b.key === 'Mod-g')?.run).toBeDefined();
    expect(keys.find((b) => b.key === 'F3')?.shift).toBeDefined();
  });

  test('Windows: the Find card\'s own ⌘G keys leave Ctrl+Shift+G too', () => {
    initPlatform('win32');
    const s = EditorState.create({ doc: 'abc abc', extensions: findExtensions({ readOnly: false }) });
    expect(runScopeHandlers(fakeView(s) as unknown as EditorView, ctrlShiftG() as unknown as KeyboardEvent, 'editor')).toBe(false);
  });

  test('macOS: ⌘⇧G stays Find Previous', () => {
    initPlatform('darwin');
    expect(searchKeys()).toEqual(searchKeymap);
  });
});

describe('⌘I is Ask About This Session', () => {
  test('macOS: the editors\' default keymap leaves ⌘I (Mod-i, select parent syntax) to the menu, and keeps the rest', () => {
    initPlatform('darwin');
    expect(defaultKeymap.some((b) => b.key === 'Mod-i')).toBe(true);
    const keys = defaultKeys();
    expect(keys.some((b) => b.key === 'Mod-i')).toBe(false);
    expect(keys).toHaveLength(defaultKeymap.length - 1);
    // CodeMirror reads Mod as Ctrl here (its navigator is Windows'): Ctrl+I stands in for ⌘I.
    const s = EditorState.create({ doc: 'const a = (1 + 2);', extensions: keymap.of(keys) });
    const ctrlI = keydown({ key: 'i', code: 'KeyI', keyCode: 73, ctrlKey: true }).e;
    expect(runScopeHandlers(fakeView(s) as unknown as EditorView, ctrlI as unknown as KeyboardEvent, 'editor')).toBe(false);
  });

  test('Windows: Ask is Ctrl+Shift+I, so Ctrl+I keeps select parent syntax', () => {
    initPlatform('win32');
    expect(defaultKeys()).toEqual(defaultKeymap);
  });
});
