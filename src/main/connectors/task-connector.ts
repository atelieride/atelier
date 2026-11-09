// The base of every task connector: sign-in (oauth/oauth.ts),
// the status machine, the in-memory task cache, its refresh rules and the token refresh. A subclass (clickup/clickup.ts,
// notion/notion.ts) says who the user is, how tasks are fetched, read and searched, and what its saved connection holds.
// Main process only; the renderer gets ConnectorInfo, TaskList and TaskDetail, never a token or an auth URL.
//
// Statuses: disconnected → connecting → connected ⇄ offline; reconnect (the source refused the token, or the saved
// connection can't be read); unavailable (the source's sign-in or connector changed, or the workspace is gone).
// - Connect: discovery → loopback → DCR → browser → callback → token, then the tool check, who the user is (`identify`)
//   and the first task fetch. Only then is anything stored: a quit, a Cancel, a timeout or any failure
//   before that leaves nothing on disk. 5 minute timeout; one flow per connector.
// - Refresh: on connect, at launch, from tasks:list when older than 60 s, every 5 min while a window is focused (and on
//   focus when older than that). Offline / 5xx / timeouts → `offline` with the cache kept and retries after 30 s, 1, 2,
//   4, then every 5 min. 429 → no request until x-ratelimit-reset (≤ 5 min), status unchanged ("Slowing down…" past a
//   minute). 401 → `reconnect` (the token is dropped from the saved connection). No access → `onAccessLost` (ClickUp
//   re-reads its hierarchy; default `unavailable`). A reply Atelier can't read → `unavailable` (lists and tasks) or no
//   results (search). An oversized reply → that call fails, the cache stays.
// - Token refresh, only for a connection saved with a refresh token (ClickUp has none: none of this runs): an
//   access token that expires within a minute (half its lifetime for a short-lived one) is renewed before the operation
//   (one renewal at a time, every caller waits for it); a 401 → one renewal and one retry. A refused renewal (signed
//   out) is a 401 (→ `reconnect`); an unanswered, rate-limited or unreadable one is offline (→ backoff). New tokens are
//   stored at once.
// - Every operation has a 30 s deadline over its HTTP requests (each also has its own 20 s timeout in http.ts); a list
//   refresh has one 30 s deadline for all its calls (tools/list and every page), unless the subclass sets its own per
//   source (`refreshDeadline`: Notion, one per database; the tool check then has its own).
// - Connect while a flow runs focuses it (its page opens again); starting a flow drops whatever was in flight. Retry on
//   `unavailable` with no usable saved token (sign-in unsupported, or Connect failed before storing) signs in again.
import { z } from 'zod';
import type { WatchResult } from '@shared/automations';
import {
  DEFAULT_CONNECTOR_OPTIONS, type ConnectorId, type ConnectorInfo, type ConnectorNoticeKind, type ConnectorOptions,
  type ConnectorReason, type ConnectorStatus, type TaskDetail, type TaskGetResult, type TaskList, type TaskSummary
} from '@shared/tasks';
import { realClock, type Clock } from './clock';
import type { Connector, ConnectorEvents } from './connector';
import type { McpEndpoint } from './endpoint';
import {
  Aborted, AuthFailed, Forbidden, RateLimited, SchemaChanged, SecretUnavailable, ToolError, ToolsMissing, Unauthorized, Unreachable,
  type AuthFailureReason
} from './errors';
import type { Transport } from './http';
import { createMcpClient, type CallOptions, type McpClient } from './mcp/client';
import { missingTools, type AnyToolSet, type ToolArgs, type ToolName, type ToolReply } from './mcp/toolset';
import { refreshAccessToken, revokeToken, runOAuth, type AuthOpener, type OAuthOptions, type OAuthTokens } from './oauth/oauth';
import type { SecretStore } from './secret-store';

export const CONNECT_TIMEOUT_MS = 5 * 60_000;
export const STALE_MS = 60_000;
export const POLL_MS = 5 * 60_000;
export const BACKOFF_MS: readonly number[] = Object.freeze([30_000, 60_000, 120_000, 240_000, 300_000]);
export const OP_DEADLINE_MS = 30_000;
/** An access token this close to its expiry is renewed before the next operation. */
export const RENEW_BEFORE_MS = 60_000;
/** A rate-limit wait longer than this shows "Slowing down…". */
const SLOW_MS = 60_000;
const MAX_SEARCH_RESULTS = 50;
const MAX_URLS = 2000;

export interface TaskConnectorDeps extends ConnectorEvents {
  store: SecretStore;
  endpoint: Pick<McpEndpoint, 'base' | 'mcpUrl' | 'allow' | 'scope' | 'name'>;
  transport: Transport;
  /** Opens the authorize page (the user's browser; the test follower under ATELIER_TEST_FOLLOW_AUTH). */
  openAuthPage: AuthOpener;
  /** Some Atelier window is focused (hidden e2e windows count as focused). */
  focused(): boolean;
  /** One line in logs/app.log (never a token: messages here are ours or scrubbed). */
  log(message: string): void;
  /** Brings the window that started Connect forward (a no-op for hidden e2e windows). */
  reveal?(origin?: number): void;
  clock?: Clock;
  clientVersion?: string;
  /** Tests: the loopback's port binding. */
  loopback?: OAuthOptions['loopback'];
}

/**
 * What every saved connection holds (encrypted by the secret store, ATELIER_HOME/connectors/<id>.bin). `token: null` =
 * signed out. `refresh`, `expiresAt` and `clientId` exist only when the server issued a refresh token (Notion; never
 * ClickUp, whose blob keeps exactly its v1 fields).
 */
export interface SavedBase {
  v: 1;
  token: string | null;
  refresh?: string;
  /** ms since the epoch. */
  expiresAt?: number;
  /** The DCR client (or the CIMD URL): refresh and revocation need it. */
  clientId?: string;
  /** An API-token connection: `token` is the API token, sent as Basic with `basicUser`. */
  auth?: 'basic';
  basicUser?: string;
  userId: string;
  account?: string;
  workspace: { id: string; name: string };
  options: { includeClosed: boolean };
}

