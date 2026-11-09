import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import type { NotionFields } from '@shared/tasks';
import { startFakeNotion, type FakeNotion, type FakeNotionScenario } from '../../../../tests/fixtures/fake-notion.mjs';
import { fetchTransport } from '../../../../tests/support/fetch-transport';
import { manualClock, type ManualClock } from '../../../../tests/support/manual-clock';
import type { HttpResponse, Transport } from '../http';
import { followAuthorize } from '../oauth/follow-auth';
import { createSecretStore, type SecretStore } from '../secret-store';
import { testSafeStorage } from '../test-safe-storage';
import { notionEndpoint } from './config';
import { InvalidArguments, ToolError } from '../errors';
import type { McpClient } from '../mcp/client';
import { STALE_MS } from '../task-connector';
import { NotionConnector, type NotionDeps } from './notion';
import { ALLOWED_TOOLS, NOTION_TOOLS } from './tools';

// The Notion connector against the local fake Notion (real HTTP on 127.0.0.1: OAuth with
// refresh tokens and revocation, MCP with the four read-only tools on the fictional fixtures), with a manual clock for
// every wait. Never the real Notion.

const SPRINT = { db: '00000006000040008000000000000006', source: '00000002000040008000000000000002' };
const BACKLOG = { db: '00000005000040008000000000000005', source: '00000001000040008000000000000001' };
/** A plain page (the databases' parent), and Backlog rows. */
const ENGINEERING_PAGE = '00000003000040008000000000000003';
const PRICING = '00000004000040008000000000000004';

const SPRINT_FIELDS: NotionFields = { title: 'Task name', status: { prop: 'Status', kind: 'status', closed: [] }, assignee: { prop: 'Assignee', mine: true }, due: 'Due' };
const BACKLOG_FIELDS: NotionFields = {
  title: 'Title', status: { prop: 'Stage', kind: 'select', closed: ['Shipped'] }, assignee: { prop: 'Owner', mine: true }, due: 'Deadline', id: 'Ticket'
};
const sprintLink = `https://www.notion.so/acme/Sprint-Tasks-${SPRINT.db}?v=0000000a00004000800000000000000a`;
const backlogLink = `https://app.notion.com/p/${BACKLOG.db}`;
/** One database with two data sources (Web, Mobile). */
const ROADMAP = { db: '7e0a5b1c2d3e4f5061728394a5b6c7d8', web: '9a1b2c3d4e5f4a6b8c7d8e9fa0b1c2d3', mobile: '0f1e2d3c4b5a49688776655443322110' };
const roadmapLink = `https://www.notion.so/acme/Roadmap-${ROADMAP.db}`;

let fakes: FakeNotion[] = [];
let connectors: NotionConnector[] = [];
/** Every secret the flows handled (sniffed on the wire, or stored) and every line the connectors logged. */
const secrets = new Set<string>();
const logged: string[] = [];
afterEach(async () => {
  for (const c of connectors.splice(0)) c.dispose();
  // Suite-level: whatever a test did, the fake never saw a tool outside the read-only allowlist…
  for (const f of fakes) expect(f.calls().filter((n) => !ALLOWED_TOOLS.has(n))).toEqual([]);
  // …and no log line carries a token, a refresh token, a code, a verifier, a state, a challenge or the client id.
  for (const s of secrets) for (const line of logged) expect(line).not.toContain(s);
  secrets.clear();
  logged.length = 0;
  await Promise.all(fakes.splice(0).map((f) => f.close()));
});

const add = (v: string | null | undefined) => { if (v && v.length >= 8) secrets.add(v); };

/** Records the secrets crossing the wire: Bearer tokens, authorize parameters, callback parameters, token forms. */
function sniffing(t: Transport): Transport {
  return async (req, signal) => {
    add(req.headers?.authorization?.replace(/^Bearer /, ''));
    const u = new URL(req.url);
    if (u.pathname.endsWith('/authorize')) for (const k of ['client_id', 'state', 'code_challenge']) add(u.searchParams.get(k));
    if (req.body && /(?:^|&)(?:code_verifier|refresh_token|token)=/.test(req.body)) {
      const form = new URLSearchParams(req.body);
      for (const k of ['code', 'code_verifier', 'client_id', 'refresh_token', 'token']) add(form.get(k));
    }
    const res = await t(req, signal);
    if (res.location) { const q = new URL(res.location, u).searchParams; add(q.get('code')); add(q.get('state')); }
    return res;
  };
}

interface Setup {
  scenario?: FakeNotionScenario;
  focused?: boolean;
  fake?: FakeNotion;
  clock?: ManualClock;
  transport?: (base: Transport) => Transport;
  /** Writes a saved connection before init. */
  seed?: (store: SecretStore, fake: FakeNotion) => void;
  /** Wraps the MCP client (a call Atelier refuses to send, for instance). */
  wrap?: (c: McpClient<typeof NOTION_TOOLS>) => McpClient<typeof NOTION_TOOLS>;
}

class WrappedNotion extends NotionConnector {
  constructor(deps: NotionDeps, private readonly wrap: (c: McpClient<typeof NOTION_TOOLS>) => McpClient<typeof NOTION_TOOLS>) { super(deps); }
  protected override makeClient(token: string) { return this.wrap(super.makeClient(token)); }
}

