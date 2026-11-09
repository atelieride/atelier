import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import nodePath, { isAbsolute, join } from 'node:path';
import { currentPlatform, type Platform } from '@shared/platform';
import { envKey, pathListSplit } from '@shared/env';
import { isAbsPath } from '@shared/paths';
import { PR_FIELDS, parseGhPr, type PrInfo } from '@shared/pr';
import { devEnv } from '../dev-env';

/**
 * The GitHub CLI, read-only: the only module that runs `gh`, and only as
 * `gh pr view <branch> --json number,title,url,state,isDraft,reviewDecision,statusCheckRollup` in a repo root, through
 * execFile (no shell), argv validated before running, 15 s timeout, output capped at 1 MB.
 */
export const GH_TIMEOUT_MS = 15000;
export const GH_MAX_BUFFER = 1024 * 1024;
const MAX_BRANCH = 200;

/**
 * A branch gh can be asked about: git's ref rules (no control characters, spaces, `~^:?*[\`, `..`, `@{`, components
 * starting with `.` or ending in `.lock`, no leading/trailing/double `/`, no trailing `.`), plus an allowlist of
 * characters (letters, digits, `._/-+#@=,`), no leading `-` (a flag) and nothing gh would read as a PR number (`123`,
 * `#123`).
 */
export function validBranch(b: string): boolean {
  if (b.length === 0 || b.length > MAX_BRANCH) return false;
  if (!/^[\p{L}\p{N}._/+#@=,-]+$/u.test(b)) return false;
  if (b.startsWith('-') || b === '@' || b.includes('..') || b.includes('@{') || b.includes('//')) return false;
  if (b.startsWith('/') || b.endsWith('/') || b.endsWith('.')) return false;
  if (b.split('/').some((c) => c.startsWith('.') || c.endsWith('.lock'))) return false;
  if (/^#?\d+$/.test(b)) return false;
  return true;
}

export const ghArgs = (branch: string): string[] => ['pr', 'view', branch, '--json', PR_FIELDS];

/** Throws unless args is exactly `pr view <valid branch> --json <PR_FIELDS>`. */
export function validateGhArgs(args: readonly string[]): void {
  const ok = args.length === 5 && args[0] === 'pr' && args[1] === 'view' && validBranch(args[2] ?? '') && args[3] === '--json' && args[4] === PR_FIELDS;
  if (!ok) throw new Error(`gh: form not allowed: ${args.join(' ')}`);
}

// An app opened from the Dock has macOS's minimal PATH: Homebrew's gh would not be found. Windows: the installer's folder.
const KNOWN_DIRS = ['/opt/homebrew/bin', '/usr/local/bin'];
const WINDOWS_DIRS = ['C:\\Program Files\\GitHub CLI'];

/** The gh to run: the test fake (dev/e2e only, ATELIER_TEST_GH), else the first in PATH (absolute entries), else Homebrew's. */
export function findGh(path: string | undefined, exists: (p: string) => boolean = existsSync, testGh: string | undefined = devEnv('ATELIER_TEST_GH'), platform: Platform = currentPlatform()): string | null {
  if (testGh) return testGh;
  if (platform === 'win32') {
    const dirs = [...pathListSplit(path ?? '', 'win32').filter((d) => isAbsPath(d, 'win32')), ...WINDOWS_DIRS];
    for (const d of dirs) { const p = nodePath.win32.join(d, 'gh.exe'); if (exists(p)) return p; }
    return null;
  }
  const dirs = [...pathListSplit(path ?? '').filter((d) => isAbsPath(d)), ...KNOWN_DIRS];
  for (const d of dirs) { const p = join(d, 'gh'); if (exists(p)) return p; }
  return null;
}

/**
 * gh's environment: the app's own (HOME, PATH, the user's gh host/token), without GH_REPO (another repo), debug output or
 * inherited GIT_* variables (GIT_DIR, GIT_WORK_TREE, GIT_CONFIG_*… would point the git gh runs at another repo or
 * config, as in git/exec.ts); no prompts (gh's nor git's), colors, spinners or update checks.
 */
export function ghEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  const dropped = ['GH_REPO', 'GH_DEBUG', 'DEBUG'];
  for (const [k, v] of Object.entries(base)) if (!envKey(k).startsWith('GIT_') && !dropped.includes(envKey(k))) env[k] = v;
  return { ...env, GH_PROMPT_DISABLED: '1', NO_COLOR: '1', GH_NO_UPDATE_NOTIFIER: '1', GH_SPINNER_DISABLED: '1', GIT_TERMINAL_PROMPT: '0' };
}

export type GhFailure = 'missing' | 'auth' | 'none' | 'error';

// A repo gh can't map to GitHub (no remote, a non-GitHub remote, not a repo): no PR for it. Checked before the login
// messages: gh's "none of the git remotes…" ends with "please use `gh auth login`" although the user is logged in.
const NO_GITHUB_REPO = /none of the git remotes configured for this repository point to a known GitHub host|no git remotes found|not a git repository/i;
const NOT_LOGGED_IN = /not logged in|authenticat|bad credentials|HTTP 401|To get started with GitHub CLI/i;

/** Why gh failed: not installed, not logged in, no PR for this branch (or no GitHub repo), or anything else (kept as the last result). */
export function classifyGhFailure(code: string | number | null | undefined, stderr: string): GhFailure {
  if (code === 'ENOENT') return 'missing';
  if (NO_GITHUB_REPO.test(stderr) || /no pull requests? found/i.test(stderr)) return 'none';
  // Exit code 4 is gh's "authentication required" (gh help exit-codes).
  if (code === 4 || NOT_LOGGED_IN.test(stderr)) return 'auth';
  return 'error';
}

export type GhResult = { kind: 'ok'; pr: PrInfo } | { kind: GhFailure };

export type GhExec = (
  file: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv; timeout: number; maxBuffer: number; encoding: 'utf8' },
  cb: (err: (Error & { code?: number | string | null }) | null, stdout: string, stderr: string) => void
) => void;

const realExec: GhExec = (file, args, opts, cb) => {
  execFile(file, args, { ...opts, windowsHide: true }, (err, stdout, stderr) => cb(err as (Error & { code?: number | string | null }) | null, String(stdout), String(stderr)));
};

/** The PR of `branch` in the repo at `root`, as gh sees it. Never throws. */
export function viewPr(root: string, branch: string, deps: { exec?: GhExec; find?: () => string | null } = {}): Promise<GhResult> {
  const args = ghArgs(branch);
  try {
    if (!isAbsolute(root)) throw new Error('gh: repo root not absolute');
    validateGhArgs(args);
  } catch {
    return Promise.resolve({ kind: 'error' });
  }
  const bin = (deps.find ?? (() => findGh(process.env.PATH)))();
  if (!bin) return Promise.resolve({ kind: 'missing' });
  const exec = deps.exec ?? realExec;
  return new Promise((resolve) => {
    exec(bin, args, { cwd: root, env: ghEnv(), timeout: GH_TIMEOUT_MS, maxBuffer: GH_MAX_BUFFER, encoding: 'utf8' }, (err, stdout, stderr) => {
      if (err) { resolve({ kind: classifyGhFailure(err.code, stderr) }); return; }
      const pr = parseGhPr(stdout);
      resolve(pr ? { kind: 'ok', pr } : { kind: 'error' });
    });
  });
}
