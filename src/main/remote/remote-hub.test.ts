import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { Resumable, TerminalInfo } from '@shared/protocol';
import type { UsageEntry } from '@shared/session';
import type { PortsMap } from '@shared/ports';
import type { RemoteLayout, RemotePairingEvent, RemoteRowsEvent, RemoteSized, RemoteStatus } from '@shared/remote';
import { DEFAULT_SETTINGS, type Settings } from '@shared/settings';
import { FakePhone, type Msg } from '../../../tests/support/fake-phone';
import { startTestRelay, type TestRelay } from '../../../tests/support/test-relay';
import { createSecretStore } from '../connectors/secret-store';
import { testSafeStorage } from '../connectors/test-safe-storage';
import type { RemoteViewer } from '../terminal-hub';
import { RemoteHub, type RemoteHubDeps, type RemoteTerminals } from './remote-hub';
import { projectIdOf } from './state';
import { collapseKeyOf } from './push';
import { openPush, pushKeyId } from './push-seal';

const term = (id: string, projectRoot: string, o: Partial<TerminalInfo> = {}): TerminalInfo => ({
  id, projectRoot, cwd: projectRoot, title: `T ${id}`, name: null, color: '#fff', foreground: 'zsh', createdAt: 1, session: null, ...o
});

/** TerminalHub's remote side, in memory: a screen per terminal, input echoed back as output. */
class FakeTerminals implements RemoteTerminals {
  list: TerminalInfo[] = [];
  private shown = new Set<() => void>();
  private viewers = new Map<number, RemoteViewer>();
  private next = -1;
  watching = new Map<number, Set<string>>();
  inputs: [string, string][] = [];
  resizes: [string, number, number][] = [];
  created: { project: string; kind: string; cols: number; rows: number; account?: string }[] = [];
  answers: [string, string][] = [];
  renames: [string, string][] = [];
  closes: string[] = [];
  dismissals: string[] = [];
  sized: RemoteSized[] = [];
  resumables: Resumable[] = [];
  usage: UsageEntry[] = [];
  starting = new Set<string>();
  allTerminals() { return this.list; }
  allResumables() { return this.resumables; }
  usageList() { return this.usage; }
  startingIds() { return this.starting; }
  onShown(cb: () => void) { this.shown.add(cb); return () => { this.shown.delete(cb); }; }
  set(list: TerminalInfo[]) { this.list = list; for (const cb of this.shown) cb(); }
  addRemoteViewer(v: RemoteViewer) { const k = this.next--; this.viewers.set(k, v); this.watching.set(k, new Set()); return k; }
  removeRemoteViewer(k: number) { this.viewers.delete(k); this.watching.delete(k); }
  async remoteAttach(k: number, id: string, cols: number, rows: number) {
    if (!this.list.some((t) => t.id === id)) throw new Error('no such terminal');
    this.watching.get(k)!.add(id);
    this.viewers.get(k)!.snapshot(id, `screen of ${id}\r\n$ `, { cols, rows });
  }
  remoteDetach(k: number, id: string) { this.watching.get(k)?.delete(id); }
  remoteInput(k: number, id: string, data: string) {
    if (!this.watching.get(k)?.has(id)) return false;
    this.inputs.push([id, data]);
    this.output(id, data);
    return true;
  }
  remoteResize(k: number, id: string, cols: number, rows: number) {
    if (!this.watching.get(k)?.has(id)) return false;
    this.resizes.push([id, cols, rows]);
    return true;
  }
  remoteSized() { return this.sized; }
  answerPermission(id: string, choice: 'allow' | 'deny') { this.answers.push([id, choice]); }
  async renameRemote(id: string, name: string) { if (!this.list.some((t) => t.id === id)) throw new Error('gone'); this.renames.push([id, name]); }
  async closeRemote(id: string) { if (!this.list.some((t) => t.id === id)) throw new Error('gone'); this.closes.push(id); this.set(this.list.filter((t) => t.id !== id)); }
  async resumeRemote(id: string, cols: number, rows: number) {
    const r = this.resumables.find((x) => x.id === id);
    if (!r) throw new Error('gone');
    this.resumables = this.resumables.filter((x) => x.id !== id);
    const t = term(`from-${id}`, r.projectRoot, { createdAt: 50 });
    this.created.push({ project: r.projectRoot, kind: 'resume', cols, rows });
    this.set([...this.list, t]);
    return t;
  }
  async dismissRemote(id: string) { if (!this.resumables.some((x) => x.id === id)) throw new Error('gone'); this.dismissals.push(id); this.resumables = this.resumables.filter((x) => x.id !== id); this.set(this.list); }
  async createRemoteSession(o: { project: string; kind: 'claude' | 'terminal'; cols: number; rows: number; account?: string }) {
    this.created.push(o);
    const t = term(`new${this.created.length}`, o.project, { createdAt: 10 + this.created.length });
    this.set([...this.list, t]);
    return t;
  }
  output(id: string, data: string) {
    for (const [k, ids] of this.watching) if (ids.has(id)) this.viewers.get(k)!.data(id, data);
  }
  exit(id: string) {
    for (const [k, ids] of this.watching) if (ids.has(id)) { ids.delete(id); this.viewers.get(k)!.exit(id); }
  }
  viewerCount() { return this.viewers.size; }
}

