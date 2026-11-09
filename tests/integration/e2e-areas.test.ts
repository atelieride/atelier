// The areas map (tests/e2e/areas.ts) keeps up with the specs and the source. A new
// spec or source file fails here until it gets its line, instead of quietly running the whole suite every time.
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { expect, test } from 'vitest';
import * as map from '../e2e/areas';
// @ts-expect-error: .mjs script without types
import { classify } from '../../scripts/e2e-select.mjs';

const root = resolve(__dirname, '../..');
const e2eDir = join(root, 'tests/e2e');
const specs = readdirSync(e2eDir).filter((n) => n.endsWith('.spec.ts')).sort();
const tracked = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean);
const isSource = (p: string) => /^src\/(renderer|main|shared|preload)\//.test(p) && !/\.test\.tsx?$/.test(p);

test('every spec is in SPECS and every SPECS entry is a spec', () => {
  expect(Object.keys(map.SPECS).sort()).toEqual(specs);
});

test('SPECS and SOURCES name only known areas, and every area has a spec', () => {
  const known = new Set<string>(map.AREAS);
  const named = [...Object.values(map.SPECS), ...Object.values(map.SOURCES), map.CSS_AREAS, map.PKG_AREAS].flat();
  expect(named.filter((a) => !known.has(a))).toEqual([]);
  const covered = new Set(Object.values(map.SPECS).flat());
  expect(map.AREAS.filter((a) => !covered.has(a))).toEqual([]);
});

test('SMOKE specs exist', () => {
  expect(map.SMOKE.filter((s) => !specs.includes(s))).toEqual([]);
});

test('every source file under src/renderer, main, shared and preload has a rule (add it to tests/e2e/areas.ts)', () => {
  const unmapped = tracked.filter(isSource).filter((p) => classify(p, map).kind === 'unmapped');
  expect(unmapped).toEqual([]);
});

test('every rule matches at least one tracked file (no stale entries)', () => {
  const rules = [...map.FOUNDATIONS, ...map.WIRING, ...map.CSS, ...map.IGNORED, ...Object.keys(map.SOURCES), ...map.HUBS, ...map.STRICT_WIRING];
  expect(rules.filter((r) => !tracked.some((p) => p.startsWith(r)))).toEqual([]);
  expect(map.STRICT_WIRING.filter((r) => classify(r, map).kind !== 'wiring')).toEqual([]);
});

test('no rule shadows another of the same length (one rule per prefix)', () => {
  const rules = [...map.FOUNDATIONS, ...map.WIRING, ...map.CSS, ...map.IGNORED, ...Object.keys(map.SOURCES)];
  expect(rules.filter((r, i) => rules.indexOf(r) !== i)).toEqual([]);
});

// What features edit additively doesn't run the whole suite (the replay of 31 merges: 15 did).
test('stylesheets load from styles.ts (CSS), not from main.tsx (a foundation)', () => {
  expect(classify('src/renderer/styles.ts', map).kind).toBe('css');
  expect(classify('src/renderer/main.tsx', map).kind).toBe('foundation');
  expect(readFileSync(join(root, 'src/renderer/main.tsx'), 'utf8')).not.toMatch(/import\s+'[^']+\.css'/);
});

test('windows.ts maps to workspace, env.ts is wiring', () => {
  expect(classify('src/main/windows.ts', map)).toEqual({ kind: 'areas', areas: ['workspace'] });
  expect(classify('tests/e2e/env.ts', map).kind).toBe('wiring');
});

// A committed .only would make every "full" run a partial one (and the full-green stamp a lie).
test('no spec commits a test.only or describe.only', () => {
  const offenders = specs.filter((s) => /\b(test|describe)(\.describe)?\.only\(/.test(readFileSync(join(e2eDir, s), 'utf8')));
  expect(offenders).toEqual([]);
});
