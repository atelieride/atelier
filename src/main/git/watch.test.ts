import { describe, expect, test, vi } from 'vitest';
import { Debouncer, classifyChange, gitChangeScope, gitDirOf, needsRediscovery, repoOf, scmChange, worktreeListChange } from './watch';

describe('needsRediscovery', () => {
  // The project's working trees by their path inside it, and what is on disk now: repositories and plain folders.
  const known = new Set(['hub', 'old-tools', 'web', '']);
  const repos = new Set(['hub', '', 'new-tools', 'hub/guides']);
  const dirs = new Set([...repos, 'web', 'drafts', 'group', 'a/b/c', 'hub/src']);
  const probe = { isRepoDir: (rel: string) => repos.has(rel), isDir: (rel: string) => dirs.has(rel) };
  test.each([
    ['a git dir of a folder no working tree is', 'hub/guides/.git/HEAD', false, true],
    ['the same with Windows separators', 'hub\\guides\\.git\\HEAD', false, true],
    ['a .git file appearing (a linked worktree or a submodule)', 'tools/.git', true, true],
    ['git internals of a known repository', 'hub/.git/HEAD', false, false],
    ['git objects of a known repository', 'hub/.git/objects/ab/cd', true, false],
    ['a known repository\'s .git removed, its folder kept', 'web/.git', true, true],
    ['a known repository\'s .git still there', 'hub/.git', false, false],
    ['a git dir deeper than the depth', 'a/b/c/d/.git/HEAD', false, false],
    ['a submodule inside the root repository', '.git/modules/lib/HEAD', false, false],
    ['a worktree in a hidden folder (discovery skips those; the worktree listing finds it)', '.claude/worktrees/x/.git', true, false],
    ['a package inside node_modules', 'web/node_modules/p/.git/HEAD', true, false],
    ['a known repository whose folder is gone (renamed, deleted)', 'old-tools', true, true],
    ['a file in a known repository', 'hub/notes.md', true, false],
    ['a repository moved or renamed in', 'new-tools', true, true],
    ['the same path only written to (no folder came): nothing to look at', 'new-tools', false, false],
    ['a folder that may hold repositories moved in', 'group', true, true],
    ['a new folder at the depth that is no repository', 'a/b/c', true, false],
    ['a new folder deeper than the depth', 'a/b/c/d', true, false],
    ['a file created at the root', 'notes.md', true, false]
  ])('%s: %s', (_what, rel, created, want) => {
    expect(needsRediscovery(rel, known, 3, probe, created)).toBe(want);
  });

  test('a folder above a known repository going away', () => {
    const none = { isRepoDir: () => false, isDir: () => false };
    expect(needsRediscovery('team', new Set(['team/api']), 3, none, true)).toBe(true);
    expect(needsRediscovery('team', new Set(['team/api']), 3, { isRepoDir: (r) => r === 'team/api', isDir: (r) => r === 'team' }, false)).toBe(false);
  });
});

