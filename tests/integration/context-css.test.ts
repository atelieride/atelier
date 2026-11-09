import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { posixRel } from '../support/platform';

// Context usage's sheet: its stylesheet loads with it, draws only with the theme's
// tokens, and its classes are its own — a class another stylesheet defines too (the context ring's .ctx-pct had
// opacity 0) silently restyles it.

const root = join(__dirname, '../../src/renderer');
const css = (f: string) => readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
function walk(dir: string, ext: RegExp): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name), ext) : ext.test(e.name) ? [join(dir, e.name)] : []));
}
/** The classes a stylesheet's selectors name (declarations left out). */
const classes = (code: string) => new Set([...code.replace(/\{[^{}]*\}/g, '{}').matchAll(/\.([a-zA-Z][\w-]*)/g)].map((m) => m[1]!));

const sheet = css(join(root, 'context.css'));

test('context.css is loaded by the sheet only, and colors only through the theme\'s tokens', () => {
  const importers = walk(root, /\.tsx?$/).filter((f) => /from ['"](\.\.?\/)+context\.css['"]|import ['"](\.\.?\/)+context\.css['"]/.test(readFileSync(f, 'utf8')));
  expect(importers.map((f) => posixRel(root, f))).toEqual(['components/ContextSheet.tsx']);
  expect(sheet).not.toMatch(/#[0-9A-Fa-f]{3,8}\b|\brgba?\(|\bhsla?\(/);
});

test('its classes are its own: no other stylesheet defines one of them', () => {
  const own = classes(sheet);
  expect(own.size).toBeGreaterThan(20);
  // The app's states and helpers it reuses on its own elements (is-on, mono…) are modifiers, not definitions to clash.
  const shared = new Set(['mono', 'grow', 'is-on', 'is-open', 'is-dim', 'is-sub', 'is-muted', 'is-live', 'is-quiet', 'is-since', 'is-buffer', 'is-done', 'is-now', 'is-wait', 'is-num', 'is-waiting', 'is-pending', 'is-note']);
  // layout.css names its spinner in the idle motion budget's rule (still while the window is inactive) on purpose.
  const named = new Set(['layout.css: .cxu-spin']);
  const clashes = walk(root, /\.css$/).filter((f) => !f.endsWith('context.css')).flatMap((f) => {
    const other = classes(css(f));
    return [...own].filter((c) => !shared.has(c) && other.has(c)).map((c) => `${posixRel(root, f)}: .${c}`);
  }).filter((x) => !named.has(x));
  expect(clashes).toEqual([]);
  expect([...own].filter((c) => !shared.has(c) && !c.startsWith('cxu-'))).toEqual([]);
});
