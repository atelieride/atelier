import { execFile } from 'node:child_process';
import { envKey } from '@shared/env';
import { currentPlatform } from '@shared/platform';
import { devEnv } from '../dev-env';

// merge-base and rev-list: the review against the default branch — both only read history.
// log, for-each-ref and worktree list: Source Control, read-only with the rules below.
// cat-file -s: the size of a file at a commit that is too large to show ("This diff is too large to show (3.4 MB)").
// remote: the configured remotes' names, bare listing only. Fetching itself is git/fetch.ts, never here.
// config: one fixed read, whether the repo's own config names a program a fetch would run (git/fetch.ts autoFetchAllowed),
// and `--get` of one key from CONFIG_READ_KEYS.
// check-ref-format, check-ignore, version and rev-parse --git-path: what a commit, a push or a branch sheet needs to
// know before git writes anything, each a fixed shape. The writes themselves are git/write.ts.
// symbolic-ref -q HEAD: HEAD's branch, born or not, whatever the ref storage (reftable leaves HEAD's file a stub).
export type GitSub = 'status' | 'diff' | 'show' | 'rev-parse' | 'ls-files' | 'merge-base' | 'rev-list' | 'log' | 'for-each-ref' | 'worktree' | 'cat-file' | 'remote' | 'config'
  | 'check-ref-format' | 'check-ignore' | 'version' | 'symbolic-ref';
const ALLOWED: ReadonlySet<string> = new Set<GitSub>(['status', 'diff', 'show', 'rev-parse', 'ls-files', 'merge-base', 'rev-list', 'log', 'for-each-ref', 'worktree', 'cat-file', 'remote', 'config',
  'check-ref-format', 'check-ignore', 'version', 'symbolic-ref']);
/**
 * The keys `config --get <key>` may read (every scope git reads by default: identity and signing live in the global
 * config). The signing program depends on gpg.format: gpg.program (openpgp), gpg.ssh.program, gpg.x509.program.
 */
export const CONFIG_READ_KEYS: readonly string[] = ['user.name', 'user.email', 'commit.gpgsign', 'gpg.format', 'gpg.program', 'gpg.ssh.program',
  'gpg.x509.program', 'push.default', 'push.autoSetupRemote'];
/** The paths `rev-parse --git-path <name>` may resolve: the in-progress operations, the index lock, the hooks folder. */
export const GIT_PATH_NAMES: readonly string[] = ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply', 'index.lock', 'hooks'];
const plainArg = (a: string | undefined): a is string => !!a && !a.startsWith('-') && !a.includes('\0');
/**
 * `config --get remote.<name>.url`: the name a plain remote name (write.ts validRemote's shape), nothing else of a
 * remote's section. Main turns the URL into a GitHub compare base; the URL itself (it may carry credentials) stays there.
 */
const REMOTE_URL_KEY = /^remote\.([A-Za-z0-9_][A-Za-z0-9._-]{0,99})\.url$/;
const remoteUrlKey = (k: string): boolean => {
  const name = REMOTE_URL_KEY.exec(k)?.[1];
  return !!name && !name.includes('..') && !name.endsWith('.lock') && !name.endsWith('.') && !/^(?:[A-Z_]*_)?HEAD$/.test(name);
};
/**
 * The local config's keys that make a fetch run a program (and core.repositoryformatversion, always there, so git
 * exits 0 when none of the others is set). Includes followed. Canonical names: sections and keys lowercase.
 */
export const AUTO_FETCH_CONFIG_ARGS = ['config', '--local', '--includes', '--name-only', '--get-regexp',
  '^(core\\.repositoryformatversion|core\\.(sshcommand|askpass|gitproxy)|credential\\..*helper|remote\\..*\\.(uploadpack|vcs))$'] as const;
const FORBIDDEN = ['--output', '--ext-diff', '--textconv', '--exec', '-c'];
export const DIFF_GUARDS = ['--no-ext-diff', '--no-textconv', '--no-color'];
/** show and log never verify signatures either: with log.showSignature (or a signed commit shown) git would run gpg. */
export const SHOW_GUARDS = [...DIFF_GUARDS, '--no-show-signature'];
export const LOG_GUARDS = SHOW_GUARDS;
const GUARDS: Record<string, string[]> = { diff: DIFF_GUARDS, show: SHOW_GUARDS, log: LOG_GUARDS };
// Diffs come from show and diff with their own limits: a log never prints patches, stats or file lists.
const LOG_PATCH = /^(?:-p|-u|--patch.*|--stat.*|--numstat|--shortstat|--dirstat.*|--summary|-L.*|--raw|--name-only|--name-status)$/;
const MERGE_DIFF = /^(?:--cc|-c|--remerge-diff|--diff-merges.*|-m|--show-signature|--pretty.*)$/;
const REF_ROOTS =['refs/heads', 'refs/remotes', 'refs/tags', 'refs/stash'];
// Output quoting meant to be evaluated by a shell: never needed, never offered.
const REF_OUTPUT = /^--(?:shell|perl|python|tcl)$/;

