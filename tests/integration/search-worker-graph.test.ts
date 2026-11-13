import { existsSync, readFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { dirname, join } from 'node:path';
import { expect, test } from 'vitest';
// @ts-expect-error: .mjs script without types
import { daemonReach } from '../../scripts/daemon-reach.mjs';

// Find in Files' worker (out/main/search-worker.js) runs as a plain Node worker thread, where Electron's API does not
// exist: nothing it imports may need it. Its graph is walked as atelierd's is (relative and @shared/ imports, `import
// type` left out) from the worker's entry. Every package the graph imports is listed here, so a new one is a decision.
const ENTRY = 'src/main/search/worker.ts';
const PACKAGES = ['@codemirror/state'];

// Imports with `from`, side-effect imports, dynamic imports and requires.
const IMPORT = /(?:^|\n)\s*(?:import|export)\s+(type\s+)?[^'"]*?from\s+['"]([^'"]+)['"]|(?:^|\n)\s*import\s+['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)|require\(\s*['"]([^'"]+)['"]\s*\)/g;

const isBuiltin = (s: string): boolean => s.startsWith('node:') || builtinModules.includes(s);

test('the search worker imports no Electron: only Node built-ins and the packages listed', () => {
  const files: string[] = daemonReach(process.cwd(), ENTRY);
  // The walk did reach the search itself: otherwise it proves nothing.
  expect(files).toEqual(expect.arrayContaining([ENTRY, 'src/main/search/run.ts', 'src/main/search/scan.ts', 'src/shared/search-match.ts']));
  const bare = new Set<string>();
  for (const f of files) {
    for (const m of readFileSync(f, 'utf8').matchAll(IMPORT)) {
      if (m[1]) continue;
      const spec = (m[2] ?? m[3] ?? m[4] ?? m[5])!;
      if (!spec.startsWith('.') && !spec.startsWith('@shared/')) bare.add(spec);
    }
  }
  expect([...bare].filter((s) => /electron/i.test(s))).toEqual([]);
  expect([...bare].filter((s) => !isBuiltin(s)).sort()).toEqual(PACKAGES);
});

const BUILT = 'out/main/search-worker.js';

test.skipIf(!existsSync(BUILT))('the built worker and the chunks it loads require no Electron', () => {
  const required = new Set<string>();
  const seen = new Set<string>();
  const visit = (file: string): void => {
    if (seen.has(file)) return;
    seen.add(file);
    for (const m of readFileSync(file, 'utf8').matchAll(/\brequire\((["'])([^"']+)\1\)/g)) {
      const spec = m[2]!;
      if (spec.startsWith('.')) visit(join(dirname(file), spec));
      else required.add(spec);
    }
  };
  visit(BUILT);
  expect([...required].filter((s) => /electron/i.test(s))).toEqual([]);
  expect([...required].filter((s) => !isBuiltin(s))).toEqual([]);
});
