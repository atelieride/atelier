// Databases view, main side: the windows and their project, the saved
// connections each window may use (its project's and every project's), the selection per project, one session per
// connection shared by every window (opened on demand, closed once no window selects it and nothing used it for
// idleCloseMs), passwords through the Keychain secret store, a snapshot per window, and every read through that
// connection's DbQueries. Nothing is looked for (connections are added by hand) and nothing is contacted
// but a saved connection a window asked about; a password never leaves main: not in a snapshot, a reply, the
// connections file or a log.
import { IPC } from '@shared/api';
import type {
  DbCatalog, DbConnection, DbConnectionForm, DbConnState, DbConnView, DbFilteredRef, DbFullRequest, DbFunctionRef, DbOverview, DbPage, DbPageRequest,
  DbPeek, DbPeekRequest, DbProblem, DbRefCount, DbRefsRequest, DbRelations, DbResult, DbServerInfo, DbSnapshot, DbStructure, DbTableRef
} from '@shared/databases';
import { EMPTY_DB_SNAPSHOT, newConnId, providerOf } from '@shared/databases';
import type { Settings } from '@shared/settings';
import type { SecretsLike } from '../redis/hub';
import { DbError, isIpLiteral, type DbDriver, type DbSession, type Tunnel, type TunnelFactory } from './driver';
import { readCatalog, readOnlyRoleSql, readServerInfo } from './postgres/catalog';
import { readOverview } from './postgres/overview';
import { DbQueries } from './queries';
import { dbConnectionSchema, secretIdOf, type DbStore } from './store';

export type { SecretsLike };

export interface DbHubWindow {
  id: number;
  send(channel: string, payload: unknown): void;
  isDestroyed(): boolean;
  once(e: 'destroyed', fn: () => void): void;
}

export type DbSettings = Pick<Settings, 'showDatabases' | 'dbTimeoutSec'>;

/** The events the hub sends its windows. */
export const DB_CHANNELS = { snapshot: IPC.evDatabases } as const;

export const DB_TIMING = {
  /** A session no window selects closes this long after its last request. */
  idleCloseMs: 60_000,
  /** Overview requests this close together (two windows polling) share one read. */
  overviewMs: 2000
};

export interface DbHubDeps {
  settings(): DbSettings;
  store: DbStore;
  secrets: SecretsLike | null;
  driver: DbDriver;
  tunnel?: TunnelFactory;
  timing?: Partial<typeof DB_TIMING>;
}

/** The role the read-only role script creates. */
const READ_ONLY_ROLE = 'atelier_readonly';
const NAME_MAX = 120;
const COPY = ' copy';
/** test() validates the form as a connection with this id (never saved). */
const PROBE_ID = 'c000000000000';

const UNKNOWN: DbResult<never> = { ok: false, problem: { kind: 'other', message: 'Unknown connection' } };
const OFF: DbResult<never> = { ok: false, problem: { kind: 'other', message: 'Databases are off in Settings' } };
const DISCONNECTED: DbProblem = { kind: 'other', message: 'Disconnected' };
/** A read on a connection explicitly disconnected (nothing contacted; Connect releases it). */
const HELD: DbResult<never> = { ok: false, problem: { kind: 'held', message: 'Disconnected' } };
/** A request a newer one for its slot replaced before it started. */
const SUPERSEDED: DbResult<never> = { ok: false, problem: { kind: 'canceled', message: 'Superseded' } };
const NO_SSH: DbProblem = { kind: 'ssh', message: "SSH tunnels aren't available" };
/** The server changed and nothing was typed for it. */
const NEW_SERVER: DbProblem = { kind: 'password', message: 'Type the password for the new server' };
/** A reply's warning when the Keychain refused a password. */
const KEYCHAIN_WARNING = "The Keychain refused the password: it's kept until you quit.";

interface Win { wc: DbHubWindow; root: string; sent: string }
/** What a read gets: the connection's open session, its queries and its server. */
interface Live { session: DbSession; queries: DbQueries; server: DbServerInfo }

/** A connection's state while Atelier is open (the saved part lives in the store). */
interface Rt {
  state: DbConnState;
  problem: DbProblem | null;
  server: DbServerInfo | null;
  session: DbSession | null;
  queries: DbQueries | null;
  tunnel: Tunnel | null;
  /** The query timeout the session was opened with: a changed setting replaces the session on the next request. */
  timeoutSec: number;
  connecting: Promise<DbResult<DbServerInfo>> | null;
  /** Bumped by every connect and close: a connect that finds it changed was overtaken and keeps nothing. */
  gen: number;
  /** The password last typed for it (password(), save()), kept until quit: used before the Keychain's. */
  memPassword: string | null;
  /** Whether the Keychain holds one: read once, then kept up to date (a read decrypts). */
  hasSecret: boolean | undefined;
  /** Its Keychain password was forgotten: never read again, even if removing it failed, until one is typed. */
  secretVoid: boolean;
  catalog: DbCatalog | null;
  catGen: number;
  /** wantCatalog's read in progress: a session opened under a select or Connect asks once, not twice. */
  catLoad: Promise<void> | null;
  overview: { at: number; value: Promise<DbResult<DbOverview>> } | null;
  /** Requests in progress: the idle close waits for them. */
  busy: number;
  idle: NodeJS.Timeout | null;
  /** Explicitly disconnected: reads answer HELD until a window selects or connects it. Never saved. */
  held: boolean;
  /** The last request in line (one request at a time per connection, in order). */
  queue: Promise<void>;
  /** The request still waiting for each slot, by its drop (a newer one for the slot calls it). */
  waiting: Map<string, () => void>;
}

