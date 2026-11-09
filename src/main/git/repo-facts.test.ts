// Integration tests on real repositories in the run's temp root.
import { execFileSync } from 'node:child_process';
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { posixTest } from '../../../tests/support/platform';
import { commit, git, historyRepo } from '../../../tests/support/git-fixture';
import { githubRepoBase, githubRepoOf, incomingPaths, readRepoFacts, remoteCommits, stashFiles, unmergedCommits, upstreamOf } from './repo-facts';

// runGit drops every inherited GIT_* variable (GIT_CONFIG_GLOBAL included), so the global config it reads is
// $HOME/.gitconfig: point HOME (and XDG_CONFIG_HOME) at an empty folder, never the user's identity or signing.
const saved = { HOME: process.env.HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME };
beforeAll(() => {
  const home = mkdtempSync(join(tmpdir(), 'atl-facts-home-'));
  process.env.HOME = home;
  process.env.XDG_CONFIG_HOME = join(home, '.config');
});
afterAll(() => {
  for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
});

const tmp = () => mkdtempSync(join(tmpdir(), 'atl-facts-'));

function repo(): string {
  const dir = tmp();
  git(dir, 'init', '-q', '-b', 'main');
  return dir;
}

/** git that is allowed to fail (conflicts), returning nothing. */
function gitMay(cwd: string, ...a: string[]): void {
  try { git(cwd, ...a); } catch { /* the conflict is the point */ }
}

/** A bare remote and two clones of it, `a` and `b`, both on main with one pushed commit. */
function remotePair(): { bare: string; a: string; b: string } {
  const base = tmp();
  const bare = join(base, 'remote.git');
  git(base, 'init', '-q', '--bare', '-b', 'main', bare);
  const a = join(base, 'a');
  git(base, 'clone', '-q', bare, a);
  commit(a, 'chore: start', { 'x.ts': 'x\n', 'keep.ts': 'k\n' });
  git(a, 'push', '-q', '-u', 'origin', 'main');
  const b = join(base, 'b');
  git(base, 'clone', '-q', bare, b);
  return { bare, a, b };
}

