import { afterEach, expect, test } from 'vitest';
import { initPlatform, resetPlatformForTests } from '@shared/platform';
import { kbd, kbdText } from './kbd';

// Shortcut labels written as macOS shows them (⌘⇧N), shown as each platform has them:
// a menu shortcut takes the Windows keymap, a key inside a panel takes Ctrl for ⌘ (what isMod and CodeMirror's Mod do).

afterEach(() => { resetPlatformForTests(); });

test('macOS: the label as written', () => {
  initPlatform('darwin');
  for (const s of ['⌘W', '⌘⇧N', '⌥-click', '⌘↵', '⇧Tab', '⌃⌥[']) expect(kbd(s)).toBe(s);
});

test('Windows: menu shortcuts as the Windows menu has them', () => {
  initPlatform('win32');
  expect(kbd('⌘N')).toBe('Ctrl+Shift+N');
  expect(kbd('⌘W')).toBe('Ctrl+Shift+W');
  expect(kbd('⌘⇧N')).toBe('Shift+Alt+N');
  expect(kbd('⇧⌘V')).toBe('Shift+Alt+V');
  expect(kbd('⌘⌥R')).toBe('Shift+Alt+R');
  expect(kbd('⌘K')).toBe('Ctrl+Shift+K');
  expect(kbd('⌘,')).toBe('Ctrl+,');
  expect(kbd('⌘\\')).toBe('Ctrl+Shift+\\');
  expect(kbd('⌘⌥→')).toBe('Ctrl+Alt+→');
  expect(kbd('⌃⇧G')).toBe('Ctrl+Shift+G');
  expect(kbd('⌥F5')).toBe('Alt+F5');
  expect(kbd('⌘⇧3')).toBe('');
  // The unsaved-file question's Don't Save and Save.
  expect(kbd('⌘⌫')).toBe('Ctrl+Backspace');
  expect(kbd('⌘S')).toBe('Ctrl+S');
  // ⌃ with ⌘ is the menu's Ctrl+Cmd: Move Tab to Left/Right Pane; New Window has none.
  expect(kbd('⌃⌘←')).toBe('Ctrl+Alt+Shift+←');
  expect(kbd('⌃⌘→')).toBe('Ctrl+Alt+Shift+→');
  expect(kbd('⌃⌘N')).toBe('');
  // Find in Files (the activity item's tip, the view's hint, the find card's button, the palette), and its F4 keys,
  // which no menu has.
  expect(kbd('⌘⇧F')).toBe('Shift+Alt+F');
  expect(kbdText('F4 · ⇧F4')).toBe('F4 · Shift+F4');
});

test('Windows: keys inside panels and editors take Ctrl for ⌘', () => {
  initPlatform('win32');
  expect(kbd('⌘C')).toBe('Ctrl+C');
  expect(kbd('⌘F')).toBe('Ctrl+F');
  expect(kbd('⌥⌘F')).toBe('Ctrl+Alt+F');
  expect(kbd('⌥⇧⌘C')).toBe('Ctrl+Alt+Shift+C');
  expect(kbd('⌘↑')).toBe('Ctrl+↑');
  expect(kbd('⌘↵')).toBe('Ctrl+Enter');
  expect(kbd('⌥↩')).toBe('Alt+Enter');
  expect(kbd('⌥⏎')).toBe('Alt+Enter');
  expect(kbd('⌃G')).toBe('Ctrl+G');
  expect(kbd('⇧Tab')).toBe('Shift+Tab');
  expect(kbd('⌃⌥[')).toBe('Ctrl+Alt+[');
  expect(kbd('⌥-click')).toBe('Alt+click');
  expect(kbd('⌘-click')).toBe('Ctrl+click');
});

test('Windows: text with keys in it, a bare Return glyph included (never "⏎" next to "Shift+Enter")', () => {
  initPlatform('win32');
  expect(kbdText('Find in the terminal (⏎ older match, ⇧⏎ newer)')).toBe('Find in the terminal (Enter older match, Shift+Enter newer)');
  expect(kbdText('⏎ ⇧⏎')).toBe('Enter Shift+Enter');
  expect(kbdText('open it as a kept tab (⏎: a preview)')).toBe('open it as a kept tab (Enter: a preview)');
  expect(kbdText('⌥↩ sends it')).toBe('Alt+Enter sends it');
  initPlatform('darwin');
  expect(kbdText('⏎ ⇧⏎')).toBe('⏎ ⇧⏎');
});
