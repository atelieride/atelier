// SSH tunnels for the Databases view: the system's own `ssh` forwards a free port on
// 127.0.0.1 to the database as the bastion host sees it, and the client connects there. The only process the view
// starts: spawn with an argv (never a shell), BatchMode (keys or the agent, never a prompt); the user's ~/.ssh/config
// and agent apply, so a host alias works (port and user may be left to it). Ready once 127.0.0.1:<local>
// takes a connection (ssh listens there only after signing in); ssh exiting first is a DbError of kind 'ssh' carrying
// its last stderr line. close() stops it: SIGTERM, then SIGKILL 2 s later if it is still there. A tunnel
// whose ssh exits on its own marks itself closed; the session through it is lost with it, and the hub's reconnect opens
// a new tunnel. Every ssh still running is known here: closeAllTunnels() stops them on quit (one still opening
// included), and whatever is left when the process exits gets SIGKILL.
import { spawn, type ChildProcess } from 'node:child_process';
import { connect, createServer, type AddressInfo } from 'node:net';
import type { DbSsh } from '@shared/databases';
import { DbError, type Tunnel, type TunnelFactory } from './driver';

export type { Tunnel, TunnelFactory };

/** How long ssh has to open the forward, signing in included. */
const READY_MS = 8000;
/** How often the local port is tried meanwhile. */
const POLL_MS = 100;
/** close(): SIGKILL this long after a SIGTERM ssh ignored. */
const KILL_MS = 2000;
/** After ssh exits, how long its last stderr may take to arrive. */
const STDERR_WAIT_MS = 250;
/** After a forwarded connection failed, how long ssh's line about it may take to arrive. */
const CHANNEL_WAIT_MS = 100;
/** How much of ssh's stderr is kept: its tail, plenty for the last lines. */
export const STDERR_MAX = 4096;
/** OpenSSH's last line, under BatchMode, for a host whose key isn't in known_hosts (or changed). */
const HOST_KEY_LINE = 'Host key verification failed.';
export const HOST_KEY_MESSAGE = 'Host key verification failed. Connect once with ssh in a terminal to trust this host.';
const CLOSED_MESSAGE = 'The SSH tunnel was closed';
/** OpenSSH's line for a forwarded connection the bastion couldn't open: `channel 2: open failed: connect failed: …`. */
const CHANNEL_FAILED = /^channel \d+: open failed: (.+)$/;

/**
 * The schema checks the same (connection-schema.ts): a host is a host name, a ~/.ssh/config
 * alias or an IPv4 address ([A-Za-z0-9._-], no leading '-': ssh would read it as an option, `-oProxyCommand=…` runs a
 * command; '_' for aliases and compose service names) or an IPv6 literal (hex digits, ':', '.', an optional %zone); a
 * user is [A-Za-z0-9._-] with no leading '-', or ''.
 */
const HOST = /^(?:[A-Za-z0-9._][A-Za-z0-9._-]*|(?=[^%]*:)[0-9A-Fa-f:.]+(?:%[A-Za-z0-9]+)?)$/;
const USER = /^(?:[A-Za-z0-9._][A-Za-z0-9._-]*)?$/;
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;

const validHost = (h: string) => h.length <= 255 && HOST.test(h);
const validPort = (p: number) => Number.isInteger(p) && p >= 1 && p <= 65535;

/**
 * ssh's argv for a tunnel from 127.0.0.1:localPort to `target` through `ssh`. `--` ends ssh's options (its getopt stops
 * there), so the destination is never read as one; the schema refused a bad host or user already, this refuses them
 * again (RangeError) whatever the caller. A null port and an empty user are left to ~/.ssh/config (no -p, the host
 * alone). Never a ControlMaster, whatever ~/.ssh/config says: joining the user's master would put the
 * forward inside that process, which close() can't stop, and becoming one (ControlMaster auto + ControlPersist) would
 * leave the bastion connection open after the tunnel closed.
 */
