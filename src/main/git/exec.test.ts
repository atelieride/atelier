import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { initPlatform, resetPlatformForTests } from '@shared/platform';
import { AUTO_FETCH_CONFIG_ARGS, CONFIG_READ_KEYS, GitTooLarge, LOG_GUARDS, SHOW_GUARDS, gitEnv, runGit, runGitBytes, validateGitArgs } from './exec';

describe('validateGitArgs', () => {
  test.each([
    [['status', '--porcelain=v2', '-z']],
    [['diff', '--no-ext-diff', '--no-textconv', '--no-color', '--numstat', '-z', 'HEAD']],
    [['show', '--no-ext-diff', '--no-textconv', '--no-color', '--no-show-signature', 'HEAD:src/a.ts']],
    [['rev-parse', '--show-toplevel']],
    [['ls-files', '-z', '--others', '--exclude-standard']],
    // Review against the default branch: read-only history queries.
    [['merge-base', 'HEAD', 'origin/main']],
    [['rev-list', '--count', 'abc..HEAD']]
  ])('allowed: %j', (args) => expect(() => validateGitArgs(args)).not.toThrow());

  test.each([
    [['symbolic-ref', 'HEAD', 'refs/heads/x']], [['update-ref', 'HEAD', 'abc']], [['branch', '-f', 'main']], [['merge', 'main']],
    [['rev-list', '--output=/tmp/x', 'HEAD']]
  ])('still forbidden next to the history reads: %j', (args) => expect(() => validateGitArgs(args)).toThrow());

  test.each([
    [['commit', '-m', 'x']], [['checkout', '.']], [['reset', '--hard']], [['stash']], [['add', '.']], [['gc']], [['config', 'x', 'y']],
    [['diff', '--output=/tmp/x']], [['diff', '--output', '/tmp/x']], [['diff', '--ext-diff']], [['show', '--textconv', 'HEAD:a']],
    [['status', '-c', 'core.pager=sh']], [['status', '--exec=rm']], [[]], [['-c', 'x=y', 'status']]
  ])('forbidden: %j', (args) => expect(() => validateGitArgs(args)).toThrow());

  test('diff and show without the mandatory safeguards → forbidden', () => {
    expect(() => validateGitArgs(['diff', '--numstat'])).toThrow(/--no-ext-diff/);
    expect(() => validateGitArgs(['show', 'HEAD:a'])).toThrow(/--no-ext-diff/);
  });
});

describe('runGit', () => {
  test('runs in a real repo without creating locks', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'atl-git-'));
    execFileSync('git', ['init', '-q'], { cwd: repo });
    writeFileSync(join(repo, 'a.txt'), 'hello\n');
    const out = await runGit(repo, ['status', '--porcelain=v2', '-z', '--untracked-files=all']);
    expect(out).toContain('? a.txt');
    expect(existsSync(join(repo, '.git', 'index.lock'))).toBe(false);
  });
  test('a forbidden command is never launched', async () => {
    await expect(runGit('/tmp', ['commit', '-m', 'x'])).rejects.toThrow(/not allowed/);
  });
  test('folder that is not a repo → readable error', async () => {
    await expect(runGit(mkdtempSync(join(tmpdir(), 'atl-nogit-')), ['rev-parse', 'HEAD'])).rejects.toThrow();
  });
});

