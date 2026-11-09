import { expect, test } from 'vitest';
import { localNameCheck, nameError } from './BranchName';

// A new branch name as the user types it: what the listed branches already say, before main's
// check-ref-format answers.

test('empty, the same name, a listed branch, or one whose folder clashes (feat and feat/x); else main decides', () => {
  const branches = ['main', 'feat/x'];
  expect(localNameCheck(branches, '', undefined)).toEqual({ check: 'empty', clash: null });
  expect(localNameCheck(branches, 'feat/x', 'feat/x')).toEqual({ check: 'same', clash: null });
  expect(localNameCheck(branches, 'main', undefined)).toEqual({ check: 'exists', clash: null });
  expect(localNameCheck(branches, 'feat/x/y', undefined)).toEqual({ check: 'clash', clash: 'feat/x' });
  expect(localNameCheck(branches, 'feat', undefined)).toEqual({ check: 'clash', clash: 'feat/x' });
  // A rename into its own folder is fine: the old name goes first.
  expect(localNameCheck(['feat'], 'feat/x', 'feat')).toBeNull();
  expect(localNameCheck(branches, 'feature', undefined)).toBeNull();
});

test('what the field says', () => {
  expect(nameError('clash', 'feat', 'feat/x')).toBe("A branch named feat/x exists, so feat can't be made");
  expect(nameError('exists', 'main')).toBe('A branch named main already exists');
  expect(nameError('ok', 'x')).toBeNull();
});
