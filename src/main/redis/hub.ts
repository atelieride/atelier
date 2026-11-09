// Redis view, main side: finds local instances and probes them, keeps one connection to each
// instance a window picked, polls INFO at the cadence of what is on screen, detects and counts queues, streams MONITOR
// only while Live shows, answers the renderer's reads, runs its writes (refused when Edits is Read-only) and tells
// about failed jobs. Every byte to Redis goes through client.ts's allowlist.
import { createHash, randomUUID } from 'node:crypto';
import { IPC } from '@shared/api';
import type { DockerContainer } from '@shared/docker';
import {
  infoOf, instanceTitle, parseInfo, serverOf, type ClientRow, type Endpoint, type InfoSample, type InstanceState, type KeyEntry, type RedisInfo,
  type KeyWriteOp, type RedisInstance, type RedisNote, type RedisWriteOp, type RedisSnapshot, type RedisStatus, type RedisValueReply, type RedisWatch, type SlowEntry, type ValuePage
} from '@shared/redis';
import { clientDisplayName, parseClientList, parseMonitorLine, trimMonitorLine, type MonitorLine } from '@shared/redis-monitor';
import { summarize, type JobInfo, type JobState, type QueueInfo, type QueueRef } from '@shared/redis-queues';
import type { Settings } from '@shared/settings';
import { Denied, NoAuth, NoPerm, RedisClient, Refused, Unknown, type ConnectOptions } from './client';
import { gatherCandidates, mentionsRedis, viewFor, type Candidate, type CandidateView } from './discover';
import { bullActions, detect, queueAdapter, type Read } from './queues';
import { text } from './resp';
import { readCounter, readValue, scanPage } from './values';
import { RedisWriter, type Preview, type UndoResult, type WriteOp, type WriteResult } from './writes';
import type { Picks } from './picks';

export interface HubWindow {
  id: number;
  send(channel: string, payload: unknown): void;
  isDestroyed(): boolean;
  once(event: 'destroyed', fn: () => void): void;
}

export type RedisSettings = Pick<Settings, 'showRedis' | 'redisInstances' | 'redisEdits' | 'redisMonitor' | 'redisQueues' | 'redisNotify' | 'redisScanKeys' | 'notifySound'>;

/** `has` (optional): whether a value is stored, without decrypting it (the Databases hub's hasPassword). */
export interface SecretsLike { read(id: string): string | null; write(id: string, value: string): void; remove(id: string): void; has?(id: string): boolean }

export interface RedisHubDeps {
  settings(): RedisSettings;
  focused(): boolean;
  /** Tests: the common ports to probe instead of 6379–6382, and the only ones ever contacted. */
  testPorts?: number[];
  /** Tests: the only folder a socket instance may live in. */
  testSocketDir?: string;
  /** A project's .env files merged (inside the project). */
  readEnv(root: string): Record<string, string>;
  /** A project's root compose files' text. */
  readCompose(root: string): string[];
  dockerContainers(): DockerContainer[];
  /** A Redis container's own password (REDIS_PASSWORD, --requirepass), from Docker's inspect. */
  dockerSecret(containerId: string): Promise<string | null>;
  /** Container IPs → names (clients coming from containers). */
  dockerIps(): Promise<Map<string, string>>;
  terminalPorts(): { project: string; port: number; name: string; title: string }[];
  /** For a Redis on this host port: client local port → the terminal whose process holds that connection. */
  clientOrigins(redisPort: number): Promise<Map<number, string>>;
  secrets: SecretsLike | null;
  picks: Picks;
  brewInstalled(): boolean;
  banner(b: { title: string; body: string; silent: boolean; root: string; queueId: string }): void;
  timing?: Partial<typeof TIMING>;
}

/** A write as the renderer asks for it: a queue named by its id. */
export type WriteOpIn = RedisWriteOp;

export const REDIS_CHANNELS = { snapshot: IPC.evRedis, status: IPC.evRedisStatus, monitor: IPC.evRedisMonitor, note: IPC.evRedisNote } as const;

export const TIMING = {
  tickMs: 2000, probeMs: 30_000, infoFastMs: 2000, infoSlowMs: 10_000, queuesMs: 10_000, detectMs: 30_000,
  monitorFlushMs: 100, coalesceMs: 5 * 60_000, samplesMs: 10 * 60_000, connectMs: 500, commandMs: 5000
};

const COMMON_PORTS = [6379, 6380, 6381, 6382];

interface Cred { user?: string; password: string; from: 'env' | 'docker' | 'keychain' }

interface QueueState { refs: QueueRef[]; infos: QueueInfo[] | null; lastDetect: number; lastCounts: number; baseline: Map<string, number>; lastFailed: Map<string, number>; noted: Map<string, number>; busy: boolean; detecting: boolean }

