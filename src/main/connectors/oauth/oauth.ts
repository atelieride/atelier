// Connector sign-in: OAuth 2.1 authorization code with PKCE S256 for a public
// client registered on the fly (RFC 7591 DCR), a loopback redirect (RFC 8252) and the issuer check on the callback
// (RFC 9207). Every step either succeeds the way Atelier requires or fails with AuthFailed (errors.ts): there is no
// weaker fallback (no `plain` PKCE, no client secret, no implicit flow).
//
// 1. discovery: GET /.well-known/oauth-authorization-server, validated (validateMetadata)
// 2. the loopback listener (loopback.ts): 127.0.0.1, free port, random path
// 3. DCR: POST registration_endpoint {client_name "Atelier", that redirect URI, token_endpoint_auth_method none,
//    grant_types authorization_code (+ refresh_token when the server lists it)}
// 4. the authorize URL (the endpoint's scope if it has one, 128-bit state, S256 challenge, resource = the MCP URL) goes to `open` (the user's
//    browser; the test follower in e2e)
// 5. the callback: state + iss checked, exactly once (loopback.ts)
// 6. the token exchange with the verifier → the tokens (access, and refresh + expiry when the server sends them),
//    returned to the caller, which resolves the account before storing anything.
//
// Jira: discovery may start from the protected resource (RFC 9728) and find the
// authorization server on its own origin with a path issuer; the client may be a Client ID Metadata Document
// (useatelier.dev/oauth/client.json: no registration, fixed loopback ports, exactly /callback), with DCR as the
// fallback when the server stops advertising it or every listed port is taken; the callback's `iss` is checked as RFC 9207 section 2.4 says when the
// connector allows it (Atlassian sends none).
//
// Afterwards `refreshAccessToken` renews an expiring access token (grant refresh_token, rotation honoured) and
// `revokeToken` tells the server to forget a token on Disconnect (best effort, never throws). Both find the token and
// revocation endpoints through the same validated discovery, cached per base.
//
// The state, the verifier, the code and the token stay in this module's locals; nothing here logs or throws them.
import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { Aborted, AuthFailed, ConnectorError, TooLarge, Unreachable } from '../errors';
import { requestText, type TextResponse, type Transport } from '../http';
import type { McpEndpoint } from '../endpoint';
import { cleanDescription, openLoopback, type LoopbackOptions } from './loopback';

export interface AuthMetadata {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  /** Absent only when a CIMD client doesn't need it. */
  registrationEndpoint?: string;
  /** The server accepts Client ID Metadata Documents. */
  cimd?: true;
  /** The server says it puts `iss` on callbacks (RFC 9207). */
  issParam?: true;
  /** Only when the server lists the refresh_token grant. */
  refreshGrant?: true;
  /** Only when the server has one and it is on the allowed origin. */
  revocationEndpoint?: string;
}

export interface OAuthTokens {
  accessToken: string;
  refreshToken?: string;
  /** ms since the epoch, when the server said `expires_in`. */
  expiresAt?: number;
  /** The DCR client or the CIMD URL: refresh and revocation need it. */
  clientId: string;
}

/** What the flow needs of an endpoint; the Jira-era fields are optional (ClickUp and Notion leave them out). */
export type AuthEndpoint = Pick<McpEndpoint, 'base' | 'mcpUrl' | 'allow' | 'scope' | 'name'>
  & Partial<Pick<McpEndpoint, 'resource' | 'authBase' | 'discovery' | 'client' | 'issInCallback'>>;

const resourceOf = (ep: AuthEndpoint): string => ep.resource ?? ep.mcpUrl;

/** Opens the authorize URL. `deliver` takes a callback URL in-process (only the test follower uses it). */
export type AuthOpener = (url: string, deliver: (callbackUrl: string) => void) => void;

export interface OAuthOptions {
  endpoint: AuthEndpoint;
  transport: Transport;
  /** Cancel, the 5 minute timeout, Disconnect, quit: the flow stops with Aborted and the listener closes. */
  signal: AbortSignal;
  open: AuthOpener;
  /** Tests: port binding and attempts. */
  loopback?: Pick<LoopbackOptions, 'bind' | 'attempts'>;
  /** Per HTTP request (default http.ts's 20 s). */
  timeoutMs?: number;
  /** Tests: the clock behind `expiresAt`. */
  now?: () => number;
}

