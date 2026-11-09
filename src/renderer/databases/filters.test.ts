import { describe, expect, test } from 'vitest';
import type { DbCell, DbPage } from '@shared/databases';
import { validFilter, validFilterShape, type DbColumn, type DbFilter, type DbFilterOp } from '@shared/databases-filters';
import { pathText } from '@shared/pg-json';
import {
  addFilter, barColumns, cellFilter, chipParts, chosenColumns, columnsLabel, commitPending, draftFilter, draftFor, draftOf, enumItems, enumToggle,
  filterTargets, MAX_FILTERS, opChoices, parsePath, pathProblem, removeFilter, replaceFilter, shownColumns, timeProblem, valueEditor, wantsCatalogColumns,
  withOp
} from './filters';
// Its own text, for the one guard below (Vite's raw import).
import filtersSource from './filters.ts?raw';

// Filters and columns: the pure helpers the filter bar, its popover,
// the Columns chip and the cell menu share. The layout math: filter-layout.test.ts; the actions: filter-actions.test.ts.

const col = (name: string, typeName: string, typeCat: string, o: Partial<DbColumn> = {}): DbColumn => ({
  name, type: typeName, typeSchema: 'pg_catalog', typeName, typeCat, isArray: false, nullable: true, isPk: false, isKey: false, ...o
});
const ID = col('id', 'int8', 'N', { isPk: true, isKey: true, nullable: false });
const EMAIL = col('email', 'text', 'S');
const TOTAL = col('total', 'numeric', 'N', { type: 'numeric(10,2)' });
const PAID = col('paid', 'bool', 'B');
const LIVE = col('live', 'bool', 'B', { nullable: false });
const STATUS = col('status', 'order_status', 'E', { typeSchema: 'public', enumValues: ['pending', 'paid', 'shipped', 'cancelled'] });
const AT = col('created_at', 'timestamptz', 'D', { type: 'timestamp with time zone' });
const PAYLOAD = col('payload', 'jsonb', 'U');
const TAGS = col('tags', 'text', 'A', { isArray: true, type: 'text[]' });
const SCORES = col('scores', 'int4', 'A', { isArray: true, type: 'integer[]' });
const SPAN = col('span', 'interval', 'T');
const g = (c: DbColumn) => ({ col: c, derived: null });
const cell = (v: string | null, cut?: number): DbCell => (cut === undefined ? { v } : { v, cut });
const f = (column: string, op: DbFilterOp, values: string[] = [], path?: (string | number)[]): DbFilter => (path ? { column, path, op, values } : { column, op, values });

describe('addFilter, replaceFilter, removeFilter: a new list each time, the tab\'s frozen one untouched', () => {
  const A = f('email', 'contains', ['acme']);
  const B = f('status', 'in', ['paid', 'shipped']);
  const list = Object.freeze([A, B]) as readonly DbFilter[];

  test('add appends a copy: changing what was given changes nothing in the list', () => {
    const given = f('total', 'gt', ['100']);
    const next = addFilter(list, given);
    expect(next).toEqual([A, B, f('total', 'gt', ['100'])]);
    given.values.push('x');
    expect(next[2]!.values).toEqual(['100']);
    expect(list).toHaveLength(2);
  });

  test('the same filter twice is one filter (an `in` in another order is the same): the list comes back as it was', () => {
    expect(addFilter(list, f('email', 'contains', ['acme']))).toBe(list);
    expect(addFilter(list, f('status', 'in', ['shipped', 'paid']))).toBe(list);
    expect(addFilter(list, f('email', 'contains', ['acme2']))).toHaveLength(3);
    expect(addFilter(list, f('payload', 'pathEq', ['x'], ['a']))).toHaveLength(3);
    const withPath = addFilter(list, f('payload', 'pathEq', ['x'], ['a']));
    expect(addFilter(withPath, f('payload', 'pathEq', ['x'], ['b']))).toHaveLength(4);
  });

  test(`main takes ${30} filters at most: the ${30}th is the last one added`, () => {
    expect(MAX_FILTERS).toBe(30);
    let l: readonly DbFilter[] = [];
    for (let i = 0; i < 35; i++) l = addFilter(l, f('id', 'ne', [String(i)]));
    expect(l).toHaveLength(30);
  });

  test('replace puts the edit in its place; an edit that equals another filter drops the other; out of range: as it was', () => {
    expect(replaceFilter(list, 0, f('email', 'eq', ['a@acme.test']))).toEqual([f('email', 'eq', ['a@acme.test']), B]);
    expect(replaceFilter(list, 1, f('email', 'contains', ['acme']))).toEqual([A]);
    expect(replaceFilter(list, 5, A)).toBe(list);
    expect(replaceFilter(list, 0, f('email', 'contains', ['acme']))).toBe(list);
  });

  test('remove takes one out; out of range: as it was', () => {
    expect(removeFilter(list, 0)).toEqual([B]);
    expect(removeFilter(list, 2)).toBe(list);
    expect(removeFilter(list, -1)).toBe(list);
  });
});

