import { type ChildProcess, spawn } from 'node:child_process';
import { isAbsolute, normalize } from '../cpath';
import { childOptions, signalTree } from '../proc-tree';
import { CO_AUTHOR_TRAILER, type GitOp, MAX_REF, MESSAGE_MAX_BYTES, hasClaudeCoAuthor, validBranchName } from '@shared/git-write';
import { trimTrailingSep } from '@shared/paths';
import { pathStyle } from '@shared/platform';
import { type Trace2Listener, Trace2Reader, type Trace2Signal, listenTrace2 } from './trace2';

// Shared with the automations' branch names (src/shared/automations.ts); its callers here import it from this module.
export { validBranchName };

/**
 * Git writes: the only place they run (with git/fetch.ts). One builder per op turns validated
 * input into a fixed argv; there is no generic "run these args". Paths only through stdin pathspecs (NUL-separated,
 * literal), messages only through stdin, refnames checked here and again by GitOps (`check-ref-format`). runWrite runs
 * only invocations a builder made, detached (own process group, no controlling terminal), with a timeout and a cancel
 * that stop the whole group, and an output cap past which the output is drained and dropped.
 */

export interface Invocation {
  readonly op: GitOp;
  /** After `git -C <root>`. */
  readonly args: readonly string[];
  readonly stdin?: string;
  readonly network: boolean;
  /**
   * true only for the ops that read paths from stdin (stage, unstage, restore): runWrite sets GIT_LITERAL_PATHSPECS=1
   * for them alone. Everywhere else it would reach hooks (a pre-commit's `git diff --cached -- '*.js'` would match
   * nothing) and git's own pathspecs (`stash push -u` cleans with ':/').
   */
  readonly literalPathspecs?: true;
}

// ── validation ───────────────────────────────────────────────────────────────────────────────────────────────────────

const MAX_REL_BYTES = 4096;
const MAX_RELS = 100_000;
const STASH_MESSAGE_MAX_BYTES = 1024;

/** A repo-relative path from a status read: no `..`, `.` or empty segment, no NUL, no leading slash, ≤ 4096 bytes. */
export function validRel(rel: string): boolean {
  if (typeof rel !== 'string' || !rel || rel.includes('\0') || Buffer.byteLength(rel) > MAX_REL_BYTES) return false;
  return rel.split('/').every((s) => s !== '' && s !== '.' && s !== '..') && (pathStyle() !== 'win32' || !/[\\:]/.test(rel));
}

/** A full refname under one of `roots` (`refs/heads/`, `refs/remotes/`…) whose rest is a valid branch name. */
function validFullRef(name: string, roots: readonly string[]): boolean {
  if (typeof name !== 'string' || name.length > MAX_REF + 20) return false;
  const root = roots.find((r) => name.startsWith(r));
  return !!root && validBranchName(name.slice(root.length));
}

const BRANCH_REF = ['refs/heads/'];
const START_REFS = ['refs/heads/', 'refs/remotes/', 'refs/tags/'];

/** A full object id: SHA-1 (40) or SHA-256 (64), lowercase hex. */
export function validOid(oid: string): boolean {
  return typeof oid === 'string' && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(oid);
}

/** A remote's name (GitOps also checks it is one of the listed remotes): plain characters, no `/`, no leading `-`, not HEAD-like. */
export function validRemote(name: string): boolean {
  return typeof name === 'string' && name.length <= 100 && /^[A-Za-z0-9_][A-Za-z0-9._-]*$/.test(name)
    && !name.includes('..') && !name.endsWith('.lock') && !name.endsWith('.') && !/^(?:[A-Z_]*_)?HEAD$/.test(name);
}

/**
 * A commit message (stdin only): ≤ MESSAGE_MAX_BYTES bytes, no NUL, and not only whitespace — git would refuse an
 * empty message, except that `--trailer` makes the trailer alone the message.
 */
export function validMessage(message: string): boolean {
  return typeof message === 'string' && message.trim().length > 0 && !message.includes('\0')
    && Buffer.byteLength(message) <= MESSAGE_MAX_BYTES;
}

/** A stash message (argv, `-m`): one line, ≤ 1 KB, no NUL, not empty. */
export function validStashMessage(message: string): boolean {
  return typeof message === 'string' && message.trim().length > 0 && !/[\0\n\r]/.test(message)
    && Buffer.byteLength(message) <= STASH_MESSAGE_MAX_BYTES;
}

