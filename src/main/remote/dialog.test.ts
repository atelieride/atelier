import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { chooseKeys, fieldHolds, MAX_ROW, promptState, readDialog, type ScreenDialog } from './dialog';
import { screenView, type ScreenView } from './prompt';

const SCREENS = join(__dirname, '../../../tests/fixtures/claude-2.1.332/screens');
/** Rows as a screen shows them, with no dim text, 120 columns wide (as the recording). */
const view = (lines: string[]): ScreenView => ({ lines, undimmed: lines, cols: 120 });
/** A recorded screen from its text rows. */
const txt = (name: string): ScreenView => view(readFileSync(join(SCREENS, `${name}.txt`), 'utf8').split('\n'));
/** The prompt's state on a recorded screen read from its snapshot, dim text included. */
const state = async (name: string) => promptState(await screenView(readFileSync(join(SCREENS, `${name}.ans`), 'utf8'), { cols: 120, rows: 40 }));

/** The recording's fictional project folder, as the Bash dialog names it (hard-wrapped at column 119). */
const PROJECT = `/work/hello/${'nested/'.repeat(16)}nested-/project`;
const RULE = '─'.repeat(120);

test('the Bash permission: its rows, four options, the long one joined, No amends', () => {
  const d = readDialog(txt('bash'), 'permission')!;
  expect(d).toMatchObject({ kind: 'permission', focused: 1, inField: false, several: false, trust: false });
  expect(d.rows).toEqual(['Bash command', 'Tip: auto mode handles these prompts for you — choose "switch to auto mode" below', 'Create empty file made-by-bash.txt', 'touch made-by-bash.txt', 'Do you want to proceed?']);
  expect(d.options.map((o) => o.label)).toEqual(['Yes', `Yes, and always allow access to ${PROJECT} from this project`, 'Yes, and switch to auto mode · auto mode handles these prompts for you', 'No']);
  expect(d.options[3]).toEqual({ n: 4, label: 'No', amend: true });
});

test('Bash after Tab on No: the cursor in its field; typed, the field holds the text', () => {
  expect(readDialog(txt('bash-amend'), 'permission')).toMatchObject({ focused: 4, inField: true });
  const typed = readDialog(txt('bash-amend-typed'), 'permission')!;
  expect(fieldHolds(typed, 4, 'do not create it, just say ok')).toBe(true);
  expect(fieldHolds(typed, 4, 'something else')).toBe(false);
  // Another option, or the cursor on No before Tab: no field to hold it.
  expect(fieldHolds(typed, 3, 'do not create it, just say ok')).toBe(false);
  expect(fieldHolds(readDialog(txt('bash-on-no'), 'permission')!, 4, 'No')).toBe(false);
  // A long text shows only its start, which is what must be there: its first 40 characters that aren't spaces.
  const long: ScreenDialog = { ...typed, options: [{ n: 1, label: 'Yes' }, { n: 2, label: `No, ${'ab '.repeat(22)}` }], focused: 2 };
  expect(fieldHolds(long, 2, 'ab '.repeat(30))).toBe(true);
  expect(fieldHolds(long, 2, `${'ab '.repeat(19)}ax`)).toBe(false);
});

