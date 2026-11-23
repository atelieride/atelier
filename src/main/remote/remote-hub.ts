// iPhone access in the main process: with Settings › iPhone on, this computer keeps one connection to the relay and
// serves each paired phone that connects through it — the state of its projects and sessions, a terminal's screen and
// output, typing, sizes, new sessions — and runs pairing (the code, the Allow/Deny question to the windows). Off, no
// relay connection exists at all. A phone only names what the state listed: opaque project ids and terminal ids, never
// paths, commands, accounts or profiles.
import type { RemoteDeviceInfo, RemoteLayout, RemotePairingEvent, RemotePairingStart, RemoteRelayState, RemoteSized, RemoteStatus } from '@shared/remote';
import { relayBase } from '@shared/remote';
import type { Settings } from '@shared/settings';
import type { PortsMap } from '@shared/ports';
import type { PrEntry } from '@shared/pr';
import type { Resumable, TerminalInfo } from '@shared/protocol';
import type { UsageEntry } from '@shared/session';
import type { SecretStore } from '../connectors/secret-store';
import type { RemoteViewer } from '../terminal-hub';
import type { Size } from '../terminal-sizes';
import { SecureChannel, type Admission } from './channel';
import { DeviceStore, type PairedDevice } from './devices';
import { IdentityStore, type RemoteIdentity } from './identity';
import { LayoutStore } from './layouts';
import { CLOSE, type ByeReason, type DeviceMessage, type HostMessage, type RemoteAccount } from './messages';
import { Pairing } from './pairing';
import { RelayLink, type RelayLinkOptions } from './relay-link';
import { remoteState, remoteUsage, type RemoteState } from './state';
import { MAX_APP_MESSAGE, type ChannelKind } from './wire';

/** What the hub needs of TerminalHub. */
export interface RemoteTerminals {
  allTerminals(): readonly TerminalInfo[];
  /** The sessions offered to resume, every project's. */
  allResumables(): readonly Resumable[];
  /** The Claude accounts' limits, per config dir, from the status line. */
  usageList(): readonly UsageEntry[];
  /** Terminals launched as Claude sessions whose Claude hasn't started yet. */
  startingIds(): ReadonlySet<string>;
  onShown(cb: () => void): () => void;
  addRemoteViewer(v: RemoteViewer): number;
  removeRemoteViewer(key: number): void;
  remoteAttach(key: number, id: string, cols: number, rows: number): Promise<void>;
  remoteDetach(key: number, id: string): void;
  remoteInput(key: number, id: string, data: string): boolean;
  remoteResize(key: number, id: string, cols: number, rows: number): boolean;
  remoteSized(): RemoteSized[];
  createRemoteSession(o: { project: string; kind: 'claude' | 'terminal'; cols: number; rows: number }): Promise<TerminalInfo>;
}

export interface RemoteHubDeps {
  home: string;
  secrets: Pick<SecretStore, 'available' | 'read' | 'write' | 'remove'>;
  settings(): Settings;
  /** The relay to dial: the setting (or a test relay in development). */
  relayUrl(): string;
  terminals: RemoteTerminals;
  /** The open project windows' roots in order, and the recent projects. */
  projects(): { open: string[]; recent: string[] };
  /** This computer as phones see it. */
  host: { name: string; app: string; platform: 'darwin' | 'win32' };
  /** The default Claude account's config dir (a session's account is found by its dir). */
  defaultDir(): string;
  /** A project's terminals' listening ports as their rows show them (none with Show listening ports off). */
  ports?(root: string): PortsMap;
  /** A project's sessions' pull requests. */
  prs?(root: string): Record<string, PrEntry>;
  /** A path with its links resolved. */
  realOf?(p: string): string;
  emitStatus(s: RemoteStatus): void;
  emitPairing(e: RemotePairingEvent): void;
  log?(message: string): void;
  timing?: Partial<{ stateMs: number; usageMs: number; outMs: number; decideMs: number; codeTtlMs: number }>;
  link?: Pick<RelayLinkOptions, 'timing' | 'budget'>;
}