async function setup(o: Setup = {}) {
  const fake = o.fake ?? await startFakeNotion({ scenario: o.scenario ?? 'normal' });
  if (!o.fake) fakes.push(fake);
  const home = mkdtempSync(join(tmpdir(), 'atl-notion-'));
  const store = createSecretStore(home, testSafeStorage({ available: true }));
  const writes: string[] = [];
  const spied: SecretStore = { ...store, write: (id, v) => { writes.push(v); store.write(id, v); } };
  o.seed?.(store, fake);
  const clock = o.clock ?? manualClock();
  const endpoint = notionEndpoint(fake.url);
  const requests: string[] = [];
  const base = sniffing(fetchTransport((u) => requests.push(new URL(u).pathname)));
  const transport = o.transport ? o.transport(base) : base;
  const state = { focused: o.focused ?? true };
  const logs: string[] = [];
  let changes = 0;
  const deps: NotionDeps = {
    store: spied, endpoint, transport, openAuthPage: followAuthorize(transport, endpoint.allow), clock, focused: () => state.focused,
    log: (m) => { logs.push(m); logged.push(m); }, onChange: () => { changes++; }, onNotice: () => undefined
  };
  const c = o.wrap ? new WrappedNotion(deps, o.wrap) : new NotionConnector(deps);
  connectors.push(c);
  c.init();
  return { fake, home, store: spied, writes, clock, c, state, logs, requests, changes: () => changes };
}
type S = Awaited<ReturnType<typeof setup>>;

interface Blob {
  token: string | null; refresh?: string; expiresAt?: number; clientId?: string; userId: string; account?: string;
  workspace: { id: string; name: string }; options: { includeClosed: boolean };
  databases: { id: string; source: string; name: string; path?: string; fields: NotionFields; idPrefix?: string; error?: string }[];
}
const blobOf = (s: S) => {
  const raw = s.store.read('notion');
  return raw === null ? null : JSON.parse(raw) as Blob;
};

async function connected(o: Setup = {}) {
  const s = await setup(o);
  s.c.connect(1);
  await s.c.idle();
  expect(s.c.info().status).toBe('connected');
  const b = blobOf(s)!;
  add(b.token); add(b.refresh); add(b.clientId);
  return s;
}

/** Connected, with these databases added (by link or id), the list refreshed. */
async function withDatabases(refs: string[], o: Setup = {}) {
  const s = await connected(o);
  for (const ref of refs) expect((await s.c.addSource(ref)).ok).toBe(true);
  await s.c.idle();
  return s;
}

const titles = (s: S) => s.c.taskList().tasks.map((t) => t.title);
const callsOf = (s: S, name: string) => s.fake.callDetails().filter((c) => c.name === name);
const fetchIds = (s: S) => callsOf(s, 'notion-fetch').map((c) => (c.arguments as { id: string }).id);
/** The pages fetched to read a row (not a database, not a data source). */
const rowFetches = (s: S) => fetchIds(s).filter((id) => !id.startsWith('collection://') && id.replace(/-/g, '') !== BACKLOG.db && id.replace(/-/g, '') !== SPRINT.db);

const failing = (match: string) => (base: Transport): Transport => async (req, signal) => {
  if (req.url.endsWith('/mcp') && req.body?.includes(match)) {
    const res: HttpResponse = { status: 500, headers: {}, location: null, body: (async function* () { /* empty */ })(), close: () => undefined };
    return res;
  }
  return base(req, signal);
};

/** Holds the next rows query until released (a list refresh in flight). */
function gated() {
  let armed = false;
  let release = () => undefined as void;
  let reached = () => undefined as void;
  let gate = Promise.resolve();
  let atGate = Promise.resolve();
  return {
    arm() {
      armed = true;
      gate = new Promise<void>((r) => { release = r; });
      atGate = new Promise<void>((r) => { reached = r; });
    },
    release: () => release(),
    reached: () => atGate,
    transport: (base: Transport): Transport => async (req, signal) => {
      if (armed && req.url.endsWith('/mcp') && req.body?.includes('"notion-query-data-sources"')) {
        armed = false;
        reached();
        await gate;
      }
      return base(req, signal);
    }
  };
}

const hex = (prefix: string, i: number) => prefix.repeat(28) + i.toString(16).padStart(4, '0');
function seedMany(n: number) {
  return (store: SecretStore, fake: FakeNotion) => {
    const token = fake.issueToken();
    add(token);
    store.write('notion', JSON.stringify({
      v: 1, token, userId: fake.fixtures.userId, account: 'Ada Lovelace', workspace: { id: '00000009-0000-4000-8000-000000000009', name: 'Acme' },
      options: { includeClosed: false },
      databases: Array.from({ length: n }, (_, i) => ({ id: hex('a', i), source: hex('b', i), name: `Database ${i}`, fields: { title: 'Name' } }))
    }));
  };
}

describe('connect', () => {
  test('connect stores nothing until get-self succeeds; then connected with sources []', async () => {
    const broken = await setup({ transport: failing('"notion-get-self"') });
    broken.c.connect(1);
    await broken.c.idle();
    expect(broken.c.info().status).toBe('disconnected');
    expect(broken.writes).toEqual([]);
    expect(broken.store.read('notion')).toBeNull();

    const s = await setup();
    const callsAtWrite: string[][] = [];
    const write = s.store.write;
    s.store.write = (id, v) => { callsAtWrite.push(s.fake.calls()); write(id, v); };
    s.c.connect(1);
    await s.c.idle();
    expect(callsAtWrite).toEqual([['notion-get-self']]);
    expect(s.c.info()).toMatchObject({ id: 'notion', name: 'Notion', status: 'connected', account: 'Ada Lovelace', workspace: 'Acme', sources: [], attention: 0 });
    expect(s.c.taskList().tasks).toEqual([]);
    const b = blobOf(s)!;
    expect(b).toMatchObject({ v: 1, userId: s.fake.fixtures.userId, workspace: { id: '00000009-0000-4000-8000-000000000009', name: 'Acme' }, databases: [] });
    expect(b.token).toMatch(/^ntnat_/);
    expect(b.refresh).toMatch(/^ntnrt_/);
    expect(b.clientId).toMatch(/^fake-client-/);
    expect(b.expiresAt).toBe(s.clock.now() + 3_600_000);
    add(b.token); add(b.refresh); add(b.clientId);
    // The sniffer saw the flow's secrets (the suite's log check is not vacuous).
    expect(secrets.size).toBeGreaterThanOrEqual(6);
  });

  test('disconnect revokes and deletes notion.bin', async () => {
    const s = await withDatabases([sprintLink]);
    const b = blobOf(s)!;
    s.c.disconnect();
    await s.c.idle();
    expect(s.fake.revoked()).toEqual([{ token: b.refresh, tokenTypeHint: null, clientId: b.clientId }]);
    expect(existsSync(join(s.home, 'connectors', 'notion.bin'))).toBe(false);
    expect(s.c.info().status).toBe('disconnected');
    expect(s.c.info().sources).toBeUndefined();
    expect(s.c.taskList().tasks).toEqual([]);
  });

  test('an access-only connection (no refresh token) loads and is never revoked', async () => {
    const s = await setup({ seed: seedMany(1) });
    await s.c.idle();
    expect(s.c.info()).toMatchObject({ status: 'connected', sources: [{ id: hex('b', 0), name: 'Database 0', error: 'unreadable', loading: false }], attention: 1 });
    s.c.disconnect();
    await s.c.idle();
    expect(s.fake.revoked()).toEqual([]);
  });
});

