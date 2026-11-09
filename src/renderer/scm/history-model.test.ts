import { expect, test } from 'vitest';
import type { ScmCommit } from '@shared/scm';
import { appendPage, emptyRows, jumpNext, mergeReload, stepSelection, visibleWindow, COMPARE_ROW, WORKTREE_ROW } from './history-model';

const c = (oid: string, parents: string[] = []): ScmCommit => ({ oid, parents, author: { name: 'A', email: 'a@a' }, authorAt: 1, committer: { name: 'A', email: 'a@a' }, committerAt: 1, subject: oid, coAuthors: [] });
// m merges f into b; e is f's parent; b and e have a as parent.
const page1 = [c('m', ['b', 'f']), c('f', ['e'])];
const page2 = [c('e', ['a']), c('b', ['a']), c('a')];

test('two pages lay out exactly like one page', () => {
  const one = appendPage(emptyRows('m'), [...page1, ...page2], { done: true, capped: false }, { graph: true, firstParent: false });
  const two = appendPage(appendPage(emptyRows('m'), page1, { done: false, capped: false }, { graph: true, firstParent: false }), page2, { done: true, capped: false }, { graph: true, firstParent: false });
  expect(two.graph).toEqual(one.graph);
  expect(two.commits.map((x) => x.oid)).toEqual(['m', 'f', 'e', 'b', 'a']);
  expect(two.done).toBe(true);
  // The current branch's first parents stay on lane 0.
  expect(two.graph.map((g) => g.lane)).toEqual([0, 1, 1, 0, 0]);
  expect(two.maxLanes).toBe(2);
});

test('the working tree row heads the list on lane 0, above HEAD', () => {
  const h = appendPage(emptyRows('m', { worktree: true }), [...page1, ...page2], { done: true, capped: false }, { graph: true, firstParent: false });
  expect(h.commits[0]!.oid).toBe(WORKTREE_ROW);
  expect(h.graph[0]!.lane).toBe(0);
  expect(h.graph[1]!.lane).toBe(0);
});

test('the compare row heads the list without a node; filtered lists have no graph; First parent draws one line', () => {
  const cmp = appendPage(emptyRows(null, { compare: true }), page1, { done: true, capped: false }, { graph: true, firstParent: false });
  expect(cmp.commits[0]!.oid).toBe(COMPARE_ROW);
  expect(cmp.graph[0]!.lane).toBe(-1);
  const flat = appendPage(emptyRows('m'), page1, { done: true, capped: false }, { graph: false, firstParent: false });
  expect(flat.graph).toEqual([]);
  const fp = appendPage(emptyRows('m'), [c('m', ['b', 'f']), c('b', ['a']), c('a')], { done: true, capped: false }, { graph: true, firstParent: true });
  expect(fp.graph.map((g) => g.lane)).toEqual([0, 0, 0]);
  expect(fp.maxLanes).toBe(1);
});

test('mergeReload: new commits on top are counted, the old ones follow, depth kept', () => {
  const prev = appendPage(emptyRows('m'), [...page1, ...page2], { done: true, capped: false }, { graph: true, firstParent: false });
  const fresh = appendPage(emptyRows('n2'), [c('n2', ['n1']), c('n1', ['m']), ...page1, ...page2], { done: true, capped: false }, { graph: true, firstParent: false });
  const r = mergeReload(prev, fresh);
  expect(r.added).toBe(2);
  expect(r.rows.commits.map((x) => x.oid)).toEqual(['n2', 'n1', 'm', 'f', 'e', 'b', 'a']);
});

test('mergeReload: a rewritten history (the old top is gone) counts nothing new', () => {
  const prev = appendPage(emptyRows('m'), page1, { done: false, capped: false }, { graph: true, firstParent: false });
  const fresh = appendPage(emptyRows('x'), [c('x', ['a']), c('a')], { done: true, capped: false }, { graph: true, firstParent: false });
  expect(mergeReload(prev, fresh).added).toBe(0);
  // The working tree row is not a commit: it never counts as new.
  const wt = appendPage(emptyRows('m', { worktree: true }), page1, { done: false, capped: false }, { graph: true, firstParent: false });
  expect(mergeReload(prev, wt).added).toBe(0);
});

test('visibleWindow: overscan around what is on screen, never more than ~80 rows for a tall pane', () => {
  expect(visibleWindow(0, 900, 5000)).toEqual({ start: 0, end: 53 });
  expect(visibleWindow(28 * 1000, 900, 5000)).toEqual({ start: 980, end: 1053 });
  expect(visibleWindow(28 * 4990, 900, 5000)).toEqual({ start: 4970, end: 5000 });
  const w = visibleWindow(28 * 2000 + 13, 1200, 10000);
  expect(w.end - w.start).toBeLessThanOrEqual(84);
});

