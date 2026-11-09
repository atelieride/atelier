// A table tab's rows: rows load as you scroll — the first fetch brings Settings › Rows per fetch, each next one is appended when the scroll comes within
// two screens of the last loaded row, one in flight at a time, never past MAX_LOADED_ROWS nor MAX_LOADED_BYTES of
// values; changing the request (filters, sort, columns, JSON columns) or Refresh starts again from the top, and a reply
// for an older request is dropped. Never a fetch of everything, never a count(*) unless Count exactly is pressed. Plus
// the footer's label. Lazy: it ships with the table's chunk; the view's own decisions are table-view.ts.
import { DB_SLOT_MAX, type DbCell, type DbFilteredRef, type DbPage, type DbPageRequest, type DbProblem, type DbRelKind, type DbResult } from '@shared/databases';
import { tdt } from '../i18n/db-table';
import { useApp } from '../store';
import { isHeld } from './hold';
import { useDb, type DbTabState } from './store';
import type { DbTabRef } from './tabs';

/** Loaded rows per tab, at most: past that the last row asks for a filter or a sort. */
export const MAX_LOADED_ROWS = 10_000;
/** Loaded values per tab, at most: their text as UTF-16, 2 bytes a character. */
export const MAX_LOADED_BYTES = 64 * 1024 * 1024;
/** At 10,000 rows with a full last fetch, one small read past them says whether there are more. */
const PROBE_SIZE = 50;

export type FetchSize = 50 | 100 | 250 | 500;
const SIZES: readonly FetchSize[] = [50, 100, 250, 500];

/** Settings › Rows per fetch as the size main's schema takes; 100 for anything else. */
export function fetchSize(setting: string): FetchSize {
  return SIZES.find((n) => String(n) === setting) ?? 100;
}

const nameRef = (ref: DbTabRef) => ({ connId: ref.connId, schema: ref.schema, name: ref.name });

/**
 * The tab's slot: its key, so main drops a request of this tab still waiting in the connection's line when
 * a newer one of the same kind comes. A key past DB_SLOT_MAX sends none — no key at all, never
 * `slot: undefined`.
 */
const slotOf = (ref: DbTabRef): { slot?: string } => (ref.key.length <= DB_SLOT_MAX ? { slot: ref.key } : {});

/**
 * The request for one fetch, built key for key (main's schemas are strict: no extra key, no `path: undefined`) out of
 * copies (the tab's state is frozen; the schemas take mutable shapes). Every column is `[]`; chosen ones are listed.
 */
export function pageRequest(ref: DbTabRef, st: DbTabState, size: number, page: number): DbPageRequest {
  return {
    ref: nameRef(ref),
    columns: st.columns ? [...st.columns] : [],
    derived: st.derived.map((d) => ({ column: d.column, path: [...d.path] })),
    filters: filtersOf(st),
    sort: st.sort.map((s) => ({ column: s.column, ...(s.path ? { path: [...s.path] } : {}), dir: s.dir })),
    page,
    size,
    ...slotOf(ref)
  };
}

function filtersOf(st: DbTabState): DbFilteredRef['filters'] {
  return st.filters.map((f) => ({ column: f.column, ...(f.path ? { path: [...f.path] } : {}), op: f.op, values: [...f.values] }));
}

/** What the estimate and Count exactly read: the table and the filters (and the tab's slot). */
export function filteredRef(ref: DbTabRef, st: DbTabState): DbFilteredRef {
  return { ref: nameRef(ref), filters: filtersOf(st), ...slotOf(ref) };
}

/**
 * Main dropped this request for a newer one of the same tab: never said — the newer one answers. Every
 * caller drops it already by its run id, except Count exactly pressed again while the first waited.
 */
export const superseded = (p: DbProblem): boolean => p.kind === 'canceled' && p.message === 'Superseded';

const api = () => window.atelier.databases;
const db = () => useDb.getState();
const patch = (key: string, p: Partial<DbTabState>) => db().patchTab(key, p);

