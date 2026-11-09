// CSV viewer: column letters and cell addresses, numbers in either decimal separator,
// the thin-space groups the table shows, and what Go to Row accepts. Pure.
import type { CellRange, Decimal } from './types';

const THIN = ' ';

/** 0 → A, 25 → Z, 26 → AA (as spreadsheets name columns). */
export function columnLetter(i: number): string {
  let s = '';
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

/** AA → 26 (any case); null for anything that isn't letters. */
export function columnIndex(letters: string): number | null {
  if (!/^[A-Za-z]+$/.test(letters)) return null;
  let n = 0;
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/** A cell's address: `G6` for row 5 (0-based data row), column 6. */
export const address = (row: number, col: number): string => `${columnLetter(col)}${row + 1}`;

/** `F3:G9`; one cell is just its address. Either corner order. */
export function rangeAddress(r: CellRange): string {
  const r0 = Math.min(r.r0, r.r1), r1 = Math.max(r.r0, r.r1), c0 = Math.min(r.c0, r.c1), c1 = Math.max(r.c0, r.c1);
  return r0 === r1 && c0 === c1 ? address(r0, c0) : `${address(r0, c0)}:${address(r1, c1)}`;
}

const DOT = /^[+-]?(?:(\d+|\d{1,3}(?:,\d{3})+)(\.\d+)?|\.\d+)([eE][+-]?\d+)?$/;
const COMMA = /^[+-]?(?:(\d+|\d{1,3}(?:\.\d{3})+)(,\d+)?|,\d+)([eE][+-]?\d+)?$/;

/** A cell's number with the file's decimal separator (the other one may group thousands); null when it isn't one. */
export function toNumber(text: string, decimal: Decimal): number | null {
  const s = text.trim();
  if (!s) return null;
  const m = (decimal === '.' ? DOT : COMMA).exec(s);
  if (!m) return null;
  const int = m[1];
  // Leading zeros (ids, zip codes): text, not a number.
  if (int && int.length > 1 && int[0] === '0' && !/[,.]/.test(int)) return null;
  const plain = decimal === '.' ? s.replace(/,/g, '') : s.replace(/\./g, '').replace(',', '.');
  const n = Number(plain);
  return Number.isFinite(n) ? n : null;
}

/** Thin-space groups (61 204). */
export const groupInt = (n: number): string => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, THIN);

/** A number cell as the table shows it: grouped integer part, the file's separator and decimals kept; else trimmed. */
export function formatNumber(text: string, decimal: Decimal): string {
  const s = text.trim();
  if (toNumber(s, decimal) === null || /[eE]/.test(s)) return s;
  const sign = s[0] === '-' || s[0] === '+' ? s[0] : '';
  const body = sign ? s.slice(1) : s;
  const at = body.indexOf(decimal);
  const int = (at < 0 ? body : body.slice(0, at)).replace(decimal === '.' ? /,/g : /\./g, '');
  const frac = at < 0 ? '' : body.slice(at + 1);
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, THIN);
  return `${sign === '-' ? '-' : ''}${grouped}${at < 0 ? '' : decimal + frac}`;
}

/** Go to Row: `48213`, a cell `H48213`, `-1` for the last row → a 0-based row (clamped) and the column if given. */
export function parseGoTo(input: string, rows: number): { row: number; col: number | null } | null {
  if (rows <= 0) return null;
  const s = input.replace(/[\s  ,]/g, '');
  const m = /^([A-Za-z]+)?(-?\d+)$/.exec(s);
  if (!m) return null;
  if (m[1] && m[2]!.startsWith('-')) return null;
  const n = Number(m[2]);
  const row = n > 0 ? n - 1 : n === 0 ? 0 : rows + n;
  return { row: Math.max(0, Math.min(rows - 1, row)), col: m[1] ? columnIndex(m[1]) : null };
}

export interface JsonCell { chip: string; preview: string; kind: 'object' | 'array'; entries: number }

const PREVIEW_ENTRIES = 4;
const short = (v: unknown): string => (Array.isArray(v) ? '[…]' : v && typeof v === 'object' ? '{…}' : JSON.stringify(v));

/** A cell holding a JSON object or array: the table's count chip and one-line preview. */
export function jsonCell(text: string): JsonCell | null {
  const s = text.trim();
  if (!s.startsWith('{') && !s.startsWith('[')) return null;
  let v: unknown;
  try { v = JSON.parse(s); } catch { return null; }
  if (!v || typeof v !== 'object') return null;
  const parts = Array.isArray(v) ? v.map(short) : Object.entries(v).map(([k, x]) => `${k}: ${short(x)}`);
  const more = parts.length > PREVIEW_ENTRIES ? ', …' : '';
  const n = parts.length;
  return Array.isArray(v)
    ? { chip: `[${n}]`, preview: parts.slice(0, PREVIEW_ENTRIES).join(', ') + more, kind: 'array', entries: n }
    : { chip: `{${n}}`, preview: parts.slice(0, PREVIEW_ENTRIES).join(', ') + more, kind: 'object', entries: n };
}
