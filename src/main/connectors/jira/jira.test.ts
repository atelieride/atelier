import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { startFakeJira, type FakeJira, type FakeJiraScenario } from '../../../../tests/fixtures/fake-jira.mjs';
import { fetchTransport } from '../../../../tests/support/fetch-transport';
import { manualClock, type ManualClock } from '../../../../tests/support/manual-clock';
import type { Transport } from '../http';
import { followAuthorize } from '../oauth/follow-auth';
import { createSecretStore, type SecretStore } from '../secret-store';
import { STALE_MS } from '../task-connector';
import { testSafeStorage } from '../test-safe-storage';
import { jiraEndpoint } from './config';
import { JiraConnector, type JiraDeps } from './jira';
import { ALLOWED_TOOLS } from './tools';

// The Jira connector against the local fake Jira (real HTTP on two 127.0.0.1 origins:
// the protected resource + MCP, and the authorization server with a path issuer), with a manual clock. Never the real
// Atlassian.

const ATL = '10001';
const WEB = '10002';
const SUP = '10003';
const MKT = '10004';
const API = { email: 'ada@example.com', token: 'ATATT3xFfGF0-fake-api-token-0123456789' };

let fakes: FakeJira[] = [];
let connectors: JiraConnector[] = [];
const logged: string[] = [];
const secrets = new Set<string>();
afterEach(async () => {
  for (const c of connectors.splice(0)) c.dispose();
  // Whatever a test did, the fake never saw a tool outside the read-only allowlist (no write, no discover/execute)…
  for (const f of fakes) expect(f.calls().filter((n) => !ALLOWED_TOOLS.has(n))).toEqual([]);
  // …and no log line carries a token.
  for (const s of secrets) for (const line of logged) expect(line).not.toContain(s);
  secrets.clear();
  logged.length = 0;
  await Promise.all(fakes.splice(0).map((f) => f.close()));
});

function sniffing(t: Transport): Transport {
  return async (req, signal) => {
    const a = req.headers?.authorization;
    if (a) secrets.add(a.replace(/^(Bearer|Basic) /, ''));
    if (req.body && /refresh_token=/.test(req.body)) { const r = new URLSearchParams(req.body).get('refresh_token'); if (r) secrets.add(r); }
    return t(req, signal);
  };
}

interface Setup {
  scenario?: FakeJiraScenario; clock?: ManualClock; apiTokens?: { email: string; token: string }[];
  /** Another connector class (a server that misbehaves, for instance). */
  make?: (deps: JiraDeps) => JiraConnector;
}

/** Searches wait for `gate.wait` while it is set (a refresh in flight while the user edits the details). */
class GatedServer extends JiraConnector {
  constructor(deps: JiraDeps, private readonly gate: { wait: Promise<void> | null }) { super(deps); }
  protected override makeClient(token: string, basicUser?: string) {
    const c = super.makeClient(token, basicUser);
    return {
      listTools: c.listTools.bind(c),
      callTool: (async (name, args, o) => {
        if (name === 'searchJiraIssuesUsingJql' && this.gate.wait) await this.gate.wait;
        return c.callTool(name, args, o);
      }) as typeof c.callTool
    };
  }
}

/** A server whose searches also return an issue of a project nobody chose (MKT-1): Atelier must drop it. */
class LeakyServer extends JiraConnector {
  protected override makeClient(token: string, basicUser?: string) {
    const c = super.makeClient(token, basicUser);
    return {
      listTools: c.listTools.bind(c),
      callTool: (async (name, args, o) => {
        const r = await c.callTool(name, args, o);
        if (name !== 'searchJiraIssuesUsingJql') return r;
        const foreign = { id: '10401', key: 'MKT-1', fields: { summary: 'Leaked', project: { id: MKT, key: 'MKT', name: 'Marketing' } } };
        return { ...r, issues: [...(r as { issues: unknown[] }).issues, foreign] };
      }) as typeof c.callTool
    };
  }
}

