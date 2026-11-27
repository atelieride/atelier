import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SerializeAddon } from '@xterm/addon-serialize';
import { Terminal as Headless } from '@xterm/headless';
import { expect, test } from 'vitest';
import { snapshotOf } from '../../daemon/snapshot-modes';
import { dialogAtBottom, screenView } from './prompt';

const SCREENS = join(__dirname, '../../../tests/fixtures/claude-2.1.332/screens');
const ans = (name: string) => readFileSync(join(SCREENS, `${name}.ans`), 'utf8');
const SIZE = { cols: 120, rows: 40 };

test('screenView: the rows as screenLines reads them, and which of their text is dim', async () => {
  const queued = await screenView(ans('queued'), SIZE);
  // The prompt box's row (the last one starting with the cursor mark; an earlier one is the queued prompt).
  const at = queued.lines.map((l, i) => (l.startsWith('❯') ? i : -1)).filter((i) => i >= 0).at(-1)!;
  expect(queued.lines[at]).toBe('❯ Press up to edit queued messages');
  expect(queued.undimmed[at]).toMatch(/^❯\s*$/);
  expect(queued.cols).toBe(120);
  const expected = readFileSync(join(SCREENS, 'queued.txt'), 'utf8').split('\n');
  const trim = (rows: string[]) => { const r = [...rows]; while (r.length && !r.at(-1)) r.pop(); return r; };
  expect(trim(queued.lines)).toEqual(trim(expected));

  const typed = await screenView(ans('working-typed'), SIZE);
  const row = typed.lines.findLastIndex((l) => l.startsWith('❯'));
  expect(typed.undimmed[row]).toContain('What is 3+4? One word.');
  expect((await screenView('x', null)).cols).toBe(120);
});

test('screenView: whether the program asked for bracketed paste, as atelierd\'s snapshot of its screen says', async () => {
  /** atelierd's snapshot of a screen the program wrote `data` to. */
  const snapshot = async (data: string) => {
    const screen = new Headless({ cols: 80, rows: 24, allowProposedApi: true });
    const serializer = new SerializeAddon();
    screen.loadAddon(serializer);
    await new Promise<void>((done) => screen.write(data, done));
    return snapshotOf(screen, serializer);
  };
  expect((await screenView(await snapshot('\x1b[?2004h$ '), SIZE)).bracketedPaste).toBe(true);
  expect((await screenView(await snapshot('$ '), SIZE)).bracketedPaste).toBe(false);
  // Asked for, then given back.
  expect((await screenView(await snapshot('\x1b[?2004h$ vim\r\n\x1b[?2004l'), SIZE)).bracketedPaste).toBe(false);
  // Claude Code asks for it.
  expect((await screenView(ans('idle'), SIZE)).bracketedPaste).toBe(true);
});

test('dialogAtBottom: its options carry their indices into the untrimmed lines', () => {
  const lines = ['⏺ run', '', '  Do you want to proceed?', '', '❯ 1. Yes', '  2. No', '', 'Esc to cancel'];
  expect(dialogAtBottom(lines)?.options.map((o) => o.line)).toEqual([4, 5]);
});