describe('valueEditor: the value editor each type and operator takes', () => {
  const cases: [DbColumn, DbFilterOp, string][] = [
    [EMAIL, 'eq', 'text'], [EMAIL, 'contains', 'text'], [EMAIL, 'starts', 'text'], [EMAIL, 'in', 'checklist'],
    [EMAIL, 'null', 'none'], [EMAIL, 'notnull', 'none'],
    [TOTAL, 'eq', 'number'], [TOTAL, 'gt', 'number'], [ID, 'le', 'number'], [TOTAL, 'between', 'two'],
    [PAID, 'true', 'bool'], [PAID, 'false', 'bool'], [PAID, 'null', 'none'],
    [STATUS, 'in', 'checklist'], [STATUS, 'notin', 'checklist'],
    [AT, 'before', 'text'], [AT, 'after', 'text'], [AT, 'between', 'two'], [AT, 'lastDays', 'days'], [AT, 'lastHours', 'hours'],
    [PAYLOAD, 'pathEq', 'path'], [PAYLOAD, 'pathContains', 'path'], [PAYLOAD, 'pathExists', 'path'], [PAYLOAD, 'pathNull', 'path'], [PAYLOAD, 'notnull', 'none'],
    [TAGS, 'has', 'text'], [SCORES, 'has', 'number'],
    [SPAN, 'eq', 'text']
  ];
  test.each(cases)('%# %o %s → %s', (c, op, want) => expect(valueEditor(c, op)).toBe(want));

  test('every operator of every type has an editor', () => {
    for (const c of [ID, EMAIL, TOTAL, PAID, STATUS, AT, PAYLOAD, TAGS, SCORES, SPAN]) {
      for (const op of opChoices(c).map((o) => o.op)) expect(valueEditor(c, op), `${c.name} ${op}`).toMatch(/^(none|text|number|two|checklist|bool|days|hours|path)$/);
    }
  });

  test('a boolean asks "is" with a true · false switch: is true and is false are one choice', () => {
    expect(opChoices(PAID)).toEqual([{ op: 'true', label: 'is' }, { op: 'null', label: 'is null' }, { op: 'notnull', label: 'is not null' }]);
    expect(opChoices(TOTAL).map((o) => o.op)).toEqual(['eq', 'ne', 'lt', 'le', 'gt', 'ge', 'between', 'null', 'notnull']);
    expect(opChoices(AT).map((o) => o.label)).toEqual(['before', 'after', 'between', 'in the last N hours', 'in the last N days', 'is null', 'is not null']);
  });
});