async function setup(o: Setup = {}) {
  const fake = await startFakeJira({ scenario: o.scenario ?? 'normal', ...(o.apiTokens ? { apiTokens: o.apiTokens } : {}) });
  fakes.push(fake);
  const home = mkdtempSync(join(tmpdir(), 'atl-jira-'));
  const store = createSecretStore(home, testSafeStorage({ available: true }));
  const clock = o.clock ?? manualClock();
  const endpoint = jiraEndpoint(fake.url, fake.authUrl);
  const requests: string[] = [];
  const transport = sniffing(fetchTransport((u) => requests.push(u)));
  const logs: string[] = [];
  const notices: string[] = [];
  const deps: JiraDeps = {
    store, endpoint, transport, openAuthPage: followAuthorize(transport, endpoint.allow), clock, focused: () => true,
    log: (m) => { logs.push(m); logged.push(m); }, onChange: () => undefined, onNotice: (n) => { notices.push(n.kind); }
  };
  const c = o.make ? o.make(deps) : new JiraConnector(deps);
  connectors.push(c);
  c.init();
  return { fake, store, clock, c, logs, notices, requests };
}
type S = Awaited<ReturnType<typeof setup>>;

const blobOf = (s: S) => { const raw = s.store.read('jira'); return raw === null ? null : JSON.parse(raw) as Record<string, unknown>; };
const keys = (s: S) => s.c.taskList().tasks.map((t) => t.displayId).sort();
const searches = (s: S) => s.fake.callDetails().filter((c) => c.name === 'searchJiraIssuesUsingJql');

async function connected(o: Setup = {}) {
  const s = await setup(o);
  s.c.connect(1);
  await s.c.idle();
  expect(s.c.info().status).toBe('connected');
  return s;
}

async function withProjects(ids: string[], o: Setup = {}) {
  const s = await connected(o);
  await s.c.searchSources('');
  for (const id of ids) expect(await s.c.addSource(id)).toEqual({ ok: true, sourceIds: [id] });
  await s.c.idle();
  return s;
}

describe('sign-in (CIMD, protected-resource discovery)', () => {
  test('no registration, no scope; the site and account are named; nothing listed until a project is chosen', async () => {
    const s = await connected();
    expect(s.fake.registrations()).toEqual([]);
    const auth = s.fake.authorizeRequests();
    expect(auth).toHaveLength(1);
    expect(auth[0]!.outcome).toBe('code');
    expect(auth[0]!.query.client_id).toBe('https://useatelier.dev/oauth/client.json');
    expect(auth[0]!.query.scope).toBeUndefined();
    expect(new URL(auth[0]!.query.redirect_uri!).pathname).toBe('/callback');
    expect(s.c.info()).toMatchObject({ status: 'connected', account: 'Ada Lovelace', workspace: 'acme.atlassian.net', projects: [], attention: 0 });
    expect(blobOf(s)).toMatchObject({ site: 'https://acme.atlassian.net', workspace: { id: s.fake.data.cloudId, name: 'acme.atlassian.net' }, projects: [] });
    expect(blobOf(s)!.clientId).toBe('https://useatelier.dev/oauth/client.json');
    expect(searches(s)).toEqual([]);
    // Every MCP call went to ?tools=all.
    expect(s.fake.callDetails().every((c) => c.exposure === 'all')).toBe(true);
    // Only the two origins were ever contacted.
    for (const u of s.requests) expect([s.fake.url, s.fake.authUrl]).toContain(new URL(u).origin);
  });

  test('no Jira site on the account → unavailable, nothing stored', async () => {
    const s = await setup({ scenario: 'no-jira-site' });
    s.c.connect();
    await s.c.idle();
    expect(s.c.info()).toMatchObject({ status: 'unavailable', reason: 'no-site' });
    expect(blobOf(s)).toBeNull();
  });

  test('two sites → the first, logged', async () => {
    const s = await connected({ scenario: 'two-sites' });
    expect(s.c.info().workspace).toBe('acme.atlassian.net');
    expect(s.logs.some((l) => /2 Jira sites/.test(l))).toBe(true);
  });

  test('no CIMD advertised → falls back to DCR', async () => {
    const s = await connected({ scenario: 'no-cimd' });
    expect(s.fake.registrations()).toHaveLength(1);
    expect(s.fake.registrations()[0]!.clientName).toBe('Atelier');
  });
});