interface Inst {
  cand: Candidate;
  state: InstanceState;
  why?: 'tls' | 'not-redis';
  server: RedisInstance['server'];
  brew: boolean;
  cred: Cred | null;
  client: RedisClient | null;
  connecting: Promise<RedisClient | null> | null;
  info: RedisInfo | null;
  samples: InfoSample[];
  lastInfo: number;
  infoBusy: boolean;
  denied: Set<string>;
  queues: Map<number, QueueState>;
  monitor: { client: RedisClient | null; pending: MonitorLine[]; timer: NodeJS.Timeout | null; starting: boolean } | null;
  own: Set<string>;
  lastCmd: Map<string, string>;
  writer: RedisWriter;
  slowThreshold: number | null | undefined;
  dir: string | null | undefined;
}

interface Win { wc: HubWindow; root: string; watch: RedisWatch; sentSnap: string; sentStatus: string }

const secretId = (key: string) => `redis-${createHash('sha1').update(key).digest('hex').slice(0, 20)}`;
const toEndpoint = (e: Endpoint) => (e.kind === 'tcp' ? { kind: 'tcp' as const, port: e.port } : { kind: 'unix' as const, path: e.path });

export class RedisHub {
  private windows = new Map<number, Win>();
  private insts = new Map<string, Inst>();
  private timer: NodeJS.Timeout | null = null;
  private lastProbe = 0;
  private probing = false;
  private probeAgain = false;
  private probed = false;
  private t: typeof TIMING;
  private changedTimer: NodeJS.Timeout | null = null;

  constructor(private deps: RedisHubDeps) {
    this.t = { ...TIMING, ...deps.timing };
  }

  // —— windows ——

  open(root: string, wc: HubWindow): void {
    this.windows.set(wc.id, { wc, root, watch: { db: 0, sidebar: false, queues: false, overview: false, live: false }, sentSnap: '', sentStatus: '' });
    wc.once('destroyed', () => this.closeWindow(wc.id));
    if (!this.timer) {
      this.timer = setInterval(() => this.tick(), this.t.tickMs);
      this.timer.unref?.();
    }
    void this.probe();
  }

