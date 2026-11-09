import { describe, expect, test } from 'vitest';
import type { DbConstraint, DbIndex } from '@shared/databases';
import type { DbColumn } from '@shared/databases-filters';
import {
  checkText, columnBadges, columnNotes, constraintParts, deadShare, indexBadges, indexKeys, scansLabel, since, sizeBar, sizeLabel, sqlLines, structureLayout
} from './structure-model';

// Structure's pure helpers: the layout at every width, the columns'
// badges and notes, an index's keys and WHERE, "never used", the Size card, the constraints' wording, the DDL's colors.

const col = (name: string, o: Partial<DbColumn & { comment: string | null; identity: boolean; generated: string | null; check: string | null }> = {}) => ({
  name, type: 'text', typeSchema: 'pg_catalog', typeName: 'text', typeCat: 'S', isArray: false, nullable: true, isPk: false, isKey: false,
  comment: null, identity: false, generated: null, check: null, ...o
});
const ix = (name: string, def: string, o: Partial<DbIndex> = {}): DbIndex => ({
  name, def, method: 'btree', bytes: 8192, scans: 12, unique: false, primary: false, partial: null, neverUsed: false, ...o
});
const PKEY = ix('orders_pkey', 'CREATE UNIQUE INDEX orders_pkey ON public.orders USING btree (id)', { unique: true, primary: true, scans: 2_100_000 });
const GIN = ix('orders_metadata_gin', 'CREATE INDEX orders_metadata_gin ON public.orders USING gin (metadata jsonb_path_ops)', { method: 'gin', scans: 0, neverUsed: true });
const CREATED = ix('orders_created_at_idx', 'CREATE INDEX orders_created_at_idx ON public.orders USING btree (created_at DESC)', { scans: 96_000 });
const PENDING = ix('orders_pending_idx', "CREATE INDEX orders_pending_idx ON public.orders USING btree (created_at) WHERE (status = 'pending'::order_status)", {
  partial: "(status = 'pending'::order_status)", scans: 8200
});
const EMAIL = ix('customers_email_key', 'CREATE UNIQUE INDEX customers_email_key ON public.customers USING btree (email)', { unique: true });

describe('structureLayout: two columns, or one below ~720 px', () => {
  test.each([
    [280, { stacked: true }], [430, { stacked: true }], [719, { stacked: true }], [720, { stacked: false, side: 320 }], [1200, { stacked: false, side: 420 }]
  ] as const)('%i px', (width, want) => {
    expect(structureLayout(width)).toMatchObject(want);
  });

  test('the side column never squeezes the columns table: at least 320, at most 420, ~36% between', () => {
    expect(structureLayout(1000).side).toBe(360);
    expect(structureLayout(3000).side).toBe(420);
    // Not measured yet (a hidden tab): the wide layout, never a stacked flash.
    expect(structureLayout(0)).toEqual({ stacked: false, side: 420 });
  });
});

