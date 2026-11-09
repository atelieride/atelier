import { describe, expect, it } from 'vitest';
import {
  arity, filterChip, INTEGER_TYPES, NUMBER_RE, opLabel, opsFor, typeClass, validFilter, validFilterShape, type DbColumn, type DbFilter, type DbPath
} from './databases-filters';

describe('NUMBER_RE and INTEGER_TYPES: shared with the filter popover (its inline problems say what validFilter decides)', () => {
  it('a number as Postgres reads one; the integer types by typname and by the names they are written with', () => {
    for (const s of ['1', '-2', '+3.5', '.5', '1e3', '1.2E-4', '12345678901234567890.000000000001']) expect(NUMBER_RE.test(s), s).toBe(true);
    for (const s of ['', '1.2.3', '12abc', 'NaN', '1e', '--1', ' 1']) expect(NUMBER_RE.test(s), s).toBe(false);
    for (const t of ['int2', 'int4', 'int8', 'bigint', 'serial']) expect(INTEGER_TYPES.has(t), t).toBe(true);
    for (const t of ['numeric', 'float8', 'money']) expect(INTEGER_TYPES.has(t), t).toBe(false);
  });
});

const col = (over: Partial<DbColumn>): DbColumn => ({
  name: 'c', type: 'text', typeSchema: 'pg_catalog', typeName: 'text', typeCat: 'S', isArray: false, nullable: true, isPk: false, isKey: false, ...over
});
const dec = col({ type: 'numeric(10,2)', typeName: 'numeric', typeCat: 'N' });
const text = col({});
const num = col({ type: 'integer', typeName: 'int4', typeCat: 'N' });
const bool = col({ type: 'boolean', typeName: 'bool', typeCat: 'B' });
const en = col({ type: 'status', typeName: 'status', typeCat: 'E', enumValues: ['paid', 'shipped', 'failed'] });
const time = col({ type: 'timestamptz', typeName: 'timestamptz', typeCat: 'D' });
const arr = col({ type: 'text[]', typeName: 'text', typeCat: 'A', isArray: true });
const json = col({ type: 'jsonb', typeName: 'jsonb', typeCat: 'U' });
const other = col({ type: 'point', typeName: 'point', typeCat: 'G' });

describe('typeClass', () => {
  it('classifies by category and name', () => {
    expect(typeClass(num)).toBe('number');
    expect(typeClass(col({ typeName: 'money', typeCat: 'N' }))).toBe('number');
    expect(typeClass(bool)).toBe('bool');
    expect(typeClass(en)).toBe('enum');
    expect(typeClass(col({ typeName: 'x', typeCat: 'X', enumValues: ['a'] }))).toBe('enum');
    for (const n of ['date', 'timestamp', 'timestamptz']) expect(typeClass(col({ typeName: n, typeCat: 'D' }))).toBe('time');
    expect(typeClass(arr)).toBe('array');
    expect(typeClass(col({ typeName: 'int4', typeCat: 'N', isArray: true }))).toBe('array');
    expect(typeClass(json)).toBe('json');
    expect(typeClass(col({ typeName: 'json', typeCat: 'U' }))).toBe('json');
    for (const n of ['uuid', 'inet', 'cidr', 'macaddr', 'citext', 'name']) expect(typeClass(col({ typeName: n, typeCat: 'U' }))).toBe('text');
    expect(typeClass(text)).toBe('text');
    expect(typeClass(other)).toBe('other');
  });
});

describe('opsFor', () => {
  it('follows the spec table, null operators first', () => {
    expect(opsFor(text)).toEqual(['null', 'notnull', 'eq', 'ne', 'contains', 'starts', 'ends', 'in']);
    expect(opsFor(num)).toEqual(['null', 'notnull', 'eq', 'ne', 'lt', 'le', 'gt', 'ge', 'between']);
    expect(opsFor(bool)).toEqual(['null', 'notnull', 'true', 'false']);
    expect(opsFor(en)).toEqual(['null', 'notnull', 'in', 'notin']);
    expect(opsFor(time)).toEqual(['null', 'notnull', 'before', 'after', 'between', 'lastHours', 'lastDays']);
    expect(opsFor(arr)).toEqual(['null', 'notnull', 'has']);
    expect(opsFor(json)).toEqual(['null', 'notnull', 'pathEq', 'pathContains', 'pathExists', 'pathNull']);
    expect(opsFor(other)).toEqual(['null', 'notnull', 'eq']);
  });
});

