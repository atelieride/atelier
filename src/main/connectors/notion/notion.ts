// The Notion connector: what is Notion's in the generic status machine (../task-connector.ts,
// which owns sign-in, token refresh, statuses, cache, timers and refresh rules). Read-only: the four tools of tools.ts.
//
// - Who: notion-get-self (the user and the workspace). Signing in again to the same workspace keeps the databases.
// - Sources: the databases the user chose (≤ 20 data sources, saved with their fields in ATELIER_HOME/connectors/
//   notion.bin); tasks are read only from them, on list, search and detail (the parent check). The pure rules
//   (picker rows, entries, the fields editor's checks) are in sources.ts.
// - List: per database, in sequence, each under its own 30 s deadline (one for the whole refresh timed out on valid
//   setups of many databases): the schema (`notion-fetch collection://…`, in memory only), the fields validated
//   against it (Notion ignores a filter on a missing column, so a renamed or deleted mapped column is guessed again and
//   saved: Review Focus 1), one rows query, the mapping. A database Atelier can't read (gone, unshared, a name over
//   Notion's limits) is `unreadable` (attention) and the others still list. One not reached (its deadline, a 5xx, the
//   network) keeps its previous tasks and the next is still read; none reached is offline (the cache kept). A 401 or a
//   429 fails the whole refresh.
// - The ID prefix ("ENG") is learned once, from the first row's page (rows give the bare number).
// - Search: per database, rows with "title contains" and the list's own filters, through the same steps as the list
//   (a schema read in the last minute is reused, an older one read again: a renamed column must not leak closed or
//   other people's tasks into the palette); never notion-search (it would reach the whole workspace). The picker's
//   database search is the only notion-search call.
// - Whatever runs while the user edits the databases (a refresh, a sign-in) applies its results to the databases as
//   they are when it ends: a removed one stays removed (and is no longer read), an edited one is read again.
import { z } from 'zod';
import type { WatchedTask, WatchResult } from '@shared/automations';
import { MAX_CLOSED_OPTIONS, MAX_DATABASES, type AddSourceResult, type Column, type ConnectorInfo, type NotionFields, type SourceInfo, type SourcePick, type TaskDetail, type TaskSummary } from '@shared/tasks';
import { Aborted, Forbidden, InvalidArguments, RateLimited, SchemaChanged, ToolError, Unauthorized, Unreachable } from '../errors';
import type { McpClient } from '../mcp/client';
import type { OAuthTokens } from '../oauth/oauth';
import { SAVED_TOKEN_FIELDS, STALE_MS, TaskConnector, message, type Failure, type TaskConnectorDeps } from '../task-connector';
import { oneLine } from '../text';
import { MAX_OPTION_CHARS, MAX_PROP_CHARS, columnsOf, rowsQuery, usableName, validateFields } from './fields';
import { idPrefixFrom, notionTaskUrl, openStatuses, pageToDetail, rowToSummary, type DatabaseConfig } from './map';
import { dashedId, notionIdFromLink, parseDataSourceState, parseDataSources, parsePageProperties, parseParentDataSource, type DataSourceSchema } from './markup';
import { checkedFields, entriesFor, picksFrom, sameFields } from './sources';
import { NOTION_TOOLS } from './tools';

export { normalizeClosed } from './sources';

export type NotionDeps = TaskConnectorDeps;
type Client = McpClient<typeof NOTION_TOOLS>;

const HEX32 = /^[0-9a-f]{32}$/;
const NOTION_UUID = /^[0-9A-Za-z_-]{1,100}$/;
const MAX_PATHS = 200;

const propName = z.string().refine((n) => usableName(n, MAX_PROP_CHARS));
const optionName = z.string().refine((n) => usableName(n, MAX_OPTION_CHARS));
const fieldsSchema = z.object({
  title: propName,
  status: z.object({ prop: propName, kind: z.enum(['status', 'select']), closed: z.array(optionName).max(MAX_CLOSED_OPTIONS) }).optional(),
  assignee: z.object({ prop: propName, mine: z.boolean() }).optional(),
  due: propName.optional(),
  id: propName.optional()
});