describe('readRepoFacts', () => {
  test('a fresh repo on main: root commit, no upstream, nothing in progress, the message for amend', async () => {
    const dir = repo();
    const oid = commit(dir, 'feat: first\n\nA body line.\n#123 stays.', { 'a.ts': 'a\n' });
    const f = await readRepoFacts(dir);
    expect(f).toMatchObject({ state: null, detached: false, branch: 'main', head: oid, upstream: null, headPushed: false, headIsMerge: false, headHasParent: false });
    expect(f.headMessage).toBe('feat: first\n\nA body line.\n#123 stays.');
  });

  test('a second commit has a parent; a merge commit is a merge', async () => {
    const dir = repo();
    commit(dir, 'one', { 'a.ts': 'a\n' });
    commit(dir, 'two', { 'a.ts': 'b\n' });
    expect(await readRepoFacts(dir)).toMatchObject({ headHasParent: true, headIsMerge: false });
    const merged = tmp();
    historyRepo(merged);
    expect(await readRepoFacts(merged)).toMatchObject({ headHasParent: true, headIsMerge: true, branch: 'main' });
  });

  test('an unborn branch: no HEAD, its name from HEAD, no message', async () => {
    const dir = repo();
    git(dir, 'checkout', '-q', '-b', 'start');
    const f = await readRepoFacts(dir);
    expect(f).toMatchObject({ head: null, branch: 'start', detached: false, headHasParent: false, headIsMerge: false, headMessage: null, headPushed: false });
  });

  test('identity: both user.name and user.email (any scope), never one alone', async () => {
    const dir = repo();
    commit(dir, 'one', { 'a.ts': 'a\n' });
    expect((await readRepoFacts(dir)).identity).toBe(false);
    git(dir, 'config', 'user.name', 'Ada');
    expect((await readRepoFacts(dir)).identity).toBe(false);
    git(dir, 'config', 'user.email', 'ada@example.com');
    expect((await readRepoFacts(dir)).identity).toBe(true);
    // The global config counts too (identity usually lives there): the fake HOME's, read once tests stop isolating git.
    const other = repo();
    writeFileSync(join(process.env.HOME!, '.gitconfig'), '[user]\n\tname = Global\n\temail = g@example.com\n');
    const isolated = process.env.ATELIER_TEST_GIT_ISOLATED;
    delete process.env.ATELIER_TEST_GIT_ISOLATED;
    try {
      expect((await readRepoFacts(other)).identity).toBe(true);
    } finally {
      if (isolated !== undefined) process.env.ATELIER_TEST_GIT_ISOLATED = isolated;
      writeFileSync(join(process.env.HOME!, '.gitconfig'), '');
    }
  });

  test('signing: commit.gpgsign (git booleans) and the program for gpg.format', async () => {
    const dir = repo();
    commit(dir, 'one', { 'a.ts': 'a\n' });
    expect(await readRepoFacts(dir)).toMatchObject({ signs: false, gpgProgram: null });
    git(dir, 'config', 'commit.gpgsign', 'yes');
    git(dir, 'config', 'gpg.program', '/opt/fake/gpg');
    expect(await readRepoFacts(dir)).toMatchObject({ signs: true, gpgProgram: '/opt/fake/gpg' });
    git(dir, 'config', 'gpg.format', 'ssh');
    expect(await readRepoFacts(dir)).toMatchObject({ signs: true, gpgProgram: null });
    git(dir, 'config', 'gpg.ssh.program', '/Applications/1Password.app/Contents/MacOS/op-ssh-sign');
    expect((await readRepoFacts(dir)).gpgProgram).toBe('/Applications/1Password.app/Contents/MacOS/op-ssh-sign');
    git(dir, 'config', 'gpg.format', 'x509');
    git(dir, 'config', 'gpg.x509.program', '/opt/fake/gpgsm');
    expect((await readRepoFacts(dir)).gpgProgram).toBe('/opt/fake/gpgsm');
    git(dir, 'config', 'commit.gpgsign', 'false');
    expect((await readRepoFacts(dir)).signs).toBe(false);
    // `[commit] gpgsign` with no value is true for git.
    git(dir, 'config', '--unset', 'commit.gpgsign');
    appendFileSync(join(dir, '.git', 'config'), '[commit]\n\tgpgsign\n');
    expect((await readRepoFacts(dir)).signs).toBe(true);
  });

  test('git version, as git reports it', async () => {
    const dir = repo();
    const m = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(execFileSync('git', ['version'], { encoding: 'utf8' }))!;
    expect((await readRepoFacts(dir)).gitVersion).toEqual([Number(m[1]), Number(m[2]), Number(m[3] ?? 0)]);
  });

  test('detached HEAD: no branch', async () => {
    const dir = repo();
    const oid = commit(dir, 'one', { 'a.ts': 'a\n' });
    commit(dir, 'two', { 'a.ts': 'b\n' });
    git(dir, 'checkout', '-q', '--detach', oid);
    expect(await readRepoFacts(dir)).toMatchObject({ detached: true, branch: null, head: oid, state: null });
  });

  test('mid-merge, mid-rebase, mid-cherry-pick, mid-revert', async () => {
    const conflicted = () => {
      const dir = repo();
      commit(dir, 'base', { 'a.ts': 'base\n' });
      git(dir, 'checkout', '-q', '-b', 'other');
      commit(dir, 'other', { 'a.ts': 'other\n' });
      git(dir, 'checkout', '-q', 'main');
      commit(dir, 'mine', { 'a.ts': 'mine\n' });
      return dir;
    };
    const merging = conflicted();
    gitMay(merging, 'merge', '-q', 'other');
    expect(await readRepoFacts(merging)).toMatchObject({ state: 'merge', branch: 'main', detached: false });

    const rebasing = conflicted();
    gitMay(rebasing, 'rebase', '-q', 'other');
    expect(await readRepoFacts(rebasing)).toMatchObject({ state: 'rebase', detached: true, branch: null });

    const picking = conflicted();
    gitMay(picking, 'cherry-pick', 'other');
    expect((await readRepoFacts(picking)).state).toBe('cherry-pick');

    const reverting = repo();
    commit(reverting, 'one', { 'a.ts': 'one\n' });
    commit(reverting, 'two', { 'a.ts': 'two\n' });
    commit(reverting, 'three', { 'a.ts': 'three\n' });
    gitMay(reverting, 'revert', '--no-edit', 'HEAD~1');
    expect((await readRepoFacts(reverting)).state).toBe('revert');
  });

  test('a linked worktree has its own state and branch, and the shared hooks', async () => {
    const dir = repo();
    commit(dir, 'one', { 'a.ts': 'a\n' });
    const wt = join(tmp(), 'wt');
    git(dir, 'worktree', 'add', '-q', '-b', 'side', wt);
    writeFileSync(join(dir, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\nexit 0\n');
    chmodSync(join(dir, '.git', 'hooks', 'pre-commit'), 0o755);
    writeFileSync(join(dir, '.git', 'MERGE_HEAD'), git(dir, 'rev-parse', 'HEAD'));
    expect((await readRepoFacts(dir)).state).toBe('merge');
    expect(await readRepoFacts(wt)).toMatchObject({ state: null, branch: 'side', hooks: { preCommit: true, commitMsg: false, prePush: false } });
  });

  test('headPushed: HEAD reachable from its upstream', async () => {
    const { a } = remotePair();
    expect(await readRepoFacts(a)).toMatchObject({ upstream: 'origin/main', headPushed: true });
    commit(a, 'local', { 'x.ts': 'local\n' });
    expect(await readRepoFacts(a)).toMatchObject({ upstream: 'origin/main', headPushed: false });
    git(a, 'push', '-q');
    expect((await readRepoFacts(a)).headPushed).toBe(true);
    // No upstream, but HEAD is on a remote-tracking branch (main's): already shared, so pushed.
    git(a, 'checkout', '-q', '-b', 'topic');
    expect(await readRepoFacts(a)).toMatchObject({ upstream: null, headPushed: true, branch: 'topic' });
    commit(a, 'topic', { 't.ts': 't\n' });
    expect(await readRepoFacts(a)).toMatchObject({ upstream: null, headPushed: false });
    // Pushed under another name, still no upstream: any remote-tracking ref that reaches HEAD counts.
    git(a, 'push', '-q', 'origin', 'topic:elsewhere');
    expect(await readRepoFacts(a)).toMatchObject({ upstream: null, headPushed: true });
    // With an upstream that doesn't have it, another remote branch that does still counts.
    commit(a, 'topic 2', { 't.ts': 't2\n' });
    git(a, 'push', '-q', '-u', 'origin', 'topic');
    commit(a, 'topic 3', { 't.ts': 't3\n' });
    git(a, 'push', '-q', 'origin', 'topic:mirror');
    expect(await readRepoFacts(a)).toMatchObject({ upstream: 'origin/topic', headPushed: true });
  });

  describe('hooks', () => {
    const hook = (dir: string, name: string, mode = 0o755) => {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, name), '#!/bin/sh\nexit 0\n');
      chmodSync(join(dir, name), mode);
    };

    test('none: git init leaves only samples, which never count', async () => {
      const dir = repo();
      hook(join(dir, '.git', 'hooks'), 'pre-push.sample');
      hook(join(dir, '.git', 'hooks'), 'pre-commit.sample');
      expect((await readRepoFacts(dir)).hooks).toEqual({ preCommit: false, commitMsg: false, prePush: false });
    });

    // POSIX: the executable bit.
    posixTest('present and executable count; a file that is not executable does not', async () => {
      const dir = repo();
      hook(join(dir, '.git', 'hooks'), 'pre-commit');
      hook(join(dir, '.git', 'hooks'), 'commit-msg', 0o644);
      hook(join(dir, '.git', 'hooks'), 'pre-push');
      expect((await readRepoFacts(dir)).hooks).toEqual({ preCommit: true, commitMsg: false, prePush: true });
    });

    test('core.hooksPath (relative to the work tree, like husky) replaces .git/hooks', async () => {
      const dir = repo();
      hook(join(dir, '.git', 'hooks'), 'pre-commit');
      hook(join(dir, '.husky', '_'), 'commit-msg');
      git(dir, 'config', 'core.hooksPath', '.husky/_');
      expect((await readRepoFacts(dir)).hooks).toEqual({ preCommit: false, commitMsg: true, prePush: false });
      const abs = join(tmp(), 'hooks');
      hook(abs, 'pre-push');
      git(dir, 'config', 'core.hooksPath', abs);
      expect((await readRepoFacts(dir)).hooks).toEqual({ preCommit: false, commitMsg: false, prePush: true });
    });
  });
});

