import { describe, expect, test } from 'vitest';
import type { DbActivity, DbCell, DbConnection, DbFk, DbPage, DbRelations } from '@shared/databases';
import type { DbColumn } from '@shared/databases-filters';
import type { FormatOpts } from '@shared/pg-format';
import { cutCount, jsonObject, rowsAs, type GridSource } from './grid-copy';
import { gridColumns, hiddenColumns } from './grid-model';
import { maskForeignSql } from './overview';
import { askQueryPrompt, askTablePrompt, BYTES_MAX, ROW_CEILING, ROWS_MAX, rowsPrompt, schemaPrompt } from './prompts';

// What goes to Claude: the rows as Copy as JSON writes them (lossless, masked
// with Mask values on), at most 100 rows and 200 KB; the DDL with the relations; a running query as shown.
// Nothing is filtered: what is on screen is what is sent.

const col = (name: string, typeName: string, typeCat: string, o: Partial<DbColumn> = {}): DbColumn => ({
  name, type: typeName, typeSchema: 'pg_catalog', typeName, typeCat, isArray: false, nullable: true, isPk: false, isKey: false, ...o
});
const ID = col('id', 'int8', 'N', { type: 'bigint', isPk: true, isKey: true });
const EMAIL = col('email', 'text', 'S');
const TOTAL = col('total', 'numeric', 'N');
const META = col('meta', 'jsonb', 'U');
const NOTE = col('note', 'text', 'S');

const O: FormatOpts = { times: 'stored', now: Date.UTC(2026, 10, 5), masked: false, width: 'grid' };
const MASKED: FormatOpts = { ...O, masked: true };
const c = (v: string | null, cut?: number): DbCell => (cut === undefined ? { v } : { v, cut });
const ORDERS = { schema: 'public', name: 'orders' };
const conn = (o: Partial<DbConnection> = {}): DbConnection => ({
  id: 'c0123456789ab', name: 'acme_dev', engine: 'postgres', env: 'local', host: 'localhost', port: 5432, database: 'acme', user: 'me', tls: 'prefer',
  ssh: null, scope: { kind: 'all' }, mask: false, writeNoted: false, createdAt: 1, ...o
});

function page(columns: DbColumn[], rows: (string | null)[][], o: Partial<DbPage> = {}): DbPage {
  return { columns, hidden: [], derived: [], rows: rows.map((r) => r.map((v) => c(v))), ms: 3, sql: 'SELECT 1', pk: ['id'], kind: 'table', ...o, rowKey: o.rowKey ?? o.pk ?? ['id'] };
}
const src = (p: DbPage): GridSource => ({ columns: gridColumns(p, 'public'), hidden: hiddenColumns(p, 'public'), rows: p.rows });
const utf8 = (s: string) => new TextEncoder().encode(s).length;
/** The fenced JSON of a prompt (between its ```json line and the closing fence). */
const fenced = (p: string) => /```json\n([\s\S]*?)\n```/.exec(p)?.[1] ?? '';
/** A rows prompt with text (the usual case here); refused or empty ones are tested apart. */
function txt(a: Parameters<typeof rowsPrompt>[0]): string {
  const r = rowsPrompt(a);
  if (r.kind !== 'text') throw new Error(`no text: ${r.kind}`);
  return r.text;
}

