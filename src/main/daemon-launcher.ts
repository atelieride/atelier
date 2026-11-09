import { execFileSync, spawn } from 'node:child_process';
import { appendFileSync, closeSync, openSync, readFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { daemonPaths } from '@shared/paths.node';
import { currentPlatform } from '@shared/platform';
import { encode, LineDecoder, type DaemonInfo } from '@shared/protocol';
import { ensureRuntime, pruneRuntimes } from './runtime-copy';
import { ensureDir } from '../daemon/fsutil';
import { Launchd, jobLabel, jobPlist } from '../daemon/launchd';

export function readDaemonInfo(infoPath: string): DaemonInfo | null {
  try {
    const raw = JSON.parse(readFileSync(infoPath, 'utf8')) as Partial<DaemonInfo>;
    if (typeof raw.sock !== 'string' || typeof raw.token !== 'string' || typeof raw.pid !== 'number') return null;
    return raw as DaemonInfo;
  } catch {
    return null;
  }
}

function canConnect(sock: string): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.createConnection(sock);
    const done = (v: boolean) => { s.destroy(); resolve(v); };
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
    setTimeout(() => done(false), 1000);
  });
}

/** XML 1.0 text can't hold most control characters, and launchd reads \r as \n: such a variable stays out of the plist. */
const plistSafe = (v: string): boolean => !/[\u0000-\u0008\u000b\u000c\u000d\u000e-\u001f\ufffe\uffff]/.test(v);

/** What the launcher needs from launchd (daemon/launchd.ts; a fake in tests). */
export type LauncherLaunchd = Pick<Launchd, 'bootstrap' | 'bootout' | 'jobState'>;

/**
 * Returns the live service; if there is none, starts it and waits until it is ready. atelierd runs as a launchd job of
 * its own: its own coalition, so a force quit of the Atelier window (or of an app that
 * shares the window's coalition) never ends the sessions. If launchd refuses, or this home's job is somehow still
 * running without answering, it is spawned detached as before: never booted out from here, its sessions would close.
 */
