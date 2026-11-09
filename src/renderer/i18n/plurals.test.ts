import { expect, test } from 'vitest';
import { t } from './en';

// Counts read in the singular when there is one.

test('Source Control and Changes counts: one file, one repository', () => {
  expect(t.scm.detail.moreFiles(1)).toBe('1 more file not listed');
  expect(t.scm.detail.moreFiles(3)).toBe('3 more files not listed');
  expect(t.moreFiles(1)).toBe('+1 more file not shown (add it to .gitignore?)');
  expect(t.moreFiles(40)).toBe('+40 more files not shown (add them to .gitignore?)');
  expect(t.scm.fetch.allFailed(1, 1)).toBe("Couldn't fetch the repository");
  expect(t.scm.fetch.allFailed(3, 3)).toBe("Couldn't fetch any of the 3 repositories");
  expect(t.scm.fetch.allFailed(1, 3)).toBe('Fetched 2 of 3 repositories · 1 failed');
});
