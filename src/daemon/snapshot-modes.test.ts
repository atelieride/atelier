import { expect, test } from 'vitest';
import { Terminal as Headless } from '@xterm/headless';
import { SerializeAddon } from '@xterm/addon-serialize';
import { snapshotModes, snapshotOf } from './snapshot-modes';

const screen = () => new Headless({ cols: 80, rows: 24, allowProposedApi: true });
const write = (t: Headless, data: string) => new Promise<void>((done) => t.write(data, done));

// 2026-10-29: after a restart full-screen Claude couldn't be scrolled until it was typed into. The serialized screen
// turned the mouse tracking on again but not its SGR encoding: the new view reported the wheel in X10 bytes, which
// never reach the program.
test('a screen capturing the mouse in SGR with a hidden cursor keeps both through a snapshot', async () => {
  const before = screen();
  const serializer = new SerializeAddon();
  before.loadAddon(serializer);
  await write(before, '\x1b[?1049h\x1b[?1002h\x1b[?1006h\x1b[?1004h\x1b[?25lclaude');
  expect(snapshotModes(before)).toBe('\x1b[?1006h\x1b[?25l');
  const after = screen();
  await write(after, snapshotOf(before, serializer));
  expect(snapshotModes(after)).toBe(snapshotModes(before));
  expect(after.modes.mouseTrackingMode).toBe('drag');
});

test('SGR pixels is kept as such', async () => {
  const t = screen();
  await write(t, '\x1b[?1003h\x1b[?1016h');
  expect(snapshotModes(t)).toBe('\x1b[?1016h\x1b[?25h');
});

// The app can't tell an atelierd that knows the encoding from an older one by what it leaves out: both are said.
test('the states the app would otherwise guess are said either way: X10 tracking, a shown cursor', async () => {
  const t = screen();
  expect(snapshotModes(t)).toBe('\x1b[?25h');
  await write(t, '\x1b[?1000h');
  expect(snapshotModes(t)).toBe('\x1b[?1006l\x1b[?25h');
  // A program giving the modes back.
  await write(t, '\x1b[?1006h\x1b[?25l');
  await write(t, '\x1b[?1006l\x1b[?1000l\x1b[?25h');
  expect(snapshotModes(t)).toBe('\x1b[?25h');
});

test('a full reset (RIS) drops the encoding; xterm keeps a hidden cursor hidden through it, so does the snapshot', async () => {
  const t = screen();
  await write(t, '\x1b[?1002h\x1b[?1006h\x1b[?25l\x1bc');
  expect(snapshotModes(t)).toBe('\x1b[?25l');
});

// The app reads a screen with anything in it as the shell's first output (send-selection.ts waits for it).
test('an untouched screen stays empty; one with output gets its modes after it', async () => {
  const t = screen();
  const serializer = new SerializeAddon();
  t.loadAddon(serializer);
  expect(snapshotOf(t, serializer)).toBe('');
  await write(t, '$ ');
  expect(snapshotOf(t, serializer)).toBe(`${serializer.serialize()}\x1b[?25h`);
});
