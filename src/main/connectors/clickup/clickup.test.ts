import { existsSync, mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { afterEach, describe, expect, test } from 'vitest';
import type { ConnectorNotice } from '@shared/tasks';
import { startFakeClickUp, type FakeClickUp, type FakeScenario } from '../../../../tests/fixtures/fake-clickup.mjs';
import { fetchTransport } from '../../../../tests/support/fetch-transport';
import { manualClock, type ManualClock } from '../../../../tests/support/manual-clock';
import type { Transport } from '../http';
import { createSecretStore, type SecretStore } from '../secret-store';
import { testSafeStorage } from '../test-safe-storage';
import { ClickUpConnector, BACKOFF_MS, CONNECT_TIMEOUT_MS, LIST_COLORS_BUDGET_MS, LIST_COLORS_TTL_MS, OP_DEADLINE_MS, POLL_MS, STALE_MS, workspaceLabel } from './clickup';
import { clickupEndpoint } from './config';
import { followAuthorize } from '../oauth/follow-auth';
import { ALLOWED_TOOLS } from './tools';
import type { AuthOpener } from '../oauth/oauth';

// The ClickUp connector's status machine, one test per state, against the local fake ClickUp
// (real HTTP on 127.0.0.1) with a manual clock for every wait. Never the real ClickUp.

let fakes: FakeClickUp[] = [];
let connectors: ClickUpConnector[] = [];
/** Every secret the flows handled (sniffed on the wire) and every line the connectors logged. */
const secrets = new Set<string>();
const logged: string[] = [];
afterEach(async () => {
  for (const c of connectors.splice(0)) c.dispose();
  // Suite-level: whatever a test did, the fake never saw a tool outside the read-only allowlist…
  for (const f of fakes) expect(f.calls().filter((n) => !ALLOWED_TOOLS.has(n))).toEqual([]);
  // …and no log line carries a token, a code, a verifier, a state, a challenge or the client registration.
  for (const s of secrets) for (const line of logged) expect(line).not.toContain(s);
  secrets.clear();
  logged.length = 0;
  await Promise.all(fakes.splice(0).map((f) => f.close()));
});

/** Records the secrets crossing the wire: Bearer tokens, authorize parameters, callback parameters, the token form. */
function sniffing(t: Transport): Transport {
  const add = (v: string | null | undefined) => { if (v && v.length >= 8) secrets.add(v); };
  return async (req, signal) => {
    add(req.headers?.authorization?.replace(/^Bearer /, ''));
    const u = new URL(req.url);
    if (u.pathname.endsWith('/oauth/authorize')) for (const k of ['client_id', 'state', 'code_challenge']) add(u.searchParams.get(k));
    if (req.body?.includes('code_verifier')) {
      const form = new URLSearchParams(req.body);
      for (const k of ['code', 'code_verifier', 'client_id']) add(form.get(k));
    }
    const res = await t(req, signal);
    if (res.location) { const q = new URL(res.location, u).searchParams; add(q.get('code')); add(q.get('state')); }
    return res;
  };
}

type Opener = 'follow' | 'none' | AuthOpener;

interface Setup {
  scenario?: FakeScenario;
  opener?: Opener;
  available?: boolean;
  focused?: boolean;
  home?: string;
  fake?: FakeClickUp;
  clock?: ManualClock;
  transport?: (base: Transport) => Transport;
  bind?: (srv: Server) => Promise<void>;
}

async function setup(o: Setup = {}) {
  const fake = o.fake ?? await startFakeClickUp({ scenario: o.scenario ?? 'normal' });
  if (!o.fake) fakes.push(fake);
  const home = o.home ?? mkdtempSync(join(tmpdir(), 'atl-clickup-'));
  const store = createSecretStore(home, testSafeStorage({ available: o.available ?? true }));
  const writes: string[] = [];
  const spied: SecretStore = { ...store, write: (id, v) => { writes.push(v); store.write(id, v); } };
  const clock = o.clock ?? manualClock();
  const endpoint = clickupEndpoint(fake.url);
  const requests: string[] = [];
  const base = sniffing(fetchTransport((u) => requests.push(new URL(u).pathname)));
  const transport = o.transport ? o.transport(base) : base;
  const opened: string[] = [];
  const delivers: ((cb: string) => void)[] = [];
  const opener = o.opener ?? 'follow';
  const openAuthPage: AuthOpener = (url, deliver) => {
    opened.push(url);
    delivers.push(deliver);
    if (opener === 'follow') followAuthorize(transport, endpoint.allow)(url, deliver);
    else if (typeof opener === 'function') opener(url, deliver);
  };
  const state = { focused: o.focused ?? true };
  const notices: ConnectorNotice[] = [];
  const origins: (number | undefined)[] = [];
  const reveals: (number | undefined)[] = [];
  const logs: string[] = [];
  let changes = 0;
  const c = new ClickUpConnector({
    store: spied, endpoint, transport, openAuthPage, clock, focused: () => state.focused,
    log: (m) => { logs.push(m); logged.push(m); }, onChange: () => { changes++; }, onNotice: (n, origin) => { notices.push(n); origins.push(origin); },
    reveal: (origin) => reveals.push(origin), ...(o.bind ? { loopback: { bind: o.bind } } : {})
  });
  connectors.push(c);
  c.init();
  return { fake, home, store, writes, clock, c, opened, delivers, state, notices, origins, reveals, logs, requests, changes: () => changes };
}

const blobOf = (s: { store: SecretStore }) => {
  const raw = s.store.read('clickup');
  return raw === null ? null : JSON.parse(raw) as { token: string | null; userId: string; account?: string; workspace: { id: string; name: string }; options: { includeClosed: boolean } };
};

async function connected(o: Setup = {}) {
  const s = await setup(o);
  s.c.connect(1);
  await s.c.idle();
  expect(s.c.info().status).toBe('connected');
  return s;
}

const redirectOf = (url: string) => new URL(url).searchParams.get('redirect_uri')!;

describe('connect', () => {
  test('connected: account from the tasks, workspace = hierarchy root, tasks cached, window brought forward', async () => {
    const s = await connected();
    const info = s.c.info();
    expect(info).toMatchObject({ id: 'clickup', name: 'ClickUp', status: 'connected', account: 'Ada Fake', workspace: 'Fakeworks', loading: false });
    expect(info.reason).toBeUndefined();
    expect(info.updatedAt).toBe(s.clock.now());
    const list = s.c.taskList();
    expect(list.status).toBe('connected');
    expect(list.tasks.map((t) => t.displayId)).toEqual(expect.arrayContaining(['ENG-101', '86fk0002b', 'ENG-103']));
    expect(list.tasks.map((t) => t.displayId)).not.toContain('ENG-090'); // closed
    expect(s.reveals).toEqual([1]);
    expect(s.notices).toEqual([]);
    // The sniffer saw the flow's secrets (the suite's log check is not vacuous).
    expect(secrets.size).toBeGreaterThanOrEqual(5);
  });

  test('the token is stored only after the account and workspace are resolved and the first fetch is in', async () => {
    const s = await setup();
    const callsAtWrite: string[][] = [];
    const write = s.store.write;
    s.store.write = (id, v) => { callsAtWrite.push(s.fake.calls()); write(id, v); };
    s.c.connect(1);
    await s.c.idle();
    expect(s.writes).toHaveLength(1);
    const blob = blobOf(s)!;
    expect(blob.token).toMatch(/^fkat_/);
    expect(blob).toMatchObject({ userId: '81000001', account: 'Ada Fake', workspace: { id: '9015000001', name: 'Fakeworks' }, options: { includeClosed: false } });
    const order = s.fake.calls();
    expect(order.slice(0, 3)).toEqual(['clickup_resolve_assignees', 'clickup_get_workspace_hierarchy', 'clickup_filter_tasks']);
  });

  test('no assigned task: no account name (the card says "Connected · <workspace>")', async () => {
    const fake = await startFakeClickUp();
    fakes.push(fake);
    fake.fixtures.tasks.length = 0;
    const s = await connected({ fake });
    expect(s.c.info().account).toBeUndefined();
    expect(s.c.info().workspace).toBe('Fakeworks');
  });

  test('two windows: one flow app-wide; Connect from the second window focuses it (the page again), never a second flow', async () => {
    let hold!: AuthOpener;
    const s = await setup({ opener: (url, deliver) => { hold = () => followAuthorize(fetchTransport(), clickupEndpoint(s.fake.url).allow)(url, deliver); } });
    s.c.connect(1);
    await expect.poll(() => s.opened.length).toBe(1);
    s.c.connect(2);
    expect(s.c.info().status).toBe('connecting');
    // The running flow's page opens again (same URL, from main: the renderer never sees it); no new registration.
    expect(s.opened).toEqual([s.opened[0], s.opened[0]]);
    // "Open the page again" does the same.
    s.c.reopenAuth();
    expect(s.opened).toEqual([s.opened[0], s.opened[0], s.opened[0]]);
    hold('', () => undefined);
    await s.c.idle();
    expect(s.c.info().status).toBe('connected');
    expect(s.reveals).toEqual([1]);
    expect(s.requests.filter((p) => p === '/oauth/register')).toHaveLength(1);
  });

  test('connecting shows when the 5 minute wait ends', async () => {
    const s = await setup({ opener: 'none' });
    s.c.connect(1);
    expect(s.c.info()).toMatchObject({ status: 'connecting', connectingUntil: s.clock.now() + CONNECT_TIMEOUT_MS });
    s.c.cancel();
    await s.c.idle();
  });
});

describe('failures while connecting', () => {
  test('browser closed / never finished: after 5 minutes → disconnected, toast "timed out", listener closed, nothing stored', async () => {
    const s = await setup({ opener: 'none' });
    s.c.connect(1);
    await expect.poll(() => s.opened.length).toBe(1);
    await s.clock.advance(CONNECT_TIMEOUT_MS - 1);
    expect(s.c.info().status).toBe('connecting');
    await s.clock.advance(1);
    await s.c.idle();
    expect(s.c.info()).toMatchObject({ status: 'disconnected', reason: 'timeout' });
    expect(s.notices).toEqual([{ id: 'clickup', kind: 'timeout' }]);
    expect(s.origins).toEqual([1]);
    await expect(fetch(redirectOf(s.opened[0]!))).rejects.toThrow();
    expect(s.writes).toEqual([]);
    expect(s.clock.pending()).toBe(0);
  });

  test('Cancel → listener closed, disconnected, no toast, no reason', async () => {
    const s = await setup({ opener: 'none' });
    s.c.connect(1);
    await expect.poll(() => s.opened.length).toBe(1);
    s.c.cancel();
    await s.c.idle();
    expect(s.c.info().status).toBe('disconnected');
    expect(s.c.info().reason).toBeUndefined();
    expect(s.notices).toEqual([]);
    await expect(fetch(redirectOf(s.opened[0]!))).rejects.toThrow();
    expect(s.clock.pending()).toBe(0);
  });

  test('user denies access → disconnected, "You didn\'t allow access"', async () => {
    const s = await setup({ scenario: 'authorize-denied' });
    s.c.connect(1);
    await s.c.idle();
    expect(s.c.info()).toMatchObject({ status: 'disconnected', reason: 'denied' });
    expect(s.notices).toEqual([{ id: 'clickup', kind: 'denied' }]);
  });

  test('other OAuth error → disconnected, "ClickUp said: <description>"', async () => {
    const fake = await startFakeClickUp();
    fakes.push(fake);
    fake.setScenario('authorize-error', { description: 'Temporarily unavailable' });
    const s = await setup({ fake });
    s.c.connect(1);
    await s.c.idle();
    expect(s.c.info()).toMatchObject({ status: 'disconnected', reason: 'oauth-error', detail: 'Temporarily unavailable' });
    expect(s.notices).toEqual([{ id: 'clickup', kind: 'oauth-error', detail: 'Temporarily unavailable' }]);
  });

  test.each(['authorize-wrong-state', 'authorize-wrong-iss'] as const)('%s → flow aborted, "Couldn\'t verify ClickUp\'s reply"', async (scenario) => {
    const s = await setup({ scenario });
    s.c.connect(1);
    await s.c.idle();
    expect(s.c.info()).toMatchObject({ status: 'disconnected', reason: 'verify-failed' });
    expect(s.notices).toEqual([{ id: 'clickup', kind: 'verify-failed' }]);
    expect(s.writes).toEqual([]);
  });

  test('a second callback → flow aborted, nothing stored', async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    let delivered = 0;
    const s = await setup({
      transport: (base) => async (req, signal) => { if (req.url.endsWith('/oauth/token')) await held; return base(req, signal); },
      opener: (url, deliver) => {
        const count = (cb: string) => { deliver(cb); if (++delivered === 2) release(); };
        const follow = followAuthorize(fetchTransport(), clickupEndpoint(s.fake.url).allow);
        follow(url, count);
        follow(url, count);
      }
    });
    s.c.connect(1);
    await s.c.idle();
    expect(s.c.info()).toMatchObject({ status: 'disconnected', reason: 'verify-failed' });
    expect(s.writes).toEqual([]);
  });

  test('the port can\'t be opened (×4) → disconnected with the error', async () => {
    const s = await setup({ bind: () => Promise.reject(Object.assign(new Error('in use'), { code: 'EADDRINUSE' })) });
    s.c.connect(1);
    await s.c.idle();
    expect(s.c.info()).toMatchObject({ status: 'disconnected', reason: 'port-failed', detail: 'EADDRINUSE' });
    expect(s.notices).toEqual([{ id: 'clickup', kind: 'port-failed', detail: 'EADDRINUSE' }]);
  });

  test.each(['discovery-network-error', 'token-network-error'] as const)('%s → disconnected, "Can\'t reach ClickUp"', async (scenario) => {
    const s = await setup({ scenario });
    s.c.connect(1);
    await s.c.idle();
    expect(s.c.info()).toMatchObject({ status: 'disconnected', reason: 'network' });
    expect(s.notices).toEqual([{ id: 'clickup', kind: 'network' }]);
  });

  test.each(['discovery-no-s256', 'discovery-no-dcr', 'discovery-no-none'] as const)('%s → unavailable, "ClickUp changed how apps sign in"', async (scenario) => {
    const s = await setup({ scenario });
    s.c.connect(1);
    await s.c.idle();
    expect(s.c.info()).toMatchObject({ status: 'unavailable', reason: 'auth-unsupported' });
    expect(s.notices).toEqual([{ id: 'clickup', kind: 'auth-unsupported' }]);
    expect(s.opened).toEqual([]);
  });

  test('Keychain unavailable → Connect refused before any request', async () => {
    const s = await setup({ available: false });
    s.c.connect(1);
    await s.c.idle();
    expect(s.c.info()).toMatchObject({ status: 'disconnected', reason: 'keychain-unavailable' });
    expect(s.notices).toEqual([{ id: 'clickup', kind: 'keychain-unavailable' }]);
    expect(s.requests).toEqual([]);
  });

  test('a tool missing from tools/list at Connect → unavailable "connector changed", nothing stored', async () => {
    const s = await setup({ scenario: 'tool-missing' });
    s.c.connect(1);
    await s.c.idle();
    expect(s.c.info()).toMatchObject({ status: 'unavailable', reason: 'connector-changed' });
    expect(s.notices).toEqual([{ id: 'clickup', kind: 'unavailable', reason: 'connector-changed' }]);
    expect(s.writes).toEqual([]);
    expect(s.logs.join('\n')).toContain('clickup_get_task');
  });

  test('401 on the first fetch right after a first Connect → disconnected "couldn\'t load", never a fake "signed out"', async () => {
    // Nothing was ever saved: there is no one to sign out, and `reconnect` with nothing saved would silently become
    // `disconnected` at the next launch.
    const s = await setup({ scenario: 'mcp-401' });
    s.c.connect(1);
    await s.c.idle();
    expect(s.c.info()).toMatchObject({ status: 'disconnected', reason: 'fetch-failed' });
    expect(s.writes).toEqual([]);
    expect(blobOf(s)).toBeNull();
    expect(s.notices).toEqual([{ id: 'clickup', kind: 'fetch-failed' }]);
    expect(s.c.info().workspace).toBeUndefined();
  });

  test('401 right after a Reconnect from a signed-out connection → still `reconnect`, signed out', async () => {
    const first = await connected();
    first.fake.revokeTokens();
    first.c.refresh();
    await first.c.idle();
    expect(first.c.info()).toMatchObject({ status: 'reconnect', reason: 'signed-out' });
    first.fake.setScenario('mcp-401');
    first.c.connect(1);
    await first.c.idle();
    expect(first.c.info()).toMatchObject({ status: 'reconnect', reason: 'signed-out', workspace: 'Fakeworks' });
  });

  test('401 right after a Reconnect from an unreadable connection → still `reconnect` (the blob is still on disk), why on the card', async () => {
    const home = mkdtempSync(join(tmpdir(), 'atl-clickup-'));
    mkdirSync(join(home, 'connectors'), { recursive: true });
    writeFileSync(join(home, 'connectors', 'clickup.bin'), 'garbage');
    const s = await setup({ home, scenario: 'mcp-401' });
    expect(s.c.info()).toMatchObject({ status: 'reconnect', reason: 'unreadable' });
    s.c.connect(1);
    await s.c.idle();
    expect(s.c.info()).toMatchObject({ status: 'reconnect', reason: 'fetch-failed' });
    expect(s.c.info().workspace).toBeUndefined();
    expect(s.notices).toEqual([{ id: 'clickup', kind: 'reconnect', reason: 'unreadable' }, { id: 'clickup', kind: 'fetch-failed' }]);
  });

  test('unavailable after Connect (sign-in unsupported): Retry starts Connect again and re-checks', async () => {
    const s = await setup({ scenario: 'discovery-no-s256' });
    s.c.connect(1);
    await s.c.idle();
    expect(s.c.info()).toMatchObject({ status: 'unavailable', reason: 'auth-unsupported' });
    const discoveries = () => s.requests.filter((p) => p === '/.well-known/oauth-authorization-server').length;
    expect(discoveries()).toBe(1);
    s.c.refresh();
    await s.c.idle();
    expect(discoveries()).toBe(2);
    expect(s.c.info()).toMatchObject({ status: 'unavailable', reason: 'auth-unsupported' });
  });

  test.each(['tool-missing', 'workspace-gone'] as const)('unavailable after Connect (%s, nothing stored): fixed on ClickUp\'s side → Retry → connected', async (scenario) => {
    const s = await setup({ scenario });
    s.c.connect(1);
    await s.c.idle();
    expect(s.c.info().status).toBe('unavailable');
    expect(s.writes).toEqual([]);
    s.fake.setScenario('normal');
    s.c.refresh();
    await s.c.idle();
    expect(s.c.info().status).toBe('connected');
    expect(blobOf(s)!.token).toMatch(/^fkat_/);
  });

  test('starting Connect drops an in-flight refresh: its late reply never overwrites `connecting`', async () => {
    let follow = true;
    const fake = await startFakeClickUp();
    fakes.push(fake);
    const s = await connected({
      fake, opener: (url, deliver) => { if (follow) followAuthorize(fetchTransport(), clickupEndpoint(fake.url).allow)(url, deliver); }
    });
    follow = false;
    s.fake.setScenario('workspace-gone');
    s.c.refresh();
    await s.c.idle();
    expect(s.c.info().status).toBe('unavailable');
    s.fake.setScenario('slow', { delayMs: 150 });
    s.c.refresh(); // Retry: a refresh with the saved token, in flight
    expect(s.c.info().loading).toBe(true);
    s.c.connect(1);
    expect(s.c.info()).toMatchObject({ status: 'connecting', loading: false });
    await new Promise((r) => setTimeout(r, 400));
    expect(s.c.info().status).toBe('connecting');
    s.c.cancel();
    await s.c.idle();
  });

  test('app quits during Connect → nothing stored, even when the callback lands afterwards', async () => {
    const s = await setup({ opener: 'none' });
    s.c.connect(1);
    await expect.poll(() => s.opened.length).toBe(1);
    s.c.dispose();
    followAuthorize(fetchTransport(), clickupEndpoint(s.fake.url).allow)(s.opened[0]!, s.delivers[0]!);
    await s.c.idle();
    await new Promise((r) => setTimeout(r, 100));
    expect(s.writes).toEqual([]);
    expect(existsSync(s.store.path('clickup'))).toBe(false);
    expect(s.notices).toEqual([]);
    expect(s.clock.pending()).toBe(0);
  });
});

