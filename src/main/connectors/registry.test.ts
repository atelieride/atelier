import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { IPC } from '@shared/api';
import type { ConnectorInfo, ConnectorNotice, TaskGetResult, TaskList, TaskSummary } from '@shared/tasks';
import { startFakeClickUp, type FakeClickUp } from '../../../tests/fixtures/fake-clickup.mjs';
import { fetchTransport } from '../../../tests/support/fetch-transport';
import { manualClock } from '../../../tests/support/manual-clock';
import { ClickUpConnector } from './clickup/clickup';
import { clickupEndpoint } from './clickup/config';
import { followAuthorize } from './oauth/follow-auth';
import { ALLOWED_TOOLS } from './clickup/tools';
import type { Connector } from './connector';
import { ConnectorRegistry, type RegistryWindow } from './registry';
import { createSecretStore } from './secret-store';
import { testSafeStorage } from './test-safe-storage';

// The connectors' registry, its broadcast, its notices and its IPC (sender checked, strict schemas,
// no token, auth URL or code in any reply, event or log line).

/** Secrets sniffed on the wire by a test, and the connector's log lines: checked after every test. */
const secrets = new Set<string>();
const logged: string[] = [];
afterEach(() => {
  for (const s of secrets) for (const line of logged) expect(line).not.toContain(s);
  secrets.clear();
  logged.length = 0;
});

const info = (o: Partial<ConnectorInfo> = {}): ConnectorInfo => ({
  id: 'clickup', name: 'ClickUp', status: 'disconnected', loading: false, tasksVersion: 0, options: { show: 'assigned', includeClosed: false }, ...o
});

class StubConnector implements Connector {
  readonly id = 'clickup' as const;
  state = info();
  calls: string[] = [];
  init() { this.calls.push('init'); }
  info() { return this.state; }
  connect(origin?: number) { this.calls.push(`connect:${origin}`); }
  cancel() { this.calls.push('cancel'); }
  reopenAuth() { this.calls.push('reopenAuth'); }
  disconnect() { this.calls.push('disconnect'); }
  refresh() { this.calls.push('refresh'); }
  setOptions(p: object) { this.calls.push(`setOptions:${JSON.stringify(p)}`); }
  taskList(): TaskList { return { source: 'clickup', status: this.state.status, loading: false, tasks: [] }; }
  async task(id: string): Promise<TaskGetResult> { this.calls.push(`task:${id}`); return { ok: false, reason: 'gone' }; }
  async search(q: string): Promise<TaskSummary[]> { this.calls.push(`search:${q}`); return []; }
  taskUrl(id: string) { return /^[A-Za-z0-9_-]{1,64}$/.test(id) ? `https://app.clickup.com/t/${id}` : null; }
  appUrl(id: string) { return /^[A-Za-z0-9_-]{1,64}$/.test(id) ? `clickup://t/${id}` : null; }
  windowFocused() { this.calls.push('focus'); }
  dispose() { this.calls.push('dispose'); }
}

type Handler = (e: unknown, arg?: unknown) => unknown;

/** `app`: what opening the desktop app answers (true: opened; false: not installed, turned off or failed). */
function harness(connector: Connector = new StubConnector(), o: { app?: boolean } = {}) {
  const sent: { win: number; channel: string; payload: unknown }[] = [];
  const wins: RegistryWindow[] = [];
  let focused: number | null = null;
  const addWindow = (id: number) => { wins.push({ id, send: (channel, payload) => sent.push({ win: id, channel, payload }), isDestroyed: () => false }); };
  const registry = new ConnectorRegistry([connector], { windows: () => wins, focusedId: () => focused });
  const handlers = new Map<string, Handler>();
  const opened: string[] = [];
  const tried: string[] = [];
  const triedSources: string[] = [];
  registry.installIpc((ch, fn) => { handlers.set(ch, fn as Handler); }, (e) => (e as { trusted?: boolean }).trusted === true,
    async (url) => { opened.push(url); return true; }, async (url, source) => { tried.push(url); triedSources.push(source); return o.app ?? false; });
  const ev = (sender = 1, trusted = true) => ({ sender: { id: sender }, trusted });
  const invoke = async (channel: string, arg?: unknown, e = ev()) => {
    const h = handlers.get(channel);
    if (!h) throw new Error(`no handler for ${channel}`);
    return h(e, arg);
  };
  return { registry, sent, addWindow, setFocused: (id: number | null) => { focused = id; }, handlers, invoke, ev, opened, tried, triedSources, connector };
}

