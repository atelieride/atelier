import { createHash } from 'node:crypto';
import { afterEach, describe, expect, test } from 'vitest';
import { startFakeNotion, WRITE_TOOLS, type FakeNotion, type FakeNotionScenario } from '../fixtures/fake-notion.mjs';

// The fake Notion (tests/fixtures/fake-notion.mjs) is test infrastructure the connector tests rely on: its OAuth
// (refresh, revocation), its filter semantics (unknown column ignored, like Notion) and its scenarios are pinned here.

let fake: FakeNotion | null = null;
afterEach(async () => { await fake?.close(); fake = null; });
const start = async (scenario: FakeNotionScenario = 'normal') => (fake = await startFakeNotion({ scenario }));

const REDIRECT = 'http://127.0.0.1:9/callback';
const form = (o: Record<string, string>) => ({ method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(o).toString() });

/** The whole OAuth dance; returns the token reply and the client id. */
async function login(f: FakeNotion) {
  const reg = await (await fetch(`${f.url}/register`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none', client_name: 'Test' }) })).json() as { client_id: string };
  const verifier = 'v'.repeat(50);
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const a = new URL(`${f.url}/authorize`);
  for (const [k, v] of Object.entries({ client_id: reg.client_id, redirect_uri: REDIRECT, response_type: 'code', state: 's1',
    code_challenge: challenge, code_challenge_method: 'S256', resource: `${f.url}/mcp` })) a.searchParams.set(k, v);
  const r = await fetch(a, { redirect: 'manual' });
  expect(r.status).toBe(302);
  const back = new URL(r.headers.get('location')!);
  expect(back.searchParams.get('state')).toBe('s1');
  expect(back.searchParams.get('iss')).toBe(f.url);
  const code = back.searchParams.get('code')!;
  const t = await fetch(`${f.url}/token`, form({ grant_type: 'authorization_code', code, code_verifier: verifier, client_id: reg.client_id, redirect_uri: REDIRECT, resource: `${f.url}/mcp` }));
  return { clientId: reg.client_id, status: t.status, body: await t.json() as Record<string, unknown>, code, verifier };
}

const refresh = (f: FakeNotion, clientId: string, token: string) => fetch(`${f.url}/token`, form({ grant_type: 'refresh_token', refresh_token: token, client_id: clientId }));

let rpcId = 0;
async function rpc(f: FakeNotion, token: string, method: string, params?: unknown) {
  return fetch(`${f.url}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }) });
}
/** tools/call → the parsed content text (or the raw error text when isError), plus the JSON-RPC envelope. */
async function call(f: FakeNotion, name: string, args: unknown = {}, token = f.issueToken()) {
  const res = await rpc(f, token, 'tools/call', { name, arguments: args });
  const body = await res.json() as { result?: { isError?: boolean; content: { text: string }[] }; error?: { code: number; message: string } };
  const text = body.result?.content[0]?.text;
  return { status: res.status, isError: body.result?.isError === true, text, data: text && !body.result?.isError ? JSON.parse(text) : undefined, error: body.error };
}

const query = (f: FakeNotion, db: 'sprint' | 'backlog', data: Record<string, unknown>) =>
  call(f, 'notion-query-data-sources', { data: { mode: 'rows', data_source_url: `collection://${f.fixtures.databases.find((d) => d.key === db)!.collectionId}`, ...data } });
const me = { type: 'property', property: 'Owner', propertyType: 'person', operator: 'person_contains', value: { type: 'relative', value: 'me' } };
const titles = (r: { data?: { results: Record<string, unknown>[] } }, key = 'Title') => r.data!.results.map((x) => x[key]);

describe('OAuth', () => {
  test('metadata advertises refresh_token, S256 only, none and the revocation endpoint', async () => {
    const f = await start();
    const m = await (await fetch(`${f.url}/.well-known/oauth-authorization-server`)).json() as Record<string, unknown>;
    expect(m).toMatchObject({ issuer: f.url, authorization_endpoint: `${f.url}/authorize`, token_endpoint: `${f.url}/token`,
      registration_endpoint: `${f.url}/register`, revocation_endpoint: `${f.url}/token/revoke`,
      code_challenge_methods_supported: ['S256'], authorization_response_iss_parameter_supported: true });
    expect(m.grant_types_supported).toEqual(['authorization_code', 'refresh_token']);
    expect(m.token_endpoint_auth_methods_supported).toContain('none');
  });

  test('round trip: code → tokens → MCP call → refresh rotates → old refresh token is invalid_grant', async () => {
    const f = await start();
    const t = await login(f);
    expect(t.status).toBe(200);
    expect(t.body).toMatchObject({ token_type: 'Bearer', expires_in: 3600 });
    const access = t.body.access_token as string;
    expect((await call(f, 'notion-get-self', {}, access)).data.user.name).toBe('Ada Lovelace');
    const r1 = await refresh(f, t.clientId, t.body.refresh_token as string);
    expect(r1.status).toBe(200);
    const b1 = await r1.json() as { access_token: string; refresh_token: string };
    expect(b1.refresh_token).not.toBe(t.body.refresh_token);
    expect((await call(f, 'notion-get-self', {}, b1.access_token)).status).toBe(200);
    const again = await refresh(f, t.clientId, t.body.refresh_token as string);
    expect(again.status).toBe(400);
    expect(await again.json()).toMatchObject({ error: 'invalid_grant' });
  });

  test('a wrong PKCE verifier fails and the code is one-shot', async () => {
    const f = await start();
    const t = await login(f);
    const reuse = await fetch(`${f.url}/token`, form({ grant_type: 'authorization_code', code: t.code, code_verifier: t.verifier, client_id: t.clientId, redirect_uri: REDIRECT }));
    expect(reuse.status).toBe(400);
  });

  test('setExpiresIn changes expires_in and the access token really expires', async () => {
    const f = await start();
    f.setExpiresIn(1);
    const t = await login(f);
    expect(t.body.expires_in).toBe(1);
    const access = t.body.access_token as string;
    expect((await call(f, 'notion-get-self', {}, access)).status).toBe(200);
    await new Promise((r) => setTimeout(r, 1100));
    expect((await call(f, 'notion-get-self', {}, access)).status).toBe(401);
  });

  test('expireAccessTokens: next MCP call is 401 but the refresh token still works', async () => {
    const f = await start();
    const t = await login(f);
    f.expireAccessTokens();
    expect((await call(f, 'notion-get-self', {}, t.body.access_token as string)).status).toBe(401);
    const r = await refresh(f, t.clientId, t.body.refresh_token as string);
    expect(r.status).toBe(200);
    expect((await call(f, 'notion-get-self', {}, ((await r.json()) as { access_token: string }).access_token)).status).toBe(200);
  });

  test('revokeRefresh: the next refresh is invalid_grant', async () => {
    const f = await start();
    const t = await login(f);
    f.revokeRefresh();
    const r = await refresh(f, t.clientId, t.body.refresh_token as string);
    expect(r.status).toBe(400);
    expect(await r.json()).toMatchObject({ error: 'invalid_grant' });
  });

  test('the revocation endpoint logs and kills the token; unknown tokens still answer 200', async () => {
    const f = await start();
    const t = await login(f);
    const access = t.body.access_token as string;
    const res = await fetch(`${f.url}/token/revoke`, form({ token: access, token_type_hint: 'access_token', client_id: t.clientId }));
    expect(res.status).toBe(200);
    expect((await fetch(`${f.url}/token/revoke`, form({ token: 'nope' }))).status).toBe(200);
    expect(f.revoked()).toEqual([
      { token: access, tokenTypeHint: 'access_token', clientId: t.clientId },
      { token: 'nope', tokenTypeHint: null, clientId: null }
    ]);
    expect((await call(f, 'notion-get-self', {}, access)).status).toBe(401);
    // Revoking the refresh token ends the session for good.
    await fetch(`${f.url}/token/revoke`, form({ token: t.body.refresh_token as string }));
    expect((await refresh(f, t.clientId, t.body.refresh_token as string)).status).toBe(400);
  });
});

describe('MCP', () => {
  test('a call without a valid token is 401', async () => {
    const f = await start();
    expect((await call(f, 'notion-get-self', {}, 'bogus')).status).toBe(401);
  });

  test('notion-get-self and notion-search (title contains, case-insensitive)', async () => {
    const f = await start();
    expect((await call(f, 'notion-get-self')).data).toMatchObject({ workspace: { name: 'Acme' }, user: { id: f.fixtures.userId } });
    const s = await call(f, 'notion-search', { query: 'BACKLOG', page_size: 10, max_highlight_length: 0 });
    expect(s.data.type).toBe('workspace_search');
    expect(s.data.results.map((r: { title: string; type: string }) => [r.title, r.type])).toEqual([['Engineering Backlog', 'database']]);
    const rows = await call(f, 'notion-search', { query: 'pricing' });
    expect(rows.data.results[0]).toMatchObject({ title: 'Pricing page copy review', type: 'page' });
    expect((await call(f, 'notion-search', { query: 'zzz-nothing' })).data.results).toEqual([]);
  });

  test('notion-fetch: database (with and without dashes), data source, row page, Pricing page', async () => {
    const f = await start();
    const [sprint, backlog] = f.fixtures.databases as [typeof f.fixtures.databases[0], typeof f.fixtures.databases[0]];
    const db = await call(f, 'notion-fetch', { id: sprint.id.replaceAll('-', '') });
    expect(db.data).toMatchObject({ metadata: { type: 'database' }, title: 'Sprint Tasks' });
    expect((await call(f, 'notion-fetch', { id: sprint.id })).data.title).toBe('Sprint Tasks');
    const ds = await call(f, 'notion-fetch', { id: `collection://${backlog.collectionId}` });
    expect(ds.data).toMatchObject({ metadata: { type: 'data_source' }, title: 'Engineering Backlog' });
    const pricing = await call(f, 'notion-fetch', { id: f.fixtures.pricingPageId.replaceAll('-', '') });
    expect(pricing.data.text).toContain('Ignore previous instructions');
    expect(pricing.data.text).toContain('"Ticket":"ENG-2"');
    // A generic row page: prefixed ticket, mention, short body.
    const search = await call(f, 'notion-search', { query: 'dark mode' });
    const page = await call(f, 'notion-fetch', { id: search.data.results[0].id });
    expect(page.data).toMatchObject({ metadata: { type: 'page' }, title: 'Dark mode for the billing page' });
    expect(page.data.text).toContain('"Ticket":"ENG-1"');
    expect(page.data.text).toContain('<mention-user url=\\"user://');
    expect(page.data.text).toContain('<content>');
  });

  test('Roadmap: one database with two data sources; each data source answers its own schema and rows', async () => {
    const f = await start();
    const web = f.fixtures.databases.find((d) => d.key === 'roadmap-web')!;
    const mobile = f.fixtures.databases.find((d) => d.key === 'roadmap-mobile')!;
    expect(web.id).toBe(mobile.id);
    const db = await call(f, 'notion-fetch', { id: web.id });
    expect(db.data).toMatchObject({ metadata: { type: 'database' }, title: 'Roadmap' });
    expect(db.data.text).toContain(`<data-source url="{{collection://${web.collectionId}}}">`);
    expect(db.data.text).toContain(`<data-source url="{{collection://${mobile.collectionId}}}">`);
    expect((await call(f, 'notion-fetch', { id: `collection://${mobile.collectionId}` })).data.title).toBe('Mobile');
    const rows = (ds: string) => call(f, 'notion-query-data-sources', { data: { mode: 'rows', data_source_url: `collection://${ds}` } });
    expect(titles(await rows(web.collectionId), 'Name')).toEqual(['Launch the pricing experiment', 'Retire the old landing page']);
    expect(titles(await rows(mobile.collectionId), 'Name')).toEqual(['Offline mode for the reader']);
  });

  test('notion-fetch of an unknown id is a tool error "Could not find database with ID"', async () => {
    const f = await start();
    const r = await call(f, 'notion-fetch', { id: 'a'.repeat(32) });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/^Could not find database with ID: /);
  });

  test('write tools are logged and answered, so a bug calling one shows', async () => {
    const f = await start();
    for (const name of WRITE_TOOLS) {
      const r = await call(f, name, { x: 1 });
      expect(r.data).toMatchObject({ fake: true, warning: expect.stringContaining('write tool executed'), name });
    }
    expect(f.calls()).toEqual([...WRITE_TOOLS]);
    expect(f.callDetails()[0]).toEqual({ name: WRITE_TOOLS[0], arguments: { x: 1 } });
  });

  test('every tools/call is logged before the auth check, and an unknown tool is a JSON-RPC error', async () => {
    const f = await start();
    await call(f, 'notion-create-pages', {}, 'bogus');
    expect(f.calls()).toEqual(['notion-create-pages']);
    expect((await call(f, 'nope')).error?.code).toBe(-32602);
  });

  test('tools/list names the four read tools and the write tools', async () => {
    const f = await start();
    const body = await (await rpc(f, f.issueToken(), 'tools/list')).json() as { result: { tools: { name: string }[] } };
    const names = body.result.tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(['notion-get-self', 'notion-search', 'notion-fetch', 'notion-query-data-sources', ...WRITE_TOOLS]));
  });
});

describe('notion-query-data-sources rows', () => {
  test('no filter: the whole table; limit and has_more', async () => {
    const f = await start();
    expect(titles(await query(f, 'sprint', {}), 'Task name')).toHaveLength(4);
    const limited = await query(f, 'backlog', { limit: 2 });
    expect(limited.data.results).toHaveLength(2);
    expect(limited.data.has_more).toBe(true);
    expect(limited.data.results[0]).not.toHaveProperty('id');
  });

  test('person_contains me', async () => {
    const f = await start();
    const r = await query(f, 'sprint', { filter: { type: 'group', operator: 'and', filters: [{ ...me, property: 'Assignee' }] } });
    expect(titles(r, 'Task name')).toEqual(['Fix flaky login test on CI', 'Add rate limiting to the export endpoint', 'Migrate settings to the new schema']);
  });

  test('status_is_not is_group complete uses the status groups (Done and Archived)', async () => {
    const f = await start();
    const r = await query(f, 'sprint', { filter: { type: 'group', operator: 'and', filters: [
      { type: 'property', property: 'Status', propertyType: 'status', operator: 'status_is_not', value: { type: 'is_group', value: 'complete' } }] } });
    expect(titles(r, 'Task name')).toEqual(['Fix flaky login test on CI', 'Add rate limiting to the export endpoint', 'Write onboarding checklist']);
  });

  test('mine + not Shipped + sorted by deadline: the real reply\'s order (empty dates last)', async () => {
    const f = await start();
    const r = await query(f, 'backlog', {
      filter: { type: 'group', operator: 'and', filters: [me, { type: 'property', property: 'Stage', propertyType: 'select', operator: 'enum_is_not', value: { type: 'exact', value: 'Shipped' } }] },
      sort: [{ property: 'Deadline', direction: 'ascending' }], limit: 100 });
    expect(titles(r)).toEqual(['Dark mode for the billing page', 'Pricing page copy review']);
    expect(r.data.has_more).toBe(false);
  });

  test('sort ascending puts the dated rows first and keeps the others in order', async () => {
    const f = await start();
    const r = await query(f, 'sprint', { sort: [{ property: 'Due', direction: 'ascending' }] });
    expect(titles(r, 'Task name')).toEqual(['Migrate settings to the new schema', 'Add rate limiting to the export endpoint', 'Fix flaky login test on CI', 'Write onboarding checklist']);
  });

  test('title string_contains is case-insensitive', async () => {
    const f = await start();
    const r = await query(f, 'backlog', { filter: { type: 'group', operator: 'and', filters: [
      { type: 'property', property: 'Title', propertyType: 'title', operator: 'string_contains', value: { type: 'exact', value: 'PRICING' } }] } });
    expect(titles(r)).toEqual(['Pricing page copy review']);
  });

  test('a filter on an unknown property is IGNORED (every row comes back), like Notion', async () => {
    const f = await start();
    const r = await query(f, 'backlog', { filter: { type: 'group', operator: 'and', filters: [
      { type: 'property', property: 'Nope', propertyType: 'select', operator: 'enum_is_not', value: { type: 'exact', value: 'Shipped' } }] } });
    expect(titles(r)).toHaveLength(3);
  });

  test('anything else is a JSON-RPC error so a bug in Atelier shows up', async () => {
    const f = await start();
    const bad = [
      { filter: { type: 'group', operator: 'or', filters: [me] } },
      { filter: { type: 'group', operator: 'and', filters: [{ ...me, operator: 'person_does_not_contain' }] } },
      { filter: { type: 'group', operator: 'and', filters: [{ ...me, value: { type: 'exact', value: 'x' } }] } },
      { sort: [{ property: 'Deadline', direction: 'descending' }] },
      { limit: 0 }
    ];
    for (const extra of bad) expect((await query(f, 'backlog', extra)).error?.code).toBe(-32602);
    expect((await call(f, 'notion-query-data-sources', { data: { mode: 'sql' } })).error?.code).toBe(-32602);
  });
});

describe('scenarios', () => {
  test('setScenario rejects an unknown name', async () => {
    const f = await start();
    expect(() => f.setScenario('nope' as FakeNotionScenario)).toThrow(/unknown scenario/);
  });

  test('mcp-401 and mcp-500', async () => {
    const f = await start('mcp-401');
    expect((await call(f, 'notion-get-self')).status).toBe(401);
    f.setScenario('mcp-500');
    expect((await call(f, 'notion-get-self')).status).toBe(500);
    f.setScenario('normal');
    expect((await call(f, 'notion-get-self')).status).toBe(200);
  });

  test('unshare-backlog: fetch and query of the Backlog are tool errors "Could not find…", Sprint still works', async () => {
    const f = await start('unshare-backlog');
    const backlog = f.fixtures.databases.find((d) => d.key === 'backlog')!;
    for (const r of [
      await call(f, 'notion-fetch', { id: backlog.id.replaceAll('-', '') }),
      await call(f, 'notion-fetch', { id: `collection://${backlog.collectionId}` }),
      await call(f, 'notion-fetch', { id: f.fixtures.pricingPageId }),
      await query(f, 'backlog', {})
    ]) {
      expect(r.isError).toBe(true);
      expect(r.text).toMatch(/^Could not find/);
    }
    expect((await call(f, 'notion-search', { query: 'Backlog' })).data.results).toEqual([]);
    expect(titles(await query(f, 'sprint', {}), 'Task name')).toHaveLength(4);
  });

  test('rename-stage: "Stage" becomes "Phase" in the schema and the rows, and a filter on Stage is ignored', async () => {
    const f = await start('rename-stage');
    const backlog = f.fixtures.databases.find((d) => d.key === 'backlog')!;
    const ds = await call(f, 'notion-fetch', { id: `collection://${backlog.collectionId}` });
    expect(ds.data.text).toContain('"Phase"');
    expect(ds.data.text).not.toContain('"Stage"');
    const db = await call(f, 'notion-fetch', { id: backlog.id });
    expect(db.data.text).not.toContain('"Stage"');
    const all = await query(f, 'backlog', { filter: { type: 'group', operator: 'and', filters: [
      { type: 'property', property: 'Stage', propertyType: 'select', operator: 'enum_is_not', value: { type: 'exact', value: 'Shipped' } }] } });
    expect(titles(all)).toHaveLength(3); // Shipped is back: the filter hit a missing column
    expect(all.data.results[0]).toHaveProperty('Phase', 'Doing');
    expect(all.data.results[0]).not.toHaveProperty('Stage');
    const filtered = await query(f, 'backlog', { filter: { type: 'group', operator: 'and', filters: [
      { type: 'property', property: 'Phase', propertyType: 'select', operator: 'enum_is_not', value: { type: 'exact', value: 'Shipped' } }] } });
    expect(titles(filtered)).toHaveLength(2);
    expect((await call(f, 'notion-fetch', { id: f.fixtures.pricingPageId })).data.text).toContain('"Phase":"Review"');
  });
});

describe('review polish', () => {
  test('a JSON-RPC batch is refused but its tools/call names are logged', async () => {
    const f = await start();
    const res = await fetch(`${f.url}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${f.issueToken()}` },
      body: JSON.stringify([{ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'notion-update-page', arguments: {} } }, { jsonrpc: '2.0', id: 2, method: 'ping' }]) });
    expect(res.status).toBe(400);
    expect(f.calls()).toEqual(['notion-update-page']);
  });

  test('page ids say "page", database ids say "database"; fetch refuses URLs', async () => {
    const f = await start('unshare-backlog');
    expect((await call(f, 'notion-fetch', { id: f.fixtures.pricingPageId })).text).toMatch(/^Could not find page with ID/);
    expect((await call(f, 'notion-fetch', { id: f.fixtures.databases[1]!.id })).text).toMatch(/^Could not find database with ID/);
    expect((await call(f, 'notion-fetch', { id: 'https://app.notion.com/p/' + 'a'.repeat(32) })).isError).toBe(true);
  });

  test('a sort on a known non-date property sorts by its string value, empties last', async () => {
    const f = await start();
    const r = await query(f, 'sprint', { sort: [{ property: 'Task name', direction: 'ascending' }] });
    expect(titles(r, 'Task name')).toEqual(['Add rate limiting to the export endpoint', 'Fix flaky login test on CI', 'Migrate settings to the new schema', 'Write onboarding checklist']);
  });
});

