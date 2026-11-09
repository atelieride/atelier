import { expect, test } from 'vitest';
import { markSvg } from './brand';

test('mark: three panels with the brand gradient and the A', () => {
  const s = markSvg(64);
  expect(s).toContain('#8B5CF6');
  expect(s).toContain('#EC4899');
  expect(s.match(/<rect /g)?.length).toBe(3);
  expect(s).toContain('<path');
});

test('mark: its colors are the theme\'s, Aurora\'s when no theme sets them', () => {
  const s = markSvg(20);
  expect(s.match(/style="stop-color: var\(--mark-a, #8B5CF6\)"/g)?.length).toBe(1);
  expect(s.match(/style="stop-color: var\(--mark-b, #EC4899\)"/g)?.length).toBe(1);
  expect(s).toMatch(/<path [^>]*style="stroke: var\(--mark-lambda, #FFFFFF\)"/);
  // Presentation attributes don't read custom properties: none left to shadow the styles.
  expect(s).not.toMatch(/stop-color="|stroke="#/);
});