/**
 * Run ids: every first fetch takes the next one, and every reply (first, more, the probe, the estimate, a count) is
 * checked against the tab's. Only ever up — a tab closed and opened again starts from DEFAULT_TAB's 0, and must never
 * take the old tab's replies for its own.
 */
let seq = 0;

/** An open table tab (never the overview), or null. */
function tableRef(key: string): DbTabRef | null {
  const ref = useApp.getState().dbTabs.find((r) => r.key === key);
  return ref && ref.kind !== 'overview' ? ref : null;
}

/**
 * A read through main, for a tab of connection `connId`. Main connects on demand, and a read the user causes on a
 * connection
 * main holds (an explicit Disconnect) is their Connect: connected first — main lets the hold go
 * for every window, its snapshot comes before the reply —, then read; a connect that fails answers for the read (one
 * attempt, nothing sent behind it). The only reads that must not connect by themselves — a tab's first show, the
 * overview's polling — never get here while held (table-view.ts shouldLoad, OverviewPoller). One that never got to main
 * (rejected) answers as a problem: nothing waits forever.
 */
export async function ask<T>(connId: string, call: () => Promise<DbResult<T>>): Promise<DbResult<T>> {
  try {
    if (isHeld(connId)) {
      const c = await api().connect(connId);
      if (!c.ok) return c;
    }
    return await call();
  } catch {
    return { ok: false, problem: { kind: 'other', message: tdt.readFailed } };
  }
}

/**
 * A read the app makes by itself after one of theirs (the estimate after a page, the probe past 10,000 rows): never
 * theirs
 * Connect. Held meanwhile, main answers it
 * kind 'held' without contacting anything; the caller drops that quietly (isHeldAnswer).
 */
async function askAuto<T>(call: () => Promise<DbResult<T>>): Promise<DbResult<T>> {
  try {
    return await call();
  } catch {
    return { ok: false, problem: { kind: 'other', message: tdt.readFailed } };
  }
}

const isHeldAnswer = (r: DbResult<unknown>): boolean => !r.ok && r.problem.kind === 'held';

/**
 * A restored tab's kind ('table' until known) corrected from a reply. Sets the app store only when it
 * changes: a page arriving for a tab already right re-renders nothing.
 */
export function setDbKind(key: string, kind: DbRelKind): void {
  const tabs = useApp.getState().dbTabs;
  if (!tabs.some((r) => r.key === key && r.kind !== 'overview' && r.kind !== kind)) return;
  useApp.setState({ dbTabs: tabs.map((r) => (r.key === key ? { ...r, kind } : r)) });
}

/** The loaded values' weight: their text as UTF-16, 2 bytes a character; a NULL weighs nothing. */
export function valueBytes(rows: readonly (readonly DbCell[])[]): number {
  let n = 0;
  for (const row of rows) for (const c of row) n += c.v === null ? 0 : c.v.length;
  return n * 2;
}

// Each loaded rows array's weight, kept as fetches append (rows arrays are never changed in place: a new one each time).
const weights = new WeakMap<readonly (readonly DbCell[])[], number>();
const weightOf = (rows: readonly (readonly DbCell[])[]): number => weights.get(rows) ?? valueBytes(rows);

/** What the next fetch is after one came back: the end (it was short), a cap (rows or values), or more to come. */
function nextOf(fetched: number, size: number, loaded: number, bytes: number): DbTabState['more'] {
  if (fetched < size) return 'end';
  return loaded >= MAX_LOADED_ROWS || bytes >= MAX_LOADED_BYTES ? 'cap' : 'idle';
}

/** The cap row's words: the 10,000-row cap, or the values budget's. */
export function capMessage(loaded: number): string {
  return loaded >= MAX_LOADED_ROWS ? tdt.more.cap : tdt.more.capBytes(loaded.toLocaleString('en-US'));
}

/** Who hears a new first page land (the inspector's reads, inspector-data.ts): no import back into this module. */
const firstPage = new Set<(key: string) => void>();
export function onFirstPage(hear: (key: string) => void): () => void {
  firstPage.add(hear);
  return () => { firstPage.delete(hear); };
}

