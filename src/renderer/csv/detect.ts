// CSV viewer: what a file most likely uses, from its first 64 KB — the delimiter whose field
// counts are the most consistent, whether the first row is a header, the decimal separator. Pure.
import { parseCsv } from './parse';
import type { CsvOptions, Decimal, Delimiter, Detected, Resolved } from './types';

const SAMPLE = 64 * 1024;
const DELIMITERS: readonly Delimiter[] = [',', ';', '\t', '|'];
/** Rows looked at for the header guess. */
const HEADER_ROWS = 50;

const NUMBERISH = /^[-+]?(\d+([.,]\d+)*|[.,]\d+)([eE][-+]?\d+)?$/;
const DATEISH = /^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;
const COMMA_DECIMAL = /^[-+]?(\d{1,3}(\.\d{3})+|\d+),\d+$/;
const DOT_DECIMAL = /^[-+]?\d*\.\d+([eE][-+]?\d+)?$/;
/** 1.284: a grouped integer as much as a decimal — no evidence either way. */
const DOT_GROUPED = /^[-+]?\d{1,3}(\.\d{3})+$/;

/** The text's start, cut at a line end when it is longer (a half line would skew the counts). */
function sample(text: string): string {
  if (text.length <= SAMPLE) return text;
  const cut = text.lastIndexOf('\n', SAMPLE);
  return cut > 0 ? text.slice(0, cut) : text.slice(0, SAMPLE);
}

const rowsWith = (text: string, delimiter: Delimiter): string[][] =>
  parseCsv(text, { delimiter, header: false, decimal: '.', skip: 0 }).rows;

/** How well a delimiter splits the rows: the share of rows with the most common count, and that count. */
function score(rows: string[][]): { share: number; fields: number } {
  const counts = new Map<number, number>();
  let fields = 0;
  let best = 0;
  for (const r of rows) {
    const k = (counts.get(r.length) ?? 0) + 1;
    counts.set(r.length, k);
    if (k > best || (k === best && r.length > fields)) { best = k; fields = r.length; }
  }
  return { share: rows.length ? best / rows.length : 0, fields };
}

function detectDelimiter(text: string, hint: 'csv' | 'tsv'): Delimiter {
  let pick: Delimiter | null = null;
  let top = { share: 0, fields: 0 };
  for (const d of DELIMITERS) {
    const s = score(rowsWith(text, d));
    if (s.fields < 2) continue;
    if (hint === 'tsv' && d === '\t') return d;
    if (!pick || s.share > top.share || (s.share === top.share && s.fields > top.fields)) { pick = d; top = s; }
  }
  return pick ?? (hint === 'tsv' ? '\t' : ',');
}

const kindOf = (v: string): 'number' | 'date' | null => {
  const s = v.trim();
  return NUMBERISH.test(s) ? 'number' : DATEISH.test(s) ? 'date' : null;
};

/** A header unless the first row holds a number or a date in a column of numbers or dates below. */
function detectHeader(rows: string[][]): boolean {
  if (rows.length < 2) return true;
  const [first, ...rest] = rows.slice(0, HEADER_ROWS + 1);
  return !first!.some((v, c) => {
    const kind = kindOf(v);
    if (!kind) return false;
    const below = rest.map((r) => r[c] ?? '').filter((x) => x.trim() !== '');
    return below.length > 0 && below.every((x) => kindOf(x) === kind);
  });
}

function detectDecimal(rows: string[][], delimiter: Delimiter): Decimal {
  if (delimiter === ',') return '.';
  let comma = 0;
  for (const r of rows) {
    for (const raw of r) {
      const v = raw.trim();
      if (COMMA_DECIMAL.test(v)) comma++;
      else if (DOT_DECIMAL.test(v) && !DOT_GROUPED.test(v)) return '.';
    }
  }
  return comma > 0 ? ',' : '.';
}

/** `hint`: the tab's language (TSV files default to Tab). */
export function detect(text: string, hint: 'csv' | 'tsv'): Detected {
  const s = sample(text);
  const delimiter = detectDelimiter(s, hint);
  const rows = rowsWith(s, delimiter);
  const header = detectHeader(rows);
  return { delimiter, header, decimal: detectDecimal(header ? rows.slice(1) : rows, delimiter) };
}

/** The options a parse uses: the user's choices, detection for the rest. */
export const resolve = (o: CsvOptions, d: Detected): Resolved => ({
  delimiter: o.delimiter === 'auto' ? d.delimiter : o.delimiter,
  header: o.header === 'auto' ? d.header : o.header,
  decimal: o.decimal === 'auto' ? d.decimal : o.decimal,
  skip: o.skip
});