/** The saved connection, encrypted by the secret store (ATELIER_HOME/connectors/notion.bin). `token: null` = signed out. */
const savedSchema = z.object({
  v: z.literal(1),
  ...SAVED_TOKEN_FIELDS,
  userId: z.string().regex(NOTION_UUID),
  account: z.string().max(200).optional(),
  workspace: z.object({ id: z.string().regex(NOTION_UUID), name: z.string().max(200) }),
  options: z.object({ includeClosed: z.boolean() }),
  databases: z.array(z.object({
    id: z.string().regex(HEX32),
    source: z.string().regex(HEX32),
    name: z.string().max(200),
    path: z.string().max(200).optional(),
    fields: fieldsSchema,
    idPrefix: z.string().regex(/^[A-Za-z][A-Za-z0-9]{0,15}$/).optional(),
    error: z.literal('unreadable').optional()
  })).max(MAX_DATABASES)
});
export type NotionSaved = z.infer<typeof savedSchema>;

/** Failures of the connection, not of one database: the operation stops and the base decides (offline, sign-out…). */
const connectionWide = (e: unknown) =>
  e instanceof Unauthorized || e instanceof Unreachable || e instanceof RateLimited || e instanceof Aborted || e instanceof Forbidden;

/** How Notion says an object is gone or not shared ("Could not find database with ID: …"). */
const GONE_TEXT = /could not find|not found|no access|unauthori[sz]ed|restricted|\b40[34]\b/i;
/** Notion can't show it (gone, unshared), or Atelier can't ask for it (a column or option name over Notion's limits). */
const unreadable = (e: unknown) => e instanceof InvalidArguments || (e instanceof ToolError && GONE_TEXT.test(e.text));

/** A page that isn't a row of a chosen database: `gone`, whatever id was asked for. */
class NotChosen extends Error {
  constructor() { super('The page is not in a chosen database.'); }
}
class NotADatabase extends Error {
  constructor() { super('That id is not a database.'); }
}

/** A data source's schema, in memory only, its columns as the fields editor shows them, when it was read. */
interface Schema { schema: DataSourceSchema; columns: Column[]; readAt: number }

/** One database's rows query and what it was built from. */
type Rows =
  | { ok: true; schema: DataSourceSchema; fields: NotionFields; changed: boolean; results: Record<string, unknown>[]; more: boolean }
  | { ok: false; why: string };

/** One database read by a list refresh. */
interface DbRead {
  /** The fields it was read with: edited meanwhile (another object) → this result is dropped, the next refresh reads it. */
  read: NotionFields;
  /** Re-guessed after a column change. */
  fields?: NotionFields;
  idPrefix?: string;
  error?: 'unreadable';
  /** Undefined: not listed this time (the previous tasks stay). */
  tasks?: TaskSummary[];
}

export class NotionConnector extends TaskConnector<NotionSaved, typeof NOTION_TOOLS> {
  readonly id = 'notion' as const;
  readonly name = 'Notion';
  protected readonly tools = NOTION_TOOLS;
  protected override readonly refreshDeadline = 'per-source' as const;
  /** By data source (32 hex). */
  private readonly schemas = new Map<string, Schema>();
  /** The last tasks listed from each data source (its count, and its share of the cache). */
  private readonly listed = new Map<string, TaskSummary[]>();
  /** Task id → its data source, for dropping a removed database's tasks. */
  private readonly taskSource = new Map<string, string>();
  /** Data sources whose ID prefix was looked for in this run (once each, even when the column has none). */
  private readonly prefixTried = new Set<string>();
  /** Database id → its path, from the picker's results (a pasted link has none). */
  private readonly paths = new Map<string, string>();