/** Atelier uses git read-only: anything outside the closed list is a programming error. */
export function validateGitArgs(args: string[]): void {
  const sub = args[0];
  if (!sub || !ALLOWED.has(sub)) throw new Error(`git: subcommand not allowed: ${sub ?? '(empty)'}`);
  const dashdash = args.indexOf('--');
  const opts = dashdash === -1 ? args.slice(1) : args.slice(1, dashdash);
  for (const a of opts) {
    if (FORBIDDEN.some((f) => a === f || a.startsWith(f + '='))) throw new Error(`git: argument not allowed: ${a}`);
  }
  for (const g of GUARDS[sub] ?? []) if (!opts.includes(g)) throw new Error(`git ${sub}: missing ${g}`);
  if (sub === 'log' || sub === 'show') {
    // Merge diffs in other words (--remerge-diff writes temporary objects), signature checks (they run gpg).
    const bad = opts.find((a) => MERGE_DIFF.test(a) || (a.startsWith('--format=') && a.includes('%G')));
    if (bad) throw new Error(`git ${sub}: argument not allowed: ${bad}`);
  }
  if (sub === 'log') {
    if (!opts.some((a) => a.startsWith('--format='))) throw new Error('git log: --format required');
    const bad = opts.find((a) => LOG_PATCH.test(a));
    if (bad) throw new Error(`git log: argument not allowed: ${bad}`);
  }
  if (sub === 'for-each-ref') {
    if (!opts.some((a) => a.startsWith('--format='))) throw new Error('git for-each-ref: --format required');
    for (const a of opts) {
      if (REF_OUTPUT.test(a)) throw new Error(`git for-each-ref: argument not allowed: ${a}`);
      if (!a.startsWith('-') && !REF_ROOTS.some((r) => a === r || a.startsWith(r + '/'))) throw new Error(`git for-each-ref: pattern not allowed: ${a}`);
    }
  }
  if (sub === 'cat-file') {
    const ok = args.length === 3 && args[1] === '-s' && /^(?:[0-9a-f]{40}|[0-9a-f]{64}):[^\0]+$/.test(args[2]!);
    if (!ok) throw new Error('git cat-file: only "-s <commit id>:<path>" is allowed');
  }
  // Names only: `-v` prints URLs (which may carry credentials), anything else changes the remotes.
  if (sub === 'remote' && args.length !== 1) throw new Error('git remote: only the bare listing is allowed');
  if (sub === 'config') {
    const fetchSafety = args.length === AUTO_FETCH_CONFIG_ARGS.length && args.every((a, i) => a === AUTO_FETCH_CONFIG_ARGS[i]);
    const keyRead = args.length === 3 && args[1] === '--get' && (CONFIG_READ_KEYS.includes(args[2]!) || remoteUrlKey(args[2]!));
    if (!fetchSafety && !keyRead) throw new Error('git config: only the fetch safety read and "--get <listed key>" are allowed');
  }
  if (sub === 'check-ref-format' && !(args.length === 3 && args[1] === '--branch' && plainArg(args[2]))) {
    throw new Error('git check-ref-format: only "--branch <name>" is allowed');
  }
  if (sub === 'check-ignore' && !(args.length === 4 && args[1] === '-q' && args[2] === '--' && !!args[3] && !args[3].includes('\0'))) {
    throw new Error('git check-ignore: only "-q -- <path>" is allowed');
  }
  if (sub === 'version' && args.length !== 1) throw new Error('git version: only the bare form is allowed');
  // With a second argument it writes HEAD, with -d it deletes it: only the one read.
  if (sub === 'symbolic-ref' && !(args.length === 3 && args[1] === '-q' && args[2] === 'HEAD')) throw new Error('git symbolic-ref: only "-q HEAD" is allowed');
  if (sub === 'rev-parse') {
    for (let i = 1; i < args.length; i++) {
      const a = args[i]!;
      if (a.startsWith('--git-path=')) throw new Error(`git rev-parse: argument not allowed: ${a}`);
      if (a === '--git-path' && !GIT_PATH_NAMES.includes(args[++i] ?? '')) throw new Error(`git rev-parse: --git-path not allowed: ${args[i] ?? '(none)'}`);
    }
  }
  if (sub === 'worktree') {
    const rest = args.slice(1);
    const ok = rest[0] === 'list' && rest[1] === '--porcelain' && (rest.length === 2 || (rest.length === 3 && rest[2] === '-z'));
    if (!ok) throw new Error('git worktree: only "list --porcelain [-z]" is allowed');
  }
}

