import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { chooseKeys, claudeWorking, fieldHolds, MAX_ROW, menuToClose, promptHolds, promptImages, promptState, readDialog, type ScreenDialog } from './dialog';
import { screenView, type ScreenView } from './prompt';

const SCREENS = join(__dirname, '../../../tests/fixtures/claude-2.1.332/screens');
/** Rows as a screen shows them, with no dim text, 120 columns wide (as the recording). */
const view = (lines: string[]): ScreenView => ({ lines, undimmed: lines, cols: 120, bracketedPaste: true });
/** A recorded screen from its text rows. */
const txt = (name: string): ScreenView => view(readFileSync(join(SCREENS, `${name}.txt`), 'utf8').split('\n'));
/** A recorded screen from its snapshot, dim text included. */
const ans = (name: string) => screenView(readFileSync(join(SCREENS, `${name}.ans`), 'utf8'), { cols: 120, rows: 40 });
/** The prompt's state on a recorded screen read from its snapshot. */
const state = async (name: string) => promptState(await ans(name));
/** A recorded screen with some of its rows replaced (by their index in the `.txt`), and rows put in before one. */
const edited = (name: string, rows: Record<number, string>, insert: { before: number; rows: string[] } | null = null): ScreenView => {
  const lines = txt(name).lines.map((l, i) => rows[i] ?? l);
  if (insert) lines.splice(insert.before, 0, ...insert.rows);
  return view(lines);
};
/** Text of wide characters (two columns each), as typed in Japanese. */
const WIDE = '確認'.repeat(30);

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
  const long: ScreenDialog = { ...typed, fieldText: 'ab '.repeat(22) };
  expect(fieldHolds(long, 4, 'ab '.repeat(30))).toBe(true);
  expect(fieldHolds(long, 4, `${'ab '.repeat(19)}ax`)).toBe(false);
  // Spaces alone are nothing to find.
  expect(fieldHolds(typed, 4, '   ')).toBe(false);
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

test('a field\'s text read whole wherever it wraps: wide characters take two columns; the plan\'s feedback runs to its hint', () => {
  // 57 wide characters reach column 119 on the field's row: the rest wrapped to the next, inside the word.
  const question = readDialog(edited('question-field-typed', { 35: `❯ 3. ${WIDE.slice(0, 57)}` }, { before: 36, rows: [`     ${WIDE.slice(57)}`] }), 'question')!;
  expect(question.options[2]).toEqual({ n: 3, label: WIDE, field: true });
  // The plan's feedback in wide characters, or with a path pushed to the next row and a blank row: still its field.
  const cjk = readDialog(edited('plan-field-typed', { 36: `   ❯ 3. ${WIDE.slice(0, 55)}` }, { before: 37, rows: [`        ${WIDE.slice(55)}`] }), 'plan')!;
  const path = `${'docs/'.repeat(20)}verify.md`;
  const wrapped = readDialog(edited('plan-field-typed', { 36: '   ❯ 3. Skip the verify step and read' }, { before: 37, rows: [`        ${path}`, '', '        then stop.'] }), 'plan')!;
  for (const [d, text] of [[cjk, WIDE], [wrapped, `Skip the verify step and read ${path} then stop.`]] as const) {
    expect(d.options[2]).toEqual({ n: 3, label: text, field: true });
    expect(d).toMatchObject({ focused: 3, inField: true });
    expect(chooseKeys(d, { n: 1, label: 'Yes, and use auto mode' })).toMatchObject({ ok: false, message: 'Answer in the terminal' });
    expect(fieldHolds(d, 3, text)).toBe(true);
  }
});