describe('choosing databases', () => {
  test('addSource by search pick and by pasted link adds the database with guessed fields', async () => {
    const s = await connected();
    const picks = await s.c.searchSources('eng');
    // Databases only: the Engineering page is not one.
    expect(picks).toEqual([{ id: BACKLOG.db, name: 'Engineering Backlog', path: 'Engineering', added: false }]);
    expect(await s.c.addSource(picks[0]!.id)).toEqual({ ok: true, sourceIds: [BACKLOG.source] });
    expect(await s.c.addSource(sprintLink)).toEqual({ ok: true, sourceIds: [SPRINT.source] });
    await s.c.idle();
    expect(s.c.info().sources).toEqual([
      { id: BACKLOG.source, name: 'Engineering Backlog', path: 'Engineering', fields: BACKLOG_FIELDS, columns: expect.any(Array), count: 2, preview: expect.objectContaining({ listName: 'Engineering Backlog' }), loading: false },
      { id: SPRINT.source, name: 'Sprint Tasks', fields: SPRINT_FIELDS, columns: expect.any(Array), count: 2, preview: expect.objectContaining({ listName: 'Sprint Tasks' }), loading: false }
    ]);
    expect(blobOf(s)!.databases).toEqual([
      { id: BACKLOG.db, source: BACKLOG.source, name: 'Engineering Backlog', path: 'Engineering', fields: BACKLOG_FIELDS, idPrefix: 'ENG' },
      { id: SPRINT.db, source: SPRINT.source, name: 'Sprint Tasks', fields: SPRINT_FIELDS }
    ]);
    expect(await s.c.searchSources('eng')).toEqual([{ id: BACKLOG.db, name: 'Engineering Backlog', path: 'Engineering', added: true }]);
  });

  test('addSource with a page link → not-database; junk → not-database without a request; an unknown id → not-found', async () => {
    const s = await connected();
    expect(await s.c.addSource(`https://www.notion.so/acme/Engineering-${ENGINEERING_PAGE}#heading`)).toEqual({ ok: false, reason: 'not-database' });
    const n = s.fake.calls().length;
    expect(await s.c.addSource('not a link')).toEqual({ ok: false, reason: 'not-database' });
    expect(await s.c.addSource('https://example.com/00000006000040008000000000000006')).toEqual({ ok: false, reason: 'not-database' });
    expect(s.fake.calls().length).toBe(n);
    expect(await s.c.addSource('f'.repeat(32))).toEqual({ ok: false, reason: 'not-found' });
    expect(s.c.info().sources).toEqual([]);
    expect(blobOf(s)!.databases).toEqual([]);
  });

  test('Notion down: the picker search rejects (one line in the picker), adding says offline; nothing changes', async () => {
    const s = await connected();
    s.fake.setScenario('mcp-500');
    await expect(s.c.searchSources('eng')).rejects.toThrow("Couldn't search Notion.");
    expect(await s.c.addSource(sprintLink)).toEqual({ ok: false, reason: 'offline' });
    expect(s.c.info()).toMatchObject({ status: 'connected', sources: [] });
    expect(blobOf(s)!.databases).toEqual([]);
  });

  test('a duplicate add changes nothing', async () => {
    const s = await withDatabases([sprintLink]);
    const writes = s.writes.length;
    const calls = s.fake.calls().length;
    expect(await s.c.addSource('00000006-0000-4000-8000-000000000006')).toEqual({ ok: true, sourceIds: [SPRINT.source] });
    await s.c.idle();
    expect(s.writes.length).toBe(writes);
    expect(s.fake.calls().length).toBe(calls);
    expect(s.c.info().sources).toHaveLength(1);
  });

  test('the 21st → too-many', async () => {
    const s = await setup({ seed: seedMany(20) });
    await s.c.idle();
    expect(s.c.info().sources).toHaveLength(20);
    const calls = s.fake.calls().length;
    expect(await s.c.addSource(sprintLink)).toEqual({ ok: false, reason: 'too-many' });
    expect(s.fake.calls().length).toBe(calls);
    expect(blobOf(s)!.databases).toHaveLength(20);
  });

  test('removeSource drops the database and its tasks at once, the other stays', async () => {
    const s = await withDatabases([sprintLink, backlogLink]);
    const info = await s.c.removeSource(SPRINT.source);
    expect(info.sources!.map((x) => x.id)).toEqual([BACKLOG.source]);
    expect(titles(s)).toEqual(['Dark mode for the billing page', 'Pricing page copy review']);
    expect(blobOf(s)!.databases.map((d) => d.id)).toEqual([BACKLOG.db]);
    // An unknown source: nothing happens.
    const writes = s.writes.length;
    expect((await s.c.removeSource('f'.repeat(32))).sources).toHaveLength(1);
    expect(s.writes.length).toBe(writes);
  });

  test('a database with two data sources adds one entry each, named "<database> · <data source>"', async () => {
    const s = await withDatabases([roadmapLink]);
    expect(s.c.info().sources!.map((x) => [x.id, x.name, x.count])).toEqual([[ROADMAP.web, 'Roadmap · Web', 1], [ROADMAP.mobile, 'Roadmap · Mobile', 1]]);
    // Launched (Notion's Complete group) hidden in Web.
    expect(titles(s)).toEqual(['Launch the pricing experiment', 'Offline mode for the reader']);
    expect(blobOf(s)!.databases.map((d) => [d.id, d.source])).toEqual([[ROADMAP.db, ROADMAP.web], [ROADMAP.db, ROADMAP.mobile]]);
    expect(await s.c.addSource(ROADMAP.db)).toEqual({ ok: true, sourceIds: [ROADMAP.web, ROADMAP.mobile] });
  });

  test('every entry a database adds counts: 19 chosen + one with two data sources → too-many', async () => {
    const s = await setup({ seed: seedMany(19) });
    await s.c.idle();
    expect(await s.c.addSource(roadmapLink)).toEqual({ ok: false, reason: 'too-many' });
    expect(blobOf(s)!.databases).toHaveLength(19);
    expect(s.c.info().sources).toHaveLength(19);
  });

  test('loadSourceColumns on a database no longer shared turns it unreadable and tells the listeners', async () => {
    const s = await withDatabases([sprintLink, backlogLink]);
    s.fake.setScenario('unshare-backlog');
    const before = s.changes();
    const info = await s.c.loadSourceColumns(BACKLOG.source);
    expect(info.attention).toBe(1);
    expect(info.sources![1]).toMatchObject({ id: BACKLOG.source, error: 'unreadable' });
    expect(titles(s)).toEqual(['Add rate limiting to the export endpoint', 'Fix flaky login test on CI']);
    expect(blobOf(s)!.databases[1]!.error).toBe('unreadable');
    expect(s.changes()).toBeGreaterThan(before);
  });

  test('editing the fields of a database no longer shared (its columns not read yet) turns it unreadable and tells the listeners', async () => {
    const g = gated();
    g.arm();
    const s = await setup({
      transport: g.transport,
      seed: (store, fake) => {
        const token = fake.issueToken();
        add(token);
        store.write('notion', JSON.stringify({
          v: 1, token, userId: fake.fixtures.userId, account: 'Ada Lovelace', workspace: { id: '00000009-0000-4000-8000-000000000009', name: 'Acme' },
          options: { includeClosed: false },
          databases: [
            { id: SPRINT.db, source: SPRINT.source, name: 'Sprint Tasks', fields: SPRINT_FIELDS },
            { id: BACKLOG.db, source: BACKLOG.source, name: 'Engineering Backlog', fields: BACKLOG_FIELDS }
          ]
        }));
      }
    });
    // The launch refresh holds Sprint's rows query: the Backlog's columns haven't been read in this run.
    await g.reached();
    s.fake.setScenario('unshare-backlog');
    const before = s.changes();
    const { due: _due, ...noDue } = BACKLOG_FIELDS;
    const info = await s.c.setSourceFields(BACKLOG.source, noDue);
    expect(info.sources![1]).toMatchObject({ id: BACKLOG.source, error: 'unreadable', fields: BACKLOG_FIELDS });
    expect(info.attention).toBe(1);
    expect(blobOf(s)!.databases[1]).toMatchObject({ error: 'unreadable', fields: BACKLOG_FIELDS });
    expect(s.changes()).toBeGreaterThan(before);
    expect(s.logs.some((l) => l.startsWith("notion: a database's columns weren't read: "))).toBe(true);
    g.release();
    await s.c.idle();
    expect(s.c.info()).toMatchObject({ status: 'connected', attention: 1 });
  });

  test('loadSourceColumns reads the schema now and shows the columns as the editor needs them', async () => {
    const s = await withDatabases([sprintLink]);
    const before = fetchIds(s).length;
    const info = await s.c.loadSourceColumns(SPRINT.source);
    expect(fetchIds(s).slice(before)).toEqual([`collection://00000002-0000-4000-8000-000000000002`]);
    expect(info.sources![0]!.columns).toEqual(expect.arrayContaining([
      { name: 'Task name', type: 'title' },
      { name: 'Assignee', type: 'person' },
      { name: 'Due', type: 'date' },
      { name: 'Status', type: 'status', options: [
        { name: 'Not started', tone: 'idle', group: 'to_do' }, { name: 'In progress', tone: 'working', group: 'in_progress' },
        { name: 'Done', tone: 'done', group: 'complete' }, { name: 'Archived', tone: 'idle', group: 'complete' }
      ] }
    ]));
    // An unknown source: no request.
    const n = s.fake.calls().length;
    await s.c.loadSourceColumns('f'.repeat(32));
    expect(s.fake.calls().length).toBe(n);
  });
});