  constructor(deps: NotionDeps) {
    super(deps);
  }

  protected parseSaved(raw: unknown): NotionSaved | null {
    const r = savedSchema.safeParse(raw);
    return r.success ? r.data : null;
  }

  protected override classify(e: unknown): Failure {
    if (e instanceof NotChosen) return 'access';
    return super.classify(e);
  }

  // ── Who, tasks ──────────────────────────────────────────────────────────────────────────────────────────────────

  /** The account. The same user and workspace signing in again keep their databases. */
  protected async identify(client: Client, tokens: OAuthTokens, signal: AbortSignal): Promise<NotionSaved> {
    const me = await this.op(signal, (s) => client.callTool('notion-get-self', {}, { signal: s }));
    const workspace = { id: me.workspace.id, name: oneLine(me.workspace.name, 200) };
    const account = oneLine(me.user.name, 200);
    const prev = this.saved;
    const same = prev !== null && prev.userId === me.user.id && prev.workspace.id === workspace.id;
    const saved: NotionSaved = {
      v: 1, token: tokens.accessToken, userId: me.user.id, ...(account ? { account } : {}), workspace,
      options: { includeClosed: this.options.includeClosed }, databases: same ? prev.databases : []
    };
    if (!savedSchema.safeParse(saved).success) throw new SchemaChanged('unexpected notion-get-self ids');
    return saved;
  }

  /**
   * Every chosen database in sequence, each under its own 30 s deadline and each failure its own (see the
   * header). One not reached keeps its previous tasks; none reached at all is the connection's failure (offline).
   */
  protected async fetchTasks(client: Client, saved: NotionSaved, signal: AbortSignal): Promise<{ tasks: TaskSummary[]; update?: Partial<NotionSaved> }> {
    const chosen = () => this.chosenNow(client, saved);
    const reads = new Map<string, DbRead>();
    let missed: Unreachable | null = null;
    for (const { source } of saved.databases) {
      // As it is now: removed meanwhile → not read any more; edited → read with its new fields.
      const db = chosen().find((d) => d.source === source);
      if (!db) continue;
      try {
        reads.set(source, await this.op(signal, (s) => this.readDatabase(client, db, chosen, s)));
      } catch (e) {
        if (!(e instanceof Unreachable) || signal.aborted) throw e;
        this.log(`a database wasn't reached (${e.reason})`);
        missed = e;
      }
    }
    if (missed && reads.size === 0) throw missed;
    return this.commit(client, saved, reads);
  }

  /**
   * The databases as they are now: the live connection's; during a sign-in, the same user's and workspace's (the user
   * may have removed one meanwhile); else the ones the operation started with.
   */
  private chosenNow(client: Client, saved: NotionSaved): readonly DatabaseConfig[] {
    const now = this.saved;
    if (!now) return saved.databases;
    if (this.client === client) return now.databases;
    return now.userId === saved.userId && now.workspace.id === saved.workspace.id ? now.databases : saved.databases;
  }

  /**
   * One database's rows, for the list and for search alike: its schema (the cached one only when read less than
   * `maxAge` ago), the fields validated against it (a renamed or deleted column guessed again), one rows query.
   */
  private async queryRows(
    client: Client, db: DatabaseConfig, chosen: () => readonly DatabaseConfig[], signal: AbortSignal, o: { maxAge: number; search?: string }
  ): Promise<Rows> {
    const cached = this.schemas.get(db.source);
    let schema = cached && this.clock.now() - cached.readAt < o.maxAge ? cached.schema : null;
    if (!schema) {
      const read = await this.readSchema(client, db.source, signal);
      if (!read) return { ok: false, why: 'no schema in the data source reply' };
      this.keepSchema(db.source, read, chosen());
      schema = read.schema;
    }
    const v = validateFields(db.fields, schema);
    if (v.missingTitle) return { ok: false, why: 'no title column' };
    const args = rowsQuery(db.source, v.fields, { schema, includeClosed: this.options.includeClosed, ...(o.search ? { search: o.search } : {}) });
    if (!args) return { ok: false, why: 'no query for its columns' };
    // has_more: rows past the limit (rows mode has no cursor), so a read of them isn't whole.
    const { results, has_more } = await client.callTool('notion-query-data-sources', args, { signal });
    return { ok: true, schema, fields: v.fields, changed: v.changed, results, more: has_more === true };
  }

