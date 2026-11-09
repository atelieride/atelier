// Docker view, main side: finds the engine and follows it through one events stream,
// keeps every container (list + inspect on change), streams logs and stats only for what windows show, answers
// inspect / disk usage / events, and turns failures into notifications. Read-only: every request goes through
// engine.ts (GET over the Unix socket, nine endpoints).
import { existsSync, lstatSync, readFileSync, statSync } from 'node:fs';
import { IPC } from '@shared/api';
import { randomUUID } from 'node:crypto';
import {
  containerFromInspect, cpuPercent, crashKind, detailFromInspect, dfSummary, dockerPipeName, eventEntry, memoryOf, netTotals, pidsOf,
  type DfSummary, type DockerContainer, type DockerDetail, type DockerEventEntry, type DockerNote, type DockerSnapshot, type EngineState, type StatsSample
} from '@shared/docker';
import { isFrame, lineLevel, splitTimestamp, type DockerLogLine } from '@shared/docker-logs';
import { redactSecrets } from '@shared/session';
import { stripAnsi } from '@shared/logline';
import type { Settings } from '@shared/settings';
import { detect, type DetectDeps } from './detect';
import { Demuxer, LineSplitter } from './demux';
import { Denied, getJson, getText, openStream, type DockerRequest, type Stream } from './engine';
import { isInside } from '@shared/paths';

export interface HubWindow {
  id: number;
  send(channel: string, payload: unknown): void;
  isDestroyed(): boolean;
  once(event: 'destroyed', fn: () => void): void;
}

export type DockerSettings = Pick<Settings, 'showDocker' | 'dockerSocket' | 'dockerOthers' | 'dockerNotify' | 'dockerLogLines' | 'notifySound'>;

export interface DockerHubDeps {
  settings(): DockerSettings;
  home: string;
  testSocket?: string;
  /** Any Atelier window focused (hidden e2e windows count as focused). */
  focused(): boolean;
  /** An OS banner (main decides when; tests log it). A click opens that container in the window of `root`. */
  banner(b: { title: string; body: string; silent: boolean; containerId: string; root: string }): void;
  /** Overrides for tests (timers, file reads). */
  timing?: Partial<typeof TIMING>;
  detect?: Partial<DetectDeps>;
}

export const DOCKER_CHANNELS = {
  snapshot: IPC.evDocker, logs: IPC.evDockerLogs, stats: IPC.evDockerStats, event: IPC.evDockerEvent, note: IPC.evDockerNote
} as const;

export const TIMING = {
  tickMs: 2000,
  probeMs: 30_000,
  relistMs: 60_000,
  debounceMs: 250,
  lingerMs: 60_000,
  flushMs: 50,
  killWindowMs: 30_000,
  coalesceMs: 5 * 60_000,
  maxStats: 24,
  maxEvents: 200
};

interface LogWatch {
  stream: Stream | null; ended: boolean; buf: DockerLogLine[]; seq: number; lastAt: number;
  watchers: Set<number>; linger: NodeJS.Timeout | null; pending: DockerLogLine[]; flush: NodeJS.Timeout | null;
}
interface StatsWatch { stream: Stream; samples: StatsSample[]; watchers: Set<number>; prev: { at: number; rx: number; tx: number } | null; text: LineSplitter }

const signature = (c: Record<string, unknown>) => `${String(c.State)}|${String(c.Status)}`;