describe('launch', () => {
  test('a stored connection: connected at once, tasks fetched right away', async () => {
    const first = await connected();
    const s = await setup({ fake: first.fake, home: first.home });
    expect(s.c.info()).toMatchObject({ status: 'connected', account: 'Ada Fake', workspace: 'Fakeworks' });
    await s.c.idle();
    expect(s.c.taskList().tasks.length).toBeGreaterThan(0);
  });

  test('a blob that can\'t be read → reconnect ("unreadable"), one notice', async () => {
    const home = mkdtempSync(join(tmpdir(), 'atl-clickup-'));
    mkdirSync(join(home, 'connectors'), { recursive: true });
    writeFileSync(join(home, 'connectors', 'clickup.bin'), 'garbage');
    const s = await setup({ home });
    expect(s.c.info()).toMatchObject({ status: 'reconnect', reason: 'unreadable' });
    // The toast says why (not "signed you out"); nothing saved, so no workspace on the card.
    expect(s.notices).toEqual([{ id: 'clickup', kind: 'reconnect', reason: 'unreadable' }]);
    expect(s.c.info().workspace).toBeUndefined();
    expect(s.requests).toEqual([]);
  });

  test('the Keychain gone at launch with a blob on disk → reconnect', async () => {
    const first = await connected();
    const s = await setup({ fake: first.fake, home: first.home, available: false });
    expect(s.c.info()).toMatchObject({ status: 'reconnect', reason: 'unreadable' });
  });

  test('Reconnect from `reconnect` replaces the saved connection', async () => {
    const first = await connected();
    first.fake.revokeTokens();
    first.c.refresh();
    await first.c.idle();
    expect(first.c.info().status).toBe('reconnect');
    first.c.connect(1);
    await first.c.idle();
    expect(first.c.info().status).toBe('connected');
    expect(blobOf(first)!.token).toMatch(/^fkat_/);
  });

  test('Cancel during Reconnect goes back to `reconnect`', async () => {
    const first = await connected();
    first.fake.revokeTokens();
    first.c.refresh();
    await first.c.idle();
    const s = await setup({ fake: first.fake, home: first.home, opener: 'none' });
    expect(s.c.info().status).toBe('reconnect');
    s.c.connect(1);
    s.c.cancel();
    await s.c.idle();
    expect(s.c.info().status).toBe('reconnect');
  });
});

