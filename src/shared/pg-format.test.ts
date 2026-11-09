import { describe, expect, it } from 'vitest';
import type { DbColumn } from './databases-filters';
import {
  MASK_COLUMN, bytesMime, cellText, ewkbSummary, formatCell, formatTimestamp, groupNumber, humanInterval, parsePgArray,
  relTimeShort, type FormatOpts
} from './pg-format';

const NOW = Date.UTC(2026, 10, 5, 17, 10); // 2026-11-05 18:10 in Rome
const O: FormatOpts = { times: 'local', tz: 'Europe/Rome', now: NOW, masked: false };

function col(name: string, typeName: string, typeCat: string, extra: Partial<DbColumn> = {}): DbColumn {
  return { name, type: typeName, typeSchema: 'pg_catalog', typeName, typeCat, isArray: false, nullable: true, isPk: false, isKey: false, ...extra };
}
const text = col('note', 'text', 'S');
const int = col('qty', 'int4', 'N');
const tstz = col('created_at', 'timestamptz', 'D');
const ts = col('local_at', 'timestamp', 'D');

describe('null, empty, blank, masked', () => {
  it('null and empty and blank', () => {
    expect(formatCell(null, text, O)).toEqual({ k: 'null' });
    expect(formatCell('', text, O)).toEqual({ k: 'empty' });
    expect(formatCell('  ', text, O)).toEqual({ k: 'blank', count: 2 });
    expect(formatCell(' \t', text, O)).toEqual({ k: 'blank', count: 2 });
  });
  it('masks matching columns before anything else but null', () => {
    const o = { ...O, masked: true };
    expect(formatCell('x', col('password_hash', 'text', 'S'), o)).toEqual({ k: 'masked' });
    expect(formatCell('', col('email', 'text', 'S'), o)).toEqual({ k: 'masked' });
    expect(formatCell(null, col('email', 'text', 'S'), o)).toEqual({ k: 'null' });
    expect(formatCell('x', col('email', 'text', 'S'), O)).toEqual({ k: 'text', text: 'x' });
    expect(cellText('x', col('api_key', 'text', 'S'), o)).toBe('••••••••');
  });
  it('MASK_COLUMN is the documented, deliberately broad regex', () => {
    expect(MASK_COLUMN.test('password_hash')).toBe(true);
    expect(MASK_COLUMN.test('api_key')).toBe(true);
    expect(MASK_COLUMN.test('email')).toBe(true);
    // Masking is opt-in and broad on purpose: `pass` matches passenger_count.
    expect(MASK_COLUMN.test('passenger_count')).toBe(true);
    expect(MASK_COLUMN.test('title')).toBe(false);
  });
});

describe('numbers', () => {
  it('groupNumber', () => {
    expect(groupNumber('1240.00')).toBe('1,240.00');
    expect(groupNumber('1234567')).toBe('1,234,567');
    expect(groupNumber('-12.5')).toBe('−12.5');
    expect(groupNumber('-1234.5')).toBe('−1,234.5');
    expect(groupNumber('1e21')).toBe('1e21');
    expect(groupNumber('-1.5e10')).toBe('-1.5e10');
    expect(groupNumber('NaN')).toBe('NaN');
    expect(groupNumber('Infinity')).toBe('Infinity');
  });
  it('formats numbers, keys and oids stay plain', () => {
    expect(formatCell('1240.00', int, O)).toEqual({ k: 'num', text: '1,240.00', neg: false });
    expect(formatCell('-12.50', int, O)).toEqual({ k: 'num', text: '−12.50', neg: true });
    expect(formatCell('10482', col('id', 'int4', 'N', { isKey: true }), O)).toEqual({ k: 'num', text: '10482', neg: false });
    expect(formatCell('16384', col('relid', 'oid', 'N'), O)).toEqual({ k: 'num', text: '16384', neg: false });
    expect(formatCell('NaN', col('x', 'float8', 'N'), O)).toEqual({ k: 'num', text: 'NaN', neg: false });
    expect(formatCell('Infinity', col('x', 'float8', 'N'), O)).toEqual({ k: 'num', text: 'Infinity', neg: false });
  });
  it('a negative key reads with the typographic minus, like every other number (never grouped)', () => {
    expect(formatCell('-10482', col('id', 'int8', 'N', { isKey: true }), O)).toEqual({ k: 'num', text: '−10482', neg: true });
    expect(formatCell('-1234', int, O)).toEqual({ k: 'num', text: '−1,234', neg: true });
  });
});