export class DockerHub {
  private windows = new Map<number, { wc: HubWindow; root: string }>();
  private engine: EngineState = { state: 'absent' };
  private containers = new Map<string, DockerContainer>();
  private sigs = new Map<string, string>();
  private sent = '';
  private events: Stream | null = null;
  private eventsBackoff = 1000;
  private eventList: DockerEventEntry[] = [];
  private health = new Map<string, string>();
  private killedAt = new Map<string, number>();
  private oomAt = new Map<string, number>();
  private noted = new Map<string, number>();
  private logs = new Map<string, LogWatch>();
  private stats = new Map<string, StatsWatch>();
  private winLogs = new Map<number, Set<string>>();
  private winStats = new Map<number, Set<string>>();
  private timer: NodeJS.Timeout | null = null;
  private relistTimer: NodeJS.Timeout | null = null;
  private reconnect: NodeJS.Timeout | null = null;
  private lastProbe = 0;
  private lastList = 0;
  private probing = false;
  private listing = false;
  private listAgain = false;
  private t: typeof TIMING;
  private socketKey = '';
  private gen = 0;
  private reprobe = false;
  /** The engine seen running this session: when its socket goes away it is "stopped", not "absent". */
  private lastSocket: string | null = null;

  constructor(private deps: DockerHubDeps) {
    this.t = { ...TIMING, ...deps.timing };
  }

  /** A project window: it gets every snapshot; the hub runs while any window is open. */
  open(root: string, wc: HubWindow): void {
    this.windows.set(wc.id, { wc, root });
    wc.once('destroyed', () => this.closeWindow(wc.id));
    if (!this.timer) {
      this.timer = setInterval(() => this.tick(), this.t.tickMs);
      void this.probe();
    }
  }

  /** Called when the containers or the engine changed (the Redis view finds Redis containers here). */
  onChange: (() => void) | null = null;

  snapshot(): DockerSnapshot {
    return { engine: this.engine, containers: [...this.containers.values()] };
  }

  /** A window came to the front: an engine started meanwhile shows up at once. */
  onFocus(): void {
    if (this.engine.state !== 'running' && Date.now() - this.lastProbe > 2000) void this.probe();
  }

  settingsChanged(): void {
    const s = this.deps.settings();
    const key = `${s.showDocker}|${s.dockerSocket}`;
    if (key === this.socketKey) return;
    this.socketKey = key;
    this.lastSocket = null;
    // A probe on its way is about the old setting: its result is dropped and a new one runs after it.
    this.gen++;
    if (this.probing) this.reprobe = true;
    this.stopEngine({ state: 'absent' });
    if (s.showDocker !== 'never' && this.windows.size) void this.probe();
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.stopEngine({ state: 'absent' });
  }

  // —— engine ——

  private tick(): void {
    const s = this.deps.settings();
    if (s.showDocker === 'never') { if (this.engine.state !== 'absent') this.stopEngine({ state: 'absent' }); return; }
    const now = Date.now();
    if (this.engine.state !== 'running') {
      if (this.deps.focused() && now - this.lastProbe >= this.t.probeMs) void this.probe();
    } else if (this.deps.focused() && now - this.lastList >= this.t.relistMs) void this.relist();
  }

  private detectDeps(): DetectDeps {
    const s = this.deps.settings();
    return {
      home: this.deps.home, custom: s.dockerSocket, testSocket: this.deps.testSocket,
      readFile: (p) => { try { return readFileSync(p, 'utf8').slice(0, 1024 * 1024); } catch { return null; } },
      isSocket: (p) => {
        // A named pipe (Windows): stat answers EBUSY, existence is what can be asked.
        if (dockerPipeName(p)) return existsSync(p) ? true : null;
        try {
          const l = lstatSync(p);
          if (l.isSocket()) return true;
          return l.isSymbolicLink() ? statSync(p).isSocket() : false;
        } catch { return null; }
      },
      ping: async (sock) => {
        try { return (await getText(sock, { kind: 'ping' }, { timeoutMs: 1000, maxBytes: 64 })).trim() === 'OK' ? 'ok' : 'gone'; } catch (e) { return e instanceof Denied ? 'denied' : 'gone'; }
      },
      version: (sock) => getJson(sock, { kind: 'version' }, { timeoutMs: 3000, maxBytes: 256 * 1024 }),
      info: (sock) => getJson(sock, { kind: 'info' }, { timeoutMs: 3000, maxBytes: 1024 * 1024 }),
      ...this.deps.detect
    };
  }

