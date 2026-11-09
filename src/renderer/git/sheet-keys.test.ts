import { expect, test } from 'vitest';
import { ENTER_GRACE_MS, swallowEnter, trapTab, typedText } from './sheet-keys';

// The git sheets' keys: an Enter that was meant for what came before never answers a sheet that
// just appeared, and Tab stays inside the sheet.

test('an Enter held down, or pressed as the sheet appears, is not an answer; later ones are', () => {
  const at = 1000;
  expect(swallowEnter({ key: 'Enter', repeat: false }, at, at)).toBe(true);
  expect(swallowEnter({ key: 'Enter', repeat: false }, at, at + ENTER_GRACE_MS - 1)).toBe(true);
  expect(swallowEnter({ key: 'Enter', repeat: true }, at, at + 5000)).toBe(true);
  expect(swallowEnter({ key: 'Enter', repeat: false }, at, at + ENTER_GRACE_MS)).toBe(false);
  expect(swallowEnter({ key: 'Escape', repeat: false }, at, at)).toBe(false);
  // ⌘↵ is a chord pressed on purpose (Discard's): only held down is it swallowed.
  expect(swallowEnter({ key: 'Enter', repeat: false, metaKey: true }, at, at)).toBe(false);
  expect(swallowEnter({ key: 'Enter', repeat: true, metaKey: true }, at, at + 5000)).toBe(true);
  expect(swallowEnter({ key: ' ', repeat: true }, at, at)).toBe(false);
});

test('an Enter after text typed in the sheet is its answer, however soon (a URL put in the field, then Enter); held down, still not', () => {
  // Add Connection's URL field: filled and Enter right as the sheet appeared stayed on step 1 (the e2e under load: React
  // reveals the lazy sheet 300 ms late, Playwright's fill finds it at once).
  const at = 1000;
  expect(swallowEnter({ key: 'Enter', repeat: false }, at, at + 10, true)).toBe(false);
  expect(swallowEnter({ key: 'Enter', repeat: false }, at, at + 10, false)).toBe(true);
  expect(swallowEnter({ key: 'Enter', repeat: true }, at, at + 10, true)).toBe(true);
  expect(swallowEnter({ key: 'Enter', repeat: true }, at, at + 5000, true)).toBe(true);
});

test('typed in the sheet: text put in a field (typing, a paste, a deletion, dictation); a checkbox toggled is not (no inputType)', () => {
  expect(typedText({ inputType: 'insertText' })).toBe(true);
  expect(typedText({ inputType: 'insertFromPaste' })).toBe(true);
  expect(typedText({ inputType: 'deleteContentBackward' })).toBe(true);
  // A checkbox's input event is a plain Event: a Space under a typing hand keeps the grace.
  expect(typedText({})).toBe(false);
  expect(typedText({ inputType: '' })).toBe(false);
});

test('Tab cycles inside the sheet: past the last back to the first, Shift+Tab before the first to the last', () => {
  expect(trapTab(3, 2, false)).toBe(0);
  expect(trapTab(3, 0, true)).toBe(2);
  // Focus on the sheet itself (not one of its controls): the first, or the last going back.
  expect(trapTab(3, -1, false)).toBe(0);
  expect(trapTab(3, -1, true)).toBe(2);
  // In between: the browser moves it.
  expect(trapTab(3, 1, false)).toBeNull();
  expect(trapTab(3, 1, true)).toBeNull();
  expect(trapTab(0, -1, false)).toBeNull();
});
