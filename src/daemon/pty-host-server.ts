import { randomBytes } from 'node:crypto';
import { chmodSync, unlinkSync } from 'node:fs';
import net from 'node:net';
import { z } from 'zod';

/**
 * atelierd's host socket, separate from the app's: the app ↔ atelierd protocol is untouched.
 *
 * 1. atelierd issues a one-time token for a terminal and bootstraps its launchd job.
 * 2. pty-host.js (the job's first image, Atelier's executable) sends {"t":"fetch",token} and gets the launch: the PTY
 *    slave, cwd, file, args and the shell's environment (never written to disk).
 * 3. The native host, on a connection of its own, sends {"t":"hello",token} as soon as it connects, then
 *    {"t":"started",pid,coalition} and {"t":"exit",code,signal} when the shell ends, or {"t":"failed",step,errno} if it
 *    could not start it. Closing after started without "exit" means the host was killed (a force quit of its
 *    coalition): "lost"; closing before started, a failure.
 *
 * A token is fetched once and greeted once; one not fetched, or not greeted after its fetch, in time expires.
 */
export interface HostLaunch { slave: string; cwd: string; file: string; args: string[]; env: Record<string, string> }

export interface HostEvents {
  started(pid: number, coalition: number): void;
  failed(step: number, errno: number): void;
  exit(code: number, signal: number): void;
  lost(): void;
  timeout(): void;
}

const token = z.string().regex(/^[0-9a-f]{32}$/);
const firstLine = z.discriminatedUnion('t', [
  z.strictObject({ t: z.literal('fetch'), token }),
  z.strictObject({ t: z.literal('hello'), token })
]);
const reportLine = z.discriminatedUnion('t', [
  z.strictObject({ t: z.literal('started'), pid: z.number().int().positive(), coalition: z.number().int().nonnegative() }),
  z.strictObject({ t: z.literal('failed'), step: z.number().int(), errno: z.number().int() })
]);
const exitLine = z.strictObject({ t: z.literal('exit'), code: z.number().int(), signal: z.number().int() });

const MAX_LINE = 4096;
const HEADER_MS = 2000;

interface Issued {
  launch: HostLaunch;
  events: HostEvents;
  state: 'issued' | 'fetched' | 'reporting' | 'done';
  timer: NodeJS.Timeout | null;
  reportMs: number;
}

export class PtyHostServer {
  private readonly issued = new Map<string, Issued>();
  private readonly sockets = new Set<net.Socket>();

  private constructor(private readonly server: net.Server, private readonly sock: string, private readonly log: (m: string) => void) {}

  static start(sock: string, log: (m: string) => void): Promise<PtyHostServer> {
    try { unlinkSync(sock); } catch { /* no stale socket */ }
    const server = net.createServer();
    const self = new PtyHostServer(server, sock, log);
    server.on('connection', (s) => self.accept(s));
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(sock, () => {
        server.off('error', reject);
        chmodSync(sock, 0o600);
        resolve(self);
      });
    });
  }

  issue(launch: HostLaunch, events: HostEvents, o: { fetchMs?: number; reportMs?: number } = {}): { token: string; revoke(): void } {
    const t = randomBytes(16).toString('hex');
    const entry: Issued = { launch, events, state: 'issued', timer: null, reportMs: o.reportMs ?? 10_000 };
    this.issued.set(t, entry);
    this.arm(t, entry, o.fetchMs ?? 10_000);
    return { token: t, revoke: () => this.spend(t) };
  }

  private arm(t: string, e: Issued, ms: number): void {
    if (e.timer) clearTimeout(e.timer);
    e.timer = setTimeout(() => {
      if (this.issued.get(t) !== e || (e.state !== 'issued' && e.state !== 'fetched')) return;
      this.spend(t);
      e.events.timeout();
    }, ms);
    e.timer.unref?.();
  }

  private spend(t: string): void {
    const e = this.issued.get(t);
    if (!e) return;
    if (e.timer) clearTimeout(e.timer);
    e.state = 'done';
    this.issued.delete(t);
  }

  private accept(s: net.Socket): void {
    this.sockets.add(s);
    s.on('close', () => this.sockets.delete(s));
    s.on('error', () => { /* handled by close */ });
    s.setEncoding('utf8');
    let buf = '';
    // A report connection: bound to its terminal by hello, then started (or failed), then exit.
    let report: Issued | null = null;
    let phase: 'hello' | 'started' | 'over' = 'hello';
    const header = setTimeout(() => s.destroy(), HEADER_MS);
    s.on('close', () => {
      clearTimeout(header);
      if (!report) return;
      // Gone before saying whether the shell started: a host that died (fallback); after, a host killed (force quit).
      if (phase === 'hello') report.events.failed(-1, 0);
      else if (phase === 'started') report.events.lost();
    });
    s.on('data', (chunk: string) => {
      buf += chunk;
      if (buf.length > MAX_LINE && !buf.includes('\n')) { s.destroy(); return; }
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        let raw: unknown;
        try { raw = JSON.parse(line); } catch { s.destroy(); return; }
        if (report) {
          if (phase === 'hello') {
            const m = reportLine.safeParse(raw);
            if (!m.success) { s.destroy(); return; }
            if (m.data.t === 'failed') { phase = 'over'; report.events.failed(m.data.step, m.data.errno); s.end(); return; }
            phase = 'started';
            report.events.started(m.data.pid, m.data.coalition);
            continue;
          }
          const x = exitLine.safeParse(raw);
          if (phase !== 'started' || !x.success) { s.destroy(); return; }
          phase = 'over';
          report.events.exit(x.data.code, x.data.signal);
          continue;
        }
        clearTimeout(header);
        const m = firstLine.safeParse(raw);
        const e = m.success ? this.issued.get(m.data.token) : undefined;
        if (!m.success || !e) { s.destroy(); return; }
        if (m.data.t === 'fetch') {
          if (e.state !== 'issued') { s.destroy(); return; }
          e.state = 'fetched';
          this.arm(m.data.token, e, e.reportMs);
          s.end(JSON.stringify({ t: 'launch', ...e.launch }) + '\n');
          return;
        }
        // hello: the native host is alive and owns this connection; no timer applies any more (fork and exec may be
        // slow under load), its closing says what happened.
        if (e.state !== 'fetched') { s.destroy(); return; }
        this.spend(m.data.token);
        e.state = 'reporting';
        report = e;
      }
    });
  }

  close(): Promise<void> {
    for (const [t] of this.issued) this.spend(t);
    for (const s of this.sockets) s.destroy();
    return new Promise((r) => this.server.close(() => {
      try { unlinkSync(this.sock); } catch { /* already gone */ }
      r();
    }));
  }
}