test('a permission\'s feedback and a question\'s own answer wrapped before a long word: the field holds the whole text, and the card names it whole', () => {
  // Claude Code wraps a field at word ends: a path that doesn't fit moves to the next row, the row above ends short.
  const path = 'src/main/remote/conversation-requests.ts';
  const feedback = `do not create it; read ${path} and say ok`;
  const no = readDialog(edited('bash-amend-typed', { 37: ' ❯ 4. No, do not create it; read' }, { before: 38, rows: [`      ${path} and say ok`] }), 'permission')!;
  expect(no).toMatchObject({ focused: 4, inField: true, fieldText: feedback });
  expect(no.options[3]!.label).toBe(`No, ${feedback}`);
  expect(fieldHolds(no, 4, feedback)).toBe(true);
  const answer = `Mango, as in notes/${'fruit/'.repeat(8)}mango.md`;
  const own = readDialog(edited('question-field-typed', { 35: '❯ 3. Mango, as in' }, { before: 36, rows: [`     notes/${'fruit/'.repeat(8)}mango.md`] }), 'question')!;
  expect(own).toMatchObject({ focused: 3, inField: true, fieldText: answer });
  expect(own.options[2]).toEqual({ n: 3, label: answer, field: true });
  // The other options keep their descriptions apart; Esc's hint below a field is no part of it.
  expect(own.options.map((o) => o.label).slice(0, 2)).toEqual(['Apple', 'Pear']);
  const hinted = readDialog(edited('bash-amend-typed', { 38: ' Esc to cancel' }), 'permission')!;
  expect(hinted.options[3]!.label).toBe('No, do not create it, just say ok');
});

test('a field holds the text only from its start, its dim placeholder no text; a field holding text already is answered in the terminal', async () => {
  // Empty fields: their placeholders are dim, nothing typed.
  const question = readDialog(await ans('question-field'), 'question')!;
  expect(question).toMatchObject({ focused: 3, inField: true, fieldText: '' });
  expect(fieldHolds(question, 3, 'Type something.')).toBe(false);
  expect(fieldHolds(question, 3, 'something')).toBe(false);
  expect(fieldHolds(readDialog(await ans('plan-field'), 'plan')!, 3, 'Tell Claude what to change')).toBe(false);
  expect(fieldHolds(readDialog(await ans('bash-amend'), 'permission')!, 4, 'and tell Claude what to do differently')).toBe(false);
  // Typed: there from the start (a permission's "No, " before it).
  expect(fieldHolds(readDialog(await ans('bash-amend-typed'), 'permission')!, 4, 'do not create it, just say ok')).toBe(true);
  expect(fieldHolds(readDialog(await ans('question-field-typed'), 'question')!, 3, 'Mango')).toBe(true);
  expect(fieldHolds(readDialog(await ans('plan-field-typed'), 'plan')!, 3, 'Skip the verify step.')).toBe(true);
  // Text left in the field, the phone's typed after it: not what the phone sent.
  const merged = readDialog(edited('question-field-typed', { 35: '❯ 3. MangoKiwi' }), 'question')!;
  expect(fieldHolds(merged, 3, 'Kiwi')).toBe(false);
  expect(fieldHolds(merged, 3, 'MangoKiwi')).toBe(true);
  // The cursor moved off a field that holds text: its digit would put the phone's text after it.
  const unfocused = 'Enter to select · ↑/↓ to navigate · Esc to cancel';
  const left = readDialog(edited('question-field-typed', { 31: '❯ 1. Apple', 35: '  3. Mango', 39: unfocused }), 'question')!;
  expect(left).toMatchObject({ focused: 1, inField: false });
  expect(left.options[2]).toEqual({ n: 3, label: 'Mango', field: true });
  expect(chooseKeys(left, { n: 3, label: 'Mango', text: 'Kiwi' })).toMatchObject({ ok: false, code: 'invalid', message: 'Answer in the terminal' });
  const plan = readDialog(edited('plan-field-typed', { 34: '   ❯ 1. Yes, and use auto mode', 36: '     3. Skip the verify step.' }), 'plan')!;
  expect(chooseKeys(plan, { n: 3, label: 'Skip the verify step.', text: 'x' })).toMatchObject({ ok: false, message: 'Answer in the terminal' });
  // Untouched, with the cursor elsewhere: answered from the phone.
  expect(chooseKeys(readDialog(txt('plan'), 'plan')!, { n: 3, label: 'Tell Claude what to change', text: 'x' })).toEqual({ ok: true, keys: '3', text: 'x' });
});

