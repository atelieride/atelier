import { describe, expect, test } from 'vitest';
import type { DbCell, DbPage } from '@shared/databases';
import type { DbColumn, DbSort } from '@shared/databases-filters';
import type { FormatOpts } from '@shared/pg-format';
import { tdt } from '../i18n/db-table';
import {
  BAR_ROOM, cellMenu, cellView, chipsThatFit, firstWidths, fitWidth, focusMovedOutside, gridColumns, gridKey, HEAD_H, initialWidth, jsonCell, menuCell, menuPoint, nextSort,
  ownKey, revealTop, selectRow, shortType, visibleRange, type CellMenuActions, type GridKeyState
} from './grid-model';

// The data grid's pure parts: columns, widths, sort, selection, the
// keyboard, the rows on screen, chips, the cell menu. What copies carry: grid-copy.test.ts; the JSON preview:
// json-text.test.ts.

const col = (name: string, typeName: string, typeCat: string, o: Partial<DbColumn> = {}): DbColumn => ({
  name, type: typeName, typeSchema: 'pg_catalog', typeName, typeCat, isArray: false, nullable: true, isPk: false, isKey: false, ...o
});
const ID = col('id', 'int8', 'N', { type: 'bigint', isPk: true, isKey: true });
const EMAIL = col('email', 'text', 'S');
const NOTE = col('note', 'text', 'S');
const META = col('meta', 'jsonb', 'U');
const OK = col('ok', 'bool', 'B', { type: 'boolean' });
const AT = col('created_at', 'timestamptz', 'D', { type: 'timestamp with time zone' });
const FK = { schema: 'public', table: 'customers', column: 'id' };

const O: FormatOpts = { times: 'stored', now: Date.UTC(2026, 10, 5), masked: false, width: 'grid' };
const MASKED: FormatOpts = { ...O, masked: true };
const c = (v: string | null, cut?: number): DbCell => (cut === undefined ? { v } : { v, cut });

function page(columns: DbColumn[], rows: (string | null)[][], o: Partial<DbPage> = {}): DbPage {
  return { columns, hidden: [], derived: [], rows: rows.map((r) => r.map((v) => c(v))), ms: 3, sql: 'SELECT 1', pk: ['id'], kind: 'table', ...o, rowKey: o.rowKey ?? o.pk ?? ['id'] };
}

describe('gridColumns: what the grid shows, by the index of each value in a row', () => {
  test('the selected columns in order, not those kept only to name the row; JSON columns after, by their last key', () => {
    const p = page([EMAIL, ID], [], { hidden: ['id'], derived: [{ column: 'meta', path: ['user', 'plan'] }, { column: 'meta', path: ['items', 0, 'sku'] }] });
    const cols = gridColumns(p);
    expect(cols.map((g) => [g.index, g.name, g.label])).toEqual([
      [0, 'email', 'email'],
      [2, 'plan', 'meta.user.plan'],
      [3, 'sku', 'meta.items[0].sku']
    ]);
    // A JSON column's type line is its path, and it is marked as one.
    expect(cols[1]!.type).toBe('meta → user.plan');
    expect(cols[1]!.derived).toEqual({ column: 'meta', path: ['user', 'plan'] });
    expect(cols[0]!.derived).toBeNull();
  });

  test('the header\'s type line: Postgres\'s short names, a foreign key\'s target after an arrow', () => {
    const fk = col('customer_id', 'int8', 'N', { type: 'bigint', isKey: true, fk: FK });
    const other = col('region_id', 'int4', 'N', { type: 'integer', isKey: true, fk: { schema: 'geo', table: 'regions', column: 'id' } });
    const [a, b, d] = gridColumns(page([fk, other, AT], []), 'public');
    expect(a!.type).toBe('int8 → customers');
    expect(b!.type).toBe('int4 → geo.regions');
    expect(d!.type).toBe('timestamptz');
    // The tooltip: the full name and Postgres's own words for the type.
    expect(a!.tip).toBe('customer_id · bigint → customers');
  });

  test('a JSON column is masked by its column\'s name or any key on its path', () => {
    const p = page([META], [], { derived: [{ column: 'secrets', path: ['plan'] }, { column: 'meta', path: ['user', 'email'] }, { column: 'meta', path: ['plan'] }] });
    expect(gridColumns(p).filter((g) => g.derived).map((g) => cellView('pro', g, MASKED).k)).toEqual(['masked', 'masked', 'text']);
  });
});