describe('the Columns table', () => {
  test('badges: PK, FK; else the index a column leads — GIN by its method, IDX for a btree, UNIQUE for a unique one', () => {
    // The indexes are read once per structure (300 columns never parse them 300 times).
    const led = indexBadges([PKEY, GIN, CREATED, PENDING, EMAIL]);
    expect(led).toEqual(new Map([['metadata', 'GIN'], ['created_at', 'IDX'], ['email', 'UNIQUE']]));
    expect(columnBadges(col('id', { isPk: true }), led)).toEqual(['PK']);
    expect(columnBadges(col('customer_id', { fk: { schema: 'public', table: 'customers', column: 'id' } }), led)).toEqual(['FK']);
    expect(columnBadges(col('metadata'), led)).toEqual(['GIN']);
    expect(columnBadges(col('created_at'), led)).toEqual(['IDX']);
    expect(columnBadges(col('email'), led)).toEqual(['UNIQUE']);
    expect(columnBadges(col('notes'), led)).toEqual([]);
    // Only a leading key column: the second of a composite index, an INCLUDE column or an expression don't count.
    const multi = indexBadges([ix('k', 'CREATE INDEX k ON t USING btree (a, b) INCLUDE (c)'), ix('e', 'CREATE INDEX e ON t USING btree (lower(d))')]);
    expect(['a', 'b', 'c', 'd'].map((n) => columnBadges(col(n), multi))).toEqual([['IDX'], [], [], []]);
    // A quoted name as pg_get_indexdef writes it; a unique index wins over a btree one, a btree over another method.
    expect(columnBadges(col('Weird Col'), indexBadges([ix('w', 'CREATE INDEX w ON t USING btree ("Weird Col")')]))).toEqual(['IDX']);
    const both = [ix('g', 'CREATE INDEX g ON t USING gin (a)', { method: 'gin' }), ix('b', 'CREATE INDEX b ON t USING btree (a)'), ix('u', 'CREATE UNIQUE INDEX u ON t USING btree (a)', { unique: true })];
    expect(indexBadges(both).get('a')).toBe('UNIQUE');
    expect(indexBadges(both.slice(0, 2)).get('a')).toBe('IDX');
    expect(indexBadges(both.slice(0, 1)).get('a')).toBe('GIN');
  });

  test('notes: the FK target (a link), an enum\'s values, a check, generated, the comment', () => {
    expect(columnNotes(col('customer_id', { fk: { schema: 'public', table: 'customers', column: 'id' } }), 'public')).toEqual([
      { kind: 'fk', text: '→ customers.id', target: { schema: 'public', name: 'customers' } }
    ]);
    expect(columnNotes(col('plan_id', { fk: { schema: 'billing', table: 'plans', column: 'id' } }), 'public')[0]).toMatchObject({ text: '→ billing.plans.id' });
    expect(columnNotes(col('status', { enumValues: ['pending', 'paid', 'shipped', 'refunded', 'failed'] }), 'public')).toEqual([{ kind: 'text', text: 'enum · 5 values' }]);
    expect(columnNotes(col('total', { check: 'CHECK ((total >= (0)::numeric))' }), 'public')).toEqual([{ kind: 'text', text: 'check total >= (0)::numeric' }]);
    expect(columnNotes(col('twice', { generated: '(a * 2)' }), 'public')).toEqual([{ kind: 'text', text: 'generated (a * 2)' }]);
    expect(columnNotes(col('notes', { comment: 'Shown on the packing slip' }), 'public')).toEqual([{ kind: 'comment', text: '“Shown on the packing slip”' }]);
  });

  test('a check\'s expression without its keyword and outer parentheses; two checks on one column kept apart', () => {
    expect(checkText('CHECK ((total >= (0)::numeric))')).toBe('total >= (0)::numeric');
    expect(checkText('CHECK (((percent >= 1) AND (percent <= 100)))')).toBe('(percent >= 1) AND (percent <= 100)');
    expect(checkText('CHECK ((a > 0)), CHECK ((a < 9))')).toBe('a > 0, a < 9');
    expect(checkText('CHECK ((a > 0)) NOT VALID')).toBe('a > 0 NOT VALID');
    expect(checkText('something else')).toBe('something else');
  });
});

describe('the Indexes table', () => {
  test('the keys after the method, the WHERE of a partial index apart (as pg_get_expr wrote it, outer parentheses off)', () => {
    expect(indexKeys(PKEY)).toEqual({ keys: '(id)', where: null });
    expect(indexKeys(GIN)).toEqual({ keys: '(metadata jsonb_path_ops)', where: null });
    expect(indexKeys(CREATED)).toEqual({ keys: '(created_at DESC)', where: null });
    expect(indexKeys(PENDING)).toEqual({ keys: '(created_at)', where: "status = 'pending'::order_status" });
    expect(indexKeys(ix('k', 'CREATE UNIQUE INDEX k ON edge.k USING btree (c, d) INCLUDE (b)'))).toEqual({ keys: '(c, d) INCLUDE (b)', where: null });
    // Something unexpected: the whole definition rather than a wrong cut.
    expect(indexKeys(ix('odd', 'whatever'))).toEqual({ keys: 'whatever', where: null });
  });

  test('scans: compact; "never used" (amber) for a non-unique index main found never scanned; no statistics: a dash', () => {
    expect(scansLabel(PKEY)).toEqual({ text: '2.1M scans', never: false });
    expect(scansLabel(CREATED)).toEqual({ text: '96k scans', never: false });
    expect(scansLabel(ix('one', 'x', { scans: 1 }))).toEqual({ text: '1 scan', never: false });
    expect(scansLabel(GIN)).toEqual({ text: 'never used', never: true });
    // A unique index with no scans still guards its key: not "never used" (main's neverUsed says so).
    expect(scansLabel(ix('u', 'x', { unique: true, scans: 0 }))).toEqual({ text: '0 scans', never: false });
    expect(scansLabel(ix('n', 'x', { scans: null }))).toEqual({ text: '—', never: false });
  });
});

