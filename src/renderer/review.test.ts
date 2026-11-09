import { describe, expect, test } from 'vitest';
import type { RepoCompare, RepoStatus } from '@shared/git';
import type { Attribution } from '@shared/attribution';
import { unifiedDoc } from './editor/linediff';
import { baseRevOf, compactDoc, compareAvailable, hunksOf, navStops, reviewBody, reviewRows, reviewScopeTitle, stepNav } from './review';

const lines = (n: number, tag = 'l') => Array.from({ length: n }, (_, i) => `${tag}${i + 1}`).join('\n') + '\n';

describe('hunksOf: the changed regions of a unified diff with 3 lines of context', () => {
  test('two far changes are two hunks, with git-style ranges', () => {
    const before = lines(30);
    const after = before.replace('l5\n', 'L5\n').replace('l25\n', 'l25\nadded\n');
    const doc = unifiedDoc(before, after)!;
    const h = hunksOf(doc);
    expect(h.map((x) => [x.oldStart, x.oldLines, x.newStart, x.newLines])).toEqual([[2, 7, 2, 7], [23, 6, 23, 7]]);
    // Rows of the full diff each hunk covers (half-open).
    expect(doc.lines.slice(h[0]!.from, h[0]!.to).filter((l) => l.kind !== 'ctx')).toHaveLength(2);
  });
  test('close changes merge into one hunk; context clipped at the edges of the file', () => {
    const before = lines(10);
    const after = before.replace('l1\n', 'L1\n').replace('l6\n', 'L6\n');
    const h = hunksOf(unifiedDoc(before, after)!);
    expect(h.map((x) => [x.oldStart, x.oldLines, x.newStart, x.newLines])).toEqual([[1, 9, 1, 9]]);
  });
  test('a new file is one hunk of additions; identical texts have none', () => {
    expect(hunksOf(unifiedDoc('', 'a\nb\n')!).map((x) => [x.oldStart, x.oldLines, x.newStart, x.newLines])).toEqual([[0, 0, 1, 2]]);
    expect(hunksOf(unifiedDoc('a\n', 'a\n')!)).toEqual([]);
  });
  test('a deleted file is one hunk of removals', () => {
    expect(hunksOf(unifiedDoc('a\nb\n', '')!).map((x) => [x.oldStart, x.oldLines, x.newStart, x.newLines])).toEqual([[1, 2, 0, 0]]);
  });
});

describe('compactDoc: only the hunks, for a read-only view', () => {
  test('text and line kinds of the hunks only; each hunk knows its first row and header', () => {
    const before = lines(30);
    const after = before.replace('l5\n', 'L5\n').replace('l25\n', 'l25\nadded\n');
    const doc = unifiedDoc(before, after)!;
    const c = compactDoc(doc, hunksOf(doc));
    expect(c.text.split('\n')).toEqual(['l2', 'l3', 'l4', 'l5', 'L5', 'l6', 'l7', 'l8', 'l23', 'l24', 'l25', 'added', 'l26', 'l27', 'l28']);
    expect(c.lines).toHaveLength(15);
    expect(c.lines[3]).toEqual({ kind: 'del', oldNo: 5, newNo: null });
    expect(c.lines[4]).toEqual({ kind: 'add', oldNo: null, newNo: 5 });
    expect(c.hunks).toEqual([
      { line: 1, header: '@@ -2,7 +2,7 @@', firstChange: 5 },
      { line: 9, header: '@@ -23,6 +23,7 @@', firstChange: 26 }
    ]);
  });
  test('a hunk of removals only points at the new line that follows them', () => {
    const doc = unifiedDoc('a\nb\nc\n', 'a\nc\n')!;
    expect(compactDoc(doc, hunksOf(doc)).hunks).toEqual([{ line: 1, header: '@@ -1,3 +1,2 @@', firstChange: 2 }]);
  });
});

const repo = (name: string, changes: Partial<RepoStatus['changes'][number]>[], oid = 'abc'): RepoStatus => ({
  root: `/p/${name}`, name, branch: 'feat', detached: false, ahead: 0, behind: 0, oid, checkedAt: 0, truncated: 0,
  changes: changes.map((c) => ({ path: `/p/${name}/${c.rel}`, rel: c.rel!, kind: c.kind ?? 'M', stage: 'none' as const, added: 1, removed: 0, ...(c.origRel ? { origRel: c.origRel } : {}) }))
});
const at = (path: string, terminalId: string, via?: 'bash'): Attribution => ({ path, terminalId, sessionId: 's', color: '#c', title: terminalId, at: 1, ...(via ? { via } : {}) });