describe('fields', () => {
  test('setSourceFields refuses an unknown source', async () => {
    const s = await withDatabases([sprintLink]);
    const writes = s.writes.length;
    const info = await s.c.setSourceFields('f'.repeat(32), { title: 'Task name' });
    expect(info.sources![0]!.fields).toEqual(SPRINT_FIELDS);
    expect(s.writes.length).toBe(writes);
  });

  test('setSourceFields validates every column against the schema: unknown or retyped columns are refused', async () => {
    const s = await withDatabases([backlogLink]);
    const writes = s.writes.length;
    for (const fields of [
      { ...BACKLOG_FIELDS, title: 'Stage' },
      { ...BACKLOG_FIELDS, status: { prop: 'Nope', kind: 'select', closed: [] } },
      { ...BACKLOG_FIELDS, status: { prop: 'Stage', kind: 'status', closed: [] } },
      { ...BACKLOG_FIELDS, assignee: { prop: 'Deadline', mine: true } },
      { ...BACKLOG_FIELDS, due: 'Owner' },
      { ...BACKLOG_FIELDS, id: 'Priority' }
    ] as NotionFields[]) {
      const info = await s.c.setSourceFields(BACKLOG.source, fields);
      expect(info.sources![0]!.fields, JSON.stringify(fields)).toEqual(BACKLOG_FIELDS);
    }
    expect(s.writes.length).toBe(writes);
  });

  test('setSourceFields saves a valid change and lists again with it', async () => {
    const s = await withDatabases([sprintLink]);
    expect(titles(s)).not.toContain('Write onboarding checklist');
    const fields = { ...SPRINT_FIELDS, assignee: { prop: 'Assignee', mine: false } };
    const info = await s.c.setSourceFields(SPRINT.source, fields);
    expect(info.sources![0]!.fields).toEqual(fields);
    await s.c.idle();
    expect(titles(s)).toContain('Write onboarding checklist');
    expect(blobOf(s)!.databases[0]!.fields).toEqual(fields);
  });

  test('closed options are normalized (trimmed, deduplicated, existing only) and a status column keeps none', async () => {
    const s = await withDatabases([backlogLink, sprintLink]);
    await s.c.setSourceFields(BACKLOG.source, { ...BACKLOG_FIELDS, status: { prop: 'Stage', kind: 'select', closed: [' Shipped ', 'Shipped', '', 'Backlog', 'Ghost'] } });
    await s.c.setSourceFields(SPRINT.source, { ...SPRINT_FIELDS, status: { prop: 'Status', kind: 'status', closed: ['Done'] } });
    await s.c.idle();
    const dbs = blobOf(s)!.databases;
    expect(dbs[0]!.fields.status).toEqual({ prop: 'Stage', kind: 'select', closed: ['Shipped', 'Backlog'] });
    expect(dbs[1]!.fields.status).toEqual({ prop: 'Status', kind: 'status', closed: [] });
  });

  test('changing the ID column forgets the learned prefix', async () => {
    const s = await withDatabases([backlogLink]);
    expect(blobOf(s)!.databases[0]!.idPrefix).toBe('ENG');
    const { id: _id, ...noId } = BACKLOG_FIELDS;
    await s.c.setSourceFields(BACKLOG.source, noId);
    await s.c.idle();
    expect(blobOf(s)!.databases[0]).not.toHaveProperty('idPrefix');
    expect(s.c.taskList().tasks.map((t) => t.displayId)).toEqual(['', '']);
  });
});