/** State goes out at most this often (coalesced), only when it changed. */
const STATE_MS = 200;
/** Usage likewise, at most once a second. */
const USAGE_MS = 1000;
/** One `out` per terminal at most this often: what arrives in between is concatenated, in order. */
const OUT_MS = 16;
/** More output than this queued for a phone (a slow link): its channel closes, it reconnects and attaches again. */
const MAX_BACKLOG = 8 * 1024 * 1024;
/** Characters per `out` message at most (its JSON stays far below the 8 MiB message size). */
const OUT_CHUNK = 512 * 1024;
/** A screen larger than a message can carry loses its oldest lines. */
const SNAPSHOT_MAX = MAX_APP_MESSAGE - 64 * 1024;
const DEFAULT_SIZE: Size = { cols: 120, rows: 36 };
/** While sessions are starting, the state is looked at again this often (a start that never came ends at 30 s). */
const STARTING_RECHECK_MS = 5000;

/** What a phone's state is compared by: equal, it isn't sent again. */
const stateKey = (st: RemoteState): string => JSON.stringify([st.projects, st.sessions, st.resumables]);

/** The newest lines of a screen whose message would be too large; whole lines only. */
function fitScreen(data: string): string {
  let d = data;
  while (Buffer.byteLength(JSON.stringify(d), 'utf8') > SNAPSHOT_MAX) {
    const cut = d.indexOf('\n', Math.floor(d.length / 4));
    d = cut === -1 ? d.slice(Math.floor(d.length / 2)) : d.slice(cut + 1);
  }
  return d;
}

/** Splits text into pieces of at most `n` characters, never between the halves of a surrogate pair. */
function chunks(text: string, n: number): string[] {
  const out: string[] = [];
  for (let at = 0; at < text.length;) {
    let end = Math.min(at + n, text.length);
    if (end < text.length && /[\udc00-\udfff]/.test(text[end]!)) end--;
    out.push(text.slice(at, end));
    at = end;
  }
  return out;
}

interface SessionHost {
  listed(id: string): boolean;
  rootOf(projectId: string): string | null;
  /** A listed project's layout, as its window last showed it (null: never shown with iPhone access on). */
  layoutOf(root: string): RemoteLayout | null;
  scheduleState(): void;
  statusChanged(): void;
  outMs: number;
}

/** One connected phone: the terminals it watches through TerminalHub, and what it is sent. */
class PhoneSession implements RemoteViewer {
  readonly key: number;
  readonly attached = new Set<string>();
  /** Attach requests waiting for their terminal's screen, by terminal. */
  private readonly waiting = new Map<string, number[]>();
  /** Output held back (coalescing, or a backlog at the relay link), by terminal, in arrival order. */
  private readonly held = new Map<string, string>();
  private heldSize = 0;
  private readonly sentAt = new Map<string, number>();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private lastState = '';
  private lastUsage = '';
  /** Each listed project's layout as this phone last got it (JSON). */
  private readonly lastLayouts = new Map<string, string>();
  private lastSize: Size | null = null;

  constructor(readonly c: SecureChannel, readonly deviceId: string, private readonly host: SessionHost, private readonly terms: RemoteTerminals) {
    this.key = terms.addRemoteViewer(this);
  }

  send(msg: HostMessage): void {
    if (!this.c.send(msg)) return;
    if (this.heldSize + this.c.queuedBytes() > MAX_BACKLOG) this.c.close(CLOSE.overloaded);
  }

  sendState(json: string, st: RemoteState): void {
    if (json === this.lastState) return;
    this.lastState = json;
    this.send({ t: 'state', projects: st.projects, sessions: st.sessions, resumables: st.resumables });
  }

  /** Each listed project's layout, after the first state: the ones this phone hasn't got as they are now. */
  sendLayouts(st: RemoteState): void {
    if (!this.lastState) return;
    for (const p of st.projects) {
      const root = st.roots.get(p.id);
      const layout = root === undefined ? null : this.host.layoutOf(root);
      const key = JSON.stringify(layout);
      if (this.lastLayouts.get(p.id) === key) continue;
      this.lastLayouts.set(p.id, key);
      this.send({ t: 'layout', project: p.id, layout });
    }
  }

  /** The accounts' limits, after the first state; only when what the phone would show changed. */
  sendUsage(key: string, accounts: RemoteAccount[]): void {
    if (!this.lastState || key === this.lastUsage) return;
    this.lastUsage = key;
    this.send({ t: 'usage', accounts });
  }

  private error(rid: number, code: 'not-found' | 'invalid' | 'busy' | 'failed', message: string): void {
    this.send({ t: 'error', rid, code, message });
  }

