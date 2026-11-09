import { closeSync, write as fsWrite } from 'node:fs';
import { basename } from 'node:path';
import tty from 'node:tty';
import { jobPlist, type Launchd } from './launchd';
import type { PtyHostServer } from './pty-host-server';
import type { PtyNative } from './pty-native';

/**
 * A terminal's process as TerminalManager uses it: node-pty's IPty, or an isolated terminal (below) with the same
 * surface. Isolated terminals learn the shell's pid a moment after they are created (onPid).
 */
export interface PtyProcess {
  readonly pid: number;
  readonly process: string;
  onData(listener: (data: string) => void): { dispose(): void };
  onExit(listener: (e: { exitCode: number | undefined; signal?: number }) => void): { dispose(): void };
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
  onPid?(listener: (pid: number) => void): { dispose(): void };
}

/** Where an isolated terminal's job starts: Atelier's executable, pty-host.js, the native host (copies in bin/). */
export interface IsolationConfig { execPath: string; hostScript: string; nativeHost: string }

export interface PtySpawnOptions { name: string; cols: number; rows: number; cwd: string; env: Record<string, string>; encoding: 'utf8' }
export type SpawnPty = (file: string, args: string[], o: PtySpawnOptions) => PtyProcess;
/** A spawner for one terminal (its id names its launchd job). */
export type SpawnFor = (id: string) => SpawnPty;

export interface IsolationDeps {
  launchd: Pick<Launchd, 'bootstrap' | 'bootout'>;
  server: Pick<PtyHostServer, 'issue'>;
  native: PtyNative;
  /** The terminal's job label. */
  label(id: string): string;
  /** The job's argv for a token: [Atelier's executable, pty-host.js, native host, host socket, token]. */
  program(token: string): string[];
  /** Where the job's own errors go (atelierd's log). */
  stderr: string;
  /** node-pty's spawn: the fallback when launchd can't start the host. */
  direct: SpawnPty;
  kill(pid: number, signal: string): void;
  log(message: string): void;
}

// node-pty waits this long for the PTY to close after the shell's exit (an orphan may hold the tty open).
const CLOSE_GRACE_MS = 200;
// A shell that can't start because of its own launch (step 15: cwd, 16: exec) ends like node-pty's spawn-helper did.
const USER_FAILURES = new Set([15, 16]);

/**
 * Spawns terminals as launchd jobs. If launchd can't start one (bootstrap error, the host
 * never reports), that terminal falls back to node-pty with its input and size replayed, and so does every later one:
 * a terminal always opens; the log says why isolation stopped.
 */
export function isolatedSpawner(deps: IsolationDeps): SpawnFor {
  let disabled: string | null = null;
  const disable = (reason: string) => {
    if (disabled) return;
    disabled = reason;
    deps.log(`terminal isolation off, falling back to direct spawn: ${reason}`);
  };
  return (id) => (file, args, o) => (disabled ? deps.direct(file, args, o) : new IsolatedPty(id, file, args, o, deps, disable));
}

type Exit = { exitCode: number | undefined; signal?: number };

class IsolatedPty implements PtyProcess {
  private readonly dataListeners = new Set<(d: string) => void>();
  private readonly exitListeners = new Set<(e: Exit) => void>();
  private readonly pidListeners = new Set<(pid: number) => void>();
  private readonly master: number;
  private slave: number | null;
  private readonly reader: tty.ReadStream;
  private readonly writes: Buffer[] = [];
  private writing = false;
  private queued: string[] | null = [];
  private shellPid = 0;
  private delegate: PtyProcess | null = null;
  private pendingKill: string | null = null;
  /** Falling back to node-pty: the host's late events are ignored. */
  private fallingBack = false;
  private exit: Exit | null = null;
  /** The master fd is closed (EIO or teardown): its number may already be reused, nothing touches it any more. */
  private masterClosed = false;
  private finished = false;
  private graceTimer: NodeJS.Timeout | null = null;
  private size: [number, number];
  private readonly label: string;
  private readonly revoke: () => void;