export function sshArgs(ssh: DbSsh, target: { host: string; port: number }, localPort: number): string[] {
  if (!validHost(ssh.host)) throw new RangeError('The SSH host must be a host name or an IP address');
  if (ssh.user.length > 128 || !USER.test(ssh.user)) throw new RangeError("The SSH user may hold letters, digits, '.', '_' and '-' (not first)");
  if (!validHost(target.host)) throw new RangeError('Through an SSH tunnel, the database host must be a host name or an IP address');
  if (![...(ssh.port === null ? [] : [ssh.port]), target.port, localPort].every(validPort)) throw new RangeError('Ports are 1–65535');
  const to = target.host.includes(':') ? `[${target.host}]` : target.host;
  return [
    '-N', '-L', `127.0.0.1:${localPort}:${to}:${target.port}`, ...(ssh.port === null ? [] : ['-p', String(ssh.port)]),
    '-o', 'BatchMode=yes', '-o', 'ExitOnForwardFailure=yes', '-o', 'ConnectTimeout=8', '-o', 'ServerAliveInterval=30',
    '-o', 'ControlMaster=no', '-o', 'ControlPath=none',
    '--', ssh.user ? `${ssh.user}@${ssh.host}` : ssh.host
  ];
}

/** The system's ssh: /usr/bin/ssh, or Windows' OpenSSH client under %SystemRoot%. */
export function sshBinary(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string {
  if (platform === 'win32') return `${(env.SystemRoot || 'C:\\Windows').replace(/[\\/]+$/, '')}\\System32\\OpenSSH\\ssh.exe`;
  return '/usr/bin/ssh';
}

/** stderr's lines, control characters dropped, blank ones left out. */
const linesOf = (stderr: string): string[] => stderr.split(/\r\n|\r|\n/).map((l) => l.replace(CONTROL, '').trim()).filter(Boolean);

/** What the view shows when ssh exits before the tunnel opens: its last stderr line, or how it ended. */
export function sshFailure(stderr: string, code: number | null, signal: NodeJS.Signals | null): string {
  const lines = linesOf(stderr);
  if (lines.includes(HOST_KEY_LINE)) return HOST_KEY_MESSAGE;
  const last = lines.at(-1);
  if (last) return last;
  return signal ? `ssh stopped (${signal})` : `ssh exited with code ${code ?? '?'}`;
}

/** Why ssh couldn't open its last forwarded connection (`channel N: open failed: <reason>`), or null. */
export function channelFailure(stderr: string): string | null {
  for (const line of linesOf(stderr).reverse()) {
    const m = CHANNEL_FAILED.exec(line);
    if (m) return m[1]!;
  }
  return null;
}

/** stderr so far plus a new chunk, cut to its last STDERR_MAX characters. */
export const keepTail = (kept: string, chunk: string): string => (kept + chunk).slice(-STDERR_MAX);

export function readyTimeoutMessage(readyMs: number): string {
  const s = readyMs / 1000;
  return `The SSH tunnel didn't open in ${Number.isInteger(s) ? s : s.toFixed(1)} s`;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** A port free on 127.0.0.1 now (bound, then released for ssh: ExitOnForwardFailure ends ssh if another took it). */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen({ host: '127.0.0.1', port: 0, exclusive: true }, () => {
      const { port } = srv.address() as AddressInfo;
      srv.close(() => resolve(port));
    });
  });
}

/** Whether 127.0.0.1:port takes a connection now (closed at once). */
function accepts(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = connect({ host: '127.0.0.1', port });
    const done = (ok: boolean) => {
      s.removeAllListeners();
      s.on('error', () => {});
      s.destroy();
      resolve(ok);
    };
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
    s.setTimeout(1000, () => done(false));
  });
}

/** Every ssh started and not yet ended: from spawn to its exit. */
const live = new Set<SshTunnel>();
let exitHooked = false;

/** Stops every ssh still running, tunnels still opening included (quit): SIGTERM now, SIGKILL 2 s later. */
export function closeAllTunnels(): void {
  for (const t of [...live]) t.close();
}

/**
 * SIGKILL to every ssh still running, synchronously: what process 'exit' runs, when no timer will fire any more
 * (close()'s SIGKILL included).
 */