function asProblem(e: unknown): DbProblem {
  if (e instanceof DbError) return e.problem;
  return { kind: 'other', message: e instanceof Error ? e.message : String(e) };
}

/** Never shows the password, whatever an error says (belt and braces: neither pg nor ssh repeats it). */
function scrub(p: DbProblem, password: string): DbProblem {
  if (password.length < 4) return p;
  const hide = (s: string | undefined) => (s === undefined ? s : s.split(password).join('••••'));
  return { ...p, message: hide(p.message)!, ...(p.detail !== undefined ? { detail: hide(p.detail)! } : {}), ...(p.hint !== undefined ? { hint: hide(p.hint)! } : {}) };
}

/** A connect through an SSH tunnel that failed: the client's error, ssh's reason when it gave one, and where it dialled. */
class TunnelFailure {
  constructor(readonly cause: unknown, readonly why: string | null, readonly localPort: number, readonly c: DbConnection) {}
}

/**
 * A failed connect as the view shows it: a link that drops while connecting is a failure to connect, not
 * "Reconnecting…". Through an SSH tunnel, ssh's own reason when the bastion couldn't open the forwarded connection (kind
 * 'ssh', naming the database as the bastion sees it); otherwise the client's problem with the tunnel's address replaced
 * by the real target — after the password is hidden (a rewrite first could change the very text that hides
 * it).
 */
function connectProblem(e: unknown, password: string): DbProblem {
  if (e instanceof TunnelFailure) {
    if (e.why) return scrub({ kind: 'ssh', message: `The bastion couldn't reach ${e.c.host}:${e.c.port}: ${e.why}` }, password);
    return throughTunnel(connectProblem(e.cause, password), e);
  }
  let p = asProblem(e);
  if (p.kind === 'lost') p = { kind: 'other', message: 'The server closed the connection while connecting', ...(p.code ? { code: p.code } : {}) };
  return scrub(p, password);
}

/**
 * A problem of a connect through a tunnel, as the user knows the server: `127.0.0.1:<local>` (the tunnel's own address)
 * becomes the target wherever it is said; the bare 127.0.0.1 only in the messages the client writes with the host it
 * dialled and no port (no answer, host not found) — never in a detail, where it is someone else's (a certificate's
 * names).
 */
function throughTunnel(p: DbProblem, t: TunnelFailure): DbProblem {
  const local = `127.0.0.1:${t.localPort}`;
  const target = `${t.c.host}:${t.c.port}`;
  const fix = (s: string) => s.split(local).join(target);
  const own = p.kind === 'timeout' || p.kind === 'host';
  const message = own ? fix(p.message).split('127.0.0.1').join(t.c.host) : fix(p.message);
  return { ...p, message, ...(p.detail !== undefined ? { detail: fix(p.detail) } : {}), ...(p.hint !== undefined ? { hint: fix(p.hint) } : {}) };
}

/** Where a session goes and as whom: a change closes the open one. */
const endpointOf = (c: DbConnection) => JSON.stringify([c.host, c.port, c.database, c.user, c.socket ?? null, c.ssh, c.tls]);
/**
 * The role on its server: a change shows the "this role can write" note again. Not the database: a switch
 * to another database of the same server (the chip) keeps a dismissed note dismissed.
 */
const roleOf = (c: DbConnection) => JSON.stringify([c.host, c.port, c.user, c.socket ?? null, c.ssh]);
/**
 * The server a password was typed for: a saved or remembered password goes only there. Another
 * database or user on it keeps the password; another host, port, socket, SSH hop or TLS mode asks for it again.
 */
export const secretTargetOf = (c: Pick<DbConnection, 'host' | 'port' | 'socket' | 'ssh' | 'tls'>): string =>
  JSON.stringify([c.host, c.port, c.socket ?? null, c.ssh, c.tls]);

/** The text the sidebar copies; never sent to a server. */
function roleScript(versionNum: number): string {
  return readOnlyRoleSql(READ_ONLY_ROLE, versionNum);
}

/**
 * A request's slot in its connection's line: its window's tab, among requests of its own kind — the same
 * table open in two windows has one tab key, and one window's page never drops the other's.
 */
const slotOf = (kind: 'page' | 'estimate' | 'count', wcId: number, slot: string | undefined): string | undefined =>
  slot === undefined ? undefined : `${kind}\0${wcId}\0${slot}`;

export class DbHub {
  private readonly windows = new Map<number, Win>();
  private readonly rts = new Map<string, Rt>();
  /** Sessions the hub closed while open: a request that fails on one is not retried. */
  private readonly ownClosed = new WeakSet<DbSession>();
  /** After dispose (quit): requests answer "Disconnected", nothing connects. */
  private disposed = false;
  /** A selection the connections file couldn't keep was logged (once). */
  private pickWarned = false;
  private readonly t: typeof DB_TIMING;

  constructor(private readonly deps: DbHubDeps) {
    this.t = { ...DB_TIMING, ...deps.timing };
  }

  // —— windows ——

