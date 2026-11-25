// Claude Code's dialogs read from a session's screen, so a phone can show one as a card and answer it with the keys
// Claude Code itself takes. A session's wait says which dialog to expect: a permission request, a plan approval, or a
// question (one page at a time: each question, then the review page of several). Any other numbered list at the
// bottom is a menu (a slash command's, the folder trust dialog): shown, answered in the terminal.
// The options are those `dialogAtBottom` finds; the rows and labels are read from the screen at their positions.
import { createHash } from 'node:crypto';
import { DASHED, dialogAtBottom, FRAME, OPTION, PLAIN, RULE, TRANSCRIPT, type Row, type ScreenView } from './prompt';

export type DialogWait = 'permission' | 'plan' | 'question';
export type DialogKind = DialogWait | 'menu';
/**
 * `field`: choosing it only moves the cursor into a text field (the question's "Type something.", the plan's "Tell
 * Claude what to change"). `amend`: a permission's "No", which Tab turns into a field for optional feedback.
 */
export interface DialogOption { n: number; label: string; field?: true; amend?: true }
export interface ScreenDialog {
  kind: DialogKind;
  /** The dialog's own rows above its options (a menu: all of them). */
  rows: string[];
  /** Always empty for a menu. */
  options: DialogOption[];
  /** The option the cursor is on, if any. */
  focused: number | null;
  /** The cursor is in a text field: a digit would be typed into it. */
  inField: boolean;
  /** The options are checkboxes. */
  several: boolean;
  /** The folder trust dialog (Esc there exits Claude Code). */
  trust: boolean;
  /** b64url(SHA-256(kind, rows, labels))[0..8]: the same dialog page reads the same wherever the cursor is among its options. */
  page: string;
}
export const MAX_ROWS = 40, MAX_ROW = 300;

/** A row's text: no frame sides, no indent. */
const textOf = (line: string | undefined) => (line ?? '').replace(FRAME, '').trim();
/** How far across the screen a row's text reaches, in characters. */
const reach = (line: string | undefined) => [...(line ?? '').trimEnd()].length;
/** At most `MAX_ROW` UTF-16 units, never half a character. */
function cut(s: string): string {
  if (s.length <= MAX_ROW) return s;
  let out = '';
  for (const ch of s) {
    if (out.length + ch.length > MAX_ROW) break;
    out += ch;
  }
  return out;
}
/** The edge a dialog starts below: a solid rule (a dashed one is inside it) or a row of `▔`. */
const isTop = (row: string) => (RULE.test(row) && !DASHED.test(row)) || /^▔+$/.test(row);
/** A prompt box's upper edge: a rule, which may carry a title (`──── name ─`). */
const isBoxTop = (row: string) => RULE.test(row) || /^[─━]+ \S.* [─━]+$/.test(row);
/** The plan dialog's hint under its feedback option, whatever that option's label (it becomes the typed text). */
const FEEDBACK = 'shift+tab to approve with this feedback';
const PLAN_FIELD = 'Tell Claude what to change';
/** A question's chip or tab-bar row (`☐ Color`, `←  ☒ Season  ✔ Submit  →`), or its review page's title. */
const QUESTION_ROW = /[☐☒]|✔ Submit|^Review your answers$/;
const REVIEW = 'Review your answers';
/** The hint a dialog shows while its cursor is in a text field (or on Submit, past one). */
const EDITOR = 'ctrl+g to edit in Vim';
const CHECKBOX = /^\[(?: |✔)\]/;
const TRUST_HINT = 'Enter to confirm · Esc to cancel';

/** Claude's prompt box nearest the bottom: an edge, a row marked `❯` or `>` at its start, the rows typed below it, an edge. */
function promptBox(lines: readonly string[]): { from: number; to: number } | null {
  for (let i = lines.length - 1; i > 0; i--) {
    if (!/^[❯>]/.test((lines[i] ?? '').replace(FRAME, '')) || !isBoxTop(textOf(lines[i - 1]))) continue;
    for (let j = i + 1; j < lines.length; j++) if (RULE.test(textOf(lines[j]))) return { from: i, to: j };
  }
  return null;
}

