import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, test } from 'vitest';
import { AuthFailed } from '../errors';
import type { HttpRequest, HttpResponse, Transport } from '../http';
import { mcpEndpoint, type EndpointOptions } from '../endpoint';
import { refreshAccessToken, runOAuth, validateMetadata, type AuthOpener } from './oauth';

// Discovery from
// the protected resource, the authorization server on its own origin with a path issuer, a Client ID Metadata Document
// as the client (DCR when the server stops advertising it), no `iss` on the callback, no scope, fixed loopback ports.

const MCP = 'https://mcp.atlassian.com';
const AUTH = 'https://auth.atlassian.com';
const ISSUER = `${AUTH}/VCeDsk8ZHncYF1g234fKtc4lNipbBhu3`;
const CIMD = 'https://useatelier.dev/oauth/client.json';

const endpoint = (o: Partial<EndpointOptions> = {}) => mcpEndpoint({
  base: MCP, name: 'Jira', mcpPath: '/v2/mcp', mcpQuery: '?tools=all', authBase: AUTH, discovery: 'protected-resource',
  client: { kind: 'cimd', id: CIMD, ports: [0] }, issInCallback: 'when-advertised', ...o
});

const prm = { resource: `${MCP}/v2/mcp`, authorization_servers: [ISSUER], bearer_methods_supported: ['header'], scopes_supported: ['read:me'] };
const metadata = {
  authorization_endpoint: `${AUTH}/authorize`, client_id_metadata_document_supported: true, code_challenge_methods_supported: ['S256'],
  grant_types_supported: ['authorization_code', 'client_credentials', 'refresh_token'], issuer: ISSUER, jwks_uri: `${AUTH}/.well-known/jwks.json`,
  registration_endpoint: `${ISSUER}/dcr/register`, response_types_supported: ['code', 'token'], revocation_endpoint: `${AUTH}/oauth/revoke`,
  token_endpoint: `${AUTH}/oauth/token`, token_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic', 'private_key_jwt']
};

interface Stub { requests: HttpRequest[]; transport: Transport }

/** Answers by URL; anything unrouted is a 404. */
function stub(routes: Record<string, (r: HttpRequest) => { status: number; body?: unknown; location?: string }>): Stub {
  const requests: HttpRequest[] = [];
  const transport: Transport = async (req) => {
    requests.push(req);
    const route = routes[req.url.split('?')[0]!];
    const out = route ? route(req) : { status: 404, body: {} };
    const text = typeof out.body === 'string' ? out.body : JSON.stringify(out.body ?? {});
    const res: HttpResponse = {
      status: out.status, headers: { 'content-type': 'application/json' }, location: out.location ?? null,
      body: (async function* () { yield Buffer.from(text); })(), close: () => undefined
    };
    return res;
  };
  return { requests, transport };
}

const tokens = { access_token: 'at-1', expires_in: 28800, id_token: 'x.y.z', refresh_token: 'rt-1', scope: 'read:jira:agent-interface write:jira:agent-interface', token_type: 'Bearer' };

const atlassian = (o: { meta?: Record<string, unknown>; prm?: Record<string, unknown> } = {}) => stub({
  [`${MCP}/.well-known/oauth-protected-resource/v2/mcp`]: () => ({ status: 200, body: o.prm ?? prm }),
  [`${ISSUER}/.well-known/oauth-authorization-server`]: () => ({ status: 200, body: o.meta ?? metadata }),
  [`${ISSUER}/dcr/register`]: () => ({ status: 201, body: { client_id: 'dcr-1', client_secret: 'ignored', token_endpoint_auth_method: 'none' } }),
  [`${AUTH}/oauth/token`]: () => ({ status: 200, body: tokens })
});

/** The browser: hands the callback straight to the loopback (the test follower's path), with or without `iss`. */
const answering = (seen: { url?: string }, cb: (authorize: URL) => string): AuthOpener => (url, deliver) => {
  seen.url = url;
  deliver(cb(new URL(url)));
};
const callback = (iss?: string) => (a: URL) => {
  const q = new URLSearchParams({ code: 'code-1', state: a.searchParams.get('state')! });
  if (iss !== undefined) q.set('iss', iss);
  return `${a.searchParams.get('redirect_uri')}?${q}`;
};

const failure = async (p: Promise<unknown>) => {
  const e = await p.then(() => null, (err: unknown) => err);
  expect(e).toBeInstanceOf(AuthFailed);
  return e as AuthFailed;
};

const blockers: Server[] = [];
afterEach(() => { for (const s of blockers.splice(0)) s.close(); });

