import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { z } from 'zod';
import type { ConnectorNotice, TaskDetail, TaskSummary } from '@shared/tasks';
import { manualClock, type ManualClock } from '../../../tests/support/manual-clock';
import { mcpEndpoint } from './endpoint';
import { Unauthorized } from './errors';
import type { HttpResponse, Transport } from './http';
import type { McpClient } from './mcp/client';
import { defineToolSet } from './mcp/toolset';
import type { OAuthTokens } from './oauth/oauth';
import { createSecretStore, type SecretStore } from './secret-store';
import { BACKOFF_MS, SAVED_TOKEN_FIELDS, STALE_MS, TaskConnector, type SavedBase, type TaskConnectorDeps } from './task-connector';
import { testSafeStorage } from './test-safe-storage';

// The base connector's token refresh, with a minimal subclass, a stub MCP client (the tokens it
// was given, the calls it got) and a fake authorization server behind the transport (discovery, /token, /revoke). The
// status machine itself is covered through ClickUp (clickup/clickup.test.ts).

const DEMO_TOOLS = defineToolSet({
  demo_self: { args: z.object({}).strict(), reply: z.object({ id: z.string() }) },
  demo_list: { args: z.object({}).strict(), reply: z.object({ items: z.array(z.object({ id: z.string(), title: z.string() })) }) },
  demo_get: { args: z.object({ id: z.string() }).strict(), reply: z.object({ id: z.string(), title: z.string() }) },
  demo_search: { args: z.object({ q: z.string() }).strict(), reply: z.object({ items: z.array(z.object({ id: z.string(), title: z.string() })) }) }
});
type DemoClient = McpClient<typeof DEMO_TOOLS>;

const demoSchema = z.object({
  v: z.literal(1), ...SAVED_TOKEN_FIELDS,
  userId: z.string(), account: z.string().optional(),
  workspace: z.object({ id: z.string(), name: z.string() }), options: z.object({ includeClosed: z.boolean() })
});
type DemoSaved = z.infer<typeof demoSchema>;

const summary = (t: { id: string; title: string }): TaskSummary => ({
  id: t.id, displayId: t.id, title: t.title, status: { name: 'open' }, url: `https://demo.example/t/${t.id}`
});

/** The MCP server's side: which tokens it refuses (401), every call with the token it came with. */
function stubServer(onCall?: (tool: string, token: string) => void) {
  const dead = new Set<string>();
  const calls: { tool: string; token: string }[] = [];
  /** While set, demo_list waits for it (a list refresh in flight). */
  const gate: { list: Promise<void> | null } = { list: null };
  const client = (token: string): DemoClient => ({
    listTools: async () => [...DEMO_TOOLS.names],
    callTool: (async (name: string, args: Record<string, string>) => {
      calls.push({ tool: name, token });
      onCall?.(name, token);
      if (name === 'demo_list' && gate.list) await gate.list;
      if (dead.has(token)) throw new Unauthorized();
      if (name === 'demo_self') return { id: 'u1' };
      if (name === 'demo_get') return { id: args.id, title: 'One' };
      return { items: [{ id: 't1', title: 'One' }] };
    }) as DemoClient['callTool']
  });
  return { dead, calls, gate, client, tokensFor:(tool: string) => calls.filter((c) => c.tool === tool).map((c) => c.token) };
}
type Stub = ReturnType<typeof stubServer>;

