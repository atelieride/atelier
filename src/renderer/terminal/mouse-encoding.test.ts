import { expect, test } from 'vitest';
import { withMouseEncoding } from './mouse-encoding';

// What an atelierd started before the fix sends for full-screen Claude: tracking on, no encoding (serialize addon).
const OLD_CLAUDE = 'claude\x1b[?1049h\x1b[H…\x1b[24;1H\x1b[?2004h\x1b[?1004h\x1b[?1002h';

test('Claude’s screen turning the mouse tracking on without its encoding is taken as SGR', () => {
  expect(withMouseEncoding(OLD_CLAUDE, true)).toBe(`${OLD_CLAUDE}\x1b[?1006h`);
  for (const mode of ['9', '1000', '1002', '1003']) expect(withMouseEncoding(`\x1b[?${mode}h`, true)).toBe(`\x1b[?${mode}h\x1b[?1006h`);
});

// vim asks xterm.js for X10 reports (it reports version 276): SGR ones would reach it as keystrokes.
test('another program’s screen is never guessed', () => {
  expect(withMouseEncoding(OLD_CLAUDE, false)).toBe(OLD_CLAUDE);
});

test('a screen that names its encoding, either way, or captures no mouse, is left as it is', () => {
  for (const named of [`${OLD_CLAUDE}\x1b[?1006h\x1b[?25l`, `${OLD_CLAUDE}\x1b[?1006l\x1b[?25h`, '\x1b[?1003h\x1b[?1016h']) {
    expect(withMouseEncoding(named, true)).toBe(named);
  }
  expect(withMouseEncoding('$ ls\r\n\x1b[?2004h', true)).toBe('$ ls\r\n\x1b[?2004h');
  expect(withMouseEncoding('', true)).toBe('');
});