describe('the Size card', () => {
  test('sizes as people read them', () => {
    expect([0, 512, 40 * 1024, 1.1 * 1024 * 1024, 18.3 * 1024 * 1024, 2.4 * 1024 ** 3, 3 * 1024 ** 4].map(sizeLabel)).toEqual([
      '0 B', '512 B', '40 KB', '1.1 MB', '18.3 MB', '2.4 GB', '3 TB'
    ]);
  });

  test('the stacked bar: table, indexes, TOAST in shares of the total; a part with bytes always shows; empty ones go', () => {
    const mb = 1024 * 1024;
    expect(sizeBar({ table: 11.2 * mb, indexes: 6.3 * mb, toast: 0.8 * mb })).toEqual([
      { part: 'table', bytes: 11.2 * mb, pct: 61.2 }, { part: 'indexes', bytes: 6.3 * mb, pct: 34.4 }, { part: 'toast', bytes: 0.8 * mb, pct: 4.4 }
    ]);
    const tiny = sizeBar({ table: 1000 * mb, indexes: 0, toast: 8192 });
    expect(tiny.map((p) => p.part)).toEqual(['table', 'toast']);
    expect(tiny[1]!.pct).toBe(2);
    expect(tiny.reduce((s, p) => s + p.pct, 0)).toBeCloseTo(100, 5);
    expect(sizeBar({ table: 0, indexes: 0, toast: 0 })).toEqual([]);
  });

  test('dead rows as a share of all rows; none known: null', () => {
    expect(deadShare({ estimate: 48210, dead: 587, lastAnalyze: null, lastVacuum: null })).toBe('1.2%');
    expect(deadShare({ estimate: 100, dead: 0, lastAnalyze: null, lastVacuum: null })).toBe('0%');
    expect(deadShare({ estimate: 0, dead: 3, lastAnalyze: null, lastVacuum: null })).toBe('100%');
    expect(deadShare({ estimate: 1_000_000, dead: 3, lastAnalyze: null, lastVacuum: null })).toBe('<0.1%');
    expect(deadShare({ estimate: null, dead: null, lastAnalyze: null, lastVacuum: null })).toBeNull();
  });

  test('"analyzed 2 h ago": seconds, minutes, hours, days', () => {
    const now = Date.parse('2026-11-06T12:00:00Z');
    const ago = (ms: number) => since(new Date(now - ms).toISOString(), now);
    expect([ago(2000), ago(30_000), ago(5 * 60_000), ago(2 * 3_600_000), ago(3 * 86_400_000)]).toEqual(['just now', '30 s ago', '5 min ago', '2 h ago', '3 d ago']);
    expect(since(null, now)).toBeNull();
  });
});