/**
 * A new worktree's folder: absolute, normalized (no `..`, `.`, `//`, trailing separator), no NUL, not a root (`/`;
 * a drive on Windows).
 */
export function validWorktreePath(path: string): boolean {
  return typeof path === 'string' && isAbsolute(path) && !path.includes('\0') && normalize(path) === path
    && trimTrailingSep(path) === path;
}

function must(ok: boolean, what: string): void {
  if (!ok) throw new Error(`git write: invalid ${what}`);
}

const flag = (b: unknown, what: string): boolean => { must(typeof b === 'boolean', what); return b as boolean; };

/** A new branch's tracking: `--track` only for a remote branch named in full, else `--no-track` (never git's default). */
function trackFlag(track: unknown, from: string | undefined): '--track' | '--no-track' {
  if (!flag(track ?? false, 'track')) return '--no-track';
  must(from !== undefined && validFullRef(from, ['refs/remotes/']), 'track start point');
  return '--track';
}

/** NUL-separated pathspecs for `--pathspec-from-file=- --pathspec-file-nul`; 'all' → `.` (the whole root). */
function pathspecs(rels: readonly string[] | 'all', allowAll: boolean): string {
  if (rels === 'all' && allowAll) return '.';
  if (!Array.isArray(rels)) throw new Error('git write: invalid path list');
  const list: readonly string[] = rels;
  must(list.length > 0 && list.length <= MAX_RELS, 'path list');
  for (const r of list) must(validRel(r), `path ${JSON.stringify(r)}`);
  return list.join('\0');
}

const PATHSPEC_STDIN = ['--pathspec-from-file=-', '--pathspec-file-nul'];

function stashRef(index: number): string {
  must(Number.isInteger(index) && index >= 0 && index <= 999, 'stash index');
  return `stash@{${index}}`;
}

/** A start point: a branch name, a full refname main read (heads, remotes, tags) or a full oid. */
const validStart = (s: string) => validOid(s) || validBranchName(s) || validFullRef(s, START_REFS);

// ── builders ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Invocations a builder made: runWrite runs nothing else. */
const built = new WeakSet<Invocation>();

function make(op: GitOp, args: string[], o: { stdin?: string; network?: boolean; literalPathspecs?: true } = {}): Invocation {
  // Never a refspec force (`+<src>:<dst>`), whatever reached a builder; a stash message (`-m`'s value) is only text.
  args.forEach((a, i) => must(typeof a === 'string' && a.length > 0 && !a.includes('\0') && (!a.startsWith('+') || args[i - 1] === '-m'), 'argument'));
  const inv: Invocation = Object.freeze({
    op, args: Object.freeze([...args]), network: o.network ?? false, ...(o.stdin !== undefined ? { stdin: o.stdin } : {}),
    ...(o.literalPathspecs ? { literalPathspecs: true as const } : {})
  });
  built.add(inv);
  return inv;
}

/** Whether a builder made this invocation (the same object, unchanged: they are frozen). */
export function isBuilt(inv: Invocation): boolean {
  return built.has(inv);
}

/**
 * One builder per op: validated input → argv after `git -C <root>`. Each throws on invalid input.
 * Frozen: nobody swaps a builder for one of their own.
 */
