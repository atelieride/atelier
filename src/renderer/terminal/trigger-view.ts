// Highlight triggers in xterm: the texts the worker matched are found again in the newest rows of the
// buffer (plain substring search: no user regex runs on this thread) and marked with decorations, a bounded number per
// terminal. A decoration whose cells no longer hold its text (a full-screen app redrew there) is dropped when rendered.
import type { IBufferLine, IDecoration, IMarker, Terminal } from '@xterm/xterm';

/** Live highlight decorations per terminal: the oldest goes past this. */
export const MAX_HIGHLIGHTS = 100;
/** Rows searched above the screen for a matched text (the batch can arrive after a burst scrolled it up). */
const SEARCH_ABOVE = 200;

/** A buffer row: its text and, for each character index, the cell it starts at (one more entry: the row's end). */
export interface Row { y: number; text: string; cellOf: number[] }
export interface Place { y: number; x: number; width: number; text: string }

/** For each matched text, its newest occurrence in the rows that isn't taken yet (in cells). */
export function locate(rows: readonly Row[], texts: readonly string[], taken: (y: number, x: number) => boolean): Place[] {
  const out: Place[] = [];
  const used = new Set<string>();
  for (const text of texts) {
    let found: Place | null = null;
    for (let r = rows.length - 1; r >= 0 && !found; r--) {
      const row = rows[r]!;
      let from = row.text.lastIndexOf(text);
      while (from !== -1) {
        const x = row.cellOf[from]!;
        if (!taken(row.y, x) && !used.has(`${row.y}:${x}`)) { found = { y: row.y, x, width: row.cellOf[from + text.length]! - x, text }; break; }
        from = from === 0 ? -1 : row.text.lastIndexOf(text, from - 1);
      }
    }
    if (found) { used.add(`${found.y}:${found.x}`); out.push(found); }
  }
  return out;
}

function rowOf(line: IBufferLine, y: number, cols: number): Row {
  let text = '';
  const cellOf: number[] = [];
  for (let x = 0; x < cols; x++) {
    const cell = line.getCell(x);
    if (!cell) break;
    if (cell.getWidth() === 0) continue;
    const ch = cell.getChars() || ' ';
    for (let i = 0; i < ch.length; i++) cellOf.push(x);
    text += ch;
  }
  cellOf.push(cols);
  return { y, text, cellOf };
}

interface Live { deco: IDecoration; marker: IMarker; x: number; width: number; text: string }

export class TriggerHighlights {
  private live: Live[] = [];
  constructor(private readonly term: Terminal) {}

  /** Highlights the texts in the newest rows (normal screen only: a full-screen app's screen is not output). */
  add(texts: readonly string[]): void {
    const buf = this.term.buffer.active;
    if (buf.type !== 'normal' || texts.length === 0) return;
    const rows: Row[] = [];
    for (let y = Math.max(0, buf.length - this.term.rows - SEARCH_ABOVE); y < buf.length; y++) {
      const line = buf.getLine(y);
      if (line) rows.push(rowOf(line, y, this.term.cols));
    }
    const cursor = buf.baseY + buf.cursorY;
    for (const p of locate(rows, texts, (y, x) => this.live.some((l) => l.marker.line === y && l.x === x))) {
      const marker = this.term.registerMarker(p.y - cursor);
      if (!marker) continue;
      const width = Math.max(1, p.width);
      const deco = this.term.registerDecoration({ marker, x: p.x, width, layer: 'top' });
      if (!deco) { marker.dispose(); continue; }
      const entry: Live = { deco, marker, x: p.x, width, text: p.text };
      deco.onRender((el) => {
        el.classList.add('trg-hit');
        if (!this.holds(entry)) this.drop(entry);
      });
      marker.onDispose(() => this.drop(entry));
      this.live.push(entry);
      while (this.live.length > MAX_HIGHLIGHTS) this.drop(this.live[0]!);
    }
  }

  dispose(): void { for (const l of [...this.live]) this.drop(l); }

  private holds(l: Live): boolean {
    const line = l.marker.line >= 0 ? this.term.buffer.active.getLine(l.marker.line) : undefined;
    return !!line && line.translateToString(false, l.x, l.x + l.width) === l.text;
  }

  private drop(l: Live): void {
    const i = this.live.indexOf(l);
    if (i === -1) return;
    this.live.splice(i, 1);
    l.deco.dispose();
    l.marker.dispose();
  }
}