describe('registry: broadcast and notices', () => {
  test('a change goes to every window once; an identical state is not sent again', () => {
    const h = harness();
    h.addWindow(1);
    h.addWindow(2);
    h.registry.changed();
    h.registry.changed();
    expect(h.sent.map((s) => [s.win, s.channel])).toEqual([[1, IPC.evConnectors], [2, IPC.evConnectors]]);
    expect(h.sent[0]!.payload).toEqual([info()]);
    (h.connector as StubConnector).state = info({ status: 'connecting' });
    h.registry.changed();
    expect(h.sent).toHaveLength(4);
  });

  test('a notice goes to the window that started Connect, else the focused one, else the first', async () => {
    const h = harness();
    h.addWindow(1);
    h.addWindow(2);
    await h.invoke(IPC.connectorsList, undefined, h.ev(1));
    await h.invoke(IPC.connectorsList, undefined, h.ev(2));
    h.registry.notice({ id: 'clickup', kind: 'timeout' }, 2);
    h.setFocused(1);
    h.registry.notice({ id: 'clickup', kind: 'denied' }, 9);
    h.setFocused(null);
    h.registry.notice({ id: 'clickup', kind: 'network' });
    expect(h.sent.map((s) => [s.win, s.channel, (s.payload as ConnectorNotice).kind])).toEqual([
      [2, IPC.evConnectorNotice, 'timeout'], [1, IPC.evConnectorNotice, 'denied'], [1, IPC.evConnectorNotice, 'network']
    ]);
  });

  test('reconnect and unavailable toasts: at most one each per launch; action results always', async () => {
    const h = harness();
    h.addWindow(1);
    await h.invoke(IPC.connectorsList, undefined, h.ev(1));
    for (let i = 0; i < 3; i++) {
      h.registry.notice({ id: 'clickup', kind: 'reconnect' });
      h.registry.notice({ id: 'clickup', kind: 'unavailable' });
      h.registry.notice({ id: 'clickup', kind: 'timeout' });
    }
    expect(h.sent.map((s) => (s.payload as ConnectorNotice).kind)).toEqual(['reconnect', 'unavailable', 'timeout', 'timeout', 'timeout']);
  });

  test('a notice with no window yet waits for the first connectors:list, which takes it once', async () => {
    const h = harness();
    h.registry.notice({ id: 'clickup', kind: 'reconnect' });
    expect(h.sent).toEqual([]);
    h.addWindow(1);
    expect(await h.invoke(IPC.connectorsList)).toEqual({ connectors: [info()], notices: [{ id: 'clickup', kind: 'reconnect' }] });
    expect(await h.invoke(IPC.connectorsList)).toEqual({ connectors: [info()], notices: [] });
  });

  test('a window that has not asked for the list yet is not listening: the launch toast waits for its first list', async () => {
    const h = harness();
    h.addWindow(1); // its renderer hasn't subscribed yet
    h.registry.notice({ id: 'clickup', kind: 'reconnect' });
    expect(h.sent.filter((s) => s.channel === IPC.evConnectorNotice)).toEqual([]);
    expect(await h.invoke(IPC.connectorsList, undefined, h.ev(1))).toEqual({ connectors: [info()], notices: [{ id: 'clickup', kind: 'reconnect' }] });
    // Ready now: the next notice is sent to it directly.
    h.registry.notice({ id: 'clickup', kind: 'timeout' }, 1);
    expect(h.sent.filter((s) => s.channel === IPC.evConnectorNotice).map((s) => [s.win, (s.payload as ConnectorNotice).kind])).toEqual([[1, 'timeout']]);
  });

  test('an origin window that is not ready yet: the notice goes to a ready window', async () => {
    const h = harness();
    h.addWindow(1);
    h.addWindow(2);
    await h.invoke(IPC.connectorsList, undefined, h.ev(2));
    h.registry.notice({ id: 'clickup', kind: 'timeout' }, 1);
    expect(h.sent.filter((s) => s.channel === IPC.evConnectorNotice).map((s) => s.win)).toEqual([2]);
  });
});

