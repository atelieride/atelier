import { expect, test } from 'vitest';
import { gitMissing, isGitMissing } from './missing';

// Git is optional on Windows (decided): without it the git views say so and link the installer,
// instead of "clean" repos or a raw spawn error. macOS keeps what it shows today.

test('a spawn of git that found no git, whatever the op', () => {
  expect(isGitMissing('git status: spawn git ENOENT')).toBe(true);
  expect(isGitMissing('spawn git ENOENT')).toBe(true);
  expect(isGitMissing('fatal: not a git repository')).toBe(false);
  expect(isGitMissing('spawn gh ENOENT')).toBe(false);
  expect(isGitMissing(undefined)).toBe(false);
});

test('Windows only: any repo or view whose git is missing', () => {
  expect(gitMissing([undefined, 'git status: spawn git ENOENT'], 'win32')).toBe(true);
  expect(gitMissing([undefined, 'git status: spawn git ENOENT'], 'darwin')).toBe(false);
  expect(gitMissing([undefined, 'fatal: bad object'], 'win32')).toBe(false);
  expect(gitMissing([], 'win32')).toBe(false);
});
