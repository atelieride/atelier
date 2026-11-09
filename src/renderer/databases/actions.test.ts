import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createElement, isValidElement, type ReactElement, type ReactNode } from 'react';
import { EMPTY_DB_SNAPSHOT, type DbActivity, type DbCell, type DbConnection, type DbOverview, type DbPage, type DbProblem, type DbRelations, type DbResult } from '@shared/databases';
import type { DbColumn } from '@shared/databases-filters';
import type { FormatOpts } from '@shared/pg-format';

// What the Databases view hands to Claude: Send to <session> through the Docker and
// Redis bars' paste (no Enter), Ask in a New Session named "db: <table>" as Redis's, Send Schema and Ask About This Table
// with the DDL and relations — the tab's own when its Structure view read them —, Overview's ✦ Ask Claude with the query
// as shown. A failed read says so; nothing waits silently.

vi.mock('../docker/actions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../docker/actions')>()),
  sendToSession: vi.fn(async () => {})
}));
vi.mock('../launch', () => ({ newSessionIn: vi.fn(async () => ({ id: 'term-new' })) }));
vi.mock('../task-session', async (importOriginal) => ({ ...(await importOriginal<typeof import('../task-session')>()), typeWhenReadyAs: vi.fn() }));

const docker = await import('../docker/actions');
const real = await vi.importActual<typeof import('../docker/actions')>('../docker/actions');
const { newSessionIn } = await import('../launch');
const { typeWhenReadyAs } = await import('../task-session');
const { useApp } = await import('../store');
const { t } = await import('../i18n/en');
const { useDb } = await import('./store');
const { useStruct } = await import('./structure-data');
const { gridColumns, hiddenColumns } = await import('./grid-model');
const { rowsAs } = await import('./grid-copy');
const { askQueryPrompt, askTablePrompt, rowsPrompt, schemaPrompt } = await import('./prompts');
const { maskForeignSql, NO_SAMPLES } = await import('./overview');
const { OverviewBody } = await import('./OverviewView');
const { askRows, askTable, overviewActions, sendRows, sendSchema } = await import('./actions');

const C = 'c0123456789ab';
const KEY = `db:${C}/public/orders`;
const REF = { connId: C, schema: 'public', name: 'orders' };
const conn = (o: Partial<DbConnection> = {}): DbConnection => ({
  id: C, name: 'acme_dev', engine: 'postgres', env: 'local', host: 'localhost', port: 5432, database: 'acme', user: 'me', tls: 'prefer', ssh: null,
  scope: { kind: 'all' }, mask: false, writeNoted: false, createdAt: 1, ...o
});
const col = (name: string, typeName: string, typeCat: string, o: Partial<DbColumn> = {}): DbColumn => ({
  name, type: typeName, typeSchema: 'pg_catalog', typeName, typeCat, isArray: false, nullable: true, isPk: false, isKey: false, ...o
});
const COLS = [col('id', 'int8', 'N', { isPk: true, isKey: true }), col('email', 'text', 'S')];
const PAGE: DbPage = {
  columns: COLS, hidden: [], derived: [], rows: [[{ v: '1' }, { v: 'a@x.test' }], [{ v: '2' }, { v: 'b@x.test' }]] as DbCell[][],
  ms: 3, sql: 'SELECT 1', pk: ['id'], rowKey: ['id'], kind: 'table'
};
const SRC = { columns: gridColumns(PAGE, 'public'), hidden: hiddenColumns(PAGE, 'public'), rows: PAGE.rows };
const O: FormatOpts = { times: 'stored', now: 0, masked: false, width: 'grid' };
/** The rows prompt's text for these rows (the sends' expected paste). */
function rowsText(src: typeof SRC, sel: number[]): string {
  const r = rowsPrompt({ conn: conn(), table: REF, src, sel, o: O });
  if (r.kind !== 'text') throw new Error(`no text: ${r.kind}`);
  return r.text;
}
const DDL = 'CREATE TABLE public.orders (\n    id bigint NOT NULL\n);\n';
const RELS: DbRelations = { out: [], in: [{ name: 'f', from: { schema: 'public', table: 'order_items', columns: ['order_id'] }, to: { schema: 'public', table: 'orders', columns: ['id'] }, indexed: true }] };
const ok = <T>(value: T): DbResult<T> => ({ ok: true, value });
const bad = (message: string): DbResult<never> => ({ ok: false, problem: { kind: 'denied', message } as DbProblem });
const settle = () => new Promise((r) => setTimeout(r, 0));
const TYPED = 'The public.orders context is in the prompt. Review it and press Enter to send.';