describe('reviewRows: the files of a review', () => {
  const repos = [repo('ui', [{ rel: 'a.ts' }, { rel: 'b.ts' }, { rel: 'c.ts', kind: '?' }])];
  const attrs = [at('/p/ui/a.ts', 't1'), at('/p/ui/b.ts', 't1', 'bash'), at('/p/ui/b.ts', 't2'), at('/p/ui/c.ts', 't2')];
  test('a session: only the files attributed to it (Edit/Write and via Bash)', () => {
    expect(reviewRows(repos, attrs, 't1', null).map((r) => r.rel)).toEqual(['a.ts', 'b.ts']);
    expect(reviewRows(repos, attrs, 't2', null).map((r) => r.rel)).toEqual(['b.ts', 'c.ts']);
    expect(reviewRows(repos, attrs, 'nobody', null)).toEqual([]);
  });
  test('all: every changed file, with its sessions', () => {
    const rows = reviewRows(repos, attrs, 'all', null);
    expect(rows.map((r) => [r.rel, r.by.map((b) => b.terminalId)])).toEqual([['a.ts', ['t1']], ['b.ts', ['t1', 't2']], ['c.ts', ['t2']]]);
  });
  test('against main: a repo that can compare lists what its branch changes; the others keep their working tree', () => {
    const other = repo('api', [{ rel: 'x.ts' }]);
    const compares: RepoCompare[] = [
      { root: '/p/ui', ok: true, base: 'main', ref: 'origin/main', mergeBase: 'f'.repeat(40), commits: 2, changes: [
        { path: '/p/ui/a.ts', rel: 'a.ts', kind: 'M', stage: 'none', added: 3, removed: 1 },
        { path: '/p/ui/old.ts', rel: 'old.ts', kind: 'A', stage: 'none', added: 9, removed: 0 }
      ] },
      { root: '/p/api', ok: false, reason: 'on-default' }
    ];
    const rows = reviewRows([...repos, other], attrs, 'all', compares);
    expect(rows.map((r) => [r.rel, r.added])).toEqual([['a.ts', 3], ['old.ts', 9], ['x.ts', 1]]);
    expect(baseRevOf(rows[0]!, compares)).toBe('f'.repeat(40));
    expect(baseRevOf(rows[2]!, compares)).toBe('HEAD');
    // A session's review against main: its files, compared with where the branch started.
    expect(reviewRows([...repos, other], attrs, 't1', compares).map((r) => r.rel)).toEqual(['a.ts']);
  });
  test('compareAvailable: offered when at least one repo can compare, with its base name', () => {
    expect(compareAvailable([{ root: '/p/api', ok: false, reason: 'on-default' }])).toBeNull();
    expect(compareAvailable([{ root: '/p/api', ok: false, reason: 'no-default' }, { root: '/p/ui', ok: true, base: 'develop', ref: 'origin/develop', mergeBase: 'f'.repeat(40), commits: 1, changes: [] }]))
      .toEqual({ base: 'develop', commits: 1 });
    expect(compareAvailable(null)).toBeNull();
  });
});

test('reviewScopeTitle: all changes, a live session, a closed one known from its attributions', () => {
  const live = { id: 't1', title: 'Alfa' } as never;
  expect(reviewScopeTitle('all', [], [])).toBe('All changes');
  expect(reviewScopeTitle('t1', [live], [])).toBe('Alfa');
  expect(reviewScopeTitle('t9', [live], [at('/p/x', 't9')])).toBe('t9');
  expect(reviewScopeTitle('t8', [live], [])).toBe('Closed session');
});