  private async probe(): Promise<void> {
    if (this.probing || this.deps.settings().showDocker === 'never') return;
    this.probing = true;
    this.lastProbe = Date.now();
    this.socketKey = `${this.deps.settings().showDocker}|${this.deps.settings().dockerSocket}`;
    const gen = this.gen;
    try {
      const detected = await detect(this.detectDeps());
      if (gen !== this.gen) return;
      // Docker Desktop removes its socket on quit: an engine seen before is stopped, and the view waits for it.
      const found: EngineState = detected.state === 'absent' && this.lastSocket ? { state: 'stopped', socket: this.lastSocket } : detected;
      if (found.state === 'running') {
        this.lastSocket = found.socket;
        if (this.engine.state === 'running' && this.engine.socket === found.socket) return;
        this.engine = found;
        this.openEvents();
        await this.relist();
        this.broadcast(true);
      } else this.stopEngine(found);
    } finally {
      this.probing = false;
      if (this.reprobe) { this.reprobe = false; void this.probe(); }
    }
  }

  private stopEngine(next: EngineState): void {
    this.events?.close();
    this.events = null;
    if (this.reconnect) clearTimeout(this.reconnect);
    this.reconnect = null;
    if (this.relistTimer) clearTimeout(this.relistTimer);
    this.relistTimer = null;
    for (const [id, w] of this.logs) { w.stream?.close(); w.stream = null; if (!w.ended) { w.ended = true; this.sendLogs(id, [], true); } }
    for (const st of this.stats.values()) st.stream.close();
    this.stats.clear();
    this.containers.clear();
    this.sigs.clear();
    this.engine = next;
    this.broadcast();
  }

  private get socket(): string | null {
    return this.engine.state === 'running' ? this.engine.socket : null;
  }

  private openEvents(): void {
    const socket = this.socket;
    if (!socket) return;
    this.events?.close();
    const lines = new LineSplitter();
    this.events = openStream(socket, { kind: 'events' }, {
      data: (c) => { this.eventsBackoff = 1000; for (const l of lines.push(c)) this.onEvent(l); },
      end: () => { this.events = null; void this.eventsEnded(); }
    });
  }

  private async eventsEnded(): Promise<void> {
    const socket = this.socket;
    if (!socket) return;
    const alive = await getText(socket, { kind: 'ping' }, { timeoutMs: 1000, maxBytes: 64 }).then(() => true, () => false);
    // Meanwhile another engine (or none) may have taken over: this stream's end is no longer news.
    if (this.socket !== socket || this.events) return;
    if (!alive) { this.stopEngine({ state: 'stopped', socket }); return; }
    this.reconnect = setTimeout(() => { this.reconnect = null; this.openEvents(); void this.relist(); }, this.eventsBackoff);
    this.eventsBackoff = Math.min(30_000, this.eventsBackoff * 2);
  }