describe('rowsPrompt (Send to <session>)', () => {
  const ROW = ['10482', 'jane@acme.test', '1240.50', '{"plan": "pro", "seats": 12345678901234567890}'];
  const p = page([ID, EMAIL, TOTAL, META], [ROW]);

  test('a fixture row, exactly: the connection and its environment, the table, the row count, a fenced JSON array', () => {
    expect(txt({ conn: conn(), table: ORDERS, src: src(p), sel: [0], o: O })).toBe([
      'From acme_dev (Local) · public.orders, 1 row:',
      '```json',
      '[',
      '  {',
      '    "id": 10482,',
      '    "email": "jane@acme.test",',
      '    "total": 1240.50,',
      '    "meta": {"plan": "pro", "seats": 12345678901234567890}',
      '  }',
      ']',
      '```'
    ].join('\n'));
  });

  test('the environment as the connection sheet names it: production says so (no confirm: the label is the cue)', () => {
    const out = txt({ conn: conn({ name: 'acme', env: 'prod' }), table: ORDERS, src: src(p), sel: [0], o: O });
    expect(out.split('\n')[0]).toBe('From acme (Production) · public.orders, 1 row:');
    expect(txt({ conn: conn({ env: 'dev' }), table: ORDERS, src: src(p), sel: [0], o: O }).split('\n')[0]).toContain('(Development)');
    expect(txt({ conn: conn({ env: 'staging' }), table: ORDERS, src: src(p), sel: [0], o: O }).split('\n')[0]).toContain('(Staging)');
  });

  test('more rows: exactly what Copy as JSON gives, in the grid\'s order whatever the selection\'s order', () => {
    const two = page([ID, EMAIL, NOTE], [['1', 'a@x.test', 'one'], ['2', 'b@x.test', null], ['3', 'c@x.test', 'three']]);
    const out = txt({ conn: conn(), table: ORDERS, src: src(two), sel: [2, 0, 2], o: O });
    expect(out.split('\n')[0]).toBe('From acme_dev (Local) · public.orders, 2 rows:');
    expect(fenced(out)).toBe(rowsAs(src(two), [0, 2], 'json', ORDERS, O));
    expect(JSON.parse(fenced(out)).map((r: { id: number }) => r.id)).toEqual([1, 3]);
  });

  test('Mask values on: the masks are sent — a masked column\'s dots, a secret key inside JSON — the rest as printed', () => {
    const q = page([ID, EMAIL, META], [['7', 'jane@acme.test', '{"api_key": "s3cr3t", "n": 12345678901234567890}']]);
    const out = txt({ conn: conn({ mask: true }), table: ORDERS, src: src(q), sel: [0], o: MASKED });
    expect(out).not.toContain('jane@acme.test');
    expect(out).not.toContain('s3cr3t');
    expect(out).toContain('"email": "••••••••"');
    expect(out).toContain('"meta": {"api_key": "••••••••", "n": 12345678901234567890}');
    // Off: nothing filtered (no redactSecrets).
    const plain = txt({ conn: conn(), table: ORDERS, src: src(q), sel: [0], o: O });
    expect(plain).toContain('"email": "jane@acme.test"');
    expect(plain).toContain('"api_key": "s3cr3t"');
  });

  test('a JSON column (a key path) goes as JSON, lossless: an integer past 2^53 stays exact', () => {
    const q = page([ID], [['1']], { derived: [{ column: 'meta', path: ['limits'] }] });
    q.rows[0]!.push(c('{"seats": 9007199254740993, "ids": [12345678901234567890]}'));
    const out = txt({ conn: conn(), table: ORDERS, src: src(q), sel: [0], o: O });
    expect(out).toContain('"meta.limits": {"seats": 9007199254740993, "ids": [12345678901234567890]}');
    expect(out).not.toContain('9007199254740992');
  });

  test('the columns as shown: a key kept only to name the row is not sent', () => {
    const q = page([EMAIL, NOTE, ID], [['a@x.test', 'hi', '1']], { hidden: ['id'] });
    const out = txt({ conn: conn(), table: ORDERS, src: src(q), sel: [0], o: O });
    expect(JSON.parse(fenced(out))).toEqual([{ email: 'a@x.test', note: 'hi' }]);
  });

  test(`${ROWS_MAX + 1} rows: the first ${ROWS_MAX} go, and the header says so`, () => {
    const many = page([ID, NOTE], Array.from({ length: 101 }, (_, i) => [String(i + 1), `row ${i + 1}`]));
    const out = txt({ conn: conn(), table: ORDERS, src: src(many), sel: many.rows.map((_, i) => i), o: O });
    expect(out.split('\n')[0]).toBe('From acme_dev (Local) · public.orders, 101 rows (first 100 rows):');
    const sent = JSON.parse(fenced(out)) as { id: number }[];
    expect(sent).toHaveLength(100);
    expect(sent.at(-1)!.id).toBe(100);
    // 100 exactly: no note.
    expect(txt({ conn: conn(), table: ORDERS, src: src(many), sel: many.rows.slice(0, 100).map((_, i) => i), o: O }).split('\n')[0])
      .toBe('From acme_dev (Local) · public.orders, 100 rows:');
  });

  test('200 KB at most (UTF-8 bytes, not characters): the rows that fit go, the header says how many', () => {
    // 'é' is two bytes: 40,000 bytes a row. Counting characters, ten would fit; in bytes, five.
    const big = page([ID, NOTE], Array.from({ length: 12 }, (_, i) => [String(i + 1), 'é'.repeat(20_000)]));
    const out = txt({ conn: conn(), table: ORDERS, src: src(big), sel: big.rows.map((_, i) => i), o: O });
    expect(out.split('\n')[0]).toBe('From acme_dev (Local) · public.orders, 12 rows (first 5 rows):');
    expect(JSON.parse(fenced(out))).toHaveLength(5);
    expect(utf8(fenced(out))).toBeLessThanOrEqual(BYTES_MAX);
    expect(BYTES_MAX).toBe(200 * 1024);
  });

  test('a first row over 200 KB alone still goes (a row is the unit), said as the first 1 row', () => {
    const wide = page([ID, NOTE, EMAIL, META], [['1', 'a'.repeat(150_000), 'b'.repeat(80_000), null], ['2', 'x', 'y', null]]);
    const out = txt({ conn: conn(), table: ORDERS, src: src(wide), sel: [0, 1], o: O });
    expect(out.split('\n')[0]).toBe('From acme_dev (Local) · public.orders, 2 rows (first 1 row):');
    expect(JSON.parse(fenced(out))).toHaveLength(1);
  });

  test('values cut at 64 KB: one line says how many (of the rows sent; masked ones carry dots, not a cut value)', () => {
    const q = page([ID, NOTE, EMAIL], [['7', null, 'a@x.test'], ['8', null, 'b@x.test']]);
    q.rows[0]![1] = c('x'.repeat(10), 70_000);
    q.rows[1]![1] = c('y'.repeat(10), 90_000);
    q.rows[1]![2] = c('b@x.test', 80_000);
    const one = txt({ conn: conn(), table: ORDERS, src: src(q), sel: [0], o: O });
    expect(one.endsWith('```\n1 value was cut at 64 KB')).toBe(true);
    const all = txt({ conn: conn(), table: ORDERS, src: src(q), sel: [0, 1], o: O });
    expect(all.endsWith('```\n3 values were cut at 64 KB')).toBe(true);
    expect(cutCount(src(q), [0, 1], 'json', O)).toBe(3);
    const masked = txt({ conn: conn({ mask: true }), table: ORDERS, src: src(q), sel: [0, 1], o: MASKED });
    expect(masked.endsWith('```\n2 values were cut at 64 KB')).toBe(true);
    // None cut: no line.
    expect(txt({ conn: conn(), table: ORDERS, src: src(p), sel: [0], o: O }).endsWith('```')).toBe(true);
  });

  test('a value holding a fence: the fence grows past it, so the JSON stays one block', () => {
    const q = page([ID, NOTE], [['1', 'see ```sql\nSELECT 1\n``` and ````']]);
    const out = txt({ conn: conn(), table: ORDERS, src: src(q), sel: [0], o: O });
    expect(out.split('\n')[1]).toBe('`````json');
    expect(out.endsWith('\n`````')).toBe(true);
  });

  test('nothing loaded among the rows asked: nothing to send (said, never a silent empty paste)', () => {
    expect(rowsPrompt({ conn: conn(), table: ORDERS, src: src(p), sel: [], o: O })).toEqual({ kind: 'none' });
    expect(rowsPrompt({ conn: conn(), table: ORDERS, src: src(p), sel: [5], o: O })).toEqual({ kind: 'none' });
  });

  test(`a first row over ${ROW_CEILING / 1024} KB (UTF-8) is refused — its size said — whatever follows it`, () => {
    expect(ROW_CEILING).toBe(512 * 1024);
    const huge = page([ID, NOTE], [['1', 'a'.repeat(640 * 1024)], ['2', 'small']]);
    const r = rowsPrompt({ conn: conn(), table: ORDERS, src: src(huge), sel: [0, 1], o: O });
    expect(r.kind).toBe('tooLarge');
    // The row's JSON as Copy Row as JSON writes it inside the array: the value and its name, quotes and indent.
    expect(r.kind === 'tooLarge' && r.bytes).toBe(utf8(jsonObject(src(huge), 0, O)));
    expect(r.kind === 'tooLarge' && r.bytes).toBeGreaterThan(ROW_CEILING);
    // In bytes: 300,000 two-byte characters are 600,000 bytes, over the ceiling though 300,000 characters aren't.
    const wide = page([ID, NOTE], [['1', 'é'.repeat(300_000)]]);
    expect(rowsPrompt({ conn: conn(), table: ORDERS, src: src(wide), sel: [0], o: O }).kind).toBe('tooLarge');
    // Under the ceiling, a first row over 200 KB still goes alone (the test above).
    expect(rowsPrompt({ conn: conn(), table: ORDERS, src: src(huge), sel: [1], o: O }).kind).toBe('text');
  });

  test('control characters 0x7f–0x9f in text values go escaped: valid JSON, kept whole by any paste sanitizer', () => {
    const q = page([ID, NOTE], [['1', 'a\u007fb\u0085c\u009fd']]);
    const out = txt({ conn: conn(), table: ORDERS, src: src(q), sel: [0], o: O });
    expect(out).toContain('"note": "a\\u007fb\\u0085c\\u009fd"');
    expect(out).not.toMatch(/[\u007f-\u009f]/);
    expect(JSON.parse(fenced(out))[0].note).toBe('a\u007fb\u0085c\u009fd');
  });
});

