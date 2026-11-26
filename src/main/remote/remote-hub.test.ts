import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import WebSocket from 'ws';
import type { Resumable, TerminalInfo } from '@shared/protocol';
import type { UsageEntry } from '@shared/session';
import type { PortsMap } from '@shared/ports';
import type { RemoteLayout, RemotePairingEvent, RemotePlaceOp, RemotePlaceResult, RemoteRowsEvent, RemoteSized, RemoteStatus } from '@shared/remote';
import { DEFAULT_SETTINGS, type Settings } from '@shared/settings';
import { THEMES } from '@shared/themes';
import { FakePhone, PhoneChannel, type Msg } from '../../../tests/support/fake-phone';
import { startTestRelay, type TestRelay } from '../../../tests/support/test-relay';
import { createSecretStore } from '../connectors/secret-store';
import { testSafeStorage } from '../connectors/test-safe-storage';
import type { RemoteViewer } from '../terminal-hub';
import { deriveCode, normalizeCode } from './code';
import { generateKeyPair } from './noise';
import { RemoteHub, type RemoteHubDeps, type RemoteWindowResult, type RemoteTerminals } from './remote-hub';
import { projectIdOf } from './state';
import { collapseKeyOf } from './push';
import { openPush, pushKeyId } from './push-seal';

const term = (id: string, projectRoot: string, o: Partial<TerminalInfo> = {}): TerminalInfo => ({
  id, projectRoot, cwd: projectRoot, title: `T ${id}`, name: null, color: '#fff', foreground: 'zsh', createdAt: 1, session: null, ...o
});

/** Claude Code's permission dialog for a command (`npm test` unless named) with these options, as a screen shows it. */
const npmDialog = (options: string[], command = 'npm test') => ['Bash command', '', `  ${command}`, '  Run the test suite', '', 'Do you want to proceed?', ...options, '', 'Esc to cancel · Tab to amend'];

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
  /** The keys answers pressed, and each terminal's screen as text (the usual permission dialog unless set). */
  answers: [string, string][] = [];
  screens = new Map<string, string[]>();
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
  /** While set, screen reads wait for it (an answer still on its way). */
  screenGate: Promise<void> | null = null;
  async permissionScreen(id: string) {
    if (!this.list.some((t) => t.id === id)) throw new Error('gone');
    if (this.screenGate) await this.screenGate;
    return this.screens.get(id) ?? npmDialog(['❯ 1. Yes', '  2. Yes, and don\'t ask again for npm test commands', '  3. No, and tell Claude what to do differently (esc)']);
  }
  answerKey(id: string, key: string) { this.answers.push([id, key]); }
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
    expect(welcome).toEqual({ t: 'welcome', host: { name: 'Studio Mac', platform: 'darwin', app: '0.3.0' }, room: phone.room });
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

  describe('the pages that show the code', () => {
    async function online() {
      const t = setup();
      t.hub.start();
      await until(() => t.hub.status().relay.state === 'online');
      return t;
    }

    test('the pairing lasts while a page that started it is there: the last one gone (closed, reloaded), it stops', async () => {
      const t = await online();
      expect(await t.hub.startPairing(1)).toMatchObject({ ok: true });
      expect(await t.hub.startPairing(2)).toMatchObject({ ok: true });
      await until(() => relay.offers().length === 1);
      t.hub.pageGone(1);
      await new Promise((r) => setTimeout(r, 50));
      expect(relay.offers()).toHaveLength(1);
      expect(t.pairing.some((e) => e.kind === 'stopped')).toBe(false);
      // A page that never showed it changes nothing.
      t.hub.pageGone(7);
      t.hub.pageGone(2);
      expect(t.pairing.at(-1)).toEqual({ kind: 'stopped' });
      await until(() => relay.offers().length === 0);
    });

    test('a phone waiting for Allow when the last page goes is told pairing is off', async () => {
      const t = await online();
      const start = await t.hub.startPairing(1);
      if (!start.ok) throw new Error('no code');
      const answer = t.phone().pairByCode(start.pairing.code);
      await until(() => t.pairing.some((e) => e.kind === 'request'));
      t.hub.pageGone(1);
      expect(await answer).toEqual({ t: 'denied', reason: 'disabled' });
    });

    test('the pages of an earlier pairing are not this one\'s: stopped or paired, the next starts with none', async () => {
      const t = await online();
      await t.hub.startPairing(1);
      t.hub.stopPairing();
      await t.hub.startPairing(2);
      t.hub.pageGone(1);
      await new Promise((r) => setTimeout(r, 50));
      expect(relay.offers()).toHaveLength(1);
      // Paired from page 2: the pairing is over; page 3's next one isn't held by page 2.
      const again = await t.hub.startPairing(2);
      if (!again.ok) throw new Error('no code');
      const answer = t.phone().pairByCode(again.pairing.code);
      await until(() => t.pairing.some((e) => e.kind === 'request'));
      t.hub.decide((t.pairing.find((e) => e.kind === 'request') as { request: { id: string } }).request.id, true);
      expect((await answer).t).toBe('welcome');
      await t.hub.startPairing(3);
      t.hub.pageGone(2);
      await new Promise((r) => setTimeout(r, 50));
      expect(relay.offers()).toHaveLength(1);
      t.hub.pageGone(3);
      await until(() => relay.offers().length === 0);
    });
  });

  describe('a phone that holds its last handshake message while the code goes', () => {
    /** Presents `code` and stops after message 2; `finish()` sends its message 3 later, as a slow or wily phone may. */
    async function holding(code: string) {
      const k = await deriveCode(normalizeCode(code)!);
      const ws = new WebSocket(relay.url.replace(/^http/, 'ws') + `/v1/pair/${k.lookup}`);
      const ch = new PhoneChannel({ kind: 'pair', id: k.lookup, key: generateKeyPair(), psk: k.psk });
      const s = { got: [] as Msg[], m3: null as Buffer | null, code: null as number | null, finish: () => ws.send(s.m3!), drop: () => ws.terminate() };
      ws.on('message', (data, binary) => {
        if (!binary) {
          if ((JSON.parse((data as Buffer).toString('utf8')) as Msg).host === 'online') ws.send(ch.start());
          return;
        }
        const r = ch.receive(data as Buffer);
        if (r.reply) s.m3 = r.reply;
        s.got.push(...r.messages);
      });
      ws.on('close', (c) => { s.code = c; });
      ws.on('error', () => {});
      await until(() => s.m3 !== null);
      return s;
    }
    const requests = (t: ReturnType<typeof setup>) => t.pairing.filter((e) => e.kind === 'request').length;

    async function online() {
      const t = setup();
      t.hub.start();
      await until(() => t.hub.status().relay.state === 'online');
      const start = await t.hub.startPairing();
      if (!start.ok) throw new Error('no code');
      return { t, code: start.pairing.code };
    }

    test('after another phone with the code was denied and the code replaced: expired, never asked about', async () => {
      const { t, code } = await online();
      const late = await holding(code);
      const answer = t.phone().pairByCode(code);
      await until(() => requests(t) === 1);
      t.hub.decide((t.pairing.find((e) => e.kind === 'request') as { request: { id: string } }).request.id, false);
      expect(await answer).toEqual({ t: 'denied', reason: 'declined' });
      await until(() => t.pairing.filter((e) => e.kind === 'code').length === 2);
      late.finish();
      await until(() => late.code !== null);
      expect(late.got).toEqual([{ t: 'denied', reason: 'expired' }]);
      expect(requests(t)).toBe(1);
      expect(t.hub.devices.list()).toEqual([]);
    });

    test('two phones with one code: the second is expired, and the first leaving still takes the question down', async () => {
      const { t, code } = await online();
      const first = await holding(code);
      const second = await holding(code);
      first.finish();
      await until(() => requests(t) === 1);
      second.finish();
      await until(() => second.code !== null);
      expect(second.got).toEqual([{ t: 'denied', reason: 'expired' }]);
      // The phone the windows ask about leaves: the question goes, the code (it knew it) is replaced.
      first.drop();
      await until(() => t.pairing.some((e) => e.kind === 'denied'));
      expect(t.pairing.filter((e) => e.kind === 'denied')).toEqual([{ kind: 'denied', reason: 'expired' }]);
      await until(() => t.pairing.filter((e) => e.kind === 'code').length === 2);
      // Allow on the question that was on screen adds nothing.
      expect(t.hub.decide((t.pairing.find((e) => e.kind === 'request') as { request: { id: string } }).request.id, true)).toBe(false);
      expect(t.hub.devices.list()).toEqual([]);
    });

    test('after the sheet closed: expired', async () => {
      const { t, code } = await online();
      const late = await holding(code);
      t.hub.stopPairing();
      late.finish();
      await until(() => late.code !== null);
      expect(late.got).toEqual([{ t: 'denied', reason: 'expired' }]);
      expect(requests(t)).toBe(0);
    });

    test('after the sheet closed and opened again with a new code: expired, and the new code still pairs', async () => {
      const { t, code } = await online();
      const late = await holding(code);
      t.hub.stopPairing();
      const again = await t.hub.startPairing();
      if (!again.ok) throw new Error('no code');
      late.finish();
      await until(() => late.code !== null);
      expect(late.got).toEqual([{ t: 'denied', reason: 'expired' }]);
      expect(requests(t)).toBe(0);
      const answer = t.phone().pairByCode(again.pairing.code);
      await until(() => requests(t) === 1);
      t.hub.decide((t.pairing.find((e) => e.kind === 'request') as { request: { id: string } }).request.id, true);
      expect((await answer).t).toBe('welcome');
      expect(t.hub.devices.list()).toHaveLength(1);
    });
  });
});