  private mapRows(q: Extract<Rows, { ok: true }>, db: DatabaseConfig, idPrefix: string | undefined): TaskSummary[] {
    const mapping: DatabaseConfig = { ...db, fields: q.fields, ...(idPrefix ? { idPrefix } : {}) };
    return q.results.flatMap((row) => rowToSummary(row, mapping, q.schema) ?? []);
  }

  private async readDatabase(client: Client, db: DatabaseConfig, chosen: () => readonly DatabaseConfig[], signal: AbortSignal): Promise<DbRead> {
    const r: DbRead = { read: db.fields };
    try {
      const q = await this.queryRows(client, db, chosen, signal, { maxAge: 0 });
      if (!q.ok) return this.cannotRead(r, q.why);
      if (q.changed) {
        this.log('fields re-guessed after a column change');
        r.fields = q.fields;
      }
      let idPrefix = db.idPrefix;
      if (q.fields.id !== undefined && idPrefix === undefined && q.results[0] && !this.prefixTried.has(db.source)) {
        const learned = await this.learnPrefix(client, q.results[0], q.fields.id, signal);
        // Tried for good only once Notion answered (a column without a prefix included); a failure retries next time.
        if (learned.settled) this.prefixTried.add(db.source);
        if (learned.prefix) idPrefix = r.idPrefix = learned.prefix;
      }
      r.tasks = this.mapRows(q, db, idPrefix);
      return r;
    } catch (e) {
      if (connectionWide(e) || e instanceof SchemaChanged) throw e;
      if (unreadable(e)) return this.cannotRead(r, message(e));
      // A plan limit, an oversized reply: this database's call failed, its cached tasks stay.
      this.log(`a database's tasks weren't read: ${message(e)}`);
      return r;
    }
  }

  private cannotRead(r: DbRead, why: string): DbRead {
    this.log(`a database can't be read: ${why}`);
    return { ...r, error: 'unreadable' };
  }

  /** "ENG-2" → "ENG", from the first row's page. `settled`: Notion answered (with or without a prefix). */
  private async learnPrefix(client: Client, row: Record<string, unknown>, prop: string, signal: AbortSignal): Promise<{ settled: boolean; prefix?: string }> {
    const id = typeof row.url === 'string' ? notionIdFromLink(row.url) : null;
    if (!id) return { settled: false };
    try {
      const page = await client.callTool('notion-fetch', { id }, { signal });
      const props = parsePageProperties(page.text);
      const value = props && Object.hasOwn(props, prop) ? props[prop] : undefined;
      const prefix = typeof value === 'string' ? idPrefixFrom(value) : null;
      return prefix ? { settled: true, prefix } : { settled: true };
    } catch (e) {
      if (connectionWide(e)) throw e;
      this.log(`the ID prefix wasn't read: ${message(e)}`);
      return { settled: false };
    }
  }