describe('bool', () => {
  it('reads t / f', () => {
    expect(formatCell('t', col('ok', 'bool', 'B'), O)).toEqual({ k: 'bool', on: true });
    expect(formatCell('f', col('ok', 'bool', 'B'), O)).toEqual({ k: 'bool', on: false });
    expect(cellText('t', col('ok', 'bool', 'B'), O)).toBe('true');
  });
});

describe('timestamps', () => {
  const raw = '2026-11-04 17:22:07.413+00';
  it('local converts to the zone', () => {
    const r = formatTimestamp(raw, 'timestamptz', O);
    expect(r.text).toBe('2026-11-04 18:22');
    expect(r.full).toBe('2026-11-04 18:22:07.413+01');
    expect(r.utc).toBe('2026-11-04 17:22:07.413+00');
    expect(r.unix).toBe(1793812927);
    expect(r.rel).toBe('yesterday');
  });
  it('utc and stored', () => {
    expect(formatTimestamp(raw, 'timestamptz', { ...O, times: 'utc' }).text).toBe('2026-11-04 17:22');
    const s = formatTimestamp('2026-11-04 17:22:07+02', 'timestamptz', { ...O, times: 'stored' });
    expect(s.text).toBe('2026-11-04 17:22');
    expect(s.full).toBe('2026-11-04 17:22:07+02');
  });
  it('summer time and half-hour offsets', () => {
    expect(formatTimestamp('2026-07-01 10:00:00+00', 'timestamptz', O).full).toBe('2026-07-01 12:00:00+02');
    expect(formatTimestamp('2026-07-01 10:00:00+00', 'timestamptz', { ...O, tz: 'Asia/Kolkata' }).full)
      .toBe('2026-07-01 15:30:00+05:30');
  });
  it('timestamp without zone is never converted', () => {
    const r = formatTimestamp('2026-11-04 17:22:07.5', 'timestamp', O);
    expect(r.text).toBe('2026-11-04 17:22');
    expect(r.full).toBe('2026-11-04 17:22:07.5');
    expect(r.unix).toBeNull();
  });
  it('cell view carries the title and the full text in the inspector', () => {
    const v = formatCell(raw, tstz, O);
    expect(v).toMatchObject({ k: 'time', text: '2026-11-04 18:22', rel: 'yesterday' });
    expect((v as { title: string }).title).toContain('2026-11-04 18:22:07.413+01');
    expect((v as { title: string }).title).toContain('2026-11-04 17:22:07.413+00');
    expect((v as { title: string }).title).toContain('1793812927');
    expect(formatCell(raw, tstz, { ...O, width: 'full' })).toMatchObject({ text: '2026-11-04 18:22:07.413+01' });
    expect(formatCell('2026-11-04 17:22:07', ts, O)).toMatchObject({ k: 'time', text: '2026-11-04 17:22' });
    expect(cellText(raw, tstz, O)).toBe('2026-11-04 18:22:07.413+01');
  });
  it('dates, infinity and odd values stay as they are', () => {
    expect(formatCell('2026-11-04', col('d', 'date', 'D'), O)).toMatchObject({ k: 'time', text: '2026-11-04', rel: null });
    expect(formatCell('infinity', tstz, O)).toMatchObject({ k: 'time', text: 'infinity', rel: null });
  });
  it('never throws: an invalid zone falls back, an out-of-range year stays as stored', () => {
    const bad = { ...O, tz: 'Not/AZone' };
    expect(() => formatTimestamp(raw, 'timestamptz', bad)).not.toThrow();
    expect(formatTimestamp(raw, 'timestamptz', bad).text).toMatch(/^2026-11-04 \d\d:\d\d$/);
    expect(() => formatCell(raw, tstz, bad)).not.toThrow();
    expect(() => cellText(raw, tstz, bad)).not.toThrow();
    const far = '294276-12-31 23:59:59+00';
    for (const times of ['local', 'utc', 'stored'] as const) {
      const r = formatTimestamp(far, 'timestamptz', { ...O, times });
      expect(r).toMatchObject({ unix: null, rel: null });
      expect(r.full).toBe(far);
    }
    expect(() => formatCell(far, tstz, O)).not.toThrow();
    expect(cellText(far, tstz, O)).toBe(far);
  });
  it('years 0–99 stay themselves (Date.UTC would read them as 19xx)', () => {
    const lit = '0050-06-01 12:00:00+00';
    const unix = new Date('0050-06-01T12:00:00Z').getTime() / 1000;
    expect(formatTimestamp(lit, 'timestamptz', { ...O, times: 'utc' })).toMatchObject({ text: '0050-06-01 12:00', utc: '0050-06-01 12:00:00+00', unix });
    expect(formatTimestamp(lit, 'timestamptz', { ...O, times: 'local', tz: 'UTC' })).toMatchObject({ full: '0050-06-01 12:00:00+00', unix });
    expect(formatTimestamp(lit, 'timestamptz', { ...O, times: 'stored' })).toMatchObject({ full: lit, unix });
  });
  it("a timestamp without a zone has no relative age: its instant can't be known", () => {
    expect(formatTimestamp('2026-11-05 16:00:00', 'timestamp', O).rel).toBeNull();
    expect(formatTimestamp('2026-11-05 16:00:00', 'timestamptz', O).rel).toBeNull(); // no offset in the text either
    expect(formatCell('2026-11-05 16:00:00', ts, O)).toMatchObject({ k: 'time', rel: null });
    expect(formatTimestamp('2026-11-05 16:00:00+00', 'timestamptz', O).rel).toBe('1h');
  });
  it('offsets with seconds (local mean time) are kept, stored and converted', () => {
    const lit = '1890-01-01 00:00:00+00:09:21';
    const unix = Date.UTC(1889, 11, 31, 23, 50, 39) / 1000;
    expect(formatTimestamp(lit, 'timestamptz', { ...O, times: 'stored' })).toMatchObject({ full: lit, utc: '1889-12-31 23:50:39+00', unix });
    expect(formatTimestamp('1890-01-01 00:00:00-00:09:21', 'timestamptz', { ...O, times: 'utc' }).full).toBe('1890-01-01 00:09:21+00');
    // Paris kept its mean time, +00:09:21, until 1911.
    expect(formatTimestamp('1889-12-31 23:50:39+00', 'timestamptz', { ...O, tz: 'Europe/Paris' }).full).toBe(lit);
  });
  it('near the end of what a Date holds, a zone ahead of UTC falls back to the stored text, never NaN', () => {
    const edge = '275760-09-13 00:00:00+00';
    const r = formatTimestamp(edge, 'timestamptz', { ...O, tz: 'Asia/Tokyo' });
    expect(r).toMatchObject({ text: edge, full: edge, unix: null });
    expect(JSON.stringify(r)).not.toContain('NaN');
    expect(formatTimestamp(edge, 'timestamptz', { ...O, times: 'utc' }).full).toBe('275760-09-13 00:00:00+00');
  });
  it('relTimeShort', () => {
    const min = 60_000;
    expect(relTimeShort(NOW - 12 * min, NOW)).toBe('12m');
    expect(relTimeShort(NOW - 2 * 3600_000, NOW)).toBe('2h');
    expect(relTimeShort(NOW - 24 * 3600_000, NOW)).toBe('yesterday');
    expect(relTimeShort(NOW - 3 * 86400_000, NOW)).toBe('3d');
    expect(relTimeShort(NOW - 5_000, NOW)).toBe('now');
    expect(relTimeShort(NOW + min, NOW)).toBeNull();
    expect(relTimeShort(NOW - 31 * 86400_000, NOW)).toBeNull();
  });
});