const fk = (from: [string, string, string[]], to: [string, string, string[]], indexed = true): DbFk => ({
  name: `${from[1]}_${from[2].join('_')}_fkey`, from: { schema: from[0], table: from[1], columns: from[2] }, to: { schema: to[0], table: to[1], columns: to[2] }, indexed
});
const DDL = "CREATE TABLE public.orders (\n    id bigint NOT NULL,\n    customer_id bigint NOT NULL,\n    status text DEFAULT 'pending'::text NOT NULL\n);\n";
const RELS: DbRelations = {
  out: [fk(['public', 'orders', ['customer_id']], ['public', 'customers', ['id']])],
  in: [fk(['public', 'order_items', ['order_id']], ['public', 'orders', ['id']], false), fk(['billing', 'refunds', ['order_id', 'line']], ['public', 'orders', ['id', 'line']])]
};
const SCHEMA = [
  'From acme_dev (Local) · public.orders, its DDL and relations:',
  '```sql',
  'CREATE TABLE public.orders (',
  '    id bigint NOT NULL,',
  '    customer_id bigint NOT NULL,',
  "    status text DEFAULT 'pending'::text NOT NULL",
  ');',
  '```',
  'References:',
  '- public.orders (customer_id) → public.customers (id)',
  'Referenced by:',
  '- public.order_items (order_id) → public.orders (id), no index on public.order_items (order_id)',
  '- billing.refunds (order_id, line) → public.orders (id, line)'
].join('\n');