describe('navStops / stepNav: ↑↓ through hunks, n/p through files', () => {
  // File 0: 2 hunks; file 1: not loaded (one stop, its header); file 2: 1 hunk.
  const stops = navStops([2, null, 1]);
  test('the stops in order', () => {
    expect(stops).toEqual([{ file: 0, hunk: 0 }, { file: 0, hunk: 1 }, { file: 1, hunk: -1 }, { file: 2, hunk: 0 }]);
  });
  test('next and previous hunk, stopping at the ends; from nothing to the first or last', () => {
    expect(stepNav(stops, null, 'hunk', 1)).toEqual({ file: 0, hunk: 0 });
    expect(stepNav(stops, null, 'hunk', -1)).toEqual({ file: 2, hunk: 0 });
    expect(stepNav(stops, { file: 0, hunk: 1 }, 'hunk', 1)).toEqual({ file: 1, hunk: -1 });
    expect(stepNav(stops, { file: 2, hunk: 0 }, 'hunk', 1)).toEqual({ file: 2, hunk: 0 });
    expect(stepNav(stops, { file: 0, hunk: 0 }, 'hunk', -1)).toEqual({ file: 0, hunk: 0 });
  });
  test('next and previous file: the first stop of that file', () => {
    expect(stepNav(stops, { file: 0, hunk: 1 }, 'file', 1)).toEqual({ file: 1, hunk: -1 });
    expect(stepNav(stops, { file: 2, hunk: 0 }, 'file', -1)).toEqual({ file: 1, hunk: -1 });
    expect(stepNav(stops, { file: 0, hunk: 1 }, 'file', -1)).toEqual({ file: 0, hunk: 0 });
    expect(stepNav([], null, 'file', 1)).toBeNull();
  });
  test('a stop that went away (file reloaded with fewer hunks): the nearest one of that file', () => {
    expect(stepNav(navStops([1]), { file: 0, hunk: 3 }, 'hunk', 1)).toEqual({ file: 0, hunk: 0 });
  });
});

describe('what the review body shows', () => {
  test('Against main still comparing: says so (never a blank view); then the files, or the empty state', () => {
    expect(reviewBody(true, null, 0)).toBe('comparing');
    expect(reviewBody(true, null, 3)).toBe('comparing');
    expect(reviewBody(true, [], 0)).toBe('empty');
    expect(reviewBody(false, null, 2)).toBe('files');
    expect(reviewBody(false, null, 0)).toBe('empty');
  });
});

describe('a working tree scope (worktrees in Changes: Review Worktree, Compare with main)', () => {
  const st = (root: string, rels: string[]): RepoStatus => ({ root, name: root.split('/').at(-1)!, branch: 'x', detached: false, ahead: 0, behind: 0, oid: null, checkedAt: 0, truncated: 0, changes: rels.map((rel) => ({ path: `${root}/${rel}`, rel, kind: 'M' as const, stage: 'none' as const, added: 1, removed: 0 })) });
  const WT = '/p/.claude/worktrees/vad';
  test('reviewRows keeps only that working tree\'s rows', () => {
    const rows = reviewRows([st('/p', ['a.ts']), st(WT, ['b.ts', 'c.ts'])], [], `repo:${WT}`, null);
    expect(rows.map((r) => r.rel)).toEqual(['b.ts', 'c.ts']);
  });
  test('its title is the working tree\'s folder name', () => {
    expect(reviewScopeTitle(`repo:${WT}`, [], [])).toBe('vad');
  });
});

test('against main, a worktree folder that the compare copies as untracked is still no row of its repo', () => {
  const st = (root: string, o: Partial<RepoStatus> = {}): RepoStatus => ({ root, name: 'x', branch: 'feat', detached: false, ahead: 0, behind: 0, oid: 'a'.repeat(40), checkedAt: 0, truncated: 0, changes: [], ...o });
  const WT = '/p/.claude/worktrees/vad';
  const compare: RepoCompare = { root: '/p', ok: true, base: 'main', ref: 'main', mergeBase: 'b'.repeat(40), commits: 1, changes: [
    { path: '/p/a.ts', rel: 'a.ts', kind: 'M', stage: 'none', added: 1, removed: 0 },
    { path: `${WT}/`, rel: '.claude/worktrees/vad/', kind: '?', stage: 'none', added: null, removed: null }
  ] };
  const rows = reviewRows([st('/p'), st(WT, { worktreeOf: '/p' })], [], 'all', [compare]);
  expect(rows.map((r) => r.rel)).toEqual(['a.ts']);
});