describe('listing', () => {
  test('list hides closed and others\' tasks', async () => {
    const s = await withDatabases([sprintLink, backlogLink]);
    // Sprint: Done and the unassigned one hidden (sorted by due date); Backlog: Shipped hidden.
    expect(titles(s)).toEqual(['Add rate limiting to the export endpoint', 'Fix flaky login test on CI', 'Dark mode for the billing page', 'Pricing page copy review']);
    const rate = s.c.taskList().tasks[0]!;
    expect(rate).toEqual({
      id: '0000000f00004000800000000000000f', displayId: '', title: 'Add rate limiting to the export endpoint',
      status: { name: 'In progress', color: '#60A5FA' }, due: new Date(2026, 9, 21).getTime(), listName: 'Sprint Tasks',
      url: 'https://app.notion.com/p/0000000f00004000800000000000000f'
    });
    expect(s.c.info()).toMatchObject({ status: 'connected', attention: 0 });
  });

  test('each database carries its own first listed task (the fields editor\'s preview), none while unreadable', async () => {
    const s = await withDatabases([sprintLink, backlogLink]);
    const sources = s.c.info().sources!;
    expect(sources[0]!.preview).toMatchObject({ title: 'Add rate limiting to the export endpoint', listName: 'Sprint Tasks' });
    expect(sources[1]!.preview).toMatchObject({ title: 'Dark mode for the billing page', listName: 'Engineering Backlog' });
    s.fake.setScenario('unshare-backlog');
    s.c.refresh();
    await s.c.idle();
    expect(s.c.info().sources![1]).not.toHaveProperty('preview');
  });

  test('include closed shows them', async () => {
    const s = await withDatabases([sprintLink, backlogLink]);
    s.c.setOptions({ includeClosed: true });
    await s.c.idle();
    expect(titles(s)).toEqual(expect.arrayContaining(['Migrate settings to the new schema', 'Ship v2 search']));
    expect(titles(s)).not.toContain('Write onboarding checklist');
  });

  test('refresh after the Stage column is renamed re-guesses the status and still hides Shipped', async () => {
    const s = await withDatabases([backlogLink]);
    s.fake.setScenario('rename-stage');
    s.c.refresh();
    await s.c.idle();
    expect(titles(s)).toEqual(['Dark mode for the billing page', 'Pricing page copy review']);
    const queries = callsOf(s, 'notion-query-data-sources');
    expect(JSON.stringify(queries.at(-1)!.arguments)).toContain('"property":"Phase"');
    expect(blobOf(s)!.databases[0]!.fields.status).toEqual({ prop: 'Phase', kind: 'select', closed: ['Shipped'] });
    expect(s.c.info().sources![0]!.fields.status!.prop).toBe('Phase');
    expect(s.logs).toContain('notion: fields re-guessed after a column change');
  });

  test('an unshared database turns unreadable, attention 1, the other database still lists', async () => {
    const s = await withDatabases([sprintLink, backlogLink]);
    s.fake.setScenario('unshare-backlog');
    s.c.refresh();
    await s.c.idle();
    const info = s.c.info();
    expect(info.status).toBe('connected');
    expect(info.attention).toBe(1);
    expect(info.sources![1]).toMatchObject({ id: BACKLOG.source, error: 'unreadable', loading: false });
    expect(info.sources![1]).not.toHaveProperty('count');
    expect(info.sources![0]).toMatchObject({ id: SPRINT.source, count: 2 });
    expect(titles(s)).toEqual(['Add rate limiting to the export endpoint', 'Fix flaky login test on CI']);
    expect(blobOf(s)!.databases[1]!.error).toBe('unreadable');
    // Shared again: readable, no attention.
    s.fake.setScenario('normal');
    s.c.refresh();
    await s.c.idle();
    expect(s.c.info().attention).toBe(0);
    expect(blobOf(s)!.databases[1]).not.toHaveProperty('error');
    expect(titles(s)).toHaveLength(4);
  });

  // One deadline per Notion database and partial commits.
  test('each database has its own 30 s deadline: two slow databases (25 s each) both list', async () => {
    const g = gated();
    const s = await withDatabases([sprintLink, backlogLink], { transport: g.transport });
    g.arm();
    s.c.refresh();
    await g.reached(); // Sprint's rows query
    await s.clock.advance(25_000);
    g.release();
    g.arm(); // the next one: Backlog's rows query, 25 s again (50 s since the refresh started)
    await g.reached();
    await s.clock.advance(25_000);
    g.release();
    await s.c.idle();
    expect(s.c.info()).toMatchObject({ status: 'connected', attention: 0 });
    expect(titles(s)).toHaveLength(4);
  });

  test('a database that doesn\'t answer in time keeps its previous tasks; the next database is still read', async () => {
    const g = gated();
    const s = await withDatabases([sprintLink, backlogLink], { transport: g.transport });
    s.fake.setScenario('unshare-backlog');
    g.arm();
    s.c.refresh();
    await g.reached(); // Sprint's rows query never answers in time
    await s.clock.advance(30_000);
    g.release();
    await s.c.idle();
    const info = s.c.info();
    expect(info.status).toBe('connected');
    // Backlog was read after Sprint timed out (it is unshared now); Sprint keeps the tasks of the last refresh.
    expect(info.attention).toBe(1);
    expect(info.sources![0]).toMatchObject({ id: SPRINT.source, count: 2 });
    expect(titles(s)).toEqual(['Add rate limiting to the export endpoint', 'Fix flaky login test on CI']);
  });

  test('a database Notion can\'t serve (5xx) keeps its tasks while the others refresh; all failing → offline, cache kept', async () => {
    let fail = '';
    const s = await withDatabases([sprintLink, backlogLink], {
      transport: (base) => async (req, signal) => (fail && req.body?.includes(fail) ? failing(fail)(base)(req, signal) : base(req, signal))
    });
    fail = '8bd98db4'; // Sprint's data source
    s.fake.setScenario('unshare-backlog');
    s.c.refresh();
    await s.c.idle();
    expect(s.c.info()).toMatchObject({ status: 'connected', attention: 1 });
    expect(titles(s)).toEqual(['Add rate limiting to the export endpoint', 'Fix flaky login test on CI']);
    // Every database out of reach: the connection is the problem.
    s.fake.setScenario('normal');
    fail = '"notion-';
    s.c.refresh();
    await s.c.idle();
    expect(s.c.info().status).toBe('offline');
    expect(titles(s)).toEqual(['Add rate limiting to the export endpoint', 'Fix flaky login test on CI']);
  });

  test('fields edited while a refresh runs are not overwritten by it (it lists again with them)', async () => {
    const g = gated();
    const s = await withDatabases([backlogLink], { transport: g.transport });
    // The in-flight refresh re-guesses the renamed column (closed: Shipped) while the user picks Shipped + Review.
    s.fake.setScenario('rename-stage');
    g.arm();
    s.c.refresh();
    await g.reached();
    const mine: NotionFields = { ...BACKLOG_FIELDS, status: { prop: 'Phase', kind: 'select', closed: ['Shipped', 'Review'] } };
    expect((await s.c.setSourceFields(BACKLOG.source, mine)).sources![0]!.fields).toEqual(mine);
    g.release();
    await s.c.idle();
    expect(blobOf(s)!.databases[0]!.fields).toEqual(mine);
    expect(titles(s)).toEqual(['Dark mode for the billing page']);
  });

  test('a database added while a refresh runs is listed by the refresh right after it', async () => {
    const g = gated();
    const s = await withDatabases([sprintLink], { transport: g.transport });
    g.arm();
    s.c.refresh();
    await g.reached();
    expect(await s.c.addSource(backlogLink)).toEqual({ ok: true, sourceIds: [BACKLOG.source] });
    g.release();
    await s.c.idle();
    expect(titles(s)).toHaveLength(4);
    expect(s.c.info().sources!.map((x) => [x.id, x.count, x.loading])).toEqual([[SPRINT.source, 2, false], [BACKLOG.source, 2, false]]);
  });

  test('a failed ID prefix read is tried again on a later refresh', async () => {
    let fail = true;
    const s = await withDatabases([backlogLink], {
      wrap: (c) => ({
        listTools: (o) => c.listTools(o),
        callTool: ((name, args, o) => {
          const id = (args as { id?: string }).id;
          if (fail && name === 'notion-fetch' && id && !id.startsWith('collection://') && id !== BACKLOG.db) {
            fail = false;
            return Promise.reject(new ToolError(name, 'Service temporarily unavailable'));
          }
          return c.callTool(name, args, o);
        }) as typeof c.callTool
      })
    });
    expect(s.c.taskList().tasks.map((t) => t.displayId)).toEqual(['#1', '#2']);
    s.c.refresh();
    await s.c.idle();
    expect(s.c.taskList().tasks.map((t) => t.displayId)).toEqual(['ENG-1', 'ENG-2']);
    expect(blobOf(s)!.databases[0]!.idPrefix).toBe('ENG');
  });

  test('a database removed while a refresh runs does not come back with it', async () => {
    const g = gated();
    const s = await withDatabases([sprintLink, backlogLink], { transport: g.transport });
    g.arm();
    s.c.refresh();
    await g.reached(); // Sprint's rows query is held: the Backlog comes next
    await s.c.removeSource(BACKLOG.source);
    const mark = s.fake.callDetails().length;
    g.release();
    await s.c.idle();
    // The refresh no longer reads it (schema or rows).
    expect(JSON.stringify(s.fake.callDetails().slice(mark))).not.toContain('4f80d0f2');
    expect(blobOf(s)!.databases.map((d) => d.id)).toEqual([SPRINT.db]);
    expect(titles(s)).toEqual(['Add rate limiting to the export endpoint', 'Fix flaky login test on CI']);
    expect(s.c.info().sources!.map((x) => x.id)).toEqual([SPRINT.source]);
  });

  test('a query Atelier refuses to send (a name over Notion\'s limits) makes that database unreadable, not the connector', async () => {
    const backlogUrl = 'collection://00000001-0000-4000-8000-000000000001';
    const s = await withDatabases([sprintLink, backlogLink], {
      wrap: (c) => ({
        listTools: (o) => c.listTools(o),
        callTool: ((name, args, o) => name === 'notion-query-data-sources' && JSON.stringify(args).includes(backlogUrl)
          ? Promise.reject(new InvalidArguments(name)) : c.callTool(name, args, o)) as typeof c.callTool
      })
    });
    expect(s.c.info()).toMatchObject({ status: 'connected', attention: 1 });
    expect(s.c.info().sources![1]).toMatchObject({ id: BACKLOG.source, error: 'unreadable' });
    expect(titles(s)).toEqual(['Add rate limiting to the export endpoint', 'Fix flaky login test on CI']);
  });

  test('the ID prefix is learned once and shown as ENG-2', async () => {
    const s = await withDatabases([backlogLink]);
    expect(s.c.taskList().tasks.map((t) => t.displayId)).toEqual(['ENG-1', 'ENG-2']);
    expect(rowFetches(s)).toHaveLength(1);
    s.c.refresh();
    await s.c.idle();
    expect(rowFetches(s)).toHaveLength(1);
    expect(blobOf(s)!.databases[0]!.idPrefix).toBe('ENG');
  });
});

