import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { startFakeClickUp, type FakeClickUp, type FakeScenario } from '../../../../tests/fixtures/fake-clickup.mjs';
import { fetchTransport } from '../../../../tests/support/fetch-transport';
import { Aborted, AuthFailed, Unreachable } from '../errors';
import type { HttpRequest, HttpResponse, Transport } from '../http';
import { clickupEndpoint } from '../clickup/config';
import { listenLoopback } from './loopback';
import { mcpEndpoint } from '../endpoint';
import { authorizeUrl, pkcePair, randomState, refreshAccessToken, revokeToken, runOAuth, validateMetadata, type AuthOpener } from './oauth';
import { followAuthorize } from './follow-auth';

// Discovery → loopback → DCR → authorize → callback (state, iss, one-shot) → token exchange,
// against the local fake ClickUp (tests/fixtures/fake-clickup.mjs), never the real one.

let fake: FakeClickUp | null = null;
afterEach(async () => { await fake?.close(); fake = null; });

const start = async (scenario: FakeScenario = 'normal') => {
  fake = await startFakeClickUp({ scenario });
  return fake;
};

/** The user's browser: GETs the authorize URL, then follows the 302 to the loopback callback over real HTTP. */
const browser = (seen: { status: number; body: string; csp: string | null; url: string }[] = []): AuthOpener => (url) => {
  void (async () => {
    const r = await fetch(url, { redirect: 'manual' });
    const to = r.headers.get('location');
    if (!to) return;
    const cb = await fetch(to);
    seen.push({ status: cb.status, body: await cb.text(), csp: cb.headers.get('content-security-policy'), url: to });
  })().catch(() => undefined);
};

const options = (f: FakeClickUp, o: Partial<Parameters<typeof runOAuth>[0]> = {}) => ({
  endpoint: clickupEndpoint(f.url),
  transport: fetchTransport(),
  signal: new AbortController().signal,
  open: browser(),
  ...o
});

const failure = async (p: Promise<unknown>) => {
  const e = await p.then(() => null, (err: unknown) => err);
  expect(e).toBeInstanceOf(AuthFailed);
  return e as AuthFailed;
};

