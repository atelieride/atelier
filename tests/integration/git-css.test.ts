import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';

// git.css: every raw value comes through theme.css tokens; the drawer's keyframes live there.
const dir = join(__dirname, '../../src/renderer');
const git = readFileSync(join(dir, 'git/git.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const theme = readFileSync(join(dir, 'theme.css'), 'utf8');

test('git.css uses tokens only: no raw color, no keyframes of its own', () => {
  expect(git).not.toMatch(/rgba?\(|hsla?\(|#[0-9a-fA-F]{3,8}\b/);
  expect(git).not.toMatch(/@keyframes/);
});

test('theme.css has the drawer rise (from the bottom) next to the entrance the checkboxes use', () => {
  expect(theme).toMatch(/@keyframes atl-rise \{/);
  expect(theme).toMatch(/@keyframes atl-enter \{/);
});

test('git.css is loaded with the rest of the app', () => {
  expect(readFileSync(join(dir, 'styles.ts'), 'utf8')).toContain("import './git/git.css';");
});

test('the checkbox column enters with atl-enter and stays still with Reduce motion', () => {
  expect(git).toMatch(/\.git-check \{[^}]*animation: atl-enter var\(--t-med\)/);
  expect(git).toMatch(/:root\[data-motion="reduced"\] \.git-check[ ,][^{]*\{[^}]*animation: none/);
});