describe('registry: IPC (sender checked, strict schemas)', () => {
  const channels = [
    [IPC.connectorsList, undefined], [IPC.connectorsConnect, { id: 'clickup' }], [IPC.connectorsCancel, { id: 'clickup' }],
    [IPC.connectorsDisconnect, { id: 'clickup' }], [IPC.connectorsRefresh, { id: 'clickup' }], [IPC.connectorsReopenAuth, { id: 'clickup' }],
    [IPC.connectorsSetOptions, { id: 'clickup', options: { includeClosed: true } }], [IPC.tasksList, undefined],
    [IPC.tasksGet, { source: 'clickup', id: '86fk0001a' }], [IPC.tasksSearch, { source: 'clickup', query: 'ENG' }],
    [IPC.connectorsOpenTask, { source: 'clickup', id: '86fk0001a' }],
    [IPC.connectorsSearchSources, { id: 'clickup', query: 'x' }], [IPC.connectorsAddSource, { id: 'clickup', ref: 'x' }],
    [IPC.connectorsRemoveSource, { id: 'clickup', sourceId: 'a'.repeat(32) }], [IPC.connectorsLoadSourceColumns, { id: 'clickup', sourceId: 'a'.repeat(32) }],
    [IPC.connectorsSetSourceFields, { id: 'clickup', sourceId: 'a'.repeat(32), fields: { title: 'Name' } }],
    [IPC.connectorsSetSourceScope, { id: 'jira', sourceId: '10001', everyone: true }], [IPC.connectorsListFilters, { id: 'jira' }],
    [IPC.connectorsSetFilter, { id: 'jira', filterId: '10040' }],
    [IPC.connectorsConnectToken, { id: 'jira', user: 'ada@example.com', secret: 'api-token-0123456789abcdef', site: 'acme.atlassian.net' }]
  ] as const;

  test('every channel is handled; none for a generic tool call', () => {
    const h = harness();
    expect([...h.handlers.keys()].sort()).toEqual(channels.map(([c]) => c).sort());
  });

  test.each(channels)('%s refuses a sender that is not an app page', async (channel, arg) => {
    const h = harness();
    await expect(h.invoke(channel, arg, h.ev(1, false))).rejects.toThrow('unauthorized sender');
    expect((h.connector as StubConnector).calls).toEqual([]);
  });

  test.each([
    [IPC.connectorsConnect, { id: 'linear' }], [IPC.connectorsConnect, { id: 'clickup', extra: 1 }], [IPC.connectorsConnect, 'clickup'],
    [IPC.connectorsSetOptions, { id: 'clickup', options: { includeClosed: 'yes' } }],
    [IPC.connectorsSetOptions, { id: 'clickup', options: { workspace: 'x' } }],
    [IPC.connectorsSetOptions, { id: 'clickup', options: { includeClosed: true }, token: 'x' }],
    [IPC.tasksGet, { source: 'clickup', id: '../x' }], [IPC.tasksGet, { source: 'clickup', id: 'a'.repeat(65) }],
    [IPC.tasksGet, { source: 'clickup', id: 'ok', url: 'https://evil.example' }],
    [IPC.tasksSearch, { source: 'clickup', query: '' }], [IPC.tasksSearch, { source: 'clickup', query: 'x'.repeat(201) }],
    [IPC.connectorsOpenTask, { source: 'clickup', id: 'x', url: 'https://evil.example' }],
    [IPC.connectorsOpenTask, { source: 'clickup', id: 'a b' }],
    [IPC.tasksList, { source: 'clickup' }], [IPC.connectorsList, { all: true }],
    // Jira's channels.
    [IPC.connectorsSetSourceScope, { id: 'jira', sourceId: 'ATL', everyone: true }], [IPC.connectorsSetSourceScope, { id: 'jira', sourceId: '10001', everyone: 'yes' }],
    [IPC.connectorsSetFilter, { id: 'jira', filterId: '1 OR x' }], [IPC.connectorsSetFilter, { id: 'jira', filterId: 10040 }],
    [IPC.connectorsConnectToken, { id: 'jira', user: 'ada@example.com', secret: 'short', site: 'acme.atlassian.net' }],
    [IPC.connectorsConnectToken, { id: 'jira', user: 'ada:x@example.com', secret: 'api-token-0123456789abcdef' }],
    [IPC.connectorsConnectToken, { id: 'jira', user: 'ada@example.com', secret: 'api token with spaces 0123', site: 'acme.atlassian.net' }],
    [IPC.connectorsConnectToken, { id: 'jira', user: 'ada@example.com', secret: 'api-token-0123456789abcdef', url: 'https://evil.example' }]
  ])('%s refuses a malformed payload %j', async (channel, arg) => {
    const h = harness();
    await expect(h.invoke(channel, arg)).rejects.toThrow();
    expect((h.connector as StubConnector).calls).toEqual([]);
  });

  test('the handlers reach the connector; Connect passes the asking window', async () => {
    const h = harness();
    const stub = h.connector as StubConnector;
    expect(await h.invoke(IPC.connectorsConnect, { id: 'clickup' }, h.ev(7))).toEqual(info());
    await h.invoke(IPC.connectorsCancel, { id: 'clickup' });
    await h.invoke(IPC.connectorsReopenAuth, { id: 'clickup' });
    await h.invoke(IPC.connectorsRefresh, { id: 'clickup' });
    await h.invoke(IPC.connectorsSetOptions, { id: 'clickup', options: { includeClosed: true } });
    await h.invoke(IPC.connectorsDisconnect, { id: 'clickup' });
    expect(await h.invoke(IPC.tasksGet, { source: 'clickup', id: '86fk0001a' })).toEqual({ ok: false, reason: 'gone' });
    expect(await h.invoke(IPC.tasksSearch, { source: 'clickup', query: 'ENG' })).toEqual([]);
    expect(await h.invoke(IPC.tasksList)).toEqual([{ source: 'clickup', status: 'disconnected', loading: false, tasks: [] }]);
    expect(stub.calls).toEqual([
      'connect:7', 'cancel', 'reopenAuth', 'refresh', 'setOptions:{"includeClosed":true}', 'disconnect', 'task:86fk0001a', 'search:ENG'
    ]);
  });

  test('connectors:openTask opens the URL main holds, never one from the renderer', async () => {
    const h = harness();
    expect(await h.invoke(IPC.connectorsOpenTask, { source: 'clickup', id: '86fk0001a' })).toBe(true);
    expect(h.opened).toEqual(['https://app.clickup.com/t/86fk0001a']);
  });

  test('connectors:openTask: the desktop app first (its URL built by main); it opened → no browser', async () => {
    const h = harness(undefined, { app: true });
    expect(await h.invoke(IPC.connectorsOpenTask, { source: 'clickup', id: '86fk0001a' })).toBe(true);
    expect(h.tried).toEqual(['clickup://t/86fk0001a']);
    expect(h.opened).toEqual([]);
  });

  test('connectors:openTask: no app (not installed, turned off or failed) → the browser', async () => {
    const h = harness(undefined, { app: false });
    expect(await h.invoke(IPC.connectorsOpenTask, { source: 'clickup', id: '86fk0001a' })).toBe(true);
    expect(h.tried).toEqual(['clickup://t/86fk0001a']);
    expect(h.opened).toEqual(['https://app.clickup.com/t/86fk0001a']);
  });

  test('connectors:openTask tells the desktop opener whose task it is (each source has its own setting)', async () => {
    const h = harness(undefined, { app: true });
    await h.invoke(IPC.connectorsOpenTask, { source: 'clickup', id: '86fk0001a' });
    expect(h.triedSources).toEqual(['clickup']);
  });

  test('windowFocused and dispose reach every connector', () => {
    const h = harness();
    h.registry.windowFocused();
    h.registry.dispose();
    expect((h.connector as StubConnector).calls).toEqual(['focus', 'dispose']);
  });
});

