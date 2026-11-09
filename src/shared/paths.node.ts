import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathStyle } from './platform';

const shortHash = (s: string): string => createHash('sha256').update(s).digest('hex').slice(0, 12);

export interface DaemonPaths {
  home: string; sock: string; info: string; registry: string; logDir: string; log: string;
  /** The terminals' launchd hosts report here; run/ holds their job plists briefly. */
  hostSock: string; run: string;
  /** Scheduled prompts, owned by atelierd. */
  schedules: string;
  /** The Claude Code signals notebook, owned by atelierd. */
  claudeSignals: string;
  bin: string; shell: string; settings: string; userStatusline: string; uiState: string; preferences: string;
}

// macOS rejects socket paths over 104 bytes: stay under 100 for margin.
const MAX_SOCK_BYTES = 100;

/**
 * Windows: `%USERPROFILE%\.atelier`, never AppData — the GUI's own AppData writes are
 * virtualized by its package and invisible to atelierd, the bridge and claude.exe.
 */
export function atelierHome(): string {
  if (pathStyle() === 'win32') return process.env.ATELIER_HOME ?? path.win32.join(os.homedir(), '.atelier');
  return process.env.ATELIER_HOME ?? path.join(os.homedir(), 'Library', 'Application Support', 'Atelier');
}

/** Windows: a named pipe per home (AF_UNIX isn't in libuv there), the same pipe for any spelling of the home. */
function win32Paths(home: string): DaemonPaths {
  const p = path.win32;
  const key = createHash('sha256').update(p.resolve(home).toLowerCase()).digest('hex').slice(0, 16);
  const logDir = p.join(home, 'logs');
  return {
    home, sock: `\\\\.\\pipe\\atelier-${key}`, logDir,
    // The launchd hosts are macOS only: never listened on.
    hostSock: p.join(home, 'run', 'pty-host.sock'),
    run: p.join(home, 'run'),
    info: p.join(home, 'atelierd.json'),
    registry: p.join(home, 'registry.json'),
    schedules: p.join(home, 'schedules.json'),
    claudeSignals: p.join(home, 'claude-signals.json'),
    log: p.join(logDir, 'atelierd.log'),
    bin: p.join(home, 'bin'),
    shell: p.join(home, 'shell'),
    settings: p.join(home, 'claude-settings.json'),
    userStatusline: p.join(home, 'user-statusline.cmd'),
    uiState: p.join(home, 'ui-state.json'),
    preferences: p.join(home, 'preferences.json')
  };
}

/** A named pipe is no file: nothing to create, remove or chmod for it. */
export const isPipePath = (sock: string): boolean => sock.startsWith('\\\\.\\pipe\\');

export function daemonPaths(home = atelierHome()): DaemonPaths {
  if (pathStyle() === 'win32') return win32Paths(home);
  let sock = path.join(home, 'atelierd.sock');
  if (Buffer.byteLength(sock) > MAX_SOCK_BYTES) {
    sock = path.join(os.tmpdir(), `atelier-${process.getuid?.() ?? 0}`, 'atelierd.sock');
  }
  let hostSock = path.join(home, 'run', 'pty-host.sock');
  if (Buffer.byteLength(hostSock) > MAX_SOCK_BYTES) {
    hostSock = path.join(os.tmpdir(), `atelier-${process.getuid?.() ?? 0}`, `${shortHash(home)}-pty-host.sock`);
  }
  const logDir = path.join(home, 'logs');
  return {
    home, sock, logDir, hostSock,
    run: path.join(home, 'run'),
    info: path.join(home, 'atelierd.json'),
    registry: path.join(home, 'registry.json'),
    schedules: path.join(home, 'schedules.json'),
    claudeSignals: path.join(home, 'claude-signals.json'),
    log: path.join(logDir, 'atelierd.log'),
    bin: path.join(home, 'bin'),
    shell: path.join(home, 'shell'),
    settings: path.join(home, 'claude-settings.json'),
    userStatusline: path.join(home, 'user-statusline.sh'),
    uiState: path.join(home, 'ui-state.json'),
    preferences: path.join(home, 'preferences.json')
  };
}