export const build = Object.freeze({
  stage(rels: string[] | 'all'): Invocation {
    return make('stage', ['add', '--all', ...PATHSPEC_STDIN], { stdin: pathspecs(rels, true), literalPathspecs: true });
  },

  /**
   * No HEAD yet (`restore --staged` needs one): a mixed `reset` of the paths, which reads an unborn HEAD as empty and
   * touches only the index. (`rm --cached` refused a staged file changed again without a force.)
   */
  unstage(rels: string[] | 'all', hasHead: boolean): Invocation {
    const stdin = pathspecs(rels, true);
    return flag(hasHead, 'hasHead')
      ? make('unstage', ['restore', '--staged', ...PATHSPEC_STDIN], { stdin, literalPathspecs: true })
      : make('unstage', ['reset', '-q', ...PATHSPEC_STDIN], { stdin, literalPathspecs: true });
  },

  /** `--cleanup=whitespace` keeps `#123` lines; the trailer only when asked and not there already. */
  commit(o: { message: string; amend: boolean; noVerify: boolean; coAuthor: boolean }): Invocation {
    must(validMessage(o?.message), 'commit message');
    const args = ['commit', '--cleanup=whitespace', '-F', '-'];
    if (flag(o.amend, 'amend')) args.push('--amend');
    if (flag(o.noVerify, 'noVerify')) args.push('--no-verify');
    if (flag(o.coAuthor, 'coAuthor') && !hasClaudeCoAuthor(o.message)) args.push('--trailer', CO_AUTHOR_TRAILER);
    return make('commit', args, { stdin: o.message });
  },

  undoCommit(oid: string): Invocation {
    must(validOid(oid), 'commit id');
    return make('undoCommit', ['reset', '--soft', `${oid}~1`]);
  },

  /**
   * The branch to its own name on its push remote (`to`, what push.default=simple does), publish, or a lease on the
   * remote oid the user saw: never a plain force. Each names its remote and one explicit refspec
   * (`refs/heads/<b>:<ref>`, never `+`), so neither push.default (matching pushes every same-named branch, upstream one
   * of another name) nor a remote's push refspecs can widen or redirect them. Never tags either:
   * `--no-follow-tags` beats a configured push.followTags.
   */
  push(o: { to?: { remote: string; branch: string }; publish?: { remote: string; branch: string }; lease?: { remote: string; branch: string; ref: string; oid: string } }): Invocation {
    must(!!o && typeof o === 'object', 'push options');
    must([o.to, o.publish, o.lease].filter(Boolean).length === 1, 'push options (one of to, publish, lease)');
    const push = ['push', '--no-follow-tags'];
    if (o.to) {
      must(validRemote(o.to.remote), 'remote');
      must(validBranchName(o.to.branch), 'branch');
      const ref = `refs/heads/${o.to.branch}`;
      return make('push', [...push, o.to.remote, `${ref}:${ref}`], { network: true });
    }
    if (o.publish) {
      must(validRemote(o.publish.remote), 'remote');
      must(validBranchName(o.publish.branch), 'branch');
      const ref = `refs/heads/${o.publish.branch}`;
      return make('push', [...push, '--set-upstream', o.publish.remote, `${ref}:${ref}`], { network: true });
    }
    if (o.lease) {
      must(validRemote(o.lease.remote), 'remote');
      must(validBranchName(o.lease.branch), 'branch');
      must(validFullRef(o.lease.ref, BRANCH_REF), 'lease ref');
      must(validOid(o.lease.oid), 'lease oid');
      return make('push', [...push, `--force-with-lease=${o.lease.ref}:${o.lease.oid}`, '--force-if-includes', o.lease.remote,
        `refs/heads/${o.lease.branch}:${o.lease.ref}`], { network: true });
    }
    throw new Error('git write: invalid push options');
  },

  pull(rebase: boolean): Invocation {
    return flag(rebase, 'rebase')
      ? make('pull', ['pull', '--rebase', '--no-autostash'], { network: true })
      : make('pull', ['pull', '--ff-only', '--no-rebase'], { network: true });
  },

  /** After a rebase that conflicts: back to exactly where it started. */
  rebaseAbort(): Invocation {
    return make('pull', ['rebase', '--abort']);
  },

  /**
   * A local branch, or a remote one by its full refname (a local branch or tag named `origin/x` would shadow the short
   * one); git names the new local branch after the part past the remote (`refs/remotes/origin/feat/x` → feat/x).
   */
  switchTo(o: { branch: string } | { track: { remote: string; branch: string } }): Invocation {
    must(!!o && typeof o === 'object' && ('branch' in o) !== ('track' in o), 'switch target');
    if ('branch' in o) {
      must(validBranchName(o.branch), 'branch');
      return make('switch', ['switch', o.branch]);
    }
    const t = o.track;
    must(!!t && typeof t === 'object' && validRemote(t.remote) && validBranchName(t.branch), 'remote branch');
    return make('switch', ['switch', '--track', `refs/remotes/${t.remote}/${t.branch}`]);
  },

  /**
   * `--create`, the long option, so the static guards can ban the short one outright. The new branch tracks nothing
   * (`--no-track` beats branch.autoSetupMerge, which makes one made from origin/main track it: Push and Sync would aim at
   * main) unless `track`: the same-named remote branch's local copy, from its full refname.
   */
  branchCreate(o: { name: string; from?: string; switch: boolean; track?: boolean }): Invocation {
    must(validBranchName(o?.name), 'branch name');
    if (o.from !== undefined) must(validStart(o.from), 'start point');
    const track = trackFlag(o.track, o.from);
    const from = o.from !== undefined ? [o.from] : [];
    return flag(o.switch, 'switch')
      ? make('branchCreate', ['switch', track, '--create', o.name, ...from])
      : make('branchCreate', ['branch', track, o.name, ...from]);
  },

  /** `-m` refuses when the new name exists (never `-M`). */
  branchRename(from: string, to: string): Invocation {
    must(validBranchName(from), 'branch name');
    must(validBranchName(to), 'new branch name');
    return make('branchRename', ['branch', '-m', from, to]);
  },

  /** `-d` refuses an unmerged branch; `-D` only when the user confirmed (Undo restores it from its oid). */
  branchDelete(name: string, force: boolean): Invocation {
    must(validBranchName(name), 'branch name');
    return make('branchDelete', ['branch', flag(force, 'force') ? '-D' : '-d', name]);
  },

  /** Undo of a delete: refuses when the name exists again. */
  branchRestore(name: string, oid: string): Invocation {
    must(validBranchName(name), 'branch name');
    must(validOid(oid), 'commit id');
    return make('branchRestore', ['branch', name, oid]);
  },

  /** Undo of a delete, after branchRestore: the upstream it had (`branch -d` drops branch.<name>.remote/merge). */
  branchSetUpstream(name: string, upstream: string): Invocation {
    must(validBranchName(name), 'branch name');
    must(validFullRef(upstream, ['refs/remotes/', 'refs/heads/']), 'upstream');
    return make('branchRestore', ['branch', `--set-upstream-to=${upstream}`, name]);
  },

  /**
   * An existing branch, a new one (`-b`), or a new one from a start point; never neither (git would invent a name).
   * A new branch tracks nothing (an automation run's too: a plain push or pull never reaches its base) unless `track`,
   * as in branchCreate.
   */
  worktreeAdd(o: { path: string; branch?: string; newName?: string; track?: boolean }): Invocation {
    must(validWorktreePath(o?.path), 'worktree path');
    must(o.branch !== undefined || o.newName !== undefined, 'worktree branch');
    // Without a new name it is a local branch to check out (a full refname or an oid would give a detached HEAD).
    if (o.branch !== undefined) must(o.newName !== undefined ? validStart(o.branch) : validBranchName(o.branch), 'branch');
    if (o.newName !== undefined) must(validBranchName(o.newName), 'new branch name');
    const args = ['worktree', 'add'];
    if (o.newName !== undefined) args.push(trackFlag(o.track, o.branch), '-b', o.newName);
    else must(o.track === undefined, 'track without a new branch');
    args.push(o.path);
    if (o.branch !== undefined) args.push(o.branch);
    return make('worktreeAdd', args);
  },

  /** An automation run's worktree, never forced: git itself keeps one with changes or a lock. */
  worktreeRemove(path: string): Invocation {
    must(validWorktreePath(path) && normalize(path + '/..') !== path, 'worktree path');
    return make('worktreeRemove', ['worktree', 'remove', path]);
  },

  stashPush(o: { message: string; untracked: boolean; staged: boolean }): Invocation {
    must(validStashMessage(o?.message), 'stash message');
    const untracked = flag(o.untracked, 'untracked'); const staged = flag(o.staged, 'staged');
    must(!(untracked && staged), 'stash options (untracked and staged)');
    // No pathspec in this argv, so no literal pathspecs: they would break git's own ':/' (see Invocation.literalPathspecs).
    return make('stashPush', ['stash', 'push', ...(untracked ? ['-u'] : []), ...(staged ? ['--staged'] : []), '-m', o.message]);
  },

  /**
   * A stash by its commit id, never by its place in the list (a session's `git stash` in between moves every index);
   * `--index` keeps what was staged (left out only when git refused it: GitOps). Pop is this, then a drop checked
   * against the id git names (GitOps).
   */
  stashApply(oid: string, o: { index: boolean } = { index: true }): Invocation {
    must(validOid(oid), 'stash id');
    return make('stashApply', ['stash', 'apply', ...(flag(o?.index, 'index') ? ['--index'] : []), oid]);
  },

  stashDrop(index: number): Invocation {
    return make('stashDrop', ['stash', 'drop', stashRef(index)]);
  },

  /** Undo of a drop: the dropped stash's commit back on the list. */
  stashStore(oid: string, message: string): Invocation {
    must(validOid(oid), 'stash id');
    must(validStashMessage(message), 'stash message');
    return make('stashRestore', ['stash', 'store', '-m', message, oid]);
  },

  /** Discard, after the Trash step: HEAD's content back in the index and the work tree. Never 'all'. */
  restore(rels: string[]): Invocation {
    return make('discard', ['restore', '--source=HEAD', '--staged', '--worktree', ...PATHSPEC_STDIN], { stdin: pathspecs(rels, false), literalPathspecs: true });
  }
});