  /**
   * A refresh's reads onto the databases as they are now: on a live connection one may have been added, removed or
   * edited while it ran (only reads made with the current fields count). The tasks are the current databases' own.
   */
  private commit(client: Client, saved: NotionSaved, reads: ReadonlyMap<string, DbRead>): { tasks: TaskSummary[]; update?: Partial<NotionSaved> } {
    const now = this.chosenNow(client, saved);
    const databases = now.map((d): DatabaseConfig => {
      const r = reads.get(d.source);
      if (!r || r.read !== d.fields) return d;
      if (r.error) {
        this.listed.delete(d.source);
        return d.error === r.error ? d : { ...d, error: r.error };
      }
      let next = d;
      if (r.fields) next = { ...next, fields: r.fields };
      if (r.idPrefix) next = { ...next, idPrefix: r.idPrefix };
      if (r.tasks) {
        this.listed.set(d.source, r.tasks);
        if (next.error) { const { error: _gone, ...rest } = next; next = rest; }
      }
      return next;
    });
    this.taskSource.clear();
    const tasks: TaskSummary[] = [];
    for (const d of databases) {
      if (d.error) continue;
      for (const t of this.listed.get(d.source) ?? []) {
        tasks.push(t);
        this.taskSource.set(t.id, d.source);
      }
    }
    const changed = now !== saved.databases || databases.some((d, i) => d !== now[i]);
    return { tasks, ...(changed ? { update: { databases } } : {}) };
  }

  /** Only a row of a chosen database (its parent data source), else `gone`. */
  protected async getTask(client: Client, saved: NotionSaved, id: string, signal: AbortSignal): Promise<TaskDetail> {
    const r = await client.callTool('notion-fetch', { id }, { signal });
    if (r.metadata.type !== 'page') throw new NotChosen();
    const parent = parseParentDataSource(r.text);
    // The databases as they are now: one removed while the page was fetched no longer counts (Review Focus 5).
    const db = parent ? (this.saved ?? saved).databases.find((d) => d.source === parent) : undefined;
    if (!db) throw new NotChosen();
    const schema = this.schemas.get(db.source)?.schema ?? null;
    const fields = schema ? validateFields(db.fields, schema).fields : db.fields;
    const detail = pageToDetail(r, { ...db, fields }, schema);
    if (!detail || detail.id !== id) throw new NotChosen();
    return detail;
  }

  /** The list's query per database plus "title contains", 25 rows each; a database's failure is skipped. */
  protected async searchTasks(client: Client, saved: NotionSaved, query: string, signal: AbortSignal): Promise<TaskSummary[]> {
    const chosen = () => this.chosenNow(client, saved);
    const out: TaskSummary[] = [];
    for (const db of chosen()) {
      if (db.error) continue;
      try {
        const q = await this.queryRows(client, db, chosen, signal, { maxAge: STALE_MS, search: query });
        if (q.ok) out.push(...this.mapRows(q, db, db.idPrefix));
      } catch (e) {
        if (connectionWide(e)) throw e;
        this.log(`search in a database failed: ${message(e)}`);
      }
    }
    return out;
  }

  /**
   * Automations: the rows of these chosen databases, read as the list reads them (the
   * database's own filters: assignee, closed). A scope that isn't a chosen database is never read; one that couldn't be
   * read makes the read not complete.
   */
  protected override async watchTasks(client: Client, saved: NotionSaved, scopes: readonly string[], signal: AbortSignal): Promise<WatchResult> {
    const chosen = () => this.chosenNow(client, saved);
    const out: WatchedTask[] = [];
    let complete = true;
    for (const scope of scopes) {
      const db = chosen().find((d) => d.source === scope);
      if (!db) continue;
      if (db.error) { complete = false; continue; }
      const q = await this.queryRows(client, db, chosen, signal, { maxAge: STALE_MS });
      if (!q.ok) { complete = false; continue; }
      if (q.more) complete = false;
      for (const t of this.mapRows(q, db, db.idPrefix)) {
        out.push({
          id: t.id, scope, displayId: t.displayId, title: t.title, url: t.url, status: t.status.name, assignees: [], tags: [],
          ...(t.priority ? { priority: t.priority } : {}), ...(t.due !== undefined ? { due: t.due } : {})
        });
      }
    }
    return { tasks: out, complete };
  }

