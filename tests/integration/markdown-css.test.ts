import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';

// The Markdown preview's styles take every color from theme.css's tokens.
const css = readFileSync(join(__dirname, '../../src/renderer/markdown.css'), 'utf8');
const main = readFileSync(join(__dirname, '../../src/renderer/styles.ts'), 'utf8');

test('markdown.css is loaded and uses tokens only: no hex, rgb() or hsl() values', () => {
  expect(main).toContain("import './markdown.css';");
  const code = css.replace(/\/\*[\s\S]*?\*\//g, '');
  expect(code.match(/#[0-9a-fA-F]{3,8}\b/g) ?? []).toEqual([]);
  expect(code.match(/\b(rgba?|hsla?)\(/g) ?? []).toEqual([]);
});

test('scrollbars keep the app style where two meet (Split: the editor scrolls both ways): no white corner', () => {
  const theme = readFileSync(join(__dirname, '../../src/renderer/theme.css'), 'utf8');
  expect(theme).toMatch(/::-webkit-scrollbar-corner\s*\{[^}]*background:\s*transparent/);
});

test('find matches in the preview are painted with the find tokens; the chosen view uses the brand segment', () => {
  expect(css).toMatch(/::highlight\(md-find\)\s*\{[^}]*var\(--hit-bg\)/);
  expect(css).toMatch(/::highlight\(md-find-current\)\s*\{[^}]*var\(--hit-strong\)/);
  expect(css).toMatch(/\.md-switch button\.is-on\s*\{[^}]*var\(--seg-on\)/);
});

test('no HTML string ever reaches the DOM from the preview code (Security)', () => {
  const dir = join(__dirname, '../../src/renderer/markdown');
  const files = readdirSync(dir).filter((n) => /\.tsx?$/.test(n) && !n.includes('.test.'));
  expect(files.length).toBeGreaterThan(5);
  for (const f of files) expect(readFileSync(join(dir, f), 'utf8'), f).not.toMatch(/innerHTML|dangerouslySetInnerHTML|outerHTML|insertAdjacentHTML/);
});