  /** Registers a window on its project and sends its first snapshot at once. */
  open(root: string, wc: DbHubWindow): void {
    this.windows.set(wc.id, { wc, root, sent: '' });
    wc.once('destroyed', () => this.closeWindow(wc.id));
    this.broadcast();
  }

  private closeWindow(id: number): void {
    this.windows.delete(id);
    for (const connId of this.rts.keys()) this.armIdle(connId);
  }

  /** Quit: every session closes; later requests answer "Disconnected" and nothing connects again. */
  dispose(): void {
    this.disposed = true;
    for (const rt of this.rts.values()) this.closeConn(rt);
  }

  /** Show Databases or the query timeout changed (a new timeout reaches each session when it is next used). */
  settingsChanged(): void {
    if (this.off()) for (const rt of this.rts.values()) this.closeConn(rt);
    this.broadcast();
  }

  // —— what windows see ——

  snapshotFor(wcId: number): DbSnapshot {
    const w = this.windows.get(wcId);
    if (!w || this.off()) return { ...EMPTY_DB_SNAPSHOT, connections: [] };
    const selected = this.pickOf(w.root);
    const sel = selected ? this.rts.get(selected) : undefined;
    return {
      connections: this.deps.store.list().filter((c) => this.sees(w.root, c)).map((c) => this.viewOf(c)),
      selected,
      // Kept while reconnecting (the sidebar stays put); a close or a failed connect drops it.
      catalog: sel?.catalog ?? null
    };
  }

  private viewOf(c: DbConnection): DbConnView {
    const rt = this.rts.get(c.id);
    return {
      conn: c, state: rt?.state ?? 'idle', problem: rt?.problem ?? null, server: rt?.server ?? null, hasPassword: this.hasPassword(c.id),
      provider: providerOf(c.host), held: rt?.held ?? false
    };
  }

  /** Sends each window its snapshot when it changed. */
  private broadcast(): void {
    for (const [id, w] of this.windows) {
      if (w.wc.isDestroyed()) continue;
      const snap = this.snapshotFor(id);
      const key = JSON.stringify(snap);
      if (key !== w.sent) {
        w.sent = key;
        w.wc.send(DB_CHANNELS.snapshot, snap);
      }
    }
  }

  // —— connections ——

  /**
   * Selects a connection for the window's project (remembered) and connects it — released from an explicit Disconnect,
   * in every window —; null selects none.
   */
  async select(wcId: number, connId: string | null): Promise<void> {
    const w = this.windows.get(wcId);
    if (!w || this.blocked()) return;
    if (connId !== null && !this.connFor(wcId, connId)) return;
    if (connId !== null) this.release(connId);
    const prev = this.pickOf(w.root);
    try {
      this.deps.store.setPick(w.root, connId);
    } catch (e) {
      // The connection is still used; the file just won't remember it.
      if (!this.pickWarned) {
        this.pickWarned = true;
        console.error('Databases: the selection was not saved:', e instanceof Error ? e.message : String(e));
      }
    }
    if (prev && prev !== connId) this.armIdle(prev);
    this.broadcast();
    if (connId !== null) await this.connectSelected(connId);
  }

  /** Connect (a user's: Connect, Try Again, a read the user caused): releases an explicit Disconnect too. */
  connect(wcId: number, connId: string): Promise<DbResult<DbServerInfo>> {
    if (!this.connFor(wcId, connId)) return Promise.resolve(UNKNOWN);
    const b = this.blocked();
    if (b) return Promise.resolve(b);
    this.release(connId);
    return this.connectSelected(connId);
  }

  /**
   * Disconnect: the session goes, and the connection is held — for every window, until one selects or
   * connects it: reads answer HELD, nothing reconnects it by itself. Kept until quit, never saved.
   */
  disconnect(wcId: number, connId: string): void {
    if (!this.connFor(wcId, connId)) return;
    const rt = this.rt(connId);
    this.closeConn(rt);
    rt.held = true;
    this.broadcast();
  }

  /**
   * Connects with a typed password; once it works, kept until quit, and in the Keychain with `save` (the reply warns
   * when the Keychain refused it).
   */
  async password(wcId: number, a: { connId: string; password: string; save: boolean }): Promise<DbResult<DbServerInfo>> {
    const f = this.connFor(wcId, a.connId);
    if (!f) return UNKNOWN;
    const b = this.blocked();
    if (b) return b;
    this.release(a.connId);
    const rt = this.rt(a.connId);
    rt.busy++;
    try {
      const r = await this.ensure(f.c, rt, { password: a.password, retryAuth: true });
      if (!r.ok) return r;
      rt.memPassword = a.password;
      const refused = a.save && !this.writeSecret(a.connId, a.password);
      await this.wantCatalog(a.connId);
      this.broadcast();
      return refused ? { ...r, warning: KEYCHAIN_WARNING } : r;
    } finally {
      rt.busy--;
      this.armIdle(a.connId);
    }
  }