describe('task detail', () => {
  test('task detail of a chosen database returns body and properties', async () => {
    const s = await withDatabases([backlogLink]);
    const r = await s.c.task(PRICING);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.task).toMatchObject({
      id: PRICING, displayId: 'ENG-2', title: 'Pricing page copy review', status: { name: 'Review', color: '#8B5CF6' },
      listName: 'Engineering Backlog', url: `https://app.notion.com/p/${PRICING}`
    });
    expect(r.task.body).toContain('Prompt-injection sample');
  });

  test('task of a removed database is gone', async () => {
    const s = await withDatabases([backlogLink]);
    expect(titles(s)).toContain('Pricing page copy review');
    await s.c.removeSource(BACKLOG.source);
    expect(s.c.taskList().tasks).toEqual([]);
    expect(await s.c.task(PRICING)).toEqual({ ok: false, reason: 'gone' });
    // The link a session's chip holds still opens.
    expect(s.c.taskUrl(PRICING)).toBe(`https://app.notion.com/p/${PRICING}`);
  });

  test('a page id from outside the chosen databases is gone', async () => {
    const s = await withDatabases([sprintLink]);
    expect(await s.c.task(PRICING)).toEqual({ ok: false, reason: 'gone' });
    expect(await s.c.task(ENGINEERING_PAGE)).toEqual({ ok: false, reason: 'gone' });
    expect(await s.c.task(SPRINT.db)).toEqual({ ok: false, reason: 'gone' });
    // Notion was asked (the parent check refused them, not the id check).
    expect(fetchIds(s)).toEqual(expect.arrayContaining([PRICING, ENGINEERING_PAGE]));
    expect(await s.c.task('not-an-id')).toEqual({ ok: false, reason: 'gone' });
  });

  test('task links: the web page and the Notion app', async () => {
    const s = await connected();
    expect(s.c.isTaskId(PRICING)).toBe(true);
    expect(s.c.isTaskId('00000004-0000-4000-8000-000000000004')).toBe(false);
    expect(s.c.taskUrl(PRICING)).toBe(`https://www.notion.so/${PRICING}`);
    expect(s.c.appUrl(PRICING)).toBe(`notion://www.notion.so/${PRICING}`);
    expect(s.c.appUrl('x')).toBeNull();
  });
});

