import { expect, test } from 'vitest';
import { followPressedKeys } from './pressed-keys';

/**
 * Stands in for xterm.js: a key pressed fires its key event, then the same string as data, in one go; the terminal's
 * answers to its program (and text from an input method) are data alone.
 */
function fakeXterm() {
  const onKey: ((e: { key: string }) => void)[] = [];
  const onData: ((data: string) => void)[] = [];
  const sent: [string, boolean][] = [];
  followPressedKeys({ onKey: (fn) => onKey.push(fn), onData: (fn) => onData.push(fn) }, (data, pressed) => sent.push([data, pressed]));
  return {
    sent,
    press: (key: string) => { for (const f of onKey) f({ key }); for (const f of onData) f(key); },
    data: (data: string) => { for (const f of onData) f(data); },
    /** A key xterm reports but sends nothing for. */
    keyAlone: (key: string) => { for (const f of onKey) f({ key }); }
  };
}

const KEYS: Record<string, string> = {
  Tab: '\t', Up: '\x1b[A', Down: '\x1b[B', Right: '\x1b[C', Left: '\x1b[D', 'Up, application cursor keys': '\x1bOA',
  Esc: '\x1b', 'Ctrl+C': '\x03', 'Ctrl+D': '\x04', 'Ctrl+L': '\x0c', 'Ctrl+R': '\x12', Enter: '\r', letter: 'a', 'Alt+b': '\x1bb'
};

// Device attributes (primary, secondary), status and cursor position reports, mode reports, colors, a status string,
// the window size, focus reports.
const ANSWERS = ['\x1b[?1;2c', '\x1b[>0;276;0c', '\x1b[0n', '\x1b[12;40R', '\x1b[?12;40R', '\x1b[?2004;2$y', '\x1b[4;2$y',
  '\x1b]11;rgb:1e1e/1e1e/2e2e\x1b\\', '\x1b]4;1;rgb:cdcd/0000/0000\x1b\\', '\x1bP1$r0m\x1b\\', '\x1b[8;24;80t', '\x1b[I', '\x1b[O'];

test('every key pressed is told as pressed, the ones that type nothing too', () => {
  const x = fakeXterm();
  for (const [name, key] of Object.entries(KEYS)) {
    x.press(key);
    expect(x.sent.at(-1), name).toEqual([key, true]);
  }
});

test('the terminal\'s answers to its program are never told as pressed, also right after a key', async () => {
  const x = fakeXterm();
  for (const a of ANSWERS) {
    x.data(a);
    expect(x.sent.at(-1), JSON.stringify(a)).toEqual([a, false]);
  }
  // Right after a key's own data, in the same go.
  x.press('\t');
  x.data('\x1b[12;40R');
  expect(x.sent.slice(-2)).toEqual([['\t', true], ['\x1b[12;40R', false]]);
  // After a key that sent nothing: in the same go, then later.
  x.keyAlone('\x1b[A');
  x.data('\x1b[I');
  x.keyAlone('\x1b[A');
  await Promise.resolve();
  x.data('\x1b[A');
  expect(x.sent.slice(-2)).toEqual([['\x1b[I', false], ['\x1b[A', false]]);
});