  private onEvent(line: string): void {
    let ev: Record<string, unknown>;
    try { ev = JSON.parse(line) as Record<string, unknown>; } catch { return; }
    const action = typeof ev.Action === 'string' ? ev.Action : '';
    const actor = (ev.Actor ?? {}) as { ID?: string; Attributes?: Record<string, string> };
    const id = typeof actor.ID === 'string' ? actor.ID : '';
    const attrs = actor.Attributes ?? {};
    const now = Date.now();
    let entry = eventEntry(ev);
    if (ev.Type === 'container' && id) {
      if (action === 'kill' || action === 'stop') this.killedAt.set(id, now);
      if (action === 'oom') this.oomAt.set(id, now);
      if (action === 'die') {
        const exitCode = Number(attrs.exitCode ?? 0);
        const kind = crashKind({ exitCode, killed: now - (this.killedAt.get(id) ?? 0) < this.t.killWindowMs, oom: now - (this.oomAt.get(id) ?? 0) < this.t.killWindowMs });
        // A kill or an OOM explains its own die only: the next one is judged afresh.
        this.killedAt.delete(id);
        this.oomAt.delete(id);
        if (kind) void this.notify(id, kind, exitCode, attrs);
      }
      if (action === 'start') {
        this.killedAt.delete(id);
        this.oomAt.delete(id);
        const w = this.logs.get(id);
        if (w && w.watchers.size && !w.stream) this.startLogs(id, w);
      }
      if (entry?.action === 'health') {
        // health_status repeats on every check: only changes count (and are listed).
        if (this.health.get(id) === entry.detail) entry = null;
        else {
          const was = this.health.get(id);
          this.health.set(id, entry.detail);
          if (entry.detail === 'unhealthy' && was !== undefined) void this.notify(id, 'unhealthy', null, attrs);
        }
      }
      if (action === 'destroy') { this.health.delete(id); this.killedAt.delete(id); this.oomAt.delete(id); this.noted.delete(id); }
      if (!action.startsWith('exec_')) this.scheduleRelist();
    }
    if (entry) {
      this.eventList.unshift(entry);
      if (this.eventList.length > this.t.maxEvents) this.eventList.length = this.t.maxEvents;
      for (const { wc } of this.windows.values()) if (!wc.isDestroyed()) wc.send(DOCKER_CHANNELS.event, entry);
    }
  }

  private scheduleRelist(): void {
    if (this.relistTimer) return;
    this.relistTimer = setTimeout(() => { this.relistTimer = null; void this.relist(); }, this.t.debounceMs);
  }

  private async relist(): Promise<void> {
    const socket = this.socket;
    if (!socket) return;
    if (this.listing) { this.listAgain = true; return; }
    this.listing = true;
    this.lastList = Date.now();
    try {
      const list = await getJson(socket, { kind: 'containers' }, { timeoutMs: 5000 });
      if (!Array.isArray(list) || this.socket !== socket) return;
      const seen = new Set<string>();
      const todo: string[] = [];
      for (const raw of list as Record<string, unknown>[]) {
        const id = typeof raw.Id === 'string' ? raw.Id : '';
        if (!id) continue;
        seen.add(id);
        const sig = signature(raw);
        if (this.sigs.get(id) !== sig || !this.containers.has(id)) { todo.push(id); this.sigs.set(id, sig); }
      }
      for (const id of [...this.containers.keys()]) if (!seen.has(id)) { this.containers.delete(id); this.sigs.delete(id); }
      for (let i = 0; i < todo.length; i += 4) {
        await Promise.all(todo.slice(i, i + 4).map(async (id) => {
          const c = containerFromInspect(await getJson(socket, { kind: 'inspect', id }).catch(() => null));
          if (c) {
            this.containers.set(c.id, c);
            if (c.health && !this.health.has(c.id)) this.health.set(c.id, c.health);
          } else { this.containers.delete(id); this.sigs.delete(id); }
        }));
      }
      for (const [id, w] of this.logs) {
        const c = this.containers.get(id);
        if (w.watchers.size && !w.stream && c && (c.state === 'running' || c.state === 'restarting')) this.startLogs(id, w);
      }
      this.broadcast();
    } catch {
      /* the events stream decides whether the engine is gone */
    } finally {
      this.listing = false;
      if (this.listAgain) { this.listAgain = false; void this.relist(); }
    }
  }

  private broadcast(force = false): void {
    const snap = this.snapshot();
    const key = JSON.stringify(snap);
    if (!force && key === this.sent) return;
    this.sent = key;
    this.onChange?.();
    for (const { wc } of this.windows.values()) if (!wc.isDestroyed()) wc.send(DOCKER_CHANNELS.snapshot, snap);
  }

  // —— logs ——

