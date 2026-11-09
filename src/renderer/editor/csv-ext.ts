// CSV viewer: the editor of a CSV tab — rainbow columns, on-screen alignment, the rows that
// don't match the header, and the cell under the cursor (the file bar's address, Split's sync). The options and the
// columns' widths come from the last parse (setCsvConf); the record structure from a tolerant scan of the text as it is
// now, redone at each edit (after a pause on large files). Decorations cover the visible lines only.
import { StateEffect, StateField, type EditorState, type Extension } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from '@codemirror/view';
import { fieldsOf, lineOfRecord, recordOfLine, scanCsv, type CsvScan } from '../csv/scan';
import { splitRecord } from '../csv/parse';
import type { Delimiter } from '../csv/types';

export interface CsvConf {
  delimiter: Delimiter;
  skip: number;
  header: boolean;
  rainbow: boolean;
  align: boolean;
  /** Align columns: each column's width in characters. */
  widths: number[];
  /** 1-based lines where a row with the wrong field count starts. */
  problemLines: number[];
}

/** Texts up to this size are rescanned at every edit; larger ones after a pause. */
const SYNC_SCAN = 512 * 1024;
const RESCAN_MS = 300;
/** How far a record's fields are read past its start (a record longer than this is cut). */
const MAX_RECORD = 256 * 1024;
const HUES = 8;

export const setCsvConf = StateEffect.define<CsvConf>();
export const rescanCsv = StateEffect.define<null>();

export const csvConfField = StateField.define<CsvConf | null>({
  create: () => null,
  update(v, tr) {
    for (const e of tr.effects) if (e.is(setCsvConf)) return e.value;
    return v;
  }
});

interface ScanState { scan: CsvScan; delimiter: Delimiter; skip: number; stale: boolean }

const scanField = StateField.define<ScanState | null>({
  create: () => null,
  update(v, tr) {
    const conf = tr.state.field(csvConfField, false);
    if (!conf) return null;
    const asked = tr.effects.some((e) => e.is(rescanCsv));
    const same = !!v && v.delimiter === conf.delimiter && v.skip === conf.skip;
    if (same && !tr.docChanged && !asked) return v;
    if (!same || asked || tr.state.doc.length <= SYNC_SCAN) {
      return { scan: scanCsv(tr.state.doc.toString(), conf.delimiter, conf.skip), delimiter: conf.delimiter, skip: conf.skip, stale: false };
    }
    return { ...v, stale: true };
  }
});

/** Whether a line starts no record (blank, or inside a quoted field). */
function nonStart(scan: CsvScan, line: number): boolean {
  const xs = scan.nonStart;
  let lo = 0;
  let hi = xs.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (xs[mid]! < line) lo = mid + 1; else hi = mid; }
  return xs[lo] === line;
}

/** The fields of the record starting on line `start`, as document offsets: only its own lines are read (the lines
 * that continue a quoted field after it), at most MAX_RECORD characters. */
function recordFields(state: EditorState, scan: CsvScan, start: number, delimiter: Delimiter): { from: number; to: number }[] {
  const doc = state.doc;
  const from = doc.line(start).from;
  let end = start;
  while (end < doc.lines && nonStart(scan, end + 1) && doc.line(end + 1).from - from < MAX_RECORD) end++;
  const text = doc.sliceString(from, Math.min(doc.line(end).to, from + MAX_RECORD));
  return fieldsOf(text, 0, delimiter).map((f) => ({ from: f.from + from, to: f.to + from }));
}

/** The line where the record holding `line` starts (itself unless it continues a quoted field); null on a blank line. */
function startLine(state: EditorState, scan: CsvScan, line: number): number | null {
  let n = Math.min(line, state.doc.lines);
  while (n > 1 && nonStart(scan, n) && state.doc.line(n).length > 0) n--;
  if (nonStart(scan, n)) return null;
  return n;
}

export interface CursorCell {
  /** The data row (-1: the header row). */
  row: number;
  col: number;
  /** The record's field count. */
  of: number;
  /** The line where the record starts. */
  line: number;
  /** The field's offsets (quotes included). */
  from: number;
  to: number;
}

/** The cell under the main cursor; null outside the data (blank and skipped lines) or before the first parse. */
export function cursorCell(state: EditorState, pos = state.selection.main.head): CursorCell | null {
  const conf = state.field(csvConfField, false);
  const sc = state.field(scanField, false);
  if (!conf || !sc) return null;
  const line = state.doc.lineAt(pos);
  if (line.length === 0 && nonStart(sc.scan, line.number)) return null;
  const start = startLine(state, sc.scan, line.number);
  if (start === null) return null;
  const record = recordOfLine(sc.scan, start);
  if (record < conf.skip) return null;
  const row = record - conf.skip - (conf.header ? 1 : 0);
  const fields = recordFields(state, sc.scan, start, conf.delimiter);
  let k = 0;
  while (k + 1 < fields.length && fields[k + 1]!.from <= pos) k++;
  const f = fields[k]!;
  return { row, col: k, of: fields.length, line: start, from: f.from, to: f.to };
}