  handle(m: DeviceMessage): void {
    switch (m.t) {
      case 'attach': {
        if (!this.host.listed(m.id)) { this.error(m.rid, 'not-found', 'This terminal is not on this computer any more.'); return; }
        this.lastSize = { cols: m.cols, rows: m.rows };
        this.waiting.set(m.id, [...(this.waiting.get(m.id) ?? []), m.rid]);
        this.terms.remoteAttach(this.key, m.id, m.cols, m.rows).catch(() => {
          const rids = this.waiting.get(m.id) ?? [];
          this.waiting.delete(m.id);
          for (const rid of rids) this.error(rid, 'failed', 'The terminal could not be opened.');
        });
        return;
      }
      case 'detach':
        this.waiting.delete(m.id);
        this.forget(m.id);
        this.terms.remoteDetach(this.key, m.id);
        this.host.statusChanged();
        return;
      case 'input':
        if (!this.terms.remoteInput(this.key, m.id, m.data)) this.error(0, 'invalid', 'Open this terminal before typing into it.');
        return;
      case 'resize':
        this.lastSize = { cols: m.cols, rows: m.rows };
        if (!this.terms.remoteResize(this.key, m.id, m.cols, m.rows)) this.error(0, 'invalid', 'Open this terminal before resizing it.');
        return;
      case 'create': {
        const root = this.host.rootOf(m.project);
        if (!root) { this.error(m.rid, 'not-found', 'This project is not on this computer any more.'); return; }
        const size = this.lastSize ?? DEFAULT_SIZE;
        this.terms.createRemoteSession({ project: root, kind: m.kind, cols: size.cols, rows: size.rows }).then(
          (info) => { this.send({ t: 'created', rid: m.rid, id: info.id }); this.host.scheduleState(); },
          () => this.error(m.rid, 'failed', m.kind === 'claude' ? 'The session could not be started.' : 'The terminal could not be started.')
        );
      }
    }
  }

  // ── RemoteViewer: what TerminalHub sends this phone ──

  snapshot(id: string, data: string, size: Size | null): void {
    this.attached.add(id);
    // The screen covers what was held back for this terminal.
    this.drop(id);
    const s = size ?? this.lastSize ?? DEFAULT_SIZE;
    this.send({ t: 'snapshot', id, cols: s.cols, rows: s.rows, data: fitScreen(data) });
    for (const rid of this.waiting.get(id) ?? []) this.send({ t: 'ok', rid });
    this.waiting.delete(id);
    this.host.statusChanged();
  }

  data(id: string, data: string): void {
    if (!this.attached.has(id)) return;
    const now = Date.now();
    const before = this.held.get(id);
    if (before === undefined && now - (this.sentAt.get(id) ?? 0) >= this.host.outMs && this.c.queuedBytes() === 0) {
      this.sendOut(id, data, now);
      return;
    }
    this.held.set(id, (before ?? '') + data);
    this.heldSize += data.length;
    if (this.heldSize + this.c.queuedBytes() > MAX_BACKLOG) { this.c.close(CLOSE.overloaded); return; }
    this.armFlush();
  }

  size(id: string, cols: number, rows: number): void {
    if (!this.attached.has(id)) return;
    this.flushOne(id);
    this.send({ t: 'size', id, cols, rows });
  }

  exit(id: string): void {
    const rids = this.waiting.get(id) ?? [];
    this.waiting.delete(id);
    for (const rid of rids) this.error(rid, 'not-found', 'The terminal ended.');
    if (!this.attached.has(id)) return;
    this.flushOne(id);
    this.attached.delete(id);
    this.send({ t: 'exit', id });
    this.host.statusChanged();
  }

  /** The relay link took everything queued for this phone: what was held back can go. */
  drained(): void { this.flushDue(); }

  dispose(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    this.held.clear();
    this.terms.removeRemoteViewer(this.key);
  }

  private sendOut(id: string, data: string, now: number): void {
    this.sentAt.set(id, now);
    for (const part of chunks(data, OUT_CHUNK)) this.send({ t: 'out', id, data: part });
  }

  private flushOne(id: string): void {
    const d = this.held.get(id);
    if (d === undefined) return;
    this.held.delete(id);
    this.heldSize -= d.length;
    this.sendOut(id, d, Date.now());
  }

  private drop(id: string): void {
    const d = this.held.get(id);
    if (d === undefined) return;
    this.held.delete(id);
    this.heldSize -= d.length;
  }

  private forget(id: string): void {
    this.drop(id);
    this.attached.delete(id);
    this.sentAt.delete(id);
  }

