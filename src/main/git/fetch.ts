import { spawn } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { childOptions, signalTree } from '../proc-tree';
import { envKey } from '@shared/env';
import type { FetchOutcome } from '@shared/scm';
import { devEnv } from '../dev-env';
import { AUTO_FETCH_CONFIG_ARGS, runGit } from './exec';

/**
 * Fetch: the one git command Atelier runs that uses the network and writes in .git — remote-tracking
 * refs, objects and FETCH_HEAD, nothing else. Its own module because runGit's closed list stays read-only (and keeps
 * refusing `fetch`). One fixed argv, forced settings through GIT_CONFIG_COUNT (never -c), no prompt of any kind, no
 * controlling terminal, a timeout that stops the whole process group.
 */
export const FETCH_ARGS = ['fetch', '--all', '--no-recurse-submodules', '--no-auto-maintenance', '--no-show-forced-updates', '--quiet'] as const;
export const FETCH_TIMEOUT_MS = 60_000;
export const FETCH_MAX_BYTES = 1024 * 1024;

// core.hooksPath=/dev/null: fetch runs the reference-transaction hook; no hook of the repo or the user may run.
// protocol.ext.allow=never: an ext:: remote is a command line; a repo config allowing it is overridden here.
// credential.helper and core.sshCommand are kept on purpose: HTTPS and SSH need them.
const FORCED: [string, string][] = [
  ['core.hooksPath', '/dev/null'], ['core.fsmonitor', 'false'], ['protocol.ext.allow', 'never'], ['fetch.recurseSubmodules', 'false'],
  ['fetch.writeCommitGraph', 'false'], ['gc.auto', '0'], ['maintenance.auto', 'false'], ['credential.interactive', 'false']
];

/**
 * Fetch's environment: no inherited GIT_* variable, no prompt (git's, Git Credential Manager's, ssh's askpass; an empty
 * GIT_ASKPASS makes git skip core.askPass and SSH_ASKPASS too, also before 2.46's credential.interactive), the forced
 * settings. `isolated` (tests only): no credential helper, no global or system config.
 */
export function fetchEnv(base: NodeJS.ProcessEnv = process.env, isolated = devEnv('ATELIER_TEST_FETCH_ISOLATED') === '1'): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(base)) if (!envKey(k).startsWith('GIT_')) env[k] = v;
  // An empty helper clears every helper configured before it (system, global, repo).
  const config = isolated ? [...FORCED, ['credential.helper', ''] as [string, string]] : FORCED;
  const out: NodeJS.ProcessEnv = { ...env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '', GCM_INTERACTIVE: 'never', SSH_ASKPASS_REQUIRE: 'never', LC_ALL: 'C', GIT_CONFIG_COUNT: String(config.length) };
  config.forEach(([k, v], i) => { out[`GIT_CONFIG_KEY_${i}`] = k; out[`GIT_CONFIG_VALUE_${i}`] = v; });
  if (isolated) { out.GIT_CONFIG_GLOBAL = '/dev/null'; out.GIT_CONFIG_NOSYSTEM = '1'; }
  return out;
}

// First matching rule wins: ssh's "Permission denied" comes with the generic "Could not read from remote".
const AUTH = /Authentication failed|could not read (?:Username|Password)|terminal prompts disabled|unable to get password|unable to read askpass|Permission denied \(|Host key verification failed|returned error: 40[13]\b|HTTP 40[13]\b|Invalid username or (?:password|token)|invalid credentials/i;
const BUSY = /cannot lock ref|Unable to create '[^']*\.lock'|is at [0-9a-f]+ but expected/i;
const NETWORK = /Could not resolve host|Could not resolve hostname|Failed to connect|Couldn't connect to server|Connection (?:refused|timed out|reset)|Network is unreachable|Operation timed out|No route to host|timed out after/i;

export function classifyFetch(stderr: string): Exclude<FetchOutcome, 'ok'> {
  if (AUTH.test(stderr)) return 'auth';
  if (BUSY.test(stderr)) return 'busy';
  if (NETWORK.test(stderr)) return 'network';
  return 'error';
}

const GENERIC = /^Could not read from remote repository\.?$/i;

/**
 * https://user:token@host/… and https://token@host/… → https://host/…. The lookbehind makes a scheme start only where no
 * scheme character precedes it, so a long run of them (a megabyte of `x`) is scanned once, not once per position.
 */