describe('projects and the list', () => {
  test('the picker lists the browsable projects with keys and types; adding one lists my open issues in ONE search', async () => {
    const s = await connected();
    const picks = await s.c.searchSources('');
    expect(picks.map((p) => [p.key, p.kind, p.added])).toEqual([['ATL', 'software', false], ['WEB', 'software', false], ['SUP', 'service_desk', false], ['MKT', 'business', false]]);
    expect((await s.c.searchSources('sup')).map((p) => p.key)).toEqual(['SUP']);
    // A word that looks like a key is still a search by name too ("website" is WEB's name, "port" part of SUP's).
    expect((await s.c.searchSources('website')).map((p) => p.key)).toEqual(['WEB']);
    expect((await s.c.searchSources('Support')).map((p) => p.key)).toEqual(['SUP']);
    // A pasted issue key or link names its project alone.
    expect((await s.c.searchSources('ATL-3')).map((p) => p.key)).toEqual(['ATL']);
    expect((await s.c.searchSources('https://acme.atlassian.net/browse/SUP-1')).map((p) => p.key)).toEqual(['SUP']);
    expect(await s.c.addSource(ATL)).toEqual({ ok: true, sourceIds: [ATL] });
    await s.c.idle();
    expect(keys(s)).toEqual(['ATL-1', 'ATL-2', 'ATL-3', 'ATL-4', 'ATL-7', 'ATL-8', 'ATL-9']);
    expect(searches(s)).toHaveLength(1);
    expect(s.c.info().projects).toEqual([{ id: ATL, key: 'ATL', name: 'Atelier', type: 'software', everyone: false, count: 7, loading: false }]);
    expect((await s.c.searchSources('')).find((p) => p.key === 'ATL')!.added).toBe(true);
  });

  test('two projects are still one search per refresh; Everyone on one adds its unassigned issues', async () => {
    const s = await withProjects([ATL, WEB]);
    const before = searches(s).length;
    await s.clock.advance(STALE_MS);
    s.c.refresh();
    await s.c.idle();
    expect(searches(s).length - before).toBe(1);
    expect(keys(s)).not.toContain('WEB-2');
    await s.c.setSourceScope(WEB, true);
    await s.c.idle();
    expect(keys(s)).toEqual(expect.arrayContaining(['WEB-1', 'WEB-2']));
    expect(blobOf(s)!.projects).toEqual(expect.arrayContaining([expect.objectContaining({ id: WEB, everyone: true })]));
  });

  test('a pasted link or key adds its project; another site is refused; a page link is not a project', async () => {
    const s = await connected();
    expect(await s.c.addSource('https://acme.atlassian.net/browse/WEB-1')).toEqual({ ok: true, sourceIds: [WEB] });
    expect(await s.c.addSource('MKT')).toEqual({ ok: true, sourceIds: [MKT] });
    expect(await s.c.addSource('https://other.atlassian.net/browse/ATL-1')).toEqual({ ok: false, reason: 'other-site' });
    expect(await s.c.addSource('https://acme.atlassian.net/wiki/spaces/X')).toEqual({ ok: false, reason: 'not-database' });
    expect(await s.c.addSource('ZZZ')).toEqual({ ok: false, reason: 'not-found' });
  });

  test('removing a project drops its issues at once', async () => {
    const s = await withProjects([ATL, MKT]);
    expect(keys(s)).toContain('MKT-1');
    await s.c.removeSource(MKT);
    expect(keys(s)).not.toContain('MKT-1');
    expect(keys(s)).toContain('ATL-3');
  });

  test('include done issues', async () => {
    const s = await withProjects([ATL]);
    s.c.setOptions({ includeClosed: true });
    await s.c.idle();
    expect(keys(s)).toContain('ATL-5');
  });

  test('a project Jira no longer has → that row unreadable, the others still listed (two searches, then one)', async () => {
    const s = await withProjects([ATL, WEB]);
    s.fake.setScenario('project-gone');
    const before = searches(s).length;
    await s.clock.advance(STALE_MS);
    s.c.refresh();
    await s.c.idle();
    expect(searches(s).length - before).toBe(2);
    expect(s.c.info().status).toBe('connected');
    expect(s.c.info().attention).toBe(1);
    expect(s.c.info().projects!.find((p) => p.id === WEB)).toMatchObject({ error: 'unreadable' });
    expect(keys(s)).toContain('ATL-3');
    const again = searches(s).length;
    await s.clock.advance(STALE_MS);
    s.c.refresh();
    await s.c.idle();
    expect(searches(s).length - again).toBe(1);
    expect((searches(s).at(-1)!.arguments as { jql: string }).jql).not.toContain(WEB);
  });

  test('edits made while a refresh runs survive what that refresh learned (a gone project)', async () => {
    const gate: { wait: Promise<void> | null } = { wait: null };
    const s = await withProjects([ATL, WEB], { make: (d) => new GatedServer(d, gate) });
    s.fake.setScenario('project-gone');
    let open!: () => void;
    gate.wait = new Promise((r) => { open = r; });
    await s.clock.advance(STALE_MS);
    s.c.refresh();
    await s.c.setSourceScope(ATL, true);
    expect(await s.c.addSource(MKT)).toEqual({ ok: true, sourceIds: [MKT] });
    gate.wait = null;
    open();
    await s.c.idle();
    const projects = blobOf(s)!.projects as { id: string; everyone: boolean; error?: string }[];
    expect(projects.find((p) => p.id === ATL)).toMatchObject({ everyone: true });
    expect(projects.find((p) => p.id === WEB)).toMatchObject({ error: 'unreadable' });
    expect(projects.map((p) => p.id)).toContain(MKT);
  });

  test('a filter chosen while a refresh found the old one gone stays chosen', async () => {
    const gate: { wait: Promise<void> | null } = { wait: null };
    const s = await withProjects([ATL], { make: (d) => new GatedServer(d, gate) });
    await s.c.listFilters();
    await s.c.setFilter('10040');
    await s.c.idle();
    s.fake.setScenario('filter-gone');
    let open!: () => void;
    gate.wait = new Promise((r) => { open = r; });
    await s.clock.advance(STALE_MS);
    s.c.refresh();
    // filter-gone hides 10040 only: the new choice is fine.
    await s.c.setFilter('10041');
    gate.wait = null;
    open();
    await s.c.idle();
    expect(blobOf(s)!.filter).toEqual({ id: '10041', name: 'Website polish' });
  });

  test('Claude Code\'s reply envelope reads the same', async () => {
    const s = await withProjects([ATL], { scenario: 'nodes-envelope' });
    expect(keys(s)).toContain('ATL-3');
  });
});