  /**
   * Automations' editor: the status options of these chosen databases a watch read
   * can return, from the schemas in memory only (the list and the watch read keep them; nothing is read for this, so a
   * database whose schema can't be read costs nothing on every preview). A scope that isn't chosen is never looked at.
   */
  protected override listDefinedStatuses(client: Client, saved: NotionSaved, scopes: readonly string[]): Promise<{ name: string; color?: string }[]> {
    const out: { name: string; color?: string }[] = [];
    for (const scope of scopes) {
      const db = this.chosenNow(client, saved).find((d) => d.source === scope);
      const schema = db && !db.error ? this.schemas.get(db.source)?.schema : undefined;
      if (!db || !schema) continue;
      for (const o of openStatuses(schema, validateFields(db.fields, schema).fields)) {
        if (!out.some((x) => x.name.toLowerCase() === o.name.toLowerCase())) out.push(o);
      }
    }
    return Promise.resolve(out);
  }

  /** Automations' editor: the chosen databases. */
  protected override listScopes(client: Client, saved: NotionSaved): Promise<{ id: string; label: string }[]> {
    return Promise.resolve(this.chosenNow(client, saved).map((d) => ({ id: d.source, label: d.name })));
  }

  /** The data source's schema (one notion-fetch) with its columns; null when the reply has none. */
  private async readSchema(client: Client, source: string, signal: AbortSignal): Promise<Schema | null> {
    const r = await client.callTool('notion-fetch', { id: `collection://${dashedId(source) ?? source}` }, { signal });
    const schema = parseDataSourceState(r.text);
    return schema ? { schema, columns: columnsOf(schema), readAt: this.clock.now() } : null;
  }

  /** Kept in memory only for a chosen data source (a refresh or a search may end after it was removed). */
  private keepSchema(source: string, s: Schema, chosen: readonly DatabaseConfig[]): void {
    if (chosen.some((d) => d.source === source)) this.schemas.set(source, s);
  }

  isTaskId(id: string): boolean {
    return typeof id === 'string' && HEX32.test(id);
  }

  taskUrlFor(id: string): string {
    return notionTaskUrl(id);
  }

  appUrl(id: string): string | null {
    return this.isTaskId(id) ? `notion://www.notion.so/${id}` : null;
  }

  // ── Card ────────────────────────────────────────────────────────────────────────────────────────────────────────

  /** The chosen databases with what is known in memory (columns, open count, loading), and how many need the user. */
  protected override infoExtra(): Partial<ConnectorInfo> {
    const dbs = this.saved?.databases;
    if (!dbs) return {};
    const sources = dbs.map((d): SourceInfo => {
      const columns = this.schemas.get(d.source)?.columns;
      const listed = d.error ? undefined : this.listed.get(d.source);
      const count = listed?.length;
      const preview = listed?.[0];
      return {
        id: d.source, name: d.name, ...(d.path ? { path: d.path } : {}), fields: d.fields,
        ...(columns ? { columns } : {}), ...(count !== undefined ? { count } : {}), ...(preview ? { preview } : {}),
        loading: this.refreshInFlight && count === undefined && !d.error,
        ...(d.error ? { error: d.error } : {})
      };
    });
    return { sources, attention: dbs.filter((d) => d.error).length };
  }

  override disconnect(): void {
    this.schemas.clear();
    this.listed.clear();
    this.taskSource.clear();
    this.prefixTried.clear();
    this.paths.clear();
    super.disconnect();
  }

  // ── Choosing databases ──────────────────────────────────────────────────────────────────────────────

  /** The current connection's client, while it can make calls. */
  private live(): Client | null {
    return (this.status === 'connected' || this.status === 'offline') && this.saved?.token ? this.client : null;
  }