test('a list typed in a field, its numbers starting rows, takes no digit: a read with no option under the cursor is answered in the terminal', () => {
  // Typed as "1. first\n2. second", the list's first item sits on the field's own row: the options read as drawn.
  const inline = readDialog(edited('plan-field-typed', { 36: '   ❯ 3. 1. first' }, { before: 37, rows: ['        2. second'] }), 'plan')!;
  expect(inline).toMatchObject({ focused: 3, inField: true });
  expect(inline.options[2]).toEqual({ n: 3, label: '1. first 2. second', field: true });
  // Below a first line, or pushed to the next row by a wrap, its numbers start rows and pass for the options.
  const plan = edited('plan-field-typed', { 36: '   ❯ 3. Changes:' }, { before: 37, rows: ['        1. first', '        2. second'] });
  const amend = edited('bash-amend-typed', { 37: ' ❯ 4. No, changes:' }, { before: 38, rows: ['      1. first', '      2. second'] });
  const wrapped = edited('bash-amend-typed', { 37: ' ❯ 4. No, run the checks again in this order, stop at the first one that fails, then tell me what broke and' }, { before: 38, rows: ['      1. first 2. second'] });
  for (const [screen, wait] of [[plan, 'plan'], [amend, 'permission'], [wrapped, 'permission']] as const) {
    const d = readDialog(screen, wait)!;
    expect(d.focused).toBeNull();
    const first = d.options[0]!;
    expect(first.label.startsWith('first')).toBe(true);
    expect(chooseKeys(d, { n: 1, label: first.label })).toMatchObject({ ok: false, code: 'invalid', message: 'Answer in the terminal' });
    expect(fieldHolds(d, 1, 'first')).toBe(false);
  }
});

test('a permission\'s hint row tells an option from its field: "Tab to amend" on an option, "Esc to cancel" alone in the field', () => {
  for (const s of ['bash', 'bash-second', 'bash-on-no', 'edit']) expect(readDialog(txt(s), 'permission'), s).toMatchObject({ inField: false });
  for (const s of ['bash-amend', 'bash-amend-typed']) expect(readDialog(txt(s), 'permission'), s).toMatchObject({ inField: true });
  // Feedback that ends like a key hint is still feedback in the field.
  const esc = readDialog(edited('bash-amend-typed', { 37: ' ❯ 4. No, cancel it (esc)' }), 'permission')!;
  expect(esc).toMatchObject({ focused: 4, inField: true });
  expect(chooseKeys(esc, { n: 1, label: 'Yes' })).toMatchObject({ ok: false, message: 'Answer in the terminal' });
  // The same label under a hint offering Tab to amend is an option of its own.
  expect(readDialog(edited('bash-amend-typed', { 37: ' ❯ 4. No, cancel it (esc)', 39: ' Esc to cancel · Tab to amend' }), 'permission')).toMatchObject({ focused: 4, inField: false });
  // A dialog that never offers to amend: its "Yes" is no field.
  expect(readDialog(edited('bash', { 39: ' Esc to cancel' }), 'permission')).toMatchObject({ focused: 1, inField: false });
});

test('a question\'s cursor is in a field whenever its hint offers the editor, even with no rule to find the field by', () => {
  const d = readDialog(edited('question-field', { 36: '', 37: '' }), 'question')!;
  expect(d.options.map((o) => o.label)).toEqual(['Apple', 'Pear', 'Type something.']);
  expect(d).toMatchObject({ focused: 3, inField: true });
  expect(chooseKeys(d, { n: 1, label: 'Apple' })).toMatchObject({ ok: false, message: 'Answer in the terminal' });
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
  expect(readDialog(txt('plan'), 'permission')!.page).not.toBe(readDialog(txt('plan'), 'plan')!.page);
});