describe('classifyChange', () => {
  test.each([
    ['src/App.tsx', 'file'],
    ['app-ui/src/App.tsx', 'file'],
    ['node_modules/x/index.js', 'ignore'],
    ['app-ui/node_modules/x/a.js', 'ignore'],
    ['app-ui/.git/HEAD', 'git'],
    ['app-ui/.git/index', 'git'],
    ['app-ui/.git/refs/heads/dev', 'git'],
    ['.git/HEAD', 'git'],
    ['app-ui/.git/objects/ab/cdef', 'ignore'],
    ['app-ui/.git/index.lock', 'ignore'],
    ['app-ui/.git/logs/HEAD', 'ignore'],
    ['.DS_Store', 'ignore'],
    // Source Control: packed refs, fetches and linked worktrees' HEADs.
    ['.git/packed-refs', 'git'],
    ['.git/FETCH_HEAD', 'git'],
    ['sub/.git/FETCH_HEAD', 'git'],
    ['.git/worktrees/v2.2/HEAD', 'git'],
    ['.git/worktrees/v2.2/index.lock', 'ignore'],
    ['.git/worktrees/v2.2/logs/HEAD', 'ignore'],
    // Worktrees in Changes: a commit inside a linked worktree writes its index in the main repo's .git.
    ['.git/worktrees/v2.2/index', 'git'],
    // A worktree removed: its admin folder goes, maybe reported as the folder alone.
    ['.git/worktrees/v2.2', 'git'],
    ['.git/worktrees', 'git'],
    // A submodule's git dir lives in its superproject's .git/modules/<name> (a name may hold slashes, or nest).
    ['.git/modules/lib/index', 'git'],
    ['.git/modules/lib/HEAD', 'git'],
    ['.git/modules/lib/refs/heads/x', 'git'],
    ['.git/modules/libs/ui/packed-refs', 'git'],
    ['.git/modules/a/modules/b/index', 'git'],
    ['.git/modules/lib/objects/ab/cdef', 'ignore'],
    ['.git/modules/lib/logs/refs/heads/x', 'ignore'],
    ['.git/modules/lib/index.lock', 'ignore'],
    ['.git/modules/lib', 'ignore'],
    // config: an upstream set (branch -u) or a remote added; reftable: every ref and HEAD in a reftable repo.
    ['.git/config', 'git'],
    ['.git/config.lock', 'ignore'],
    ['.git/reftable/tables.list', 'git'],
    ['.git/reftable/tables.list.lock', 'ignore']
  ])('%s → %s', (rel, kind) => expect(classifyChange('/p', rel)).toBe(kind));
});

test('gitDirOf: the git dir a changed path lies in, a submodule’s included', () => {
  expect(gitDirOf('app/.git/refs/heads/x')).toBe('app/.git');
  expect(gitDirOf('.git/worktrees/v2/index')).toBe('.git');
  expect(gitDirOf('.git/modules/lib/refs/heads/x')).toBe('.git/modules/lib');
  expect(gitDirOf('.git/modules/libs/ui/HEAD')).toBe('.git/modules/libs/ui');
  expect(gitDirOf('app/.git/modules/a/modules/b/index')).toBe('app/.git/modules/a/modules/b');
  expect(gitDirOf('src/a.ts')).toBeNull();
});

test('scmChange: a submodule’s refs, config and reftable are refs changes of their own git dir', () => {
  expect(scmChange('.git/modules/lib/refs/heads/x')).toEqual({ gitDir: '.git/modules/lib', what: 'refs', worktree: false });
  expect(scmChange('.git/modules/lib/HEAD')).toEqual({ gitDir: '.git/modules/lib', what: 'head', worktree: false });
  expect(scmChange('.git/config')).toEqual({ gitDir: '.git', what: 'refs', worktree: false });
  expect(scmChange('.git/reftable/tables.list')).toEqual({ gitDir: '.git', what: 'refs', worktree: false });
  expect(scmChange('.git/modules/lib/objects/ab/cd')).toBeNull();
});

test('worktreeListChange: a linked worktree added or removed (its admin folder or HEAD)', () => {
  expect(worktreeListChange('.git/worktrees/v2')).toBe(true);
  expect(worktreeListChange('app/.git/worktrees/v2/HEAD')).toBe(true);
  expect(worktreeListChange('.git/worktrees')).toBe(true);
  expect(worktreeListChange('.git/worktrees/v2/index')).toBe(false);
  expect(worktreeListChange('.git/HEAD')).toBe(false);
  expect(worktreeListChange('src/worktrees/v2')).toBe(false);
  expect(worktreeListChange('.git/modules/lib/worktrees/v2')).toBe(true);
});