let relay: TestRelay;
const hubs: RemoteHub[] = [];
const phones: FakePhone[] = [];

beforeEach(async () => { relay = await startTestRelay(); });
afterEach(async () => {
  for (const p of phones.splice(0)) p.drop();
  for (const h of hubs.splice(0)) await h.dispose();
  await relay.close();
});

async function until(check: () => boolean, ms = 4000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
}

function setup(o: { settings?: Partial<Settings>; safe?: Parameters<typeof testSafeStorage>[0]; timing?: RemoteHubDeps['timing']; link?: RemoteHubDeps['link']; home?: string; deps?: Partial<RemoteHubDeps>; away?: () => boolean } = {}) {
  const home = o.home ?? mkdtempSync(join(tmpdir(), 'atl-remote-hub-'));
  let settings: Settings = { ...DEFAULT_SETTINGS, remoteAccess: true, remoteRelay: relay.url, projectColors: { '/work/app': 4 }, ...o.settings };
  const terms = new FakeTerminals();
  terms.list = [term('t1', '/work/app'), term('t2', '/work/app', { createdAt: 2, session: { sessionId: 's', state: 'waiting', waitingFor: 'permission', title: null, activity: null, contextPct: null, unread: false, updatedAt: 0 } as never })];
  const statuses: RemoteStatus[] = [];
  const pairing: RemotePairingEvent[] = [];
  const rows: [string, RemoteRowsEvent][] = [];
  let projects = { open: ['/work/app'], recent: ['/work/old'] };
  const hub = new RemoteHub({
    home, secrets: createSecretStore(home, testSafeStorage(o.safe)), settings: () => settings, relayUrl: () => settings.remoteRelay,
    terminals: terms, projects: () => projects, host: { name: 'Studio Mac', app: '0.3.0', platform: 'darwin' },
    emitStatus: (s) => statuses.push(s), emitPairing: (e) => pairing.push(e),
    defaultDir: () => '/home/.claude',
    rows: (root, e) => rows.push([root, e]),
    away: o.away ?? (() => true),
    timing: { stateMs: 30, usageMs: 30, ...o.timing }, ...(o.link ? { link: o.link } : {}), ...o.deps
  });
  hubs.push(hub);
  const phone = (opts: Partial<ConstructorParameters<typeof FakePhone>[0]> = {}) => { const p = new FakePhone({ relay: relay.url, ...opts }); phones.push(p); return p; };
  const set = (patch: Partial<Settings>) => { settings = { ...settings, ...patch }; hub.settingsChanged(); };
  const setProjects = (p: typeof projects) => { projects = p; hub.projectsChanged(); };
  return { hub, home, terms, statuses, pairing, phone, set, setProjects, rows };
}

/** Pairs a phone by code, answering Allow; the phone and its welcome. */
async function paired(t: ReturnType<typeof setup>, o: { qr?: boolean } = {}) {
  t.hub.start();
  await until(() => t.hub.status().relay.state === 'online');
  const start = await t.hub.startPairing();
  if (!start.ok) throw new Error(start.message);
  const phone = t.phone();
  const welcome = o.qr ? phone.pairByQr(start.pairing.qr) : phone.pairByCode(start.pairing.code);
  await until(() => t.pairing.some((e) => e.kind === 'request'));
  const req = t.pairing.find((e) => e.kind === 'request') as Extract<RemotePairingEvent, { kind: 'request' }>;
  expect(t.hub.decide(req.request.id, true)).toBe(true);
  return { phone, welcome: await welcome, code: start.pairing };
}

describe('on and off', () => {
  test('off: no relay connection exists, nothing is asked of the Keychain', async () => {
    let asked = 0;
    const t = setup({ settings: { remoteAccess: false } });
    const safe = (t.hub as unknown as { identities: { secrets: { available(): boolean } } }).identities.secrets;
    const real = safe.available.bind(safe);
    safe.available = () => { asked++; return real(); };
    t.hub.start();
    await new Promise((r) => setTimeout(r, 100));
    expect(relay.hostFrames).toEqual([]);
    expect(asked).toBe(0);
    expect(t.statuses).toEqual([]);
    expect(await t.hub.startPairing()).toMatchObject({ ok: false, reason: 'disabled' });
  });

  test('on: the identity is made, the relay connection goes online, the windows are told', async () => {
    const t = setup();
    t.hub.start();
    await until(() => t.statuses.at(-1)?.relay.state === 'online');
    expect(t.statuses.at(-1)).toMatchObject({ enabled: true, available: true, devices: [], sized: [] });
    expect(relay.hostFrames.filter((f) => f.frame.t === 'auth')).toHaveLength(1);
  });

  test('without encryption remote access is unavailable: an error, no connection', async () => {
    const t = setup({ safe: { available: false } });
    t.hub.start();
    expect(t.hub.status()).toMatchObject({ available: false, relay: { state: 'error' } });
    await new Promise((r) => setTimeout(r, 50));
    expect(relay.hostFrames).toEqual([]);
  });

  test('a relay URL Atelier may not dial is an error, never dialed', async () => {
    const t = setup({ settings: { remoteRelay: 'http://relay.test' } });
    t.hub.start();
    expect(t.hub.status().relay).toEqual({ state: 'error', message: 'The relay address is not one Atelier can use.' });
  });
});

