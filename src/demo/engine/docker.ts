// Docker's live part in the demo. The containers, details, df and events
// are compiled (compile/docker.ts, the app's own parsers); this plays what changes, in the shapes main sends:
// - logs: each container keeps a ring of its last LOG_RING lines with main's seq numbers; while a view watches one, a
//   small generator writes new lines in that service's voice (the api about one a second, the rest quieter), and the
//   time nobody watched is filled in when a watch starts, so logs always run up to now;
// - stats: a random walk per watched running container, a sample every STATS_MS, kept as main keeps them (60);
// - the Docker beat: CRASH_AFTER_MS into the visit (or sooner, when "Things to try" asks: crashNow) the worker
//   crash-loops on ECONNREFUSED 127.0.0.1:6379 and stays exited 1 — events, snapshots, its last lines, one note
//   (Notification Center and toast), as DockerHub reports it.
// Every timer is the engine's clock: nothing runs while the page is hidden, and nothing at all while nobody watches.
import type { DockerContainer, DockerDetail, DockerEventEntry, DockerSnapshot, StatsSample } from '@shared/docker';
import type { DockerLogLine } from '@shared/docker-logs';
import type { DemoContext } from '../bridge/context';
import type { Cancel } from './clock';

export const LOG_RING = 200;
export const STATS_MS = 1500;
export const STATS_KEPT = 60;
/** When the worker crashes, in the clock's (visible) time. */
export const CRASH_AFTER_MS = 20_000;
/** main's maxEvents. */
const MAX_EVENTS = 200;
/** At most this many lines are written for the time nobody watched. */
const BACKFILL_MAX = 60;

type Rand = () => number;
type Out = { err?: boolean; text: string };
/** A service's voice: how long until its next lines, and what they say. */
interface Voice { gap(r: Rand): number; lines(r: Rand, at: number): Out[] }

const pick = <T>(r: Rand, list: readonly T[]): T => list[Math.floor(r() * list.length)]!;
const pad = (n: number, w = 2) => String(n).padStart(w, '0');
const ms = (r: Rand, lo: number, hi: number) => (lo + r() * (hi - lo)).toFixed(1);
const iso = (at: number) => new Date(at).toISOString();
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const ROUTES: [weight: number, line: (r: Rand) => string][] = [
  [6, (r) => `GET /api/products${pick(r, ['', '', '?page=2', '?page=3', '?q=mug', '?category=teapots'])} 200 ${ms(r, 9, 34)} ms`],
  [4, (r) => `GET /api/cart 200 ${ms(r, 4, 14)} ms`],
  [3, (r) => `GET /healthz 200 ${ms(r, 0.6, 1.6)} ms`],
  [3, (r) => `GET /api/products/${pick(r, ['8812', '8813', '8814', '7731', '5120'])} 200 ${ms(r, 6, 21)} ms`],
  [2, (r) => `POST /api/cart/items 201 ${ms(r, 12, 40)} ms`],
  [1, (r) => `PATCH /api/cart/items/${1 + Math.floor(r() * 4)} 200 ${ms(r, 10, 30)} ms`],
  [1, (r) => `DELETE /api/cart/items/${1 + Math.floor(r() * 4)} 204 ${ms(r, 8, 20)} ms`],
  [1, (r) => `GET /api/session ${r() < 0.4 ? 401 : 200} ${ms(r, 2, 6)} ms`],
  [1, (r) => `GET /api/orders?customer=4021 200 ${ms(r, 60, 420)} ms`],
  [1, (r) => `POST /api/checkout 200 ${ms(r, 180, 640)} ms`],
  [1, (r) => `GET /api/search?q=${pick(r, ['mug', 'tea', 'sencha', 'teapot'])} 200 ${ms(r, 18, 70)} ms`],
  [1, (r) => `GET /static/${pick(r, ['app.4f1c.js', 'app.9a2e.css', 'logo.svg'])} 304 ${ms(r, 0.4, 1.2)} ms`]
];
const ROUTE_WEIGHT = ROUTES.reduce((n, [w]) => n + w, 0);

