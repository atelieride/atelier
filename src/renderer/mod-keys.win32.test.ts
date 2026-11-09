import { afterEach, expect, test } from 'vitest';
import { initPlatform, resetPlatformForTests } from '@shared/platform';
import { isConnectorsBackKey } from './connectors-view';
import { shortcutAction } from './editor/find/find-logic';

// ⌘ shortcuts inside panels are Ctrl on Windows (no ⌘ there); macOS unchanged.

const ev = (o: Partial<KeyboardEvent>) => ({ key: 'Enter', code: 'Enter', altKey: false, metaKey: false, shiftKey: false, ctrlKey: false, isComposing: false, ...o }) as KeyboardEvent;

afterEach(() => { resetPlatformForTests(); });

test('find in file: Ctrl+Enter replaces all on Windows (⌘Enter on macOS)', () => {
  initPlatform('win32');
  expect(shortcutAction(ev({ ctrlKey: true }), 'replace', false)).toBe('replaceAll');
  expect(shortcutAction(ev({}), 'replace', false)).toBe('replace');
  expect(shortcutAction(ev({ ctrlKey: true }), 'find', false)).toBe(null);
  expect(shortcutAction(ev({}), 'find', false)).toBe('next');
  initPlatform('darwin');
  expect(shortcutAction(ev({ metaKey: true }), 'replace', false)).toBe('replaceAll');
  expect(shortcutAction(ev({ ctrlKey: true }), 'replace', false)).toBe(null);
});

test('connectors: Ctrl+[ goes back on Windows (⌘[ on macOS)', () => {
  initPlatform('win32');
  expect(isConnectorsBackKey({ key: '[', metaKey: false, ctrlKey: true, shiftKey: false, altKey: false })).toBe(true);
  expect(isConnectorsBackKey({ key: '[', metaKey: true, ctrlKey: false, shiftKey: false, altKey: false })).toBe(false);
  initPlatform('darwin');
  expect(isConnectorsBackKey({ key: '[', metaKey: true, ctrlKey: false, shiftKey: false, altKey: false })).toBe(true);
  expect(isConnectorsBackKey({ key: '[', metaKey: false, ctrlKey: true, shiftKey: false, altKey: false })).toBe(false);
});