  /**
   * Test Connection: connects with the form's values, reads the server (role, whether it can write), closes. Saves
   * nothing. Editing (`id`) with the field left empty ('' or null) uses the saved password, but only on the
   * server it was typed for: pointed elsewhere, it asks for one and contacts nothing.
   */
  async test(wcId: number, a: { form: DbConnectionForm; password: string | null; id: string | null }): Promise<DbResult<DbServerInfo>> {
    const w = this.windows.get(wcId);
    if (!w) return UNKNOWN;
    const old = a.id === null ? null : this.connFor(wcId, a.id)?.c ?? null;
    if (a.id !== null && !old) return UNKNOWN;
    const b = this.blocked();
    if (b) return b;
    const v = this.validated(w, a.form, { id: PROBE_ID, mask: false, writeNoted: false, createdAt: 0 });
    if (!v.ok) return v;
    let password = a.password ?? '';
    if (old && !password) {
      if (secretTargetOf(old) !== secretTargetOf(v.value)) return { ok: false, problem: NEW_SERVER };
      password = this.passwordOf(old.id);
    }
    try {
      const d = await this.dial(v.value, password, this.deps.settings().dbTimeoutSec);
      d.session.close();
      d.tunnel?.close();
      return { ok: true, value: d.server };
    } catch (e) {
      return { ok: false, problem: connectProblem(e, password) };
    }
  }

  /**
   * Saves the form as a new connection (`id` null) or over one this window can see. A typed password goes to the
   * Keychain (the reply warns when it refused) and replaces one the server refused; an empty field ('' or null)
   * keeps the saved one while the server stays the same, and forgets it when the connection now points at another
   * server (asked for again). A changed endpoint closes the open session; a changed role shows the write note
   * again; another database (the sidebar's database chip) forgets the schema pick: its schemas are others.
   */
  async save(wcId: number, a: { form: DbConnectionForm; password: string | null; id: string | null }): Promise<DbResult<{ id: string }>> {
    const w = this.windows.get(wcId);
    if (!w) return UNKNOWN;
    const old = a.id === null ? null : this.connFor(wcId, a.id)?.c ?? null;
    if (a.id !== null && !old) return UNKNOWN;
    const id = old?.id ?? this.freshId();
    const schema = old?.schema !== undefined && old.database === a.form.database ? { schema: old.schema } : {};
    const keep = old
      ? { id, mask: old.mask, writeNoted: old.writeNoted, createdAt: old.createdAt, ...schema }
      : { id, mask: false, writeNoted: false, createdAt: Date.now() };
    const v = this.validated(w, a.form, keep);
    if (!v.ok) return v;
    const c = old && roleOf(old) !== roleOf(v.value) ? { ...v.value, writeNoted: false } : v.value;
    const put = this.put(c);
    if (!put.ok) return put;
    const rt = this.rt(id);
    const moved = !old || endpointOf(old) !== endpointOf(c);
    if (old && moved) this.closeConn(rt);
    let refused = false;
    if (a.password) {
      rt.memPassword = a.password;
      refused = !this.writeSecret(id, a.password);
      // The one the server refused is gone: the next request tries this one (reads never retry a refused password).
      if (rt.state === 'password') {
        rt.state = 'idle';
        rt.problem = null;
      }
    } else if (old && secretTargetOf(old) !== secretTargetOf(c)) {
      this.forgetPassword(id);
      rt.state = 'password';
      rt.problem = NEW_SERVER;
    }
    this.armIdle(id);
    this.broadcast();
    return { ok: true, value: { id }, ...(refused ? { warning: KEYCHAIN_WARNING } : {}) };
  }

  /** Same settings, the name + " copy", the Keychain secret copied. */
  duplicate(wcId: number, id: string): DbResult<{ id: string }> {
    const f = this.connFor(wcId, id);
    if (!f) return UNKNOWN;
    const nid = this.freshId();
    const put = this.put({ ...f.c, id: nid, name: f.c.name.slice(0, NAME_MAX - COPY.length) + COPY, createdAt: Date.now() });
    if (!put.ok) return put;
    const secret = this.readSecret(id);
    if (secret !== null && !this.writeSecret(nid, secret)) this.rt(nid).memPassword = secret;
    const mem = this.rts.get(id)?.memPassword;
    if (mem) this.rt(nid).memPassword = mem;
    this.broadcast();
    return { ok: true, value: { id: nid } };
  }

  /** Remove Connection: its session, its entry, its pick and its Keychain secret. */
  remove(wcId: number, id: string): void {
    if (!this.connFor(wcId, id)) return;
    const rt = this.rts.get(id);
    if (rt) {
      this.closeConn(rt);
      this.rts.delete(id);
    }
    try {
      this.deps.store.remove(id);
    } catch {
      // Kept in memory by the store; nothing else to undo.
    }
    try {
      this.deps.secrets?.remove(secretIdOf(id));
    } catch {
      // The secret store logs nothing of the value; a blob left behind belongs to no connection.
    }
    this.broadcast();
  }

  setMask(wcId: number, id: string, on: boolean): void {
    this.patch(wcId, id, { mask: on });
  }

  /** Dismiss on the "this role can write" note. */
  noteWrite(wcId: number, id: string): void {
    this.patch(wcId, id, { writeNoted: true });
  }

  /** The schema chip: remembered on the connection, its catalog read again when connected. */
  async setSchema(wcId: number, id: string, schema: string): Promise<void> {
    if (!this.patch(wcId, id, { schema })) return;
    if (!this.off() && this.rts.get(id)?.state === 'connected') await this.loadCatalog(id);
  }