describe('saved filter', () => {
  test('listed by name; chosen, it narrows the list; gone, it is dropped and said once', async () => {
    const s = await withProjects([ATL]);
    expect(await s.c.listFilters()).toEqual([{ id: '10040', name: 'My open bugs' }, { id: '10041', name: 'Website polish' }]);
    await s.c.setFilter('10040');
    await s.c.idle();
    expect(keys(s)).toEqual(['ATL-3', 'ATL-7']);
    expect(s.c.info().filter).toEqual({ id: '10040', name: 'My open bugs' });
    s.fake.setScenario('filter-gone');
    await s.clock.advance(STALE_MS);
    s.c.refresh();
    await s.c.idle();
    expect(s.c.info().filter).toBeUndefined();
    expect(s.c.info().filterGone).toBe(true);
    expect(keys(s)).toContain('ATL-4');
    expect(blobOf(s)!.filter).toBeUndefined();
    await s.c.setFilter(null);
    expect(s.c.info().filterGone).toBeUndefined();
  });

  test('with no site saved (disconnected), a task has no link of main\'s: the chip keeps its own', async () => {
    const s = await withProjects([ATL]);
    expect(s.c.taskUrl('10103')).toBe('https://acme.atlassian.net/browse/ATL-3');
    s.c.disconnect();
    expect(s.c.taskUrl('10103')).toBeNull();
  });

  test('a filter id not from the last listing is ignored', async () => {
    const s = await withProjects([ATL]);
    await s.c.setFilter('10040');
    expect(s.c.info().filter).toBeUndefined();
  });
});