const API: Voice = {
  gap: (r) => 600 + r() * 900,
  lines(r) {
    const x = r();
    // Now and then the bug the overview's stack trace shows, a warning, or a debug line between requests.
    if (x < 0.015) return [
      { text: `POST /api/checkout 500 ${ms(r, 0.9, 1.4)} s` },
      { err: true, text: 'Error: checkout failed: TokenExpiredError: jwt expired' },
      { err: true, text: '    at verify (/app/src/auth/session.ts:42:11)' },
      { err: true, text: '    at checkout (/app/src/routes/checkout.ts:88:5)' },
      { err: true, text: '    at Layer.handle (/app/node_modules/express/lib/router/layer.js:95:5)' }
    ];
    if (x < 0.035) return [{ text: `{"level":"warn","msg":"slow query ${Math.round(300 + r() * 300)} ms","sql":"SELECT * FROM orders WHERE customer_id = $1","rows":${20 + Math.floor(r() * 30)}}` }];
    if (x < 0.07) return [{ text: `debug: cache ${r() < 0.7 ? 'hit' : 'miss'} products:page:${1 + Math.floor(r() * 3)}` }];
    if (x < 0.085) return [{ text: `info: job enqueued email.receipt id=${8813 + Math.floor(r() * 80)}` }];
    let w = r() * ROUTE_WEIGHT;
    for (const [weight, line] of ROUTES) { w -= weight; if (w <= 0) return [{ text: line(r) }]; }
    return [{ text: ROUTES[0]![1](r) }];
  }
};

const WEB: Voice = {
  gap: (r) => 9000 + r() * 16_000,
  lines(r, at) {
    const d = new Date(at);
    const h = d.getUTCHours();
    const time = `${((h + 11) % 12) + 1}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} ${h < 12 ? 'AM' : 'PM'}`;
    return [{ text: r() < 0.8 ? `${time} [vite] hmr update /src/${pick(r, ['pages/Checkout.tsx', 'pages/Cart.tsx', 'components/ProductCard.tsx', 'styles/cart.css'])}` : `${time} [vite] page reload src/main.tsx` }];
  }
};

let pid = 64;
const POSTGRES: Voice = {
  gap: (r) => 14_000 + r() * 26_000,
  lines(r, at) {
    const stamp = `${iso(at).replace('T', ' ').slice(0, 23)} UTC`;
    if (r() < 0.6) return [{ text: `${stamp} [${++pid}] LOG:  duration: ${ms(r, 180, 520)} ms  statement: SELECT * FROM orders WHERE customer_id = $1` }];
    return [{ text: `${stamp} [27] LOG:  checkpoint starting: time` }, { text: `${stamp} [27] LOG:  checkpoint complete: wrote ${Math.floor(r() * 40) + 3} buffers (0.${Math.floor(r() * 9)}%); 0 WAL file(s) added, 0 removed, 0 recycled` }];
  }
};

const REDIS: Voice = {
  gap: (r) => 55_000 + r() * 10_000,
  lines(_r, at) {
    const d = new Date(at);
    const stamp = `1:M ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()} ${iso(at).slice(11, 23)}`;
    return [{ text: `${stamp} * 1 changes in 60 seconds. Saving...` }, { text: `${stamp} * Background saving started by pid ${pid += 3}` }, { text: `${stamp} * Background saving terminated with success` }];
  }
};

const MAILPIT: Voice = {
  gap: (r) => 25_000 + r() * 35_000,
  lines(r, at) {
    const stamp = iso(at).slice(0, 19).replace(/-/g, '/').replace('T', ' ');
    return [{ text: r() < 0.5 ? `INFO[${stamp}] [http] GET /api/v1/messages 200` : `INFO[${stamp}] [smtpd] connection from 172.19.0.${Math.floor(r() * 6) + 2}:5${Math.floor(r() * 9000) + 1000}` }];
  }
};

const WORKER: Voice = {
  gap: (r) => 4000 + r() * 9000,
  lines: (r) => [{ text: `info: job email.receipt id=${8813 + Math.floor(r() * 80)} done in ${Math.round(120 + r() * 260)} ms` }]
};

const LOCALSTACK: Voice = {
  gap: (r) => 40_000 + r() * 40_000,
  lines: (r) => [{ text: `${pick(r, ['AWS s3.ListObjectsV2 => 200', 'AWS sqs.ReceiveMessage => 200', 'AWS s3.GetObject => 200'])}` }]
};

const VOICES: Record<string, Voice> = { api: API, web: WEB, postgres: POSTGRES, redis: REDIS, mailpit: MAILPIT, worker: WORKER, localstack: LOCALSTACK };

/** A container's usual load: CPU % around `cpu`, memory around `mem` MB, network around `net` KB/s. */
const LOADS: Record<string, { cpu: number; mem: number; net: number; pids: number }> = {
  api: { cpu: 6, mem: 186, net: 14, pids: 23 }, web: { cpu: 3, mem: 142, net: 3, pids: 31 }, postgres: { cpu: 1.2, mem: 92, net: 6, pids: 9 },
  redis: { cpu: 0.6, mem: 12, net: 4, pids: 6 }, mailpit: { cpu: 0.1, mem: 24, net: 0.2, pids: 8 }, worker: { cpu: 2, mem: 118, net: 2, pids: 19 },
  localstack: { cpu: 1.5, mem: 312, net: 1, pids: 41 }
};
const DEFAULT_LOAD = { cpu: 1, mem: 64, net: 1, pids: 10 };