  /** Each terminal whose time came gets its held output in one message; the rest wait for theirs. */
  private flushDue(): void {
    if (this.c.queuedBytes() > 0) return;
    const now = Date.now();
    for (const id of [...this.held.keys()]) if (now - (this.sentAt.get(id) ?? 0) >= this.host.outMs) this.flushOne(id);
    if (this.held.size > 0) this.armFlush();
  }

  private armFlush(): void {
    if (this.flushTimer || this.held.size === 0) return;
    const now = Date.now();
    let due = Infinity;
    for (const id of this.held.keys()) due = Math.min(due, (this.sentAt.get(id) ?? 0) + this.host.outMs);
    this.flushTimer = setTimeout(() => { this.flushTimer = null; this.flushDue(); }, Math.max(1, due - now));
    this.flushTimer.unref?.();
  }
}

export class RemoteHub {
  private readonly identities: IdentityStore;
  readonly devices: DeviceStore;
  private readonly layouts: LayoutStore;
  private identity: RemoteIdentity | null = null;
  private link: RelayLink | null = null;
  private linkFor = '';
  private relay: { state: RemoteRelayState; message?: string } = { state: 'offline' };
  private readonly channels = new Map<number, SecureChannel>();
  private readonly sessions = new Map<number, PhoneSession>();
  /** Channels admitted, by channel, with their device's id, until opened. */
  private readonly admitted = new Map<number, string>();
  private pairing: Pairing | null = null;
  /** The pairing channel waiting for the user's answer. */
  private asking: SecureChannel | null = null;
  private stateTimer: ReturnType<typeof setTimeout> | null = null;
  private stateAt = 0;
  private usageTimer: ReturnType<typeof setTimeout> | null = null;
  private usageAt = 0;
  private readonly usageMs: number;
  private statusKey = '';
  /** Whether encryption is available, asked only once remote access is on or Settings asks (it may touch the Keychain). */
  private availableKnown: boolean | null = null;
  private readonly offShown: () => void;
  private readonly stateMs: number;
  private readonly host: SessionHost;

  constructor(private readonly d: RemoteHubDeps) {
    this.identities = new IdentityStore(d.secrets);
    this.devices = new DeviceStore(d.home);
    this.layouts = new LayoutStore(d.home);
    this.stateMs = d.timing?.stateMs ?? STATE_MS;
    this.usageMs = d.timing?.usageMs ?? USAGE_MS;
    this.offShown = d.terminals.onShown(() => this.scheduleState());
    this.host = {
      listed: (id) => this.d.terminals.allTerminals().some((t) => t.id === id),
      rootOf: (pid) => this.computeState().roots.get(pid) ?? null,
      layoutOf: (root) => this.layouts.get(root),
      scheduleState: () => this.scheduleState(),
      statusChanged: () => this.statusChanged(),
      outMs: d.timing?.outMs ?? OUT_MS
    };
  }

  start(): void { this.apply(); }

  /** Settings changed: remote access, the relay, the project colors, the accounts, the ports shown. */
  settingsChanged(): void {
    this.apply();
    this.scheduleState();
    this.scheduleUsage();
  }

  /** Something a row shows that TerminalHub doesn't know changed: a port, a pull request. */
  stateChanged(): void { this.scheduleState(); }

  /** The status line reported the accounts' limits again. */
  usageChanged(): void { this.scheduleUsage(); }

  /**
   * A project's main window shows its sidebar arranged this way now: kept (and saved) while iPhone access is on, and
   * sent to the phones when it changed.
   */
  layoutChanged(root: string, layout: RemoteLayout): void {
    if (!this.d.settings().remoteAccess) return;
    if (this.layouts.set(root, layout)) this.scheduleState();
  }

  /** A project's layout as phones get it (null: never shown with iPhone access on). */
  layoutOf(root: string): RemoteLayout | null { return this.layouts.get(root); }

  /** A project window opened or closed, or the recent projects changed. */
  projectsChanged(): void { this.scheduleState(); }

  private available(): boolean {
    this.availableKnown ??= this.identities.available();
    return this.availableKnown;
  }

