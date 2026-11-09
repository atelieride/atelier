import { describe, expect, test } from 'vitest';
import type { DbCell, DbFullRequest, DbPage, DbResult } from '@shared/databases';
import type { DbColumn } from '@shared/databases-filters';
import type { FormatOpts } from '@shared/pg-format';
import { blankAt, copyText, cutCount, fullRequest, rowsAs, valueCopy, type GridSource } from './grid-copy';
import { gridColumns, hiddenColumns } from './grid-model';

// What ⌘C and Copy Rows As carry (no number ever changes, a cut value is read whole before Copy Value, SQL INSERT
// has the row's keys): masked when Mask values is on.

const col = (name: string, typeName: string, typeCat: string, o: Partial<DbColumn> = {}): DbColumn => ({
  name, type: typeName, typeSchema: 'pg_catalog', typeName, typeCat, isArray: false, nullable: true, isPk: false, isKey: false, ...o
});
const ID = col('id', 'int8', 'N', { type: 'bigint', isPk: true, isKey: true });
const EMAIL = col('email', 'text', 'S');
const NOTE = col('note', 'text', 'S');
const TOTAL = col('total', 'numeric', 'N', { type: 'numeric(30,9)' });
const META = col('meta', 'jsonb', 'U');
const OK = col('ok', 'bool', 'B', { type: 'boolean' });

const O: FormatOpts = { times: 'stored', now: Date.UTC(2026, 10, 5), masked: false, width: 'grid' };
const MASKED: FormatOpts = { ...O, masked: true };
const c = (v: string | null, cut?: number): DbCell => (cut === undefined ? { v } : { v, cut });
const T = { connId: 'c0123456789ab', schema: 'public', name: 'orders' };

function page(columns: DbColumn[], rows: (string | null)[][], o: Partial<DbPage> = {}): DbPage {
  return { columns, hidden: [], derived: [], rows: rows.map((r) => r.map((v) => c(v))), ms: 3, sql: 'SELECT 1', pk: ['id'], kind: 'table', ...o, rowKey: o.rowKey ?? o.pk ?? ['id'] };
}
const src = (p: DbPage): GridSource => ({ columns: gridColumns(p), hidden: hiddenColumns(p), rows: p.rows });

describe('copyText (⌘C)', () => {
  const p = page([ID, EMAIL, NOTE, OK], [['1', 'a@x.test', 'line one\nline\ttwo', 't'], ['2', 'b@x.test', null, 'f'], ['3', 'c@x.test', '', 't']]);
  test('one row selected: the focused cell\'s value as it is (newlines kept)', () => {
    expect(copyText(src(p), [0], { row: 0, col: 2 }, O)).toBe('line one\nline\ttwo');
    expect(copyText(src(p), [0], { row: 0, col: 3 }, O)).toBe('true');
    expect(copyText(src(p), [1], { row: 1, col: 2 }, O)).toBe('');
    // Nothing selected, a focused cell: its value.
    expect(copyText(src(p), [], { row: 1, col: 1 }, O)).toBe('b@x.test');
  });

  test('more rows: TSV with a header, tabs and newlines in values written as \\t and \\n, NULL empty', () => {
    expect(copyText(src(p), [1, 0], { row: 0, col: 2 }, O)).toBe([
      'id\temail\tnote\tok',
      '1\ta@x.test\tline one\\nline\\ttwo\ttrue',
      '2\tb@x.test\t\tfalse'
    ].join('\n'));
  });

  test('one row selected with the focus elsewhere: that row as TSV', () => {
    expect(copyText(src(p), [2], null, O)).toBe('id\temail\tnote\tok\n3\tc@x.test\t\ttrue');
  });

  test('nothing selected, nothing focused: nothing', () => {
    expect(copyText(src(p), [], null, O)).toBe('');
  });

  test('⌘C on a NULL or empty focused cell has nothing to copy: no copy, no "Copied" — any other value does', () => {
    expect(blankAt(src(p), { row: 1, col: 2 })).toBe(true);
    expect(blankAt(src(p), { row: 2, col: 2 })).toBe(true);
    expect(blankAt(src(p), { row: 0, col: 2 })).toBe(false);
    expect(blankAt(src(p), { row: 1, col: 3 })).toBe(false);
    // Spaces are a value (the grid shows them as ␣ marks).
    expect(blankAt(src(page([ID, NOTE], [['1', '  ']])), { row: 0, col: 1 })).toBe(false);
    // Nothing there (a row or column gone): nothing either.
    expect(blankAt(src(p), { row: 9, col: 2 })).toBe(true);
  });

  test('a uuid is copied whole by ⌘C (and Copy Value) — a click selects its row as any cell does', () => {
    const U = col('ref', 'uuid', 'U');
    const q = page([ID, U], [['1', '8f2a91c4-5b0e-4c1f-9d2a-31b7c0a4e7d1']]);
    expect(copyText(src(q), [0], { row: 0, col: 1 }, O)).toBe('8f2a91c4-5b0e-4c1f-9d2a-31b7c0a4e7d1');
    expect(blankAt(src(q), { row: 0, col: 1 })).toBe(false);
  });

  test('Mask values on: masked in the cell and in the TSV', () => {
    expect(copyText(src(p), [0], { row: 0, col: 1 }, MASKED)).toBe('••••••••');
    expect(copyText(src(p), [0, 1], null, MASKED)).not.toContain('@x.test');
  });
});

