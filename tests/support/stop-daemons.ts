// The end of a test run: atelierds an e2e left running (a test that failed before its own cleanup, an app that didn't
// stop its daemon) are stopped. Only daemons whose ATELIER_HOME is inside this run's temp root, found by their
// atelierd.json, and only a pid whose command line still is an atelierd (daemon.js): never the user's own.
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, realpathSync } from 'node:fs';
import { homeHash } from '../../src/daemon/launchd';
import { join } from 'node:path';

function commandOf(pid: number): string {
  try {
    if (process.platform === 'win32') {
      // No ps on Windows: the process's command line from CIM (slow, but only at the end of a run).
      const script = `(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').CommandLine`;
      return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8' });
    }
    return execFileSync('/bin/ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' });
  } catch { return ''; }
}

/** Stops (SIGTERM) every atelierd of a home directly under `runDir`; returns the pids it stopped. */
export function stopRunDaemons(runDir: string): number[] {
  const stopped: number[] = [];
  let homes: string[];
  try { homes = readdirSync(runDir); } catch { return stopped; }
  for (const h of homes) {
    let pid: number;
    try { pid = Number((JSON.parse(readFileSync(join(runDir, h, 'atelierd.json'), 'utf8')) as { pid?: unknown }).pid); } catch { continue; }
    if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid) continue;
    if (!/\bdaemon\.js\b/.test(commandOf(pid))) continue;
    try { process.kill(pid, 'SIGTERM'); stopped.push(pid); } catch { /* already gone */ }
  }
  return stopped;
}

interface JobOps { list(): string[]; bootout(label: string): void }

const launchctlOps: JobOps = {
  list: () => {
    try {
      return execFileSync('/bin/launchctl', ['list'], { encoding: 'utf8' }).split('\n').slice(1).map((l) => l.split('\t')[2]?.trim() ?? '').filter(Boolean);
    } catch { return []; }
  },
  bootout: (label) => { try { execFileSync('/bin/launchctl', ['bootout', `gui/${process.getuid?.() ?? 0}/${label}`], { stdio: 'ignore' }); } catch { /* gone */ } }
};

/**
 * Boots out the launchd jobs of this run's homes: atelierd's and its terminals', found by
 * the hash of each home directly under `runDir`. Labels of any other home (the user's app, a dev instance) never match.
 */
export function bootOutRunJobs(runDir: string, ops: JobOps = launchctlOps): string[] {
  // No launchd on Windows (atelierd and its terminals aren't jobs there).
  if (process.platform === 'win32' && ops === launchctlOps) return [];
  let homes: string[];
  try { homes = readdirSync(runDir); } catch { return []; }
  const hashes = new Set<string>();
  for (const h of homes) {
    const p = join(runDir, h);
    hashes.add(homeHash(p));
    try { hashes.add(homeHash(realpathSync(p))); } catch { /* gone */ }
  }
  const ours = ops.list().filter((l) => {
    const m = /^dev\.useatelier\.(?:atelierd|session)\.([0-9a-f]{12})(?:\.|$)/.exec(l);
    return !!m && hashes.has(m[1]!);
  });
  for (const l of ours) ops.bootout(l);
  return ours;
}