describe('cellView (what a grid cell shows)', () => {
  test('a column\'s value through formatCell', () => {
    const [id, meta] = gridColumns(page([ID, META], []));
    expect(cellView('1', id!, O)).toEqual({ k: 'num', text: '1', neg: false });
    expect(cellView('{"a":1}', meta!, O)).toMatchObject({ k: 'json', raw: '{"a":1}' });
  });
  test('a JSON column\'s text holding an object or an array shows as JSON (read as text, never parsed); other text as text', () => {
    const [, plan] = gridColumns(page([ID], [], { derived: [{ column: 'meta', path: ['limits'] }] }));
    expect(cellView('{"seats": 12345678901234567890}', plan!, O)).toMatchObject({ k: 'json', raw: '{"seats": 12345678901234567890}' });
    expect(cellView('[1, 2]', plan!, O)).toMatchObject({ k: 'json', raw: '[1, 2]' });
    expect(cellView('pro', plan!, O)).toEqual({ k: 'text', text: 'pro' });
    expect(cellView('{not json', plan!, O)).toEqual({ k: 'text', text: '{not json' });
  });
  test('Mask values on, the preview masks a secret key inside a JSON value (the rest as printed); a cut one, no longer JSON, is dots', () => {
    const [, meta] = gridColumns(page([ID, META], []));
    expect(cellView('{"email": "a@x.test", "n": 12345678901234567890}', meta!, MASKED)).toMatchObject({ k: 'json', raw: '{"email": "••••••••", "n": 12345678901234567890}' });
    expect(cellView('{"email": "a@x.test", "n": 1', meta!, MASKED)).toMatchObject({ k: 'json', raw: '••••••••' });
    expect(cellView('{"email": "a@x.test"}', meta!, O)).toMatchObject({ raw: '{"email": "a@x.test"}' });
    // A JSON column holding an object: the same.
    const [, limits] = gridColumns(page([ID], [], { derived: [{ column: 'meta', path: ['limits'] }] }));
    expect(cellView('{"api_key": "k", "seats": 3}', limits!, MASKED)).toMatchObject({ k: 'json', raw: '{"api_key": "••••••••", "seats": 3}' });
    // Round 2, item 2: its object cut at 64 KB (no longer JSON) — with the mask on, dots whole; off, its text.
    expect(cellView('{"api_key": "k", "seats": [1, 2', limits!, MASKED, 70_000)).toEqual({ k: 'masked' });
    expect(cellView('{"api_key": "k", "seats": [1, 2', limits!, O, 70_000)).toEqual({ k: 'text', text: '{"api_key": "k", "seats": [1, 2' });
    // A string that only starts like one, not cut: as it is.
    expect(cellView('{not json', limits!, MASKED)).toEqual({ k: 'text', text: '{not json' });
  });

  test("a bytea main cut shows the server's size (DbCell.cut), never its cut hex's", () => {
    const [blob] = gridColumns(page([col('blob', 'bytea', 'U')], []));
    const hex = '\\x' + '89504e470d0a1a0a'.padEnd(2 * 65536, '0');
    expect(cellView(hex, blob!, O, 3 * 1024 * 1024)).toMatchObject({ k: 'bytes', size: 3 * 1024 * 1024, mime: 'image/png' });
    expect(cellView('\\xdeadbeef', blob!, O)).toMatchObject({ k: 'bytes', size: 4 });
  });

  test('masked by its column\'s name or a key on its path, JSON or not', () => {
    const [, token] = gridColumns(page([ID], [], { derived: [{ column: 'meta', path: ['auth', 'token'] }] }));
    expect(cellView('{"a": 1}', token!, MASKED)).toEqual({ k: 'masked' });
    expect(cellView('abc', token!, MASKED)).toEqual({ k: 'masked' });
    expect(cellView(null, token!, MASKED)).toEqual({ k: 'null' });
  });
});

describe('shortType', () => {
  test('the SQL standard\'s long names in Postgres\'s short ones, modifiers and array brackets kept', () => {
    expect(shortType('timestamp with time zone')).toBe('timestamptz');
    expect(shortType('timestamp(3) without time zone')).toBe('timestamp(3)');
    expect(shortType('time with time zone')).toBe('timetz');
    expect(shortType('character varying(255)')).toBe('varchar(255)');
    expect(shortType('character(2)')).toBe('char(2)');
    expect(shortType('double precision')).toBe('float8');
    expect(shortType('bigint')).toBe('int8');
    expect(shortType('integer[]')).toBe('int4[]');
    expect(shortType('boolean')).toBe('bool');
    expect(shortType('numeric(10,2)')).toBe('numeric(10,2)');
    expect(shortType('order_status')).toBe('order_status');
    expect(shortType('public.geometry(Point,4326)')).toBe('public.geometry(Point,4326)');
  });
});

