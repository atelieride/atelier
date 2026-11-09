import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { formatAccelerator, isImeComposing, isMod, isSourceControlKey } from './keys';
import { MENU_SPEC, menuItems } from './menu-spec';

// Key labels and the main modifier for both platforms. macOS: the glyphs the app has always
// shown, in the accelerator's own order (⌘⇧N, ⌘⌥S, ⌃⌘N); elsewhere: Windows' Ctrl+Shift+N text.

/** The macOS formatter the app had before (src/renderer/shortcuts.ts keysOf), as the oracle. */
const SYM: Record<string, string> = { CmdOrCtrl: '⌘', Cmd: '⌘', Ctrl: '⌃', Shift: '⇧', Alt: '⌥', Option: '⌥' };
// Enter: no menu shortcut used it before Schedule Prompt… (⌘⌥⏎); ⏎ is the glyph the app shows for it everywhere.
const KEY: Record<string, string> = { Left: '←', Right: '→', Up: '↑', Down: '↓', Enter: '⏎' };
const keysOfToday = (accel: string) => { const p = accel.split('+'); return p.map((x, i) => (i < p.length - 1 ? SYM[x] ?? x : KEY[x] ?? x)).join(''); };

const accels = menuItems(MENU_SPEC).flatMap((i) => ('accelerator' in i && i.accelerator ? [i.accelerator] : []));

describe('macOS: exactly the old glyphs', () => {
  test('every menu accelerator and the odd ones', () => {
    expect(accels.length).toBeGreaterThan(15);
    for (const a of [...accels, 'CmdOrCtrl+Alt+S', 'Ctrl+Cmd+N', 'CmdOrCtrl+\\', 'CmdOrCtrl+,', 'Alt+Shift+F5', 'CmdOrCtrl+Alt+Left', 'Ctrl+Shift+Tab']) {
      expect(formatAccelerator(a, 'darwin'), a).toBe(keysOfToday(a));
    }
  });
});

describe('Windows and Linux: Ctrl+Shift+N text', () => {
  test('modifiers as words joined by +, keys as written, arrows as arrows', () => {
    expect(formatAccelerator('CmdOrCtrl+Shift+N', 'win32')).toBe('Ctrl+Shift+N');
    expect(formatAccelerator('CmdOrCtrl+Alt+S', 'win32')).toBe('Ctrl+Alt+S');
    expect(formatAccelerator('Ctrl+Tab', 'win32')).toBe('Ctrl+Tab');
    expect(formatAccelerator('Alt+F5', 'linux')).toBe('Alt+F5');
    expect(formatAccelerator('CmdOrCtrl+Alt+Left', 'win32')).toBe('Ctrl+Alt+←');
    expect(formatAccelerator('CmdOrCtrl+,', 'win32')).toBe('Ctrl+,');
    expect(formatAccelerator('CmdOrCtrl+\\', 'win32')).toBe('Ctrl+\\');
    expect(formatAccelerator('CmdOrCtrl+Return', 'win32')).toBe('Ctrl+Enter');
  });
});

test('isMod: ⌘ on macOS, Ctrl elsewhere', () => {
  expect(isMod({ metaKey: true, ctrlKey: false }, 'darwin')).toBe(true);
  expect(isMod({ metaKey: false, ctrlKey: true }, 'darwin')).toBe(false);
  expect(isMod({ metaKey: false, ctrlKey: true }, 'win32')).toBe(true);
  expect(isMod({ metaKey: true, ctrlKey: false }, 'win32')).toBe(false);
  expect(isMod({ metaKey: false, ctrlKey: true }, 'linux')).toBe(true);
});

test('Ctrl+Shift+G is Source Control everywhere (⌃⇧G on macOS); ⌘⇧G, Ctrl+G and Ctrl+Alt+Shift+G are not', () => {
  const k = (key: string, m: { ctrl?: boolean; shift?: boolean; alt?: boolean; meta?: boolean }, code = 'KeyG') =>
    ({ key, code, ctrlKey: !!m.ctrl, shiftKey: !!m.shift, altKey: !!m.alt, metaKey: !!m.meta });
  expect(isSourceControlKey(k('G', { ctrl: true, shift: true }))).toBe(true);
  // A layout of another script: the physical key decides.
  expect(isSourceControlKey(k('П', { ctrl: true, shift: true }))).toBe(true);
  expect(isSourceControlKey(k('G', { meta: true, shift: true }))).toBe(false);
  expect(isSourceControlKey(k('g', { ctrl: true }))).toBe(false);
  expect(isSourceControlKey(k('G', { ctrl: true, shift: true, alt: true }))).toBe(false);
  expect(isSourceControlKey(k('F', { ctrl: true, shift: true }, 'KeyF'))).toBe(false);
});

test('a key that belongs to an IME composition (Enter picks a candidate, Esc drops it) is never a command', () => {
  expect(isImeComposing({ isComposing: true, keyCode: 13 })).toBe(true);
  // Chromium sends keyCode 229 for keys the IME takes, sometimes before isComposing is set.
  expect(isImeComposing({ isComposing: false, keyCode: 229 })).toBe(true);
  expect(isImeComposing({ isComposing: false, keyCode: 13 })).toBe(false);
  // The palette's field and the dictation's Enter / Esc ask it first.
  expect(readFileSync(join(process.cwd(), 'src/renderer/components/Palette.tsx'), 'utf8')).toMatch(/onKeyDown=\{\(e\) => \{\s*if \(isImeComposing\(e\.nativeEvent\)\) return;/);
  const dictation = readFileSync(join(process.cwd(), 'src/renderer/dictation/controller.ts'), 'utf8');
  expect(dictation.match(/e\.key === '(Enter|Escape)' && !isImeComposing\(e\)/g)).toHaveLength(3);
});
