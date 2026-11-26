import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';
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

test('dialogAtBottom: its options carry their indices into the untrimmed lines', () => {
  const lines = ['⏺ run', '', '  Do you want to proceed?', '', '❯ 1. Yes', '  2. No', '', 'Esc to cancel'];
  expect(dialogAtBottom(lines)?.options.map((o) => o.line)).toEqual([4, 5]);
});
