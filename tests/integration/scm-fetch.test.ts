// Fetch: the only git command that writes and uses the network. It brings the remote's commits into
// refs/remotes and FETCH_HEAD, and nothing else: no hook, no ext:: transport, no prompt, no local branch, index, HEAD
// or working-tree change. Every repo here lives in the run's private temp root; remotes are local (bare repos, a
// loopback HTTP server); the user's git config, Keychain and gh credentials are never involved (isolated: true).
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';
import { posixTest } from '../support/platform';
import { autoFetchAllowed, runFetch, stopAllFetches } from '../../src/main/git/fetch';
import { lastFetchAt, readRefs } from '../../src/main/git/history';
import { commit, fixtureGitEnv, git } from '../support/git-fixture';
import { execFileSync } from 'node:child_process';

const tmp = (p: string) => realpathSync(mkdtempSync(join(tmpdir(), p)));

/** A bare remote, a working clone and a second clone that pushes a new commit. */
function remoteAndClones(): { base: string; up: string; wk: string; other: string } {
  const base = tmp('atl-fetch-');
  const seed = join(base, 'seed');
  mkdirSync(seed);
  git(seed, 'init', '-q', '-b', 'main');
  commit(seed, 'first', { 'a.txt': 'a\n' });
  git(base, 'clone', '-q', '--bare', seed, 'up.git');
  const up = join(base, 'up.git');
  git(base, 'clone', '-q', up, 'wk');
  git(base, 'clone', '-q', up, 'other');
  return { base, up, wk: join(base, 'wk'), other: join(base, 'other') };
}

/** Everything a fetch must never change: working tree, index, HEAD, local branches, config, hooks. */
function localState(repo: string): Record<string, string> {
  const out: Record<string, string> = {};
  const add = (p: string) => { out[p.slice(repo.length)] = createHash('sha256').update(readFileSync(p)).digest('hex'); };
  const walk = (d: string, skip: (rel: string) => boolean) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (skip(p.slice(repo.length))) continue;
      if (statSync(p).isDirectory()) walk(p, skip); else add(p);
    }
  };
  walk(repo, (rel) => rel === '/.git');
  for (const f of ['HEAD', 'index', 'config']) if (existsSync(join(repo, '.git', f))) add(join(repo, '.git', f));
  walk(join(repo, '.git', 'refs', 'heads'), () => false);
  walk(join(repo, '.git', 'hooks'), () => false);
  return out;
}

const servers: Server[] = [];
afterAll(() => { for (const s of servers) s.close(); });
function http(handler: Parameters<typeof createServer>[1]): Promise<string> {
  const s = createServer(handler);
  servers.push(s);
  return new Promise((resolve) => s.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(s.address() as AddressInfo).port}`)));
}

// POSIX: POSIX process groups and sh helpers.
posixTest('a commit pushed elsewhere arrives in refs/remotes and FETCH_HEAD; nothing local changes', async () => {
  const { wk, other } = remoteAndClones();
  const pushed = commit(other, 'second', { 'b.txt': 'b\n' });
  git(other, 'push', '-q', 'origin', 'main');
  writeFileSync(join(wk, 'dirty.txt'), 'uncommitted\n');
  git(wk, 'add', 'dirty.txt');
  writeFileSync(join(wk, 'a.txt'), 'edited\n');
  const before = localState(wk);
  const head = git(wk, 'rev-parse', 'HEAD').trim();

  const r = await runFetch(wk, { isolated: true });
  expect(r).toEqual({ outcome: 'ok' });
  expect(git(wk, 'rev-parse', 'refs/remotes/origin/main').trim()).toBe(pushed);
  expect(existsSync(join(wk, '.git', 'FETCH_HEAD'))).toBe(true);
  expect(git(wk, 'rev-parse', 'HEAD').trim()).toBe(head);
  expect(localState(wk)).toEqual(before);
  expect(git(wk, 'status', '--porcelain=v2', '--branch')).toContain('# branch.ab +0 -1');
});

test('no hook runs: a reference-transaction hook (which plain git fetch runs) leaves no marker', async () => {
  const { base, wk, other } = remoteAndClones();
  commit(other, 'second', { 'b.txt': 'b\n' });
  git(other, 'push', '-q', 'origin', 'main');
  const marker = join(base, 'HOOK-RAN');
  const hook = `#!/bin/sh\ntouch '${marker}'\ncat >/dev/null\n`;
  // Sanity: in a third clone, a plain fetch does run that hook (so the test can catch a fetch that would).
  git(base, 'clone', '-q', join(base, 'up.git'), 'sanity');
  const sanity = join(base, 'sanity');
  git(other, 'commit', '-q', '--allow-empty', '-m', 'third');
  git(other, 'push', '-q', 'origin', 'main');
  for (const repo of [sanity, wk]) {
    writeFileSync(join(repo, '.git', 'hooks', 'reference-transaction'), hook);
    chmodSync(join(repo, '.git', 'hooks', 'reference-transaction'), 0o755);
  }
  execFileSync('git', ['fetch', '-q'], { cwd: sanity, env: fixtureGitEnv });
  expect(existsSync(marker)).toBe(true);
  rmSync(marker);

  expect((await runFetch(wk, { isolated: true })).outcome).toBe('ok');
  expect(existsSync(marker)).toBe(false);
});

test('an ext:: remote never runs, even when the repo allows that transport', async () => {
  const { base, wk } = remoteAndClones();
  const marker = join(base, 'EXT-RAN');
  git(wk, 'config', 'protocol.ext.allow', 'always');
  git(wk, 'remote', 'add', 'evil', `ext::sh -c touch% ${marker}`);
  const r = await runFetch(wk, { isolated: true });
  expect(r.outcome).not.toBe('ok');
  expect(existsSync(marker)).toBe(false);
});

