import { expect, test } from 'vitest';
import { wheelLines } from './wheel';

const PX = 0; const LINE = 1; const PAGE = 2;

test('wheel pixels to lines: remainders accumulate, the sign gives the direction', () => {
  let r = wheelLines(0, -170, PX, 16, 40);
  expect(r).toEqual({ lines: -10, rest: -0.625 });
  r = wheelLines(r.rest, -10, PX, 16, 40);
  expect(r.lines).toBe(-1);
  expect(wheelLines(0, 8, PX, 16, 40)).toEqual({ lines: 0, rest: 0.5 });
  expect(wheelLines(0.5, 8, PX, 16, 40).lines).toBe(1);
});

test('lines and pages, and a cap per event (no avalanches from an accelerating mouse)', () => {
  expect(wheelLines(0, 3, LINE, 16, 40).lines).toBe(3);
  expect(wheelLines(0, -1, PAGE, 16, 40).lines).toBe(-40);
  expect(wheelLines(0, 100000, PX, 16, 40).lines).toBe(60);
  expect(wheelLines(0, 50, PX, 0, 40).lines).toBe(0);
});