export function killLiveTunnels(): void {
  for (const t of live) t.kill();
}

class SshTunnel implements Tunnel {
  private readonly child: ChildProcess;
  /** How ssh ended (its own exit, a signal, or a failed start); null while it runs. */
  private ended: { code: number | null; signal: NodeJS.Signals | null; failure: string | null } | null = null;
  private readonly exited: Promise<void>;
  private readonly stderrDone: Promise<void>;
  private stderr = '';
  private stopped = false;

  constructor(private readonly bin: string, args: string[], readonly localPort: number) {
    this.child = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    live.add(this);
    if (!exitHooked) {
      exitHooked = true;
      process.on('exit', killLiveTunnels);
    }
    const err = this.child.stderr!;
    err.setEncoding('utf8');
    err.on('data', (d: string) => { this.stderr = keepTail(this.stderr, d); });
    this.stderrDone = new Promise((r) => { err.once('close', r); err.on('error', () => r()); });
    this.exited = new Promise((resolve) => {
      this.child.once('exit', (code, signal) => {
        this.ended ??= { code, signal, failure: null };
        live.delete(this);
        resolve();
      });
      // No process at all (ENOENT: not installed); after a start, 'error' only reports a failed kill (kept listened to:
      // an 'error' event nobody listens to would throw in the main process).
      this.child.on('error', (e: NodeJS.ErrnoException) => {
        if (this.child.pid !== undefined) return;
        this.ended ??= { code: null, signal: null, failure: e.code === 'ENOENT' ? `ssh isn't installed (${this.bin})` : `Can't run ssh (${this.bin}): ${e.code ?? e.message}` };
        live.delete(this);
        resolve();
      });
    });
  }

  get closed(): boolean { return this.stopped || this.ended !== null; }

  /** Resolves once the forward takes connections; rejects (kind 'ssh') if ssh ends or is closed first, or readyMs passes. */
  async open(readyMs: number): Promise<void> {
    const deadline = Date.now() + readyMs;
    for (;;) {
      if (this.stopped) throw new DbError({ kind: 'ssh', message: CLOSED_MESSAGE });
      if (this.ended) throw new DbError({ kind: 'ssh', message: await this.why() });
      if ((await accepts(this.localPort)) && !this.ended && !this.stopped) return;
      if (this.ended || this.stopped) continue;
      if (Date.now() >= deadline) {
        this.close();
        throw new DbError({ kind: 'ssh', message: readyTimeoutMessage(readyMs) });
      }
      await Promise.race([sleep(POLL_MS), this.exited]);
    }
  }

  close(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.ended) return;
    this.child.kill('SIGTERM');
    const kill = setTimeout(() => this.kill(), KILL_MS);
    kill.unref();
    void this.exited.then(() => clearTimeout(kill));
  }

  /** SIGKILL now, if ssh is still running. */
  kill(): void {
    this.stopped = true;
    if (!this.ended) this.child.kill('SIGKILL');
  }

  async lastError(): Promise<string | null> {
    await sleep(CHANNEL_WAIT_MS);
    return channelFailure(this.stderr);
  }

  private async why(): Promise<string> {
    const e = this.ended!;
    if (e.failure) return e.failure;
    // 'exit' can come before the last of stderr has been read.
    await Promise.race([this.stderrDone, sleep(STDERR_WAIT_MS)]);
    return sshFailure(this.stderr, e.code, e.signal);
  }
}

/** Opens tunnels with `bin` (sshBinary's, or a test's fake through ATELIER_TEST_SSH_BIN). */
export function createTunnelFactory(o: { bin: string; readyMs?: number }): TunnelFactory {
  const readyMs = o.readyMs ?? READY_MS;
  return async (ssh, target) => {
    let args: string[];
    let localPort: number;
    try {
      localPort = await freePort();
      args = sshArgs(ssh, target, localPort);
    } catch (e) {
      throw new DbError({ kind: 'ssh', message: e instanceof Error ? e.message : String(e) });
    }
    const tunnel = new SshTunnel(o.bin, args, localPort);
    await tunnel.open(readyMs);
    return tunnel;
  };
}