describe('Filter by This Value · Exclude This Value (the cell menu)', () => {
  test('text and numbers: equals / not equals, the value exactly as Postgres printed it (a number never goes through JS)', () => {
    expect(cellFilter(g(EMAIL), cell('a@acme.test'), 'by')).toEqual(f('email', 'eq', ['a@acme.test']));
    expect(cellFilter(g(EMAIL), cell('a@acme.test'), 'exclude')).toEqual(f('email', 'ne', ['a@acme.test']));
    const big = '12345678901234567890.000000000001';
    expect(cellFilter(g(TOTAL), cell(big), 'by')).toEqual(f('total', 'eq', [big]));
    expect(cellFilter(g(ID), cell('9007199254740993'), 'exclude')).toEqual(f('id', 'ne', ['9007199254740993']));
  });

  test('NULL: is null / is not null, whatever the type (JSON and arrays too)', () => {
    for (const c of [EMAIL, TOTAL, PAID, STATUS, AT, PAYLOAD, TAGS, SPAN]) {
      expect(cellFilter(g(c), cell(null), 'by')).toEqual(f(c.name, 'null'));
      expect(cellFilter(g(c), cell(null), 'exclude')).toEqual(f(c.name, 'notnull'));
    }
  });

  test('an enum: is any of / is none of that value', () => {
    expect(cellFilter(g(STATUS), cell('paid'), 'by')).toEqual(f('status', 'in', ['paid']));
    expect(cellFilter(g(STATUS), cell('paid'), 'exclude')).toEqual(f('status', 'notin', ['paid']));
  });

  test('a boolean: is true / is false; Exclude only when the column holds no NULL (else is false would drop them too)', () => {
    expect(cellFilter(g(PAID), cell('t'), 'by')).toEqual(f('paid', 'true'));
    expect(cellFilter(g(PAID), cell('f'), 'by')).toEqual(f('paid', 'false'));
    expect(cellFilter(g(PAID), cell('t'), 'exclude')).toBeNull();
    expect(cellFilter(g(LIVE), cell('t'), 'exclude')).toEqual(f('live', 'false'));
  });

  test('a time: between the value and itself (no equals for times); nothing to exclude it with', () => {
    expect(cellFilter(g(AT), cell('2026-11-04 18:28:47.123+01'), 'by')).toEqual(f('created_at', 'between', ['2026-11-04 18:28:47.123+01', '2026-11-04 18:28:47.123+01']));
    expect(cellFilter(g(AT), cell('2026-11-04 18:28:47.123+01'), 'exclude')).toBeNull();
  });

  test('a JSON column (a key added as a column): at path equals, with its path; nothing to exclude, nothing for NULL', () => {
    const d = { col: col('payload.data.status', 'text', 'S'), derived: { column: 'payload', path: ['data', 'status'] } };
    expect(cellFilter(d, cell('paid'), 'by')).toEqual(f('payload', 'pathEq', ['paid'], ['data', 'status']));
    expect(cellFilter(d, cell('paid'), 'exclude')).toBeNull();
    expect(cellFilter(d, cell(null), 'by')).toBeNull();
  });

  test('whole JSON values and arrays: none (their operators take a path or an element); interval: equals as text, no exclude', () => {
    expect(cellFilter(g(PAYLOAD), cell('{"a": 1}'), 'by')).toBeNull();
    expect(cellFilter(g(TAGS), cell('{vip,new}'), 'by')).toBeNull();
    expect(cellFilter(g(SPAN), cell('3 days'), 'by')).toEqual(f('span', 'eq', ['3 days']));
    expect(cellFilter(g(SPAN), cell('3 days'), 'exclude')).toBeNull();
  });

  test('only part of the value is here (cut at 64 KB), or more than main takes (10,000 characters): none', () => {
    expect(cellFilter(g(EMAIL), cell('x'.repeat(100), 70_000), 'by')).toBeNull();
    expect(cellFilter(g(EMAIL), cell('x'.repeat(10_001)), 'by')).toBeNull();
    expect(cellFilter(g(EMAIL), cell('x'.repeat(10_000)), 'by')).toEqual(f('email', 'eq', ['x'.repeat(10_000)]));
    expect(cellFilter(g(EMAIL), undefined, 'by')).toBeNull();
  });

  test('a masked cell is offered (the filter holds the real value); its chip shows dots, never the value', () => {
    const fl = cellFilter(g(EMAIL), cell('a@acme.test'), 'by')!;
    expect(fl.values).toEqual(['a@acme.test']);
    const chip = chipParts(fl, true);
    expect(chip.val).toBe('••••••••');
    expect(JSON.stringify(chip)).not.toContain('acme');
  });
});