test('stepSelection', () => {
  expect(stepSelection(0, null, 'down', 10)).toBeNull();
  expect(stepSelection(5, null, 'down', 10)).toBe(0);
  expect(stepSelection(5, 4, 'down', 10)).toBe(4);
  expect(stepSelection(5, 0, 'up', 10)).toBe(0);
  expect(stepSelection(50, 20, 'pageDown', 10)).toBe(30);
  expect(stepSelection(50, 5, 'pageUp', 10)).toBe(0);
  expect(stepSelection(50, 5, 'end', 10)).toBe(49);
  expect(stepSelection(50, 5, 'home', 10)).toBe(0);
});

test('reloadChunks: a reload covers the whole loaded depth in pages main accepts (≤ 4 000), up to the cap', async () => {
  const { reloadChunks } = await import('./history-model');
  expect(reloadChunks(0)).toEqual([{ skip: 0, count: 400 }]);
  expect(reloadChunks(350)).toEqual([{ skip: 0, count: 400 }]);
  expect(reloadChunks(3001)).toEqual([{ skip: 0, count: 3200 }]);
  expect(reloadChunks(4800)).toEqual([{ skip: 0, count: 4000 }, { skip: 4000, count: 800 }]);
  expect(reloadChunks(9000).map((c) => c.skip + c.count).at(-1)).toBe(9200);
  expect(reloadChunks(30000).map((c) => c.skip + c.count).at(-1)).toBe(20000);
  expect(reloadChunks(30000).every((c) => c.count <= 4000)).toBe(true);
});

test('mergeReload: the rows to shift by are the new commits plus a working tree row that came (or minus one that went)', () => {
  const prev = appendPage(emptyRows('m'), page1, { done: false, capped: false }, { graph: true, firstParent: false });
  const withWt = appendPage(emptyRows('m', { worktree: true }), page1, { done: false, capped: false }, { graph: true, firstParent: false });
  expect(mergeReload(prev, withWt)).toMatchObject({ added: 0, shift: 1 });
  expect(mergeReload(withWt, prev)).toMatchObject({ added: 0, shift: -1 });
  const fresh = appendPage(emptyRows('n', { worktree: true }), [c('n', ['m']), ...page1], { done: false, capped: false }, { graph: true, firstParent: false });
  expect(mergeReload(prev, fresh)).toMatchObject({ added: 1, shift: 2 });
});

test('historyFooter: loading, a retry after a failed page, the cap, a shallow clone, nothing', async () => {
  const { historyFooter } = await import('./history-model');
  const r = (done: boolean, capped = false) => ({ ...appendPage(emptyRows('m'), page1, { done, capped }, { graph: true, firstParent: false }) });
  expect(historyFooter(r(false), { shallow: false, moreFailed: false })).toBe('loading');
  expect(historyFooter(r(false), { shallow: false, moreFailed: true })).toBe('retry');
  expect(historyFooter(r(true, true), { shallow: false, moreFailed: false })).toBe('capped');
  expect(historyFooter(r(true), { shallow: true, moreFailed: false })).toBe('shallow');
  expect(historyFooter(r(true), { shallow: false, moreFailed: false })).toBeNull();
});

test('mergeReload: a commit that lands below the top (a newer unrelated tip stays first) still counts as new; the anchor row decides the shift', () => {
  const prev = appendPage(emptyRows('t2'), [c('L'), c('t2', ['t1']), c('t1', ['b']), c('b')], { done: true, capped: false }, { graph: true, firstParent: false });
  const fresh = appendPage(emptyRows('n'), [c('L'), c('n', ['t2']), c('t2', ['t1']), c('t1', ['b']), c('b')], { done: true, capped: false }, { graph: true, firstParent: false });
  expect(mergeReload(prev, fresh)).toMatchObject({ added: 1, newOids: ['n'], shift: 0 });
  expect(mergeReload(prev, fresh, 2)).toMatchObject({ shift: 1 });
  // Older commits that only weren't loaded before (the list wasn't done) are not new.
  const part = appendPage(emptyRows('t2'), [c('L'), c('t2', ['t1'])], { done: false, capped: false }, { graph: true, firstParent: false });
  expect(mergeReload(part, fresh)).toMatchObject({ added: 1, newOids: ['n'] });
});

test('jumpNext: select a loaded commit once; else locate it once per jump, counted only when the answer came', () => {
  const rows = (oids: string[], done = false) => ({ commits: oids.map((o) => c(o)), done });
  expect(jumpNext('x', rows(['a', 'x']), { located: null, selected: null })).toEqual({ kind: 'select', at: 1 });
  expect(jumpNext('x', rows(['a', 'x']), { located: null, selected: 'x' })).toEqual({ kind: 'none' });
  expect(jumpNext('x', rows(['a']), { located: null, selected: null })).toEqual({ kind: 'locate' });
  // The rows changed while the locate was on its way (its answer was dropped): it is asked again, never given up on.
  expect(jumpNext('x', rows(['a', 'b']), { located: null, selected: null })).toEqual({ kind: 'locate' });
  // Answered (loaded deeper, or past the cap): no second deeper load.
  expect(jumpNext('x', rows(['a', 'b']), { located: 'x', selected: null })).toEqual({ kind: 'none' });
  expect(jumpNext('x', rows(['a'], true), { located: null, selected: null })).toEqual({ kind: 'none' });
});