/**
 * The row a pick by key selects: the page's row whose row-key columns all hold the key's values; none
 * found, no key, or a page without a row key: the first.
 */
export function pickedRow(page: Pick<DbPage, 'columns' | 'rowKey' | 'rows'>, key: Readonly<Record<string, string>> | null): number {
  if (!key || page.rowKey.length === 0 || page.rowKey.some((k) => key[k] === undefined)) return 0;
  const at = page.rowKey.map((k) => page.columns.findIndex((c) => c.name === k));
  if (at.some((i) => i < 0)) return 0;
  const i = page.rows.findIndex((row) => page.rowKey.every((k, j) => row[at[j]!]?.v === key[k]));
  return i < 0 ? 0 : i;
}

/**
 * The first fetch, from the top: the request as the tab holds it now, at Settings › Rows per fetch. The rows on screen
 * stay until the reply replaces them (a Refresh doesn't flash); a reply for an older request is dropped; then the
 * estimate (not needed when the first fetch was the end: every row is here).
 */
export async function loadFirst(key: string): Promise<void> {
  const ref = tableRef(key);
  if (!ref) return;
  const st = db().tab(key);
  const reqId = ++seq;
  const size = fetchSize(useApp.getState().settings.dbPageSize);
  patch(key, { reqId, loading: true, problem: null, more: 'idle', moreProblem: null, exact: null });
  const r = await ask(ref.connId, () => api().page(pageRequest(ref, st, size, 0)));
  if (db().tab(key).reqId !== reqId) return;
  // The rows the inspector read for are gone with this reply (its reads are cached per page).
  for (const hear of firstPage) hear(key);
  // Opened on a key (Open ›, "N rows ›", Open Referenced Row): the first row selected when the rows come, once; a pick by
  // a row's key: that row when the page has it.
  const want = db().tab(key).pick;
  const pick = want ? { pick: false } : null;
  if (!r.ok) {
    patch(key, { loading: false, problem: r.problem, rows: [], data: null, more: 'idle', selection: [], focus: null, ...pick });
    return;
  }
  const page = r.value;
  const bytes = valueBytes(page.rows);
  weights.set(page.rows, bytes);
  const more = nextOf(page.rows.length, size, page.rows.length, bytes);
  // Every column asked: these are the table's (the filter popover and the Columns chip list them).
  const cols = st.columns === null ? { tableCols: page.columns } : {};
  const first = pick && page.rows.length > 0 ? page.columns.findIndex((c) => !page.hidden.includes(c.name)) : -1;
  const at = first >= 0 ? pickedRow(page, typeof want === 'object' ? want.key : null) : 0;
  const sel = first >= 0 ? { selection: [at], focus: { row: at, col: first } } : { selection: [], focus: null };
  patch(key, { loading: false, problem: null, data: page, rows: page.rows, more, at: Date.now(), ...sel, ...cols, ...pick });
  setDbKind(key, page.kind);
  if (more === 'end') return;
  const e = await askAuto(() => api().estimate(filteredRef(ref, st)));
  if (isHeldAnswer(e)) return;
  if (db().tab(key).reqId === reqId) patch(key, { estimate: e.ok ? e.value : null });
}

/**
 * The next fetch, appended: page = loaded / the first fetch's size (the setting may have changed since; a run keeps
 * its size). Nothing while one is in flight, at the end, at a cap, or with nothing to append to (the first fetch out
 * or failed). A reply for another run — the filters changed, a Refresh, the tab closed and opened again — or for rows
 * that moved meanwhile is dropped. From 'error' it is Retry. Reaching 10,000 rows with a full fetch, one probe.
 */
