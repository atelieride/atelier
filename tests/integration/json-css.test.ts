import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';

// JSON navigation's styles take every color from theme.css's tokens; nothing from a file
// reaches the DOM as HTML.
const css = readFileSync(join(__dirname, '../../src/renderer/json.css'), 'utf8');
const main = readFileSync(join(__dirname, '../../src/renderer/styles.ts'), 'utf8');

test('json.css is loaded and uses tokens only: no hex, rgb() or hsl() values', () => {
  expect(main).toContain("import './json.css';");
  const code = css.replace(/\/\*[\s\S]*?\*\//g, '');
  expect(code.match(/#[0-9a-fA-F]{3,8}\b/g) ?? []).toEqual([]);
  expect(code.match(/\b(rgba?|hsla?)\(/g) ?? []).toEqual([]);
});

test('the editor side (folding, error card) uses tokens too', () => {
  const ext = readFileSync(join(__dirname, '../../src/renderer/editor/json-ext.ts'), 'utf8');
  expect(ext.match(/#[0-9a-fA-F]{3,8}\b/g) ?? []).toEqual([]);
  expect(ext.match(/\b(rgba?|hsla?)\(/g) ?? []).toEqual([]);
});

test('no HTML string ever reaches the DOM from the JSON code', () => {
  const dir = join(__dirname, '../../src/renderer/json');
  const files = readdirSync(dir).filter((n) => /\.tsx?$/.test(n) && !n.includes('.test.')).map((n) => join(dir, n));
  files.push(join(__dirname, '../../src/renderer/editor/json-ext.ts'));
  expect(files.length).toBeGreaterThan(8);
  for (const f of files) expect(readFileSync(f, 'utf8'), f).not.toMatch(/innerHTML|dangerouslySetInnerHTML|outerHTML|insertAdjacentHTML/);
});