  constructor(private readonly id: string, private readonly file: string, private readonly args: string[], private readonly o: PtySpawnOptions, private readonly deps: IsolationDeps, private readonly disable: (reason: string) => void) {
    this.size = [o.cols, o.rows];
    this.label = deps.label(id);
    const pair = deps.native.open(o.cols, o.rows);
    this.master = pair.master;
    // Held until the shell has it: with no slave open, the master reads EOF.
    this.slave = pair.slave;
    this.reader = new tty.ReadStream(pair.master);
    this.reader.setEncoding('utf8');
    this.reader.on('data', (d: string) => { for (const l of this.dataListeners) l(d); });
    this.reader.on('error', (err: NodeJS.ErrnoException) => {
      // As node-pty: EAGAIN comes and goes; EIO means every slave fd closed.
      if (err.code === 'EAGAIN') return;
      this.onMasterClosed();
    });
    this.reader.on('close', () => this.onMasterClosed());
    const env = { ...o.env, PWD: o.cwd, TERM: o.name };
    const issued = deps.server.issue({ slave: pair.pty, cwd: o.cwd, file, args, env }, {
      started: (pid, coalition) => this.onStarted(pid, coalition),
      failed: (step, errno) => this.onFailed(step, errno),
      exit: (code, signal) => this.onExitReport({ exitCode: code, signal }),
      lost: () => this.onExitReport({ exitCode: undefined }),
      timeout: () => this.fallback('the host did not start in time')
    });
    this.revoke = issued.revoke;
    const plist = jobPlist({ label: this.label, program: deps.program(issued.token), env: { ELECTRON_RUN_AS_NODE: '1' }, stderr: deps.stderr });
    deps.launchd.bootstrap(this.label, plist).catch((err: Error) => this.fallback(err.message));
  }

  get pid(): number { return this.delegate ? this.delegate.pid : this.shellPid; }

  get process(): string {
    if (this.delegate) return this.delegate.process;
    // Not attached yet: the shell is what will be in front.
    if (!this.shellPid || this.finished || this.masterClosed) return basename(this.file);
    // Then exactly node-pty's answer on macOS: the foreground group leader's name, undefined when that leader already
    // exited (a pipeline's first command: the app relies on it), the file when the kernel names pid 0.
    let name: string | undefined;
    try { name = this.deps.native.process(this.master); } catch { name = undefined; }
    return (name !== 'kernel_task' ? name : this.file) as string;
  }

  onData(l: (d: string) => void) { this.dataListeners.add(l); return { dispose: () => { this.dataListeners.delete(l); } }; }
  onExit(l: (e: Exit) => void) { this.exitListeners.add(l); return { dispose: () => { this.exitListeners.delete(l); } }; }
  onPid(l: (pid: number) => void) { this.pidListeners.add(l); return { dispose: () => { this.pidListeners.delete(l); } }; }

  write(data: string): void {
    if (this.delegate) { this.delegate.write(data); return; }
    if (this.finished || this.masterClosed) return;
    if (this.queued) { this.queued.push(data); return; }
    this.writeMaster(Buffer.from(data, 'utf8'));
  }

  resize(cols: number, rows: number): void {
    this.size = [cols, rows];
    if (this.delegate) { this.delegate.resize(cols, rows); return; }
    if (!this.finished && !this.masterClosed) this.deps.native.resize(this.master, cols, rows);
  }

  kill(signal = 'SIGHUP'): void {
    if (this.delegate) { this.delegate.kill(signal); return; }
    if (this.finished) return;
    if (this.fallingBack) { this.pendingKill = signal; return; }
    if (this.shellPid) { try { this.deps.kill(this.shellPid, signal); } catch { /* already gone */ } return; }
    this.pendingKill = signal;
  }