describe('rowsAs (Copy Rows As › JSON · CSV · Markdown · SQL INSERT)', () => {
  const BIG = '12345678901234567890.123456789';
  const p = page([ID, NOTE, TOTAL, META, OK, EMAIL], [
    ['1', 'it\'s "fine", | ok', BIG, '{"plan": "pro", "seats": 12}', 't', 'a@x.test'],
    ['2', null, '-3.50', null, 'f', 'b@x.test']
  ]);

  test('JSON: DEL and the C1 controls (0x7f–0x9f) written as \\u escapes, in text values and inside JSON values', () => {
    // JSON allows them raw, but a paste sanitizer may drop them: escaped, a send keeps them, and the text parses the same.
    const q = page([ID, NOTE, META], [['1', 'a\u007fb\u0085c\u009fd', '{"k": "x\u0085y", "n": 12345678901234567890}']]);
    const out = rowsAs(src(q), [0], 'json', T, O);
    expect(out).not.toMatch(/[\u007f-\u009f]/);
    expect(out).toContain('"note": "a\\u007fb\\u0085c\\u009fd"');
    expect(out).toContain('"meta": {"k": "x\\u0085y", "n": 12345678901234567890}');
    expect(JSON.parse(out)).toMatchObject({ note: 'a\u007fb\u0085c\u009fd', meta: { k: 'x\u0085y' } });
    // Other formats carry the value as it is.
    expect(rowsAs(src(q), [0], 'csv', T, O)).toContain('a\u007fb\u0085c\u009fd');
  });

  test('JSON is written as text: numbers as Postgres printed them, JSON values as they are, NULL null, booleans', () => {
    const out = rowsAs(src(p), [0, 1], 'json', T, O);
    expect(out).toBe([
      '[',
      '  {',
      '    "id": 1,',
      '    "note": "it\'s \\"fine\\", | ok",',
      `    "total": ${BIG},`,
      '    "meta": {"plan": "pro", "seats": 12},',
      '    "ok": true,',
      '    "email": "a@x.test"',
      '  },',
      '  {',
      '    "id": 2,',
      '    "note": null,',
      '    "total": -3.50,',
      '    "meta": null,',
      '    "ok": false,',
      '    "email": "b@x.test"',
      '  }',
      ']'
    ].join('\n'));
    expect(() => JSON.parse(out)).not.toThrow();
  });

  test('one row: an object, not a one-element array (Copy Row as JSON)', () => {
    expect(rowsAs(src(p), [1], 'json', T, O)).toBe('{\n  "id": 2,\n  "note": null,\n  "total": -3.50,\n  "meta": null,\n  "ok": false,\n  "email": "b@x.test"\n}');
    expect(rowsAs(src(p), [], 'json', T, O)).toBe('[]');
  });

  test('JSON: integers past 2^53, long decimals and exponents never go through a float, in columns and inside jsonb', () => {
    const F8 = col('ratio', 'float8', 'N');
    const q = page([ID, TOTAL, F8, META], [['9007199254740993', '0.1000000000000000000001', '1e+300', '{"n": 12345678901234567890, "a": [[1.0, 2E-7], []]}']]);
    const out = rowsAs(src(q), [0], 'json', T, O);
    expect(out).toContain('"id": 9007199254740993,');
    expect(out).toContain('"total": 0.1000000000000000000001,');
    expect(out).toContain('"ratio": 1e+300,');
    expect(out).toContain('"meta": {"n": 12345678901234567890, "a": [[1.0, 2E-7], []]}');
    expect(() => JSON.parse(out)).not.toThrow();
  });

  test('JSON: what isn\'t a JSON number is a string (NaN, Infinity, money); a value cut at 64 KB is its text', () => {
    const MONEY = col('price', 'money', 'N');
    const q = page([TOTAL, col('f', 'float8', 'N'), col('g', 'float8', 'N'), MONEY, META], [['NaN', 'Infinity', '-Infinity', '$1,240.00', null]]);
    q.rows[0]![4] = c('{"a": [1, 2', 70_000);
    const out = rowsAs(src(q), [0], 'json', T, O);
    expect(out).toContain('"total": "NaN",');
    expect(out).toContain('"f": "Infinity",');
    expect(out).toContain('"g": "-Infinity",');
    expect(out).toContain('"price": "$1,240.00",');
    expect(out).toContain('"meta": "{\\"a\\": [1, 2"');
    expect(() => JSON.parse(out)).not.toThrow();
  });

  test('JSON columns of a path carry their path as the name; an object or array there as JSON, other text as a string', () => {
    const q = page([ID], [['1'], ['2'], ['3']], { derived: [{ column: 'meta', path: ['limits'] }] });
    q.rows[0]!.push(c('{"seats": 12345678901234567890}'));
    q.rows[1]!.push(c('[abc'));
    q.rows[2]!.push(c('12'));
    const out = rowsAs(src(q), [0, 1, 2], 'json', T, O);
    expect(out).toContain('"meta.limits": {"seats": 12345678901234567890}');
    expect(out).toContain('"meta.limits": "[abc"');
    expect(out).toContain('"meta.limits": "12"');
    expect(() => JSON.parse(out)).not.toThrow();
  });

  test('CSV (RFC 4180): a header, quotes around commas, quotes doubled, CRLF line ends, NULL empty', () => {
    const multi = page([ID, NOTE], [['1', 'two\nlines'], ['2', 'plain']]);
    expect(rowsAs(src(multi), [0, 1], 'csv', T, O)).toBe('id,note\r\n1,"two\nlines"\r\n2,plain\r\n');
    expect(rowsAs(src(p), [0, 1], 'csv', T, O).split('\r\n')[1]).toBe(`1,"it's ""fine"", | ok",${BIG},"{""plan"": ""pro"", ""seats"": 12}",true,a@x.test`);
    expect(rowsAs(src(p), [1], 'csv', T, O).split('\r\n')[1]).toBe('2,,-3.50,,false,b@x.test');
  });

  test('Markdown: a table, pipes escaped (a backslash before one too), newlines as <br>, numbers right-aligned', () => {
    const multi = page([ID, NOTE], [['1', 'a | b\nc']]);
    expect(rowsAs(src(multi), [0], 'markdown', T, O)).toBe('| id | note |\n| ---: | --- |\n| 1 | a \\| b<br>c |\n');
    expect(rowsAs(src(p), [1], 'markdown', T, O)).toContain('| 2 | NULL | -3.50 | NULL | false | b@x.test |');
    // a\|b: the backslash escaped, then the pipe — the cell stays one cell.
    expect(rowsAs(src(page([NOTE], [['a\\|b']])), [0], 'markdown', T, O)).toBe('| note |\n| --- |\n| a\\\\\\|b |\n');
  });

  test('SQL INSERT: the table quoted, a statement per row, strings with quotes doubled, numbers kept exact, NULL, JSON as a literal', () => {
    expect(rowsAs(src(p), [0, 1], 'insert', T, O)).toBe([
      `INSERT INTO "public"."orders" ("id", "note", "total", "meta", "ok", "email") VALUES (1, 'it''s "fine", | ok', ${BIG}, '{"plan": "pro", "seats": 12}', true, 'a@x.test');`,
      'INSERT INTO "public"."orders" ("id", "note", "total", "meta", "ok", "email") VALUES (2, NULL, -3.50, NULL, false, \'b@x.test\');'
    ].join('\n'));
    const odd = { schema: 'my schema', name: 'we"ird' };
    expect(rowsAs(src(page([NOTE], [['x']])), [0], 'insert', odd, O)).toBe('INSERT INTO "my schema"."we""ird" ("note") VALUES (\'x\');');
  });

  test('SQL INSERT: what isn\'t a plain number is quoted (money, NaN); JSON columns of a path aren\'t the table\'s', () => {
    const money = col('price', 'money', 'N');
    const q = page([money, TOTAL], [['$1,240.00', 'NaN']], { derived: [{ column: 'meta', path: ['plan'] }] });
    q.rows[0]!.push(c('pro'));
    expect(rowsAs(src(q), [0], 'insert', T, O)).toBe('INSERT INTO "public"."orders" ("price", "total") VALUES (\'$1,240.00\', \'NaN\');');
  });

  test('SQL INSERT carries the row\'s key columns even when they aren\'t shown; the other formats show what is shown', () => {
    const q = page([EMAIL, ID], [['a@x.test', '7']], { hidden: ['id'] });
    expect(rowsAs(src(q), [0], 'insert', T, O)).toBe('INSERT INTO "public"."orders" ("email", "id") VALUES (\'a@x.test\', 7);');
    expect(rowsAs(src(q), [0], 'csv', T, O)).toBe('email\r\na@x.test\r\n');
    expect(rowsAs(src(q), [0], 'json', T, O)).toBe('{\n  "email": "a@x.test"\n}');
  });

  test('Mask values on: every format carries the mask', () => {
    const secret = page([ID, EMAIL, col('api_token', 'jsonb', 'U')], [['1', 'a@x.test', '{"k":"s3cr3t"}']]);
    for (const fmt of ['json', 'csv', 'markdown', 'insert'] as const) {
      const out = rowsAs(src(secret), [0], fmt, T, MASKED);
      expect(out, fmt).not.toContain('a@x.test');
      expect(out, fmt).not.toContain('s3cr3t');
      expect(out, fmt).toContain('••••••••');
    }
    expect(JSON.parse(rowsAs(src(secret), [0], 'json', T, MASKED))).toEqual({ id: 1, email: '••••••••', api_token: '••••••••' });
  });

  test('Mask values on, a secret key inside a JSON value is masked in every copy — the rest exactly as printed', () => {
    const meta = page([ID, col('metadata', 'jsonb', 'U')], [['1', '{"email": "a@x.test", "n": 12345678901234567890}']]);
    for (const fmt of ['json', 'csv', 'markdown', 'insert'] as const) {
      const out = rowsAs(src(meta), [0], fmt, T, MASKED);
      expect(out, fmt).not.toContain('a@x.test');
      expect(out, fmt).toContain('12345678901234567890');
    }
    expect(copyText(src(meta), [0], { row: 0, col: 1 }, MASKED)).toBe('{"email": "••••••••", "n": 12345678901234567890}');
    expect(copyText(src(meta), [0], { row: 0, col: 1 }, O)).toBe('{"email": "a@x.test", "n": 12345678901234567890}');
  });

  test('a JSON column\'s object cut at 64 KB is dots in every copy with the mask on (no key to mask it by)', () => {
    const p = page([ID], [['1']], { derived: [{ column: 'meta', path: ['limits'] }] });
    p.rows[0]!.push(c('{"api_key": "s3cr3t", "seats": [1, 2', 70_000));
    for (const fmt of ['json', 'csv', 'markdown'] as const) expect(rowsAs(src(p), [0], fmt, T, MASKED), fmt).not.toContain('s3cr3t');
    expect(copyText(src(p), [0], { row: 0, col: 1 }, MASKED)).toBe('••••••••');
    expect(copyText(src(p), [0], { row: 0, col: 1 }, O)).toContain('s3cr3t');
  });

  test('values the copy wrote as dots aren\'t counted as cut in it', () => {
    const p = page([ID, col('metadata', 'jsonb', 'U')], [['1', null]], { derived: [{ column: 'metadata', path: ['limits'] }] });
    p.rows[0]![1] = c('{"a": "x', 80_000);
    p.rows[0]!.push(c('{"b": [1', 70_000));
    expect(cutCount(src(p), [0], 'json', O)).toBe(2);
    expect(cutCount(src(p), [0], 'json', MASKED)).toBe(0);
    expect(cutCount(src(p), [0], 'tsv', MASKED)).toBe(0);
  });

  test('Copy Value of a cut JSON value, read whole first, carries the mask too', async () => {
    const meta = page([ID, col('metadata', 'jsonb', 'U')], [['7', null]]);
    meta.rows[0]![1] = c('{"email": "a@x', 90_000);
    const full = async (): Promise<DbResult<string>> => ({ ok: true, value: '{"email": "a@x.test", "n": 1}' });
    expect(await valueCopy(src(meta), meta, T, { row: 0, col: 1 }, MASKED, full)).toEqual({ ok: true, text: '{"email": "••••••••", "n": 1}' });
  });

  test('rows in the grid\'s order, whatever order they were selected in', () => {
    expect(rowsAs(src(p), [1, 0], 'csv', T, O).split('\r\n').map((l) => l.split(',')[0])).toEqual(['id', '1', '2', '']);
  });
});

