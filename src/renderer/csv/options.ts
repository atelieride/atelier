// CSV viewer: each file's parse options (delimiter, header, decimal separator, lines to skip), kept
// per absolute path in localStorage like the views (a per-viewer convenience: lost storage only means detection again).
import { dropOverrides, renameOverrides } from '../lang-overrides';
import { isAbsPath } from '@shared/paths';
import { AUTO_OPTIONS, type CsvOptions } from './types';

export type CsvOptionsMap = Record<string, CsvOptions>;

export const CSV_OPTIONS_KEY = 'atelier.csvOptions';
export const MAX_CSV_OPTIONS = 200;
export const MAX_SKIP = 20;

const DELIMITERS: readonly unknown[] = ['auto', ',', ';', '\t', '|'];
const DECIMALS: readonly unknown[] = ['auto', '.', ','];

/** One saved entry, each field checked on its own: an invalid one falls back to auto. */
function toOptions(v: unknown): CsvOptions | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const skip = typeof o.skip === 'number' && Number.isFinite(o.skip) && o.skip > 0 ? Math.min(MAX_SKIP, Math.floor(o.skip)) : 0;
  return {
    delimiter: DELIMITERS.includes(o.delimiter) ? (o.delimiter as CsvOptions['delimiter']) : 'auto',
    header: o.header === true || o.header === false ? o.header : 'auto',
    decimal: DECIMALS.includes(o.decimal) ? (o.decimal as CsvOptions['decimal']) : 'auto',
    skip
  };
}

const isAuto = (o: CsvOptions) => o.delimiter === 'auto' && o.header === 'auto' && o.decimal === 'auto' && o.skip === 0;

/** From the saved value (whatever it contains) to valid options: absolute paths, known values. */
export function parseCsvOptions(raw: string | null): CsvOptionsMap {
  let o: Record<string, unknown> = {};
  try { const v: unknown = raw ? JSON.parse(raw) : {}; if (v && typeof v === 'object' && !Array.isArray(v)) o = v as Record<string, unknown>; } catch { /* broken: none */ }
  const out: CsvOptionsMap = {};
  for (const [path, v] of Object.entries(o)) {
    const opts = isAbsPath(path) ? toOptions(v) : null;
    if (opts) out[path] = opts;
  }
  return out;
}

export const optionsOf = (all: Readonly<CsvOptionsMap>, path: string): CsvOptions => all[path] ?? AUTO_OPTIONS;

/** `path` set to `o` (the newest entry); all-auto needs no entry. Bounded. */
export function withOptions(all: CsvOptionsMap, path: string, o: CsvOptions): CsvOptionsMap {
  const rest = Object.entries(all).filter(([p]) => p !== path);
  if (!isAuto(o)) rest.push([path, o]);
  return Object.fromEntries(rest.slice(-MAX_CSV_OPTIONS));
}

export const renameCsvOptions = (all: CsvOptionsMap, from: string, to: string): CsvOptionsMap => renameOverrides(all, from, to);
export const dropCsvOptions = (all: CsvOptionsMap, path: string): CsvOptionsMap => dropOverrides(all, path);

export function loadCsvOptions(): CsvOptionsMap {
  try { return typeof localStorage === 'undefined' ? {} : parseCsvOptions(localStorage.getItem(CSV_OPTIONS_KEY)); } catch { return {}; }
}

/** Saves the real files' options (untitled tabs are not files: their numbers are reused). */
export function saveCsvOptions(all: CsvOptionsMap): void {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(CSV_OPTIONS_KEY, JSON.stringify(Object.fromEntries(Object.entries(all).filter(([p]) => isAbsPath(p)))));
  } catch { /* not saved: stays for this session */ }
}
