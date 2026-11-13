import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { beforeAll, expect, test } from 'vitest';
import { initPlatform, resetPlatformForTests } from '@shared/platform';
import { winOnly } from '../../../tests/support/platform';
import { guardBin, guardEnv, guardGit, pushPrefixes, writeGuard } from './guard';

// Git for Windows runs the guard's sh hooks, and atelier-git.exe (vendor/bin,
// built by `npm run build:bridge`) is the git every shell of the session finds first — PowerShell, cmd and Git Bash
// (Claude Code's Bash tool). Throwaway repositories; never the user's config (an empty global file, no system config).

const EXE = resolve(__dirname, '..', '..', '..', 'vendor', 'bin', 'atelier-git.exe');
const BASH = join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Git', 'bin', 'bash.exe');

winOnly('the git guard on Windows', () => {
  const home = mkdtempSync(join(tmpdir(), 'atl-gw-home-'));
  const globalConfig = join(home, 'gitconfig');
  writeFileSync(globalConfig, '');
  // One PATH key (Windows' is "Path"; two spellings in one environment would be a coin toss).
  const { Path, PATH, ...rest } = process.env as Record<string, string>;
  const systemPath = PATH ?? Path ?? '';
  const isolated: Record<string, string> = {
    ...rest, PATH: systemPath, HOME: home, USERPROFILE: home, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: globalConfig,
    GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.test', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.test', GIT_TERMINAL_PROMPT: '0'
  };
  const git = (cwd: string, args: string[], env: Record<string, string> = {}) => spawnSync('git', args, { cwd, env: { ...isolated, ...env }, encoding: 'utf8' });
  const ok = (cwd: string, args: string[], env: Record<string, string> = {}) => {
    const r = git(cwd, args, env);
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
    return r.stdout.trim();
  };
  let guardDir = '';

  beforeAll(() => {
    expect(existsSync(EXE), `${EXE}: run npm run build:bridge first`).toBe(true);
    initPlatform('win32');
    guardDir = join(mkdtempSync(join(tmpdir(), 'atl-gw-')), 'guard');
    writeGuard(guardDir, { gitExe: EXE });
    resetPlatformForTests();
    return () => resetPlatformForTests();
  });

  /** A project with a bare remote, `main`, the user's stash, and the run's worktree on `auto/run1`. */
  function project() {
    const dir = mkdtempSync(join(tmpdir(), 'atl-gw-repo-'));
    const remote = join(dir, 'remote.git');
    const root = join(dir, 'acme');
    ok(dir, ['init', '-q', '--bare', '-b', 'main', remote]);
    ok(dir, ['init', '-q', '-b', 'main', root]);
    writeFileSync(join(root, 'f.txt'), 'base\n');
    ok(root, ['add', 'f.txt']);
    ok(root, ['commit', '-q', '-m', 'base']);
    ok(root, ['remote', 'add', 'origin', remote]);
    ok(root, ['push', '-q', 'origin', 'main']);
    writeFileSync(join(root, 'f.txt'), "the user's work\n");
    ok(root, ['stash', '-q']);
    const wt = join(root, '.claude', 'worktrees', 'auto-run1');
    ok(root, ['worktree', 'add', '-q', '--no-track', '-b', 'auto/run1', wt, 'main']);
    initPlatform('win32');
    const env = Object.fromEntries(guardEnv({ guardDir, branch: 'auto/run1', pushPrefixes: pushPrefixes([remote]), worktree: wt, project: root }));
    resetPlatformForTests();
    // As launch.ps1 sets it: the guard's git first on PATH, and the function Git Bash finds before its own git.
    const exe = `${guardBin(guardDir).replace(/\\/g, '/')}/git.exe`;
    const session = { ...env, PATH: `${guardBin(guardDir)};${systemPath}`, 'BASH_FUNC_git%%': `() { '${exe}' "$@"; }` };
    writeFileSync(join(wt, 'f.txt'), 'run\n');
    ok(wt, ['commit', '-q', '-am', 'run: work'], env);
    return { dir, remote, root, wt, env, session, base: ok(root, ['rev-parse', 'main']), stash: ok(root, ['rev-parse', 'refs/stash']) };
  }

  const ps = (cwd: string, command: string, env: Record<string, string>) =>
    spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command], { cwd, env: { ...isolated, ...env }, encoding: 'utf8' });
  // cmd parses its own command line: handed over verbatim (`/s /c "…"`), as a terminal would type it.
  const cmd = (cwd: string, command: string, env: Record<string, string>) =>
    spawnSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', `"${command}"`], { cwd, env: { ...isolated, ...env }, encoding: 'utf8', windowsVerbatimArguments: true });
  const bash = (cwd: string, command: string, env: Record<string, string>) =>
    spawnSync(BASH, ['-c', command], { cwd, env: { ...isolated, ...env }, encoding: 'utf8' });
  const slash = (p: string) => p.replace(/\\/g, '/');

  test('every shell finds the guard\'s git first; it runs the real one and returns its output and exit code', () => {
    const p = project();
    initPlatform('win32');
    expect(guardGit(guardDir)).toBe(join(guardDir, 'bin', 'git.exe'));
    resetPlatformForTests();
    for (const run of [ps, cmd, bash]) {
      const r = run(p.wt, 'git rev-parse --abbrev-ref HEAD', p.session);
      expect(r.status, `${run.name}: ${r.stderr}`).toBe(0);
      expect(r.stdout.trim()).toBe('auto/run1');
      expect(run(p.wt, 'git rev-parse --verify -q refs/heads/nope', p.session).status).toBe(1);
    }
    expect(ps(p.wt, '(Get-Command git).Source', p.session).stdout.trim().toLowerCase()).toBe(join(guardDir, 'bin', 'git.exe').toLowerCase());
    // Git Bash puts /mingw64/bin before the inherited PATH: there git is the function launch.ps1 exports.
    expect(bash(p.wt, 'type -t git', p.session).stdout.trim()).toBe('function');
    expect(bash(p.wt, 'type -t git', { PATH: p.session.PATH }).stdout.trim()).toBe('file');
  });

  test('a command whose work tree is the project\'s checkout is refused before git touches it, from every shell and spelling', () => {
    const p = project();
    const up = p.root.toUpperCase();
    const shapes: [typeof ps, string, string][] = [
      [ps, p.wt, `git -C '${p.root}' merge --no-edit auto/run1`],
      [ps, p.root, 'git merge --no-edit auto/run1'],
      [ps, p.wt, `git -C '${up}' merge --no-edit auto/run1`],
      [ps, p.wt, `git -C .. -C ..\\.. merge --no-edit auto/run1`],
      [ps, p.wt, `git --work-tree='${p.root}' --git-dir='${p.root}\\.git' checkout auto/run1 -- f.txt`],
      [cmd, p.wt, `git -C "${p.root}" merge --no-edit auto/run1`],
      [bash, p.wt, `git -C '${slash(p.root)}' merge --no-edit auto/run1`],
      [bash, p.wt, `cd '${slash(p.root)}' && git merge --no-edit auto/run1`]
    ];
    for (const [run, cwd, line] of shapes) {
      const r = run(cwd, line, p.session);
      expect(r.status, line).not.toBe(0);
      expect(r.stderr, line).toContain('Atelier: an automated session works only in its own worktree');
    }
    expect(ok(p.root, ['rev-parse', 'main'])).toBe(p.base);
    expect(ok(p.root, ['status', '--porcelain', '--untracked-files=no'])).toBe('');
  });

  test('options read as git reads them; the checkout\'s git dir or index refused; the run\'s own fine', () => {
    const p = project();
    for (const line of [`git --attr-source HEAD -C '${p.root}' merge --no-edit auto/run1`]) {
      const r = ps(p.wt, line, p.session);
      expect(r.status, line).not.toBe(0);
      expect(r.stderr, line).toContain('Atelier: an automated session works only in its own worktree');
    }
    expect(ps(p.wt, 'git --frobnicate status', p.session).stderr).toContain("Atelier: an automated session's git doesn't take --frobnicate");
    const dotgit = join(p.root, '.git');
    for (const line of [`git --git-dir='${dotgit}' read-tree auto/run1`, `$env:GIT_DIR='${dotgit}'; git read-tree auto/run1`,
      `$env:GIT_INDEX_FILE='${join(dotgit, 'index')}'; git read-tree auto/run1`]) {
      const r = ps(p.wt, line, p.session);
      expect(r.status, line).not.toBe(0);
      expect(r.stderr, line).toContain("Atelier: an automated session uses only its own worktree's git folder");
    }
    expect(ok(p.root, ['status', '--porcelain', '--untracked-files=no'])).toBe('');
    // A quote or a space in an argument reaches git exactly as the guard read it.
    // (From Git Bash, which quotes for the C runtime; PowerShell 5.1 mangles the quotes before the guard sees them.)
    // A space, quotes, and a backslash right before a quote (the case the quoting rules are about).
    const r = bash(p.wt, `git -c 'atelier.probe=A "B" x\\"y' config --get atelier.probe`, p.session);
    expect(r.stdout.trim(), r.stderr).toBe('A "B" x\\"y');
    expect(ps(p.wt, 'git PUSH origin auto/run1', p.session).stderr).toContain('Atelier: automated sessions never push');
  });

  test('never a push, never the stash (list and show stay); the user\'s stash is untouched', () => {
    const p = project();
    // What a refusal that says nothing ran into: the shell and line, the exit code (in hex, where Windows' own codes
    // read as such), the signal, what went to stdout and a spawn error.
    const said = (name: string, line: string, r: ReturnType<typeof ps>) =>
      `${name} ${line}: status ${r.status === null ? 'null' : `${r.status} (0x${(r.status >>> 0).toString(16)})`}, signal ${r.signal}, stdout ${JSON.stringify(r.stdout)}${r.error ? `, error ${r.error.message}` : ''}`;
    for (const run of [ps, cmd, bash]) {
      for (const line of ['git push --no-verify origin auto/run1', 'git -c x.y=z push origin auto/run1']) {
        const r = run(p.wt, line, p.session);
        expect(r.status, `${run.name} ${line}`).not.toBe(0);
        expect(r.stderr, said(run.name, line, r)).toContain('Atelier: automated sessions never push');
      }
      for (const line of ['git stash', 'git stash pop', 'git stash drop']) {
        const r = run(p.wt, line, p.session);
        expect(r.status, `${run.name} ${line}`).not.toBe(0);
        expect(r.stderr, said(run.name, line, r)).toContain('Atelier: an automated session doesn\'t use git stash');
      }
      expect(run(p.wt, 'git stash list', p.session).status).toBe(0);
    }
    expect(ok(p.root, ['rev-parse', 'refs/stash'])).toBe(p.stash);
    expect(git(p.remote, ['rev-parse', '--verify', '-q', 'refs/heads/auto/run1']).status).not.toBe(0);
  });

  test('past the shim (git itself, by its path): the sh hooks refuse other branches, tags and refs/stash; pushes are rewritten', () => {
    const p = project();
    const real = (args: string[]) => git(p.wt, args, p.env);
    for (const args of [['branch', 'other'], ['tag', 'v9'], ['update-ref', 'refs/heads/main', 'HEAD'], ['stash']]) {
      if (args[0] === 'stash') writeFileSync(join(p.wt, 'f.txt'), 'dirty\n');
      const r = real(args);
      expect(r.status, args.join(' ')).not.toBe(0);
      expect(r.stderr, args.join(' ')).toMatch(/Atelier/);
    }
    expect(readFileSync(join(p.wt, 'f.txt'), 'utf8')).toBe('dirty\n');
    for (const target of ['origin', p.remote, slash(p.remote), `file:///${slash(p.remote)}`]) {
      const r = real(['push', '--no-verify', target, 'auto/run1']);
      expect(r.status, target).not.toBe(0);
    }
    expect(git(p.remote, ['rev-parse', '--verify', '-q', 'refs/heads/auto/run1']).status).not.toBe(0);
    expect(ok(p.root, ['rev-parse', 'main'])).toBe(p.base);
    expect(ok(p.root, ['rev-parse', 'refs/stash'])).toBe(p.stash);
  });

  test('the run works: commit on its branch; the repository\'s own hooks still run (chained by the sh hooks)', () => {
    const p = project();
    const marker = join(p.dir, 'post-commit-ran');
    mkdirSync(join(p.root, '.git', 'hooks'), { recursive: true });
    writeFileSync(join(p.root, '.git', 'hooks', 'post-commit'), `#!/bin/sh\ntouch '${slash(marker)}'\n`);
    writeFileSync(join(p.wt, 'g.txt'), 'new\n');
    for (const line of ['git add g.txt', 'git commit -q -m "add g"']) {
      const r = ps(p.wt, line, p.session);
      expect(r.status, `${line}: ${r.stderr}`).toBe(0);
    }
    expect(ok(p.wt, ['log', '--format=%s', '-1'])).toBe('add g');
    expect(existsSync(marker)).toBe(true);
  });
});
