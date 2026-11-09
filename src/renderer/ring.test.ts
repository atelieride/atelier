import { expect, test } from 'vitest';
import { ringDash, showContext } from './ring';

const C = 2 * Math.PI * 6;

test('context ring', () => {
  expect(ringDash(0, 6).dashoffset).toBeCloseTo(C);
  expect(ringDash(100, 6).dashoffset).toBeCloseTo(0);
  expect(ringDash(50, 6).dashoffset).toBeCloseTo(C / 2);
  expect(ringDash(150, 6).dashoffset).toBeCloseTo(0);
  expect(ringDash(-5, 6).dashoffset).toBeCloseTo(C);
  expect(ringDash(Number.NaN, 6).dashoffset).toBeCloseTo(C);
  expect(ringDash(30, 6).dasharray).toBe(`${C.toFixed(2)} ${C.toFixed(2)}`);
});

test('context shows at any value once the status line sent one (the ring lives only in the session bar)', () => {
  expect(showContext(null)).toBe(false);
  expect(showContext(0)).toBe(true);
  expect(showContext(14)).toBe(true);
  expect(showContext(49)).toBe(true);
  expect(showContext(93)).toBe(true);
});