  watchLogs(wcId: number, ids: string[]): void {
    const next = new Set(ids.filter((id) => this.containers.has(id)));
    const prev = this.winLogs.get(wcId) ?? new Set<string>();
    this.winLogs.set(wcId, next);
    for (const id of next) {
      if (prev.has(id)) continue;
      let w = this.logs.get(id);
      if (!w) {
        w = { stream: null, ended: false, buf: [], seq: 0, lastAt: 0, watchers: new Set(), linger: null, pending: [], flush: null };
        this.logs.set(id, w);
      }
      w.watchers.add(wcId);
      if (w.linger) { clearTimeout(w.linger); w.linger = null; }
      if (!w.stream) this.startLogs(id, w);
    }
    for (const id of prev) if (!next.has(id)) this.unwatchLogs(id, wcId);
  }

  private unwatchLogs(id: string, wcId: number): void {
    const w = this.logs.get(id);
    if (!w) return;
    w.watchers.delete(wcId);
    if (w.watchers.size || w.linger) return;
    // Kept a minute: switching back is instant; then the stream closes and the lines go.
    w.linger = setTimeout(() => {
      if (w.watchers.size) return;
      w.stream?.close();
      if (w.flush) clearTimeout(w.flush);
      this.logs.delete(id);
    }, this.t.lingerMs);
  }

  logsOf(id: string): { lines: DockerLogLine[]; ended: boolean } {
    const w = this.logs.get(id);
    return w ? { lines: w.buf, ended: w.ended && !w.stream } : { lines: [], ended: false };
  }

  private startLogs(id: string, w: LogWatch): void {
    const socket = this.socket;
    const c = this.containers.get(id);
    if (!socket || !c) return;
    const history = this.deps.settings().dockerLogLines;
    const since = w.lastAt ? Math.floor(w.lastAt / 1000) : undefined;
    const after = w.lastAt;
    const demux = new Demuxer();
    const out = new LineSplitter();
    const err = new LineSplitter();
    const take = (text: string, isErr: boolean) => {
      const { at, text: body } = splitTimestamp(text);
      // A reopened stream starts at the same second: what was already shown is skipped.
      if (after && at !== null && at <= after) return;
      const line: DockerLogLine = { seq: ++w.seq, at, err: isErr, text: body };
      if (at !== null) w.lastAt = at;
      w.buf.push(line);
      if (w.buf.length > history) w.buf.splice(0, w.buf.length - history);
      w.pending.push(line);
      if (!w.flush) w.flush = setTimeout(() => { w.flush = null; const l = w.pending; w.pending = []; this.sendLogs(id, l, false); }, this.t.flushMs);
    };
    w.ended = false;
    w.stream = openStream(socket, { kind: 'logs', id, follow: true, tail: history, ...(since !== undefined ? { since } : {}) } as DockerRequest, {
      data: (chunk) => {
        if (c.tty) for (const l of out.push(chunk)) take(l, false);
        else for (const f of demux.push(chunk)) for (const l of (f.err ? err : out).push(f.data)) take(l, f.err);
      },
      end: () => {
        for (const l of out.flush()) take(l, false);
        for (const l of err.flush()) take(l, true);
        w.stream = null;
        w.ended = true;
        if (w.flush) { clearTimeout(w.flush); w.flush = null; }
        const l = w.pending; w.pending = [];
        this.sendLogs(id, l, true);
      }
    });
  }

  private sendLogs(id: string, lines: DockerLogLine[], ended: boolean): void {
    const w = this.logs.get(id);
    if (!w) return;
    for (const wcId of w.watchers) {
      const win = this.windows.get(wcId);
      if (win && !win.wc.isDestroyed()) win.wc.send(DOCKER_CHANNELS.logs, { id, lines, ended });
    }
  }

  // —— stats ——

