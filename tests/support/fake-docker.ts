// A fake Docker Engine on a Unix socket, for vitest integration tests and Playwright e2e: the
// app never meets a real engine in tests. It serves the nine read endpoints from in-memory containers — multiplexed
// or TTY logs (follow, tail, since), a stats stream, a scripted events stream — records every request, and answers
// anything that isn't a GET with 405 (tests assert none came).
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { rmSync } from 'node:fs';
import type { ContainerSpec } from '../../src/demo/world/docker';

export interface FakeLog { at: number; err: boolean; text: string }
// The spec type is the demo world's (one description of a container for the e2e, the screenshots and the demo).
export type { ContainerSpec };

// A container's Engine JSON lives with the demo's compiler (src/demo/compile/docker-inspect.ts): the fake engine
// serves it, the browser demo compiles it into snapshots at build time — one description of a container for both.
import { idOf, inspectOf } from '../../src/demo/compile/docker-inspect';
export { idOf, inspectOf };

const iso = (ms: number) => new Date(ms).toISOString().replace('Z', '000000Z');

function frame(err: boolean, text: string): Buffer {
  const body = Buffer.from(text, 'utf8');
  const head = Buffer.alloc(8);
  head[0] = err ? 2 : 1;
  head.writeUInt32BE(body.length, 4);
  return Buffer.concat([head, body]);
}

interface Entry { inspect: Record<string, unknown>; logs: FakeLog[]; cpu: number; rx: number; tx: number }

export class FakeDocker {
  readonly requests: { method: string; path: string }[] = [];
  readonly containers = new Map<string, Entry>();
  version: Record<string, unknown> = { Version: '27.3.1', ApiVersion: '1.47', MinAPIVersion: '1.24', Os: 'linux', Arch: 'arm64', Platform: { Name: 'Docker Engine - Community' }, Components: [{ Name: 'Engine', Version: '27.3.1' }] };
  info: Record<string, unknown> = { OperatingSystem: 'OrbStack', Name: 'orbstack', NCPU: 4, MemTotal: 8 * 1024 ** 3, Architecture: 'aarch64', ServerVersion: '27.3.1' };
  df: Record<string, unknown> = {
    LayersSize: 12_400_000_000,
    Images: [{ Id: 'sha256:1', Size: 9_000_000_000, SharedSize: 0, Containers: 2 }, { Id: 'sha256:2', Size: 3_400_000_000, SharedSize: 0, Containers: 0 }],
    Containers: [{ Id: 'x', SizeRw: 220_000_000 }],
    Volumes: [{ Name: 'acme_node_modules', UsageData: { Size: 412_000_000, RefCount: 1 } }, { Name: 'old', UsageData: { Size: 3_400_000_000, RefCount: 0 } }],
    BuildCache: [{ ID: 'b1', Size: 6_100_000_000, InUse: false, Shared: false }]
  };
  statsEveryMs = 200;
  private followers = new Map<string, Set<{ res: ServerResponse; tty: boolean }>>();
  private eventStreams = new Set<ServerResponse>();
  private open = new Set<ServerResponse>();
  private openPaths = new Map<ServerResponse, string>();

  private constructor(readonly socket: string, private server: Server) {}