describe('constraints and triggers', () => {
  const c = (kind: DbConstraint['kind'], def: string): DbConstraint => ({ name: 'x', kind, def });

  test('the kind\'s words dimmed, the rest as Postgres wrote it', () => {
    expect(constraintParts(c('f', 'FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE RESTRICT'))).toEqual({ kw: 'FOREIGN KEY', rest: '(customer_id) REFERENCES customers(id) ON DELETE RESTRICT' });
    expect(constraintParts(c('p', 'PRIMARY KEY (id)'))).toEqual({ kw: 'PRIMARY KEY', rest: '(id)' });
    expect(constraintParts(c('u', 'UNIQUE (email)'))).toEqual({ kw: 'UNIQUE', rest: '(email)' });
    expect(constraintParts(c('c', 'CHECK ((total >= (0)::numeric))'))).toEqual({ kw: 'CHECK', rest: '((total >= (0)::numeric))' });
    expect(constraintParts(c('x', 'EXCLUDE USING gist (room WITH =, during WITH &&)'))).toEqual({ kw: 'EXCLUDE', rest: 'USING gist (room WITH =, during WITH &&)' });
  });

  test('a trigger: when and what it runs ("TRIGGER BEFORE UPDATE → set_updated_at()"), the whole definition otherwise', () => {
    expect(constraintParts(c('t', 'CREATE TRIGGER orders_set_updated_at BEFORE UPDATE ON public.orders FOR EACH ROW EXECUTE FUNCTION set_updated_at()')))
      .toEqual({ kw: 'TRIGGER BEFORE UPDATE', rest: '→ set_updated_at()' });
    expect(constraintParts(c('t', 'CREATE TRIGGER t AFTER INSERT OR DELETE ON s.t FOR EACH STATEMENT EXECUTE PROCEDURE audit(\'x\')')))
      .toEqual({ kw: 'TRIGGER AFTER INSERT OR DELETE', rest: "→ audit('x')" });
    expect(constraintParts(c('t', 'CREATE CONSTRAINT TRIGGER odd'))).toEqual({ kw: 'TRIGGER', rest: 'CREATE CONSTRAINT TRIGGER odd' });
  });
});

describe('the DDL\'s colors', () => {
  test('keywords, types, strings, numbers and comments; names and punctuation as they are; one line each', () => {
    const lines = sqlLines("CREATE TABLE public.orders (\n    status order_status DEFAULT 'pending'::order_status NOT NULL,\n    total numeric(10,2) DEFAULT 0 -- the sum\n);");
    expect(lines).toHaveLength(4);
    const kinds = (i: number) => lines[i]!.filter((t) => t.k !== 'ws').map((t) => [t.k, t.s]);
    expect(kinds(0)).toEqual([['kw', 'CREATE'], ['kw', 'TABLE'], ['id', 'public.orders'], ['p', '(']]);
    expect(kinds(1)).toEqual([['id', 'status'], ['id', 'order_status'], ['kw', 'DEFAULT'], ['str', "'pending'"], ['p', '::'], ['id', 'order_status'], ['kw', 'NOT'], ['kw', 'NULL'], ['p', ',']]);
    expect(kinds(2)).toEqual([['id', 'total'], ['type', 'numeric'], ['p', '('], ['num', '10'], ['p', ','], ['num', '2'], ['p', ')'], ['kw', 'DEFAULT'], ['num', '0'], ['com', '-- the sum']]);
    // Every character kept, in order.
    expect(lines.map((l) => l.map((t) => t.s).join('')).join('\n')).toBe("CREATE TABLE public.orders (\n    status order_status DEFAULT 'pending'::order_status NOT NULL,\n    total numeric(10,2) DEFAULT 0 -- the sum\n);");
  });

  test('a string or a quoted name over several lines, doubled quotes inside, a dollar-quoted body: kept whole', () => {
    const text = "COMMENT ON TABLE t IS 'it''s\nmulti';\nCREATE FUNCTION f() AS $function$\nselect 'x'\n$function$;";
    const lines = sqlLines(text);
    expect(lines.map((l) => l.map((t) => t.s).join('')).join('\n')).toBe(text);
    expect(lines[0]!.find((t) => t.k === 'str')?.s).toBe("'it''s");
    expect(lines[1]![0]).toEqual({ k: 'str', s: "multi'" });
    expect(lines[2]!.find((t) => t.k === 'str')?.s).toBe('$function$');
    expect(lines[3]).toEqual([{ k: 'str', s: "select 'x'" }]);
    const quoted = sqlLines('CREATE TABLE "Order ""Items""" (id int);');
    expect(quoted[0]!.find((t) => t.k === 'id' && t.s.startsWith('"'))?.s).toBe('"Order ""Items"""');
  });
});
