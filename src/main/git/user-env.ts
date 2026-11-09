// The user's shell environment for git writes: hooks (husky's npx through nvm or Homebrew),
// gpg and ssh agents need the PATH and variables of the user's zsh, which an app opened from Finder doesn't have.
// Main captures it itself with atelierd's own code (imported, atelierd unchanged), lazily before the first write op,
// in memory only, captured again when a zsh startup file changed since.
import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { envGet, knownBinDirs, pathListJoin, pathListSplit, withEnv } from '@shared/env';
import { currentPlatform } from '@shared/platform';
import { buildTerminalEnv } from '../../daemon/env';
import { captureShellEnv } from '../../daemon/shell-env';
import { zshStartupFiles, type FileStamp } from '../shell-env-fresh';

/** A failed capture is tried again after this long even with unchanged files (a broken config costs 10 s an op). */
export const FAILED_RETRY_MS = 5 * 60_000;
const CAPTURE_TIMEOUT_MS = 10_000;

export interface UserEnvDeps {
  /** The user's filtered shell environment; rejects when the shell fails. */
  capture(): Promise<Record<string, string>>;
  /** A file's stamp, null when missing (or unreadable). */
  stat(p: string): Promise<FileStamp | null>;
  /** The zsh startup files whose change calls for a new capture. */
  files(): string[];
  now(): number;
  /** The app's environment, used (with the common PATH folders) when there is no capture. */
  fallback(): NodeJS.ProcessEnv;
  /** Gives up on a capture that hasn't answered by then (default 10 s). */
  timeoutMs?: number;
  log?(message: string): void;
}

export interface UserEnvResult { env: NodeJS.ProcessEnv; captured: boolean }

/** The app's environment with polishEnv's PATH folders first: Homebrew's, /usr/local's, then the app's PATH. */
export function fallbackEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const dirs = [...knownBinDirs(), ...pathListSplit(envGet(base, 'PATH') ?? '').filter(Boolean)];
  return withEnv(base, 'PATH', pathListJoin([...new Set(dirs)]));
}

/**
 * The environment the user's zsh starts with, as atelierd builds it: no Atelier or Claude Code variables, the user's
 * own ZDOTDIR only (absent when they have none), Oh My Zsh's update prompt off.
 */
export function captureBaseEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const base = buildTerminalEnv(env, { DISABLE_AUTO_UPDATE: 'true' });
  for (const k of Object.keys(base)) if (k.startsWith('ATELIER_')) delete base[k];
  delete base.ZDOTDIR;
  if (env.ZDOTDIR) base.ZDOTDIR = env.ZDOTDIR;
  return base;
}

const key = (s: FileStamp | null) => (s ? `${s.mtimeMs}:${s.size}:${s.ino}` : 'missing');

export class UserEnv {
  /** The capture in use and the startup files' stamps taken just before it. */
  private ok: { env: Record<string, string>; stamps: string } | null = null;
  /** The stamps the last capture failed with, and when: no retry until a file changes or FAILED_RETRY_MS pass. */
  private failed: { stamps: string; at: number } | null = null;
  private running: Promise<void> | null = null;

  constructor(private readonly deps: UserEnvDeps) {}

  /** The environment for a write op: the user's capture, else the app's with the common PATH folders. */
  async get(): Promise<UserEnvResult> {
    if (this.running) return this.join();
    const stamps = await this.stamps();
    // Another op started a capture while the files were read: wait for that one.
    if (this.running) return this.join();
    const fresh = this.ok?.stamps === stamps;
    const waiting = this.failed?.stamps === stamps && this.deps.now() - this.failed.at < FAILED_RETRY_MS;
    if (fresh || waiting) return this.result();
    this.running = this.capture(stamps).finally(() => { this.running = null; });
    return this.join();
  }

  private async join(): Promise<UserEnvResult> {
    await this.running;
    return this.result();
  }

  /** A copy for each caller: the op's own variables never reach the capture. */
  private result(): UserEnvResult {
    // A failed recapture keeps the earlier one: still the user's environment, if a little older.
    return this.ok ? { env: { ...this.ok.env }, captured: true } : { env: fallbackEnv(this.deps.fallback()), captured: false };
  }

  private async stamps(): Promise<string> {
    const files = this.deps.files();
    const stamps = await Promise.all(files.map(async (f) => key(await this.deps.stat(f).catch(() => null))));
    return files.map((f, i) => `${f}\u0000${stamps[i]}`).join('\u0000');
  }

  private async capture(stamps: string): Promise<void> {
    const ms = this.deps.timeoutMs ?? CAPTURE_TIMEOUT_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`shell environment not captured in ${ms} ms`)), ms); });
    try {
      const env = await Promise.race([this.deps.capture(), timeout]);
      this.ok = { env, stamps };
      this.failed = null;
      this.deps.log?.(`git writes: shell environment captured (${Object.keys(env).length} variables)`);
    } catch (err) {
      this.failed = { stamps, at: this.deps.now() };
      this.deps.log?.(`git writes: shell environment not captured: ${(err as Error).message}`);
    } finally {
      clearTimeout(timer);
    }
  }
}

async function statStamp(p: string): Promise<FileStamp | null> {
  try {
    const s = await stat(p);
    return { mtimeMs: s.mtimeMs, size: s.size, ino: s.ino };
  } catch {
    return null;
  }
}

/**
 * The real wiring: the user's login+interactive zsh through atelierd's captureShellEnv (its output already filtered
 * by filterCapturedEnv), started from the home folder with the ZDOTDIR the app got, like atelierd's own capture.
 */
export function defaultUserEnv(log?: (message: string) => void): UserEnv {
  return new UserEnv({
    capture: async () => {
      // Windows has no login shell to ask: an app started from the Start menu already has the user's environment
      // (their variables and PATH, from the registry). Every op would otherwise say it ran without it.
      if (currentPlatform() === 'win32') return Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => typeof e[1] === 'string'));
      const base = captureBaseEnv(process.env);
      const { env } = await captureShellEnv({ env: base, cwd: base.HOME ?? homedir(), timeoutMs: CAPTURE_TIMEOUT_MS }).result;
      // Oh My Zsh's update prompt is off only for the capture.
      if (process.env.DISABLE_AUTO_UPDATE === undefined) delete env.DISABLE_AUTO_UPDATE;
      return env;
    },
    stat: statStamp,
    files: () => zshStartupFiles(homedir(), process.env.ZDOTDIR),
    now: () => Date.now(),
    fallback: () => process.env,
    // A little after captureShellEnv's own timeout, which also ends the shell's process group.
    timeoutMs: CAPTURE_TIMEOUT_MS + 1_000,
    log
  });
}
