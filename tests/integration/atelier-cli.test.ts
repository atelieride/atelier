import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, expect, test } from 'vitest';

// The `atelier` shell command, run through the link the Install command makes, with a fake
// `open` that records its arguments.
const SCRIPT = join(__dirname, '../../assets/bin/atelier');

let base: string;
let app: string;
let link: string;
let log: string;
let fakeOpen: string;
let cwd: string;
beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'atl-cli-')));
  app = join(base, 'Apps', 'Atelier.app');
  const bin = join(app, 'Contents', 'Resources', 'bin');
  mkdirSync(bin, { recursive: true });
  log = join(base, 'open.log');
  fakeOpen = join(base, 'fake-open');
  writeFileSync(fakeOpen, `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a" >> '${log}'; done\n`);
  chmodSync(fakeOpen, 0o755);
  // The copy under test calls the fake instead of /usr/bin/open (the shipped script has no test hook).
  writeFileSync(join(bin, 'atelier'), readFileSync(SCRIPT, 'utf8').replaceAll('/usr/bin/open', fakeOpen));
  chmodSync(join(bin, 'atelier'), 0o755);
  mkdirSync(join(base, 'usr-local-bin'));
  link = join(base, 'usr-local-bin', 'atelier');
  symlinkSync(join(bin, 'atelier'), link);
  cwd = join(base, 'work');
  mkdirSync(join(cwd, 'src'), { recursive: true });
  writeFileSync(join(cwd, 'src', 'a.ts'), '');
  writeFileSync(join(cwd, '-dash.txt'), '');
});

const run = (...args: string[]) => spawnSync(link, args, { cwd, env: { PATH: '/usr/bin:/bin' }, encoding: 'utf8' });
const opened = () => readFileSync(log, 'utf8').trim().split('\n');

test('the shipped script is executable and has no test hook (test variables are inert in what ships)', () => {
  expect(readFileSync(SCRIPT, 'utf8')).not.toMatch(/ATELIER_TEST/);
  expect(execFileSync('/bin/test', ['-x', SCRIPT]).toString()).toBe('');
});

test('files and folders open in the app the link leads to, as absolute paths', () => {
  const r = run('src/a.ts', '.', join(cwd, 'src'));
  expect(r.status).toBe(0);
  expect(opened()).toEqual(['-a', app, join(cwd, 'src/a.ts'), join(cwd, '.'), join(cwd, 'src')]);
});

test('a name that starts with a dash is a file, not an option', () => {
  expect(run('-dash.txt').status).toBe(0);
  expect(opened()).toEqual(['-a', app, join(cwd, '-dash.txt')]);
});

test('no arguments: the app comes to the front', () => {
  expect(run().status).toBe(0);
  expect(opened()).toEqual(['-a', app]);
});

test('a missing file: an error, nothing opened', () => {
  const r = run('src/a.ts', 'nope.txt');
  expect(r.status).toBe(1);
  expect(r.stderr).toContain('atelier: no such file: nope.txt');
  expect(() => readFileSync(log)).toThrow();
});