describe('discovery validation', () => {
  const base = 'https://mcp.clickup.com';
  // No override (an empty one): the real base, for validation only — nothing here makes a request.
  const ep = clickupEndpoint('');
  const good = {
    issuer: base, authorization_endpoint: `${base}/oauth/authorize`, token_endpoint: `${base}/oauth/token`,
    registration_endpoint: `${base}/oauth/register`, response_types_supported: ['code'], grant_types_supported: ['authorization_code'],
    code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none']
  };

  test('the real metadata shape is accepted', () => {
    expect(validateMetadata(good, ep)).toEqual({
      issuer: base, authorizationEndpoint: `${base}/oauth/authorize`, tokenEndpoint: `${base}/oauth/token`, registrationEndpoint: `${base}/oauth/register`
    });
  });

  test.each([
    ['no registration endpoint (no DCR)', { registration_endpoint: undefined }],
    ['no S256', { code_challenge_methods_supported: ['plain'] }],
    ['no PKCE list at all', { code_challenge_methods_supported: undefined }],
    ['no public clients (`none`)', { token_endpoint_auth_methods_supported: ['client_secret_post'] }],
    ['no authorization_code grant', { grant_types_supported: ['client_credentials'] }],
    ['no `code` response type', { response_types_supported: ['token'] }],
    ['another issuer', { issuer: 'https://attacker.example' }],
    ['a token endpoint on another host', { token_endpoint: 'https://attacker.example/token' }],
    ['a registration endpoint over http', { registration_endpoint: 'http://mcp.clickup.com/oauth/register' }],
    ['an authorize page over plain http', { authorization_endpoint: 'http://app.clickup.com/authorize' }],
    ['credentials in the authorize URL', { authorization_endpoint: 'https://u:p@app.clickup.com/authorize' }],
    ['not an object', null]
  ])('%s → unsupported, never a weaker flow', (_name, patch) => {
    const raw = patch === null ? null : { ...good, ...patch };
    let err: unknown = null;
    try { validateMetadata(raw, ep); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(AuthFailed);
    expect((err as AuthFailed).reason).toBe('unsupported');
  });

  test('a missing grant list means the RFC 8414 default (authorization_code included)', () => {
    expect(validateMetadata({ ...good, grant_types_supported: undefined }, ep).issuer).toBe(base);
  });
});

describe('PKCE, state and the authorize URL', () => {
  test('S256: the challenge is the base64url SHA-256 of a 43+ character verifier; fresh every time', () => {
    const a = pkcePair();
    const b = pkcePair();
    expect(a.verifier).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
    expect(a.challenge).toBe(createHash('sha256').update(a.verifier).digest('base64url'));
    expect(a.verifier).not.toBe(b.verifier);
  });

  test('state carries 128 random bits', () => {
    const s = randomState();
    expect(Buffer.from(s, 'base64url').byteLength).toBeGreaterThanOrEqual(16);
    expect(randomState()).not.toBe(s);
  });

  test('scope=read, S256, state and the MCP resource', () => {
    const u = new URL(authorizeUrl('https://mcp.clickup.com/oauth/authorize', {
      clientId: 'c1', redirectUri: 'http://127.0.0.1:5000/callback/ab', state: 'st', challenge: 'ch', resource: 'https://mcp.clickup.com/mcp', scope: 'read'
    }));
    expect(Object.fromEntries(u.searchParams)).toEqual({
      response_type: 'code', client_id: 'c1', redirect_uri: 'http://127.0.0.1:5000/callback/ab', scope: 'read', state: 'st',
      code_challenge: 'ch', code_challenge_method: 'S256', resource: 'https://mcp.clickup.com/mcp'
    });
  });
});

describe('the connect flow against the fake ClickUp', () => {
  test('discovery → DCR → browser → loopback callback → token: a working Bearer token, the tab shows the close page', async () => {
    const f = await start();
    const seen: { status: number; body: string; csp: string | null; url: string }[] = [];
    let opened = '';
    const { accessToken } = await runOAuth(options(f, { open: (url, deliver) => { opened = url; browser(seen)(url, deliver); } }));
    expect(accessToken).toMatch(/^fkat_/);
    const q = new URL(opened).searchParams;
    expect(q.get('scope')).toBe('read');
    expect(q.get('resource')).toBe(`${f.url}/mcp`);
    expect(q.get('redirect_uri')).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback\/[0-9a-f]{32}$/);
    await expect.poll(() => seen.length).toBe(1);
    expect(seen[0]!.status).toBe(200);
    expect(seen[0]!.body).toContain('You can close this tab and go back to Atelier');
    // The code arrived, nothing more: the exchange, the tools check and the account can still fail in Atelier.
    expect(seen[0]!.body).toContain('Finishing in Atelier…');
    expect(seen[0]!.body).not.toMatch(/Connected/i);
    // A self-contained page: nothing loaded from anywhere, a CSP that allows only its own inline style.
    expect(seen[0]!.csp).toMatch(/^default-src 'none'; style-src 'sha256-[A-Za-z0-9+/=]+'; base-uri 'none'; form-action 'none'$/);
    expect(seen[0]!.body).toContain(`<meta http-equiv="Content-Security-Policy" content="${seen[0]!.csp}">`);
    expect(seen[0]!.body).not.toMatch(/src=|href=|url\(|@import/);
    // The listener closed with the flow: the callback URL no longer answers.
    await expect(fetch(seen[0]!.url)).rejects.toThrow();
  });

  test('the token is tied to this flow: MCP accepts it', async () => {
    const f = await start();
    const { accessToken } = await runOAuth(options(f));
    const r = await fetch(`${f.url}/mcp`, {
      method: 'POST', headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json, text/event-stream', 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' })
    });
    expect(r.status).toBe(200);
  });

  test('the test follower (ATELIER_TEST_FOLLOW_AUTH) gets the same result without a browser', async () => {
    const f = await start();
    const ep = clickupEndpoint(f.url);
    const { accessToken } = await runOAuth(options(f, { open: followAuthorize(fetchTransport(), ep.allow) }));
    expect(accessToken).toMatch(/^fkat_/);
  });

  test('user denies access → denied', async () => {
    const f = await start('authorize-denied');
    expect((await failure(runOAuth(options(f)))).reason).toBe('denied');
  });

  test('other OAuth error → oauth-error with ClickUp\'s description: one line, at most 120 characters', async () => {
    const f = await start();
    f.setScenario('authorize-error', { description: `Down\nfor\u0007 maintenance ${'x'.repeat(300)}` });
    const e = await failure(runOAuth(options(f)));
    expect(e.reason).toBe('oauth-error');
    expect(e.detail).toMatch(/^Down for maintenance x+…?$/);
    expect(e.detail!.length).toBeLessThanOrEqual(120);
  });

  test('the error page escapes ClickUp\'s description', async () => {
    const f = await start();
    f.setScenario('authorize-error', { description: '<script>alert(1)</script>' });
    const seen: { status: number; body: string; csp: string | null; url: string }[] = [];
    await failure(runOAuth(options(f, { open: browser(seen) })));
    await expect.poll(() => seen.length).toBe(1);
    expect(seen[0]!.body).not.toContain('<script>');
    expect(seen[0]!.body).toContain('&lt;script&gt;');
  });

  test.each(['authorize-wrong-state', 'authorize-wrong-iss'] as const)('%s → refused with a 400 page, flow aborted (verify)', async (scenario) => {
    const f = await start(scenario);
    const seen: { status: number; body: string; csp: string | null; url: string }[] = [];
    expect((await failure(runOAuth(options(f, { open: browser(seen) })))).reason).toBe('verify');
    await expect.poll(() => seen.length).toBe(1);
    expect(seen[0]!.status).toBe(400);
  });

  test('a wrong path gets a 404 and does not use up the one callback', async () => {
    const f = await start();
    let codes: number[] = [];
    const open: AuthOpener = (url) => {
      void (async () => {
        const to = new URL((await fetch(url, { redirect: 'manual' })).headers.get('location')!);
        codes.push((await fetch(`${to.origin}/favicon.ico`)).status);
        codes.push((await fetch(`${to.origin}/callback/${'0'.repeat(32)}${to.search}`)).status);
        codes.push((await fetch(to)).status);
      })();
    };
    const { accessToken } = await runOAuth(options(f, { open }));
    expect(accessToken).toMatch(/^fkat_/);
    await expect.poll(() => codes.length).toBe(3);
    expect(codes).toEqual([404, 404, 200]);
    codes = [];
  });

  test('the browser repeating the accepted callback (same URL) gets the same page and the sign-in goes on', async () => {
    const f = await start();
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    const base = fetchTransport();
    const transport: Transport = async (req, signal) => {
      if (req.url.endsWith('/oauth/token')) await held;
      return base(req, signal);
    };
    const statuses: number[] = [];
    const open: AuthOpener = (url) => {
      void (async () => {
        const to = (await fetch(url, { redirect: 'manual' })).headers.get('location')!;
        statuses.push((await fetch(to)).status);
        statuses.push((await fetch(to)).status);
        release();
      })();
    };
    const { accessToken } = await runOAuth(options(f, { transport, open }));
    expect(accessToken).toMatch(/^fkat_/);
    expect(statuses).toEqual([200, 200]);
  });

  test('a second, different callback (even after a good one) → 400 and the flow is aborted, no token', async () => {
    const f = await start();
    // Hold the token exchange until the second callback has landed.
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    const base = fetchTransport();
    const transport: Transport = async (req, signal) => {
      if (req.url.endsWith('/oauth/token')) await held;
      return base(req, signal);
    };
    const statuses: number[] = [];
    const open: AuthOpener = (url) => {
      void (async () => {
        const to = new URL((await fetch(url, { redirect: 'manual' })).headers.get('location')!);
        statuses.push((await fetch(to)).status);
        to.searchParams.set('code', 'someone-else');
        statuses.push((await fetch(to)).status);
        release();
      })();
    };
    expect((await failure(runOAuth(options(f, { transport, open })))).reason).toBe('verify');
    expect(statuses).toEqual([200, 400]);
  });

  test('port retry: two listen failures, then a free port', async () => {
    const f = await start();
    let tries = 0;
    const bind = (srv: Server) => (++tries <= 2 ? Promise.reject(Object.assign(new Error('in use'), { code: 'EADDRINUSE' })) : listenLoopback(srv));
    const { accessToken } = await runOAuth(options(f, { loopback: { bind } }));
    expect(accessToken).toMatch(/^fkat_/);
    expect(tries).toBe(3);
  });

  test('the port can\'t be opened: 1 try + 3 retries, then port with the error code; nothing registered', async () => {
    const f = await start();
    let tries = 0;
    const seen: string[] = [];
    const bind = () => { tries++; return Promise.reject(Object.assign(new Error('nope'), { code: 'EACCES' })); };
    const e = await failure(runOAuth(options(f, { loopback: { bind }, transport: fetchTransport((u) => seen.push(new URL(u).pathname)) })));
    expect(e.reason).toBe('port');
    expect(e.detail).toBe('EACCES');
    expect(tries).toBe(4);
    expect(seen).not.toContain('/oauth/register');
  });

  test.each([
    ['discovery-no-s256', 'unsupported'], ['discovery-no-dcr', 'unsupported'], ['discovery-no-none', 'unsupported'],
    ['discovery-network-error', 'network'], ['token-network-error', 'network']
  ] as const)('%s → %s', async (scenario, reason) => {
    const f = await start(scenario);
    expect((await failure(runOAuth(options(f)))).reason).toBe(reason);
  });

  test('ClickUp unreachable (closed port) → network', async () => {
    const e = await failure(runOAuth({ endpoint: clickupEndpoint('http://127.0.0.1:9'), transport: fetchTransport(), signal: new AbortController().signal, open: browser() }));
    expect(e.reason).toBe('network');
  });

  test('the signal (Cancel, timeout, quit) ends the wait: Aborted, and the listener is closed', async () => {
    const f = await start();
    const ctl = new AbortController();
    let redirect = '';
    const open: AuthOpener = (url) => { redirect = new URL(url).searchParams.get('redirect_uri')!; };
    const p = runOAuth(options(f, { signal: ctl.signal, open }));
    await expect.poll(() => redirect).not.toBe('');
    ctl.abort();
    await expect(p).rejects.toBeInstanceOf(Aborted);
    await expect(fetch(redirect)).rejects.toThrow();
  });
});