describe('while connected', () => {
  test('offline (5xx) → cached tasks kept with their time, backoff 30 s → 1 → 2 → 4 → 5 min, back to connected on success', async () => {
    const s = await connected();
    const before = s.c.taskList();
    s.fake.setScenario('mcp-500');
    await s.clock.advance(STALE_MS);
    s.c.refresh();
    await s.c.idle();
    expect(s.c.info().status).toBe('offline');
    const offline = s.c.taskList();
    expect(offline.status).toBe('offline');
    expect(offline.tasks).toEqual(before.tasks);
    expect(offline.updatedAt).toBe(before.updatedAt);
    expect(BACKOFF_MS).toEqual([30_000, 60_000, 120_000, 240_000, 300_000]);
    const fetches = () => s.fake.calls().filter((n) => n === 'clickup_filter_tasks').length;
    for (const wait of [30_000, 60_000, 120_000, 240_000, 300_000, 300_000]) {
      const before = fetches();
      await s.clock.advance(wait - 1);
      await s.c.idle();
      expect(fetches()).toBe(before);
      await s.clock.advance(1);
      await s.c.idle();
      expect(fetches()).toBe(before + 1);
      expect(s.c.info().status).toBe('offline');
    }
    s.fake.setScenario('normal');
    await s.clock.advance(300_000);
    await s.c.idle();
    expect(s.c.info().status).toBe('connected');
    expect(s.c.info().updatedAt).toBe(s.clock.now());
    // Backoff reset: the next failure waits 30 s again.
    s.fake.setScenario('mcp-500');
    s.c.refresh();
    await s.c.idle();
    expect(s.c.info().status).toBe('offline');
    expect(s.clock.dueIn()).toContain(30_000);
  });

  test('offline (network error) → offline', async () => {
    const s = await connected();
    s.fake.setScenario('mcp-network-error');
    s.c.refresh();
    await s.c.idle();
    expect(s.c.info().status).toBe('offline');
  });

  test('a call that hangs hits the 30 s deadline → offline', async () => {
    const s = await connected();
    s.fake.setScenario('slow');
    s.c.refresh();
    await expect.poll(() => s.c.info().loading).toBe(true);
    await s.clock.advance(OP_DEADLINE_MS);
    await s.c.idle();
    expect(s.c.info().status).toBe('offline');
  });

  test('one 30 s deadline for a whole refresh (every page), not one per call: offline at 30 s', async () => {
    const fake = await startFakeClickUp({ pageSize: 1 });
    fakes.push(fake);
    const clock = manualClock();
    let slowPages = false;
    // Each page takes 20 s on the manual clock: page 1 ends at 20 s, page 2 would end at 40 s.
    const s = await connected({
      fake, clock,
      transport: (base) => async (req, signal) => {
        if (slowPages && req.body?.includes('clickup_filter_tasks')) await clock.advance(20_000);
        return base(req, signal);
      }
    });
    expect(fake.calls().filter((n) => n === 'clickup_filter_tasks').length).toBeGreaterThan(1); // paged
    slowPages = true;
    s.c.refresh();
    await s.c.idle();
    expect(s.c.info().status).toBe('offline');
  });

  test('429 → waits for x-ratelimit-reset, cache kept, status unchanged; no request before the reset', async () => {
    const s = await connected();
    s.fake.setScenario('mcp-429', { resetInSeconds: 30 });
    s.c.refresh();
    await s.c.idle();
    expect(s.c.info().status).toBe('connected');
    expect(s.c.info().reason).toBeUndefined();
    const calls = s.fake.calls().length;
    s.c.refresh();
    await s.c.idle();
    expect(s.fake.calls().length).toBe(calls);
    s.fake.setScenario('normal');
    await s.clock.advance(31_000);
    await s.c.idle();
    expect(s.fake.calls().length).toBe(calls + 1);
    expect(s.c.info().status).toBe('connected');
  });

  test('429 for more than a minute → "Slowing down…" until the wait is over', async () => {
    const s = await connected();
    s.fake.setScenario('mcp-429', { resetInSeconds: 120 });
    s.c.refresh();
    await s.c.idle();
    expect(s.c.info()).toMatchObject({ status: 'connected', reason: 'slowing-down' });
    s.fake.setScenario('normal');
    await s.clock.advance(121_000);
    await s.c.idle();
    expect(s.c.info().status).toBe('connected');
    expect(s.c.info().reason).toBeUndefined();
  });

  test('401 → reconnect: tasks hidden, token dropped from the saved connection, timers stopped, one notice', async () => {
    const s = await connected();
    s.fake.revokeTokens();
    s.c.refresh();
    await s.c.idle();
    expect(s.c.info()).toMatchObject({ status: 'reconnect', reason: 'signed-out', account: 'Ada Fake', workspace: 'Fakeworks' });
    expect(s.c.taskList()).toMatchObject({ status: 'reconnect', tasks: [] });
    expect(blobOf(s)!.token).toBeNull();
    expect(s.notices).toEqual([{ id: 'clickup', kind: 'reconnect', reason: 'signed-out' }]);
    expect(s.clock.pending()).toBe(0);
    // Later polls, gets and refreshes don't call ClickUp and don't notify again.
    const calls = s.fake.calls().length;
    s.c.refresh();
    expect(await s.c.task('86fk0001a')).toEqual({ ok: false, reason: 'reconnect' });
    await s.clock.advance(POLL_MS * 2);
    await s.c.idle();
    expect(s.fake.calls().length).toBe(calls);
    expect(s.notices).toHaveLength(1);
  });

  test.each(['workspace-gone', 'workspace-gone-403'] as const)('%s → unavailable "workspace gone", tasks empty; Retry once it is back', async (scenario) => {
    const s = await connected();
    s.fake.setScenario(scenario);
    s.c.refresh();
    await s.c.idle();
    expect(s.c.info()).toMatchObject({ status: 'unavailable', reason: 'workspace-gone' });
    expect(s.c.taskList().tasks).toEqual([]);
    expect(s.notices).toEqual([{ id: 'clickup', kind: 'unavailable', reason: 'workspace-gone' }]);
    s.fake.setScenario('normal');
    s.c.refresh();
    await s.c.idle();
    expect(s.c.info().status).toBe('connected');
    expect(s.c.taskList().tasks.length).toBeGreaterThan(0);
  });

  test('schema changed → unavailable "connector changed", details in the log, tasks hidden', async () => {
    const s = await connected();
    s.fake.setScenario('schema-changed');
    s.c.refresh();
    await s.c.idle();
    expect(s.c.info()).toMatchObject({ status: 'unavailable', reason: 'connector-changed' });
    expect(s.c.taskList().tasks).toEqual([]);
    expect(s.logs.some((l) => /clickup_filter_tasks/.test(l))).toBe(true);
    // The toast says which: the card's own line.
    expect(s.notices).toEqual([{ id: 'clickup', kind: 'unavailable', reason: 'connector-changed' }]);
  });

  test('oversized reply → that call fails and is logged, the cache stays, status unchanged', async () => {
    const s = await connected();
    const before = s.c.taskList();
    s.fake.setScenario('oversized');
    await s.clock.advance(STALE_MS);
    s.c.refresh();
    await s.c.idle();
    expect(s.c.info().status).toBe('connected');
    expect(s.c.taskList().tasks).toEqual(before.tasks);
    expect(s.c.taskList().updatedAt).toBe(before.updatedAt);
    expect(s.logs.some((l) => /byte cap/.test(l))).toBe(true);
    expect(await s.c.task('86fk0001a')).toEqual({ ok: false, reason: 'failed' });
  });

  test('Disconnect deletes the saved connection, the cache and every timer', async () => {
    const s = await connected();
    expect(existsSync(s.store.path('clickup'))).toBe(true);
    const version = s.c.info().tasksVersion;
    s.c.disconnect();
    expect(existsSync(s.store.path('clickup'))).toBe(false);
    expect(s.c.info()).toMatchObject({ status: 'disconnected', loading: false, options: { show: 'assigned', includeClosed: false } });
    expect(s.c.info().account).toBeUndefined();
    expect(s.c.info().tasksVersion).toBeGreaterThan(version);
    expect(s.c.taskList()).toMatchObject({ status: 'disconnected', tasks: [] });
    expect(s.c.taskUrl('86fk0001a')).toBe('https://app.clickup.com/t/86fk0001a');
    expect(s.clock.pending()).toBe(0);
    await s.clock.advance(POLL_MS * 3);
    expect(s.fake.calls().length).toBe(3);
  });

  test('a refresh that succeeds while a failed task fetch scheduled a retry: connected, no retry left, only the poll', async () => {
    let failGets = false;
    const s = await connected({
      transport: (base) => async (req, signal) => {
        if (failGets && req.body?.includes('clickup_get_task')) throw new Error('network down');
        return base(req, signal);
      }
    });
    failGets = true;
    s.fake.setScenario('slow', { delayMs: 100 });
    await s.clock.advance(STALE_MS);
    s.c.refresh();
    expect(await s.c.task('86fk0001a')).toEqual({ ok: false, reason: 'offline' });
    await s.c.idle();
    await new Promise((r) => setTimeout(r, 200));
    await s.c.idle();
    expect(s.c.info().status).toBe('connected');
    expect(s.clock.dueIn()).toEqual([POLL_MS]);
  });

  test('workspace gone but the hierarchy has another root: that workspace is used and saved, polling goes on', async () => {
    let forbidOnce = false;
    const s = await connected({
      transport: (base) => async (req, signal) => {
        if (forbidOnce && req.body?.includes('clickup_filter_tasks')) {
          forbidOnce = false;
          return { status: 403, headers: {}, location: null, body: (async function* () { /* empty */ })(), close: () => undefined };
        }
        return base(req, signal);
      }
    });
    s.fake.fixtures.workspace.id = '9015000009';
    s.fake.fixtures.workspace.name = 'Newworks';
    forbidOnce = true;
    s.c.refresh();
    await s.c.idle();
    expect(s.c.info()).toMatchObject({ status: 'connected', workspace: 'Newworks' });
    expect(blobOf(s)!.workspace).toEqual({ id: '9015000009', name: 'Newworks' });
    expect(s.clock.dueIn()).toEqual([POLL_MS]);
    // From `unavailable` (Retry) too: the poll comes back.
    s.fake.setScenario('workspace-gone');
    s.c.refresh();
    await s.c.idle();
    expect(s.c.info().status).toBe('unavailable');
    expect(s.clock.pending()).toBe(0);
    s.fake.setScenario('normal');
    s.fake.fixtures.workspace.id = '9015000001';
    s.fake.fixtures.workspace.name = 'Fakeworks';
    forbidOnce = true;
    s.c.refresh();
    await s.c.idle();
    expect(s.c.info()).toMatchObject({ status: 'connected', workspace: 'Fakeworks' });
    expect(s.clock.dueIn()).toEqual([POLL_MS]);
  });

  test('Disconnect during a refresh: the late reply changes nothing', async () => {
    const s = await connected();
    s.fake.setScenario('slow', { delayMs: 200 });
    s.c.refresh();
    s.c.disconnect();
    await new Promise((r) => setTimeout(r, 300));
    await s.c.idle();
    expect(s.c.info().status).toBe('disconnected');
    expect(s.c.taskList().tasks).toEqual([]);
  });
});