describe('source control reads', () => {
  const LOG = ['--no-ext-diff', '--no-textconv', '--no-color', '--no-show-signature'];
  test.each([
    [['log', ...LOG, '--topo-order', '--format=%H', '--branches', '--remotes', '--tags', 'HEAD', '-n', '400']],
    [['log', ...LOG, '-g', '--format=%gd', 'refs/stash']],
    [['log', ...LOG, '--format=%H', '--grep=x', '-F', '-i', '--all-match', '--end-of-options', 'refs/heads/main', '--', ':(literal)src']],
    [['for-each-ref', '--format=%(refname)', 'refs/heads', 'refs/remotes', 'refs/tags']],
    [['for-each-ref', '--format=%(refname)', '--sort=-creatordate', 'refs/tags']],
    [['worktree', 'list', '--porcelain']], [['worktree', 'list', '--porcelain', '-z']],
    [['cat-file', '-s', 'a'.repeat(40) + ':src/a b.ts']],
    [['show', ...LOG, 'HEAD:a.ts']], [['show', ...LOG, '--no-patch', '--format=%B', 'abc']],
    // The configured remotes' names: a repo that has a remote but was never fetched.
    [['remote']],
    // Whether the repo's own config names programs a fetch would run: one fixed form.
    [[...AUTO_FETCH_CONFIG_ARGS]],
    // HEAD's branch, born or not, in any ref storage: the read form only.
    [['symbolic-ref', '-q', 'HEAD']]
  ])('allowed: %j', (args) => expect(() => validateGitArgs(args)).not.toThrow());
  test.each([
    [['log', '--format=%H']],
    [['log', ...LOG, 'HEAD']],
    [['log', ...LOG, '--format=%H', '-p']], [['log', ...LOG, '--format=%H', '--patch']], [['log', ...LOG, '--format=%H', '-u']],
    [['log', ...LOG, '--format=%H', '--stat']], [['log', ...LOG, '--format=%H', '--stat=200']], [['log', ...LOG, '--format=%H', '--numstat']],
    [['log', ...LOG, '--format=%H', '--output=/tmp/x']],
    [['for-each-ref', 'refs/heads']],
    [['for-each-ref', '--format=%(refname)', 'refs/notes']], [['for-each-ref', '--format=%(refname)', 'refs']],
    [['for-each-ref', '--format=%(refname)', '--shell', 'refs/heads']],
    [['worktree', 'add', '../x']], [['worktree', 'list']], [['worktree', 'prune']], [['worktree', 'list', '--porcelain', '--expire=now']],
    [['show', '--no-ext-diff', '--no-textconv', '--no-color', 'HEAD:a']],
    // Patches in other words (merges' diffs; --remerge-diff even writes temporary objects), signature checks.
    [['log', ...LOG, '--format=%H', '--cc']], [['log', ...LOG, '--format=%H', '--remerge-diff']], [['log', ...LOG, '--format=%H', '--diff-merges=on']],
    [['log', ...LOG, '--format=%H', '-m']], [['log', ...LOG, '--format=%H', '--show-signature']], [['log', ...LOG, '--format=%H%G?']],
    [['log', ...LOG, '--format=%H %GS']], [['log', ...LOG, '--format=%H', '--pretty=format:%G?']], [['show', ...LOG, '--format=%GK', 'HEAD']],
    // cat-file only tells a blob's size: no contents, no batch mode, no other revision syntax.
    [['cat-file', '-p', 'HEAD']], [['cat-file', '--batch']], [['cat-file', '-s', 'HEAD:a']], [['cat-file', '-s', 'a'.repeat(40)]], [['cat-file', '-s', 'a'.repeat(40) + ':a', 'x']],
    [['stash', 'list']], [['checkout', 'main']], [['switch', 'main']], [['fetch']], [['notes', 'list']],
    // Only the bare listing: no -v (URLs may carry credentials), no add/remove/set-url/prune/update.
    [['remote', '-v']], [['remote', 'add', 'x', 'y']], [['remote', 'remove', 'origin']], [['remote', 'prune', 'origin']], [['remote', 'update']], [['remote', 'set-url', 'origin', 'x']],
    [['config', '--global', '--list']], [['config', 'set', 'a.b', 'c']], [['config', 'core.hooksPath', '/x']], [['config', '--local', '--includes', '--name-only', '--get-regexp', '.']],
    [[...AUTO_FETCH_CONFIG_ARGS, 'extra']],
    // symbolic-ref writes HEAD with a second argument, deletes it with -d.
    [['symbolic-ref', 'HEAD', 'refs/heads/x']], [['symbolic-ref', '-q', 'HEAD', 'refs/heads/x']], [['symbolic-ref', '-d', 'HEAD']],
    [['symbolic-ref', '--delete', '-q', 'HEAD']], [['symbolic-ref', 'HEAD']], [['symbolic-ref', '-q', 'ORIG_HEAD']]
  ])('refused: %j', (args) => expect(() => validateGitArgs(args)).toThrow());
});