describe('initialWidth (64–420 px, by type and a sample of the page)', () => {
  test('narrow values in a narrow column, never under 64', () => {
    expect(initialWidth(col('n', 'int4', 'N'), ['1', '2', '3'])).toBe(64);
    // "plan" is wider than 64 once its sort arrow's room is counted (the header decides, not the values).
    expect(initialWidth(col('plan', 'text', 'S'), ['pro', 'free'])).toBe(78);
  });

  test('long text grows with its sample, never past 420', () => {
    const short = initialWidth(NOTE, ['Gift wrap please']);
    const long = initialWidth(NOTE, ['Gift wrap please, and leave it with the concierge if nobody answers.']);
    expect(short).toBeGreaterThan(100);
    expect(long).toBeGreaterThan(short);
    expect(initialWidth(NOTE, ['x'.repeat(5000)])).toBe(420);
  });

  test('by type: JSON wide, timestamps room for the relative suffix, booleans and UUIDs narrow', () => {
    expect(initialWidth(META, ['{"a":1}'])).toBeGreaterThanOrEqual(260);
    expect(initialWidth(AT, ['2026-11-04 18:22:07+01'], { ...O, now: Date.UTC(2026, 10, 5, 12) })).toBeGreaterThanOrEqual(180);
    expect(initialWidth(OK, ['t', 'f'])).toBeLessThanOrEqual(90);
    const uuid = initialWidth(col('ref', 'uuid', 'U'), ['8f2a91c4-5b0e-4c1f-9d2a-31b7c0a4e7d1']);
    expect(uuid).toBeGreaterThan(150);
    expect(uuid).toBeLessThan(220);
  });

  test('the header\'s name and its icons get room before the values do', () => {
    const name = col('customer_lifetime_value_cents', 'int8', 'N', { fk: FK });
    expect(initialWidth(name, ['1'])).toBeGreaterThan(29 * 7);
    // No sample (an empty page): the type's own width.
    expect(initialWidth(META, [])).toBeGreaterThanOrEqual(260);
    expect(initialWidth(NOTE, [null, null])).toBeGreaterThanOrEqual(64);
  });

  test('a short name keeps room for its key icon and the sort arrow, so sorting never cuts it', () => {
    // Button padding 10 + 14, the key (12 + 5 gap), the name (2 × 7.4), the arrow (12 + 5 gap) and a multi-sort digit (7).
    const need = 24 + 17 + 2 * 7.4 + 17 + 7;
    expect(initialWidth(ID, ['1', '2'])).toBeGreaterThanOrEqual(need);
    const g = gridColumns(page([ID], [['1']]))[0]!;
    expect(fitWidth(g, [[c('1')]], O)).toBeGreaterThanOrEqual(need);
    const [first] = firstWidths([g], [[c('1')]], {}, O).widths;
    expect(first).toBeGreaterThanOrEqual(need);
  });
});

describe('one measure for first widths and fits: what the cell shows (8)', () => {
  test('a grouped number fits whole ("1,234,567" is nine characters, not seven)', () => {
    const qty = col('qty', 'int8', 'N');
    const [g] = gridColumns(page([qty], []));
    const need = Math.ceil(9 * 7.2 + 20);
    expect(initialWidth(qty, ['1234567'])).toBeGreaterThanOrEqual(need);
    expect(fitWidth(g!, [[c('1234567')]], O)).toBeGreaterThanOrEqual(need);
  });

  test('the value fits the cell\'s content box: 10 px of padding each side and its 1 px border (an e2e saw "158.…")', () => {
    const total = col('total', 'numeric', 'N');
    const [g] = gridColumns(page([total], []));
    // A cell is its column's width less 21 px (padding 10 + 10, border-right 1); 12 px mono is 7.2 px a character.
    for (const v of ['158.80', '1240.00', '48210.75']) {
      expect(initialWidth(total, [v]) - 21, v).toBeGreaterThanOrEqual(v.length * 7.2);
      expect(fitWidth(g!, [[c(v)]], O) - 21, v).toBeGreaterThanOrEqual(v.length * 7.2);
    }
  });

  test('masked: the dots\' width, whatever the value\'s length', () => {
    const [e] = gridColumns(page([EMAIL], []));
    const dots = fitWidth(e!, [[c('a@b')]], MASKED);
    expect(dots).toBeGreaterThan(fitWidth(e!, [[c('a@b')]], O));
    expect(dots).toBeGreaterThanOrEqual(Math.ceil(8 * 7.2 + 20));
    expect(initialWidth(EMAIL, ['a@b'], MASKED)).toBe(dots);
  });

  test('a foreign key\'s value counts its arrow; a UUID its folded form', () => {
    const v = '123456789012';
    const plain = col('customer_id', 'int8', 'N', { isKey: true });
    const fk = { ...plain, fk: FK };
    expect(initialWidth(fk, [v]) - initialWidth(plain, [v])).toBe(17);
    const ref = col('customer_ref', 'uuid', 'U', { fk: FK });
    const uuid = '8f2a91c4-5b0e-4c1f-9d2a-31b7c0a4e7d1';
    const [u] = gridColumns(page([ref], []));
    expect(initialWidth(ref, [uuid])).toBeGreaterThanOrEqual(Math.ceil(23 * 7.2 + 17 + 20));
    expect(fitWidth(u!, [[c(uuid)]], O)).toBe(initialWidth(ref, [uuid]));
  });
});