  /** The picker: notion-search, databases only. A failure rejects (the picker shows one line, never a toast). */
  async searchSources(query: string): Promise<SourcePick[]> {
    const q = oneLine(query, 200);
    const client = this.live();
    if (!q || !client) return [];
    const signal = this.life.signal;
    let results;
    try {
      ({ results } = await this.op(signal, (s) => this.withClient(s, (c) =>
        c.callTool('notion-search', { query: q, page_size: 25, max_highlight_length: 0 }, { signal: s }))));
    } catch (e) {
      if (e instanceof Unauthorized && !signal.aborted && this.client === client) this.signOut();
      this.log(`database search failed: ${message(e)}`);
      throw new Error("Couldn't search Notion.");
    }
    const picks = picksFrom(results, new Set(this.saved?.databases.map((d) => d.id)));
    for (const p of picks) this.rememberPath(p.id, p.path);
    return picks;
  }

  /**
   * A database by a pick's id or a pasted link: fetched, one entry per data source with guessed fields, then the list
   * refreshes (and learns the ID prefix). Already there → nothing changes, its entries are the answer.
   */
  async addSource(ref: string): Promise<AddSourceResult> {
    const id = typeof ref === 'string' ? notionIdFromLink(ref) : null;
    if (!id) return { ok: false, reason: 'not-database' };
    const client = this.live();
    if (!client || !this.saved) return { ok: false, reason: 'failed' };
    const have = (s: NotionSaved) => s.databases.filter((d) => d.id === id).map((d) => d.source);
    if (have(this.saved).length) return { ok: true, sourceIds: have(this.saved) };
    if (this.saved.databases.length >= MAX_DATABASES) return { ok: false, reason: 'too-many' };
    const signal = this.life.signal;
    let entries: DatabaseConfig[];
    let schemas: ReadonlyMap<string, Schema | null>;
    try {
      ({ entries, schemas } = await this.op(signal, (s) => this.withClient(s, (c) => this.readNewDatabase(c, id, s))));
    } catch (e) {
      if (signal.aborted || this.client !== client) return { ok: false, reason: 'failed' };
      if (e instanceof NotADatabase) return { ok: false, reason: 'not-database' };
      if (unreadable(e) || e instanceof Forbidden) return { ok: false, reason: 'not-found' };
      if (e instanceof Unauthorized) { this.signOut(); return { ok: false, reason: 'failed' }; }
      this.log(`database not added: ${message(e)}`);
      return { ok: false, reason: e instanceof Unreachable ? 'offline' : 'failed' };
    }
    const saved = this.saved;
    if (!saved || this.client !== client) return { ok: false, reason: 'failed' };
    if (have(saved).length) return { ok: true, sourceIds: have(saved) }; // added meanwhile
    const fresh = entries.filter((e) => !saved.databases.some((d) => d.source === e.source));
    if (!fresh.length) return { ok: true, sourceIds: entries.map((e) => e.source) };
    if (saved.databases.length + fresh.length > MAX_DATABASES) return { ok: false, reason: 'too-many' };
    this.saved = { ...saved, databases: [...saved.databases, ...fresh] };
    // Only the added ones' schemas are kept (a database refused as too many leaves nothing behind).
    for (const e of fresh) {
      const s = schemas.get(e.source);
      if (s) this.schemas.set(e.source, s);
    }
    this.persist();
    this.refreshSoon();
    this.changed();
    return { ok: true, sourceIds: fresh.map((e) => e.source) };
  }

  /** The database's entries (one per data source) and its data sources' schemas, nothing kept yet. */
  private async readNewDatabase(client: Client, id: string, signal: AbortSignal): Promise<{ entries: DatabaseConfig[]; schemas: Map<string, Schema | null> }> {
    const r = await client.callTool('notion-fetch', { id }, { signal });
    if (r.metadata.type !== 'database') throw new NotADatabase();
    const sources = parseDataSources(r.text);
    const schemas = new Map<string, Schema | null>();
    for (const ref of sources) {
      const source = ref.id.replace(/-/g, '');
      schemas.set(source, await this.readSchema(client, source, signal));
    }
    const entries = entriesFor({ id, title: r.title, path: this.paths.get(id) }, sources,
      new Map([...schemas].map(([source, s]) => [source, s?.schema ?? null])));
    if (!entries.length) throw new Error('no data source with a readable schema');
    return { entries, schemas };
  }

