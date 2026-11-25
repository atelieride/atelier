import { expect, test } from 'vitest';
import { allowKey, denyKey, screenLines } from './prompt';

/** What the phone's row showed for the usual dialog's request. */
const NPM = 'Bash npm test';

// Claude Code's permission dialog as a screen shows it (its rows, a bordered frame on some versions, the hints).
const dialog = (options: string[], o: { frame?: boolean; after?: string[]; command?: string[]; title?: string } = {}): string[] => {
  const body = [
    o.title ?? 'Bash command', '', ...(o.command ?? ['npm test']).map((l) => `  ${l}`), '  Run the test suite', '', 'Do you want to proceed?',
    ...options,
    '', ...(o.after ?? ['Esc to cancel · Tab to amend'])
  ];
  return [
    '⏺ I\'ll run the tests.', '',
    ...(o.frame ? ['╭──────────────────────────────────────────────╮', ...body.map((l) => `│ ${l.padEnd(44)} │`), '╰──────────────────────────────────────────────╯'] : body)
  ];
};
const USUAL = ['❯ 1. Yes', '  2. Yes, and don\'t ask again for npm test commands in /work/app', '  3. No, and tell Claude what to do differently (esc)'];

test('the usual dialog: "1" is its "Yes"', () => {
  expect(allowKey(dialog(USUAL), NPM)).toEqual({ ok: true, key: '1' });
  // Framed, as some versions draw it.
  expect(allowKey(dialog(['❯ 1. Yes', '  2. No, and tell Claude what to do differently (esc)'], { frame: true }), NPM)).toEqual({ ok: true, key: '1' });
});

test('"No" listed first: the digit of "Yes", whichever row the cursor is on', () => {
  expect(allowKey(dialog(['❯ 1. No', '  2. Yes']), NPM)).toEqual({ ok: true, key: '2' });
  expect(allowKey(dialog(['  1. No', '❯ 2. Yes', '  3. Yes, and don\'t ask again for this session']), NPM)).toEqual({ ok: true, key: '2' });
});

test('only "don\'t ask again" or "allow all" options: no "Yes" to choose, refused', () => {
  expect(allowKey(dialog(['❯ 1. Yes, and don\'t ask again for this session', '  2. No, and tell Claude what to do differently (esc)']), NPM)).toMatchObject({ ok: false });
  expect(allowKey(dialog(['❯ 1. Yes, allow all edits during this session (shift+tab)', '  2. No']), NPM)).toMatchObject({ ok: false });
});

test('typing feedback after Tab: a digit would be typed into it, refused', () => {
  // Tab on "Yes": its row turns into a field ("Yes, " then the placeholder or what was typed).
  expect(allowKey(dialog(['❯ 1. Yes, and tell Claude what to do next', '  2. No, and tell Claude what to do differently (esc)'], { after: ['Enter to submit · Esc to cancel'] }), NPM)).toMatchObject({ ok: false });
  expect(allowKey(dialog(['❯ 1. Yes, run only the unit tests', '  2. No']), NPM)).toMatchObject({ ok: false });
  // Tab on "No": "Yes" still reads "Yes", but the cursor is in No's field.
  expect(allowKey(dialog(['  1. Yes', '❯ 2. No, tell Claude what to do differently']), NPM)).toMatchObject({ ok: false });
  expect(allowKey(dialog(['  1. Yes', '❯ 2. No, use pnpm instead']), NPM)).toMatchObject({ ok: false });
  // The cursor on an editable "don't ask again" prefix: a field too.
  expect(allowKey(dialog(['  1. Yes', '❯ 2. Yes, and don\'t ask again for npm run *', '  3. No']), NPM)).toMatchObject({ ok: false });
});

test('no dialog at the bottom of the screen (answered already, or none): refused, even with an old one higher up', () => {
  expect(allowKey(['$ npm test', 'ok'], NPM)).toMatchObject({ ok: false });
  const old = [...dialog(['❯ 1. Yes', '  2. No']), '⏺ Bash(npm test)', '  ⎿  12 passed', '', '⏺ All tests pass.', '', '> ', '', '  ? for shortcuts'];
  expect(allowKey(old, NPM)).toMatchObject({ ok: false });
  expect(allowKey([], NPM)).toMatchObject({ ok: false });
});

test('the refusal says what to do', () => {
  expect(allowKey([], NPM)).toEqual({ ok: false, message: 'Open the session to answer' });
});