// ── the runner ───────────────────────────────────────────────────────────────────────────────────────────────────────

export const LOCAL_TIMEOUT_MS = 15 * 60_000;
export const NETWORK_TIMEOUT_MS = 5 * 60_000;
export const WRITE_MAX_BYTES = 1024 * 1024;
/** After a kill, or after git exited: how long a leftover holding the pipes may delay the answer. */
const GRACE_MS = 500;
/** Stop: SIGTERM first (git removes its index.lock and other lock files), SIGKILL when still running this much later. */
const TERM_GRACE_MS = 2000;

export interface RunOpts {
  /** writeEnv's output (refused otherwise); GIT_TRACE2_EVENT is set here, one socket per run. */
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  /** Output as it comes, stdout and stderr merged in arrival order, ANSI stripped. */
  onChunk?(s: string): void;
  onPhase?(p: Trace2Signal): void;
  signal?: AbortSignal;
  /** The configured gpg.program (its basename is a signing phase too). */
  gpgProgram?: string | null;
  /**
   * A cleanup step (rebase --abort, popping Atelier's own stash back): Quit Anyway's stopAllWrites lets it finish, so
   * nothing is left half-done; only killAllWrites (will-quit) stops it.
   */
  cleanup?: boolean;
}

export interface RawRun {
  code: number | null;
  output: string;
  /** Output past WRITE_MAX_BYTES was dropped (git kept running: the cap never stops it). */
  truncated: boolean;
  cancelled: boolean;
  timedOut: boolean;
  /** The client-side hook that exited non-zero (trace2). */
  hookFailed?: string;
  /** The last client-side hook that started (trace2). */
  lastHook?: string;
  /** Timed out: the client-side hook that was still running then (trace2). */
  hookRunning?: string;
  /** trace2 delivered at least one event. */
  traced: boolean;
}