describe('firstWidths: measured once per tab and column', () => {
  test('a new run (a sort, a filter, Refresh) keeps the widths seen; only columns not seen before are measured', () => {
    const p = page([ID, NOTE], [['1', 'short']]);
    const first = firstWidths(gridColumns(p), p.rows, {}, O);
    expect(first.added).toEqual({ id: first.widths[0], note: first.widths[1] });
    const longer = page([ID, NOTE], [['1', 'a much longer note than before, one that would widen the column a lot']]);
    const again = firstWidths(gridColumns(longer), longer.rows, first.added!, O);
    expect(again.widths).toEqual(first.widths);
    expect(again.added).toBeNull();
    const more = page([ID, NOTE], [['1', 'x']], { derived: [{ column: 'meta', path: ['plan'] }] });
    more.rows[0]!.push(c('pro'));
    const cols = gridColumns(more);
    const third = firstWidths(cols, more.rows, first.added!, O);
    expect(third.widths.slice(0, 2)).toEqual(first.widths);
    expect(Object.keys(third.added!)).toEqual([cols[2]!.key]);
  });
});

describe('nextSort (ascending → descending → off; Shift adds a secondary sort)', () => {
  const a: DbSort = { column: 'a', dir: 'asc' };
  test('a click cycles that column and makes it the only sort', () => {
    expect(nextSort([], 'a', false)).toEqual([{ column: 'a', dir: 'asc' }]);
    expect(nextSort([a], 'a', false)).toEqual([{ column: 'a', dir: 'desc' }]);
    expect(nextSort([{ column: 'a', dir: 'desc' }], 'a', false)).toEqual([]);
    expect(nextSort([a], 'b', false)).toEqual([{ column: 'b', dir: 'asc' }]);
    expect(nextSort([a, { column: 'b', dir: 'asc' }], 'b', false)).toEqual([{ column: 'b', dir: 'desc' }]);
  });

  test('Shift appends, then cycles that column in its place, then removes it', () => {
    const one = nextSort([a], 'b', true);
    expect(one).toEqual([a, { column: 'b', dir: 'asc' }]);
    const two = nextSort(one, 'b', true);
    expect(two).toEqual([a, { column: 'b', dir: 'desc' }]);
    expect(nextSort(two, 'b', true)).toEqual([a]);
    expect(nextSort(two, 'a', true)).toEqual([{ column: 'a', dir: 'desc' }, { column: 'b', dir: 'desc' }]);
  });

  test('a JSON column sorts by its path; the same column without a path is another sort', () => {
    const p = nextSort([a], 'meta', true, ['user', 'plan']);
    expect(p).toEqual([a, { column: 'meta', path: ['user', 'plan'], dir: 'asc' }]);
    expect(nextSort(p, 'meta', true, ['user', 'plan'])).toEqual([a, { column: 'meta', path: ['user', 'plan'], dir: 'desc' }]);
    expect(nextSort(p, 'meta', true)).toHaveLength(3);
  });

  test('never changes the array it is given (the tab\'s state is frozen)', () => {
    const frozen = Object.freeze([Object.freeze({ ...a })]) as readonly DbSort[];
    expect(() => nextSort(frozen, 'a', true)).not.toThrow();
    expect(frozen).toEqual([a]);
  });
});

describe('selectRow (a click selects, ⌘-click toggles, Shift-click extends)', () => {
  const plain = { meta: false, shift: false };
  test('a click: that row alone', () => {
    expect(selectRow([1, 4], 2, plain, 1)).toEqual([2]);
  });
  test('⌘-click toggles, kept in order', () => {
    expect(selectRow([1, 3], 3, { meta: true, shift: false }, 1)).toEqual([1]);
    expect(selectRow([4], 1, { meta: true, shift: false }, 4)).toEqual([1, 4]);
  });
  test('Shift-click: the range from the anchor, either way; no anchor: the row', () => {
    expect(selectRow([2], 5, { meta: false, shift: true }, 2)).toEqual([2, 3, 4, 5]);
    expect(selectRow([5], 2, { meta: false, shift: true }, 5)).toEqual([2, 3, 4, 5]);
    expect(selectRow([], 7, { meta: false, shift: true }, null)).toEqual([7]);
  });
  test('⌘⇧-click adds the range to what is selected', () => {
    expect(selectRow([0], 5, { meta: true, shift: true }, 3)).toEqual([0, 3, 4, 5]);
  });
});

describe('focusMovedOutside', () => {
  test('the grid follows a focus moved from outside it (the inspector\'s ↑/↓, a row picked on opening) — scrolled to, its Shift anchor there — never its own (a click, a right-click, its keys)', () => {
    expect(focusMovedOutside(6, 5)).toBe(true);
    expect(focusMovedOutside(5, 5)).toBe(false);
    expect(focusMovedOutside(0, null)).toBe(true);
    expect(focusMovedOutside(null, 5)).toBe(false);
  });
});