describe('search', () => {
  test('search after a mapped column is renamed (no list refresh since) reads the schema again: Shipped stays hidden', async () => {
    const s = await withDatabases([backlogLink], { focused: false });
    s.fake.setScenario('rename-stage');
    await s.clock.advance(STALE_MS);
    const n = s.fake.calls().length;
    expect(await s.c.search('ship')).toEqual([]);
    expect(s.fake.calls().slice(n)).toEqual(['notion-fetch', 'notion-query-data-sources']);
    expect((await s.c.search('pricing')).map((t) => [t.title, t.status.name])).toEqual([['Pricing page copy review', 'Review']]);
  });

  test('search uses rows title contains, never notion-search', async () => {
    const s = await withDatabases([sprintLink, backlogLink]);
    const n = s.fake.calls().length;
    expect((await s.c.search('pricing')).map((t) => t.title)).toEqual(['Pricing page copy review']);
    // The list's own filters still apply: the unassigned task is not found.
    expect(await s.c.search('onboarding')).toEqual([]);
    const after = s.fake.callDetails().slice(n);
    expect(after.map((c) => c.name)).toEqual(Array(4).fill('notion-query-data-sources'));
    expect(JSON.stringify(after[1]!.arguments)).toContain('{"type":"property","property":"Title","propertyType":"title","operator":"string_contains","value":{"type":"exact","value":"pricing"}}');
    expect((after[1]!.arguments as { data: { limit: number } }).data.limit).toBe(25);
  });

  test('a new search stops the one still running (no pile-up of rows queries while the user types)', async () => {
    const g = gated();
    const s = await withDatabases([sprintLink, backlogLink], { transport: g.transport });
    const n = s.fake.calls().length;
    g.arm();
    const first = s.c.search('pri');
    await g.reached(); // its Sprint query is held
    const second = s.c.search('pricing');
    g.release();
    expect(await first).toEqual([]);
    expect((await second).map((t) => t.title)).toEqual(['Pricing page copy review']);
    // Only the second search's two queries reached Notion: the first sent nothing more once stopped.
    expect(s.fake.calls().slice(n)).toEqual(['notion-query-data-sources', 'notion-query-data-sources']);
  });
});