/** The index of the row a dialog starts below, from row `at` up: its top edge, or a transcript row (marked at column 0). */
function topAbove(lines: readonly string[], at: number): number {
  let i = at;
  while (i >= 0 && !isTop(textOf(lines[i])) && !TRANSCRIPT.test(lines[i] ?? '')) i--;
  return i;
}

/** The rows strictly between two indices as text: empty rows and rules (dashed ones inside a dialog) left out. */
function rowsBetween(lines: readonly string[], from: number, to: number): string[] {
  const rows: string[] = [];
  for (let i = from + 1; i < to; i++) {
    const row = textOf(lines[i]);
    if (row && !RULE.test(row)) rows.push(cut(row));
  }
  return rows;
}

/** The index of the last row with text (-1: none). */
const lastRow = (lines: readonly string[]) => {
  let i = lines.length - 1;
  while (i >= 0 && !textOf(lines[i])) i--;
  return i;
};

/**
 * An option's label: its row's text, then each row right below it while the row before reached `cols − 20` or more
 * (Claude Code wrapped it), with no space where that row reached `cols − 1` (a hard wrap, inside a word). A numbered
 * row is the next option however long this one is; a rule, an empty row or the plan's feedback hint ends it too.
 * `end`: the label's last row.
 */
function labelOf(lines: readonly string[], o: Row, cols: number): { label: string; end: number } {
  let label = o.label;
  let end = o.line;
  for (let i = o.line + 1; i < lines.length; i++) {
    const row = textOf(lines[i]);
    const before = reach(lines[end]);
    if (!row || before < cols - 20 || OPTION.test(row) || RULE.test(row) || row === FEEDBACK) break;
    label += (before >= cols - 1 ? '' : ' ') + row;
    end = i;
  }
  return { label: cut(label), end };
}

const pageOf = (kind: DialogKind, rows: string[], options: DialogOption[]) =>
  createHash('sha256').update(JSON.stringify([kind, rows, options.map((o) => o.label)])).digest('base64url').slice(0, 8);

/** A menu: all its rows from its top edge (above row `at`) to its last row, its first `MAX_ROWS`. */
function menu(lines: readonly string[], at: number, trust: boolean): ScreenDialog {
  const rows = rowsBetween(lines, topAbove(lines, at), lastRow(lines) + 1).slice(0, MAX_ROWS);
  return { kind: 'menu', rows, options: [], focused: null, inField: false, several: false, trust, page: pageOf('menu', rows, []) };
}

/**
 * The dialog at the bottom of the screen. With the session's `wait`, the dialog it waits on (a question only once its
 * chip or tab bar shows); without one, any numbered list there is a menu, and the folder trust dialog (no numbers: its
 * cursor on an unnumbered row above `Enter to confirm · Esc to cancel`) a menu marked `trust`. Null when there is none,
 * or when the numbered rows sit above or inside Claude's prompt box (a list in a reply, or typed).
 */
export function readDialog(view: ScreenView, wait: DialogWait | null): ScreenDialog | null {
  const { lines, cols } = view;
  const d = dialogAtBottom(lines);
  if (!d) {
    if (wait) return null;
    const last = lastRow(lines);
    if (last < 0 || textOf(lines[last]) !== TRUST_HINT) return null;
    const trust = menu(lines, last, true);
    return trust.rows.slice(0, -1).some((r) => r.startsWith('❯') && !OPTION.test(r)) ? trust : null;
  }
  const box = promptBox(lines);
  if (box && box.to > d.options[0]!.line) return null;
  if (!wait) return menu(lines, d.options[0]!.line, false);

  const rows = rowsBetween(lines, topAbove(lines, d.options[0]!.line - 1), d.options[0]!.line).slice(-MAX_ROWS);
  if (wait === 'question' && !rows.some((r) => QUESTION_ROW.test(r))) return null;
  const read = d.options.map((o) => ({ ...labelOf(lines, o, cols), row: o }));
  // The hint row: the last row below the options (none on a question's review page).
  let hint = '';
  for (let i = lines.length - 1; i > read.at(-1)!.end && !hint; i--) hint = textOf(lines[i]);

  let field: number | null = null;
  if (wait === 'plan') field = read.find((r) => textOf(lines[r.end + 1]) === FEEDBACK || r.label === PLAN_FIELD)?.row.n ?? null;
  if (wait === 'question' && !rows.includes(REVIEW)) {
    // The last option above the rule drawn inside the list, before "Chat about this".
    const first = d.options[0]!.line;
    let rule = -1;
    for (let i = first + 1; i < d.options.at(-1)!.line && rule === -1; i++) if (RULE.test(textOf(lines[i]))) rule = i;
    if (rule !== -1) field = read.filter((r) => r.row.line < rule).at(-1)?.row.n ?? null;
  }
  const amend = wait === 'permission' && hint.includes('Tab to amend');
  const options: DialogOption[] = read.map(({ row, label }) => ({
    n: row.n, label,
    ...(row.n === field ? { field: true as const } : {}),
    ...(amend && label === 'No' ? { amend: true as const } : {})
  }));

  const at = read.find((r) => r.row.focused);
  const focused = at?.row.n ?? null;
  const inField = wait === 'permission' ? !!at && !PLAIN.test(at.label)
    : focused !== null ? focused === field
    // A question with no option under the cursor: on Submit, past the field, where the hint still offers the editor.
    : wait === 'question' && hint.includes(EDITOR);
  return {
    kind: wait, rows, options, focused, inField,
    several: options.some((o) => CHECKBOX.test(o.label)),
    trust: false,
    page: pageOf(wait, rows, options)
  };
}