test('another request in the dialog than the one the phone showed (parallel agents ask in turn): refused', () => {
  // The phone shows the latest request; Claude Code shows the oldest first.
  expect(allowKey(dialog(USUAL, { command: ['rm -rf build'] }), NPM)).toMatchObject({ ok: false });
  expect(allowKey(dialog(USUAL, { command: ['rm -rf build'] }), 'Bash rm -rf build')).toEqual({ ok: true, key: '1' });
  // The one shown is only the start of the dialog's command, or inside it: refused.
  expect(allowKey(dialog(USUAL, { command: ['npm test && rm -rf build'] }), NPM)).toMatchObject({ ok: false });
  expect(allowKey(dialog(USUAL, { command: ['CI=1 npm test'] }), NPM)).toMatchObject({ ok: false });
  // Nothing named (only "Needs permission"): nothing to check the dialog against.
  expect(allowKey(dialog(USUAL), null)).toMatchObject({ ok: false });
});

test('a question in front, with its own "Yes" and "No", while the phone shows a permission: refused', () => {
  const question = ['⏺ Before I go on:', '', '☐ Tests', '', 'Should I run npm test now?', '', '❯ 1. Yes', '  2. No', '  3. Type something.', '', 'Enter to select · ↑/↓ to navigate · Esc to cancel'];
  expect(allowKey(question, NPM)).toMatchObject({ ok: false });
  expect(denyKey(question, NPM)).toMatchObject({ ok: false });
});

test('a command wrapped over rows reads whole; one cut at 60 characters ("…") is matched by its start', () => {
  const long = 'git commit -m "Retry the upload when the relay drops the socket mid-way through"';
  const wrapped = dialog(USUAL, { command: ['git commit -m "Retry the upload when the relay drops the', 'socket mid-way through"'] });
  expect(allowKey(wrapped, `Bash ${long}`)).toEqual({ ok: true, key: '1' });
  // As atelierd names a long command: its first 59 characters and "…".
  expect(allowKey(wrapped, `Bash ${long.slice(0, 59)}…`)).toEqual({ ok: true, key: '1' });
  expect(allowKey(wrapped, 'Bash git commit -m "Retry the download…')).toMatchObject({ ok: false });
  // A pipe where a row wraps, and a dialog that draws its frame with "|".
  expect(allowKey(dialog(USUAL, { command: ['git log --oneline |', 'head -20'] }), 'Bash git log --oneline | head -20')).toEqual({ ok: true, key: '1' });
});

test('what stands above the dialog\'s top edge is not the dialog\'s', () => {
  const screen = ['⏺ Bash(npm test)', '  ⎿  Running…', 'npm test', '──────────────────────────────', ...dialog(USUAL, { command: ['rm -rf build'] }).slice(2)];
  expect(allowKey(screen, NPM)).toMatchObject({ ok: false });
  expect(allowKey(screen, 'Bash rm -rf build')).toEqual({ ok: true, key: '1' });
});

test('Claude Code 2.1.332: the command between two dashed rules, below the dialog\'s top edge, four options', () => {
  // As the full-screen renderer draws it at 120 columns (the transcript above, the dialog at the bottom).
  const dashed = '╌'.repeat(118);
  const screen = [
    '❯ Run touch made-by-bash.txt with the Bash tool.', '  Creating empty file made-by-bash.txt', '  ⎿  $ touch made-by-bash.txt',
    '─'.repeat(120),
    ' Bash command', ' Tip: auto mode handles these prompts for you — choose "switch to auto mode" below', ' Create empty file made-by-bash.txt',
    dashed, ' touch made-by-bash.txt', dashed,
    ' Do you want to proceed?',
    ' ❯ 1. Yes',
    '   2. Yes, and always allow access to /work/projects/acme-store/packages/web/src/generated/very/long/folder/name/that',
    '      /wraps from this project',
    '   3. Yes, and switch to auto mode · auto mode handles these prompts for you',
    '   4. No',
    ' Esc to cancel · Tab to amend'
  ];
  const touch = 'Bash touch made-by-bash.txt';
  expect(allowKey(screen, touch)).toEqual({ ok: true, key: '1' });
  expect(denyKey(screen, touch)).toEqual({ ok: true, key: '\x1b' });
  // Still only for the request the dialog names: the command between the rules.
  expect(allowKey(screen, 'Bash touch other.txt')).toMatchObject({ ok: false });
  expect(denyKey(screen, 'Bash touch other.txt')).toMatchObject({ ok: false });
  // The solid rule stays the dialog's top edge: the transcript's "$ touch made-by-bash.txt" above it doesn't count.
  const named = screen.map((l) => (l === ' touch made-by-bash.txt' ? ' touch elsewhere.txt' : l));
  expect(allowKey(named, touch)).toMatchObject({ ok: false });
});

