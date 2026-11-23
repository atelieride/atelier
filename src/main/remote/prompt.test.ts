import { expect, test } from 'vitest';
import { allowKey, screenLines } from './prompt';

// Claude Code's permission dialog as a screen shows it (its rows, a bordered frame on some versions, the hints).
const dialog = (options: string[], o: { frame?: boolean; after?: string[] } = {}): string[] => {
  const body = [
    'Bash command', '', '  npm test', '  Run the test suite', '', 'Do you want to proceed?',
    ...options,
    '', ...(o.after ?? ['Esc to cancel · Tab to amend'])
  ];
  return [
    '⏺ I\'ll run the tests.', '',
    ...(o.frame ? ['╭──────────────────────────────────────────────╮', ...body.map((l) => `│ ${l.padEnd(44)} │`), '╰──────────────────────────────────────────────╯'] : body)
  ];
};

test('the usual dialog: "1" is its "Yes"', () => {
  const lines = dialog(['❯ 1. Yes', '  2. Yes, and don\'t ask again for npm test commands in /work/app', '  3. No, and tell Claude what to do differently (esc)']);
  expect(allowKey(lines)).toEqual({ ok: true, key: '1' });
  // Framed, as some versions draw it.
  expect(allowKey(dialog(['❯ 1. Yes', '  2. No, and tell Claude what to do differently (esc)'], { frame: true }))).toEqual({ ok: true, key: '1' });
});

test('"No" listed first: the digit of "Yes", whichever row the cursor is on', () => {
  expect(allowKey(dialog(['❯ 1. No', '  2. Yes']))).toEqual({ ok: true, key: '2' });
  expect(allowKey(dialog(['  1. No', '❯ 2. Yes', '  3. Yes, and don\'t ask again for this session']))).toEqual({ ok: true, key: '2' });
});

test('only "don\'t ask again" or "allow all" options: no "Yes" to choose, refused', () => {
  expect(allowKey(dialog(['❯ 1. Yes, and don\'t ask again for this session', '  2. No, and tell Claude what to do differently (esc)']))).toMatchObject({ ok: false });
  expect(allowKey(dialog(['❯ 1. Yes, allow all edits during this session (shift+tab)', '  2. No']))).toMatchObject({ ok: false });
});

test('typing feedback after Tab: a digit would be typed into it, refused', () => {
  // Tab on "Yes": its row turns into a field ("Yes, " then the placeholder or what was typed).
  expect(allowKey(dialog(['❯ 1. Yes, and tell Claude what to do next', '  2. No, and tell Claude what to do differently (esc)'], { after: ['Enter to submit · Esc to cancel'] }))).toMatchObject({ ok: false });
  expect(allowKey(dialog(['❯ 1. Yes, run only the unit tests', '  2. No']))).toMatchObject({ ok: false });
  // Tab on "No": "Yes" still reads "Yes", but the cursor is in No's field.
  expect(allowKey(dialog(['  1. Yes', '❯ 2. No, tell Claude what to do differently']))).toMatchObject({ ok: false });
  expect(allowKey(dialog(['  1. Yes', '❯ 2. No, use pnpm instead']))).toMatchObject({ ok: false });
  // The cursor on an editable "don't ask again" prefix: a field too.
  expect(allowKey(dialog(['  1. Yes', '❯ 2. Yes, and don\'t ask again for npm run *', '  3. No']))).toMatchObject({ ok: false });
});

test('no dialog at the bottom of the screen (answered already, or none): refused, even with an old one higher up', () => {
  expect(allowKey(['$ npm test', 'ok'])).toMatchObject({ ok: false });
  const old = [...dialog(['❯ 1. Yes', '  2. No']), '⏺ Bash(npm test)', '  ⎿  12 passed', '', '⏺ All tests pass.', '', '> ', '', '  ? for shortcuts'];
  expect(allowKey(old)).toMatchObject({ ok: false });
  expect(allowKey([])).toMatchObject({ ok: false });
});

test('the refusal says what to do', () => {
  expect(allowKey([])).toEqual({ ok: false, message: 'Open the session to answer' });
});

test('a terminal\'s screen as text, from the escape sequences an attach sends (colors, cursor moves, the alternate screen)', async () => {
  const snapshot = '\x1b[1mDo you want to proceed?\x1b[0m\r\n\x1b[38;5;153m❯\x1b[39m \x1b[2m1.\x1b[22m Yes\r\n\x1b[2C2. No';
  const lines = await screenLines(snapshot, { cols: 40, rows: 10 });
  expect(lines.filter(Boolean)).toEqual(['Do you want to proceed?', '❯ 1. Yes', '  2. No']);
  const alt = await screenLines('old output\r\n\x1b[?1049h\x1b[H\x1b[3;1H❯ 1. Yes\x1b[4;3H2. No', { cols: 30, rows: 6 });
  expect(alt.filter(Boolean)).toEqual(['❯ 1. Yes', '  2. No']);
  expect(allowKey(await screenLines(snapshot, null))).toEqual({ ok: true, key: '1' });
});