export const scrubCredentials = (s: string): string => s.replace(/(?<![a-z0-9+.-])([a-z][a-z0-9+.-]*:\/\/)[^/@\s']+@/gi, '$1');

/** A message line is picked from at most this much of each line: a hook printing a megabyte on one line costs nothing. */
export const MESSAGE_LINE_MAX = 4096;

/** git's first meaningful line, without its "fatal:"/"error:" prefix, credentials removed, at most 200 characters. */
export function fetchMessage(stderr: string): string {
  const lines = stderr.split('\n').map((l) => l.slice(0, MESSAGE_LINE_MAX).trim()).filter((l) => l && !/^hint:/i.test(l));
  const strip = (l: string) => l.replace(/^(?:fatal|error):\s*/i, '');
  const line = lines.map(strip).find((l) => !GENERIC.test(l)) ?? (lines[0] ? strip(lines[0]) : '');
  const clean = scrubCredentials(line);
  return clean.length > 200 ? `${clean.slice(0, 199)}…` : clean;
}

/**
 * Whether Atelier may fetch this repo on its own: not when its own config (includes followed) names a
 * program the fetch would run — an ssh command, a credential helper, an askpass, a git:// proxy, an upload-pack. Such
 * a config usually comes with the repo from an archive or a copy, not a clone; the user can still fetch by hand.
 * Unreadable config: no.
 */
export async function autoFetchAllowed(root: string): Promise<boolean> {
  try {
    const keys = (await runGit(root, [...AUTO_FETCH_CONFIG_ARGS])).split('\n').map((s) => s.trim()).filter(Boolean);
    return keys.every((k) => k === 'core.repositoryformatversion');
  } catch { return false; }
}

export interface FetchResult { outcome: FetchOutcome; message?: string }

/** Every fetch in progress, by its stop function. */
const running = new Set<(message: string) => void>();

/** The app quits: every fetch in progress is stopped (they run detached and would outlive it). */
export function stopAllFetches(): void {
  for (const stop of [...running]) stop('Atelier quit.');
}

export interface FetchOpts { timeoutMs?: number; isolated?: boolean }

/** `git fetch` in a repo root. Never rejects: every failure is an outcome. */
export function runFetch(root: string, o: FetchOpts = {}): Promise<FetchResult> {
  if (!isAbsolute(root) || root.includes('\0')) return Promise.resolve({ outcome: 'error', message: 'invalid repository path' });
  return new Promise((resolve) => {
    let stopped: string | null = null;
    let settled = false;
    let stderr = '';
    let bytes = 0;
    let grace: NodeJS.Timeout | undefined;
    const finish = (r: FetchResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(grace);
      running.delete(stop);
      resolve(r);
    };
    // The whole group: git, git-remote-https, ssh.
    const killAll = () => signalTree(child, 'SIGKILL');
    // Timed out or the app quits: the group is killed, and the answer comes soon even if a helper that left the group
    // still holds stderr open.
    const stop = (message: string) => {
      if (stopped !== null) return;
      stopped = message;
      killAll();
      grace = setTimeout(() => finish({ outcome: 'network', message }), 500);
    };
    // spawn because Node's execFile drops `detached`: its own session, so its own process group and no controlling
    // terminal (ssh can't open /dev/tty, even in a dev run started from a terminal). stdin closed, stdout ignored.
    const child = spawn('git', ['-C', root, ...FETCH_ARGS], { env: fetchEnv(process.env, o.isolated), ...childOptions(), stdio: ['ignore', 'ignore', 'pipe'] });
    running.add(stop);
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (s: string) => {
      bytes += Buffer.byteLength(s);
      if (bytes > FETCH_MAX_BYTES) { killAll(); finish({ outcome: 'error', message: 'git printed too much output.' }); return; }
      stderr += s;
    });
    child.on('error', (err) => finish({ outcome: 'error', message: fetchMessage(err.message) }));
    child.on('close', (code) => {
      if (stopped !== null) { finish({ outcome: 'network', message: stopped }); return; }
      if (code === 0) { finish({ outcome: 'ok' }); return; }
      finish({ outcome: classifyFetch(stderr), message: fetchMessage(stderr) || `git fetch exited with ${code ?? 'a signal'}` });
    });
    const timer = setTimeout(() => stop('The remote did not answer in time.'), o.timeoutMs ?? FETCH_TIMEOUT_MS);
  });
}
