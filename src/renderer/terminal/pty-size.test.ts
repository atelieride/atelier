import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { PtySize, SETTLE_MS } from './pty-size';

let sent: [number, number][];
let size: PtySize;
beforeEach(() => {
  vi.useFakeTimers();
  sent = [];
  size = new PtySize((cols, rows) => { sent.push([cols, rows]); });
});
afterEach(() => { vi.useRealTimers(); });

test('a pane dragged on the normal buffer: only the size it settles at reaches the program, once', () => {
  for (let cols = 100; cols <= 140; cols += 4) {
    size.fitted(cols, 40, false);
    vi.advanceTimersByTime(16);
  }
  expect(sent).toEqual([]);
  vi.advanceTimersByTime(SETTLE_MS);
  expect(sent).toEqual([[140, 40]]);
  vi.advanceTimersByTime(SETTLE_MS * 10);
  expect(sent).toEqual([[140, 40]]);
});

test('a single change on the normal buffer goes once it has settled', () => {
  size.fitted(120, 40, false);
  vi.advanceTimersByTime(SETTLE_MS - 1);
  expect(sent).toEqual([]);
  vi.advanceTimersByTime(1);
  expect(sent).toEqual([[120, 40]]);
});

test('on the alternate buffer (a full-screen program) every size goes at once: it follows the drag live', () => {
  size.fitted(101, 40, true);
  size.fitted(102, 40, true);
  size.fitted(103, 41, true);
  expect(sent).toEqual([[101, 40], [102, 40], [103, 41]]);
  vi.advanceTimersByTime(SETTLE_MS * 10);
  expect(sent).toHaveLength(3);
});

test('a size fitted on the alternate buffer replaces one still settling: the waiting one never goes after it', () => {
  size.fitted(110, 40, false);
  size.fitted(120, 40, true);
  vi.advanceTimersByTime(SETTLE_MS * 10);
  expect(sent).toEqual([[120, 40]]);
});

test('now() sends at once and drops a size still settling', () => {
  size.fitted(110, 40, false);
  size.now(130, 42);
  expect(sent).toEqual([[130, 42]]);
  vi.advanceTimersByTime(SETTLE_MS * 10);
  expect(sent).toEqual([[130, 42]]);
});

test('flush() sends the size still settling at once, and nothing when none is', () => {
  size.flush();
  expect(sent).toEqual([]);
  size.fitted(110, 40, false);
  size.fitted(115, 40, false);
  size.flush();
  expect(sent).toEqual([[115, 40]]);
  vi.advanceTimersByTime(SETTLE_MS * 10);
  size.flush();
  expect(sent).toEqual([[115, 40]]);
});