describe('chips (column · operator · value)', () => {
  test('as the filter bar reads them', () => {
    expect(chipParts(f('created_at', 'lastDays', ['7']), false)).toMatchObject({ col: 'created_at', op: 'in the last', val: '7 days' });
    expect(chipParts(f('created_at', 'lastHours', ['1']), false)).toMatchObject({ col: 'created_at', op: 'in the last', val: '1 hour' });
    expect(chipParts(f('status', 'notin', ['cancelled']), false)).toMatchObject({ col: 'status', op: 'is none of', val: 'cancelled' });
    expect(chipParts(f('status', 'in', ['paid', 'shipped']), false)).toMatchObject({ val: 'paid, shipped' });
    expect(chipParts(f('total', 'between', ['10', '20']), false)).toMatchObject({ op: 'between', val: '10 – 20' });
    expect(chipParts(f('deleted_at', 'null'), false)).toMatchObject({ col: 'deleted_at', op: 'is null', val: '' });
    expect(chipParts(f('paid', 'true'), false)).toMatchObject({ op: 'is true', val: '' });
    expect(chipParts(f('payload', 'pathEq', ['paid'], ['data', 'object', 0, 'status']), false)).toMatchObject({ col: 'payload → data.object[0].status', op: 'at path equals', val: 'paid' });
    expect(chipParts(f('email', 'eq', ['']), false)).toMatchObject({ val: '""' });
  });

  test('the tooltip holds the whole filter', () => {
    expect(chipParts(f('status', 'notin', ['cancelled']), false).tip).toBe('status is none of cancelled');
    expect(chipParts(f('deleted_at', 'null'), false).tip).toBe('deleted_at is null');
  });

  test('Mask values: a masked column\'s values are dots in the chip and its tooltip — by name or by a key on its path', () => {
    for (const fl of [f('email', 'eq', ['a@acme.test']), f('api_key', 'in', ['k1', 'k2']), f('payload', 'pathEq', ['tok_123'], ['card', 'token']), f('phone', 'between', ['1', '2'])]) {
      const chip = chipParts(fl, true);
      expect(chip.val, fl.column).toBe('••••••••');
      for (const v of fl.values) expect(chip.tip).not.toContain(v);
    }
    expect(chipParts(f('email', 'eq', ['a@acme.test']), false).val).toBe('a@acme.test');
    expect(chipParts(f('total', 'eq', ['12']), true).val).toBe('12');
    expect(chipParts(f('email', 'notnull'), true)).toMatchObject({ op: 'is not null', val: '' });
  });
});

describe('JSON paths: typed as pathText writes them, bounded as main bounds them', () => {
  test('keys joined by dots, [n] an array item, ["…"] a key with other characters', () => {
    expect(parsePath('data.object.lines[0].price')).toEqual(['data', 'object', 'lines', 0, 'price']);
    expect(parsePath('  status ')).toEqual(['status']);
    expect(parsePath('[2]')).toEqual([2]);
    expect(parsePath('["a.b"].c')).toEqual(['a.b', 'c']);
    expect(parsePath('items[0][1]')).toEqual(['items', 0, 1]);
    expect(parsePath('user-agent.raw')).toEqual(['user-agent', 'raw']);
  });

  test('what pathText writes reads back the same', () => {
    for (const p of [['data', 'object', 'lines', 0, 'price'], ['a.b', 'c d', 'x"y', 'q\\z'], [0, 'k'], ['ünïcode', 'ok']]) expect(parsePath(pathText(p))).toEqual(p);
  });

  test('not a path: null', () => {
    for (const s of ['', '  ', 'a..b', 'a.', '.a', 'a[', 'a[x]', 'a[-1]', 'a["x"', 'a[0]b', '["x"]y', 'a[1.5]']) expect(parsePath(s), s).toBeNull();
  });

  test('main\'s bounds: 16 keys, 256 characters a key, no NUL, an index up to 2,147,483,647', () => {
    expect(pathProblem(Array.from({ length: 16 }, (_, i) => `k${i}`))).toBeNull();
    expect(pathProblem(Array.from({ length: 17 }, (_, i) => `k${i}`))).toBe('A path holds at most 16 keys');
    expect(pathProblem(['x'.repeat(256)])).toBeNull();
    expect(pathProblem(['x'.repeat(257)])).toBe('A key holds at most 256 characters');
    expect(pathProblem(['a\0b'])).toBe('A key can’t hold a NUL character');
    expect(pathProblem([2_147_483_647])).toBeNull();
    expect(pathProblem([2_147_483_648])).toBe('An index goes up to 2,147,483,647');
  });
});