describe('gridKey (the grid\'s keyboard)', () => {
  const key = (k: string, o: Partial<{ code: string; mod: boolean; shift: boolean; alt: boolean; ctrl: boolean; wrapKey: boolean }> = {}) =>
    ({ key: k, code: o.code ?? '', mod: o.mod ?? false, shift: o.shift ?? false, alt: o.alt ?? false, ctrl: o.ctrl ?? false, wrapKey: o.wrapKey ?? false });
  const state = (o: Partial<GridKeyState> = {}): GridKeyState => ({ count: 10, selection: [], focus: null, anchor: null, firstCol: 0, ...o });

  test('↓/↑ move the focus and the selection with it; from nothing, the first or the last row; never past the ends', () => {
    expect(gridKey(key('ArrowDown'), state())).toEqual({ kind: 'select', selection: [0], focus: { row: 0, col: 0 }, anchor: 0, reveal: 0 });
    expect(gridKey(key('ArrowUp'), state())).toEqual({ kind: 'select', selection: [9], focus: { row: 9, col: 0 }, anchor: 9, reveal: 9 });
    expect(gridKey(key('ArrowDown'), state({ focus: { row: 3, col: 2 }, selection: [3] }))).toEqual({ kind: 'select', selection: [4], focus: { row: 4, col: 2 }, anchor: 4, reveal: 4 });
    expect(gridKey(key('ArrowDown'), state({ focus: { row: 9, col: 2 } }))).toMatchObject({ focus: { row: 9, col: 2 } });
    expect(gridKey(key('ArrowUp'), state({ focus: { row: 0, col: 2 } }))).toMatchObject({ focus: { row: 0, col: 2 } });
    expect(gridKey(key('ArrowDown'), state({ count: 0 }))).toBeNull();
  });

  test('Shift extends from the anchor, the anchor stays', () => {
    expect(gridKey(key('ArrowDown', { shift: true }), state({ focus: { row: 3, col: 1 }, selection: [3], anchor: 3 })))
      .toEqual({ kind: 'select', selection: [3, 4], focus: { row: 4, col: 1 }, anchor: 3, reveal: 4 });
    expect(gridKey(key('ArrowUp', { shift: true }), state({ focus: { row: 5, col: 1 }, selection: [3, 4, 5], anchor: 3 })))
      .toEqual({ kind: 'select', selection: [3, 4], focus: { row: 4, col: 1 }, anchor: 3, reveal: 4 });
    // No anchor yet: from the focused row.
    expect(gridKey(key('ArrowUp', { shift: true }), state({ focus: { row: 5, col: 1 } }))).toMatchObject({ selection: [4, 5], anchor: 5 });
  });

  test('Tab on a focused row opens it as a record; no row focused, Shift+Tab or with a modifier: the browser\'s', () => {
    expect(gridKey(key('Tab'), state({ focus: { row: 3, col: 2 }, selection: [3] }))).toEqual({ kind: 'record', row: 3 });
    // The focused row, not the selection's last.
    expect(gridKey(key('Tab'), state({ focus: { row: 1, col: 0 }, selection: [1, 2, 5] }))).toEqual({ kind: 'record', row: 1 });
    expect(gridKey(key('Tab'), state())).toBeNull();
    expect(gridKey(key('Tab'), state({ selection: [4] }))).toBeNull();
    // A focus past the rows loaded (a new first page came meanwhile): nothing to open.
    expect(gridKey(key('Tab'), state({ count: 2, focus: { row: 5, col: 0 } }))).toBeNull();
    for (const m of [{ shift: true }, { alt: true }, { mod: true }, { ctrl: true }]) {
      expect(gridKey(key('Tab', m), state({ focus: { row: 3, col: 2 } })), JSON.stringify(m)).toBeNull();
    }
  });

  test('⌘A every row loaded; Esc clears (only when there is something to clear); Enter the inspector; ⌘C; ⌥Z', () => {
    expect(gridKey(key('a', { mod: true }), state({ count: 4 }))).toEqual({ kind: 'select', selection: [0, 1, 2, 3], focus: { row: 0, col: 0 }, anchor: 0, reveal: null });
    expect(gridKey(key('a', { mod: true }), state({ count: 4, focus: { row: 2, col: 1 }, anchor: 2 }))).toMatchObject({ focus: { row: 2, col: 1 }, anchor: 2 });
    expect(gridKey(key('Escape'), state({ selection: [1] }))).toEqual({ kind: 'clear' });
    expect(gridKey(key('Escape'), state())).toBeNull();
    expect(gridKey(key('Enter'), state())).toEqual({ kind: 'inspector' });
    expect(gridKey(key('c', { mod: true, code: 'KeyC' }), state())).toEqual({ kind: 'copy' });
    // A layout where C types another letter: the key's place decides.
    expect(gridKey(key('с', { mod: true, code: 'KeyC' }), state())).toEqual({ kind: 'copy' });
    expect(gridKey(key('Ω', { alt: true, code: 'KeyZ', wrapKey: true }), state())).toEqual({ kind: 'wrap' });
  });

  test('other chords are left to the app (⌘↓, ⌥↓, ⇧⌘A, ⌘⏎, ⇧⏎, letters)', () => {
    for (const k of [key('ArrowDown', { mod: true }), key('ArrowDown', { alt: true }), key('a', { mod: true, shift: true }), key('Enter', { mod: true }),
      key('Enter', { shift: true }), key('j'), key('c'), key('Escape', { mod: true })]) {
      expect(gridKey(k, state({ selection: [1], focus: { row: 1, col: 0 } })), JSON.stringify(k)).toBeNull();
    }
  });

  test('⌥↩ sends the selected rows, or the focused one; with nothing to send, or another chord, it is not the grid\'s', () => {
    expect(gridKey(key('Enter', { alt: true }), state({ selection: [1, 3], focus: { row: 3, col: 0 } }))).toEqual({ kind: 'send', rows: [1, 3] });
    expect(gridKey(key('Enter', { alt: true }), state({ focus: { row: 4, col: 2 } }))).toEqual({ kind: 'send', rows: [4] });
    expect(gridKey(key('Enter', { alt: true }), state())).toBeNull();
    for (const k of [key('Enter', { alt: true, shift: true }), key('Enter', { alt: true, mod: true }), key('Enter', { alt: true, ctrl: true })]) {
      expect(gridKey(k, state({ selection: [1], focus: { row: 1, col: 0 } })), JSON.stringify(k)).toBeNull();
    }
  });

  test('the Control key is required: a caller that leaves it out is a type error, never ⌃⌥↩ sent as ⌥↩', () => {
    // @ts-expect-error — no `ctrl`: the chord can't be told from ⌥↩.
    const without: Parameters<typeof gridKey>[0] = { key: 'Enter', code: 'Enter', mod: false, shift: false, alt: true, wrapKey: false };
    expect(gridKey({ ...without, ctrl: true }, state({ selection: [1] }))).toBeNull();
    expect(gridKey({ ...without, ctrl: false }, state({ selection: [1] }))).toEqual({ kind: 'send', rows: [1] });
  });

  test('only keys that reach the grid itself: a control inside it (Retry, a link) keeps its own Enter', () => {
    const grid = { id: 'grid' };
    expect(ownKey(grid, grid)).toBe(true);
    expect(ownKey({ id: 'retry button' }, grid)).toBe(false);
    expect(ownKey(null, grid)).toBe(false);
  });
});