describe('arity and labels', () => {
  it('knows how many values an operator takes', () => {
    expect(arity('between')).toBe(2);
    expect(arity('in')).toBe('many');
    expect(arity('notin')).toBe('many');
    expect(arity('null')).toBe(0);
    expect(arity('true')).toBe(0);
    expect(arity('pathExists')).toBe(0);
    // A JSON null at the path (#>> can't tell it from a missing key: both read SQL NULL).
    expect(arity('pathNull')).toBe(0);
    // Said as its siblings in the popover's list: at path equals · contains · exists · is JSON null.
    expect(opLabel('pathNull')).toBe('at path is JSON null');
    expect((['pathEq', 'pathContains', 'pathExists', 'pathNull'] as const).map(opLabel).every((l) => l.startsWith('at path '))).toBe(true);
    expect(filterChip({ column: 'payload', path: ['request', 'id'], op: 'pathNull', values: [] })).toEqual({ col: 'payload → request.id', op: 'at path is JSON null', val: '' });
    expect(arity('eq')).toBe(1);
    expect(arity('lastDays')).toBe(1);
  });
  it('labels', () => {
    expect(opLabel('eq')).toBe('equals');
    expect(opLabel('le')).toBe('≤');
    expect(opLabel('lastHours')).toBe('in the last N hours');
    expect(opLabel('pathEq')).toBe('at path equals');
  });
});

const f = (over: Partial<DbFilter>): DbFilter => ({ column: 'c', op: 'eq', values: ['x'], ...over });