class DemoConnector extends TaskConnector<DemoSaved, typeof DEMO_TOOLS> {
  // ConnectorId has one member until Notion joins (Task 4); the id only names the stored blob in a temp home here.
  readonly id = 'clickup' as const;
  readonly name = 'Demo';
  protected readonly tools = DEMO_TOOLS;
  constructor(deps: TaskConnectorDeps, private readonly server: Stub) { super(deps); }
  /** A 401 elsewhere (another operation, another window) signs the connection out right now. */
  signOutNow(): void { this.signOut(); }
  /** The Basic user every client was made with (undefined: Bearer). */
  readonly basicUsers: (string | undefined)[] = [];
  /** What identify was told (the API-token sign-in's site). */
  readonly hints: unknown[] = [];
  protected override readonly tokenSignIn = true;
  protected override makeClient(token: string, basicUser?: string): DemoClient { this.basicUsers.push(basicUser); return this.server.client(token); }
  protected parseSaved(raw: unknown): DemoSaved | null {
    const r = demoSchema.safeParse(raw);
    return r.success ? r.data : null;
  }
  protected async identify(client: DemoClient, tokens: OAuthTokens, signal: AbortSignal, hint?: { site?: string }): Promise<DemoSaved> {
    this.hints.push(hint);
    const me = await client.callTool('demo_self', {}, { signal });
    return { v: 1, token: tokens.accessToken, userId: me.id, workspace: { id: 'w1', name: 'Demo' }, options: { includeClosed: false } };
  }
  protected async fetchTasks(client: DemoClient, _saved: DemoSaved, signal: AbortSignal) {
    const r = await client.callTool('demo_list', {}, { signal });
    return { tasks: r.items.map(summary) };
  }
  protected async getTask(client: DemoClient, _saved: DemoSaved, id: string, signal: AbortSignal): Promise<TaskDetail> {
    const r = await client.callTool('demo_get', { id }, { signal });
    return { ...summary(r), body: '' };
  }
  protected async searchTasks(client: DemoClient, _saved: DemoSaved, q: string, signal: AbortSignal): Promise<TaskSummary[]> {
    return (await client.callTool('demo_search', { q }, { signal })).items.map(summary);
  }
  isTaskId(id: string): boolean { return /^t\d+$/.test(id); }
  taskUrlFor(id: string): string { return `https://demo.example/t/${id}`; }
  appUrl(): string | null { return null; }
}

// ── The fake authorization server, behind the transport ──────────────────────────────────────────────────────────

interface Reply { status: number; body: unknown }
type TokenAnswer = Reply | 'refused' | Promise<Reply>;

const reply = (status: number, body: unknown): HttpResponse => ({
  status, headers: { 'content-type': 'application/json' }, location: null,
  body: (async function* () { yield Buffer.from(JSON.stringify(body)); })(), close: () => undefined
});

/** A new origin per test: refreshAccessToken caches the discovered metadata per base. */
let port = 41_000;

function authServer(o: { token?: (form: Record<string, string>) => TokenAnswer; revocation?: boolean } = {}) {
  const origin = `http://127.0.0.1:${port++}`;
  const requests: string[] = [];
  const posts: { path: string; form: Record<string, string> }[] = [];
  const transport: Transport = async (req) => {
    const u = new URL(req.url);
    requests.push(u.pathname);
    if (u.pathname === '/.well-known/oauth-authorization-server') {
      return reply(200, {
        issuer: origin, authorization_endpoint: `${origin}/authorize`, token_endpoint: `${origin}/token`, registration_endpoint: `${origin}/register`,
        ...(o.revocation ? { revocation_endpoint: `${origin}/revoke` } : {}),
        response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none']
      });
    }
    if (req.method === 'POST') {
      const form = Object.fromEntries(new URLSearchParams(req.body ?? ''));
      posts.push({ path: u.pathname, form });
      if (u.pathname === '/token') {
        const answer = await (o.token ?? (() => ({ status: 200, body: { access_token: 'at-2', token_type: 'Bearer' } })))(form);
        if (answer === 'refused') throw new Error('connect ECONNREFUSED');
        return reply(answer.status, answer.body);
      }
      return reply(200, {});
    }
    return reply(404, {});
  };
  return { origin, transport, requests, posts, tokenPosts: () => posts.filter((p) => p.path === '/token') };
}

// ── Setup ──────────────────────────────────────────────────────────────────────────────────────────────────────

let connectors: DemoConnector[] = [];
afterEach(() => { for (const c of connectors.splice(0)) c.dispose(); });

interface Setup {
  saved?: Partial<DemoSaved>;
  /** Fields to leave out of the saved connection. */
  without?: (keyof DemoSaved)[];
  server?: Parameters<typeof authServer>[0];
  onCall?: (tool: string, token: string, store: SecretStore) => void;
  clock?: ManualClock;
  /** Nothing saved (a first Connect). */
  fresh?: boolean;
}