describe('visibility, detail, search', () => {
  test('a detail of a chosen project: Markdown body; HTML reduced to text; the injection is just data', async () => {
    const s = await withProjects([ATL]);
    const seven = await s.c.task('10107');
    expect(seven.ok && seven.task.body).toContain('IGNORE ALL PREVIOUS INSTRUCTIONS');
    const nine = await s.c.task('10109');
    expect(nine.ok).toBe(true);
    if (nine.ok) {
      expect(nine.task.body).not.toMatch(/<\/?(p|span|ul|li|pre|code|a)\b/);
      expect(nine.task.url).toBe('https://acme.atlassian.net/browse/ATL-9');
    }
  });

  test('an issue of a project that isn\'t chosen is gone, whatever id is asked for', async () => {
    const s = await withProjects([ATL]);
    expect(await s.c.task('10401')).toEqual({ ok: false, reason: 'gone' });
    expect(await s.c.task('99999')).toEqual({ ok: false, reason: 'gone' });
    expect(await s.c.task('ATL-3')).toEqual({ ok: false, reason: 'gone' });
  });

  test('an issue a server returns from a project that isn\'t chosen never reaches the list, a search or an automation', async () => {
    const s = await withProjects([ATL], { make: (d) => new LeakyServer(d) });
    expect(keys(s)).not.toContain('MKT-1');
    expect((await s.c.search('leaked billing')).map((t) => t.displayId)).not.toContain('MKT-1');
    expect((await s.c.watch([ATL])).tasks.map((t) => t.displayId)).not.toContain('MKT-1');
  });

  test('search: title words within the chosen projects; a key reads that issue; nothing outside', async () => {
    const s = await withProjects([ATL]);
    expect((await s.c.search('billing')).map((t) => t.displayId)).toEqual(['ATL-3']);
    expect((await s.c.search('ATL-4')).map((t) => t.displayId)).toContain('ATL-4');
    expect(await s.c.search('WEB-1')).toEqual([]);
    expect(await s.c.search('"))) OR project != 1')).toEqual([]);
  });
});

describe('automations', () => {
  test('watch: everyone\'s open issues of the scopes, with creator, labels and priority level; a scope not chosen → incomplete', async () => {
    const s = await withProjects([ATL, SUP]);
    const w = await s.c.watch([SUP]);
    expect(w.complete).toBe(true);
    expect(w.tasks.map((t) => t.displayId).sort()).toEqual(['SUP-1', 'SUP-2']);
    const one = w.tasks.find((t) => t.displayId === 'SUP-1')!;
    expect(one).toMatchObject({ scope: SUP, tags: ['claude'], priority: 'high', assignees: [] });
    expect(one.creatorId).toBe(s.fake.data.users.customer.accountId);
    // The editor's people chips: assignees and creators by display name, once each.
    const names = new Map((w.people ?? []).map((p) => [p.id, p.name]));
    expect(names.get(s.fake.data.users.customer.accountId)).toBe(s.fake.data.users.customer.displayName);
    expect(new Set(w.people!.map((p) => p.id)).size).toBe(w.people!.length);
    expect((await s.c.watch([SUP, MKT])).complete).toBe(false);
    expect(s.c.serviceScopes([ATL, SUP])).toEqual([SUP]);
    expect(await s.c.scopes()).toEqual([{ id: ATL, label: 'ATL · Atelier' }, { id: SUP, label: 'SUP · Customer Support' }]);
    expect(await s.c.creator('10103')).toEqual({ id: s.fake.data.users.grace.accountId, name: 'Grace Hopper' });
  });
});