  private apply(): void {
    if (!this.d.settings().remoteAccess) { this.shutDown('disabled'); return; }
    this.availableKnown = null;
    if (!this.available()) {
      this.shutDown('disabled');
      this.setRelay('error', 'This computer can\'t keep the keys for iPhone access encrypted.');
      return;
    }
    if (!this.identity) {
      try { this.identity = this.identities.ensure(); } catch {
        this.shutDown('disabled');
        this.setRelay('error', 'Atelier can\'t read its keys for iPhone access. Reset iPhone access to start again.');
        return;
      }
    }
    const base = relayBase(this.d.relayUrl());
    const want = `${base} ${this.identity.roomId}`;
    if (this.link && this.linkFor === want) return;
    // Another relay (or identity): the phones on this one are dropped with it.
    if (this.link) this.shutDown('disabled', { keepState: true });
    if (!base) { this.setRelay('error', 'The relay address is not one Atelier can use.'); return; }
    const id = this.identity;
    const link: RelayLink = new RelayLink({
      base, roomId: id.roomId, secret: id.roomSecret,
      onState: (state, message) => { if (this.link === link) this.setRelay(state, message); },
      onOpen: (ch, kind, lookup) => { if (this.link === link) this.openChannel(link, id, ch, kind, lookup); },
      onClosed: (ch) => { if (this.link === link) this.channels.get(ch)?.relayClosed(); },
      onData: (ch, payload) => { if (this.link === link) this.channels.get(ch)?.receive(payload); },
      onDrain: (ch) => { if (this.link === link) this.sessions.get(ch)?.drained(); },
      ...this.d.link
    });
    this.link = link;
    this.linkFor = want;
    link.start();
  }

  /**
   * Every channel ends (open ones with `bye`, a phone waiting for Allow with `denied`), pairing stops, and the relay
   * connection closes once what was queued has left (at most `flushMs`).
   */
  private shutDown(reason: ByeReason, o: { keepState?: boolean; flushMs?: number } = {}): Promise<void> {
    // Pairing first: a phone waiting for Allow is answered "disabled", not taken for one that left.
    if (this.pairing) this.stopPairing();
    for (const c of [...this.channels.values()]) {
      if (c.state === 'open') c.bye(reason);
      else if (c.state === 'admitting') c.deny('disabled');
      else c.close(CLOSE.normal);
    }
    const link = this.link;
    this.link = null;
    this.linkFor = '';
    if (!o.keepState) this.setRelay('offline');
    return link ? link.stop(o.flushMs ?? 300) : Promise.resolve();
  }

  /** A phone is connected now. */
  hasPhones(): boolean { return this.sessions.size > 0; }

  /** The app quits: every phone is told, then the connection closes. */
  async dispose(): Promise<void> {
    this.offShown();
    if (this.stateTimer) { clearTimeout(this.stateTimer); this.stateTimer = null; }
    if (this.usageTimer) { clearTimeout(this.usageTimer); this.usageTimer = null; }
    if (this.startingTimer) { clearTimeout(this.startingTimer); this.startingTimer = null; }
    await this.shutDown('quitting', { flushMs: 500 });
  }

  // ── Channels ──

  private openChannel(link: RelayLink, id: RemoteIdentity, ch: number, kind: ChannelKind, lookup?: string): void {
    this.channels.get(ch)?.relayClosed();
    const c = new SecureChannel(ch, kind, {
      link, host: id.host, roomId: id.roomId,
      hello: { name: this.d.host.name, app: this.d.host.app, platform: this.d.host.platform },
      pairCodes: () => this.pairing?.codes() ?? [],
      pairFailed: () => this.pairing?.failed(),
      admit: (x) => this.admit(x),
      opened: (x) => this.opened(x),
      message: (x, m) => this.sessions.get(x.ch)?.handle(m),
      closed: (x) => this.channelClosed(x)
    }, lookup);
    this.channels.set(ch, c);
  }

  private async admit(c: SecureChannel): Promise<Admission> {
    const key = c.deviceKey!;
    const hello = c.hello!;
    if (c.kind === 'device') {
      const known = this.devices.byKey(key);
      if (!known) return { ok: false, reason: 'unknown-device', code: CLOSE.unknownDevice };
      this.admitted.set(c.ch, known.id);
      return { ok: true };
    }
    const pairing = this.pairing;
    if (!pairing) return { ok: false, reason: 'expired', code: CLOSE.normal };
    this.asking = c;
    const decision = await pairing.ask({ name: hello.name, model: hello.model });
    if (this.asking === c) this.asking = null;
    if (decision !== 'allow') return { ok: false, reason: decision, code: CLOSE.normal };
    if (c.state !== 'admitting') return { ok: false, reason: 'expired', code: CLOSE.normal };
    const device = this.devices.add({ name: hello.name, model: hello.model, key });
    pairing.finish();
    if (this.pairing === pairing) this.pairing = null;
    this.admitted.set(c.ch, device.id);
    this.d.emitPairing({ kind: 'paired', device: this.info(device, new Map([[device.id, new Set()]])) });
    return { ok: true };
  }