/** Hooks of a receiving repository: through a local (path) remote they show up in the push's trace2; never ours. */
const SERVER_HOOKS = new Set(['pre-receive', 'update', 'post-receive', 'post-update', 'proc-receive', 'push-to-checkout']);
export const isServerHook = (hook: string): boolean => SERVER_HOOKS.has(hook);

// CSI, OSC (BEL or ST), DCS/SOS/PM/APC, two-character escapes; then any other C0 control but tab, newline, CR.
const ANSI = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[PX^_][^\x1b]*\x1b\\|[@-Z\\-_])/g;
const CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;
/** An escape sequence cut at the end of a chunk: kept for the next one. */
const PARTIAL = /\x1b(?:\[[0-?]*[ -/]*|\][^\x07\x1b]*\x1b?|[PX^_][^\x1b]*\x1b?)?$/;
const MAX_CARRY = 256;

export function stripAnsi(s: string): string {
  return s.replace(ANSI, '').replace(CONTROL, '');
}

// The environment must be writeEnv's: these values, and no other GIT_* variable (GIT_DIR, GIT_INDEX_FILE,
// GIT_CONFIG_PARAMETERS — git's command-line config by another name — GIT_SSH_COMMAND…).
// GIT_LITERAL_PATHSPECS follows the invocation (set in start()), never the caller's environment.
const REQUIRED_ENV: Record<string, string> = { GIT_EDITOR: ':', GIT_SEQUENCE_EDITOR: ':', GIT_TERMINAL_PROMPT: '0' };
const ALLOWED_GIT_ENV = /^GIT_(?:TERMINAL_PROMPT|ASKPASS|EDITOR|SEQUENCE_EDITOR|MERGE_AUTOEDIT|LITERAL_PATHSPECS|CONFIG_COUNT|CONFIG_KEY_\d+|CONFIG_VALUE_\d+|CONFIG_GLOBAL|CONFIG_NOSYSTEM|TRACE2_EVENT)$/;

