import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { DaemonPaths } from '@shared/paths.node';
import { toCanonical } from '@shared/paths';
import { pathStyle } from '@shared/platform';
import { shellQuote } from '@shared/shell';
import { ensureDir, ensurePrivateFile, writeFileAtomic } from './fsutil';
import type { IsolationConfig } from './session-pty';
import { ATELIER_BASH, ATELIER_PROFILE_FILES, ATELIER_PS1, HOOK_SCRIPT, STATUSLINE_SCRIPT, ZSH_FILES } from './install-files';

export const HOOK_EVENTS = [
  'SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PermissionRequest',
  'Notification', 'Stop', 'StopFailure', 'SessionEnd',
  // v2.0 (capability states2): subagent count and compaction.
  'SubagentStart', 'SubagentStop', 'PreCompact', 'PostCompact',
  // Exact attribution: a failing tool call ends its window.
  'PostToolUseFailure'
] as const;

export interface UserStatusLine { command: string; refreshInterval?: number; padding?: number }

/** Reads (read-only) the status line configured by the user. */
export function readUserStatusLine(
  // ATELIER_USER_CLAUDE_SETTINGS exists for tests: the user's real status line must never run with fake data.
  settingsFile = process.env.ATELIER_USER_CLAUDE_SETTINGS ?? join(homedir(), '.claude', 'settings.json')
): UserStatusLine | null {
  try {
    // A leading BOM (Windows PowerShell 5.1's `Set-Content -Encoding UTF8` writes one) is not JSON.
    const text = readFileSync(settingsFile, 'utf8').replace(/^\uFEFF/, '');
    const sl = (JSON.parse(text) as { statusLine?: Record<string, unknown> }).statusLine;
    if (!sl || sl.type !== 'command' || typeof sl.command !== 'string' || !sl.command.trim()) return null;
    const out: UserStatusLine = { command: sl.command };
    if (typeof sl.refreshInterval === 'number') out.refreshInterval = sl.refreshInterval;
    if (typeof sl.padding === 'number') out.padding = sl.padding;
    return out;
  } catch {
    return null;
  }
}

export function buildClaudeSettings(binDir: string, user: UserStatusLine | null): object {
  const hook = [{ hooks: [{ type: 'command', command: shellQuote(join(binDir, 'atelier-hook')), timeout: 2 }] }];
  const hooks = Object.fromEntries(HOOK_EVENTS.map((e) => [e, hook]));
  const statusLine: Record<string, unknown> = { type: 'command', command: shellQuote(join(binDir, 'atelier-statusline')) };
  if (user?.refreshInterval !== undefined) statusLine.refreshInterval = user.refreshInterval;
  if (user?.padding !== undefined) statusLine.padding = user.padding;
  return { hooks, statusLine };
}

/**
 * Windows: the bridge's command line in Claude Code's settings. Claude runs hooks through Git
 * Bash when it finds one, else PowerShell: a path without spaces works as is in both. A path that needs quoting has no
 * form both read, and which shell Claude picks can't be told from here (a per-user Git, git on PATH, its own variable):
 * the bridge by name then, which both find on the PATH atelier.ps1 sets.
 */
export function bridgeCommand(bridge: string, mode: 'hook' | 'status'): string {
  const p = toCanonical(bridge, 'win32');
  return /^[A-Za-z0-9_.\/:-]+$/.test(p) ? `${p} ${mode}` : `atelier-bridge ${mode}`;
}

/**
 * Windows: Claude's cap on each hook, in seconds. Claude starts Git Bash (or PowerShell), which starts the bridge: with
 * an antivirus scanning both, that start alone can pass 2 s, and a hook Claude kills is lost (the session never gets a
 * state). The bridge bounds its own wait (~2 s to connect, 1.9 s for atelierd's reply: native/atelier-bridge.c), so
 * this only leaves room for the start; Claude waits for it only when the bridge itself is that slow.
 */