  private closeWindow(id: number): void {
    this.windows.delete(id);
    if (!this.windows.size) this.dispose();
    else this.tick();
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.changedTimer) clearTimeout(this.changedTimer);
    this.changedTimer = null;
    for (const i of this.insts.values()) this.disconnect(i);
    this.insts.clear();
  }

  onFocus(): void {
    if (Date.now() - this.lastProbe > 2000) void this.probe();
  }

  /** Docker containers or terminals' ports changed: a server may have started or stopped. */
  sourcesChanged(): void {
    if (this.changedTimer || !this.windows.size) return;
    this.changedTimer = setTimeout(() => { this.changedTimer = null; void this.probe(); }, 1000);
    this.changedTimer.unref?.();
  }

  settingsChanged(): void {
    if (this.deps.settings().showRedis === 'never') { for (const i of this.insts.values()) this.disconnect(i); this.insts.clear(); this.broadcast(); return; }
    void this.probe();
    this.tick();
  }

  watch(wcId: number, w: RedisWatch): void {
    const win = this.windows.get(wcId);
    if (!win) return;
    win.watch = w;
    this.tick();
  }

  // —— probing ——

  private candidates(): Candidate[] {
    const s = this.deps.settings();
    const projects = [...new Set([...this.windows.values()].map((w) => w.root))];
    const all = gatherCandidates({
      projects, env: (r) => this.deps.readEnv(r), containers: this.deps.dockerContainers(), terminals: this.deps.terminalPorts(),
      ports: this.deps.testPorts ?? COMMON_PORTS, custom: s.redisInstances
    });
    // Tests: only the test ports (a fake Docker Redis on 6379 must never reach the real one on the Mac running them).
    const test = this.deps.testPorts;
    return test ? all.filter((c) => (c.endpoint.kind === 'tcp' ? test.includes(c.endpoint.port) : !!this.deps.testSocketDir && c.endpoint.path.startsWith(this.deps.testSocketDir))) : all;
  }

  async probe(): Promise<void> {
    if (this.deps.settings().showRedis === 'never') return;
    if (this.probing) { this.probeAgain = true; return; }
    this.probing = true;
    this.lastProbe = Date.now();
    try {
      const cands = this.candidates();
      const keys = new Set(cands.map((c) => c.key));
      for (const [k, i] of this.insts) if (!keys.has(k)) { this.disconnect(i); this.insts.delete(k); }
      await Promise.all(cands.map(async (c) => {
        const i = this.insts.get(c.key) ?? this.newInst(c);
        i.cand = c;
        this.insts.set(c.key, i);
        // A live connection is its own heartbeat (INFO polls): no probe.
        if (i.client && !i.client.closed) return;
        await this.probeOne(i);
      }));
      for (const [k, i] of this.insts) if (i.state === 'stopped' && !this.expected(i.cand)) this.insts.delete(k);
    } finally {
      this.probing = false;
      this.probed = true;
      this.broadcast();
      this.tick();
      if (this.probeAgain) { this.probeAgain = false; void this.probe(); }
    }
  }

  private newInst(c: Candidate): Inst {
    const i: Inst = {
      cand: c, state: 'stopped', server: null, brew: false, cred: null, client: null, connecting: null, info: null, samples: [], lastInfo: 0, infoBusy: false,
      denied: new Set(), queues: new Map(), monitor: null, own: new Set(), lastCmd: new Map(), writer: null as unknown as RedisWriter, slowThreshold: undefined, dir: undefined
    };
    i.writer = new RedisWriter(() => (i.client && !i.client.closed ? i.client : null));
    return i;
  }

  /** Sources that promise a server (the project's config, a container, a custom one): kept as "not running". */
  private expected(c: Candidate): boolean {
    return c.sources.some((s) => s === 'env' || s === 'custom' || s === 'docker') || !!c.container;
  }

  private connect(i: Inst, cred: Cred | null, name: string, onClose?: () => void): Promise<RedisClient> {
    const o: ConnectOptions = { name, connectTimeoutMs: this.t.connectMs, commandTimeoutMs: this.t.commandMs, ...(onClose ? { onClose } : {}), ...(cred ? { auth: { ...(cred.user ? { user: cred.user } : {}), password: cred.password } } : {}) };
    return RedisClient.connect(toEndpoint(i.cand.endpoint), o);
  }

  private async creds(i: Inst): Promise<Cred[]> {
    // The one that worked this run first (also when the Keychain couldn't keep it).
    const out: Cred[] = i.cred ? [i.cred] : [];
    let stored: string | null = null;
    try { stored = this.deps.secrets?.read(secretId(i.cand.key)) ?? null; } catch { stored = null; }
    if (stored) { try { const p = JSON.parse(stored) as { user?: string; password: string }; if (typeof p.password === 'string') out.push({ ...(p.user ? { user: p.user } : {}), password: p.password, from: 'keychain' }); } catch { /* unreadable */ } }
    for (const e of i.cand.envs) if (e.password !== undefined) out.push({ ...(e.user ? { user: e.user } : {}), password: e.password, from: 'env' });
    if (i.cand.container) { const p = await this.deps.dockerSecret(i.cand.container.id).catch(() => null); if (p) out.push({ password: p, from: 'docker' }); }
    return out;
  }

  private async probeOne(i: Inst): Promise<void> {
    if (i.cand.tls) { i.state = 'unsupported'; i.why = 'tls'; return; }
    let c: RedisClient | null = null;
    try {
      c = await this.connect(i, null, 'atelier');
      try {
        await c.call(['PING']);
        // No password needed now; one kept from this run is dropped.
        i.cred = null;
      } catch (e) {
        if (!(e instanceof NoAuth)) throw e;
        c.close();
        c = null;
        for (const cred of await this.creds(i)) {
          try { c = await this.connect(i, cred, 'atelier'); await c.call(['PING']); i.cred = cred; break; } catch { c?.close(); c = null; }
        }
        if (!c) { i.state = 'auth'; i.server = null; return; }
      }
      const server = await c.call(['INFO', 'server']).then((r) => parseInfo(text(r)), () => ({} as Record<string, string>));
      const cluster = await c.call(['INFO', 'cluster']).then((r) => parseInfo(text(r)), () => ({} as Record<string, string>));
      const all = { ...server, ...cluster };
      if (!all.redis_version && !all.valkey_version && !all.dragonfly_version) { i.state = 'unsupported'; i.why = 'not-redis'; return; }
      const sv = serverOf(all);
      const info = infoOf(all);
      i.server = { name: sv.name, version: sv.version, mode: info.mode };
      i.brew = info.brew;
      i.state = 'running';
      delete i.why;
    } catch (e) {
      i.server = null;
      if (e instanceof Refused) i.state = 'stopped';
      else if (e instanceof Denied) i.state = 'denied';
      else if (e instanceof NoPerm) i.state = 'running';
      else { i.state = this.expected(i.cand) ? 'unsupported' : 'stopped'; if (i.state === 'unsupported') i.why = 'not-redis'; }
    } finally {
      c?.close();
    }
  }

  // —— connections of picked instances ——

  private pickOf(w: Win): Inst | null {
    const view = viewFor([...this.insts.values()].map((i) => i.cand), w.root);
    const picked = this.deps.picks.get(w.root);
    const key = view.find((v) => v.key === picked)?.key ?? view.find((v) => this.insts.get(v.key)?.state === 'running')?.key ?? view[0]?.key;
    return key ? this.insts.get(key) ?? null : null;
  }

  private ensureClient(i: Inst): Promise<RedisClient | null> {
    if (i.client && !i.client.closed) return Promise.resolve(i.client);
    if (i.state !== 'running') return Promise.resolve(null);
    if (i.connecting) return i.connecting;
    i.connecting = this.connect(i, i.cred, 'atelier', () => this.lost(i)).then((c) => {
      // The last window closed while it was connecting: nothing would ever close it.
      if (!this.windows.size || !this.insts.has(i.cand.key)) { c.close(); return null; }
      i.client = c;
      return c;
    }, () => { void this.probe(); return null; }).finally(() => { i.connecting = null; });
    return i.connecting;
  }

  /** The server went away: probed again at once, the view says so. */
  private lost(i: Inst): void {
    i.client = null;
    this.stopMonitor(i);
    void this.probe();
  }

  private disconnect(i: Inst): void {
    this.stopMonitor(i);
    const c = i.client;
    i.client = null;
    c?.close();
  }

  private async clientOf(wcId: number): Promise<{ i: Inst; c: RedisClient; w: Win }> {
    const w = this.windows.get(wcId);
    const i = w ? this.pickOf(w) : null;
    const c = i ? await this.ensureClient(i) : null;
    if (!w || !i || !c) throw new Error('Redis is not connected');
    return { i, c, w };
  }

  // —— the loop ——

  private tick(): void {
    const s = this.deps.settings();
    if (s.showRedis === 'never' || !this.windows.size) return;
    const now = Date.now();
    const focused = this.deps.focused();
    if (focused && now - this.lastProbe >= this.t.probeMs) void this.probe();
    const picked = new Map<Inst, Win[]>();
    for (const w of this.windows.values()) { const i = this.pickOf(w); if (i) picked.set(i, [...(picked.get(i) ?? []), w]); }
    for (const i of this.insts.values()) if (!picked.has(i) && i.client) this.disconnect(i);
    for (const [i, wins] of picked) {
      if (i.state !== 'running') continue;
      void this.ensureClient(i).then((c) => {
        if (!c) return;
        const fast = focused && wins.some((w) => w.watch.overview || w.watch.live);
        if (!i.infoBusy && (fast ? now - i.lastInfo >= this.t.infoFastMs - 50 : focused && now - i.lastInfo >= this.t.infoSlowMs - 50)) void this.pollInfo(i);
        if (s.redisQueues) {
          for (const db of new Set(wins.map((w) => w.watch.db))) {
            const qs = this.queueState(i, db);
            if (!qs.detecting && (focused || s.redisNotify) && now - qs.lastDetect >= this.t.detectMs) void this.detectQueues(i, db);
            const shown = focused && wins.some((w) => w.watch.db === db && (w.watch.sidebar || w.watch.queues));
            if (!qs.busy && qs.refs.length && (shown || s.redisNotify) && now - qs.lastCounts >= this.t.queuesMs - 50) void this.countQueues(i, db);
          }
        }
        const wantMonitor = s.redisMonitor && focused && wins.some((w) => w.watch.live) && !i.denied.has('monitor');
        if (wantMonitor) void this.startMonitor(i); else this.stopMonitor(i);
      });
    }
    this.broadcast();
  }

  private async pollInfo(i: Inst): Promise<void> {
    const c = i.client;
    if (!c) return;
    i.infoBusy = true;
    try {
      const r = await c.call(['INFO']);
      const info = infoOf(parseInfo(text(r)));
      const now = Date.now();
      i.info = info;
      i.server = { name: info.name, version: info.version, mode: info.mode };
      i.lastInfo = now;
      i.samples.push({ at: now, usedMemory: info.usedMemory, ops: info.ops, hits: info.hits, misses: info.misses, expired: info.expired, evicted: info.evicted });
      while (i.samples.length && now - i.samples[0]!.at > this.t.samplesMs) i.samples.shift();
      i.denied.delete('info');
      if (i.dir === undefined) {
        try { const d = await c.call(['CONFIG', 'GET', 'dir']); i.dir = text((Array.isArray(d) ? d : [])[1] ?? null) || null; } catch { i.dir = null; }
      }
    } catch (e) {
      if (e instanceof NoPerm || e instanceof Unknown) { i.denied.add('info'); i.lastInfo = Date.now(); }
    } finally {
      i.infoBusy = false;
      this.broadcast();
    }
  }

  // —— queues ——

  private queueState(i: Inst, db: number): QueueState {
    let q = i.queues.get(db);
    if (!q) { q = { refs: [], infos: null, lastDetect: 0, lastCounts: 0, baseline: new Map(), lastFailed: new Map(), noted: new Map(), busy: false, detecting: false }; i.queues.set(db, q); }
    return q;
  }

  private reader(c: RedisClient, db: number): Read { return (cmds) => c.pipeline(cmds, db, 20_000); }

  private async detectQueues(i: Inst, db: number): Promise<void> {
    const c = i.client;
    const qs = this.queueState(i, db);
    if (!c) return;
    qs.detecting = true;
    qs.lastDetect = Date.now();
    try {
      qs.refs = await detect(this.reader(c, db), 20_000);
      if (!qs.refs.length) qs.infos = [];
      else void this.countQueues(i, db);
    } catch { /* kept the last detection */ } finally { qs.detecting = false; this.broadcast(); }
  }

  private async clientNames(c: RedisClient, i: Inst): Promise<string[] | null> {
    try {
      const list = parseClientList(text(await c.call(['CLIENT', 'LIST'])));
      i.own = new Set(list.filter((x) => x.name.startsWith('atelier')).map((x) => x.addr));
      const live = new Set(list.map((x) => x.addr));
      for (const a of i.lastCmd.keys()) if (!live.has(a)) i.lastCmd.delete(a);
      i.denied.delete('clients');
      return list.map((x) => x.name);
    } catch (e) {
      if (e instanceof NoPerm || e instanceof Unknown) i.denied.add('clients');
      return null;
    }
  }

  private async countQueues(i: Inst, db: number): Promise<void> {
    const c = i.client;
    const qs = this.queueState(i, db);
    if (!c || qs.busy) return;
    qs.busy = true;
    qs.lastCounts = Date.now();
    try {
      const read = this.reader(c, db);
      const names = qs.refs.some((r) => r.lib === 'bullmq') ? await this.clientNames(c, i) : null;
      const now = Date.now();
      const infos: QueueInfo[] = [];
      for (const r of qs.refs) {
        const a = queueAdapter(r.lib);
        try {
          const [counts, workers, done] = await Promise.all([a.counts(r, read), a.workers(r, read, names), a.done(r, read, now)]);
          infos.push({ ...r, counts, workers, done, actions: bullActions(r) || r.lib === 'sidekiq' });
        } catch (e) {
          infos.push({ ...r, counts: { waiting: 0, active: null, delayed: null, failed: null, paused: false }, workers: null, done: null, actions: false, error: (e as Error).message.slice(0, 120) });
        }
      }
      for (const q of infos) {
        const failed = q.counts.failed ?? 0;
        const base = qs.baseline.get(q.id);
        qs.baseline.set(q.id, base === undefined ? failed : Math.min(base, failed));
        const last = qs.lastFailed.get(q.id);
        if (last !== undefined && failed > last && this.deps.settings().redisNotify) void this.notify(i, db, q);
        qs.lastFailed.set(q.id, failed);
      }
      qs.infos = infos;
    } finally {
      qs.busy = false;
      this.broadcast();
    }
  }

  private async notify(i: Inst, db: number, q: QueueInfo): Promise<void> {
    const now = Date.now();
    const id = `${i.cand.key}|${q.id}`;
    const qs = this.queueState(i, db);
    if (now - (qs.noted.get(id) ?? -Infinity) < this.t.coalesceMs) return;
    qs.noted.set(id, now);
    const c = i.client;
    if (!c) return;
    const job = (await queueAdapter(q.lib).jobs(q, this.reader(c, db), 'failed', 0, 1).catch(() => []))[0];
    const note: RedisNote = { id: randomUUID(), at: now, instance: i.cand.key, queue: { id: q.id, name: q.name, lib: q.lib }, job: { id: job?.id ?? '', name: job?.name ?? 'job', reason: (job?.reason ?? '').slice(0, 200) } };
    const wins = [...this.windows.values()].filter((w) => this.pickOf(w) === i && !w.wc.isDestroyed());
    for (const w of wins) w.wc.send(REDIS_CHANNELS.note, note);
    if (this.deps.focused() || !wins.length) return;
    this.deps.banner({ title: `${q.name}: a job failed`, body: note.job.reason || note.job.name, silent: !this.deps.settings().notifySound, root: wins[0]!.root, queueId: q.id });
  }

  // —— monitor ——

  private async startMonitor(i: Inst): Promise<void> {
    if (i.monitor) return;
    i.monitor = { client: null, pending: [], timer: null, starting: true };
    const m = i.monitor;
    try {
      if (i.client) await this.clientNames(i.client, i);
      const c = await RedisClient.connect(toEndpoint(i.cand.endpoint), {
        name: 'atelier-monitor', connectTimeoutMs: this.t.connectMs, maxReply: 4 * 1024 * 1024, onClose: () => { if (i.monitor === m) i.monitor = null; },
        ...(i.cred ? { auth: { ...(i.cred.user ? { user: i.cred.user } : {}), password: i.cred.password } } : {})
      });
      if (i.monitor !== m) { c.close(); return; }
      m.client = c;
      await c.monitor((line) => {
        const l = parseMonitorLine(line);
        if (!l || i.own.has(l.addr) || l.addr === i.client?.localAddr || l.addr === c.localAddr) return;
        if (i.lastCmd.size < 1000 || i.lastCmd.has(l.addr)) i.lastCmd.set(l.addr, [l.cmd, ...l.args.slice(0, 3)].join(' ').slice(0, 160));
        m.pending.push(trimMonitorLine(l));
        // A burst between two flushes: the newest lines win.
        if (m.pending.length > 2000) m.pending.splice(0, m.pending.length - 2000);
        if (!m.timer) m.timer = setTimeout(() => this.flushMonitor(i, m), this.t.monitorFlushMs);
      });
      i.denied.delete('monitor');
    } catch (e) {
      if (e instanceof NoPerm || e instanceof Unknown) i.denied.add('monitor');
      m.client?.close();
      if (i.monitor === m) i.monitor = null;
      this.broadcast();
    } finally { m.starting = false; }
  }

  private flushMonitor(i: Inst, m: NonNullable<Inst['monitor']>): void {
    m.timer = null;
    const lines = m.pending.splice(0);
    if (!lines.length) return;
    for (const w of this.windows.values()) if (w.watch.live && this.pickOf(w) === i && !w.wc.isDestroyed()) w.wc.send(REDIS_CHANNELS.monitor, { key: i.cand.key, lines });
  }

  private stopMonitor(i: Inst): void {
    const m = i.monitor;
    if (!m) return;
    i.monitor = null;
    if (m.timer) clearTimeout(m.timer);
    m.client?.close();
  }

  // —— what windows see ——

  private instanceFor(i: Inst, v: CandidateView, root: string): RedisInstance {
    const c = i.cand;
    const badge = c.sources.includes('docker') ? 'docker' : c.terminal ? 'terminal' : c.sources.includes('custom') ? 'custom' : i.brew ? 'brew' : 'local';
    const env = c.envs.find((e) => e.project === root);
    // A password in this project's .env not tried on this server (it names another endpoint): offered, never sent.
    const tried = new Set(c.envs.map((e) => e.password));
    const other = i.state === 'auth' ? redisEnvPassword(this.deps.readEnv(root), tried) : null;
    return {
      key: c.key, endpoint: c.endpoint, state: i.state, badge, label: badge === 'brew' ? 'Homebrew' : badge === 'local' ? 'Local' : v.label, hint: v.hint, mine: v.mine,
      server: i.server, db: env?.db ?? 0, prefix: env?.prefix ?? null, ...(i.why ? { why: i.why } : {}), hasPassword: !!i.cred, envPassword: other,
      container: c.container ? { id: c.container.id, name: c.container.name, service: c.container.service, running: c.container.running, finishedAt: c.container.finishedAt } : null
    };
  }

  snapshotFor(wcId: number): RedisSnapshot {
    const w = this.windows.get(wcId);
    if (!w || this.deps.settings().showRedis === 'never') return { instances: [], pick: null, mentions: false, brew: false, probed: this.probed };
    const view = viewFor([...this.insts.values()].map((i) => i.cand), w.root);
    const instances = view.map((v) => this.instanceFor(this.insts.get(v.key)!, v, w.root));
    return {
      instances, pick: this.pickOf(w)?.cand.key ?? null,
      mentions: mentionsRedis(this.deps.readEnv(w.root), this.deps.readCompose(w.root)), brew: this.deps.brewInstalled(), probed: this.probed
    };
  }

  statusFor(wcId: number): RedisStatus {
    const w = this.windows.get(wcId);
    const i = w ? this.pickOf(w) : null;
    const db = w?.watch.db ?? 0;
    if (!w || !i) return { key: null, info: null, samples: [], denied: [], queues: null, unseen: {}, db, dir: null, error: null };
    const qs = i.queues.get(db);
    const unseen: Record<string, number> = {};
    for (const q of qs?.infos ?? []) { const n = (q.counts.failed ?? 0) - (qs!.baseline.get(q.id) ?? 0); if (n > 0) unseen[q.id] = n; }
    return {
      // The charts' 10 minutes of samples only for a window that shows them: otherwise the status (INFO for the footer)
      // would carry them every 10 s for nothing.
      key: i.cand.key, info: i.state === 'running' ? i.info : null, samples: i.state === 'running' && (w.watch.overview || w.watch.live) ? i.samples : [], denied: [...i.denied].sort(),
      queues: this.deps.settings().redisQueues ? qs?.infos ?? null : null, unseen, db, dir: i.dir ?? null, error: null
    };
  }

  private broadcast(): void {
    for (const [id, w] of this.windows) {
      if (w.wc.isDestroyed()) continue;
      const snap = this.snapshotFor(id);
      const sk = JSON.stringify(snap);
      if (sk !== w.sentSnap) { w.sentSnap = sk; w.wc.send(REDIS_CHANNELS.snapshot, snap); }
      const st = this.statusFor(id);
      const tk = JSON.stringify(st);
      if (tk !== w.sentStatus) { w.sentStatus = tk; w.wc.send(REDIS_CHANNELS.status, st); }
    }
  }

  // —— requests ——

  pick(wcId: number, key: string): void {
    const w = this.windows.get(wcId);
    if (!w || !this.insts.has(key)) return;
    this.deps.picks.set(w.root, key);
    this.tick();
  }

  async auth(wcId: number, a: { key: string; user?: string; password?: string; useEnv?: boolean }): Promise<{ ok: true } | { ok: false; reason: 'wrong' | 'unreachable' }> {
    const w = this.windows.get(wcId);
    const i = this.insts.get(a.key);
    if (!w || !i) return { ok: false, reason: 'unreachable' };
    const password = a.useEnv ? redisEnvPasswordValue(this.deps.readEnv(w.root)) : a.password;
    if (!password) return { ok: false, reason: 'wrong' };
    const cred: Cred = { ...(a.user ? { user: a.user } : {}), password, from: 'keychain' };
    try {
      const c = await this.connect(i, cred, 'atelier');
      await c.call(['PING']);
      c.close();
    } catch (e) {
      return { ok: false, reason: e instanceof NoAuth ? 'wrong' : 'unreachable' };
    }
    try { this.deps.secrets?.write(secretId(i.cand.key), JSON.stringify({ ...(a.user ? { user: a.user } : {}), password })); } catch { /* used for this run only */ }
    i.cred = cred;
    await this.probeOne(i);
    this.broadcast();
    this.tick();
    return { ok: true };
  }

  forget(key: string): void {
    const i = this.insts.get(key);
    this.deps.secrets?.remove(secretId(key));
    if (i && i.cred?.from === 'keychain') { i.cred = null; this.disconnect(i); }
    void this.probe();
  }

  seen(wcId: number, queueId: string): void {
    const w = this.windows.get(wcId);
    const i = w ? this.pickOf(w) : null;
    const qs = i?.queues.get(w!.watch.db);
    const q = qs?.infos?.find((x) => x.id === queueId);
    if (!qs || !q) return;
    qs.baseline.set(queueId, q.counts.failed ?? 0);
    this.broadcast();
  }

  async scan(wcId: number, a: { db: number; match: string; cursor: string }): Promise<{ cursor: string; keys: KeyEntry[]; total: number }> {
    const { c } = await this.clientOf(wcId);
    return scanPage(c, a.db, a.match, a.cursor);
  }

  async value(wcId: number, a: { db: number; key: string; page: ValuePage }): Promise<RedisValueReply> {
    const { c } = await this.clientOf(wcId);
    return readValue(c, a.db, a.key, a.page);
  }

  async counter(wcId: number, a: { db: number; key: string }): Promise<{ value: string | null; ttl: number }> {
    const { c } = await this.clientOf(wcId);
    return readCounter(c, a.db, a.key);
  }

  async clients(wcId: number): Promise<ClientRow[]> {
    const { i, c } = await this.clientOf(wcId);
    let list;
    try { list = parseClientList(text(await c.call(['CLIENT', 'LIST']))); i.denied.delete('clients'); } catch (e) {
      if (e instanceof NoPerm || e instanceof Unknown) { i.denied.add('clients'); this.broadcast(); }
      return [];
    }
    i.own = new Set(list.filter((x) => x.name.startsWith('atelier')).map((x) => x.addr));
    const live = new Set(list.map((x) => x.addr));
    for (const a of i.lastCmd.keys()) if (!live.has(a)) i.lastCmd.delete(a);
    const hostPort = i.cand.endpoint.kind === 'tcp' && !i.cand.sources.includes('docker') ? i.cand.endpoint.port : null;
    const origins = hostPort ? await this.deps.clientOrigins(hostPort).catch(() => new Map<number, string>()) : new Map<number, string>();
    const ips = await this.deps.dockerIps().catch(() => new Map<string, string>());
    return list.map((x) => {
      const display = clientDisplayName(x.name);
      const kind: ClientRow['kind'] = x.name.startsWith('atelier') ? 'atelier' : !x.name ? 'unnamed' : display !== x.name || /^(sidekiq|rq:worker|asynq|resque)/i.test(x.name) ? 'queue' : 'app';
      const [ip, port] = [x.addr.slice(0, x.addr.lastIndexOf(':')), Number(x.addr.slice(x.addr.lastIndexOf(':') + 1))];
      const from = kind === 'atelier' ? 'Atelier (this view)' : origins.get(port) ? `Terminal · ${origins.get(port)}` : ips.get(ip) ? `Docker · ${ips.get(ip)}` : x.addr;
      const cmd = i.lastCmd.get(x.addr) ?? x.cmd.replace('|', ' ').toUpperCase();
      return { id: x.id, name: display, kind, from, cmd, idle: x.idle, db: x.db, addr: x.addr };
    });
  }

  async slowlog(wcId: number): Promise<{ threshold: number | null; entries: SlowEntry[] }> {
    const { i, c } = await this.clientOf(wcId);
    if (i.slowThreshold === undefined) {
      try { const r = await c.call(['CONFIG', 'GET', 'slowlog-log-slower-than']); i.slowThreshold = Number(text((Array.isArray(r) ? r : [])[1] ?? null)) || null; } catch { i.slowThreshold = null; i.denied.add('config'); }
    }
    try {
      const r = await c.call(['SLOWLOG', 'GET', 10]);
      const entries = (Array.isArray(r) ? r : []).map((e) => {
        const a = Array.isArray(e) ? e : [];
        const args = (Array.isArray(a[3]) ? a[3] : []).map((x) => text(x));
        return { id: Number(text(a[0] ?? null)) || 0, at: (Number(text(a[1] ?? null)) || 0) * 1000, micros: Number(text(a[2] ?? null)) || 0, command: args.join(' ').slice(0, 200), client: text(a[5] ?? null) };
      });
      i.denied.delete('slowlog');
      return { threshold: i.slowThreshold, entries };
    } catch (e) {
      if (e instanceof NoPerm || e instanceof Unknown) { i.denied.add('slowlog'); this.broadcast(); }
      return { threshold: i.slowThreshold, entries: [] };
    }
  }

  private queueRef(i: Inst, db: number, id: string): QueueRef | null {
    return i.queues.get(db)?.refs.find((r) => r.id === id) ?? null;
  }

  async jobs(wcId: number, a: { db: number; queue: string; state: JobState; start: number; count: number }): Promise<JobInfo[]> {
    const { i, c } = await this.clientOf(wcId);
    const q = this.queueRef(i, a.db, a.queue);
    if (!q) return [];
    return (await queueAdapter(q.lib).jobs(q, this.reader(c, a.db), a.state, a.start, a.count)).map(summarize);
  }

  async job(wcId: number, a: { db: number; queue: string; state: JobState; id: string }): Promise<{ job: JobInfo; command: string | null } | null> {
    const { i, c } = await this.clientOf(wcId);
    const q = this.queueRef(i, a.db, a.queue);
    if (!q) return null;
    const ad = queueAdapter(q.lib);
    const job = await ad.job(q, this.reader(c, a.db), a.state, a.id);
    return job ? { job, command: ad.command(q, job, a.state) } : null;
  }

  async preview(wcId: number, a: { db: number; pattern: string; instance: string }): Promise<Preview> {
    const { i } = await this.clientOf(wcId);
    if (i.cand.key !== a.instance) throw new Error('moved: the window shows another instance');
    return i.writer.preview(a.db, a.pattern);
  }

  async write(wcId: number, a: { db: number; op: WriteOpIn; instance: string }): Promise<WriteResult> {
    if (this.deps.settings().redisEdits !== 'ask') return { ok: false, reason: 'refused' };
    const { i } = await this.clientOf(wcId);
    // Confirmed on one instance, the window now shows another (it restarted, another one started): nothing is written.
    if (i.cand.key !== a.instance) return { ok: false, reason: 'moved' };
    let op: WriteOp;
    if (a.op.op === 'retry' || a.op.op === 'remove') {
      // The queue as main detected it, never as the renderer described it.
      const q = this.queueRef(i, a.db, a.op.queue.id);
      if (!q) return { ok: false, reason: 'refused' };
      op = a.op.op === 'retry' ? { op: 'retry', queue: q, id: a.op.id } : { op: 'remove', queue: q, id: a.op.id };
    } else op = a.op as KeyWriteOp;
    const r = await i.writer.run(a.db, op);
    if (r.ok && (op.op === 'retry' || op.op === 'remove' || op.op === 'flushdb')) void this.countQueues(i, a.db);
    return r;
  }

  async undo(wcId: number, id: string): Promise<UndoResult> {
    if (this.deps.settings().redisEdits !== 'ask') return { ok: false, reason: 'error', message: 'Edits are off' };
    const { i, w } = await this.clientOf(wcId);
    const r = await i.writer.undo(id);
    void this.countQueues(i, w.watch.db);
    return r;
  }

  /** The window's picked instance title (banners, prompts). */
  titleOf(wcId: number): string {
    const w = this.windows.get(wcId);
    const i = w ? this.pickOf(w) : null;
    return i ? instanceTitle({ server: i.server, endpoint: i.cand.endpoint }) : 'Redis';
  }
}