describe('OAuth negatives', () => {
  const authorizeUrl = (f: FakeNotion, clientId: string, o: Record<string, string | null> = {}) => {
    const p: Record<string, string | null> = { client_id: clientId, redirect_uri: REDIRECT, response_type: 'code', state: 's', code_challenge: 'c', code_challenge_method: 'S256', ...o };
    const u = new URL(`${f.url}/authorize`);
    for (const [k, v] of Object.entries(p)) if (v !== null) u.searchParams.set(k, v);
    return u;
  };
  const register = async (f: FakeNotion) => ((await (await fetch(`${f.url}/register`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none' }) })).json()) as { client_id: string }).client_id;

  test('authorize: an unregistered redirect_uri or client is a 400 page, never a redirect', async () => {
    const f = await start();
    const id = await register(f);
    expect((await fetch(authorizeUrl(f, id, { redirect_uri: 'http://127.0.0.1:9/other' }), { redirect: 'manual' })).status).toBe(400);
    expect((await fetch(authorizeUrl(f, 'nobody'), { redirect: 'manual' })).status).toBe(400);
  });

  test('authorize: missing state or code_challenge redirects with an error', async () => {
    const f = await start();
    const id = await register(f);
    for (const o of [{ state: null }, { code_challenge: null }] as Record<string, null>[]) {
      const r = await fetch(authorizeUrl(f, id, o), { redirect: 'manual' });
      expect(r.status).toBe(302);
      const to = new URL(r.headers.get('location')!);
      expect(to.searchParams.get('error')).toBe('invalid_request');
      expect(to.searchParams.has('code')).toBe(false);
    }
  });

  test('token: redirect_uri and client_id mismatches are invalid_grant, and a code cannot be reused', async () => {
    const f = await start();
    const code = async () => {
      const t = await login(f);
      return t;
    };
    const t = await code();
    // A fresh code per attempt: the first (even wrong) exchange consumes it.
    const fresh = async () => {
      const id = await register(f);
      const r = await fetch(authorizeUrl(f, id, { code_challenge: createHash('sha256').update('v').digest('base64url') }), { redirect: 'manual' });
      return { id, code: new URL(r.headers.get('location')!).searchParams.get('code')! };
    };
    const a = await fresh();
    const badRedirect = await fetch(`${f.url}/token`, form({ grant_type: 'authorization_code', code: a.code, code_verifier: 'v', client_id: a.id, redirect_uri: 'http://127.0.0.1:9/other' }));
    expect(badRedirect.status).toBe(400);
    expect(await badRedirect.json()).toMatchObject({ error: 'invalid_grant' });
    const b = await fresh();
    const badClient = await fetch(`${f.url}/token`, form({ grant_type: 'authorization_code', code: b.code, code_verifier: 'v', client_id: t.clientId, redirect_uri: REDIRECT }));
    expect(await badClient.json()).toMatchObject({ error: 'invalid_grant' });
    const c = await fresh();
    const body = form({ grant_type: 'authorization_code', code: c.code, code_verifier: 'v', client_id: c.id, redirect_uri: REDIRECT });
    expect((await fetch(`${f.url}/token`, body)).status).toBe(200);
    expect((await fetch(`${f.url}/token`, body)).status).toBe(400);
  });
});

describe('close', () => {
  test('close is idempotent and frees the port', async () => {
    const f = await start();
    const url = f.url;
    await f.close();
    await f.close();
    await expect(fetch(`${url}/mcp`, { method: 'POST' })).rejects.toThrow();
    fake = null;
  });
});
