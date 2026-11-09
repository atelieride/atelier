// Worktrees in Changes (design "Working trees as repos"): which working trees a project
// shows and what each linked one has to merge, on real repositories.
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { expect, test, vi } from 'vitest';
import { posixTest } from '../support/platform';
import * as exec from '../../src/main/git/exec';
import { readMerge } from '../../src/main/git/compare';
import { discoverRepos, listWorkingTrees } from '../../src/main/git/repos';
import { readRepoStatus } from '../../src/main/git/service';
import { commit, git } from '../support/git-fixture';

function project(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'atl-wt-')));
  git(root, 'init', '-q', '-b', 'main');
  // Worktree folders ignored, as a project using them would have it: `git add -A` on main must not take them in.
  commit(root, 'first', { 'a.ts': '1\n', 'b.ts': '1\n', '.gitignore': '.claude/\n.worktrees/\n' });
  return root;
}

// POSIX: git prints C:/ worktree paths on Windows.
posixTest('working trees: the repos, hidden linked worktrees with worktreeOf, visible ones linked; outside and prunable ones skipped', async () => {
  const root = project();
  git(root, 'worktree', 'add', '-q', '-b', 'worktree-vad', join(root, '.claude', 'worktrees', 'vad'));
  git(root, 'worktree', 'add', '-q', '-b', 'vis', join(root, 'visible'));
  const outside = realpathSync(mkdtempSync(join(tmpdir(), 'atl-wt-out-')));
  git(root, 'worktree', 'add', '-q', '-b', 'far', join(outside, 'far'));
  git(root, 'worktree', 'add', '-q', '-b', 'gone', join(root, '.worktrees', 'gone'));
  rmSync(join(root, '.worktrees', 'gone'), { recursive: true, force: true });

  const trees = await listWorkingTrees(root, discoverRepos(root));
  expect(trees.map((t) => [relative(root, t.root), t.worktreeOf === null ? null : relative(root, t.worktreeOf), t.hidden])).toEqual([
    ['', null, false],
    ['.claude/worktrees/vad', '', true],
    ['visible', '', false]
  ]);
  expect(new Set(trees.map((t) => t.common))).toEqual(new Set([join(root, '.git')]));
});

// POSIX: git prints C:/ worktree paths on Windows.
posixTest('working trees: separate repos keep their own common dirs and no worktreeOf', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'atl-wt-multi-')));
  for (const name of ['api', 'web']) {
    git(root, 'init', '-q', '-b', 'main', name);
    commit(join(root, name), 'first', { 'x.ts': '1\n' });
  }
  const trees = await listWorkingTrees(root, discoverRepos(root));
  expect(trees.map((t) => [relative(root, t.root), t.worktreeOf, relative(root, t.common)])).toEqual([
    ['api', null, 'api/.git'], ['web', null, 'web/.git']
  ]);
});

test('merge summary: commits and files the branch adds since the default branch; null on the default branch', async () => {
  const root = project();
  const wt = join(root, '.claude', 'worktrees', 'vad');
  git(root, 'worktree', 'add', '-q', '-b', 'worktree-vad', wt);
  commit(wt, 'one', { 'a.ts': '2\n' });
  commit(wt, 'two', { 'c.ts': 'new\n' });
  // main moves on too: what main adds is not the branch's.
  commit(root, 'main', { 'b.ts': '2\n' });
  writeFileSync(join(wt, 'b.ts'), 'dirty\n');

  const merge = await readMerge(wt, await readRepoStatus(wt));
  expect(merge).toMatchObject({ base: 'main', commits: 2, files: ['a.ts', 'c.ts'], truncated: 0 });
  expect(await readMerge(root, await readRepoStatus(root))).toBeNull();
  // The fixture's commits on main never take the worktree in as an embedded repository.
  expect(git(root, 'ls-files').split('\n')).not.toContain('.claude/worktrees/vad');
});

test('merge summary: a branch squash-merged into main has nothing left to merge, though its commits are still "ahead"', async () => {
  const root = project();
  const wt = join(root, '.claude', 'worktrees', 'sq');
  git(root, 'worktree', 'add', '-q', '-b', 'worktree-sq', wt);
  commit(wt, 'one', { 'a.ts': '2\n' });
  commit(wt, 'two', { 'c.ts': 'new\n' });
  expect(await readMerge(wt, await readRepoStatus(wt))).toMatchObject({ commits: 2, files: ['a.ts', 'c.ts'], merged: false });
  // The same content lands on main as one commit (a squash merge on GitHub, then pulled).
  commit(root, 'squash', { 'a.ts': '2\n', 'c.ts': 'new\n' });
  expect(await readMerge(wt, await readRepoStatus(wt))).toMatchObject({ commits: 2, files: [], merged: true });
  // Main changes one of them again afterwards: that file is still the branch's to merge.
  commit(root, 'later', { 'c.ts': 'newer\n' });
  expect(await readMerge(wt, await readRepoStatus(wt))).toMatchObject({ files: ['c.ts'], merged: false });
});

// POSIX: git prints C:/ worktree paths on Windows.
posixTest('a failed worktree listing keeps the worktrees listed before (a git hiccup never hides them)', async () => {
  const root = project();
  const wt = join(root, '.claude', 'worktrees', 'vad');
  git(root, 'worktree', 'add', '-q', '-b', 'worktree-vad', wt);
  const before = await listWorkingTrees(root, discoverRepos(root));
  const realGit = exec.runGit;
  const failing = vi.spyOn(exec, 'runGit').mockImplementation((repo, args, ...rest) => (args[0] === 'worktree' ? Promise.reject(new Error('timeout')) : realGit(repo, args, ...rest)));
  try {
    expect((await listWorkingTrees(root, discoverRepos(root), before)).map((t) => t.root)).toEqual([root, wt]);
    expect((await listWorkingTrees(root, discoverRepos(root))).map((t) => t.root)).toEqual([root]);
  } finally {
    failing.mockRestore();
  }
});

// POSIX: git prints C:/ worktree paths on Windows.
posixTest('git not answering for the common dir: it is read from the files git reads (a linked worktree’s .git file), never <root>/.git', async () => {
  const main = project();
  const elsewhere = realpathSync(mkdtempSync(join(tmpdir(), 'atl-wt-out-')));
  const wt = join(elsewhere, 'omni');
  git(main, 'worktree', 'add', '-q', '-b', 'omni', wt);
  const realGit = exec.runGit;
  const failing = vi.spyOn(exec, 'runGit').mockImplementation((repo, args, ...rest) => (args[0] === 'rev-parse' ? Promise.reject(new Error('timeout')) : realGit(repo, args, ...rest)));
  try {
    const [tree] = await listWorkingTrees(wt, [wt]);
    expect(tree).toMatchObject({ root: wt, common: join(main, '.git'), gitDir: join(main, '.git', 'worktrees', 'omni') });
  } finally {
    failing.mockRestore();
  }
});