const strings = z.array(z.string()).optional();
const metadataSchema = z.object({
  issuer: z.string(),
  authorization_endpoint: z.string(),
  token_endpoint: z.string(),
  registration_endpoint: z.string().optional(),
  revocation_endpoint: z.string().optional(),
  client_id_metadata_document_supported: z.boolean().optional(),
  authorization_response_iss_parameter_supported: z.boolean().optional(),
  response_types_supported: strings,
  grant_types_supported: strings,
  code_challenge_methods_supported: strings,
  token_endpoint_auth_methods_supported: strings
});

const trimSlash = (s: string) => s.replace(/\/+$/, '');

function url(s: string): URL | null {
  try { return new URL(s); } catch { return null; }
}

/**
 * The server must offer exactly the flow Atelier uses: DCR (or, for a CIMD client, CIMD), S256, public
 * clients (`none`), the authorization code grant (RFC 8414's default when the list is absent) and `code` responses; the
 * issuer is the base URL (or the one the protected resource named), the registration and token endpoints are on an
 * allowed origin (main calls them), and the authorize page is https (the user's browser opens it). Anything else →
 * AuthFailed('unsupported').
 */
export function validateMetadata(raw: unknown, ep: Pick<McpEndpoint, 'base' | 'allow'> & Partial<Pick<McpEndpoint, 'client'>>, issuer: string = ep.base): AuthMetadata {
  const unsupported = () => new AuthFailed('unsupported');
  const r = metadataSchema.safeParse(raw);
  if (!r.success) throw unsupported();
  const m = r.data;
  if (trimSlash(m.issuer) !== trimSlash(issuer)) throw unsupported();
  const cimd = ep.client?.kind === 'cimd' && m.client_id_metadata_document_supported === true;
  if (!m.registration_endpoint && !cimd) throw unsupported();
  if (!m.code_challenge_methods_supported?.includes('S256')) throw unsupported();
  if (!m.token_endpoint_auth_methods_supported?.includes('none')) throw unsupported();
  if (m.grant_types_supported && !m.grant_types_supported.includes('authorization_code')) throw unsupported();
  if (m.response_types_supported && !m.response_types_supported.includes('code')) throw unsupported();
  const allowed = (s: string) => { const u = url(s); return !!u && ep.allow(u); };
  if (!allowed(m.token_endpoint) || (m.registration_endpoint !== undefined && !allowed(m.registration_endpoint))) throw unsupported();
  const auth = url(m.authorization_endpoint);
  if (!auth || auth.username !== '' || auth.password !== '' || !(auth.protocol === 'https:' || ep.allow(auth))) throw unsupported();
  return {
    issuer: m.issuer, authorizationEndpoint: auth.href, tokenEndpoint: m.token_endpoint,
    ...(m.registration_endpoint !== undefined ? { registrationEndpoint: m.registration_endpoint } : {}),
    ...(m.grant_types_supported?.includes('refresh_token') ? { refreshGrant: true as const } : {}),
    ...(m.client_id_metadata_document_supported === true ? { cimd: true as const } : {}),
    ...(m.authorization_response_iss_parameter_supported === true ? { issParam: true as const } : {}),
    ...(m.revocation_endpoint && allowed(m.revocation_endpoint) ? { revocationEndpoint: m.revocation_endpoint } : {})
  };
}

/** PKCE (RFC 7636): a 256-bit verifier and its S256 challenge. */
export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

/** The CSRF state: 128 random bits. */
export function randomState(): string {
  return randomBytes(16).toString('base64url');
}

export function authorizeUrl(endpoint: string, p: { clientId: string; redirectUri: string; state: string; challenge: string; resource: string; scope?: string }): string {
  const u = new URL(endpoint);
  const q = u.searchParams;
  q.set('response_type', 'code');
  q.set('client_id', p.clientId);
  q.set('redirect_uri', p.redirectUri);
  if (p.scope) q.set('scope', p.scope);
  q.set('state', p.state);
  q.set('code_challenge', p.challenge);
  q.set('code_challenge_method', 'S256');
  q.set('resource', p.resource);
  return u.href;
}

const registrationSchema = z.object({ client_id: z.string().min(1).max(4096) });
const tokenSchema = z.object({
  access_token: z.string().regex(/^[\x21-\x7e]{1,8192}$/),
  token_type: z.string(),
  refresh_token: z.string().regex(/^[\x21-\x7e]{1,8192}$/).optional(),
  expires_in: z.number().positive().finite().optional()
});
const oauthErrorSchema = z.object({ error: z.string(), error_description: z.string().optional() });