test('the Edit permission and the plan: their rows and options; the plan\'s third option is a field', () => {
  const edit = readDialog(txt('edit'), 'permission')!;
  expect(edit.rows).toEqual(['Edit file', 'hello.txt', '1 -Hello, world!', '1 +Hello, there!', '2  This file is for edit tests.', 'Do you want to make this edit to hello.txt?']);
  // Option 2 reaches column 117, yet "3. No" below it is an option of its own, not more of its label.
  expect(edit.options).toEqual([
    { n: 1, label: 'Yes' },
    { n: 2, label: 'Yes, and switch to accept edits (auto-approve file edits and common file commands) for this session (shift+tab)' },
    { n: 3, label: 'No', amend: true }
  ]);
  const plan = readDialog(txt('plan'), 'plan')!;
  expect(plan).toMatchObject({ kind: 'plan', rows: ['Claude has written up a plan and is ready to execute. Would you like to proceed?'], focused: 1, inField: false });
  expect(plan.options).toEqual([{ n: 1, label: 'Yes, and use auto mode' }, { n: 2, label: 'Yes, manually approve edits' }, { n: 3, label: 'Tell Claude what to change', field: true }]);
  expect(readDialog(txt('plan-field'), 'plan')).toMatchObject({ focused: 3, inField: true });
  // Typed, the field's label is the text: still the field, by the hint row below it.
  const typed = readDialog(txt('plan-field-typed'), 'plan')!;
  expect(typed.options[2]).toEqual({ n: 3, label: 'Skip the verify step.', field: true });
  expect(fieldHolds(typed, 3, 'Skip the verify step.')).toBe(true);
});

test('a question: chip and question as rows, descriptions left out, "Type something." a field, "Chat about this" after the rule', () => {
  const d = readDialog(txt('question'), 'question')!;
  expect(d).toMatchObject({ kind: 'question', rows: ['☐ Color', 'What is your favorite color?'], focused: 1, inField: false, several: false, trust: false });
  expect(d.options).toEqual([
    { n: 1, label: 'Red' }, { n: 2, label: 'Green' }, { n: 3, label: 'Blue' },
    { n: 4, label: 'Type something.', field: true },
    { n: 5, label: 'Chat about this' }
  ]);
  // The cursor on the field, empty and then typed: in it, and holding the text.
  expect(readDialog(txt('question-field'), 'question')).toMatchObject({ focused: 3, inField: true });
  const typed = readDialog(txt('question-field-typed'), 'question')!;
  expect(typed.options[2]).toEqual({ n: 3, label: 'Mango', field: true });
  expect(fieldHolds(typed, 3, 'Mango')).toBe(true);
});

test('several questions: each page reads differently; the review page has its answers as rows and two options', () => {
  const [a, b, r] = [readDialog(txt('questions-first'), 'question')!, readDialog(txt('questions-second'), 'question')!, readDialog(txt('questions-review'), 'question')!];
  expect(new Set([a.page, b.page, r.page]).size).toBe(3);
  expect(a.rows).toEqual(['←  ☐ Season  ☐ Drink  ✔ Submit  →', 'What is your favorite season?']);
  expect(r.rows).toEqual(['←  ☒ Season  ☒ Drink  ✔ Submit  →', 'Review your answers', '● What is your favorite season?', '→ Winter', '● What is your favorite drink?', '→ Tea']);
  expect(r.options.map((o) => o.label)).toEqual(['Submit answers', 'Cancel']);
  expect(r).toMatchObject({ focused: 1, inField: false });
});

test('several choices: several, and the cursor on Submit reads as in a field', () => {
  const d = readDialog(txt('several'), 'question')!;
  expect(d).toMatchObject({ several: true, focused: 1, inField: false });
  expect(d.options).toEqual([
    { n: 1, label: '[ ] Cats' }, { n: 2, label: '[ ] Dogs' }, { n: 3, label: '[ ] Fish' },
    { n: 4, label: '[ ] Type something', field: true },
    { n: 5, label: 'Chat about this' }
  ]);
  // Submit is no numbered option: no option has the cursor, and the hint row offers the editor, as in a field.
  expect(readDialog(txt('several-submit'), 'question')).toMatchObject({ several: true, focused: null, inField: true });
  // Its review page lists no boxes.
  expect(readDialog(txt('several-review'), 'question')).toMatchObject({ several: false, focused: 1, inField: false });
});

