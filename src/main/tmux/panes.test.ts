import { expect, test } from 'vitest';
import { trimLines } from './panes';

test('very long lines truncated (a JSON of tens of KB does not block the pane), trailing empty lines removed', () => {
  const r = trimLines(['a', 'x'.repeat(20000), '', '\x1b[0m  ', ''], 8192);
  expect(r).toHaveLength(2);
  expect(r[1]!.length).toBeLessThanOrEqual(8193);
  expect(r[1]!.endsWith('…')).toBe(true);
});
