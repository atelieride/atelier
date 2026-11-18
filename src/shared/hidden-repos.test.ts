import { expect, test } from 'vitest';
import { HIDDEN_REPOS_MAX_PER_PROJECT, isHiddenRel, underHidden } from './hidden-repos';

// A hidden repository is named by its path inside the project, '/'-separated: what the store keeps and the scan,
// the watcher and Source Control compare with.

test('a hidden path is a relative path inside the project, with forward slashes', () => {
  for (const ok of ['data', 'agent/data/repo', 'a b/c-d_e.f', 'tools/.cache']) expect(isHiddenRel(ok)).toBe(true);
  for (const bad of ['', '/abs', 'a//b', 'a/', './a', 'a/./b', '../a', 'a/..', 'a\\b', 'a\0b', 'x'.repeat(1025), 3, null, undefined])
    expect(isHiddenRel(bad)).toBe(false);
  expect(HIDDEN_REPOS_MAX_PER_PROJECT).toBe(200);
});

test('a path is under a hidden one when it is that folder or below it, segment by segment', () => {
  const hidden = ['agent/data/repo'];
  expect(underHidden('agent/data/repo', hidden)).toBe(true);
  expect(underHidden('agent/data/repo/.git/HEAD', hidden)).toBe(true);
  expect(underHidden('agent/data/repo/src/a.ts', hidden)).toBe(true);
  // A sibling that only starts with the same letters is not under it.
  expect(underHidden('agent/data/repo2/a.ts', hidden)).toBe(false);
  expect(underHidden('agent/data', hidden)).toBe(false);
  expect(underHidden('tools/shared', hidden)).toBe(false);
  expect(underHidden('anything', [])).toBe(false);
});

test('the watcher\'s Windows separators count as separators; Windows compares names in any case', () => {
  expect(underHidden('agent\\data\\repo\\.git\\HEAD', ['agent/data/repo'], 'posix')).toBe(true);
  expect(underHidden('Agent\\Data\\Repo\\x', ['agent/data/repo'], 'win32')).toBe(true);
  expect(underHidden('Agent/Data/Repo/x', ['agent/data/repo'], 'posix')).toBe(false);
});