describe('schemaPrompt (Send Schema to <session>)', () => {
  test('the DDL as Postgres gives it, then the relations both ways, one line each', () => {
    expect(schemaPrompt({ conn: conn(), table: ORDERS, ddl: DDL, rel: RELS })).toBe(SCHEMA);
  });

  test('no foreign key either way: said in one line; relations unknown (their read failed): the DDL alone', () => {
    const none = schemaPrompt({ conn: conn(), table: ORDERS, ddl: DDL, rel: { out: [], in: [] } });
    expect(none.endsWith('```\nNo foreign keys point to or from it.')).toBe(true);
    const alone = schemaPrompt({ conn: conn({ env: 'prod' }), table: ORDERS, ddl: DDL, rel: null });
    expect(alone.split('\n')[0]).toBe('From acme_dev (Production) · public.orders, its DDL:');
    expect(alone.endsWith(');\n```')).toBe(true);
  });

  test('Ask About This Table starts with the same text', () => {
    expect(askTablePrompt({ conn: conn(), table: ORDERS, ddl: DDL, rel: RELS })).toBe(SCHEMA);
  });
});

describe('askTablePrompt with rows (Ask in New Session, the table, its DDL and the rows)', () => {
  const p = page([ID, NOTE], [['1', 'hello']]);
  test('the rows as Send gives them, then the table\'s DDL', () => {
    const rows = txt({ conn: conn(), table: ORDERS, src: src(p), sel: [0], o: O });
    expect(askTablePrompt({ conn: conn(), table: ORDERS, ddl: DDL, rows })).toBe(`${rows}\n\nThe DDL of public.orders:\n\`\`\`sql\n${DDL.trimEnd()}\n\`\`\``);
  });

  test('the DDL unknown (its read failed): the rows alone', () => {
    const rows = txt({ conn: conn(), table: ORDERS, src: src(p), sel: [0], o: O });
    expect(askTablePrompt({ conn: conn(), table: ORDERS, ddl: null, rows })).toBe(rows);
  });

  test('no rows and no DDL is not a prompt: the signature refuses it', () => {
    // Checked by `npm run typecheck`: an unused @ts-expect-error fails it.
    // @ts-expect-error — Ask About This Table needs the DDL.
    const bad = () => askTablePrompt({ conn: conn(), table: ORDERS, ddl: null, rel: null });
    // @ts-expect-error — relations go with Ask About This Table only (an Ask on rows carries the DDL alone).
    const mixed = () => askTablePrompt({ conn: conn(), table: ORDERS, ddl: DDL, rel: RELS, rows: 'x' });
    expect([typeof bad, typeof mixed]).toEqual(['function', 'function']);
  });
});

describe('askQueryPrompt (Overview\'s ✦ Ask Claude)', () => {
  const act = (o: Partial<DbActivity> = {}): DbActivity => ({
    pid: 48213, role: 'app', app: 'api-worker', state: 'active', seconds: 72, query: "SELECT id FROM audit_log WHERE payload->>'actor' = 'jane@acme.test'", ours: false, ...o
  });

  test('the query as shown — masked with Mask values on — how long it has run, who runs it, and the question', () => {
    const shown = maskForeignSql(act().query!);
    expect(askQueryPrompt({ conn: conn({ name: 'acme', env: 'prod' }), activity: act(), query: shown })).toBe([
      'From acme (Production) · a query active for 1m 12s (pid 48213, role app, application api-worker):',
      '```sql',
      "SELECT id FROM audit_log WHERE payload->>'••••' = '••••'",
      '```',
      'Why is this query taking so long, and what would make it faster?'
    ].join('\n'));
  });

  test('no role or application known: left out', () => {
    const out = askQueryPrompt({ conn: conn(), activity: act({ role: '', app: '' }), query: 'SELECT pg_sleep(30)' });
    expect(out.split('\n')[0]).toBe('From acme_dev (Local) · a query active for 1m 12s (pid 48213):');
  });
});