describe('the popover\'s draft → a filter main takes', () => {
  test('a new filter starts where it is most useful: the last 7 days for a time, is any of for an enum…', () => {
    expect(draftFor(AT)).toEqual({ op: 'lastDays', values: ['7'], path: '' });
    expect(draftFor(STATUS)).toEqual({ op: 'in', values: [], path: '' });
    expect(draftFor(PAID)).toEqual({ op: 'true', values: [], path: '' });
    expect(draftFor(PAYLOAD)).toEqual({ op: 'pathEq', values: [''], path: '' });
    expect(draftFor(EMAIL)).toEqual({ op: 'eq', values: [''], path: '' });
    expect(draftFor(TAGS)).toEqual({ op: 'has', values: [''], path: '' });
    // A JSON column's key: at path equals, its path written out.
    expect(draftFor(PAYLOAD, ['data', 'object', 0, 'status'])).toEqual({ op: 'pathEq', values: [''], path: 'data.object[0].status' });
  });

  test('an existing filter edits as it is', () => {
    expect(draftOf(f('payload', 'pathEq', ['x'], ['a', 0]))).toEqual({ op: 'pathEq', values: ['x'], path: 'a[0]' });
    expect(draftOf(f('total', 'between', ['1', '2']))).toEqual({ op: 'between', values: ['1', '2'], path: '' });
  });

  test('another operator keeps what still fits', () => {
    const d = { op: 'eq' as const, values: ['42'], path: '' };
    expect(withOp(d, TOTAL, 'gt')).toEqual({ op: 'gt', values: ['42'], path: '' });
    expect(withOp(d, TOTAL, 'between')).toEqual({ op: 'between', values: ['42', ''], path: '' });
    expect(withOp(d, TOTAL, 'null')).toEqual({ op: 'null', values: [], path: '' });
    expect(withOp({ op: 'eq', values: ['vip'], path: '' }, EMAIL, 'in')).toEqual({ op: 'in', values: ['vip'], path: '' });
    expect(withOp({ op: 'eq', values: [''], path: '' }, EMAIL, 'in')).toEqual({ op: 'in', values: [], path: '' });
    expect(withOp({ op: 'before', values: ['2026-11-01'], path: '' }, AT, 'lastDays')).toEqual({ op: 'lastDays', values: ['7'], path: '' });
    expect(withOp({ op: 'lastDays', values: ['3'], path: '' }, AT, 'lastHours')).toEqual({ op: 'lastHours', values: ['3'], path: '' });
    expect(withOp({ op: 'pathEq', values: ['x'], path: 'a.b' }, PAYLOAD, 'pathExists')).toEqual({ op: 'pathExists', values: [], path: 'a.b' });
    expect(withOp({ op: 'pathExists', values: [], path: 'a.b' }, PAYLOAD, 'pathContains')).toEqual({ op: 'pathContains', values: [''], path: 'a.b' });
    // Is JSON null keeps the path, takes no value.
    expect(withOp({ op: 'pathEq', values: ['x'], path: 'a.b' }, PAYLOAD, 'pathNull')).toEqual({ op: 'pathNull', values: [], path: 'a.b' });
    expect(draftFilter(PAYLOAD, { op: 'pathNull', values: [], path: 'request.id' })).toEqual({ ok: true, filter: { column: 'payload', path: ['request', 'id'], op: 'pathNull', values: [] } });
  });

  const ok = (c: DbColumn, d: { op: DbFilterOp; values: string[]; path: string }) => {
    const r = draftFilter(c, d);
    if (!r.ok) throw new Error(`refused: ${r.problem}`);
    // Whatever Apply sends passes main's own checks.
    expect(validFilterShape(r.filter)).toBe(true);
    expect(validFilter(c, r.filter)).toBe(true);
    return r.filter;
  };
  const no = (c: DbColumn, d: { op: DbFilterOp; values: string[]; path: string }) => {
    const r = draftFilter(c, d);
    if (r.ok) throw new Error(`taken: ${JSON.stringify(r.filter)}`);
    return r;
  };

  test('numbers stay the strings typed (precision): never a JS number on the way', () => {
    expect(ok(TOTAL, { op: 'eq', values: ['12345678901234567890.000000000001'], path: '' }).values).toEqual(['12345678901234567890.000000000001']);
    expect(ok(ID, { op: 'gt', values: [' 9007199254740993 '], path: '' }).values).toEqual(['9007199254740993']);
    expect(ok(TOTAL, { op: 'between', values: ['1e3', '-.5'], path: '' }).values).toEqual(['1e3', '-.5']);
  });

  test('inline problems, said before main would refuse', () => {
    expect(no(TOTAL, { op: 'eq', values: [''], path: '' })).toMatchObject({ problem: 'Type a value', field: 0 });
    expect(no(TOTAL, { op: 'eq', values: ['12abc'], path: '' })).toMatchObject({ problem: 'Type a number', field: 0 });
    expect(no(ID, { op: 'eq', values: ['1.5'], path: '' })).toMatchObject({ problem: 'Type a whole number', field: 0 });
    expect(no(TOTAL, { op: 'between', values: ['1', ''], path: '' })).toMatchObject({ problem: 'Type a value', field: 1 });
    expect(no(AT, { op: 'lastDays', values: ['0'], path: '' })).toMatchObject({ problem: 'From 1 to 100,000' });
    expect(no(AT, { op: 'lastHours', values: ['100001'], path: '' })).toMatchObject({ problem: 'From 1 to 100,000' });
    expect(no(AT, { op: 'lastDays', values: ['2.5'], path: '' })).toMatchObject({ problem: 'From 1 to 100,000' });
    expect(no(AT, { op: 'before', values: ['  '], path: '' })).toMatchObject({ problem: 'Type a value' });
    expect(no(STATUS, { op: 'in', values: [], path: '' })).toMatchObject({ problem: 'Choose at least one value', field: 'values' });
    expect(no(EMAIL, { op: 'in', values: Array.from({ length: 101 }, (_, i) => `v${i}`), path: '' })).toMatchObject({ problem: 'At most 100 values' });
    expect(no(EMAIL, { op: 'contains', values: ['x'.repeat(10_001)], path: '' })).toMatchObject({ problem: 'At most 10,000 characters' });
    expect(no(EMAIL, { op: 'eq', values: ['a\0b'], path: '' })).toMatchObject({ problem: 'A value can’t hold a NUL character' });
    expect(no(EMAIL, { op: 'contains', values: [''], path: '' })).toMatchObject({ problem: 'Type a value' });
    expect(no(PAYLOAD, { op: 'pathEq', values: ['x'], path: '' })).toMatchObject({ problem: 'Type a path, like data.object.status', field: 'path' });
    expect(no(PAYLOAD, { op: 'pathEq', values: ['x'], path: 'a..b' })).toMatchObject({ problem: 'Not a path: keys joined by dots, [0] for an array item', field: 'path' });
    expect(no(PAYLOAD, { op: 'pathExists', values: [], path: Array.from({ length: 17 }, (_, i) => `k${i}`).join('.') })).toMatchObject({ problem: 'A path holds at most 16 keys' });
    // Never naming the value (Mask values may hide it).
    expect(no(STATUS, { op: 'in', values: ['paid', 'lost'], path: '' })).toMatchObject({ problem: 'A chosen value isn’t in the type anymore: uncheck it', field: 'values' });
    expect(no(EMAIL, { op: 'lt', values: ['x'], path: '' })).toMatchObject({ problem: 'This filter doesn’t fit email' });
  });

  test('an empty value is a value only where the type has one: not for uuid, inet, cidr, macaddr', () => {
    for (const t of ['uuid', 'inet', 'cidr', 'macaddr']) {
      const c = col('k', t, 'U');
      expect(no(c, { op: 'eq', values: [''], path: '' }), t).toMatchObject({ problem: 'Type a value', field: 0 });
      expect(no(c, { op: 'ne', values: [''], path: '' }), t).toMatchObject({ problem: 'Type a value' });
    }
    expect(ok(col('name', 'citext', 'S'), { op: 'eq', values: [''], path: '' }).values).toEqual(['']);
  });

  test('a time before / after / between: a light check of the date — anything Postgres may read is taken', () => {
    expect(no(AT, { op: 'before', values: ['soon'], path: '' })).toMatchObject({ problem: 'Type a date, like 2026-11-04 or 2026-11-04 18:30', field: 0 });
    expect(no(AT, { op: 'between', values: ['2026-11-01', '2026-13-01'], path: '' })).toMatchObject({ problem: 'Type a date, like 2026-11-04 or 2026-11-04 18:30', field: 1 });
    expect(ok(AT, { op: 'after', values: ['today'], path: '' }).values).toEqual(['today']);
    expect(ok(AT, { op: 'between', values: ['2026-11-01T08:00:00Z', 'Nov 4 2026'], path: '' }).values).toEqual(['2026-11-01T08:00:00Z', 'Nov 4 2026']);
  });

  test('taken: an empty text equals (rows whose value is ""), a JSON path, a checklist, a relative time, a boolean', () => {
    expect(ok(EMAIL, { op: 'eq', values: [''], path: '' })).toEqual(f('email', 'eq', ['']));
    expect(ok(EMAIL, { op: 'contains', values: [' acme '], path: '' })).toEqual(f('email', 'contains', [' acme ']));
    expect(ok(PAYLOAD, { op: 'pathEq', values: ['paid'], path: 'data.object[0].status' })).toEqual(f('payload', 'pathEq', ['paid'], ['data', 'object', 0, 'status']));
    expect(ok(PAYLOAD, { op: 'pathExists', values: ['stale'], path: 'refund' })).toEqual(f('payload', 'pathExists', [], ['refund']));
    expect(ok(STATUS, { op: 'notin', values: ['cancelled'], path: '' })).toEqual(f('status', 'notin', ['cancelled']));
    expect(ok(EMAIL, { op: 'in', values: ['a', 'b'], path: '' })).toEqual(f('email', 'in', ['a', 'b']));
    expect(ok(AT, { op: 'lastDays', values: [' 7 '], path: '' })).toEqual(f('created_at', 'lastDays', ['7']));
    expect(ok(PAID, { op: 'false', values: [], path: '' })).toEqual(f('paid', 'false'));
    expect(ok(AT, { op: 'before', values: [' 2026-11-01 '], path: '' })).toEqual(f('created_at', 'before', ['2026-11-01']));
  });
});