describe('incomingPaths and remoteCommits', () => {
  test('what a pull would bring: paths (both sides of a rename) and the commits, newest first, limited', async () => {
    const { a, b } = remotePair();
    expect(await incomingPaths(a)).toEqual([]);
    expect(await remoteCommits(a, 3)).toEqual([]);
    const c1 = commit(b, 'feat: one', { 'x.ts': 'x2\n' });
    git(b, 'mv', 'keep.ts', 'kept.ts');
    const c2 = commit(b, 'refactor: rename keep', {});
    const c3 = commit(b, 'feat: three', { 'new dir/y è.ts': 'y\n' });
    git(b, 'push', '-q');
    // Not fetched yet: nothing is known.
    expect(await incomingPaths(a)).toEqual([]);
    git(a, 'fetch', '-q');
    // A local commit on another file is not incoming (three dots: since the merge base).
    commit(a, 'local', { 'local.ts': 'l\n' });
    expect((await incomingPaths(a)).sort()).toEqual(['keep.ts', 'kept.ts', 'new dir/y è.ts', 'x.ts']);
    expect(await remoteCommits(a, 2)).toEqual([
      { oid: c3, subject: 'feat: three', author: 'Ada' },
      { oid: c2, subject: 'refactor: rename keep', author: 'Ada' }
    ]);
    expect((await remoteCommits(a, 10)).map((c) => c.oid)).toEqual([c3, c2, c1]);
  });

  test('no upstream: nothing incoming', async () => {
    const dir = repo();
    commit(dir, 'one', { 'a.ts': 'a\n' });
    expect(await incomingPaths(dir)).toEqual([]);
    expect(await remoteCommits(dir, 3)).toEqual([]);
  });
});

