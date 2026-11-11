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
  const { repos } = await discoverRepos(root, { depth: 2 });
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
  // The root is a repository: the others are inside it, except its linked worktrees (they are its own checkouts).
  expect(list.map((e) => [e.rel, e.nestedIn])).toEqual([['', null], ['.worktrees/v2.2', null], ['apps/web', root], ['visible', null]]);
});

// POSIX: git prints C:/ worktree paths on Windows.
posixTest('a repository inside another one is nested in the nearest one; linked worktrees never are', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'atl-scm-nested-')));
  const repo = (dir: string) => { mkdirSync(dir, { recursive: true }); git(dir, 'init', '-q', '-b', 'main'); commit(dir, 'first', { 'a.ts': '1\n', '.gitignore': '.claude/\n' }); };
  const hub = join(root, 'hub');
  repo(hub);
  repo(join(hub, 'guides'));
  repo(join(hub, 'guides', 'eu'));
  repo(join(root, 'api'));
  git(join(root, 'api'), 'worktree', 'add', '-q', '-b', 'worktree-x', join(root, 'api', '.claude', 'worktrees', 'x'));
  const { repos } = await discoverRepos(root, { depth: 3 });
  const list = await listScmRepos(root, repos);
  expect(list.map((e) => [e.rel, e.nestedIn])).toEqual([
    ['api', null],
    ['api/.claude/worktrees/x', null],
    ['hub', null],
    ['hub/guides', hub],
    ['hub/guides/eu', join(hub, 'guides')]
  ]);
});

test('a broken repo stays listed with its .git as common dir', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'atl-scm-broken-')));
  mkdirSync(join(root, 'x', '.git'), { recursive: true });
  const list = await listScmRepos(root, [join(root, 'x')]);
  expect(list).toEqual([{ root: join(root, 'x'), rel: 'x', name: 'x', worktreeOf: null, nestedIn: null, common: join(root, 'x', '.git'), status: null }]);
});
