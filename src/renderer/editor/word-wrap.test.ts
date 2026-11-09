import { afterEach, describe, expect, test, vi } from 'vitest';
import { EditorState } from '@codemirror/state';
import { keymap, runScopeHandlers, type EditorView } from '@codemirror/view';
import { defaultKeymap } from '@codemirror/commands';
import { initPlatform, resetPlatformForTests } from '@shared/platform';
import { useApp } from '../store';
import { isWordWrapKey, toggleWordWrap, wordWrapKeys } from './word-wrap';

// CodeMirror reads its platform from navigator when it loads: macOS here, where it leaves ⌥ + a letter to typing
// ("Alt-combinations on macOS tend to be typed characters"), so Alt-z alone never matches ⌥Z there.
vi.hoisted(() => { Object.defineProperty(globalThis, 'navigator', { value: { platform: 'MacIntel', userAgent: 'Macintosh', vendor: '' }, configurable: true }); });

afterEach(() => { vi.unstubAllGlobals(); resetPlatformForTests(); });

type K = { key: string; keyCode?: number; altKey?: boolean; ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean; repeat?: boolean };
const keydown = (k: K) => ({
  key: k.key, code: 'KeyZ', keyCode: k.keyCode ?? 90, altKey: !!k.altKey, ctrlKey: !!k.ctrlKey, metaKey: !!k.metaKey, shiftKey: !!k.shiftKey, repeat: !!k.repeat,
  isComposing: false, defaultPrevented: false, getModifierState: () => false, stopPropagation() {}, preventDefault() { this.defaultPrevented = true; }
});

/** Runs a keydown through an editor's keymaps (no DOM in unit tests): whether it was handled, and the toggles. */
const press = (k: K) => {
  const toggle = vi.fn();
  const view = { state: EditorState.create({ doc: 'a long line', extensions: [keymap.of([...wordWrapKeys(toggle), ...defaultKeymap])] }), dispatch() {} };
  const handled = runScopeHandlers(view as unknown as EditorView, keydown(k) as unknown as KeyboardEvent, 'editor');
  return { handled, toggles: toggle.mock.calls.length };
};

describe('⌥Z in an editor', () => {
  test('macOS: ⌥Z typing a symbol (Ω on US layouts) switches word wrap, and the Ω is not typed', () => {
    initPlatform('darwin');
    expect(press({ key: 'Ω', altKey: true })).toEqual({ handled: true, toggles: 1 });
  });

  test('macOS: ⌥Z typing a letter (ż on Polish Pro) stays typing', () => {
    initPlatform('darwin');
    expect(press({ key: 'ż', altKey: true })).toEqual({ handled: false, toggles: 0 });
    expect(isWordWrapKey({ key: 'Dead', keyCode: 90, altKey: true, ctrlKey: false, metaKey: false, shiftKey: false }, true)).toBe(false);
    // A layout with nothing on ⌥Z reports the z itself (as Playwright does): the shortcut.
    expect(isWordWrapKey({ key: 'z', keyCode: 90, altKey: true, ctrlKey: false, metaKey: false, shiftKey: false }, true)).toBe(true);
  });

  test('macOS: ⌥Z typing a letter of another script (Cyrillic, Greek) stays typing; Ω and symbols are the shortcut', () => {
    const k = (key: string) => isWordWrapKey({ key, keyCode: 90, altKey: true, ctrlKey: false, metaKey: false, shiftKey: false }, true);
    expect([k('ж'), k('ζ'), k('Â'), k('ż')]).toEqual([false, false, false, false]);
    // Greek capital omega and the ohm sign: what US-derived layouts type.
    expect([k('Ω'), k('Ω'), k('≈'), k('Z')]).toEqual([true, true, true, true]);
  });

  test('held down, ⌥Z switches once: its repeats are swallowed, never typed nor switching again', () => {
    initPlatform('darwin');
    expect(press({ key: 'Ω', altKey: true, repeat: true })).toEqual({ handled: true, toggles: 0 });
  });

  test('Windows: Alt+Z switches it; AltGr+Z (Ctrl+Alt, ż on Polish) is typing', () => {
    initPlatform('win32');
    expect(press({ key: 'z', altKey: true })).toEqual({ handled: true, toggles: 1 });
    expect(press({ key: 'ż', altKey: true, ctrlKey: true })).toEqual({ handled: false, toggles: 0 });
  });

  test('Z, ⇧⌥Z, ⌘Z and ⌥ on another key are not it', () => {
    initPlatform('darwin');
    for (const k of [{ key: 'z' }, { key: '¸', altKey: true, shiftKey: true }, { key: 'z', metaKey: true }, { key: '≈', altKey: true, keyCode: 88 }]) {
      expect(press(k).toggles, JSON.stringify(k)).toBe(0);
    }
  });
});

describe('toggleWordWrap', () => {
  test('asks the settings for the other value: every window and the menu follow the change', () => {
    const set = vi.fn(async (p: object) => p);
    vi.stubGlobal('window', { atelier: { settings: { set } } });
    useApp.setState({ settings: { ...useApp.getState().settings, wordWrap: false } });
    toggleWordWrap();
    expect(set).toHaveBeenLastCalledWith({ wordWrap: true });
    useApp.setState({ settings: { ...useApp.getState().settings, wordWrap: true } });
    toggleWordWrap();
    expect(set).toHaveBeenLastCalledWith({ wordWrap: false });
  });
});