describe('GitHub compare base (Publish\'s "Open a pull request"): never a raw URL', () => {
  test('https, scp-like ssh and ssh:// forms of github.com, with or without .git; credentials never kept', () => {
    const want = 'https://github.com/acme/store';
    for (const url of ['https://github.com/acme/store.git', 'https://github.com/acme/store', 'https://github.com/acme/store/', 'git@github.com:acme/store.git',
      'git@github.com:acme/store', 'ssh://git@github.com/acme/store.git', 'ssh://git@github.com/acme/store', 'https://ada:ghp_SECRET123@github.com/acme/store.git',
      'https://x-access-token:tok@GitHub.com/acme/store.git', 'https://github.com/acme/store.git\n'])
      expect(githubRepoBase(url), url).toBe(want);
    expect(githubRepoBase('git@github.com:Acme-Co/my_repo.v2.git')).toBe('https://github.com/Acme-Co/my_repo.v2');
  });

  test('anything else: none (other hosts, look-alikes, plain http, extra path, odd names)', () => {
    for (const url of ['https://gitlab.com/acme/store.git', 'https://github.com.evil.com/acme/store.git', 'https://evil.com/github.com/acme/store', 'http://github.com/acme/store.git',
      'git@evil.com:github.com/acme/store.git', 'ssh://git@github.com:22/acme/store.git', 'https://github.com/acme/store/extra', 'https://github.com/ac me/store',
      'https://github.com/../store', 'https://github.com/acme/..', 'https://github.com/acme/.git', 'git@github.com:acme/store?x=1', 'https://github.com/acme/store#x',
      '/srv/git/store.git', 'file:///srv/store.git', '', 'github.com/acme/store'])
      expect(githubRepoBase(url), url).toBeNull();
  });

  test('read from a listed remote\'s URL: the base only, never the credentials in it', async () => {
    const dir = repo();
    git(dir, 'remote', 'add', 'origin', 'https://ada:ghp_SECRET123@github.com/acme/store.git');
    git(dir, 'remote', 'add', 'gl', 'https://gitlab.com/acme/store.git');
    expect(await githubRepoOf(dir, 'origin')).toBe('https://github.com/acme/store');
    expect(await githubRepoOf(dir, 'gl')).toBeNull();
    expect(await githubRepoOf(dir, 'missing')).toBeNull();
    await expect(githubRepoOf(dir, '-x')).rejects.toThrow();
  });
});