  /** The sidebar's Refresh: the selected connection's catalog read again when connected (its tables' columns too). */
  async refresh(wcId: number): Promise<void> {
    const w = this.windows.get(wcId);
    if (!w || this.off()) return;
    const id = this.pickOf(w.root);
    const rt = id ? this.rts.get(id) : undefined;
    if (!id || rt?.state !== 'connected') return;
    rt.queries?.forget();
    await this.loadCatalog(id);
  }

  // —— reads ——

  /** A page; one still waiting is dropped when a newer page for its `slot` comes. */
  page(wcId: number, req: DbPageRequest): Promise<DbResult<DbPage>> {
    return this.use(wcId, req.ref.connId, (l) => l.queries.page(req), slotOf('page', wcId, req.slot));
  }

  estimate(wcId: number, a: DbFilteredRef): Promise<DbResult<number | null>> {
    return this.use(wcId, a.ref.connId, (l) => l.queries.estimate(a.ref, a.filters), slotOf('estimate', wcId, a.slot));
  }

  count(wcId: number, a: DbFilteredRef): Promise<DbResult<number>> {
    return this.use(wcId, a.ref.connId, (l) => l.queries.count(a.ref, a.filters), slotOf('count', wcId, a.slot));
  }

  peek(wcId: number, a: DbPeekRequest): Promise<DbResult<DbPeek>> {
    return this.use(wcId, a.ref.connId, (l) => l.queries.peek(a.ref, a.cols, a.values, a.row === true));
  }

  refs(wcId: number, a: DbRefsRequest): Promise<DbResult<DbRefCount[]>> {
    return this.use(wcId, a.ref.connId, (l) => l.queries.refs(a.ref, a.key));
  }

  full(wcId: number, a: DbFullRequest): Promise<DbResult<string>> {
    return this.use(wcId, a.ref.connId, (l) => l.queries.full(a.ref, a.key, a.column, a.path));
  }

  structure(wcId: number, ref: DbTableRef): Promise<DbResult<DbStructure>> {
    return this.use(wcId, ref.connId, (l) => l.queries.structure(ref));
  }

  relations(wcId: number, ref: DbTableRef): Promise<DbResult<DbRelations>> {
    return this.use(wcId, ref.connId, (l) => l.queries.relations(ref));
  }

  /** A table's DDL, or a function's definition: the same connection checks for both. */
  ddl(wcId: number, ref: DbTableRef | DbFunctionRef): Promise<DbResult<string>> {
    return this.use(wcId, ref.connId, (l) => l.queries.ddl(ref));
  }

  /** The overview; requests within overviewMs share one read (the renderer computes tx/s from xacts). */
  async overview(wcId: number, connId: string): Promise<DbResult<DbOverview>> {
    const f = this.connFor(wcId, connId);
    if (!f) return UNKNOWN;
    const b = this.gate(connId);
    if (b) return b;
    const rt = this.rt(connId);
    if (rt.overview && Date.now() - rt.overview.at < this.t.overviewMs) return rt.overview.value;
    const value = this.through(f.c, (l) => readOverview(l.session, l.server));
    const entry = { at: Date.now(), value };
    rt.overview = entry;
    const r = await value;
    if (!r.ok && rt.overview === entry) rt.overview = null;
    return r;
  }

  /** Copy SQL for a Read-only Role: the script for the connected server's version. */
  readOnlySql(wcId: number, connId: string): DbResult<string> {
    if (!this.connFor(wcId, connId)) return UNKNOWN;
    const server = this.rts.get(connId)?.server;
    if (!server) return { ok: false, problem: { kind: 'other', message: 'Connect first: the script depends on the server version' } };
    return { ok: true, value: roleScript(server.versionNum) };
  }

  // —— inside ——

  private off(): boolean {
    return this.deps.settings().showDatabases === 'never';
  }

  /** Why a request that would contact a server is refused now: the hub was disposed, or the view is off. */
  private blocked(): DbResult<never> | null {
    if (this.disposed) return { ok: false, problem: DISCONNECTED };
    return this.off() ? OFF : null;
  }

  /**
   * Why a read of connection `id` can't run now — asked when it comes and again at its turn: blocked, the connection
   * removed meanwhile, or held by an explicit Disconnect.
   */
  private gate(id: string): DbResult<never> | null {
    const b = this.blocked();
    if (b) return b;
    if (!this.deps.store.get(id)) return UNKNOWN;
    return this.rts.get(id)?.held ? HELD : null;
  }

  /** The hold of an explicit Disconnect ends (a window selects or connects it): every window is told. */
  private release(id: string): void {
    const rt = this.rts.get(id);
    if (!rt?.held) return;
    rt.held = false;
    this.broadcast();
  }

  private sees(root: string, c: DbConnection): boolean {
    return c.scope.kind === 'all' || c.scope.root === root;
  }

  /** The window and the connection, when that window may use it (its project's, or every project's); else null. */
  private connFor(wcId: number, id: string): { w: Win; c: DbConnection } | null {
    const w = this.windows.get(wcId);
    if (!w) return null;
    const c = this.deps.store.get(id);
    return c && this.sees(w.root, c) ? { w, c } : null;
  }

  /** The project's selection, when its windows can still see it. */
  private pickOf(root: string): string | null {
    const id = this.deps.store.pick(root);
    const c = id ? this.deps.store.get(id) : null;
    return c && this.sees(root, c) ? c.id : null;
  }