describe('a paired phone', () => {
  test('connects again by its room: welcome without the room, then the state', async () => {
    const t = setup();
    const { phone } = await paired(t);
    await phone.close();
    expect(await phone.connect()).toEqual({ t: 'welcome', host: { name: 'Studio Mac', platform: 'darwin', app: '0.3.0' } });
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
    // The old link closes on its own time: right after reset the status can still read online from it.
    await until(() => !relay.hostOnline(room));
    await until(() => t.hub.status().relay.state === 'online');
    // Online again, and not in the old room: a new one.
    expect(relay.hostOnline(room)).toBe(false);
  });
});

describe('what a relay can make this computer do', () => {
  test('at most 16 handshakes at once: channels beyond them are closed overloaded until one ends', async () => {
    await relay.close();
    relay = await startTestRelay({ maxChannels: 40 });
    const t = setup();
    const { phone } = await paired(t);
    await phone.close();
    const room = phone.room!;
    const dial = () => {
      const ws = new WebSocket(relay.url.replace(/^http/, 'ws') + `/v1/device/${room}`);
      const s = { ws, code: null as number | null };
      ws.on('close', (code) => { s.code = code; });
      ws.on('error', () => {});
      return s;
    };
    // Channels that never send their first handshake message: each would hold a handshake for 30 s.
    const idle = Array.from({ length: 16 }, dial);
    const channels = () => (t.hub as unknown as { channels: Map<number, unknown> }).channels.size;
    await until(() => channels() === 16);
    const extra = dial();
    await until(() => extra.code !== null);
    expect(extra.code).toBe(4429);
    expect(idle.every((s) => s.code === null)).toBe(true);
    await expect(phone.connect()).rejects.toThrow(/4429/);
    // One ends: there is room for a phone again.
    idle[0]!.ws.terminate();
    await until(() => channels() === 15);
    expect((await phone.connect()).t).toBe('welcome');
    for (const s of idle) s.ws.terminate();
  });
});

// Message 2 goes before the phone is known: a removed phone (it keeps the room id) or the relay (it routes the
// pairing lookup) can start a handshake and read it. Who the computer is comes only in welcome.
describe('who this computer is', () => {
  test('a pairing phone reads nothing of it in the handshake; welcome, after Allow, names it, its platform and version', async () => {
    const t = setup();
    t.hub.start();
    await until(() => t.hub.status().relay.state === 'online');
    const start = await t.hub.startPairing();
    if (!start.ok) throw new Error('no code');
    const phone = t.phone();
    const welcome = phone.pairByCode(start.pairing.code);
    await until(() => t.pairing.some((e) => e.kind === 'request'));
    expect(phone.hostHello).toEqual({ v: 1, name: '' });
    const req = t.pairing.find((e) => e.kind === 'request') as Extract<RemotePairingEvent, { kind: 'request' }>;
    expect(t.hub.decide(req.request.id, true)).toBe(true);
    expect(await welcome).toEqual({ t: 'welcome', host: { name: 'Studio Mac', platform: 'darwin', app: '0.3.0' }, room: phone.room });
  });

  test('a removed phone reads nothing of it', async () => {
    const t = setup();
    const { phone } = await paired(t);
    expect(t.hub.removeDevice(t.hub.devices.list()[0]!.id)).toBe(true);
    await phone.closed();
    expect(await phone.connect()).toEqual({ t: 'denied', reason: 'unknown-device' });
    expect(phone.hostHello).toEqual({ v: 1, name: '' });
  });
});

