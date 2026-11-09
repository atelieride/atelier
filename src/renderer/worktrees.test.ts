import { describe, expect, test } from 'vitest';
import type { FileChange, RepoStatus } from '@shared/git';
import type { ChangeBy, ChangeRow } from './changes';
import { branchLabel, worktreeAt, worktreeCommands, hideWorktreeFolders, isWorktree, locationOf, meetGroups, nestWorktrees, realPath, showLocations, treeOf } from './worktrees';

const ch = (root: string, rel: string, kind: FileChange['kind'] = 'M'): FileChange => ({ path: `${root}/${rel}`, rel, kind, stage: 'none', added: 1, removed: 0 });
const st = (root: string, o: Partial<RepoStatus> = {}): RepoStatus => ({
  root, name: root.split('/').at(-1)!, branch: 'main', detached: false, ahead: 0, behind: 0, changes: [], oid: 'a'.repeat(40), checkedAt: 0, truncated: 0, worktreeOf: null, merge: null, ...o
});
const row = (repo: string, rel: string, by: ChangeBy[] = []): ChangeRow => ({ ...ch(repo, rel), repo, by });
const who = (id: string, title: string, o: Partial<ChangeBy> = {}): ChangeBy => ({ terminalId: id, color: '#fff', title, ...o });

const P = '/p';
const VAD = '/p/.claude/worktrees/vad';
const OLD = '/p/.worktrees/old';
const main = (o: Partial<RepoStatus> = {}) => st(P, o);
const vad = (o: Partial<RepoStatus> = {}) => st(VAD, { branch: 'worktree-vad', worktreeOf: P, ...o });
const merge = (files: string[], commits = files.length, merged = false) => ({ base: 'main', commits, files, truncated: 0, merged });

describe('hideWorktreeFolders', () => {
  test("drops a repo's untracked entry that is a shown worktree's folder, with or without its trailing slash", () => {
    const repos = [main({ changes: [ch(P, '.claude/worktrees/vad/', '?'), ch(P, '.worktrees/old', '?'), ch(P, 'notes.md', '?'), ch(P, 'src/a.ts')] }), vad(), st(OLD, { worktreeOf: P })];
    expect(hideWorktreeFolders(repos)[0]!.changes.map((c) => c.rel)).toEqual(['notes.md', 'src/a.ts']);
  });
  test('keeps the same objects when there is nothing to hide', () => {
    const repos = [main({ changes: [ch(P, 'a.ts')] })];
    expect(hideWorktreeFolders(repos)[0]).toBe(repos[0]);
  });
});

describe('nestWorktrees', () => {
  test('each worktree under its repo, by name; a clean repo shows for a worktree with files; idle ones apart', () => {
    const repos = [main(), st('/p/api'), vad({ changes: [ch(VAD, 'src/store.ts')] }), st('/p/.claude/worktrees/abc', { worktreeOf: P, changes: [ch('/p/.claude/worktrees/abc', 'x.ts')] }), st(OLD, { worktreeOf: P })];
    const rows = [row(VAD, 'src/store.ts'), row('/p/.claude/worktrees/abc', 'x.ts')];
    const { families, idle } = nestWorktrees(repos, rows);
    expect(families.map((f) => [f.repo.root, f.rows.length, f.worktrees.map((w) => [w.name, w.state, w.rows.length])])).toEqual([
      [P, 0, [['abc', 'files', 1], ['vad', 'files', 1]]]
    ]);
    expect(idle.map((w) => w.name)).toEqual(['old']);
  });
  test('a clean worktree with commits to merge is shown as "merge"; one with nothing is idle', () => {
    const { families, idle } = nestWorktrees([main(), vad({ merge: merge(['a.ts'], 3) }), st(OLD, { worktreeOf: P, merge: merge([], 0) })], []);
    expect(families[0]!.worktrees.map((w) => [w.name, w.state])).toEqual([['vad', 'merge']]);
    expect(idle.map((w) => w.name)).toEqual(['old']);
  });
  test('a squash-merged worktree (commits ahead, nothing left to merge) is idle, with no ↑ and no compare', () => {
    const repos = [main(), vad({ merge: merge([], 3, true) })];
    expect(nestWorktrees(repos, []).idle.map((w) => w.name)).toEqual(['vad']);
    expect(worktreeCommands(repos).map((c) => c.kind)).toEqual(['review']);
  });
  test('repos without worktrees keep today\'s rule: shown only with changes', () => {
    const repos = [main({ changes: [ch(P, 'a.ts')] }), st('/p/api')];
    expect(nestWorktrees(repos, [row(P, 'a.ts')]).families.map((f) => f.repo.root)).toEqual([P]);
  });
});

test('treeOf: the deepest working tree containing a path; isWorktree; branchLabel', () => {
  const repos = [main(), vad()];
  expect(treeOf(repos, `${VAD}/src/a.ts`)?.root).toBe(VAD);
  expect(treeOf(repos, `${P}/src/a.ts`)?.root).toBe(P);
  expect(treeOf(repos, VAD)?.root).toBe(VAD);
  expect(treeOf(repos, '/elsewhere/a.ts')).toBeNull();
  expect(treeOf(repos, '/p/.claude/worktrees/vadx/a.ts')?.root).toBe(P);
  expect(isWorktree(repos[1]!)).toBe(true);
  expect(isWorktree(repos[0]!)).toBe(false);
  expect(isWorktree(null)).toBe(false);
  expect(branchLabel(vad())).toBe('worktree-vad');
  // Two detached worktrees must be told apart (the violet card names both): the short commit id.
  expect(branchLabel(vad({ branch: null, detached: true, oid: '3f2a1c9'.padEnd(40, '0') }))).toBe('detached 3f2a1c9');
  expect(branchLabel(vad({ branch: null, detached: true, oid: null }))).toBe('detached');
});

