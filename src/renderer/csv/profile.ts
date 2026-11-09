// CSV viewer: what each column holds — its type, counts, stats, histogram, top values and the
// widths the table and the aligned source use. Computed once per parse (in the worker). Pure.
import { columnLetter, toNumber } from './format';
import type { ColType, ColumnProfile, CsvData, Decimal, Delimiter, TopValue } from './types';

const BINS = 12;
const MAX_TOP = 500;
const MAX_RAW = 40;
const WIDTH_SAMPLE = 2000;
const CHAR_PX = 7.4;
/** A cell's padding and a little room so a value of the widest column never ends in an ellipsis. */
const PAD_PX = 28;
/** Around a header's name: the letter chip, the sort arrow and the ▾ menu button. */
const HEAD_PX = 60;
const BAR_PX = 56;

const BOOL = new Set(['true', 'false', 'yes', 'no']);
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATETIME = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2})(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/;

const validDay = (y: string, m: string, d: string): boolean => {
  const t = new Date(Date.UTC(+y, +m - 1, +d));
  return t.getUTCFullYear() === +y && t.getUTCMonth() === +m - 1 && t.getUTCDate() === +d;
};

/** A date or datetime as epoch ms (no zone: UTC), or null. */
function dateValue(s: string): { ms: number; time: boolean } | null {
  let m = DATE.exec(s);
  if (m) return validDay(m[1]!, m[2]!, m[3]!) ? { ms: Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!), time: false } : null;
  m = DATETIME.exec(s);
  if (!m || !validDay(m[1]!, m[2]!, m[3]!) || +m[4]! > 23 || +m[5]! > 59 || (m[6] !== undefined && +m[6] > 59)) return null;
  const zone = m[8] === undefined ? 'Z' : m[8] === 'Z' ? 'Z' : m[8].includes(':') ? m[8] : `${m[8].slice(0, 3)}:${m[8].slice(3)}`;
  const ms = Date.parse(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6] ?? '00'}${m[7] ?? ''}${zone}`);
  return Number.isFinite(ms) ? { ms, time: true } : null;
}

/** A date or datetime cell as epoch ms (sorting), or null. */
export const dateMs = (s: string): number | null => dateValue(s.trim())?.ms ?? null;

const isJson = (s: string): boolean => {
  if (s[0] !== '{' && s[0] !== '[') return false;
  try { const v: unknown = JSON.parse(s); return typeof v === 'object' && v !== null; } catch { return false; }
};

/** The field as the file has it: quoted when it holds a quote, a separator or a newline. */
/** A value's length in the file: quoted (and its quotes doubled) when it holds the delimiter, a quote or a line break. */
const rawLength = (v: string, delimiter: Delimiter): number => {
  if (!v.includes(delimiter) && !/["\n\r]/.test(v)) return v.length;
  let quotes = 0;
  for (let k = 0; k < v.length; k++) if (v.charCodeAt(k) === 34) quotes++;
  return v.length + 2 + quotes;
};

function profileColumn(data: CsvData, i: number, decimal: Decimal, delimiter: Delimiter): ColumnProfile {
  const counts = new Map<string, number>();
  let empty = 0;
  let longest = 0;
  let raw = 0;
  const rows = data.rows;
  for (let r = 0; r < rows.length; r++) {
    const v = rows[r]![i] ?? '';
    if (r < WIDTH_SAMPLE && v.length > longest) longest = v.length;
    if (raw < MAX_RAW) raw = Math.max(raw, rawLength(v, delimiter));
    if (v.trim() === '') { empty++; continue; }
    counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  const count = rows.length - empty;
  const distinct = counts.size;
  const name = data.header?.[i] ?? '';

  // The type: every distinct value must fit it.
  let bool = distinct > 0, num = distinct > 0, int = true, dates = distinct > 0, anyTime = false, json = distinct > 0;
  let places: number | null | undefined;
  const nums = new Map<string, number>();
  for (const v of counts.keys()) {
    const s = v.trim();
    if (bool && !BOOL.has(s.toLowerCase())) bool = false;
    if (num) {
      const n = toNumber(s, decimal);
      if (n === null) num = false;
      else {
        nums.set(v, n);
        const at = s.indexOf(decimal);
        if (at >= 0 || /[eE]/.test(s)) int = false;
        const p = at >= 0 ? s.length - at - 1 : 0;
        places = places === undefined ? p : places === p ? p : null;
      }
    }
    if (dates) {
      const d = dateValue(s);
      if (!d) dates = false;
      else { nums.set(v, d.ms); if (d.time) anyTime = true; }
    }
    if (json && !isJson(s)) json = false;
    if (!bool && !num && !dates && !json) break;
  }
  let type: ColType;
  if (count === 0) type = 'empty';
  else if (bool) type = 'boolean';
  else if (num) type = int ? 'integer' : 'decimal';
  else if (dates) type = anyTime ? 'datetime' : 'date';
  else if (json) type = 'json';
  else if (distinct >= 2 && distinct <= 12 && distinct <= count / 2) type = 'category';
  else type = 'text';

  const numeric = type === 'integer' || type === 'decimal';
  const measured = numeric || type === 'date' || type === 'datetime';
  let min: number | null = null, max: number | null = null, sum: number | null = null, mean: number | null = null, bins: number[] | null = null;
  if (measured && count > 0) {
    let lo = Infinity, hi = -Infinity, total = 0;
    for (const [v, c] of counts) {
      const n = nums.get(v)!;
      if (n < lo) lo = n;
      if (n > hi) hi = n;
      total += n * c;
    }
    min = lo; max = hi; mean = total / count; sum = numeric ? total : null;
    bins = new Array<number>(BINS).fill(0);
    for (const [v, c] of counts) {
      const n = nums.get(v)!;
      const k = hi === lo ? 0 : Math.min(BINS - 1, Math.floor(((n - lo) / (hi - lo)) * BINS));
      bins[k]! += c;
    }
  }

  const top: TopValue[] = distinct <= MAX_TOP ? [...counts].map(([value, c]) => ({ value, count: c })).sort((a, b) => b.count - a.count) : [];
  const unique = count > 1 && distinct === count;
  const codes = type === 'category' && [...counts.keys()].every((v) => /^[A-Z0-9]{1,3}$/.test(v.trim()));
  // Ids (unique integers) and a handful of repeated numbers (status codes, flags) are labels, not amounts.
  const bars = numeric && min !== null && min >= 0 && !(type === 'integer' && unique) && distinct > 3;
  const px = Math.max(longest * CHAR_PX + (bars ? BAR_PX : 0), name.length * CHAR_PX + HEAD_PX) + PAD_PX;
  const width = Math.round(Math.min(340, Math.max(64, px)));
  const rawWidth = Math.min(MAX_RAW, Math.max(raw, rawLength(name, delimiter)));
  return {
    index: i, letter: columnLetter(i), name, type, unique, places: type === 'decimal' ? places ?? null : null,
    count, empty, distinct, min, max, mean, sum, bins, top, codes, bars, width, rawWidth,
    extra: !!data.header && i >= data.header.length
  };
}

/** Every column of a parsed file (the widest row's count), in order. */
/** `delimiter`: the file's (Align columns counts the quotes a value needs in it). */
export function profile(data: CsvData, decimal: Decimal, delimiter: Delimiter = ','): ColumnProfile[] {
  return Array.from({ length: data.width }, (_, i) => profileColumn(data, i, decimal, delimiter));
}