  private selectedAnywhere(id: string): boolean {
    for (const w of this.windows.values()) if (this.pickOf(w.root) === id) return true;
    return false;
  }

  private rt(id: string): Rt {
    let r = this.rts.get(id);
    if (!r) {
      r = {
        state: 'idle', problem: null, server: null, session: null, queries: null, tunnel: null, timeoutSec: 0, connecting: null, gen: 0,
        memPassword: null, hasSecret: undefined, secretVoid: false, catalog: null, catGen: 0, catLoad: null, overview: null, busy: 0, idle: null,
        held: false, queue: Promise.resolve(), waiting: new Map()
      };
      this.rts.set(id, r);
    }
    return r;
  }

  private freshId(): string {
    let id = newConnId();
    while (this.deps.store.get(id)) id = newConnId();
    return id;
  }

  private put(c: DbConnection): DbResult<null> {
    try {
      this.deps.store.put(c);
      return { ok: true, value: null };
    } catch (e) {
      return { ok: false, problem: { kind: 'other', message: e instanceof Error ? e.message : 'Not saved' } };
    }
  }

  private patch(wcId: number, id: string, p: Partial<Pick<DbConnection, 'mask' | 'writeNoted' | 'schema'>>): DbConnection | null {
    const f = this.connFor(wcId, id);
    if (!f) return null;
    const c = { ...f.c, ...p };
    if (!this.put(c).ok) return null;
    this.broadcast();
    return c;
  }

  /**
   * The form as the connections file would keep it, its fields named one by one (a stray key never gets in), scoped to
   * this window's project or to every project; or why the file would refuse it.
   */
  private validated(w: Win, form: DbConnectionForm, keep: Pick<DbConnection, 'id' | 'mask' | 'writeNoted' | 'createdAt'> & { schema?: string }): DbResult<DbConnection> {
    const candidate = {
      id: keep.id, name: form.name, engine: form.engine, env: form.env, host: form.host, port: form.port, database: form.database, user: form.user,
      ...(form.socket !== undefined ? { socket: form.socket } : {}), tls: form.tls, ssh: form.ssh,
      scope: form.scope?.kind === 'all' ? { kind: 'all' as const } : { kind: 'project' as const, root: w.root },
      mask: keep.mask, writeNoted: keep.writeNoted, ...(keep.schema !== undefined ? { schema: keep.schema } : {}), createdAt: keep.createdAt
    };
    const r = dbConnectionSchema.safeParse(candidate);
    if (r.success) return { ok: true, value: r.data };
    const where = r.error.issues[0]?.path.join('.') || 'form';
    return { ok: false, problem: { kind: 'other', message: `Invalid connection: ${where}` } };
  }

  // —— passwords ——

  private readSecret(id: string): string | null {
    if (this.rts.get(id)?.secretVoid) return null;
    try {
      const v = this.deps.secrets?.read(secretIdOf(id)) ?? null;
      return v === '' ? null : v;
    } catch {
      // Unavailable or unreadable: as if none was saved (the view asks for it).
      return null;
    }
  }

  /** True when the Keychain kept it. */
  private writeSecret(id: string, password: string): boolean {
    if (!this.deps.secrets) return false;
    try {
      this.deps.secrets.write(secretIdOf(id), password);
      const rt = this.rt(id);
      rt.hasSecret = true;
      rt.secretVoid = false;
      return true;
    } catch {
      return false;
    }
  }

  /** The connection now points at another server: its password goes, from the Keychain and from memory. */
  private forgetPassword(id: string): void {
    const rt = this.rt(id);
    rt.memPassword = null;
    rt.hasSecret = false;
    rt.secretVoid = true;
    try {
      this.deps.secrets?.remove(secretIdOf(id));
    } catch {
      // secretVoid keeps it unused until a new one is typed.
    }
  }

  private passwordOf(id: string): string {
    return this.rts.get(id)?.memPassword || this.readSecret(id) || '';
  }

  private hasPassword(id: string): boolean {
    const rt = this.rt(id);
    if (rt.memPassword) return true;
    if (rt.hasSecret === undefined) rt.hasSecret = this.secretSaved(id);
    return rt.hasSecret;
  }

  /**
   * Whether the Keychain holds one: asked without decrypting it when the store can say, else read once. A
   * blob that turns out unreadable is found at connect, which then asks for the password.
   */
  private secretSaved(id: string): boolean {
    const s = this.deps.secrets;
    if (!s?.has) return this.readSecret(id) !== null;
    if (this.rts.get(id)?.secretVoid) return false;
    try {
      return s.has(secretIdOf(id));
    } catch {
      return false;
    }
  }

  // —— sessions ——

  /**
   * The open session can serve the caller. One opened with another query timeout is replaced only once nothing else
   * uses it (the caller counts itself in `busy`): a read in progress is never cut short by a setting.
   */
  private live(rt: Rt): boolean {
    if (!rt.session || rt.session.closed || !rt.server) return false;
    return rt.timeoutSec === this.deps.settings().dbTimeoutSec || rt.busy > 1;
  }