function json(res: TextResponse): unknown {
  try { return JSON.parse(res.text); } catch { return undefined; }
}

/** One HTTP call of the flow: transport failures → network, anything else that isn't ours → unsupported. */
async function call(o: OAuthOptions, signal: AbortSignal, req: Parameters<typeof requestText>[1]): Promise<TextResponse> {
  try {
    return await requestText(o.transport, req, { allow: o.endpoint.allow, signal, ...(o.timeoutMs ? { timeoutMs: o.timeoutMs } : {}) });
  } catch (e) {
    if (e instanceof Aborted) throw e;
    if (e instanceof TooLarge) throw new AuthFailed('unsupported');
    throw new AuthFailed('network');
  }
}

function tokensOf(t: z.infer<typeof tokenSchema>, clientId: string, now: () => number, keepRefresh?: string): OAuthTokens {
  const refreshToken = t.refresh_token ?? keepRefresh;
  return {
    accessToken: t.access_token,
    ...(refreshToken ? { refreshToken } : {}),
    ...(t.expires_in ? { expiresAt: now() + t.expires_in * 1000 } : {}),
    clientId
  };
}

/** A 5xx is ClickUp being down (network); another non-2xx means the flow isn't what Atelier knows (unsupported). */
const httpFailure = (status: number) => new AuthFailed(status >= 500 ? 'network' : 'unsupported');

const prmSchema = z.object({ resource: z.string(), authorization_servers: z.array(z.string()).min(1) });

/**
 * Finds and validates the authorization server's metadata: at `<base>/.well-known/oauth-authorization-server`, or
 * (protected-resource discovery, RFC 9728) through `<base>/.well-known/oauth-protected-resource<resource path>`, which
 * must name this resource and an authorization server on `authBase`'s origin; that issuer's metadata is then read at
 * `<issuer>/.well-known/oauth-authorization-server`. `get` makes one GET (the caller's error mapping) and `status`
 * judges a non-200.
 */
async function discover(ep: AuthEndpoint, get: (url: string) => Promise<TextResponse>, status: (s: number) => Error): Promise<AuthMetadata> {
  let issuer = ep.base;
  if (ep.discovery === 'protected-resource') {
    const res = await get(`${ep.base}/.well-known/oauth-protected-resource${new URL(resourceOf(ep)).pathname}`);
    if (res.status !== 200) throw status(res.status);
    const p = prmSchema.safeParse(json(res));
    if (!p.success || p.data.resource !== resourceOf(ep)) throw new AuthFailed('unsupported');
    const as = url(p.data.authorization_servers[0]!);
    const authOrigin = new URL(ep.authBase ?? ep.base).origin;
    if (!as || as.origin !== authOrigin || as.search !== '' || as.hash !== '' || !ep.allow(as)) throw new AuthFailed('unsupported');
    issuer = trimSlash(as.href);
  }
  const res = await get(`${issuer}/.well-known/oauth-authorization-server`);
  if (res.status !== 200) throw status(res.status);
  return validateMetadata(json(res), ep, issuer);
}