describe('pairing', () => {
  test('by code: the phone presents it, the windows ask, Allow; welcome with the room, then the state', async () => {
    const t = setup();
    const { phone, welcome } = await paired(t);
    expect(welcome).toEqual({ t: 'welcome', host: { name: 'Studio Mac', platform: 'darwin' }, room: phone.room });
    expect(phone.room).toHaveLength(43);
    const state = await phone.state();
    expect(state.projects).toEqual([
      { id: projectIdOf('/work/app'), name: 'app', color: 4, open: true },
      { id: projectIdOf('/work/old'), name: 'old', color: expect.any(Number), open: false }
    ]);
    expect((state.sessions as Msg[]).map((s) => [s.id, s.claude, s.state, s.waitingFor ?? null])).toEqual([['t1', false, 'idle', null], ['t2', true, 'waiting', 'permission']]);
    // The request named the phone; the code died with the pairing.
    expect(t.pairing.find((e) => e.kind === 'request')).toMatchObject({ request: { name: 'Test iPhone', model: 'iPhone17,1' } });
    expect(t.pairing.find((e) => e.kind === 'paired')).toMatchObject({ device: { name: 'Test iPhone', model: 'iPhone17,1', connected: true } });
    await until(() => relay.offers().length === 0);
    await until(() => t.statuses.at(-1)?.devices[0]?.connected === true);
  });

  test('by QR: the host key is pinned, the relay taken from the code', async () => {
    const t = setup();
    const { phone, welcome } = await paired(t, { qr: true });
    expect(welcome.t).toBe('welcome');
    expect(phone.hostKey).toHaveLength(32);
  });

  test('Deny: the phone is told declined and closed; the sheet gets a fresh code', async () => {
    const t = setup();
    t.hub.start();
    await until(() => t.hub.status().relay.state === 'online');
    const start = await t.hub.startPairing();
    if (!start.ok) throw new Error('no code');
    const phone = t.phone();
    const answer = phone.pairByCode(start.pairing.code);
    await until(() => t.pairing.some((e) => e.kind === 'request'));
    t.hub.decide((t.pairing.find((e) => e.kind === 'request') as { request: { id: string } }).request.id, false);
    expect(await answer).toEqual({ t: 'denied', reason: 'declined' });
    await phone.closed();
    await until(() => t.pairing.filter((e) => e.kind === 'code').length === 2);
    expect(t.hub.devices.list()).toEqual([]);
  });

  test('no answer in time: expired', async () => {
    const t = setup({ timing: { decideMs: 80 } });
    t.hub.start();
    await until(() => t.hub.status().relay.state === 'online');
    const start = await t.hub.startPairing();
    if (!start.ok) throw new Error('no code');
    expect(await t.phone().pairByCode(start.pairing.code)).toEqual({ t: 'denied', reason: 'expired' });
  });

  test('a wrong code never reaches the windows; five of them and the code is replaced', async () => {
    const t = setup();
    t.hub.start();
    await until(() => t.hub.status().relay.state === 'online');
    const start = await t.hub.startPairing();
    if (!start.ok) throw new Error('no code');
    // A phone that guessed the lookup but not the code: the relay routes it, the handshake fails.
    const { deriveCode } = await import('./code');
    const real = await deriveCode(start.pairing.code.replace(/-/g, ''));
    for (let i = 0; i < 5; i++) {
      const p = t.phone();
      (p as unknown as { dial(kind: string, id: string, path: string, o: object): Promise<Msg> }).dial('pair', real.lookup, `/v1/pair/${real.lookup}`, { psk: Buffer.alloc(32, i), hostKey: null }).catch(() => {});
      await p.closed();
    }
    await until(() => t.pairing.filter((e) => e.kind === 'code').length === 2);
    expect(t.pairing.some((e) => e.kind === 'request')).toBe(false);
  });

  test('turning remote access off while a phone waits for Allow: denied disabled, pairing stopped', async () => {
    const t = setup();
    t.hub.start();
    await until(() => t.hub.status().relay.state === 'online');
    const start = await t.hub.startPairing();
    if (!start.ok) throw new Error('no code');
    const answer = t.phone().pairByCode(start.pairing.code);
    await until(() => t.pairing.some((e) => e.kind === 'request'));
    t.set({ remoteAccess: false });
    expect(await answer).toEqual({ t: 'denied', reason: 'disabled' });
    expect(t.pairing.at(-1)).toEqual({ kind: 'stopped' });
    expect(t.pairing.some((e) => e.kind === 'denied')).toBe(false);
  });
});

