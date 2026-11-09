import { describe, expect, test } from 'vitest';
import type { FileChange, RepoStatus } from '@shared/git';
import type { ScmRepoEntry } from '@shared/scm';
import { allRows, blockView, firstLine, foldedOf, hasBody, idleTip, runningLabel, syncAbility, syncTotals, viewCommand, withFirstLine } from './all-view';

// Source Control's All Repositories view: the order of the blocks, what each
// header marks and which one button each block shows. Nothing here moves a block by itself.

const ch = (rel: string): FileChange => ({ path: `/p/${rel}`, rel, kind: 'M', stage: 'none', added: 1, removed: 0 });
const st = (root: string, o: Partial<RepoStatus> = {}): RepoStatus => ({
  root, name: root.split('/').pop()!, branch: 'dev', detached: false, ahead: 0, behind: 0, upstream: 'origin/dev', changes: [], oid: 'a'.repeat(40), checkedAt: 1, truncated: 0, ...o
});
const entry = (root: string, rel: string, worktreeOf: string | null = null): ScmRepoEntry => ({ root, rel, name: rel.split('/').pop()!, worktreeOf, common: `${worktreeOf ?? root}/.git`, status: null });
const commit = { staged: 0, offered: false, block: null };

describe('allRows', () => {
  const repos = [st('/p/web'), st('/p/api'), st('/p/api/.worktrees/x', { worktreeOf: '/p/api' })];
  const entries = [entry('/p/web', 'web'), entry('/p/api', 'api'), entry('/p/api/.worktrees/x', 'api/.worktrees/x', '/p/api')];

  test('repositories by their label, each followed by its worktrees', () => {
    expect(allRows(repos, entries).map((r) => [r.name, r.worktree])).toEqual([['api', false], ['x', true], ['web', false]]);
  });

  test('a working tree added keeps everyone else where they were', () => {
    const more = [...repos, st('/p/billing'), st('/p/api/.worktrees/a', { worktreeOf: '/p/api' })];
    const ents = [...entries, entry('/p/billing', 'billing'), entry('/p/api/.worktrees/a', 'api/.worktrees/a', '/p/api')];
    expect(allRows(more, ents).map((r) => r.name)).toEqual(['api', 'a', 'x', 'billing', 'web']);
  });

  test("a worktree whose repository isn't listed sorts as a repository; no entry yet: the status' name", () => {
    const orphan = [st('/p/web'), st('/p/b-wt', { worktreeOf: '/elsewhere' })];
    expect(allRows(orphan, null).map((r) => [r.name, r.worktree])).toEqual([['b-wt', false], ['web', false]]);
  });

  test('a folder part dims before the name, and orders with it', () => {
    const nested = [st('/p/services/mailer'), st('/p/api')];
    const rows = allRows(nested, [entry('/p/services/mailer', 'services/mailer'), entry('/p/api', 'api')]);
    expect(rows.map((r) => [r.dir, r.name])).toEqual([['', 'api'], ['services/', 'mailer']]);
  });
});

describe('blockView', () => {
  test('an op running wins over everything', () => {
    expect(blockView({ status: st('/p/a', { behind: 2 }), running: 'pull', hasRemote: true, commit: { staged: 3, offered: true, block: null } }).button).toEqual({ kind: 'running', op: 'pull' });
  });

  test('files staged: Commit with their count, its block reason kept for the tooltip', () => {
    expect(blockView({ status: st('/p/a', { behind: 1 }), running: null, hasRemote: true, commit: { staged: 2, offered: true, block: 'Write a message first' } }).button)
      .toEqual({ kind: 'commit', staged: 2, block: 'Write a message first' });
  });

  test('nothing staged but a commit possible (the setting asks or stages all): Commit without a count', () => {
    expect(blockView({ status: st('/p/a', { changes: [ch('a.ts')], behind: 1 }), running: null, hasRemote: true, commit: { staged: 0, offered: true, block: null } }).button)
      .toEqual({ kind: 'commit', staged: 0, block: null });
  });

  test("nothing staged and the setting says Don't commit: the sync button when there is something to sync", () => {
    expect(blockView({ status: st('/p/a', { changes: [ch('a.ts')], behind: 1 }), running: null, hasRemote: true, commit: { staged: 0, offered: false, block: 'Nothing staged' } }).button)
      .toEqual({ kind: 'sync', action: 'pull' });
  });

  test('the sync button says what it does: Pull, Push, or Sync with both', () => {
    expect(blockView({ status: st('/p/a', { behind: 2 }), running: null, hasRemote: true, commit }).button).toEqual({ kind: 'sync', action: 'pull' });
    expect(blockView({ status: st('/p/a', { ahead: 1 }), running: null, hasRemote: true, commit }).button).toEqual({ kind: 'sync', action: 'push' });
    expect(blockView({ status: st('/p/a', { ahead: 1, behind: 1 }), running: null, hasRemote: true, commit }).button).toEqual({ kind: 'sync', action: 'sync' });
  });

  test('the ↓↑ counts show once: on the button when it pulls, pushes or syncs (running too), else on the header', () => {
    expect(blockView({ status: st('/p/a', { behind: 2 }), running: null, hasRemote: true, commit }).countsOn).toBe('button');
    expect(blockView({ status: st('/p/a', { behind: 2 }), running: 'pull', hasRemote: true, commit }).countsOn).toBe('button');
    expect(blockView({ status: st('/p/a', { behind: 1 }), running: null, hasRemote: true, commit: { staged: 1, offered: false, block: null } }).countsOn).toBe('head');
    expect(blockView({ status: st('/p/a', { ahead: 1 }), running: 'commit', hasRemote: true, commit }).countsOn).toBe('head');
  });

  test('ahead or behind its own upstream: the sync button; no upstream with a remote: Publish; none: idle', () => {
    expect(blockView({ status: st('/p/a', { ahead: 1 }), running: null, hasRemote: true, commit }).button).toMatchObject({ kind: 'sync' });
    expect(blockView({ status: st('/p/a', { upstream: null }), running: null, hasRemote: true, commit }).button).toEqual({ kind: 'publish' });
    expect(blockView({ status: st('/p/a', { upstream: null }), running: null, hasRemote: false, commit }).button).toEqual({ kind: 'idle' });
    expect(blockView({ status: st('/p/a', { upstream: 'origin/main' }), running: null, hasRemote: true, commit }).button).toEqual({ kind: 'publish' });
    expect(blockView({ status: st('/p/a', { detached: true, branch: null }), running: null, hasRemote: true, commit }).button).toEqual({ kind: 'idle' });
  });

  test('the marks: files changed (past the cap too), what to pull and push, clean only with neither', () => {
    const v = blockView({ status: st('/p/a', { changes: [ch('a.ts'), ch('b.ts')], truncated: 3, ahead: 1, behind: 2 }), running: null, hasRemote: true, commit });
    expect(v).toMatchObject({ changes: 5, ahead: 1, behind: 2, clean: false, error: null });
    expect(blockView({ status: st('/p/a'), running: null, hasRemote: true, commit })).toMatchObject({ changes: 0, ahead: 0, behind: 0, clean: true, button: { kind: 'idle' } });
    // A branch tracking another name: its counts mean nothing to Sync.
    expect(blockView({ status: st('/p/a', { upstream: 'origin/main', ahead: 4 }), running: null, hasRemote: true, commit })).toMatchObject({ ahead: 0, clean: true });
  });

  test('a status git could not read: its error, no counts, nothing to click', () => {
    const v = blockView({ status: st('/p/a', { error: 'fatal: not a git repository', behind: 1 }), running: null, hasRemote: true, commit: { staged: 1, offered: true, block: null } });
    expect(v).toMatchObject({ error: 'fatal: not a git repository', clean: false, behind: 0, button: { kind: 'idle' } });
  });
});

