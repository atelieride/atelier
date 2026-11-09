import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { pickDefault, readCompare, readContentAt } from './compare';
import { readRepoStatus } from './service';

describe('pickDefault (the branch a review compares against)', () => {
  test("origin/HEAD first: its branch, shown without the remote's name", () => {
    expect(pickDefault({ originHead: 'origin/develop', main: true, master: true })).toEqual({ ref: 'origin/develop', base: 'develop' });
  });
  test('no remote default: a local main, then master', () => {
    expect(pickDefault({ originHead: null, main: true, master: true })).toEqual({ ref: 'main', base: 'main' });
    expect(pickDefault({ originHead: null, main: false, master: true })).toEqual({ ref: 'master', base: 'master' });
  });
  test('nothing to compare against', () => {
    expect(pickDefault({ originHead: null, main: false, master: false })).toBeNull();
    // A broken symbolic ref (origin/HEAD pointing nowhere) is the remote's name alone.
    expect(pickDefault({ originHead: 'origin', main: false, master: false })).toBeNull();
  });
});

// Test repos isolated from the user's git configuration (global hooks, signing…).
const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const git = (cwd: string, ...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd, env: gitEnv, encoding: 'utf8' });

function upstreamAndClone(): { up: string; wk: string } {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'atl-cmp-')));
  const up = join(base, 'up');
  mkdirSync(up);
  git(up, 'init', '-q', '-b', 'main');
  writeFileSync(join(up, 'a.ts'), 'one\ntwo\nthree\n');
  writeFileSync(join(up, 'b.ts'), 'b\n');
  git(up, 'add', '.');
  git(up, 'commit', '-q', '-m', 'first');
  git(base, 'clone', '-q', up, 'wk');
  return { up, wk: join(base, 'wk') };
}

describe('readCompare on real repos', () => {
  test('a feature branch: committed, uncommitted and untracked changes since it left origin/main', async () => {
    const { wk } = upstreamAndClone();
    git(wk, 'checkout', '-q', '-b', 'feat');
    writeFileSync(join(wk, 'a.ts'), 'one\nTWO\nthree\n');
    writeFileSync(join(wk, 'c.ts'), 'new\n');
    git(wk, 'add', '.');
    git(wk, 'commit', '-q', '-m', 'feature');
    writeFileSync(join(wk, 'b.ts'), 'b\nmore\n');
    writeFileSync(join(wk, 'u.ts'), 'u1\nu2\n');
    const status = await readRepoStatus(wk);
    const r = await readCompare(wk, status);
    expect(r).toMatchObject({ ok: true, base: 'main', ref: 'origin/main', commits: 1 });
    if (!r.ok) throw new Error('expected ok');
    expect(r.mergeBase).toBe(git(wk, 'rev-parse', 'origin/main').trim());
    expect(r.changes.map((c) => [c.rel, c.kind, c.added, c.removed])).toEqual([
      ['a.ts', 'M', 1, 1], ['b.ts', 'M', 1, 0], ['c.ts', 'A', 1, 0], ['u.ts', '?', 2, 0]
    ]);
    // The base side of a review: the file as it was where the branch started.
    expect(await readContentAt(wk, r.mergeBase, 'a.ts')).toBe('one\ntwo\nthree\n');
    expect(await readContentAt(wk, r.mergeBase, 'c.ts')).toBeNull();
  });

  test('on the default branch: not offered', async () => {
    const { wk } = upstreamAndClone();
    expect(await readCompare(wk, await readRepoStatus(wk))).toEqual({ root: wk, ok: false, reason: 'on-default' });
  });

  test('no remote: a local main is the default; without main or master there is nothing to compare', async () => {
    const { up } = upstreamAndClone();
    git(up, 'checkout', '-q', '-b', 'feat');
    expect(await readCompare(up, await readRepoStatus(up))).toMatchObject({ ok: true, base: 'main', ref: 'main', commits: 0, changes: [] });
    git(up, 'branch', '-q', '-m', 'main', 'trunk');
    expect(await readCompare(up, await readRepoStatus(up))).toEqual({ root: up, ok: false, reason: 'no-default' });
  });

  test('a repo without commits', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'atl-cmp-empty-')));
    git(dir, 'init', '-q', '-b', 'feat');
    expect(await readCompare(dir, await readRepoStatus(dir))).toEqual({ root: dir, ok: false, reason: 'no-head' });
  });

  test('readContentAt: only commit ids or HEAD, never other revision syntax or paths outside the repo', async () => {
    const { wk } = upstreamAndClone();
    expect(await readContentAt(wk, 'HEAD', 'b.ts')).toBe('b\n');
    expect(await readContentAt(wk, 'main~0', 'b.ts')).toBeNull();
    expect(await readContentAt(wk, '--output=/tmp/x', 'b.ts')).toBeNull();
    expect(await readContentAt(wk, 'HEAD', '../b.ts')).toBeNull();
    expect(await readContentAt(wk, 'HEAD', '/etc/hosts')).toBeNull();
  });
});