describe('a paired phone', () => {
  test('connects again by its room: welcome without the room, then the state', async () => {
    const t = setup();
    const { phone } = await paired(t);
    await phone.close();
    expect(await phone.connect()).toEqual({ t: 'welcome', host: { name: 'Studio Mac', platform: 'darwin' } });
    await phone.state();
  });

  test('a phone this computer doesn\'t know: denied unknown-device, closed 4401', async () => {
    const t = setup();
    const { phone } = await paired(t);
    const stranger = t.phone();
    stranger.room = phone.room;
    expect(await stranger.connect()).toEqual({ t: 'denied', reason: 'unknown-device' });
    expect(await stranger.closed()).toBe(4401);
  });

  test('attach: the screen at its size, ok, then output in order; typing reaches the terminal', async () => {
    const t = setup();
    const { phone } = await paired(t);
    const snap = await phone.attach('t1', 60, 30);
    expect(snap).toEqual({ t: 'snapshot', id: 't1', cols: 60, rows: 30, data: 'screen of t1\r\n$ ' });
    await phone.waitFor((m) => m.t === 'ok' && m.rid === 1);
    t.terms.output('t1', 'one ');
    t.terms.output('t1', 'two ');
    phone.input('t1', 'echo hi\r');
    await phone.sees('t1', 'one two echo hi\r');
    expect(t.terms.inputs).toEqual([['t1', 'echo hi\r']]);
    await until(() => t.statuses.at(-1)?.devices[0]?.attached.includes('t1') === true);
  });

  test('busy output is coalesced: at most one out per terminal per interval, nothing lost, in order', async () => {
    const t = setup({ timing: { outMs: 40 } });
    const { phone } = await paired(t);
    await phone.attach('t1');
    const since = phone.messages.length;
    for (let i = 0; i < 200; i++) t.terms.output('t1', `${i},`);
    await phone.sees('t1', '199,');
    const outs = phone.messages.slice(since).filter((m) => m.t === 'out');
    expect(outs.length).toBeLessThan(10);
    expect(outs.map((m) => m.data).join('')).toBe(Array.from({ length: 200 }, (_, i) => `${i},`).join(''));
  });

  test('typing into, or resizing, a terminal it has not opened is refused', async () => {
    const t = setup();
    const { phone } = await paired(t);
    phone.input('t2', 'x');
    expect(await phone.waitFor((m) => m.t === 'error')).toMatchObject({ rid: 0, code: 'invalid' });
    expect(t.terms.inputs).toEqual([]);
    expect((await phone.attach('nope')).t).toBe('error');
  });

  test('a resize reaches the terminal; another view taking the size is told as `size`; the end as `exit`', async () => {
    const t = setup();
    const { phone } = await paired(t);
    await phone.attach('t1');
    phone.resize('t1', 50, 20);
    await until(() => t.terms.resizes.length === 1);
    expect(t.terms.resizes).toEqual([['t1', 50, 20]]);
    (t.terms as unknown as { viewers: Map<number, RemoteViewer> }).viewers.forEach((v) => v.size('t1', 120, 40));
    expect(await phone.waitFor((m) => m.t === 'size')).toEqual({ t: 'size', id: 't1', cols: 120, rows: 40 });
    t.terms.exit('t1');
    expect(await phone.waitFor((m) => m.t === 'exit')).toEqual({ t: 'exit', id: 't1' });
  });

  test('create: a Claude session or a terminal in a listed project, at the phone\'s size; an unknown project is not found', async () => {
    const t = setup();
    const { phone } = await paired(t);
    await phone.attach('t1', 70, 25);
    expect(await phone.create(projectIdOf('/work/old'), 'claude')).toMatchObject({ t: 'created', id: 'new1' });
    expect(t.terms.created).toEqual([{ project: '/work/old', kind: 'claude', cols: 70, rows: 25 }]);
    expect(await phone.create(projectIdOf('/elsewhere'), 'terminal')).toMatchObject({ t: 'error', code: 'not-found' });
    await phone.state((s) => (s.sessions as Msg[]).some((x) => x.id === 'new1'));
  });

  test('state: sent again when it changes, coalesced, never when it is the same', async () => {
    const t = setup({ timing: { stateMs: 100 } });
    const { phone } = await paired(t);
    await phone.state();
    const states = () => phone.messages.filter((m) => m.t === 'state').length;
    const before = states();
    for (let i = 0; i < 10; i++) t.terms.set([...t.terms.list.slice(0, 2), term(`x${i}`, '/work/app', { createdAt: 5 })]);
    await phone.state((s) => (s.sessions as Msg[]).some((x) => x.id === 'x9'));
    await new Promise((r) => setTimeout(r, 250));
    expect(states() - before).toBeLessThanOrEqual(2);
    const settled = states();
    t.terms.set([...t.terms.list]);
    t.setProjects({ open: ['/work/app'], recent: ['/work/old'] });
    await new Promise((r) => setTimeout(r, 250));
    expect(states()).toBe(settled);
    t.setProjects({ open: [], recent: ['/work/old'] });
    const next = await phone.state((s) => (s.projects as Msg[])[0]?.open === false);
    expect(next.projects).toBeDefined();
  });

  test('removed in Settings: bye revoked at once, then it is a stranger', async () => {
    const t = setup();
    const { phone } = await paired(t);
    const id = t.hub.devices.list()[0]!.id;
    expect(t.hub.removeDevice(id)).toBe(true);
    expect(await phone.waitFor((m) => m.t === 'bye')).toEqual({ t: 'bye', reason: 'revoked' });
    await phone.closed();
    expect(await phone.connect()).toEqual({ t: 'denied', reason: 'unknown-device' });
    expect(t.terms.viewerCount()).toBe(0);
  });

  test('remote access turned off: bye disabled, the relay connection gone, nothing reconnects', async () => {
    const t = setup();
    const { phone } = await paired(t);
    const room = phone.room!;
    t.set({ remoteAccess: false });
    expect(await phone.waitFor((m) => m.t === 'bye')).toEqual({ t: 'bye', reason: 'disabled' });
    await until(() => !relay.hostOnline(room));
    await new Promise((r) => setTimeout(r, 200));
    expect(relay.hostOnline(room)).toBe(false);
    expect(t.statuses.at(-1)?.relay.state).toBe('offline');
  });

  test('the app quits: bye quitting', async () => {
    const t = setup();
    const { phone } = await paired(t);
    await t.hub.dispose();
    expect(phone.messages.at(-1)).toEqual({ t: 'bye', reason: 'quitting' });
  });

  test('the relay restarts: the computer comes back, the phone connects again', async () => {
    const t = setup({ link: { timing: { backoffMinMs: 20, backoffMaxMs: 60 } } });
    const { phone } = await paired(t);
    relay.dropAll();
    await until(() => t.hub.status().relay.state !== 'online');
    await until(() => t.hub.status().relay.state === 'online');
    expect((await phone.connect()).t).toBe('welcome');
    expect(t.terms.viewerCount()).toBe(1);
  });

  test('a phone that can\'t keep up (more than 8 MiB queued) is closed; it reconnects and attaches again', async () => {
    const t = setup({ link: { budget: { frames: { burst: 2, perSec: 2 }, bytes: { burst: 64 * 1024, perSec: 64 * 1024 } } } });
    const { phone } = await paired(t);
    await phone.attach('t1');
    const chunk = 'z'.repeat(256 * 1024);
    for (let i = 0; i < 40; i++) t.terms.output('t1', chunk);
    expect(await phone.closed(8000)).toBe(4429);
    expect((await phone.connect()).t).toBe('welcome');
    expect((await phone.attach('t1')).t).toBe('snapshot');
  });

  test('reset: every phone unpaired, a new room', async () => {
    const t = setup();
    const { phone } = await paired(t);
    const room = phone.room!;
    t.hub.reset();
    expect(await phone.waitFor((m) => m.t === 'bye')).toEqual({ t: 'bye', reason: 'revoked' });
    expect(t.hub.devices.list()).toEqual([]);
    await until(() => t.hub.status().relay.state === 'online');
    expect(relay.hostOnline(room)).toBe(false);
  });
});