function refusal(root: string, inv: Invocation, env: NodeJS.ProcessEnv): string | null {
  if (typeof root !== 'string' || !isAbsolute(root) || root.includes('\0')) return 'invalid repository path';
  if (!inv || !built.has(inv)) return 'not a built invocation';
  if (!env || typeof env !== 'object') return 'no environment';
  for (const [k, v] of Object.entries(REQUIRED_ENV)) if (env[k] !== v) return `environment without ${k}=${v}`;
  const extra = Object.keys(env).find((k) => k.startsWith('GIT_') && !ALLOWED_GIT_ENV.test(k));
  return extra ? `environment with ${extra}` : null;
}

const empty = (o: Partial<RawRun>): RawRun => ({ code: null, output: '', truncated: false, cancelled: false, timedOut: false, traced: false, ...o });

/** Every run in progress: Cancel's stop (SIGTERM, then SIGKILL), an immediate SIGKILL, whether it is a cleanup. */
const running = new Set<{ stop: () => void; kill: () => void; cleanup: boolean }>();

/**
 * Quit Anyway: every write in progress is stopped as Cancel would (they run detached and would outlive the app),
 * except the cleanups, which put a stopped op back where it started.
 */
export function stopAllWrites(): void {
  for (const r of [...running]) if (!r.cleanup) r.stop();
}

/** will-quit: SIGKILL, now, to the group of every run still alive, cleanups included. */
export function killAllWrites(): void {
  for (const r of [...running]) r.kill();
}

const DROPPED_NOTE = '\n… output past 1 MB dropped\n';

/**
 * Runs a built invocation in a repo root. Never rejects: a refusal, a spawn error, a timeout, a cancel or the output
 * cap are all in the answer. stdin is always written and closed, so git never waits on it.
 */
export function runWrite(root: string, inv: Invocation, o: RunOpts): Promise<RawRun> {
  const refused = refusal(root, inv, o?.env);
  if (refused) return Promise.resolve(empty({ output: `Atelier refused to run git: ${refused}.` }));
  if (o.signal?.aborted) return Promise.resolve(empty({ cancelled: true }));
  return new Promise((resolve) => { void start(root, inv, o, resolve); });
}