// ── Generic OAuth: refresh, revocation, per-connector endpoints ───────────────────────────────
// A tiny in-test authorization server shaped like Notion's metadata: refresh_token grant, revocation on /token's origin.

interface TinyOptions {
  refreshGrant?: boolean;
  revocation?: boolean;
  /** The token reply's extra fields. */
  tokenExtra?: Record<string, unknown>;
  /** What a refresh answers (default: a plain success). */
  refreshReply?: { status: number; body: unknown };
}
interface Tiny {
  url: string;
  requests: { method: string; path: string; body: string }[];
  registered: Record<string, unknown>[];
  close(): Promise<void>;
}

async function startTiny(o: TinyOptions = {}): Promise<Tiny> {
  const requests: Tiny['requests'] = [];
  const registered: Record<string, unknown>[] = [];
  let url = '';
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      const u = new URL(req.url ?? '/', 'http://x');
      requests.push({ method: req.method ?? '', path: u.pathname, body });
      const send = (status: number, payload: unknown, headers: Record<string, string> = {}) => {
        res.writeHead(status, { 'content-type': 'application/json', ...headers });
        res.end(JSON.stringify(payload));
      };
      if (u.pathname === '/.well-known/oauth-authorization-server') {
        return send(200, {
          issuer: url, authorization_endpoint: `${url}/authorize`, token_endpoint: `${url}/token`, registration_endpoint: `${url}/register`,
          ...(o.revocation ? { revocation_endpoint: `${url}/token` } : {}),
          response_types_supported: ['code'],
          grant_types_supported: o.refreshGrant ? ['authorization_code', 'refresh_token'] : ['authorization_code'],
          token_endpoint_auth_methods_supported: ['none', 'client_secret_post'], code_challenge_methods_supported: ['S256'],
          authorization_response_iss_parameter_supported: true
        });
      }
      if (u.pathname === '/register') {
        registered.push(JSON.parse(body) as Record<string, unknown>);
        return send(201, { client_id: 'cid-1' });
      }
      if (u.pathname === '/authorize') {
        const to = new URL(u.searchParams.get('redirect_uri')!);
        to.searchParams.set('code', 'code-1');
        to.searchParams.set('state', u.searchParams.get('state')!);
        to.searchParams.set('iss', url);
        res.writeHead(302, { location: to.href });
        return res.end();
      }
      if (u.pathname === '/token') {
        if (new URLSearchParams(body).get('grant_type') === 'refresh_token' && o.refreshReply) return send(o.refreshReply.status, o.refreshReply.body);
        return send(200, { access_token: 'at-1', token_type: 'Bearer', ...o.tokenExtra });
      }
      send(404, {});
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return {
    url, requests, registered,
    close: () => new Promise<void>((r) => { server.close(() => r()); server.closeAllConnections(); })
  };
}