test('realPath: a path under the project as opened becomes the real one (as git and the statuses have it)', () => {
  const proj = { root: '/var/x/p', realRoot: '/private/var/x/p' };
  expect(realPath('/var/x/p/.claude/worktrees/vad', proj)).toBe('/private/var/x/p/.claude/worktrees/vad');
  expect(realPath('/var/x/p', proj)).toBe('/private/var/x/p');
  expect(realPath('/var/x/pp', proj)).toBe('/var/x/pp');
  expect(realPath('/a', null)).toBe('/a');
});

describe('meetGroups', () => {
  const alfa = who('t1', 'Changes polish');
  const beta = who('t2', 'Dictation VAD');
  const order = ['t1', 't2', 't3'];

  test('a file changed in the main checkout and committed on a worktree branch: one group, both sides named', () => {
    const repos = [main({ changes: [ch(P, 'src/layout.css')] }), vad({ merge: merge(['src/layout.css', 'src/vad.ts']) })];
    const rows = [row(P, 'src/layout.css', [alfa])];
    expect(meetGroups(repos, rows, order)).toEqual([{
      key: `${P}|${VAD}`,
      sides: [{ root: P, branch: 'main', names: ['Changes polish'] }, { root: VAD, branch: 'worktree-vad', names: [] }],
      files: ['src/layout.css']
    }]);
  });
  test('dirty on both sides: names from sure attributions only, in session order', () => {
    const repos = [main({ changes: [ch(P, 'a.ts')] }), vad({ changes: [ch(VAD, 'a.ts')] })];
    const rows = [row(P, 'a.ts', [beta, alfa]), row(VAD, 'a.ts', [who('t3', 'Gamma', { unclear: ['x'] }), beta])];
    expect(meetGroups(repos, rows, order)[0]!.sides.map((s) => s.names)).toEqual([['Changes polish', 'Dictation VAD'], ['Dictation VAD']]);
  });
  test('three branches on one file: one group with three sides', () => {
    const repos = [main({ changes: [ch(P, 'a.ts')] }), vad({ changes: [ch(VAD, 'a.ts')] }), st(OLD, { worktreeOf: P, branch: 'old', merge: merge(['a.ts']) })];
    expect(meetGroups(repos, [], order).map((g) => g.sides.map((s) => s.branch))).toEqual([['main', 'old', 'worktree-vad']]);
  });
  test('never across different repos, never within one working tree, never on paths only one side has', () => {
    const repos = [main({ changes: [ch(P, 'a.ts'), ch(P, 'b.ts')] }), st('/p/api', { changes: [ch('/p/api', 'a.ts')] }), vad({ changes: [ch(VAD, 'c.ts')] })];
    expect(meetGroups(repos, [], order)).toEqual([]);
  });
});

describe('locations', () => {
  const repos = [main(), vad()];
  test('a live session is where its cwd is; a closed one where all its rows are; rows in two trees: unknown', () => {
    expect(locationOf(`${VAD}/src`, [], repos)?.root).toBe(VAD);
    expect(locationOf(null, [row(VAD, 'a.ts'), row(VAD, 'b.ts')], repos)?.root).toBe(VAD);
    expect(locationOf(null, [row(VAD, 'a.ts'), row(P, 'b.ts')], repos)).toBeNull();
    expect(locationOf('/elsewhere', [row(P, 'b.ts')], repos)?.root).toBe(P);
  });
  test('pills only when the sessions are not all in the same working tree', () => {
    expect(showLocations([repos[0]!, repos[0]!, null])).toBe(false);
    expect(showLocations([repos[0]!, repos[1]!])).toBe(true);
    expect(showLocations([null, repos[1]!])).toBe(false);
  });
  test('two repos without worktrees (app and api, both on main): no pills, they would only say "main" twice', () => {
    expect(showLocations([st('/p/app'), st('/p/api')])).toBe(false);
    expect(showLocations([st('/p/app'), st('/p/api', { worktreeOf: null }), vad()])).toBe(true);
  });
});

test('worktreeAt: the linked worktree a path is in, with its name and the path inside it; none in a main checkout', () => {
  const repos = [main(), vad()];
  expect(worktreeAt(repos, `${VAD}/src/store.ts`)).toEqual({ root: VAD, name: 'vad', rel: 'src/store.ts' });
  expect(worktreeAt(repos, VAD)).toEqual({ root: VAD, name: 'vad', rel: '' });
  expect(worktreeAt(repos, `${P}/src/store.ts`)).toBeNull();
  expect(worktreeAt(repos, '/elsewhere')).toBeNull();
});

test('worktreeCommands: like its menu — Review for every worktree, Compare only with commits to merge', () => {
  const repos = [main(), vad({ merge: merge(['a.ts'], 2) }), st(OLD, { worktreeOf: P, branch: 'old', merge: merge([], 0) })];
  expect(worktreeCommands(repos)).toEqual([
    { key: `review-wt-${VAD}`, kind: 'review', name: 'vad', branch: 'worktree-vad', scope: `repo:${VAD}` },
    { key: `compare-wt-${VAD}`, kind: 'compare', name: 'vad', branch: 'worktree-vad', scope: `repo:${VAD}`, base: 'main' },
    { key: `review-wt-${OLD}`, kind: 'review', name: 'old', branch: 'old', scope: `repo:${OLD}` }
  ]);
});