export const WINDOWS_HOOK_TIMEOUT_S = 10;

export function buildWindowsClaudeSettings(bridge: string, user: UserStatusLine | null): object {
  const hook = [{ hooks: [{ type: 'command', command: bridgeCommand(bridge, 'hook'), timeout: WINDOWS_HOOK_TIMEOUT_S }] }];
  const hooks = Object.fromEntries(HOOK_EVENTS.map((e) => [e, hook]));
  const statusLine: Record<string, unknown> = { type: 'command', command: bridgeCommand(bridge, 'status') };
  if (user?.refreshInterval !== undefined) statusLine.refreshInterval = user.refreshInterval;
  if (user?.padding !== undefined) statusLine.padding = user.padding;
  return { hooks, statusLine };
}

/**
 * Copies the first bridge that exists into bin/, left alone when identical. Windows can't replace an executable that is
 * running (a hook in flight while atelierd restarts): the previous bridge then stays, it speaks the same wire format.
 * So does a bridge the runtime lost or can't hand over (an antivirus or Smart App Control quarantining it): the copy
 * installed at an earlier start keeps the sessions' states, and the log says so; no bridge at all is logged loudly.
 */
export function installBridge(
  bin: string, sources: readonly string[], write: (path: string, data: Buffer, mode: number) => void = writeFileAtomic,
  log: (msg: string) => void = () => {}
): string | null {
  const dest = join(bin, 'atelier-bridge.exe');
  const kept = (why: string): string | null => {
    const installed = existsSync(dest) ? dest : null;
    log(installed
      ? `${why}: the installed copy stays (${dest})`
      : `no atelier-bridge.exe (${why}, none in ${bin}): Claude sessions will show no states`);
    return installed;
  };
  const src = sources.find((p) => existsSync(p));
  if (!src) return kept(`atelier-bridge.exe missing from ${sources.join(', ') || 'the runtime'} (an antivirus may have quarantined it)`);
  let bytes: Buffer;
  try { bytes = readFileSync(src); } catch (err) { return kept(`${src} can't be read (${(err as Error).message})`); }
  let same = false;
  try { same = readFileSync(dest).equals(bytes); } catch { /* not installed yet */ }
  if (same) return dest;
  try { write(dest, bytes, 0o755); } catch (err) { return kept(`${dest} can't be replaced (${(err as Error).message})`); }
  return dest;
}

/** How installAtelierFiles reports a file it couldn't install, and writes (tests replace it to make one fail). */
export interface InstallOptions {
  log?: (msg: string) => void;
  write?: (path: string, data: string | Uint8Array, mode: number) => void;
}

/**
 * Each file installs on its own: one that fails (an antivirus holding its temp file past the rename's retries) is
 * logged and keeps its previous copy, and atelierd starts anyway. None of them is needed for atelierd to run; a
 * terminal missing one still opens (without states, or without part of the integration).
 */
function installer(o: InstallOptions): { step(what: string, fn: () => void): void; write: NonNullable<InstallOptions['write']>; log: (msg: string) => void } {
  const log = o.log ?? (() => {});
  return {
    log,
    write: o.write ?? writeFileAtomic,
    step: (what, fn) => {
      try { fn(); } catch (err) { log(`${what} not installed, the previous one stays: ${(err as Error).message}`); }
    }
  };
}