export type PromptState = 'empty' | 'typed' | 'none';

/**
 * Claude's prompt box on screen: `typed` when text that isn't dim follows its mark (a dim placeholder or suggestion is
 * no text), `empty` otherwise; `none` while a dialog shows or no box is found.
 */
export function promptState(view: ScreenView): PromptState {
  if (readDialog(view, null)) return 'none';
  const box = promptBox(view.lines);
  if (!box) return 'none';
  for (let i = box.from; i < box.to; i++) {
    let row = (view.undimmed[i] ?? '').replace(FRAME, '');
    if (i === box.from) row = row.replace(/^\s*[❯>]?/, '');
    if (/\S/.test(row)) return 'typed';
  }
  return 'empty';
}

export type ChooseKeys = { ok: true; keys: string; text?: string } | { ok: false; code: 'busy' | 'invalid'; message: string };

const IN_TERMINAL: ChooseKeys = { ok: false, code: 'invalid', message: 'Answer in the terminal' };
const DOWN = '\x1b[B', UP = '\x1b[A';

/**
 * The keys that choose option `n` (labelled `label`, as the phone showed it) in dialog `d`: its digit; for a field,
 * its digit and then the text, typed once the cursor is in the field; for a permission's "No" with feedback, the arrows
 * from the cursor to it and Tab, then the text. Refused when the dialog is answered in the terminal (a menu,
 * checkboxes, the cursor already in a field: a digit would be typed there), or the option isn't the one shown.
 */
export function chooseKeys(d: ScreenDialog, o: { n: number; label: string; text?: string }): ChooseKeys {
  if (d.kind === 'menu' || d.several || d.inField) return IN_TERMINAL;
  const option = d.options.find((x) => x.n === o.n);
  if (!option) return IN_TERMINAL;
  if (option.label !== o.label) return { ok: false, code: 'busy', message: 'The request changed' };
  if (option.field) return o.text ? { ok: true, keys: String(o.n), text: o.text } : { ok: false, code: 'invalid', message: 'This option needs text.' };
  if (!o.text) return { ok: true, keys: String(o.n) };
  if (!option.amend) return { ok: false, code: 'invalid', message: 'This option takes no text.' };
  if (d.focused === null) return IN_TERMINAL;
  const steps = o.n - d.focused;
  return { ok: true, keys: (steps > 0 ? DOWN : UP).repeat(Math.abs(steps)) + '\t', text: o.text };
}

/**
 * Whether option `n`'s field shows `text`: the cursor in it, and its label holding the text's first 40 characters
 * that aren't spaces (spaces left out on both sides: a long text wraps anywhere, and only its start may show).
 */
export function fieldHolds(d: ScreenDialog, n: number, text: string): boolean {
  if (d.focused !== n || !d.inField) return false;
  const label = d.options.find((o) => o.n === n)?.label.replace(/\s+/g, '') ?? '';
  return label.includes([...text.replace(/\s+/g, '')].slice(0, 40).join(''));
}
