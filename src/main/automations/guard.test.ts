import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, expect, test } from 'vitest';
import { initPlatform, resetPlatformForTests } from '@shared/platform';
import { posixOnly } from '../../../tests/support/platform';
import { GUARD_HOOK_NAMES, guardEnv, guardGit, pushPrefixes, writeGuard } from './guard';

// The guard runs real git with real hooks
// against throwaway repositories, never the user's config (GIT_CONFIG_GLOBAL=/dev/null, no system config, own HOME).

const home = mkdtempSync(join(tmpdir(), 'atl-guard-home-'));
const isolated = {
  PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.test', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.test',
  GIT_TERMINAL_PROMPT: '0'
};
const run = (cwd: string, args: string[], env: Record<string, string> = {}) =>
  spawnSync('git', args, { cwd, env: { ...isolated, ...env }, encoding: 'utf8' });
const ok = (cwd: string, args: string[], env: Record<string, string> = {}) => {
  const r = run(cwd, args, env);
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};
const sh = (cwd: string, script: string, env: Record<string, string>) =>
  spawnSync('/bin/sh', ['-c', script], { cwd, env: { ...isolated, ...env }, encoding: 'utf8' });

let guardDir = '';
beforeAll(() => {
  guardDir = join(mkdtempSync(join(tmpdir(), 'atl-guard-')), 'guard');
  writeGuard(guardDir);
});

/** A project with a bare remote, `main` and `other`, and the run's worktree on `auto/run1`. */
function project() {
  const dir = mkdtempSync(join(tmpdir(), 'atl-guard-repo-'));
  const remote = join(dir, 'remote.git');
  const root = join(dir, 'acme');
  ok(dir, ['init', '-q', '--bare', '-b', 'main', remote]);
  ok(dir, ['init', '-q', '-b', 'main', root]);
  writeFileSync(join(root, 'f.txt'), 'base\n');
  ok(root, ['add', 'f.txt']);
  ok(root, ['commit', '-q', '-m', 'base']);
  ok(root, ['remote', 'add', 'origin', remote]);
  ok(root, ['push', '-q', 'origin', 'main']);
  ok(root, ['branch', 'other']);
  const wt = join(root, '.claude', 'worktrees', 'auto-run1');
  ok(root, ['worktree', 'add', '-q', '-b', 'auto/run1', wt, 'main']);
  const env = Object.fromEntries(guardEnv({ guardDir, branch: 'auto/run1', pushPrefixes: pushPrefixes([remote]) }));
  writeFileSync(join(wt, 'f.txt'), 'run\n');
  ok(wt, ['commit', '-q', '-am', 'run: work'], env);
  return { dir, remote, root, wt, env, base: ok(root, ['rev-parse', 'main']) };
}

/** The session's environment with the guard's git first on PATH, as the launcher sets it. */
const shimmed = (p: { root: string; wt: string; env: Record<string, string> }) => ({
  ...p.env, ...Object.fromEntries(guardEnv({ guardDir, branch: 'auto/run1', pushPrefixes: [], worktree: p.wt, project: p.root })),
  PATH: `${join(guardDir, 'bin')}:${isolated.PATH}`
});