describe('refresh rules', () => {
  test('tasks:list refreshes when the tasks are older than 60 s, never blocks, and bumps tasksVersion when they arrive', async () => {
    const s = await connected();
    const calls = () => s.fake.calls().filter((n) => n === 'clickup_filter_tasks').length;
    expect(calls()).toBe(1);
    s.c.taskList();
    await s.c.idle();
    expect(calls()).toBe(1);
    await s.clock.advance(STALE_MS);
    const version = s.c.info().tasksVersion;
    const list = s.c.taskList();
    expect(list.loading).toBe(true);
    expect(list.tasks.length).toBeGreaterThan(0);
    await s.c.idle();
    expect(calls()).toBe(2);
    expect(s.c.info().tasksVersion).toBeGreaterThan(version);
    expect(s.c.info().loading).toBe(false);
  });

  test('every 5 minutes while a window is focused; never while none is', async () => {
    const s = await connected({ focused: false });
    const calls = () => s.fake.calls().filter((n) => n === 'clickup_filter_tasks').length;
    await s.clock.advance(POLL_MS);
    await s.c.idle();
    expect(calls()).toBe(1);
    s.state.focused = true;
    await s.clock.advance(POLL_MS);
    await s.c.idle();
    expect(calls()).toBe(2);
  });

  test('a window gaining focus refreshes tasks older than 5 minutes', async () => {
    const s = await connected({ focused: false });
    const calls = () => s.fake.calls().filter((n) => n === 'clickup_filter_tasks').length;
    s.c.windowFocused();
    await s.c.idle();
    expect(calls()).toBe(1);
    await s.clock.advance(POLL_MS - 1);
    s.c.windowFocused();
    await s.c.idle();
    expect(calls()).toBe(1);
    await s.clock.advance(1);
    s.c.windowFocused();
    await s.c.idle();
    expect(calls()).toBe(2);
  });

  test('Include closed tasks: saved, and the tasks are fetched again with closed ones', async () => {
    const s = await connected();
    s.c.setOptions({ includeClosed: true });
    await s.c.idle();
    expect(s.c.info().options.includeClosed).toBe(true);
    expect(blobOf(s)!.options.includeClosed).toBe(true);
    expect(s.c.taskList().tasks.map((t) => t.displayId)).toContain('ENG-090');
    const last = s.fake.callDetails().filter((d) => d.name === 'clickup_filter_tasks').at(-1)!;
    expect(last.arguments).toMatchObject({ include_closed: true, assignees: ['81000001'] });
  });
});