  private opened(c: SecureChannel): void {
    const deviceId = this.admitted.get(c.ch);
    this.admitted.delete(c.ch);
    if (!deviceId || !this.identity) { c.close(CLOSE.normal); return; }
    const s = new PhoneSession(c, deviceId, this.host, this.d.terminals);
    this.sessions.set(c.ch, s);
    s.send({ t: 'welcome', host: { name: this.d.host.name, platform: this.d.host.platform }, ...(c.kind === 'pair' ? { room: this.identity.roomId } : {}) });
    const st = this.computeState();
    s.sendState(stateKey(st), st);
    s.sendLayouts(st);
    const u = this.computeUsage();
    s.sendUsage(u.key, u.accounts);
    this.devices.seen(deviceId);
    this.statusChanged();
  }

  private channelClosed(c: SecureChannel): void {
    if (this.channels.get(c.ch) === c) this.channels.delete(c.ch);
    this.admitted.delete(c.ch);
    if (this.asking === c) { this.asking = null; this.pairing?.cancel(); }
    const s = this.sessions.get(c.ch);
    if (s?.c === c) {
      this.sessions.delete(c.ch);
      s.dispose();
      this.devices.seen(s.deviceId);
    }
    this.statusChanged();
  }

  // ── State ──

  private computeState(): RemoteState {
    const s = this.d.settings();
    const p = this.d.projects();
    const terminals = this.d.terminals.allTerminals();
    const starting = this.d.terminals.startingIds();
    this.armStarting(starting);
    // Each project's ports and pull requests, asked once per state.
    const ports = new Map<string, PortsMap>();
    const prs = new Map<string, Record<string, PrEntry>>();
    const rootOf = new Map(terminals.map((t) => [t.id, t.projectRoot]));
    const of = <T>(cache: Map<string, T>, get: ((root: string) => T) | undefined, id: string): T | undefined => {
      const root = rootOf.get(id);
      if (!get || root === undefined) return undefined;
      if (!cache.has(root)) cache.set(root, get(root));
      return cache.get(root);
    };
    return remoteState({
      terminals, open: p.open, recent: p.recent, colors: s, now: Date.now(), starting,
      resumables: this.d.terminals.allResumables(), accounts: s.claudeAccounts, defaultDir: this.d.defaultDir(),
      ports: (id) => of(ports, this.d.ports, id)?.[id],
      pr: (id) => of(prs, this.d.prs, id)?.[id],
      ...(this.d.realOf ? { realOf: this.d.realOf } : {})
    });
  }

  private scheduleState(): void {
    if (this.sessions.size === 0 || this.stateTimer) return;
    const wait = Math.max(0, this.stateAt + this.stateMs - Date.now());
    this.stateTimer = setTimeout(() => {
      this.stateTimer = null;
      this.stateAt = Date.now();
      const st = this.computeState();
      const json = stateKey(st);
      for (const s of this.sessions.values()) { s.sendState(json, st); s.sendLayouts(st); }
    }, wait);
    this.stateTimer.unref?.();
  }

  /** A session still starting reads as one for 30 s at most: the state goes again when that runs out. */
  private startingTimer: ReturnType<typeof setTimeout> | null = null;
  private startingKey = '';
  private armStarting(ids: ReadonlySet<string>): void {
    const key = [...ids].sort().join(',');
    if (key === this.startingKey) return;
    this.startingKey = key;
    if (this.startingTimer) { clearTimeout(this.startingTimer); this.startingTimer = null; }
    if (ids.size === 0) return;
    this.startingTimer = setTimeout(() => { this.startingTimer = null; this.startingKey = ''; this.scheduleState(); }, STARTING_RECHECK_MS);
    this.startingTimer.unref?.();
  }

  private computeUsage(): { key: string; accounts: RemoteAccount[] } {
    const accounts = remoteUsage({ usage: this.d.terminals.usageList(), accounts: this.d.settings().claudeAccounts, defaultDir: this.d.defaultDir(), now: Date.now() });
    // updatedAt alone moving changes nothing a phone shows.
    return { key: JSON.stringify(accounts.map(({ updatedAt: _u, ...rest }) => rest)), accounts };
  }

