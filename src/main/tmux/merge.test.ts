import { describe, expect, test } from 'vitest';
import { LineBuffer, newLines } from './merge';

describe('newLines', () => {
  test('new lines after the ones already seen', () => {
    expect(newLines(['a', 'b', 'c', '>'], ['a', 'b', 'c', 'd', 'e', '>'])).toEqual({ appended: ['d', 'e'], reset: false });
  });
  test('scrolling past the start of the capture: the anchor is still found', () => {
    const prev = Array.from({ length: 30 }, (_, i) => `l${i}`).concat(['>']);
    const next = Array.from({ length: 30 }, (_, i) => `l${i + 10}`).concat(['>']);
    expect(newLines(prev, next).appended).toEqual(['l30', 'l31', 'l32', 'l33', 'l34', 'l35', 'l36', 'l37', 'l38', 'l39']);
  });
  test('progress line being rewritten: no new line', () => {
    expect(newLines(['build', '[=   ] 10%'], ['build', '[===  ] 60%'])).toEqual({ appended: [], reset: false });
  });
  test('repeated identical lines (same log twice) do not confuse the anchor', () => {
    expect(newLines(['x', 'ok', 'ok', '>'], ['x', 'ok', 'ok', 'ok', '>'])).toEqual({ appended: ['ok'], reset: false });
  });
  test('cleared screen: reset with the new content', () => {
    expect(newLines(['a', 'b', '>'], ['new', '>'])).toEqual({ appended: ['new'], reset: true });
  });
  test('repeated identical blocks (crash loop without timestamps): new lines are not lost', () => {
    const same = (n: number) => Array.from({ length: n }, () => 'Error: boom').concat(['$']);
    expect(newLines(same(30), same(35)).appended).toHaveLength(5);
    expect(newLines(['a', 'live'], ['a', 'b', 'a', 'c'])).toEqual({ appended: ['b', 'a'], reset: false });
  });
  test('stream faster than the capture (no overlap, full capture): no reset, lines appended with a marker', () => {
    const prev = Array.from({ length: 2000 }, (_, i) => `old ${i}`).concat(['$']);
    const next = Array.from({ length: 2000 }, (_, i) => `new ${i}`).concat(['$']);
    const r = newLines(prev, next);
    expect(r.reset).toBe(false);
    expect(r.appended[0]).toMatch(/skipped/);
    expect(r.appended).toHaveLength(2001);
  });
  test('first capture: everything new, no reset', () => {
    expect(newLines([], ['a', 'b', '>'])).toEqual({ appended: ['a', 'b'], reset: false });
  });
});

test('LineBuffer keeps at most N lines', () => {
  const b = new LineBuffer(3);
  b.push(['1', '2']); b.push(['3', '4', '5']);
  expect(b.lines()).toEqual(['3', '4', '5']);
  b.reset(['x']);
  expect(b.lines()).toEqual(['x']);
});

test('LineBuffer counts received lines (sequence) even beyond the limit', () => {
  const b = new LineBuffer(3);
  b.push(['1', '2']); b.push(['3', '4']);
  expect(b.seq).toBe(4);
  b.reset(['x', 'y']);
  expect(b.seq).toBe(2);
});