// Sources IPC: connectors with chosen sources (Notion's databases).
describe('registry: sources IPC', () => {
  const SID = 'a'.repeat(32);
  const fields = { title: 'Name', status: { prop: 'Stage', kind: 'select', closed: ['Shipped'] }, assignee: { prop: 'Owner', mine: true } };

  class SourceStub extends StubConnector {
    async searchSources(q: string) { this.calls.push(`searchSources:${q}`); return [{ id: SID, name: 'Backlog', added: false }]; }
    async addSource(ref: string) { this.calls.push(`addSource:${ref}`); return { ok: true as const, sourceIds: [SID] }; }
    async removeSource(id: string) { this.calls.push(`removeSource:${id}`); return this.state; }
    async setSourceFields(id: string, f: unknown) { this.calls.push(`setSourceFields:${id}:${JSON.stringify(f)}`); return this.state; }
    async loadSourceColumns(id: string) { this.calls.push(`loadSourceColumns:${id}`); return this.state; }
  }

  test('sources IPC rejects a connector without sources', async () => {
    const h = harness();
    expect(await h.invoke(IPC.connectorsSearchSources, { id: 'clickup', query: 'x' })).toEqual([]);
    expect(await h.invoke(IPC.connectorsAddSource, { id: 'clickup', ref: 'x' })).toEqual({ ok: false, reason: 'unsupported' });
    expect(await h.invoke(IPC.connectorsRemoveSource, { id: 'clickup', sourceId: SID })).toEqual(info());
    expect(await h.invoke(IPC.connectorsSetSourceFields, { id: 'clickup', sourceId: SID, fields })).toEqual(info());
    expect(await h.invoke(IPC.connectorsLoadSourceColumns, { id: 'clickup', sourceId: SID })).toEqual(info());
  });

  test('searchSources routes to the connector', async () => {
    const c = new SourceStub();
    const h = harness(c);
    expect(await h.invoke(IPC.connectorsSearchSources, { id: 'clickup', query: 'back' })).toEqual([{ id: SID, name: 'Backlog', added: false }]);
    expect(await h.invoke(IPC.connectorsAddSource, { id: 'clickup', ref: 'https://www.notion.so/x' })).toEqual({ ok: true, sourceIds: [SID] });
    await h.invoke(IPC.connectorsRemoveSource, { id: 'clickup', sourceId: SID });
    await h.invoke(IPC.connectorsSetSourceFields, { id: 'clickup', sourceId: SID, fields });
    await h.invoke(IPC.connectorsLoadSourceColumns, { id: 'clickup', sourceId: SID });
    expect(c.calls).toEqual([
      'searchSources:back', 'addSource:https://www.notion.so/x', `removeSource:${SID}`,
      `setSourceFields:${SID}:${JSON.stringify(fields)}`, `loadSourceColumns:${SID}`
    ]);
  });

  test('sources IPC checks the sender', async () => {
    const h = harness(new SourceStub());
    for (const [ch, arg] of [
      [IPC.connectorsSearchSources, { id: 'clickup', query: 'x' }], [IPC.connectorsAddSource, { id: 'clickup', ref: 'x' }],
      [IPC.connectorsRemoveSource, { id: 'clickup', sourceId: SID }], [IPC.connectorsLoadSourceColumns, { id: 'clickup', sourceId: SID }],
      [IPC.connectorsSetSourceFields, { id: 'clickup', sourceId: SID, fields }]
    ] as const) await expect(h.invoke(ch, arg, h.ev(1, false))).rejects.toThrow();
  });

  test('sources IPC validates sourceId and fields strictly', async () => {
    const c = new SourceStub();
    const h = harness(c);
    const bad: [string, unknown][] = [
      [IPC.connectorsSearchSources, { id: 'clickup', query: '' }],
      [IPC.connectorsSearchSources, { id: 'clickup', query: 'x'.repeat(201) }],
      [IPC.connectorsSearchSources, { id: 'clickup', query: 'x', extra: 1 }],
      [IPC.connectorsAddSource, { id: 'clickup', ref: '' }],
      [IPC.connectorsAddSource, { id: 'clickup', ref: 'x'.repeat(401) }],
      [IPC.connectorsRemoveSource, { id: 'clickup', sourceId: 'A'.repeat(32) }],
      [IPC.connectorsRemoveSource, { id: 'clickup', sourceId: 'a'.repeat(31) }],
      [IPC.connectorsLoadSourceColumns, { id: 'clickup', sourceId: 'zz' }],
      [IPC.connectorsSetSourceFields, { id: 'clickup', sourceId: 'nothex', fields }],
      [IPC.connectorsSetSourceFields, { id: 'clickup', sourceId: SID, fields: { ...fields, extra: 1 } }],
      [IPC.connectorsSetSourceFields, { id: 'clickup', sourceId: SID, fields: { title: 'Na\nme' } }],
      [IPC.connectorsSetSourceFields, { id: 'clickup', sourceId: SID, fields: { title: 'x'.repeat(101) } }],
      [IPC.connectorsSetSourceFields, { id: 'clickup', sourceId: SID, fields: { title: '' } }],
      [IPC.connectorsSetSourceFields, { id: 'clickup', sourceId: SID, fields: { title: 'T', status: { prop: 'S', kind: 'checkbox', closed: [] } } }],
      [IPC.connectorsSetSourceFields, { id: 'clickup', sourceId: SID, fields: { title: 'T', status: { prop: 'S', kind: 'select', closed: Array(51).fill('x') } } }],
      [IPC.connectorsSetSourceFields, { id: 'clickup', sourceId: SID, fields: { title: 'T', due: 'D\u0007' } }],
      // Line/paragraph separators and bidi controls, like the shared cleaner (fields.ts usableName).
      ...[0x2028, 0x2029, 0x061c, 0x200e, 0x200f, 0x202a, 0x202e, 0x2066, 0x2069].map((n) => String.fromCharCode(n)).flatMap((ch): [string, unknown][] => [
        [IPC.connectorsSetSourceFields, { id: 'clickup', sourceId: SID, fields: { title: `T${ch}x` } }],
        [IPC.connectorsSetSourceFields, { id: 'clickup', sourceId: SID, fields: { title: 'T', status: { prop: 'S', kind: 'select', closed: [`Done${ch}`] } } }]
      ]),
      [IPC.connectorsSetSourceFields, { id: 'clickup', sourceId: SID, fields: { title: 'T', status: { prop: 'S', kind: 'select', closed: ['x'.repeat(201)] } } }],
      [IPC.connectorsSetSourceFields, { id: 'clickup', sourceId: SID, fields: { title: 'T', assignee: { prop: 'P', mine: true, extra: 1 } } }],
      [IPC.connectorsSetSourceFields, { id: 'nope', sourceId: SID, fields }]
    ];
    for (const [ch, arg] of bad) await expect(h.invoke(ch, arg), JSON.stringify(arg)).rejects.toThrow();
    expect(c.calls).toEqual([]);
  });

  test('sources IPC takes option names up to 200 characters and emoji with a zero-width joiner', async () => {
    const c = new SourceStub();
    const h = harness(c);
    const ok = { title: `${String.fromCodePoint(0x1f469, 0x200d, 0x1f4bb)} Task`, status: { prop: 'S', kind: 'select', closed: ['x'.repeat(200)] } };
    await h.invoke(IPC.connectorsSetSourceFields, { id: 'clickup', sourceId: SID, fields: ok });
    expect(c.calls).toEqual([`setSourceFields:${SID}:${JSON.stringify(ok)}`]);
  });
});