describe('workspace name (ClickUp\'s MCP names every hierarchy root "Workspace")', () => {
  test('workspaceLabel: a real root name wins; "Workspace" or nothing → the spaces, two at most, then +N', () => {
    expect(workspaceLabel('Acme', ['acme'])).toBe('Acme');
    expect(workspaceLabel('Workspace', ['acme'])).toBe('acme');
    expect(workspaceLabel(' workspace ', ['acme', 'ops'])).toBe('acme, ops');
    expect(workspaceLabel('', ['acme', 'ops', 'web', 'data'])).toBe('acme, ops +2');
    expect(workspaceLabel('Workspace', ['acme'], 12)).toBe('acme +11'); // spaces beyond the first page
    expect(workspaceLabel('Workspace', [' ', 'acme\nteam'])).toBe('acme team');
    expect(workspaceLabel('Workspace', [])).toBe('');
  });

  test('Connect: the root is "Workspace" → the card shows the spaces, and that is what is saved', async () => {
    const s = await setup();
    s.fake.fixtures.workspace.name = 'Workspace';
    s.c.connect(1);
    await s.c.idle();
    expect(s.c.info()).toMatchObject({ status: 'connected', workspace: 'Engineering, Design' });
    expect(blobOf(s)!.workspace).toEqual({ id: '9015000001', name: 'Engineering, Design' });
  });

  test('Connect: no spaces either → no workspace name (empty, still saved)', async () => {
    const s = await setup();
    s.fake.fixtures.workspace.name = 'Workspace';
    s.fake.fixtures.workspace.children = [];
    s.c.connect(1);
    await s.c.idle();
    expect(s.c.info()).toMatchObject({ status: 'connected', workspace: '' });
  });

  test('a connection saved with the literal "Workspace" gets the spaces at the next refresh, once', async () => {
    const first = await setup();
    first.fake.fixtures.workspace.name = 'Workspace';
    first.c.connect(1);
    await first.c.idle();
    first.store.write('clickup', JSON.stringify({ ...blobOf(first)!, workspace: { id: '9015000001', name: 'Workspace' } }));
    const s = await setup({ fake: first.fake, home: first.home });
    expect(s.c.info().workspace).toBe('Workspace');
    await s.c.idle();
    expect(s.c.info()).toMatchObject({ status: 'connected', workspace: 'Engineering, Design' });
    expect(blobOf(s)!.workspace).toEqual({ id: '9015000001', name: 'Engineering, Design' });
    const hierarchyCalls = () => s.fake.calls().filter((n) => n === 'clickup_get_workspace_hierarchy').length;
    const before = hierarchyCalls();
    s.c.refresh();
    await s.c.idle();
    expect(hierarchyCalls()).toBe(before);
  });

  test('a v1 ClickUp connection saved before the refactor still loads', async () => {
    const fake = await startFakeClickUp();
    fakes.push(fake);
    const home = mkdtempSync(join(tmpdir(), 'atl-clickup-'));
    // Exactly what the release before the connectors core wrote (connectors/clickup.bin): no refresh fields.
    const v1 = `{"v":1,"token":"${fake.issueToken()}","userId":"81000001","account":"Ada Fake","workspace":{"id":"9015000001","name":"Fakeworks"},"options":{"includeClosed":true}}`;
    createSecretStore(home, testSafeStorage()).write('clickup', v1);
    const s = await setup({ fake, home });
    expect(s.c.info()).toMatchObject({ status: 'connected', account: 'Ada Fake', workspace: 'Fakeworks', options: { includeClosed: true } });
    await s.c.idle();
    expect(s.c.info()).toMatchObject({ status: 'connected', account: 'Ada Fake', workspace: 'Fakeworks' });
    expect(s.c.taskList().tasks.map((t) => t.displayId)).toContain('ENG-090'); // closed, shown: the option was read
    // Nothing to renew and nothing rewritten: the blob is still the v1 one, byte for byte.
    expect(s.writes).toEqual([]);
    expect(s.store.read('clickup')).toBe(v1);
  });
});

