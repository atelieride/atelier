// Databases view: a raw Postgres text value plus its column type become a display view for the grid and the row
// inspector. Pure: it runs in main and in the renderer, so no
// Node-only APIs (no Buffer); time zones go through Intl.

import { typeClass, type DbColumn } from './databases-filters';

export type DbTimes = 'local' | 'utc' | 'stored';
export interface FormatOpts { times: DbTimes; tz?: string; now: number; masked: boolean; width?: 'grid' | 'full' }

export type CellView =
  | { k: 'null' } | { k: 'empty' } | { k: 'blank'; count: number } | { k: 'masked' }
  | { k: 'num'; text: string; neg: boolean }
  | { k: 'bool'; on: boolean }
  | { k: 'time'; text: string; rel: string | null; title: string }
  | { k: 'uuid'; head: string; tail: string }
  | { k: 'json'; value: unknown | undefined; raw: string }
  | { k: 'array'; items: (string | null)[] }
  | { k: 'enum'; text: string; tint: number }
  | { k: 'bytes'; head: string; size: number; mime: string | null }
  | { k: 'range'; text: string }
  | { k: 'geo'; text: string }
  | { k: 'lexemes'; items: { word: string; pos: string }[] }
  | { k: 'text'; text: string };

// Masking is opt-in and broad on purpose (`pass` also matches passenger_count): better a column hidden too many than a
// secret on a shared screen.
export const MASK_COLUMN = /pass(word)?|pwd|secret|token|api_?key|private_?key|salt|hash|otp|email|phone|iban|ssn|tax_?id/i;
/** What a masked value shows and carries, everywhere (the grid, the inspector, copies, sends). */
export const MASK = '••••••••';
const MINUS = '−';

// ---------- numbers ----------

