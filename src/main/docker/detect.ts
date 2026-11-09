// Finding the engine: the custom path when set, else the current docker context (unix:// only),
// else the sockets Docker Desktop, OrbStack, Colima, Rancher Desktop and the system use. The first that answers
// `/_ping` and speaks API ≥ 1.41 is the engine. Tests pass ATELIER_TEST_DOCKER_SOCKET: then only that one is tried.
// Windows: named pipes — Docker Desktop's, an npipe:// context, a custom one.
import { createHash } from 'node:crypto';
import path from 'node:path';
import { dockerPipeName, engineName, type EngineState } from '@shared/docker';
import { toCanonical } from '@shared/paths';
import { currentPlatform, type Platform } from '@shared/platform';

export interface DetectDeps {
  home: string;
  /** Settings › Docker › Engine "Custom": '' when detected. */
  custom: string;
  testSocket: string | undefined;
  readFile(path: string): string | null;
  /** True for a socket (a symlink followed), false for another file, null when nothing is there. */
  isSocket(path: string): boolean | null;
  ping(socket: string): Promise<'ok' | 'gone' | 'denied'>;
  version(socket: string): Promise<unknown>;
  info(socket: string): Promise<unknown>;
  platform?: Platform;
}

/** Docker Desktop's engine pipes on Windows (the Windows-containers one, then the Linux one). */
const WINDOWS_PIPES = ['\\\\.\\pipe\\docker_engine', '\\\\.\\pipe\\dockerDesktopLinuxEngine'];
const win = (d: DetectDeps) => (d.platform ?? currentPlatform()) === 'win32';
/** Files under the home folder: the canonical form on Windows (home is C:/…), node's join on macOS. */
const joinIn = (d: DetectDeps, ...p: string[]) => (win(d) ? toCanonical(path.win32.join(d.home, ...p), 'win32') : path.join(d.home, ...p));

export const MIN_API = '1.41';

function contextSocket(d: DetectDeps): string | null {
  try {
    const cfg = JSON.parse(d.readFile(joinIn(d, '.docker', 'config.json')) ?? 'null') as { currentContext?: unknown } | null;
    const name = cfg?.currentContext;
    if (typeof name !== 'string' || !name || name === 'default') return null;
    const meta = JSON.parse(d.readFile(joinIn(d, '.docker', 'contexts', 'meta', createHash('sha256').update(name).digest('hex'), 'meta.json')) ?? 'null') as { Endpoints?: { docker?: { Host?: unknown } } } | null;
    const host = meta?.Endpoints?.docker?.Host;
    if (win(d)) return typeof host === 'string' ? dockerPipeName(host) : null;
    return typeof host === 'string' && host.startsWith('unix://') && host.length > 'unix://'.length ? host.slice('unix://'.length) : null;
  } catch {
    return null;
  }
}

export function candidates(d: DetectDeps): string[] {
  if (d.testSocket) return [d.testSocket];
  if (d.custom) return [win(d) ? dockerPipeName(d.custom) ?? d.custom : d.custom];
  const known = win(d) ? WINDOWS_PIPES : [
    path.join(d.home, '.docker', 'run', 'docker.sock'),
    path.join(d.home, '.orbstack', 'run', 'docker.sock'),
    path.join(d.home, '.colima', 'default', 'docker.sock'),
    path.join(d.home, '.rd', 'docker.sock'),
    '/var/run/docker.sock'
  ];
  const ctx = contextSocket(d);
  return [...new Set(ctx ? [ctx, ...known] : known)];
}

/** "1.47" ≥ "1.41". */
export function apiAtLeast(v: string, min: string): boolean {
  const [a = 0, b = 0] = v.split('.').map(Number);
  const [x = 0, y = 0] = min.split('.').map(Number);
  return a > x || (a === x && b >= y);
}

const field = (o: unknown, k: string): unknown => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined);
const s = (v: unknown) => (typeof v === 'string' ? v : '');
const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

export async function detect(d: DetectDeps): Promise<EngineState> {
  let silent: string | null = null;
  for (const socket of candidates(d)) {
    if (d.isSocket(socket) !== true) continue;
    const ping = await d.ping(socket).catch(() => 'gone' as const);
    if (ping === 'denied') return { state: 'denied', socket };
    if (ping !== 'ok') { silent ??= socket; continue; }
    try {
      const version = await d.version(socket);
      const api = s(field(version, 'ApiVersion'));
      if (!api || !apiAtLeast(api, MIN_API)) return { state: 'unsupported', socket, version: s(field(version, 'Version')) };
      const info = await d.info(socket).catch(() => ({}));
      return {
        state: 'running', socket, name: engineName(version, info, socket), version: s(field(version, 'Version')), apiVersion: api,
        os: s(field(version, 'Os')), arch: s(field(version, 'Arch')), cpus: n(field(info, 'NCPU')), memory: n(field(info, 'MemTotal'))
      };
    } catch {
      silent ??= socket;
    }
  }
  return silent ? { state: 'stopped', socket: silent } : { state: 'absent' };
}
