import { describe, expect, test } from 'vitest';
import { createKeyReader } from './keys';

// The bytes xterm.js sends, as keys (the demo's Claude screen and shell answer keys).

describe('createKeyReader', () => {
  test('text, Enter, Backspace, Tab, control keys', () => {
    const read = createKeyReader();
    expect(read('ls -la\r')).toEqual([{ t: 'text', text: 'ls -la' }, { t: 'enter' }]);
    expect(read('a\x7fb\t\x03\x0c')).toEqual([{ t: 'text', text: 'a' }, { t: 'backspace' }, { t: 'text', text: 'b' }, { t: 'tab' }, { t: 'ctrl', key: 'c' }, { t: 'ctrl', key: 'l' }]);
  });

  test('arrows (normal and application mode), Home/End, Delete', () => {
    const read = createKeyReader();
    expect(read('\x1b[A\x1b[B\x1b[C\x1b[D\x1bOA\x1b[H\x1b[F\x1b[3~')).toEqual([{ t: 'up' }, { t: 'down' }, { t: 'right' }, { t: 'left' }, { t: 'up' }, { t: 'home' }, { t: 'end' }, { t: 'delete' }]);
  });

  test('a lone ESC is Esc; ESC CR is Shift+Enter (a new line in the prompt)', () => {
    const read = createKeyReader();
    expect(read('\x1b')).toEqual([{ t: 'esc' }]);
    expect(read('\x1b\r')).toEqual([{ t: 'newline' }]);
  });

  test('a bracketed paste, whole or split over writes (the renderer sends it in pieces)', () => {
    const read = createKeyReader();
    expect(read('\x1b[200~hello\rworld\x1b[201~')).toEqual([{ t: 'paste', text: 'hello\rworld' }]);
    expect(read('\x1b[200~')).toEqual([]);
    expect(read('part one\r')).toEqual([]);
    expect(read('part two')).toEqual([]);
    expect(read('\x1b[201~x')).toEqual([{ t: 'paste', text: 'part one\rpart two' }, { t: 'text', text: 'x' }]);
  });
});