describe('tokens', () => {
  test('an expired access token is refreshed before listing', async () => {
    const s = await withDatabases([sprintLink], { focused: false });
    const before = blobOf(s)!;
    await s.clock.advance(before.expiresAt! - s.clock.now() - 30_000);
    s.fake.expireAccessTokens(); // the old token would now be refused
    const mark = s.requests.length;
    s.c.refresh();
    await s.c.idle();
    const after = s.requests.slice(mark);
    expect(after.indexOf('/token')).toBeGreaterThanOrEqual(0);
    expect(after.indexOf('/token')).toBeLessThan(after.indexOf('/mcp'));
    const b = blobOf(s)!;
    add(b.token); add(b.refresh);
    expect(b.token).not.toBe(before.token);
    expect(b.refresh).not.toBe(before.refresh);
    expect(s.c.info().status).toBe('connected');
    expect(titles(s)).toHaveLength(2);
  });

  test('a database removed while signing in again stays removed', async () => {
    const g = gated();
    const s = await withDatabases([sprintLink, backlogLink], { transport: g.transport });
    s.fake.revokeRefresh();
    s.fake.expireAccessTokens();
    s.c.refresh();
    await s.c.idle();
    expect(s.c.info().status).toBe('reconnect');
    g.arm();
    s.c.connect(1);
    await g.reached(); // the sign-in's first list: Sprint's rows query is held
    await s.c.removeSource(BACKLOG.source);
    g.release();
    await s.c.idle();
    const b = blobOf(s)!;
    add(b.token); add(b.refresh); add(b.clientId);
    expect(s.c.info().status).toBe('connected');
    expect(s.c.info().sources!.map((x) => x.id)).toEqual([SPRINT.source]);
    expect(b.databases.map((d) => d.id)).toEqual([SPRINT.db]);
    expect(titles(s)).toHaveLength(2);
  });

  test('a refused refresh → reconnect; connecting again keeps the databases', async () => {
    const s = await withDatabases([sprintLink]);
    s.fake.revokeRefresh();
    s.fake.expireAccessTokens();
    s.c.refresh();
    await s.c.idle();
    expect(s.c.info()).toMatchObject({ status: 'reconnect', reason: 'signed-out' });
    const b = blobOf(s)!;
    expect(b.token).toBeNull();
    expect(b).not.toHaveProperty('refresh');
    expect(b.databases.map((d) => d.id)).toEqual([SPRINT.db]);
    s.c.connect(1);
    await s.c.idle();
    expect(s.c.info()).toMatchObject({ status: 'connected', sources: [{ id: SPRINT.source }] });
    expect(titles(s)).toHaveLength(2);
    const again = blobOf(s)!;
    add(again.token); add(again.refresh); add(again.clientId);
  });
});

describe('automations\' reads: only the chosen databases', () => {
  test('watch: the chosen database\'s rows, as the list reads them, with their scope and status', async () => {
    const s = await withDatabases([SPRINT.db]);
    const listed = s.c.taskList().tasks;
    const { tasks: watched, complete } = await s.c.watch([SPRINT.source]);
    expect(complete).toBe(true);
    expect(watched.map((t) => t.id).sort()).toEqual(listed.map((t) => t.id).sort());
    expect(watched.every((t) => t.scope === SPRINT.source)).toBe(true);
    expect(watched.map((t) => t.status)).toEqual(listed.map((t) => t.status.name));
  });

  test('watch: a database with more rows than one query returns is read as not complete (queued runs never skipped for it)', async () => {
    const s = await withDatabases([SPRINT.db], {
      wrap: (c) => ({
        listTools: (o) => c.listTools(o),
        callTool: (async (name, args, o) => {
          const r = await c.callTool(name, args, o);
          return name === 'notion-query-data-sources' ? { ...(r as object), has_more: true } : r;
        }) as typeof c.callTool
      })
    });
    const { tasks, complete } = await s.c.watch([SPRINT.source]);
    expect(tasks.length).toBeGreaterThan(0);
    expect(complete).toBe(false);
  });

  test('a database that isn\'t chosen is never read, whatever the automation names', async () => {
    const s = await withDatabases([SPRINT.db]);
    const before = callsOf(s, 'notion-query-data-sources').length;
    expect(await s.c.watch([BACKLOG.source])).toEqual({ tasks: [], complete: true });
    expect(callsOf(s, 'notion-query-data-sources').length).toBe(before);
  });

  test('definedStatuses: the chosen databases\' open status options, from the schema in memory; never another database', async () => {
    const s = await withDatabases([SPRINT.db, BACKLOG.db]);
    const fetches = callsOf(s, 'notion-fetch').length;
    expect(await s.c.definedStatuses([SPRINT.source, BACKLOG.source, '0b1c2d3e4f5061728394a5b6c7d8e9f0'])).toEqual([
      { name: 'Not started' }, { name: 'In progress', color: '#60A5FA' }, { name: 'Backlog' }, { name: 'Doing', color: '#60A5FA' }, { name: 'Review', color: '#8B5CF6' }
    ]);
    expect(callsOf(s, 'notion-fetch').length).toBe(fetches); // both schemas were read by the list
  });

  test('scopes: the chosen databases, by name', async () => {
    const s = await withDatabases([SPRINT.db, BACKLOG.db]);
    const scopes = await s.c.scopes();
    expect(scopes.map((x) => x.id).sort()).toEqual([BACKLOG.source, SPRINT.source].sort());
    expect(scopes.every((x) => x.label.length > 0)).toBe(true);
  });
});