describe('validFilter', () => {
  it('accepts well-formed filters', () => {
    expect(validFilter(text, f({ op: 'contains', values: ['a'] }))).toBe(true);
    expect(validFilter(dec, f({ op: 'between', values: ['1', '2.5'] }))).toBe(true);
    expect(validFilter(num, f({ op: 'between', values: ['1', '25'] }))).toBe(true);
    expect(validFilter(text, f({ op: 'null', values: [] }))).toBe(true);
    expect(validFilter(time, f({ op: 'lastDays', values: ['7'] }))).toBe(true);
    expect(validFilter(en, f({ op: 'in', values: ['paid', 'failed'] }))).toBe(true);
    expect(validFilter(json, f({ op: 'pathEq', path: ['data', 'status'], values: ['paid'] }))).toBe(true);
    expect(validFilter(json, f({ op: 'pathExists', path: ['a', 0], values: [] }))).toBe(true);
    expect(validFilter(json, f({ op: 'pathNull', path: ['request', 'id'], values: [] }))).toBe(true);
    // A path it needs; no value it takes; a JSON column only.
    expect(validFilter(json, f({ op: 'pathNull', values: [] }))).toBe(false);
    expect(validFilter(json, f({ op: 'pathNull', path: ['a'], values: ['x'] }))).toBe(false);
    expect(validFilter(text, f({ op: 'pathNull', path: ['a'], values: [] }))).toBe(false);
  });
  it('rejects operators the type does not allow', () => {
    expect(validFilter(bool, f({ op: 'eq', values: ['true'] }))).toBe(false);
    expect(validFilter(text, f({ op: 'lt', values: ['1'] }))).toBe(false);
  });
  it('rejects wrong value counts', () => {
    expect(validFilter(num, f({ op: 'between', values: ['1'] }))).toBe(false);
    expect(validFilter(text, f({ op: 'null', values: ['x'] }))).toBe(false);
    expect(validFilter(text, f({ op: 'in', values: [] }))).toBe(false);
  });
  it('checks number and interval values', () => {
    expect(validFilter(num, f({ op: 'gt', values: ['abc'] }))).toBe(false);
    expect(validFilter(num, f({ op: 'gt', values: [''] }))).toBe(false);
    expect(validFilter(time, f({ op: 'lastDays', values: ['0'] }))).toBe(false);
    expect(validFilter(time, f({ op: 'lastDays', values: ['x'] }))).toBe(false);
    expect(validFilter(time, f({ op: 'lastDays', values: ['1.5'] }))).toBe(false);
    expect(validFilter(time, f({ op: 'lastHours', values: ['100001'] }))).toBe(false);
    expect(validFilter(time, f({ op: 'lastHours', values: ['100000'] }))).toBe(true);
  });
  it('takes only whole numbers for integer columns (a fraction would fail on the server)', () => {
    for (const typeName of ['int2', 'int4', 'int8', 'smallint', 'integer', 'bigint', 'serial', 'bigserial', 'smallserial', 'serial4']) {
      const int = col({ type: typeName, typeName, typeCat: 'N' });
      expect(validFilter(int, f({ op: 'eq', values: ['42'] }))).toBe(true);
      expect(validFilter(int, f({ op: 'ge', values: [' -7 '] }))).toBe(true);
      for (const v of ['1.5', '2e3', '.5', '1.', '1e0']) expect(validFilter(int, f({ op: 'lt', values: [v] }))).toBe(false);
      expect(validFilter(int, f({ op: 'between', values: ['1', '2.5'] }))).toBe(false);
      expect(validFilter(int, f({ op: 'ne', values: ['0.0'] }))).toBe(false);
    }
    expect(validFilter(dec, f({ op: 'lt', values: ['1.5'] }))).toBe(true);
    expect(validFilter(col({ typeName: 'float8', typeCat: 'N' }), f({ op: 'lt', values: ['2e3'] }))).toBe(true);
    const ints = col({ type: 'integer[]', typeName: 'int4', typeCat: 'N', isArray: true });
    expect(validFilter(ints, f({ op: 'has', values: ['5'] }))).toBe(true);
    expect(validFilter(ints, f({ op: 'has', values: ['5.5'] }))).toBe(false);
    expect(validFilter(arr, f({ op: 'has', values: ['5.5'] }))).toBe(true);
  });
  it('caps value counts and sizes', () => {
    const many = (n: number) => Array.from({ length: n }, (_, i) => `v${i}`);
    expect(validFilter(text, f({ op: 'in', values: many(100) }))).toBe(true);
    expect(validFilter(text, f({ op: 'in', values: many(101) }))).toBe(false);
    expect(validFilter(text, f({ values: ['a'.repeat(10000)] }))).toBe(true);
    expect(validFilter(text, f({ values: ['a'.repeat(10001)] }))).toBe(false);
  });
  it('requires a path for JSON operators only', () => {
    expect(validFilter(json, f({ op: 'pathEq', values: ['a'] }))).toBe(false);
    expect(validFilter(text, f({ op: 'eq', path: ['a'], values: ['a'] }))).toBe(false);
  });
  it('rejects enum values the type does not have', () => {
    expect(validFilter(en, f({ op: 'in', values: ['nope'] }))).toBe(false);
  });
  it('takes a filter for this column only', () => {
    expect(validFilter(text, f({ column: 'other' }))).toBe(false);
    expect(validFilter(en, f({ column: 'status', op: 'in', values: ['paid'] }))).toBe(false);
    expect(validFilter(text, f({ column: 'c' }))).toBe(true);
  });
  it("an enum whose labels weren't read takes any non-empty value (the server's cast checks it); an empty one never", () => {
    const bare = col({ type: 'mood', typeName: 'mood', typeCat: 'E' });
    expect(validFilter(bare, f({ op: 'in', values: ['happy', 'anything at all'] }))).toBe(true);
    expect(validFilter(bare, f({ op: 'notin', values: ['x', ''] }))).toBe(false);
    expect(validFilter(bare, f({ op: 'in', values: [''] }))).toBe(false);
  });
  it('an oid is a whole number too', () => {
    const oid = col({ type: 'oid', typeName: 'oid', typeCat: 'N' });
    expect(validFilter(oid, f({ op: 'eq', values: ['16384'] }))).toBe(true);
    for (const v of ['1.5', '2e3']) expect(validFilter(oid, f({ op: 'eq', values: [v] })), v).toBe(false);
  });
  it('values that are not an array are refused, never thrown on', () => {
    for (const values of [undefined, null, 'x', 5, { length: 1, 0: 'x' }]) {
      const bad = { column: 'c', op: 'eq', values } as unknown as DbFilter;
      expect(() => validFilter(text, bad), JSON.stringify(values)).not.toThrow();
      expect(validFilter(text, bad), JSON.stringify(values)).toBe(false);
      expect(validFilterShape(bad), JSON.stringify(values)).toBe(false);
    }
  });
  it('a path: at most 16 elements, keys of at most 256 characters without NUL, indexes whole from 0 to 2^31 − 1', () => {
    const ok = (path: unknown) => validFilter(json, f({ op: 'pathEq', path: path as DbPath, values: ['x'] }));
    expect(ok(Array.from({ length: 16 }, (_, i) => `k${i}`))).toBe(true);
    expect(ok(Array.from({ length: 17 }, (_, i) => `k${i}`))).toBe(false);
    expect(ok(['a'.repeat(256), ''])).toBe(true);
    expect(ok(['a'.repeat(257)])).toBe(false);
    expect(ok(['a\0b'])).toBe(false);
    expect(ok(['a', 0, 2_147_483_647])).toBe(true);
    for (const n of [-1, 1.5, NaN, Infinity, 2_147_483_648]) expect(ok(['a', n]), String(n)).toBe(false);
    for (const p of [[true], [null], [{}], 'a.b', { 0: 'a', length: 1 }]) expect(ok(p), JSON.stringify(p)).toBe(false);
    // The same checks in the shape main's IPC asks for before any catalog is at hand.
    expect(validFilterShape(f({ op: 'pathEq', path: ['a\0'], values: ['x'] }))).toBe(false);
    expect(validFilterShape(f({ op: 'pathEq', path: ['a', NaN], values: ['x'] }))).toBe(false);
    expect(validFilterShape(f({ op: 'eq', path: 'ab' as unknown as DbPath }))).toBe(false);
  });
});

describe('filterChip', () => {
  it('shows a path and a value', () => {
    expect(filterChip({ column: 'payload', path: ['data', 'status'], op: 'pathEq', values: ['paid'] }))
      .toEqual({ col: 'payload → data.status', op: 'at path equals', val: 'paid' });
    expect(filterChip({ column: 's', op: 'in', values: ['paid', 'shipped', 'failed'] }))
      .toEqual({ col: 's', op: 'is any of', val: 'paid, shipped, failed' });
    expect(filterChip({ column: 'n', op: 'between', values: ['1', '5'] }).val).toBe('1 – 5');
    expect(filterChip({ column: 'n', op: 'null', values: [] })).toEqual({ col: 'n', op: 'is null', val: '' });
  });
  it('writes a path as pathText does: a dotted key stays one key, an index reads [n]', () => {
    expect(filterChip({ column: 'payload', path: ['a.b', 0, 'c'], op: 'pathEq', values: ['x'] }).col).toBe('payload → ["a.b"][0].c');
  });
});
