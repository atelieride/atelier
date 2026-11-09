import { expect, test } from 'vitest';
import { DraftTracker, typesSomething } from './drafts';

test('typesSomething: keys that type, Enter, Backspace and Ctrl+C do; terminal reports and mouse or focus events do not', () => {
  for (const d of ['a', '\r', '\x7f', '\x03', '\x1b[200~x\x1b[201~', '\x1b\r']) expect(typesSomething(d), JSON.stringify(d)).toBe(true);
  for (const d of ['\x1b[I', '\x1b[O', '\x1b[<64;10;5M', '\x1b[<0;3;4m', '\x1b[12;40R', '\x1b]11;rgb:0/0/0\x07', '\x1b[?1;2c', '\x1b[A', '']) expect(typesSomething(d), JSON.stringify(d)).toBe(false);
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