export async function runOAuth(o: OAuthOptions): Promise<OAuthTokens> {
  if (o.signal.aborted) throw new Aborted();
  // The flow's own signal: the caller's (Cancel, timeout, quit) or a callback that broke the rules.
  const flow = new AbortController();
  let violated = false;
  const onOuter = () => flow.abort();
  o.signal.addEventListener('abort', onOuter, { once: true });
  let loopback: Awaited<ReturnType<typeof openLoopback>> | null = null;
  try {
    const meta = await discover(o.endpoint, (u) => call(o, flow.signal, { method: 'GET', url: u, headers: { accept: 'application/json' } }), httpFailure);
    metadataCache.set(o.endpoint.base, meta);
    // The published document when the server takes it, else a registration (ClickUp, Notion; Jira's fallback).
    let cimd = o.endpoint.client?.kind === 'cimd' && meta.cimd ? o.endpoint.client : null;
    const registrationEndpoint = meta.registrationEndpoint;
    if (!cimd && !registrationEndpoint) throw new AuthFailed('unsupported');

    const state = randomState();
    const { verifier, challenge } = pkcePair();
    const listen = (fixed: { ports: readonly number[] } | null) => openLoopback({
      state, issuer: meta.issuer, connectorName: o.endpoint.name, ...o.loopback,
      issRequired: o.endpoint.issInCallback !== 'when-advertised' || meta.issParam === true,
      ...(fixed ? { fixedPath: true, ports: fixed.ports } : {}),
      onViolation: () => { violated = true; flow.abort(); }
    });
    try {
      loopback = await listen(cimd);
    } catch (e) {
      // Every port the document lists is taken (or reserved: Windows keeps ranges for Hyper-V, WSL, Docker): a client
      // registered on the fly can use any port, when the server offers registration.
      if (!(cimd && registrationEndpoint && e instanceof AuthFailed && e.reason === 'port')) throw e;
      cimd = null;
      loopback = await listen(null);
    }
    if (flow.signal.aborted) throw new Aborted();
    const redirectUri = loopback.redirectUri;

    let clientId: string;
    if (cimd) {
      clientId = cimd.id;
    } else {
      const registration = await call(o, flow.signal, {
        method: 'POST', url: registrationEndpoint!,
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({
          client_name: 'Atelier', redirect_uris: [redirectUri], token_endpoint_auth_method: 'none',
          grant_types: meta.refreshGrant ? ['authorization_code', 'refresh_token'] : ['authorization_code'], response_types: ['code']
        })
      });
      if (registration.status < 200 || registration.status > 299) throw httpFailure(registration.status);
      const reg = registrationSchema.safeParse(json(registration));
      if (!reg.success) throw new AuthFailed('unsupported');
      clientId = reg.data.client_id;
    }

    const lb = loopback;
    o.open(authorizeUrl(meta.authorizationEndpoint, { clientId, redirectUri, state, challenge, resource: resourceOf(o.endpoint), ...(o.endpoint.scope ? { scope: o.endpoint.scope } : {}) }), (cb) => lb.deliver(cb));
    const answer = await Promise.race([
      lb.result,
      new Promise<never>((_r, reject) => {
        if (flow.signal.aborted) reject(new Aborted());
        flow.signal.addEventListener('abort', () => reject(new Aborted()), { once: true });
      })
    ]);
    if (answer.kind === 'denied') throw new AuthFailed('denied');
    if (answer.kind === 'error') throw new AuthFailed('oauth-error', answer.description);

    const form = new URLSearchParams({
      grant_type: 'authorization_code', code: answer.code, redirect_uri: redirectUri, client_id: clientId, code_verifier: verifier,
      resource: resourceOf(o.endpoint)
    });
    const exchange = await call(o, flow.signal, {
      method: 'POST', url: meta.tokenEndpoint,
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body: form.toString()
    });
    // A second callback during the exchange still stops the flow: its token is dropped.
    if (flow.signal.aborted) throw new Aborted();
    if (exchange.status >= 500) throw new AuthFailed('network');
    if (exchange.status !== 200) {
      const err = oauthErrorSchema.safeParse(json(exchange));
      if (err.success) throw new AuthFailed('oauth-error', cleanDescription(err.data.error_description || err.data.error) || 'unknown error');
      throw new AuthFailed('unsupported');
    }
    const token = tokenSchema.safeParse(json(exchange));
    if (!token.success || token.data.token_type.toLowerCase() !== 'bearer') throw new AuthFailed('unsupported');
    return tokensOf(token.data, clientId, o.now ?? Date.now);
  } catch (e) {
    if (violated) throw new AuthFailed('verify');
    if (o.signal.aborted) throw new Aborted();
    if (e instanceof ConnectorError) throw e;
    throw new AuthFailed('network');
  } finally {
    o.signal.removeEventListener('abort', onOuter);
    loopback?.close();
  }
}

// ── Refresh and revocation ──────────────────────────────────────────────────────────────────────────────────────────

/** The validated metadata per base (the token and revocation endpoints of the last discovery): refresh and revoke run
 * long after sign-in and must not re-discover every time. */
const metadataCache = new Map<string, AuthMetadata>();

/** OAuth errors that mean the refresh token is no good: sign in again. */
const REFUSED: ReadonlySet<string> = new Set(['invalid_grant', 'invalid_client', 'unauthorized_client']);

/** Revocation on Disconnect waits at most this long per request. */
export const REVOKE_TIMEOUT_MS = 5_000;