test('the computer\'s name and app version reach the phone in the handshake', async () => {
  const t = setup();
  t.hub.start();
  await until(() => t.hub.status().relay.state === 'online');
  const start = await t.hub.startPairing();
  if (!start.ok) throw new Error('no code');
  const phone = t.phone();
  void phone.pairByCode(start.pairing.code).catch(() => {});
  await vi.waitFor(() => expect((phone as unknown as { channel: { hostHello: unknown } | null }).channel?.hostHello).toEqual({ v: 1, name: 'Studio Mac', app: '0.3.0', platform: 'darwin' }));
});

describe('what the sidebar shows (v1.1)', () => {
  const resetsAt = Math.floor(Date.now() / 1000) + 3600;
  const usage = (pct: number): UsageEntry => ({ configDir: '/home/.claude', usage: { fiveHour: { pct, resetsAt }, sevenDay: null, updatedAt: Date.now() } });

  test('state: every row\'s details and the resumables; usage after it, then again when it changes, never the same twice', async () => {
    const t = setup({ settings: { claudeAccounts: { list: [{ id: 'default', name: 'Claude', dir: '', color: 2 }, { id: 'work', name: 'Work', dir: '/acc/work', color: 5 }], newSession: 'default', dismissed: [] } } });
    t.terms.resumables = [{ id: 'r1', projectRoot: '/work/app', cwd: '/work/app', title: 'Old run', color: '#F28FAD', sessionId: 's-r1', endedAt: 5, configDir: '/acc/work' }];
    t.terms.usage = [usage(42)];
    const { phone } = await paired(t);
    const state = await phone.state();
    expect(state.resumables).toEqual([{ id: 'r1', project: projectIdOf('/work/app'), title: 'Old run', color: '#F28FAD', endedAt: 5, account: 'work' }]);
    expect((state.sessions as Msg[]).find((x) => x.id === 't2')).toMatchObject({ section: 'needs', detail: 'Needs permission' });
    const first = await phone.waitFor((m) => m.t === 'usage');
    expect(phone.messages.indexOf(first)).toBeGreaterThan(phone.messages.indexOf(state));
    expect(first.accounts).toEqual([
      { id: 'default', name: 'Claude', color: 2, default: true, fiveHour: { pct: 42, resetsAt: expect.any(Number) }, updatedAt: expect.any(Number) },
      { id: 'work', name: 'Work', color: 5, default: false }
    ]);
    // The same numbers (only updatedAt moved): nothing new; another percentage: a new usage.
    const count = () => phone.messages.filter((m) => m.t === 'usage').length;
    t.terms.usage = [{ ...usage(42), usage: { ...usage(42).usage, updatedAt: Date.now() + 5 } }];
    t.hub.usageChanged();
    await new Promise((r) => setTimeout(r, 120));
    expect(count()).toBe(1);
    t.terms.usage = [usage(57)];
    t.hub.usageChanged();
    const next = await phone.waitFor((m) => m.t === 'usage' && (m.accounts as Msg[])[0]!.fiveHour !== undefined && ((m.accounts as Msg[])[0]!.fiveHour as Msg).pct === 57);
    expect(next).toBeTruthy();
    // A resumable dismissed elsewhere: the state goes again.
    t.terms.resumables = [];
    t.terms.set(t.terms.list);
    await phone.state((s) => (s.resumables as Msg[]).length === 0);
  });

  test('a terminal launched as a Claude session reads as one while it starts', async () => {
    const t = setup();
    t.terms.list = [...t.terms.list, term('n1', '/work/app', { createdAt: 9 })];
    t.terms.starting = new Set(['n1']);
    const { phone } = await paired(t);
    const state = await phone.state((s) => (s.sessions as Msg[]).some((x) => x.id === 'n1'));
    expect((state.sessions as Msg[]).find((x) => x.id === 'n1')).toMatchObject({ claude: true, starting: true, detail: 'Starting…' });
  });

  test('ports and pull requests come from their hubs, by project', async () => {
    const t = setup({
      deps: {
        ports: (root): PortsMap => (root === '/work/app' ? { t1: [{ port: 3000, name: 'node' }] } : {}),
        prs: () => ({})
      }
    });
    const { phone } = await paired(t);
    const state = await phone.state();
    expect((state.sessions as Msg[]).find((x) => x.id === 't1')!.ports).toEqual([{ port: 3000, name: 'node' }]);
  });
});

