import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';

// The Changes panel's notices list paths with no spaces (report-worker/src/services/chat/agent/prompt.ts):
// without a break anywhere they run past the card's border in a narrow sidebar.
const css = readFileSync(join(__dirname, '../../src/renderer/layout.css'), 'utf8');
const rule = (sel: string) => css.match(new RegExp(`^${sel.replace(/\./g, '\\.')} \\{([^}]*)\\}`, 'm'))?.[1] ?? '';

test('the violet notice breaks long paths inside the card', () => {
  expect(rule('.meet-body')).toMatch(/overflow-wrap: anywhere/);
});

test('the same-file notice: a chip never runs past the card, the hint gives way first', () => {
  expect(rule('.clash-chip')).toMatch(/max-width: 100%/);
  expect(rule('.clash-chip')).toMatch(/text-overflow: ellipsis/);
  expect(rule('.clash-check')).toMatch(/text-overflow: ellipsis/);
  expect(rule('.clash-check')).toMatch(/min-width: 0/);
  expect(rule('.clash-title')).toMatch(/min-width: 0/);
});

test('the same-file notice: its avatars and chips answer hover and keyboard focus', () => {
  expect(css).toMatch(/\.clash-avatar:hover/);
  expect(css).toMatch(/\.clash-avatar:focus-visible/);
  expect(css).toMatch(/\.clash-chip:hover/);
  expect(css).toMatch(/\.clash-chip:focus-visible/);
});

test('the "+N more" chip keeps a visible focus: its own focus rule comes after the rule that clears its ring', () => {
  const clears = css.indexOf('.clash-chip.is-more {');
  const focus = css.indexOf('.clash-chip.is-more:focus-visible');
  expect(clears).toBeGreaterThan(-1);
  expect(focus).toBeGreaterThan(clears);
  expect(rule('.clash-chip.is-more:focus-visible')).toMatch(/var\(--violet\)/);
});

test('an avatar\'s focus ring sits outside the avatar\'s own ring (the app\'s double ring)', () => {
  expect(rule('.clash-avatar:focus-visible')).toMatch(/0 0 0 2px var\(--bg-0\), 0 0 0 3\.5px var\(--violet\)/);
});

test('at the narrowest Changes the title gives way instead of running past the card: the hint first, then the count', () => {
  expect(rule('.clash-what')).toMatch(/text-overflow: ellipsis/);
  expect(rule('.clash-what')).toMatch(/min-width: 0/);
  // The hint takes only the room left over (basis 0): a shrink weight would still take a fraction of a pixel from the
  // count, and that fraction is enough for its ellipsis ("on the same 6 fil…" with the hint still shown).
  expect(rule('.clash-check')).toMatch(/flex: 1 1 0;/);
  expect(rule('.clash-check')).toMatch(/text-align: right/);
  expect(rule('.clash-what')).toMatch(/flex: 0 1 auto/);
});