type Fn = ReturnType<typeof vi.fn>;
let api: { ddl: Fn; relations: Fn };
let toasts: unknown[][];
beforeEach(() => {
  api = { ddl: vi.fn(async () => ok(DDL)), relations: vi.fn(async () => ok(RELS)) };
  vi.stubGlobal('window', { atelier: { databases: api } });
  toasts = [];
  useApp.setState({ showToast: (...a: unknown[]) => { toasts.push(a); } } as never);
  useDb.setState({ loaded: true, snap: { ...EMPTY_DB_SNAPSHOT, connections: [{ conn: conn(), state: 'connected', problem: null, server: null, hasPassword: false, provider: null, held: false }] } });
  vi.mocked(docker.sendToSession).mockClear();
  vi.mocked(newSessionIn).mockClear();
  vi.mocked(typeWhenReadyAs).mockClear();
});
afterEach(() => {
  vi.unstubAllGlobals();
  useStruct.setState(useStruct.getInitialState(), true);
  useDb.setState(useDb.getInitialState(), true);
  useApp.setState(useApp.getInitialState(), true);
});

describe('rows (the grid: ⌥↩, the action bar, the cell menu)', () => {
  test('Send: the rows prompt, pasted into the target session by the Docker and Redis bars\' paste', () => {
    sendRows(REF, SRC, [1, 0], O);
    expect(docker.sendToSession).toHaveBeenCalledWith(rowsText(SRC, [1, 0]));
  });

  test('nothing loaded among the rows asked: said, nothing pasted, no session started (no silent path)', async () => {
    sendRows(REF, SRC, [7], O);
    await askRows(REF, SRC, [], O);
    expect(docker.sendToSession).not.toHaveBeenCalled();
    expect(newSessionIn).not.toHaveBeenCalled();
    expect(toasts.map((x) => x[0])).toEqual(['Nothing loaded to send', 'Nothing loaded to send']);
  });

  test('a first row over 512 KB is refused — Send, ⌥↩ and Ask alike —, its size said, Copy at hand', async () => {
    const huge = { ...SRC, rows: [[{ v: '1' }, { v: 'a'.repeat(640 * 1024) }], ...SRC.rows] as DbCell[][] };
    sendRows(REF, huge, [0, 1], O);
    await askRows(REF, huge, [0], O);
    expect(docker.sendToSession).not.toHaveBeenCalled();
    expect(newSessionIn).not.toHaveBeenCalled();
    expect(api.ddl).not.toHaveBeenCalled();
    expect(toasts.map((x) => x[0])).toEqual(['This row is too large to send (640 KB) — Copy it instead', 'This row is too large to send (640 KB) — Copy it instead']);
    // Copy: the row as Copy Row as JSON writes it, whole.
    const clip = vi.fn(async () => true);
    vi.stubGlobal('window', { atelier: { databases: api, clipboard: { write: clip } } });
    const action = toasts[0]![1] as { label: string; run(): void };
    expect(action.label).toBe('Copy');
    action.run();
    await settle();
    expect(clip).toHaveBeenCalledWith(rowsAs(huge, [0], 'json', REF, O));
  });

  test('Send with no session to paste into: the toast says so, its Copy keeps the text (the Docker and Redis wording)', async () => {
    vi.mocked(docker.sendToSession).mockImplementationOnce(real.sendToSession);
    sendRows(REF, SRC, [0], O);
    await settle();
    expect(toasts).toHaveLength(1);
    expect(toasts[0]![0]).toBe(t.docker.noSession);
    expect(toasts[0]![0]).toBe('No Claude session to send to: start one first.');
    expect(toasts[0]![1]).toMatchObject({ label: 'Copy' });
  });

  test('Ask in a New Session: a session "db: <table>", the rows then the table\'s DDL typed in (not sent) — the Structure view\'s DDL when read', async () => {
    useStruct.setState({ tabs: { [KEY]: { ddl: { id: 1, loading: false, v: DDL } } } });
    await askRows(REF, SRC, [0], O, KEY);
    expect(api.ddl).not.toHaveBeenCalled();
    expect(newSessionIn).toHaveBeenCalledWith('db: orders');
    const rows = rowsText(SRC, [0]);
    expect(typeWhenReadyAs).toHaveBeenCalledWith('term-new', askTablePrompt({ conn: conn(), table: REF, ddl: DDL, rows }), false, TYPED);
  });

  test('Ask in a New Session: the DDL read by the table\'s names when the tab has none; the rows are the ones asked at the press', async () => {
    // Its own rows (never the shared fixture's): one is changed while the DDL is read.
    const local = { ...SRC, rows: SRC.rows.map((r) => [...r]) };
    const asked = askRows(REF, local, [1], O);
    // The rows are read at the press: what changes while the DDL comes doesn't change what goes.
    const rows = rowsText(local, [1]);
    local.rows[1]![1] = { v: 'changed@x.test' };
    await asked;
    expect(api.ddl).toHaveBeenCalledWith(REF);
    expect(vi.mocked(typeWhenReadyAs).mock.calls[0]![1]).toBe(askTablePrompt({ conn: conn(), table: REF, ddl: DDL, rows }));
  });

  test('Ask in a New Session with the DDL unreadable: the rows go alone, and a toast says why', async () => {
    api.ddl.mockResolvedValueOnce(bad('permission denied for table orders'));
    await askRows(REF, SRC, [0], O);
    expect(toasts[0]![0]).toBe('Couldn’t read the DDL of public.orders (permission denied for table orders): the rows went without it');
    expect(vi.mocked(typeWhenReadyAs).mock.calls[0]![1]).toBe(rowsText(SRC, [0]));
  });

  test('a connection no longer known (removed meanwhile): nothing goes, and a toast says so', async () => {
    useDb.setState({ snap: EMPTY_DB_SNAPSHOT });
    sendRows(REF, SRC, [0], O);
    await askRows(REF, SRC, [0], O);
    expect(docker.sendToSession).not.toHaveBeenCalled();
    expect(newSessionIn).not.toHaveBeenCalled();
    expect(toasts.map((x) => x[0])).toEqual(['This connection isn’t available here', 'This connection isn’t available here']);
  });
});