// Git writes: the reads a commit, a push or a branch sheet needs, each a fixed shape.
describe('git writes reads', () => {
  test.each([
    [['check-ref-format', '--branch', 'feat/x']],
    [['check-ignore', '-q', '--', '.claude/worktrees/feat-x']],
    ...CONFIG_READ_KEYS.map((k) => [['config', '--get', k]]),
    [['version']],
    [['rev-parse', '--path-format=absolute', '--git-path', 'hooks', '--git-path', 'MERGE_HEAD', '--git-path', 'rebase-merge']],
    ...['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply', 'index.lock', 'hooks'].map((n) => [['rev-parse', '--git-path', n]]),
    [['merge-base', '--is-ancestor', 'HEAD', '@{u}']],
    // A remote's URL, for the GitHub compare base (main scrubs it; the raw URL never leaves main).
    [['config', '--get', 'remote.origin.url']], [['config', '--get', 'remote.my-fork_2.url']], [['config', '--get', 'remote.a.b.url']],
    [['for-each-ref', '--contains=HEAD', '--count=1', '--format=%(refname)', 'refs/remotes']],
    [['rev-list', '--count', 'refs/heads/feat/x', '--not', '--exclude=feat/x', '--branches', '--remotes', '--tags', '--']],
    [['diff', '--no-ext-diff', '--no-textconv', '--no-color', '--name-only', '--no-renames', '-z', 'HEAD...@{u}', '--']]
  ])('allowed: %j', (args) => expect(() => validateGitArgs(args)).not.toThrow());

  test('the config keys are exactly the closed list', () => {
    expect([...CONFIG_READ_KEYS].sort()).toEqual(['commit.gpgsign', 'gpg.format', 'gpg.program', 'gpg.ssh.program', 'gpg.x509.program',
      'push.autoSetupRemote', 'push.default', 'user.email', 'user.name']);
  });

  test.each([
    // config: one key from the list, read only, from every scope git reads by default.
    [['config', '--get', 'core.sshCommand']], [['config', '--get', 'core.hooksPath']], [['config', '--get', 'credential.helper']],
    [['config', '--get', 'USER.NAME']], [['config', '--get', 'user.name', 'extra']], [['config', '--get']], [['config', '--get', 'user.name', '-c']],
    [['config', 'user.name', 'x']], [['config', 'user.name']], [['config', '--unset', 'user.name']], [['config', '--global', '--get', 'user.name']],
    [['config', '--get-all', 'user.name']], [['config', '--get-regexp', 'user']], [['config', '--get', '--', 'user.name']],
    [['config', '--file', '/tmp/x', '--get', 'user.name']], [['config', '--includes', '--get', 'user.name']], [['config', 'set', 'user.name', 'x']],
    [['-c', 'x=y', 'config', '--get', 'user.name']],
    // remote.<name>.url only: a plain remote name, nothing else of a remote's section, one read.
    [['config', '--get', 'remote.origin.pushurl']], [['config', '--get', 'remote.origin.uploadpack']], [['config', '--get', 'remote..url']],
    [['config', '--get', 'remote.-x.url']], [['config', '--get', 'remote.a/b.url']], [['config', '--get', 'remote.a b.url']], [['config', '--get', 'remote.a..b.url']],
    [['config', '--get', 'remote.origin.url', 'extra']], [['config', '--get-all', 'remote.origin.url']], [['config', '--get', 'remote.origin.URL']],
    [['config', '--get', 'remote.HEAD.url']], [['config', '--get', 'remote.x.lock.url']], [['config', '--get', 'remote.origin.url.x']],
    [['config', '--get', `remote.${'x'.repeat(101)}.url`]], [['config', '--get-regexp', 'remote\\..*\\.url']], [['config', 'remote.origin.url', 'x']],
    // check-ref-format: only --branch and one name that can't be read as an option.
    [['check-ref-format', 'refs/heads/x']], [['check-ref-format', '--branch']], [['check-ref-format', '--branch', 'a', 'b']],
    [['check-ref-format', '--normalize', 'refs/heads/x']], [['check-ref-format', '--branch', '-x']], [['check-ref-format', '--branch', '']],
    [['check-ref-format', '--branch', 'a\0b']],
    // check-ignore: quiet, one path after --.
    [['check-ignore', 'x']], [['check-ignore', '-q', 'x']], [['check-ignore', '-q', '--', 'a', 'b']], [['check-ignore', '--stdin']],
    [['check-ignore', '-v', '--', 'x']], [['check-ignore', '-q', '--', '']], [['check-ignore', '-q', '--no-index', '--', 'x']], [['check-ignore', '-q', '--']],
    // Four arguments, but the third isn't `--`: an option where the separator belongs.
    [['check-ignore', '-q', '--no-index', 'x']], [['check-ignore', '-q', '--stdin', 'x']], [['check-ignore', '-q', '-v', 'x']],
    // A remote name ending with a dot (git refuses it as a remote): never read.
    [['config', '--get', 'remote.x..url']],
    // rev-parse --git-path: only the listed names.
    [['rev-parse', '--git-path', 'config']], [['rev-parse', '--git-path', '../x']], [['rev-parse', '--git-path']], [['rev-parse', '--git-path=hooks']],
    [['rev-parse', '--git-path', 'hooks', '--git-path', 'objects']], [['rev-parse', '--git-path', 'hooks/pre-commit']],
    // version: the bare form.
    [['version', '--build-options']], [['version', 'x']]
  ])('refused: %j', (args) => expect(() => validateGitArgs(args)).toThrow());

  test.each([
    [['commit', '-m', 'x']], [['commit', '--amend']], [['add', '--all']], [['push']], [['push', '--force-with-lease']], [['stash', 'push']], [['stash', 'list']],
    [['reset', '--soft', 'HEAD~1']], [['switch', 'main']], [['checkout', 'main']], [['branch', '-d', 'x']], [['branch']], [['restore', '--staged', '.']],
    [['rm', '--cached', 'a']], [['pull']], [['rebase', '--abort']], [['worktree', 'add', 'x']], [['merge', '--abort']], [['cherry-pick', 'x']],
    [['revert', 'x']], [['tag', 'v1']], [['update-ref', 'HEAD', 'x']], [['symbolic-ref', 'HEAD']], [['fetch']], [['clean', '-n']], [['notes', 'list']],
    [['hook', 'run', 'pre-commit']], [['var', 'GIT_EDITOR']], [['ls-tree', 'HEAD']]
  ])('writes (and everything else outside the list) stay refused: %j', (args) => expect(() => validateGitArgs(args)).toThrow(/allowed/));
});