  private onStarted(pid: number, coalition: number): void {
    if (this.finished || this.delegate || this.fallingBack) return;
    this.shellPid = pid;
    this.closeSlave();
    this.deps.log(`terminal ${this.id}: shell ${pid} started in launchd job, coalition ${coalition}`);
    const queued = this.queued ?? [];
    this.queued = null;
    for (const d of queued) this.writeMaster(Buffer.from(d, 'utf8'));
    for (const l of this.pidListeners) l(pid);
    if (this.pendingKill) { const s = this.pendingKill; this.pendingKill = null; this.kill(s); }
  }

  private onFailed(step: number, errno: number): void {
    if (this.fallingBack) return;
    if (USER_FAILURES.has(step)) { this.onExitReport({ exitCode: 1 }); this.closeSlave(); return; }
    this.fallback(`the host failed at step ${step} (errno ${errno})`);
  }

  private onExitReport(e: Exit): void {
    if (this.finished || this.exit || this.fallingBack) return;
    this.exit = e;
    if (this.masterClosed) { this.finish(); return; }
    this.graceTimer = setTimeout(() => this.finish(), CLOSE_GRACE_MS);
  }

  private onMasterClosed(): void {
    if (this.masterClosed) return;
    this.masterClosed = true;
    this.writes.length = 0;
    if (this.exit) this.finish();
  }

  /**
   * Launchd could not start this terminal: node-pty starts it instead, with what was typed and the current size. The
   * job is booted out first, so a host that is late (not dead) can never open this PTY once its number is reused.
   */
  private fallback(reason: string): void {
    if (this.finished || this.delegate || this.shellPid || this.fallingBack) return;
    this.fallingBack = true;
    this.revoke();
    this.disable(reason);
    void this.deps.launchd.bootout(this.label).catch(() => false).then(() => {
      this.teardown(false);
      if (this.pendingKill) { this.finished = true; this.emitExit({ exitCode: undefined }); return; }
      const d = this.deps.direct(this.file, this.args, this.o);
      this.delegate = d;
      d.onData((data) => { for (const l of this.dataListeners) l(data); });
      d.onExit((e) => this.emitExit(e));
      const queued = this.queued ?? [];
      this.queued = null;
      for (const q of queued) d.write(q);
      if (this.size[0] !== this.o.cols || this.size[1] !== this.o.rows) d.resize(this.size[0], this.size[1]);
      for (const l of this.pidListeners) l(d.pid);
    });
  }

  private finish(): void {
    if (this.finished) return;
    this.finished = true;
    this.teardown();
    this.emitExit(this.exit ?? { exitCode: undefined });
  }

  private emitExit(e: Exit): void {
    for (const l of this.exitListeners) l(e);
  }

  private teardown(bootout = true): void {
    if (this.graceTimer) { clearTimeout(this.graceTimer); this.graceTimer = null; }
    this.closeSlave();
    this.reader.destroy();
    this.writes.length = 0;
    if (bootout) void this.deps.launchd.bootout(this.label).catch(() => { /* already gone */ });
  }

  private closeSlave(): void {
    if (this.slave === null) return;
    try { closeSync(this.slave); } catch { /* closed */ }
    this.slave = null;
  }

  // node-pty's CustomWriteStream: writes straight to the fd, in order, retrying on EAGAIN (the master is non-blocking).
  private writeMaster(buf: Buffer): void {
    if (buf.length === 0) return;
    this.writes.push(buf);
    if (!this.writing) this.drain();
  }

  private drain(): void {
    const next = this.writes[0];
    if (!next || this.finished || this.masterClosed) { this.writing = false; return; }
    this.writing = true;
    fsWrite(this.master, next, 0, next.length, null, (err, written) => {
      if (err) {
        if (err.code === 'EAGAIN') { setImmediate(() => this.drain()); return; }
        this.writes.length = 0;
        this.writing = false;
        return;
      }
      if (written < next.length) this.writes[0] = next.subarray(written); else this.writes.shift();
      this.drain();
    });
  }
}