  /**
   * The connection's session: the open one, the connect in progress, or a new one. With `password`, a new one with it.
   * Reads pass `retryAuth: false`: credentials the server refused aren't tried again until the user gives others.
   */
  private ensure(c: DbConnection, rt: Rt, o: { password?: string; retryAuth: boolean }): Promise<DbResult<DbServerInfo>> {
    if (this.disposed) return Promise.resolve({ ok: false, problem: DISCONNECTED });
    if (o.password === undefined) {
      if (this.live(rt)) return Promise.resolve({ ok: true, value: rt.server! });
      if (rt.connecting) return rt.connecting;
      if (!o.retryAuth && rt.state === 'password' && rt.problem) return Promise.resolve({ ok: false, problem: rt.problem });
    }
    const p = this.newSession(c, rt, o.password);
    rt.connecting = p;
    const settled = () => {
      if (rt.connecting === p) rt.connecting = null;
    };
    void p.then(settled, settled);
    return p;
  }

  /** Replaces the connection's session with a new one (`typed`: the password to use instead of the known one). */
  private async newSession(c: DbConnection, rt: Rt, typed?: string): Promise<DbResult<DbServerInfo>> {
    this.dropSession(rt);
    const gen = ++rt.gen;
    rt.state = 'connecting';
    rt.problem = null;
    this.broadcast();
    const password = typed ?? this.passwordOf(c.id);
    const timeoutSec = this.deps.settings().dbTimeoutSec;
    try {
      const d = await this.dial(c, password, timeoutSec);
      if (gen !== rt.gen) {
        d.session.close();
        d.tunnel?.close();
        return { ok: false, problem: DISCONNECTED };
      }
      rt.session = d.session;
      rt.tunnel = d.tunnel;
      rt.queries = new DbQueries(d.session);
      rt.server = d.server;
      rt.timeoutSec = timeoutSec;
      rt.state = 'connected';
      rt.problem = null;
      // Whatever asked for the session: the sidebar shows the selected connection's catalog. Queued behind the read that
      // may be opening it (never awaited here: that read's turn holds the queue).
      void this.wantCatalog(c.id);
      return { ok: true, value: d.server };
    } catch (e) {
      const problem = connectProblem(e, password);
      if (gen === rt.gen) {
        rt.state = problem.kind === 'auth' || problem.kind === 'password' ? 'password' : 'error';
        rt.problem = problem;
        rt.server = null;
        rt.catalog = null;
      }
      return { ok: false, problem };
    } finally {
      if (gen === rt.gen) {
        this.broadcast();
        this.armIdle(c.id);
      }
    }
  }

  /**
   * A session to c (through its SSH tunnel) and its server; on a failure, what was opened is closed and it throws. A
   * tunnel that opens once the hub is disposed (quit) is closed before anything is contacted.
   */
  private async dial(c: DbConnection, password: string, timeoutSec: number): Promise<{ session: DbSession; tunnel: Tunnel | null; server: DbServerInfo }> {
    let tunnel: Tunnel | null = null;
    let session: DbSession | null = null;
    try {
      let host = c.host;
      let port = c.port;
      let socket = c.socket;
      let servername: string | undefined;
      if (c.ssh) {
        if (!this.deps.tunnel) throw new DbError(NO_SSH);
        tunnel = await this.deps.tunnel(c.ssh, { host: c.host, port: c.port });
        if (this.disposed) throw new DbError(DISCONNECTED);
        host = '127.0.0.1';
        port = tunnel.localPort;
        socket = undefined;
        // TLS still names the real server (SNI, the certificate check), when it has a name.
        if (!isIpLiteral(c.host)) servername = c.host;
      }
      const t0 = Date.now();
      session = await this.deps.driver.connect({
        host, port, database: c.database, user: c.user, password, ...(socket !== undefined ? { socket } : {}),
        ...(servername !== undefined ? { servername } : {}), tls: c.tls, timeoutSec
      });
      return { session, tunnel, server: await readServerInfo(session, t0) };
    } catch (e) {
      session?.close();
      if (!tunnel) throw e;
      try {
        // Rewritten by connectProblem, once the password is hidden.
        throw this.disposed ? e : new TunnelFailure(e, await tunnel.lastError(), tunnel.localPort, c);
      } finally {
        tunnel.close();
      }
    }
  }

  /** Ends the session and its tunnel; one still open is marked as closed by the hub. */
  private dropSession(rt: Rt): void {
    const s = rt.session;
    if (s) {
      if (!s.closed) this.ownClosed.add(s);
      s.close();
    }
    rt.tunnel?.close();
    rt.session = null;
    rt.queries = null;
    rt.tunnel = null;
  }

  /**
   * Disconnect: the session goes, a connect in progress keeps nothing, the connection shows idle, the overview read is
   * forgotten. (A session replaced — a reconnect — keeps the overview of the last overviewMs: a read in line for its turn
   * may be the one that opens the new session.)
   */
  private closeConn(rt: Rt): void {
    rt.gen++;
    rt.catGen++;
    this.dropSession(rt);
    rt.overview = null;
    rt.connecting = null;
    rt.state = 'idle';
    rt.problem = null;
    rt.server = null;
    rt.catalog = null;
    rt.catLoad = null;
    if (rt.idle) clearTimeout(rt.idle);
    rt.idle = null;
  }

