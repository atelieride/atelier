import { afterEach, expect, test } from 'vitest';
import { initPlatform, resetPlatformForTests } from '@shared/platform';
import { blockJumpKey, copyKey, pasteKey, terminalFindKey } from './keys';

// Terminal keys on Windows: copy as Windows Terminal does, command blocks with Ctrl
// (Windows has no ⌘).

const ev = (o: Partial<{ type: string; key: string; shiftKey: boolean; altKey: boolean; metaKey: boolean; ctrlKey: boolean; isComposing: boolean }>) =>
  ({ type: 'keydown', key: 'c', shiftKey: false, altKey: false, metaKey: false, ctrlKey: false, isComposing: false, ...o });

afterEach(() => { resetPlatformForTests(); });

test('Windows: Ctrl+C copies a selection (else it is ^C for the program), Ctrl+Shift+C always copies', () => {
  initPlatform('win32');
  expect(copyKey(ev({ ctrlKey: true }), true)).toBe('copy');
  expect(copyKey(ev({ ctrlKey: true }), false)).toBe(null);
  expect(copyKey(ev({ ctrlKey: true, shiftKey: true, key: 'C' }), false)).toBe('copy');
  expect(copyKey(ev({ ctrlKey: true, type: 'keyup' }), true)).toBe('swallow');
  expect(copyKey(ev({ ctrlKey: true, altKey: true }), true)).toBe(null);
  expect(copyKey(ev({ key: 'c' }), true)).toBe(null);
});

test('macOS: ⌘C is the menu’s, never this', () => {
  initPlatform('darwin');
  expect(copyKey(ev({ ctrlKey: true }), true)).toBe(null);
  expect(copyKey(ev({ metaKey: true }), true)).toBe(null);
});

test('Windows: Ctrl+↑ / Ctrl+↓ jump between command blocks; macOS keeps ⌘', () => {
  initPlatform('win32');
  expect(blockJumpKey(ev({ ctrlKey: true, key: 'ArrowUp' }))).toBe('prev');
  expect(blockJumpKey(ev({ ctrlKey: true, key: 'ArrowDown' }))).toBe('next');
  expect(blockJumpKey(ev({ metaKey: true, key: 'ArrowUp' }))).toBe(null);
  initPlatform('darwin');
  expect(blockJumpKey(ev({ metaKey: true, key: 'ArrowUp' }))).toBe('prev');
  expect(blockJumpKey(ev({ ctrlKey: true, key: 'ArrowUp' }))).toBe(null);
});

test('Windows: Ctrl+V and Ctrl+Shift+V paste (the browser’s paste, never ^V for the program)', () => {
  initPlatform('win32');
  expect(pasteKey(ev({ ctrlKey: true, key: 'v' }))).toBe('paste');
  expect(pasteKey(ev({ ctrlKey: true, shiftKey: true, key: 'V' }))).toBe('paste');
  expect(pasteKey(ev({ ctrlKey: true, key: 'v', type: 'keypress' }))).toBe('swallow');
  expect(pasteKey(ev({ ctrlKey: true, key: 'v', type: 'keyup' }))).toBe('swallow');
  expect(pasteKey(ev({ ctrlKey: true, altKey: true, key: 'v' }))).toBe(null);
  expect(pasteKey(ev({ ctrlKey: true, key: 'v', isComposing: true }))).toBe(null);
  expect(pasteKey(ev({ key: 'v' }))).toBe(null);
});

test('Windows: copy and paste keys on a non-Latin layout (Russian Ctrl+V types м) go by the physical key', () => {
  initPlatform('win32');
  expect(pasteKey({ ...ev({ ctrlKey: true, key: 'м' }), code: 'KeyV' })).toBe('paste');
  expect(copyKey({ ...ev({ ctrlKey: true, key: 'с' }), code: 'KeyC' }, true)).toBe('copy');
  // A Latin layout that moves the letter (AZERTY, Dvorak) keeps going by the letter it types.
  expect(pasteKey({ ...ev({ ctrlKey: true, key: 'q' }), code: 'KeyV' })).toBe(null);
  expect(pasteKey({ ...ev({ ctrlKey: true, key: 'м' }), code: 'KeyM' })).toBe(null);
});

test('macOS: ⌘V is the menu’s and Ctrl+V stays ^V', () => {
  initPlatform('darwin');
  expect(pasteKey(ev({ ctrlKey: true, key: 'v' }))).toBe(null);
  expect(pasteKey(ev({ metaKey: true, key: 'v' }))).toBe(null);
});

test('Windows: Ctrl+Shift+F opens Find in the terminal (the terminal-first rule); Ctrl+F stays ^F for the program', () => {
  initPlatform('win32');
  expect(terminalFindKey(ev({ key: 'F', ctrlKey: true, shiftKey: true }))).toBe('find');
  expect(terminalFindKey(ev({ key: 'F', ctrlKey: true, shiftKey: true, type: 'keyup' }))).toBe('swallow');
  // A non-Latin layout (Russian: the F key types а): the physical key, as Ctrl+C and Ctrl+V.
  expect(terminalFindKey({ ...ev({ key: 'А', ctrlKey: true, shiftKey: true }), code: 'KeyF' })).toBe('find');
  expect(terminalFindKey(ev({ key: 'f', ctrlKey: true }))).toBeNull();
  expect(terminalFindKey(ev({ key: 'F', ctrlKey: true, shiftKey: true, altKey: true }))).toBeNull();
  expect(terminalFindKey(ev({ key: 'f', metaKey: true }))).toBeNull();
});