test('an HTTP remote asking for credentials fails as auth, at once, without prompting', async () => {
  const url = await http((_req, res) => { res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="x"' }); res.end(); });
  const repo = tmp('atl-fetch-auth-');
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'remote', 'add', 'origin', `${url}/x.git`);
  const t0 = Date.now();
  const r = await runFetch(repo, { isolated: true });
  expect(r.message ?? '').toMatch(/./); expect(r.outcome, r.message).toBe('auth');
  expect(r.message).toBeTruthy();
  expect(Date.now() - t0).toBeLessThan(10_000);
});

test('a remote that never answers: stopped at the timeout, as a network outcome', async () => {
  const url = await http(() => { /* never answers */ });
  const repo = tmp('atl-fetch-slow-');
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'remote', 'add', 'origin', `${url}/x.git`);
  const t0 = Date.now();
  const r = await runFetch(repo, { isolated: true, timeoutMs: 800 });
  expect(r.outcome).toBe('network');
  expect(Date.now() - t0).toBeLessThan(5_000);
});

test('a repo without remotes: nothing to do, ok', async () => {
  const repo = tmp('atl-fetch-none-');
  git(repo, 'init', '-q', '-b', 'main');
  commit(repo, 'one', { 'a.txt': 'a\n' });
  expect(await runFetch(repo, { isolated: true })).toEqual({ outcome: 'ok' });
});

test('a fetch run in a linked worktree counts for the repo and all its worktrees (FETCH_HEAD is per worktree)', async () => {
  const { base, wk, other } = remoteAndClones();
  git(wk, 'worktree', 'add', '-q', join(base, 'wt'), '-b', 'side');
  const wt = join(base, 'wt');
  commit(other, 'second', { 'b.txt': 'b\n' });
  git(other, 'push', '-q', 'origin', 'main');
  expect(await lastFetchAt(join(wk, '.git'))).toBeNull();
  expect((await runFetch(wt, { isolated: true })).outcome).toBe('ok');
  expect(existsSync(join(wk, '.git', 'FETCH_HEAD'))).toBe(false);
  const at = await lastFetchAt(join(wk, '.git'));
  expect(at).not.toBeNull();
  expect(Math.abs(at! - Date.now())).toBeLessThan(10_000);
  expect((await readRefs(wk)).fetchedAt).toBe(at);
  expect((await readRefs(wt)).fetchedAt).toBe(at);
});

describe('autoFetchAllowed: a repo whose own config names a program a fetch would run is fetched by hand only', () => {
  test.each([
    ['remote.origin.uploadpack', 'touch /tmp/never'],
    ['core.sshCommand', 'ssh -i key'],
    ['credential.helper', '!f() { echo; }; f'],
    ['credential.https://example.com.helper', 'store'],
    ['core.gitProxy', '/bin/proxy'],
    ['core.askPass', '/bin/askpass'],
    ['remote.origin.vcs', 'x']
  ])('%s', async (key, value) => {
    const { wk } = remoteAndClones();
    expect(await autoFetchAllowed(wk)).toBe(true);
    git(wk, 'config', key, value);
    expect(await autoFetchAllowed(wk)).toBe(false);
  });
  test('also through an included file', async () => {
    const { base, wk } = remoteAndClones();
    writeFileSync(join(base, 'extra.cfg'), '[remote "origin"]\n\tuploadpack = touch /tmp/never\n');
    git(wk, 'config', 'include.path', join(base, 'extra.cfg'));
    expect(await autoFetchAllowed(wk)).toBe(false);
  });
  test('an ordinary clone with user settings is allowed', async () => {
    const { wk } = remoteAndClones();
    git(wk, 'config', 'user.name', 'x');
    git(wk, 'config', 'fetch.prune', 'true');
    expect(await autoFetchAllowed(wk)).toBe(true);
  });
});

/** A fake `git` first on PATH: it leaves a child in another session holding stderr, then hangs. */
function escapingGit(base: string): string {
  const bin = join(base, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'git'), `#!/usr/bin/perl\nuse POSIX;\nif (fork() == 0) { POSIX::setsid(); sleep 4; exit 0; }\nsleep 30;\n`);
  chmodSync(join(bin, 'git'), 0o755);
  return bin;
}

// POSIX: POSIX process groups and sh helpers.
posixTest('M3: a helper that left the process group (and still holds stderr) never keeps a fetch running past its timeout', async () => {
  const base = tmp('atl-fetch-escape-');
  const bin = escapingGit(base);
  const path = process.env.PATH;
  process.env.PATH = `${bin}:${path ?? ''}`;
  try {
    const t0 = Date.now();
    const r = await runFetch(base, { isolated: true, timeoutMs: 300 });
    expect(r.outcome).toBe('network');
    expect(Date.now() - t0).toBeLessThan(3000);
  } finally { process.env.PATH = path; }
});

test('M8: stopping every fetch (the app quits) ends them at once', async () => {
  const url = await http(() => { /* never answers */ });
  const repo = tmp('atl-fetch-quit-');
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'remote', 'add', 'origin', `${url}/x.git`);
  const p = runFetch(repo, { isolated: true });
  await new Promise((r) => setTimeout(r, 300));
  const t0 = Date.now();
  stopAllFetches();
  expect((await p).outcome).toBe('network');
  expect(Date.now() - t0).toBeLessThan(3000);
});