describe('the schema (Structure\'s DDL card, the sidebar\'s table menu)', () => {
  test('Send Schema: the DDL and the relations read by the table\'s names, sent with the paste', async () => {
    await sendSchema(REF);
    expect(api.ddl).toHaveBeenCalledWith(REF);
    expect(api.relations).toHaveBeenCalledWith(REF);
    expect(docker.sendToSession).toHaveBeenCalledWith(schemaPrompt({ conn: conn(), table: REF, ddl: DDL, rel: RELS }));
  });

  test('Send Schema from a tab whose Structure view read them: those (what is on screen), nothing read again', async () => {
    const shown = 'CREATE TABLE public.orders ();\n';
    useStruct.setState({ tabs: { [KEY]: { ddl: { id: 1, loading: false, v: shown }, relations: { id: 2, loading: false, v: { out: [], in: [] } } } } });
    await sendSchema(REF, KEY);
    expect(api.ddl).not.toHaveBeenCalled();
    expect(api.relations).not.toHaveBeenCalled();
    expect(docker.sendToSession).toHaveBeenCalledWith(schemaPrompt({ conn: conn(), table: REF, ddl: shown, rel: { out: [], in: [] } }));
  });

  test('a failed DDL read: a toast with the problem, nothing sent (never silent)', async () => {
    api.ddl.mockResolvedValueOnce(bad('permission denied for table orders'));
    await sendSchema(REF);
    expect(docker.sendToSession).not.toHaveBeenCalled();
    expect(toasts.map((x) => x[0])).toEqual(['Couldn’t read the DDL of public.orders: permission denied for table orders']);
  });

  test('a call that never reached main: the same toast with its words', async () => {
    api.ddl.mockRejectedValueOnce(new Error('ipc gone'));
    await sendSchema(REF);
    expect(docker.sendToSession).not.toHaveBeenCalled();
    expect(toasts[0]![0]).toBe('Couldn’t read the DDL of public.orders: Couldn’t read the table');
  });

  test('the relations unreadable: the DDL goes alone, a toast says the relations didn\'t', async () => {
    api.relations.mockResolvedValueOnce(bad('canceled'));
    await sendSchema(REF);
    expect(docker.sendToSession).toHaveBeenCalledWith(schemaPrompt({ conn: conn(), table: REF, ddl: DDL, rel: null }));
    expect(toasts.map((x) => x[0])).toEqual(['Couldn’t read the relations of public.orders (canceled): the DDL went without them']);
  });

  test('Ask About This Table: a session "db: <table>" with the DDL and relations typed in', async () => {
    await askTable(REF);
    expect(newSessionIn).toHaveBeenCalledWith('db: orders');
    expect(typeWhenReadyAs).toHaveBeenCalledWith('term-new', askTablePrompt({ conn: conn(), table: REF, ddl: DDL, rel: RELS }), false, TYPED);
  });

  test('Ask About This Table with the DDL unreadable: a toast, no session started', async () => {
    api.ddl.mockResolvedValueOnce(bad('permission denied for table orders'));
    await askTable(REF);
    expect(newSessionIn).not.toHaveBeenCalled();
    expect(toasts[0]![0]).toBe('Couldn’t read the DDL of public.orders: permission denied for table orders');
  });
});