describe('values cut at 64 KB', () => {
  const cutPage = () => {
    const q = page([ID, NOTE, EMAIL], [['7', null, 'a@x.test'], ['8', null, 'b@x.test']]);
    q.rows[0]![1] = c('x'.repeat(10), 70_000);
    q.rows[1]![1] = c('y'.repeat(10), 90_000);
    q.rows[1]![2] = c('b@x.test', 80_000);
    return q;
  };

  test('cutCount: the cut values a copy of these rows carries (masked ones carry dots, not a cut value)', () => {
    const q = cutPage();
    expect(cutCount(src(q), [0, 1], 'csv', O)).toBe(3);
    expect(cutCount(src(q), [0], 'json', O)).toBe(1);
    expect(cutCount(src(q), [0, 1], 'csv', MASKED)).toBe(2);
    expect(cutCount(src(q), [], 'csv', O)).toBe(0);
  });

  test('fullRequest: the column of the row named by its primary key; a JSON column by its path; none without a whole key', () => {
    const q = cutPage();
    const [, note] = gridColumns(q);
    expect(fullRequest(q, T, q.rows[0]!, note!)).toEqual({ ref: { connId: T.connId, schema: 'public', name: 'orders' }, key: { id: '7' }, column: 'note' });
    const d = page([ID], [['7']], { derived: [{ column: 'meta', path: ['a', 0] }] });
    d.rows[0]!.push(c('x', 70_000));
    expect(fullRequest(d, T, d.rows[0]!, gridColumns(d)[1]!)).toEqual({ ref: { connId: T.connId, schema: 'public', name: 'orders' }, key: { id: '7' }, column: 'meta', path: ['a', 0] });
    expect(fullRequest({ ...q, rowKey: [] }, T, q.rows[0]!, note!)).toBeNull();
    expect(fullRequest(q, T, [c(null), ...q.rows[0]!.slice(1)], note!)).toBeNull();
  });

  test('fullRequest by the row\'s key: no primary key, a unique NOT NULL key names the row', () => {
    const CODE = col('code', 'text', 'S');
    const NOTE = col('note', 'text', 'S');
    const q = page([CODE, NOTE], [['USD', null]], { pk: [], rowKey: ['code'] });
    q.rows[0]![1] = c('x', 80_000);
    expect(fullRequest(q, T, q.rows[0]!, gridColumns(q)[1]!)).toEqual({ ref: { connId: T.connId, schema: 'public', name: 'orders' }, key: { code: 'USD' }, column: 'note' });
  });

  test('Copy Value on a cut value reads it whole first, then copies it', async () => {
    const q = cutPage();
    const asked: DbFullRequest[] = [];
    const full = async (r: DbFullRequest): Promise<DbResult<string>> => { asked.push(r); return { ok: true, value: 'the whole note' }; };
    expect(await valueCopy(src(q), q, T, { row: 0, col: 1 }, O, full)).toEqual({ ok: true, text: 'the whole note' });
    expect(asked).toEqual([{ ref: { connId: T.connId, schema: 'public', name: 'orders' }, key: { id: '7' }, column: 'note' }]);
  });

  test('a value not cut, or masked: the loaded one (or the dots), nothing read', async () => {
    const q = cutPage();
    let asked = 0;
    const full = async (): Promise<DbResult<string>> => { asked++; return { ok: true, value: 'no' }; };
    expect(await valueCopy(src(q), q, T, { row: 0, col: 2 }, O, full)).toEqual({ ok: true, text: 'a@x.test' });
    expect(await valueCopy(src(q), q, T, { row: 1, col: 2 }, MASKED, full)).toEqual({ ok: true, text: '••••••••' });
    expect(asked).toBe(0);
  });

  test('a refusal says why; a row with no key to read it by says so', async () => {
    const q = cutPage();
    const refuse = async (): Promise<DbResult<string>> => ({ ok: false, problem: { kind: 'other', message: 'This value is over 16 MB' } });
    expect(await valueCopy(src(q), q, T, { row: 0, col: 1 }, O, refuse)).toEqual({ ok: false, message: 'This value is over 16 MB' });
    expect(await valueCopy(src(q), { ...q, rowKey: [] }, T, { row: 0, col: 1 }, O, refuse)).toEqual({ ok: false, message: 'No key to read the whole value' });
  });
});