async function start(root: string, inv: Invocation, o: RunOpts, resolve: (r: RawRun) => void): Promise<void> {
  const r = empty({});
  let bytes = 0;
  let settled = false;
  let stopping = false;
  let exited = false;
  let child: ChildProcess | null = null;
  let listener: Trace2Listener | null = null;
  let grace: NodeJS.Timeout | undefined;
  let escalate: NodeJS.Timeout | undefined;
  const reader = new Trace2Reader({ gpgProgram: o.gpgProgram });

  const finish = () => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    clearTimeout(grace);
    clearTimeout(escalate);
    running.delete(entry);
    o.signal?.removeEventListener('abort', quit);
    // A leftover of the group (a hook's background job) may hold the pipes: stop reading them.
    child?.stdout?.destroy();
    child?.stderr?.destroy();
    const closed = listener ? listener.close() : Promise.resolve();
    void closed.then(() => resolve({ ...r }), () => resolve({ ...r }));
  };
  // The whole group: git, its hooks and their children, gpg, ssh. The group outlives its leader while any member runs.
  const signalAll = (sig: 'SIGTERM' | 'SIGKILL') => { if (child) signalTree(child, sig); };
  const killAll = () => {
    clearTimeout(escalate);
    signalAll('SIGKILL');
    clearTimeout(grace);
    grace = setTimeout(finish, GRACE_MS);
  };
  // SIGTERM lets git remove its lock files (a SIGKILL leaves .git/index.lock behind, and every later write is "busy");
  // whatever still runs 2 s later, or once git itself ended, gets SIGKILL.
  const stop = (why: 'cancelled' | 'timedOut') => {
    if (stopping || settled) return;
    stopping = true;
    r[why] = true;
    if (!child) return; // still setting up: start() sees `stopping` before spawning
    if (exited) { killAll(); return; }
    signalAll('SIGTERM');
    escalate = setTimeout(killAll, TERM_GRACE_MS);
  };
  const quit = () => stop('cancelled');
  // will-quit: no SIGTERM grace, the app is going.
  const kill = () => {
    if (settled) return;
    if (!stopping) { stopping = true; r.cancelled = true; }
    if (child) killAll();
  };
  const entry = { stop: quit, kill, cleanup: !!o.cleanup };
  running.add(entry);
  o.signal?.addEventListener('abort', quit, { once: true });
  const timeoutMs = Number.isFinite(o.timeoutMs) && o.timeoutMs > 0 ? o.timeoutMs : inv.network ? NETWORK_TIMEOUT_MS : LOCAL_TIMEOUT_MS;
  const timer = setTimeout(() => {
    // A client hook still running (tests in pre-push, husky's npm install): the time ran out there, not at the remote.
    const hook = reader.running();
    if (hook && !isServerHook(hook)) r.hookRunning = hook;
    stop('timedOut');
  }, timeoutMs);

  listener = await listenTrace2((line) => {
    r.traced = true;
    const s = reader.push(line);
    if (!s) return;
    if ('hookFailed' in s) { if (isServerHook(s.hookFailed)) return; r.hookFailed ??= s.hookFailed; }
    else if (s.phase === 'hook') { if (isServerHook(s.hook)) return; r.lastHook = s.hook; }
    try { o.onPhase?.(s); } catch { /* the caller's problem */ }
  });
  if (stopping) { finish(); return; }

  const env: NodeJS.ProcessEnv = { ...o.env };
  // Only the ops that read paths from stdin; never inherited by a hook of any other op.
  if (inv.literalPathspecs) env.GIT_LITERAL_PATHSPECS = '1';
  else delete env.GIT_LITERAL_PATHSPECS;
  if (listener.event) env.GIT_TRACE2_EVENT = listener.event;
  else delete env.GIT_TRACE2_EVENT;

  const emit = (text: string) => {
    r.output += text;
    try { o.onChunk?.(text); } catch { /* the caller's problem */ }
  };
  // Past the cap the pipes are still drained (a hook blocked on a full pipe would never end) and the rest is dropped,
  // noted once: printing a lot is no failure (a post-commit's log after a commit that was made). The timeout still
  // bounds a runaway.
  const take = () => {
    let carry = '';
    return (d: string) => {
      if (settled || r.truncated) return;
      let text = carry + d;
      carry = '';
      const m = PARTIAL.exec(text);
      if (m && m[0].length <= MAX_CARRY) { carry = m[0]; text = text.slice(0, m.index); }
      text = stripAnsi(text);
      if (!text) return;
      const n = Buffer.byteLength(text);
      if (bytes + n <= WRITE_MAX_BYTES) { bytes += n; emit(text); return; }
      const head = Buffer.from(text).subarray(0, WRITE_MAX_BYTES - bytes).toString('utf8');
      bytes = WRITE_MAX_BYTES;
      r.truncated = true;
      emit(head + DROPPED_NOTE);
    };
  };

  try {
    // spawn because Node's execFile drops `detached`: its own session, so its own process group and no controlling
    // terminal (ssh, gpg's pinentry and hooks can't open /dev/tty, even in a dev run started from a terminal).
    child = spawn('git', ['-C', root, ...inv.args], { env, ...childOptions(), stdio: ['pipe', 'pipe', 'pipe'] });
  } catch (err) {
    r.output += `${(err as Error).message}\n`;
    finish();
    return;
  }
  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  child.stdout?.on('data', take());
  child.stderr?.on('data', take());
  child.stdout?.on('error', () => { /* destroyed */ });
  child.stderr?.on('error', () => { /* destroyed */ });
  child.stdin?.on('error', () => { /* git exited before reading it all (EPIPE) */ });
  child.stdin?.end(inv.stdin ?? '');
  child.on('error', (err) => { r.output += `${err.message}\n`; finish(); });
  child.on('exit', (code) => {
    r.code = code;
    exited = true;
    // Stopping: git ended (on SIGTERM, its locks removed); the rest of its group goes now.
    if (stopping) { killAll(); return; }
    // Exited, but a leftover may hold stdout/stderr open: answer soon anyway.
    grace = setTimeout(finish, GRACE_MS);
  });
  child.on('close', (code) => {
    if (code !== null) r.code = code;
    finish();
  });
}