describe('layouts (v1.1)', () => {
  const L = (o: Partial<RemoteLayout> = {}): RemoteLayout => ({
    groupByState: true, pins: ['t2'], order: { sessions: [], terminals: ['t1'] },
    workspaces: { active: 'w1', activities: true, places: [{ id: 'w1', name: 'Main', color: 1, open: true }, { id: 'a1', name: 'SSO', color: 3, parent: 'w1', open: false }], members: { t2: 'a1' } },
    ...o
  });

  test('after the first state, one layout per listed project (null when never shown), then each change once', async () => {
    const t = setup();
    const { phone } = await paired(t);
    const state = await phone.state();
    const ids = (state.projects as Msg[]).map((p) => p.id);
    const layouts = () => phone.messages.filter((m) => m.t === 'layout');
    await until(() => layouts().length === ids.length);
    expect(phone.messages.findIndex((m) => m.t === 'layout')).toBeGreaterThan(phone.messages.indexOf(state));
    expect(layouts().map((m) => [m.project, m.layout])).toEqual(ids.map((id) => [id, null]));
    t.hub.layoutChanged('/work/app', L());
    const app = projectIdOf('/work/app');
    const got = await phone.waitFor((m) => m.t === 'layout' && m.project === app && m.layout !== null);
    expect(got.layout).toEqual(L());
    // The same layout again: nothing; another one: sent.
    t.hub.layoutChanged('/work/app', L());
    await new Promise((r) => setTimeout(r, 100));
    expect(layouts()).toHaveLength(ids.length + 1);
    t.hub.layoutChanged('/work/app', L({ groupByState: false }));
    await phone.waitFor((m) => m.t === 'layout' && (m.layout as Msg | null)?.groupByState === false);
    // A project that comes into the list gets its layout with it.
    t.setProjects({ open: ['/work/app', '/work/new'], recent: ['/work/old'] });
    await phone.waitFor((m) => m.t === 'layout' && m.project === projectIdOf('/work/new'));
  });

  test('kept for a phone that connects later, and across restarts; never taken with access off', async () => {
    const t = setup();
    t.hub.layoutChanged('/work/app', L());
    const { phone } = await paired(t);
    const got = await phone.waitFor((m) => m.t === 'layout' && m.project === projectIdOf('/work/app'));
    expect(got.layout).toEqual(L());
    const again = setup({ home: t.home });
    again.hub.start();
    expect(again.hub.layoutOf('/work/app')).toEqual(L());
    const off = setup({ settings: { remoteAccess: false } });
    off.hub.layoutChanged('/work/app', L());
    expect(off.hub.layoutOf('/work/app')).toBeNull();
  });
});

