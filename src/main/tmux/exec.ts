import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathListSplit } from '@shared/env';

/** The only format Atelier asks tmux for (a format with `#(...)` would make tmux run commands). */
export const PANE_FORMAT = ['#{pane_id}', '#{session_name}', '#{window_index}', '#{pane_index}', '#{pane_title}', '#{pane_current_command}', '#{pane_current_path}'].join('\t');

const PANE_TARGET = /^%\d+$/;
const SERVER = /^[A-Za-z0-9_-]+$/;

/** tmux server is off (no sessions). */
export class TmuxUnavailable extends Error {}
/** tmux is not installed or not found. */
export class TmuxNotInstalled extends Error {}

/**
 * Read-only: list panes, capture their content, read a property. Nothing else:
 * never attach or -C (a client that detaches can kill the session, as some dev scripts do), never send-keys.
 */
export function validateTmuxArgs(args: string[]): void {
  const bad = (why: string): never => { throw new Error(`tmux: ${why}: ${args.join(' ')}`); };
  if (args.some((a) => a.includes(';'))) bad('command separator not allowed');
  if (args.some((a) => a.includes('#('))) bad('command in format not allowed');
  const [sub, ...rest] = args;
  switch (sub) {
    case 'list-panes':
      if (!(rest.length === 3 && rest[0] === '-a' && rest[1] === '-F' && rest[2] === PANE_FORMAT)) bad('form not allowed');
      return;
    case 'capture-pane':
      // -p -e -J -S -N -t %id
      if (!(rest.length === 7 && rest[0] === '-p' && rest[1] === '-e' && rest[2] === '-J' && rest[3] === '-S' &&
        /^-\d+$/.test(rest[4]!) && rest[5] === '-t' && PANE_TARGET.test(rest[6]!))) bad('form not allowed');
      return;
    default:
      bad('subcommand not allowed');
  }
}

/** Environment for tmux: without TMUX/TMUX_PANE, which would make it read the server the app was started from instead of the default one. */
export function tmuxEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...base };
  delete env.TMUX;
  delete env.TMUX_PANE;
  return env;
}

// An app opened from the Dock has macOS's minimal PATH: Homebrew's tmux would not be found.
const KNOWN_DIRS = ['/opt/homebrew/bin', '/usr/local/bin', '/opt/local/bin', '/usr/bin'];

export function findTmux(path: string | undefined, exists: (p: string) => boolean = existsSync): string | null {
  const dirs = [...pathListSplit(path ?? '').filter(Boolean), ...KNOWN_DIRS];
  for (const d of dirs) { const p = join(d, 'tmux'); if (exists(p)) return p; }
  return null;
}

let tmuxPath: string | null | undefined;

export function runTmux(args: string[], opts: { server?: string } = {}): Promise<string> {
  try {
    validateTmuxArgs(args);
    if (opts.server !== undefined && !SERVER.test(opts.server)) throw new Error('tmux: invalid server name');
  } catch (err) {
    return Promise.reject(err);
  }
  // -u: an app opened from the Dock has no LANG/LC_*, and tmux then writes the format's tabs as `_` (no pane found).
  const full = ['-u', ...(opts.server ? ['-L', opts.server] : []), ...args];
  if (tmuxPath === undefined) tmuxPath = findTmux(process.env.PATH);
  const bin = tmuxPath;
  if (!bin) return Promise.reject(new TmuxNotInstalled('tmux not found'));
  return new Promise((resolve, reject) => {
    execFile(bin, full, { timeout: 3000, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8', env: tmuxEnv() }, (err, stdout, stderr) => {
      if (!err) { resolve(stdout); return; }
      const msg = `${stderr || err.message}`.trim();
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') { tmuxPath = undefined; reject(new TmuxNotInstalled(msg)); return; }
      if (/no server running|error connecting|No such file/i.test(msg)) reject(new TmuxUnavailable(msg));
      else reject(new Error(`tmux ${args[0]}: ${msg}`));
    });
  });
}