test('gitChangeScope: which working trees of a repo a git change can move', () => {
  expect(gitChangeScope('.git/refs/heads/main')).toBe('all');
  expect(gitChangeScope('app/.git/packed-refs')).toBe('all');
  expect(gitChangeScope('.git/FETCH_HEAD')).toBe('all');
  expect(gitChangeScope('.git/worktrees/vad/index')).toBe('linked');
  expect(gitChangeScope('.git/worktrees/vad/HEAD')).toBe('linked');
  expect(gitChangeScope('.git/HEAD')).toBe('own');
  expect(gitChangeScope('.git/index')).toBe('own');
  expect(gitChangeScope('.git/modules/lib/index')).toBe('own');
  expect(gitChangeScope('.git/modules/lib/refs/heads/x')).toBe('all');
  expect(gitChangeScope('.git/config')).toBe('all');
  expect(gitChangeScope('src/a.ts')).toBeNull();
});

test('repoOf: the deepest repo', () => {
  const repos = ['/p', '/p/app-ui', '/p/app-ui/sub'];
  expect(repoOf(repos, '/p/app-ui/sub/a.ts')).toBe('/p/app-ui/sub');
  expect(repoOf(repos, '/p/app-ui/src/a.ts')).toBe('/p/app-ui');
  expect(repoOf(repos, '/p/x.ts')).toBe('/p');
  expect(repoOf(['/p/app-ui'], '/p/altro/a.ts')).toBeNull();
  expect(repoOf(['/p/app'], '/p/app-ui/a.ts')).toBeNull();
});

test('Debouncer: a burst becomes a single delivery with all the keys', () => {
  vi.useFakeTimers();
  const got: Set<string>[] = [];
  const d = new Debouncer(300, (k) => got.push(k));
  for (let i = 0; i < 1000; i++) d.add(`k${i % 3}`);
  vi.advanceTimersByTime(299);
  expect(got).toHaveLength(0);
  vi.advanceTimersByTime(1);
  expect(got).toEqual([new Set(['k0', 'k1', 'k2'])]);
  vi.useRealTimers();
});

test('Debouncer: a delivery says when its last key came (later than its first, earlier than the delivery)', () => {
  vi.useFakeTimers();
  const got: [Set<string>, number][] = [];
  const d = new Debouncer(300, (k, last) => got.push([k, last]));
  const t0 = Date.now();
  d.add('a');
  vi.advanceTimersByTime(120);
  d.add('b');
  vi.advanceTimersByTime(300);
  expect(got).toEqual([[new Set(['a', 'b']), t0 + 120]]);
  vi.useRealTimers();
});

test('Debouncer with max wait: continuous writes do not block delivery', () => {
  vi.useFakeTimers();
  const got: Set<string>[] = [];
  const d = new Debouncer(300, (k) => got.push(k), 1500);
  // one write every 100 ms for 4 s: without a max wait it would never deliver
  for (let t = 0; t < 4000; t += 100) { d.add('log.txt'); vi.advanceTimersByTime(100); }
  expect(got.length).toBeGreaterThanOrEqual(2);
  vi.useRealTimers();
});

describe('scmChange', () => {
  test.each([
    ['.git/HEAD', { gitDir: '.git', what: 'head', worktree: false }],
    ['app/.git/HEAD', { gitDir: 'app/.git', what: 'head', worktree: false }],
    ['.git/refs/heads/feat/x', { gitDir: '.git', what: 'refs', worktree: false }],
    ['.git/refs/tags/v1', { gitDir: '.git', what: 'refs', worktree: false }],
    ['.git/packed-refs', { gitDir: '.git', what: 'refs', worktree: false }],
    ['.git/FETCH_HEAD', { gitDir: '.git', what: 'fetch', worktree: false }],
    ['.git/worktrees/v2.2/HEAD', { gitDir: '.git', what: 'head', worktree: true }],
    // FETCH_HEAD is per worktree: a fetch run in a linked one writes it in its admin folder.
    ['.git/worktrees/v2.2/FETCH_HEAD', { gitDir: '.git', what: 'fetch', worktree: false }],
    ['.git/index', null],
    ['.git/objects/ab/cd', null],
    ['.git/refs/heads/x.lock', null],
    ['.git/logs/HEAD', null],
    ['src/a.ts', null]
  ])('%s', (rel, want) => expect(scmChange(rel)).toEqual(want));
});