describe('revealTop: a row brought into view never lies under the action bar', () => {
  // 30 px rows under the sticky header; a viewport 600 px tall; the bar's room at its foot.
  test('below the view: scrolled until its bottom edge meets the top of the bar\'s room — the last row too', () => {
    // Row 20 ends at HEAD_H + 21 × 30 in the content; the view shows down to 600 − BAR_ROOM.
    expect(revealTop(20, 30, 0, 600, BAR_ROOM)).toBe(HEAD_H + 21 * 30 - (600 - BAR_ROOM));
    // Without the room (nothing floats there), as before: to the viewport's bottom.
    expect(revealTop(20, 30, 0, 600, 0)).toBe(HEAD_H + 21 * 30 - 600);
    // A row whose bottom sits in the bar's room is not "in view".
    const top = 100;
    const row = Math.floor((top + 600 - BAR_ROOM - HEAD_H) / 30);
    expect(revealTop(row, 30, top, 600, BAR_ROOM)).toBeGreaterThan(top);
  });

  test('above the view: under the sticky header; in view: left where it is (static UI)', () => {
    expect(revealTop(2, 30, 300, 600, BAR_ROOM)).toBe(60);
    expect(revealTop(12, 30, 300, 600, BAR_ROOM)).toBeNull();
  });

  test('a viewport too short for the room: the row still shows under the header, never above the view', () => {
    expect(revealTop(10, 30, 0, 90, BAR_ROOM)).toBe(11 * 30 - 30);
  });

  test('the room is the bar\'s: its buttons, its padding, its distance from the foot', () => {
    expect(BAR_ROOM).toBeGreaterThanOrEqual(28 + 2 * 6 + 12);
  });
});