describe('what the sidebar shows', () => {
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

describe('how Atelier looks', () => {
  const looks = (phone: FakePhone) => phone.messages.filter((m) => m.t === 'look');

  test('after the first state: the theme in use, the terminal settings and every theme', async () => {
    const t = setup({ settings: { theme: 'ember', terminalFontSize: 16, cursorStyle: 'block' } });
    const { phone } = await paired(t);
    const state = await phone.state();
    const look = await phone.waitFor((m) => m.t === 'look');
    expect(phone.messages.indexOf(look)).toBeGreaterThan(phone.messages.indexOf(state));
    expect(look).toMatchObject({ theme: 'ember', terminalColors: 'theme', terminal: { font: 'JetBrains Mono', size: 16, lineHeight: 1.2, cursor: 'block', blink: true } });
    expect((look.themes as Msg[]).map((x) => x.id)).toEqual(THEMES.map((x) => x.id));
    expect(((look.themes as Msg[])[1]!.colors as Record<string, string>)['bg-0']).toMatch(/^#[0-9A-F]{6}$/);
  });

  test('a change in Settings › Appearance or Terminal sends it again; anything else, or the same look, does not', async () => {
    const t = setup();
    const { phone } = await paired(t);
    await phone.waitFor((m) => m.t === 'look');
    t.set({ theme: 'daylight' });
    expect(await phone.waitFor((m) => m.t === 'look' && m.theme === 'daylight')).toBeTruthy();
    t.set({ cursorBlink: false });
    expect(await phone.waitFor((m) => m.t === 'look' && (m.terminal as Msg).blink === false)).toMatchObject({ theme: 'daylight' });
    // The project colors (sent in the state) and the same look again: no new look.
    t.set({ projectColors: { '/work/app': 6 } });
    await phone.state((s) => (s.projects as Msg[])[0]!.color === 6);
    t.set({ theme: 'daylight', cursorBlink: false });
    await new Promise((r) => setTimeout(r, 100));
    expect(looks(phone)).toHaveLength(3);
  });

  test('a phone that connects again gets it again', async () => {
    const t = setup({ settings: { theme: 'tide' } });
    const { phone } = await paired(t);
    await phone.waitFor((m) => m.t === 'look');
    await phone.close();
    await until(() => !t.hub.hasPhones());
    await phone.connect();
    expect(await phone.waitFor((m) => m.t === 'look')).toMatchObject({ theme: 'tide' });
  });
});

describe('each project\'s sidebar arrangement', () => {
  const L = (o: Partial<RemoteLayout> = {}): RemoteLayout => ({
    groupByState: true, pins: ['t2'], order: { sessions: [], terminals: ['t1'] },
    workspaces: { active: 'w1', activities: true, places: [{ id: 'w1', name: 'Main', color: 1, open: true }, { id: 'a1', name: 'SSO', color: 3, parent: 'w1', open: false }], members: { t2: 'a1' } },
    ...o
  });

  test('after the first state, one layout per listed project (null when never shown), then each change once', async () => {
    // Activities on, as the window that sends L() has them.
    const t = setup({ settings: { wsActivities: true } });
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
    const t = setup({ settings: { wsActivities: true } });
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

describe('actions on rows', () => {
  const waitingSession = (o: object = {}) => ({ sessionId: 's', state: 'waiting', waitingFor: 'permission', title: null, activity: 'waiting: Bash npm test', contextPct: null, unread: false, updatedAt: 1, ...o }) as never;

  test('answer: only for the very wait the state showed, which later events of it don\'t change; another wait is "The request changed"', async () => {
    const t = setup();
    t.terms.list = [term('w', '/work/app', { session: waitingSession() })];
    const { phone } = await paired(t);
    const row = (await phone.state((s) => (s.sessions as Msg[]).some((x) => x.id === 'w' && x.wait))).sessions as Msg[];
    const wait = row.find((x) => x.id === 'w')!.wait as string;
    // A subagent's event during the same wait: the key stays, the answer goes.
    t.terms.set([term('w', '/work/app', { session: waitingSession({ updatedAt: 2, subagents: 1 }) })]);
    await phone.state((s) => (s.sessions as Msg[]).some((x) => x.id === 'w' && x.agents === 1));
    expect((await phone.state()).sessions as Msg[]).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'w', wait })]));
    expect(await phone.answer('w', wait, 'allow')).toMatchObject({ t: 'ok' });
    expect(t.terms.answers).toEqual([['w', '1']]);
    // The wait ends and another starts: refused, nothing typed.
    t.terms.set([term('w', '/work/app', { session: waitingSession({ state: 'running', waitingFor: null, activity: 'Bash npm test', updatedAt: 3 }) })]);
    t.terms.set([term('w', '/work/app', { session: waitingSession({ updatedAt: 4 }) })]);
    expect(await phone.answer('w', wait, 'deny')).toMatchObject({ t: 'error', code: 'busy', message: 'The request changed' });
    const fresh = ((await phone.state((s) => (s.sessions as Msg[]).some((x) => x.id === 'w' && x.wait && x.wait !== wait))).sessions as Msg[]).find((x) => x.id === 'w')!.wait as string;
    // Deny: Esc.
    expect(await phone.answer('w', fresh, 'deny')).toMatchObject({ t: 'ok' });
    // No longer waiting at all: refused.
    t.terms.set([term('w', '/work/app', { session: waitingSession({ state: 'running', waitingFor: null, activity: 'Bash npm test' }) })]);
    expect(await phone.answer('w', fresh, 'deny')).toMatchObject({ t: 'error', code: 'busy', message: 'The request changed' });
    expect(await phone.answer('gone', wait, 'allow')).toMatchObject({ t: 'error', code: 'not-found' });
    expect(t.terms.answers).toEqual([['w', '1'], ['w', '\x1b']]);
  });

  test('allow picks the screen\'s own "Yes"; with none to pick (or the cursor in a feedback field), refused and nothing typed', async () => {
    const t = setup();
    t.terms.list = [term('a', '/work/app', { session: waitingSession() }), term('b', '/work/app', { session: waitingSession() }), term('c', '/work/app', { session: waitingSession() })];
    t.terms.screens.set('a', npmDialog(['❯ 1. No', '  2. Yes']));
    t.terms.screens.set('b', npmDialog(['❯ 1. Yes, and don\'t ask again for this session', '  2. No']));
    t.terms.screens.set('c', npmDialog(['❯ 1. Yes, and tell Claude what to do next', '  2. No']));
    const { phone } = await paired(t);
    const rows = (await phone.state((s) => (s.sessions as Msg[]).filter((x) => x.wait).length === 3)).sessions as Msg[];
    const waitOf = (id: string) => rows.find((x) => x.id === id)!.wait as string;
    expect(await phone.answer('a', waitOf('a'), 'allow')).toMatchObject({ t: 'ok' });
    expect(await phone.answer('b', waitOf('b'), 'allow')).toMatchObject({ t: 'error', code: 'invalid', message: 'Open the session to answer' });
    expect(await phone.answer('c', waitOf('c'), 'allow')).toMatchObject({ t: 'error', code: 'invalid', message: 'Open the session to answer' });
    // Deny: Esc declines whatever the dialog lists.
    expect(await phone.answer('b', waitOf('b'), 'deny')).toMatchObject({ t: 'ok' });
    expect(t.terms.answers).toEqual([['a', '2'], ['b', '\x1b']]);
  });

  test('only the request the phone showed: another one in the dialog (another agent\'s, asked first) is refused, Allow and Deny alike', async () => {
    const t = setup();
    t.terms.list = [term('w', '/work/app', { session: waitingSession() })];
    // The phone shows the latest request (npm test); Claude Code shows the oldest first (rm -rf build).
    t.terms.screens.set('w', npmDialog(['❯ 1. Yes', '  2. No'], 'rm -rf build'));
    const { phone } = await paired(t);
    const wait = ((await phone.state((s) => (s.sessions as Msg[]).some((x) => x.id === 'w' && x.wait))).sessions as Msg[]).find((x) => x.id === 'w')!.wait as string;
    expect(await phone.answer('w', wait, 'allow')).toMatchObject({ t: 'error', code: 'invalid', message: 'Open the session to answer' });
    expect(await phone.answer('w', wait, 'deny')).toMatchObject({ t: 'error', code: 'invalid', message: 'Open the session to answer' });
    // The request answered at the Mac: the tool runs, no dialog any more. Deny would interrupt it: refused.
    t.terms.screens.set('w', ['⏺ Bash(npm test)', '  ⎿  Running…', '', '✻ Testing… (esc to interrupt)']);
    expect(await phone.answer('w', wait, 'deny')).toMatchObject({ t: 'error', code: 'invalid' });
    expect(t.terms.answers).toEqual([]);
    // Its own dialog on screen now: refused answers didn't count, this one goes.
    t.terms.screens.delete('w');
    expect(await phone.answer('w', wait, 'allow')).toMatchObject({ t: 'ok' });
    expect(t.terms.answers).toEqual([['w', '1']]);
  });

  test('a wait is answered once, one answer at a time: a double tap, or a Deny while the allowed tool runs, is refused; the next wait is answered', async () => {
    const t = setup();
    t.terms.list = [term('w', '/work/app', { session: waitingSession() })];
    const { phone } = await paired(t);
    const waitNow = async (not?: string) => ((await phone.state((s) => (s.sessions as Msg[]).some((x) => x.id === 'w' && x.wait && x.wait !== not))).sessions as Msg[]).find((x) => x.id === 'w')!.wait as string;
    const wait = await waitNow();
    // Two taps: both arrive while the first still reads the screen.
    let open!: () => void;
    t.terms.screenGate = new Promise<void>((r) => { open = r; });
    const first = phone.answer('w', wait, 'allow');
    const second = phone.answer('w', wait, 'allow');
    expect(await second).toMatchObject({ t: 'error', code: 'busy' });
    open();
    t.terms.screenGate = null;
    expect(await first).toMatchObject({ t: 'ok' });
    // After "Yes" the session waits under the same key until the tool has run: answered already.
    expect(await phone.answer('w', wait, 'allow')).toMatchObject({ t: 'error', code: 'busy', message: 'This request was answered already' });
    expect(await phone.answer('w', wait, 'deny')).toMatchObject({ t: 'error', code: 'busy', message: 'This request was answered already' });
    expect(t.terms.answers).toEqual([['w', '1']]);
    // The tool ran; the very same request comes again: a new wait, answered too.
    t.terms.set([term('w', '/work/app', { session: waitingSession({ state: 'running', waitingFor: null, activity: 'Bash npm test', updatedAt: 3 }) })]);
    t.terms.set([term('w', '/work/app', { session: waitingSession({ updatedAt: 4 }) })]);
    const again = await waitNow(wait);
    expect(await phone.answer('w', again, 'allow')).toMatchObject({ t: 'ok' });
    expect(t.terms.answers).toEqual([['w', '1'], ['w', '1']]);
  });

  test('answer: a question or a plan has no wait key and is answered in the session, never from the row', async () => {
    const t = setup();
    t.terms.list = [
      term('q', '/work/app', { session: waitingSession({ waitingFor: 'question', activity: 'waiting: question' }) }),
      term('p', '/work/app', { session: waitingSession({ activity: 'waiting: plan approval' }) })
    ];
    const { phone } = await paired(t);
    const rows = (await phone.state((s) => (s.sessions as Msg[]).filter((x) => x.state === 'waiting').length === 2)).sessions as Msg[];
    expect(rows.filter((x) => x.wait)).toEqual([]);
    expect(rows.find((x) => x.id === 'p')).toMatchObject({ permission: 'plan approval' });
    expect(await phone.answer('q', 'AAAAAAAAAAAAAAAAAAAAAA', 'allow')).toMatchObject({ t: 'error', code: 'busy', message: 'The request changed' });
    expect(await phone.answer('p', 'AAAAAAAAAAAAAAAAAAAAAA', 'allow')).toMatchObject({ t: 'error', code: 'busy', message: 'The request changed' });
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
    // Activities on: SSO is a place.
    const t = setup({ settings: { wsActivities: true, claudeAccounts: { list: [{ id: 'default', name: 'Claude', dir: '', color: 1 }, { id: 'work', name: 'Work', dir: '/acc/work', color: 2 }], newSession: 'default', dismissed: [] } } });
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

  test('create in a place of a project whose window is closed: the window opens for it and moves the new row there', async () => {
    const calls: [string, RemotePlaceOp][] = [];
    const t = setup({ deps: { places: async (root, op) => { calls.push([root, op]); return { ok: true }; } } });
    // A recent project, its window closed; its layout as its window last showed it.
    t.hub.layoutChanged('/work/old', { groupByState: true, pins: [], order: { sessions: [], terminals: [] }, workspaces: { active: 'w9', activities: false, places: [{ id: 'w9', name: 'Other', color: 4, open: true }, { id: 'w8', name: 'Release', color: 2, open: true }], members: {} } });
    const { phone } = await paired(t);
    await phone.state();
    expect(await phone.create(projectIdOf('/work/old'), 'claude', { place: 'w8' })).toMatchObject({ t: 'created', id: 'new1' });
    expect(t.terms.created.at(-1)).toMatchObject({ project: '/work/old', kind: 'claude' });
    await until(() => calls.length === 1);
    expect(calls).toEqual([['/work/old', { kind: 'move', id: 'new1', place: 'w8' }]]);
    // Nothing for a window that isn't there.
    expect(t.rows).toEqual([]);
  });
});

describe('workspaces and activities from the phone', () => {
  const app = projectIdOf('/work/app');
  const old = projectIdOf('/work/old');
  const layoutApp: RemoteLayout = {
    groupByState: true, pins: [], order: { sessions: [], terminals: [] },
    workspaces: { active: 'w1', activities: true, places: [{ id: 'w1', name: 'Main', color: 1, open: true }, { id: 'a1', name: 'SSO', color: 2, parent: 'w1', open: false }], members: {} }
  };
  const layoutOld: RemoteLayout = { ...layoutApp, workspaces: { active: 'w9', activities: false, places: [{ id: 'w9', name: 'Other', color: 4, open: true }], members: {} } };

  /** A paired phone whose window answers each change with `answer` (its calls kept). */
  async function withPlaces(answer: (root: string, op: RemotePlaceOp) => Promise<RemotePlaceResult> = async (_r, op) => (op.kind === 'workspace' || op.kind === 'activity' ? { ok: true, place: 'new1' } : { ok: true })) {
    const calls: [string, RemotePlaceOp][] = [];
    const t = setup({ deps: { places: (root, op) => { calls.push([root, op]); return answer(root, op); } } });
    t.terms.resumables = [{ id: 'r1', projectRoot: '/work/app', cwd: '/work/app', title: 'Old', color: '#F28FAD', sessionId: 's-r1', endedAt: 5 }];
    t.hub.layoutChanged('/work/app', layoutApp);
    t.hub.layoutChanged('/work/old', layoutOld);
    const { phone } = await paired(t);
    await phone.state();
    return { t, phone, calls };
  }

  test('state: carries the switches as Settings has them, and goes again when one changes', async () => {
    const { t, phone } = await withPlaces();
    expect((await phone.state()).features).toEqual({ workspacesEverywhere: false, activities: false });
    t.set({ wsActivities: true });
    expect((await phone.state((s) => (s.features as Msg | undefined)?.activities === true)).features).toEqual({ workspacesEverywhere: false, activities: true });
    t.set({ workspacesEverywhere: true });
    expect((await phone.state((s) => (s.features as Msg | undefined)?.workspacesEverywhere === true)).features).toEqual({ workspacesEverywhere: true, activities: true });
  });

  test('layouts: activities as the switch is now, over a layout a window sent before it changed; sent again when it changes', async () => {
    const { t, phone } = await withPlaces();
    const activitiesOf = (project: string) => () => ([...phone.messages].reverse().find((m) => m.t === 'layout' && m.project === project)?.layout as RemoteLayout | undefined)?.workspaces?.activities;
    // The window sent it with activities on; Settings has them off now.
    await until(() => activitiesOf(app)() === false);
    t.set({ wsActivities: true });
    await until(() => activitiesOf(app)() === true && activitiesOf(old)() === true);
    // The places stay as the window sent them.
    const last = [...phone.messages].reverse().find((m) => m.t === 'layout' && m.project === app)!.layout as RemoteLayout;
    expect(last.workspaces!.places).toEqual(layoutApp.workspaces!.places);
  });

  test('layouts: activities off over a layout sent with them on, as the window would show it (kept aside, their rows in their workspace), none of them a place', async () => {
    const { t, phone, calls } = await withPlaces();
    // The window, closed since, sent it with SSO (an activity of Main) in front and a row in it.
    t.hub.layoutChanged('/work/app', { ...layoutApp, workspaces: { ...layoutApp.workspaces!, active: 'a1', members: { t1: 'a1', t2: 'w1' } } });
    const sent = () => ([...phone.messages].reverse().find((m) => m.t === 'layout' && m.project === app)?.layout as RemoteLayout | undefined)?.workspaces;
    await until(() => sent()?.members.t2 === 'w1');
    expect(sent()).toEqual({ active: 'w1', activities: false, places: [layoutApp.workspaces!.places[0]], members: { t1: 'w1', t2: 'w1' } });
    // Not a place while they are off: nothing goes into it, nothing starts in it, it isn't renamed or closed.
    expect(await phone.request({ t: 'move', id: 't1', place: 'a1' })).toMatchObject({ t: 'error', code: 'not-found' });
    expect(await phone.request({ t: 'create', project: app, kind: 'terminal', place: 'a1' })).toMatchObject({ t: 'error', code: 'not-found' });
    expect(await phone.request({ t: 'renamePlace', project: app, place: 'a1', name: 'X' })).toMatchObject({ t: 'error', code: 'not-found' });
    expect(await phone.request({ t: 'closePlace', project: app, place: 'a1' })).toMatchObject({ t: 'error', code: 'not-found' });
    expect(calls).toEqual([]);
    // On again: as the window sent it.
    t.set({ wsActivities: true });
    await until(() => sent()?.activities === true);
    expect(sent()).toEqual({ active: 'a1', activities: true, places: layoutApp.workspaces!.places, members: { t1: 'a1', t2: 'w1' } });
  });

  test('workspace: refused in words where workspaces are off (or never shown), the window never asked; on in every project, it goes', async () => {
    const { t, phone, calls } = await withPlaces();
    t.hub.layoutChanged('/work/old', { groupByState: true, pins: [], order: { sessions: [], terminals: [] } });
    t.setProjects({ open: ['/work/app'], recent: ['/work/old', '/work/new'] });
    const fresh = projectIdOf('/work/new');
    await phone.state((s) => (s.projects as Msg[]).some((p) => p.id === fresh));
    for (const project of [old, fresh]) {
      expect(await phone.request({ t: 'workspace', project, name: 'Billing' })).toMatchObject({ t: 'error', code: 'invalid', message: 'Workspaces are off in this project. Turn them on in Atelier on this computer.' });
    }
    expect(calls).toEqual([]);
    t.set({ workspacesEverywhere: true });
    expect(await phone.request({ t: 'workspace', project: old })).toMatchObject({ t: 'created' });
    expect(await phone.request({ t: 'workspace', project: fresh })).toMatchObject({ t: 'created' });
    expect(calls.map(([root]) => root)).toEqual(['/work/old', '/work/new']);
  });

  test('activity: refused in words while activities are off, the window never asked; on, it goes', async () => {
    const { t, phone, calls } = await withPlaces();
    expect(await phone.request({ t: 'activity', project: app, workspace: 'w1' })).toMatchObject({ t: 'error', code: 'invalid', message: 'Activities are off. Turn them on in Atelier on this computer.' });
    expect(calls).toEqual([]);
    t.set({ wsActivities: true });
    expect(await phone.request({ t: 'activity', project: app, workspace: 'w1' })).toMatchObject({ t: 'created' });
    expect(calls).toEqual([['/work/app', { kind: 'activity', workspace: 'w1' }]]);
  });

  test('workspace: in a listed project whose workspaces are on, named or with Atelier\'s default', async () => {
    const { phone, calls } = await withPlaces();
    expect(await phone.request({ t: 'workspace', project: app })).toMatchObject({ t: 'created', id: 'new1' });
    expect(await phone.request({ t: 'workspace', project: old, name: 'Billing' })).toMatchObject({ t: 'created', id: 'new1' });
    expect(await phone.request({ t: 'workspace', project: app, name: '🚀'.repeat(60) })).toMatchObject({ t: 'created' });
    expect(calls).toEqual([['/work/app', { kind: 'workspace' }], ['/work/old', { kind: 'workspace', name: 'Billing' }], ['/work/app', { kind: 'workspace', name: '🚀'.repeat(60) }]]);
    expect(await phone.request({ t: 'workspace', project: 'nope' })).toMatchObject({ t: 'error', code: 'not-found' });
    for (const name of ['', '   ', 'x'.repeat(61), 'two\nlines', 'tab\there']) {
      expect(await phone.request({ t: 'workspace', project: app, name })).toMatchObject({ t: 'error', code: 'invalid', message: expect.stringMatching(/^A name /) });
    }
    expect(calls).toHaveLength(3);
  });

  test('activity: in a workspace of that project\'s layout; an activity, another project\'s workspace or an unknown one is refused', async () => {
    const { t, phone, calls } = await withPlaces();
    t.set({ wsActivities: true });
    expect(await phone.request({ t: 'activity', project: app, workspace: 'w1' })).toMatchObject({ t: 'created', id: 'new1' });
    expect(await phone.request({ t: 'activity', project: app, workspace: 'w1', name: 'Release' })).toMatchObject({ t: 'created' });
    expect(calls).toEqual([['/work/app', { kind: 'activity', workspace: 'w1' }], ['/work/app', { kind: 'activity', workspace: 'w1', name: 'Release' }]]);
    expect(await phone.request({ t: 'activity', project: app, workspace: 'a1' })).toMatchObject({ t: 'error', code: 'invalid', message: 'An activity goes inside a workspace.' });
    expect(await phone.request({ t: 'activity', project: app, workspace: 'w9' })).toMatchObject({ t: 'error', code: 'invalid', message: 'This workspace is in another project.' });
    expect(await phone.request({ t: 'activity', project: app, workspace: 'zz' })).toMatchObject({ t: 'error', code: 'not-found' });
    expect(await phone.request({ t: 'activity', project: 'nope', workspace: 'w1' })).toMatchObject({ t: 'error', code: 'not-found' });
    expect(await phone.request({ t: 'activity', project: app, workspace: 'w1', name: '' })).toMatchObject({ t: 'error', code: 'invalid' });
    expect(calls).toHaveLength(2);
  });

  test('renamePlace: a workspace or an activity of that project, 1…60 characters', async () => {
    const { t, phone, calls } = await withPlaces();
    t.set({ wsActivities: true });
    expect(await phone.request({ t: 'renamePlace', project: app, place: 'w1', name: 'Auth' })).toMatchObject({ t: 'ok' });
    expect(await phone.request({ t: 'renamePlace', project: app, place: 'a1', name: 'Okta' })).toMatchObject({ t: 'ok' });
    expect(calls).toEqual([['/work/app', { kind: 'rename', place: 'w1', name: 'Auth' }], ['/work/app', { kind: 'rename', place: 'a1', name: 'Okta' }]]);
    expect(await phone.request({ t: 'renamePlace', project: app, place: 'w9', name: 'X' })).toMatchObject({ t: 'error', code: 'invalid', message: 'This workspace or activity is in another project.' });
    expect(await phone.request({ t: 'renamePlace', project: app, place: 'zz', name: 'X' })).toMatchObject({ t: 'error', code: 'not-found' });
    expect(await phone.request({ t: 'renamePlace', project: app, place: 'w1', name: '' })).toMatchObject({ t: 'error', code: 'invalid' });
    expect(calls).toHaveLength(2);
  });

  test('move: a terminal or a resumable into a place of its own project; another project\'s place is refused', async () => {
    const { t, phone, calls } = await withPlaces();
    t.set({ wsActivities: true });
    expect(await phone.request({ t: 'move', id: 't1', place: 'a1' })).toMatchObject({ t: 'ok' });
    expect(await phone.request({ t: 'move', id: 'r1', place: 'w1' })).toMatchObject({ t: 'ok' });
    expect(calls).toEqual([['/work/app', { kind: 'move', id: 't1', place: 'a1' }], ['/work/app', { kind: 'move', id: 'r1', place: 'w1' }]]);
    expect(await phone.request({ t: 'move', id: 't1', place: 'w9' })).toMatchObject({ t: 'error', code: 'invalid', message: 'This workspace or activity is in another project.' });
    expect(await phone.request({ t: 'move', id: 't1', place: 'zz' })).toMatchObject({ t: 'error', code: 'not-found' });
    expect(await phone.request({ t: 'move', id: 'nope', place: 'w1' })).toMatchObject({ t: 'error', code: 'not-found' });
    expect(calls).toHaveLength(2);
  });

  test('a project with workspaces off has no place to name: not found until its window turns them on', async () => {
    const { t, phone, calls } = await withPlaces();
    t.hub.layoutChanged('/work/app', { groupByState: true, pins: [], order: { sessions: [], terminals: [] } });
    await phone.waitFor((m) => m.t === 'layout' && m.project === app && !(m.layout as Msg).workspaces);
    expect(await phone.request({ t: 'move', id: 't1', place: 'w1' })).toMatchObject({ t: 'error', code: 'not-found' });
    expect(await phone.request({ t: 'renamePlace', project: app, place: 'a1', name: 'X' })).toMatchObject({ t: 'error', code: 'not-found' });
    expect(calls).toEqual([]);
  });

  test('closePlace: a workspace or an activity of that project; what is in it moves unless the phone says stop', async () => {
    const { t, phone, calls } = await withPlaces();
    t.set({ wsActivities: true });
    expect(await phone.request({ t: 'closePlace', project: app, place: 'w1' })).toMatchObject({ t: 'ok' });
    expect(await phone.request({ t: 'closePlace', project: app, place: 'a1', sessions: 'stop' })).toMatchObject({ t: 'ok' });
    expect(await phone.request({ t: 'closePlace', project: app, place: 'a1', sessions: 'move' })).toMatchObject({ t: 'ok' });
    expect(calls).toEqual([['/work/app', { kind: 'close', place: 'w1', how: 'move' }], ['/work/app', { kind: 'close', place: 'a1', how: 'stop' }], ['/work/app', { kind: 'close', place: 'a1', how: 'move' }]]);
    expect(await phone.request({ t: 'closePlace', project: app, place: 'w9' })).toMatchObject({ t: 'error', code: 'invalid', message: 'This workspace or activity is in another project.' });
    expect(await phone.request({ t: 'closePlace', project: app, place: 'zz' })).toMatchObject({ t: 'error', code: 'not-found' });
    expect(await phone.request({ t: 'closePlace', project: 'nope', place: 'w1' })).toMatchObject({ t: 'error', code: 'not-found' });
    expect(calls).toHaveLength(3);
  });

  test('closePlace: the window\'s refusal (the last workspace stays) passes on as it is', async () => {
    const { phone } = await withPlaces(async () => ({ ok: false, code: 'invalid', message: 'A project\'s last workspace stays.' }));
    expect(await phone.request({ t: 'closePlace', project: app, place: 'w1' })).toMatchObject({ t: 'error', code: 'invalid', message: 'A project\'s last workspace stays.' });
  });

  test('the window\'s refusals pass on as they are; no answer, or no window to ask, is `failed`', async () => {
    const { t: on, phone } = await withPlaces(async (_r, op) => {
      if (op.kind === 'rename') return { ok: false, code: 'not-found', message: 'This workspace is not in the project any more.' };
      if (op.kind === 'activity') return { ok: false, code: 'invalid', message: 'This workspace has 20 activities already.' };
      if (op.kind === 'move') throw new Error('window gone');
      return { ok: false, code: 'failed', message: 'The project\'s window did not answer.' };
    });
    on.set({ wsActivities: true });
    expect(await phone.request({ t: 'renamePlace', project: app, place: 'w1', name: 'A' })).toEqual({ t: 'error', rid: expect.any(Number), code: 'not-found', message: 'This workspace is not in the project any more.' });
    expect(await phone.request({ t: 'activity', project: app, workspace: 'w1' })).toMatchObject({ t: 'error', code: 'invalid', message: 'This workspace has 20 activities already.' });
    expect(await phone.request({ t: 'workspace', project: app })).toMatchObject({ t: 'error', code: 'failed', message: 'The project\'s window did not answer.' });
    expect(await phone.request({ t: 'move', id: 't1', place: 'w1' })).toMatchObject({ t: 'error', code: 'failed' });
    // No window to ask, in a project whose workspaces are on.
    const t = setup();
    t.hub.layoutChanged('/work/app', layoutApp);
    const p = await paired(t);
    await p.phone.state();
    expect(await p.phone.request({ t: 'workspace', project: app })).toMatchObject({ t: 'error', code: 'failed' });
  });
});

describe('project windows from the phone', () => {
  const app = projectIdOf('/work/app');
  const old = projectIdOf('/work/old');
  type Call = ['open', string] | ['close', string, 'keep' | 'stop' | undefined];

  /** A paired phone whose computer opens and closes windows with `answer` (its calls kept). */
  async function withWindows(answer: (call: Call) => Promise<RemoteWindowResult> = async () => ({ ok: true }), deps: Partial<RemoteHubDeps> = {}) {
    const calls: Call[] = [];
    const t = setup({
      deps: {
        windows: {
          open: (root) => { const c: Call = ['open', root]; calls.push(c); return answer(c); },
          close: (root, sessions) => { const c: Call = ['close', root, sessions]; calls.push(c); return answer(c); }
        },
        ...deps
      }
    });
    t.terms.resumables = [{ id: 'r-old', projectRoot: '/work/old', cwd: '/work/old', title: 'Old', color: '#F28FAD', sessionId: 's-r', endedAt: 5 }];
    const { phone } = await paired(t);
    await phone.state();
    return { t, phone, calls };
  }

  test('openWindow: a listed project\'s window, a recent one included; an unknown project is not found', async () => {
    const { phone, calls } = await withWindows();
    expect(await phone.request({ t: 'openWindow', project: old })).toMatchObject({ t: 'ok' });
    expect(await phone.request({ t: 'openWindow', project: app })).toMatchObject({ t: 'ok' });
    expect(calls).toEqual([['open', '/work/old'], ['open', '/work/app']]);
    expect(await phone.request({ t: 'openWindow', project: 'nope' })).toMatchObject({ t: 'error', code: 'not-found', message: 'This project is not on this computer any more.' });
    expect(calls).toHaveLength(2);
  });

  test('closeWindow: with the phone\'s answer about what is busy, or without one; an unknown project is not found', async () => {
    const { phone, calls } = await withWindows();
    expect(await phone.request({ t: 'closeWindow', project: app })).toMatchObject({ t: 'ok' });
    expect(await phone.request({ t: 'closeWindow', project: app, sessions: 'keep' })).toMatchObject({ t: 'ok' });
    expect(await phone.request({ t: 'closeWindow', project: old, sessions: 'stop' })).toMatchObject({ t: 'ok' });
    expect(calls).toEqual([['close', '/work/app', undefined], ['close', '/work/app', 'keep'], ['close', '/work/old', 'stop']]);
    expect(await phone.request({ t: 'closeWindow', project: 'nope' })).toMatchObject({ t: 'error', code: 'not-found' });
    expect(calls).toHaveLength(3);
  });

  test('the computer\'s refusals pass on as they are; a failure, or no way to reach the windows, is `failed`', async () => {
    const { phone } = await withWindows(async (c) => {
      if (c[0] === 'close') return { ok: false, code: 'invalid', message: 'It has unsaved files: save or close them on this computer first.' };
      throw new Error('gone');
    });
    expect(await phone.request({ t: 'closeWindow', project: app })).toEqual({ t: 'error', rid: expect.any(Number), code: 'invalid', message: 'It has unsaved files: save or close them on this computer first.' });
    expect(await phone.request({ t: 'openWindow', project: old })).toMatchObject({ t: 'error', code: 'failed' });
    const t = setup();
    const p = await paired(t);
    await p.phone.state();
    expect(await p.phone.request({ t: 'openWindow', project: old })).toMatchObject({ t: 'error', code: 'failed' });
    expect(await p.phone.request({ t: 'closeWindow', project: app })).toMatchObject({ t: 'error', code: 'failed' });
  });

  // Atelier's own New Session always happens in a window: one the phone starts in a closed project opens it there.
  test('create in a project whose window is closed opens it after the start; an open one, or a create in a place, opens nothing more', async () => {
    const places: [string, RemotePlaceOp][] = [];
    const { t, phone, calls } = await withWindows(undefined, { places: async (root, op) => { places.push([root, op]); return { ok: true }; } });
    t.hub.layoutChanged('/work/old', { groupByState: true, pins: [], order: { sessions: [], terminals: [] }, workspaces: { active: 'w9', activities: false, places: [{ id: 'w9', name: 'Other', color: 4, open: true }, { id: 'w8', name: 'Release', color: 2, open: true }], members: {} } });
    expect(await phone.create(old, 'claude')).toMatchObject({ t: 'created', id: 'new1' });
    await until(() => calls.length === 1);
    expect(calls).toEqual([['open', '/work/old']]);
    expect(await phone.create(app, 'terminal')).toMatchObject({ t: 'created' });
    // The place's move opens the window itself: not twice.
    expect(await phone.create(old, 'claude', { place: 'w8' })).toMatchObject({ t: 'created' });
    await until(() => places.length === 1);
    await new Promise((r) => setTimeout(r, 20));
    expect(calls).toEqual([['open', '/work/old']]);
  });

  test('resume in a project whose window is closed opens it once resumed; a window that won\'t open still leaves the session created', async () => {
    const logs: string[] = [];
    const { phone, calls } = await withWindows(async () => ({ ok: false, code: 'failed', message: 'The project\'s folder isn\'t there any more.' }), { log: (m) => logs.push(m) });
    expect(await phone.resume('r-old')).toMatchObject({ t: 'created', id: 'from-r-old' });
    await until(() => calls.length === 1);
    expect(calls).toEqual([['open', '/work/old']]);
    await until(() => logs.some((l) => l.includes('window')));
    expect(await phone.create(old, 'terminal')).toMatchObject({ t: 'created' });
  });
});

describe('push notifications', () => {
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

  test('only phones still paired are woken: a registration left behind by a phone no longer in the list gets nothing', async () => {
    const t = setup();
    const { phone } = await paired(t);
    await phone.state();
    await phone.registerPush(token, 'sandbox', key);
    // Gone from the paired phones by any other way than Remove (a damaged list, an older version's): its registration stays.
    t.hub.devices.remove(t.hub.devices.list()[0]!.id);
    t.hub.attention(news(waitingTerm('w1', 'One')));
    await new Promise((r) => setTimeout(r, 150));
    expect(relay.pushes(roomOf(t))).toHaveLength(0);
  });

  test('the 21st phone paired makes room like Remove: the phone seen longest ago is told revoked, its notices stop, Settings no longer lists it', async () => {
    await relay.close();
    relay = await startTestRelay({ maxChannels: 40 });
    const t = setup();
    const { phone: oldest } = await paired(t);
    await oldest.state();
    await oldest.registerPush(token, 'sandbox', key);
    const oldestId = t.hub.devices.list()[0]!.id;
    // Nineteen more, all seen after it.
    await new Promise((r) => setTimeout(r, 20));
    for (let i = 0; i < 19; i++) t.hub.devices.add({ name: `Phone ${i}`, model: 'iPhone17,1', key: Buffer.alloc(32, i + 1).toString('base64url') });
    expect(t.hub.devices.list()).toHaveLength(20);
    const start = await t.hub.startPairing();
    if (!start.ok) throw new Error('no code');
    const newest = t.phone();
    const welcome = newest.pairByCode(start.pairing.code);
    await until(() => t.pairing.filter((e) => e.kind === 'request').length === 2);
    const req = t.pairing.filter((e) => e.kind === 'request').at(-1) as Extract<RemotePairingEvent, { kind: 'request' }>;
    t.hub.decide(req.request.id, true);
    expect((await welcome).t).toBe('welcome');
    expect(await oldest.waitFor((m) => m.t === 'bye')).toEqual({ t: 'bye', reason: 'revoked' });
    expect(t.hub.devices.byId(oldestId)).toBeNull();
    await until(() => t.statuses.at(-1)!.devices.length === 20 && !t.statuses.at(-1)!.devices.some((d) => d.id === oldestId));
    t.hub.attention(news(waitingTerm('w1', 'One')));
    await new Promise((r) => setTimeout(r, 150));
    expect(relay.pushes(roomOf(t))).toHaveLength(0);
    expect((t.hub as unknown as { pushes: { list(): unknown[] } }).pushes.list()).toEqual([]);
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