  /** Removing asks nothing (one click adds it back): the database and its tasks go at once. */
  async removeSource(sourceId: string): Promise<ConnectorInfo> {
    const saved = this.saved;
    if (!saved || !saved.databases.some((d) => d.source === sourceId)) return this.info();
    this.saved = { ...saved, databases: saved.databases.filter((d) => d.source !== sourceId) };
    this.persist();
    this.forgetTasks(sourceId);
    this.schemas.delete(sourceId);
    this.prefixTried.delete(sourceId);
    this.changed();
    return this.info();
  }

  /** The fields editor: saved only when every column fits the current schema; the database lists again. */
  async setSourceFields(sourceId: string, fields: NotionFields): Promise<ConnectorInfo> {
    if (!this.saved?.databases.some((d) => d.source === sourceId)) return this.info();
    const schema = this.schemas.get(sourceId)?.schema ?? await this.loadSchema(sourceId);
    const checked = schema ? checkedFields(fields, schema) : null;
    const saved = this.saved;
    const db = saved?.databases.find((d) => d.source === sourceId);
    if (!saved || !db) return this.info();
    if (!checked) {
      this.log("fields not saved: they don't match the database's columns");
      return this.info();
    }
    if (sameFields(checked, db.fields)) return this.info();
    let next: DatabaseConfig = { ...db, fields: checked };
    if (checked.id !== db.fields.id) {
      // Another ID column has another prefix.
      const { idPrefix: _old, ...rest } = next;
      next = rest;
      this.prefixTried.delete(sourceId);
    }
    this.saved = { ...saved, databases: saved.databases.map((d) => (d.source === sourceId ? next : d)) };
    this.persist();
    this.refreshSoon();
    this.changed();
    return this.info();
  }

  /** The fields editor opened: the schema is read now, so its columns are current. */
  async loadSourceColumns(sourceId: string): Promise<ConnectorInfo> {
    if (!this.saved?.databases.some((d) => d.source === sourceId)) return this.info();
    await this.loadSchema(sourceId);
    this.changed();
    return this.info();
  }

  /** A source's schema outside a refresh; a database Notion no longer shows turns unreadable. */
  private async loadSchema(source: string): Promise<DataSourceSchema | null> {
    const client = this.live();
    if (!client) return null;
    const signal = this.life.signal;
    try {
      const read = await this.op(signal, (s) => this.withClient(s, (c) => this.readSchema(c, source, s)));
      if (read) this.keepSchema(source, read, this.saved?.databases ?? []);
      return read?.schema ?? null;
    } catch (e) {
      if (signal.aborted || this.client !== client) return null;
      this.log(`a database's columns weren't read: ${message(e)}`);
      if (e instanceof Unauthorized) this.signOut();
      else if (unreadable(e)) this.markUnreadable(source);
      return null;
    }
  }

  private markUnreadable(source: string): void {
    const saved = this.saved;
    if (!saved?.databases.some((d) => d.source === source && !d.error)) return;
    this.saved = { ...saved, databases: saved.databases.map((d) => (d.source === source ? { ...d, error: 'unreadable' as const } : d)) };
    this.persist();
    this.forgetTasks(source);
    this.changed();
  }

  /** A source's tasks leave the cache (removed, or unreadable). */
  private forgetTasks(source: string): void {
    this.listed.delete(source);
    this.dropTasks((t) => this.taskSource.get(t.id) !== source);
    for (const [task, s] of this.taskSource) if (s === source) this.taskSource.delete(task);
  }

  private rememberPath(id: string, path: string | undefined): void {
    this.paths.delete(id);
    if (path) this.paths.set(id, path);
    if (this.paths.size > MAX_PATHS) this.paths.delete(this.paths.keys().next().value!);
  }
}