  static async start(socket: string): Promise<FakeDocker> {
    rmSync(socket, { force: true });
    let self: FakeDocker | null = null;
    const server = createServer((req, res) => self!.handle(req, res));
    self = new FakeDocker(socket, server);
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(socket, () => resolve()); });
    return self;
  }

  add(spec: ContainerSpec, logs: (FakeLog | string)[] = []): string {
    const inspect = inspectOf(spec);
    const id = inspect.Id as string;
    const now = Date.now();
    this.containers.set(id, { inspect, logs: logs.map((l, i) => (typeof l === 'string' ? { at: now - (logs.length - i) * 1000, err: false, text: l } : l)), cpu: 1_000_000, rx: 0, tx: 0 });
    // As Docker does: whoever follows the events hears about it.
    this.event(id, 'create');
    if ((spec.state ?? 'running') === 'running') this.event(id, 'start');
    return id;
  }

  /** Changes a container (its spec's fields) and plays the events Docker would send. */
  change(id: string, spec: ContainerSpec, events: { action: string; attrs?: Record<string, string> }[] = []): void {
    const e = this.containers.get(id);
    if (!e) return;
    e.inspect = { ...inspectOf(spec), Id: id, Name: e.inspect.Name };
    for (const ev of events) this.event(id, ev.action, ev.attrs);
    if (spec.state && spec.state !== 'running') for (const f of this.followers.get(id) ?? []) f.res.end();
  }

  remove(id: string): void {
    this.containers.delete(id);
    this.event(id, 'destroy');
  }

  log(id: string, text: string, err = false, at = Date.now()): void {
    const e = this.containers.get(id);
    if (!e) return;
    const l = { at, err, text };
    e.logs.push(l);
    for (const f of this.followers.get(id) ?? []) f.res.write(this.encode(l, f.tty));
  }

  event(id: string, action: string, attrs: Record<string, string> = {}): void {
    const e = this.containers.get(id);
    const name = e ? (e.inspect.Name as string).slice(1) : '';
    const line = JSON.stringify({ status: action, id, from: '', Type: 'container', Action: action, Actor: { ID: id, Attributes: { name, ...attrs } }, scope: 'local', time: Math.floor(Date.now() / 1000), timeNano: Date.now() * 1e6 }) + '\n';
    for (const r of this.eventStreams) r.write(line);
  }

  nonGet(): string[] { return this.requests.filter((r) => r.method !== 'GET').map((r) => `${r.method} ${r.path}`); }

  /** Replies still open whose path contains `part` ('/stats', '/logs'): the streams the app follows now. */
  streaming(part: string): number { return [...this.openPaths.values()].filter((p) => p.includes(part)).length; }

  async close(): Promise<void> {
    for (const r of this.open) r.destroy();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
    rmSync(this.socket, { force: true });
  }

  private encode(l: FakeLog, tty: boolean): Buffer {
    const text = `${iso(l.at)} ${l.text}\n`;
    return tty ? Buffer.from(text.replace(/\n$/, '\r\n')) : frame(l.err, text);
  }

  private handle(req: IncomingMessage, res: ServerResponse): void {
    const url = new URL(req.url ?? '/', 'http://docker');
    this.requests.push({ method: req.method ?? '', path: req.url ?? '' });
    if (req.method !== 'GET') { res.writeHead(405).end(); return; }
    this.open.add(res);
    this.openPaths.set(res, req.url ?? '');
    res.on('close', () => { this.open.delete(res); this.openPaths.delete(res); });
    const json = (v: unknown) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(v)); };
    const p = url.pathname;
    if (p === '/_ping') { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('OK'); return; }
    if (p === '/version') return json(this.version);
    if (p === '/info') return json(this.info);
    if (p === '/system/df') return json(this.df);
    if (p === '/containers/json') {
      return json([...this.containers.values()].map(({ inspect: i }) => {
        const st = i.State as Record<string, unknown>;
        return { Id: i.Id, Names: [i.Name], Image: (i.Config as Record<string, unknown>).Image, State: st.Status, Status: `${st.Status} ${st.ExitCode} ${st.StartedAt} ${(st.Health as Record<string, unknown> | undefined)?.Status ?? ''} ${i.RestartCount}`, Labels: (i.Config as Record<string, unknown>).Labels };
      }));
    }
    if (p === '/events') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.flushHeaders();
      this.eventStreams.add(res);
      res.on('close', () => this.eventStreams.delete(res));
      return;
    }
    const m = /^\/containers\/([0-9a-f]{12,64})\/(json|logs|stats)$/.exec(p);
    const entry = m ? [...this.containers.entries()].find(([id]) => id.startsWith(m[1]!)) : undefined;
    if (!m || !entry) { res.writeHead(404).end('{"message":"No such container"}'); return; }
    const [id, e] = entry;
    if (m[2] === 'json') return json(e.inspect);
    if (m[2] === 'logs') {
      const tty = (e.inspect.Config as Record<string, unknown>).Tty === true;
      const since = Number(url.searchParams.get('since') ?? 0) * 1000;
      const tail = url.searchParams.get('tail');
      let lines = e.logs.filter((l) => l.at >= since);
      if (tail && tail !== 'all') lines = lines.slice(-Number(tail));
      res.writeHead(200, { 'Content-Type': tty ? 'application/vnd.docker.raw-stream' : 'application/vnd.docker.multiplexed-stream' });
      for (const l of lines) res.write(this.encode(l, tty));
      const running = ((e.inspect.State as Record<string, unknown>).Running) === true;
      if (url.searchParams.get('follow') !== '1' || !running) { res.end(); return; }
      const f = { res, tty };
      const set = this.followers.get(id) ?? new Set();
      set.add(f);
      this.followers.set(id, set);
      res.on('close', () => set.delete(f));
      return;
    }
    // stats
    const sample = () => {
      const prev = e.cpu;
      e.cpu += 3_100_000 + Math.round(Math.random() * 400_000);
      return {
        read: new Date().toISOString(),
        cpu_stats: { cpu_usage: { total_usage: e.cpu }, system_cpu_usage: 200_000_000 + Date.now(), online_cpus: 4 },
        precpu_stats: { cpu_usage: { total_usage: prev }, system_cpu_usage: 100_000_000 + Date.now() },
        memory_stats: { usage: 200 * 1024 * 1024, limit: 2 * 1024 ** 3, stats: { inactive_file: 18 * 1024 * 1024 } },
        // Counters only grow, as the kernel's do: a steady ~2 KB/s with a little noise.
        networks: { eth0: { rx_bytes: (e.rx += 180 + Math.round(Math.random() * 60)), tx_bytes: (e.tx += 170 + Math.round(Math.random() * 60)) } },
        pids_stats: { current: 23 }
      };
    };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (url.searchParams.get('stream') !== '1') { res.end(JSON.stringify(sample())); return; }
    res.write(JSON.stringify(sample()) + '\n');
    const timer = setInterval(() => res.write(JSON.stringify(sample()) + '\n'), this.statsEveryMs);
    res.on('close', () => clearInterval(timer));
  }
}