/** The name of a password variable in a project's .env, offered for a server that wants one. */
export function redisEnvPassword(env: Record<string, string>, tried: Set<string | undefined>): string | null {
  if (env.REDIS_PASSWORD && env.REDIS_PASSWORD !== 'null' && !tried.has(env.REDIS_PASSWORD)) return 'REDIS_PASSWORD';
  for (const [k, v] of Object.entries(env)) {
    if (!/REDIS.*URL$|^REDIS_URL$/.test(k)) continue;
    const m = /^rediss?:\/\/(?:[^:@/]*):([^@/]+)@/.exec(v);
    if (m && !tried.has(decodeURIComponent(m[1]!))) return k;
  }
  return null;
}

function redisEnvPasswordValue(env: Record<string, string>): string | null {
  if (env.REDIS_PASSWORD && env.REDIS_PASSWORD !== 'null') return env.REDIS_PASSWORD;
  for (const [k, v] of Object.entries(env)) {
    if (!/REDIS.*URL$|^REDIS_URL$/.test(k)) continue;
    const m = /^rediss?:\/\/(?:[^:@/]*):([^@/]+)@/.exec(v);
    if (m) { try { return decodeURIComponent(m[1]!); } catch { return m[1]!; } }
  }
  return null;
}

export const _test = { secretId };
