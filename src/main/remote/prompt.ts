// Allow and Deny from a phone answer Claude Code's permission dialog with its own keys, read from the terminal's
// screen. Allow picks the option the dialog labels "Yes" (allow once): a digit chooses an option of its selection lists
// outright, and the dialog doesn't always list "Yes" first. Deny is Esc. Either is sent only for the request the phone
// showed: the dialog's text above its options must name it (its command, its file, or the tool alone), since the
// phone shows the latest request while Claude Code asks in turn (parallel agents) and a question may sit in front.
// Refused (nothing typed) when the screen shows no such dialog at its bottom, and Allow when the cursor is in a field
// — after Tab, an option turns into a field for feedback, and a digit would be typed into it.
import { Terminal as Headless } from '@xterm/headless';

export type AllowKey = { ok: true; key: string } | { ok: false; message: string };

const REFUSED: AllowKey = { ok: false, message: 'Open the session to answer' };
/** A dialog's numbered row: the cursor's mark when it is on it, its number, its label. */
export const OPTION = /^(?:([❯›>▸])\s*)?(\d)\.\s+(.+)$/;
/** A bordered frame's sides, drawn by some versions. */
export const FRAME = /^[│┃|]\s?|\s?[│┃|]$/g;
/**
 * The dialog must end this close to the bottom of the screen: after it only its hints, a frame's bottom edge and a
 * status line. An older one, answered already, doesn't count.
 */
const NEAR_BOTTOM = 4;
/** A row the dialog always draws as it is: "Yes", "No", or a label ending in its key hint ("(esc)", "(shift+tab)"). */
export const PLAIN = /^(Yes|No)$|\((?:esc|[a-z]+(?:\+[a-z]+)+)\)$/;
/** A row that only draws a line: the dialog's top edge, a frame's or a box's edge. The dialog starts below it. */
export const RULE = /^[─━═╌╍┄┅┈┉╭╮╰╯┌┐└┘┏┓┗┛├┤┬┴\s]*[─━═╌╍┄┅┈┉][─━═╌╍┄┅┈┉╭╮╰╯┌┐└┘┏┓┗┛├┤┬┴\s]*$/;
/**
 * A row of dashes only: inside the dialog, around the command or the diff it asks about (Claude Code 2.1 draws it
 * between two), never its top edge, which is a solid line. What stands between them is the request itself: a command
 * must be all of it, and a diff's text names nothing (it may mention any file or tool).
 */
export const DASHED = /^[╌╍┄┅┈┉\s]*[╌╍┄┅┈┉][╌╍┄┅┈┉\s]*$/;
/** The transcript's marks (a message, a tool call, its result): above the dialog, never part of it. */
export const TRANSCRIPT = /^[⏺●⎿]/;
/** At most this many rows above its options are the dialog's. */
const DIALOG_ROWS = 100;
/** Tools whose request names a file by its last part ("Edit upload.ts"), as their dialog names it. */
export const FILE_TOOLS: ReadonlySet<string> = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit', 'Read']);

export interface Row { n: number; label: string; focused: boolean; /** The row's index in the lines given (untrimmed, empty rows counted). */ line: number }

/**
 * The dialog at the bottom of the screen: its options, the rows of its own above them outside the dashed rules, the
 * rows between those rules (null when it draws none), and the cursor in a field.
 */
export interface Dialog { options: Row[]; above: string[]; body: string[] | null; inField: boolean }