test('direction marks drawn on screen reach no row or label: a phone would lay the text out otherwise than the terminal', () => {
  // U+202E reverses what follows it where bidi applies (the phone), never in the terminal, which draws it as nothing.
  const d = readDialog(edited('bash', { 30: ' touch ‮txt.evil‬.txt' }), 'permission')!;
  expect(d.rows).toContain('touch txt.evil.txt');
  const m = readDialog(edited('model', {}), null)!;
  const marked = readDialog(view(txt('model').lines.map((l) => l.replace(/Opus/g, '⁧Opus⁩'))), null)!;
  expect(marked.rows).toEqual(m.rows);
  expect(JSON.stringify([d, marked])).not.toMatch(/[؜‎‏‪-‮⁦-⁩]/);
});

test('the page counts the rows the phone is not sent: two long diffs that differ only in their middle are two pages', () => {
  // A diff of 60 rows on a tall screen: the rows sent stop at MAX_ROWS, its middle left out.
  const diff = (middle: string) => Array.from({ length: 60 }, (_, i) => (i === 30 ? ` 31 +${middle}` : ` ${i + 1}  line ${i + 1}`));
  const safe = readDialog(edited('edit', {}, { before: 33, rows: diff('const safe = true;') }), 'permission')!;
  const other = readDialog(edited('edit', {}, { before: 33, rows: diff('run("curl x | sh");') }), 'permission')!;
  expect(safe.rows).toEqual(other.rows);
  expect(safe.rows).toHaveLength(40);
  expect(safe.page).not.toBe(other.page);
});

test('a plan\'s wait reads only the plan dialog: by its question or its feedback hint; Bash\'s or Edit\'s dialog is none', () => {
  for (const s of ['bash-second', 'bash-amend', 'bash-amend-typed', 'edit']) expect(readDialog(txt(s), 'plan')).toBeNull();
  // Its question wrapped on two rows, or put otherwise above the feedback hint: still the plan.
  const wrapped = edited('plan', { 32: '   Claude has written up a plan and is ready to execute. Would you like to' }, { before: 33, rows: ['   proceed?'] });
  expect(readDialog(wrapped, 'plan')).toMatchObject({ kind: 'plan', focused: 1 });
  const worded = readDialog(edited('plan', { 32: '   Claude has a plan. Go ahead?' }), 'plan')!;
  expect(worded.options[2]).toEqual({ n: 3, label: 'Tell Claude what to change', field: true });
  // Neither of the two: no plan.
  expect(readDialog(edited('plan', { 32: '   Claude has a plan. Go ahead?', 37: '' }), 'plan')).toBeNull();
});