test("syncTotals: what Sync All would move — upstreams of their own name, never a diverged branch (main's Sync All skips it)", () => {
  expect(syncTotals([st('/p/a', { behind: 2 }), st('/p/b', { ahead: 1, behind: 1 }), st('/p/c', { upstream: 'origin/main', behind: 5 }), st('/p/d', { behind: 4, upstreamGone: true }), st('/p/e', { ahead: 3 })]))
    .toEqual({ ahead: 3, behind: 2 });
});

describe('the field and its draft: one line shown, the body kept', () => {
  test('firstLine shows the subject; withFirstLine writes it back over the subject, keeping the body', () => {
    expect(firstLine('feat: x\n\nThe body.')).toBe('feat: x');
    expect(firstLine('')).toBe('');
    expect(withFirstLine('feat: x\n\nThe body.', 'feat: y')).toBe('feat: y\n\nThe body.');
    expect(withFirstLine('feat: x', 'feat: y')).toBe('feat: y');
    expect(hasBody('feat: x\n\nThe body.')).toBe(true);
    expect(hasBody('feat: x\n')).toBe(false);
  });
});

test("idleTip: the error git gave first, then 'in sync', then why Commit can't run", () => {
  const base = { changes: 0, ahead: 0, behind: 0, clean: false, error: null, button: { kind: 'idle' as const }, countsOn: 'head' as const };
  expect(idleTip({ ...base, error: 'fatal: bad object' }, 'Nothing staged')).toBe("Git couldn't read it: fatal: bad object");
  expect(idleTip({ ...base, clean: true }, 'Nothing staged')).toBe('In sync, nothing to commit');
  expect(idleTip(base, 'Nothing staged')).toBe('Nothing staged');
});

test('runningLabel: every op a block can show running has its own words', () => {
  expect(runningLabel('pull')).toBe('Pulling…');
  expect(runningLabel('commit')).toBe('Committing…');
  expect(runningLabel('switch')).toBe('Switch…');
  expect(runningLabel('stashPush')).toBe('Stash…');
});

test('syncAbility: Pull and Push off on a detached HEAD or without a remote, Fetch off without a remote', () => {
  expect(syncAbility(st('/p/a'), true)).toEqual({ pull: null, push: null, fetch: null });
  expect(syncAbility(st('/p/a', { detached: true, branch: null }), true)).toEqual({ pull: 'Not on a branch', push: 'Not on a branch', fetch: null });
  expect(syncAbility(st('/p/a', { upstream: null }), false)).toEqual({ pull: 'No remote', push: 'No remote', fetch: 'No remote' });
});

test('viewCommand: the palette offers the other view, and none with a single repository', () => {
  expect(viewCommand('one', 3)).toEqual({ key: 'scm-view-all', to: 'all' });
  expect(viewCommand('all', 3)).toEqual({ key: 'scm-view-one', to: 'one' });
  expect(viewCommand('one', 1)).toBeNull();
  expect(viewCommand('all', 1)).toBeNull();
});

test('foldedOf: worktrees start folded, repositories open; a fold by hand wins both ways', () => {
  const repo = { root: '/p/a', name: 'a', dir: '', worktree: false, status: st('/p/a') };
  const wt = { ...repo, root: '/p/a/wt', worktree: true };
  expect([foldedOf(repo, {}), foldedOf(wt, {})]).toEqual([false, true]);
  expect([foldedOf(repo, { '/p/a': true }), foldedOf(wt, { '/p/a/wt': false })]).toEqual([true, false]);
});