export function dialogAtBottom(lines: readonly string[]): Dialog | null {
  const at: number[] = [];
  const rows = lines.map((l) => l.replace(FRAME, '').trim()).filter((l, i) => { if (l.length > 0) at.push(i); return l.length > 0; });
  // The last row numbered 1, and the rows that follow it in order: the dialog's options.
  let first = -1;
  for (let i = rows.length - 1; i >= 0 && first === -1; i--) if (OPTION.exec(rows[i]!)?.[2] === '1') first = i;
  if (first === -1) return null;
  const options: Row[] = [];
  let last = first;
  for (let i = first; i < rows.length; i++) {
    const m = OPTION.exec(rows[i]!);
    if (!m) continue;
    if (Number(m[2]) !== options.length + 1) break;
    options.push({ n: Number(m[2]), label: m[3]!.trim(), focused: m[1] !== undefined, line: at[i]! });
    last = i;
  }
  if (rows.length - 1 - last > NEAR_BOTTOM) return null;
  const focused = options.find((o) => o.focused);
  const own: string[] = [];
  for (let i = first - 1; i >= 0 && own.length < DIALOG_ROWS; i--) {
    if (!DASHED.test(rows[i]!) && (RULE.test(rows[i]!) || TRANSCRIPT.test(rows[i]!))) break;
    own.unshift(rows[i]!);
  }
  const inField = !!focused && !PLAIN.test(focused.label);
  const rules = own.flatMap((r, i) => (DASHED.test(r) ? [i] : []));
  if (!rules.length) return { options, above: own, body: null, inField };
  // One dashed rule alone: not a shape this reads.
  if (rules.length === 1) return null;
  const top = rules[0]!;
  const bottom = rules.at(-1)!;
  return {
    options, inField,
    above: [...own.slice(0, top), ...own.slice(bottom + 1)],
    body: own.slice(top + 1, bottom).filter((r) => !DASHED.test(r))
  };
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Rows compared as text alone: no spaces (a command wraps anywhere), no frame sides (a row may end with its "|"). */
const flat = (s: string) => s.replace(/[\s│┃|]+/g, '');

/**
 * A command the dialog shows as whole rows: a run of rows reads exactly as the command, wrapped or not; one cut short
 * ("…", as long ones are named) by its start. Only starting or containing it is another command.
 */
function commandIn(rows: readonly string[], command: string): boolean {
  const { want, cut } = wanted(command);
  if (!want) return false;
  for (let i = 0; i < rows.length; i++) {
    let seen = '';
    for (let j = i; j < rows.length; j++) {
      seen += flat(rows[j]!);
      if (cut ? seen.startsWith(want) : seen === want) return true;
      if (!want.startsWith(seen)) break;
    }
  }
  return false;
}

/** A command as it is compared: flat, and whether it was cut short ("…"), when only its start is known. */
function wanted(command: string): { want: string; cut: boolean } {
  const cut = command.endsWith('…');
  return { want: flat(cut ? command.slice(0, -1) : command), cut };
}

/** A command that is all of these rows, wrapped or not; one cut short by its start. */
function commandIs(rows: readonly string[], command: string): boolean {
  const { want, cut } = wanted(command);
  const seen = rows.map(flat).join('');
  return !!want && (cut ? seen.startsWith(want) : seen === want);
}

/** A file's name as a path's last part on a row ("src/upload.ts", "edit to upload.ts?"), not the start of another. */
const fileIn = (row: string, name: string) => new RegExp(`(?:^|[\\s/\\\\(\`'"])${escape(name)}(?=$|[\\s?:,;)\`'"]|\\.(?:\\s|$))`).test(row);
/** A tool's name as a word of its own. */
const wordIn = (row: string, word: string) => new RegExp(`(?:^|[^\\w-])${escape(word)}(?![\\w-])`).test(row);

/** A wait's target as it names its request: the tool, and what it acts on ('' for the tool alone). */
function requestOf(target: string): { tool: string; what: string } {
  const space = target.indexOf(' ');
  if (space === -1) return { tool: target, what: '' };
  return { tool: target.slice(0, space), what: target.slice(space + 1).trim() };
}

/**
 * Whether these rows name the request `target` names, as a session's wait does: "Bash npm test" (a command),
 * "Edit upload.ts" (a file), or the tool alone ("Deploy"). Nothing named: nothing to check, false.
 */
export function shows(rows: readonly string[], target: string | null): boolean {
  if (!target) return false;
  const { tool, what } = requestOf(target);
  if (!what) return rows.some((r) => wordIn(r, tool));
  if (FILE_TOOLS.has(tool)) {
    const name = what.split(/[\\/]/).filter(Boolean).at(-1) ?? what;
    return rows.some((r) => fileIn(r, name));
  }
  return commandIn(rows, what);
}

/**
 * Whether the dialog asks for the request `target` names, as `shows` reads it. A file or a tool counts only outside
 * the dashed rules; a command between them must be all of what they hold.
 */
function asksFor(d: Dialog, target: string | null): boolean {
  if (!target) return false;
  const { tool, what } = requestOf(target);
  if (d.body && what && !FILE_TOOLS.has(tool)) return commandIs(d.body, what);
  return shows(d.above, target);
}

/** The digit that chooses "Yes" in the permission dialog at the bottom of the screen for `target`, or why it can't. */
export function allowKey(lines: readonly string[], target: string | null): AllowKey {
  const d = dialogAtBottom(lines);
  if (!d || d.inField || !asksFor(d, target)) return REFUSED;
  const yes = d.options.find((o) => o.label === 'Yes');
  return yes ? { ok: true, key: String(yes.n) } : REFUSED;
}

/**
 * Esc, which declines the permission dialog at the bottom of the screen for `target`, whatever it lists and wherever
 * its cursor is. Without that dialog on screen (answered already, the tool running) an Esc would interrupt Claude
 * instead: refused.
 */
export function denyKey(lines: readonly string[], target: string | null): AllowKey {
  const d = dialogAtBottom(lines);
  return !d || !asksFor(d, target) ? REFUSED : { ok: true, key: '\x1b' };
}

/**
 * A screen as atelierd sends it on attach (escape sequences), as plain text rows: written into a headless terminal at
 * least as wide as the real one (rows it wrapped stay whole), every row of its active buffer.
 */
export function screenLines(snapshot: string, size: { cols: number; rows: number } | null): Promise<string[]> {
  const screen = new Headless({ cols: Math.max(size?.cols ?? 0, 300), rows: Math.max(size?.rows ?? 0, 100), scrollback: 2000, allowProposedApi: true });
  return new Promise((resolve) => {
    screen.write(snapshot, () => {
      const buf = screen.buffer.active;
      const out: string[] = [];
      for (let i = 0; i < buf.length; i++) out.push(buf.getLine(i)?.translateToString(true) ?? '');
      screen.dispose();
      resolve(out);
    });
  });
}

/** A screen's rows, which of their text is dim, and the terminal's width. */
export interface ScreenView {
  lines: string[];
  /** `lines[i]` with each dim cell's characters as spaces (same indices). */
  undimmed: string[];
  cols: number;
}

/** The width a terminal is taken to have when its size is unknown. */
const DEFAULT_COLS = 120;

/** A screen as `screenLines` reads it, with a second set of rows that leaves out the dim text (hints, placeholders). */
export function screenView(snapshot: string, size: { cols: number; rows: number } | null): Promise<ScreenView> {
  const screen = new Headless({ cols: Math.max(size?.cols ?? 0, 300), rows: Math.max(size?.rows ?? 0, 100), scrollback: 2000, allowProposedApi: true });
  return new Promise((resolve) => {
    screen.write(snapshot, () => {
      const buf = screen.buffer.active;
      const lines: string[] = [];
      const undimmed: string[] = [];
      const scratch = buf.getNullCell();
      for (let i = 0; i < buf.length; i++) {
        const line = buf.getLine(i);
        lines.push(line?.translateToString(true) ?? '');
        let bright = '';
        // One cell object is refilled for every column: no allocation per cell.
        for (let x = 0; line && x < line.length; x++) {
          const cell = line.getCell(x, scratch);
          // A wide character's second cell has width 0 and no text: nothing to add for it.
          if (!cell || cell.getWidth() === 0) continue;
          const chars = cell.getChars() || ' ';
          bright += cell.isDim() ? ' '.repeat(cell.getWidth()) : chars;
        }
        undimmed.push(bright.trimEnd());
      }
      screen.dispose();
      resolve({ lines, undimmed, cols: size?.cols || DEFAULT_COLS });
    });
  });
}