describe('actions on rows (v1.1)', () => {
  const waitingSession = (o: object = {}) => ({ sessionId: 's', state: 'waiting', waitingFor: 'permission', title: null, activity: 'waiting: Bash npm test', contextPct: null, unread: false, updatedAt: 1, ...o }) as never;

  test('answer: only for the very wait the state showed; allow and deny reach the session; another wait is "The request changed"', async () => {
    const t = setup();
    t.terms.list = [term('w', '/work/app', { session: waitingSession() })];
    const { phone } = await paired(t);
    const row = (await phone.state((s) => (s.sessions as Msg[]).some((x) => x.id === 'w' && x.wait))).sessions as Msg[];
    const wait = row.find((x) => x.id === 'w')!.wait as string;
    expect(await phone.answer('w', wait, 'allow')).toMatchObject({ t: 'ok' });
    expect(t.terms.answers).toEqual([['w', 'allow']]);
    // A newer request (updated since): refused, nothing typed.
    t.terms.set([term('w', '/work/app', { session: waitingSession({ updatedAt: 2 }) })]);
    expect(await phone.answer('w', wait, 'deny')).toMatchObject({ t: 'error', code: 'busy', message: 'The request changed' });
    // No longer waiting at all: the same.
    t.terms.set([term('w', '/work/app', { session: waitingSession({ state: 'running', waitingFor: null, activity: 'Bash npm test' }) })]);
    expect(await phone.answer('w', wait, 'deny')).toMatchObject({ t: 'error', code: 'busy', message: 'The request changed' });
    expect(await phone.answer('gone', wait, 'allow')).toMatchObject({ t: 'error', code: 'not-found' });
    expect(t.terms.answers).toEqual([['w', 'allow']]);
  });

  test('answer: a question or a plan is answered in the session, never from the row', async () => {
    const t = setup();
    t.terms.list = [
      term('q', '/work/app', { session: waitingSession({ waitingFor: 'question', activity: 'waiting: question' }) }),
      term('p', '/work/app', { session: waitingSession({ activity: 'waiting: plan approval' }) })
    ];
    const { phone } = await paired(t);
    const rows = (await phone.state((s) => (s.sessions as Msg[]).filter((x) => x.wait).length === 2)).sessions as Msg[];
    const waitOf = (id: string) => rows.find((x) => x.id === id)!.wait as string;
    expect(await phone.answer('q', waitOf('q'), 'allow')).toMatchObject({ t: 'error', code: 'busy', message: 'The request changed' });
    expect(await phone.answer('p', waitOf('p'), 'allow')).toMatchObject({ t: 'error', code: 'invalid' });
    expect(t.terms.answers).toEqual([]);
  });

  test('rename, close, dismiss and resume a listed row; unknown ones are not found', async () => {
    const t = setup();
    t.terms.resumables = [
      { id: 'r1', projectRoot: '/work/app', cwd: '/work/app', title: 'Old', color: '#F28FAD', sessionId: 's-r1', endedAt: 5 },
      { id: 'r2', projectRoot: '/work/app', cwd: '/work/app', title: 'Older', color: '#F28FAD', sessionId: 's-r2', endedAt: 4 },
      { id: 'far', projectRoot: '/elsewhere', cwd: '/elsewhere', title: 'Far', color: '#F28FAD', sessionId: 's-far', endedAt: 4 }
    ];
    const { phone } = await paired(t);
    await phone.state();
    expect(await phone.rename('t1', 'Build')).toMatchObject({ t: 'ok' });
    expect(t.terms.renames).toEqual([['t1', 'Build']]);
    expect(await phone.closeRow('t1')).toMatchObject({ t: 'ok' });
    expect(t.terms.closes).toEqual(['t1']);
    expect(await phone.dismiss('r2')).toMatchObject({ t: 'ok' });
    expect(t.terms.dismissals).toEqual(['r2']);
    const resumed = await phone.resume('r1');
    expect(resumed).toMatchObject({ t: 'created', id: 'from-r1' });
    // The project's window keeps the row's pin and place: told before the resume, and after it.
    expect(t.rows).toEqual([['/work/app', { kind: 'resuming', id: 'r1' }], ['/work/app', { kind: 'resumed', from: 'r1', to: 'from-r1' }]]);
    // A project the phone doesn't list, and ids that aren't there.
    expect(await phone.resume('far')).toMatchObject({ t: 'error', code: 'not-found' });
    expect(await phone.dismiss('nope')).toMatchObject({ t: 'error', code: 'not-found' });
    expect(await phone.rename('nope', 'x')).toMatchObject({ t: 'error', code: 'not-found' });
    expect(await phone.closeRow('nope')).toMatchObject({ t: 'error', code: 'not-found' });
  });

  test('create in a place of the project\'s layout, as an account; an unknown place or account is refused', async () => {
    const t = setup({ settings: { claudeAccounts: { list: [{ id: 'default', name: 'Claude', dir: '', color: 1 }, { id: 'work', name: 'Work', dir: '/acc/work', color: 2 }], newSession: 'default', dismissed: [] } } });
    t.hub.layoutChanged('/work/app', { groupByState: true, pins: [], order: { sessions: [], terminals: [] }, workspaces: { active: 'w1', activities: true, places: [{ id: 'w1', name: 'Main', color: 1, open: true }, { id: 'a1', name: 'SSO', color: 2, parent: 'w1', open: false }], members: {} } });
    const { phone } = await paired(t);
    await phone.state();
    const app = projectIdOf('/work/app');
    expect(await phone.create(app, 'claude', { place: 'a1', account: 'work' })).toMatchObject({ t: 'created', id: 'new1' });
    expect(t.terms.created.at(-1)).toMatchObject({ project: '/work/app', kind: 'claude', account: 'work' });
    expect(t.rows).toEqual([['/work/app', { kind: 'join', id: 'new1', place: 'a1' }]]);
    // No place: wherever Atelier puts new rows; nothing for the window to do.
    expect(await phone.create(app, 'terminal')).toMatchObject({ t: 'created' });
    expect(t.rows).toHaveLength(1);
    expect(await phone.create(app, 'claude', { place: 'gone' })).toMatchObject({ t: 'error', code: 'not-found' });
    expect(await phone.create(app, 'claude', { account: 'nobody' })).toMatchObject({ t: 'error', code: 'not-found' });
    expect(await phone.create(app, 'terminal', { account: 'work' })).toMatchObject({ t: 'error', code: 'invalid' });
    expect(t.terms.created).toHaveLength(2);
  });
});