test('/model is a menu with no options; the folder trust dialog is a menu marked trust', () => {
  expect(readDialog(txt('model'), null)).toMatchObject({ kind: 'menu', options: [], trust: false });
  expect(readDialog(txt('model'), null)!.rows[0]).toBe('Select model');
  expect(readDialog(txt('trust'), null)).toMatchObject({ kind: 'menu', options: [], trust: true });
  // A menu's rows run to its last one, its options and hints included.
  expect(readDialog(txt('model'), null)!.rows.at(-1)).toBe('s to use this session only · Enter to save · Esc to cancel');
  expect(readDialog(txt('trust'), null)!.rows).toContain('❯ No, exit');
  // A question read with no wait is a menu too, with all its rows: an in-list rule is no top edge.
  expect(readDialog(txt('question'), null)!.rows.slice(0, 3)).toEqual(['☐ Color', 'What is your favorite color?', '❯ 1. Red']);
});

test('no dialog: Claude working, idle, or a numbered list in its reply above the prompt box', () => {
  for (const s of ['working', 'working-typed', 'idle', 'queued', 'plan-after', 'bash-after', 'model-typed']) {
    for (const wait of [null, 'permission', 'plan', 'question'] as const) expect(readDialog(txt(s), wait)).toBeNull();
  }
  const reply = ['⏺ Two steps:', '', '  1. Build the app', '  2. Run the tests', '', RULE, '❯ ', RULE, '  ⏸ manual mode on · ? for shortcuts'];
  expect(readDialog(view(reply), null)).toBeNull();
  expect(readDialog(view(reply), 'permission')).toBeNull();
  // The same list as a dialog draws it, with no prompt box below: a dialog.
  expect(readDialog(view([...reply.slice(0, 5), 'Esc to cancel']), null)).toMatchObject({ kind: 'menu' });
  // A numbered list typed in the prompt box isn't one either.
  expect(readDialog(view(['⏺ Done.', '', RULE, '❯ 1. Build the app', '  2. Run the tests', RULE, '  ⏸ manual mode on']), null)).toBeNull();
});

test('a question wait with no question on screen reads nothing', () => {
  expect(readDialog(txt('model'), 'question')).toBeNull();
  expect(readDialog(txt('bash'), 'question')).toBeNull();
  expect(readDialog(txt('trust'), 'question')).toBeNull();
});

test('the page ignores the cursor: Bash with the cursor on No reads as the same page as with it on Yes', () => {
  const yes = readDialog(txt('bash-second'), 'permission')!;
  const no = readDialog(txt('bash-on-no'), 'permission')!;
  expect([yes.focused, no.focused]).toEqual([1, 4]);
  expect(no.page).toBe(yes.page);
  expect(yes.page).toMatch(/^[\w-]{8}$/);
  // Another request, a field's label changed, or another kind: another page.
  expect(readDialog(txt('bash'), 'permission')!.page).not.toBe(yes.page);
  expect(readDialog(txt('bash-amend'), 'permission')!.page).not.toBe(yes.page);
  expect(readDialog(txt('bash-second'), 'plan')!.page).not.toBe(yes.page);
});

test('rows and labels stay within their caps', () => {
  const long = 'x'.repeat(400);
  const d = readDialog(view([RULE, ...Array.from({ length: 50 }, (_, i) => `row ${i}`), long, 'Do you want to proceed?', '❯ 1. Yes', `  2. ${long}`, '  3. No', '', 'Esc to cancel']), 'permission')!;
  expect(d.rows).toHaveLength(40);
  // The rows nearest the options are the ones kept.
  expect(d.rows.at(-1)).toBe('Do you want to proceed?');
  expect(d.rows.at(-2)).toHaveLength(MAX_ROW);
  expect(d.options[1]!.label).toHaveLength(MAX_ROW);
  // A menu keeps its first rows, its title first.
  const menu = readDialog(view([RULE, 'Pick one', ...Array.from({ length: 50 }, (_, i) => `row ${i}`), '❯ 1. A', '  2. B', '', 'Esc to cancel']), null)!;
  expect(menu.rows).toHaveLength(40);
  expect(menu.rows[0]).toBe('Pick one');
});

