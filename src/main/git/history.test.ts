import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, vi } from 'vitest';
import { commit, git } from '../../../tests/support/git-fixture';

// numstat fails (a timeout on a huge vendoring commit): the files --raw listed are still shown, without counts.
vi.mock('./exec', async (orig) => {
  const real = await orig<typeof import('./exec')>();
  return { ...real, runGit: (repo: string, args: string[], o?: object) => (args.includes('--numstat') ? Promise.reject(new Error('git diff: timeout')) : real.runGit(repo, args, o)) };
});

test('readCommit keeps the file list when the line counts fail', async () => {
  const { readCommit } = await import('./history');
  const repo = realpathSync(mkdtempSync(join(tmpdir(), 'atl-scm-num-')));
  git(repo, 'init', '-q', '-b', 'main');
  commit(repo, 'one', { 'a.txt': 'a\n' });
  const c = commit(repo, 'two', { 'a.txt': 'b\n', 'b.txt': 'b\n' });
  const d = await readCommit(repo, c, null, '4b825dc642cb6eb9a060e54bf8d69288fbee4904');
  expect(d.error).toBeUndefined();
  expect(d.files.map((f) => [f.rel, f.kind, f.added, f.removed])).toEqual([['a.txt', 'M', null, null], ['b.txt', 'A', null, null]]);
});