function setup(o: Setup = {}) {
  const clock = o.clock ?? manualClock(1_000_000_000);
  const home = mkdtempSync(join(tmpdir(), 'atl-tc-'));
  const store = createSecretStore(home, testSafeStorage());
  const saved: Record<string, unknown> = {
    v: 1, token: 'at-1', refresh: 'rt-1', clientId: 'cid-1', userId: 'u1',
    workspace: { id: 'w1', name: 'Demo' }, options: { includeClosed: false }, ...o.saved
  };
  for (const k of o.without ?? []) delete saved[k];
  if (!o.fresh) store.write('clickup', JSON.stringify(saved));
  const auth = authServer(o.server);
  const server = stubServer((tool, token) => o.onCall?.(tool, token, store));
  const notices: ConnectorNotice[] = [];
  const logs: string[] = [];
  const c = new DemoConnector({
    store, endpoint: mcpEndpoint({ base: 'https://demo.example', name: 'Demo', override: auth.origin }), transport: auth.transport,
    openAuthPage: () => undefined, clock, focused: () => true, log: (m) => { logs.push(m); },
    onChange: () => undefined, onNotice: (n) => { notices.push(n); }
  }, server);
  connectors.push(c);
  const blob = () => { const raw = store.read('clickup'); return raw === null ? null : JSON.parse(raw) as Record<string, unknown>; };
  return { c, clock, store, auth, server, notices, logs, blob };
}

const refreshed = (expiresIn?: number, refresh?: string): Reply => ({
  status: 200, body: { access_token: 'at-2', token_type: 'Bearer', ...(expiresIn ? { expires_in: expiresIn } : {}), ...(refresh ? { refresh_token: refresh } : {}) }
});