describe('the column list (the popover\'s first step)', () => {
  test('the table\'s columns in order, then each JSON column as its column → path (filterable)', () => {
    const t = filterTargets([ID, EMAIL, PAYLOAD], [{ column: 'payload', path: ['data', 'status'] }, { column: 'gone', path: ['x'] }]);
    expect(t.map((x) => x.label)).toEqual(['id', 'email', 'payload', 'payload → data.status']);
    expect(t[3]).toMatchObject({ col: PAYLOAD, path: ['data', 'status'], type: 'json path' });
    expect(t[0]).toMatchObject({ col: ID, path: null, type: 'int8' });
  });
});

describe('the Columns chip ("9 of 12", a checklist; hidden columns aren\'t selected)', () => {
  const ALL = [ID, EMAIL, TOTAL, STATUS];
  test('every column on: null (main selects them all); else the names in the table\'s order, not the clicks\'', () => {
    expect(chosenColumns(ALL, new Set(['status', 'id', 'email', 'total']))).toBeNull();
    expect(chosenColumns(ALL, new Set(['status', 'id']))).toEqual(['id', 'status']);
    expect(shownColumns(ALL, null)).toEqual(new Set(['id', 'email', 'total', 'status']));
    expect(shownColumns(ALL, ['email', 'gone'])).toEqual(new Set(['email']));
  });
  test('its label', () => {
    expect(columnsLabel(9, 12)).toBe('9 of 12');
    expect(columnsLabel(12, 12)).toBe('12 columns');
    expect(columnsLabel(1, 1)).toBe('1 column');
  });
});

