import { expect, test } from 'vitest';
import type { FileChange } from '@shared/git';
import { groupCheck, relsOf, rowStage, stageable, toggleRows, type StageRow } from './staging';

// Staging in Changes: a row's tri-state, a group's checkbox, what a click stages or unstages.

const row = (rel: string, stage: FileChange['stage'], o: Partial<StageRow> = {}): StageRow => ({ repo: '/p/a', rel, kind: 'M', stage, ...o });

test('a row reads its index state; unmerged rows and submodules never count as staged', () => {
  expect(rowStage(row('x', 'all'))).toBe('all');
  expect(rowStage(row('x', 'partial'))).toBe('partial');
  expect(rowStage(row('x', 'none'))).toBe('none');
  expect(rowStage(row('x', 'all', { kind: 'U' }))).toBe('none');
  expect(rowStage(row('x', 'all', { submodule: true }))).toBe('none');
});

test('unmerged files and submodules are not stageable, with the tooltip saying why', () => {
  expect(stageable(row('x', 'none'))).toEqual({ ok: true });
  expect(stageable(row('x', 'none', { kind: '?' }))).toEqual({ ok: true });
  expect(stageable(row('x', 'none', { kind: 'U' }))).toEqual({ ok: false, reason: 'Resolve the conflict first' });
  expect(stageable(row('x', 'none', { submodule: true }))).toEqual({ ok: false, reason: "Submodules aren't committed from Atelier yet" });
});

test('a rename stages and unstages both of its paths', () => {
  expect(relsOf(row('new.ts', 'none', { kind: 'R', origRel: 'old.ts' }))).toEqual(['new.ts', 'old.ts']);
  expect(relsOf(row('a.ts', 'none'))).toEqual(['a.ts']);
});

test('a group is checked when all its rows are, indeterminate when some are (partial counts as some)', () => {
  expect(groupCheck([])).toBe('none');
  expect(groupCheck([row('a', 'none'), row('b', 'none')])).toBe('none');
  expect(groupCheck([row('a', 'all'), row('b', 'all')])).toBe('all');
  expect(groupCheck([row('a', 'all'), row('b', 'none')])).toBe('some');
  expect(groupCheck([row('a', 'partial')])).toBe('some');
  expect(groupCheck([row('a', 'all'), row('b', 'partial')])).toBe('some');
});

test('rows that cannot be staged do not keep a group from being checked', () => {
  expect(groupCheck([row('a', 'all'), row('b', 'none', { kind: 'U' })])).toBe('all');
  expect(groupCheck([row('b', 'none', { submodule: true })])).toBe('none');
});

test('an empty or indeterminate group stages the rest; a checked one unstages everything', () => {
  const two = (o: Partial<StageRow> = {}) => [row('a', 'all'), row('b', 'none', o), row('c', 'partial')];
  expect(toggleRows(two())).toEqual([{ root: '/p/a', stage: ['b', 'c'] }]);
  expect(toggleRows([row('a', 'none'), row('b', 'none')])).toEqual([{ root: '/p/a', stage: ['a', 'b'] }]);
  expect(toggleRows([row('a', 'all'), row('b', 'all')])).toEqual([{ root: '/p/a', unstage: ['a', 'b'] }]);
  // One row: its own checkbox.
  expect(toggleRows([row('a', 'partial')])).toEqual([{ root: '/p/a', stage: ['a'] }]);
  expect(toggleRows([row('a', 'all')])).toEqual([{ root: '/p/a', unstage: ['a'] }]);
});

test('unstageable rows are left out, and a group of only those does nothing', () => {
  expect(toggleRows([row('a', 'none'), row('u', 'none', { kind: 'U' }), row('s', 'none', { submodule: true })])).toEqual([{ root: '/p/a', stage: ['a'] }]);
  expect(toggleRows([row('u', 'none', { kind: 'U' })])).toEqual([]);
});

test('a group across repositories (a session) decides once, then splits per root in list order; renames bring both paths', () => {
  const rows = [
    row('a', 'all'),
    row('n.ts', 'none', { repo: '/p/b', kind: 'R', origRel: 'o.ts' }),
    row('c', 'all', { repo: '/p/a' })
  ];
  expect(toggleRows(rows)).toEqual([{ root: '/p/b', stage: ['n.ts', 'o.ts'] }]);
  const staged = rows.map((r) => ({ ...r, stage: 'all' as const }));
  expect(toggleRows(staged)).toEqual([{ root: '/p/a', unstage: ['a', 'c'] }, { root: '/p/b', unstage: ['n.ts', 'o.ts'] }]);
});