/**
 * Errors here are the connector's typed ones (Unreachable, Aborted…): a refresh is an ordinary operation, not a flow. A
 * transport failure (refused, reset, timed out) is Unreachable from requestText (http.ts), so a refresh goes offline.
 */
async function metadataFor(o: { endpoint: AuthEndpoint; transport: Transport; signal?: AbortSignal; timeoutMs?: number }): Promise<AuthMetadata> {
  const cached = metadataCache.get(o.endpoint.base);
  if (cached) return cached;
  const meta = await discover(o.endpoint, (u) => requestText(o.transport, { method: 'GET', url: u, headers: { accept: 'application/json' } },
    { allow: o.endpoint.allow, ...(o.signal ? { signal: o.signal } : {}), ...(o.timeoutMs ? { timeoutMs: o.timeoutMs } : {}) }),
  (s) => (s >= 500 || s === 429 || s === 403 ? new Unreachable('server', s) : new AuthFailed('unsupported')));
  metadataCache.set(o.endpoint.base, meta);
  return meta;
}

/**
 * Renews an access token. A refused refresh token (`invalid_grant`, `invalid_client`, or any 400 / 401)
 * means the user must sign in again → AuthFailed('signed-out'); a 5xx, a 429, a 403 (a CDN challenge) or no answer is
 * Unreachable (the caller retries later); a reply Atelier can't read → AuthFailed('unsupported'). A server that rotates
 * sends a new refresh token, which replaces the old one; one that doesn't keeps the old one valid.
 */
export async function refreshAccessToken(o: {
  endpoint: AuthEndpoint; transport: Transport; clientId: string; refreshToken: string; signal: AbortSignal; now?: () => number;
}): Promise<OAuthTokens> {
  let meta: AuthMetadata;
  try {
    meta = await metadataFor(o);
  } catch (e) {
    if (e instanceof TooLarge) throw new AuthFailed('unsupported');
    throw e;
  }
  const form = new URLSearchParams({
    grant_type: 'refresh_token', client_id: o.clientId, refresh_token: o.refreshToken, resource: resourceOf(o.endpoint)
  });
  let res: TextResponse;
  try {
    res = await requestText(o.transport, {
      method: 'POST', url: meta.tokenEndpoint,
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body: form.toString()
    }, { allow: o.endpoint.allow, signal: o.signal });
  } catch (e) {
    if (e instanceof TooLarge) throw new AuthFailed('unsupported');
    throw e;
  }
  const err = res.status === 200 ? null : oauthErrorSchema.safeParse(json(res));
  // Atlassian refuses a dead refresh token with a 403 carrying an OAuth error (unauthorized_client).
  if (res.status === 403 && err?.success && REFUSED.has(err.data.error)) throw new AuthFailed('signed-out');
  // A rate limit or a CDN challenge in front of the token endpoint is the server not answering, never a sign-out.
  if (res.status >= 500 || res.status === 429 || res.status === 403) throw new Unreachable('server', res.status);
  if (err) {
    if (err.success && REFUSED.has(err.data.error)) throw new AuthFailed('signed-out');
    if (res.status === 400 || res.status === 401) throw new AuthFailed('signed-out');
    throw new AuthFailed('unsupported');
  }
  const token = tokenSchema.safeParse(json(res));
  if (!token.success || token.data.token_type.toLowerCase() !== 'bearer') throw new AuthFailed('unsupported');
  return tokensOf(token.data, o.clientId, o.now ?? Date.now, o.refreshToken);
}

/**
 * Best-effort revocation on Disconnect (RFC 7009): posts the token and client id to the server's revocation endpoint,
 * if it has one. Never throws: every error and the server's verdict are ignored (the local copy is deleted either way).
 * Each request gives up after 5 s, so with a discovery not yet cached it can take up to ~10 s; Disconnect doesn't wait
 * for it (the connector runs it in the background).
 */
export async function revokeToken(o: { endpoint: AuthEndpoint; transport: Transport; clientId: string; token: string }): Promise<void> {
  try {
    const meta = await metadataFor({ ...o, timeoutMs: REVOKE_TIMEOUT_MS });
    if (!meta.revocationEndpoint) return;
    await requestText(o.transport, {
      method: 'POST', url: meta.revocationEndpoint,
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({ token: o.token, client_id: o.clientId }).toString()
    }, { allow: o.endpoint.allow, timeoutMs: REVOKE_TIMEOUT_MS });
  } catch {
    // Disconnect goes on: the server keeps a token that expires by itself.
  }
}