export function groupNumber(text: string): string {
  const m = /^(-?)(\d+)(\.\d+)?$/.exec(text);
  if (!m) return text; // NaN, Infinity, exponent forms, money…
  const int = m[2]!.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${m[1] ? MINUS : ''}${int}${m[3] ?? ''}`;
}

// ---------- timestamps ----------

const TS_RE = /^(\d{4,})-(\d\d)-(\d\d)[ T](\d\d):(\d\d):(\d\d)(?:\.(\d+))?(?:([+-])(\d\d)(?::?(\d\d))?(?::?(\d\d))?)?$/;
const pad = (n: number, w = 2): string => String(n).padStart(w, '0');

/** An offset in seconds as Postgres prints it: +01, +05:30, +00:09:21 (a local mean time keeps its seconds). */
function offsetText(sec: number): string {
  const a = Math.abs(sec);
  const m = Math.floor(a / 60) % 60;
  const s = a % 60;
  return `${sec < 0 ? '-' : '+'}${pad(Math.floor(a / 3600))}${m || s ? ':' + pad(m) : ''}${s ? ':' + pad(s) : ''}`;
}

const formatters = new Map<string, Intl.DateTimeFormat>();
function zoneFormatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit'
    });
    formatters.set(tz, f);
  }
  return f;
}

interface Wall { y: number; mo: number; d: number; h: number; mi: number; s: number }
function wallText(w: Wall): { minute: string; second: string } {
  const minute = `${pad(w.y, 4)}-${pad(w.mo)}-${pad(w.d)} ${pad(w.h)}:${pad(w.mi)}`;
  return { minute, second: `${minute}:${pad(w.s)}` };
}

/** A UTC wall clock as epoch milliseconds: years 0–99 stay themselves (Date.UTC reads them as 19xx); NaN past a Date's range. */
function utcMs(w: Wall, ms = 0): number {
  const t = new Date(0);
  t.setUTCFullYear(w.y, w.mo - 1, w.d);
  t.setUTCHours(w.h, w.mi, w.s, ms);
  return t.getTime();
}

/** The wall clock in a zone and its offset in seconds; null when that wall clock falls past what a Date holds. */
function zoneWall(ms: number, tz: string): { wall: Wall; offsetSec: number } | null {
  const whole = Math.floor(ms / 1000) * 1000;
  const p: Record<string, number> = {};
  for (const part of zoneFormatter(tz).formatToParts(whole)) if (part.type !== 'literal') p[part.type] = Number(part.value);
  const wall = { y: p.year!, mo: p.month!, d: p.day!, h: p.hour!, mi: p.minute!, s: p.second! };
  const asUtc = utcMs(wall);
  if (!Number.isFinite(asUtc)) return null;
  return { wall, offsetSec: Math.round((asUtc - whole) / 1000) };
}

// The asked zone, else the system's (an invalid zone name must not throw into a grid cell); null when neither works or
// the wall clock falls past a Date's range (the caller keeps the stored text).
function localWall(ms: number, o: FormatOpts): { wall: Wall; offsetSec: number } | null {
  for (const tz of [o.tz, undefined]) {
    try {
      return zoneWall(ms, tz ?? Intl.DateTimeFormat().resolvedOptions().timeZone);
    } catch { /* try the next zone */ }
  }
  return null;
}

export function relTimeShort(ms: number, now: number): string | null {
  const diff = now - ms;
  if (diff < 0) return null;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'now';
  if (mins < 60) return `${mins}m`;
  if (diff < 23.5 * 3600_000) return `${Math.floor(diff / 3600_000)}h`;
  const days = Math.round(diff / 86400_000);
  if (days <= 1) return 'yesterday';
  return days <= 30 ? `${days}d` : null;
}

export function formatTimestamp(
  lit: string, kind: 'timestamp' | 'timestamptz', o: FormatOpts
): { text: string; full: string; rel: string | null; utc: string; unix: number | null } {
  const m = TS_RE.exec(lit.trim());
  if (!m) return { text: lit, full: lit, rel: null, utc: lit, unix: null };
  const [y, mo, d, h, mi, s] = [m[1], m[2], m[3], m[4], m[5], m[6]].map(Number) as [number, number, number, number, number, number];
  const frac = m[7] ? `.${m[7]}` : '';
  const storedWall: Wall = { y, mo, d, h, mi, s };
  const fracMs = m[7] ? Math.floor(Number(`0.${m[7]}`) * 1000) : 0;
  if (kind === 'timestamp' || m[8] === undefined) {
    // No zone in the value: shown as stored, never converted, and no relative age (its instant can't be known).
    const t = wallText(storedWall);
    return { text: t.minute, full: `${t.second}${frac}`, rel: null, utc: `${t.second}${frac}`, unix: null };
  }
  const sign = m[8] === '-' ? -1 : 1;
  // In seconds: a local mean time's offset has them (+00:09:21).
  const storedOffset = sign * (Number(m[9]) * 3600 + Number(m[10] ?? 0) * 60 + Number(m[11] ?? 0));
  const ms = utcMs(storedWall, fracMs) - storedOffset * 1000;
  // Postgres years go past what a JS Date holds: keep the value as stored rather than throw.
  const asStored = { text: lit, full: lit, rel: null, utc: lit, unix: null };
  if (!Number.isFinite(ms) || Math.abs(ms) > 8.64e15) return asStored;
  const unix = Math.floor(ms / 1000);
  const u = new Date(ms);
  const utcWall: Wall = {
    y: u.getUTCFullYear(), mo: u.getUTCMonth() + 1, d: u.getUTCDate(), h: u.getUTCHours(), mi: u.getUTCMinutes(), s: u.getUTCSeconds()
  };
  const utc = `${wallText(utcWall).second}${frac}+00`;
  let wall = storedWall;
  let off = storedOffset;
  if (o.times === 'utc') { wall = utcWall; off = 0; }
  else if (o.times === 'local') {
    const z = localWall(ms, o);
    if (!z) return asStored;
    wall = z.wall;
    off = z.offsetSec;
  }
  const t = wallText(wall);
  return { text: t.minute, full: `${t.second}${frac}${offsetText(off)}`, rel: relTimeShort(ms, o.now), utc, unix };
}

// ---------- intervals ----------

export function humanInterval(lit: string): string {
  let rest = lit.trim();
  const parts: string[] = [];
  const units: [RegExp, string][] = [[/^(-?\d+) years?\s*/, 'y'], [/^(-?\d+) mons?\s*/, 'mo'], [/^(-?\d+) days?\s*/, 'd']];
  for (const [re, u] of units) {
    const m = re.exec(rest);
    if (m) { if (Number(m[1]) !== 0) parts.push(`${m[1]}${u}`); rest = rest.slice(m[0].length); }
  }
  if (rest) {
    const m = /^([+-]?)(\d+):(\d\d):(\d\d(?:\.\d+)?)$/.exec(rest);
    if (!m) return lit;
    const t: string[] = [];
    if (Number(m[2]) !== 0) t.push(`${Number(m[2])}h`);
    if (Number(m[3]) !== 0) t.push(`${Number(m[3])}m`);
    if (Number(m[4]) !== 0) t.push(`${Number(m[4])}s`);
    if (t.length > 0) t[0] = (m[1] === '-' ? '-' : '') + t[0];
    parts.push(...t);
  }
  return parts.length > 0 ? parts.join(' ') : '0s';
}

// ---------- arrays ----------

export function parsePgArray(lit: string): (string | null)[] {
  let s = lit.trim();
  if (s.startsWith('[')) { const eq = s.indexOf('='); if (eq > 0) s = s.slice(eq + 1); } // dimension decoration
  if (!s.startsWith('{') || !s.endsWith('}')) return [lit];
  const out: (string | null)[] = [];
  let i = 1;
  const end = s.length - 1;
  while (i < end) {
    const c = s[i]!;
    if (c === ',' || c === ' ') { i++; continue; }
    if (c === '{') {
      let depth = 0;
      let j = i;
      let quoted = false;
      for (; j < end; j++) {
        const ch = s[j]!;
        if (quoted) { if (ch === '\\') j++; else if (ch === '"') quoted = false; continue; }
        if (ch === '"') quoted = true;
        else if (ch === '{') depth++;
        else if (ch === '}' && --depth === 0) break;
      }
      out.push(s.slice(i, j + 1));
      i = j + 1;
    } else if (c === '"') {
      let v = '';
      i++;
      while (i < end && s[i] !== '"') {
        if (s[i] === '\\') i++;
        v += s[i] ?? '';
        i++;
      }
      i++;
      out.push(v);
    } else {
      let j = i;
      while (j < end && s[j] !== ',') j++;
      const v = s.slice(i, j).trim();
      out.push(v.toUpperCase() === 'NULL' ? null : v);
      i = j;
    }
  }
  return out;
}

// ---------- bytea, geometry ----------

export function bytesMime(hexHead: string): string | null {
  const h = hexHead.replace(/^\\x/, '').toLowerCase();
  if (h.startsWith('89504e47')) return 'image/png';
  if (h.startsWith('ffd8ff')) return 'image/jpeg';
  if (h.startsWith('47494638')) return 'image/gif';
  if (h.startsWith('52494646') && h.slice(16, 24) === '57454250') return 'image/webp';
  if (h.startsWith('25504446')) return 'application/pdf';
  if (h.startsWith('1f8b')) return 'application/gzip';
  if (h.startsWith('504b0304')) return 'application/zip';
  return null;
}

function hexBytes(hex: string): Uint8Array | null {
  if (hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

// EWKB, as PostGIS prints geometry and geography: the OGC type number with flags in its high bits (never the ISO
// 1001… codes).
const GEO_NAMES: Readonly<Record<number, string>> = {
  1: 'POINT', 2: 'LINESTRING', 3: 'POLYGON', 4: 'MULTIPOINT', 5: 'MULTILINESTRING', 6: 'MULTIPOLYGON', 7: 'GEOMETRYCOLLECTION',
  8: 'CIRCULARSTRING', 9: 'COMPOUNDCURVE', 10: 'CURVEPOLYGON', 11: 'MULTICURVE', 12: 'MULTISURFACE', 15: 'POLYHEDRALSURFACE',
  16: 'TIN', 17: 'TRIANGLE'
};
const EWKB_Z = 0x80000000;
const EWKB_M = 0x40000000;
const EWKB_SRID = 0x20000000;
const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 * A geometry's summary: a point's coordinates (x y, then z, else m), a line's points, a polygon's points over its rings,
 * anything else its parts; the SRID after a shape (never after a point). Truncated, the name (and the shape's SRID).
 */
export function ewkbSummary(hex: string): string {
  const bytes = hexBytes(hex);
  if (!bytes || bytes.length < 5) return hex;
  const v = new DataView(bytes.buffer);
  const le = bytes[0] === 1;
  const raw = v.getUint32(1, le);
  const type = raw & 0x1fffffff;
  const name = GEO_NAMES[type];
  if (!name) return hex;
  let at = 5;
  let srid: number | null = null;
  if ((raw & EWKB_SRID) !== 0) {
    if (bytes.length < 9) return hex;
    srid = v.getUint32(5, le);
    at = 9;
  }
  const hasZ = (raw & EWKB_Z) !== 0;
  const hasM = (raw & EWKB_M) !== 0;
  const dims = 2 + (hasZ ? 1 : 0) + (hasM ? 1 : 0);
  const tail = srid !== null ? ` · SRID ${srid}` : '';
  try {
    if (type === 1) {
      const nums: number[] = [];
      for (let k = 0; k < dims; k++) nums.push(v.getFloat64(at + k * 8, le));
      return `POINT(${nums.slice(0, 3).join(' ')})`;
    }
    const n = v.getUint32(at, le);
    if (type === 2 || type === 8) return `${name} · ${plural(n, 'point')}${tail}`;
    if (type === 3 || type === 17) {
      let points = 0;
      let p = at + 4;
      for (let r = 0; r < n; r++) {
        const c = v.getUint32(p, le);
        points += c;
        p += 4 + c * dims * 8;
      }
      return `${name} · ${plural(points, 'point')}${tail}`;
    }
    return `${name} · ${plural(n, 'part')}${tail}`;
  } catch {
    return type === 1 ? name : `${name}${tail}`;
  }
}

// ---------- the cell ----------

const UUID_HEAD = 8;

function lexemes(raw: string): { word: string; pos: string }[] {
  const out: { word: string; pos: string }[] = [];
  const re = /'((?:[^']|'')*)'(?::(\S+))?/g;
  for (let m = re.exec(raw); m; m = re.exec(raw)) out.push({ word: m[1]!.replace(/''/g, "'"), pos: m[2] ?? '' });
  return out;
}

/** Whether a column's values show as dots: Mask values on and its name matches (the grid, the inspector, every copy). */
export function isMasked(col: DbColumn, o: FormatOpts): boolean {
  return o.masked && MASK_COLUMN.test(col.name);
}

/**
 * A value's view. `cut`: the value's whole length when main cut it at 64 KB (DbCell.cut) — a bytea's size is then the
 * server's, never its cut hex's.
 */
export function formatCell(raw: string | null, col: DbColumn, o: FormatOpts, cut?: number): CellView {
  if (raw === null) return { k: 'null' };
  if (isMasked(col, o)) return { k: 'masked' };
  if (raw === '') return { k: 'empty' };
  if (/^[ \t]+$/.test(raw)) return { k: 'blank', count: raw.length };
  const tn = col.typeName;
  const cls = typeClass(col);
  if (cls === 'array') return { k: 'array', items: parsePgArray(raw) };
  if (cls === 'bool') return { k: 'bool', on: raw === 't' || raw === 'true' };
  if (cls === 'number') {
    // Keys and oids are never grouped; a leading minus reads − in every number (forms groupNumber leaves, exponents and
    // money, keep their text).
    const plain = col.isKey || tn === 'oid';
    return { k: 'num', text: plain ? raw.replace(/^-(?=\d)/, MINUS) : groupNumber(raw), neg: raw.startsWith('-') };
  }
  if (cls === 'enum') {
    const i = col.enumValues ? col.enumValues.indexOf(raw) : -1;
    return { k: 'enum', text: raw, tint: i >= 0 ? i % 8 : 0 };
  }
  if (cls === 'time') {
    if (tn === 'date') return { k: 'time', text: raw, rel: null, title: raw };
    const t = formatTimestamp(raw, tn === 'timestamptz' ? 'timestamptz' : 'timestamp', o);
    const title = t.unix === null ? t.full : `${t.full} · ${t.utc} UTC · unix ${t.unix}`;
    return { k: 'time', text: o.width === 'full' ? t.full : t.text, rel: t.rel, title };
  }
  if (cls === 'json') {
    let value: unknown;
    try { value = JSON.parse(raw); } catch { value = undefined; }
    return { k: 'json', value, raw };
  }
  if (tn === 'uuid') return { k: 'uuid', head: raw.slice(0, UUID_HEAD), tail: raw.slice(UUID_HEAD) };
  if (tn === 'bytea' && raw.startsWith('\\x')) {
    const hex = raw.slice(2);
    return { k: 'bytes', head: hex.slice(0, 16), size: cut ?? Math.floor(hex.length / 2), mime: bytesMime(hex.slice(0, 24)) };
  }
  if (tn === 'interval') return { k: 'text', text: o.width === 'full' ? raw : humanInterval(raw) };
  if (tn === 'geometry' || tn === 'geography') return { k: 'geo', text: ewkbSummary(raw) };
  if (tn === 'tsvector') return { k: 'lexemes', items: lexemes(raw) };
  if (col.typeCat === 'R' || /range$/.test(tn)) return { k: 'range', text: raw };
  return { k: 'text', text: raw };
}

// What Copy Value, TSV and prompts carry: the value as the user reads it, masked when the mask is on.
export function cellText(raw: string | null, col: DbColumn, o: FormatOpts): string {
  if (raw === null) return '';
  if (isMasked(col, o)) return MASK;
  const cls = typeClass(col);
  if (cls === 'bool') return raw === 't' ? 'true' : raw === 'f' ? 'false' : raw;
  if (cls === 'time' && col.typeName !== 'date') return formatTimestamp(raw, col.typeName === 'timestamptz' ? 'timestamptz' : 'timestamp', o).full;
  return raw;
}
