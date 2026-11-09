// CSV viewer: what the table's headers say about a column — its type line, the summary under
// it, the histogram's bars — and the tint of a category's value. Pure.
import { t } from '../i18n/en';
import { groupInt } from './format';
import type { ColumnProfile, Decimal } from './types';

export const TINTS = 8;

export function typeLabel(p: ColumnProfile): string {
  if (p.extra) return t.csv.extra(p.count);
  if (p.type === 'empty') return t.csv.types.empty!;
  const base = p.type === 'text' && p.unique ? `${t.csv.types.text} · ${t.csv.unique}`
    : p.type === 'category' ? `${t.csv.types.category} · ${p.distinct}`
      : p.type === 'decimal' && p.places !== null ? `${t.csv.types.decimal} · ${t.csv.places(p.places)}`
        : t.csv.types[p.type]!;
  return p.empty > 0 ? `${base} · ${groupInt(p.empty)} ${t.csv.stats.empty.toLowerCase()}` : base;
}

/** A category value's tint: its rank by frequency, cycling; a value the profile doesn't list gets the last tint. */
export function tintOf(p: ColumnProfile, value: string): number {
  const k = p.top.findIndex((x) => x.value === value);
  return k < 0 ? TINTS - 1 : k % TINTS;
}

/** A number as the header shows it: thin-space groups, the file's decimal separator, at most two decimals. */
export function shortNumber(n: number, decimal: Decimal): string {
  let s = Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/\.?0+$/, '');
  if (s === '-0') s = '0';
  const [int, frac] = s.split('.');
  const sign = int!.startsWith('-') ? '-' : '';
  const grouped = groupInt(Number(int!.replace('-', '')));
  return sign + grouped + (frac ? decimal + frac : '');
}

const isoDate = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export function summaryText(p: ColumnProfile, decimal: Decimal): string {
  if (p.type === 'empty') return '';
  if ((p.type === 'integer' || p.type === 'decimal') && p.min !== null && p.max !== null) return `${shortNumber(p.min, decimal)} – ${shortNumber(p.max, decimal)}`;
  if ((p.type === 'date' || p.type === 'datetime') && p.min !== null && p.max !== null) return `${isoDate(p.min)} → ${isoDate(p.max)}`;
  if ((p.type === 'category' || p.type === 'boolean') && p.top.length) {
    const shown = p.top.slice(0, 2).map((x) => `${x.value} ${groupInt(x.count)}`);
    const rest = p.distinct - shown.length;
    return shown.join(' · ') + (rest > 0 ? ` · +${rest}` : '');
  }
  return t.csv.distinct(groupInt(p.distinct));
}

/** Histogram bar heights in px, the tallest bin `max`; a non-empty bin at least 2 px. */
export function binHeights(bins: readonly number[], max: number): number[] {
  const top = Math.max(0, ...bins);
  return bins.map((b) => (b === 0 || top === 0 ? 0 : Math.max(2, Math.round((b / top) * max))));
}