describe('task details, search and links', () => {
  test('task(id) → the detail; a gone task → gone; a malformed id → gone without a request', async () => {
    const s = await connected();
    const r = await s.c.task('86fk0001a');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.task).toMatchObject({ id: '86fk0001a', displayId: 'ENG-101' });
    expect(await s.c.task('86fkgone0')).toEqual({ ok: false, reason: 'gone' });
    const calls = s.fake.calls().length;
    expect(await s.c.task('../etc')).toEqual({ ok: false, reason: 'gone' });
    expect(s.fake.calls().length).toBe(calls);
  });

  test('task(id) while not connected → not-connected, no request', async () => {
    const s = await setup();
    expect(await s.c.task('86fk0001a')).toEqual({ ok: false, reason: 'not-connected' });
    expect(s.requests).toEqual([]);
  });

  test('task(id) offline → offline', async () => {
    const s = await connected();
    s.fake.setScenario('mcp-500');
    expect(await s.c.task('86fk0001a')).toEqual({ ok: false, reason: 'offline' });
    expect(s.c.info().status).toBe('offline');
  });

  test('search: results; a reply Atelier can\'t read is a failed search (no results), never `unavailable`', async () => {
    const s = await connected();
    expect((await s.c.search('ENG')).length).toBeGreaterThanOrEqual(0);
    s.fake.setScenario('schema-changed');
    expect(await s.c.search('ENG')).toEqual([]);
    expect(s.c.info().status).toBe('connected');
  });

  test('taskUrl: the URL ClickUp gave for a cached task, else one built from a valid id; nothing for a bad id', async () => {
    const s = await connected();
    const t = s.c.taskList().tasks.find((x) => x.id === '86fk0001a')!;
    expect(s.c.taskUrl('86fk0001a')).toBe(t.url);
    expect(s.c.taskUrl('86fkzzzz9')).toBe('https://app.clickup.com/t/86fkzzzz9');
    expect(s.c.taskUrl('a/b')).toBeNull();
  });

  test('appUrl: the desktop app\'s link (clickup://t/<id>, checked on the real app 2026-10-12), built from a valid id only', async () => {
    const s = await setup();
    expect(s.c.appUrl('86fk0001a')).toBe('clickup://t/86fk0001a');
    expect(s.c.appUrl('a/b')).toBeNull();
    expect(s.c.appUrl('86fk?x=1')).toBeNull();
    expect(s.c.appUrl('')).toBeNull();
  });
});

