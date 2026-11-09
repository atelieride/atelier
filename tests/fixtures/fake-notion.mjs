#!/usr/bin/env node
// Fake Notion for tests: an OAuth authorization server (with refresh tokens and revocation) and the MCP endpoint of
// Notion's hosted server, as observed on 2026-10-17, on 127.0.0.1
// with a random port. No test ever talks to real Notion. Types: fake-notion.d.mts. Mirrors fake-clickup.mjs.
// Data is invented: the workspace is built from the fictional fixtures in tests/fixtures/notion/ (the Engineering
// page, the Sprint Tasks and Engineering Backlog databases with their rows, and Roadmap, one database with two data
// sources, Web and Mobile), nothing is duplicated here.
//
// Use
//   In-process (vitest): `const fake = await startFakeNotion({ logFile })`, then point the app at `fake.url`
//   (the connector's test URL override). `await fake.close()` ends it (keep-alive sockets included).
//   CLI: `node tests/fixtures/fake-notion.mjs [--log <file>] [--scenario <name>] [--sse]` prints one JSON line
//   `{"url":"http://127.0.0.1:<port>"}` on stdout and runs until SIGTERM/SIGINT.
//
// Endpoints (issuer = the base URL, no trailing slash)
//   GET  /.well-known/oauth-authorization-server   RFC 8414 metadata: grants authorization_code + refresh_token, S256
//                           only, `none` among the token auth methods, DCR, `revocation_endpoint` /token/revoke,
//                           authorization_response_iss_parameter_supported.
//   GET  /.well-known/oauth-protected-resource[/mcp]  RFC 9728 metadata for `<base>/mcp`.
//   POST /register          RFC 7591 DCR (JSON): needs redirect_uris and token_endpoint_auth_method "none" → 200.
//   GET  /authorize         Auto-approves: 302 to `redirect_uri?code&state&iss`. Needs a registered client_id, an exact
//                           redirect_uri, response_type=code, state, S256 challenge; `resource` (if sent) = `<base>/mcp`.
//   POST /token             Form body. authorization_code: checks client_id, redirect_uri, `resource` and the PKCE S256
//                           verifier; a code is consumed by its first exchange attempt (one-shot). refresh_token:
//                           rotates (the old refresh token dies with the exchange); unknown, used or revoked →
//                           400 invalid_grant. Reply: {access_token, token_type:"Bearer", expires_in, refresh_token};
//                           expires_in defaults to 3600 (setExpiresIn) and the access token really expires then.
//   POST /token/revoke      RFC 7009, form body {token, token_type_hint?, client_id?}: logged (`revoked()`), the token
//                           (access or refresh) stops working, always 200 (unknown tokens too).
//   POST /mcp               MCP streamable HTTP, protocol 2025-06-18, no session id. Needs `Authorization: Bearer <token
//                           issued here>` (401 otherwise) and an Accept with application/json and text/event-stream (406).
//                           One JSON-RPC reply as application/json, or as text/event-stream when SSE is on. Notifications
//                           get 202. Methods: initialize, ping, tools/list, tools/call. Tool results use the content
//                           shape `result.content = [{type:"text", text:<JSON of the data>}]`, failures `isError: true`.
//   POST /__scenario        Test control: JSON {name, opts?, sse?} → 200, unknown name → 400.
//   POST /__expire          Test control: expireAccessTokens().      POST /__revoke-refresh   revokeRefresh().
//   POST /__expires-in      Test control: JSON {seconds}.            GET  /__calls            {calls, details}.
//   GET  /__revoked         Test control: the revocation log.
//
// The call log: EVERY tools/call request that reaches /mcp with a JSON body is logged (before the auth and scenario
// checks, write tools included): in memory (`calls()`, `callDetails()`) and, with `logFile`, appended to that file as one
// name per line. Tests assert no write tool ever shows. Write tools (`notion-create-pages`, `notion-update-page`, …) still
// answer with a result, so a bug that calls one shows up both in the log and in the reply ("write tool executed on the
// fake Notion").
//
// Scenarios (setScenario(name, opts) / POST /__scenario; the default is `normal`)
//   normal            Everything works.
//   mcp-401           /mcp → 401 + WWW-Authenticate (invalid_token), like a revoked token.
//   mcp-500           /mcp → 500.
//   unshare-backlog   The Engineering Backlog (database, data source, its row pages, search hits) is no longer shared with
//                     the integration: fetch and query answer the tool error "Could not find database with ID: …".
//   rename-stage      The Backlog's "Stage" column is renamed "Phase" in the schema AND in the rows (a mapped column
//                     renamed in Notion): a filter on "Stage" is now on a missing column and, like Notion, IGNORED.
//
// Tool replies (shapes as observed)
//   notion-get-self {} → {workspace:{id,name}, user:{type,id,name,email}} ("me" for filters = that user id).
//   notion-search {query, page_size?, max_highlight_length?} → {results:[{id,title,url,type,highlight,timestamp,path?,
//     verification}], type:"workspace_search"}: the items whose title contains the query (case-insensitive).
//   notion-fetch {id} → {metadata:{type}, title, url, text, …}. id = a database id (32 hex, dashes or not) → the
//     database; `collection://<uuid>` → the data source; a row page id → a page in the fixtures' page format (properties
//     JSON with the prefixed ticket like "ENG-2", a short fictional body; the Pricing page keeps its injection body).
//   notion-query-data-sources {data:{mode:"rows", data_source_url, filter?, sort?, limit?}} → {results:[row…], has_more}.
//     Filters: a group `and` of the four observed shapes only: person_contains me; status_is_not is_group complete (the
//     data source's status groups); enum_is_not exact; string_contains exact on the title (case-insensitive). One sort,
//     ascending on a date property (rows without a date last), `limit`. A filter or sort on an unknown property is IGNORED
//     (like Notion). Anything else is a JSON-RPC -32602 error, so a bug in Atelier shows up.
import { createHash, randomBytes } from 'node:crypto';
import { appendFileSync, readFileSync, realpathSync } from 'node:fs';
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';

