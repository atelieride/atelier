import { expect, test } from 'vitest';
import { compressTokens } from './tokens';

test('absolute offsets and a palette without duplicates; the default color produces no span', () => {
  const r = compressTokens([
    [{ content: 'const', color: '#F5917E' }, { content: ' a = ', color: '#E2E0DA' }, { content: "'x'", color: '#A8D58B' }],
    [{ content: 'let', color: '#F5917E' }]
  ], '#E2E0DA');
  expect(r.colors).toEqual(['#F5917E', '#A8D58B']);
  // line 0: "const a = 'x'" (13) + \n → line 1 starts at 14
  expect(r.spans).toEqual([0, 5, 0, 10, 13, 1, 14, 17, 0]);
});

test('theme colors given as CSS variables are kept as written (custom property names are case-sensitive)', () => {
  const r = compressTokens([[{ content: 'const', color: 'var(--syn-keyword)' }, { content: ' a', color: 'var(--editor-fg)' }]], 'var(--editor-fg)');
  expect(r.colors).toEqual(['var(--syn-keyword)']);
  expect(r.spans).toEqual([0, 5, 0]);
});