export async function ensureDaemon(o: {
  execPath: string; script: string; version: string; home?: string; timeoutMs?: number; launchd?: LauncherLaunchd | null;
  /** Windows: a packaged app runs atelierd from a runtime copy named by the daemon's fingerprint. */
  packaged?: boolean; fingerprint?: string;
}): Promise<DaemonInfo> {
  const paths = daemonPaths(o.home);
  const current = readDaemonInfo(paths.info);
  if (current && (await canConnect(current.sock))) return current;

  ensureDir(paths.home, 0o700);
  ensureDir(paths.logDir, 0o700);
  const env: NodeJS.ProcessEnv = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };
  if (o.home) env.ATELIER_HOME = o.home;
  const argv = [o.script, `--version=${o.version}`];
  const log = (msg: string) => {
    try { appendFileSync(paths.log, `${new Date().toISOString()} launcher: ${msg}\n`, { mode: 0o600 }); } catch { /* no log */ }
  };

  if (currentPlatform() === 'win32') {
    const runtimeRoot = path.win32.join(paths.home, 'runtime');
    const fingerprint = o.fingerprint ?? 'dev';
    const info = await startWindowsDaemon({
      execPath: o.execPath, script: o.script, args: argv.slice(1), env, packaged: !!o.packaged, fingerprint, runtimeRoot,
      hop: spawnHop, log,
      waitReady: (ms) => waitForInfo(paths.info, current?.startedAt, ms)
    });
    // The copies no daemon of this home runs from any more go (an update left them behind).
    pruneRuntimes(runtimeRoot, [fingerprint, ...(info.runtime ? [path.win32.basename(info.runtime)] : [])]);
    return info;
  }

  let viaLaunchd = false;
  const launchd = o.launchd === undefined ? new Launchd({ runDir: paths.run }) : o.launchd;
  if (launchd) {
    const label = jobLabel('atelierd', paths.home);
    try {
      // After a restart the old atelierd may still be exiting: give its job a moment to stop.
      let state = await launchd.jobState(label);
      for (let i = 0; state === 'running' && i < 20; i++) {
        await new Promise((r) => setTimeout(r, 100));
        state = await launchd.jobState(label);
      }
      // Only an explicit "stopped" is booted out: a running job holds sessions, an unknown state may be one.
      if (state === 'running') throw new Error('its job is running but does not answer');
      if (state === 'unknown') throw new Error('launchd did not tell whether its job runs');
      if (state === 'stopped') await launchd.bootout(label);
      const vars = Object.fromEntries(Object.entries(env).filter((e): e is [string, string] => typeof e[1] === 'string' && plistSafe(e[0]) && plistSafe(e[1])));
      try {
        await launchd.bootstrap(label, jobPlist({ label, program: [o.execPath, ...argv], env: vars, stdout: paths.log, stderr: paths.log }));
      } catch (err) {
        // launchd may have taken the job before failing (a timeout): never let it start next to a directly spawned one.
        await launchd.bootout(label).catch(() => false);
        throw err;
      }
      viaLaunchd = true;
    } catch (err) {
      try { appendFileSync(paths.log, `${new Date().toISOString()} launcher: launchd job not started (${(err as Error).message}): spawned directly\n`, { mode: 0o600 }); } catch { /* no log */ }
    }
  }
  if (!viaLaunchd) {
    const out = openSync(paths.log, 'a', 0o600);
    // Detached and unrelated to the app: closing Atelier must not close the sessions.
    const child = spawn(o.execPath, argv, { detached: true, windowsHide: true, stdio: ['ignore', out, out], env });
    child.unref();
    // The child already has its own copy of the descriptor: this one must be closed, or every attempt leaves one open.
    closeSync(out);
  }

  const info = await waitForInfo(paths.info, current?.startedAt, o.timeoutMs ?? 8000);
  if (info) return info;
  throw new Error('atelierd did not start: see the log in ' + paths.log);
}

/** The new atelierd's info, once it is written (another start than `before`) and its socket or pipe answers. */
async function waitForInfo(infoPath: string, before: number | undefined, ms: number): Promise<DaemonInfo | null> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
    const info = readDaemonInfo(infoPath);
    if (info && info.startedAt !== before && (await canConnect(info.sock))) return info;
  }
  return null;
}

/** How atelierd starts on Windows; the side effects are given, so the order of tries is tested anywhere. */
export interface WindowsStart {
  execPath: string; script: string; args: string[]; env: NodeJS.ProcessEnv;
  packaged: boolean; fingerprint: string; runtimeRoot: string;
  /** Makes (or reuses) the runtime copy; `keyFiles`: what atelierd runs from, relative to the package. */
  copy?: (src: string, root: string, fp: string, keyFiles: readonly string[]) => string;
  hop(exec: string, args: string[], env: NodeJS.ProcessEnv): void;
  waitReady(ms: number): Promise<DaemonInfo | null>;
  log(msg: string): void;
}

/**
 * Windows: a packaged app starts atelierd from its runtime copy (the Store package's
 * files stay free for updates), the script at the same place inside the copy; when the copy can't be made, or its
 * atelierd doesn't come up (Smart App Control blocks an unsigned copy), from the package itself. A development run
 * starts in place.
 */