/** Where a cell's field starts (a missing field: the record's end); null for a row the text doesn't have. */
export function fieldStart(state: EditorState, row: number, col: number): number | null {
  const conf = state.field(csvConfField, false);
  const sc = state.field(scanField, false);
  if (!conf || !sc) return null;
  const line = lineOfRecord(sc.scan, row + conf.skip + (conf.header ? 1 : 0));
  // A large file's scan is redone a moment after an edit: until then it may name lines the document no longer has.
  if (line < 1 || line > state.doc.lines) return null;
  const fields = recordFields(state, sc.scan, line, conf.delimiter);
  return fields[col]?.from ?? fields.at(-1)!.to;
}

/** A field as the table shows it (the parser's own rules: quotes removed, doubled quotes undone). */
export const unquoteField = (raw: string, delimiter: Delimiter): string => splitRecord(raw, delimiter)[0] ?? '';

class Pad extends WidgetType {
  constructor(readonly width: number) { super(); }
  eq(o: Pad) { return o.width === this.width; }
  toDOM() {
    const s = document.createElement('span');
    s.className = 'cm-csv-pad';
    s.style.width = `${this.width}ch`;
    return s;
  }
  ignoreEvent() { return false; }
}

const marks = Array.from({ length: HUES }, (_, i) => Decoration.mark({ class: `cm-csv-c${i}` }));
const delim = Decoration.mark({ class: 'cm-csv-del' });
const headLine = Decoration.line({ class: 'cm-csv-head' });
const skipLine = Decoration.line({ class: 'cm-csv-skip' });
const badLine = Decoration.line({ class: 'cm-csv-bad' });

/** The decorations of the records crossing `ranges` (the visible ones). */
export function csvDecorations(state: EditorState, ranges: readonly { from: number; to: number }[]): DecorationSet {
  const conf = state.field(csvConfField, false);
  const sc = state.field(scanField, false);
  if (!conf || !sc) return Decoration.none;
  const doc = state.doc;
  const bad = new Set(conf.problemLines);
  const out: ReturnType<Decoration['range']>[] = [];
  let done = 0;
  for (const r of ranges) {
    let n = Math.max(doc.lineAt(r.from).number, done + 1);
    const last = doc.lineAt(r.to).number;
    while (n <= last) {
      const start = startLine(state, sc.scan, n);
      if (start === null) { n++; continue; }
      const line = doc.line(start);
      const record = recordOfLine(sc.scan, start);
      if (record >= 0 && record < conf.skip) { out.push(skipLine.range(line.from)); n = start + 1; continue; }
      if (record === conf.skip && conf.header) out.push(headLine.range(line.from));
      if (bad.has(start)) out.push(badLine.range(line.from));
      const fields = recordFields(state, sc.scan, start, conf.delimiter);
      fields.forEach((f, k) => {
        if (conf.rainbow && f.to > f.from) out.push(marks[k % HUES]!.range(f.from, f.to));
        if (k + 1 < fields.length) {
          if (conf.rainbow) out.push(delim.range(f.to, f.to + 1));
          const w = conf.widths[k] ?? 0;
          const len = f.to - f.from;
          if (conf.align && len < w && doc.lineAt(f.from).number === doc.lineAt(f.to).number) out.push(Decoration.widget({ widget: new Pad(w - len), side: 1 }).range(f.to));
        }
      });
      const end = doc.lineAt(fields.at(-1)!.to).number;
      done = end;
      n = end + 1;
    }
  }
  return Decoration.set(out, true);
}

const plugin = ViewPlugin.fromClass(class {
  decorations: DecorationSet;
  timer: ReturnType<typeof setTimeout> | undefined;
  constructor(readonly view: EditorView) { this.decorations = csvDecorations(view.state, view.visibleRanges); }
  update(u: ViewUpdate) {
    const conf = u.startState.field(csvConfField, false) !== u.state.field(csvConfField, false);
    const scan = u.startState.field(scanField, false) !== u.state.field(scanField, false);
    if (u.docChanged || u.viewportChanged || conf || scan) this.decorations = csvDecorations(u.state, u.view.visibleRanges);
    if (u.docChanged && u.state.field(scanField, false)?.stale) {
      clearTimeout(this.timer);
      this.timer = setTimeout(() => this.view.dispatch({ effects: rescanCsv.of(null) }), RESCAN_MS);
    }
  }
  destroy() { clearTimeout(this.timer); }
}, { decorations: (p) => p.decorations });

export const csvEditorExtensions = (): Extension => [csvConfField, scanField, plugin];