describe('Overview\'s ✦ Ask Claude', () => {
  const ACT: DbActivity = { pid: 48213, role: 'app', app: 'api-worker', state: 'active', seconds: 72, query: "SELECT id FROM audit_log WHERE payload->>'actor' = 'jane@acme.test'", ours: false };

  test('a session "db: <connection> pid <pid>" with the query as given', async () => {
    overviewActions(C).ask!(ACT, ACT.query!);
    await settle();
    expect(newSessionIn).toHaveBeenCalledWith('db: acme_dev pid 48213');
    expect(typeWhenReadyAs).toHaveBeenCalledWith('term-new', askQueryPrompt({ conn: conn(), activity: ACT, query: ACT.query! }), false,
      'The pid 48213 context is in the prompt. Review it and press Enter to send.');
  });

  test('pressed on the overview with Mask values on: the query typed in is the masked one shown — the text sent is the text shown', async () => {
    useDb.setState({ snap: { ...EMPTY_DB_SNAPSHOT, connections: [{ conn: conn({ mask: true }), state: 'connected', problem: null, server: null, hasPassword: false, provider: null, held: false }] } });
    const data: DbOverview = {
      server: { version: '17.2', versionNum: 170002, tls: true, role: 'app', canWrite: false, latencyMs: 3 }, uptimeSec: 3600, sizeBytes: 1024,
      connections: { total: 1, max: 100, active: 1, idleInTx: 0 }, cacheHit: 0.99, longest: null, xacts: 10, biggest: [], schemas: [], extensions: [],
      activity: [ACT], slowest: null, at: 1
    };
    const el = createElement(OverviewBody, {
      conn: conn({ mask: true }), view: null, st: { data, problem: null, samples: NO_SAMPLES }, held: false, width: 1180,
      actions: overviewActions(C), onRetry: () => {}, onConnect: () => {}, onMask: () => {}
    });
    const btn = hosts(el).find((e) => e.props.className === 'dbo-ask')!;
    (btn.props.onClick as () => void)();
    await settle();
    const prompt = vi.mocked(typeWhenReadyAs).mock.calls[0]![1];
    expect(prompt).toContain(maskForeignSql(ACT.query!));
    expect(prompt).not.toContain('jane@acme.test');
  });
});

type Host = ReactElement<Record<string, unknown>>;
/** The host elements of a tree, function components called (OverviewBody's parts use no hooks): their handlers. */
function hosts(node: ReactNode, out: Host[] = []): Host[] {
  if (Array.isArray(node)) {
    for (const n of node) hosts(n as ReactNode, out);
    return out;
  }
  if (!isValidElement(node)) return out;
  const el = node as Host;
  if (typeof el.type === 'function') return hosts((el.type as (p: unknown) => ReactNode)(el.props), out);
  if (typeof el.type === 'string') out.push(el);
  return hosts(el.props.children as ReactNode, out);
}
