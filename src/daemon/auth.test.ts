import { expect, test } from 'vitest';
import { generateToken, tokensEqual } from './auth';

test('64-character hex tokens, different every time', () => {
  const a = generateToken();
  expect(a).toMatch(/^[0-9a-f]{64}$/);
  expect(generateToken()).not.toBe(a);
});
test('confronto', () => {
  const a = generateToken();
  expect(tokensEqual(a, a)).toBe(true);
  expect(tokensEqual(a, generateToken())).toBe(false);
  expect(tokensEqual(a, a.slice(0, 10))).toBe(false);
  expect(tokensEqual('', '')).toBe(false);
});