describe('menuCell: Shift+F10 always opens a cell\'s menu', () => {
  test('the focused cell; none: the first row on screen, its first column', () => {
    expect(menuCell({ row: 7, col: 2 }, 95, 30, 100, 0)).toEqual({ row: 7, col: 2 });
    expect(menuCell(null, 95, 30, 100, 3)).toEqual({ row: 4, col: 3 });
    expect(menuCell(null, 0, 30, 100, 0)).toEqual({ row: 0, col: 0 });
    expect(menuCell(null, 99_999, 30, 100, 0)).toEqual({ row: 99, col: 0 });
    expect(menuCell(null, 0, 30, 0, 0)).toBeNull();
  });
});

describe('menuPoint: where Shift+F10\'s menu opens, beside its cell, inside the grid', () => {
  const view = { scrollTop: 300, scrollLeft: 0, viewW: 600, viewH: 400 };
  test('under the cell\'s left part, from the column widths and the scroll — no drawn row needed', () => {
    // Row 12 at 30 px: its bottom 44 + 13 × 30 − 300 = 134 px into the grid; column 1 starts after 52 + 100.
    expect(menuPoint({ row: 12, k: 1, widths: [100, 200], rowH: 30, ...view })).toEqual({ x: 52 + 100 + 24, y: 134 - 4 });
  });
  test('a column scrolled out of sight: the menu stays inside the grid', () => {
    expect(menuPoint({ row: 12, k: 1, widths: [100, 200], rowH: 30, ...view, scrollLeft: 400 })).toEqual({ x: 52, y: 130 });
    expect(menuPoint({ row: 12, k: 0, widths: [100, 2000], rowH: 30, ...view, viewW: 100 }).x).toBeLessThanOrEqual(100 - 8);
  });
});

describe('visibleRange (only the rows on screen and an overscan in the DOM)', () => {
  test('at the top', () => {
    expect(visibleRange(0, 600, 30, 10_000)).toEqual({ first: 0, last: 28 });
  });
  test('in the middle: the overscan on both sides', () => {
    expect(visibleRange(3000, 600, 30, 10_000)).toEqual({ first: 92, last: 128 });
  });
  test('at the end: clamped to the rows loaded', () => {
    expect(visibleRange(2400, 600, 30, 100)).toEqual({ first: 72, last: 100 });
    expect(visibleRange(99_999, 600, 30, 100)).toEqual({ first: 92, last: 100 });
  });
  test('no rows, no height, another overscan', () => {
    expect(visibleRange(0, 600, 30, 0)).toEqual({ first: 0, last: 0 });
    expect(visibleRange(0, 0, 30, 50)).toEqual({ first: 0, last: 8 });
    expect(visibleRange(300, 300, 30, 1000, 2)).toEqual({ first: 8, last: 22 });
  });
  test('10,000 rows: a screenful, never the lot', () => {
    for (const top of [0, 150_000, 299_400]) {
      const r = visibleRange(top, 900, 30, 10_000);
      expect(r.last - r.first).toBeLessThanOrEqual(60);
    }
  });
});

describe('chipsThatFit (arrays: chips, "+N" past the width)', () => {
  test('as many as the width holds, at least one', () => {
    expect(chipsThatFit(['api', 'beta', 'eu', 'gift-wrap', 'priority', 'vip'], 180)).toBe(3);
    expect(chipsThatFit(['api', 'beta'], 400)).toBe(2);
    expect(chipsThatFit(['a-very-long-tag-name-indeed'], 64)).toBe(1);
    expect(chipsThatFit([], 200)).toBe(0);
  });

  test('a lexeme\'s position counts its 4 px gap: the first width holds the chips it shows and their "+N" (an e2e saw tsvector\'s "+3" cut)', () => {
    const tsv = col('c_tsvector', 'tsvector', 'U');
    const raw = "'answer':12 'concierg':9 'gift':1 'leav':5 'nobodi':11 'pleas':3 'wrap':2";
    const items = [['answer', '12'], ['concierg', '9'], ['gift', '1'], ['leav', '5'], ['nobodi', '11'], ['pleas', '3'], ['wrap', '2']];
    // As table.css draws a chip: 10.5 px mono (6.3 px a character), padding 6 + 6, a gap of 4 after it, the position
    // 4 px after the word.
    const drawn = ([w, p]: string[]) => (w!.length + p!.length) * 6.3 + 12 + 4 + 4;
    const more = (n: number) => `+${n}`.length * 6.3 + 12;
    const width = initialWidth(tsv, [raw]);
    const n = chipsThatFit(items.map(([w, p]) => ({ text: w!, pos: p! })), width);
    expect(n).toBeGreaterThan(0);
    const used = items.slice(0, n).reduce((s, x) => s + drawn(x), 0) + (n < items.length ? more(items.length - n) : 0);
    expect(used, `${n} chips in a ${width} px column`).toBeLessThanOrEqual(width - 21);
  });

  test('room for the "+N" chip as it reads ("+197" is wider than "+3")', () => {
    expect(chipsThatFit(Array.from({ length: 200 }, () => 'a'), 145)).toBe(3);
    expect(chipsThatFit(Array.from({ length: 6 }, () => 'a'), 145)).toBe(4);
  });
});