// POSIX: hooks are #!/bin/sh scripts with mode bits.
posixOnly('the git guard: only the run\'s own branch moves, nothing is pushed', () => {
  test('every command shape that would change another branch, tag or push is refused, with Atelier\'s reason', () => {
    const p = project();
    const shapes = [
      `git -C '${p.root}' merge --no-edit auto/run1`,
      `bash -c "cd '${p.root}' && git merge --no-edit auto/run1"`,
      `git -C '${p.root}' branch -f other HEAD`,
      'git update-ref refs/heads/main HEAD',
      'git branch another-branch',
      'git tag v9',
      'git push origin HEAD:main',
      'git push --no-verify origin HEAD:main',
      'git push --no-verify origin auto/run1',
      `git push --no-verify '${p.remote}' auto/run1`,
      `git push --no-verify 'file://${p.remote}' auto/run1`
    ];
    for (const s of shapes) {
      const r = sh(p.wt, s, p.env);
      expect(r.status, s).not.toBe(0);
      expect(`${r.stderr}`, s).toMatch(/Atelier|atelier/);
    }
    expect(ok(p.root, ['rev-parse', 'main'])).toBe(p.base);
    expect(ok(p.root, ['rev-parse', 'other'])).toBe(p.base);
    expect(ok(p.root, ['tag', '--list'])).toBe('');
    expect(run(p.remote, ['rev-parse', '--verify', '-q', 'refs/heads/auto/run1']).status).not.toBe(0);
    expect(ok(p.remote, ['rev-parse', 'main'])).toBe(p.base);
  });

  test('the PATH git: a command whose work tree is the project\'s own checkout is refused before git touches it', () => {
    const p = project();
    const env = shimmed(p);
    const shapes = [
      `git -C '${p.root}' merge --no-edit auto/run1`,
      `bash -c "cd '${p.root}' && git merge --no-edit auto/run1"`,
      `git --work-tree='${p.root}' --git-dir='${p.root}/.git' checkout auto/run1 -- f.txt`,
      `GIT_WORK_TREE='${p.root}' GIT_DIR='${p.root}/.git' git checkout auto/run1 -- f.txt`,
      `git -C '${p.root}' -c core.hooksPath=/dev/null merge --no-edit auto/run1`,
      `git -C .. -C ../.. merge --no-edit auto/run1`
    ];
    for (const s of shapes) {
      const r = sh(p.wt, s, env);
      expect(r.status, s).not.toBe(0);
      expect(r.stderr, s).toContain('Atelier: an automated session works only in its own worktree');
    }
    // The checkout is untouched: same commit, nothing staged, nothing changed.
    expect(ok(p.root, ['rev-parse', 'main'])).toBe(p.base);
    expect(ok(p.root, ['status', '--porcelain', '--untracked-files=no'])).toBe('');
  });

  test('the PATH git reads options as git does: a value-taking option can\'t hide -C; an unknown one is refused', () => {
    const p = project();
    const env = shimmed(p);
    for (const s of [`git --attr-source HEAD -C '${p.root}' merge --no-edit auto/run1`, `git --shallow-file x -C '${p.root}' merge --no-edit auto/run1`]) {
      const r = sh(p.wt, s, env);
      expect(r.status, s).not.toBe(0);
      expect(r.stderr, s).toContain('Atelier: an automated session works only in its own worktree');
    }
    const odd = sh(p.wt, 'git --frobnicate status', env);
    expect(odd.status).not.toBe(0);
    expect(odd.stderr).toContain("Atelier: an automated session's git doesn't take --frobnicate");
    // Every-day options still work.
    expect(sh(p.wt, 'git --no-pager -c core.quotepath=false --no-optional-locks log -1 --format=%s', env).stdout.trim()).toBe('run: work');
    expect(ok(p.root, ['rev-parse', 'main'])).toBe(p.base);
  });

  test('the PATH git refuses the checkout\'s own git dir or index (--git-dir, GIT_DIR, GIT_INDEX_FILE); the run\'s own are fine', () => {
    const p = project();
    const env = shimmed(p);
    for (const s of [`git --git-dir='${p.root}/.git' read-tree auto/run1`, `git --git-dir '${p.root}/.git' add -A`,
      `GIT_DIR='${p.root}/.git' git read-tree auto/run1`, `GIT_INDEX_FILE='${p.root}/.git/index' git read-tree auto/run1`]) {
      const r = sh(p.wt, s, env);
      expect(r.status, s).not.toBe(0);
      expect(r.stderr, s).toContain("Atelier: an automated session uses only its own worktree's git folder");
    }
    expect(ok(p.root, ['status', '--porcelain', '--untracked-files=no'])).toBe('');
    // The run's own (git sets GIT_DIR for hooks): its worktree's admin folder.
    const admin = readFileSync(join(p.wt, '.git'), 'utf8').replace(/^gitdir: /, '').trim();
    expect(sh(p.wt, `GIT_DIR='${admin}' git rev-parse --abbrev-ref HEAD`, env).stdout.trim()).toBe('auto/run1');
  });

  test('the PATH git lets the run work: its worktree, a folder outside the project, the hooks it chains', () => {
    const p = project();
    const env = shimmed(p);
    expect(sh(p.wt, 'git status --porcelain && git log --oneline -1', env).status).toBe(0);
    const other = mkdtempSync(join(tmpdir(), 'atl-guard-other-'));
    expect(sh(p.wt, `git -C '${other}' init -q`, env).status).toBe(0);
    mkdirSync(join(p.wt, '.myhooks'));
    writeFileSync(join(p.wt, '.myhooks', 'pre-commit'), '#!/bin/sh\ngit rev-parse --show-toplevel >/dev/null || exit 1\nexit 0\n');
    chmodSync(join(p.wt, '.myhooks', 'pre-commit'), 0o755);
    writeFileSync(join(p.wt, 'k.txt'), 'x\n');
    const r = sh(p.wt, 'git add k.txt && git commit -q -m k', { ...env, ATELIER_USER_HOOKS: '.myhooks' });
    expect(r.status, r.stderr).toBe(0);
  });

  test('the run works normally on its own branch: commit, fetch, checkout of a file', () => {
    const p = project();
    writeFileSync(join(p.wt, 'g.txt'), 'new\n');
    ok(p.wt, ['add', 'g.txt'], p.env);
    ok(p.wt, ['commit', '-q', '-m', 'add g'], p.env);
    writeFileSync(join(p.wt, 'g.txt'), 'dirty\n');
    ok(p.wt, ['checkout', '--', 'g.txt'], p.env);
    ok(p.wt, ['fetch', '-q', 'origin'], p.env);
    expect(ok(p.wt, ['log', '--format=%s', '-1'], p.env)).toBe('add g');
  });

  test('the PATH git never pushes, whatever the remote: an ssh host alias, a pushurl, --no-verify, -C, bash -c', () => {
    const p = project();
    ok(p.root, ['remote', 'add', 'work', 'github-work:acme/app.git']);
    ok(p.root, ['config', 'remote.origin.pushurl', p.remote]);
    const env = shimmed(p);
    for (const s of ['git push --no-verify origin auto/run1', 'git -C . push --no-verify origin auto/run1',
      `bash -c 'git push --no-verify origin auto/run1'`, 'git -c x.y=z push work auto/run1', 'git send-pack origin auto/run1']) {
      const r = sh(p.wt, s, env);
      expect(r.status, s).not.toBe(0);
      expect(r.stderr, s).toContain('Atelier: automated sessions never push');
    }
    expect(run(p.remote, ['rev-parse', '--verify', '-q', 'refs/heads/auto/run1']).status).not.toBe(0);
  });

  test('stash is shared with the user\'s checkout: the PATH git refuses it (list and show stay), the hooks refuse refs/stash', () => {
    const p = project();
    writeFileSync(join(p.root, 'f.txt'), 'the user\'s work\n');
    ok(p.root, ['stash', '-q']);
    const theirs = ok(p.root, ['rev-parse', 'refs/stash']);
    const env = shimmed(p);
    for (const s of ['git stash', 'git stash push -u', 'git stash pop', 'git stash apply', 'git stash drop', 'git stash clear', 'git -C . stash pop']) {
      const r = sh(p.wt, s, env);
      expect(r.status, s).not.toBe(0);
      expect(r.stderr, s).toContain('Atelier: an automated session doesn\'t use git stash');
    }
    expect(sh(p.wt, 'git stash list && git stash show', env).status).toBe(0);
    // Git itself (an absolute path, past the PATH git): the hooks still refuse to move refs/stash, and the work stays.
    writeFileSync(join(p.wt, 'f.txt'), 'run, not committed\n');
    const pushed = run(p.wt, ['stash', '-q'], p.env);
    expect(pushed.status).not.toBe(0);
    expect(pushed.stderr).toContain('Atelier');
    expect(readFileSync(join(p.wt, 'f.txt'), 'utf8')).toBe('run, not committed\n');
    ok(p.wt, ['checkout', '--', 'f.txt'], p.env);
    run(p.wt, ['stash', 'pop', '-q'], p.env);
    run(p.wt, ['stash', 'drop', '-q'], p.env);
    expect(ok(p.root, ['rev-parse', 'refs/stash'])).toBe(theirs);
    expect(ok(p.root, ['stash', 'list']).split('\n')).toHaveLength(1);
  });

  test('the repository\'s own hooks still run: core.hooksPath (husky style, relative) or .git/hooks', () => {
    const p = project();
    mkdirSync(join(p.wt, '.myhooks'));
    writeFileSync(join(p.wt, '.myhooks', 'pre-commit'), '#!/bin/sh\necho "lint failed" >&2\nexit 1\n');
    chmodSync(join(p.wt, '.myhooks', 'pre-commit'), 0o755);
    writeFileSync(join(p.wt, 'h.txt'), 'x\n');
    ok(p.wt, ['add', 'h.txt'], p.env);
    const refused = run(p.wt, ['commit', '-q', '-m', 'h'], { ...p.env, ATELIER_USER_HOOKS: '.myhooks' });
    expect(refused.status).not.toBe(0);
    expect(refused.stderr).toContain('lint failed');
    // Unset: the repository's hooks folder (the common dir's, shared by worktrees).
    const marker = join(p.dir, 'post-commit-ran');
    const hooks = join(p.root, '.git', 'hooks');
    writeFileSync(join(hooks, 'post-commit'), `#!/bin/sh\ntouch '${marker}'\n`);
    chmodSync(join(hooks, 'post-commit'), 0o755);
    ok(p.wt, ['commit', '-q', '--no-verify', '-m', 'h'], p.env);
    expect(existsSync(marker)).toBe(true);
  });

  test('a user reference-transaction hook still runs, after the guard, with the same input', () => {
    const p = project();
    const seen = join(p.dir, 'rt-input');
    const hooks = join(p.root, '.git', 'hooks');
    writeFileSync(join(hooks, 'reference-transaction'), `#!/bin/sh\n[ "$1" = committed ] && cat >> '${seen}'\nexit 0\n`);
    chmodSync(join(hooks, 'reference-transaction'), 0o755);
    writeFileSync(join(p.wt, 'i.txt'), 'x\n');
    ok(p.wt, ['add', 'i.txt'], p.env);
    ok(p.wt, ['commit', '-q', '-m', 'i'], p.env);
    expect(readFileSync(seen, 'utf8')).toContain('refs/heads/auto/run1');
  });

  test('push prefixes: the usual schemes, plus each scp-style remote\'s user@host:', () => {
    expect(pushPrefixes([])).toEqual(['/', 'file://', 'https://', 'http://', 'ssh://', 'git://', 'git@']);
    expect(pushPrefixes(['deploy@build.example:acme.git', 'https://github.com/x/y', 'deploy@build.example:other.git']))
      .toEqual(['/', 'file://', 'https://', 'http://', 'ssh://', 'git://', 'git@', 'deploy@build.example:']);
    // An ssh host alias (~/.ssh/config) has no user@: its host: is a prefix too; a URL's scheme is not.
    expect(pushPrefixes(['github-work:acme/app.git', 'gh.example:x', 'https://h/x', 'ftp://h/x'])).toEqual(
      ['/', 'file://', 'https://', 'http://', 'ssh://', 'git://', 'git@', 'github-work:', 'gh.example:']);
    // A remote on a Windows drive (C:/…, D:\…): its drive is a prefix too.
    expect(pushPrefixes(['C:/x/remote.git', 'D:\\y\\r.git'])).toEqual(['/', 'file://', 'https://', 'http://', 'ssh://', 'git://', 'git@', 'C:', 'D:']);
    const p = project();
    const r = run(p.wt, ['push', '--no-verify', 'deploy@build.example:acme.git', 'auto/run1'],
      Object.fromEntries(guardEnv({ guardDir, branch: 'auto/run1', pushPrefixes: pushPrefixes(['deploy@build.example:acme.git']) })));
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/atelier/);
  });

  test('guardEnv: one GIT_CONFIG entry per setting, the run\'s branch; a branch with a quote is refused', () => {
    const env = guardEnv({ guardDir: '/g', branch: 'auto/x', pushPrefixes: ['/', 'git@'] });
    expect(env).toEqual([
      ['GIT_CONFIG_COUNT', '3'],
      ['GIT_CONFIG_KEY_0', 'core.hooksPath'], ['GIT_CONFIG_VALUE_0', '/g'],
      ['GIT_CONFIG_KEY_1', 'url.atelier-automated-sessions-never-push://blocked/.pushInsteadOf'], ['GIT_CONFIG_VALUE_1', '/'],
      ['GIT_CONFIG_KEY_2', 'url.atelier-automated-sessions-never-push://blocked/.pushInsteadOf'], ['GIT_CONFIG_VALUE_2', 'git@'],
      ['ATELIER_RUN_BRANCH', 'auto/x']
    ]);
    expect(() => guardEnv({ guardDir: '/g', branch: "a'b", pushPrefixes: [] })).toThrow();
  });

  test('writeGuard: every client hook, executable, in a 0700 folder; written again only when it differs', () => {
    for (const n of ['reference-transaction', 'pre-push', 'pre-commit', 'commit-msg', 'post-checkout', 'post-merge', 'pre-rebase']) {
      expect(GUARD_HOOK_NAMES).toContain(n);
      expect(statSync(join(guardDir, n)).mode & 0o777, n).toBe(0o700);
    }
    expect(statSync(guardDir).mode & 0o777).toBe(0o700);
    const before = statSync(join(guardDir, 'pre-push')).mtimeMs;
    expect(writeGuard(guardDir)).toBe(false);
    expect(statSync(join(guardDir, 'pre-push')).mtimeMs).toBe(before);
  });
});