test('gitEnv: ATELIER_TEST_GIT_ISOLATED=1 (e2e, unit tests) reads no global or system config; otherwise they stay', () => {
  const prev = process.env.ATELIER_TEST_GIT_ISOLATED;
  try {
    process.env.ATELIER_TEST_GIT_ISOLATED = '1';
    const isolated = gitEnv({ GIT_CONFIG_GLOBAL: '/somewhere/else', GIT_DIR: '/x' });
    expect(isolated).toMatchObject({ GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' });
    expect(isolated.GIT_DIR).toBeUndefined();
    delete process.env.ATELIER_TEST_GIT_ISOLATED;
    const real = gitEnv({ GIT_CONFIG_GLOBAL: '/somewhere/else' });
    expect(real.GIT_CONFIG_GLOBAL).toBeUndefined();
    expect(real.GIT_CONFIG_NOSYSTEM).toBeUndefined();
  } finally {
    if (prev === undefined) delete process.env.ATELIER_TEST_GIT_ISOLATED; else process.env.ATELIER_TEST_GIT_ISOLATED = prev;
  }
});

test('runGit under ATELIER_TEST_GIT_ISOLATED=1 never sees a global config', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'atl-git-iso-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  // A fake home with its own ~/.gitconfig (never the user's): what git reads as the global config when not isolated.
  writeFileSync(join(dir, '.gitconfig'), '[user]\n\tname = From Global\n');
  const keys = ['ATELIER_TEST_GIT_ISOLATED', 'HOME', 'XDG_CONFIG_HOME'] as const;
  const prev = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  try {
    process.env.HOME = dir;
    process.env.XDG_CONFIG_HOME = join(dir, 'xdg');
    process.env.ATELIER_TEST_GIT_ISOLATED = '1';
    await expect(runGit(dir, ['config', '--get', 'user.name'])).rejects.toThrow();
  } finally {
    for (const k of keys) if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k];
  }
});

test('gitEnv forces no signature checks and UTF-8 log output (no -c)', () => {
  const env = gitEnv({});
  const pairs = Object.fromEntries(Array.from({ length: Number(env.GIT_CONFIG_COUNT) }, (_, i) => [env[`GIT_CONFIG_KEY_${i}`], env[`GIT_CONFIG_VALUE_${i}`]]));
  expect(pairs).toEqual({ 'diff.autoRefreshIndex': 'false', 'core.fsmonitor': 'false', 'log.showSignature': 'false', 'i18n.logOutputEncoding': 'UTF-8' });
});

test('gitEnv on Windows: core.longpaths too, so a worktree past MAX_PATH reads as it is', () => {
  initPlatform('win32');
  try {
    const env = gitEnv({});
    const pairs = Object.fromEntries(Array.from({ length: Number(env.GIT_CONFIG_COUNT) }, (_, i) => [env[`GIT_CONFIG_KEY_${i}`], env[`GIT_CONFIG_VALUE_${i}`]]));
    expect(pairs['core.longpaths']).toBe('true');
    expect(Object.keys(pairs)).toHaveLength(5);
  } finally {
    resetPlatformForTests();
  }
});

describe('runGit limits', () => {
  test('maxBytes: an output over the limit rejects with GitTooLarge', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'atl-git-'));
    const g = (...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: repo });
    g('init', '-q');
    writeFileSync(join(repo, 'big.txt'), 'x'.repeat(5000));
    g('add', '.');
    g('commit', '-qm', 'x');
    await expect(runGitBytes(repo, ['show', ...SHOW_GUARDS, 'HEAD:big.txt'], { maxBytes: 1000 })).rejects.toBeInstanceOf(GitTooLarge);
    expect((await runGitBytes(repo, ['show', ...SHOW_GUARDS, 'HEAD:big.txt'], { maxBytes: 10000 })).length).toBe(5000);
  });
  test('signal: an aborted call rejects', async () => {
    const ac = new AbortController();
    const p = runGit(process.cwd(), ['log', ...LOG_GUARDS, '--format=%H', 'HEAD'], { signal: ac.signal });
    ac.abort();
    await expect(p).rejects.toThrow(/abort/i);
  });
});