describe('cellMenu', () => {
  const act = (): CellMenuActions => ({ copyValue: () => {}, copyRow: () => {}, copyAs: () => {}, wrap: () => {} });
  const ids = (items: ReturnType<typeof cellMenu>) => items.map((i) => (i === 'sep' ? '-' : i.id));

  test('Copy Value, Copy Row as JSON, Copy Rows As › the four formats; Wrap Cells checked as the tab has it', () => {
    const items = cellMenu({ rows: 1, wrap: true, json: false }, act());
    expect(ids(items)).toEqual(['copy-value', 'copy-row', 'copy-as', '-', 'wrap']);
    const as = items.find((i) => i !== 'sep' && i.id === 'copy-as');
    expect(as !== 'sep' && as?.submenu?.map((i) => (i === 'sep' ? '-' : i.label))).toEqual(['JSON', 'CSV', 'Markdown', 'SQL INSERT']);
    const wrap = items.find((i) => i !== 'sep' && i.id === 'wrap');
    expect(wrap !== 'sep' && wrap?.checked).toBe(true);
    expect(wrap !== 'sep' && wrap?.hint).toBe('⌥Z');
    const value = items[0];
    expect(value !== 'sep' && value?.hint).toBe('⌘C');
  });

  test('several rows: the format menu names them', () => {
    const as = cellMenu({ rows: 3, wrap: false, json: false }, act()).find((i) => i !== 'sep' && i.id === 'copy-as');
    expect(as !== 'sep' && as?.label).toBe('Copy 3 Rows As');
  });

  test('the later tasks\' items show only when given (filters T24, the referenced row T25, JSON view T26, sessions T29)', () => {
    const full: CellMenuActions = {
      ...act(), filterBy: () => {}, exclude: () => {}, openRef: () => {}, openJson: () => {}, sendTo: { label: 'db-migration', run: () => {} }, askNew: () => {}
    };
    expect(ids(cellMenu({ rows: 1, wrap: false, json: true }, full))).toEqual(
      ['copy-value', 'copy-row', 'copy-as', '-', 'filter-by', 'exclude', 'open-ref', 'open-json', '-', 'send-to', 'ask-new', '-', 'wrap']
    );
    // Open in JSON View only on a JSON value.
    expect(ids(cellMenu({ rows: 1, wrap: false, json: false }, full))).not.toContain('open-json');
  });

  test('Send to <session> names the session the Docker and Redis bars target; with none, "Send to Session" (its run says why)', () => {
    const label = (sendTo: CellMenuActions['sendTo']) => {
      const it = cellMenu({ rows: 1, wrap: false, json: false }, { ...act(), sendTo, askNew: () => {} }).find((i) => i !== 'sep' && i.id === 'send-to');
      return it !== 'sep' ? it?.label : undefined;
    };
    expect(label({ label: 'db-migration', run: () => {} })).toBe('Send to db-migration');
    expect(label({ label: null, run: () => {} })).toBe('Send to Session');
    const ask = cellMenu({ rows: 2, wrap: false, json: false }, { ...act(), askNew: () => {} }).find((i) => i !== 'sep' && i.id === 'ask-new');
    expect(ask !== 'sep' && ask?.label).toBe('Ask in a New Session');
  });

  test('no string left unused', () => {
    expect('sortTip' in tdt.grid).toBe(false);
  });

  test('Column Menu…: the cell\'s column menu from the keyboard, with Wrap Cells', () => {
    const items = cellMenu({ rows: 1, wrap: false, json: false }, { ...act(), columnMenu: () => {} });
    expect(ids(items)).toEqual(['copy-value', 'copy-row', 'copy-as', '-', 'column-menu', 'wrap']);
    const it = items.find((i) => i !== 'sep' && i.id === 'column-menu');
    expect(it !== 'sep' && it?.label).toBe('Column Menu…');
  });
});

describe('jsonCell: what Open in JSON View and a double click open', () => {
  const p = page([ID, META, NOTE], [], { derived: [{ column: 'meta', path: ['a'] }] });
  const [, meta, note, drv] = gridColumns(p);
  test('a json/jsonb value (cut ones too: the view loads them whole); a JSON column\'s object or array; nothing else', () => {
    expect(jsonCell(meta!, c('{"a": 1}'))).toBe(true);
    expect(jsonCell(meta!, c('{"a": ', 70_000))).toBe(true);
    expect(jsonCell(meta!, c(null))).toBe(false);
    expect(jsonCell(meta!, undefined)).toBe(false);
    expect(jsonCell(drv!, c('[1, 2]'))).toBe(true);
    expect(jsonCell(drv!, c('paid'))).toBe(false);
    expect(jsonCell(note!, c('{"a": 1}'))).toBe(false);
  });
});
