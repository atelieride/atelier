import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';

// sync.css: the Sync split button and the git sheets, tokens only, loaded with the app.
const dir = join(__dirname, '../../src/renderer');
const css = readFileSync(join(dir, 'git/sync.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

test('sync.css uses tokens only: no raw color, no keyframes of its own', () => {
  expect(css).not.toMatch(/rgba?\(|hsla?\(|#[0-9a-fA-F]{3,8}\b/);
  expect(css).not.toMatch(/@keyframes/);
});

test('sync.css is loaded with the rest of the app', () => {
  expect(readFileSync(join(dir, 'styles.ts'), 'utf8')).toContain("import './git/sync.css';");
});

test('nothing loops here (a running op spins with the shared .git-spin); the entrances stay still with Reduce motion', () => {
  expect(css).not.toMatch(/\binfinite\b/);
  expect(css).toMatch(/:root\[data-motion="reduced"\] \.git-sync \{ animation: none/);
  expect(css).toMatch(/:root\[data-motion="reduced"\] :is\([^)]*\.git-sheet-commit[^)]*\) \{ animation: none/);
});