/** Windows: the PowerShell and Git Bash integrations, the bridge, the user's status line and Claude's settings. */
function installWindowsFiles(paths: DaemonPaths, userClaudeSettings: string | undefined, bridges: readonly string[], o: InstallOptions): void {
  const { step, write, log } = installer(o);
  step(paths.bin, () => ensureDir(paths.bin, 0o700));
  step(paths.shell, () => ensureDir(paths.shell, 0o700));
  step(join(paths.shell, 'atelier.ps1'), () => write(join(paths.shell, 'atelier.ps1'), ATELIER_PS1, 0o644));
  // Without it Git Bash terminals start as a plain `bash -l` (main.ts checks it is there).
  step(join(paths.shell, 'atelier.bash'), () => write(join(paths.shell, 'atelier.bash'), ATELIER_BASH, 0o644));
  let bridge: string | null = null;
  step('atelier-bridge.exe', () => { bridge = installBridge(paths.bin, bridges, write, log); });
  const user = readUserStatusLine(userClaudeSettings);
  step(paths.userStatusline, () => write(paths.userStatusline, user ? user.command + '\n' : '', 0o600));
  // No bridge (a broken install): terminals still work, sessions just show no states.
  step(paths.settings, () => write(paths.settings, JSON.stringify(bridge ? buildWindowsClaudeSettings(bridge, user) : {}, null, 2), 0o600));
}

/**
 * Writes everything the terminals need. Only inside Atelier's own folder. `bridges`: where atelier-bridge.exe may be
 * (Windows only: the runtime's resources, then a dev build's vendor/bin).
 */
export function installAtelierFiles(paths: DaemonPaths, userClaudeSettings?: string, bridges: readonly string[] = [], o: InstallOptions = {}): void {
  if (pathStyle() === 'win32') { installWindowsFiles(paths, userClaudeSettings, bridges, o); return; }
  const { step, write } = installer(o);
  step(paths.bin, () => ensureDir(paths.bin, 0o700));
  step(paths.shell, () => ensureDir(paths.shell, 0o700));
  step(join(paths.shell, 'zsh'), () => ensureDir(join(paths.shell, 'zsh'), 0o700));
  step(join(paths.bin, 'atelier-hook'), () => write(join(paths.bin, 'atelier-hook'), HOOK_SCRIPT, 0o755));
  step(join(paths.bin, 'atelier-statusline'), () => write(join(paths.bin, 'atelier-statusline'), STATUSLINE_SCRIPT, 0o755));
  for (const [name, content] of Object.entries(ZSH_FILES)) step(join(paths.shell, 'zsh', name), () => write(join(paths.shell, 'zsh', name), content, 0o644));
  step(join(paths.shell, 'atelier'), () => ensureDir(join(paths.shell, 'atelier'), 0o700));
  for (const [name, content] of Object.entries(ATELIER_PROFILE_FILES)) step(join(paths.shell, 'atelier', name), () => write(join(paths.shell, 'atelier', name), content, 0o644));
  // The Atelier profile's history: created private before zsh first writes it.
  step(join(paths.shell, 'history'), () => ensurePrivateFile(join(paths.shell, 'history')));
  const user = readUserStatusLine(userClaudeSettings);
  step(paths.userStatusline, () => write(paths.userStatusline, user ? user.command + '\n' : '', 0o600));
  step(paths.settings, () => write(paths.settings, JSON.stringify(buildClaudeSettings(paths.bin, user), null, 2), 0o600));
}

/**
 * The terminals' launchd host files, copied into ATELIER_HOME/bin at every start:
 * a running atelierd keeps launching the exact pty-host.js and native host it shipped with, whatever an app update
 * puts in the bundle meanwhile. The first native host that exists wins (the app's Resources/bin, then a dev build's
 * vendor/bin). Nothing to copy: null, and terminals spawn the way they always did.
 */
export function installPtyHost(paths: DaemonPaths, src: { execPath: string; hostScript: string; nativeHosts: string[] }): IsolationConfig | null {
  const native = src.nativeHosts.find((p) => existsSync(p));
  if (!native || !existsSync(src.hostScript)) return null;
  ensureDir(paths.bin, 0o700);
  const hostScript = join(paths.bin, 'pty-host.js');
  const nativeHost = join(paths.bin, 'atelier-pty-host');
  writeFileAtomic(hostScript, readFileSync(src.hostScript), 0o600);
  writeFileAtomic(nativeHost, readFileSync(native), 0o700);
  return { execPath: src.execPath, hostScript, nativeHost };
}