describe('metadata', () => {
  test('a path issuer, endpoints on the authorization origin, CIMD: accepted; registration optional for a CIMD client', () => {
    const m = validateMetadata(metadata, endpoint(), ISSUER);
    expect(m).toMatchObject({ issuer: ISSUER, tokenEndpoint: `${AUTH}/oauth/token`, revocationEndpoint: `${AUTH}/oauth/revoke`, cimd: true, refreshGrant: true });
    expect(m.issParam).toBeUndefined();
    expect(validateMetadata({ ...metadata, registration_endpoint: undefined }, endpoint(), ISSUER).registrationEndpoint).toBeUndefined();
  });

  test('a DCR client still needs the registration endpoint; no CIMD and no DCR → unsupported', () => {
    let err: unknown = null;
    try { validateMetadata({ ...metadata, registration_endpoint: undefined, client_id_metadata_document_supported: undefined }, endpoint(), ISSUER); } catch (e) { err = e; }
    expect((err as AuthFailed).reason).toBe('unsupported');
  });

  test.each([
    ['another issuer than the protected resource named', { issuer: `${AUTH}/other` }],
    ['a token endpoint off both origins', { token_endpoint: 'https://api.atlassian.com/oauth/token' }],
    ['no S256', { code_challenge_methods_supported: ['plain'] }],
    ['no public clients', { token_endpoint_auth_methods_supported: ['client_secret_post'] }]
  ])('%s → unsupported', (_n, patch) => {
    let err: unknown = null;
    try { validateMetadata({ ...metadata, ...patch }, endpoint(), ISSUER); } catch (e) { err = e; }
    expect((err as AuthFailed).reason).toBe('unsupported');
  });

  test('`authorization_response_iss_parameter_supported` is carried', () => {
    expect(validateMetadata({ ...metadata, authorization_response_iss_parameter_supported: true }, endpoint(), ISSUER).issParam).toBe(true);
  });
});

