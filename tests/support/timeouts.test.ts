import { expect, test } from 'vitest';
import { testTimeoutFor } from './timeouts';

test('a test has 20 s on macOS and Linux, a minute on Windows (git-heavy tests in the CI runner\'s slow spells)', () => {
  expect(testTimeoutFor('darwin')).toBe(20_000);
  expect(testTimeoutFor('linux')).toBe(20_000);
  expect(testTimeoutFor('win32')).toBe(60_000);
});