  /** Closes the session idleCloseMs from now unless a window selects it or a request uses it by then. */
  private armIdle(id: string): void {
    const rt = this.rts.get(id);
    if (!rt) return;
    if (rt.idle) clearTimeout(rt.idle);
    rt.idle = null;
    if ((!rt.session && !rt.connecting) || this.selectedAnywhere(id)) return;
    const timer = setTimeout(() => {
      if (rt.idle !== timer) return;
      rt.idle = null;
      // A request in progress arms it again when it ends; so does a connect.
      if (this.rts.get(id) !== rt || rt.busy > 0 || rt.connecting || this.selectedAnywhere(id)) return;
      this.closeConn(rt);
      this.broadcast();
    }, this.t.idleCloseMs);
    timer.unref?.();
    rt.idle = timer;
  }

  /** Connects (credentials tried again: the user asked) and reads the catalog when a window selects it. */
  private async connectSelected(id: string): Promise<DbResult<DbServerInfo>> {
    const c = this.deps.store.get(id);
    if (!c) return UNKNOWN;
    const rt = this.rt(id);
    rt.busy++;
    try {
      const r = await this.ensure(c, rt, { retryAuth: true });
      if (r.ok) await this.wantCatalog(id);
      return r;
    } finally {
      rt.busy--;
      this.armIdle(id);
    }
  }

  /**
   * The catalog of a connection a window selects, when it has none: read whatever opened the session — select, Connect,
   * a typed password, or a read (a table tab restored at launch, the overview's polling, a reconnect after a failed one
   * dropped it). One read at a time: a session opened under a select is asked for twice and reads it once.
   */
  private wantCatalog(id: string): Promise<void> {
    const rt = this.rt(id);
    if (rt.catalog || !this.selectedAnywhere(id)) return Promise.resolve();
    if (rt.catLoad) return rt.catLoad;
    const p: Promise<void> = this.loadCatalog(id).finally(() => {
      if (rt.catLoad === p) rt.catLoad = null;
    });
    rt.catLoad = p;
    return p;
  }

  /** The catalog of a connection a window selects, in the schema it remembers (else readCatalog picks one). */
  private async loadCatalog(id: string): Promise<void> {
    const c = this.deps.store.get(id);
    if (!c || !this.selectedAnywhere(id)) return;
    const rt = this.rt(id);
    const g = ++rt.catGen;
    const r = await this.through(c, (l) => readCatalog(l.session, c.schema ?? null));
    if (g !== rt.catGen) return;
    if (r.ok) rt.catalog = { connId: id, database: c.database, ...r.value, readAt: Date.now() };
    if (rt.state === 'connected') rt.problem = r.ok ? null : r.problem;
    this.broadcast();
  }

  /** A request on a connection a window may use (`slot`: see through). */
  private use<T>(wcId: number, id: string, read: (l: Live) => Promise<T>, slot?: string): Promise<DbResult<T>> {
    const f = this.connFor(wcId, id);
    if (!f) return Promise.resolve(UNKNOWN);
    return this.through(f.c, read, slot);
  }

  /**
   * A request through the connection, in its turn: one request at a time per connection, in the
   * order they came, so one still waiting can be dropped — a newer request for the same `slot` (a tab's page, estimate
   * or count) answers it Superseded at once, and it never runs. Asked again at its turn: a Disconnect, a removal, Never
   * or quit meanwhile answer instead of reconnecting.
   */
  private through<T>(c: DbConnection, read: (l: Live) => Promise<T>, slot?: string): Promise<DbResult<T>> {
    const now = this.gate(c.id);
    if (now) return Promise.resolve(now);
    const rt = this.rt(c.id);
    return new Promise<DbResult<T>>((resolve) => {
      let dropped = false;
      const drop = (): void => {
        dropped = true;
        resolve(SUPERSEDED);
      };
      if (slot !== undefined) {
        rt.waiting.get(slot)?.();
        rt.waiting.set(slot, drop);
      }
      const turn = async (): Promise<void> => {
        if (slot !== undefined && rt.waiting.get(slot) === drop) rt.waiting.delete(slot);
        if (dropped) return;
        try {
          resolve(this.gate(c.id) ?? (await this.runNow(c, read)));
        } catch (e) {
          resolve({ ok: false, problem: asProblem(e) });
        }
      };
      rt.queue = rt.queue.then(turn);
    });
  }

  /**
   * A request through the connection's session now, connecting on demand. A connection lost under it (a server
   * restart, sleep, the network) is reconnected once and the request tried again once; one the hub closed isn't.
   */
  private async runNow<T>(c: DbConnection, read: (l: Live) => Promise<T>): Promise<DbResult<T>> {
    const rt = this.rt(c.id);
    rt.busy++;
    try {
      for (let attempt = 0; ; attempt++) {
        const r = await this.ensure(c, rt, { retryAuth: false });
        if (!r.ok) return r;
        if (!rt.session || !rt.queries || !rt.server) return { ok: false, problem: DISCONNECTED };
        const l: Live = { session: rt.session, queries: rt.queries, server: rt.server };
        try {
          return { ok: true, value: await read(l) };
        } catch (e) {
          const p = asProblem(e);
          if (p.kind !== 'lost') return { ok: false, problem: p };
          if (this.ownClosed.has(l.session)) return { ok: false, problem: DISCONNECTED };
          if (attempt > 0) return { ok: false, problem: { ...p, message: 'The connection was lost' } };
        }
      }
    } finally {
      rt.busy--;
      this.armIdle(c.id);
    }
  }
}
