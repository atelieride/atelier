// "Merged by you" against a real repository: past its base commit and reachable from its base
// (the remote-tracking ref, or the local branch of the same name), read-only.
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, toOut } from '../../src/main/cpath';
import { expect } from 'vitest';
import { branchMerged } from '../../src/main/automations/merged';
import { posixTest } from '../support/platform';
import { commit, git } from '../support/git-fixture';

const tmp = (p: string) => toOut(realpathSync(mkdtempSync(join(tmpdir(), p))));

// POSIX: sh fixtures.
posixTest('nothing done, not merged, merged locally, merged on the remote; a branch gone: not merged', async () => {
  const dir = tmp('atl-merged-');
  git(dir, 'init', '-q', '-b', 'main');
  const base = commit(dir, 'base', { 'a.ts': 'a\n' });
  git(dir, 'update-ref', 'refs/remotes/origin/main', base);
  git(dir, 'branch', 'auto/cu-1-x', base);
  const run = { branch: 'auto/cu-1-x', base: 'refs/remotes/origin/main', baseOid: base };

  expect(await branchMerged(dir, run)).toBe(false);
  git(dir, 'switch', '-q', 'auto/cu-1-x');
  commit(dir, 'fix', { 'a.ts': 'fixed\n' });
  git(dir, 'switch', '-q', 'main');
  expect(await branchMerged(dir, run)).toBe(false);

  git(dir, 'merge', '-q', '--no-ff', '-m', 'merge', 'auto/cu-1-x');
  expect(await branchMerged(dir, run)).toBe(true);

  git(dir, 'reset', '-q', '--hard', base);
  expect(await branchMerged(dir, run)).toBe(false);
  git(dir, 'update-ref', 'refs/remotes/origin/main', git(dir, 'rev-parse', 'auto/cu-1-x').trim());
  expect(await branchMerged(dir, run)).toBe(true);

  expect(await branchMerged(dir, { ...run, branch: 'auto/gone' })).toBe(false);
  expect(await branchMerged(join(dir, 'nope'), run)).toBe(false);
});
