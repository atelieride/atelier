// CSV viewer: a tolerant scan of a CSV text for the editor — which lines start a record
// (blank lines and the inside of quoted fields don't), the record of a line and back, the fields' offsets in a record
// and the field under a position — so the rainbow columns, the cell address and Split's sync follow the text as it is
// typed. Quote rules as the parser's (a quote opens only at a field's start); never fails; pure.
import type { Delimiter } from './types';

const QUOTE = 34;
const LF = 10;
const CR = 13;

export interface CsvScan {
  /** The text's line count (as the editor counts them: a final line break opens an empty last line). */
  lines: number;
  /** 1-based lines that start no record, ascending: blank lines and lines that begin inside a quoted field. */
  nonStart: number[];
}

/** `skip`: the first non-blank lines are plain text (an export's title lines), as the parser skips them. */
export function scanCsv(text: string, delimiter: Delimiter, skip = 0): CsvScan {
  const n = text.length;
  const d = delimiter.charCodeAt(0);
  const nonStart: number[] = [];
  let line = 1;
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  let inQuote = false;
  let fieldStart = true;
  let lineStart = true;
  let toSkip = skip;
  let rawLine = false;
  for (;;) {
    if (lineStart) {
      lineStart = false;
      rawLine = false;
      if (inQuote) nonStart.push(line);
      else {
        const c = i < n ? text.charCodeAt(i) : -1;
        if (c === -1 || c === LF || c === CR) nonStart.push(line);
        else if (toSkip > 0) { toSkip--; rawLine = true; }
        fieldStart = true;
      }
    }
    if (i >= n) break;
    const c = text.charCodeAt(i);
    if (rawLine && c !== LF && c !== CR) { i++; continue; }
    if (inQuote) {
      if (c === QUOTE) {
        if (text.charCodeAt(i + 1) === QUOTE) { i += 2; continue; }
        inQuote = false;
        i++;
        continue;
      }
    } else if (c === QUOTE && fieldStart) { inQuote = true; fieldStart = false; i++; continue; }
    else if (c === d) { fieldStart = true; i++; continue; }
    else fieldStart = false;
    if (c === LF || c === CR) {
      i += c === CR && text.charCodeAt(i + 1) === LF ? 2 : 1;
      line++;
      lineStart = true;
      continue;
    }
    i++;
  }
  return { lines: line, nonStart };
}

/** How many of the sorted `xs` are below `v`. */
function below(xs: readonly number[], v: number): number {
  let lo = 0;
  let hi = xs.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (xs[mid]! < v) lo = mid + 1; else hi = mid; }
  return lo;
}

/** The 0-based record a line starts (every record counted: skipped lines and the header too); -1 when it starts none. */
export function recordOfLine(scan: CsvScan, line: number): number {
  if (line < 1 || line > scan.lines) return -1;
  const k = below(scan.nonStart, line);
  if (scan.nonStart[k] === line) return -1;
  return line - 1 - k;
}

/** The line a record starts on; -1 for no such record. */
export function lineOfRecord(scan: CsvScan, record: number): number {
  if (record < 0) return -1;
  let line = record + 1;
  for (const ns of scan.nonStart) { if (ns <= line) line++; else break; }
  return line <= scan.lines ? line : -1;
}

/** The fields of the record starting at `from`, quotes included, delimiters and the line break left out. */
export function fieldsOf(text: string, from: number, delimiter: Delimiter): { from: number; to: number }[] {
  const n = text.length;
  const d = delimiter.charCodeAt(0);
  const out: { from: number; to: number }[] = [];
  let i = from;
  for (;;) {
    const s = i;
    if (i < n && text.charCodeAt(i) === QUOTE) {
      i++;
      while (i < n) {
        if (text.charCodeAt(i) === QUOTE) {
          if (text.charCodeAt(i + 1) === QUOTE) { i += 2; continue; }
          i++;
          break;
        }
        i++;
      }
    }
    while (i < n) { const c = text.charCodeAt(i); if (c === d || c === LF || c === CR) break; i++; }
    out.push({ from: s, to: i });
    if (i >= n || text.charCodeAt(i) !== d) return out;
    i++;
  }
}

/** The field index under `pos` in the record starting at `recordFrom` (a delimiter belongs to the field before it). */
export function fieldAt(text: string, recordFrom: number, pos: number, delimiter: Delimiter): number {
  const fields = fieldsOf(text, recordFrom, delimiter);
  let k = 0;
  while (k + 1 < fields.length && fields[k + 1]!.from <= pos) k++;
  return k;
}