export async function startWindowsDaemon(s: WindowsStart): Promise<DaemonInfo> {
  const w = path.win32;
  const pkgDir = w.dirname(s.execPath);
  let exec = s.execPath;
  let script = s.script;
  if (s.packaged) {
    try {
      // A copy that lost one of these since (an antivirus quarantining the bridge) is made again.
      const keys = [w.basename(s.execPath), w.relative(pkgDir, s.script), w.join('resources', 'bin', 'atelier-bridge.exe')];
      const rt = s.copy ? s.copy(pkgDir, s.runtimeRoot, s.fingerprint, keys) : ensureRuntime(pkgDir, s.runtimeRoot, s.fingerprint, undefined, keys);
      exec = w.join(rt, w.basename(s.execPath));
      script = w.join(rt, w.relative(pkgDir, s.script));
    } catch (err) {
      s.log(`runtime copy not made (${(err as Error).message}): atelierd runs from the package`);
    }
  }
  s.hop(exec, [script, ...s.args], s.env);
  // A copy's first start may be slow (an antivirus scanning the fresh files): it gets longer than the package.
  const fromCopy = exec !== s.execPath;
  const info = await s.waitReady(fromCopy ? 20_000 : 8000);
  if (info) return info;
  if (fromCopy) {
    // Should the copy's atelierd still come up, the first one to listen serves and the other leaves.
    s.log(`atelierd did not answer from its runtime copy ${w.dirname(exec)} within 20 s (blocked?): starting it from the package`);
    s.hop(s.execPath, [s.script, ...s.args], s.env);
    const again = await s.waitReady(8000);
    if (again) return again;
  }
  throw new Error('atelierd did not start: see its log in ATELIER_HOME\\logs');
}

// The middle process: spawns atelierd detached and exits, so nothing links atelierd to the app's process tree (it
// survives Task Manager's "End task" and `taskkill /T` on the app).
const HOP = "require('child_process').spawn(process.argv[1], JSON.parse(process.argv[2]), { detached: true, stdio: 'ignore', windowsHide: true }).unref()";

function spawnHop(exec: string, args: string[], env: NodeJS.ProcessEnv): void {
  spawn(exec, ['-e', HOP, exec, JSON.stringify(args)], { detached: true, stdio: 'ignore', windowsHide: true, env: { ...env, ELECTRON_RUN_AS_NODE: '1' } }).unref();
}

/**
 * Asks an atelierd to stop with the `stop` header: its control token only, whatever protocol
 * version it speaks. True once it answers that it stops.
 */
export function requestStop(info: Pick<DaemonInfo, 'sock' | 'token'>, timeoutMs = 3000): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.createConnection(info.sock);
    const dec = new LineDecoder();
    let done = false;
    const finish = (v: boolean) => { if (done) return; done = true; clearTimeout(timer); s.destroy(); resolve(v); };
    const timer = setTimeout(() => finish(false), timeoutMs);
    s.setEncoding('utf8');
    s.on('connect', () => s.write(encode({ t: 'stop', token: info.token })));
    s.on('data', (chunk: string) => { for (const line of dec.push(chunk)) if (line.includes('"stopping"')) finish(true); });
    s.on('close', () => finish(false));
    s.on('error', () => finish(false));
  });
}

function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/** Is the process really an atelierd (launched with the service script)? A reused pid must not be touched. */
function isAtelierd(pid: number): boolean {
  if (pid === process.pid) return false;
  try {
    return execFileSync('/bin/ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' }).includes('daemon.js');
  } catch {
    return false;
  }
}

/**
 * Stops an atelierd that doesn't speak this app's protocol (it accepts no requests, not even shutdown):
 * SIGTERM, which makes it save the registry and close the terminals like a normal shutdown.
 */
export async function stopStaleDaemon(infoPath: string, timeoutMs = 5000): Promise<boolean> {
  const info = readDaemonInfo(infoPath);
  // Windows: no graceful signal; the stop header saves the registry and closes the terminals like a shutdown.
  if (info && currentPlatform() === 'win32') {
    if (!(await requestStop(info))) return false;
    const deadline = Date.now() + timeoutMs;
    while (isAlive(info.pid) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    return !isAlive(info.pid);
  }
  if (!info || !isAtelierd(info.pid)) return false;
  try { process.kill(info.pid, 'SIGTERM'); } catch { return false; }
  const deadline = Date.now() + timeoutMs;
  while (isAlive(info.pid) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
  return !isAlive(info.pid);
}