let tiny: Tiny | null = null;
afterEach(async () => { await tiny?.close(); tiny = null; });

const notion = (t: Tiny, scope?: string) => mcpEndpoint({ base: 'https://mcp.notion.com', name: 'Notion', ...(scope ? { scope } : {}), override: t.url });
const flow = (t: Tiny, o: Partial<Parameters<typeof runOAuth>[0]> = {}) => ({
  endpoint: notion(t), transport: fetchTransport(), signal: new AbortController().signal, open: browser(), ...o
});

describe('generic OAuth', () => {
  test('the authorize URL has no scope when the endpoint has none', async () => {
    tiny = await startTiny();
    let opened = '';
    await runOAuth(flow(tiny, { open: (url, d) => { opened = url; browser()(url, d); } }));
    expect(new URL(opened).searchParams.has('scope')).toBe(false);
    expect(new URL(opened).searchParams.get('resource')).toBe(`${tiny.url}/mcp`);
  });

  test('the authorize URL carries the endpoint scope when it has one', async () => {
    tiny = await startTiny();
    let opened = '';
    await runOAuth(flow(tiny, { endpoint: notion(tiny, 'read'), open: (url, d) => { opened = url; browser()(url, d); } }));
    expect(new URL(opened).searchParams.get('scope')).toBe('read');
  });

  test('DCR asks for refresh_token when the server lists it, and only then', async () => {
    tiny = await startTiny({ refreshGrant: true });
    await runOAuth(flow(tiny));
    expect(tiny.registered[0]!.grant_types).toEqual(['authorization_code', 'refresh_token']);
    await tiny.close();
    tiny = await startTiny({ refreshGrant: false });
    await runOAuth(flow(tiny));
    expect(tiny.registered[0]!.grant_types).toEqual(['authorization_code']);
  });

  test("the token reply's refresh_token and expires_in come back with the client id", async () => {
    tiny = await startTiny({ refreshGrant: true, tokenExtra: { refresh_token: 'rt-1', expires_in: 3600 } });
    const tokens = await runOAuth(flow(tiny, { now: () => 1_000_000 }));
    expect(tokens).toEqual({ accessToken: 'at-1', refreshToken: 'rt-1', expiresAt: 1_000_000 + 3_600_000, clientId: 'cid-1' });
  });

  test('a reply without them stays a plain token (ClickUp)', async () => {
    tiny = await startTiny();
    const tokens = await runOAuth(flow(tiny));
    expect(tokens).toEqual({ accessToken: 'at-1', clientId: 'cid-1' });
  });

  test('the loopback page names the connector', async () => {
    tiny = await startTiny();
    const seen: { status: number; body: string; csp: string | null; url: string }[] = [];
    await runOAuth(flow(tiny, { open: browser(seen) }));
    await expect.poll(() => seen.length).toBe(1);
    expect(seen[0]!.body).toContain('Notion');
    expect(seen[0]!.body).not.toContain('ClickUp');
  });

  test('the denied page names the connector too', async () => {
    tiny = await startTiny();
    const seen: { status: number; body: string; csp: string | null; url: string }[] = [];
    const open: AuthOpener = (url) => {
      void (async () => {
        const r = await fetch(url, { redirect: 'manual' });
        const to = new URL(r.headers.get('location')!);
        const cb = new URL(to.origin + to.pathname);
        cb.searchParams.set('error', 'access_denied');
        cb.searchParams.set('state', to.searchParams.get('state')!);
        cb.searchParams.set('iss', to.searchParams.get('iss')!);
        const page = await fetch(cb);
        seen.push({ status: page.status, body: await page.text(), csp: null, url: cb.href });
      })();
    };
    await failure(runOAuth(flow(tiny, { open })));
    await expect.poll(() => seen.length).toBe(1);
    expect(seen[0]!.body).toContain("You didn&#39;t allow access in Notion");
  });
});