const TOKEN = /^[\x21-\x7e]{1,8192}$/;
/** An e-mail-shaped user, printable ASCII without `:` (it would split the Basic credentials). */
export const BASIC_USER = /^[\x21-\x39\x3b-\x7e]{1,64}@[\x21-\x39\x3b-\x7e]{1,189}$/;
/** An API token: printable ASCII, no spaces. */
export const API_TOKEN = /^[\x21-\x7e]{16,512}$/;
/** The token fields of a saved connection's zod schema, for every subclass's own (old blobs without them still parse). */
export const SAVED_TOKEN_FIELDS = {
  token: z.string().regex(TOKEN).nullable(),
  refresh: z.string().regex(TOKEN).optional(),
  expiresAt: z.number().finite().optional(),
  clientId: z.string().min(1).max(4096).optional(),
  auth: z.literal('basic').optional(),
  basicUser: z.string().regex(BASIC_USER).optional()
};

/** The API-token sign-in's credentials, as the user typed them (validated by the IPC schema and again here). */
export interface TokenCredentials { user: string; secret: string; site?: string }

/** The token fields to store from a sign-in or a renewal: the refresh set only with a refresh token. */
function tokenFields(t: OAuthTokens): Pick<SavedBase, 'token' | 'refresh' | 'expiresAt' | 'clientId'> {
  if (!t.refreshToken) return { token: t.accessToken };
  return { token: t.accessToken, refresh: t.refreshToken, clientId: t.clientId, ...(t.expiresAt !== undefined ? { expiresAt: t.expiresAt } : {}) };
}

/** `saved` without its refresh set (and its expiry), then with `fields`. */
function withTokens<S extends SavedBase>(saved: S, fields: Partial<SavedBase>): S {
  const { refresh: _r, expiresAt: _e, ...rest } = saved;
  return { ...rest, ...fields } as S;
}

interface Flow {
  ctl: AbortController;
  /** Set when Atelier stopped it: Cancel, the 5 minute timeout, Disconnect, quit. */
  why?: 'cancel' | 'timeout' | 'disconnect' | 'quit';
  /** The authorize URL and its callback, for "Open the page again". Main only. */
  url?: string;
  deliver?: (callbackUrl: string) => void;
  origin?: number;
  until: number;
  timer: unknown;
  previous: { status: ConnectorStatus; reason?: ConnectorReason; detail?: string };
}

export type Failure = 'unauthorized' | 'offline' | 'rate-limited' | 'schema' | 'access' | 'tool' | 'aborted' | 'other';

export const message = (e: unknown) => (e instanceof Error ? e.message : 'unknown error');

const AUTH_REASONS: Record<AuthFailureReason, ConnectorReason> = {
  unsupported: 'auth-unsupported', denied: 'denied', 'oauth-error': 'oauth-error', verify: 'verify-failed', port: 'port-failed', network: 'network', 'signed-out': 'signed-out'
};

/**
 * The current connection's client. A token renewal swaps the client inside, so `this.client` keeps its identity: an
 * operation that captured it still tells a renewed connection (same object) from a replaced or signed-out one.
 */
class LiveClient<T extends AnyToolSet> implements McpClient<T> {
  constructor(public current: McpClient<T>) {}
  callTool<N extends ToolName<T>>(name: N, args: ToolArgs<T, N>, o?: CallOptions): Promise<ToolReply<T, N>> {
    return this.current.callTool(name, args, o);
  }
  listTools(o?: CallOptions): Promise<string[]> {
    return this.current.listTools(o);
  }
}