describe('tokens', () => {
  test('an expired access token is renewed with the refresh token (CIMD client id), and the list goes on', async () => {
    const s = await withProjects([ATL]);
    s.fake.expireAccessTokens();
    await s.clock.advance(STALE_MS);
    s.c.refresh();
    await s.c.idle();
    expect(s.c.info().status).toBe('connected');
    expect(keys(s)).toContain('ATL-3');
  });

  test('Disconnect asks Atlassian to revoke (it refuses CIMD clients) and forgets everything', async () => {
    const s = await withProjects([ATL]);
    s.c.disconnect();
    await s.c.idle();
    expect(s.fake.revoked().map((r) => r.client)).toEqual(['cimd']);
    expect(blobOf(s)).toBeNull();
    expect(s.c.info()).toMatchObject({ status: 'disconnected' });
    expect(s.c.info().projects).toBeUndefined();
  });

  test('429 with Retry-After: no request until then, the cache kept', async () => {
    const s = await withProjects([ATL]);
    s.fake.setScenario('rate-limited');
    await s.clock.advance(STALE_MS);
    s.c.refresh();
    await s.c.idle();
    const n = s.fake.calls().length;
    s.c.refresh();
    await s.c.idle();
    expect(s.fake.calls().length).toBe(n);
    expect(keys(s)).toContain('ATL-3');
  });
});

describe('API-token sign-in', () => {
  test('e-mail + token + site: Basic auth, stored as such, the same projects flow', async () => {
    const s = await setup({ apiTokens: [API] });
    s.c.connectWithToken({ user: API.email, secret: API.token, site: 'acme.atlassian.net' });
    await s.c.idle();
    expect(s.c.info()).toMatchObject({ status: 'connected', signIn: 'token', tokenUser: API.email, workspace: 'acme.atlassian.net' });
    expect(s.fake.authorizeRequests()).toEqual([]);
    expect(s.fake.callDetails().every((c) => c.auth === 'basic')).toBe(true);
    expect(blobOf(s)).toMatchObject({ auth: 'basic', basicUser: API.email, token: API.token });
    await s.c.searchSources('');
    expect((await s.c.addSource(ATL)).ok).toBe(true);
    await s.c.idle();
    expect(keys(s)).toContain('ATL-3');
  });

  test('refused (the admin turned API tokens off) → token-refused, nothing stored', async () => {
    const s = await setup({ apiTokens: [API], scenario: 'tokens-disabled' });
    s.c.connectWithToken({ user: API.email, secret: API.token, site: 'acme.atlassian.net' });
    await s.c.idle();
    expect(s.c.info()).toMatchObject({ status: 'disconnected', reason: 'token-refused' });
    expect(blobOf(s)).toBeNull();
  });

  test('a token without scopes (Jira\'s tools not listed) → token-scopes in the form, not "connector changed"', async () => {
    const s = await setup({ apiTokens: [API], scenario: 'token-unscoped' });
    s.c.connectWithToken({ user: API.email, secret: API.token, site: 'acme.atlassian.net' });
    await s.c.idle();
    expect(s.c.info()).toMatchObject({ status: 'disconnected', reason: 'token-scopes' });
    expect(s.notices).toEqual(['token-scopes']);
    expect(blobOf(s)).toBeNull();
  });

  test('a site that isn\'t a Jira Cloud site is refused before any request: the form says so', async () => {
    const s = await setup({ apiTokens: [API] });
    s.c.connectWithToken({ user: API.email, secret: API.token, site: 'https://evil.example' });
    await s.c.idle();
    expect(s.c.info()).toMatchObject({ status: 'disconnected', reason: 'token-site' });
    expect(s.notices).toEqual(['token-site']);
    expect(s.fake.calls()).toEqual([]);
  });

  test('a Jira site that isn\'t on this account: the form says so, nothing stored, no browser sign-in', async () => {
    const s = await setup({ apiTokens: [API] });
    s.c.connectWithToken({ user: API.email, secret: API.token, site: 'acme2.atlassian.net' });
    await s.c.idle();
    expect(s.c.info()).toMatchObject({ status: 'disconnected', reason: 'token-site' });
    expect(blobOf(s)).toBeNull();
    expect(s.fake.authorizeRequests()).toEqual([]);
  });
});