export async function loadMore(key: string): Promise<void> {
  const ref = tableRef(key);
  const st = db().tab(key);
  if (!ref || !st.data || st.loading || st.problem || (st.more !== 'idle' && st.more !== 'error')) return;
  // The first fetch was full (else it was the end): its length is this run's size.
  const size = st.data.rows.length;
  if (size === 0 || st.rows.length % size !== 0 || st.rows.length >= MAX_LOADED_ROWS) return;
  const reqId = st.reqId;
  const sent = st.rows;
  patch(key, { more: 'loading', moreProblem: null });
  const r = await ask(ref.connId, () => api().page(pageRequest(ref, st, size, sent.length / size)));
  const now = db().tab(key);
  if (now.reqId !== reqId || now.rows !== sent || !now.data) return;
  if (!r.ok) {
    patch(key, { more: 'error', moreProblem: r.problem });
    return;
  }
  const rows = [...sent, ...r.value.rows];
  const bytes = weightOf(sent) + valueBytes(r.value.rows);
  weights.set(rows, bytes);
  const data: DbPage = { ...now.data, ms: r.value.ms, sql: r.value.sql };
  const more = nextOf(r.value.rows.length, size, rows.length, bytes);
  if (more !== 'cap' || rows.length < MAX_LOADED_ROWS || bytes >= MAX_LOADED_BYTES) {
    patch(key, { rows, data, more, at: Date.now() });
    return;
  }
  // The rows show at once, the bottom row keeps loading while one small read past row 10,000 says whether that
  // was all of them (the end, an exact label) or not (the cap). A probe that fails — or finds the connection held since:
  // the app's own read never connects it — says cap: there may be more.
  patch(key, { rows, data, at: Date.now() });
  const probe = await askAuto(() => api().page(pageRequest(ref, st, PROBE_SIZE, MAX_LOADED_ROWS / PROBE_SIZE)));
  const after = db().tab(key);
  if (after.reqId !== reqId || after.rows !== rows) return;
  patch(key, { more: probe.ok && probe.value.rows.length === 0 ? 'end' : 'cap' });
}

/**
 * Whether the scroll is within two viewports of the last loaded row: `scrollTop` from the first row, the
 * viewport's height, a row's height, the rows loaded. A grid with no height (hidden) never asks.
 */
export function needsMore(scrollTop: number, viewport: number, rowH: number, loaded: number): boolean {
  if (viewport <= 0) return false;
  return loaded * rowH - (scrollTop + viewport) <= 2 * viewport;
}

/**
 * Count exactly: count(*) with the filters replaces the estimate. The problem when it failed (to say), else null — a
 * count dropped for a newer one of this tab has nothing to say.
 */
export async function countExactly(key: string): Promise<DbProblem | null> {
  const ref = tableRef(key);
  if (!ref) return null;
  const st = db().tab(key);
  const r = await ask(ref.connId, () => api().count(filteredRef(ref, st)));
  if (!r.ok) return superseded(r.problem) ? null : r.problem;
  if (db().tab(key).reqId === st.reqId) patch(key, { exact: r.value });
  return null;
}

const grouped = (n: number) => n.toLocaleString('en-US');

/** An estimate as the toolbar and the footer show it: grouped under a million ("2,300"), compact above ("1.2M"). */
export function approxRows(n: number): string {
  if (n < 1e6) return grouped(n);
  const m = n / 1e6;
  return `${m >= 100 ? Math.round(m) : Math.round(m * 10) / 10}M`;
}

/** The footer's label: '300 loaded of ~2,300', 'all 2,318 loaded', 'No rows', '10,000 loaded of ~1.2M'. */
export function rowsLabel(st: DbTabState): string {
  const l = tdt.label;
  if (st.problem || !st.data) return '';
  const n = st.rows.length;
  if (n === 0) return l.none;
  const all = st.more === 'end' || (st.exact !== null && n >= st.exact);
  if (all) return n === 1 ? l.one : l.all(grouped(n));
  if (st.exact !== null) return l.of(grouped(n), grouped(st.exact));
  if (st.estimate !== null && st.estimate > n) return l.of(grouped(n), `~${approxRows(st.estimate)}`);
  return l.loaded(grouped(n));
}
