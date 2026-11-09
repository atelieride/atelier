import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { posixRel } from '../support/platform';

// Test and development environment variables must not work in the packaged app: they are read only from dev-env.ts.
const mainDir = join(__dirname, '../../src/main');
const files = (d: string): string[] => readdirSync(d).flatMap((n) => {
  const p = join(d, n);
  return statSync(p).isDirectory() ? files(p) : p.endsWith('.ts') && !p.endsWith('.test.ts') ? [p] : [];
});

test('ATELIER_TEST_* and ELECTRON_RENDERER_URL go only through devEnv()', () => {
  const offenders = files(mainDir).filter((p) => !p.endsWith('dev-env.ts'))
    .filter((p) => /process\.env\.(ATELIER_TEST_\w+|ELECTRON_RENDERER_URL)|process\.env\[['"](ATELIER_TEST_|ELECTRON_RENDERER_URL)/.test(readFileSync(p, 'utf8')));
  expect(offenders.map((p) => posixRel(mainDir, p))).toEqual([]);
});