describe('the bar\'s columns when the first read of every column failed (a blob-heavy table stays rescuable)', () => {
  const ALL = [ID, EMAIL, PAYLOAD];
  const page = (columns: DbColumn[]) => ({ columns } as DbPage);
  const FAILED = { tableCols: undefined, columns: null, data: null, loading: false, problem: { kind: 'canceled', message: 'Stopped after 15 s' } } as const;
  const catalog = [{ ...ID, comment: null, identity: true, generated: null, check: null }, { ...EMAIL, comment: 'who', identity: false, generated: null, check: null }];

  test('barColumns: the last read of all of them, else this read\'s when it read all, else the catalog\'s (Structure\'s), as plain columns', () => {
    expect(barColumns({ tableCols: ALL, columns: ['id'], data: page([ID]) }, catalog)).toBe(ALL);
    expect(barColumns({ tableCols: undefined, columns: null, data: page(ALL) }, catalog)).toBe(ALL);
    // Nothing read of every column: the catalog's, without Structure's own fields (they'd never reach main anyway).
    expect(barColumns(FAILED, catalog)).toEqual([ID, EMAIL]);
    expect(barColumns({ tableCols: undefined, columns: ['id'], data: page([ID]) }, catalog)).toEqual([ID, EMAIL]);
    expect(barColumns(FAILED, null)).toBeNull();
  });

  test('wantsCatalogColumns: no columns known and the read failed — never while loading, held, or answered "held"', () => {
    expect(wantsCatalogColumns(FAILED, false)).toBe(true);
    expect(wantsCatalogColumns({ ...FAILED, columns: ['id'] }, false)).toBe(true);
    expect(wantsCatalogColumns(FAILED, true)).toBe(false);
    expect(wantsCatalogColumns({ ...FAILED, problem: { kind: 'held', message: 'Disconnected' } }, false)).toBe(false);
    expect(wantsCatalogColumns({ ...FAILED, loading: true }, false)).toBe(false);
    expect(wantsCatalogColumns({ ...FAILED, problem: null }, false)).toBe(false);
    expect(wantsCatalogColumns({ ...FAILED, tableCols: ALL }, false)).toBe(false);
    expect(wantsCatalogColumns({ ...FAILED, data: page(ALL) }, false)).toBe(false);
  });
});