  watchStats(wcId: number, ids: string[]): void {
    const next = new Set(ids.filter((id) => this.containers.get(id)?.state === 'running'));
    const prev = this.winStats.get(wcId) ?? new Set<string>();
    this.winStats.set(wcId, next);
    for (const id of next) {
      const st = this.stats.get(id);
      if (st) { st.watchers.add(wcId); continue; }
      if (this.stats.size >= this.t.maxStats) continue;
      this.startStats(id, wcId);
    }
    for (const id of prev) {
      if (next.has(id)) continue;
      const st = this.stats.get(id);
      if (!st) continue;
      st.watchers.delete(wcId);
      if (!st.watchers.size) { st.stream.close(); this.stats.delete(id); }
    }
  }

  statsOf(ids: string[]): Record<string, StatsSample[]> {
    return Object.fromEntries(ids.flatMap((id) => { const st = this.stats.get(id); return st ? [[id, st.samples]] : []; }));
  }

  private startStats(id: string, wcId: number): void {
    const socket = this.socket;
    if (!socket) return;
    const st: StatsWatch = { stream: null as unknown as Stream, samples: [], watchers: new Set([wcId]), prev: null, text: new LineSplitter() };
    this.stats.set(id, st);
    st.stream = openStream(socket, { kind: 'stats', id, stream: true }, {
      data: (chunk) => {
        for (const l of st.text.push(chunk)) {
          let raw: unknown;
          try { raw = JSON.parse(l); } catch { continue; }
          const now = Date.now();
          const net = netTotals(raw);
          const mem = memoryOf(raw);
          // The first reading has no previous one: no CPU (precpu is empty) and no rate yet.
          if (!st.prev) { st.prev = { at: now, rx: net.rx, tx: net.tx }; continue; }
          const dt = (now - st.prev.at) / 1000;
          const sample: StatsSample = {
            at: now, cpu: Math.round(cpuPercent(raw) * 10) / 10, mem: mem.used, memLimit: mem.limit,
            rx: dt > 0 ? Math.max(0, (net.rx - st.prev.rx) / dt) : 0, tx: dt > 0 ? Math.max(0, (net.tx - st.prev.tx) / dt) : 0, pids: pidsOf(raw)
          };
          st.prev = { at: now, rx: net.rx, tx: net.tx };
          st.samples.push(sample);
          if (st.samples.length > 60) st.samples.shift();
          for (const w of st.watchers) {
            const win = this.windows.get(w);
            if (win && !win.wc.isDestroyed()) win.wc.send(DOCKER_CHANNELS.stats, { id, sample });
          }
        }
      },
      end: () => { if (this.stats.get(id) === st) this.stats.delete(id); }
    });
  }

  // —— one-off reads ——

  async inspect(id: string): Promise<{ container: DockerContainer; detail: DockerDetail } | null> {
    const socket = this.socket;
    if (!socket || !this.containers.has(id)) return null;
    const raw = await getJson(socket, { kind: 'inspect', id }).catch(() => null);
    const container = containerFromInspect(raw);
    const detail = detailFromInspect(raw);
    return container && detail ? { container, detail } : null;
  }

  async df(): Promise<DfSummary | null> {
    const socket = this.socket;
    if (!socket) return null;
    return getJson(socket, { kind: 'df' }, { timeoutMs: 20_000, maxBytes: 32 * 1024 * 1024 }).then(dfSummary, () => null);
  }

  eventsList(): DockerEventEntry[] { return this.eventList; }

  /** The last lines of a container, not followed (notifications, "Why it stopped"). */
  async tail(id: string, n: number): Promise<DockerLogLine[]> {
    const socket = this.socket;
    if (!socket || !this.containers.has(id)) return [];
    const raw = await this.rawTail(socket, id, n);
    const out: DockerLogLine[] = [];
    const push = (l: string, err: boolean) => { const { at, text } = splitTimestamp(l); out.push({ seq: out.length + 1, at, err, text }); };
    const o = new LineSplitter();
    const e = new LineSplitter();
    if (this.containers.get(id)?.tty) for (const l of o.push(raw)) push(l, false);
    else for (const f of new Demuxer().push(raw)) for (const l of (f.err ? e : o).push(f.data)) push(l, f.err);
    for (const l of o.flush()) push(l, false);
    for (const l of e.flush()) push(l, true);
    return out;
  }