describe('interval', () => {
  it('humanInterval', () => {
    expect(humanInterval('3 days 04:00:00')).toBe('3d 4h');
    expect(humanInterval('00:00:05.5')).toBe('5.5s');
    expect(humanInterval('1 year 2 mons')).toBe('1y 2mo');
    expect(humanInterval('-01:30:00')).toBe('-1h 30m');
    expect(humanInterval('00:00:00')).toBe('0s');
    expect(humanInterval('whatever')).toBe('whatever');
  });
  it('grid shows it humanized, full and copy stay exact', () => {
    const c = col('took', 'interval', 'T');
    expect(formatCell('3 days 04:00:00', c, O)).toEqual({ k: 'text', text: '3d 4h' });
    expect(formatCell('3 days 04:00:00', c, { ...O, width: 'full' })).toEqual({ k: 'text', text: '3 days 04:00:00' });
    expect(cellText('3 days 04:00:00', c, O)).toBe('3 days 04:00:00');
  });
});

describe('uuid, json, arrays, enums', () => {
  it('uuid splits 8 / rest', () => {
    expect(formatCell('0b6f2c1e-4a77-4c2e-9d11-5a8b3c0e91aa', col('id', 'uuid', 'U'), O))
      .toEqual({ k: 'uuid', head: '0b6f2c1e', tail: '-4a77-4c2e-9d11-5a8b3c0e91aa' });
  });
  it('json parses or keeps the raw text', () => {
    const j = col('meta', 'jsonb', 'U');
    expect(formatCell('{"a": {"b": [1, 2]}}', j, O)).toEqual({ k: 'json', value: { a: { b: [1, 2] } }, raw: '{"a": {"b": [1, 2]}}' });
    expect(formatCell('{nope', j, O)).toEqual({ k: 'json', value: undefined, raw: '{nope' });
    expect(formatCell('null', j, O)).toMatchObject({ k: 'json', value: null });
  });
  it('parsePgArray', () => {
    expect(parsePgArray('{api,"beta tag",NULL,"q\\"x"}')).toEqual(['api', 'beta tag', null, 'q"x']);
    expect(parsePgArray('{}')).toEqual([]);
    expect(parsePgArray('{{1,2},{3}}')).toEqual(['{1,2}', '{3}']);
    expect(parsePgArray('{"NULL","a,b","c\\\\d"}')).toEqual(['NULL', 'a,b', 'c\\d']);
    expect(parsePgArray('[0:1]={a,b}')).toEqual(['a', 'b']);
  });
  it('array cell', () => {
    expect(formatCell('{a,NULL}', col('tags', 'text', 'A', { isArray: true }), O)).toEqual({ k: 'array', items: ['a', null] });
  });
  it('enum tint is the position', () => {
    const e = col('status', 'order_status', 'E', { enumValues: ['new', 'paid', 'shipped'] });
    expect(formatCell('paid', e, O)).toEqual({ k: 'enum', text: 'paid', tint: 1 });
    const many = col('s', 'x', 'E', { enumValues: Array.from({ length: 10 }, (_, i) => `v${i}`) });
    expect(formatCell('v9', many, O)).toMatchObject({ tint: 1 });
    expect(formatCell('gone', e, O)).toMatchObject({ k: 'enum', tint: 0 });
  });
});

