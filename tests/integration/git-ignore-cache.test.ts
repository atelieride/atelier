import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { posixTest } from '../support/platform';
import { runGit } from '../../src/main/git/exec';
import { IgnoreCache, LS_IGNORED_ARGS } from '../../src/main/git/ignore-cache';

// An ignored folder is skipped; a folder that only holds ignored files is not.
// POSIX: /usr/bin/git.
posixTest('real git: out/ (ignored) is skipped, logs/ (only *.log inside) is not, a .log file is', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'atl-ign-'));
  execFileSync('/usr/bin/git', ['init', '-q', dir]);
  writeFileSync(join(dir, '.gitignore'), '*.log\nout/\n');
  mkdirSync(join(dir, 'logs')); writeFileSync(join(dir, 'logs', 'app.log'), 'a\n');
  mkdirSync(join(dir, 'out')); writeFileSync(join(dir, 'out', 'x.js'), 'b\n');
  writeFileSync(join(dir, 'keep.ts'), 'c\n');
  const c = new IgnoreCache((repo) => runGit(repo, LS_IGNORED_ARGS));
  await c.refresh(dir);
  expect(c.ignored(dir, 'out/x.js')).toBe(true);
  expect(c.ignored(dir, 'out/new.js')).toBe(true);
  expect(c.ignored(dir, 'logs/app.log')).toBe(true);
  expect(c.ignored(dir, 'logs/notes.md')).toBe(false);
  expect(c.ignored(dir, 'keep.ts')).toBe(false);
});