  private rawTail(socket: string, id: string, n: number): Promise<Buffer> {
    return new Promise((resolve) => {
      const chunks: Buffer[] = [];
      let size = 0;
      const s = openStream(socket, { kind: 'logs', id, follow: false, tail: n }, {
        data: (c) => { size += c.length; if (size > 4 * 1024 * 1024) { clearTimeout(timer); s.close(); resolve(Buffer.concat(chunks)); return; } chunks.push(c); },
        end: () => { clearTimeout(timer); resolve(Buffer.concat(chunks)); }
      });
      const timer = setTimeout(() => { s.close(); resolve(Buffer.concat(chunks)); }, 3000);
    });
  }

  // —— notifications ——

  /** The windows told about a container: its project's first, then (others listed) every other one. */
  private targets(workingDir: string | null): { wc: HubWindow; root: string }[] {
    const others = this.deps.settings().dockerOthers;
    const mine: { wc: HubWindow; root: string }[] = [];
    const rest: { wc: HubWindow; root: string }[] = [];
    for (const w of this.windows.values()) {
      if (w.wc.isDestroyed()) continue;
      if (workingDir && isInside(w.root, workingDir)) mine.push(w);
      else if (others) rest.push(w);
    }
    return [...mine, ...rest];
  }

  private async notify(id: string, reason: DockerNote['reason'], exitCode: number | null, attrs: Record<string, string>): Promise<void> {
    const s = this.deps.settings();
    if (!s.dockerNotify) return;
    const c = this.containers.get(id);
    const name = c?.name ?? attrs['com.docker.compose.service'] ?? attrs.name ?? id.slice(0, 12);
    const project = c?.project ?? attrs['com.docker.compose.project'] ?? null;
    const workingDir = c?.workingDir ?? attrs['com.docker.compose.project.working_dir'] ?? null;
    const wins = this.targets(workingDir);
    if (!wins.length) return;
    // Once per container per window of time: a crash loop (restart: always) is one note, one toast, one chime, not
    // one per die. Marked before the log read, so dies arriving meanwhile are folded too.
    const now = Date.now();
    if (now - (this.noted.get(id) ?? -Infinity) < this.t.coalesceMs) return;
    this.noted.set(id, now);
    const lines = await this.tail(id, 50);
    const texts = lines.map((l) => stripAnsi(l.text).trim()).filter(Boolean);
    // The error itself, not the last of its stack frames.
    const errLine = [...lines].reverse().find((l) => !isFrame(l.text) && lineLevel(l.text, l.err ? 'err' : 'out') === 'error');
    const line = redactSecrets(stripAnsi(errLine?.text ?? texts.at(-1) ?? '').trim()).slice(0, 200);
    const note: DockerNote = { id: randomUUID(), at: Date.now(), container: { id, name, project }, reason, exitCode, line };
    for (const { wc } of wins) if (!wc.isDestroyed()) wc.send(DOCKER_CHANNELS.note, note);
    if (this.deps.focused()) return;
    const what = reason === 'unhealthy' ? 'is unhealthy' : reason === 'oom' ? 'ran out of memory' : `exited (${exitCode ?? '?'})`;
    this.deps.banner({ title: `${name} ${what}`, body: line || (project ?? 'Docker'), silent: !s.notifySound, containerId: id, root: wins[0]!.root });
  }

  private closeWindow(wcId: number): void {
    this.windows.delete(wcId);
    this.watchLogs(wcId, []);
    this.watchStats(wcId, []);
    this.winLogs.delete(wcId);
    this.winStats.delete(wcId);
    if (this.windows.size === 0) this.dispose();
  }
}