/**
 * Git environment: no inherited GIT_* variables (GIT_DIR, GIT_WORK_TREE, GIT_INDEX_FILE… could hijack it to
 * another repo) and four forced settings without using -c:
 * - diff.autoRefreshIndex=false: otherwise `git diff` rewrites .git/index when a file has only its mtime changed;
 * - core.fsmonitor=false: otherwise git would run the program configured in the repo (or start the daemon);
 * - log.showSignature=false: otherwise `git log` would run gpg on every signed commit;
 * - i18n.logOutputEncoding=UTF-8: messages come out as UTF-8 whatever the repo's commit encoding.
 * Tests (ATELIER_TEST_GIT_ISOLATED=1, set by e2eEnv and the unit setup) read no global or system config, like writeEnv.
 */
export function gitEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(base)) if (!envKey(k).startsWith('GIT_')) env[k] = v;
  const isolated = devEnv('ATELIER_TEST_GIT_ISOLATED') === '1' ? { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } : {};
  const windows = currentPlatform() === 'win32';
  return {
    ...env,
    ...isolated,
    GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GIT_PAGER: 'cat', LC_ALL: 'C',
    GIT_CONFIG_COUNT: windows ? '5' : '4',
    GIT_CONFIG_KEY_0: 'diff.autoRefreshIndex', GIT_CONFIG_VALUE_0: 'false',
    GIT_CONFIG_KEY_1: 'core.fsmonitor', GIT_CONFIG_VALUE_1: 'false',
    GIT_CONFIG_KEY_2: 'log.showSignature', GIT_CONFIG_VALUE_2: 'false',
    GIT_CONFIG_KEY_3: 'i18n.logOutputEncoding', GIT_CONFIG_VALUE_3: 'UTF-8',
    // Windows: paths past MAX_PATH read as they are, as the writes write them.
    ...(windows ? { GIT_CONFIG_KEY_4: 'core.longpaths', GIT_CONFIG_VALUE_4: 'true' } : {})
  };
}

/** The output went past `maxBytes`: the process was stopped (a file too large to show). */
export class GitTooLarge extends Error {
  constructor() { super('git: output too large'); this.name = 'GitTooLarge'; }
}

export interface GitOpts { timeoutMs?: number; maxBytes?: number; signal?: AbortSignal }

function exec<T extends string | Buffer>(repo: string, args: string[], opts: GitOpts, encoding: 'utf8' | 'buffer'): Promise<T> {
  try { validateGitArgs(args); } catch (err) { return Promise.reject(err); }
  return new Promise((resolve, reject) => {
    execFile('git', ['--no-optional-locks', '-C', repo, ...args], {
      env: gitEnv(),
      windowsHide: true,
      timeout: opts.timeoutMs ?? 10000,
      maxBuffer: opts.maxBytes ?? 20 * 1024 * 1024,
      encoding,
      ...(opts.signal ? { signal: opts.signal } : {})
    }, (err, stdout, stderr) => {
      if (!err) { resolve(stdout as T); return; }
      if ((err as NodeJS.ErrnoException).code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') { reject(new GitTooLarge()); return; }
      if (err.name === 'AbortError') { reject(new Error(`git ${args[0]}: aborted`)); return; }
      reject(new Error(`git ${args[0]}: ${(String(stderr) || err.message).trim()}`));
    });
  });
}

export function runGit(repo: string, args: string[], opts: GitOpts = {}): Promise<string> {
  return exec<string>(repo, args, opts, 'utf8');
}

/** The raw bytes of git's output (file contents at a commit: binary detection, other encodings). */
export function runGitBytes(repo: string, args: string[], opts: GitOpts = {}): Promise<Buffer> {
  return exec<Buffer>(repo, args, opts, 'buffer');
}