describe('refreshAccessToken', () => {
  const refresh = (t: Tiny, o: Partial<Parameters<typeof refreshAccessToken>[0]> = {}) => refreshAccessToken({
    endpoint: notion(t), transport: fetchTransport(), clientId: 'cid-1', refreshToken: 'rt-old', signal: new AbortController().signal, ...o
  });

  test('posts grant_type=refresh_token with client_id, refresh_token and resource', async () => {
    tiny = await startTiny({ refreshGrant: true, refreshReply: { status: 200, body: { access_token: 'at-2', token_type: 'Bearer', expires_in: 60 } } });
    const tokens = await refresh(tiny, { now: () => 5_000 });
    const post = tiny.requests.filter((r) => r.method === 'POST' && r.path === '/token').at(-1)!;
    expect(Object.fromEntries(new URLSearchParams(post.body))).toEqual({
      grant_type: 'refresh_token', client_id: 'cid-1', refresh_token: 'rt-old', resource: `${tiny.url}/mcp`
    });
    expect(tokens).toEqual({ accessToken: 'at-2', refreshToken: 'rt-old', expiresAt: 65_000, clientId: 'cid-1' });
  });

  test('a rotated refresh token replaces the old one; none returned keeps the old one', async () => {
    tiny = await startTiny({ refreshGrant: true, refreshReply: { status: 200, body: { access_token: 'at-2', token_type: 'Bearer', refresh_token: 'rt-new' } } });
    expect((await refresh(tiny)).refreshToken).toBe('rt-new');
    await tiny.close();
    tiny = await startTiny({ refreshGrant: true, refreshReply: { status: 200, body: { access_token: 'at-3', token_type: 'Bearer' } } });
    const t = await refresh(tiny);
    expect(t.refreshToken).toBe('rt-old');
    expect(t.expiresAt).toBeUndefined();
  });

  test('invalid_grant → AuthFailed(signed-out)', async () => {
    tiny = await startTiny({ refreshGrant: true, refreshReply: { status: 400, body: { error: 'invalid_grant' } } });
    const e = await failure(refresh(tiny));
    expect(e.reason).toBe('signed-out');
  });

  test('400 or 401 without a known error → AuthFailed(signed-out) (spec A.2)', async () => {
    for (const status of [400, 401]) {
      tiny = await startTiny({ refreshGrant: true, refreshReply: { status, body: {} } });
      expect((await failure(refresh(tiny))).reason).toBe('signed-out');
      await tiny.close();
      tiny = null;
    }
  });

  test('a rate limit (429) or a CDN challenge (403) is not a sign-out → Unreachable', async () => {
    for (const status of [429, 403]) {
      tiny = await startTiny({ refreshGrant: true, refreshReply: { status, body: { error: 'slow_down' } } });
      await expect(refresh(tiny)).rejects.toBeInstanceOf(Unreachable);
      await tiny.close();
      tiny = null;
    }
  });

  test('5xx → Unreachable', async () => {
    tiny = await startTiny({ refreshGrant: true, refreshReply: { status: 503, body: {} } });
    await expect(refresh(tiny)).rejects.toBeInstanceOf(Unreachable);
  });

  test('a closed port → Unreachable', async () => {
    tiny = await startTiny({ refreshGrant: true });
    const ep = notion(tiny);
    await tiny.close();
    await expect(refreshAccessToken({
      endpoint: ep, transport: fetchTransport(), clientId: 'c', refreshToken: 'r', signal: new AbortController().signal
    })).rejects.toBeInstanceOf(Unreachable);
  });

  test('a token endpoint that refuses the connection (metadata already known) → Unreachable', async () => {
    const ep = mcpEndpoint({ base: 'https://mcp.notion.com', name: 'Notion', override: 'http://127.0.0.1:49101' });
    const transport = scripted(ep.base, { onPost: () => { throw new Error('connect ECONNREFUSED'); } });
    const o = { endpoint: ep, transport, clientId: 'c', refreshToken: 'r', signal: new AbortController().signal };
    await expect(refreshAccessToken(o)).rejects.toBeInstanceOf(Unreachable); // discovery, then the refused POST
    await expect(refreshAccessToken(o)).rejects.toBeInstanceOf(Unreachable); // cached discovery, refused POST
  });
});

