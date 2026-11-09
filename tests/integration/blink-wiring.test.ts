import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';

// Settings reach the terminals before the store (adoptSettings), so the registry hands each
// terminal's blink controller the new value itself, and leaves cursorBlink out of the generic options loop.
test('the registry hands the new cursor setting itself to each terminal, not the store (still the old value then)', () => {
  const src = readFileSync(join(__dirname, '../../src/renderer/terminal/registry.ts'), 'utf8');
  expect(src).toMatch(/lt\.blink\.settingsChanged\(s\.cursorBlink\)/);
  expect(src).toMatch(/if \(k === 'cursorBlink'\) continue;/);
});
