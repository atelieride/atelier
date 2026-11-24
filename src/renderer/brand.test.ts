import { expect, test } from 'vitest';
import { markPaint, markSvg } from './brand';

test('a plate of the mark: the mark\'s paint in the theme\'s colors, seen through its box, its own gradient id', () => {
  const a = markPaint({ x: 28, y: 10, w: 40, h: 40 }, 0.6);
  expect(a).toMatch(/^<svg viewBox="28 10 40 40" preserveAspectRatio="none">/);
  expect(a).toContain('style="stop-color: var(--mark-a, #8B5CF6)"');
  expect(a).toContain('style="stop-color: var(--mark-b, #EC4899)"');
  // Painted in the mark's own frame (its group offset), over more than the view, at the plate's opacity.
  expect(a).toMatch(/<g transform="translate\(0 6\)"><rect [^>]*opacity="0.6"\/><\/g><\/svg>$/);
  const id = /id="(atl-g-\d+)"/.exec(a)?.[1];
  expect(a).toContain(`fill="url(#${id})"`);
  expect(/id="(atl-g-\d+)"/.exec(markPaint({ x: 4, y: 22, w: 40, h: 40 }, 1))?.[1]).not.toBe(id);
  expect(a).not.toMatch(/ATL_G|stop-color="/);
});

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
