import { describe, expect, test } from 'vitest';
import { FILE_ROW_H, MATCH_ROW_H, leadFor, rowTops, scrollToShow, textChars, visibleRange } from './rows-geometry';

const kinds = (s: string): ('file' | 'match')[] => [...s].map((c) => (c === 'f' ? 'file' : 'match'));

describe('rowTops', () => {
  test('file rows are 26 px, match rows 22 px; the last entry is the whole height', () => {
    expect(FILE_ROW_H).toBe(26);
    expect(MATCH_ROW_H).toBe(22);
    expect(rowTops(kinds('fmmf'))).toEqual([0, 26, 48, 70, 96]);
    expect(rowTops([])).toEqual([0]);
  });
});

describe('visibleRange', () => {
  const tops = rowTops(kinds('fmmfmm')); // 0 26 48 70 96 118 | 140

  test('the rows the viewport touches, partly shown ones included', () => {
    expect(visibleRange(tops, 0, 50, 0)).toEqual({ start: 0, end: 3 });
    expect(visibleRange(tops, 30, 20, 0)).toEqual({ start: 1, end: 3 });
    // A row starting exactly at the bottom edge is not shown yet.
    expect(visibleRange(tops, 0, 48, 0)).toEqual({ start: 0, end: 2 });
  });

  test('overscan adds rows on each side, clamped to the list', () => {
    expect(visibleRange(tops, 30, 20, 1)).toEqual({ start: 0, end: 4 });
    expect(visibleRange(tops, 0, 500, 10)).toEqual({ start: 0, end: 6 });
  });

  test('an empty list or no height draws nothing; a scroll past the end keeps the last rows', () => {
    expect(visibleRange([0], 0, 600, 10)).toEqual({ start: 0, end: 0 });
    expect(visibleRange(tops, 0, 0, 0)).toEqual({ start: 0, end: 0 });
    expect(visibleRange(tops, 1000, 50, 0)).toEqual({ start: 5, end: 6 });
  });

  test('thousands of rows: a bounded window wherever the list is scrolled', () => {
    const big = rowTops(kinds(`f${'m'.repeat(3000)}`));
    for (const top of [0, 30_000, big.at(-1)! - 600]) {
      const { start, end } = visibleRange(big, top, 600, 12);
      expect(end - start).toBeLessThanOrEqual(Math.ceil(600 / MATCH_ROW_H) + 1 + 24);
      expect(big[start]!).toBeLessThanOrEqual(top);
      expect(big[end] ?? big.at(-1)!).toBeGreaterThanOrEqual(Math.min(top + 600, big.at(-1)!));
    }
  });
});

describe('textChars and leadFor: a match never pushed out of its row', () => {
  test('the room a match row leaves its text grows with the list, never below a few characters', () => {
    expect(textChars(200)).toBeGreaterThanOrEqual(12);
    expect(textChars(200)).toBeLessThan(textChars(264));
    expect(textChars(264)).toBeLessThan(textChars(520));
    expect(textChars(0)).toBe(4);
  });

  test('the text before a match fits with the match and "…" in the room; 4 to 20 characters', () => {
    for (const width of [200, 232, 264, 320]) {
      const room = textChars(width);
      for (const len of [3, 5, 12]) {
        const lead = leadFor(room, len);
        expect(lead).toBeGreaterThanOrEqual(4);
        expect(lead).toBeLessThanOrEqual(20);
        if (room >= len + 8) expect(1 + lead + len).toBeLessThanOrEqual(room);
      }
    }
    expect(leadFor(200, 5)).toBe(20);
    expect(leadFor(10, 30)).toBe(4);
  });
});

describe('scrollToShow', () => {
  const tops = rowTops(kinds('fmmfmm'));
  test('a row already whole leaves the scroll; one above comes to the top, one below to the bottom', () => {
    expect(scrollToShow(tops, 1, 0, 60)).toBe(0);
    expect(scrollToShow(tops, 0, 30, 60)).toBe(0);
    expect(scrollToShow(tops, 4, 0, 60)).toBe(118 - 60);
    expect(scrollToShow(tops, 9, 10, 60)).toBe(10);
  });
});
