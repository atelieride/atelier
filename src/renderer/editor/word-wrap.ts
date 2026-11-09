// Word wrap switched from where you are: View › Word Wrap, the palette and ⌥Z in
// an editor. One setting for every editor (files, Review, a commit's diff, a file at a revision), as Settings › Editor
// has it: it goes through main's settings, so every window and the menu's check follow.
import type { KeyBinding } from '@codemirror/view';
import { currentPlatform } from '@shared/platform';
import { useApp } from '../store';

/** Word wrap on if it is off, off if it is on. */
export function toggleWordWrap(): void {
  void window.atelier.settings.set({ wordWrap: !useApp.getState().settings.wordWrap }).catch(() => {});
}

type KeyLike = { key: string; keyCode: number; altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; isComposing?: boolean };

/** Ω: what ⌥Z types on US-derived Mac layouts (Greek capital omega, or the ohm sign). */
const OMEGA = new Set(['Ω', 'Ω']);

/**
 * ⌥Z (Alt+Z off macOS): the layout's Z key with ⌥ alone. On macOS ⌥ types characters: when ⌥Z types a letter (ż on
 * Polish Pro, Â on French, a letter of a Cyrillic or Greek layout) it stays typing; Ω (US-derived layouts), a symbol or
 * the z itself (nothing on ⌥Z) is the shortcut. Off macOS Alt alone types nothing (AltGr is Ctrl+Alt, never this).
 */
export function isWordWrapKey(e: KeyLike, mac = currentPlatform() === 'darwin'): boolean {
  if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || e.isComposing || e.keyCode !== 90) return false;
  if (!mac) return true;
  return e.key !== 'Dead' && (e.key.toLowerCase() === 'z' || OMEGA.has(e.key) || !/\p{L}/u.test(e.key));
}

/**
 * ⌥Z in an editor. An editor key, not the menu's: a menu key would fire from terminals too, where ⌥Z
 * types. Through `any`: CodeMirror leaves ⌥ + a letter to typing on macOS, so Alt-z would never match ⌥Z there.
 * Held down, it switches once: the repeats are taken (nothing typed) without switching again.
 */
export const wordWrapKeys = (toggle: () => void = toggleWordWrap): KeyBinding[] => [{
  any: (_view, e) => {
    if (!isWordWrapKey(e)) return false;
    if (!e.repeat) toggle();
    return true;
  }
}];
