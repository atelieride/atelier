import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { expect, test } from 'vitest';
import { posixTest } from '../support/platform';
import { discoverRepos } from '../../src/main/git/repos';
import { listScmRepos } from '../../src/main/git/scm-repos';
import { commit, git, historyRepo } from '../support/git-fixture';

// POSIX: git prints C:/ worktree paths on Windows.
posixTest('switcher entries: the repos, then each one\'s linked worktrees hidden in the project; common dirs', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'atl-scm-proj-')));
  historyRepo(root);
  const web = join(root, 'apps', 'web');
  mkdirSync(web, { recursive: true });
  git(web, 'init', '-q', '-b', 'main');
  commit(web, 'first', { 'i.ts': '1\n' });
  git(root, 'worktree', 'add', '-q', '-b', 'v2.2-integrate', join(root, '.worktrees', 'v2.2'));
  const outside = realpathSync(mkdtempSync(join(tmpdir(), 'atl-scm-out-')));
  git(root, 'worktree', 'add', '-q', '-b', 'far', join(outside, 'far'));
  // A linked worktree in a visible folder is a discovered repo already: listed once.
  git(root, 'worktree', 'add', '-q', '-b', 'vis', join(root, 'visible'));
  const repos = discoverRepos(root);
  const list = await listScmRepos(root, repos);
  expect(list.map((e) => [e.rel, e.name, e.worktreeOf])).toEqual([
    ['', basename(root), null],
    ['.worktrees/v2.2', 'v2.2', root],
    ['apps/web', 'web', null],
    ['visible', 'visible', null]
  ]);
  expect(list[0]!.common).toBe(join(root, '.git'));
  expect(list[1]!.common).toBe(join(root, '.git'));
  expect(list[2]!.common).toBe(join(web, '.git'));
  expect(list[3]!.common).toBe(join(root, '.git'));
  expect(list.every((e) => e.status === null)).toBe(true);
});

test('a broken repo stays listed with its .git as common dir', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'atl-scm-broken-')));
  mkdirSync(join(root, 'x', '.git'), { recursive: true });
  const list = await listScmRepos(root, [join(root, 'x')]);
  expect(list).toEqual([{ root: join(root, 'x'), rel: 'x', name: 'x', worktreeOf: null, common: join(root, 'x', '.git'), status: null }]);
});