describe('token refresh', () => {
  test('refreshes before an operation when the token expires within a minute', async () => {
    const clock = manualClock(1_000_000_000);
    const s = setup({ clock, saved: { expiresAt: clock.now() + 5 * 60_000 }, server: { token: () => refreshed(3600) } });
    s.c.init();
    await s.c.idle();
    // Five minutes left: the launch refresh uses the token as it is.
    expect(s.auth.tokenPosts()).toHaveLength(0);
    expect(s.server.tokensFor('demo_list')).toEqual(['at-1']);
    // 59 s left by the next stale refresh: the token is renewed first.
    await clock.advance(4 * 60_000 + 1_000);
    expect(s.c.taskList().loading).toBe(true);
    await s.c.idle();
    expect(s.auth.tokenPosts().map((p) => p.form)).toEqual([
      { grant_type: 'refresh_token', client_id: 'cid-1', refresh_token: 'rt-1', resource: `${s.auth.origin}/mcp` }
    ]);
    expect(s.server.tokensFor('demo_list')).toEqual(['at-1', 'at-2']);
    expect(s.c.info().status).toBe('connected');
  });

  test('concurrent operations share one refresh', async () => {
    let release!: (r: Reply) => void;
    const gate = new Promise<Reply>((r) => { release = r; });
    const clock = manualClock(1_000_000_000);
    // The Mac slept: the token expires in 10 s when the launch refresh, a task and a search all start.
    const s = setup({ clock, saved: { expiresAt: clock.now() + 10_000 }, server: { token: () => gate } });
    s.c.init();
    const task = s.c.task('t1');
    const search = s.c.search('one');
    await expect.poll(() => s.auth.tokenPosts().length).toBe(1);
    release(refreshed(3600));
    expect(await task).toMatchObject({ ok: true, task: { id: 't1' } });
    expect((await search).map((t) => t.id)).toEqual(['t1']);
    await s.c.idle();
    expect(s.auth.tokenPosts()).toHaveLength(1);
    expect(s.server.calls.map((c) => c.token)).toEqual(['at-2', 'at-2', 'at-2']);
    expect(s.c.info().status).toBe('connected');
  });

  test('a 401 with a refresh token refreshes once and retries the operation', async () => {
    const s = setup();
    s.server.dead.add('at-1');
    s.c.init();
    await s.c.idle();
    expect(s.auth.tokenPosts()).toHaveLength(1);
    expect(s.server.tokensFor('demo_list')).toEqual(['at-1', 'at-2']);
    expect(s.c.info().status).toBe('connected');
    expect(s.c.taskList().tasks.map((t) => t.id)).toEqual(['t1']);

    // The renewed token refused too: no second refresh, signed out.
    const t = setup();
    t.server.dead.add('at-1');
    t.server.dead.add('at-2');
    t.c.init();
    await t.c.idle();
    expect(t.auth.tokenPosts()).toHaveLength(1);
    expect(t.server.tokensFor('demo_list')).toEqual(['at-1', 'at-2']);
    expect(t.c.info()).toMatchObject({ status: 'reconnect', reason: 'signed-out' });
  });

  test('a refused refresh signs out (reconnect, signed-out) and drops both tokens from the saved connection', async () => {
    const clock = manualClock(1_000_000_000);
    const s = setup({ clock, saved: { expiresAt: clock.now() + 10_000 }, server: { token: () => ({ status: 400, body: { error: 'invalid_grant' } }) } });
    s.c.init();
    await s.c.idle();
    expect(s.c.info()).toMatchObject({ status: 'reconnect', reason: 'signed-out' });
    expect(s.notices).toEqual([{ id: 'clickup', kind: 'reconnect', reason: 'signed-out' }]);
    expect(s.server.calls).toEqual([]);
    const blob = s.blob()!;
    expect(blob.token).toBeNull();
    expect(blob).not.toHaveProperty('refresh');
    expect(blob).not.toHaveProperty('expiresAt');
    expect(blob).toMatchObject({ userId: 'u1', workspace: { id: 'w1', name: 'Demo' } });
    expect(s.c.taskList().tasks).toEqual([]);
  });

  test('an unreachable refresh goes offline with the backoff', async () => {
    const clock = manualClock(1_000_000_000);
    let answer: TokenAnswer = 'refused';
    const s = setup({ clock, saved: { expiresAt: clock.now() + 10_000 }, server: { token: () => answer } });
    s.c.init();
    await s.c.idle();
    expect(s.c.info().status).toBe('offline');
    expect(s.server.calls).toEqual([]);
    expect(clock.dueIn()).toContain(BACKOFF_MS[0]);
    answer = refreshed(3600);
    await clock.advance(BACKOFF_MS[0]!);
    await s.c.idle();
    expect(s.c.info().status).toBe('connected');
    expect(s.server.tokensFor('demo_list')).toEqual(['at-2']);
    expect(s.auth.tokenPosts()).toHaveLength(2);
  });

  test('refreshed tokens are stored at once', async () => {
    const clock = manualClock(1_000_000_000);
    const seen: (Record<string, unknown> | null)[] = [];
    const s = setup({
      clock, saved: { expiresAt: clock.now() + 10_000 }, server: { token: () => refreshed(3600, 'rt-2') },
      onCall: (_tool, _token, store) => { const raw = store.read('clickup'); seen.push(raw === null ? null : JSON.parse(raw) as Record<string, unknown>); }
    });
    s.c.init();
    await s.c.idle();
    // The first call with the new token already finds it on disk (rotated refresh token, new expiry, same client).
    expect(seen[0]).toMatchObject({ token: 'at-2', refresh: 'rt-2', expiresAt: clock.now() + 3_600_000, clientId: 'cid-1' });
    expect(s.blob()).toMatchObject({ token: 'at-2', refresh: 'rt-2', expiresAt: clock.now() + 3_600_000, clientId: 'cid-1' });
  });

  test('a renewal without expires_in drops the old expiry', async () => {
    const clock = manualClock(1_000_000_000);
    const s = setup({ clock, saved: { expiresAt: clock.now() + 10_000 } });
    s.c.init();
    await s.c.idle();
    expect(s.blob()).toMatchObject({ token: 'at-2', refresh: 'rt-1' });
    expect(s.blob()).not.toHaveProperty('expiresAt');
    // No expiry known: the next stale refresh does not renew again.
    await clock.advance(STALE_MS);
    s.c.taskList();
    await s.c.idle();
    expect(s.auth.tokenPosts()).toHaveLength(1);
  });

  test('a token refused for another reason (rate limit, CDN challenge, an unknown reply) goes offline, never signs out', async () => {
    for (const answer of [
      { status: 429, body: {} }, { status: 403, body: '<html>challenge</html>' }, { status: 200, body: { nope: true } }
    ] satisfies Reply[]) {
      const clock = manualClock(1_000_000_000);
      const s = setup({ clock, saved: { expiresAt: clock.now() + 10_000 }, server: { token: () => answer } });
      s.c.init();
      await s.c.idle();
      expect(s.c.info().status).toBe('offline');
      expect(clock.dueIn()).toContain(BACKOFF_MS[0]);
      expect(s.blob()).toMatchObject({ token: 'at-1', refresh: 'rt-1' });
      expect(s.notices).toEqual([]);
    }
  });

  test('a short-lived token is renewed when half its lifetime is left, not before every operation', async () => {
    const clock = manualClock(1_000_000_000);
    // The server gives 50 s tokens: "renew within a minute" alone would renew before every call.
    const s = setup({ clock, saved: { expiresAt: clock.now() + 10_000 }, server: { token: () => refreshed(50) } });
    s.c.init();
    await s.c.idle();
    expect(s.auth.tokenPosts()).toHaveLength(1);
    expect(await s.c.task('t1')).toMatchObject({ ok: true });
    await clock.advance(20_000); // 30 s left of 50: still more than half
    expect(await s.c.task('t1')).toMatchObject({ ok: true });
    expect(s.auth.tokenPosts()).toHaveLength(1);
    await clock.advance(6_000); // 24 s left: under half
    expect(await s.c.task('t1')).toMatchObject({ ok: true });
    expect(s.auth.tokenPosts()).toHaveLength(2);
    expect(s.server.tokensFor('demo_get')).toEqual(['at-2', 'at-2', 'at-2']);
  });

  test('a renewal that finishes after a sign-out stores nothing and changes nothing', async () => {
    let release!: (r: Reply) => void;
    const clock = manualClock(1_000_000_000);
    const s = setup({ clock, saved: { expiresAt: clock.now() + 10_000 }, server: { token: () => new Promise<Reply>((r) => { release = r; }) } });
    s.c.init();
    await expect.poll(() => s.auth.tokenPosts().length).toBe(1);
    s.c.signOutNow();
    expect(s.c.info()).toMatchObject({ status: 'reconnect', reason: 'signed-out' });
    release(refreshed(3600, 'rt-2'));
    await s.c.idle();
    expect(s.c.info()).toMatchObject({ status: 'reconnect', reason: 'signed-out' });
    expect(s.blob()!.token).toBeNull();
    expect(s.blob()).not.toHaveProperty('refresh');
    expect(s.server.calls).toEqual([]);

    // Disconnect while it runs: the blob stays deleted.
    const clock2 = manualClock(1_000_000_000);
    const t = setup({ clock: clock2, saved: { expiresAt: clock2.now() + 10_000 }, server: { token: () => new Promise<Reply>((r) => { release = r; }) } });
    t.c.init();
    await expect.poll(() => t.auth.tokenPosts().length).toBe(1);
    t.c.disconnect();
    release(refreshed(3600, 'rt-2'));
    await t.c.idle();
    expect(t.blob()).toBeNull();
    expect(t.c.info().status).toBe('disconnected');
  });

  test("one caller's deadline during a shared renewal doesn't fail the others", async () => {
    let release!: (r: Reply) => void;
    const clock = manualClock(1_000_000_000);
    const s = setup({ clock, saved: { expiresAt: clock.now() + 10_000 }, server: { token: () => new Promise<Reply>((r) => { release = r; }) } });
    s.c.init(); // the launch refresh starts the renewal; its 30 s deadline runs
    await expect.poll(() => s.auth.tokenPosts().length).toBe(1);
    await clock.advance(20_000);
    const task = s.c.task('t1'); // joins the renewal 20 s later, with its own deadline
    await clock.advance(10_000); // the refresh's deadline: offline
    expect(s.c.info().status).toBe('offline');
    release(refreshed(3600));
    expect(await task).toMatchObject({ ok: true, task: { id: 't1' } });
    await s.c.idle();
    expect(s.auth.tokenPosts()).toHaveLength(1);
    expect(s.c.info().status).toBe('connected'); // the task's success brought a refresh, with the new token
    expect(s.server.tokensFor('demo_list')).toEqual(['at-2']);
  });

  test('a list refresh that finishes after a sign-out leaves the connection signed out', async () => {
    const s = setup({ without: ['refresh', 'clientId'] });
    let release!: () => void;
    s.server.gate.list = new Promise<void>((r) => { release = r; });
    s.c.init();
    await expect.poll(() => s.server.tokensFor('demo_list').length).toBe(1);
    s.c.signOutNow();
    release();
    await s.c.idle();
    expect(s.c.info()).toMatchObject({ status: 'reconnect', reason: 'signed-out' });
    expect(s.c.info().updatedAt).toBeUndefined();
    expect(s.c.taskList().tasks).toEqual([]);
  });

  test('without a refresh token a 401 signs out as before', async () => {
    const s = setup({ without: ['refresh', 'clientId'] });
    s.server.dead.add('at-1');
    s.c.init();
    await s.c.idle();
    expect(s.c.info()).toMatchObject({ status: 'reconnect', reason: 'signed-out' });
    expect(s.server.tokensFor('demo_list')).toEqual(['at-1']);
    expect(s.auth.requests).toEqual([]);
    expect(s.blob()!.token).toBeNull();
  });

  test('disconnect revokes the refresh token when the server allows it', async () => {
    const s = setup({ server: { revocation: true } });
    s.c.init();
    await s.c.idle();
    s.c.disconnect();
    await s.c.idle();
    expect(s.auth.posts.filter((p) => p.path === '/revoke').map((p) => p.form)).toEqual([{ token: 'rt-1', client_id: 'cid-1' }]);
    expect(s.blob()).toBeNull();
    expect(s.c.info().status).toBe('disconnected');

    // No client id or no token (a connection without refresh, like ClickUp's): nothing is sent, not even discovery.
    const t = setup({ without: ['refresh', 'clientId'], server: { revocation: true } });
    t.c.init();
    await t.c.idle();
    t.c.disconnect();
    await t.c.idle();
    expect(t.auth.requests).toEqual([]);
  });
});