export const PROTOCOL_VERSION = '2025-06-18';
export const SCENARIOS = Object.freeze(['normal', 'mcp-401', 'mcp-500', 'unshare-backlog', 'rename-stage']);
export const READ_TOOLS = Object.freeze(['notion-get-self', 'notion-search', 'notion-fetch', 'notion-query-data-sources']);
export const WRITE_TOOLS = Object.freeze([
  'notion-create-pages', 'notion-update-page', 'notion-move-pages', 'notion-duplicate-page', 'notion-create-database',
  'notion-update-data-source', 'notion-create-comment', 'notion-delete-pages'
]);

const MAX_BODY = 1024 * 1024;
const DEFAULT_EXPIRES_IN = 3600;

// ── Fixture data ────────────────────────────────────────────────────────────────────────────────────────────────────

const loadJson = (name) => JSON.parse(readFileSync(new URL(`./notion/${name}.json`, import.meta.url), 'utf8'));
const dashed = (hex) => `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
const hexOf = (url) => /([0-9a-f]{32})(?:\?|$)/.exec(url)?.[1];
const stateOf = (text) => JSON.parse(/<data-source-state>\n([\s\S]*?)\n<\/data-source-state>/.exec(text)[1]);

/** A fresh copy per server: a test may mutate its fake's data without touching another's. */
export function makeFixtures() {
  const self = loadJson('get-self');
  const search = loadJson('search-tasks');
  const pricing = loadJson('fetch-page-pricing');
  // One entry per data source: a database with several (Roadmap: Web and Mobile) has one entry each, sharing its id and
  // its database reply (`dbKey`); fetch by the database id answers the first one's, which lists them all.
  const make = (key, ticketPrefix, dbKey = key) => {
    const dbReply = loadJson(`fetch-database-${dbKey}`);
    const dsReply = loadJson(`fetch-data-source-${key}`);
    const schema = stateOf(dsReply.text).schema;
    const parent = /<parent-page url="([^"]+)" title="([^"]+)"/.exec(dbReply.text);
    const id = hexOf(dbReply.url);
    const rows = loadJson(`rows-${key}`).results.map((r) => ({ ...r, id: hexOf(r.url) }));
    return {
      key, title: dbReply.title, id: dashed(id), hex: id, url: dbReply.url,
      collectionId: /collection:\/\/([0-9a-f-]{36})/.exec(dsReply.text)[1],
      schema, dbReply, dsReply, rows, ticketPrefix,
      parentUrl: parent[1], parentTitle: parent[2]
    };
  };
  const databases = [make('sprint', 'TASK'), make('backlog', 'ENG'), make('roadmap-web', 'RM', 'roadmap'), make('roadmap-mobile', 'RM', 'roadmap')];
  const parent = { id: dashed(hexOf(databases[0].parentUrl)), title: databases[0].parentTitle, url: databases[0].parentUrl };
  return { self, search, pricing, databases, parent };
}

const clone = (v) => JSON.parse(JSON.stringify(v));

// ── Tool descriptions (tools/list) ──────────────────────────────────────────────────────────────────────────────────

const obj = (properties, required = []) => ({ type: 'object', properties, required });
const TOOLS = [
  { name: 'notion-get-self', description: 'Information about the current user and workspace.', inputSchema: obj({}) },
  { name: 'notion-search', description: 'Search the workspace.',
    inputSchema: obj({ query: { type: 'string' }, page_size: { type: 'number' }, max_highlight_length: { type: 'number' } }, ['query']) },
  { name: 'notion-fetch', description: 'Fetch a page, database or data source.', inputSchema: obj({ id: { type: 'string' } }, ['id']) },
  { name: 'notion-query-data-sources', description: 'Query data sources.', inputSchema: obj({ data: { type: 'object' } }, ['data']) },
  ...WRITE_TOOLS.map((name) => ({ name, description: 'Write tool (the fake logs and answers it).', inputSchema: obj({}) }))
];

const textResult = (data) => ({ content: [{ type: 'text', text: typeof data === 'string' ? data : JSON.stringify(data) }] });
const errorResult = (text) => ({ isError: true, content: [{ type: 'text', text }] });
const invalid = (message) => ({ error: { code: -32602, message: `Invalid arguments: ${message}` } });

// ── Server ──────────────────────────────────────────────────────────────────────────────────────────────────────────

export async function startFakeNotion(opts = {}) {
  const fixtures = makeFixtures();
  const me = fixtures.self.user.id;
  let scenario = 'normal';
  let scenarioOpts = {};
  let sse = Boolean(opts.sse);
  let expiresIn = DEFAULT_EXPIRES_IN;
  const clients = new Map(); // client_id → { redirectUris }
  const codes = new Map(); // code → { clientId, redirectUri, challenge }
  const accessTokens = new Map(); // token → { clientId, expiresAt }
  const refreshTokens = new Map(); // token → { clientId }
  const callLog = []; // { name, arguments }
  const revokedLog = []; // { token, tokenTypeHint, clientId }
  let url = '';

  const setScenario = (name, o = {}) => {
    if (!SCENARIOS.includes(name)) throw new Error(`fake Notion: unknown scenario ${JSON.stringify(name)}`);
    scenario = name;
    scenarioOpts = { ...o };
  };
  setScenario(opts.scenario ?? 'normal', opts.scenarioOptions);

  const logCall = (name, args) => {
    const n = typeof name === 'string' ? name : JSON.stringify(name ?? null);
    callLog.push({ name: n, arguments: args });
    if (opts.logFile) appendFileSync(opts.logFile, (/^[A-Za-z0-9_.-]+$/.test(n) ? n : JSON.stringify(n)) + '\n');
  };

  const send = (res, status, body, headers = {}) => {
    const text = body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body);
    res.writeHead(status, {
      ...(body === undefined ? {} : { 'content-type': typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json' }),
      'content-length': Buffer.byteLength(text), ...headers
    });
    res.end(text);
  };
  const oauthError = (res, status, error, description) => send(res, status, { error, error_description: description });

  const readBody = (req) => new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });

  // ── OAuth ────────────────────────────────────────────────────────────────────────────────────────────────────────

  const metadata = () => ({
    issuer: url,
    authorization_endpoint: `${url}/authorize`,
    token_endpoint: `${url}/token`,
    registration_endpoint: `${url}/register`,
    revocation_endpoint: `${url}/token/revoke`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post', 'none'],
    revocation_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post', 'none'],
    scopes_supported: [],
    authorization_response_iss_parameter_supported: true
  });

  function register(res, raw) {
    let body;
    try { body = JSON.parse(raw); } catch { return oauthError(res, 400, 'invalid_client_metadata', 'Body is not JSON.'); }
    const uris = body?.redirect_uris;
    if (!Array.isArray(uris) || uris.length === 0 || !uris.every((u) => typeof u === 'string' && URL.canParse(u))) {
      return oauthError(res, 400, 'invalid_redirect_uri', 'redirect_uris must be a non-empty list of URLs.');
    }
    if (body.token_endpoint_auth_method !== 'none') {
      return oauthError(res, 400, 'invalid_client_metadata', 'Only public clients (token_endpoint_auth_method "none").');
    }
    const clientId = `fake-client-${randomBytes(12).toString('hex')}`;
    clients.set(clientId, { redirectUris: [...uris] });
    send(res, 200, {
      client_id: clientId, client_id_issued_at: Math.floor(Date.now() / 1000), client_name: body.client_name ?? null,
      redirect_uris: uris, token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code']
    });
  }

  function authorize(res, q) {
    const client = clients.get(q.get('client_id') ?? '');
    const redirectUri = q.get('redirect_uri') ?? '';
    // Without a known client and its exact redirect URI there is nowhere safe to send the user: a plain 400 page.
    if (!client || !client.redirectUris.includes(redirectUri)) return send(res, 400, 'Unknown client or redirect_uri.');
    const back = (params) => {
      const to = new URL(redirectUri);
      for (const [k, v] of Object.entries(params)) to.searchParams.set(k, v);
      res.writeHead(302, { location: to.toString(), 'content-length': 0 });
      res.end();
    };
    const state = q.get('state') ?? '';
    const fail = (error, description) => back({ error, error_description: description, ...(state ? { state } : {}), iss: url });
    if (q.get('response_type') !== 'code') return fail('unsupported_response_type', 'Only response_type=code.');
    if (!state) return fail('invalid_request', 'state is required.');
    if (q.get('code_challenge_method') !== 'S256' || !q.get('code_challenge')) return fail('invalid_request', 'PKCE S256 is required.');
    if (q.has('resource') && q.get('resource') !== `${url}/mcp`) return fail('invalid_target', 'Unknown resource.');
    const code = `fake-code-${randomBytes(16).toString('hex')}`;
    codes.set(code, { clientId: q.get('client_id'), redirectUri, challenge: q.get('code_challenge') });
    back({ code, state, iss: url });
  }

  function issueToken(clientId = 'fake-client-direct') {
    const t = `ntnat_${randomBytes(48).toString('base64url')}`;
    accessTokens.set(t, { clientId, expiresAt: Date.now() + expiresIn * 1000 });
    return t;
  }

  /** A fresh access + refresh pair, the reply body of both grants. */
  function issuePair(res, clientId) {
    const refresh = `ntnrt_${randomBytes(48).toString('base64url')}`;
    refreshTokens.set(refresh, { clientId });
    send(res, 200, { access_token: issueToken(clientId), token_type: 'Bearer', expires_in: expiresIn, refresh_token: refresh },
      { 'cache-control': 'no-store' });
  }

  function token(req, res, raw) {
    if (!(req.headers['content-type'] ?? '').startsWith('application/x-www-form-urlencoded')) {
      return oauthError(res, 400, 'invalid_request', 'Expected a form body.');
    }
    const f = new URLSearchParams(raw);
    if (f.has('resource') && f.get('resource') !== `${url}/mcp`) return oauthError(res, 400, 'invalid_target', 'Unknown resource.');
    const grant = f.get('grant_type');
    if (grant === 'refresh_token') {
      const presented = f.get('refresh_token') ?? '';
      const entry = refreshTokens.get(presented);
      refreshTokens.delete(presented); // rotation: the old refresh token is spent, right or wrong client
      if (!entry) return oauthError(res, 400, 'invalid_grant', 'Unknown, used or revoked refresh token.');
      if (f.get('client_id') !== entry.clientId) return oauthError(res, 400, 'invalid_grant', 'client_id mismatch.');
      return issuePair(res, entry.clientId);
    }
    if (grant !== 'authorization_code') return oauthError(res, 400, 'unsupported_grant_type', 'Only authorization_code and refresh_token.');
    const code = f.get('code') ?? '';
    const verifier = f.get('code_verifier') ?? '';
    if (!code || !verifier) return oauthError(res, 400, 'invalid_request', 'code and code_verifier are required.');
    const entry = codes.get(code);
    codes.delete(code); // one-shot: the first attempt consumes the code, right or wrong
    if (!entry) return oauthError(res, 400, 'invalid_grant', 'Unknown or used code.');
    if (f.get('client_id') !== entry.clientId) return oauthError(res, 400, 'invalid_grant', 'client_id mismatch.');
    if (f.get('redirect_uri') !== entry.redirectUri) return oauthError(res, 400, 'invalid_grant', 'redirect_uri mismatch.');
    if (createHash('sha256').update(verifier).digest('base64url') !== entry.challenge) {
      return oauthError(res, 400, 'invalid_grant', 'PKCE verification failed.');
    }
    issuePair(res, entry.clientId);
  }

  function revoke(res, raw) {
    const f = new URLSearchParams(raw);
    const t = f.get('token') ?? '';
    revokedLog.push({ token: t, tokenTypeHint: f.get('token_type_hint'), clientId: f.get('client_id') });
    accessTokens.delete(t);
    refreshTokens.delete(t);
    send(res, 200, {}); // RFC 7009: 200 whether or not the token existed
  }

  // ── The workspace ────────────────────────────────────────────────────────────────────────────────────────────────

  const unshared = (db) => scenario === 'unshare-backlog' && db.key === 'backlog';
  const renamed = (db) => scenario === 'rename-stage' && db.key === 'backlog';
  const rename = (s) => s.replaceAll('"Stage"', '"Phase"');

  /** The database as the current scenario shows it: schema, replies and rows with the Stage column renamed if asked. */
  function view(db) {
    if (!renamed(db)) return { ...db, rows: clone(db.rows) };
    const r = (reply) => ({ ...clone(reply), text: rename(reply.text) });
    const schema = clone(db.schema);
    schema.Phase = { ...schema.Stage, name: 'Phase' };
    delete schema.Stage;
    const rows = db.rows.map(({ Stage, ...rest }) => ({ ...clone(rest), ...(Stage === undefined ? {} : { Phase: Stage }) }));
    return { ...db, schema, dbReply: r(db.dbReply), dsReply: r(db.dsReply), rows };
  }

  const visibleDatabases = () => fixtures.databases.filter((d) => !unshared(d)).map(view);
  const notFound = (id) => errorResult(`Could not find database with ID: ${id}`);
  const pageNotFound = (id) => errorResult(`Could not find page with ID: ${id}`);

  const mentionOr = (v) => {
    if (typeof v !== 'string' || !v.startsWith('[')) return v;
    try {
      const a = JSON.parse(v);
      if (!Array.isArray(a)) return v;
      return a.map((x) => (typeof x === 'string' && x.startsWith('user://') ? `<mention-user url="${x}"></mention-user>` : x));
    } catch { return v; }
  };

  /** A row page in the fixtures' page format (a Pricing page): properties JSON, a short fictional body. */
  function rowPage(db, row) {
    const titleKey = Object.keys(db.schema).find((k) => db.schema[k].type === 'title');
    const idKey = Object.keys(db.schema).find((k) => db.schema[k].type === 'auto_increment_id');
    const title = String(row[titleKey]);
    const props = {};
    for (const [k, v] of Object.entries(row)) {
      if (k === 'id') continue;
      props[k] = k === idKey ? `${db.ticketPrefix}-${v}` : mentionOr(v);
    }
    const sorted = Object.fromEntries(Object.entries(props).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
    const pageUrl = `https://app.notion.com/p/${row.id}`;
    const body = `## Context\nFictional task "${title}" from the ${db.title} test database.\n\n- [ ] first step\n- [ ] second step`;
    const text = `Here is the result of "fetch" for the Page with URL ${pageUrl} as of 2026-10-16T23:46:26.528Z:\n<page url="${pageUrl}">\n`
      + `<ancestor-path>\n<parent-data-source url="collection://${db.collectionId}" name="${db.title}"/>\n`
      + `<ancestor-2-database url="https://app.notion.com/p/${db.hex}" title="${db.title}"/>\n`
      + `<ancestor-3-page url="${fixtures.parent.url}" title="${fixtures.parent.title}"/>\n</ancestor-path>\n`
      + `<properties>\n${JSON.stringify(sorted)}\n</properties>\n<iconMetadata>null</iconMetadata>\n<content>\n${body}\n</content>\n</page>\n\n`
      + `<parent-data-source-schema url="collection://${db.collectionId}">\n…\n</parent-data-source-schema>`;
    return {
      metadata: { type: 'page' }, title, url: `${pageUrl}?pvs=204`, text, cover: null, icon: null,
      path: `${fixtures.parent.title} / ${db.title}`, verification: { state: 'unverified' }, page_last_edited_at: '2026-10-16T23:46:26.498Z'
    };
  }

  function parentPage() {
    const p = fixtures.parent;
    return {
      metadata: { type: 'page' }, title: p.title, url: `${p.url}?pvs=204`,
      text: `Here is the result of "fetch" for the Page with URL ${p.url} as of 2026-10-16T23:46:26.528Z:\n<page url="${p.url}">\n`
        + `<properties>\n{"title":"${p.title}"}\n</properties>\n<content>\nThe fictional engineering home page.\n</content>\n</page>`,
      cover: null, icon: null, path: '', verification: { state: 'unverified' }, page_last_edited_at: '2026-10-16T23:46:26.498Z'
    };
  }

  function fetchTool(a) {
    // Ids only (a database/page id or collection://<uuid>): Atelier never passes URLs, so the fake refuses them.
    const id = String(a.id ?? '');
    const coll = /^collection:\/\/([0-9a-f-]{36})$/i.exec(id);
    if (coll) {
      const db = fixtures.databases.find((d) => d.collectionId === coll[1].toLowerCase());
      if (!db || unshared(db)) return notFound(coll[1]);
      return textResult(view(db).dsReply);
    }
    const hex = id.replaceAll('-', '').toLowerCase();
    if (!/^[0-9a-f]{32}$/.test(hex)) return errorResult(`Invalid ID: ${id}`);
    const db = fixtures.databases.find((d) => d.hex === hex);
    if (db) return unshared(db) ? notFound(dashed(hex)) : textResult(view(db).dbReply);
    if (hex === hexOf(fixtures.pricing.url)) {
      const home = fixtures.databases.find((d) => d.key === 'backlog');
      if (unshared(home)) return pageNotFound(dashed(hex));
      return textResult(renamed(home) ? { ...clone(fixtures.pricing), text: rename(fixtures.pricing.text) } : fixtures.pricing);
    }
    if (hex === hexOf(fixtures.parent.url)) return textResult(parentPage());
    for (const d of fixtures.databases) {
      const row = view(d).rows.find((r) => r.id === hex);
      if (row) return unshared(d) ? pageNotFound(dashed(hex)) : textResult(rowPage(view(d), row));
    }
    return notFound(dashed(hex));
  }

  function searchTool(a) {
    const q = String(a.query ?? '').toLowerCase();
    const size = Number.isInteger(a.page_size) ? a.page_size : 10;
    const items = [];
    const seen = new Set();
    const add = (item) => { if (!seen.has(item.id)) { seen.add(item.id); items.push(item); } };
    const hidden = new Set(fixtures.databases.filter(unshared).flatMap((d) => [d.id, ...d.rows.map((r) => dashed(r.id))]));
    for (const item of fixtures.search.results) add(clone(item));
    for (const d of visibleDatabases()) {
      const titleKey = Object.keys(d.schema).find((k) => d.schema[k].type === 'title');
      for (const r of d.rows) {
        add({ id: dashed(r.id), title: String(r[titleKey]), url: `${r.url}?pvs=204`, type: 'page', highlight: '',
          timestamp: '2026-10-16T23:46:00.000Z', path: `${fixtures.parent.title} / ${d.title}`, verification: { state: 'unverified' } });
      }
    }
    const results = items.filter((i) => !hidden.has(i.id) && q && i.title.toLowerCase().includes(q)).slice(0, size);
    return textResult({ results, type: 'workspace_search' });
  }

  // ── Query ────────────────────────────────────────────────────────────────────────────────────────────────────────

  const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  const onlyKeys = (o, keys) => isObj(o) && Object.keys(o).every((k) => keys.includes(k)) && keys.every((k) => k in o);

  /** Validates one filter item against the four confirmed shapes; returns a message when it is anything else. */
  function filterProblem(f) {
    if (!onlyKeys(f, ['type', 'property', 'propertyType', 'operator', 'value']) || f.type !== 'property' || typeof f.property !== 'string') {
      return 'filter item is not a property filter';
    }
    const v = f.value;
    const exact = onlyKeys(v, ['type', 'value']) && v.type === 'exact' && typeof v.value === 'string' && v.value.length > 0;
    if (f.propertyType === 'person' && f.operator === 'person_contains' && onlyKeys(v, ['type', 'value']) && v.type === 'relative' && v.value === 'me') return null;
    if (f.propertyType === 'status' && f.operator === 'status_is_not' && onlyKeys(v, ['type', 'value']) && v.type === 'is_group' && v.value === 'complete') return null;
    if (f.propertyType === 'select' && f.operator === 'enum_is_not' && exact) return null;
    if (f.propertyType === 'title' && f.operator === 'string_contains' && exact) return null;
    return `unsupported filter ${JSON.stringify(f.propertyType)}/${JSON.stringify(f.operator)} with this value`;
  }

  /** The predicate of a validated filter item for a row, or undefined when the property is not in the schema (ignored). */
  function predicate(db, f) {
    const def = db.schema[f.property];
    if (!def) return undefined;
    if (def.type !== f.propertyType) return () => { throw new Error(`property ${f.property} is of type ${def.type}, not ${f.propertyType}`); };
    switch (f.operator) {
      case 'person_contains': return (r) => { try { return JSON.parse(r[f.property] ?? '[]').includes(`user://${me}`); } catch { return false; } };
      case 'status_is_not': {
        const complete = (def.groups?.complete ?? []).map((o) => o.name);
        return (r) => !complete.includes(r[f.property]);
      }
      case 'enum_is_not': return (r) => r[f.property] !== f.value.value;
      default: return (r) => String(r[f.property] ?? '').toLowerCase().includes(f.value.value.toLowerCase());
    }
  }

  function queryTool(a) {
    const d = a.data;
    if (!isObj(d) || d.mode !== 'rows') return invalid('data.mode must be "rows"');
    if (!Object.keys(d).every((k) => ['mode', 'data_source_url', 'filter', 'sort', 'limit'].includes(k))) return invalid('unknown key in data');
    const coll = /^collection:\/\/([0-9a-f-]{36})$/i.exec(String(d.data_source_url ?? ''));
    if (!coll) return invalid('data.data_source_url must be collection://<id>');
    let filters = [];
    if (d.filter !== undefined) {
      if (!onlyKeys(d.filter, ['type', 'operator', 'filters']) || d.filter.type !== 'group' || d.filter.operator !== 'and' || !Array.isArray(d.filter.filters)) {
        return invalid('data.filter must be a group with operator "and"');
      }
      for (const f of d.filter.filters) {
        const problem = filterProblem(f);
        if (problem) return invalid(problem);
      }
      filters = d.filter.filters;
    }
    if (d.sort !== undefined && !(Array.isArray(d.sort) && d.sort.length <= 1
      && d.sort.every((s) => onlyKeys(s, ['property', 'direction']) && typeof s.property === 'string' && s.direction === 'ascending'))) {
      return invalid('data.sort must be at most one ascending sort');
    }
    if (d.limit !== undefined && !(Number.isInteger(d.limit) && d.limit >= 1 && d.limit <= 100)) return invalid('data.limit must be an integer from 1 to 100');
    const found = fixtures.databases.find((x) => x.collectionId === coll[1].toLowerCase());
    if (!found || unshared(found)) return notFound(coll[1]);
    const db = view(found);
    let rows = db.rows;
    try {
      for (const p of filters.map((f) => predicate(db, f)).filter(Boolean)) rows = rows.filter(p);
    } catch (e) { return invalid(e.message); }
    const sort = d.sort?.[0];
    if (sort && db.schema[sort.property]) {
      // A date sorts by its start; any other property by its string value. Rows without a value come last.
      const key = db.schema[sort.property].type === 'date' ? `date:${sort.property}:start` : sort.property;
      rows = rows.map((r, i) => ({ r, i })).sort((x, y) => {
        const a1 = x.r[key], b1 = y.r[key];
        if (a1 === undefined || b1 === undefined) return a1 === b1 ? x.i - y.i : a1 === undefined ? 1 : -1;
        return a1 < b1 ? -1 : a1 > b1 ? 1 : x.i - y.i;
      }).map((x) => x.r);
    }
    const limit = d.limit ?? 100;
    const results = rows.slice(0, limit).map(({ id, ...row }) => row);
    return textResult({ results, has_more: rows.length > limit });
  }

  function callTool(name, args) {
    const a = isObj(args) ? args : {};
    if (WRITE_TOOLS.includes(name)) return textResult({ fake: true, warning: 'write tool executed on the fake Notion', name });
    switch (name) {
      case 'notion-get-self': return textResult(fixtures.self);
      case 'notion-search': return searchTool(a);
      case 'notion-fetch': return fetchTool(a);
      case 'notion-query-data-sources': return queryTool(a);
      default: return undefined;
    }
  }

  // ── MCP ──────────────────────────────────────────────────────────────────────────────────────────────────────────

  /** The JSON-RPC result or error for one request. */
  function dispatch(msg) {
    const p = isObj(msg.params) ? msg.params : {};
    switch (msg.method) {
      case 'initialize':
        return { result: { protocolVersion: PROTOCOL_VERSION, capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'fake-notion', version: '0.0.0' } } };
      case 'ping': return { result: {} };
      case 'tools/list': return { result: { tools: TOOLS } };
      case 'tools/call': {
        const r = typeof p.name === 'string' ? callTool(p.name, p.arguments) : undefined;
        if (!r) return { error: { code: -32602, message: `Unknown tool: ${String(p.name)}` } };
        return r.error ? { error: r.error } : { result: r };
      }
      default: return { error: { code: -32601, message: `Method not found: ${String(msg.method)}` } };
    }
  }

  function reply(res, msg, out) {
    const body = JSON.stringify({ jsonrpc: '2.0', id: msg.id, ...out });
    if (sse) {
      const text = `event: message\ndata: ${body}\n\n`;
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'content-length': Buffer.byteLength(text) });
      res.end(text);
    } else {
      send(res, 200, body, { 'content-type': 'application/json' });
    }
  }

  function mcp(req, res, raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch { return send(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); }
    // Logged before any check: a write call is a bug even when it would have been refused. A JSON-RPC batch is
    // refused below (400) but every element's tools/call is still logged, so a write in a batch can't escape the log.
    for (const m of Array.isArray(msg) ? msg : [msg]) {
      if (m && typeof m === 'object' && m.method === 'tools/call') logCall(m.params?.name, m.params?.arguments);
    }
    const auth = req.headers.authorization ?? '';
    const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    const entry = accessTokens.get(bearer);
    if (!entry || entry.expiresAt <= Date.now() || scenario === 'mcp-401') {
      return send(res, 401, { error: 'invalid_token' }, {
        'www-authenticate': `Bearer error="invalid_token", resource_metadata="${url}/.well-known/oauth-protected-resource"`
      });
    }
    const accept = req.headers.accept ?? '';
    if (!accept.includes('application/json') || !accept.includes('text/event-stream')) {
      return send(res, 406, { error: 'Accept must include application/json and text/event-stream.' });
    }
    const version = req.headers['mcp-protocol-version'];
    if (version !== undefined && version !== PROTOCOL_VERSION) return send(res, 400, { error: `Unsupported MCP-Protocol-Version ${version}` });
    if (scenario === 'mcp-500') return send(res, 500, { error: 'internal error' });
    if (!msg || typeof msg !== 'object' || Array.isArray(msg) || msg.jsonrpc !== '2.0') {
      return send(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } });
    }
    if (msg.id === undefined || msg.method === undefined) return send(res, 202); // notification or client response
    reply(res, msg, dispatch(msg));
  }

  async function control(req, res, path, raw) {
    const json = () => { try { return JSON.parse(raw); } catch { return undefined; } };
    if (path === '/__scenario' && req.method === 'POST') {
      const body = json();
      if (!body) return send(res, 400, { error: 'Body is not JSON.' });
      try { setScenario(body.name, body.opts); } catch (e) { return send(res, 400, { error: e.message }); }
      if (typeof body.sse === 'boolean') sse = body.sse;
      return send(res, 200, { ok: true, scenario, sse });
    }
    if (path === '/__expire' && req.method === 'POST') { accessTokens.clear(); return send(res, 200, { ok: true }); }
    if (path === '/__revoke-refresh' && req.method === 'POST') { refreshTokens.clear(); return send(res, 200, { ok: true }); }
    if (path === '/__expires-in' && req.method === 'POST') {
      const s = json()?.seconds;
      if (!Number.isFinite(s) || s <= 0) return send(res, 400, { error: 'seconds must be a positive number' });
      expiresIn = s;
      return send(res, 200, { ok: true });
    }
    if (path === '/__calls' && req.method === 'GET') return send(res, 200, { calls: callLog.map((c) => c.name), details: callLog });
    if (path === '/__revoked' && req.method === 'GET') return send(res, 200, { revoked: revokedLog });
    send(res, 404, { error: 'not_found' });
  }

  const server = createServer(async (req, res) => {
    try {
      const u = new URL(req.url ?? '/', url || 'http://127.0.0.1');
      const path = u.pathname;
      const raw = req.method === 'POST' ? await readBody(req) : '';
      if (path.startsWith('/__')) return await control(req, res, path, raw);
      if (path === '/.well-known/oauth-authorization-server' && req.method === 'GET') return send(res, 200, metadata());
      if ((path === '/.well-known/oauth-protected-resource' || path === '/.well-known/oauth-protected-resource/mcp') && req.method === 'GET') {
        return send(res, 200, { resource: `${url}/mcp`, authorization_servers: [url], bearer_methods_supported: ['header'] });
      }
      if (path === '/register' && req.method === 'POST') return register(res, raw);
      if (path === '/authorize' && req.method === 'GET') return authorize(res, u.searchParams);
      if (path === '/token' && req.method === 'POST') return token(req, res, raw);
      if (path === '/token/revoke' && req.method === 'POST') return revoke(res, raw);
      if (path === '/mcp') {
        if (req.method !== 'POST') return send(res, 405, { error: 'method_not_allowed' }, { allow: 'POST' });
        return mcp(req, res, raw);
      }
      send(res, 404, { error: 'not_found' });
    } catch (e) {
      if (!res.headersSent && !res.destroyed) send(res, 500, { error: String(e?.message ?? e) });
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
  const port = /** @type {import('node:net').AddressInfo} */ (server.address()).port;
  url = `http://127.0.0.1:${port}`;

  let closing;
  return {
    url, port, issuer: url,
    fixtures: {
      userId: me,
      databases: fixtures.databases.map((d) => ({ key: d.key, id: d.id, collectionId: d.collectionId, title: d.title })),
      pricingPageId: dashed(hexOf(fixtures.pricing.url))
    },
    setScenario,
    scenario: () => scenario,
    setSse: (on) => { sse = Boolean(on); },
    calls: () => callLog.map((c) => c.name),
    callDetails: () => callLog.map((c) => ({ ...c })),
    revoked: () => revokedLog.map((r) => ({ ...r })),
    issueToken: () => issueToken(),
    expireAccessTokens: () => { accessTokens.clear(); },
    revokeRefresh: () => { refreshTokens.clear(); },
    setExpiresIn: (seconds) => {
      if (!Number.isFinite(seconds) || seconds <= 0) throw new Error('fake Notion: expires_in must be a positive number');
      expiresIn = seconds;
    },
    close: () => {
      closing ??= new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
      return closing;
    }
  };
}

// ── CLI ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

const isMain = (() => {
  try { return process.argv[1] !== undefined && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href; } catch { return false; }
})();
if (isMain) {
  const argv = process.argv.slice(2);
  const arg = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
  const fake = await startFakeNotion({ logFile: arg('--log'), scenario: arg('--scenario'), sse: argv.includes('--sse') });
  process.stdout.write(JSON.stringify({ url: fake.url }) + '\n');
  const stop = () => { void fake.close().then(() => process.exit(0)); };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}