export interface DockerEngine {
  snapshot(): DockerSnapshot;
  detail(id: string): { container: DockerContainer; detail: DockerDetail } | null;
  logs(id: string): { lines: DockerLogLine[]; ended: boolean };
  tail(id: string, n: number): DockerLogLine[];
  watchLogs(ids: string[]): void;
  watchStats(ids: string[]): void;
  stats(ids: string[]): Record<string, StatsSample[]>;
  events(): DockerEventEntry[];
  /** The Docker beat now rather than CRASH_AFTER_MS in ("Things to try"); once only, whoever starts it. */
  crashNow(): void;
}

interface Ring { lines: DockerLogLine[]; seq: number; lastAt: number; ended: boolean }
interface Walk { samples: StatsSample[]; cpu: number; mem: number; rx: number; tx: number }

export function createDockerEngine(ctx: DemoContext, rand: Rand = Math.random): DockerEngine {
  const { world } = ctx;
  let containers = world.docker.snapshot.containers.map((c) => ({ ...c }));
  const details = new Map(Object.entries(world.docker.details));
  const events = [...world.docker.events];
  const engine = world.docker.snapshot.engine;
  const memLimit = engine.state === 'running' ? engine.memory : 2 * 1024 ** 3;
  const byId = (id: string) => containers.find((c) => c.id === id);
  const running = (id: string) => byId(id)?.state === 'running';
  const voiceOf = (id: string): Voice | null => { const c = byId(id); return c ? VOICES[c.service ?? c.name] ?? null : null; };

  // —— logs ——
  const rings = new Map<string, Ring>();
  const ring = (id: string): Ring => {
    let r = rings.get(id);
    if (!r) {
      const seed = world.docker.logs[id] ?? [];
      const lines = seed.slice(-LOG_RING).map((l, i) => ({ seq: i + 1, at: l.at, err: l.err, text: l.text }));
      r = { lines, seq: lines.length, lastAt: seed.at(-1)?.at ?? ctx.now() - 60_000, ended: !running(id) };
      rings.set(id, r);
    }
    return r;
  };
  const append = (id: string, out: Out[], at: number): DockerLogLine[] => {
    const r = ring(id);
    const added = out.map((o) => ({ seq: ++r.seq, at, err: !!o.err, text: o.text }));
    r.lines.push(...added);
    if (r.lines.length > LOG_RING) r.lines.splice(0, r.lines.length - LOG_RING);
    r.lastAt = at;
    return added;
  };
  const push = (id: string, lines: DockerLogLine[], ended = false) => { if (lines.length || ended) ctx.events.emit('dockerLogs', { id, lines, ended }); };

  const writers = new Map<string, Cancel>();
  /** The lines a service would have written since it was last heard, up to now (at most BACKFILL_MAX). */
  const backfill = (id: string, v: Voice) => {
    const r = ring(id);
    const now = ctx.now();
    const pending: { at: number; out: Out[] }[] = [];
    for (let at = r.lastAt + v.gap(rand); at < now; at += v.gap(rand)) {
      pending.push({ at: Math.round(at), out: v.lines(rand, at) });
      if (pending.length > BACKFILL_MAX) pending.shift();
    }
    for (const p of pending) append(id, p.out, p.at);
  };
  const write = (id: string, v: Voice) => {
    writers.set(id, ctx.clock.after(v.gap(rand), () => {
      if (!running(id) || (crashing && id === workerId)) { writers.delete(id); return; }
      const at = ctx.now();
      push(id, append(id, v.lines(rand, at), at));
      write(id, v);
    }));
  };
  let watchedLogs = new Set<string>();

  // —— stats ——
  const walks = new Map<string, Walk>();
  let watchedStats = new Set<string>();
  let statsTask: Cancel | null = null;
  const loadOf = (id: string) => { const c = byId(id); return LOADS[c?.service ?? c?.name ?? ''] ?? DEFAULT_LOAD; };
  const step = (id: string, w: Walk, at: number): StatsSample => {
    const l = loadOf(id);
    // Mean-reverting walks: lively, never drifting off. A request burst now and then on the busy ones.
    w.cpu = Math.max(0.05, w.cpu + (l.cpu - w.cpu) * 0.3 + (rand() - 0.5) * l.cpu * 0.8 + (rand() < 0.06 ? l.cpu * 2.5 : 0));
    w.mem = Math.max(l.mem * 0.8, w.mem + (l.mem - w.mem) * 0.1 + (rand() - 0.5) * l.mem * 0.04);
    w.rx = Math.max(0, w.rx + (l.net - w.rx) * 0.4 + (rand() - 0.5) * l.net);
    w.tx = Math.max(0, w.tx + (l.net * 1.6 - w.tx) * 0.4 + (rand() - 0.5) * l.net * 1.4);
    const s: StatsSample = { at, cpu: Math.round(w.cpu * 10) / 10, mem: Math.round(w.mem * 1024 * 1024), memLimit, rx: Math.round(w.rx * 1024), tx: Math.round(w.tx * 1024), pids: l.pids + (rand() < 0.2 ? 1 : 0) };
    w.samples.push(s);
    if (w.samples.length > STATS_KEPT) w.samples.shift();
    return s;
  };
  const walk = (id: string): Walk => {
    let w = walks.get(id);
    if (!w) {
      const l = loadOf(id);
      w = { samples: [], cpu: l.cpu, mem: l.mem, rx: l.net, tx: l.net };
      walks.set(id, w);
      // A minute of history, so a sparkline opens drawn (main's would fill in over the next minute).
      const now = ctx.now();
      for (let i = 40; i > 0; i--) step(id, w, now - i * STATS_MS);
    }
    return w;
  };
  const tick = () => {
    const at = ctx.now();
    for (const id of watchedStats) if (running(id)) ctx.events.emit('dockerStats', { id, sample: step(id, walk(id), at) });
  };

  // —— the crash ——
  const crash = world.docker.crash;
  let crashing = false;
  const workerId = crash.container.id;
  const broadcast = () => ctx.events.emit('docker', { engine, containers });
  const replace = (c: DockerContainer) => { containers = containers.map((x) => (x.id === c.id ? c : x)); broadcast(); };
  let started = false;
  const playCrash = () => {
    const healthy = byId(workerId);
    if (started || !healthy) return;
    started = true;
    const start = ctx.now();
    // From here on the worker says only what the crash says (its healthy voice would talk between restarts).
    crashing = true;
    writers.get(workerId)?.();
    writers.delete(workerId);
    details.set(workerId, crash.detail);
    let restarts = 0;
    for (const l of crash.lines) ctx.clock.after(l.afterMs, () => push(workerId, append(workerId, [l], ctx.now())));
    const last = crash.events.at(-1)!;
    for (const e of crash.events) {
      ctx.clock.after(e.afterMs, () => {
        const at = ctx.now();
        const entry: DockerEventEntry = { ...e.entry, at };
        events.unshift(entry);
        if (events.length > MAX_EVENTS) events.length = MAX_EVENTS;
        ctx.events.emit('dockerEvent', entry);
        if (e === last) {
          replace({ ...crash.container, startedAt: start + crash.events.filter((x) => x.entry.action === 'start').at(-1)!.afterMs, finishedAt: at });
          ring(workerId).ended = true;
          push(workerId, [], true);
          writers.get(workerId)?.();
          writers.delete(workerId);
          if (ctx.state.settings.dockerNotify) {
            ctx.events.emit('dockerNote', { id: `demo-crash-${at}`, at, container: { id: workerId, name: crash.container.name, project: crash.container.project }, reason: 'crash', exitCode: crash.container.exitCode, line: crash.note });
          }
        } else if (e.entry.action === 'die') replace({ ...healthy, state: 'restarting', restarts, exitCode: null });
        else if (e.entry.action === 'start') replace({ ...healthy, state: 'running', restarts: ++restarts, startedAt: at });
      });
    }
  };
  const autoCrash = ctx.clock.after(CRASH_AFTER_MS, playCrash);

  return {
    snapshot: () => ({ engine, containers }),
    detail(id) {
      const container = byId(id);
      const detail = details.get(id);
      return container && detail ? { container, detail } : null;
    },
    logs(id) {
      if (!byId(id)) return { lines: [], ended: false };
      const r = ring(id);
      return { lines: [...r.lines], ended: r.ended };
    },
    tail(id, n) {
      if (!byId(id)) return [];
      return ring(id).lines.slice(-Math.max(0, n)).map((l, i) => ({ ...l, seq: i + 1 }));
    },
    watchLogs(ids) {
      const next = new Set(ids.filter((id) => byId(id)));
      for (const id of watchedLogs) if (!next.has(id)) { writers.get(id)?.(); writers.delete(id); }
      for (const id of next) {
        if (watchedLogs.has(id) || writers.has(id)) continue;
        const v = voiceOf(id);
        if (!v || !running(id) || (id === workerId && crashing)) continue;
        backfill(id, v);
        write(id, v);
      }
      watchedLogs = next;
    },
    watchStats(ids) {
      watchedStats = new Set(ids.filter(running));
      for (const id of watchedStats) walk(id);
      if (watchedStats.size && !statsTask) statsTask = ctx.clock.every(STATS_MS, tick);
      if (!watchedStats.size && statsTask) { statsTask(); statsTask = null; }
    },
    stats: (ids) => Object.fromEntries(ids.flatMap((id) => { const w = walks.get(id); return w && watchedStats.has(id) ? [[id, [...w.samples]]] : []; })),
    events: () => [...events],
    crashNow() { autoCrash(); playCrash(); }
  };
}