describe('push notifications (v1.1)', () => {
  const token = 'ab'.repeat(32);
  const key = Buffer.alloc(32, 7);
  const waitingTerm = (id: string, title: string) => term(id, '/work/app', { title, session: { sessionId: 's', state: 'waiting', waitingFor: 'permission', title: null, activity: 'waiting: Bash npm test', contextPct: null, unread: false, updatedAt: 1 } as never });
  const news = (...waiting: TerminalInfo[]) => ({ waiting, done: [], error: [] });
  const roomOf = (t: ReturnType<typeof setup>) => (t.hub as unknown as { identity: { roomId: string } }).identity.roomId;

  test('a registered phone gets a sealed notice through the relay: its token and environment, the key\'s id, a collapse key per session', async () => {
    const t = setup();
    const { phone } = await paired(t);
    await phone.state();
    expect(await phone.registerPush(token, 'sandbox', key)).toMatchObject({ t: 'ok' });
    t.hub.attention(news(waitingTerm('w1', 'Refactor auth')));
    await until(() => relay.pushes(roomOf(t)).length === 1);
    const f = relay.pushes(roomOf(t))[0]!;
    expect(f).toMatchObject({ t: 'push', to: token, env: 'sandbox', k: pushKeyId(key), c: collapseKeyOf('w1') });
    expect(f.id).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(JSON.parse(openPush(key, f.p))).toMatchObject({ v: 1, kind: 'waiting', title: 'Refactor auth', subtitle: 'app', body: 'Needs permission · Bash npm test', project: projectIdOf('/work/app'), id: 'w1' });
    // Nothing of it in the clear for the relay.
    expect(JSON.stringify(f)).not.toContain('Refactor auth');
  });

  test('unregistering, removing the phone or a dead token forgets it; kept encrypted across restarts', async () => {
    const t = setup();
    const { phone } = await paired(t);
    await phone.state();
    await phone.registerPush(token, 'production', key);

    // The relay says the token is dead: forgotten, nothing more goes to it.
    relay.pushAnswer(() => ({ status: 410, reason: 'Unregistered' }));
    t.hub.attention(news(waitingTerm('w3', 'Tests')));
    await until(() => relay.pushes().length === 1);
    await new Promise((r) => setTimeout(r, 50));
    t.hub.attention(news(waitingTerm('w4', 'More')));
    await new Promise((r) => setTimeout(r, 150));
    expect(relay.pushes()).toHaveLength(1);

    // Registered again, then unregistered: nothing.
    relay.pushAnswer(() => ({ status: 200 }));
    await phone.registerPush(token, 'sandbox', key);
    await phone.unregisterPush();
    t.hub.attention(news(waitingTerm('w5', 'Five')));
    await new Promise((r) => setTimeout(r, 150));
    expect(relay.pushes()).toHaveLength(1);

    // Registered again: after a restart it is still there.
    await phone.registerPush(token, 'production', key);
    phone.drop();
    await t.hub.dispose();
    const again = setup({ home: t.home });
    again.hub.start();
    await until(() => again.hub.status().relay.state === 'online');
    again.hub.attention(news(waitingTerm('w2', 'Docs')));
    await until(() => relay.pushes(roomOf(again)).some((f) => f.env === 'production'));

    // The phone removed in Settings: nothing.
    again.hub.removeDevice(again.hub.status().devices[0]!.id);
    again.hub.attention(news(waitingTerm('w6', 'Six')));
    await new Promise((r) => setTimeout(r, 150));
    expect(relay.pushes()).toHaveLength(2);
  });

  test('while the user is here (and the rule on), no notice', async () => {
    let away = false;
    const t = setup({ away: () => away });
    const { phone } = await paired(t);
    await phone.state();
    await phone.registerPush(token, 'sandbox', key);
    t.hub.attention(news(waitingTerm('w1', 'One')));
    await new Promise((r) => setTimeout(r, 150));
    expect(relay.pushes(roomOf(t))).toHaveLength(0);
    away = true;
    t.hub.attention(news(waitingTerm('w1', 'One')));
    await until(() => relay.pushes(roomOf(t)).length === 1);
  });
});