describe('Mask values on a boolean: "is true" names the value, so the chip says "is ••••"', () => {
  test('chip, tooltip — and so the aria-label and "+N more" built from it', () => {
    for (const op of ['true', 'false'] as const) {
      const chip = chipParts(f('password_set', op), true);
      expect(chip).toMatchObject({ col: 'password_set', op: 'is', val: '••••••••', tip: 'password_set is ••••••••' });
      expect(JSON.stringify(chip)).not.toMatch(/true|false/);
    }
    expect(chipParts(f('password_set', 'true'), false)).toMatchObject({ op: 'is true', val: '' });
    expect(chipParts(f('paid', 'true'), true)).toMatchObject({ op: 'is true', val: '' });
    // Filter by on a masked boolean cell is offered: its chip is the masked one above.
    expect(chipParts(cellFilter(g(col('password_set', 'bool', 'B')), cell('t'), 'by')!, true).tip).toBe('password_set is ••••••••');
  });
});

describe('an enum\'s checklist', () => {
  const CAT = ['pending', 'paid', 'shipped'];
  test('the catalog\'s values, checked as chosen; a chosen value the type no longer has, last, checked, marked', () => {
    expect(enumItems(CAT, ['paid', 'lost'], false)).toEqual([
      { value: 'pending', label: 'pending', checked: false }, { value: 'paid', label: 'paid', checked: true },
      { value: 'shipped', label: 'shipped', checked: false }, { value: 'lost', label: 'lost (not in the type anymore)', checked: true }
    ]);
  });
  test('masked while editing: nothing checked, nothing gone named (the values are what Mask hides)', () => {
    expect(enumItems(CAT, ['paid', 'lost'], true)).toEqual(CAT.map((v) => ({ value: v, label: v, checked: false })));
  });
  test('a toggle: in the catalog\'s order; a gone value unchecked goes; while hidden, the first toggle starts a new choice', () => {
    expect(enumToggle(CAT, ['shipped'], 'pending', false)).toEqual(['pending', 'shipped']);
    expect(enumToggle(CAT, ['paid', 'lost'], 'lost', false)).toEqual(['paid']);
    expect(enumToggle(CAT, ['paid', 'lost'], 'pending', false)).toEqual(['pending', 'paid', 'lost']);
    expect(enumToggle(CAT, ['paid', 'lost'], 'shipped', true)).toEqual(['shipped']);
  });
});

describe('"is any of" typed values: what is still in the field counts', () => {
  test('the tokens and the pending text; the pending text alone; nothing pending, the tokens', () => {
    expect(commitPending(['a'], 'b')).toEqual(['a', 'b']);
    expect(commitPending([], 'b')).toEqual(['b']);
    expect(commitPending(['a'], '')).toEqual(['a']);
    expect(commitPending(['a'], 'a')).toEqual(['a']);
    // A pasted list: each line a value.
    expect(commitPending(['a'], 'b\nc\r\n\n')).toEqual(['a', 'b', 'c']);
  });
  test('Apply takes them: a draft with only pending text is a filter, not "Choose at least one value"', () => {
    const d = { op: 'in' as const, values: commitPending([], 'vip'), path: '' };
    expect(draftFilter(EMAIL, d)).toEqual({ ok: true, filter: f('email', 'in', ['vip']) });
  });
});

describe('timeProblem: a light date check — when in doubt, Postgres decides', () => {
  test('refused: no digit and not one of Postgres\'s words; an ISO date with a month or a day out of range', () => {
    for (const v of ['soon', 'later', '2026-13-01', '2026-00-10', '2026-11-32', '2026-11-00 10:00']) expect(timeProblem(v), v).toBe(true);
  });
  test('taken: ISO dates and times, Postgres\'s words, other spellings with digits', () => {
    for (const v of ['2026-11-04', '2026-11-04 18:30', '2026-11-04T18:30:00.123+01', 'today', 'NOW', 'yesterday', 'tomorrow', 'epoch', 'infinity', '-infinity', 'Nov 4 2026', '11/04/2026', '04.11.2026']) expect(timeProblem(v), v).toBe(false);
  });
});

describe('one regex, one set of integer types', () => {
  test('filters.ts takes NUMBER_RE and INTEGER_TYPES from @shared/databases-filters, never its own copies', () => {
    const src = filtersSource;
    expect(src).toMatch(/import \{[^}]*\bINTEGER_TYPES\b[^}]*\bNUMBER_RE\b[^}]*\} from '@shared\/databases-filters'/);
    expect(src).not.toMatch(/const (NUMBER_RE|INTEGER_TYPES)\b/);
  });
});
