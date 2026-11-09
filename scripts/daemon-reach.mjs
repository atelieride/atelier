// The source modules atelierd bundles: an import walk from src/daemon/index.ts over relative and @shared/ imports
// (`import type` skipped, as the bundler drops it). Any byte change in what atelierd bundles changes its fingerprint and
// asks every user to restart it (closing their sessions), so work that must not touch atelierd checks this list first.
// tests/integration/daemon-reach.test.ts pins it. Node built-ins only.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const IMPORT = /(?:^|\n)\s*(?:import|export)\s+(type\s+)?[^'"]*?from\s+['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)|require\(\s*['"]([^'"]+)['"]\s*\)/g;

function resolveSpec(root, from, spec) {
  const base = spec.startsWith('@shared/') ? resolve(root, 'src/shared', spec.slice('@shared/'.length)) : resolve(dirname(from), spec);
  for (const c of [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`]) if (/\.tsx?$/.test(c) && existsSync(c)) return c;
  return null;
}

/** Repo-relative paths ('/'-separated, sorted) of every module reachable from `entry`. */
export function daemonReach(root, entry = 'src/daemon/index.ts') {
  const seen = new Set();
  const visit = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    for (const m of readFileSync(file, 'utf8').matchAll(IMPORT)) {
      if (m[1]) continue; // import type / export type
      const spec = m[2] ?? m[3] ?? m[4];
      if (!spec.startsWith('.') && !spec.startsWith('@shared/')) continue;
      const next = resolveSpec(root, file, spec);
      if (next) visit(next);
    }
  };
  visit(resolve(root, entry));
  return [...seen].map((f) => relative(root, f).split('\\').join('/')).sort();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) console.log(daemonReach(process.cwd()).join('\n'));