describe('bytea', () => {
  const png = '\\x89504e470d0a1a0a0000000d49484452';
  it('head, size and mime', () => {
    expect(formatCell(png, col('blob', 'bytea', 'U'), O)).toEqual({ k: 'bytes', head: '89504e470d0a1a0a', size: 16, mime: 'image/png' });
    expect(formatCell('\\xdeadbeef', col('blob', 'bytea', 'U'), O)).toEqual({ k: 'bytes', head: 'deadbeef', size: 4, mime: null });
  });
  it("a value main cut: its size is the server's (DbCell.cut), never its cut hex's", () => {
    const cut = '\\x' + '89504e470d0a1a0a'.padEnd(2 * 65536, '0');
    expect(formatCell(cut, col('blob', 'bytea', 'U'), O, 1_048_576)).toMatchObject({ k: 'bytes', size: 1_048_576, mime: 'image/png' });
    expect(formatCell('\\xdeadbeef', col('blob', 'bytea', 'U'), O, undefined)).toMatchObject({ size: 4 });
  });
  it('bytesMime by magic bytes', () => {
    expect(bytesMime('ffd8ffe0')).toBe('image/jpeg');
    expect(bytesMime('47494638396100')).toBe('image/gif');
    expect(bytesMime('52494646' + '24000000' + '57454250')).toBe('image/webp');
    expect(bytesMime('52494646' + '24000000' + '41564920')).toBeNull();
    expect(bytesMime('255044462d')).toBe('application/pdf');
    expect(bytesMime('1f8b0800')).toBe('application/gzip');
    expect(bytesMime('504b0304')).toBe('application/zip');
    expect(bytesMime('')).toBeNull();
  });
});