test('promptState: empty, a dim placeholder or suggestion, typed text, or no prompt at all', async () => {
  expect(await state('idle')).toBe('empty');
  expect(await state('queued')).toBe('empty');      // "Press up to edit queued messages", dim
  expect(await state('plan-after')).toBe('empty');  // "commit this", a dim suggestion
  expect(await state('working')).toBe('empty');
  expect(await state('working-typed')).toBe('typed');
  expect(await state('model-typed')).toBe('typed');
  for (const s of ['bash', 'model', 'trust']) expect(await state(s)).toBe('none');
  // No box on screen; a box whose text is a numbered list.
  expect(promptState(view(['⏺ Done.', '', 'Esc to cancel']))).toBe('none');
  expect(promptState(view(['⏺ Done.', '', RULE, '❯ 1. Build the app', '  2. Run the tests', RULE, '  ⏸ manual mode on']))).toBe('typed');
  // Text typed on the box's second row only, under a titled rule.
  expect(promptState(view([`${'─'.repeat(100)} a-title ─`, '❯ ', '  second line', RULE]))).toBe('typed');
});

test('chooseKeys: a digit, a field\'s digit and text, No amended through arrows and Tab; refusals in words', () => {
  const bash = readDialog(txt('bash'), 'permission')!;
  const question = readDialog(txt('question'), 'question')!;
  const several = readDialog(txt('several'), 'question')!;
  const planField = readDialog(txt('plan-field'), 'plan')!;
  expect(chooseKeys(bash, { n: 1, label: 'Yes' })).toEqual({ ok: true, keys: '1' });
  expect(chooseKeys(bash, { n: 4, label: 'No' })).toEqual({ ok: true, keys: '4' });
  expect(chooseKeys(bash, { n: 4, label: 'No', text: 'use pnpm' })).toEqual({ ok: true, keys: '\x1b[B\x1b[B\x1b[B\t', text: 'use pnpm' });
  expect(chooseKeys(question, { n: 4, label: 'Type something.', text: 'Mango' })).toEqual({ ok: true, keys: '4', text: 'Mango' });
  expect(chooseKeys(question, { n: 4, label: 'Type something.' })).toMatchObject({ ok: false, code: 'invalid', message: 'This option needs text.' });
  expect(chooseKeys(question, { n: 2, label: 'Green', text: 'x' })).toMatchObject({ ok: false, message: 'This option takes no text.' });
  expect(chooseKeys(question, { n: 2, label: 'Blue' })).toMatchObject({ ok: false, code: 'busy', message: 'The request changed' });
  expect(chooseKeys(several, { n: 1, label: '[ ] Cats' })).toMatchObject({ ok: false, message: 'Answer in the terminal' });
  expect(chooseKeys(planField, { n: 1, label: 'Yes, and use auto mode' })).toMatchObject({ ok: false, message: 'Answer in the terminal' });
  // No such option on this page; a menu; arrows up to an amend above the cursor; no cursor to start the arrows from.
  expect(chooseKeys(question, { n: 7, label: 'Purple' })).toMatchObject({ ok: false, code: 'invalid', message: 'Answer in the terminal' });
  expect(chooseKeys(readDialog(txt('model'), null)!, { n: 1, label: 'Default' })).toMatchObject({ ok: false, code: 'invalid', message: 'Answer in the terminal' });
  const noFirst: ScreenDialog = { ...bash, options: [{ n: 1, label: 'No', amend: true }, { n: 2, label: 'Yes' }], focused: 2 };
  expect(chooseKeys(noFirst, { n: 1, label: 'No', text: 'x' })).toEqual({ ok: true, keys: '\x1b[A\t', text: 'x' });
  expect(chooseKeys({ ...noFirst, focused: null }, { n: 1, label: 'No', text: 'x' })).toMatchObject({ ok: false, code: 'invalid', message: 'Answer in the terminal' });
});
