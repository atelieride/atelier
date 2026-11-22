import { expect, test } from 'vitest';
import { DraftTracker, typesSomething } from './drafts';

test('typesSomething: keys that type, Enter, Backspace and Ctrl+C do; terminal reports and mouse or focus events do not', () => {
  for (const d of ['a', '\r', '\x7f', '\x03', '\x1b[200~x\x1b[201~', '\x1b\r']) expect(typesSomething(d), JSON.stringify(d)).toBe(true);
  for (const d of ['\x1b[I', '\x1b[O', '\x1b[<64;10;5M', '\x1b[<0;3;4m', '\x1b[12;40R', '\x1b]11;rgb:0/0/0\x07', '\x1b[?1;2c', '\x1b[A', '']) expect(typesSomething(d), JSON.stringify(d)).toBe(false);
  // Every answer xterm.js gives a program by itself: secondary device attributes, mode reports, colors ended by ST, a
  // status string, the window size.
  for (const d of ['\x1b[>0;276;0c', '\x1b[0n', '\x1b[?12;40R', '\x1b[?2004;2$y', '\x1b[4;2$y', '\x1b]11;rgb:1e1e/1e1e/2e2e\x1b\\', '\x1b]4;1;rgb:cdcd/0000/0000\x1b\\', '\x1bP1$r0m\x1b\\', '\x1bP1$r1;24r\x1b\\', '\x1b[8;24;80t']) expect(typesSomething(d), JSON.stringify(d)).toBe(false);
});

test('a tracker follows each terminal on its own: text leaves a draft, Enter or Ctrl+C clears it, a dialog keeps it', () => {
  const d = new DraftTracker();
  d.note('a', 'fix it');
  d.note('b', 'x\r');
  expect(d.has('a')).toBe(true);
  expect(d.has('b')).toBe(false);
  d.note('a', '\r', true);
  expect(d.has('a')).toBe(true);
  d.note('a', '\x1b[200~pasted\x1b[201~\r');
  expect(d.has('a')).toBe(false);
  d.assume('c');
  expect(d.ids().sort()).toEqual(['c']);
  d.forget('c');
  expect(d.has('c')).toBe(false);
});