describe('compact replies (ClickUp since October 2026): a status is its name, its color is in the list', () => {
  const colors = (s: { c: ClickUpConnector }) => Object.fromEntries(s.c.taskList().tasks.map((t) => [t.displayId, t.status]));
  const listReads = (s: { fake: FakeClickUp }) => s.fake.calls().filter((n) => n === 'clickup_get_list').length;

  test('each task gets its status name and its list\'s color; a CSS-variable color is no color', async () => {
    const s = await connected({ scenario: 'compact' });
    expect(colors(s)).toEqual({
      'ENG-101': { name: 'in progress', color: '#5f55ee' },
      'ENG-103': { name: 'review', color: '#f8ae00' },
      '86fk0002b': { name: 'to do' }
    });
    expect(listReads(s)).toBe(2); // Sprint 42 and Backlog, once each
  });

  test('a list\'s statuses are read again only after 30 minutes, not on every refresh', async () => {
    const s = await connected({ scenario: 'compact' });
    await s.clock.advance(STALE_MS);
    s.c.refresh();
    await s.c.idle();
    expect(listReads(s)).toBe(2);
    expect(colors(s)['ENG-101']).toEqual({ name: 'in progress', color: '#5f55ee' });
    await s.clock.advance(LIST_COLORS_TTL_MS);
    s.c.refresh();
    await s.c.idle();
    expect(listReads(s)).toBe(4);
  });

  test('colored replies (the older shape) never read a list', async () => {
    const s = await connected();
    expect(listReads(s)).toBe(0);
    expect(colors(s)['ENG-101']).toEqual({ name: 'in progress', color: '#5f55ee' });
  });

  test('a server without clickup_get_list: still connected, names without colors, asked once per list per 30 minutes', async () => {
    const s = await connected({ scenario: 'list-tool-missing' });
    expect(colors(s)).toEqual({ 'ENG-101': { name: 'in progress' }, 'ENG-103': { name: 'review' }, '86fk0002b': { name: 'to do' } });
    expect(listReads(s)).toBe(2);
    await s.clock.advance(STALE_MS);
    s.c.refresh();
    await s.c.idle();
    expect(s.c.info().status).toBe('connected');
    expect(listReads(s)).toBe(2);
  });

  test('lists that never answer cost the refresh a few seconds at most: tasks in, connected, no colors', async () => {
    let hung = 0;
    const hang: (base: Transport) => Transport = (base) => (req, signal) => {
      if (!req.body?.includes('"clickup_get_list"')) return base(req, signal);
      hung++;
      return new Promise((_, reject) => signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
    };
    const s = await setup({ scenario: 'compact', transport: hang });
    s.c.connect(1);
    // The sign-in runs on real HTTP: wait for the first list read to be on the wire, then let the budget run out.
    for (let i = 0; i < 500 && hung === 0; i++) await new Promise((r) => setTimeout(r, 10));
    expect(hung).toBe(1);
    await s.clock.advance(LIST_COLORS_BUDGET_MS);
    await s.c.idle();
    expect(hung).toBe(1); // the second list isn't asked once the budget is spent
    expect(LIST_COLORS_BUDGET_MS).toBeLessThanOrEqual(5000);
    expect(s.c.info().status).toBe('connected');
    expect(colors(s)['ENG-101']).toEqual({ name: 'in progress' });
  });

  test('a list the budget never got to isn\'t cached as read: the next read asks it (the one that hung waits 30 minutes)', async () => {
    let hang = true;
    let asked = 0;
    const slow: (base: Transport) => Transport = (base) => (req, signal) => {
      if (!req.body?.includes('"clickup_get_list"')) return base(req, signal);
      asked++;
      if (!hang) return base(req, signal);
      return new Promise((_, reject) => signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
    };
    const s = await setup({ scenario: 'compact', transport: slow });
    s.c.connect(1);
    for (let i = 0; i < 500 && asked === 0; i++) await new Promise((r) => setTimeout(r, 10));
    await s.clock.advance(LIST_COLORS_BUDGET_MS);
    await s.c.idle();
    expect(asked).toBe(1);
    hang = false;
    await s.c.definedStatuses(['901500000301', '901500000302']);
    expect(asked).toBe(2);
  });

  test('search results and a task detail keep their status name (and the detail its color)', async () => {
    const s = await connected({ scenario: 'compact' });
    const found = await s.c.search('login');
    expect(found.map((t) => t.status)).toEqual([{ name: 'in progress', color: '#5f55ee' }]);
    const got = await s.c.task('86fk0001a');
    expect(got.ok && got.task.status).toEqual({ name: 'in progress', color: '#5f55ee' });
  });
});

describe('automations\' reads', () => {
  const SPRINT = '901500000301';
  const BACKLOG = '901500000302';

  test('watch: every open task of the lists, whoever it is assigned to, with what conditions read', async () => {
    const s = await connected({ scenario: 'compact' });
    const { tasks, complete } = await s.c.watch([SPRINT, BACKLOG]);
    expect(complete).toBe(true);
    expect(tasks.map((t) => t.id).sort()).toEqual(['86fk0001a', '86fk0002b', '86fk0003c', '86fk0005e']);
    expect(tasks.find((t) => t.id === '86fk0001a')).toEqual({
      id: '86fk0001a', scope: SPRINT, displayId: 'ENG-101', title: 'Fix the login redirect loop', url: 'https://app.clickup.com/t/86fk0001a',
      status: 'in progress', assignees: ['81000001'], tags: ['auth'], priority: 'high', due: expect.any(Number)
    });
    expect(tasks.find((t) => t.id === '86fk0005e')!.assignees).toEqual(['81000002']);
    expect((await s.c.watch([BACKLOG])).tasks.map((t) => t.id)).toEqual(['86fk0002b']);
    expect(s.c.userIdNow()).toBe('81000001');
  });

  test('watch: the names of the people it saw, for the editor\'s chips', async () => {
    const s = await connected({ scenario: 'compact' });
    const { people } = await s.c.watch([SPRINT, BACKLOG]);
    expect(people).toEqual([{ id: '81000001', name: 'Ada Fake' }, { id: '81000002', name: 'Grace Fake' }]);
  });

  test('definedStatuses: the lists\' open statuses with their colors, closed ones left out, cached with the colors (30 minutes)', async () => {
    const s = await connected({ scenario: 'compact' });
    const reads = () => s.fake.calls().filter((n) => n === 'clickup_get_list').length;
    const before = reads(); // Sprint 42 and Backlog were read for the task list's colors
    expect(await s.c.definedStatuses([SPRINT, '901500000303'])).toEqual([
      { name: 'to do' }, { name: 'in progress', color: '#5f55ee' }, { name: 'review', color: '#f8ae00' }
    ]);
    expect(reads()).toBe(before + 1); // only Assets was new
    await s.c.definedStatuses([SPRINT, '901500000303']);
    expect(reads()).toBe(before + 1);
  });

  test('definedStatuses: never throws; a server without clickup_get_list or a source not connected gives none', async () => {
    const m = await connected({ scenario: 'list-tool-missing' });
    expect(await m.c.definedStatuses([SPRINT])).toEqual([]);
    const off = await setup();
    expect(await off.c.definedStatuses([SPRINT])).toEqual([]);
    expect(off.fake.calls()).toEqual([]);
  });

  test('watch: more pages than a read takes (3) is not a complete read', async () => {
    const fake = await startFakeClickUp({ scenario: 'compact', pageSize: 1 });
    fakes.push(fake);
    const s = await connected({ fake });
    expect(await s.c.watch([SPRINT, BACKLOG])).toMatchObject({ complete: false, tasks: { length: 3 } });
    expect((await s.c.watch([BACKLOG])).complete).toBe(true);
  });

  test('creator: from the task\'s detail', async () => {
    const s = await connected({ scenario: 'compact' });
    expect(await s.c.creator('86fk0005e')).toEqual({ id: '81000002', name: 'Grace Fake' });
    expect(await s.c.creator('86fk0001a')).toEqual({ id: '81000001', name: 'Ada Fake' });
    expect(await s.c.creator('86fkgone0')).toBeNull();
  });

  test('a 401 while watching signs out, as everywhere; offline goes offline; both throw to the runner', async () => {
    const s = await connected();
    s.fake.setScenario('mcp-401');
    await expect(s.c.watch([SPRINT])).rejects.toThrow();
    expect(s.c.info().status).toBe('reconnect');
    const o = await connected();
    o.fake.setScenario('mcp-500');
    await expect(o.c.watch([SPRINT])).rejects.toThrow();
    expect(o.c.info().status).toBe('offline');
  });

  test('not connected: refused before any request', async () => {
    const s = await setup();
    await expect(s.c.watch([SPRINT])).rejects.toThrow(/isn't connected/);
    expect(s.fake.calls()).toEqual([]);
  });

  test('scopes: every list of the workspace, named Space › Folder › List (folderless: Space › List)', async () => {
    const s = await connected();
    expect(await s.c.scopes()).toEqual([
      { id: '901500000301', label: 'Engineering › Platform › Sprint 42' },
      { id: '901500000302', label: 'Engineering › Backlog' },
      { id: '901500000303', label: 'Design › Assets' }
    ]);
  });
});