describe('upstreamOf (what a force-with-lease names)', () => {
  test("the branch's upstream on its remote: remote, its ref there, the remote-tracking oid", async () => {
    const { a } = remotePair();
    const oid = git(a, 'rev-parse', 'refs/remotes/origin/main').trim();
    expect(await upstreamOf(a, 'main')).toEqual({ remote: 'origin', ref: 'refs/heads/main', oid });
    // Another local name tracking main: the remote's ref, not the local name.
    git(a, 'branch', '-q', '--track', 'local-name', 'origin/main');
    expect(await upstreamOf(a, 'local-name')).toEqual({ remote: 'origin', ref: 'refs/heads/main', oid });
  });

  test('none without an upstream, for an unknown branch, or an unsafe name', async () => {
    const dir = repo();
    commit(dir, 'one', { 'a.ts': 'a\n' });
    expect(await upstreamOf(dir, 'main')).toBeNull();
    expect(await upstreamOf(dir, 'nope')).toBeNull();
    await expect(upstreamOf(dir, '--all')).rejects.toThrow(/not allowed/);
    await expect(upstreamOf(dir, 'a*')).rejects.toThrow(/not allowed/);
  });
});

describe('stashFiles', () => {
  test('tracked changes (staged or not) and, with -u, the new files', async () => {
    const dir = repo();
    commit(dir, 'one', { 'a.ts': 'a\n', 'b.ts': 'b\n', 'c.ts': 'c\n' });
    writeFileSync(join(dir, 'a.ts'), 'a2\n');
    writeFileSync(join(dir, 'b.ts'), 'b2\n');
    git(dir, 'add', 'b.ts');
    mkdirSync(join(dir, 'new dir'));
    writeFileSync(join(dir, 'new dir', 'n è.txt'), 'n\n');
    git(dir, 'stash', 'push', '-q', '-u', '-m', 'with new');
    const withNew = git(dir, 'rev-parse', 'stash@{0}').trim();
    expect(await stashFiles(dir, withNew)).toEqual(['a.ts', 'b.ts', 'new dir/n è.txt']);

    writeFileSync(join(dir, 'c.ts'), 'c2\n');
    writeFileSync(join(dir, 'untracked.txt'), 'u\n');
    git(dir, 'stash', 'push', '-q', '-m', 'tracked only');
    const tracked = git(dir, 'rev-parse', 'stash@{0}').trim();
    expect(await stashFiles(dir, tracked)).toEqual(['c.ts']);
  });

  test('anything but a full commit id is refused before git runs', async () => {
    const dir = repo();
    commit(dir, 'one', { 'a.ts': 'a\n' });
    await expect(stashFiles(dir, 'stash@{0}')).rejects.toThrow();
    await expect(stashFiles(dir, '--output=/tmp/x')).rejects.toThrow();
  });
});

describe('unmergedCommits', () => {
  test('commits on the branch that no other branch, remote branch or tag has', async () => {
    const { a } = remotePair();
    git(a, 'checkout', '-q', '-b', 'feat/x');
    commit(a, 'f1', { 'f.ts': '1\n' });
    commit(a, 'f2', { 'f.ts': '2\n' });
    git(a, 'checkout', '-q', 'main');
    expect(await unmergedCommits(a, 'feat/x')).toBe(2);
    // Pushed: the remote branch has them.
    git(a, 'push', '-q', 'origin', 'feat/x');
    expect(await unmergedCommits(a, 'feat/x')).toBe(0);
    git(a, 'checkout', '-q', '-b', 'feat/y');
    commit(a, 'y1', { 'y.ts': '1\n' });
    git(a, 'checkout', '-q', 'main');
    expect(await unmergedCommits(a, 'feat/y')).toBe(1);
    // A tag keeps them too; so does another local branch.
    git(a, 'tag', 'keep-y', 'feat/y');
    expect(await unmergedCommits(a, 'feat/y')).toBe(0);
    git(a, 'tag', '-d', 'keep-y');
    git(a, 'branch', 'copy-y', 'feat/y');
    expect(await unmergedCommits(a, 'feat/y')).toBe(0);
  });

  test('unknown or unsafe names are refused', async () => {
    const dir = repo();
    commit(dir, 'one', { 'a.ts': 'a\n' });
    await expect(unmergedCommits(dir, 'nope')).rejects.toThrow();
    await expect(unmergedCommits(dir, '--all')).rejects.toThrow();
    await expect(unmergedCommits(dir, 'ma*')).rejects.toThrow();
    await expect(unmergedCommits(dir, '../main')).rejects.toThrow();
  });
});