describe('geometry', () => {
  const toHex = (b: DataView): string => Array.from(new Uint8Array(b.buffer), (v) => v.toString(16).padStart(2, '0')).join('');
  function ewkbPoint(x: number, y: number, srid: number): string {
    const b = new DataView(new ArrayBuffer(25));
    b.setUint8(0, 1);
    b.setUint32(1, 0x20000001, true);
    b.setUint32(5, srid, true);
    b.setFloat64(9, x, true);
    b.setFloat64(17, y, true);
    return toHex(b).toUpperCase();
  }
  function ewkbLine(n: number): string {
    const b = new DataView(new ArrayBuffer(13 + n * 16));
    b.setUint8(0, 1);
    b.setUint32(1, 0x20000002, true);
    b.setUint32(5, 4326, true);
    b.setUint32(9, n, true);
    return toHex(b);
  }
  it('a point reads as POINT(x y)', () => {
    const hex = ewkbPoint(9.19, 45.46, 4326);
    expect(hex.startsWith('0101000020E6100000')).toBe(true);
    expect(ewkbSummary(hex)).toBe('POINT(9.19 45.46)');
    expect(formatCell(hex, col('loc', 'geometry', 'U'), O)).toEqual({ k: 'geo', text: 'POINT(9.19 45.46)' });
  });
  it('other shapes get a summary, garbage stays text', () => {
    expect(ewkbSummary(ewkbLine(12))).toBe('LINESTRING · 12 points · SRID 4326');
    expect(ewkbSummary('zz')).toBe('zz');
  });

  /** EWKB as PostGIS prints it, either byte order: the type word with its flags (Z 0x80000000, M 0x40000000, SRID 0x20000000). */
  class Ewkb {
    private readonly bytes: number[] = [];
    constructor(private readonly le: boolean, type: number, srid?: number) {
      this.bytes.push(le ? 1 : 0);
      this.u32((type | (srid === undefined ? 0 : 0x20000000)) >>> 0);
      if (srid !== undefined) this.u32(srid);
    }
    u32(n: number): this { const d = new DataView(new ArrayBuffer(4)); d.setUint32(0, n, this.le); this.bytes.push(...new Uint8Array(d.buffer)); return this; }
    f64(...ns: number[]): this { for (const n of ns) { const d = new DataView(new ArrayBuffer(8)); d.setFloat64(0, n, this.le); this.bytes.push(...new Uint8Array(d.buffer)); } return this; }
    get hex(): string { return this.bytes.map((b) => b.toString(16).padStart(2, '0')).join(''); }
  }
  const Z = 0x80000000;
  const M = 0x40000000;

  it('big-endian reads as little-endian does', () => {
    expect(ewkbSummary(new Ewkb(false, 1).f64(1.5, -2).hex)).toBe('POINT(1.5 -2)');
    expect(ewkbSummary(new Ewkb(false, 2, 4326).u32(3).f64(0, 0, 1, 1, 2, 2).hex)).toBe('LINESTRING · 3 points · SRID 4326');
    expect(ewkbSummary(new Ewkb(false, 3).u32(1).u32(4).f64(0, 0, 1, 0, 1, 1, 0, 0).hex)).toBe('POLYGON · 4 points');
  });
  it('Z and M: a point shows x y and its third number (z, else m); rings skip every coordinate', () => {
    expect(ewkbSummary(new Ewkb(true, Z | 1, 4326).f64(1, 2, 3).hex)).toBe('POINT(1 2 3)');
    expect(ewkbSummary(new Ewkb(true, M | 1).f64(1, 2, 7).hex)).toBe('POINT(1 2 7)');
    expect(ewkbSummary(new Ewkb(true, Z | M | 1).f64(1, 2, 3, 7).hex)).toBe('POINT(1 2 3)');
    const ring = (n: number, dims: number) => Array.from({ length: n * dims }, (_, i) => i);
    expect(ewkbSummary(new Ewkb(true, Z | 3).u32(2).u32(4).f64(...ring(4, 3)).u32(5).f64(...ring(5, 3)).hex)).toBe('POLYGON · 9 points');
    expect(ewkbSummary(new Ewkb(false, Z | M | 3, 3857).u32(2).u32(4).f64(...ring(4, 4)).u32(3).f64(...ring(3, 4)).hex)).toBe('POLYGON · 7 points · SRID 3857');
  });
  it('multi geometries and collections count their parts', () => {
    expect(ewkbSummary(new Ewkb(true, 4, 4326).u32(3).hex)).toBe('MULTIPOINT · 3 parts · SRID 4326');
    expect(ewkbSummary(new Ewkb(true, 5).u32(2).hex)).toBe('MULTILINESTRING · 2 parts');
    expect(ewkbSummary(new Ewkb(false, 6).u32(1).hex)).toBe('MULTIPOLYGON · 1 part');
    expect(ewkbSummary(new Ewkb(true, Z | 7).u32(2).hex)).toBe('GEOMETRYCOLLECTION · 2 parts');
  });
  it('curves and surfaces are summarized by name, never as hex', () => {
    expect(ewkbSummary(new Ewkb(true, 8, 4326).u32(3).f64(0, 0, 1, 1, 2, 0).hex)).toBe('CIRCULARSTRING · 3 points · SRID 4326');
    expect(ewkbSummary(new Ewkb(true, 9).u32(2).hex)).toBe('COMPOUNDCURVE · 2 parts');
    expect(ewkbSummary(new Ewkb(true, 10).u32(1).hex)).toBe('CURVEPOLYGON · 1 part');
    expect(ewkbSummary(new Ewkb(true, 11).u32(2).hex)).toBe('MULTICURVE · 2 parts');
    expect(ewkbSummary(new Ewkb(true, 12).u32(2).hex)).toBe('MULTISURFACE · 2 parts');
    expect(ewkbSummary(new Ewkb(true, 15).u32(6).hex)).toBe('POLYHEDRALSURFACE · 6 parts');
    expect(ewkbSummary(new Ewkb(true, 16).u32(4).hex)).toBe('TIN · 4 parts');
    expect(ewkbSummary(new Ewkb(true, 17).u32(1).u32(4).f64(0, 0, 1, 0, 0, 1, 0, 0).hex)).toBe('TRIANGLE · 4 points');
    // ISO type codes (1001…) are never what Postgres prints for geometry (EWKB flags are): left as they are.
    const iso = new Ewkb(true, 1001).f64(1, 2, 3).hex;
    expect(ewkbSummary(iso)).toBe(iso);
  });
  it('a truncated point prints its name alone (a point never shows an SRID); a truncated shape keeps it', () => {
    expect(ewkbSummary(new Ewkb(true, 1, 4326).f64(1).hex)).toBe('POINT');
    expect(ewkbSummary(new Ewkb(true, 1).hex)).toBe('POINT');
    expect(ewkbSummary(new Ewkb(true, 2, 4326).hex)).toBe('LINESTRING · SRID 4326');
  });
  it('never throws, whatever the bytes (a seeded fuzz)', () => {
    let seed = 0x5eed;
    const rnd = (): number => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const FLAGS = [0, 0x20000000, Z, M, Z | M | 0x20000000];
    for (let k = 0; k < 5000; k++) {
      const bytes = Array.from({ length: Math.floor(rnd() * 80) }, () => Math.floor(rnd() * 256));
      if (bytes.length > 0 && rnd() < 0.8) bytes[0] = rnd() < 0.5 ? 0 : 1;
      if (bytes.length >= 5 && rnd() < 0.8) {
        // A plausible type word, so the walk gets past the header into the counts.
        const d = new DataView(new ArrayBuffer(4));
        d.setUint32(0, ((1 + Math.floor(rnd() * 17)) | FLAGS[Math.floor(rnd() * FLAGS.length)]!) >>> 0, bytes[0] === 1);
        bytes.splice(1, 4, ...new Uint8Array(d.buffer));
      }
      let hex = bytes.map((b) => b.toString(16).padStart(2, '0')).join('');
      if (rnd() < 0.05) hex = hex.slice(1);
      let out: unknown;
      expect(() => { out = ewkbSummary(hex); }, hex).not.toThrow();
      expect(typeof out, hex).toBe('string');
      expect(out as string, hex).not.toMatch(/NaN|undefined/);
    }
  });
});

describe('the rest', () => {
  it('tsvector lexemes', () => {
    expect(formatCell("'fat':2,4 'cat':3A 'it''s'", col('doc', 'tsvector', 'U'), O)).toEqual({
      k: 'lexemes', items: [{ word: 'fat', pos: '2,4' }, { word: 'cat', pos: '3A' }, { word: "it's", pos: '' }]
    });
  });
  it('ranges, text and unknown types keep the text', () => {
    expect(formatCell('[1,10)', col('r', 'int4range', 'R'), O)).toEqual({ k: 'range', text: '[1,10)' });
    expect(formatCell('10.0.0.1/32', col('ip', 'inet', 'I'), O)).toEqual({ k: 'text', text: '10.0.0.1/32' });
    expect(formatCell('hello', text, O)).toEqual({ k: 'text', text: 'hello' });
    expect(formatCell('(1,2)', col('p', 'point', 'G'), O)).toEqual({ k: 'text', text: '(1,2)' });
  });
});
