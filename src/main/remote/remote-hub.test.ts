import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import WebSocket from 'ws';
import { PAGE_BYTES, WRAPPER_BYTES } from '@shared/conversation/pages';
import { encodeProjectPath } from '@shared/history';
import type { Resumable, TerminalInfo } from '@shared/protocol';
import type { UsageEntry } from '@shared/session';
import type { PortsMap } from '@shared/ports';
import type { RemoteLayout, RemotePairingEvent, RemotePlaceOp, RemotePlaceResult, RemoteRowsEvent, RemoteSized, RemoteStatus } from '@shared/remote';
import { DEFAULT_SETTINGS, type Settings } from '@shared/settings';
import { THEMES } from '@shared/themes';
import { FakePhone, PhoneChannel, type Msg } from '../../../tests/support/fake-phone';
import { expectMode } from '../../../tests/support/platform';
import { startTestRelay, type TestRelay } from '../../../tests/support/test-relay';
import { createSecretStore } from '../connectors/secret-store';
import { testSafeStorage } from '../connectors/test-safe-storage';
import type { RemoteViewer } from '../terminal-hub';
import { deriveCode, normalizeCode } from './code';
import { generateKeyPair } from './noise';
import { readDialog, type DialogWait } from './dialog';
import { screenView, type ScreenView } from './prompt';
import { TYPED_RECENTLY_MS } from './prompt-outbox';
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
  /** Each terminal's screen rows with their dim text as spaces (its `screens` rows unless set). */
  dims = new Map<string, string[]>();
  /** Whether each terminal's program asked for bracketed paste (as Claude Code and zsh do, unless set). */
  pasteModes = new Map<string, boolean>();
  /** The terminals an Atelier window has open, and when a window last typed in each (ms). */
  windows = new Set<string>();
  windowInput = new Map<string, number>();
  /** A terminal's Claude account dir (none: the default account). */
  accountDirs = new Map<string, string>();
  /** Each attach's `take`: whether it took the terminal's size. */
  takes: boolean[] = [];
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
  /** While set, attaches wait for it before the screen comes (an attach on its way). */
  attachGate: Promise<void> | null = null;
  async remoteAttach(k: number, id: string, cols: number, rows: number, take = true) {
    if (!this.list.some((t) => t.id === id)) throw new Error('no such terminal');
    if (this.attachGate) await this.attachGate;
    this.takes.push(take);
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
  /**
   * Screens a terminal shows one after the other, as keys change them: each read takes the next one, the last one
   * stays (an error: that read fails). Set, they come before `screens`.
   */
  views = new Map<string, (ScreenView | Error)[]>();
  /** Every screen read ('read') and every key answers pressed, in order; and how many screen reads there were. */
  events: string[] = [];
  reads = 0;
  /** Called with each key answers press, once it is pressed (what the computer does meanwhile). */
  onKey: ((id: string, key: string) => void) | null = null;
  /** While set, screen reads wait for it (an answer still on its way); `gated` counts the reads that waited. */
  screenGate: Promise<void> | null = null;
  gated = 0;
  async permissionScreen(id: string) {
    if (!this.list.some((t) => t.id === id)) throw new Error('gone');
    if (this.screenGate) { this.gated++; await this.screenGate; }
    return this.screenOf(id).lines;
  }
  async screenView(id: string): Promise<ScreenView> {
    if (!this.list.some((t) => t.id === id)) throw new Error('gone');
    if (this.screenGate) { this.gated++; await this.screenGate; }
    return this.screenOf(id);
  }
  /** The screen a read of terminal `id` finds now (every screen read goes through here). */
  private screenOf(id: string): ScreenView {
    this.events.push('read');
    this.reads++;
    const next = this.views.get(id);
    if (next?.length) {
      const v = next.length > 1 ? next.shift()! : next[0]!;
      if (v instanceof Error) throw v;
      return v;
    }
    const lines = this.screens.get(id) ?? npmDialog(['❯ 1. Yes', '  2. Yes, and don\'t ask again for npm test commands', '  3. No, and tell Claude what to do differently (esc)']);
    return { lines, undimmed: this.dims.get(id) ?? lines, cols: 120, bracketedPaste: this.pasteModes.get(id) ?? true };
  }
  windowShows(id: string) { return this.windows.has(id); }
  lastWindowInput(id: string) { return this.windowInput.get(id) ?? 0; }
  accountDirOf(_project: string | null, terminalId: string | undefined) { return terminalId === undefined ? undefined : this.accountDirs.get(terminalId); }
  answerKey(id: string, key: string) { this.answers.push([id, key]); this.events.push(key); this.onKey?.(id, key); }
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
  vi.unstubAllEnvs();
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
  // Where Atelier keeps the images pasted into its terminals (its temp folder's on macOS): a phone's go there too.
  const imageDir = join(home, 'clipboard');
  let settings: Settings = { ...DEFAULT_SETTINGS, remoteAccess: true, remoteRelay: relay.url, projectColors: { '/work/app': 4 }, ...o.settings };
  const terms = new FakeTerminals();
  terms.list = [term('t1', '/work/app'), term('t2', '/work/app', { createdAt: 2, session: { sessionId: 's', state: 'waiting', waitingFor: 'permission', title: null, activity: null, contextPct: null, unread: false, updatedAt: 0 } as never })];
  const statuses: RemoteStatus[] = [];
  const pairing: RemotePairingEvent[] = [];
  const rows: [string, RemoteRowsEvent][] = [];
  let projects = { open: ['/work/app'], recent: ['/work/old'] };
  const hub = new RemoteHub({
    home, imageDir, secrets: createSecretStore(home, testSafeStorage(o.safe)), settings: () => settings, relayUrl: () => settings.remoteRelay,
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
  return { hub, home, imageDir, terms, statuses, pairing, phone, set, setProjects, rows };
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

  test('attach fit: a Claude session a window shows keeps its size; no window, or a plain terminal, takes it as before', async () => {
    const t = setup();
    const claude = { sessionId: 's3', state: 'idle', title: null, activity: null, contextPct: null, unread: false, updatedAt: 0 } as never;
    t.terms.list = [...t.terms.list, term('t3', '/work/app', { createdAt: 3, session: claude }), term('n1', '/work/app', { createdAt: 4 })];
    t.terms.starting = new Set(['n1']);
    t.terms.windows = new Set(['t1', 't2', 'n1']);
    const { phone } = await paired(t);
    // Shown by a window: the snapshot comes at the terminal's size, the phone's size kept for when it types.
    expect(await phone.attach('t2', 60, 30, { fit: true })).toMatchObject({ t: 'snapshot', id: 't2' });
    expect(await phone.attach('n1', 60, 30, { fit: true })).toMatchObject({ t: 'snapshot', id: 'n1' });
    expect(t.terms.takes).toEqual([false, false]);
    // A plain terminal a window shows, a Claude session no window shows, an attach without fit (an older phone).
    await phone.attach('t1', 60, 30, { fit: true });
    await phone.attach('t3', 60, 30, { fit: true });
    await phone.attach('t2', 60, 30);
    expect(t.terms.takes).toEqual([false, false, true, true, true]);
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

  test('every waiting row carries `ask`, a key of that very wait whatever it waits for; the wait over and asked again, a new key', async () => {
    const t = setup();
    const waiting = (o: object = {}) => ({ sessionId: 's', state: 'waiting', waitingFor: 'question', title: null, activity: 'waiting: question', contextPct: null, unread: false, updatedAt: 1, ...o }) as never;
    const plan = term('p', '/work/app', { createdAt: 4, session: waiting({ waitingFor: 'permission', activity: 'waiting: plan approval' }) });
    t.terms.list = [term('t1', '/work/app'), term('q', '/work/app', { createdAt: 3, session: waiting() }), plan];
    const { phone } = await paired(t);
    const row = (s: Msg, id: string) => (s.sessions as Msg[]).find((x) => x.id === id)!;
    const first = await phone.state((s) => !!row(s, 'q').ask && !!row(s, 'p').ask);
    const ask = row(first, 'q').ask as string;
    expect(ask).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(row(first, 'p').ask).not.toBe(ask);
    // Neither a question nor a plan is one a row answers: no `wait`. A plain terminal waits for nothing.
    expect([row(first, 'q').wait, row(first, 'p').wait, row(first, 't1').ask]).toEqual([undefined, undefined, undefined]);
    // The question answered, then another one at once (no state in between): another key.
    t.terms.set([term('t1', '/work/app'), term('q', '/work/app', { createdAt: 3, session: waiting({ state: 'running', waitingFor: null, activity: 'Thinking', updatedAt: 2 }) }), plan]);
    t.terms.set([term('t1', '/work/app'), term('q', '/work/app', { createdAt: 3, session: waiting({ updatedAt: 3 }) }), plan]);
    const next = await phone.state((s) => !!row(s, 'q').ask && row(s, 'q').ask !== ask);
    expect(row(next, 'p').ask).toBe(row(first, 'p').ask);
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

// A Claude session's transcript lines, and a hub that reads them.
const T = '2026-11-25T10:00:00.000Z';
const prompt = (text: string) => ({ type: 'user', timestamp: T, message: { role: 'user', content: text } });
const reply = (text: string) => ({ type: 'assistant', timestamp: T, message: { role: 'assistant', content: [{ type: 'text', text }] } });
/** A tool call (`Bash` with a command unless named), by Claude or, `side`, by a subagent. */
const call = (id: string, command: string, o: { name?: string; input?: Record<string, unknown>; side?: true } = {}) => ({
  type: 'assistant', timestamp: T, ...(o.side ? { isSidechain: true } : {}),
  message: { role: 'assistant', content: [{ type: 'tool_use', id, name: o.name ?? 'Bash', input: o.input ?? { command } }] }
});
const done = (id: string, out: string) => ({
  type: 'user', timestamp: T, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: out }] }, toolUseResult: { stdout: out, stderr: '' }
});
const jsonl = (...lines: unknown[]) => lines.map((l) => `${JSON.stringify(l)}\n`).join('');
const claude = (sessionId: string) => ({ sessionId, state: 'running', title: null, activity: null, contextPct: null, unread: false, updatedAt: 1 }) as never;
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * A hub whose Claude sessions' transcripts are `<dir>/<terminal id>.jsonl` (`<session id>.jsonl` with `bySession`, as
 * Claude Code keeps one per session), read every 20 ms; keys typed into a session 5 ms apart, an Enter after a prompt
 * waited for 150 ms at most, an image's marker 300 ms, a whole prompt's typing 500 ms, of a clock that moves 5 ms with
 * each screen read: a slow machine reads no fewer times.
 */
function conversing(o: { lingerMs?: number; chatMs?: number; bySession?: boolean; imageMs?: number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'atl-conversation-'));
  const file = (id: string) => join(dir, `${id}.jsonl`);
  // A transcript moved (as Claude Code moves one into a worktree's folder) swaps it for a file made beforehand in one
  // step. A rename over it would too, but Windows refuses that rename (EPERM) while the 20 ms poll has the file open.
  const moved = new Map<string, string>();
  let reads = () => 0;
  const timing = { pollMs: 20, chatMs: o.chatMs ?? 20, keyMs: 5, enterMs: 5, enterCapMs: 150, imageCapMs: 300, typingCapMs: 500, retryMs: 5, slowMs: 20, staleMs: 400, now: () => reads() * 5, ...(o.lingerMs ? { lingerMs: o.lingerMs } : {}) };
  const transcriptOf = (x: TerminalInfo) => {
    if (!x.session) return null;
    const key = o.bySession ? x.session.sessionId : x.id;
    return moved.get(key) ?? file(key);
  };
  const t = setup({ deps: { conversation: { transcriptOf, home: null, timing } }, ...(o.imageMs ? { timing: { imageMs: o.imageMs } } : {}) });
  reads = () => t.terms.reads;
  return {
    ...t, dir, file,
    write: (id: string, ...lines: unknown[]) => writeFileSync(file(id), jsonl(...lines)),
    append: (id: string, ...lines: unknown[]) => appendFileSync(file(id), jsonl(...lines)),
    /** The session's transcript is at `to` from now on, a file (or link) made at `to` beforehand. */
    move: (id: string, to: string) => { moved.set(id, to); }
  };
}

/** Another phone paired with the same computer, after the first. */
async function another(t: ReturnType<typeof setup>): Promise<FakePhone> {
  const start = await t.hub.startPairing();
  if (!start.ok) throw new Error(start.message);
  const phone = t.phone();
  const welcome = phone.pairByCode(start.pairing.code);
  await until(() => t.pairing.filter((e) => e.kind === 'request').length === 2);
  const req = t.pairing.filter((e) => e.kind === 'request').at(-1) as Extract<RemotePairingEvent, { kind: 'request' }>;
  t.hub.decide(req.request.id, true);
  expect((await welcome).t).toBe('welcome');
  return phone;
}

describe('following a Claude session\'s conversation', () => {
  const ns = (m: Msg) => (m.entries as Msg[]).map((e) => e.n);
  const UNREADABLE = 'The conversation can\'t be read. Open the terminal.';

  /** The `chat`s for a session from message `since` on. */
  const chats = (phone: FakePhone, id: string, since = 0) => phone.messages.slice(since).filter((m) => m.t === 'chat' && m.id === id);
  const badge = (t: ReturnType<typeof setup>) => t.statuses.at(-1)?.devices[0]?.attached ?? [];

  test('follow: a Claude session\'s newest page with its key, then new entries as Claude writes them; unfollow stops them', async () => {
    const t = conversing();
    t.write('t2', prompt('List the files.'), reply('Sure.'), call('b1', 'ls'));
    const { phone } = await paired(t);
    const page = await phone.follow('t2');
    expect(page).toMatchObject({ t: 'chat', id: 't2', rid: expect.any(Number), conversation: expect.stringMatching(/^[A-Za-z0-9_-]{16}$/), start: true });
    expect(page.pending).toBeUndefined();
    expect((page.entries as Msg[]).map((e) => [e.n, e.k])).toEqual([[1, 'prompt'], [2, 'reply'], [3, 'tool']]);
    expect((page.entries as Msg[])[2]).toMatchObject({ tool: 'Bash', target: 'ls', status: 'running' });
    // The Bash call's result and a reply: only what changed, under the same key, without a rid.
    const since = phone.messages.length;
    t.append('t2', done('b1', 'hello.txt'), reply('One file.'));
    await until(() => phone.conversation('t2').length === 4 && phone.conversation('t2')[2]!.status === 'ok');
    const live = chats(phone, 't2', since);
    expect(live.every((m) => m.rid === undefined && m.conversation === page.conversation && m.start === undefined)).toBe(true);
    expect(live.flatMap(ns)).toEqual([3, 4]);
    expect(phone.conversation('t2').map((e) => [e.n, e.k, e.status ?? null])).toEqual([[1, 'prompt', null], [2, 'reply', null], [3, 'tool', 'ok'], [4, 'reply', null]]);
    // Unfollowed (a request after it shows it was handled): nothing more.
    phone.unfollow('t2');
    expect(await phone.follow('gone')).toMatchObject({ t: 'error' });
    const after = phone.messages.length;
    t.append('t2', reply('More.'));
    await pause(200);
    expect(chats(phone, 't2', after)).toEqual([]);
  });

  test('follow before n: the page just older, nothing followed by it', async () => {
    const t = conversing();
    t.write('t2', prompt('One.'), reply('1.'), prompt('Two.'), reply('2.'), prompt('Three.'));
    const { phone } = await paired(t);
    const older = await phone.follow('t2', 3);
    expect(older).toMatchObject({ t: 'chat', id: 't2', rid: expect.any(Number), start: true });
    expect(ns(older)).toEqual([1, 2]);
    // Not followed: not on the badge, and what Claude writes next isn't sent.
    const since = phone.messages.length;
    t.append('t2', reply('3.'));
    await pause(200);
    expect(chats(phone, 't2', since)).toEqual([]);
    expect(badge(t)).toEqual([]);
    // The newest page, under the same key.
    const newest = await phone.follow('t2');
    expect(newest.conversation).toBe(older.conversation);
    expect(ns(newest)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  test('follow refuses a terminal not listed, a plain terminal, and a 17th session', async () => {
    const t = conversing();
    const many = Array.from({ length: 17 }, (_, i) => term(`c${i}`, '/work/app', { createdAt: 10 + i, session: claude(`s${i}`) }));
    t.terms.list = [...t.terms.list, ...many];
    const { phone } = await paired(t);
    expect(await phone.follow('gone')).toEqual({ t: 'error', rid: expect.any(Number), code: 'not-found', message: 'This session is not on this computer any more.' });
    expect(await phone.follow('t1')).toMatchObject({ t: 'error', code: 'invalid', message: 'This is not a Claude session.' });
    expect(await phone.follow('t1', 5)).toMatchObject({ t: 'error', code: 'invalid', message: 'This is not a Claude session.' });
    for (const c of many.slice(0, 16)) expect(await phone.follow(c.id)).toMatchObject({ t: 'chat', id: c.id, pending: true });
    expect(await phone.follow('c16')).toMatchObject({ t: 'error', code: 'busy', message: 'Too many conversations open.' });
    // One of the 16 followed again: its page again. One unfollowed: the 17th is followed.
    expect(await phone.follow('c3')).toMatchObject({ t: 'chat', id: 'c3' });
    phone.unfollow('c0');
    expect(await phone.follow('c16')).toMatchObject({ t: 'chat', id: 'c16' });
    await until(() => badge(t).length === 16 && !badge(t).includes('c0'));
  });

  test('pending: a session with no transcript yet, then its entries under the same key', async () => {
    const t = conversing();
    const starting = term('n1', '/work/app', { createdAt: 9 });
    t.terms.list = [...t.terms.list, starting];
    t.terms.starting = new Set(['n1']);
    const { phone } = await paired(t);
    // Still starting: no session yet.
    const page = await phone.follow('n1');
    expect(page).toEqual({ t: 'chat', id: 'n1', rid: expect.any(Number), conversation: expect.stringMatching(/^[A-Za-z0-9_-]{16}$/), entries: [], start: true, pending: true });
    // Another terminal's news while it starts: a terminal list, with it still sessionless.
    t.terms.set(t.terms.list.map((x) => (x.id === 't1' ? { ...x, title: 'Renamed' } : x)));
    await pause(60);
    // Claude started: its session id comes before its transcript (Claude Code writes it at the first prompt).
    t.terms.starting = new Set();
    t.terms.set([...t.terms.list.filter((x) => x.id !== 'n1'), { ...starting, session: claude('s-new') }]);
    await pause(100);
    t.write('n1', prompt('Hi.'), reply('Hello.'));
    await until(() => phone.conversation('n1').length === 2);
    expect(chats(phone, 'n1').every((m) => m.conversation === page.conversation)).toBe(true);
    expect(phone.conversation('n1').map((e) => [e.n, e.k])).toEqual([[1, 'prompt'], [2, 'reply']]);
  });

  test('a transcript gone from its place keeps what was read, under its key: nothing is sent, a follow meanwhile gets it; back, only what changed comes', async () => {
    const t = conversing();
    t.write('t2', prompt('Hi.'), reply('Hello.'));
    const { phone } = await paired(t);
    const page = await phone.follow('t2');
    const since = phone.messages.length;
    rmSync(t.file('t2'));
    await pause(150);
    expect(chats(phone, 't2', since)).toEqual([]);
    // Followed again while it is gone (the phone's view opened again): the entries read last, under the same key.
    const again = await phone.follow('t2');
    expect(again).toMatchObject({ t: 'chat', id: 't2', conversation: page.conversation, start: true });
    expect(again.pending).toBeUndefined();
    expect(ns(again)).toEqual([1, 2]);
    const back = phone.messages.length;
    t.write('t2', prompt('Hi.'), reply('Hello.'), prompt('Again.'));
    await until(() => phone.conversation('t2').length === 3);
    expect(chats(phone, 't2', back).every((m) => m.conversation === page.conversation && m.pending === undefined)).toBe(true);
    expect(chats(phone, 't2', back).flatMap(ns)).toEqual([3]);
  });

  test('a session followed while it starts whose transcript comes with a long history (a resume): its newest page under a new key, never every entry', async () => {
    const t = conversing();
    const starting = term('n1', '/work/app', { createdAt: 9 });
    t.terms.list = [...t.terms.list, starting];
    t.terms.starting = new Set(['n1']);
    const { phone } = await paired(t);
    const page = await phone.follow('n1');
    expect(page).toMatchObject({ pending: true, start: true });
    t.terms.starting = new Set();
    t.terms.set([...t.terms.list.filter((x) => x.id !== 'n1'), { ...starting, session: claude('s-resumed') }]);
    await pause(60);
    // Three hundred entries at once.
    const since = phone.messages.length;
    writeFileSync(join(t.dir, 'next.jsonl'), jsonl(...Array.from({ length: 300 }, (_, i) => prompt(`Prompt ${i + 1}.`))));
    renameSync(join(t.dir, 'next.jsonl'), t.file('n1'));
    const live = await phone.waitFor((m) => m.t === 'chat' && m.id === 'n1', { since });
    expect(live.conversation).not.toBe(page.conversation);
    expect([live.rid, live.start, live.pending]).toEqual([undefined, undefined, undefined]);
    expect(ns(live)).toEqual(Array.from({ length: 200 }, (_, i) => i + 101));
    await pause(150);
    expect(chats(phone, 'n1', since)).toHaveLength(1);
    // The older ones on request, under that key.
    const older = await phone.follow('n1', 101);
    expect(older).toMatchObject({ conversation: live.conversation, start: true });
    expect(ns(older)).toEqual(Array.from({ length: 100 }, (_, i) => i + 1));
  });

  test('Claude exiting in a followed terminal ends the follow quietly: off the badge, nothing sent, the phone keeps what it shows', async () => {
    const t = conversing();
    t.write('t2', prompt('Hi.'), reply('Hello.'));
    const { phone } = await paired(t);
    await phone.follow('t2');
    await until(() => badge(t).includes('t2'));
    const since = phone.messages.length;
    // The shell back in front: no Claude session in the terminal any more, none starting.
    t.terms.set(t.terms.list.map((x) => (x.id === 't2' ? { ...x, foreground: 'zsh', session: null } : x)));
    await until(() => badge(t).length === 0);
    t.append('t2', reply('Late.'));
    await pause(150);
    expect(phone.messages.slice(since).filter((m) => m.t === 'chat' || m.t === 'error')).toEqual([]);
    expect(phone.conversation('t2').map((e) => e.n)).toEqual([1, 2]);
    expect(await phone.follow('t2')).toMatchObject({ t: 'error', code: 'invalid', message: 'This is not a Claude session.' });
  });

  test('/clear in a followed terminal: the session ends with Claude still in front, the next one starts; still followed, the new conversation comes under a new key', async () => {
    const t = conversing({ bySession: true });
    const inFront = (session: unknown) => t.terms.list.map((x) => (x.id === 't2' ? { ...x, foreground: '2.1.332', session: session as never } : x));
    t.terms.list = inFront(claude('s-before'));
    t.write('s-before', prompt('Before.'), reply('Old.'));
    const { phone } = await paired(t);
    const page = await phone.follow('t2');
    // SessionEnd: no session, Claude still the terminal's program.
    t.terms.set(inFront(null));
    await pause(150);
    expect(badge(t)).toContain('t2');
    // SessionStart with a new id, its transcript written at its first prompt.
    t.write('s-after', prompt('After.'));
    t.terms.set(inFront(claude('s-after')));
    await until(() => phone.conversation('t2').some((e) => e.text === 'After.'));
    expect(chats(phone, 't2').at(-1)!.conversation).not.toBe(page.conversation);
    expect(phone.conversation('t2').map((e) => e.text)).toEqual(['After.']);
    expect(badge(t)).toContain('t2');
  });

  test('changes coalesce: lines Claude Code writes together go in few messages, nothing lost', async () => {
    // How changes 5 ms apart wait for chatMs is the conversations' own test, on its clock.
    const t = conversing({ chatMs: 200 });
    t.write('t2', prompt('Hi.'));
    const { phone } = await paired(t);
    await phone.follow('t2');
    const since = phone.messages.length;
    t.append('t2', ...Array.from({ length: 10 }, (_, i) => prompt(`Line ${i}.`)));
    await until(() => phone.conversation('t2').length === 11);
    expect(chats(phone, 't2', since).flatMap(ns)).toEqual(Array.from({ length: 10 }, (_, i) => i + 2));
    expect(chats(phone, 't2', since).length).toBeLessThanOrEqual(3);
  });

  test('two phones follow one session: each its own pages; one unfollowing leaves the other\'s', async () => {
    const t = conversing();
    t.write('t2', prompt('Hi.'));
    const { phone: one } = await paired(t);
    const two = await another(t);
    const [a, b] = [await one.follow('t2'), await two.follow('t2')];
    expect(b.conversation).toBe(a.conversation);
    expect([ns(a), ns(b)]).toEqual([[1], [1]]);
    one.unfollow('t2');
    expect(await one.follow('gone')).toMatchObject({ t: 'error' });
    const since = one.messages.length;
    t.append('t2', reply('Hello.'));
    await until(() => two.conversation('t2').length === 2);
    await pause(100);
    expect(chats(one, 't2', since)).toEqual([]);
    await until(() => t.statuses.at(-1)!.devices.filter((d) => d.attached.includes('t2')).length === 1);
  });

  test('a follow refused while the session is followed: answered, and followed no more; every follow waiting is answered', async () => {
    const t = conversing();
    t.write('t2', prompt('Hi.'));
    const { phone } = await paired(t);
    const page = await phone.follow('t2');
    await until(() => badge(t).includes('t2'));
    const since = phone.messages.length;
    const real = join(t.dir, 'elsewhere.jsonl');
    writeFileSync(real, jsonl(prompt('Hi.')));
    symlinkSync(real, join(t.dir, 'link.jsonl'));
    t.move('t2', join(t.dir, 'link.jsonl'));
    await phone.waitFor((m) => m.t === 'error' && m.rid === page.rid, { since });
    const failed = { t: 'error', rid: expect.any(Number), code: 'failed', message: UNREADABLE };
    expect(await Promise.all([phone.follow('t2'), phone.follow('t2')])).toEqual([failed, failed]);
    await until(() => badge(t).length === 0);
  });

  test('a phone following a session shows on its badge: status lists it until unfollow or the channel\'s end', async () => {
    const t = conversing();
    t.write('t2', prompt('Hi.'));
    const { phone } = await paired(t);
    await phone.follow('t2');
    await until(() => badge(t).includes('t2'));
    phone.unfollow('t2');
    await until(() => badge(t).length === 0);
    await phone.follow('t2');
    await until(() => badge(t).includes('t2'));
    phone.drop();
    await until(() => t.statuses.at(-1)?.devices[0]?.connected === false);
    expect(badge(t)).toEqual([]);
  });

  test('a session that leaves the list is followed no more', async () => {
    const t = conversing();
    t.write('t2', prompt('Hi.'));
    const { phone } = await paired(t);
    await phone.follow('t2');
    await until(() => badge(t).includes('t2'));
    t.terms.set(t.terms.list.filter((x) => x.id !== 't2'));
    await until(() => badge(t).length === 0);
    const since = phone.messages.length;
    t.append('t2', reply('Late.'));
    await pause(150);
    expect(chats(phone, 't2', since)).toEqual([]);
  });

  test('reconnecting: the same key and the newest page, nothing lost while away', async () => {
    const t = conversing();
    t.write('t2', prompt('Hi.'), reply('Hello.'));
    const { phone } = await paired(t);
    const first = await phone.follow('t2');
    phone.drop();
    await until(() => t.statuses.at(-1)?.devices[0]?.connected === false);
    t.append('t2', prompt('While away.'), reply('Done.'));
    await pause(100);
    expect((await phone.connect()).t).toBe('welcome');
    const again = await phone.follow('t2');
    expect(again.conversation).toBe(first.conversation);
    expect(ns(again)).toEqual([1, 2, 3, 4]);
    t.append('t2', prompt('Back.'));
    await until(() => phone.conversation('t2').length === 5);
  });

  test('followed again once the computer stopped reading it: the newest page, then every change', async () => {
    const t = conversing({ lingerMs: 40 });
    t.write('t2', prompt('Hi.'), reply('Hello.'));
    const { phone } = await paired(t);
    const first = await phone.follow('t2');
    // Changes while followed move the conversation's count of changes on.
    for (const text of ['A.', 'B.', 'C.']) {
      t.append('t2', prompt(text));
      await until(() => phone.conversation('t2').at(-1)?.text === text);
    }
    phone.unfollow('t2');
    // Nobody follows it: after a while it is no longer read, its count of changes starting again.
    await pause(250);
    const again = await phone.follow('t2');
    expect(again.conversation).toBe(first.conversation);
    expect(ns(again)).toEqual([1, 2, 3, 4, 5]);
    t.append('t2', reply('Next.'));
    await until(() => phone.conversation('t2').length === 6);
  });

  test('a transcript that can\'t be read: follow fails; a followed one says so once, and its entries come again once it reads', async () => {
    const t = conversing();
    // A folder where the transcript would be.
    mkdirSync(t.file('t2'));
    const { phone } = await paired(t);
    expect(await phone.follow('t2')).toEqual({ t: 'error', rid: expect.any(Number), code: 'failed', message: UNREADABLE });
    await pause(100);
    expect(badge(t)).toEqual([]);
    expect(await phone.follow('t2', 3)).toMatchObject({ t: 'error', code: 'failed', message: UNREADABLE });
    // A transcript, followed; entry 1 a command still running, 200 entries after it.
    rmSync(t.file('t2'), { recursive: true });
    const lines = [call('b1', 'npm test'), ...Array.from({ length: 200 }, (_, i) => prompt(`Prompt ${i}.`))];
    t.write('t2', ...lines);
    const page = await phone.follow('t2');
    expect(ns(page)).toEqual(Array.from({ length: 200 }, (_, i) => i + 2));
    // Replaced by a link: never read through it. Said once, while every read fails.
    const since = phone.messages.length;
    const real = join(t.dir, 'elsewhere.jsonl');
    writeFileSync(real, jsonl(...lines));
    // Each change in one step (the transcript moved to a path made beforehand): never a moment with no file.
    const swap = (name: string, make: (at: string) => void) => { const at = join(t.dir, name); make(at); t.move('t2', at); };
    swap('link.jsonl', (at) => symlinkSync(real, at));
    expect(await phone.waitFor((m) => m.t === 'error', { since })).toEqual({ t: 'error', rid: page.rid, code: 'failed', message: UNREADABLE });
    await pause(150);
    expect(phone.messages.slice(since).filter((m) => m.t === 'error')).toHaveLength(1);
    expect(badge(t)).toEqual(['t2']);
    // A file again, with the command done meanwhile: the newest page again, and the change to entry 1 with it.
    const back = phone.messages.length;
    swap('back.jsonl', (at) => writeFileSync(at, jsonl(...lines, done('b1', 'passed'), prompt('Back.'))));
    await until(() => phone.conversation('t2').at(-1)?.text === 'Back.' && phone.conversation('t2')[0]?.n === 1);
    expect(chats(phone, 't2', back).every((m) => m.rid === undefined && m.conversation === page.conversation)).toBe(true);
    expect(chats(phone, 't2', back).flatMap(ns)).toEqual([1, ...Array.from({ length: 200 }, (_, i) => i + 3)]);
    expect(phone.conversation('t2')[0]).toMatchObject({ n: 1, status: 'ok' });
  });

  test('a full page with the longest id and rid stays within 512 KiB of JSON, wrapper included; live changes too', async () => {
    const t = conversing();
    const id = 'x'.repeat(64);
    t.terms.list = [...t.terms.list, term(id, '/work/app', { createdAt: 3, session: claude('s-long') })];
    // Replies that weigh exactly 4 KiB each as entries: a page fills to the byte, so a wrapper left out of its budget
    // would take the message over.
    const W = 4096;
    const at = Date.parse(T);
    const sized = (n: number) => {
      const room = W - (JSON.stringify({ k: 'reply', at, text: '', n }).length + 1);
      return reply(`${'word '.repeat(room)}`.slice(0, room - 1) + '.');
    };
    t.write(id, ...Array.from({ length: 140 }, (_, i) => sized(i + 1)));
    const { phone } = await paired(t);
    const bytes = (m: Msg) => Buffer.byteLength(JSON.stringify(m), 'utf8');
    const weighs = (m: Msg) => (m.entries as Msg[]).every((e) => Buffer.byteLength(JSON.stringify(e), 'utf8') + 1 === W);
    const rid = 2 ** 31 - 1;
    phone.send({ t: 'follow', rid, id });
    const page = await phone.waitFor((m) => m.t === 'chat' && m.rid === rid);
    expect((page.conversation as string).length).toBe(16);
    expect(weighs(page)).toBe(true);
    expect((page.entries as Msg[]).length).toBe(Math.floor((PAGE_BYTES - WRAPPER_BYTES) / W));
    expect(page.start).toBeUndefined();
    expect(bytes(page)).toBeLessThanOrEqual(PAGE_BYTES);
    // 140 more at once: split into messages that each fit.
    // Written at once (the transcript moved to a whole new file, the same lines first): read in one go, sent in one
    // change.
    const since = phone.messages.length;
    const all = jsonl(...Array.from({ length: 280 }, (_, i) => sized(i + 1)));
    writeFileSync(join(t.dir, 'next.jsonl'), all);
    t.move(id, join(t.dir, 'next.jsonl'));
    await until(() => phone.conversation(id).at(-1)?.n === 280);
    const live = chats(phone, id, since);
    expect(live.flatMap(ns)).toEqual(Array.from({ length: 140 }, (_, i) => i + 141));
    expect(live.every(weighs)).toBe(true);
    expect((live[0]!.entries as Msg[]).length).toBe(Math.floor((PAGE_BYTES - WRAPPER_BYTES) / W));
    for (const m of live) expect(bytes(m)).toBeLessThanOrEqual(PAGE_BYTES);
  });

  test('a session\'s transcript is read from its own Claude account\'s folder; the default account\'s from the default one', async () => {
    const base = mkdtempSync(join(tmpdir(), 'atl-accounts-'));
    const defaultProjects = join(base, 'default', 'projects');
    const work = join(base, 'work');
    vi.stubEnv('ATELIER_TEST_CLAUDE_PROJECTS', defaultProjects);
    const A = 'aaaaaaaa-0000-4000-8000-00000000000a';
    const B = 'bbbbbbbb-0000-4000-8000-00000000000b';
    const place = (projects: string, session: string, text: string) => {
      const folder = join(projects, encodeProjectPath('/work/app'));
      mkdirSync(folder, { recursive: true });
      writeFileSync(join(folder, `${session}.jsonl`), jsonl(prompt(text)));
    };
    place(join(work, 'projects'), A, 'As work.');
    // The same session id in the default account's folder: not the one read for a work session.
    place(defaultProjects, A, 'Not this one.');
    place(defaultProjects, B, 'As default.');
    const t = setup({ deps: { conversation: { home: null, timing: { pollMs: 20 } } } });
    t.terms.list = [...t.terms.list, term('w', '/work/app', { createdAt: 3, session: claude(A) }), term('d', '/work/app', { createdAt: 4, session: claude(B) })];
    t.terms.accountDirs.set('w', work);
    const { phone } = await paired(t);
    expect(((await phone.follow('w')).entries as Msg[]).map((e) => e.text)).toEqual(['As work.']);
    expect(((await phone.follow('d')).entries as Msg[]).map((e) => e.text)).toEqual(['As default.']);
  });

  test('a phone that never follows gets no conversation, whatever Claude writes', async () => {
    const t = conversing();
    t.write('t2', prompt('Hi.'));
    const { phone } = await paired(t);
    await phone.state();
    t.append('t2', reply('Hello.'));
    t.terms.set([...t.terms.list]);
    await pause(150);
    expect(phone.messages.filter((m) => m.t === 'chat')).toEqual([]);
  });
});

const SCREENS = join(__dirname, '../../../tests/fixtures/claude-2.1.332/screens');
/** A recorded screen as TerminalHub reads it, its dim text told apart. */
const screen = (name: string) => screenView(readFileSync(join(SCREENS, `${name}.ans`), 'utf8'), { cols: 120, rows: 40 });
/** The screens terminal `id` shows from now on (recorded ones by name), one per read, the last one staying. */
const shows = async (t: ReturnType<typeof setup>, id: string, ...views: (string | ScreenView | Error)[]) => {
  t.terms.views.set(id, await Promise.all(views.map((v) => (typeof v === 'string' ? screen(v) : v))));
};
/** A screen's rows edited alike in its text and in its undimmed text. */
const edit = (v: ScreenView, f: (row: string) => string): ScreenView => ({ ...v, lines: v.lines.map(f), undimmed: v.undimmed.map(f) });
/** A Claude session waiting: for a permission (its activity names the request, or the plan approval), or an answer. */
const waiting = (activity: string, o: { question?: true; updatedAt?: number } = {}) =>
  ({ sessionId: 's', state: 'waiting', waitingFor: o.question ? 'question' : 'permission', title: null, activity, contextPct: null, unread: false, updatedAt: o.updatedAt ?? 5 }) as never;
const withSession = (list: TerminalInfo[], id: string, session: unknown) => list.map((x) => (x.id === id ? { ...x, session: session as never } : x));
const OK = { t: 'ok', rid: expect.any(Number) };
const refused = (code: string, message: string) => ({ t: 'error', rid: expect.any(Number), code, message });

describe('a Claude session\'s dialog, read and answered from a phone', () => {
  /** A recorded screen with its dialog's cursor moved to option `n`. */
  const cursorOn = async (name: string, n: number) =>
    edit(await screen(name), (row) => row.replace(/^(\s*)❯ (\d\.)/, '$1  $2').replace(new RegExp(`^(\\s*)  (${n}\\.)`), '$1❯ $2'));
  /** A recorded screen with `from` written as `to` on its rows. */
  const replaced = async (name: string, from: string, to: string) => edit(await screen(name), (row) => row.replace(from, to));
  /** The page a recorded screen's dialog reads as, for that wait. */
  const pageOf = async (name: string, wait: DialogWait | null) => readDialog(await screen(name), wait)!.page;
  /** The ask of terminal `id` as the phone's state shows it, once it is another than `not`. */
  const askOf = async (phone: FakePhone, id = 't2', not?: string) =>
    ((await phone.state((s) => (s.sessions as Msg[]).some((x) => x.id === id && x.ask && x.ask !== not))).sessions as Msg[]).find((x) => x.id === id)!.ask as string;
  /** Terminal `id`'s wait ends (Claude works on) and `session`'s begins: its ask. */
  const anew = async (t: ReturnType<typeof setup>, phone: FakePhone, id: string, session: unknown) => {
    const before = await askOf(phone, id);
    t.terms.set(withSession(t.terms.list, id, claude('s')));
    t.terms.set(withSession(t.terms.list, id, session));
    return askOf(phone, id, before);
  };
  const CHANGED = refused('busy', 'The request changed');
  const IN_TERMINAL = refused('invalid', 'Answer in the terminal');
  const NOT_THROUGH = refused('failed', 'The answer didn\'t go through. Open the terminal.');
  const DOWN = '\x1b[B';
  /** The recording's fictional project folder, as the Bash dialog names it (hard-wrapped there). */
  const PROJECT = `/work/hello/${'nested/'.repeat(16)}nested-/project`;

  test('dialog: the dialog on screen, its ask, and the running call it is about; nothing of what a field holds', async () => {
    const t = conversing();
    t.terms.list = withSession(t.terms.list, 't2', waiting('waiting: Bash touch made-by-bash.txt'));
    t.write('t2', prompt('List the files.'), reply('Sure.'), prompt('Make a file.'), reply('Making it.'), call('b1', 'touch made-by-bash.txt'));
    await shows(t, 't2', 'bash');
    const { phone } = await paired(t);
    const ask = await askOf(phone);
    expect(await phone.dialog('t2')).toEqual({
      t: 'dialog', rid: expect.any(Number), id: 't2', ask: `${ask}.${await pageOf('bash', 'permission')}`, kind: 'permission',
      rows: ['Bash command', 'Tip: auto mode handles these prompts for you — choose "switch to auto mode" below', 'Create empty file made-by-bash.txt', 'touch made-by-bash.txt', 'Do you want to proceed?'],
      options: [
        { n: 1, label: 'Yes' },
        { n: 2, label: `Yes, and always allow access to ${PROJECT} from this project` },
        { n: 3, label: 'Yes, and switch to auto mode · auto mode handles these prompts for you' },
        { n: 4, label: 'No', amend: true }
      ],
      entry: 5
    });
    // The next request, with text typed in No's field on the computer: the dialog as drawn, none of the reader's own.
    t.terms.set(withSession(t.terms.list, 't2', waiting('waiting: Bash touch second.txt', { updatedAt: 6 })));
    const next = await askOf(phone, 't2', ask);
    await shows(t, 't2', 'bash-amend-typed');
    const d = await phone.dialog('t2');
    expect(Object.keys(d).sort()).toEqual(['ask', 'id', 'kind', 'options', 'rid', 'rows', 't']);
    expect(d.ask).toBe(`${next}.${await pageOf('bash-amend-typed', 'permission')}`);
  });

  test('dialog: two calls alike, a subagent\'s request, a transcript unreadable or not written yet: no entry; nothing readable: "Answer in the terminal"', async () => {
    const t = conversing();
    const at = (id: string, activity: string, createdAt: number) => term(id, '/work/app', { createdAt, session: waiting(activity) });
    t.terms.list = [...t.terms.list, at('alike', 'waiting: Bash npm test', 3), at('sub', 'waiting: Bash rm -rf build', 4), at('broken', 'waiting: Bash npm test', 5), at('new', 'waiting: Bash npm test', 6), at('blank', 'waiting: Bash npm test', 7)];
    t.write('alike', prompt('Test it twice.'), call('b1', 'npm test'), call('b2', 'npm test'));
    // The request is the subagent's own call: Claude's only call running is the agent.
    t.write('sub', prompt('Clean up.'), call('a1', '', { name: 'Agent', input: { description: 'Clean the build', prompt: 'Remove it.' } }), call('s1', 'rm -rf build', { side: true }));
    mkdirSync(t.file('broken'));
    t.terms.screens.set('sub', npmDialog(['❯ 1. Yes', '  2. No'], 'rm -rf build'));
    t.terms.screens.set('blank', ['⏺ Bash(npm test)', '  ⎿  Running…', '', '✻ Testing… (esc to interrupt)']);
    const { phone } = await paired(t);
    for (const id of ['alike', 'sub', 'broken', 'new']) {
      const d = await phone.dialog(id);
      expect(d).toMatchObject({ t: 'dialog', id, kind: 'permission', ask: expect.stringMatching(/^[\w-]{22}\.[\w-]{8}$/) });
      expect(d.entry).toBeUndefined();
    }
    expect(await phone.dialog('blank')).toEqual(IN_TERMINAL);
    expect(await phone.dialog('gone')).toEqual(refused('not-found', 'This session is not on this computer any more.'));
    expect(await phone.dialog('t1')).toEqual(refused('invalid', 'This is not a Claude session.'));
  });

  test('dialog: the entry is the running call the dialog on screen names, never another one the session\'s hook names; a hook for another tool: no entry', async () => {
    const t = conversing();
    const edit = (id: string, file: string) => call(id, '', { name: 'Edit', input: { file_path: `/work/app/${file}`, old_string: 'world', new_string: 'there' } });
    // Two Edits run at once: the hook names b.ts while Claude Code draws a.ts's dialog first.
    t.terms.list = withSession(t.terms.list, 't2', waiting('waiting: Edit b.ts'));
    t.write('t2', prompt('Edit both.'), edit('e1', 'a.ts'), edit('e2', 'b.ts'));
    const forA = await replaced('edit', 'hello.txt', 'a.ts');
    const forB = await replaced('edit', 'hello.txt', 'b.ts');
    await shows(t, 't2', forA);
    const { phone } = await paired(t);
    expect(await phone.dialog('t2')).toMatchObject({ kind: 'permission', rows: expect.arrayContaining(['a.ts', 'Do you want to make this edit to a.ts?']), entry: 2 });
    await shows(t, 't2', forB);
    expect((await phone.dialog('t2')).entry).toBe(3);
    // The hook naming a.ts, b.ts's dialog drawn: b.ts's.
    t.terms.set(withSession(t.terms.list, 't2', waiting('waiting: Edit a.ts', { updatedAt: 6 })));
    expect((await phone.dialog('t2')).entry).toBe(3);
    // A Bash request waiting while an Edit's dialog shows: the hook and the screen disagree on the request, so no
    // entry, whichever call runs.
    t.append('t2', call('b1', 'touch made-by-bash.txt'));
    t.terms.set(withSession(t.terms.list, 't2', waiting('waiting: Bash touch made-by-bash.txt', { updatedAt: 7 })));
    for (const v of [forA, await screen('edit')]) {
      await shows(t, 't2', v);
      const d = await phone.dialog('t2');
      expect(d).toMatchObject({ t: 'dialog', kind: 'permission' });
      expect(d.entry).toBeUndefined();
    }
    // Bash's own dialog: its entry.
    await shows(t, 't2', 'bash');
    expect((await phone.dialog('t2')).entry).toBe(4);
  });

  test('dialog: a subagent\'s request never carries a running call\'s entry: a file named in its diff, a command sharing a cut one\'s start', async () => {
    const t = conversing();
    const editCall = (id: string, file: string) => call(id, '', { name: 'Edit', input: { file_path: `/work/app/${file}`, old_string: 'world', new_string: 'there' } });
    const agent = call('a1', '', { name: 'Agent', input: { description: 'Tidy the imports', prompt: 'Tidy them.' } });
    // Claude runs an agent and Edit a.ts; the agent's Edit c.ts asks first, its diff naming a.ts.
    t.terms.list = withSession(t.terms.list, 't2', waiting('waiting: Edit c.ts'));
    t.write('t2', prompt('Tidy up.'), agent, editCall('e1', 'a.ts'));
    const forC = edit(await replaced('edit', 'hello.txt', 'c.ts'), (row) => row.replace('This file is for edit tests.', 'import { x } from \'./a.ts\';'));
    expect(readDialog(forC, 'permission')!.rows).toContain('2  import { x } from \'./a.ts\';');
    await shows(t, 't2', forC);
    const { phone } = await paired(t);
    expect((await phone.dialog('t2')).entry).toBeUndefined();
    // The hook naming a.ts: the dialog still asks about c.ts.
    t.terms.set(withSession(t.terms.list, 't2', waiting('waiting: Edit a.ts', { updatedAt: 6 })));
    expect((await phone.dialog('t2')).entry).toBeUndefined();
    // a.ts's own dialog: its entry, by its path and its question.
    await shows(t, 't2', await replaced('edit', 'hello.txt', 'a.ts'));
    expect((await phone.dialog('t2')).entry).toBe(3);
    // Two long commands alike in their first 59 characters, the hook's target cut there: only the running one's whole
    // command is its dialog.
    const start = `cd /work/app/packages/server/${'deep/'.repeat(6)}src && npm run`;
    const [main, side] = [`${start} build -- --watch`, `${start} lint -- --fix`];
    t.append('t2', call('b1', main), call('s1', side, { side: true }));
    t.terms.set(withSession(t.terms.list, 't2', waiting(`waiting: Bash ${side.slice(0, 59)}…`, { updatedAt: 7 })));
    t.terms.views.delete('t2');
    t.terms.screens.set('t2', npmDialog(['❯ 1. Yes', '  2. No'], side));
    expect((await phone.dialog('t2')).entry).toBeUndefined();
    t.terms.screens.set('t2', npmDialog(['❯ 1. Yes', '  2. No'], main));
    expect((await phone.dialog('t2')).entry).toBe(4);
  });

  test('dialog: /model while nothing waits is a menu with no options and no ask; so is the trust dialog while Claude starts, marked', async () => {
    const t = conversing();
    const other = term('w', '/work/app', { createdAt: 3, session: { ...(claude('s-w') as object), state: 'waiting' } as never });
    t.terms.list = [...withSession(t.terms.list, 't2', claude('s')), other, term('n1', '/work/app', { createdAt: 4 })];
    t.terms.starting = new Set(['n1']);
    for (const id of ['t2', 'w']) await shows(t, id, 'model');
    await shows(t, 'n1', 'trust');
    const { phone } = await paired(t);
    const rows = readDialog(await screen('model'), null)!.rows;
    expect(rows[0]).toBe('Select model');
    expect(await phone.dialog('t2')).toEqual({ t: 'dialog', rid: expect.any(Number), id: 't2', kind: 'menu', rows, options: [] });
    // A session waiting for what no dialog of its own answers has an ask; its menu still has none.
    expect(await askOf(phone, 'w')).toEqual(expect.any(String));
    expect(await phone.dialog('w')).toEqual({ t: 'dialog', rid: expect.any(Number), id: 'w', kind: 'menu', rows, options: [] });
    expect(await phone.dialog('n1')).toEqual({ t: 'dialog', rid: expect.any(Number), id: 'n1', kind: 'menu', rows: readDialog(await screen('trust'), null)!.rows, options: [], trust: true });
  });

  test('choose: the option\'s digit, only while the same wait shows the same page and label; once', async () => {
    const t = conversing();
    t.terms.list = withSession(t.terms.list, 't2', waiting('waiting: Bash touch made-by-bash.txt'));
    await shows(t, 't2', 'bash');
    const { phone } = await paired(t);
    const d = await phone.dialog('t2');
    t.terms.events = [];
    expect(await phone.choose('t2', d.ask as string, 1, 'Yes')).toEqual(OK);
    expect(t.terms.events).toEqual(['read', '1']);
    // The same dialog again (no hook comes until the tool has run): answered already.
    expect(await phone.choose('t2', d.ask as string, 1, 'Yes')).toEqual(refused('busy', 'This request was answered already'));
    // The next request: the old ask is another wait's.
    await shows(t, 't2', 'bash-second');
    const ask = await anew(t, phone, 't2', waiting('waiting: Bash touch second.txt', { updatedAt: 7 }));
    expect(await phone.choose('t2', d.ask as string, 1, 'Yes')).toEqual(CHANGED);
    const next = await phone.dialog('t2');
    expect(next.ask).toBe(`${ask}.${await pageOf('bash-second', 'permission')}`);
    // Another dialog on screen under the same wait, an option labelled otherwise, or none of that number: nothing typed.
    await shows(t, 't2', 'edit');
    expect(await phone.choose('t2', next.ask as string, 1, 'Yes')).toEqual(CHANGED);
    await shows(t, 't2', 'bash-second');
    expect(await phone.choose('t2', next.ask as string, 3, 'Yes')).toEqual(CHANGED);
    expect(await phone.choose('t2', next.ask as string, 7, 'Maybe')).toEqual(IN_TERMINAL);
    expect(t.terms.answers).toEqual([['t2', '1']]);
    // Those typed nothing: the request is still to answer.
    expect(await phone.choose('t2', next.ask as string, 3, 'Yes, and switch to auto mode · auto mode handles these prompts for you')).toEqual(OK);
    expect(t.terms.answers).toEqual([['t2', '1'], ['t2', '3']]);
  });

  test('choose refuses right after a window typed in the terminal: its key may not be drawn yet, and the digit would answer the next question', async () => {
    const t = conversing();
    t.terms.list = withSession(t.terms.list, 't2', waiting('waiting: question', { question: true }));
    await shows(t, 't2', 'questions-first');
    const { phone } = await paired(t);
    const d = await phone.dialog('t2');
    t.terms.windowInput.set('t2', Date.now() - 500);
    t.terms.events = [];
    expect(await phone.choose('t2', d.ask as string, 2, 'Winter')).toEqual(CHANGED);
    expect(t.terms.answers).toEqual([]);
    // Typed a while ago, nothing since: the choice goes.
    t.terms.windowInput.set('t2', Date.now() - TYPED_RECENTLY_MS - 100);
    expect(await phone.choose('t2', d.ask as string, 2, 'Winter')).toEqual(OK);
    expect(t.terms.answers).toEqual([['t2', '2']]);
  });

  test('choose a field: its digit, the text once the cursor is in it, Enter once it shows the text', async () => {
    const t = conversing();
    t.terms.list = withSession(t.terms.list, 't2', waiting('waiting: question', { question: true }));
    await shows(t, 't2', 'question-fruit');
    const { phone } = await paired(t);
    const d = await phone.dialog('t2');
    expect(d.options).toEqual([{ n: 1, label: 'Apple' }, { n: 2, label: 'Pear' }, { n: 3, label: 'Type something.', field: true }, { n: 4, label: 'Chat about this' }]);
    await shows(t, 't2', 'question-fruit', 'question-field', 'question-field-typed');
    t.terms.events = [];
    expect(await phone.choose('t2', d.ask as string, 3, 'Type something.', 'Mango')).toEqual(OK);
    // Each key right after a read showing the dialog ready for it.
    expect(t.terms.events).toEqual(['read', '3', 'read', 'Mango', 'read', '\r']);
    // The digit didn't put the cursor in the field: the keys stop there.
    await anew(t, phone, 't2', waiting('waiting: question', { question: true, updatedAt: 8 }));
    await shows(t, 't2', 'question-fruit');
    const again = await phone.dialog('t2');
    t.terms.answers = [];
    expect(await phone.choose('t2', again.ask as string, 3, 'Type something.', 'Mango')).toEqual(NOT_THROUGH);
    expect(t.terms.answers).toEqual([['t2', '3']]);
    // The field took the cursor but doesn't show the text: no Enter.
    await anew(t, phone, 't2', waiting('waiting: question', { question: true, updatedAt: 9 }));
    await shows(t, 't2', 'question-fruit');
    const third = await phone.dialog('t2');
    await shows(t, 't2', 'question-fruit', 'question-field');
    t.terms.answers = [];
    expect(await phone.choose('t2', third.ask as string, 3, 'Type something.', 'Mango')).toEqual(NOT_THROUGH);
    expect(t.terms.answers).toEqual([['t2', '3'], ['t2', 'Mango']]);
  });

  test('choose the plan\'s field: its digit, the feedback once the cursor is in it, Enter once it shows it', async () => {
    const t = conversing();
    t.terms.list = withSession(t.terms.list, 't2', waiting('waiting: plan approval'));
    await shows(t, 't2', 'plan');
    const { phone } = await paired(t);
    const d = await phone.dialog('t2');
    await shows(t, 't2', 'plan', 'plan-field', 'plan-field-typed');
    t.terms.events = [];
    expect(await phone.choose('t2', d.ask as string, 3, 'Tell Claude what to change', 'Skip the verify step.')).toEqual(OK);
    expect(t.terms.events).toEqual(['read', '3', 'read', 'Skip the verify step.', 'read', '\r']);
  });

  test('a field\'s keys stop when the computer acts meanwhile: text in the field already or after the phone\'s, another request, a window typing', async () => {
    const t = conversing();
    t.terms.list = withSession(t.terms.list, 't2', waiting('waiting: question', { question: true }));
    const { phone } = await paired(t);
    let at = 10;
    /** A new wait for the fruit question, its dialog read: its ask. */
    const fresh = async () => {
      await anew(t, phone, 't2', waiting('waiting: question', { question: true, updatedAt: at++ }));
      await shows(t, 't2', 'question-fruit');
      return (await phone.dialog('t2')).ask as string;
    };
    const tries = async (...views: (string | ScreenView)[]) => {
      const ask = await fresh();
      await shows(t, 't2', ...views);
      t.terms.events = [];
      return phone.choose('t2', ask, 3, 'Type something.', 'Mango');
    };
    // The field the digit opened holds text already (typed on the computer): the phone's would go after it.
    expect(await tries('question-fruit', 'question-field-typed')).toEqual(NOT_THROUGH);
    expect(t.terms.events).toEqual(['read', '3', 'read']);
    // More than the phone's text in the field once typed: no Enter.
    expect(await tries('question-fruit', 'question-field', await replaced('question-field-typed', '❯ 3. Mango', '❯ 3. Mango and kiwi'))).toEqual(NOT_THROUGH);
    expect(t.terms.events).toEqual(['read', '3', 'read', 'Mango', 'read']);
    // Once the digit went, the wait ends and another question begins, the screen still showing the same dialog.
    t.terms.onKey = (_id, key) => {
      if (key !== '3') return;
      t.terms.set(withSession(t.terms.list, 't2', claude('s')));
      t.terms.set(withSession(t.terms.list, 't2', waiting('waiting: question', { question: true, updatedAt: 90 })));
    };
    expect(await tries('question-fruit', 'question-field', 'question-field-typed')).toEqual(NOT_THROUGH);
    expect(t.terms.events).toEqual(['read', '3', 'read']);
    // A window types in the terminal after the phone's text: the field may hold both, Enter would send them.
    t.terms.onKey = (id, key) => { if (key === 'Mango') t.terms.windowInput.set(id, Date.now()); };
    expect(await tries('question-fruit', 'question-field', 'question-field-typed')).toEqual(NOT_THROUGH);
    expect(t.terms.events).toEqual(['read', '3', 'read', 'Mango', 'read']);
  });

  test('choose No with feedback: each arrow after a read showing the cursor where the last one left it, then Tab, the text, Enter', async () => {
    const t = conversing();
    t.terms.list = withSession(t.terms.list, 't2', waiting('waiting: Bash touch second.txt'));
    await shows(t, 't2', 'bash-second');
    const { phone } = await paired(t);
    const d = await phone.dialog('t2');
    await shows(t, 't2', 'bash-second', await cursorOn('bash-second', 2), await cursorOn('bash-second', 3), 'bash-on-no', 'bash-amend', 'bash-amend-typed');
    t.terms.events = [];
    expect(await phone.choose('t2', d.ask as string, 4, 'No', 'do not create it, just say ok')).toEqual(OK);
    expect(t.terms.events).toEqual(['read', DOWN, 'read', DOWN, 'read', DOWN, 'read', '\t', 'read', 'do not create it, just say ok', 'read', '\r']);
    // The cursor on No already: Tab right away.
    await anew(t, phone, 't2', waiting('waiting: Bash touch second.txt', { updatedAt: 8 }));
    await shows(t, 't2', 'bash-on-no');
    const onNo = await phone.dialog('t2');
    await shows(t, 't2', 'bash-on-no', 'bash-amend', 'bash-amend-typed');
    t.terms.events = [];
    expect(await phone.choose('t2', onNo.ask as string, 4, 'No', 'do not create it, just say ok')).toEqual(OK);
    expect(t.terms.events).toEqual(['read', '\t', 'read', 'do not create it, just say ok', 'read', '\r']);
  });

  test('the arrows stop as soon as a read doesn\'t show the cursor one step on: the dialog gone, the cursor where it was or further', async () => {
    const t = conversing();
    t.terms.list = withSession(t.terms.list, 't2', waiting('waiting: Bash touch second.txt'));
    const { phone } = await paired(t);
    let at = 10;
    const tries = async (...views: (string | ScreenView)[]) => {
      await anew(t, phone, 't2', waiting('waiting: Bash touch second.txt', { updatedAt: at++ }));
      await shows(t, 't2', 'bash-second');
      const ask = (await phone.dialog('t2')).ask as string;
      await shows(t, 't2', ...views);
      t.terms.events = [];
      return phone.choose('t2', ask, 4, 'No', 'do not create it, just say ok');
    };
    // Answered on the computer right after the first arrow: no arrow goes after it.
    for (const after of ['idle', 'bash-second', await cursorOn('bash-second', 3)]) {
      expect(await tries('bash-second', after)).toEqual(NOT_THROUGH);
      expect(t.terms.events).toEqual(['read', DOWN, 'read']);
    }
  });

  test('a screen read that fails: the dialog is answered in the terminal; a choose too before any key, and after one it didn\'t go through', async () => {
    const t = conversing();
    t.terms.list = withSession(t.terms.list, 't2', waiting('waiting: question', { question: true }));
    const { phone } = await paired(t);
    await shows(t, 't2', new Error('no screen'));
    expect(await phone.dialog('t2')).toEqual(IN_TERMINAL);
    await shows(t, 't2', 'question-fruit');
    const d = await phone.dialog('t2');
    await shows(t, 't2', new Error('no screen'));
    expect(await phone.choose('t2', d.ask as string, 3, 'Type something.', 'Mango')).toEqual(IN_TERMINAL);
    expect(t.terms.answers).toEqual([]);
    // Nothing typed: still to answer. The read after the digit fails: nothing more goes.
    await shows(t, 't2', 'question-fruit', new Error('no screen'));
    expect(await phone.choose('t2', d.ask as string, 3, 'Type something.', 'Mango')).toEqual(NOT_THROUGH);
    expect(t.terms.answers).toEqual([['t2', '3']]);
  });

  test('a phone removed while its choose types: no key goes after', async () => {
    const t = conversing();
    t.terms.list = withSession(t.terms.list, 't2', waiting('waiting: question', { question: true }));
    await shows(t, 't2', 'question-fruit');
    const { phone } = await paired(t);
    const d = await phone.dialog('t2');
    await shows(t, 't2', 'question-fruit', 'question-field', 'question-field-typed');
    t.terms.onKey = (_id, key) => { if (key === '3') t.hub.removeDevice(t.hub.devices.list()[0]!.id); };
    phone.choose('t2', d.ask as string, 3, 'Type something.', 'Mango').catch(() => {});
    await until(() => t.terms.answers.length > 0);
    await pause(100);
    expect(t.terms.answers).toEqual([['t2', '3']]);
  });

  test('the row and a choose answer one wait once: a choose\'s Yes, then the row\'s Deny; the row\'s Allow, then a choose', async () => {
    const t = conversing();
    t.terms.list = withSession(t.terms.list, 't2', waiting('waiting: Bash touch made-by-bash.txt'));
    // Claude Code hasn't drawn anything else yet: the dialog is still on screen.
    await shows(t, 't2', 'bash');
    const { phone } = await paired(t);
    const ALREADY = refused('busy', 'This request was answered already');
    const waitKey = async (not?: string) => ((await phone.state((s) => (s.sessions as Msg[]).some((x) => x.id === 't2' && x.wait && x.wait !== not))).sessions as Msg[]).find((x) => x.id === 't2')!.wait as string;
    const wait = await waitKey();
    const d = await phone.dialog('t2');
    expect(await phone.choose('t2', d.ask as string, 1, 'Yes')).toEqual(OK);
    // A Deny now would be an Esc that interrupts the command just allowed.
    expect(await phone.answer('t2', wait, 'deny')).toEqual(ALREADY);
    expect(await phone.answer('t2', wait, 'allow')).toEqual(ALREADY);
    expect(t.terms.answers).toEqual([['t2', '1']]);
    // The next request: the row's Allow first, then a choose on its dialog.
    await anew(t, phone, 't2', waiting('waiting: Bash touch made-by-bash.txt', { updatedAt: 9 }));
    const next = await waitKey(wait);
    expect(await phone.answer('t2', next, 'allow')).toEqual(OK);
    const d2 = await phone.dialog('t2');
    expect(await phone.choose('t2', d2.ask as string, 1, 'Yes')).toEqual(ALREADY);
    expect(t.terms.answers).toEqual([['t2', '1'], ['t2', '1']]);
  });

  test('several questions: after an answer the next page has another ask; Submit answers on the review page', async () => {
    const t = conversing();
    const questions = [
      { header: 'Season', question: 'What is your favorite season?', options: [{ label: 'Summer' }, { label: 'Winter' }] },
      { header: 'Drink', question: 'What is your favorite drink?', options: [{ label: 'Tea' }, { label: 'Coffee' }] }
    ];
    t.terms.list = withSession(t.terms.list, 't2', waiting('waiting: question', { question: true }));
    t.write('t2', prompt('Ask me two things.'), call('q1', '', { name: 'AskUserQuestion', input: { questions } }));
    await shows(t, 't2', 'questions-first');
    const { phone } = await paired(t);
    const ask = await askOf(phone);
    const first = await phone.dialog('t2');
    expect(first).toMatchObject({ kind: 'question', ask: `${ask}.${await pageOf('questions-first', 'question')}`, rows: expect.arrayContaining(['What is your favorite season?']), entry: 2 });
    expect(await phone.choose('t2', first.ask as string, 2, 'Winter')).toEqual(OK);
    // The same wait, its next page.
    await shows(t, 't2', 'questions-second');
    const second = await phone.dialog('t2');
    expect(second).toMatchObject({ kind: 'question', ask: `${ask}.${await pageOf('questions-second', 'question')}`, rows: expect.arrayContaining(['What is your favorite drink?']), entry: 2 });
    expect(await phone.choose('t2', second.ask as string, 1, 'Tea')).toEqual(OK);
    await shows(t, 't2', 'questions-review');
    const review = await phone.dialog('t2');
    expect(review).toMatchObject({ kind: 'question', ask: `${ask}.${await pageOf('questions-review', 'question')}`, options: [{ n: 1, label: 'Submit answers' }, { n: 2, label: 'Cancel' }], entry: 2 });
    expect(new Set([first.ask, second.ask, review.ask]).size).toBe(3);
    expect(await phone.choose('t2', review.ask as string, 1, 'Submit answers')).toEqual(OK);
    expect(t.terms.answers).toEqual([['t2', '2'], ['t2', '1'], ['t2', '1']]);
  });

  test('choose refuses a menu, several choices, a cursor already in a field, a field without text and text for a plain option, typing nothing', async () => {
    const t = conversing();
    t.terms.list = [
      ...withSession(t.terms.list, 't2', waiting('waiting: question', { question: true })),
      term('m', '/work/app', { createdAt: 3, session: { ...(claude('s-m') as object), state: 'waiting' } as never }),
      term('p', '/work/app', { createdAt: 4, session: waiting('waiting: Bash touch second.txt') })
    ];
    const { phone } = await paired(t);
    // A menu has no ask to name: one made of its session's ask and its page is still refused.
    await shows(t, 'm', 'model');
    expect((await phone.dialog('m')).ask).toBeUndefined();
    expect(await phone.choose('m', `${await askOf(phone, 'm')}.${await pageOf('model', null)}`, 4, 'Sonnet 5.5')).toEqual(IN_TERMINAL);
    await shows(t, 't2', 'several');
    const several = await phone.dialog('t2');
    expect(several).toMatchObject({ kind: 'question', several: true });
    expect(await phone.choose('t2', several.ask as string, 1, '[ ] Cats')).toEqual(IN_TERMINAL);
    // The cursor in the question's field already, or in No's: a digit would be typed there.
    await shows(t, 't2', 'question-field');
    expect(await phone.choose('t2', (await phone.dialog('t2')).ask as string, 1, 'Apple')).toEqual(IN_TERMINAL);
    await shows(t, 'p', 'bash-amend');
    expect(await phone.choose('p', (await phone.dialog('p')).ask as string, 1, 'Yes')).toEqual(IN_TERMINAL);
    await shows(t, 't2', 'question-fruit');
    const fruit = await phone.dialog('t2');
    expect(await phone.choose('t2', fruit.ask as string, 3, 'Type something.')).toEqual(refused('invalid', 'This option needs text.'));
    expect(await phone.choose('t2', fruit.ask as string, 1, 'Apple', 'Green ones')).toEqual(refused('invalid', 'This option takes no text.'));
    expect(await phone.choose('gone', fruit.ask as string, 1, 'Apple')).toEqual(refused('not-found', 'This session is not on this computer any more.'));
    expect(await phone.choose('t1', fruit.ask as string, 1, 'Apple')).toEqual(refused('invalid', 'This is not a Claude session.'));
    expect(t.terms.answers).toEqual([]);
    // None of them counted as an answer.
    expect(await phone.choose('t2', fruit.ask as string, 1, 'Apple')).toEqual(OK);
    expect(t.terms.answers).toEqual([['t2', '1']]);
  });

  test('a plan\'s wait while the screen shows Bash\'s dialog, its cursor in No\'s field: not the plan\'s page, nothing typed', async () => {
    const t = conversing();
    t.terms.list = withSession(t.terms.list, 't2', waiting('waiting: plan approval'));
    t.write('t2', prompt('Plan it.'), call('p1', '', { name: 'ExitPlanMode', input: { plan: '1. Append Bye.' } }));
    await shows(t, 't2', 'plan');
    const { phone } = await paired(t);
    const plan = await phone.dialog('t2');
    expect(plan).toMatchObject({ kind: 'plan', entry: 2, options: [{ n: 1, label: 'Yes, and use auto mode' }, { n: 2, label: 'Yes, manually approve edits' }, { n: 3, label: 'Tell Claude what to change', field: true }] });
    await shows(t, 't2', 'bash-amend');
    t.terms.events = [];
    // Read for the plan's wait, Bash's dialog has no field and a "Yes" first: only the page tells it isn't the plan.
    expect(await phone.choose('t2', plan.ask as string, 1, 'Yes')).toEqual(CHANGED);
    expect(await phone.choose('t2', plan.ask as string, 1, 'Yes, and use auto mode')).toEqual(CHANGED);
    expect(await phone.choose('t2', plan.ask as string, 3, 'Tell Claude what to change', 'Skip the verify step.')).toEqual(CHANGED);
    expect(t.terms.events).toEqual(['read', 'read', 'read']);
    // Read anew for the plan's wait, Bash's dialog is no plan: nothing to show, so no page to choose in.
    expect(await phone.dialog('t2')).toEqual(IN_TERMINAL);
    expect(t.terms.answers).toEqual([]);
  });

  test('an answer from the row and a choose on the same dialog: one goes, the other is refused', async () => {
    const t = conversing();
    t.terms.list = withSession(t.terms.list, 't2', waiting('waiting: Bash touch made-by-bash.txt'));
    await shows(t, 't2', 'bash');
    const { phone } = await paired(t);
    const BEING = refused('busy', 'This request is being answered');
    const waitKey = async (not?: string) => ((await phone.state((s) => (s.sessions as Msg[]).some((x) => x.id === 't2' && x.wait && x.wait !== not))).sessions as Msg[]).find((x) => x.id === 't2')!.wait as string;
    // Screen reads wait until opened: whichever comes first is still reading when the other arrives.
    let open = () => {};
    const gate = () => { t.terms.screenGate = new Promise<void>((r) => { open = () => { t.terms.screenGate = null; r(); }; }); };
    const wait = await waitKey();
    const d = await phone.dialog('t2');
    gate();
    const allow = phone.answer('t2', wait, 'allow');
    const choose = phone.choose('t2', d.ask as string, 1, 'Yes');
    expect(await choose).toEqual(BEING);
    open();
    expect(await allow).toEqual(OK);
    expect(t.terms.answers).toEqual([['t2', '1']]);
    // The next request: the choose first, the row's Allow while it reads.
    await anew(t, phone, 't2', waiting('waiting: Bash touch made-by-bash.txt', { updatedAt: 9 }));
    const next = await waitKey(wait);
    const d2 = await phone.dialog('t2');
    gate();
    const chose = phone.choose('t2', d2.ask as string, 1, 'Yes');
    const allowed = phone.answer('t2', next, 'allow');
    expect(await allowed).toEqual(BEING);
    open();
    expect(await chose).toEqual(OK);
    expect(t.terms.answers).toEqual([['t2', '1'], ['t2', '1']]);
  });
});

describe('typing into a Claude session from a phone: a prompt, an interrupt, a menu closed', () => {
  /** The keys a prompt goes as: one bracketed paste, its new lines as Enter inside it. */
  const PASTE = (text: string) => `\x1b[200~${text.replace(/\n/g, '\r')}\x1b[201~`;
  const ESC = '\x1b';
  const BEING = refused('busy', 'This request is being answered');
  const ANSWER_FIRST = refused('busy', 'Answer Claude\'s request first.');
  const TYPED = refused('busy', 'Text is typed in Claude\'s prompt on the computer.');
  const NO_PROMPT = refused('busy', 'Claude\'s prompt isn\'t on screen.');
  const MEANWHILE = refused('busy', 'Claude asked something meanwhile. Check the terminal.');
  const NOT_REACHED = refused('failed', 'The text didn\'t reach Claude\'s prompt.');
  const NOT_WORKING = refused('invalid', 'Claude isn\'t working.');
  /** Accepted, waiting on this computer for Claude to be idle. */
  const QUEUED = { t: 'ok', rid: expect.any(Number), queued: true };
  const NO_MENU = refused('invalid', 'No menu to close.');
  const IN_TERMINAL = refused('invalid', 'Answer in the terminal');
  const GONE = refused('not-found', 'This session is not on this computer any more.');
  const NOT_CLAUDE = refused('invalid', 'This is not a Claude session.');
  /** A Claude session whose turn is over. */
  const finished = { ...(claude('s') as object), state: 'done' } as never;
  /** A session waiting with no request named, as atelierd without its richer states tells it. */
  const waitingSome = (sessionId: string) => ({ ...(claude(sessionId) as object), state: 'waiting' }) as never;
  /** A recorded screen whose prompt box holds `rows` as typed: the first after its `❯`, the others on rows put in below. */
  const prompted = async (name: string, ...rows: string[]): Promise<ScreenView> => {
    const v = await screen(name);
    const at = v.undimmed.map((l) => l.trimEnd()).lastIndexOf('❯');
    const put = (ls: string[]) => [...ls.slice(0, at), `❯ ${rows[0]}`, ...rows.slice(1).map((r) => `  ${r}`), ...ls.slice(at + 1)];
    return { ...v, lines: put(v.lines), undimmed: put(v.undimmed) };
  };
  /** The folder trust dialog as other versions draw it: numbered, in a frame, Esc exits. */
  const framed = (row: string) => `│ ${row.padEnd(56)} │`;
  const numberedTrust: ScreenView = (() => {
    const lines = [`╭${'─'.repeat(58)}╮`, framed('Do you trust the files in this folder?'), framed(''), framed('/work/app'), framed(''),
      framed('❯ 1. Yes, proceed'), framed('  2. No, exit'), framed(''), `╰${'─'.repeat(58)}╯`, '   Enter to confirm · Esc to exit'];
    return { lines, undimmed: lines, cols: 120, bracketedPaste: true };
  })();
  /** Screen reads wait from now until `open()`; `reading()` resolves once one waits. */
  const gate = (t: ReturnType<typeof setup>) => {
    let open = () => {};
    t.terms.screenGate = new Promise<void>((r) => { open = () => { t.terms.screenGate = null; r(); }; });
    const before = t.terms.gated;
    return { open, reading: () => until(() => t.terms.gated > before) };
  };
  /** Nothing went through attach, input or resize: the terminal keeps the computer's size. */
  const sizeKept = (t: ReturnType<typeof setup>) => {
    expect(t.terms.takes).toEqual([]);
    expect(t.terms.inputs).toEqual([]);
    expect(t.terms.resizes).toEqual([]);
    expect([...t.terms.watching.values()].every((ids) => ids.size === 0)).toBe(true);
  };
  const keys = (t: ReturnType<typeof setup>) => t.terms.answers.map(([, k]) => k);

  test('say: an empty prompt gets the text as one paste, then Enter once the prompt shows it; the size never moves', async () => {
    const t = conversing();
    t.terms.list = withSession(t.terms.list, 't2', finished);
    await shows(t, 't2', 'idle', await prompted('idle', 'fix the tests'));
    const { phone } = await paired(t);
    t.terms.events = [];
    expect(await phone.say('t2', 'fix the tests')).toEqual(OK);
    // A read before the paste, and one showing the text before the Enter.
    expect(t.terms.events).toEqual(['read', PASTE('fix the tests'), 'read', '\r']);
    expect(t.terms.answers).toEqual([['t2', PASTE('fix the tests')], ['t2', '\r']]);
    // Drawn a read later, its paste markers echoed.
    await shows(t, 't2', 'idle', 'idle', await prompted('idle', '^[[200~fix the tests^[[201~'));
    t.terms.events = [];
    expect(await phone.say('t2', 'fix the tests')).toEqual(OK);
    expect(t.terms.events).toEqual(['read', PASTE('fix the tests'), 'read', 'read', '\r']);
    sizeKept(t);
  });

  test('say while Claude works: kept on this computer, then typed once a fresh read shows Claude idle, never into a turn: a request drawn between the last read and the Enter would take that Enter as its "Yes"', async () => {
    const t = conversing();
    t.terms.list = withSession(t.terms.list, 't2', finished);
    const { phone } = await paired(t);
    // Its turn over by its hooks, working on screen (a prompt typed on the computer, its hook not here yet).
    await shows(t, 't2', 'working');
    expect(await phone.say('t2', 'fix the tests')).toEqual(QUEUED);
    // Working by its hooks too: a second one waits after the first.
    t.terms.set(withSession(t.terms.list, 't2', claude('s')));
    expect(await phone.say('t2', 'then run the build')).toEqual(QUEUED);
    // Read again and again while the screen shows Claude working: nothing typed.
    const reads = t.terms.reads;
    await until(() => t.terms.reads >= reads + 3);
    expect(t.terms.answers).toEqual([]);
    // The turn over with text typed on the computer: nothing either.
    await shows(t, 't2', await prompted('idle', 'a draft'));
    const drafted = t.terms.reads;
    await until(() => t.terms.reads >= drafted + 2);
    expect(t.terms.answers).toEqual([]);
    // Idle with its prompt empty: both go as one prompt, a blank line apart.
    // A look, then a read holding the terminal, before the paste.
    await shows(t, 't2', 'idle', 'idle', await prompted('idle', 'fix the tests', '', 'then run the build'));
    await until(() => keys(t).length === 2);
    expect(keys(t)).toEqual([PASTE('fix the tests\n\nthen run the build'), '\r']);
    // Nothing waits any more: the screen is read no more.
    const done = t.terms.reads;
    await new Promise((r) => setTimeout(r, 100));
    expect(t.terms.reads).toBe(done);
    sizeKept(t);
  });

  test('say: one sent while another prompt types goes after it, every phone\'s in the order they came, all as one prompt', async () => {
    const t = conversing();
    t.terms.list = withSession(t.terms.list, 't2', claude('s'));
    await shows(t, 't2', 'working');
    const { phone } = await paired(t);
    const two = await another(t);
    // The first one still reading the screen: the other phone's waits.
    const g = gate(t);
    const first = phone.say('t2', 'fix the tests');
    await g.reading();
    expect(await two.say('t2', 'run the build')).toEqual(QUEUED);
    g.open();
    // Claude working: the first one waits too, before it.
    expect(await first).toEqual(QUEUED);
    expect(await phone.say('t2', 'and commit')).toEqual(QUEUED);
    expect(t.terms.answers).toEqual([]);
    // Four line breaks: Claude Code folds the paste.
    await shows(t, 't2', 'idle', 'idle', await prompted('idle', '[Pasted text #1 +4 lines]'));
    await until(() => keys(t).length === 2);
    expect(keys(t)).toEqual([PASTE('fix the tests\n\nrun the build\n\nand commit'), '\r']);
    // Within the size one prompt may take.
    await shows(t, 't2', 'working');
    expect(await phone.say('t2', 'x'.repeat(8100))).toEqual(QUEUED);
    expect(await two.say('t2', 'y'.repeat(8100))).toEqual(QUEUED);
    expect(await phone.say('t2', 'z'.repeat(200))).toEqual(refused('busy', 'Too much is waiting for Claude already. Send it once Claude is done.'));
  });

  test('say: what waits goes though its phone went away; a phone unpaired takes back what it sent', async () => {
    const t = conversing();
    t.terms.list = withSession(t.terms.list, 't2', claude('s'));
    await shows(t, 't2', 'working');
    const { phone } = await paired(t);
    const first = t.hub.devices.list()[0]!.id;
    const two = await another(t);
    const second = t.hub.devices.list().find((d) => d.id !== first)!.id;
    expect(await two.say('t2', 'run the build')).toEqual(QUEUED);
    expect(await phone.say('t2', 'fix the tests')).toEqual(QUEUED);
    // The first phone's app leaves (in the background); the second phone is unpaired.
    phone.drop();
    await until(() => !t.hub.status().devices.find((d) => d.id === first)!.connected);
    t.hub.removeDevice(second);
    await shows(t, 't2', 'idle', 'idle', await prompted('idle', 'fix the tests'));
    await until(() => keys(t).length === 2);
    expect(keys(t)).toEqual([PASTE('fix the tests'), '\r']);
  });

  test('say: iPhone access turned off: nothing waiting goes', async () => {
    const t = conversing();
    t.terms.list = withSession(t.terms.list, 't2', claude('s'));
    await shows(t, 't2', 'working');
    const { phone } = await paired(t);
    expect(await phone.say('t2', 'and commit')).toEqual(QUEUED);
    t.set({ remoteAccess: false });
    await shows(t, 't2', 'idle', await prompted('idle', 'and commit'));
    await new Promise((r) => setTimeout(r, 100));
    expect(t.terms.answers).toEqual([]);
  });

  test('say: what waits is dropped with its session, or once pasted with no Enter after it (it stays in Claude\'s prompt)', async () => {
    const t = conversing();
    t.terms.list = withSession(t.terms.list, 't2', claude('s'));
    await shows(t, 't2', 'working');
    const { phone } = await paired(t);
    expect(await phone.say('t2', 'fix the tests')).toEqual(QUEUED);
    // Claude Code exits: the shell in front, no session.
    t.terms.set(t.terms.list.map((x) => (x.id === 't2' ? { ...x, session: null, foreground: 'zsh' } : x)));
    t.terms.set(t.terms.list.map((x) => (x.id === 't2' ? { ...x, session: claude('s2'), foreground: 'claude' } : x)));
    await shows(t, 't2', 'idle', await prompted('idle', 'fix the tests'));
    await new Promise((r) => setTimeout(r, 100));
    expect(t.terms.answers).toEqual([]);
    // A request drawn once the paste went: no Enter, and it isn't typed again.
    await shows(t, 't2', 'working');
    expect(await phone.say('t2', 'fix the tests')).toEqual(QUEUED);
    await shows(t, 't2', 'idle', 'idle', 'bash');
    await until(() => keys(t).length === 1);
    await new Promise((r) => setTimeout(r, 100));
    expect(keys(t)).toEqual([PASTE('fix the tests')]);
  });

  test('say: the rows count what waits; the same text sent twice waits once; a slash command goes alone; tries back off', async () => {
    const t = conversing();
    t.terms.list = withSession(t.terms.list, 't2', claude('s'));
    await shows(t, 't2', 'working');
    const { phone } = await paired(t);
    const rowOf = (s: Msg, id: string) => (s.sessions as Msg[]).find((x) => x.id === id);
    /** The row once a state shows `n` waiting for it. */
    const queued = async (n: number | undefined) => rowOf(await phone.state((s) => rowOf(s, 't2')?.queued === n), 't2');
    expect(await phone.say('t2', 'fix the tests')).toEqual(QUEUED);
    expect(await phone.say('t2', 'fix the tests')).toEqual(QUEUED);
    expect(await phone.say('t2', '/compact')).toEqual(QUEUED);
    expect(await phone.say('t2', 'then go on')).toEqual(QUEUED);
    expect((await queued(3))?.queued).toBe(3);
    // Working all along: a read every slowMs at most once backed off.
    const reads = t.terms.reads;
    await new Promise((r) => setTimeout(r, 300));
    expect(t.terms.reads - reads).toBeLessThanOrEqual(300 / 20 + 2);
    // Idle: the prompt before the command, then the command alone, then the rest.
    await shows(t, 't2', 'idle', 'idle', await prompted('idle', 'fix the tests'));
    await until(() => keys(t).length === 2);
    await queued(2);
    await shows(t, 't2', 'idle', 'idle', await prompted('idle', '/compact'));
    await until(() => keys(t).length === 4);
    await shows(t, 't2', 'idle', 'idle', await prompted('idle', 'then go on'));
    await until(() => keys(t).length === 6);
    expect(keys(t)).toEqual([PASTE('fix the tests'), '\r', PASTE('/compact'), '\r', PASTE('then go on'), '\r']);
    expect(await queued(undefined)).toBeDefined();
  });

  test('say: what waits never goes into another Claude session in that terminal, nor after the computer kept it out too long', async () => {
    const t = conversing();
    t.terms.list = withSession(t.terms.list, 't2', claude('s'));
    await shows(t, 't2', 'working');
    const { phone } = await paired(t);
    expect(await phone.say('t2', 'yes, push it')).toEqual(QUEUED);
    // A resume (`/resume`, or `/clear`'s next session): another session there, Claude in front all along.
    t.terms.set(withSession(t.terms.list, 't2', { ...(claude('s-other') as object), state: 'done' }));
    await shows(t, 't2', 'idle', 'idle', await prompted('idle', 'yes, push it'));
    await new Promise((r) => setTimeout(r, 100));
    expect(t.terms.answers).toEqual([]);
    // Text typed on the computer at the turn's end, for staleMs: dropped, though the prompt is empty later.
    await shows(t, 't2', 'working');
    expect(await phone.say('t2', 'yes, push it')).toEqual(QUEUED);
    await shows(t, 't2', await prompted('idle', 'a draft'));
    await new Promise((r) => setTimeout(r, 600));
    await shows(t, 't2', 'idle', 'idle', await prompted('idle', 'yes, push it'));
    await new Promise((r) => setTimeout(r, 100));
    expect(t.terms.answers).toEqual([]);
  });

  test('say: a try waiting for Claude looks at the screen without holding the terminal: a Stop meanwhile goes', async () => {
    const t = conversing();
    t.terms.list = withSession(t.terms.list, 't2', claude('s'));
    await shows(t, 't2', 'working');
    const { phone } = await paired(t);
    expect(await phone.say('t2', 'fix the tests')).toEqual(QUEUED);
    // The try's read waits: a Stop now reads too, and goes.
    const g = gate(t);
    await g.reading();
    const stopped = phone.stop('t2');
    await until(() => t.terms.gated >= 2);
    g.open();
    expect(await stopped).toEqual(OK);
    expect(keys(t)).toEqual([ESC]);
  });

  test('say: iPhone access turned off and on again while what waits is typed: no Enter for it', async () => {
    const t = conversing();
    t.terms.list = withSession(t.terms.list, 't2', claude('s'));
    await shows(t, 't2', 'working');
    const { phone } = await paired(t);
    expect(await phone.say('t2', 'fix the tests')).toEqual(QUEUED);
    t.terms.onKey = (_id, key) => { if (key.startsWith('\x1b[200~')) { t.set({ remoteAccess: false }); t.set({ remoteAccess: true }); } };
    await shows(t, 't2', 'idle', 'idle', await prompted('idle', 'fix the tests'));
    await until(() => keys(t).length === 1);
    await new Promise((r) => setTimeout(r, 100));
    expect(keys(t)).toEqual([PASTE('fix the tests')]);
  });

  test('say: a multi-line text is one paste with \\r between its lines', async () => {
    const t = conversing();
    t.terms.list = withSession(t.terms.list, 't2', finished);
    // The texts of recorded pastes, on Claude Code's screens after them.
    const three = ['Line one of the pasted text.', 'Line two of the pasted text.', 'Line three of the pasted text.'].join('\n');
    const forty = Array.from({ length: 40 }, (_, i) => `Line ${i + 1} of the long pasted text.`).join('\n');
    await shows(t, 't2', 'idle', 'paste-three-lines');
    const { phone } = await paired(t);
    expect(await phone.say('t2', three)).toEqual(OK);
    expect(keys(t)).toEqual(['\x1b[200~Line one of the pasted text.\rLine two of the pasted text.\rLine three of the pasted text.\x1b[201~', '\r']);
    // Folded into Claude Code's stand-in, past 2 line breaks.
    await shows(t, 't2', 'idle', 'paste-forty-lines');
    t.terms.answers = [];
    expect(await phone.say('t2', forty)).toEqual(OK);
    expect(keys(t)).toEqual([PASTE(forty), '\r']);
    // A key typed on the computer after either: no Enter.
    for (const [text, typed] of [[three, 'paste-three-lines-typed'], [forty, 'paste-forty-lines-typed']] as const) {
      await shows(t, 't2', 'idle', typed);
      t.terms.answers = [];
      expect(await phone.say('t2', text)).toEqual(NOT_REACHED);
      expect(keys(t)).toEqual([PASTE(text)]);
    }
  });

  test('say: one line past 800 characters goes once Claude Code shows it folded; one of 800 only as typed', async () => {
    const t = conversing();
    t.terms.list = withSession(t.terms.list, 't2', claude('s'));
    /** A recorded paste's text: `n` characters of one sentence again and again, a last space made a full stop. */
    const sentences = (n: number) => {
      const s = 'The quick brown fox jumps over the lazy dog. '.repeat(Math.ceil(n / 45)).slice(0, n);
      return s.endsWith(' ') ? `${s.slice(0, -1)}.` : s;
    };
    const { phone } = await paired(t);
    for (const [n, shown] of [[2000, 'paste-line-2000'], [801, 'paste-line-801'], [800, 'paste-line-800']] as const) {
      await shows(t, 't2', 'idle', shown);
      t.terms.answers = [];
      expect(await phone.say('t2', sentences(n))).toEqual(OK);
      expect(keys(t)).toEqual([PASTE(sentences(n)), '\r']);
    }
    // 800 characters are never folded: a stand-in there is another paste's.
    await shows(t, 't2', 'idle', 'paste-line-801');
    t.terms.answers = [];
    expect(await phone.say('t2', sentences(800))).toEqual(NOT_REACHED);
    expect(keys(t)).toEqual([PASTE(sentences(800))]);
  });

  test('say refuses text in Claude\'s prompt, on screen or typed in a window just now', async () => {
    const t = conversing();
    t.terms.list = withSession(t.terms.list, 't2', claude('s'));
    const { phone } = await paired(t);
    // Text there not sent yet: typed while Claude works, a slash command.
    for (const s of ['working-typed', 'model-typed']) {
      await shows(t, 't2', s);
      expect(await phone.say('t2', 'fix the tests')).toEqual(TYPED);
    }
    // A window typed in the terminal just now: what it typed may not be drawn yet.
    await shows(t, 't2', 'idle', await prompted('idle', 'fix the tests'));
    t.terms.windowInput.set('t2', Date.now() - 500);
    expect(await phone.say('t2', 'fix the tests')).toEqual(TYPED);
    // A window types while the screen is read.
    t.terms.windowInput.set('t2', 0);
    const g = gate(t);
    const said = phone.say('t2', 'fix the tests');
    await g.reading();
    t.terms.windowInput.set('t2', Date.now());
    g.open();
    expect(await said).toEqual(TYPED);
    expect(t.terms.answers).toEqual([]);
    // A window types once the paste went: an Enter would send its keys too.
    await shows(t, 't2', 'idle', await prompted('idle', 'fix the tests'));
    t.terms.windowInput.set('t2', Date.now() - TYPED_RECENTLY_MS - 100);
    t.terms.onKey = (id, key) => { if (key.startsWith('\x1b[200~')) t.terms.windowInput.set(id, Date.now()); };
    expect(await phone.say('t2', 'fix the tests')).toEqual(TYPED);
    expect(keys(t)).toEqual([PASTE('fix the tests')]);
    // Typed a while ago, nothing since: the prompt is the phone's.
    t.terms.onKey = null;
    t.terms.windowInput.set('t2', Date.now() - TYPED_RECENTLY_MS - 100);
    await shows(t, 't2', 'idle', await prompted('idle', 'fix the tests'));
    t.terms.answers = [];
    expect(await phone.say('t2', 'fix the tests')).toEqual(OK);
    expect(keys(t)).toEqual([PASTE('fix the tests'), '\r']);
  });

  test('say refuses a wait, a dialog or a menu on screen, or no prompt on screen', async () => {
    const t = conversing();
    t.terms.list = [
      ...withSession(t.terms.list, 't2', waiting('waiting: Bash touch made-by-bash.txt')),
      term('w', '/work/app', { createdAt: 3, session: waitingSome('s-w') }),
      term('r', '/work/app', { createdAt: 4, session: claude('s-r') }),
      term('n1', '/work/app', { createdAt: 5 })
    ];
    t.terms.starting = new Set(['n1']);
    await shows(t, 't2', 'bash');
    await shows(t, 'w', 'working');
    await shows(t, 'n1', 'trust');
    const { phone } = await paired(t);
    // Waiting: for a permission, or for what no dialog of its own answers.
    expect(await phone.say('t2', 'go on')).toEqual(ANSWER_FIRST);
    expect(await phone.say('w', 'go on')).toEqual(ANSWER_FIRST);
    // Waiting for nothing yet: a dialog drawn before its hook, a menu, the trust dialog while Claude starts.
    for (const s of ['bash', 'question', 'model']) {
      await shows(t, 'r', s);
      expect(await phone.say('r', 'go on')).toEqual(ANSWER_FIRST);
    }
    expect(await phone.say('n1', 'go on')).toEqual(ANSWER_FIRST);
    // A wait that begins while the screen is read.
    await shows(t, 'r', 'working', await prompted('working', 'go on'));
    const g = gate(t);
    const said = phone.say('r', 'go on');
    await g.reading();
    t.terms.set(withSession(t.terms.list, 'r', waiting('waiting: Bash npm test')));
    g.open();
    expect(await said).toEqual(ANSWER_FIRST);
    t.terms.set(withSession(t.terms.list, 'r', claude('s-r')));
    // No prompt on screen: another mode (bash mode's `!`), a screen that can't be read.
    await shows(t, 'r', edit(await screen('working'), (row) => (row.trimEnd() === '❯' ? '! ls' : row)));
    expect(await phone.say('r', 'go on')).toEqual(NO_PROMPT);
    await shows(t, 'r', new Error('no screen'));
    expect(await phone.say('r', 'go on')).toEqual(NO_PROMPT);
    // Not a session listed, or not Claude's.
    expect(await phone.say('gone', 'go on')).toEqual(GONE);
    expect(await phone.say('t1', 'go on')).toEqual(NOT_CLAUDE);
    expect(t.terms.answers).toEqual([]);
  });

  test('say: a request that shows up before the Enter gets no Enter', async () => {
    const t = conversing();
    t.terms.list = withSession(t.terms.list, 't2', claude('s'));
    const { phone } = await paired(t);
    // A dialog or a menu drawn once the paste went: the text stays in Claude's prompt.
    for (const after of ['bash', 'model']) {
      await shows(t, 't2', 'idle', after);
      t.terms.answers = [];
      expect(await phone.say('t2', 'fix the tests')).toEqual(MEANWHILE);
      expect(keys(t)).toEqual([PASTE('fix the tests')]);
    }
    // The prompt shows the text, but the session waits now (its dialog not drawn yet).
    await shows(t, 't2', 'idle', await prompted('idle', 'fix the tests'));
    t.terms.onKey = (id, key) => { if (key.startsWith('\x1b[200~')) t.terms.set(withSession(t.terms.list, id, waiting('waiting: Bash npm test'))); };
    t.terms.answers = [];
    expect(await phone.say('t2', 'fix the tests')).toEqual(MEANWHILE);
    expect(keys(t)).toEqual([PASTE('fix the tests')]);
  });

  test('say: a paste that never shows in the prompt: failed, no Enter', async () => {
    const t = conversing();
    t.terms.list = withSession(t.terms.list, 't2', claude('s'));
    const { phone } = await paired(t);
    // The prompt stays empty: read again until the Enter's wait runs out.
    await shows(t, 't2', 'idle');
    t.terms.events = [];
    expect(await phone.say('t2', 'fix the tests')).toEqual(NOT_REACHED);
    expect(t.terms.events.slice(0, 2)).toEqual(['read', PASTE('fix the tests')]);
    expect(t.terms.events.slice(2).every((e) => e === 'read')).toBe(true);
    expect(t.terms.events.length).toBeGreaterThan(4);
    // Other text there (typed as the paste went), the text and more, the text folded though it is one line, a screen
    // that can't be read.
    const after = [await screen('working-typed'), await prompted('idle', 'fix the tests and the build'), await prompted('idle', '[Pasted text #1]'), new Error('no screen')];
    for (const v of after) {
      await shows(t, 't2', 'idle', v);
      t.terms.answers = [];
      expect(await phone.say('t2', 'fix the tests')).toEqual(NOT_REACHED);
      expect(keys(t)).toEqual([PASTE('fix the tests')]);
    }
  });

  test('a phone removed while its prompt types: no Enter goes after the paste', async () => {
    const t = conversing();
    t.terms.list = withSession(t.terms.list, 't2', claude('s'));
    await shows(t, 't2', 'idle', await prompted('idle', 'fix the tests'));
    const { phone } = await paired(t);
    t.terms.onKey = (_id, key) => { if (key.startsWith('\x1b[200~')) t.hub.removeDevice(t.hub.devices.list()[0]!.id); };
    t.terms.events = [];
    phone.say('t2', 'fix the tests').catch(() => {});
    // The read after the paste shows the text: the loop goes no further.
    await until(() => t.terms.events.filter((e) => e === 'read').length >= 2);
    expect(t.terms.events).toEqual(['read', PASTE('fix the tests'), 'read']);
  });

  test('stop: Esc while Claude works with no dialog; refused when idle or while a dialog shows', async () => {
    const t = conversing();
    t.terms.list = [
      ...withSession(t.terms.list, 't2', claude('s')),
      term('i', '/work/app', { createdAt: 3, session: finished }),
      term('p', '/work/app', { createdAt: 4, session: waiting('waiting: Bash touch made-by-bash.txt') }),
      term('w', '/work/app', { createdAt: 5, session: waitingSome('s-w') }),
      term('n1', '/work/app', { createdAt: 6 })
    ];
    t.terms.starting = new Set(['n1']);
    await shows(t, 't2', 'working');
    await shows(t, 'i', 'idle');
    await shows(t, 'p', 'bash');
    await shows(t, 'w', 'working');
    await shows(t, 'n1', 'idle');
    const { phone } = await paired(t);
    t.terms.events = [];
    expect(await phone.stop('t2')).toEqual(OK);
    expect(t.terms.events).toEqual(['read', ESC]);
    // Not working: its turn over, or Claude still starting.
    expect(await phone.stop('i')).toEqual(NOT_WORKING);
    expect(await phone.stop('n1')).toEqual(NOT_WORKING);
    // A request waits, its dialog drawn or not yet: Esc would decline it.
    expect(await phone.stop('p')).toEqual(ANSWER_FIRST);
    await shows(t, 'p', 'working');
    expect(await phone.stop('p')).toEqual(ANSWER_FIRST);
    expect(await phone.stop('w')).toEqual(ANSWER_FIRST);
    // A dialog drawn before its hook, or a menu, working or not: Esc would answer it, not stop Claude.
    for (const s of ['bash', 'question', 'model']) {
      await shows(t, 't2', s);
      expect(await phone.stop('t2')).toEqual(ANSWER_FIRST);
    }
    await shows(t, 'i', 'model');
    expect(await phone.stop('i')).toEqual(ANSWER_FIRST);
    // A screen that can't be read may hide a request: no Esc, the terminal tells.
    await shows(t, 't2', new Error('no screen'));
    expect(await phone.stop('t2')).toEqual(ANSWER_FIRST);
    // A window typed in the terminal just now (its own Esc, a draft): no Esc on top of it. A request or Claude not
    // working is told first.
    await shows(t, 't2', 'working');
    await shows(t, 'i', 'idle');
    for (const id of ['t2', 'i', 'p']) t.terms.windowInput.set(id, Date.now() - 500);
    expect(await phone.stop('t2')).toEqual(TYPED);
    expect(await phone.stop('i')).toEqual(NOT_WORKING);
    expect(await phone.stop('p')).toEqual(ANSWER_FIRST);
    expect(await phone.stop('gone')).toEqual(GONE);
    expect(await phone.stop('t1')).toEqual(NOT_CLAUDE);
    expect(t.terms.answers).toEqual([['t2', ESC]]);
    sizeKept(t);
  });

  test('stop goes only while the screen shows Claude working, whatever the hooks say: a late Stop hook leaves no Esc on an idle prompt', async () => {
    const t = conversing();
    // Still running by its hooks, its turn over on screen.
    t.terms.list = withSession(t.terms.list, 't2', claude('s'));
    await shows(t, 't2', 'idle');
    const { phone } = await paired(t);
    expect(await phone.stop('t2')).toEqual(NOT_WORKING);
    // Working, with text typed in Claude's prompt: Claude Code no longer offers Esc to interrupt.
    await shows(t, 't2', 'working-typed');
    expect(await phone.stop('t2')).toEqual(TYPED);
    // Text typed while the hint stays drawn (as another version may draw it): Esc would reach that draft.
    await shows(t, 't2', await prompted('working', 'a draft on the computer'));
    expect(await phone.stop('t2')).toEqual(TYPED);
    expect(t.terms.answers).toEqual([]);
    // Its turn over by its hooks, working on screen (a prompt typed on the computer, its hook not here yet).
    t.terms.set(withSession(t.terms.list, 't2', finished));
    await shows(t, 't2', 'working');
    expect(await phone.stop('t2')).toEqual(OK);
    expect(keys(t)).toEqual([ESC]);
  });

  test('a phone\'s answer, then the tool it allowed runs with the session still waiting (no hook until it is done): the dialog was answered, a prompt and an interrupt go; a dialog drawn meanwhile refuses them', async () => {
    const t = conversing();
    t.terms.list = withSession(t.terms.list, 't2', waiting('waiting: Bash touch made-by-bash.txt'));
    await shows(t, 't2', 'bash');
    const { phone } = await paired(t);
    const ALREADY = refused('busy', 'This request was answered already');
    const d = await phone.dialog('t2');
    expect(await phone.choose('t2', d.ask as string, 1, 'Yes')).toEqual(OK);
    // The command runs: Claude Code draws it working, the session waits under the same ask.
    await shows(t, 't2', 'working');
    expect(await phone.dialog('t2')).toEqual(ALREADY);
    // A prompt waits for the turn's end, as anywhere; it goes once the screen shows it over (the hooks still on the
    // request answered).
    t.terms.answers = [];
    expect(await phone.say('t2', 'run the build')).toEqual(QUEUED);
    await shows(t, 't2', 'idle', 'idle', await prompted('idle', 'run the build'));
    await until(() => keys(t).length === 2);
    expect(keys(t)).toEqual([PASTE('run the build'), '\r']);
    await shows(t, 't2', 'working-typed');
    expect(await phone.say('t2', 'run the build')).toEqual(TYPED);
    // An interrupt stops the command allowed.
    await shows(t, 't2', 'working');
    t.terms.answers = [];
    expect(await phone.stop('t2')).toEqual(OK);
    expect(keys(t)).toEqual([ESC]);
    // The next request drawn meanwhile, the hooks still on the first one: everything waits for its answer.
    await shows(t, 't2', 'bash-second');
    expect(await phone.dialog('t2')).toMatchObject({ t: 'dialog', kind: 'permission', ask: expect.stringContaining('.') });
    t.terms.answers = [];
    expect(await phone.say('t2', 'run the build')).toEqual(ANSWER_FIRST);
    expect(await phone.stop('t2')).toEqual(ANSWER_FIRST);
    // A screen read while the prompt waits for its Enter: the dialog drawn then gets no Enter.
    await shows(t, 't2', 'idle', 'bash-second');
    expect(await phone.say('t2', 'run the build')).toEqual(MEANWHILE);
    expect(keys(t)).toEqual([PASTE('run the build')]);
  });

  test('a question answered on its first page is no wait over: a frame with no dialog next reads as ever, and its next page shows; a plan\'s approval is one', async () => {
    const t = conversing();
    t.terms.list = withSession(t.terms.list, 't2', waiting('waiting: question', { question: true }));
    await shows(t, 't2', 'questions-first');
    const { phone } = await paired(t);
    const first = await phone.dialog('t2');
    expect(await phone.choose('t2', first.ask as string, 2, 'Winter')).toEqual(OK);
    // Between its pages, under the same ask: nothing to read yet, never "answered already".
    await shows(t, 't2', 'working');
    expect(await phone.dialog('t2')).toEqual(IN_TERMINAL);
    expect(await phone.stop('t2')).toEqual(ANSWER_FIRST);
    expect(await phone.say('t2', 'run the build')).toEqual(ANSWER_FIRST);
    await shows(t, 't2', 'questions-second');
    expect(await phone.dialog('t2')).toMatchObject({ kind: 'question', rows: expect.arrayContaining(['What is your favorite drink?']) });
    // A plan approved from the phone: one answer ends that wait.
    t.terms.set(withSession(t.terms.list, 't2', claude('s')));
    t.terms.set(withSession(t.terms.list, 't2', waiting('waiting: plan approval', { updatedAt: 9 })));
    await shows(t, 't2', 'plan');
    const plan = await phone.dialog('t2');
    expect(plan).toMatchObject({ kind: 'plan', ask: expect.not.stringContaining(first.ask as string) });
    expect(await phone.choose('t2', plan.ask as string, 1, 'Yes, and use auto mode')).toEqual(OK);
    await shows(t, 't2', 'working');
    expect(await phone.dialog('t2')).toEqual(refused('busy', 'This request was answered already'));
    expect(await phone.stop('t2')).toEqual(OK);
  });

  test('a wait the row answered is answered alike; one answered on the computer, of which nothing tells this one, is refused as before', async () => {
    const t = conversing();
    t.terms.list = withSession(t.terms.list, 't2', waiting('waiting: Bash touch made-by-bash.txt'));
    const { phone } = await paired(t);
    const ALREADY = refused('busy', 'This request was answered already');
    const waitKey = async (not?: string) => ((await phone.state((s) => (s.sessions as Msg[]).some((x) => x.id === 't2' && x.wait && x.wait !== not))).sessions as Msg[]).find((x) => x.id === 't2')!.wait as string;
    const first = await waitKey();
    await shows(t, 't2', 'bash', 'working');
    expect(await phone.answer('t2', first, 'allow')).toEqual(OK);
    expect(await phone.dialog('t2')).toEqual(ALREADY);
    expect(await phone.stop('t2')).toEqual(OK);
    expect(keys(t)).toEqual(['1', ESC]);
    // The next wait, answered on the computer: its dialog gone, the session still waiting.
    t.terms.set(withSession(t.terms.list, 't2', claude('s')));
    t.terms.set(withSession(t.terms.list, 't2', waiting('waiting: Bash touch made-by-bash.txt', { updatedAt: 9 })));
    await waitKey(first);
    await shows(t, 't2', 'working');
    expect(await phone.dialog('t2')).toEqual(IN_TERMINAL);
    expect(await phone.stop('t2')).toEqual(ANSWER_FIRST);
    expect(await phone.say('t2', 'run the build')).toEqual(ANSWER_FIRST);
    expect(keys(t)).toEqual(['1', ESC]);
  });

  test('escape: Esc on a menu only; refused on a permission, a question, the trust dialog, or nothing', async () => {
    const t = conversing();
    t.terms.list = [
      ...withSession(t.terms.list, 't2', finished),
      term('p', '/work/app', { createdAt: 3, session: waiting('waiting: Bash touch made-by-bash.txt') }),
      term('q', '/work/app', { createdAt: 4, session: waiting('waiting: question', { question: true }) }),
      term('n1', '/work/app', { createdAt: 5 })
    ];
    t.terms.starting = new Set(['n1']);
    await shows(t, 't2', 'model');
    await shows(t, 'p', 'bash');
    await shows(t, 'q', 'question');
    await shows(t, 'n1', 'trust');
    const { phone } = await paired(t);
    t.terms.events = [];
    expect(await phone.escape('t2')).toEqual(OK);
    expect(t.terms.events).toEqual(['read', ESC]);
    // A permission or a question waiting for its answer.
    expect(await phone.escape('p')).toEqual(NO_MENU);
    expect(await phone.escape('q')).toEqual(NO_MENU);
    // Drawn before its hook (nothing waits yet), a permission, a plan's approval, a question, its review page: their
    // own rows tell them from a menu.
    for (const s of ['bash', 'edit', 'plan', 'question', 'questions-review']) {
      await shows(t, 't2', s);
      expect(await phone.escape('t2')).toEqual(NO_MENU);
    }
    // The trust dialog, as this version draws it and numbered: Esc there exits Claude Code.
    expect(await phone.escape('n1')).toEqual(IN_TERMINAL);
    await shows(t, 't2', numberedTrust);
    expect(await phone.escape('t2')).toEqual(IN_TERMINAL);
    // Nothing to close: the prompt, text in it, a screen that can't be read.
    for (const s of ['idle', 'working-typed', new Error('no screen')]) {
      await shows(t, 't2', s);
      expect(await phone.escape('t2')).toEqual(NO_MENU);
    }
    // A window typed in the terminal just now: its own Esc may be on its way, and two would do more than close it.
    await shows(t, 't2', 'model');
    t.terms.windowInput.set('t2', Date.now() - 500);
    expect(await phone.escape('t2')).toEqual(TYPED);
    expect(await phone.escape('gone')).toEqual(GONE);
    expect(await phone.escape('t1')).toEqual(NOT_CLAUDE);
    expect(t.terms.answers).toEqual([['t2', ESC]]);
    sizeKept(t);
  });

  test('one typing request per session at a time, across phones', async () => {
    const t = conversing();
    t.terms.list = withSession(t.terms.list, 't2', claude('s'));
    await shows(t, 't2', 'idle', await prompted('idle', 'fix the tests'));
    const { phone } = await paired(t);
    const two = await another(t);
    // The first phone's prompt still reading the screen: every other typing is refused, and none of those frees the
    // terminal it holds.
    const g = gate(t);
    const said = phone.say('t2', 'fix the tests');
    await g.reading();
    expect(await two.stop('t2')).toEqual(BEING);
    expect(await two.escape('t2')).toEqual(BEING);
    expect(await phone.stop('t2')).toEqual(BEING);
    // A prompt waits for its turn.
    expect(await two.say('t2', 'run the build')).toEqual(QUEUED);
    g.open();
    expect(await said).toEqual(OK);
    await shows(t, 't2', 'idle', 'idle', await prompted('idle', 'run the build'));
    await until(() => keys(t).length === 4);
    // Free again once it is done.
    await shows(t, 't2', 'working');
    expect(await two.stop('t2')).toEqual(OK);
    expect(keys(t)).toEqual([PASTE('fix the tests'), '\r', PASTE('run the build'), '\r', ESC]);
    // An answer on its way holds it too: a choice in a dialog while it reads the screen.
    t.terms.set(withSession(t.terms.list, 't2', waiting('waiting: Bash touch made-by-bash.txt')));
    await shows(t, 't2', 'bash');
    const d = await phone.dialog('t2');
    const g2 = gate(t);
    const chose = phone.choose('t2', d.ask as string, 1, 'Yes');
    await g2.reading();
    expect(await two.stop('t2')).toEqual(BEING);
    g2.open();
    expect(await chose).toEqual(OK);
    // And typing holds it for the row's Allow: an interrupt while it reads the screen.
    const waitKey = async (not?: string) => ((await phone.state((s) => (s.sessions as Msg[]).some((x) => x.id === 't2' && x.wait && x.wait !== not))).sessions as Msg[]).find((x) => x.id === 't2')!.wait as string;
    const before = await waitKey();
    t.terms.set(withSession(t.terms.list, 't2', claude('s')));
    t.terms.set(withSession(t.terms.list, 't2', waiting('waiting: Bash touch made-by-bash.txt', { updatedAt: 9 })));
    const next = await waitKey(before);
    const g3 = gate(t);
    const stopped = phone.stop('t2');
    await g3.reading();
    expect(await two.answer('t2', next, 'allow')).toEqual(BEING);
    g3.open();
    expect(await stopped).toEqual(ANSWER_FIRST);
    expect(await two.answer('t2', next, 'allow')).toEqual(OK);
    expect(keys(t)).toEqual([PASTE('fix the tests'), '\r', PASTE('run the build'), '\r', ESC, '1', '1']);
  });

  // ── Prompts with images ──

  /** A png's or a jpeg's first bytes, then `n` (each image its own bytes, to find its file by). */
  const png = (n: number) => Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, n]);
  const jpeg = (n: number) => Buffer.from([0xff, 0xd8, 0xff, 0xe0, n]);
  const IMAGE_GONE = refused('invalid', 'The image isn\'t on the computer any more. Send it again.');
  const IMAGE_NOT_REACHED = refused('failed', 'The image didn\'t reach Claude\'s prompt.');
  /** Hands the computer an image for terminal `id`: its reference, and the file it was kept in. */
  const sent = async (t: ReturnType<typeof setup>, phone: FakePhone, id: string, bytes: Buffer) => {
    const r = await phone.image(id, bytes[0] === 0xff ? 'jpeg' : 'png', bytes);
    if (r.t !== 'ok') throw new Error(String(r.message));
    const path = readdirSync(t.imageDir).map((f) => join(t.imageDir, f)).find((p) => readFileSync(p).equals(bytes));
    return { ref: r.image as string, path: path! };
  };
  /** `n` copies of a screen, one per read. */
  const times = (n: number, v: ScreenView) => Array.from({ length: n }, () => v);

  test('say with images: each one\'s path pasted alone until the prompt shows one more marker, then a space and the text, then Enter; used up once sent', async () => {
    const t = conversing();
    t.terms.list = withSession(t.terms.list, 't2', finished);
    const { phone } = await paired(t);
    const one = await sent(t, phone, 't2', png(1));
    const two = await sent(t, phone, 't2', jpeg(2));
    expect(two.path.endsWith('.jpg')).toBe(true);
    // The path drawn as text a moment before its marker; Claude Code's own numbers, whatever they are.
    await shows(t, 't2', 'idle', await prompted('idle', one.path), await prompted('idle', '[Image #3]'), await prompted('idle', '[Image #3][Image #4]'),
      await prompted('idle', '[Image #3][Image #4] What changed', 'between them?'));
    t.terms.events = [];
    expect(await phone.say('t2', 'What changed\nbetween them?', [one.ref, two.ref])).toEqual(OK);
    expect(t.terms.events).toEqual(['read', PASTE(one.path), 'read', 'read', PASTE(two.path), 'read', PASTE(' What changed\nbetween them?'), 'read', '\r']);
    // Sent: its images are used up.
    t.terms.events = [];
    expect(await phone.say('t2', 'again', [two.ref])).toEqual(IMAGE_GONE);
    expect(t.terms.events).toEqual([]);
    // On Claude Code's own screens: the marker, then the text after it.
    const four = await sent(t, phone, 't2', png(4));
    await shows(t, 't2', 'idle', 'image-pasted', 'image-text');
    expect(await phone.say('t2', 'What color is this image?', [four.ref])).toEqual(OK);
    expect(t.terms.events).toEqual(['read', PASTE(four.path), 'read', PASTE(' What color is this image?'), 'read', '\r']);
    t.terms.events = [];
    // Images alone: Enter once the prompt shows them, and nothing else.
    const three = await sent(t, phone, 't2', png(3));
    await shows(t, 't2', 'idle', await prompted('idle', '[Image #5]'));
    expect(await phone.say('t2', '', [three.ref])).toEqual(OK);
    expect(t.terms.events).toEqual(['read', PASTE(three.path), 'read', '\r']);
    sizeKept(t);
  });

  test('say with images: no Enter once a marker never shows, a window types, or Claude asks something meanwhile; the images stay for a retry', async () => {
    const t = conversing();
    t.terms.list = withSession(t.terms.list, 't2', claude('s'));
    const { phone } = await paired(t);
    const one = await sent(t, phone, 't2', png(1));
    const two = await sent(t, phone, 't2', png(2));
    // The path stays text (Claude Code couldn't read it): read for the image's own wait, longer than an Enter's (here
    // 60 reads, not 30), then nothing more typed.
    await shows(t, 't2', 'idle', await prompted('idle', one.path));
    t.terms.events = [];
    expect(await phone.say('t2', 'and these?', [one.ref])).toEqual(IMAGE_NOT_REACHED);
    expect(keys(t)).toEqual([PASTE(one.path)]);
    expect(t.terms.events.filter((e) => e === 'read').length).toBeGreaterThan(50);
    // The second image never shows: no text, no Enter.
    await shows(t, 't2', 'idle', await prompted('idle', '[Image #1]'));
    t.terms.answers = [];
    expect(await phone.say('t2', 'and these?', [one.ref, two.ref])).toEqual(IMAGE_NOT_REACHED);
    expect(keys(t)).toEqual([PASTE(one.path), PASTE(two.path)]);
    // The images then the text within a whole prompt's wait: here each image takes 55 reads of its 60, and the second
    // runs past the 100 the whole prompt may take.
    await shows(t, 't2', 'idle', ...times(54, await prompted('idle', one.path)), await prompted('idle', '[Image #1]'), ...times(54, await prompted('idle', '[Image #1]')),
      await prompted('idle', '[Image #1][Image #2]'), await prompted('idle', '[Image #1][Image #2] and these?'));
    t.terms.answers = [];
    expect(await phone.say('t2', 'and these?', [one.ref, two.ref])).toEqual(IMAGE_NOT_REACHED);
    expect(keys(t)).toEqual([PASTE(one.path), PASTE(two.path)]);
    // A window types once the first image went: no more keys.
    await shows(t, 't2', 'idle', await prompted('idle', '[Image #1]'));
    t.terms.windowInput.set('t2', Date.now() - TYPED_RECENTLY_MS - 100);
    t.terms.onKey = (id, key) => { if (key === PASTE(one.path)) t.terms.windowInput.set(id, Date.now()); };
    t.terms.answers = [];
    expect(await phone.say('t2', 'and these?', [one.ref, two.ref])).toEqual(TYPED);
    expect(keys(t)).toEqual([PASTE(one.path)]);
    // A dialog drawn once an image went.
    t.terms.onKey = null;
    t.terms.windowInput.set('t2', 0);
    await shows(t, 't2', 'idle', 'bash');
    t.terms.answers = [];
    expect(await phone.say('t2', 'and these?', [one.ref])).toEqual(MEANWHILE);
    expect(keys(t)).toEqual([PASTE(one.path)]);
    // Refused every time: the images still go.
    await shows(t, 't2', 'idle', await prompted('idle', '[Image #1]'), await prompted('idle', '[Image #1][Image #2]'));
    t.terms.answers = [];
    expect(await phone.say('t2', '', [one.ref, two.ref])).toEqual(OK);
    expect(keys(t)).toEqual([PASTE(one.path), PASTE(two.path), '\r']);
  });

  test('say with images: refused before any key for an image not on the computer: never given, another terminal\'s, another phone\'s, run out', async () => {
    const t = conversing({ imageMs: 300 });
    t.terms.list = [...withSession(t.terms.list, 't2', finished), term('t3', '/work/app', { createdAt: 3, session: claude('s3') })];
    await shows(t, 't2', 'idle', await prompted('idle', '[Image #1]'));
    const { phone } = await paired(t);
    const two = await another(t);
    const mine = await sent(t, phone, 't2', png(1));
    const theirs = await sent(t, two, 't2', png(2));
    const t3s = await sent(t, phone, 't3', png(3));
    expect(await phone.say('t2', 'x', ['n'.repeat(22)])).toEqual(IMAGE_GONE);
    expect(await phone.say('t2', 'x', [mine.ref, t3s.ref])).toEqual(IMAGE_GONE);
    expect(await phone.say('t2', 'x', [theirs.ref])).toEqual(IMAGE_GONE);
    // Not a session listed, or not Claude's: refused as ever, first.
    expect(await phone.say('gone', 'x', [mine.ref])).toEqual(GONE);
    expect(await phone.say('t1', 'x', [mine.ref])).toEqual(NOT_CLAUDE);
    expect(t.terms.answers).toEqual([]);
    // Run out: 10 minutes for the computer, here a moment.
    await pause(350);
    expect(await phone.say('t2', '', [mine.ref])).toEqual(IMAGE_GONE);
    expect(t.terms.answers).toEqual([]);
  });

  test('say with images while Claude works: kept on this computer (its images used up), and never joined with another prompt waiting', async () => {
    const t = conversing();
    t.terms.list = withSession(t.terms.list, 't2', claude('s'));
    await shows(t, 't2', 'working');
    const { phone } = await paired(t);
    const one = await sent(t, phone, 't2', png(1));
    const two = await sent(t, phone, 't2', png(2));
    const rowOf = (s: Msg) => (s.sessions as Msg[]).find((x) => x.id === 't2');
    expect(await phone.say('t2', 'fix the tests')).toEqual(QUEUED);
    expect(await phone.say('t2', 'and this', [one.ref])).toEqual(QUEUED);
    // Waiting, its images are used up: sent again, refused.
    expect(await phone.say('t2', 'and this', [one.ref])).toEqual(IMAGE_GONE);
    expect(await phone.say('t2', 'and this', [two.ref])).toEqual(QUEUED);
    expect(rowOf(await phone.state((s) => rowOf(s)?.queued === 3))?.queued).toBe(3);
    // Idle: the text alone, then each prompt with its images alone.
    await shows(t, 't2', 'idle', 'idle', await prompted('idle', 'fix the tests'));
    await until(() => keys(t).length === 2);
    await shows(t, 't2', 'idle', 'idle', await prompted('idle', '[Image #1]'), await prompted('idle', '[Image #1] and this'));
    await until(() => keys(t).length === 5);
    await shows(t, 't2', 'idle', 'idle', await prompted('idle', '[Image #2]'), await prompted('idle', '[Image #2] and this'));
    await until(() => keys(t).length === 8);
    expect(keys(t)).toEqual([PASTE('fix the tests'), '\r', PASTE(one.path), PASTE(' and this'), '\r', PASTE(two.path), PASTE(' and this'), '\r']);
    sizeKept(t);
  });

  test('say: nothing more typed once Claude starts a turn by itself while the prompt types (its hooks say so, or its screen); what went stays in the prompt', async () => {
    const STARTED = refused('busy', 'Claude started working meanwhile. Check the terminal.');
    const t = conversing();
    t.terms.list = withSession(t.terms.list, 't2', finished);
    const { phone } = await paired(t);
    const one = await sent(t, phone, 't2', png(1));
    const two = await sent(t, phone, 't2', png(2));
    // A turn starts once the first image went (a background task's notice): its hooks say so, while the screen still
    // shows the marker in the prompt (text in the prompt takes the place of "esc to interrupt").
    await shows(t, 't2', 'idle', await prompted('idle', '[Image #1]'));
    const starts = (after: string) => { t.terms.onKey = (id, key) => { if (key === after) t.terms.list = withSession(t.terms.list, id, claude('s')); }; };
    starts(PASTE(one.path));
    expect(await phone.say('t2', 'and these?', [one.ref, two.ref])).toEqual(STARTED);
    expect(keys(t)).toEqual([PASTE(one.path)]);
    // Its screen says so: "esc to interrupt" under the box, the hooks not (yet).
    t.terms.onKey = null;
    t.terms.list = withSession(t.terms.list, 't2', finished);
    t.terms.answers = [];
    await shows(t, 't2', 'idle', await prompted('working', '[Image #1]'));
    expect(await phone.say('t2', 'and these?', [one.ref])).toEqual(STARTED);
    expect(keys(t)).toEqual([PASTE(one.path)]);
    // A text alone: no Enter into the turn.
    t.terms.answers = [];
    await shows(t, 't2', 'idle', await prompted('idle', 'fix the tests'));
    starts(PASTE('fix the tests'));
    expect(await phone.say('t2', 'fix the tests')).toEqual(STARTED);
    expect(keys(t)).toEqual([PASTE('fix the tests')]);
    // Hooks that said Claude worked from the start (an interrupt leaves them so): the screen alone tells.
    t.terms.onKey = null;
    t.terms.answers = [];
    await shows(t, 't2', 'idle', await prompted('idle', 'fix the tests'));
    expect(await phone.say('t2', 'fix the tests')).toEqual(OK);
    expect(keys(t)).toEqual([PASTE('fix the tests'), '\r']);
  });

  test('say with images: an image on its way (a tap twice, a prompt and a paste) is taken by one of them only; the other is told', async () => {
    const IMAGE_BUSY = refused('busy', 'This image is on its way to the terminal already.');
    const t = conversing();
    t.terms.list = withSession(t.terms.list, 't2', finished);
    const { phone } = await paired(t);
    await phone.attach('t2');
    const one = await sent(t, phone, 't2', png(1));
    await shows(t, 't2', 'idle', 'idle', await prompted('idle', '[Image #1]'), await prompted('idle', '[Image #1] look'));
    t.terms.answers = [];
    // The first reads the screen before any key: the second, and a paste of the same image, come meanwhile.
    const g = gate(t);
    const first = phone.say('t2', 'look', [one.ref]);
    await g.reading();
    expect(await phone.say('t2', 'look', [one.ref])).toEqual(IMAGE_BUSY);
    g.open();
    expect(await first).toEqual(OK);
    expect(keys(t)).toEqual([PASTE(one.path), PASTE(' look'), '\r']);
    // A paste on its way holds it the same: a prompt naming it meanwhile is told.
    const two = await sent(t, phone, 't2', png(2));
    const g2 = gate(t);
    const pasted = phone.paste('t2', two.ref);
    await g2.reading();
    expect(await phone.say('t2', '', [two.ref])).toEqual(IMAGE_BUSY);
    g2.open();
    expect(await pasted).toEqual(OK);
    expect(t.terms.inputs.map(([, d]) => d)).toEqual([`\x1b[200~${two.path}\x1b[201~`]);
    // One refused gives it back, for a retry.
    const three = await sent(t, phone, 't2', png(3));
    await shows(t, 't2', new Error('no screen'));
    expect(await phone.paste('t2', three.ref)).toEqual(refused('failed', 'The image could not be pasted.'));
    t.terms.views.delete('t2');
    expect(await phone.paste('t2', three.ref)).toEqual(OK);
  });

  test('say with images while Claude works: the same image sent again (a resend whose answer was lost: a new reference, a new file) waits once; images wait 10 at most', async () => {
    const FULL = refused('busy', 'Too much is waiting for Claude already. Send it once Claude is done.');
    const t = conversing();
    t.terms.list = withSession(t.terms.list, 't2', claude('s'));
    await shows(t, 't2', 'working');
    const { phone } = await paired(t);
    const rowOf = (s: Msg) => (s.sessions as Msg[]).find((x) => x.id === 't2');
    const first = await sent(t, phone, 't2', png(1));
    expect(await phone.say('t2', 'and this', [first.ref])).toEqual(QUEUED);
    const again = (await phone.image('t2', 'png', png(1))).image as string;
    expect(await phone.say('t2', 'and this', [again])).toEqual(QUEUED);
    expect(rowOf(await phone.state((s) => rowOf(s)?.queued === 1))?.queued).toBe(1);
    // Up to 10 images waiting: one more is refused, and stays for later.
    const five = async (from: number) => { const refs: string[] = []; for (let n = from; n < from + 5; n++) refs.push((await sent(t, phone, 't2', png(n))).ref); return refs; };
    expect(await phone.say('t2', '', await five(10))).toEqual(QUEUED);
    const more = await five(20);
    expect(await phone.say('t2', '', [more[0]!, more[1]!, more[2]!, more[3]!])).toEqual(QUEUED);
    expect(await phone.say('t2', 'too many', [more[4]!])).toEqual(FULL);
    expect(rowOf(await phone.state((s) => rowOf(s)?.queued === 3))?.queued).toBe(3);
  });
});

describe('images from a phone', () => {
  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
  const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16]);
  const UNUSABLE = refused('invalid', 'This image can\'t be used.');
  const IMAGE_GONE = refused('invalid', 'The image isn\'t on the computer any more. Send it again.');
  const NOT_OPEN = refused('invalid', 'Open this terminal before typing into it.');
  const ANSWER_FIRST = refused('busy', 'Answer Claude\'s request first.');
  /** The files in the folder of pasted images. */
  const kept = (t: ReturnType<typeof setup>) => { try { return readdirSync(t.imageDir).sort(); } catch { return []; } };
  /** The file holding these bytes. */
  const fileOf = (t: ReturnType<typeof setup>, bytes: Buffer) => kept(t).map((f) => join(t.imageDir, f)).find((p) => readFileSync(p).equals(bytes))!;
  /** Screen reads wait from now until `open()`. */
  const gate = (t: ReturnType<typeof setup>) => {
    let open = () => {};
    t.terms.screenGate = new Promise<void>((r) => { open = () => { t.terms.screenGate = null; r(); }; });
    const before = t.terms.gated;
    return { open, reading: () => until(() => t.terms.gated > before) };
  };

  test('image: kept in a private file where Atelier keeps its own pasted images, named by an opaque reference; for a listed terminal only', async () => {
    const t = setup();
    const { phone } = await paired(t);
    // A Claude session: a prompt may carry it, attached or not.
    const a = await phone.image('t2', 'png', PNG);
    expect(a).toEqual({ t: 'ok', rid: expect.any(Number), image: expect.stringMatching(/^[A-Za-z0-9_-]{1,64}$/) });
    expect(await phone.image('t2', 'jpeg', JPEG)).toMatchObject({ t: 'ok', image: expect.any(String) });
    const files = kept(t);
    expect(files).toHaveLength(2);
    expect(files.map((f) => f.split('.').pop()).sort()).toEqual(['jpg', 'png']);
    const png = join(t.imageDir, files.find((f) => f.endsWith('.png'))!);
    expect(readFileSync(png)).toEqual(PNG);
    expectMode(png, 0o600);
    expectMode(t.imageDir, 0o700);
    // A plain terminal only once the phone opened it (a paste is all it can take); a terminal not listed: not found.
    expect(await phone.image('t1', 'png', PNG)).toEqual(NOT_OPEN);
    await phone.attach('t1');
    expect(await phone.image('t1', 'png', PNG)).toMatchObject({ t: 'ok' });
    expect(await phone.image('gone', 'png', PNG)).toEqual(refused('not-found', 'This session is not on this computer any more.'));
    // Not an image Atelier keeps: another type, the other type's bytes, too large, base64 rather than base64url, nothing.
    const before = kept(t);
    expect(await phone.image('t2', 'gif', PNG)).toEqual(UNUSABLE);
    expect(await phone.image('t2', 'png', JPEG)).toEqual(UNUSABLE);
    expect(await phone.image('t2', 'png', Buffer.concat([PNG, Buffer.alloc(2 * 1024 * 1024)]))).toEqual(UNUSABLE);
    const plus = Buffer.concat([PNG, Buffer.from([0xfb, 0xff, 0xbf])]).toString('base64');
    expect(plus).toMatch(/[+/]/);
    expect(await phone.image('t2', 'png', plus)).toEqual(UNUSABLE);
    expect(await phone.image('t2', 'png', '')).toEqual(UNUSABLE);
    expect(kept(t)).toEqual(before);
  });

  test('image: at most 10 references held by a channel, a new one dropping the oldest', async () => {
    const t = setup();
    const { phone } = await paired(t);
    const refs: string[] = [];
    for (let i = 0; i < 11; i++) {
      const r = await phone.image('t2', 'png', PNG);
      expect(r).toMatchObject({ t: 'ok' });
      refs.push(r.image as string);
    }
    // The first is gone; the second still names its image (the prompt is refused for the session's wait instead).
    expect(await phone.say('t2', '', [refs[0]!])).toEqual(IMAGE_GONE);
    expect(await phone.say('t2', '', [refs[1]!])).toEqual(ANSWER_FIRST);
  });

  test('image: for a terminal whose attach is on its way, as for one attached', async () => {
    const t = setup();
    const { phone } = await paired(t);
    let open = () => {};
    t.terms.attachGate = new Promise<void>((r) => { open = () => { t.terms.attachGate = null; r(); }; });
    phone.send({ t: 'attach', rid: 900, id: 't1', cols: 80, rows: 24 });
    expect(await phone.image('t1', 'png', PNG)).toMatchObject({ t: 'ok' });
    open();
    await phone.waitFor((m) => m.t === 'snapshot' && m.id === 't1');
  });

  test('image: a folder that can\'t be written is "could not be saved"', async () => {
    const home = mkdtempSync(join(tmpdir(), 'atl-remote-hub-'));
    // A file where the folder should be.
    const blocked = join(home, 'clipboard');
    writeFileSync(blocked, 'x');
    const t = setup({ home, deps: { imageDir: blocked } });
    const { phone } = await paired(t);
    expect(await phone.image('t2', 'png', PNG)).toEqual(refused('failed', 'The image could not be saved on the computer.'));
  });

  test('references die with their channel: the same phone connecting again holds none', async () => {
    const t = setup();
    const { phone } = await paired(t);
    await phone.attach('t1');
    const r = await phone.image('t1', 'png', PNG);
    expect(await phone.connect()).toMatchObject({ t: 'welcome' });
    await phone.attach('t1');
    expect(await phone.paste('t1', r.image as string)).toEqual(IMAGE_GONE);
    expect(await phone.say('t2', '', [r.image as string])).toEqual(IMAGE_GONE);
  });

  test('paste: the image\'s path typed into an attached terminal as Paste does, bracketed when the program asked; used up once typed', async () => {
    const t = setup({ timing: { imageMs: 300 } });
    const { phone } = await paired(t);
    await phone.attach('t1');
    const one = Buffer.concat([PNG, Buffer.from([1])]);
    const two = Buffer.concat([PNG, Buffer.from([2])]);
    const r1 = (await phone.image('t1', 'png', one)).image as string;
    const r2 = (await phone.image('t1', 'png', two)).image as string;
    expect(await phone.paste('t1', r1)).toEqual(OK);
    // Typed: used up.
    expect(await phone.paste('t1', r1)).toEqual(IMAGE_GONE);
    // A shell that didn't ask for bracketed paste gets the path as it is.
    t.terms.pasteModes.set('t1', false);
    expect(await phone.paste('t1', r2)).toEqual(OK);
    // Through the phone's input, as typing is (it takes the terminal's size there).
    expect(t.terms.inputs).toEqual([['t1', `\x1b[200~${fileOf(t, one)}\x1b[201~`], ['t1', fileOf(t, two)]]);
    // Not opened: refused as input is. Not an image of this terminal, of this channel, or not any more.
    const claudes = (await phone.image('t2', 'png', PNG)).image as string;
    expect(await phone.paste('t2', claudes)).toEqual(NOT_OPEN);
    expect(await phone.paste('t1', claudes)).toEqual(IMAGE_GONE);
    expect(await phone.paste('t1', 'n'.repeat(22))).toEqual(IMAGE_GONE);
    const r3 = (await phone.image('t1', 'png', PNG)).image as string;
    const two2 = await another(t);
    await two2.attach('t1');
    expect(await two2.paste('t1', r3)).toEqual(IMAGE_GONE);
    await pause(350);
    expect(await phone.paste('t1', r3)).toEqual(IMAGE_GONE);
    expect(t.terms.inputs).toHaveLength(2);
  });

  test('paste: a screen that can\'t be read (how the program takes a paste is unknown) is "could not be pasted"; the image stays', async () => {
    const t = setup();
    const { phone } = await paired(t);
    await phone.attach('t1');
    const r = (await phone.image('t1', 'png', PNG)).image as string;
    await shows(t, 't1', new Error('no screen'));
    expect(await phone.paste('t1', r)).toEqual(refused('failed', 'The image could not be pasted.'));
    expect(t.terms.inputs).toEqual([]);
    t.terms.views.delete('t1');
    expect(await phone.paste('t1', r)).toEqual(OK);
  });

  test('paste: the phone\'s input and pastes after it are typed after it, in order', async () => {
    const t = setup();
    const { phone } = await paired(t);
    await phone.attach('t1');
    const one = Buffer.concat([PNG, Buffer.from([1])]);
    const two = Buffer.concat([PNG, Buffer.from([2])]);
    const r1 = (await phone.image('t1', 'png', one)).image as string;
    const r2 = (await phone.image('t1', 'png', two)).image as string;
    // The paste reads the screen first: a key and another paste sent meanwhile wait for it.
    const g = gate(t);
    const pasted = phone.paste('t1', r1);
    await g.reading();
    phone.input('t1', 'x\r');
    const second = phone.paste('t1', r2);
    // An answer that comes once the hub has had both (it handles a phone's messages in order).
    expect(await phone.image('t1', 'png', PNG)).toMatchObject({ t: 'ok' });
    expect(t.terms.inputs).toEqual([]);
    g.open();
    expect(await pasted).toEqual(OK);
    expect(await second).toEqual(OK);
    expect(t.terms.inputs).toEqual([['t1', `\x1b[200~${fileOf(t, one)}\x1b[201~`], ['t1', 'x\r'], ['t1', `\x1b[200~${fileOf(t, two)}\x1b[201~`]]);
    // Nothing waiting: input goes at once, as ever.
    phone.input('t1', 'y');
    await until(() => t.terms.inputs.length === 4);
  });

  test('Atelier starting prunes the images folder: a phone\'s images more than a day old go, as pasted ones do', async () => {
    const t = setup();
    mkdirSync(t.imageDir, { recursive: true });
    const old = join(t.imageDir, 'clipboard-2026-10-08-090000-OLD.jpg');
    const recent = join(t.imageDir, 'clipboard-2026-10-10-090000-NEW.png');
    for (const f of [old, recent]) writeFileSync(f, 'x');
    const twoDaysAgo = (Date.now() - 2 * 86_400_000) / 1000;
    utimesSync(old, twoDaysAgo, twoDaysAgo);
    t.hub.start();
    expect(kept(t)).toEqual(['clipboard-2026-10-10-090000-NEW.png']);
  });
});
