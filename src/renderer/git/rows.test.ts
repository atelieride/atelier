import { expect, test } from 'vitest';
import type { FileChange } from '@shared/git';
import { folderParts, groupBox, headCount, repoPathOf, rowBox, stagedDot } from './rows';
import type { StageRow } from './staging';

// What Changes rows and headers show of the index: the staged dot, the header
// count, the checkboxes' states and why one is disabled, the by-session folder line.

const row = (rel: string, stage: FileChange['stage'], o: Partial<StageRow> = {}): StageRow => ({ repo: '/p/a', rel, kind: 'M', stage, ...o });

test('the staged dot: full when all of it is staged, a half ring when part of it is, none otherwise', () => {
  expect(stagedDot(row('a', 'all'))).toBe('all');
  expect(stagedDot(row('a', 'partial'))).toBe('partial');
  expect(stagedDot(row('a', 'none'))).toBeNull();
  // The dot says what git's index holds, also for a row Atelier can't stage (a submodule staged in a terminal).
  expect(stagedDot(row('a', 'all', { submodule: true }))).toBe('all');
});

test('the header count: "4 files", "3 staged · 4" with the drawer closed, "2 of 3" with it open', () => {
  const rows = [row('a', 'all'), row('b', 'partial'), row('c', 'none'), row('d', 'all')];
  expect(headCount(rows.map((r) => ({ ...r, stage: 'none' as const })), false)).toEqual({ kind: 'files', n: 4 });
  expect(headCount(rows, false)).toEqual({ kind: 'staged', staged: 3, n: 4 });
  expect(headCount(rows, true)).toEqual({ kind: 'of', staged: 3, n: 4 });
  // Nothing staged with the drawer open: the plain count, not "0 of 4".
  expect(headCount([row('a', 'none')], true)).toEqual({ kind: 'files', n: 1 });
  // `n` is the header's own count (a session's sure files), whatever the rows passed for staging.
  expect(headCount([row('a', 'all')], false, 5)).toEqual({ kind: 'staged', staged: 1, n: 5 });
});

test("a row's checkbox: its tri-state, disabled with the reason for unmerged files and submodules", () => {
  expect(rowBox(row('a', 'all'))).toEqual({ state: 'all', disabled: null });
  expect(rowBox(row('a', 'partial'))).toEqual({ state: 'partial', disabled: null });
  expect(rowBox(row('a', 'none'))).toEqual({ state: 'none', disabled: null });
  expect(rowBox(row('a', 'none', { kind: 'U' }))).toEqual({ state: 'none', disabled: 'Resolve the conflict first' });
  expect(rowBox(row('a', 'all', { submodule: true }))).toEqual({ state: 'none', disabled: "Submodules aren't committed from Atelier yet" });
});

test("a group's checkbox: all, some (partial counts), none; disabled only when no row can stage; none without rows", () => {
  expect(groupBox([row('a', 'all'), row('b', 'all')])).toEqual({ state: 'all', disabled: null });
  expect(groupBox([row('a', 'all'), row('b', 'none')])).toEqual({ state: 'some', disabled: null });
  expect(groupBox([row('a', 'partial')])).toEqual({ state: 'some', disabled: null });
  expect(groupBox([row('a', 'none'), row('b', 'none', { kind: 'U' })])).toEqual({ state: 'none', disabled: null });
  expect(groupBox([row('a', 'none', { kind: 'U' })])).toEqual({ state: 'none', disabled: 'Resolve the conflict first' });
  expect(groupBox([])).toBeNull();
});

test("a repository's path for the by-session folder line: relative to the project, its name at the project's root", () => {
  expect(repoPathOf('/p/plugins/payments', '/p')).toBe('plugins/payments');
  expect(repoPathOf('/p/acme-store', '/p/')).toBe('acme-store');
  expect(repoPathOf('/p', '/p')).toBe('p');
  expect(repoPathOf('/elsewhere/api', '/p')).toBe('api');
  expect(repoPathOf('/p/api', null)).toBe('api');
});

test('the folder line: "plugins/payments › src" with several repositories, today\'s "name · dir" with one', () => {
  expect(folderParts('src', { label: 'plugins/payments', multi: true })).toEqual({ repo: 'plugins/payments', sep: ' › ', dir: 'src' });
  // A file at the repository's root: the path alone.
  expect(folderParts('.', { label: 'plugins/payments', multi: true })).toEqual({ repo: 'plugins/payments', sep: '', dir: null });
  expect(folderParts('src', { label: 'app', multi: false })).toEqual({ repo: 'app', sep: ' · ', dir: 'src' });
  expect(folderParts('src', null)).toEqual({ repo: null, sep: '', dir: 'src' });
});
