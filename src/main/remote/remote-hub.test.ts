import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { TerminalInfo } from '@shared/protocol';
import type { RemotePairingEvent, RemoteStatus } from '@shared/remote';
import { DEFAULT_SETTINGS, type Settings } from '@shared/settings';
import { FakePhone, type Msg } from '../../../tests/support/fake-phone';
import { startTestRelay, type TestRelay } from '../../../tests/support/test-relay';
import { createSecretStore } from '../connectors/secret-store';
import { testSafeStorage } from '../connectors/test-safe-storage';
import type { RemoteViewer } from '../terminal-hub';
import { RemoteHub, type RemoteHubDeps, type RemoteTerminals } from './remote-hub';
import { projectIdOf } from './state';

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
  created: { project: string; kind: string; cols: number; rows: number }[] = [];
  sized: string[] = [];
  allTerminals() { return this.list; }
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
  async createRemoteSession(o: { project: string; kind: 'claude' | 'terminal'; cols: number; rows: number }) {
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

function setup(o: { settings?: Partial<Settings>; safe?: Parameters<typeof testSafeStorage>[0]; timing?: RemoteHubDeps['timing']; link?: RemoteHubDeps['link']; home?: string } = {}) {
  const home = o.home ?? mkdtempSync(join(tmpdir(), 'atl-remote-hub-'));
  let settings: Settings = { ...DEFAULT_SETTINGS, remoteAccess: true, remoteRelay: relay.url, projectColors: { '/work/app': 4 }, ...o.settings };
  const terms = new FakeTerminals();
  terms.list = [term('t1', '/work/app'), term('t2', '/work/app', { createdAt: 2, session: { sessionId: 's', state: 'waiting', waitingFor: 'permission', title: null, activity: null, contextPct: null, unread: false, updatedAt: 0 } as never })];
  const statuses: RemoteStatus[] = [];
  const pairing: RemotePairingEvent[] = [];
  let projects = { open: ['/work/app'], recent: ['/work/old'] };
  const hub = new RemoteHub({
    home, secrets: createSecretStore(home, testSafeStorage(o.safe)), settings: () => settings, relayUrl: () => settings.remoteRelay,
    terminals: terms, projects: () => projects, host: { name: 'Studio Mac', app: '0.3.0', platform: 'darwin' },
    emitStatus: (s) => statuses.push(s), emitPairing: (e) => pairing.push(e),
    timing: { stateMs: 30, ...o.timing }, ...(o.link ? { link: o.link } : {})
  });
  hubs.push(hub);
  const phone = (opts: Partial<ConstructorParameters<typeof FakePhone>[0]> = {}) => { const p = new FakePhone({ relay: relay.url, ...opts }); phones.push(p); return p; };
  const set = (patch: Partial<Settings>) => { settings = { ...settings, ...patch }; hub.settingsChanged(); };
  const setProjects = (p: typeof projects) => { projects = p; hub.projectsChanged(); };
  return { hub, home, terms, statuses, pairing, phone, set, setProjects };
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
