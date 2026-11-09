import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { expect, test } from 'vitest';
import { posixRel } from '../support/platform';

// src/main/ipc-schemas.ts is shapes only: every IPC module and some shared tests (settings.test.ts) import it, so it
// must not drag file-system code along (a store, atelierd's fsutil, node:fs). Schemas it shares with a store live in a
// schema-only module (databases/connection-schema.ts), imported by both.

const root = resolve(__dirname, '..', '..');
/**
 * An import or re-export at a line's start — its clause (if any) holds no quote or `;`, so a side-effect import
 * (`import 'x'`) is matched as itself and never swallowed up to the next `from` — or a dynamic import().
 */
const IMPORT = /(?:^|\n)[ \t]*(?:import|export)\s+(type\s+)?(?:[^;'"`]*?\s+from\s+)?['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g;

/** The modules a source imports for their values (type-only imports are erased), in order. */
function importsOf(text: string): string[] {
  return [...text.matchAll(IMPORT)].filter((m) => !m[1]).map((m) => (m[2] ?? m[3])!);
}

/** The source files and packages reachable from `entry` through value imports (type-only imports are erased). */
function reach(entry: string): { files: string[]; packages: string[] } {
  const seen = new Set<string>();
  const packages = new Set<string>();
  const stack = [entry];
  while (stack.length) {
    const f = stack.pop()!;
    if (seen.has(f)) continue;
    seen.add(f);
    for (const from of importsOf(readFileSync(f, 'utf8'))) {
      const base = from.startsWith('@shared/') ? resolve(root, 'src/shared', from.slice('@shared/'.length)) : from.startsWith('.') ? resolve(dirname(f), from) : null;
      if (!base) { packages.add(from); continue; }
      const file = [base, `${base}.ts`, join(base, 'index.ts')].find((c) => existsSync(c) && statSync(c).isFile());
      if (file) stack.push(file);
    }
  }
  return { files: [...seen].map((f) => posixRel(root, f)).sort(), packages: [...packages].sort() };
}

test('ipc-schemas reaches zod and pure modules only: no Node module, no store, no atelierd code', () => {
  const { files, packages } = reach(resolve(root, 'src/main/ipc-schemas.ts'));
  expect(packages).toEqual(['zod']);
  expect(files.filter((f) => f.startsWith('src/daemon/') || /\/store\.ts$/.test(f))).toEqual([]);
  // The walk does follow imports.
  expect(files).toEqual(expect.arrayContaining(['src/main/path-schemas.ts', 'src/shared/databases-filters.ts']));
});

test('the import scan sees every kind of value import, a side-effect one included, and never swallows one into the next', () => {
  const src = [
    "import { z } from 'zod';",
    "import 'node:fs';",
    'import "./polyfill";',
    "import type { X } from './types';",
    "import {\n  a,\n  b\n} from './multi';",
    "export const NAME = 'not an import';",
    "export * from './again';",
    "const lazy = import('./later');",
    "import def, { c } from './both'"
  ].join('\n');
  expect(importsOf(src)).toEqual(['zod', 'node:fs', './polyfill', './multi', './again', './later', './both']);
});
