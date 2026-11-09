// The text a right-click can send to a terminal: xterm's selection, or the one
// full-screen Claude made itself (it captures the mouse, highlights the drag and copies it to the clipboard).

/**
 * Selected text made ready for a shell: full-screen rows are padded (trailing whitespace goes), Claude indents its code
 * blocks (the common indentation goes, the relative one stays), blank lines at both ends go. '' when nothing is left.
 */
export function cleanSelection(text: string): string {
  // Rows are padded, so a trailing space is never meaningful: `\ ` at the end reads as a line continuation.
  const lines = text.replace(/\r\n?/g, '\n').split('\n').map((l) => l.replace(/\s+$/, ''));
  while (lines.length > 0 && lines[0] === '') lines.shift();
  while (lines.length > 0 && lines.at(-1) === '') lines.pop();
  const indents = lines.filter((l) => l !== '').map((l) => /^[ \t]*/.exec(l)![0]);
  let common = indents[0] ?? '';
  for (const s of indents) while (!s.startsWith(common)) common = common.slice(0, -1);
  return lines.map((l) => l.slice(common.length)).join('\n');
}

/** What Claude copied from a drag: the clipboard after the release, when it differs from the one at the press. */
export function claudeCopy(before: string | null, after: string | null): string | null {
  if (!after || after === before) return null;
  return after;
}

/**
 * Claude's selection at the right-click: its copy, only while the clipboard still holds it — text copied elsewhere since
 * (another app, a clipboard manager) is never taken for it.
 */
export function claudeSelection(copied: string | null, now: string | null): string | null {
  return copied !== null && now === copied ? copied : null;
}

/** A release this far from its press is a drag (a selection), not a click. */
export function isDrag(press: { x: number; y: number }, release: { x: number; y: number }): boolean {
  return Math.hypot(release.x - press.x, release.y - press.y) >= 4;
}

/** One line in the palette for the text being sent: its first line and how many follow. */
export function selectionPreview(text: string): { first: string; more: number } {
  const lines = text.split('\n');
  return { first: lines[0] ?? '', more: lines.length - 1 };
}

// Full-screen Claude captures the mouse: its drag selects in Claude, which copies the text itself on release. The
// clipboard at the last left press in a Claude terminal (dropped at the release), then what the drag copied; one slot.
let press: { id: string; at: { x: number; y: number }; clipboard: Promise<string | null> } | null = null;
let copied: { id: string; text: Promise<string | null> } | null = null;
const read = () => window.atelier.clipboard.read().catch(() => null);
/** Claude copies within a moment of the release: the clipboard is looked at after these pauses (500 ms in all). */
const COPY_PAUSES_MS = [60, 140, 300];

/** A left press in a Claude terminal capturing the mouse (the registry calls it). */
export function noteClaudePress(id: string, at: { x: number; y: number }): void {
  press = { id, at, clipboard: read() };
  copied = null;
}

/** Its release: a drag (not a click) leaves what Claude copied, if it copied something new. */
export function noteClaudeRelease(id: string, at: { x: number; y: number }): void {
  const p = press;
  press = null;
  if (!p || p.id !== id || !isDrag(p.at, at)) return;
  copied = {
    id,
    text: (async () => {
      const before = await p.clipboard;
      for (const ms of COPY_PAUSES_MS) {
        await new Promise((r) => setTimeout(r, ms));
        const found = claudeCopy(before, await read());
        if (found) return found;
      }
      return null;
    })()
  };
}

/** Claude's selection in that terminal: what its last drag copied, while the clipboard still holds it; else null. */
export async function claudeSelectionOf(id: string): Promise<string | null> {
  if (copied?.id !== id) return null;
  const [text, now] = await Promise.all([copied.text, read()]);
  return claudeSelection(text, now);
}
