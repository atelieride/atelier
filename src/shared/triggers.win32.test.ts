import { afterEach, expect, test } from 'vitest';
import { initPlatform, resetPlatformForTests } from './platform';
import { LineSplitter } from './triggers';

// Output triggers on Windows: ConPTY re-renders what programs print, spaces as cursor-forward
// (ESC[nC) and new lines as cursor moves (ESC[r;cH). Read as text, they are spaces and line ends; macOS unchanged.

afterEach(() => { resetPlatformForTests(); });

test('Windows: cursor-forward reads as spaces, a cursor move as a new line', () => {
  initPlatform('win32');
  const s = new LineSplitter();
  expect(s.feed('tests\x1b[1Cfailed\x1b[3C(2)\r\n')).toEqual(['tests failed   (2)']);
  expect(s.feed('first\x1b[5;1Hsecond\x1b[6;1fthird\r\n')).toEqual(['first', 'second', 'third']);
  // A huge count can't flood a line.
  expect(s.feed('a\x1b[99999Cb\r\n')[0]!.length).toBeLessThanOrEqual(1000);
});

test('macOS: as before (cursor moves dropped)', () => {
  initPlatform('darwin');
  expect(new LineSplitter().feed('tests\x1b[1Cfailed\x1b[5;1Hx\r\n')).toEqual(['testsfailedx']);
});