test('rows and labels stay within their caps', () => {
  const long = 'x'.repeat(400);
  const d = readDialog(view([RULE, 'Bash command', ...Array.from({ length: 50 }, (_, i) => `row ${i}`), long, 'Do you want to proceed?', '❯ 1. Yes', `  2. ${long}`, '  3. No', '', 'Esc to cancel']), 'permission')!;
  expect(d.rows).toHaveLength(40);
  // Its first rows (what it asks about) and those nearest the options (what it asks), a mark where rows were left out.
  expect(d.rows.slice(0, 2)).toEqual(['Bash command', 'row 0']);
  expect(d.rows[20]).toBe('…');
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

test('subject: a request\'s rows outside the dashed rules (its title, its path) and its question, never the diff or command between them', () => {
  expect(readDialog(txt('edit'), 'permission')!.subject).toEqual(['Edit file', 'hello.txt', 'Do you want to make this edit to hello.txt?']);
  expect(readDialog(txt('bash'), 'permission')!.subject).toEqual(['Bash command', 'Tip: auto mode handles these prompts for you — choose "switch to auto mode" below', 'Create empty file made-by-bash.txt', 'Do you want to proceed?']);
  // No dashed rules: only its question, wrapped over two rows.
  const lines = txt('edit').lines;
  const at = lines.findIndex((l) => l.includes('Do you want to make'));
  const plain = view([...lines.slice(0, at).filter((l) => !/╌/.test(l)), ' Do you want to make this edit to', ' hello.txt?', ...lines.slice(at + 1)]);
  expect(readDialog(plain, 'permission')!.subject).toEqual(['Do you want to make this edit to', 'hello.txt?']);
  expect(readDialog(txt('model'), null)!.subject).toEqual([]);
});

test('claudeWorking: Claude Code\'s "esc to interrupt" under its prompt box, with no dialog; nowhere else', async () => {
  expect(claudeWorking(await ans('working'))).toBe(true);
  expect(claudeWorking(await ans('queued'))).toBe(true);
  // Text typed in the prompt takes the hint's place; a turn over, a dialog or a menu has none.
  for (const s of ['working-typed', 'idle', 'plan-after', 'bash-after', 'bash', 'question', 'model', 'trust']) expect(claudeWorking(await ans(s)), s).toBe(false);
  // The words in a reply above the box, or under it but not as the hint's own part of its row.
  const working = txt('working').lines;
  expect(claudeWorking(view([...working.slice(0, 25), '⏺ Press esc to interrupt it.', ...working.slice(26, 39), '  ⏸ manual mode on']))).toBe(false);
  expect(claudeWorking(view([...working.slice(0, 39), '  ⏸ manual mode on · press esc to interrupt it']))).toBe(false);
  // Another mode's row, a status line below it.
  expect(claudeWorking(view([...working.slice(0, 39), '  ⏵⏵ accept edits on · esc to interrupt', '  main · Opus 5.5']))).toBe(true);
  // A numbered list at the bottom (a menu over the box) wins: Esc would close it.
  expect(claudeWorking(view([...working.slice(0, 40), '❯ 1. Yes', '  2. No']))).toBe(false);
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

test('promptHolds: the prompt box holds the text and nothing else, wrapped anywhere, its echoed paste markers no text', async () => {
  /** The idle screen's prompt box holding `rows` as typed. */
  const typed = (...rows: string[]) => edited('idle', { 37: `❯ ${rows[0]}` }, { before: 38, rows: rows.slice(1).map((r) => `  ${r}`) });
  expect(promptHolds(typed('fix the tests'), 'fix the tests')).toBe(true);
  // Wrapped inside a word or at a space; its lines on rows of their own; a tab drawn as spaces.
  expect(promptHolds(typed('fix the te', 'sts'), 'fix the tests')).toBe(true);
  expect(promptHolds(typed('fix the tests', 'then run them'), 'fix the tests\nthen run them')).toBe(true);
  expect(promptHolds(typed('fix    the tests'), 'fix\tthe tests')).toBe(true);
  // A bracketed paste's markers as a terminal echoing its input draws them, wrapped too.
  expect(promptHolds(typed('^[[200~fix the tests^[[201~'), 'fix the tests')).toBe(true);
  expect(promptHolds(typed('^[[200~fix the tests^[[2', '01~'), 'fix the tests')).toBe(true);
  // A slash command with Claude Code's list of commands above the box.
  expect(promptHolds(txt('model-typed'), '/model')).toBe(true);
  // Another text, the text and more before or after it, part of it, one line of two, nothing.
  expect(promptHolds(txt('working-typed'), 'fix the tests')).toBe(false);
  expect(promptHolds(typed('fix the tests and the build'), 'fix the tests')).toBe(false);
  expect(promptHolds(typed('lint, then fix the tests'), 'fix the tests')).toBe(false);
  expect(promptHolds(typed('fix the'), 'fix the tests')).toBe(false);
  expect(promptHolds(typed('fix the tests'), 'fix the tests\nthen run them')).toBe(false);
  expect(promptHolds(txt('idle'), 'fix the tests')).toBe(false);
  // Dim text is no text (the queued prompt's placeholder); no prompt box; a dialog at the bottom, the box above it.
  expect(promptHolds(await ans('queued'), 'Press up to edit queued messages')).toBe(false);
  expect(promptHolds(view(['⏺ fix the tests']), 'fix the tests')).toBe(false);
  expect(promptHolds(view([RULE, '❯ fix the tests', RULE, 'Do you want to proceed?', '❯ 1. Yes', '  2. No', '', 'Esc to cancel']), 'fix the tests')).toBe(false);
});

test('promptImages: the [Image #N] markers in Claude\'s prompt box, whatever their numbers, dim or not; none without a box', () => {
  const typed = (...rows: string[]) => edited('idle', { 37: `❯ ${rows[0]}` }, { before: 38, rows: rows.slice(1).map((r) => `  ${r}`) });
  expect(promptImages(txt('idle'))).toBe(0);
  expect(promptImages(typed('[Image #1]'))).toBe(1);
  expect(promptImages(typed('[Image #3][Image #4] What color is it?'))).toBe(2);
  // Wrapped across rows; text that only looks like one (no number, a word inside).
  expect(promptImages(typed('[Image #1][Ima', 'ge #2]'))).toBe(2);
  expect(promptImages(typed('[Image #] [Image one]'))).toBe(0);
  // Drawn dim, it still counts.
  const dim = typed('[Image #1]');
  expect(promptImages({ ...dim, undimmed: dim.undimmed.map((r) => r.replace('[Image #1]', ' '.repeat(10))) })).toBe(1);
  // No box, or a dialog at the bottom: none to count.
  expect(promptImages(view(['⏺ [Image #1]']))).toBeNull();
  expect(promptImages(view([RULE, '❯ [Image #1]', RULE, 'Do you want to proceed?', '❯ 1. Yes', '  2. No', '', 'Esc to cancel']))).toBeNull();
});

test('promptHolds with images: the text after its markers, and exactly that many markers; the text check leaves them out', () => {
  const typed = (...rows: string[]) => edited('idle', { 37: `❯ ${rows[0]}` }, { before: 38, rows: rows.slice(1).map((r) => `  ${r}`) });
  // Pasted right after the marker (no space), or after the space the computer pasted first; two images.
  expect(promptHolds(typed('[Image #1]What color is it?'), ' What color is it?', 1)).toBe(true);
  expect(promptHolds(typed('[Image #1] What color is it?'), ' What color is it?', 1)).toBe(true);
  expect(promptHolds(typed('[Image #2][Image #3] Compare th', 'em.'), ' Compare them.', 2)).toBe(true);
  // Images alone: the markers and nothing else.
  expect(promptHolds(typed('[Image #1]'), '', 1)).toBe(true);
  expect(promptHolds(typed('[Image #1][Image #2]'), '', 2)).toBe(true);
  // One marker short or one too many, its path still drawn as text, text after it, nothing at all.
  expect(promptHolds(typed('[Image #1]'), '', 2)).toBe(false);
  expect(promptHolds(typed('[Image #1][Image #2]'), '', 1)).toBe(false);
  expect(promptHolds(typed('[Image #1] /tmp/atelier-clipboard/clipboard-2.png'), '', 2)).toBe(false);
  expect(promptHolds(typed('[Image #1] a draft'), '', 1)).toBe(false);
  expect(promptHolds(txt('idle'), '', 1)).toBe(false);
  expect(promptHolds(txt('idle'), '', 0)).toBe(false);
  // Without images, a marker in the prompt is more than the text: an Enter would send that image too.
  expect(promptHolds(typed('[Image #1]fix the tests'), 'fix the tests')).toBe(false);
  // A text that names a marker itself counts it.
  expect(promptHolds(typed('[Image #1] see [Image #1]'), ' see [Image #1]', 1)).toBe(true);
  // A text that is only a marker's characters, with no image: typed as text, it is that text (as before images).
  expect(promptHolds(typed('[Image #1]'), '[Image #1]')).toBe(true);
  expect(promptHolds(typed('[Image #1][Image #2]'), '[Image #1] [Image #2]')).toBe(true);
  // Folded after its marker, as a long paste is.
  expect(promptHolds(typed('[Image #1][Pasted text #2 +40 lines]'), ` ${Array.from({ length: 41 }, (_, i) => `Line ${i}`).join('\n')}`, 1)).toBe(true);
});

test('on Claude Code\'s own screens: an image\'s path pasted alone is one marker, the text pasted after it holds with it', async () => {
  const pasted = await ans('image-pasted');
  const text = await ans('image-text');
  expect(promptImages(pasted)).toBe(1);
  expect(promptImages(text)).toBe(1);
  // The marker is text in the box (an Enter would send it), drawn in plain text, not dim.
  expect(promptState(pasted)).toBe('typed');
  expect(promptHolds(pasted, '', 1)).toBe(true);
  expect(promptHolds(pasted, '', 2)).toBe(false);
  expect(promptHolds(pasted, '')).toBe(false);
  // The text as pasted after it (a space first), and only with its image.
  expect(promptHolds(text, ' What color is this image?', 1)).toBe(true);
  expect(promptHolds(text, '', 1)).toBe(false);
  expect(promptHolds(text, ' What color is this image?')).toBe(false);
  expect(promptHolds(text, ' What color is this?', 1)).toBe(false);
});

/** A recorded paste's text: `n` characters of one sentence again and again, a last space made a full stop. */
const sentences = (n: number) => {
  const s = 'The quick brown fox jumps over the lazy dog. '.repeat(Math.ceil(n / 45)).slice(0, n);
  return s.endsWith(' ') ? `${s.slice(0, -1)}.` : s;
};
/** Each recorded paste's screen, by fixture, and the text pasted there. */
const PASTED: Record<string, string> = {
  'paste-three-lines': ['Line one of the pasted text.', 'Line two of the pasted text.', 'Line three of the pasted text.'].join('\n'),
  'paste-four-lines': ['Line 1.', 'Line 2.', 'Line 3.', 'Line 4.'].join('\n'),
  'paste-forty-lines': Array.from({ length: 40 }, (_, i) => `Line ${i + 1} of the long pasted text.`).join('\n'),
  'paste-two-long-lines': [sentences(450), sentences(450)].join('\n'),
  'paste-three-long-lines': [sentences(300), sentences(300), sentences(300)].map((l) => `${l.trimEnd()}.`).join('\n'),
  'paste-line-500': sentences(500),
  'paste-line-800': sentences(800),
  'paste-line-801': sentences(801),
  'paste-line-1000': sentences(1000),
  'paste-line-2000': sentences(2000)
};

test('promptHolds on recorded pastes: each text as Claude Code draws it, inline or folded; one key typed after it, refused', async () => {
  for (const [name, text] of Object.entries(PASTED)) expect(promptHolds(await ans(name), text), name).toBe(true);
  // A key typed on the computer right after the paste, drawn inline or after the stand-in.
  expect(promptHolds(await ans('paste-three-lines-typed'), PASTED['paste-three-lines']!)).toBe(false);
  expect(promptHolds(await ans('paste-forty-lines-typed'), PASTED['paste-forty-lines']!)).toBe(false);
});

test('promptHolds: the stand-in only for a text Claude Code folds, with the count of its line breaks', async () => {
  // A text that is drawn inline (800 characters at most, 2 line breaks at most) is never a stand-in's.
  expect(promptHolds(await ans('paste-line-801'), PASTED['paste-line-800']!)).toBe(false);
  expect(promptHolds(await ans('paste-three-long-lines'), PASTED['paste-three-lines']!)).toBe(false);
  // Another count of line breaks, a count for a single line, none for a text of several.
  expect(promptHolds(await ans('paste-forty-lines'), PASTED['paste-four-lines']!)).toBe(false);
  expect(promptHolds(await ans('paste-four-lines'), PASTED['paste-line-2000']!)).toBe(false);
  expect(promptHolds(await ans('paste-line-2000'), PASTED['paste-forty-lines']!)).toBe(false);
  // The two folds a text may get, one by its length, one by its line breaks; the stand-in's number is any.
  const folded = (row: string) => edited('idle', { 37: `❯ ${row}` });
  expect(promptHolds(folded('[Pasted text #3 +1 lines]'), PASTED['paste-two-long-lines']!)).toBe(true);
  expect(promptHolds(folded('[Pasted text #1 +1 line]'), PASTED['paste-two-long-lines']!)).toBe(false);
  expect(promptHolds(folded('lint [Pasted text #1 +3 lines]'), PASTED['paste-four-lines']!)).toBe(false);
});

test('menuToClose: a menu; a permission, a plan or a question drawn before its hook is none; the trust dialog exits', () => {
  expect(menuToClose(txt('model'))).toBe('menu');
  const requests = ['bash', 'bash-second', 'bash-on-no', 'bash-amend', 'edit', 'plan', 'plan-field', 'question', 'question-fruit', 'questions-first', 'questions-review', 'several', 'several-review'];
  for (const s of requests) expect(menuToClose(txt(s))).toBeNull();
  for (const s of ['idle', 'working', 'working-typed', 'queued', 'model-typed']) expect(menuToClose(txt(s))).toBeNull();
  // Each of a request's own marks alone, in a list otherwise a menu's.
  const list = (o: { above?: string; hint?: string } = {}) =>
    view([RULE, 'Pick one', ...(o.above ? [o.above] : []), '❯ 1. A', '  2. B', '', o.hint ?? 'Enter to select · Esc to cancel']);
  expect(menuToClose(list())).toBe('menu');
  const marks = ['Do you want to proceed?', 'Do you want to make this edit to a.ts?', 'Would you like to proceed?', '☐ Color', '←  ☐ Season  ✔ Submit  →', 'Review your answers'];
  for (const above of marks) expect(menuToClose(list({ above }))).toBeNull();
  expect(menuToClose(list({ hint: 'Esc to cancel · Tab to amend' }))).toBeNull();
  expect(menuToClose(list({ hint: 'shift+tab to approve with this feedback' }))).toBeNull();
  // A permission longer than the rows a menu keeps (a long diff): its marks near the options still count.
  const long = edited('edit', {}, { before: 33, rows: Array.from({ length: 45 }, (_, i) => ` ${i + 3} +added line ${i}`) });
  expect(readDialog(long, null)!.rows).not.toContain('Do you want to make this edit to hello.txt?');
  expect(menuToClose(long)).toBeNull();
  // The trust dialog as this version draws it, numbered as others do, and another dialog Esc exits Claude Code from.
  expect(menuToClose(txt('trust'))).toBe('exits');
  const framed = (row: string) => `│ ${row.padEnd(56)} │`;
  const numbered = view([`╭${'─'.repeat(58)}╮`, framed('Do you trust the files in this folder?'), framed(''), framed('/work/app'), framed(''),
    framed('❯ 1. Yes, proceed'), framed('  2. No, exit'), framed(''), `╰${'─'.repeat(58)}╯`, '   Enter to confirm · Esc to exit']);
  expect(readDialog(numbered, null)).toMatchObject({ kind: 'menu', trust: false });
  expect(menuToClose(numbered)).toBe('exits');
  expect(menuToClose(view([RULE, 'WARNING: Claude Code running in Bypass Permissions mode', '❯ 1. No, exit', '  2. Yes, I accept', '', 'Enter to confirm · Esc to exit']))).toBe('exits');
});
