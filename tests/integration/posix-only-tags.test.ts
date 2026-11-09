import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { posixRel } from '../support/platform';
import { POSIX_ONLY_FILES } from '../support/posix-only';

// The suite runs on Windows too: a test that runs a POSIX binary by its path, writes a
// #!/bin/sh fake or checks permission bits must say it needs POSIX — the whole file in tests/support/posix-only.ts,
// or its tests through posixOnly/posixTest/expectMode/isWin (tests/support/platform.ts). Otherwise it would only fail
// on the Windows CI job, long after the change that added it.

const root = join(__dirname, '..', '..');
const POSIX_USE = [
  { what: 'runs a POSIX binary by its path', re: /\b(?:execFileSync|execFile|spawnSync|spawn)\(\s*['"`]\/(?:usr\/)?(?:s?bin)\// },
  { what: 'writes a #! script', re: /['"`]#!\/(?:usr\/)?bin\/(?:env |sh|zsh|bash)/ },
  { what: 'checks permission bits', re: /\.mode & 0o7{3,4}\)/ }
];
// winOnly/winTest: written for Windows on purpose (a #!/bin/sh hook there is Git for Windows' sh's to run).
const TAGGED = /\bposixOnly\b|\bposixTest\b|\bexpectMode\(|\bisWin\b|\bisPosix\b|\.skipIf\(|\bwinOnly\b|\bwinTest\b/;

/**
 * Files whose match runs nothing on Windows, with why. A new entry needs the same care: when in doubt, tag the test.
 */
const UNTAGGED_OK: Record<string, string> = {
  'tests/integration/posix-only-tags.test.ts': 'this guard: the patterns are written here as text'
};

function testFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) { if (name !== 'node_modules') out.push(...testFiles(p)); } else if (name.endsWith('.test.ts')) out.push(p);
  }
  return out;
}

test('every test that needs POSIX says so (the Windows suite skips it on purpose, never by accident)', () => {
  const offenders: string[] = [];
  for (const f of [...testFiles(join(root, 'src')), ...testFiles(join(root, 'tests'))]) {
    const rel = posixRel(root, f);
    if (rel in POSIX_ONLY_FILES || rel in UNTAGGED_OK) continue;
    const src = readFileSync(f, 'utf8');
    const uses = POSIX_USE.filter((u) => u.re.test(src)).map((u) => u.what);
    if (uses.length && !TAGGED.test(src)) offenders.push(`${rel}: ${uses.join(', ')}`);
  }
  expect(offenders).toEqual([]);
});

test('the guard sees a POSIX use (each pattern on a sample)', () => {
  expect(POSIX_USE[0]!.re.test("execFileSync('/bin/ps', ['-A'])")).toBe(true);
  expect(POSIX_USE[1]!.re.test("writeFileSync(p, '#!/bin/sh\\nexit 0\\n')")).toBe(true);
  expect(POSIX_USE[2]!.re.test('expect(statSync(f).mode & 0o777).toBe(0o600)')).toBe(true);
  expect(TAGGED.test('posixTest(')).toBe(true);
});

test('every file in the POSIX-only list exists (a renamed test must not drop out of it silently)', () => {
  const missing = Object.keys(POSIX_ONLY_FILES).filter((rel) => { try { return !statSync(join(root, rel)).isFile(); } catch { return true; } });
  expect(missing).toEqual([]);
});
