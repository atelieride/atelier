// Allow from a phone picks the option Claude Code's permission dialog labels "Yes" (allow once), read from the
// terminal's screen: a digit chooses an option of its selection lists outright, and the dialog doesn't always list
// "Yes" first. Refused (nothing typed) when the screen shows no such option at its bottom, or when the cursor is in a
// field — after Tab, an option turns into a field for feedback, and a digit would be typed into it.
import { Terminal as Headless } from '@xterm/headless';

export type AllowKey = { ok: true; key: string } | { ok: false; message: string };

const REFUSED: AllowKey = { ok: false, message: 'Open the session to answer' };
/** A dialog's numbered row: the cursor's mark when it is on it, its number, its label. */
const OPTION = /^(?:([❯›>▸])\s*)?(\d)\.\s+(.+)$/;
/** A bordered frame's sides, drawn by some versions. */
const FRAME = /^[│┃|]\s?|\s?[│┃|]$/g;
/**
 * The dialog must end this close to the bottom of the screen: after it only its hints, a frame's bottom edge and a
 * status line. An older one, answered already, doesn't count.
 */
const NEAR_BOTTOM = 4;
/** A row the dialog always draws as it is: "Yes", "No", or a label ending in its key hint ("(esc)", "(shift+tab)"). */
const PLAIN = /^(Yes|No)$|\((?:esc|[a-z]+(?:\+[a-z]+)+)\)$/;

interface Row { n: number; label: string; focused: boolean }

/** The digit that chooses "Yes" in the permission dialog at the bottom of the screen, or why it can't be chosen. */
export function allowKey(lines: readonly string[]): AllowKey {
  const rows = lines.map((l) => l.replace(FRAME, '').trim()).filter((l) => l.length > 0);
  // The last row numbered 1, and the rows that follow it in order: the dialog's options.
  let first = -1;
  for (let i = rows.length - 1; i >= 0 && first === -1; i--) if (OPTION.exec(rows[i]!)?.[2] === '1') first = i;
  if (first === -1) return REFUSED;
  const options: Row[] = [];
  let last = first;
  for (let i = first; i < rows.length; i++) {
    const m = OPTION.exec(rows[i]!);
    if (!m) continue;
    if (Number(m[2]) !== options.length + 1) break;
    options.push({ n: Number(m[2]), label: m[3]!.trim(), focused: m[1] !== undefined });
    last = i;
  }
  if (rows.length - 1 - last > NEAR_BOTTOM) return REFUSED;
  // The cursor in a field: a digit would be typed there instead of choosing.
  const focused = options.find((o) => o.focused);
  if (focused && !PLAIN.test(focused.label)) return REFUSED;
  const yes = options.find((o) => o.label === 'Yes');
  return yes ? { ok: true, key: String(yes.n) } : REFUSED;
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