// Windows: the same hooks, and the app's native atelier-git.exe copied as bin\git.exe instead of the script.
afterEach(() => { resetPlatformForTests(); });

test('writeGuard on Windows: the hooks, and bin/git.exe a copy of the given binary (no sh git); copied again only when it differs', () => {
  initPlatform('win32');
  const dir = join(mkdtempSync(join(tmpdir(), 'atl-guard-win-')), 'guard');
  const exe = join(dir, '..', 'atelier-git.exe');
  writeFileSync(exe, Buffer.from([0x4d, 0x5a, 1, 2, 3]));
  expect(writeGuard(dir, { gitExe: exe })).toBe(true);
  expect(readFileSync(join(dir, 'bin', 'git.exe'))).toEqual(Buffer.from([0x4d, 0x5a, 1, 2, 3]));
  expect(existsSync(join(dir, 'bin', 'git'))).toBe(false);
  expect(readFileSync(join(dir, 'reference-transaction'), 'utf8')).toContain('refs/stash)');
  expect(guardGit(dir)).toBe(join(dir, 'bin', 'git.exe'));
  expect(writeGuard(dir, { gitExe: exe })).toBe(false);
  writeFileSync(exe, Buffer.from([0x4d, 0x5a, 9]));
  expect(writeGuard(dir, { gitExe: exe })).toBe(true);
  expect(readFileSync(join(dir, 'bin', 'git.exe'))).toEqual(Buffer.from([0x4d, 0x5a, 9]));
  // No binary (a build without it): the hooks still, and no git at all in bin (launch refuses then).
  const bare = join(mkdtempSync(join(tmpdir(), 'atl-guard-win-')), 'guard');
  writeGuard(bare, { gitExe: null });
  expect(existsSync(join(bare, 'bin', 'git.exe'))).toBe(false);
  expect(existsSync(join(bare, 'pre-push'))).toBe(true);
  // macOS: the sh script, whatever binary is named.
  resetPlatformForTests();
  const mac = join(mkdtempSync(join(tmpdir(), 'atl-guard-mac-')), 'guard');
  writeGuard(mac, { gitExe: exe });
  expect(existsSync(join(mac, 'bin', 'git'))).toBe(true);
  expect(existsSync(join(mac, 'bin', 'git.exe'))).toBe(false);
  expect(guardGit(mac)).toBe(join(mac, 'bin', 'git'));
});

test('guardEnv on Windows: core.longpaths on for the session\'s git too', () => {
  initPlatform('win32');
  const env = Object.fromEntries(guardEnv({ guardDir: 'C:/g', branch: 'auto/x', pushPrefixes: ['/'] }));
  const n = Number(env.GIT_CONFIG_COUNT);
  const cfg = Object.fromEntries(Array.from({ length: n }, (_, i) => [env[`GIT_CONFIG_KEY_${i}`], env[`GIT_CONFIG_VALUE_${i}`]]));
  expect(cfg['core.longpaths']).toBe('true');
  expect(cfg['core.hooksPath']).toBe('C:/g');
});