describe('sign-in through the protected resource with the CIMD client', () => {
  test('PRM → metadata on the auth origin → no registration → authorize with the document as client_id, no scope → tokens', async () => {
    const a = atlassian();
    const seen: { url?: string } = {};
    const t = await runOAuth({ endpoint: endpoint(), transport: a.transport, signal: new AbortController().signal, open: answering(seen, callback()) });
    expect(t).toMatchObject({ accessToken: 'at-1', refreshToken: 'rt-1', clientId: CIMD });
    expect(a.requests.map((r) => `${r.method} ${r.url}`)).toEqual([
      `GET ${MCP}/.well-known/oauth-protected-resource/v2/mcp`,
      `GET ${ISSUER}/.well-known/oauth-authorization-server`,
      `POST ${AUTH}/oauth/token`
    ]);
    const u = new URL(seen.url!);
    expect(u.origin + u.pathname).toBe(`${AUTH}/authorize`);
    expect(u.searchParams.get('client_id')).toBe(CIMD);
    expect(u.searchParams.get('resource')).toBe(`${MCP}/v2/mcp`);
    expect(u.searchParams.has('scope')).toBe(false);
    // The document's redirect: 127.0.0.1, exactly /callback (no random segment).
    const redirect = new URL(u.searchParams.get('redirect_uri')!);
    expect(redirect.hostname).toBe('127.0.0.1');
    expect(redirect.pathname).toBe('/callback');
    const form = new URLSearchParams(a.requests[2]!.body);
    expect(form.get('client_id')).toBe(CIMD);
    expect(form.get('resource')).toBe(`${MCP}/v2/mcp`);
    expect(form.get('redirect_uri')).toBe(redirect.href);
  });

  test('the fixed path is guessable: a request without our state is refused but doesn\'t end the sign-in', async () => {
    const a = atlassian();
    const t = await runOAuth({
      endpoint: endpoint(), transport: a.transport, signal: new AbortController().signal,
      open: (url, deliver) => {
        const u = new URL(url);
        const redirect = u.searchParams.get('redirect_uri')!;
        deliver(`${redirect}?code=evil&state=nope`);
        deliver(`${redirect}?code=evil`);
        deliver(callback()(u));
      }
    });
    expect(t.accessToken).toBe('at-1');
    expect(new URLSearchParams(a.requests.at(-1)!.body).get('code')).toBe('code-1');
  });

  test('after the good callback, a request without our state on the fixed path still doesn\'t end the sign-in', async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    const a = atlassian();
    const transport: Transport = async (req, signal) => {
      if (req.url === `${AUTH}/oauth/token`) await held;
      return a.transport(req, signal);
    };
    const t = await runOAuth({
      endpoint: endpoint(), transport, signal: new AbortController().signal,
      open: (url, deliver) => {
        const u = new URL(url);
        deliver(callback()(u));
        deliver(`${u.searchParams.get('redirect_uri')}?code=evil&state=nope`);
        release();
      }
    });
    expect(t.accessToken).toBe('at-1');
  });

  test('Atlassian\'s codes are long JWTs: a 6 KB code is taken and exchanged as is', async () => {
    const a = atlassian();
    const code = `eyJraWQiOiJhdXRoIiwiYWxnIjoiUlMyNTYifQ.${'eyJzY29wZXMiOlsi'.repeat(380)}.c2ln-_`;
    const t = await runOAuth({
      endpoint: endpoint(), transport: a.transport, signal: new AbortController().signal,
      open: (url, deliver) => {
        const u = new URL(url);
        deliver(`${u.searchParams.get('redirect_uri')}?${new URLSearchParams({ code, state: u.searchParams.get('state')! })}`);
      }
    });
    expect(t.accessToken).toBe('at-1');
    expect(new URLSearchParams(a.requests.at(-1)!.body).get('code')).toBe(code);
  });

  test('with DCR\'s random path, a wrong state still ends the flow (ClickUp\'s rule, unchanged)', async () => {
    const a = atlassian({ meta: { ...metadata, client_id_metadata_document_supported: undefined } });
    const e = await failure(runOAuth({
      endpoint: endpoint(), transport: a.transport, signal: new AbortController().signal,
      open: (url, deliver) => { deliver(`${new URL(url).searchParams.get('redirect_uri')}?code=x&state=nope`); }
    }));
    expect(e.reason).toBe('verify');
  });

  test('a callback with a wrong iss is refused even when the server never advertises iss', async () => {
    const a = atlassian();
    expect((await failure(runOAuth({ endpoint: endpoint(), transport: a.transport, signal: new AbortController().signal, open: answering({}, callback('https://evil.example')) }))).reason).toBe('verify');
  });

  test('a server that advertises iss: a callback without it is refused, with the right one accepted', async () => {
    const meta = { ...metadata, authorization_response_iss_parameter_supported: true };
    expect((await failure(runOAuth({ endpoint: endpoint(), transport: atlassian({ meta }).transport, signal: new AbortController().signal, open: answering({}, callback()) }))).reason).toBe('verify');
    const ok = await runOAuth({ endpoint: endpoint(), transport: atlassian({ meta }).transport, signal: new AbortController().signal, open: answering({}, callback(ISSUER)) });
    expect(ok.accessToken).toBe('at-1');
  });

  test('a connector without `when-advertised` (ClickUp, Notion) still requires iss', async () => {
    const ep = endpoint({ issInCallback: undefined });
    expect((await failure(runOAuth({ endpoint: ep, transport: atlassian().transport, signal: new AbortController().signal, open: answering({}, callback()) }))).reason).toBe('verify');
  });

  test('the protected resource must name this resource and an authorization server on the auth origin', async () => {
    for (const bad of [{ ...prm, resource: `${MCP}/v1/mcp` }, { ...prm, authorization_servers: ['https://attacker.example/x'] }, { ...prm, authorization_servers: [] }, { nope: 1 }]) {
      const e = await failure(runOAuth({ endpoint: endpoint(), transport: atlassian({ prm: bad }).transport, signal: new AbortController().signal, open: answering({}, callback()) }));
      expect(e.reason).toBe('unsupported');
    }
  });

  test('no CIMD advertised but DCR there → registers, as ClickUp does (random callback path)', async () => {
    const a = atlassian({ meta: { ...metadata, client_id_metadata_document_supported: undefined } });
    const seen: { url?: string } = {};
    const t = await runOAuth({ endpoint: endpoint(), transport: a.transport, signal: new AbortController().signal, open: answering(seen, callback()) });
    expect(t.clientId).toBe('dcr-1');
    const reg = a.requests.find((r) => r.url === `${ISSUER}/dcr/register`)!;
    expect(JSON.parse(reg.body!)).toMatchObject({ client_name: 'Atelier', token_endpoint_auth_method: 'none' });
    expect(new URL(new URL(seen.url!).searchParams.get('redirect_uri')!).pathname).toMatch(/^\/callback\/[0-9a-f]{32}$/);
  });

  test('fixed ports: a busy first port → the next one', async () => {
    const busy = createServer();
    blockers.push(busy);
    await new Promise<void>((r) => busy.listen(0, '127.0.0.1', () => r()));
    const taken = (busy.address() as { port: number }).port;
    const free = createServer();
    await new Promise<void>((r) => free.listen(0, '127.0.0.1', () => r()));
    const next = (free.address() as { port: number }).port;
    await new Promise<void>((r) => free.close(() => r()));
    const ep = { ...endpoint(), client: { kind: 'cimd' as const, id: CIMD, ports: [taken, next] } };
    const seen: { url?: string } = {};
    await runOAuth({ endpoint: ep, transport: atlassian().transport, signal: new AbortController().signal, open: answering(seen, callback()) });
    expect(new URL(new URL(seen.url!).searchParams.get('redirect_uri')!).port).toBe(String(next));
  });

  /** A port something else listens on (Windows also reserves whole ranges for Hyper-V, WSL, Docker). */
  const takenPort = async () => {
    const busy = createServer();
    blockers.push(busy);
    await new Promise<void>((r) => busy.listen(0, '127.0.0.1', () => r()));
    return (busy.address() as { port: number }).port;
  };

  test('every listed port busy → a client registered for a random port (DCR), and the sign-in goes on', async () => {
    const ep = { ...endpoint(), client: { kind: 'cimd' as const, id: CIMD, ports: [await takenPort(), await takenPort()] } };
    const a = atlassian();
    const seen: { url?: string } = {};
    const t = await runOAuth({ endpoint: ep, transport: a.transport, signal: new AbortController().signal, open: answering(seen, callback()) });
    expect(t).toMatchObject({ accessToken: 'at-1', clientId: 'dcr-1' });
    const reg = a.requests.find((r) => r.url === `${ISSUER}/dcr/register`)!;
    const redirect = new URL(new URL(seen.url!).searchParams.get('redirect_uri')!);
    expect(JSON.parse(reg.body!).redirect_uris).toEqual([redirect.href]);
    expect(redirect.pathname).toMatch(/^\/callback\/[0-9a-f]{32}$/);
    expect(new URL(seen.url!).searchParams.get('client_id')).toBe('dcr-1');
    expect(new URLSearchParams(a.requests.at(-1)!.body).get('client_id')).toBe('dcr-1');
  });

  test('every listed port busy and no registration offered → port failure, nothing else asked', async () => {
    const ep = { ...endpoint(), client: { kind: 'cimd' as const, id: CIMD, ports: [await takenPort()] } };
    const a = atlassian({ meta: { ...metadata, registration_endpoint: undefined } });
    const e = await failure(runOAuth({ endpoint: ep, transport: a.transport, signal: new AbortController().signal, open: answering({}, callback()) }));
    expect(e.reason).toBe('port');
    expect(a.requests.some((r) => r.url.endsWith('/oauth/token') || r.url.endsWith('/dcr/register'))).toBe(false);
  });

  test('refresh finds the token endpoint through the same discovery and keeps the CIMD client id', async () => {
    const a = atlassian();
    const t = await refreshAccessToken({ endpoint: endpoint(), transport: a.transport, clientId: CIMD, refreshToken: 'rt-0', signal: new AbortController().signal });
    expect(t).toMatchObject({ accessToken: 'at-1', refreshToken: 'rt-1', clientId: CIMD });
    const form = new URLSearchParams(a.requests.at(-1)!.body);
    expect(Object.fromEntries(form)).toMatchObject({ grant_type: 'refresh_token', client_id: CIMD, refresh_token: 'rt-0', resource: `${MCP}/v2/mcp` });
  });

  test('Atlassian refusing a refresh with 403 unauthorized_client is a sign-out, not a network problem', async () => {
    const a = stub({
      [`${MCP}/.well-known/oauth-protected-resource/v2/mcp`]: () => ({ status: 200, body: prm }),
      [`${ISSUER}/.well-known/oauth-authorization-server`]: () => ({ status: 200, body: metadata }),
      [`${AUTH}/oauth/token`]: () => ({ status: 403, body: { error: 'unauthorized_client' } })
    });
    const e = await failure(refreshAccessToken({ endpoint: endpoint(), transport: a.transport, clientId: CIMD, refreshToken: 'rt-0', signal: new AbortController().signal }));
    expect(e.reason).toBe('signed-out');
  });

  test('a bare 403 (a CDN challenge, no OAuth error) is still the server not answering', async () => {
    const a = stub({
      [`${MCP}/.well-known/oauth-protected-resource/v2/mcp`]: () => ({ status: 200, body: prm }),
      [`${ISSUER}/.well-known/oauth-authorization-server`]: () => ({ status: 200, body: metadata }),
      [`${AUTH}/oauth/token`]: () => ({ status: 403, body: '<html>challenge</html>' })
    });
    const e = await refreshAccessToken({ endpoint: endpoint(), transport: a.transport, clientId: CIMD, refreshToken: 'rt-0', signal: new AbortController().signal }).then(() => null, (x: unknown) => x);
    expect(e).not.toBeInstanceOf(AuthFailed);
  });
});