/** A transport for one origin: discovery answers (with a revocation endpoint), POSTs go to `onPost`. */
function scripted(base: string, o: { onPost: (req: HttpRequest, signal: AbortSignal) => Promise<HttpResponse> }): Transport {
  const json = (status: number, body: unknown): HttpResponse => ({
    status, headers: { 'content-type': 'application/json' }, location: null,
    body: (async function* () { yield Buffer.from(JSON.stringify(body)); })(), close: () => undefined
  });
  return async (req, signal) => {
    if (req.method === 'POST') return o.onPost(req, signal);
    return json(200, {
      issuer: base, authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token`, registration_endpoint: `${base}/register`,
      revocation_endpoint: `${base}/revoke`, grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none']
    });
  };
}

describe('revokeToken', () => {
  test('gives up after 5 s when the server never answers (Disconnect never waits longer)', async () => {
    vi.useFakeTimers();
    try {
      const ep = mcpEndpoint({ base: 'https://mcp.notion.com', name: 'Notion', override: 'http://127.0.0.1:49102' });
      let posted = false;
      const transport = scripted(ep.base, {
        onPost: (_req, signal) => { posted = true; return new Promise((_r, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')))); }
      });
      let done = false;
      const p = revokeToken({ endpoint: ep, transport, clientId: 'c', token: 't' }).then(() => { done = true; });
      await vi.advanceTimersByTimeAsync(4_999);
      expect(posted).toBe(true);
      expect(done).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(done).toBe(true);
      await p;
    } finally {
      vi.useRealTimers();
    }
  });

  const revoke = (t: Tiny) => revokeToken({ endpoint: notion(t), transport: fetchTransport(), clientId: 'cid-1', token: 'rt-1' });

  test('posts token and client_id to the revocation_endpoint', async () => {
    tiny = await startTiny({ revocation: true });
    await revoke(tiny);
    const post = tiny.requests.filter((r) => r.method === 'POST' && r.path === '/token');
    expect(post).toHaveLength(1);
    expect(Object.fromEntries(new URLSearchParams(post[0]!.body))).toEqual({ token: 'rt-1', client_id: 'cid-1' });
  });

  test('does nothing without a revocation endpoint', async () => {
    tiny = await startTiny({ revocation: false });
    await revoke(tiny);
    expect(tiny.requests.filter((r) => r.method === 'POST')).toHaveLength(0);
  });

  test('never throws: unreachable server, failing endpoint', async () => {
    tiny = await startTiny({ revocation: true });
    const ep = notion(tiny);
    await tiny.close();
    await expect(revokeToken({ endpoint: ep, transport: fetchTransport(), clientId: 'c', token: 't' })).resolves.toBeUndefined();
  });

  test('validateMetadata keeps a revocation endpoint on the allowed origin and drops another', () => {
    const base = 'https://mcp.notion.com';
    const ep = mcpEndpoint({ base, name: 'Notion' });
    const good = {
      issuer: base, authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token`, registration_endpoint: `${base}/register`,
      grant_types_supported: ['authorization_code', 'refresh_token'], code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none']
    };
    expect(validateMetadata({ ...good, revocation_endpoint: `${base}/token` }, ep)).toMatchObject({ revocationEndpoint: `${base}/token`, refreshGrant: true });
    expect(validateMetadata({ ...good, revocation_endpoint: 'https://attacker.example/revoke' }, ep)).not.toHaveProperty('revocationEndpoint');
    expect(validateMetadata(good, ep)).not.toHaveProperty('revocationEndpoint');
  });
});