describe('no token, auth URL or code ever reaches the renderer', () => {
  let fake: FakeClickUp | null = null;
  afterEach(async () => {
    expect(fake?.calls().filter((n) => !ALLOWED_TOOLS.has(n)) ?? []).toEqual([]);
    await fake?.close();
    fake = null;
  });

  test('a full connect / list / get / search / open / refresh / disconnect flow, every reply and event serialized', async () => {
    fake = await startFakeClickUp();
    const ep = clickupEndpoint(fake.url);
    const base = fetchTransport();
    // Everything secret the flow handles, sniffed on the wire: tokens, codes, verifiers, challenges, states, client ids.
    const transport: typeof base = async (req, signal) => {
      const auth = req.headers?.authorization;
      if (auth) secrets.add(auth.replace(/^Bearer /, ''));
      if (req.body?.includes('code_verifier')) for (const [k, v] of new URLSearchParams(req.body)) if (k !== 'grant_type' && k !== 'redirect_uri' && k !== 'resource') secrets.add(v);
      const res = await base(req, signal);
      if (res.location) for (const k of ['code', 'state']) { const v = new URL(res.location).searchParams.get(k); if (v) secrets.add(v); }
      return res;
    };
    const opened: string[] = [];
    let registry!: ConnectorRegistry;
    const clock = manualClock();
    const connector = new ClickUpConnector({
      store: createSecretStore(mkdtempSync(join(tmpdir(), 'atl-reg-')), testSafeStorage()), endpoint: ep, transport, clock,
      openAuthPage: (url, deliver) => { opened.push(url); followAuthorize(transport, ep.allow)(url, deliver); },
      focused: () => true, log: (m) => { logged.push(m); }, onChange: () => registry.changed(), onNotice: (n, o) => registry.notice(n, o)
    });
    const h = harness(connector);
    registry = h.registry;
    h.addWindow(1);
    h.addWindow(2);
    connector.init();
    const replies: unknown[] = [];
    const call = async (channel: string, arg?: unknown) => { const r = await h.invoke(channel, arg); replies.push(r); return r; };
    await call(IPC.connectorsList);
    await call(IPC.connectorsConnect, { id: 'clickup' });
    await call(IPC.connectorsConnect, { id: 'clickup' }); // a second window joins
    await call(IPC.connectorsReopenAuth, { id: 'clickup' });
    await connector.idle();
    expect(connector.info().status).toBe('connected');
    const lists = await call(IPC.tasksList) as TaskList[];
    expect(lists[0]!.tasks.length).toBeGreaterThan(0);
    await call(IPC.tasksGet, { source: 'clickup', id: '86fk0001a' });
    await call(IPC.tasksGet, { source: 'clickup', id: '86fkgone0' });
    await call(IPC.tasksSearch, { source: 'clickup', query: 'ENG' });
    await call(IPC.connectorsOpenTask, { source: 'clickup', id: '86fk0001a' });
    await call(IPC.connectorsSetOptions, { id: 'clickup', options: { includeClosed: true } });
    await connector.idle();
    // Something to log (an oversized reply), so the suite's log check has lines to look at.
    fake.setScenario('oversized');
    await call(IPC.connectorsRefresh, { id: 'clickup' });
    await connector.idle();
    expect(logged.length).toBeGreaterThan(0);
    fake.setScenario('normal');
    fake.revokeTokens();
    await call(IPC.connectorsRefresh, { id: 'clickup' });
    await connector.idle();
    await call(IPC.connectorsList);
    await call(IPC.connectorsDisconnect, { id: 'clickup' });
    connector.dispose();

    expect(secrets.size).toBeGreaterThanOrEqual(5);
    expect([...secrets].some((s) => s.startsWith('fkat_'))).toBe(true);
    const everything = JSON.stringify({ replies, sent: h.sent, opened: h.opened });
    for (const s of secrets) expect(everything).not.toContain(s);
    for (const u of opened) expect(everything).not.toContain(new URL(u).search.slice(1, 40));
    expect(everything).not.toMatch(/fkat_|fake-code-|code_verifier|code_challenge|access_token|Bearer/);
    expect(h.sent.some((s) => s.channel === IPC.evConnectorNotice)).toBe(true);
  });
});
