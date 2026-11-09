import { expect, test } from 'vitest';
import { DEFAULT_FLAGS, DANGER_FLAG, MAX_FLAGS, type ClaudeFlags } from '@shared/claude-flags';
import { normalizeAccounts } from '@shared/claude-accounts';
import { addTyped, flagSummary, permissionOverride, removeAt, scopeFlags, scopeOf, suggestionsFor, withShared } from './launch-flags';

const accounts = normalizeAccounts({ list: [{ id: 'default', name: 'Claude', dir: '', color: 1 }, { id: 'work', name: 'Work', dir: '/Users/me/.claude-work', color: 2 }] })!;
const f0: ClaudeFlags = { all: [['--ide']], accounts: { work: { flags: [[DANGER_FLAG]], shared: true } } };

test('addTyped: parsed flags join the scope; errors name the token', () => {
  const r = addTyped(DEFAULT_FLAGS, 'all', '--add-dir ~/notes --verbose');
  expect(r).toEqual({ next: { all: [['--add-dir', '~/notes'], ['--verbose']], accounts: {} } });
  expect(addTyped(f0, 'work', '--verbose')).toEqual({ next: { all: [['--ide']], accounts: { work: { flags: [[DANGER_FLAG], ['--verbose']], shared: true } } } });
  expect(addTyped(f0, 'all', '--model opus')).toEqual({ error: 'reserved', token: '--model' });
  expect(addTyped(f0, 'all', 'notes')).toEqual({ error: 'shape', token: 'notes' });
  expect(addTyped(f0, 'all', '--ide')).toEqual({ error: 'dup', token: '--ide' });
  expect(addTyped(f0, 'all', '   ')).toEqual({ error: 'empty', token: '' });
  const big = (c: string) => ['--append-system-prompt', c.repeat(1135)];
  expect(addTyped({ all: [big('a'), big('b'), big('c')], accounts: {} }, 'all', '--add-dir /x')).toEqual({ error: 'size', token: '--add-dir' });
  const full = { all: Array.from({ length: MAX_FLAGS }, (_, i) => [`--f${i}`]), accounts: {} };
  expect(addTyped(full, 'all', '--more')).toEqual({ error: 'full', token: '--more' });
});

test('removeAt and withShared keep the normalized form', () => {
  expect(removeAt(f0, 'work', 0)).toEqual({ all: [['--ide']], accounts: {} });
  expect(removeAt(f0, 'all', 0)).toEqual({ all: [], accounts: { work: { flags: [[DANGER_FLAG]], shared: true } } });
  expect(withShared(f0, 'work', false).accounts.work).toEqual({ flags: [[DANGER_FLAG]], shared: false });
  expect(withShared(withShared(DEFAULT_FLAGS, 'work', false), 'work', true)).toEqual(DEFAULT_FLAGS);
});

test('scopeOf: an account that is gone, or with only the default one, is all accounts', () => {
  expect(scopeOf('work', accounts)).toBe('work');
  expect(scopeOf('gone', accounts)).toBe('all');
  expect(scopeOf('default', normalizeAccounts({ list: [{ id: 'default', name: 'Claude', dir: '', color: 1 }] })!)).toBe('all');
  expect(scopeFlags(f0, 'all')).toEqual([['--ide']]);
  expect(scopeFlags(f0, 'work')).toEqual([[DANGER_FLAG]]);
  expect(scopeFlags(f0, 'default')).toEqual([]);
});

test('flagSummary: what a badge says', () => {
  expect(flagSummary([])).toEqual({ count: 0, danger: false });
  expect(flagSummary([['--ide'], ['--verbose']])).toEqual({ count: 2, danger: false });
  expect(flagSummary([['--ide'], [DANGER_FLAG]])).toEqual({ count: 2, danger: true });
});

test('suggestionsFor: known flags not in the list yet, filtered by what is typed', () => {
  const all = suggestionsFor([], '');
  expect(all.at(-1)!.flag).toBe(DANGER_FLAG);
  expect(suggestionsFor([['--add-dir', '/x']], '').some((s) => s.flag === '--add-dir')).toBe(true);
  expect(suggestionsFor([['--verbose']], '').some((s) => s.flag === '--verbose')).toBe(false);
  expect(suggestionsFor([], '--mcp').map((s) => s.flag)).toEqual(['--mcp-config']);
  expect(suggestionsFor([], 'skip').map((s) => s.flag)).toEqual([DANGER_FLAG]);
});

test('permissionOverride: which sessions Permission mode no longer applies to', () => {
  expect(permissionOverride(DEFAULT_FLAGS, accounts)).toBeNull();
  expect(permissionOverride(f0, accounts)).toEqual({ names: ['Work'] });
  expect(permissionOverride({ all: [[DANGER_FLAG]], accounts: {} }, accounts)).toEqual({ all: true });
  expect(permissionOverride({ all: [[DANGER_FLAG]], accounts: { work: { flags: [], shared: false } } }, accounts)).toEqual({ names: ['Claude'] });
});