  private scheduleUsage(): void {
    if (this.sessions.size === 0 || this.usageTimer) return;
    const wait = Math.max(0, this.usageAt + this.usageMs - Date.now());
    this.usageTimer = setTimeout(() => {
      this.usageTimer = null;
      this.usageAt = Date.now();
      const u = this.computeUsage();
      for (const s of this.sessions.values()) s.sendUsage(u.key, u.accounts);
    }, wait);
    this.usageTimer.unref?.();
  }

  // ── What the windows get ──

  private setRelay(state: RemoteRelayState, message?: string): void {
    if (state === 'error' && message && message !== this.relay.message) this.d.log?.(`relay: ${message}`);
    this.relay = message ? { state, message } : { state };
    this.statusChanged();
  }

  private info(d: PairedDevice, live: Map<string, Set<string>>): RemoteDeviceInfo {
    const attached = live.get(d.id);
    return { id: d.id, name: d.name, model: d.model, pairedAt: d.pairedAt, lastSeenAt: d.lastSeenAt, connected: attached !== undefined, attached: [...(attached ?? [])] };
  }

  status(): RemoteStatus {
    const live = new Map<string, Set<string>>();
    for (const s of this.sessions.values()) {
      const set = live.get(s.deviceId) ?? new Set<string>();
      for (const id of s.attached) set.add(id);
      live.set(s.deviceId, set);
    }
    return {
      enabled: this.d.settings().remoteAccess,
      available: this.available(),
      relay: { ...this.relay },
      devices: this.devices.list().map((d) => this.info(d, live)),
      sized: this.d.terminals.remoteSized()
    };
  }

  /** Something the status shows may have changed: the windows get it when it did. */
  statusChanged(): void {
    // Off and never asked about: nothing to tell, and the Keychain stays untouched.
    if (this.availableKnown === null && !this.d.settings().remoteAccess) return;
    const st = this.status();
    const key = JSON.stringify(st);
    if (key === this.statusKey) return;
    this.statusKey = key;
    this.d.emitStatus(st);
  }

  // ── Pairing and devices (the windows' requests) ──

  async startPairing(): Promise<RemotePairingStart> {
    if (!this.d.settings().remoteAccess) return { ok: false, reason: 'disabled', message: 'Turn on access from iPhone first.' };
    const link = this.link;
    const id = this.identity;
    const base = relayBase(this.d.relayUrl());
    if (!link || !id || !base) return { ok: false, reason: 'unavailable', message: this.relay.message ?? 'iPhone access is unavailable right now.' };
    this.pairing ??= new Pairing({
      offer: (lookup, ttl) => this.link?.offer(lookup, ttl),
      withdraw: (lookup) => this.link?.withdraw(lookup),
      relay: base, hostKey: id.host.publicKey, hostName: this.d.host.name,
      emit: (e) => this.d.emitPairing(e),
      ...(this.d.timing?.decideMs ? { decideMs: this.d.timing.decideMs } : {}),
      ...(this.d.timing?.codeTtlMs ? { ttlMs: this.d.timing.codeTtlMs } : {})
    });
    try { return { ok: true, pairing: await this.pairing.current() }; } catch {
      return { ok: false, reason: 'failed', message: 'Atelier could not make a pairing code.' };
    }
  }

  /** The pairing sheet closed: the code goes; a phone waiting for an answer is told pairing is off. */
  stopPairing(): void {
    const p = this.pairing;
    if (!p) return;
    this.pairing = null;
    p.stop();
    this.d.emitPairing({ kind: 'stopped' });
  }

  decide(requestId: string, allow: boolean): boolean {
    return this.pairing?.decide(requestId, allow) ?? false;
  }

  /** Unpairs a phone: its connection ends at once (`bye revoked`). */
  removeDevice(id: string): boolean {
    for (const s of [...this.sessions.values()]) if (s.deviceId === id) s.c.bye('revoked');
    const removed = this.devices.remove(id);
    this.statusChanged();
    return removed;
  }

  /** A new identity (a new room and key): every phone is unpaired and must pair again. */
  reset(): void {
    for (const s of [...this.sessions.values()]) s.c.bye('revoked');
    void this.shutDown('revoked', { keepState: true });
    this.devices.clear();
    this.identities.reset();
    this.identity = null;
    this.apply();
    this.statusChanged();
  }
}