/** `p`, or Aborted as soon as `signal` aborts (the shared renewal goes on for the other callers). */
function abortable<R>(p: Promise<R>, signal: AbortSignal): Promise<R> {
  if (signal.aborted) return Promise.reject(new Aborted());
  return new Promise<R>((resolve, reject) => {
    const onAbort = () => reject(new Aborted());
    signal.addEventListener('abort', onAbort, { once: true });
    p.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

export abstract class TaskConnector<S extends SavedBase, T extends AnyToolSet> implements Connector {
  abstract readonly id: ConnectorId;
  abstract readonly name: string;
  /** The connector's read-only allowlist (its tools.ts). */
  protected abstract readonly tools: T;
  /**
   * A list refresh's deadline: one over all its calls (`whole`), or none over the refresh, `fetchTasks` setting one per
   * source itself (`per-source`: Notion's databases, so many valid ones never add up to a timeout).
   */
  protected readonly refreshDeadline: 'whole' | 'per-source' = 'whole';
  protected readonly clock: Clock;
  protected status: ConnectorStatus = 'disconnected';
  protected reason: ConnectorReason | undefined;
  protected detail: string | undefined;
  protected saved: S | null = null;
  protected client: LiveClient<T> | null = null;
  protected options: ConnectorOptions = { ...DEFAULT_CONNECTOR_OPTIONS };
  private tasks: TaskSummary[] = [];
  private readonly urls = new Map<string, string>();
  private updatedAt: number | undefined;
  private tasksVersion = 0;
  private flow: Flow | null = null;
  /** Aborted by Disconnect and quit: every in-flight call of the current connection stops and its reply is dropped. */
  protected life = new AbortController();
  private refreshing: Promise<void> | null = null;
  private refreshAgain = false;
  /** The search in flight: the next one stops it. */
  private searching: AbortController | null = null;
  /** The token renewal in flight, shared by every operation that needs it. */
  private renewing: Promise<void> | null = null;
  /** How long the current access token was issued for (ms), when it was issued in this run. */
  private lifetime: number | undefined;
  private retryTimer: unknown = null;
  private pollTimer: unknown = null;
  private backoff = 0;
  private holdUntil = 0;
  private toolsChecked = false;
  private disposed = false;
  private readonly work = new Set<Promise<unknown>>();

  constructor(protected readonly deps: TaskConnectorDeps) {
    this.clock = deps.clock ?? realClock;
  }

  // ── What a subclass provides ────────────────────────────────────────────────────────────────────────────────────

  /** The saved connection's own schema (a JSON value in, null when it isn't one). */
  protected abstract parseSaved(raw: unknown): S | null;
  /**
   * After sign-in and the tool check, before anything is stored: who the user is and the workspace. The token fields
   * come from `tokens` (the base sets them on the result).
   */
  protected abstract identify(client: McpClient<T>, tokens: OAuthTokens, signal: AbortSignal, hint?: { site?: string }): Promise<S>;
  /** The API-token sign-in is offered: Jira only. */
  protected readonly tokenSignIn: boolean = false;
  /** The user's tasks, mapped; `update` changes the saved connection (merged onto the current one and stored). */
  protected abstract fetchTasks(client: McpClient<T>, saved: S, signal: AbortSignal): Promise<{ tasks: TaskSummary[]; update?: Partial<S> }>;
  protected abstract getTask(client: McpClient<T>, saved: S, id: string, signal: AbortSignal): Promise<TaskDetail>;
  /** At most 50 are kept. */
  protected abstract searchTasks(client: McpClient<T>, saved: S, query: string, signal: AbortSignal): Promise<TaskSummary[]>;
  /** Automations: the tasks of these scopes, whoever they are assigned to. A source without it throws. */
  protected watchTasks(_client: McpClient<T>, _saved: S, _scopes: readonly string[], _signal: AbortSignal): Promise<WatchResult> {
    return Promise.reject(new Error(`${this.name} can't be watched yet`));
  }
  /** Automations' editor: the places tasks live (ClickUp's lists). A source without it has none to offer. */
  protected listScopes(_client: McpClient<T>, _saved: S, _signal: AbortSignal): Promise<{ id: string; label: string }[]> {
    return Promise.resolve([]);
  }
  /**
   * Automations' editor: the statuses these scopes define, used by a task or not
   * (ClickUp's lists, Notion's status column). A source without them has none: its chips offer what tasks carry.
   */
  protected listDefinedStatuses(_client: McpClient<T>, _saved: S, _scopes: readonly string[], _signal: AbortSignal): Promise<{ name: string; color?: string }[]> {
    return Promise.resolve([]);
  }
  /** Why a Connect that lost access at its first reads is unavailable (Jira: an account with no Jira site). */
  protected accessReason(_e: unknown): ConnectorReason {
    return 'workspace-gone';
  }
  /** Automations: the scopes among these whose tasks strangers write (Jira's service projects); none elsewhere. */
  serviceScopes(_scopes: readonly string[]): string[] {
    return [];
  }
  /** Automations' "Created by": who created a task (null: unknown). */
  protected taskCreator(_client: McpClient<T>, _saved: S, _id: string, _signal: AbortSignal): Promise<{ id: string; name: string } | null> {
    return Promise.resolve(null);
  }
  /** A well-formed task id of this source (anything else is `gone` without a request). */
  abstract isTaskId(id: string): boolean;
  /** The web page of a task built from a valid id, when the source gave no URL. */
  abstract taskUrlFor(id: string): string;
  abstract appUrl(id: string): string | null;

  /** What a failure means for the status machine. ClickUp also reads "no access" in tool errors. */
  protected classify(e: unknown): Failure {
    if (e instanceof Unauthorized) return 'unauthorized';
    if (e instanceof Unreachable) return 'offline';
    if (e instanceof RateLimited) return 'rate-limited';
    if (e instanceof SchemaChanged) return 'schema';
    if (e instanceof Forbidden) return 'access';
    if (e instanceof ToolError) return 'tool';
    if (e instanceof Aborted) return 'aborted';
    return 'other';
  }

  /** A list refresh found no access: by default the workspace is gone. */
  protected async onAccessLost(_client: McpClient<T>, _signal: AbortSignal): Promise<void> {
    this.clearCache();
    this.toUnavailable('workspace-gone');
  }

  /** After a list refresh worked, before it reports `connected` (ClickUp names a generic workspace). */
  protected async afterRefresh(_client: McpClient<T>, _signal: AbortSignal): Promise<void> {
    // nothing by default
  }

  /** More fields for the card (Notion: its sources). */
  protected infoExtra(): Partial<ConnectorInfo> {
    return {};
  }

  /** The MCP client for a token, or for an API token with its user (tests stub it). */
  protected makeClient(token: string, basicUser?: string): McpClient<T> {
    return createMcpClient({
      mcpUrl: this.deps.endpoint.mcpUrl, allow: this.deps.endpoint.allow, transport: this.deps.transport, token, tools: this.tools,
      ...(basicUser !== undefined ? { basicUser } : {}),
      now: () => this.clock.now(), ...(this.deps.clientVersion ? { clientVersion: this.deps.clientVersion } : {})
    });
  }

  // ── Launch, info ────────────────────────────────────────────────────────────────────────────────────────────────

  init(): void {
    let raw: string | null;
    try {
      raw = this.deps.store.read(this.id);
    } catch (e) {
      this.log(`saved connection can't be read: ${message(e)}`);
      this.toReconnect('unreadable');
      return;
    }
    if (raw === null) return;
    const saved = this.load(raw);
    if (!saved) { this.log("saved connection can't be read: unexpected shape"); this.toReconnect('unreadable'); return; }
    this.saved = saved;
    this.options = { ...DEFAULT_CONNECTOR_OPTIONS, includeClosed: saved.options.includeClosed };
    if (!saved.token) { this.toReconnect(saved.auth === 'basic' ? 'token-expired' : 'signed-out'); return; }
    this.client = new LiveClient(this.makeClient(saved.token, saved.auth === 'basic' ? saved.basicUser : undefined));
    this.status = 'connected';
    this.startPoll();
    void this.refreshNow();
    this.changed();
  }

  private load(raw: string): S | null {
    try {
      return this.parseSaved(JSON.parse(raw));
    } catch {
      return null;
    }
  }

  info(): ConnectorInfo {
    const live = this.status === 'connected' || this.status === 'offline';
    return {
      id: this.id, name: this.name, status: this.status,
      ...(this.saved?.account ? { account: this.saved.account } : {}),
      ...(this.saved ? { workspace: this.saved.workspace.name } : {}),
      ...(live && this.updatedAt !== undefined ? { updatedAt: this.updatedAt } : {}),
      ...(this.reason ? { reason: this.reason } : {}),
      ...(this.detail ? { detail: this.detail } : {}),
      ...(this.flow ? { connectingUntil: this.flow.until } : {}),
      loading: this.refreshing !== null,
      tasksVersion: this.tasksVersion,
      options: { ...this.options },
      ...(this.saved?.auth === 'basic' ? { signIn: 'token' as const, ...(this.saved.basicUser ? { tokenUser: this.saved.basicUser } : {}) } : {}),
      ...this.infoExtra()
    };
  }

  // ── Connect ─────────────────────────────────────────────────────────────────────────────────────────────────────

  connect(origin?: number): void {
    if (this.disposed) return;
    // One flow per connector: a Connect from any window focuses the running one (its page opens again).
    if (this.flow) { this.reopenAuth(); return; }
    const flow = this.startFlow(origin);
    if (flow) this.track(this.runConnect(flow));
  }

  /**
   * The API-token sign-in: no browser and no loopback, the same checks as Connect (tools,
   * identify, the first fetch) before anything is stored. Ignored by a connector that doesn't offer it, while a flow
   * runs, and when connected.
   */
  connectWithToken(creds: TokenCredentials, origin?: number): void {
    if (this.disposed || !this.tokenSignIn || this.flow) return;
    if (!BASIC_USER.test(creds.user) || !API_TOKEN.test(creds.secret)) return;
    const flow = this.startFlow(origin);
    if (flow) this.track(this.runTokenConnect(flow, creds));
  }

  /** Connect's common start: the checks, a fresh life, the 5 minute flow. Null when nothing may start. */
  private startFlow(origin: number | undefined): Flow | null {
    if (this.status === 'connected' || this.status === 'offline') return null;
    if (!this.deps.store.available()) {
      this.reason = 'keychain-unavailable';
      this.detail = undefined;
      this.notice('keychain-unavailable', undefined, origin);
      this.changed();
      return null;
    }
    // Whatever the old connection had in flight (a Retry's refresh, a task fetch) is dropped: a late reply must never
    // overwrite `connecting`.
    this.life.abort();
    this.life = new AbortController();
    this.refreshing = null;
    this.refreshAgain = false;
    this.renewing = null;
    this.stopTimers();
    const flow: Flow = {
      ctl: new AbortController(), origin, until: this.clock.now() + CONNECT_TIMEOUT_MS, timer: null,
      previous: { status: this.status, ...(this.reason ? { reason: this.reason } : {}), ...(this.detail ? { detail: this.detail } : {}) }
    };
    flow.timer = this.clock.setTimeout(() => this.stopFlow('timeout'), CONNECT_TIMEOUT_MS);
    this.flow = flow;
    this.status = 'connecting';
    this.reason = undefined;
    this.detail = undefined;
    this.changed();
    return flow;
  }

  cancel(): void {
    this.stopFlow('cancel');
  }

  reopenAuth(): void {
    const f = this.flow;
    if (f?.url && f.deliver) this.deps.openAuthPage(f.url, f.deliver);
  }

  private stopFlow(why: NonNullable<Flow['why']>): void {
    const f = this.flow;
    if (!f) return;
    f.why = why;
    f.ctl.abort();
  }

  private endFlow(f: Flow): void {
    this.clock.clearTimeout(f.timer);
    if (this.flow === f) this.flow = null;
  }

  private async runConnect(flow: Flow): Promise<void> {
    const signal = flow.ctl.signal;
    try {
      const tokens = await runOAuth({
        endpoint: this.deps.endpoint, transport: this.deps.transport, signal,
        open: (url, deliver) => { flow.url = url; flow.deliver = deliver; this.deps.openAuthPage(url, deliver); },
        ...(this.deps.loopback ? { loopback: this.deps.loopback } : {}),
        now: () => this.clock.now()
      });
      const client = new LiveClient(this.makeClient(tokens.accessToken));
      await this.finishConnect(flow, client, tokens, tokenFields(tokens));
    } catch (e) {
      if (this.flow !== flow) return; // Disconnect or quit took it over
      this.endFlow(flow);
      this.connectFailed(flow, e);
    }
  }

  private async runTokenConnect(flow: Flow, creds: TokenCredentials): Promise<void> {
    try {
      const client = new LiveClient(this.makeClient(creds.secret, creds.user));
      // No OAuth tokens: identify gets the API token as the access token, and the site the user typed.
      await this.finishConnect(flow, client, { accessToken: creds.secret, clientId: '' }, { token: creds.secret, auth: 'basic', basicUser: creds.user },
        creds.site !== undefined ? { site: creds.site } : {});
    } catch (e) {
      if (this.flow !== flow) return;
      this.endFlow(flow);
      // The server refused the token itself, the token can't see the tools (made without scopes: Atlassian lists almost
      // nothing for it), or the site typed isn't one the account can open: say so where the user typed them (a first
      // fetch failing for another reason is the generic case).
      const failure = flow.why === undefined ? this.classify(e) : null;
      const scopes = flow.why === undefined && e instanceof ToolsMissing;
      if (failure === 'unauthorized' || failure === 'access' || scopes) {
        const reason = scopes ? 'token-scopes' : failure === 'unauthorized' ? 'token-refused' : 'token-site';
        this.status = 'disconnected';
        this.reason = reason;
        this.detail = undefined;
        this.notice(reason, undefined, flow.origin);
        this.changed();
        return;
      }
      this.connectFailed(flow, e);
    }
  }

  /** The tools, the account, the workspace and the first tasks, before anything is stored. */
  private async finishConnect(flow: Flow, client: LiveClient<T>, tokens: OAuthTokens, fields: Partial<SavedBase>, hint?: { site?: string }): Promise<void> {
    const signal = flow.ctl.signal;
    const tools = await this.op(signal, (s) => client.listTools({ signal: s }));
    const missing = missingTools(this.tools, tools);
    if (missing.length) throw new ToolsMissing(missing);
    let saved: S = { ...await this.identify(client, tokens, signal, hint), ...fields };
    const { tasks, update } = await this.fetchTasks(client, saved, signal);
    if (signal.aborted) throw new Aborted();
    if (update) saved = { ...saved, ...update };
    this.deps.store.write(this.id, JSON.stringify(saved));
    this.endFlow(flow);
    this.life = new AbortController();
    this.saved = saved;
    this.client = client;
    this.noteLifetime(tokens.expiresAt);
    this.toolsChecked = true;
    this.status = 'connected';
    this.reason = undefined;
    this.detail = undefined;
    this.backoff = 0;
    this.holdUntil = 0;
    this.applyTasks(tasks);
    this.startPoll();
    this.changed();
    this.deps.reveal?.(flow.origin);
  }

  private connectFailed(flow: Flow, e: unknown): void {
    const back = flow.previous;
    // Where a failed Connect goes back to: a signed-out or broken saved connection stays what it was.
    const fallback: ConnectorStatus = back.status === 'reconnect' || (back.status === 'unavailable' && this.saved) ? back.status : 'disconnected';
    if (flow.why === 'cancel') {
      this.status = fallback;
      this.reason = fallback === back.status ? back.reason : undefined;
      this.detail = fallback === back.status ? back.detail : undefined;
      this.changed();
      return;
    }
    const fail = (status: ConnectorStatus, reason: ConnectorReason, kind: ConnectorNoticeKind, detail?: string) => {
      this.status = status;
      this.reason = reason;
      this.detail = detail;
      this.notice(kind, detail, flow.origin);
      this.changed();
    };
    if (flow.why === 'timeout') return fail(fallback, 'timeout', 'timeout');
    if (e instanceof AuthFailed) {
      const reason = AUTH_REASONS[e.reason];
      if (e.reason === 'unsupported') this.log('sign-in unsupported: the authorization server lacks DCR (or CIMD), S256, public clients or the code grant, or its discovery is off');
      return fail(e.reason === 'unsupported' ? 'unavailable' : fallback, reason, reason as ConnectorNoticeKind, e.detail);
    }
    if (e instanceof SecretUnavailable) return fail(fallback, 'keychain-unavailable', 'keychain-unavailable');
    switch (this.classify(e)) {
      // A saved connection: signed out. Nothing saved (a first Connect, or an unreadable one): there is no one to sign
      // out — `reconnect` with nothing saved would also quietly turn into `disconnected` at the next launch.
      case 'unauthorized': return this.saved ? fail('reconnect', 'signed-out', 'reconnect') : fail(fallback, 'fetch-failed', 'fetch-failed');
      case 'offline': return fail(fallback, 'network', 'network');
      case 'schema':
        this.log(`connector changed: ${message(e)}`);
        return fail('unavailable', 'connector-changed', 'unavailable');
      case 'access': return fail('unavailable', this.accessReason(e), 'unavailable');
      default:
        this.log(`first task fetch failed: ${message(e)}`);
        return fail(fallback, 'fetch-failed', 'fetch-failed');
    }
  }

  // ── Disconnect, quit ────────────────────────────────────────────────────────────────────────────────────────────

  disconnect(): void {
    const f = this.flow;
    if (f) { f.why = 'disconnect'; this.endFlow(f); f.ctl.abort(); }
    this.life.abort();
    this.life = new AbortController();
    this.stopTimers();
    this.revoke();
    try { this.deps.store.remove(this.id); } catch (e) { this.log(`couldn't delete the saved connection: ${message(e)}`); }
    this.saved = null;
    this.client = null;
    this.clearCache();
    this.refreshing = null;
    this.refreshAgain = false;
    this.renewing = null;
    this.lifetime = undefined;
    this.status = 'disconnected';
    this.reason = undefined;
    this.detail = undefined;
    this.options = { ...DEFAULT_CONNECTOR_OPTIONS };
    this.backoff = 0;
    this.holdUntil = 0;
    this.toolsChecked = false;
    this.changed();
  }

  /** Disconnect (spec A.2): the server forgets the token, best effort, when the connection has a client id (a refresh set). */
  private revoke(): void {
    const saved = this.saved;
    const token = saved?.refresh ?? saved?.token;
    if (!saved?.clientId || !token) return;
    this.track(revokeToken({ endpoint: this.deps.endpoint, transport: this.deps.transport, clientId: saved.clientId, token }));
  }

  dispose(): void {
    this.disposed = true;
    const f = this.flow;
    if (f) { f.why = 'quit'; this.endFlow(f); f.ctl.abort(); }
    this.life.abort();
    this.stopTimers();
  }

  // ── Tasks ───────────────────────────────────────────────────────────────────────────────────────────────────────

  taskList(): TaskList {
    if (this.status === 'connected' && this.stale(STALE_MS)) void this.refreshNow();
    const live = this.status === 'connected' || this.status === 'offline';
    return {
      source: this.id, status: this.status, loading: this.refreshing !== null,
      ...(live && this.updatedAt !== undefined ? { updatedAt: this.updatedAt } : {}),
      tasks: live ? [...this.tasks] : []
    };
  }

  /** The connected user's id ("me" in automations' conditions), null when not connected. */
  userIdNow(): string | null {
    return this.saved?.userId ?? null;
  }

  /**
   * Automations' read: the tasks of these scopes with what conditions read. A 401 signs out, a
   * network failure goes offline, a 429 holds, a changed shape is `unavailable` — as for every read; the error is
   * thrown to the runner, which tries again one interval later.
   */
  async watch(scopes: readonly string[]): Promise<WatchResult> {
    return this.automationRead((c, saved, s) => this.watchTasks(c, saved, scopes, s));
  }

  /** Automations' editor: where tasks live, with names people know. */
  async scopes(): Promise<{ id: string; label: string }[]> {
    return this.automationRead((c, saved, s) => this.listScopes(c, saved, s));
  }

  /** Automations' editor: the statuses the scopes define, best effort (none when they can't be read; never throws). */
  async definedStatuses(scopes: readonly string[]): Promise<{ name: string; color?: string }[]> {
    try {
      return await this.automationRead((c, saved, s) => this.listDefinedStatuses(c, saved, scopes, s));
    } catch (e) {
      this.log(`defined statuses not read: ${message(e)}`);
      return [];
    }
  }

  /** Automations' "Created by" (null: unknown or gone). */
  async creator(id: string): Promise<{ id: string; name: string } | null> {
    if (typeof id !== 'string' || !this.isTaskId(id)) return null;
    try {
      return await this.automationRead((c, saved, s) => this.taskCreator(c, saved, id, s));
    } catch (e) {
      if (this.classify(e) === 'tool' || this.classify(e) === 'access') return null;
      throw e;
    }
  }

  private async automationRead<R>(fn: (c: McpClient<T>, saved: S, signal: AbortSignal) => Promise<R>): Promise<R> {
    const client = this.client;
    const saved = this.saved;
    if (!client || !saved || this.status !== 'connected') throw new Error(`${this.name} isn't connected`);
    if (this.clock.now() < this.holdUntil) throw new Error(`${this.name} asked Atelier to slow down`);
    const signal = this.life.signal;
    try {
      return await this.op(signal, (s) => this.withClient(s, (c) => fn(c, saved, s)));
    } catch (e) {
      if (!signal.aborted && this.client === client) {
        switch (this.classify(e)) {
          case 'unauthorized': this.signOut(); break;
          case 'offline': this.goOffline(); break;
          case 'rate-limited': this.hold((e as RateLimited).resetAt); break;
          case 'schema':
            this.log(`connector changed: ${message(e)}`);
            this.toUnavailable('connector-changed');
            break;
          default: break;
        }
      }
      throw e;
    }
  }

  async task(id: string): Promise<TaskGetResult> {
    if (typeof id !== 'string' || !this.isTaskId(id)) return { ok: false, reason: 'gone' };
    if (this.status === 'reconnect') return { ok: false, reason: 'reconnect' };
    if (this.status === 'unavailable') return { ok: false, reason: 'unavailable' };
    const client = this.client;
    const saved = this.saved;
    if (!client || !saved || (this.status !== 'connected' && this.status !== 'offline')) return { ok: false, reason: 'not-connected' };
    if (this.clock.now() < this.holdUntil) return { ok: false, reason: 'busy' };
    const signal = this.life.signal;
    try {
      const detail = await this.op(signal, (s) => this.withClient(s, (c) => this.getTask(c, saved, id, s)));
      this.rememberUrl(detail.id, detail.url);
      if (this.status === 'offline') void this.refreshNow();
      return { ok: true, task: detail };
    } catch (e) {
      if (signal.aborted || this.client !== client) return { ok: false, reason: 'not-connected' };
      switch (this.classify(e)) {
        case 'unauthorized': this.signOut(); return { ok: false, reason: 'reconnect' };
        case 'offline': this.goOffline(); return { ok: false, reason: 'offline' };
        case 'rate-limited': this.hold((e as RateLimited).resetAt); return { ok: false, reason: 'busy' };
        case 'schema':
          this.log(`connector changed: ${message(e)}`);
          this.toUnavailable('connector-changed');
          return { ok: false, reason: 'unavailable' };
        case 'access':
        case 'tool': return { ok: false, reason: 'gone' };
        default:
          this.log(`task fetch failed: ${message(e)}`);
          return { ok: false, reason: 'failed' };
      }
    }
  }

  /**
   * The source's search. Its reply shape may be loose, so any failure is "no results" (logged), never `unavailable`
   *; only a 401 has an effect (`reconnect`). A new search stops the one still
   * running (it answers no results): typing in the palette never piles up requests (Notion's run one per database).
   */
  async search(query: string): Promise<TaskSummary[]> {
    const keywords = typeof query === 'string' ? query.trim().slice(0, 200) : '';
    this.searching?.abort();
    this.searching = null;
    const client = this.client;
    const saved = this.saved;
    if (!keywords || !client || !saved || (this.status !== 'connected' && this.status !== 'offline') || this.clock.now() < this.holdUntil) return [];
    const ctl = new AbortController();
    this.searching = ctl;
    const life = this.life.signal;
    const onLife = () => ctl.abort();
    life.addEventListener('abort', onLife, { once: true });
    const signal = ctl.signal;
    try {
      const found = await this.op(signal, (s) => this.withClient(s, (c) => this.searchTasks(c, saved, keywords, s)));
      if (signal.aborted) return [];
      const out = found.slice(0, MAX_SEARCH_RESULTS);
      for (const t of out) this.rememberUrl(t.id, t.url);
      return out;
    } catch (e) {
      if (signal.aborted || this.client !== client) return [];
      if (e instanceof Unauthorized) this.signOut();
      else this.log(`search failed: ${message(e)}`);
      return [];
    } finally {
      life.removeEventListener('abort', onLife);
      if (this.searching === ctl) this.searching = null;
    }
  }

  taskUrl(id: string): string | null {
    if (typeof id !== 'string' || !this.isTaskId(id)) return null;
    return this.urls.get(id) ?? this.taskUrlFor(id);
  }

  setOptions(patch: Partial<Pick<ConnectorOptions, 'includeClosed'>>): void {
    if (typeof patch.includeClosed !== 'boolean' || patch.includeClosed === this.options.includeClosed) return;
    this.options = { ...this.options, includeClosed: patch.includeClosed };
    if (this.saved) {
      this.saved = { ...this.saved, options: { includeClosed: patch.includeClosed } };
      this.persist();
    }
    this.refreshSoon();
    this.changed();
  }

  refresh(origin?: number): void {
    if (this.status === 'unavailable') {
      // Unavailable with no usable token (sign-in unsupported, or Connect failed before storing): Retry signs in again.
      if (!this.client || !this.saved?.token) { this.connect(origin); return; }
      this.toolsChecked = false;
    }
    void this.refreshNow();
  }

  windowFocused(): void {
    if (this.status === 'connected' && this.stale(POLL_MS)) void this.refreshNow();
  }

  /** Tests: resolves once nothing this connector started is still running. */
  async idle(): Promise<void> {
    while (this.work.size) await Promise.allSettled([...this.work]);
    for (let i = 0; i < 10; i++) await Promise.resolve();
  }

  // ── Internals ───────────────────────────────────────────────────────────────────────────────────────────────────

  protected refreshNow(): Promise<void> {
    if (this.refreshing) return this.refreshing;
    const client = this.client;
    const saved = this.saved;
    if (this.disposed || !client || !saved?.token) return Promise.resolve();
    if (this.status !== 'connected' && this.status !== 'offline' && this.status !== 'unavailable') return Promise.resolve();
    if (this.clock.now() < this.holdUntil) return Promise.resolve();
    this.clearRetry();
    const signal = this.life.signal;
    const run = async () => {
      try {
        // One 30 s deadline for the whole refresh (tools/list and every page): "Loading tasks…" never lasts longer.
        // Per source: the tool check has its own, and fetchTasks one per source.
        const whole = this.refreshDeadline === 'whole';
        const within = <R>(fn: (s: AbortSignal) => Promise<R>): Promise<R> => (whole ? this.op(signal, fn) : fn(signal));
        const { tasks, update } = await within((s) => this.withClient(s, async (c) => {
          if (!this.toolsChecked) {
            const listed = await (whole ? c.listTools({ signal: s }) : this.op(s, (t) => c.listTools({ signal: t })));
            const missing = missingTools(this.tools, listed);
            if (missing.length) throw new SchemaChanged(`tools missing: ${missing.join(', ')}`);
            this.toolsChecked = true;
          }
          return this.fetchTasks(c, saved, s);
        }));
        // Signed out (or replaced) meanwhile: this reply belongs to a connection that is gone.
        if (signal.aborted || this.client !== client) return;
        this.applyTasks(tasks);
        if (update && this.saved) { this.saved = { ...this.saved, ...update }; this.persist(); }
        await this.afterRefresh(client, signal);
        if (signal.aborted || this.client !== client) return;
        this.backOnline();
      } catch (e) {
        if (signal.aborted || this.client !== client) return;
        await this.refreshFailed(e, client, signal);
      }
    };
    const p: Promise<void> = run().finally(() => {
      if (this.refreshing !== p) return;
      this.refreshing = null;
      if (signal.aborted) return;
      this.changed();
      if (this.refreshAgain) { this.refreshAgain = false; void this.refreshNow(); }
    });
    this.refreshing = p;
    this.track(p);
    this.changed();
    return p;
  }

  /**
   * A refresh that reads the saved connection as it is now: at once, or right after the one in flight (which read it
   * before the change: an option, a source added or edited).
   */
  protected refreshSoon(): void {
    if (this.refreshing) this.refreshAgain = true;
    else void this.refreshNow();
  }

  /** A list refresh is running ("Loading tasks…"). */
  protected get refreshInFlight(): boolean {
    return this.refreshing !== null;
  }

  private async refreshFailed(e: unknown, client: McpClient<T>, signal: AbortSignal): Promise<void> {
    switch (this.classify(e)) {
      case 'unauthorized': return this.signOut();
      case 'offline': return this.goOffline();
      case 'rate-limited': return this.hold((e as RateLimited).resetAt);
      case 'schema':
        this.log(`connector changed: ${message(e)}`);
        return this.toUnavailable('connector-changed');
      case 'access': return this.onAccessLost(client, signal);
      default:
        // Oversized, a tool error, a bug: this call fails, the cache stays.
        this.log(`task list fetch failed: ${message(e)}`);
    }
  }

  /** A fetch worked: connected, backoff reset, no retry pending (one a failed task fetch may have scheduled), polling. */
  protected backOnline(): void {
    this.status = 'connected';
    this.reason = undefined;
    this.detail = undefined;
    this.backoff = 0;
    this.clearRetry();
    this.startPoll();
  }

  // ── Token refresh ────────────────────────────────────────────────────────────────────────

  /**
   * Runs one operation with the current client, renewing the access token first when it expires within a minute, and
   * once more (then one retry) when the server answers 401. Without a refresh token this is just `fn(client)`.
   */
  protected async withClient<R>(signal: AbortSignal, fn: (c: McpClient<T>) => Promise<R>): Promise<R> {
    const client = this.client;
    if (!client) throw new Aborted();
    if (this.expiring()) await this.renewed(signal);
    const used = this.saved?.token;
    try {
      return await fn(client);
    } catch (e) {
      if (!(e instanceof Unauthorized) || !this.canRenew() || signal.aborted || this.client !== client) throw e;
      // Another operation may have renewed the token meanwhile: then only the retry.
      if (this.saved?.token === used) await this.renewed(signal);
      return await fn(client);
    }
  }

  private canRenew(): boolean {
    return !!(this.saved?.refresh && this.saved.clientId);
  }

  /**
   * Renew when less than a minute is left, or less than half the lifetime of a token issued for under two minutes (so
   * a 50 s token isn't renewed before every call). The lifetime is known only for tokens issued in this run.
   */
  private expiring(): boolean {
    const at = this.saved?.expiresAt;
    if (!this.canRenew() || at === undefined) return false;
    const early = this.lifetime === undefined ? RENEW_BEFORE_MS : Math.min(RENEW_BEFORE_MS, this.lifetime / 2);
    return at - this.clock.now() < early;
  }

  private noteLifetime(expiresAt: number | undefined): void {
    this.lifetime = expiresAt === undefined ? undefined : Math.max(0, expiresAt - this.clock.now());
  }

  /** Waits for the shared renewal (starting it if none runs), as long as the caller's signal allows. */
  private renewed(signal: AbortSignal): Promise<void> {
    this.renewing ??= this.renew();
    return abortable(this.renewing, signal);
  }

  /**
   * One renewal for every waiting operation. Refused (AuthFailed('signed-out'): `invalid_grant`, a 400 / 401) →
   * Unauthorized: the callers sign out as for a 401. Unanswered, rate limited or a reply Atelier can't read →
   * Unreachable: they go offline with the backoff and try again.
   */
  private renew(): Promise<void> {
    const client = this.client;
    const saved = this.saved;
    const signal = this.life.signal;
    const run = async () => {
      if (!client || !saved?.refresh || !saved.clientId) throw new Unauthorized();
      let t: OAuthTokens;
      try {
        t = await refreshAccessToken({
          endpoint: this.deps.endpoint, transport: this.deps.transport, clientId: saved.clientId, refreshToken: saved.refresh, signal,
          now: () => this.clock.now()
        });
      } catch (e) {
        if (!(e instanceof AuthFailed)) throw e;
        if (e.reason === 'signed-out') { this.log('token refresh refused: signed out'); throw new Unauthorized(); }
        // A reply Atelier can't read is not the user's sign-in failing: retry later (backoff), signed in.
        this.log(`token refresh failed: ${e.reason}`);
        throw new Unreachable('server');
      }
      if (signal.aborted || this.client !== client || !this.saved) throw new Aborted();
      // Stored at once: a quit right after must not leave a spent refresh token on disk (servers rotate them).
      this.saved = withTokens(this.saved, tokenFields(t));
      this.persist();
      this.noteLifetime(t.expiresAt);
      client.current = this.makeClient(t.accessToken);
    };
    const p: Promise<void> = run().finally(() => { if (this.renewing === p) this.renewing = null; });
    this.track(p);
    return p;
  }

  // ── Cache, statuses, timers ─────────────────────────────────────────────────────────────────────────────────────

  /** One operation under a 30 s deadline (and the caller's signal); the deadline is a timeout (→ offline). */
  protected async op<R>(parent: AbortSignal, fn: (signal: AbortSignal) => Promise<R>): Promise<R> {
    const ctl = new AbortController();
    let expired = false;
    const timer = this.clock.setTimeout(() => { expired = true; ctl.abort(); }, OP_DEADLINE_MS);
    const onParent = () => ctl.abort();
    if (parent.aborted) ctl.abort();
    else parent.addEventListener('abort', onParent, { once: true });
    try {
      return await fn(ctl.signal);
    } catch (e) {
      if (expired && !parent.aborted) throw new Unreachable('timeout');
      throw e;
    } finally {
      this.clock.clearTimeout(timer);
      parent.removeEventListener('abort', onParent);
    }
  }

  protected applyTasks(fetched: readonly TaskSummary[]): void {
    const seen = new Set<string>();
    const tasks: TaskSummary[] = [];
    for (const s of fetched) {
      if (seen.has(s.id)) continue;
      seen.add(s.id);
      tasks.push(s);
      this.rememberUrl(s.id, s.url);
    }
    this.tasks = tasks;
    this.updatedAt = this.clock.now();
    this.tasksVersion++;
  }

  /** Drops cached tasks (a removed source's) without counting as a fetch: `updatedAt` stays. */
  protected dropTasks(keep: (t: TaskSummary) => boolean): void {
    const tasks = this.tasks.filter(keep);
    if (tasks.length === this.tasks.length) return;
    this.tasks = tasks;
    this.tasksVersion++;
  }

  protected clearCache(): void {
    this.tasks = [];
    this.urls.clear();
    this.updatedAt = undefined;
    this.tasksVersion++;
  }

  protected rememberUrl(id: string, url: string): void {
    this.urls.delete(id);
    this.urls.set(id, url);
    if (this.urls.size > MAX_URLS) this.urls.delete(this.urls.keys().next().value!);
  }

  /**
   * 401 (or a refused renewal): the token is dead. It leaves the saved connection with its refresh set (no half-valid
   * token on disk); the account stays for the card.
   */
  protected signOut(): void {
    if (this.saved) {
      this.saved = withTokens(this.saved, { token: null });
      try {
        this.deps.store.write(this.id, JSON.stringify(this.saved));
      } catch {
        try { this.deps.store.remove(this.id); } catch { /* nothing more to do */ }
      }
    }
    this.client = null;
    this.clearCache();
    // An API token isn't renewed: it expired or was revoked (the user and auth kind stay for the Reconnect form).
    this.toReconnect(this.saved?.auth === 'basic' ? 'token-expired' : 'signed-out');
  }

  private toReconnect(reason: ConnectorReason): void {
    const was = this.status;
    this.stopTimers();
    this.holdUntil = 0;
    this.status = 'reconnect';
    this.reason = reason;
    this.detail = undefined;
    if (was !== 'reconnect') this.notice('reconnect');
    this.changed();
  }

  protected toUnavailable(reason: ConnectorReason): void {
    const was = this.status;
    this.stopTimers();
    this.status = 'unavailable';
    this.reason = reason;
    this.detail = undefined;
    if (was !== 'unavailable') this.notice('unavailable');
    this.changed();
  }

  protected goOffline(): void {
    if (this.status === 'offline' && this.retryTimer !== null) return;
    if (this.status !== 'connected' && this.status !== 'offline' && this.status !== 'unavailable') return;
    this.status = 'offline';
    if (this.reason === 'slowing-down') this.reason = undefined;
    const wait = BACKOFF_MS[Math.min(this.backoff, BACKOFF_MS.length - 1)]!;
    this.backoff++;
    this.clearRetry();
    this.retryTimer = this.clock.setTimeout(() => { this.retryTimer = null; void this.refreshNow(); }, wait);
    this.changed();
  }

  /** 429: no request until `resetAt`; past a minute the card says "Slowing down…". */
  private hold(resetAt: number): void {
    const wait = Math.max(0, resetAt - this.clock.now());
    this.holdUntil = resetAt;
    if (wait > SLOW_MS) this.reason = 'slowing-down';
    this.clearRetry();
    this.retryTimer = this.clock.setTimeout(() => {
      this.retryTimer = null;
      this.holdUntil = 0;
      if (this.reason === 'slowing-down') { this.reason = undefined; this.changed(); }
      void this.refreshNow();
    }, wait);
    this.changed();
  }

  private stale(ms: number): boolean {
    return this.updatedAt === undefined || this.clock.now() - this.updatedAt >= ms;
  }

  private startPoll(): void {
    if (this.pollTimer !== null) this.clock.clearTimeout(this.pollTimer);
    this.pollTimer = this.clock.setTimeout(() => {
      this.pollTimer = null;
      if (this.status === 'connected' && this.deps.focused() && this.stale(STALE_MS)) void this.refreshNow();
      if (this.status === 'connected' || this.status === 'offline') this.startPoll();
    }, POLL_MS);
  }

  private clearRetry(): void {
    if (this.retryTimer !== null) this.clock.clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  private stopTimers(): void {
    this.clearRetry();
    if (this.pollTimer !== null) this.clock.clearTimeout(this.pollTimer);
    this.pollTimer = null;
  }

  protected persist(): void {
    if (!this.saved) return;
    try { this.deps.store.write(this.id, JSON.stringify(this.saved)); } catch (e) { this.log(`couldn't save the connection: ${message(e)}`); }
  }

  protected track(p: Promise<unknown>): void {
    this.work.add(p);
    void p.catch(() => undefined).finally(() => this.work.delete(p));
  }

  /** `reconnect` and `unavailable` carry the status's reason (set before), so the toast says which one it is. */
  protected notice(kind: ConnectorNoticeKind, detail?: string, origin?: number): void {
    const reason = (kind === 'reconnect' || kind === 'unavailable') && this.reason ? { reason: this.reason } : {};
    this.deps.onNotice({ id: this.id, kind, ...(detail ? { detail } : {}), ...reason }, origin);
  }

  protected changed(): void {
    this.deps.onChange();
  }

  protected log(m: string): void {
    this.deps.log(`${this.id}: ${m}`);
  }
}