test('a file\'s permission: the dialog names that file; another one, or a name that only starts the same, is refused', () => {
  const edit = (file: string) => ['Edit file', '╭────────────────────────────╮', `│ src/${file}`, '│  12 -  const retries = 3;', '│  12 +  const retries = 5;', '╰────────────────────────────╯', `Do you want to make this edit to ${file}?`, '❯ 1. Yes', '  2. Yes, allow all edits during this session (shift+tab)', '  3. No, and tell Claude what to do differently (esc)'];
  expect(allowKey(edit('upload.ts'), 'Edit upload.ts')).toEqual({ ok: true, key: '1' });
  expect(allowKey(edit('upload.ts'), 'Edit relay.ts')).toMatchObject({ ok: false });
  expect(allowKey(edit('upload.ts.bak'), 'Edit upload.ts')).toMatchObject({ ok: false });
  // A Windows path is named whole: its last part is the file.
  expect(allowKey(['Create file', 'Do you want to create notes.md?', '❯ 1. Yes', '  2. No'], 'Write C:\\work\\notes.md')).toEqual({ ok: true, key: '1' });
});

test('a tool named alone: its name must stand in the dialog', () => {
  const tool = (line: string) => ['Tool use', '', `  ${line}`, '', 'Do you want to proceed?', '❯ 1. Yes', '  2. No'];
  expect(allowKey(tool('Deploy(env: "staging")'), 'Deploy')).toEqual({ ok: true, key: '1' });
  expect(allowKey(tool('Deployment(env: "staging")'), 'Deploy')).toMatchObject({ ok: false });
  expect(allowKey(tool('github - create_issue(title: "x") (MCP)'), 'mcp__github__create_issue')).toMatchObject({ ok: false });
});

test('Deny: Esc, only for the dialog the phone showed, whatever options it lists', () => {
  expect(denyKey(dialog(USUAL), NPM)).toEqual({ ok: true, key: '\x1b' });
  expect(denyKey(dialog(['❯ 1. Yes, and don\'t ask again for this session', '  2. No, and tell Claude what to do differently (esc)']), NPM)).toEqual({ ok: true, key: '\x1b' });
  expect(denyKey(dialog(USUAL, { command: ['rm -rf build'] }), NPM)).toMatchObject({ ok: false });
  // No dialog (answered at the Mac, or the tool already runs): an Esc would interrupt it.
  expect(denyKey(['⏺ Bash(npm test)', '  ⎿  Running…', '', '✻ Testing… (esc to interrupt)'], NPM)).toEqual({ ok: false, message: 'Open the session to answer' });
  expect(denyKey(dialog(USUAL), null)).toMatchObject({ ok: false });
  // Esc cancels the dialog wherever its cursor is, a feedback field included.
  expect(denyKey(dialog(['  1. Yes', '❯ 2. No, use pnpm instead']), NPM)).toEqual({ ok: true, key: '\x1b' });
});

test('a terminal\'s screen as text, from the escape sequences an attach sends (colors, cursor moves, the alternate screen)', async () => {
  const snapshot = '\x1b[1mBash command\x1b[0m\r\n\r\n  npm test\r\n\x1b[1mDo you want to proceed?\x1b[0m\r\n\x1b[38;5;153m❯\x1b[39m \x1b[2m1.\x1b[22m Yes\r\n\x1b[2C2. No';
  const lines = await screenLines(snapshot, { cols: 40, rows: 10 });
  expect(lines.filter(Boolean)).toEqual(['Bash command', '  npm test', 'Do you want to proceed?', '❯ 1. Yes', '  2. No']);
  const alt = await screenLines('old output\r\n\x1b[?1049h\x1b[H\x1b[3;1H❯ 1. Yes\x1b[4;3H2. No', { cols: 30, rows: 6 });
  expect(alt.filter(Boolean)).toEqual(['❯ 1. Yes', '  2. No']);
  expect(allowKey(await screenLines(snapshot, null), NPM)).toEqual({ ok: true, key: '1' });
});
