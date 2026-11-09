import { execFile } from 'node:child_process';
import { currentPlatform, type Platform } from '@shared/platform';

// A child and everything it started (git, its hooks, gpg, ssh; claude -p), stopped together.
// macOS: the child leads its own process group (detached), the group gets the signal — exactly as before. Windows has
// neither groups nor SIGTERM: `taskkill /PID <pid> /T /F` ends the tree at once (no grace: a lock git leaves is
// reported, never deleted). One fixed program, argv only (tests/integration/no-child-process.test.ts).

interface Child { pid?: number | undefined; exitCode?: number | null; signalCode?: string | null; kill(signal?: NodeJS.Signals | number): boolean }
interface Deps {
  platform?: Platform;
  /** macOS: process.kill on the group (a negative pid). */
  killGroup?: (pid: number, sig: NodeJS.Signals) => void;
  /** Windows: runs taskkill. */
  run?: (file: string, args: string[]) => void;
  systemRoot?: string;
}

const runTaskkill = (file: string, args: string[]) => {
  execFile(file, args, { timeout: 5000, windowsHide: true }, () => { /* gone already, or not ours to stop */ });
};

/** Windows: the children taskkill already took (/T /F ends the tree at once: a second call is never needed). */
const killed = new WeakSet<Child>();

export function signalTree(child: Child, sig: 'SIGTERM' | 'SIGKILL', d: Deps = {}): void {
  if (!child.pid) return;
  if ((d.platform ?? currentPlatform()) === 'win32') {
    // Once per child, and never after it exited: its pid may already be another process's (Windows reuses them fast).
    if (killed.has(child) || (child.exitCode ?? null) !== null || (child.signalCode ?? null) !== null) return;
    killed.add(child);
    const root = d.systemRoot ?? process.env.SystemRoot ?? 'C:\\Windows';
    (d.run ?? runTaskkill)(`${root}\\System32\\taskkill.exe`, ['/PID', String(child.pid), '/T', '/F']);
    return;
  }
  try { (d.killGroup ?? ((pid, s) => process.kill(pid, s)))(-child.pid, sig); } catch { try { child.kill(sig); } catch { /* gone */ } }
}

/**
 * How to spawn a child stopped with signalTree: its own group on macOS (no controlling terminal either); on Windows not
 * detached (a detached console program gets a console of its own) and never a console window.
 */
export function childOptions(platform: Platform = currentPlatform()): { detached: boolean; windowsHide: true } {
  return { detached: platform !== 'win32', windowsHide: true };
}
