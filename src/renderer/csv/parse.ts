// CSV viewer: an RFC 4180 parser — fields split by the delimiter, `"` quotes with `""` inside,
// quoted fields that hold delimiters and line breaks, CRLF or LF, a leading BOM ignored, blank lines not rows. Rows
// that don't match the header and an unclosed quote are reported, never thrown. One linear pass; pure.
import type { CsvData, Delimiter, Problem, Resolved } from './types';

const QUOTE = 34;
const LF = 10;
const CR = 13;

interface Rec {
  fields: string[];
  /** Just past the record's line break (or the text's end). */
  end: number;
  /** Line breaks inside its quoted fields (the closing one not counted). */
  breaks: number;
  /** An unclosed quote: the field runs to the end of the text. */
  open: boolean;
}

/** The record starting at `at`. */
function readRecord(text: string, at: number, delimiter: Delimiter): Rec {
  const n = text.length;
  const d = delimiter.charCodeAt(0);
  const fields: string[] = [];
  let i = at;
  let breaks = 0;
  for (;;) {
    if (i < n && text.charCodeAt(i) === QUOTE) {
      i++;
      let val = '';
      let seg = i;
      let closed = false;
      while (i < n) {
        const c = text.charCodeAt(i);
        if (c === QUOTE) {
          if (text.charCodeAt(i + 1) === QUOTE) { val += text.slice(seg, i + 1); i += 2; seg = i; continue; }
          val += text.slice(seg, i);
          i++;
          closed = true;
          break;
        }
        if (c === LF || (c === CR && text.charCodeAt(i + 1) !== LF)) breaks++;
        i++;
      }
      if (!closed) { fields.push(val + text.slice(seg, n)); return { fields, end: n, breaks, open: true }; }
      // Text after the closing quote is kept as it is (lenient).
      const s = i;
      while (i < n) { const c = text.charCodeAt(i); if (c === d || c === LF || c === CR) break; i++; }
      fields.push(s < i ? val + text.slice(s, i) : val);
    } else {
      const s = i;
      while (i < n) { const c = text.charCodeAt(i); if (c === d || c === LF || c === CR) break; i++; }
      fields.push(text.slice(s, i));
    }
    if (i >= n) return { fields, end: n, breaks, open: false };
    const c = text.charCodeAt(i);
    if (c === d) { i++; continue; }
    i += c === CR && text.charCodeAt(i + 1) === LF ? 2 : 1;
    return { fields, end: i, breaks, open: false };
  }
}

/** The fields of one record's text, quotes undone (stops at the first line break outside quotes). */
export const splitRecord = (line: string, delimiter: Delimiter): string[] => readRecord(line, 0, delimiter).fields;

/** The most common field count (the first one seen wins a tie). */
function commonCount(rows: string[][]): number {
  const counts = new Map<number, number>();
  let best = 0;
  let bestN = 0;
  for (const r of rows) {
    const k = (counts.get(r.length) ?? 0) + 1;
    counts.set(r.length, k);
    if (k > bestN) { best = r.length; bestN = k; }
  }
  return best;
}

export function parseCsv(input: string, o: Resolved): CsvData {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const n = text.length;
  const rows: string[][] = [];
  const lines: number[] = [];
  const endLines: number[] = [];
  const quotes: Problem[] = [];
  let header: string[] | null = null;
  let headerLine: number | null = null;
  let wantHeader = o.header;
  let skip = o.skip;
  let i = 0;
  let line = 1;
  while (i < n) {
    const c = text.charCodeAt(i);
    if (c === LF || c === CR) { i += c === CR && text.charCodeAt(i + 1) === LF ? 2 : 1; line++; continue; }
    if (skip > 0) {
      // A title line: skipped as text, whatever quotes it has.
      while (i < n) { const x = text.charCodeAt(i); if (x === LF || x === CR) break; i++; }
      if (i < n) i += text.charCodeAt(i) === CR && text.charCodeAt(i + 1) === LF ? 2 : 1;
      line++;
      skip--;
      continue;
    }
    const r = readRecord(text, i, o.delimiter);
    if (wantHeader) {
      wantHeader = false;
      header = r.fields;
      headerLine = line;
      if (r.open) quotes.push({ kind: 'quote', row: -1, line });
    } else {
      rows.push(r.fields);
      lines.push(line);
      endLines.push(line + r.breaks);
      if (r.open) quotes.push({ kind: 'quote', row: rows.length - 1, line });
    }
    line += r.breaks + 1;
    i = r.end;
  }
  const expected = header ? header.length : commonCount(rows);
  let width = header ? header.length : 0;
  // An unclosed quote is the problem of its row (its field count says nothing more); a header's comes first.
  const problems: Problem[] = quotes.filter((p) => p.row < 0);
  const quoted = new Map(quotes.filter((p) => p.row >= 0).map((p) => [p.row, p]));
  for (let k = 0; k < rows.length; k++) {
    const len = rows[k]!.length;
    if (len > width) width = len;
    const qp = quoted.get(k);
    if (qp) problems.push(qp);
    else if (len !== expected) problems.push({ kind: 'fields', row: k, line: lines[k]!, count: len });
  }
  return { header, headerLine, rows, lines, endLines, width, expected, problems };
}
