// Where a connector talks: one https origin that is both the OAuth server and the MCP host
// (https://mcp.clickup.com, https://mcp.notion.com), and only there. A test override swaps the origin for a local fake
// (tests/fixtures/fake-*.mjs); only a bare http://127.0.0.1:<port> is taken, anything else is ignored. The override
// itself comes from a devEnv variable read by the connector's own config (inert in the packaged app).
//
// Jira adds what Atlassian needs, all optional: the authorization server on its own
// origin (`authBase`, allowed next to `base` and nothing else), an MCP URL with a path and a query while the OAuth
// `resource` stays without the query, discovery from the protected resource (RFC 9728), a Client ID Metadata Document
// as the client, and an `iss` callback parameter checked only when the server advertises it (RFC 9207, section 2.4).
import { originAllow } from './http';

/** The OAuth client: registered on the fly (RFC 7591), or a Client ID Metadata Document Atelier publishes. */
export type OAuthClient =
  | { kind: 'dcr' }
  /** `ports`: the loopback ports the document lists, tried in order (0 = any, tests only). */
  | { kind: 'cimd'; id: string; ports: readonly number[] };

export interface McpEndpoint {
  /** The origin: the MCP host (and the OAuth issuer unless `authBase`). */
  base: string;
  /** The MCP endpoint (`${base}/mcp` unless the connector says otherwise). */
  mcpUrl: string;
  /** The OAuth `resource` and the protected resource's identity: `mcpUrl` without its query. */
  resource: string;
  /** Exactly `base`'s origin and `authBase`'s (net allowlist, per request and per redirect). */
  allow(u: URL): boolean;
  /** True when the test override is active. */
  test: boolean;
  /** The OAuth scope to ask for; none when the server defines no scopes (Notion) or refuses one (Jira). */
  scope?: string;
  /** The connector's name in user-facing copy (the sign-in pages). */
  name: string;
  /** The authorization server's origin, when it isn't `base` (Jira: https://auth.atlassian.com). */
  authBase?: string;
  /** How the authorization server is found: absent = `<base>/.well-known/oauth-authorization-server`. */
  discovery?: 'protected-resource';
  /** Absent = DCR. */
  client?: OAuthClient;
  /** Absent = the callback must carry `iss`. */
  issInCallback?: 'when-advertised';
}

function loopbackOverride(raw: string | undefined): string | null {
  if (!raw) return null;
  let u: URL;
  try { u = new URL(raw); } catch { return null; }
  const bare = u.pathname === '/' && u.search === '' && u.hash === '' && u.username === '' && u.password === '';
  return u.protocol === 'http:' && u.hostname === '127.0.0.1' && u.port !== '' && bare ? u.origin : null;
}

export interface EndpointOptions {
  base: string;
  name: string;
  scope?: string;
  override?: string;
  /** Default `/mcp`. */
  mcpPath?: string;
  /** Appended to the MCP URL only (never to the resource), e.g. `?tools=all`. */
  mcpQuery?: string;
  authBase?: string;
  /** The test override of `authBase` (a bare loopback origin; ignored otherwise). */
  authOverride?: string;
  discovery?: 'protected-resource';
  client?: OAuthClient;
  issInCallback?: 'when-advertised';
}

export function mcpEndpoint(o: EndpointOptions): McpEndpoint {
  const local = loopbackOverride(o.override);
  const authLocal = loopbackOverride(o.authOverride);
  const base = local ?? o.base;
  const test = local !== null || authLocal !== null;
  const authBase = o.authBase === undefined ? undefined : authLocal ?? local ?? o.authBase;
  const resource = `${base}${o.mcpPath ?? '/mcp'}`;
  const own = originAllow(base, { loopbackHttp: local !== null });
  const auth = authBase === undefined ? null : originAllow(authBase, { loopbackHttp: authBase !== o.authBase });
  // A CIMD client lists fixed ports; a test fake binds any free one (parallel test workers).
  const client = o.client?.kind === 'cimd' && test ? { ...o.client, ports: [0] } : o.client;
  return {
    base, mcpUrl: `${resource}${o.mcpQuery ?? ''}`, resource, test, name: o.name,
    allow: auth ? (u: URL) => own(u) || auth(u) : own,
    ...(o.scope ? { scope: o.scope } : {}),
    ...(authBase !== undefined ? { authBase } : {}),
    ...(o.discovery ? { discovery: o.discovery } : {}),
    ...(client ? { client } : {}),
    ...(o.issInCallback ? { issInCallback: o.issInCallback } : {})
  };
}
