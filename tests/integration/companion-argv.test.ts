import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { posixRel } from '../support/platform';

// Ask is read-only by construction (Tests › Integration guards): the only argv of its
// `claude -p` is companionArgs()'s (src/shared/companion/args.ts, whose unit test pins every case and that no write tool
// is ever there). Here: nothing else in main builds one, the service hands the runner nothing but that argv, and the
// runner spawns nothing but what it was handed.

const root = join(__dirname, '..', '..');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(n) && !/\.test\.ts$/.test(n) ? [p] : [];
  });
}

/** Every match of `re` in main's sources (tests left out), as `file: line`. */
function uses(re: RegExp): string[] {
  return walk(join(root, 'src/main')).flatMap((f) => readFileSync(f, 'utf8').split('\n').flatMap((line, i) => (re.test(line) ? [`${posixRel(root, f)}:${i + 1}`] : [])));
}

const service = readFileSync(join(root, 'src/main/companion/service.ts'), 'utf8');
const run = readFileSync(join(root, 'src/main/companion/run.ts'), 'utf8');

test('companionArgs() is called once in main: the service\'s argsFor', () => {
  const calls = uses(/\bcompanionArgs\(/);
  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatch(/^src\/main\/companion\/service\.ts:/);
  expect(service).toMatch(/const argsFor = \(t: Thread\) => companionArgs\(\{/);
});

test('the argv\'s path forms follow the machine: the service hands companionArgs the running platform', () => {
  // Windows roots (C:\…) and the rules file's separator come from this one input;
  // rules.md names the root companionRoot gives --add-dir, with the same platform.
  expect(service).toMatch(/const platform = currentPlatform\(\);\n\s+const argsFor = \(t: Thread\) => companionArgs\(\{[^}]*\bplatform,/);
  expect(service).toMatch(/root = companionRoot\(projectRoot, platform\);/);
  expect(service).toMatch(/rulesText\(\{[^}]*project: root,/);
});

test('the runner is called once, by the service, with argsFor\'s argv and no other', () => {
  // Main wires the real runner in as the service's `run` dependency, and calls it nowhere else.
  expect(uses(/\brunCompanion\(/)).toEqual([expect.stringMatching(/^src\/main\/companion\/run\.ts:/)]);
  // Elsewhere only as a type (the service's dependency) and index.ts' import and wiring.
  const values = uses(/^(?!.*\b(type|typeof) runCompanion\b).*\brunCompanion\b/).filter((u) => !u.startsWith('src/main/companion/run.ts:'));
  expect(values).toEqual([expect.stringMatching(/^src\/main\/index\.ts:/), expect.stringMatching(/^src\/main\/index\.ts:/)]);
  expect(readFileSync(join(root, 'src/main/index.ts'), 'utf8')).toMatch(/\brun: runCompanion,/);
  // In the service: one call of its `run` dependency, its argv from argsFor.
  expect(service.match(/\bdeps\.run\(/g)).toHaveLength(1);
  expect(service).toMatch(/deps\.run\(\{\s*claudeBin, args: argsFor\(t\),/);
  expect(service.match(/\bargs:/g)).toHaveLength(1);
});

test('the runner spawns once, the binary it was handed with the argv it was handed', () => {
  expect(run.match(/\bspawn\(/g)).toHaveLength(1);
  expect(run).toMatch(/\bspawn\(o\.claudeBin, o\.args, \{/);
  // Nothing appended to or spliced into the argv on the way.
  expect(run).not.toMatch(/o\.args\s*(\.(push|unshift|splice|concat)\b|=[^=])/);
});