// The API-token sign-in, generic in the base (Jira opts in).
describe('API-token sign-in', () => {
  const creds = { user: 'ada@example.com', secret: 'api-token-0123456789abcdef', site: 'acme.atlassian.net' };

  test('no browser, no OAuth request: the tool check, identify (with the site), the first fetch, then stored as basic', async () => {
    const s = setup({ fresh: true });
    s.c.init();
    s.c.connectWithToken(creds);
    await s.c.idle();
    expect(s.c.info()).toMatchObject({ status: 'connected', signIn: 'token', tokenUser: 'ada@example.com' });
    expect(s.auth.requests).toEqual([]);
    expect(s.c.basicUsers).toEqual(['ada@example.com']);
    expect(s.c.hints).toEqual([{ site: 'acme.atlassian.net' }]);
    expect(s.server.tokensFor('demo_list')).toEqual(['api-token-0123456789abcdef']);
    expect(s.blob()).toMatchObject({ token: 'api-token-0123456789abcdef', auth: 'basic', basicUser: 'ada@example.com' });
    expect(s.blob()!.refresh).toBeUndefined();
    expect(s.blob()!.clientId).toBeUndefined();
  });

  test('a refused token → not connected, "token-refused", nothing stored', async () => {
    const s = setup({ fresh: true });
    s.server.dead.add(creds.secret);
    s.c.init();
    s.c.connectWithToken(creds);
    await s.c.idle();
    expect(s.c.info()).toMatchObject({ status: 'disconnected', reason: 'token-refused' });
    expect(s.notices.map((n) => n.kind)).toEqual(['token-refused']);
    expect(s.blob()).toBeNull();
  });

  test('relaunch: the saved basic connection makes a Basic client; a later 401 → reconnect "token-expired", no renewal, the user kept', async () => {
    const s = setup({ saved: { token: creds.secret, auth: 'basic', basicUser: creds.user }, without: ['refresh', 'clientId'] });
    s.c.init();
    await s.c.idle();
    expect(s.c.basicUsers).toEqual(['ada@example.com']);
    expect(s.c.info()).toMatchObject({ status: 'connected', signIn: 'token', tokenUser: 'ada@example.com' });
    s.server.dead.add(creds.secret);
    await s.clock.advance(STALE_MS);
    s.c.refresh();
    await s.c.idle();
    expect(s.c.info()).toMatchObject({ status: 'reconnect', reason: 'token-expired', tokenUser: 'ada@example.com' });
    expect(s.auth.requests).toEqual([]);
    expect(s.blob()).toMatchObject({ token: null, auth: 'basic', basicUser: 'ada@example.com' });
  });

  test('Disconnect sends nothing (no OAuth client to revoke)', async () => {
    const s = setup({ saved: { token: creds.secret, auth: 'basic', basicUser: creds.user }, without: ['refresh', 'clientId'], server: { revocation: true } });
    s.c.init();
    await s.c.idle();
    s.c.disconnect();
    await s.c.idle();
    expect(s.auth.requests).toEqual([]);
    expect(s.blob()).toBeNull();
  });

  test('a connector that hasn\'t opted in ignores it', async () => {
    const s = setup({ fresh: true });
    s.c.init();
    (s.c as unknown as { tokenSignIn: boolean }).tokenSignIn = false;
    s.c.connectWithToken(creds);
    await s.c.idle();
    expect(s.c.info().status).toBe('disconnected');
    expect(s.server.calls).toEqual([]);
  });
});
