// Git writes behind the IPC: every op checks, in main and before any git call, the Read-only
// setting, that the root is one ScmHub listed for the sender's project, that each path is in that root's last status,
// each refname in its refs read now, each new name through check-ref-format, a stash's index and oid in the current
// list, a lease's oid the one main showed. Then the op waits its turn in the write queue (one per object store), runs
// with the user's shell environment through git/write.ts's builders only, streams its phases and output to the windows
// that show the root, and asks for a fresh status at the end. GitOps itself never builds an argv nor spawns.
import { randomUUID } from 'node:crypto';
import { constants as fsc, lstatSync, realpathSync } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, sep, toOut } from './cpath';
import type { IpcMainInvokeEvent } from 'electron';
import { IPC } from '@shared/api';
import { type Attribution, isUnsure } from '@shared/attribution';
import type { FileChange, RepoStatus } from '@shared/git';
import { CO_AUTHOR_TRAILER, branchClash, upstreamKind } from '@shared/git-write';
import { BULK_GIT_PARALLEL, inLanes } from '@shared/lanes';
import { isBelow, isGitDirName, splitPath } from '@shared/paths';
import { currentPlatform } from '@shared/platform';
import type { GitFacts, GitOp, GitOpEvent, GitOpResult, GitPhase, MessageTweak, RemoteCommit, RepoFacts, ScmMessageEvent, StageTarget, SwitchCarry, SyncAllRow } from '@shared/git-write';
import type { TerminalInfo } from '@shared/protocol';
import type { ScmFetchAnswer, ScmRef, ScmRefs, ScmRepoEntry, ScmStash, ScmWorktree } from '@shared/scm';
import type { Settings } from '@shared/settings';
import { DIFF_GUARDS, LOG_GUARDS, runGit } from './git/exec';
import { gitReadLimiter } from './git/read-limiter';
import { readStashes, readWorktrees } from './git/history';
import { type StatusChange, parseStatusV2 } from './git/parse';
import { githubRepoOf, incomingPaths, pushTargetOf, readRepoFacts, remoteCommits, stashFiles, unmergedCommits, upstreamOf } from './git/repo-facts';
import type { Trace2Signal } from './git/trace2';
import { type Invocation, LOCAL_TIMEOUT_MS, NETWORK_TIMEOUT_MS, type RawRun, build, runWrite, validBranchName, validRel, validRemote, validStashMessage, validWorktreePath } from './git/write';
import { writeEnv } from './git/write-env';
import { classifyWrite } from './git/write-outcome';
import type { WriteQueue } from './git/write-queue';
import { type MessageModel, buildMessageInput, promptsFor, readMessageSources, writeMessage } from './scm/message';
import { osWords } from '@shared/windows-words';
import {
  gitBranchCreateSchema, gitBranchDeleteSchema, gitBranchRenameSchema, gitBranchRestoreSchema, gitCheckBranchNameSchema, gitCommitSchema, gitIdSchema,
  gitPathsSchema, gitPullSchema, gitPushSchema, gitRemoteCommitsSchema, gitStashApplySchema, gitStashDropSchema, gitStashPushSchema, gitStashRestoreSchema,
  gitSwitchSchema, gitSyncAllSchema, gitSyncSchema, gitUndoCommitSchema, gitWorktreeAddSchema, gitWorktreeCheckSchema, noArgsSchema, scmMessageSchema, scmRootSchema, gitFactsSchema
} from './ipc-schemas';

export type GitOpsSettings = Pick<Settings, 'gitActions' | 'commitMessages' | 'commitUsePrompts' | 'commitLanguage'>;

/** The git reads GitOps decides with (runGit's closed list); tests replace them. */
export interface GitReads {
  facts(root: string): Promise<RepoFacts>;
  /** The repository a folder is in: its top level and common dir (absolute), or null when it isn't in one. */
  repoRoot(dir: string): Promise<{ root: string; common: string } | null>;
  head(root: string): Promise<string | null>;
  /** Every change, past the status cap (Discard All, dirty checks); a rename with its HEAD and index object names. */
  status(root: string): Promise<StatusChange[]>;
  stashes(root: string): Promise<ScmStash[]>;
  stashFiles(root: string, oid: string): Promise<string[]>;
  worktrees(root: string): Promise<ScmWorktree[]>;
  upstream(root: string, branch: string): Promise<{ remote: string; ref: string; oid: string } | null>;
  /** The local branches' short names (`for-each-ref refs/heads`). */
  branchNames(root: string): Promise<string[]>;
  /** Where a plain push of the branch goes: push remote, its push refspec's ref, the upstream's remote and ref. */
  pushTarget(root: string, branch: string): Promise<{ remote: string; ref: string; upstreamRemote: string; upstreamRef: string } | null>;
  /** `check-ref-format --branch <name>` gives the name back unchanged. */
  refName(root: string, name: string): Promise<boolean>;
  ignored(root: string, rel: string): Promise<boolean>;
  /** A commit's parent count and the files it changes against its first parent. */
  commitFiles(root: string, oid: string): Promise<{ parents: number; files: string[] }>;
  aheadBehind(root: string): Promise<{ ahead: number; behind: number } | null>;
  unmerged(root: string, branch: string): Promise<number>;
  incoming(root: string): Promise<string[]>;
  remoteCommits(root: string, n: number): Promise<RemoteCommit[]>;
  /** How many commits the upstream has that HEAD lacks (`rev-list --count HEAD..@{u}`), 0 without an upstream. */
  remoteCount(root: string): Promise<number>;
  /**
   * The rebase in progress in this work tree, as its state files say (`<rebase-merge|rebase-apply>/orig-head` and
   * `head-name`, read inside the git dir, never through a symlink), null when none or unreadable.
   */
  rebaseInfo(root: string): Promise<{ origHead: string | null; headName: string | null } | null>;
  /** The work tree's index.lock (`rev-parse --git-path index.lock`), when it exists. */
  indexLock(root: string): Promise<{ path: string; mtimeMs: number } | null>;
  /** A commit's parents (in order) and its message. */
  commitMeta(root: string, oid: string): Promise<{ parents: string[]; message: string } | null>;
  /** A configured remote's GitHub compare base (`https://github.com/<owner>/<repo>`), null for any other remote. */
  githubRepo(root: string, remote: string): Promise<string | null>;
}

const quiet = (p: Promise<string>) => p.then((s) => s.trim(), () => null);
const OID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

/** A one-line state file of git's (at most 4 KB), trimmed; never through a symlink; null when absent or unreadable. */
async function smallFile(path: string): Promise<string | null> {
  let fh: Awaited<ReturnType<typeof open>> | null = null;
  try {
    fh = await open(path, fsc.O_RDONLY | fsc.O_NOFOLLOW);
    const buf = Buffer.alloc(4096);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    return buf.subarray(0, bytesRead).toString('utf8').trim();
  } catch {
    return null;
  } finally {
    await fh?.close().catch(() => {});
  }
}

/**
 * A facts read for a view of many repositories (All Repositories asks for one block each): it waits for a slot of the
 * shared limiter. A read for an action the user is waiting on (commit, push, pull) never does.
 */
export const viewFacts = (read: (root: string) => Promise<RepoFacts>) => (root: string): Promise<RepoFacts> => gitReadLimiter.run('live', () => read(root));

export const gitReads: GitReads = {
  facts: readRepoFacts,
  repoRoot: async (dir) => {
    const out = await quiet(runGit(dir, ['rev-parse', '--path-format=absolute', '--show-toplevel', '--git-common-dir']));
    const [root, common] = (out ?? '').split('\n').map((s) => s.trim());
    return root && common && isAbsolute(root) && isAbsolute(common) ? { root: toOut(root), common: toOut(common) } : null;
  },
  head: async (root) => {
    const s = await quiet(runGit(root, ['rev-parse', '--verify', '-q', 'HEAD']));
    return s && OID.test(s) ? s : null;
  },
  status: async (root) => parseStatusV2(await runGit(root, ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all'], { maxBytes: 256 * 1024 * 1024, timeoutMs: 60_000 }), root, { oids: true }).changes,
  stashes: readStashes,
  stashFiles,
  worktrees: readWorktrees,
  upstream: upstreamOf,
  pushTarget: pushTargetOf,
  branchNames: async (root) => ((await quiet(runGit(root, ['for-each-ref', '--format=%(refname:lstrip=2)', 'refs/heads']))) ?? '').split('\n').filter(Boolean),
  refName: async (root, name) => validBranchName(name) && (await quiet(runGit(root, ['check-ref-format', '--branch', name]))) === name,
  ignored: (root, rel) => runGit(root, ['check-ignore', '-q', '--', rel]).then(() => true, () => false),
  commitFiles: async (root, oid) => {
    const parents = ((await quiet(runGit(root, ['rev-parse', `${oid}^@`]))) ?? '').split('\n').filter((p) => /^[0-9a-f]{40,64}$/.test(p)).length;
    if (parents !== 1) return { parents, files: [] };
    const out = await runGit(root, ['diff', ...DIFF_GUARDS, '--name-only', '--no-renames', '-z', `${oid}^`, oid, '--']);
    return { parents, files: out.split('\0').filter(Boolean) };
  },
  aheadBehind: async (root) => {
    const m = /^(\d+)\s+(\d+)$/.exec((await quiet(runGit(root, ['rev-list', '--left-right', '--count', 'HEAD...@{u}', '--']))) ?? '');
    return m ? { ahead: Number(m[1]), behind: Number(m[2]) } : null;
  },
  unmerged: unmergedCommits,
  incoming: (root) => incomingPaths(root).catch(() => []),
  remoteCommits: (root, n) => remoteCommits(root, n).catch(() => []),
  remoteCount: async (root) => {
    const n = Number((await quiet(runGit(root, ['rev-list', '--count', 'HEAD..@{u}', '--']))) ?? '');
    return Number.isSafeInteger(n) && n >= 0 ? n : 0;
  },
  rebaseInfo: async (root) => {
    const dirs = ((await quiet(runGit(root, ['rev-parse', '--path-format=absolute', '--git-path', 'rebase-merge', '--git-path', 'rebase-apply']))) ?? '').split('\n');
    for (const dir of dirs) {
      if (!isAbsolute(dir)) continue;
      // lstat: a symlink named rebase-merge is not a rebase in progress here.
      try { if (!lstatSync(dir).isDirectory()) continue; } catch { continue; }
      const [origHead, headName] = await Promise.all([smallFile(join(dir, 'orig-head')), smallFile(join(dir, 'head-name'))]);
      return { origHead, headName };
    }
    return null;
  },
  indexLock: async (root) => {
    const path = await quiet(runGit(root, ['rev-parse', '--path-format=absolute', '--git-path', 'index.lock']));
    if (!path || !isAbsolute(path)) return null;
    return stat(path).then((s) => ({ path, mtimeMs: s.mtimeMs }), () => null);
  },
  commitMeta: async (root, oid) => {
    if (!OID.test(oid)) return null;
    const [parents, message] = await Promise.all([
      quiet(runGit(root, ['rev-parse', `${oid}^@`])),
      runGit(root, ['show', ...LOG_GUARDS, '--no-patch', '--format=%B', oid]).catch(() => null)
    ]);
    if (parents === null || message === null) return null;
    return { parents: parents.split('\n').map((p) => p.trim()).filter((p) => OID.test(p)), message };
  },
  githubRepo: githubRepoOf
};

export interface GitOpsDeps {
  settings(): GitOpsSettings;
  /** GitHub: a project's real root and last statuses, the attribution keep set, fresh statuses. */
  git: {
    /** repos: every working tree the project shows (nested ones are never staged into an outer repo). */
    info(key: string): { root: string; repos?: readonly string[]; status: ReadonlyMap<string, RepoStatus> } | null;
    keep(root: string, paths: string[]): () => void;
    requestStatus(root: string): void;
  };
  /** ScmHub: the listed entries, refs, the manual fetch. */
  scm: {
    entryFor(key: string, root: string): Promise<ScmRepoEntry | null>;
    entries(key: string): Promise<ScmRepoEntry[]>;
    refs(key: string, root: string, fresh?: boolean): Promise<ScmRefs>;
    refsMoved(key: string): void;
    fetchNow(root: string, common: string): Promise<ScmFetchAnswer>;
  };
  queue: WriteQueue;
  /** A project's attributions and terminals (✦), and a terminal's Claude account dir (undefined: the default one). */
  sessions(key: string): { attributions: Attribution[]; terminals: TerminalInfo[] };
  accountDir(key: string, terminalId: string): string | undefined;
  /** fs/write.ts moveToTrash: the only file write (Discard). */
  trash(root: string, path: string): Promise<{ ok: true } | { error: string }>;
  userEnv(): Promise<{ env: NodeJS.ProcessEnv; captured: boolean }>;
  /** The real `claude` for ✦ (or a test's fake), null when not found. */
  claude(): string | null;
  /** An op's event to every window that shows the root. */
  emit(root: string, e: GitOpEvent): void;
  now?(): number;
  reads?: Partial<GitReads>;
  run?: typeof runWrite;
  writeMessage?: typeof writeMessage;
  /** Waits before each retry of a busy op (3 retries over 5 s). */
  retryDelaysMs?: number[];
  /** How long Undo stays offered after a commit. */
  undoTtlMs?: number;
}

interface Target { key: string; root: string; common: string; name: string }

interface UndoRecord { root: string; oid: string; files: string[]; message: string; at: number; release: () => void; timer: NodeJS.Timeout }

interface RunningOp { ev: GitOpEvent; ac: AbortController }

interface RunOpts {
  hooksExist?: boolean; gpgProgram?: string | null;
  /**
   * A cleanup step (rebase --abort, popping Atelier's own stash back): it runs even after the op was cancelled or
   * timed out, with its own signal and a short timeout, so nothing is left half-done.
   */
  cleanup?: boolean;
}

/** One op's runs: the same id, signal and environment for each git process it starts. */
interface Exec { run(inv: Invocation, o?: RunOpts): Promise<GitOpResult> }

export const READ_ONLY_MESSAGE = 'Git actions are read-only';
/** The key of ops the automations' runner starts (no window owns them). */
const AUTOMATION_KEY = 'automation-runner';
/** What git says when a worktree's files are still open somewhere (Windows won't delete them). */
const HELD_OPEN = /Permission denied|Device or resource busy|being used by another process/i;
const READ_ONLY: GitOpResult = { outcome: 'error', message: READ_ONLY_MESSAGE };
const fail = (outcome: GitOpResult['outcome'], message: string, extra: Partial<GitOpResult> = {}): GitOpResult => ({ outcome, message, ...extra });
/** An op that went through says what it left (GitOpResult.left); any other answer says nothing of it. */
const withLeft = (r: GitOpResult, left: NonNullable<GitOpResult['left']>): GitOpResult => (r.outcome === 'ok' ? { ...r, left } : r);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** A new branch named `name` made from `ref` is that remote branch's local copy: the only new branch that tracks. */
const copiesRemote = (ref: ScmRef, name: string): boolean =>
  ref.kind === 'remote' && !!ref.remote && ref.name === `refs/remotes/${ref.remote}/${name}`;
export const DISCARD_ALL_MAX = 10_000;
/** Stage All's paths go through the pathspec stdin, bounded like the IPC's own lists. */
export const STAGE_ALL_MAX = 100_000;
export const UNDO_TTL_MS = 15 * 60_000;
const BUSY_RETRIES_MS = [1500, 1500, 2000];
const PULL_STASH_MESSAGE = 'Atelier: before pull';
const FOREIGN_REBASE = "A rebase is in progress that Atelier didn't start: finish it in the terminal";

/** An op stopped by one of its client hooks: it failed, or ran out of time while it ran (classifyWrite). */
function hookStopped(r: GitOpResult): boolean {
  return r.outcome === 'hook' || (r.outcome === 'error' && !!r.hook && /hook did not finish in time/.test(r.message ?? ''));
}

/** git's refusal of a pathspec naming nothing (a listed file gone before the op ran). */
const NO_MATCH = /pathspec '[^\n]*' did not match any files/;

/**
 * git's "you are leaving N commits behind" (a switch away from a detached HEAD whose commits no branch holds): said,
 * with the commit to branch from (reachable only through the reflog afterwards).
 */
function leftBehind(r: GitOpResult): string | null {
  const m = r.outcome === 'ok' ? /you are leaving (\d+) commits? behind/i.exec(r.output ?? '') : null;
  if (!m) return null;
  const n = Number(m[1]);
  const tip = /git branch <new-branch-name> ([0-9a-f]{4,64})/.exec(r.output ?? '')?.[1];
  return `${plural(n, 'commit')} ${n === 1 ? 'was' : 'were'} left on no branch${tip ? ` (${tip})` : ''}: make a branch from it in a terminal to keep ${n === 1 ? 'it' : 'them'}`;
}

/** git's refusal of `stash apply --index` when the staged part doesn't apply on its own: nothing was applied. */
const INDEX_REFUSED = /conflicts in index\. Try without --index/i;
/** `git stash drop`'s answer: the entry and the commit it dropped. */
const DROPPED = /^Dropped (?:refs\/)?stash@\{\d+\} \(([0-9a-f]{40}(?:[0-9a-f]{24})?)\)$/m;
/** A cleanup step's timeout (RunOpts.cleanup). */
const CLEANUP_TIMEOUT_MS = 60_000;
/** A busy op's lock older than this may be left behind by a process that died. */
const OLD_LOCK_MS = 60_000;
const KEPT_NOTE = (n: number) => n === 1
  ? "1 file kept: it has staged changes that aren't in your working copy — unstage or commit them first"
  : `${n} files kept: they have staged changes that aren't in your working copy — unstage or commit them first`;

/** A rename whose index side is HEAD's blob at its old path (porcelain v2's hI = hH, not the null oid): a pure move. */
const pureRename = (c: StatusChange): boolean =>
  c.kind === 'R' && c.origRel !== undefined && !!c.headOid && c.headOid === c.indexOid && /[1-9a-f]/.test(c.headOid);

/** A message as `commit --cleanup=whitespace` leaves it: trailing spaces, blank-line runs and edges gone. */
const cleaned = (s: string) => s.replace(/\r\n/g, '\n').split('\n').map((l) => l.trimEnd()).join('\n').replace(/\n{3,}/g, '\n\n').trim();

const OP_NOUN: Record<GitOp, string> = {
  stage: 'stage', unstage: 'unstage', commit: 'commit', undoCommit: 'undo', push: 'push', pull: 'pull', sync: 'sync', switch: 'branch switch',
  branchCreate: 'new branch', branchRename: 'branch rename', branchDelete: 'branch delete', branchRestore: 'branch restore', worktreeAdd: 'new worktree', worktreeRemove: 'worktree removal',
  stashPush: 'stash', stashApply: 'stash apply', stashDrop: 'stash drop', stashRestore: 'stash restore', discard: 'discard'
};

/**
 * The quit question's text while git writes run or wait, null when none do; `ops`: each one, for the in-app
 * sheet's list.
 */
export function quitPrompt(running: GitOpEvent[]): { message: string; detail: string; ops: { noun: string; repo: string }[] } | null {
  if (running.length === 0) return null;
  const names = [...new Set(running.map((e) => basename(e.root)))];
  const ops = running.map((e) => ({ noun: OP_NOUN[e.op], repo: basename(e.root) }));
  if (running.length === 1) {
    const noun = OP_NOUN[running[0]!.op];
    return {
      message: `${/^[aeiou]/.test(noun) ? 'An' : 'A'} ${noun} is running in ${names[0]}`,
      detail: 'Wait lets it finish. Quit Anyway stops it, as Cancel would: git leaves no half-made commit, but the repository may need a look.',
      ops
    };
  }
  return {
    message: `${running.length} git actions are running`,
    detail: `In ${names.join(', ')}. Wait lets them finish. Quit Anyway stops them, as Cancel would.`,
    ops
  };
}

/** How long Quit Anyway waits for the stopped ops' cleanups before quitting all the same (will-quit kills the rest). */
export const QUIT_SETTLE_MS = 60_000;

/**
 * Quit Anyway, once the dialog is answered: the ops stop as Cancel would and new ones are refused, every other
 * write is stopped (cleanups spared), and the app quits once the ops ended, cleanups included, or after `timeoutMs`.
 */
export async function quitAnyway(d: { ops: Pick<GitOps, 'stopAll'>; stopWrites(): void; quit(): void }, timeoutMs = QUIT_SETTLE_MS): Promise<void> {
  const ended = d.ops.stopAll(timeoutMs);
  d.stopWrites();
  await ended.catch(() => false);
  d.quit();
}

/** Every git write op of the app: validation, queue, runs, events, undo records, keep sets. */
export class GitOps {
  private readonly reads: GitReads;
  private readonly ops = new Map<string, RunningOp>();
  private readonly messages = new Map<string, AbortController>();
  private readonly undos = new Map<string, UndoRecord>();
  /** Keep-set holds released once a status read after `after` arrived for their root (the prune it decides used them). */
  private readonly releases: { root: string; after: number; release: () => void }[] = [];
  /** The upstream oid main showed per root (remoteCommits): the only one a lease may name. */
  private readonly shown = new Map<string, { branch: string; oid: string }>();
  /** Branches deleted and stashes dropped here (per git common dir): the only ones Undo may restore. */
  private readonly deletedBranches = new Map<string, Map<string, { oid: string; upstream: string | null }>>();
  private readonly droppedStashes = new Map<string, { common: string; message: string }>();
  /** Every op not ended yet (Quit Anyway waits for them). */
  private readonly pending = new Set<Promise<GitOpResult>>();
  /** Quit Anyway was answered: new ops are refused. */
  private closing = false;

  constructor(private readonly deps: GitOpsDeps) {
    this.reads = { ...gitReads, ...deps.reads };
  }

  private now(): number { return this.deps.now?.() ?? Date.now(); }
  private readOnly(): boolean { return this.deps.settings().gitActions !== 'on'; }

  /** The root as listed for the project (its real path), or why not. Read-only first: before anything else. */
  private async target(key: string, root: string): Promise<Target | GitOpResult> {
    if (this.readOnly()) return READ_ONLY;
    const entry = typeof root === 'string' && isAbsolute(root) ? await this.deps.scm.entryFor(key, root) : null;
    if (!entry) return fail('error', 'Unknown repository');
    return { key, root: entry.root, common: entry.common, name: entry.name || basename(entry.root) };
  }

  /** Paths must be in the root's last status (either side of a rename), or 'all'. */
  private unknownRels(t: Target, rels: StageTarget): GitOpResult | null {
    if (rels === 'all') return null;
    const st = this.deps.git.info(t.key)?.status.get(t.root);
    if (!st || st.error) return fail('stale', 'The list of changes is not ready: try again');
    const known = new Set<string>();
    for (const c of st.changes) { known.add(c.rel); if (c.origRel) known.add(c.origRel); }
    return Array.isArray(rels) && rels.length > 0 && rels.every((r) => known.has(r)) ? null : fail('stale', 'The list of changes moved: try again');
  }

  // ── running ops ─────────────────────────────────────────────────────────────────────────────────────────────────────

  private send(rec: RunningOp, patch: Partial<GitOpEvent>): void {
    const { chunk: _c, result: _r, ...keep } = patch;
    rec.ev = { ...rec.ev, ...keep };
    try { this.deps.emit(rec.ev.root, { ...rec.ev, ...patch }); } catch { /* a window gone */ }
  }

  /**
   * Runs `body` as one op: queued behind the writes of its object store, cancellable while queued or running, its
   * events to the windows; a fresh status (of every worktree of the store when refs moved) at the end.
   */
  private op(t: Target, op: GitOp, body: (x: Exec) => Promise<GitOpResult>, o: { refs?: boolean; stamped?: boolean } = {}): Promise<GitOpResult> {
    // Quit Anyway answered: nothing new starts while the running ops end.
    if (this.closing) return Promise.resolve(fail('cancelled', 'Atelier is quitting.'));
    const p = this.runOp(t, op, body, o);
    this.pending.add(p);
    void p.finally(() => this.pending.delete(p));
    return p;
  }

  private async runOp(t: Target, op: GitOp, body: (x: Exec) => Promise<GitOpResult>, o: { refs?: boolean; stamped?: boolean }): Promise<GitOpResult> {
    const id = randomUUID();
    const rec: RunningOp = { ev: { id, root: t.root, op, phase: 'queued', startedAt: this.now() }, ac: new AbortController() };
    this.ops.set(id, rec);
    this.send(rec, { phase: 'queued' });
    let result: GitOpResult;
    let started = false;
    try {
      const job = this.deps.queue.run(t.common, async () => {
        if (rec.ac.signal.aborted) return fail('cancelled', 'Cancelled.');
        // Switched to Read-only while this op waited its turn: it never starts.
        if (this.readOnly()) return READ_ONLY;
        started = true;
        this.send(rec, { phase: 'running' });
        const user = await this.deps.userEnv().catch(() => ({ env: process.env, captured: false }));
        return body(this.exec(t, rec, user));
      });
      job.catch(() => {});
      // Cancelled while queued: answered now, not when its turn comes (then it sees the abort and never starts).
      const cancelled = new Promise<GitOpResult>((resolve) => {
        rec.ac.signal.addEventListener('abort', () => { if (!started) resolve(fail('cancelled', 'Cancelled.')); }, { once: true });
      });
      result = await Promise.race([job, cancelled]);
    } catch (err) {
      result = fail('error', (err as Error).message || 'Git write failed');
    } finally {
      this.ops.delete(id);
    }
    // Before the fresh status is asked for: the read that follows starts at or after `at`.
    if (o.stamped) result = { ...result, at: this.now() };
    this.send(rec, { phase: 'done', result });
    this.after(t, !!o.refs);
    return result;
  }

  private exec(t: Target, rec: RunningOp, user: { env: NodeJS.ProcessEnv; captured: boolean }): Exec {
    const run = this.deps.run ?? runWrite;
    const delays = this.deps.retryDelaysMs ?? BUSY_RETRIES_MS;
    return {
      run: async (inv, o = {}) => {
        // A cleanup's own signal: the op's may be aborted already (that is when cleanups matter most).
        const signal = o.cleanup ? new AbortController().signal : rec.ac.signal;
        const timeoutMs = o.cleanup ? CLEANUP_TIMEOUT_MS : inv.network ? NETWORK_TIMEOUT_MS : LOCAL_TIMEOUT_MS;
        let res: GitOpResult;
        let raw: RawRun;
        for (let attempt = 0; ; attempt++) {
          raw = await run(t.root, inv, {
            env: writeEnv(user.env), timeoutMs, signal, gpgProgram: o.gpgProgram ?? null, ...(o.cleanup ? { cleanup: true } : {}),
            onChunk: (chunk) => this.send(rec, { chunk }),
            onPhase: (p: Trace2Signal) => {
              if ('phase' in p) this.send(rec, p.phase === 'hook' ? { phase: 'hook', hook: p.hook } : { phase: 'signing' as GitPhase });
            }
          });
          res = classifyWrite(inv, raw, { hooksExist: !!o.hooksExist });
          if (res.outcome !== 'busy' || attempt >= delays.length || signal.aborted) break;
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, delays[attempt]);
            signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
          });
          if (signal.aborted) return fail('cancelled', 'Cancelled.');
          this.send(rec, { phase: 'running' });
        }
        if (res.outcome === 'busy') {
          const lock = await this.reads.indexLock(t.root).catch(() => null);
          const old = lock && this.now() - lock.mtimeMs > OLD_LOCK_MS ? ` Its lock file (${this.lockName(t, lock.path)}) is over a minute old: if no git command is running, remove it from the terminal.` : '';
          res = { ...res, message: `Git is busy in ${t.name}: a session is committing. Try again.${old}` };
        } else if (raw.cancelled || raw.timedOut) {
          // Stopped (SIGTERM first: git removes its own locks). A lock still there is reported, never deleted: only
          // the user can tell no git command of theirs holds it. Our own ops on this store wait in the queue.
          const lock = await this.reads.indexLock(t.root).catch(() => null);
          if (lock) res = { ...res, outcome: 'error', message: `A git lock file was left behind in ${t.name} (${this.lockName(t, lock.path)}). If no git command is running, remove it from the terminal.` };
        }
        if (!user.captured) res = { ...res, noShellEnv: true };
        return res;
      }
    };
  }

  /** A lock's path as the user finds it: from the root (`.git/index.lock`), else absolute (a linked worktree's). */
  private lockName(t: Target, path: string): string {
    const rel = relative(t.root, path);
    return rel && !rel.startsWith('..') && !isAbsolute(rel) ? rel.split(sep).join('/') : path;
  }

  private after(t: Target, refs: boolean): void {
    this.deps.git.requestStatus(t.root);
    // An automation's op has no window: the windows' own reads pick the new refs up.
    if (!refs || t.key === AUTOMATION_KEY) return;
    this.deps.scm.refsMoved(t.key);
    void this.deps.scm.entries(t.key).then((list) => {
      for (const e of list) if (e.common === t.common && e.root !== t.root) this.deps.git.requestStatus(e.root);
    }, () => {});
  }

  /** Cancel: a queued op never starts, a running one's process group is killed. */
  cancel(id: string): void {
    this.ops.get(id)?.ac.abort();
    this.messages.get(id)?.abort();
  }

  /** Every op stops as Cancel would (their cleanups still run). */
  cancelAll(): void {
    for (const rec of this.ops.values()) rec.ac.abort();
    for (const ac of this.messages.values()) ac.abort();
  }

  /**
   * Quit Anyway: no new op starts, every op stops as Cancel would, and this answers once they all ended, their
   * cleanups included (rebase --abort, Stash and Pull's pop, stash-and-switch's pop back), or after `timeoutMs` (false).
   */
  async stopAll(timeoutMs: number): Promise<boolean> {
    this.closing = true;
    this.cancelAll();
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); });
    try {
      return await Promise.race([Promise.all([...this.pending]).then(() => true), late]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** The quit Quit Anyway started was called off (a page kept, the info dialog cancelled): ops may start again. */
  resume(): void {
    this.closing = false;
  }

  /** Every op queued or running (the quit dialog names them). */
  runningOps(): GitOpEvent[] {
    return [...this.ops.values()].map((r) => r.ev);
  }

  /** The ops of the project's working trees (a window that opens mid-op). */
  async running(key: string): Promise<GitOpEvent[]> {
    const roots = new Set((await this.deps.scm.entries(key).catch(() => [])).map((e) => e.root));
    return this.runningOps().filter((e) => roots.has(e.root));
  }

  // ── statuses: undo records and keep sets ─────────────────────────────────────────────────────────────

  /** Every status main reads (GitHub.onStatus): Undo ends when HEAD moved away or the commit is pushed; holds end. */
  statusChanged(st: RepoStatus): void {
    for (let i = this.releases.length - 1; i >= 0; i--) {
      const r = this.releases[i]!;
      if (r.root === st.root && st.checkedAt > r.after) { this.releases.splice(i, 1); r.release(); }
    }
    const u = this.undos.get(st.root);
    // A status read before the commit was recorded still shows the old HEAD: it says nothing about the commit.
    if (!u || st.error || st.checkedAt <= u.at) return;
    if (st.oid !== u.oid || (!!st.upstream && st.ahead === 0)) this.endUndo(u);
  }

  /** Releases a hold once a status read after now came in (or after a minute at the latest). */
  private releaseLater(root: string, release: () => void): void {
    const r = { root, after: this.now(), release };
    this.releases.push(r);
    setTimeout(() => { const i = this.releases.indexOf(r); if (i >= 0) { this.releases.splice(i, 1); release(); } }, 60_000).unref?.();
    this.deps.git.requestStatus(root);
  }

  private endUndo(u: UndoRecord, released = false): void {
    if (this.undos.get(u.root) === u) this.undos.delete(u.root);
    clearTimeout(u.timer);
    if (released) this.releaseLater(u.root, u.release); else u.release();
  }

  private async recordUndo(t: Target, oid: string, message: string): Promise<boolean> {
    const prev = this.undos.get(t.root);
    if (prev) this.endUndo(prev);
    const { parents, files } = await this.reads.commitFiles(t.root, oid).catch(() => ({ parents: 0, files: [] as string[] }));
    if (parents !== 1) return false;
    const u: UndoRecord = {
      root: t.root, oid, files, message, at: this.now(), release: this.deps.git.keep(t.root, files),
      timer: setTimeout(() => this.endUndo(u), this.deps.undoTtlMs ?? UNDO_TTL_MS)
    };
    u.timer.unref?.();
    this.undos.set(t.root, u);
    return true;
  }

  /** The undo still offered for this root, checked against facts read now (HEAD, upstream, parents). */
  private undoFor(root: string, f: RepoFacts): UndoRecord | null {
    const u = this.undos.get(root);
    if (!u) return null;
    if (f.head !== u.oid || f.headPushed || !f.headHasParent || f.headIsMerge) { this.endUndo(u); return null; }
    return u;
  }

  // ── staging ─────────────────────────────────────────────────────────────────────────────────────────────────────────

  async stage(key: string, a: { root: string; rels: StageTarget }): Promise<GitOpResult> {
    const t = await this.target(key, a.root);
    if (!('key' in t)) return t;
    const bad = this.unknownRels(t, a.rels);
    if (bad) return bad;
    // `git add` of an unmerged file marks its conflict resolved; submodules aren't committed from Atelier.
    if (a.rels !== 'all') {
      const want = new Set(a.rels);
      const blocked = this.deps.git.info(t.key)?.status.get(t.root)?.changes.filter((c) => (want.has(c.rel) || (!!c.origRel && want.has(c.origRel))) && (c.kind === 'U' || c.submodule)) ?? [];
      if (blocked.length) return fail('state', blocked.some((c) => c.kind === 'U') ? 'Resolve the conflict first' : "Submodules aren't committed from Atelier yet", { files: blocked.map((c) => c.rel) });
    }
    return this.op(t, 'stage', async (x) => {
      if (a.rels !== 'all') {
        const r = await x.run(build.stage(a.rels));
        if (r.outcome === 'ok' || !NO_MATCH.test(r.output ?? '')) return r;
        // A new file listed but gone before the click (a session's temp file): git refused the whole list for it. The
        // rest is staged: the paths a status read now still names.
        const now = new Set((await this.reads.status(t.root)).flatMap((c) => (c.origRel ? [c.rel, c.origRel] : [c.rel])));
        const still = a.rels.filter((rel) => now.has(rel));
        if (still.length === 0) return fail('nothing', 'Those files are gone: nothing to stage');
        return still.length === a.rels.length ? r : x.run(build.stage(still));
      }
      // Stage All: the paths of a status read now (the last one may be truncated or old), each named, never `.`, which
      // would also take unmerged files (resolving them), a submodule's new commit and an untracked nested repository
      // (as a gitlink).
      const all = await this.reads.status(t.root);
      const unmerged = all.filter((c) => c.kind === 'U');
      if (unmerged.length) return fail('state', 'Resolve the conflicts first', { files: unmerged.slice(0, 50).map((c) => c.rel) });
      const rels = this.stageAllPaths(t, all);
      if (rels.length === 0) return fail('nothing', 'Nothing to stage');
      if (rels.length > STAGE_ALL_MAX) return fail('error', `Too many changes to stage at once (${rels.length}): stage them in smaller groups`);
      return x.run(build.stage(rels));
    }, { stamped: true });
  }

  /** Stage All's paths: plain files only (both sides of a rename), no submodule, nested repository or folder entry. */
  private stageAllPaths(t: Target, all: FileChange[]): string[] {
    const nested = (this.deps.git.info(t.key)?.repos ?? []).filter((r) => r !== t.root && isBelow(t.root, r)).map((r) => r.slice(t.root.length + 1));
    const inNested = (rel: string) => nested.some((n) => rel === n || rel.startsWith(n + '/'));
    const out: string[] = [];
    for (const c of all) {
      if (c.submodule || c.kind === 'U') continue;
      const paths = c.origRel !== undefined ? [c.origRel, c.rel] : [c.rel];
      // `dir/`: an untracked folder git won't list file by file, i.e. a repository of its own.
      if (paths.some((p) => !validRel(p) || inNested(p))) continue;
      out.push(...paths);
    }
    return out;
  }

  async unstage(key: string, a: { root: string; rels: StageTarget }): Promise<GitOpResult> {
    const t = await this.target(key, a.root);
    if (!('key' in t)) return t;
    const bad = this.unknownRels(t, a.rels);
    if (bad) return bad;
    // An unmerged file's stages are the conflict itself; unstaging during a merge drops what it merged in.
    if (a.rels !== 'all') {
      const want = new Set(a.rels);
      const blocked = this.deps.git.info(t.key)?.status.get(t.root)?.changes.filter((c) => want.has(c.rel) && c.kind === 'U') ?? [];
      if (blocked.length) return fail('state', 'Resolve the conflict first', { files: blocked.map((c) => c.rel) });
    }
    return this.op(t, 'unstage', async (x) => {
      if (a.rels === 'all') {
        const f = await this.reads.facts(t.root);
        if (f.state) return fail('state', `${t.name} is in the middle of a ${f.state}: finish it in the terminal`);
        const unmerged = (await this.reads.status(t.root)).filter((c) => c.kind === 'U');
        if (unmerged.length) return fail('state', 'Resolve the conflicts first', { files: unmerged.slice(0, 50).map((c) => c.rel) });
      }
      return x.run(build.unstage(a.rels, (await this.reads.head(t.root)) !== null));
    }, { stamped: true });
  }

  // ── commit and undo ─────────────────────────────────────────────────────────────────────────────────────────────────

  async commit(key: string, a: { root: string; message: string; amend: boolean; coAuthor: boolean; noVerify: boolean; expectHead?: string }): Promise<GitOpResult> {
    const t = await this.target(key, a.root);
    if (!('key' in t)) return t;
    return this.op(t, 'commit', async (x) => {
      const f = await this.reads.facts(t.root);
      if (!f.identity) return fail('identity', "Git doesn't know who you are: set user.name and user.email");
      if (f.state) return fail('state', `${t.name} is in the middle of a ${f.state}: finish it in the terminal`);
      // The drawer showed this HEAD (the commit an amend replaces): a session committed since, so refuse.
      if (a.expectHead !== undefined && f.head !== a.expectHead) {
        const now = f.head ? f.head.slice(0, 7) : 'no commit';
        return fail('stale', `HEAD moved: ${now} is not the commit you were ${a.amend ? 'amending' : 'looking at'}`);
      }
      if (a.amend && (!f.head || f.headIsMerge || f.headPushed)) {
        return fail('stale', !f.head ? 'There is no commit to amend yet' : f.headIsMerge ? "A merge commit can't be amended here" : 'Already pushed: amending would rewrite shared history');
      }
      // The staged paths are held from before git runs (a status read while it commits must not prune their
      // sessions), then handed to Undo's own hold or let go.
      const staged = (await this.reads.status(t.root).catch(() => [] as StatusChange[])).filter((c) => c.stage !== 'none')
        .flatMap((c) => (c.origRel !== undefined ? [c.origRel, c.rel] : [c.rel]));
      const release = staged.length ? this.deps.git.keep(t.root, staged) : () => {};
      try {
        const r = await x.run(build.commit({ message: a.message, amend: a.amend, noVerify: a.noVerify, coAuthor: a.coAuthor }),
          { hooksExist: f.hooks.preCommit || f.hooks.commitMsg, gpgProgram: f.gpgProgram });
        if (r.outcome !== 'ok') return r;
        const sha = await this.reads.head(t.root);
        if (!sha) return r;
        // Amend: no Undo (resetting would drop the commit it replaced, not the amendment).
        if (a.amend) return { ...r, sha };
        // HEAD now is ours only if it sits on the HEAD we committed on and carries our message: a session may have
        // committed (or amended) in between, and Undo must never reset its work.
        if (!(await this.isOurCommit(t, sha, f.head, a.message))) return r;
        const undo = await this.recordUndo(t, sha, a.message);
        return { ...r, sha, ...(undo ? { undo: { oid: sha } } : {}) };
      } finally {
        release();
      }
    }, { refs: true });
  }

  private async isOurCommit(t: Target, sha: string, before: string | null, message: string): Promise<boolean> {
    const meta = await this.reads.commitMeta(t.root, sha).catch(() => null);
    if (!meta) return false;
    const onBefore = before ? meta.parents[0] === before : meta.parents.length === 0;
    // Ours, as `--cleanup=whitespace` left it, with the trailer we may have added taken out (git places it before a
    // last `#…` paragraph, so it isn't always at the end).
    const sent = cleaned(message);
    const committed = sent.includes(CO_AUTHOR_TRAILER) ? meta.message : meta.message.split('\n').filter((l) => l.trim() !== CO_AUTHOR_TRAILER).join('\n');
    return onBefore && cleaned(committed) === sent;
  }

  /** Only Atelier's own last commit, still HEAD, not pushed, one parent; answers its message for the draft. */
  async undoCommit(key: string, a: { root: string; oid: string }): Promise<GitOpResult> {
    const t = await this.target(key, a.root);
    if (!('key' in t)) return t;
    return this.op(t, 'undoCommit', async (x) => {
      const u = this.undos.get(t.root);
      if (!u || u.oid !== a.oid) return fail('stale', 'Only the commit Atelier just made can be undone');
      const f = await this.reads.facts(t.root);
      if (f.state) return fail('state', `${t.name} is in the middle of a ${f.state}: finish it in the terminal`);
      if (!this.undoFor(t.root, f)) {
        return fail('stale', f.head !== a.oid ? 'HEAD moved since that commit' : f.headPushed ? 'Already pushed: undoing would rewrite shared history' : "This commit can't be undone here");
      }
      const r = await x.run(build.undoCommit(a.oid));
      if (r.outcome !== 'ok') return r;
      this.endUndo(u, true);
      return { ...r, message: u.message };
    }, { refs: true });
  }

  // ── push, pull, sync ────────────────────────────────────────────────────────────────────────────────────────────────

  async push(key: string, a: { root: string; publish?: { remote: string }; lease?: { oid: string } }): Promise<GitOpResult> {
    const t = await this.target(key, a.root);
    if (!('key' in t)) return t;
    if (a.publish && a.lease) return fail('error', 'Publish or force, not both');
    return this.op(t, 'push', (x) => this.pushIn(t, x, a), { refs: true, stamped: true });
  }

  private async pushIn(t: Target, x: Exec, a: { publish?: { remote: string }; lease?: { oid: string } }): Promise<GitOpResult> {
    const f = await this.reads.facts(t.root);
    if (!f.branch || f.detached || !f.head) return fail('state', 'Not on a branch with commits: nothing to push');
    // A name made in a terminal that git would read as more than a branch (`+main` is a forced refspec).
    if (!validBranchName(f.branch)) return fail('state', `Atelier can't push a branch named ${f.branch}: push it from the terminal`);
    let inv: Invocation;
    // Even with its upstream once it went through: published (tracks it now) or forced (the remote has what HEAD has).
    let left: NonNullable<GitOpResult['left']> | undefined = { ahead: 0, behind: 0 };
    if (a.publish) {
      const refs = await this.deps.scm.refs(t.key, t.root, true);
      if (!validRemote(a.publish.remote) || !refs.remotes.includes(a.publish.remote)) return fail('stale', 'That remote is not configured here');
      inv = build.push({ publish: { remote: a.publish.remote, branch: f.branch } });
      left = { ...left, published: a.publish.remote };
    } else if (a.lease) {
      const seen = this.shown.get(t.root);
      if (!seen || seen.branch !== f.branch || seen.oid !== a.lease.oid) return fail('stale', 'The remote moved since you looked: look again before forcing');
      const to = await this.pushTo(t, f.branch);
      if ('outcome' in to) return to;
      const up = await this.reads.upstream(t.root, f.branch);
      if (!up) return fail('state', `${f.branch} has no upstream`);
      // The lease is on the upstream's oid: only when that is where the push goes, under the branch's own name.
      if (up.remote !== to.remote || up.ref !== `refs/heads/${f.branch}`) return fail('state', `Atelier can't force this upstream (${up.remote} ${up.ref}): push from the terminal`);
      inv = build.push({ lease: { remote: up.remote, branch: f.branch, ref: up.ref, oid: seen.oid } });
    } else {
      const to = await this.pushTo(t, f.branch);
      if ('outcome' in to) return to;
      inv = build.push({ to: { remote: to.remote, branch: f.branch } });
      // Nothing left to push to the upstream when it went there; pushed to another remote (a fork), nothing known.
      left = to.upstream ? { ahead: 0 } : undefined;
    }
    const r = await x.run(inv, { hooksExist: f.hooks.prePush });
    if (r.outcome === 'ok' && a.lease) this.shown.delete(t.root);
    return r.outcome === 'auth' ? { ...r, message: "Push needs sign-in: git asked for a password Atelier can't type" } : left ? withLeft(r, left) : r;
  }

  /**
   * Where a plain push (Push, Sync) sends the branch: its push remote, under its own name — what
   * push.default=simple does, whatever push.default says. A branch tracking a branch of another name on that remote
   * (feat/x on origin/main) is refused (Publish gives it its own), and so is a remote push refspec that maps it
   * elsewhere.
   */
  private async pushTo(t: Target, branch: string): Promise<{ remote: string; upstream: boolean } | GitOpResult> {
    const p = await this.reads.pushTarget(t.root, branch).catch(() => null);
    if (!p) return fail('state', `${branch} has no upstream: publish it first`);
    const own = `refs/heads/${branch}`;
    if (p.upstreamRemote === p.remote && p.upstreamRef && p.upstreamRef !== own) {
      const up = p.upstreamRef.startsWith('refs/heads/') ? `${p.upstreamRemote}/${p.upstreamRef.slice('refs/heads/'.length)}` : `${p.upstreamRemote} ${p.upstreamRef}`;
      return fail('state', `${branch} tracks ${up}, a branch of another name: publish it as its own branch`);
    }
    if (p.ref && p.ref !== own) return fail('state', `${p.remote} pushes ${branch} to ${p.ref}: push it from the terminal`);
    const refs = await this.deps.scm.refs(t.key, t.root, true);
    if (!validRemote(p.remote) || !refs.remotes.includes(p.remote)) return fail('state', `Atelier can't push to ${p.remote}: push it from the terminal`);
    // To the upstream's own branch (another name on that remote was refused above), or to another remote (a fork).
    return { remote: p.remote, upstream: p.upstreamRemote === p.remote };
  }

  async pull(key: string, a: { root: string; rebase: boolean; stash?: boolean }): Promise<GitOpResult> {
    const t = await this.target(key, a.root);
    if (!('key' in t)) return t;
    return this.op(t, 'pull', async (x) => withLeft(await this.pullIn(t, x, a.rebase, !!a.stash), { behind: 0 }), { refs: true, stamped: true });
  }

  /**
   * Ff-only, or a rebase that is aborted at once when it stops. With `stash` (Stash and Pull): the changes are
   * stashed first and that exact stash popped after, its files kept in the keep set until the pop ended.
   */
  private async pullIn(t: Target, x: Exec, rebase: boolean, stash: boolean): Promise<GitOpResult> {
    const f = await this.reads.facts(t.root);
    if (f.state) return fail('state', `${t.name} is in the middle of a ${f.state}: finish it in the terminal`);
    if (!f.branch || !f.upstream) return fail('state', 'This branch has no upstream to pull from');
    let stashed: { oid: string; message: string; release: () => void } | null = null;
    if (stash) {
      const s = await this.sequenceStash(t, x, PULL_STASH_MESSAGE, 'nothing was pulled');
      if ('outcome' in s) return s;
      stashed = s.stashed;
    }
    // A hook after the update (post-merge, post-checkout: husky's npm install) that failed or ran out of time: the pull
    // happened all the same when HEAD moved and nothing is left in progress. Only then: a session's commit moves HEAD
    // too, so a pull failing on its own (network, diverged, dirty) is never taken for done.
    const pulled = await x.run(build.pull(rebase), { gpgProgram: f.gpgProgram });
    let r = !hookStopped(pulled) ? pulled : await this.doneAnyway(pulled, async () => {
      const after = await this.reads.facts(t.root);
      return !after.state && !!after.head && after.head !== f.head;
    });
    let foreign = false;
    if (r.outcome !== 'ok' && rebase && (await this.reads.facts(t.root).catch(() => null))?.state === 'rebase') {
      if (r.outcome === 'state' || !(await this.ourRebase(t, f))) {
        // Someone else's rebase (a session's, started before or during this pull): never aborted from here, it may
        // hold their conflict resolutions.
        foreign = true;
        r = { ...r, outcome: 'state', message: FOREIGN_REBASE };
      } else {
        // Nothing is left half-done, even when the pull was cancelled or timed out: back to where it started.
        const abort = await x.run(build.rebaseAbort(), { cleanup: true });
        r = abort.outcome !== 'ok'
          ? { ...abort, outcome: 'state', message: "Couldn't rebase cleanly, nor undo the rebase: finish it in the terminal" }
          // Stopped (cancel, timeout) or failed otherwise: its own answer, the rebase undone all the same.
          : r.outcome !== 'conflict' ? r
          : { ...r, outcome: 'conflict', message: `Couldn't rebase cleanly: your commits and ${f.upstream} change the same lines. Finish it in the terminal.` };
      }
    }
    if (r.outcome === 'auth') r = { ...r, message: "Pull needs sign-in: git asked for a password Atelier can't type" };
    if (r.outcome === 'conflict' && r.dirty) {
      const n = r.files?.length ?? 0;
      r = { ...r, message: n ? `Your changes to ${plural(n, 'file')} would be overwritten: commit or stash them first` : 'Your changes would be overwritten: commit or stash them first' };
    }
    if (!stashed) return r;
    if (foreign) {
      // Popping into someone else's rebase would mix the changes into it: they stay in the stash list.
      this.releaseLater(t.root, stashed.release);
      return { ...r, message: `${r.message}. Your changes are in the stash list (${stashed.message}).`, stash: { oid: stashed.oid, message: PULL_STASH_MESSAGE } };
    }
    const pop = await this.popExact(t, x, stashed.oid);
    this.releaseLater(t.root, stashed.release);
    if (pop.outcome === 'ok') return pop.warning ? { ...r, warning: pop.warning } : r;
    const told = pop.message ?? '';
    const message = r.outcome === 'ok' ? `Pulled, but ${told.charAt(0).toLowerCase()}${told.slice(1)}` : `${r.message ?? 'The pull failed'}. ${told}`;
    return { ...(r.outcome === 'ok' ? pop : r), message: message.trim(), stash: { oid: stashed.oid, message: PULL_STASH_MESSAGE } };
  }

  /**
   * The rebase in progress is the one this pull started: its state files name the HEAD read before the pull as the
   * original one, and this branch.
   */
  private async ourRebase(t: Target, f: RepoFacts): Promise<boolean> {
    const info = await this.reads.rebaseInfo(t.root).catch(() => null);
    return !!info && !!f.head && !!f.branch && info.origHead === f.head && info.headName === `refs/heads/${f.branch}`;
  }

  /**
   * Stashes the changes for an Atelier sequence (Stash and Pull, stash and switch), holding the stashed files in the
   * keep set until the caller lets them go. A push stopped midway (cancel, timeout) that made the stash all
   * the same gets it popped back (or says where the changes are). Answers the op's result when the sequence stops here.
   */
  private async sequenceStash(t: Target, x: Exec, message: string, notDone: string): Promise<GitOpResult | { stashed: { oid: string; message: string; release: () => void } | null }> {
    const before = (await this.reads.stashes(t.root).catch(() => [] as ScmStash[]))[0]?.oid ?? null;
    const s = await x.run(build.stashPush({ message, untracked: true, staged: false }));
    if (s.outcome === 'nothing') return { stashed: null };
    const top = (await this.reads.stashes(t.root).catch(() => [] as ScmStash[]))[0];
    if (s.outcome !== 'ok') {
      if (!top || top.oid === before || !top.message.endsWith(message)) return s;
      const back = await this.popExact(t, x, top.oid);
      return back.outcome === 'ok' ? s
        : { ...s, message: `${s.message ?? 'Stopped.'} Your changes are in the stash list (${top.message}): ${back.message ?? 'they could not be put back'}`, stash: { oid: top.oid, message: top.message } };
    }
    if (!top || !top.message.endsWith(message)) return fail('error', `Your changes are in the stash list, but not where Atelier expected them: ${notDone}`);
    const files = await this.reads.stashFiles(t.root, top.oid).catch(() => [] as string[]);
    return { stashed: { oid: top.oid, message: top.message, release: this.deps.git.keep(t.root, files) } };
  }

  /**
   * Pops the stash Atelier made, by its id, while it is still in the list (a session that popped or dropped it
   * meanwhile has its changes); its conflicts keep it. A cleanup step: it runs after a cancelled or timed-out pull or
   * switch too.
   */
  private async popExact(t: Target, x: Exec, oid: string): Promise<GitOpResult> {
    // A list that can't be read is an answer too (the callers name the stash), never a throw past its keep-set hold.
    const list = await this.reads.stashes(t.root).catch(() => null);
    if (!list) return fail('error', 'Atelier couldn\'t read the stash list to put your changes back.');
    if (!list.some((e) => e.oid === oid)) return fail('stale', 'Your stash left the list meanwhile: a session popped or dropped it.');
    const r = await this.applyStash(t, x, oid, { pop: true, cleanup: true });
    if (r.outcome === 'conflict' && r.dirty) {
      // An untracked file of the stash where a file of that name is now (one the pull brought): the rest came back,
      // that one didn't. Never "dirty": that reads as the op's own refusal (and offered Stash and Pull again).
      const { dirty: _dirty, ...rest } = r;
      const n = r.files?.length ?? 0;
      // "would be overwritten" (a session changed those files meanwhile): git applied nothing.
      if (!/already exists, no checkout/.test(r.output ?? '')) {
        return { ...rest, message: `Your stashed changes couldn't come back: ${n ? `${plural(n, 'file')} changed meanwhile` : 'files changed meanwhile'}. The stash is kept.` };
      }
      const what = n === 1 ? `Your stashed ${r.files![0]}` : n ? `Your ${plural(n, 'stashed file')}` : 'Some stashed files';
      return { ...rest, message: `${what} couldn't come back: ${n === 1 ? 'a file of that name is' : 'files of those names are'} there now. The stash is kept.` };
    }
    if (r.outcome === 'conflict') return { ...r, message: `Your stashed changes conflict${r.files?.length ? ` in ${plural(r.files.length, 'file')}` : ''}: resolve them in the terminal. The stash is kept.` };
    return r;
  }

  /** Pull (ff, or a rebase only when the caller confirmed a diverged branch), then push. */
  async sync(key: string, a: { root: string; rebase: boolean }): Promise<GitOpResult> {
    const t = await this.target(key, a.root);
    if (!('key' in t)) return t;
    return this.op(t, 'sync', (x) => this.syncIn(t, x, a.rebase), { refs: true, stamped: true });
  }

  private async syncIn(t: Target, x: Exec, rebase: boolean): Promise<GitOpResult> {
    let ab = await this.reads.aheadBehind(t.root);
    if (!ab) return fail('state', 'This branch has no upstream to sync with');
    if (ab.ahead > 0) {
      // The push it ends with must be possible before anything is pulled into the branch.
      const branch = (await this.reads.facts(t.root)).branch;
      const to = branch ? await this.pushTo(t, branch) : fail('state', 'Not on a branch with commits: nothing to push');
      if ('outcome' in to) return to;
    }
    if (ab.ahead > 0 && ab.behind > 0 && !rebase) return fail('state', `Your branch and its upstream have diverged: rebase your ${plural(ab.ahead, 'commit')} first`);
    if (ab.behind > 0) {
      const p = await this.pullIn(t, x, ab.ahead > 0, false);
      if (p.outcome !== 'ok') return p;
      ab = await this.reads.aheadBehind(t.root);
    }
    if (ab && ab.ahead > 0) {
      const pushed = await this.pushIn(t, x, {});
      return withLeft(pushed, { ...pushed.left, behind: 0 });
    }
    return ab ? { outcome: 'ok', left: { ahead: 0, behind: 0 } } : { outcome: 'ok' };
  }

  /**
   * Sync for every repository of the project with an upstream that is ahead or behind, a few at once; diverged ones
   * need you, and so do the listed ones in `skip` (their incoming changes touch files live sessions are changing):
   * never pulled. The rows keep the list's order.
   */
  async syncAll(key: string, o: { skip: string[] } = { skip: [] }): Promise<SyncAllRow[]> {
    if (this.readOnly()) return [];
    const skip = new Set(o.skip);
    const rows: SyncAllRow[] = [];
    const todo: { at: number; root: string; common: string }[] = [];
    for (const e of await this.deps.scm.entries(key)) {
      const st = e.status;
      const up = upstreamKind(st?.branch, st?.upstream, st?.upstreamGone);
      // A gone upstream has no counts; one of another name is never synced (Sync would pull main into it, and main
      // refuses to push there): it needs publishing.
      if (up === 'other' && st!.ahead > 0) { rows.push({ root: e.root, result: null, needsYou: 'no-upstream' }); continue; }
      if (!st || up !== 'own' || (st.ahead === 0 && st.behind === 0)) continue;
      if (st.ahead > 0 && st.behind > 0) { rows.push({ root: e.root, result: null, needsYou: 'diverged' }); continue; }
      if (skip.has(e.root)) { rows.push({ root: e.root, result: null, needsYou: 'live' }); continue; }
      todo.push({ at: rows.length, root: e.root, common: e.common });
      rows.push({ root: e.root, result: null });
    }
    // A few repositories at once; a repository's worktrees one after another (they share its object store, which takes
    // one write at a time). A failure stops nothing: its row says it.
    await inLanes(todo, (x) => x.common, BULK_GIT_PARALLEL, async (x) => {
      rows[x.at] = { root: x.root, result: await this.sync(key, { root: x.root, rebase: false }) };
    });
    return rows;
  }

  // ── branches ────────────────────────────────────────────────────────────────────────────────────────────────────────

  private async ref(t: Target, name: string): Promise<{ refs: ScmRefs; ref: ScmRefs['refs'][number] } | null> {
    const refs = await this.deps.scm.refs(t.key, t.root, true);
    const ref = refs.refs.find((r) => r.name === name);
    return ref ? { refs, ref } : null;
  }

  /** A new branch name: git's rules here, then check-ref-format's answer, the same name back. */
  private async newName(root: string, name: string): Promise<boolean> {
    return validBranchName(name) && this.reads.refName(root, name).catch(() => false);
  }

  /**
   * A new name that clashes with a branch's folder (feat when feat/x exists, or feat/x/y when feat/x does): git's
   * refs can't be both, and it would answer "cannot lock ref". The refusal, or null.
   */
  private async clashOf(root: string, name: string, except?: string): Promise<GitOpResult | null> {
    const names = await this.reads.branchNames(root).catch(() => [] as string[]);
    // Taken already (a session made it a moment ago): git would refuse, and a failing hook must not read as done.
    if (name !== except && names.includes(name)) return fail('error', `A branch named ${name} already exists`);
    const other = branchClash(names, name, except);
    return other ? fail('error', `A branch named ${other} exists, so ${name} can't be made: pick another name`) : null;
  }

  /**
   * Carry 'none' refuses uncommitted changes; 'bring' is a plain switch (git refuses clashes); 'stash' stashes
   * them first, named, and puts them back if the switch fails. A remote branch tracks, unless a local one has its name.
   */
  async switchTo(key: string, a: { root: string; ref: string; carry: SwitchCarry }): Promise<GitOpResult> {
    const t = await this.target(key, a.root);
    if (!('key' in t)) return t;
    return this.op(t, 'switch', async (x) => {
      const found = await this.ref(t, a.ref);
      if (!found || found.ref.kind === 'tag') return fail('stale', 'That branch is gone: look again');
      const { refs, ref } = found;
      let target: { branch: string } | { track: { remote: string; branch: string } };
      if (ref.kind === 'head') target = { branch: ref.short };
      else {
        const local = ref.remote ? ref.short.slice(ref.remote.length + 1) : '';
        if (!ref.remote || !local || ref.name !== `refs/remotes/${ref.remote}/${local}`) return fail('stale', 'That branch is gone: look again');
        if (!validRemote(ref.remote)) return fail('state', `Atelier can't track a branch of the remote ${ref.remote}: switch to it from the terminal`);
        const existing = refs.refs.find((r) => r.kind === 'head' && r.short === local);
        target = existing ? { branch: existing.short } : { track: { remote: ref.remote, branch: local } };
      }
      if ('branch' in target && refs.head.branch === target.branch && !refs.head.detached) return { outcome: 'ok' };
      if (a.carry === 'none') {
        const dirty = (await this.reads.status(t.root)).filter((c) => c.kind !== '?');
        if (dirty.length) return fail('conflict', `${plural(dirty.length, 'file')} with changes: stash them or bring them along`, { dirty: true, files: dirty.slice(0, 50).map((c) => c.rel) });
      }
      let stashed: { oid: string; message: string; release: () => void } | null = null;
      if (a.carry === 'stash') {
        let message = `Atelier: changes on ${refs.head.branch ?? 'a detached HEAD'}`;
        if (!validStashMessage(message)) message = 'Atelier: changes before a switch';
        const s = await this.sequenceStash(t, x, message, 'not switched');
        if ('outcome' in s) return s;
        stashed = s.stashed;
      }
      const to = 'branch' in target ? target.branch : target.track.branch;
      const switched = await this.doneAnyway(await x.run(build.switchTo(target)), async () => (await this.reads.facts(t.root)).branch === to);
      const left = leftBehind(switched);
      const r = left ? { ...switched, warning: switched.warning ? `${switched.warning}. ${left}` : left } : switched;
      if (!stashed) return r;
      // The stashed files stay held until a status read after the sequence.
      if (r.outcome === 'ok') { this.releaseLater(t.root, stashed.release); return { ...r, stash: { oid: stashed.oid, message: stashed.message } }; }
      const back = await this.popExact(t, x, stashed.oid);
      this.releaseLater(t.root, stashed.release);
      return { ...r, message: `${r.message ?? 'Not switched.'} ${back.outcome !== 'ok' ? 'Your changes are in the stash list.' : back.warning ? 'Your changes are back, and still in the stash list.' : 'Your changes are back.'}`.trim() };
    }, { refs: true });
  }

  /**
   * git answers a failing post-checkout hook's status for switch and worktree add although the checkout happened
   * (githooks(5)): an op that failed, was stopped or timed out is looked at again, and when its change is there it is
   * done, the failure kept as a warning (stash and switch must never pop the changes onto the new branch).
   */
  private async doneAnyway(r: GitOpResult, happened: () => Promise<boolean>): Promise<GitOpResult> {
    if (r.outcome === 'ok' || !(await happened().catch(() => false))) return r;
    const why = r.outcome === 'hook' && r.hook ? `The ${r.hook} hook failed${r.message ? `: ${r.message}` : ''}` : r.message ?? 'git ended with an error';
    return { outcome: 'ok', warning: why, ...(r.output !== undefined ? { output: r.output } : {}), ...(r.hook ? { hook: r.hook } : {}), ...(r.noShellEnv ? { noShellEnv: true as const } : {}) };
  }

  /** `same`: a rename's current name, which goes before the new one is made (feat → feat/x is fine). */
  async checkBranchName(key: string, a: { root: string; name: string; same?: string }): Promise<boolean> {
    const t = await this.target(key, a.root);
    if (!('key' in t)) return false;
    return (await this.newName(t.root, a.name)) && !(await this.clashOf(t.root, a.name, a.same));
  }

  async branchCreate(key: string, a: { root: string; name: string; from?: string; switch: boolean }): Promise<GitOpResult> {
    const t = await this.target(key, a.root);
    if (!('key' in t)) return t;
    return this.op(t, 'branchCreate', async (x) => {
      if (!(await this.newName(t.root, a.name))) return fail('error', 'Not a valid branch name');
      const clash = await this.clashOf(t.root, a.name);
      if (clash) return clash;
      let from: ScmRef | undefined;
      if (a.from !== undefined) {
        const found = await this.ref(t, a.from);
        if (!found) return fail('stale', 'That ref is gone: look again');
        from = found.ref;
      }
      const r = await x.run(build.branchCreate({ name: a.name, ...(from ? { from: from.name, track: copiesRemote(from, a.name) } : {}), switch: a.switch }));
      // `switch --create` runs post-checkout; `branch` runs no hook.
      return a.switch ? this.doneAnyway(r, async () => (await this.reads.facts(t.root)).branch === a.name) : r;
    }, { refs: true });
  }

  /** git lists a worktree at this folder (real path). */
  private async hasWorktree(t: Target, path: string): Promise<boolean> {
    const real = (p: string) => { try { return toOut(realpathSync(p)); } catch { return p; } };
    return (await this.reads.worktrees(t.root)).some((w) => !w.prunable && real(w.path) === path);
  }

  /** The worktrees where this local branch is checked out (this root included when it is current here). */
  private async checkedOut(t: Target, branch: string): Promise<string[]> {
    const real = (p: string) => { try { return toOut(realpathSync(p)); } catch { return p; } };
    return (await this.reads.worktrees(t.root)).filter((w) => w.branch === branch).map((w) => real(w.path));
  }

  async branchRename(key: string, a: { root: string; ref: string; name: string }): Promise<GitOpResult> {
    const t = await this.target(key, a.root);
    if (!('key' in t)) return t;
    return this.op(t, 'branchRename', async (x) => {
      const found = await this.ref(t, a.ref);
      if (!found || found.ref.kind !== 'head') return fail('stale', 'That branch is gone: look again');
      if ((await this.checkedOut(t, found.ref.short)).some((p) => p !== t.root)) return fail('state', `${found.ref.short} is checked out in another worktree`);
      if (!(await this.newName(t.root, a.name))) return fail('error', 'Not a valid branch name');
      const clash = await this.clashOf(t.root, a.name, found.ref.short);
      if (clash) return clash;
      return x.run(build.branchRename(found.ref.short, a.name));
    }, { refs: true });
  }

  /** Never the current branch or one checked out anywhere; -d first, -D only when asked, Undo from its oid. */
  async branchDelete(key: string, a: { root: string; ref: string; force: boolean }): Promise<GitOpResult> {
    const t = await this.target(key, a.root);
    if (!('key' in t)) return t;
    return this.op(t, 'branchDelete', async (x) => {
      const found = await this.ref(t, a.ref);
      if (!found || found.ref.kind !== 'head') return fail('stale', 'That branch is gone: look again');
      const { ref } = found;
      if (ref.current || found.refs.head.branch === ref.short) return fail('state', "The current branch can't be deleted");
      if ((await this.checkedOut(t, ref.short)).length) return fail('state', `${ref.short} is checked out in a worktree`);
      const r = await x.run(build.branchDelete(ref.short, a.force));
      if (r.outcome === 'conflict' && !a.force) {
        const n = await this.reads.unmerged(t.root, ref.short).catch(() => 0);
        // git -d asks for a merge into the branch's upstream when it has one, else into HEAD: one merged only into
        // another branch has nothing unmerged anywhere.
        const into = ref.upstream && !ref.gone ? ref.upstream.replace(/^refs\/(?:remotes|heads)\//, '') : found.refs.head.branch ?? 'HEAD';
        const message = n > 0 ? `${ref.short} has ${plural(n, 'commit')} that ${n === 1 ? "isn't" : "aren't"} merged anywhere`
          : `${ref.short} isn't merged into ${into}`;
        return { ...r, message };
      }
      if (r.outcome !== 'ok') return r;
      let deleted = this.deletedBranches.get(t.common);
      if (!deleted) { deleted = new Map(); this.deletedBranches.set(t.common, deleted); }
      // Its upstream as refs read it (branch -d drops branch.<name>.remote/merge): Undo sets it back.
      deleted.set(ref.short, { oid: ref.oid, upstream: ref.upstream && !ref.gone ? ref.upstream : null });
      return { ...r, branch: { name: ref.short, oid: ref.oid } };
    }, { refs: true });
  }

  /** Undo of a delete: only a branch deleted here, with the oid it had, and its upstream back. */
  async branchRestore(key: string, a: { root: string; name: string; oid: string }): Promise<GitOpResult> {
    const t = await this.target(key, a.root);
    if (!('key' in t)) return t;
    return this.op(t, 'branchRestore', async (x) => {
      const deleted = this.deletedBranches.get(t.common);
      const d = deleted?.get(a.name);
      if (!deleted || !d || d.oid !== a.oid) return fail('stale', 'Only a branch Atelier deleted can be restored');
      if (!(await this.newName(t.root, a.name))) return fail('error', 'Not a valid branch name');
      const clash = await this.clashOf(t.root, a.name);
      if (clash) return clash;
      const r = await x.run(build.branchRestore(a.name, a.oid));
      if (r.outcome !== 'ok') return r;
      deleted.delete(a.name);
      if (!d.upstream) return r;
      let up: GitOpResult;
      try { up = await x.run(build.branchSetUpstream(a.name, d.upstream)); } catch { up = fail('error', 'invalid upstream'); }
      return up.outcome === 'ok' ? r : { ...r, message: `${a.name} is back, without its upstream (${d.upstream.replace(/^refs\/(?:remotes|heads)\//, '')})` };
    }, { refs: true });
  }

  // ── worktrees ───────────────────────────────────────────────────────────────────────────────────────────────────────

  /**
   * A new worktree's folder: absolute and normalized, inside the project's real root (symlinks resolved through
   * its deepest existing folder), never inside a `.git`, not existing yet; whether git ignores it in this root.
   */
  private async worktreePath(t: Target, path: string, project = this.deps.git.info(t.key)?.root ?? null): Promise<{ inside: boolean; exists: boolean; ignored: boolean; real: string }> {
    const no = { inside: false, exists: false, ignored: false, real: path };
    if (!project || !validWorktreePath(path)) return no;
    let exists = false;
    try { lstatSync(path); exists = true; } catch { /* the usual case */ }
    let base = path; const rest: string[] = [];
    for (;;) {
      try { base = toOut(realpathSync(base)); break; } catch { /* not there yet */ }
      const up = dirname(base);
      if (up === base) return no;
      rest.unshift(basename(base));
      base = up;
    }
    const real = join(base, ...rest);
    const rel = relative(project, real);
    const inside = !!rel && !rel.startsWith('..') && !isAbsolute(rel) && !splitPath(rel).some((c) => isGitDirName(c));
    const inRoot = relative(t.root, real);
    const ignored = inside && !!inRoot && !inRoot.startsWith('..') && !isAbsolute(inRoot) ? await this.reads.ignored(t.root, inRoot.split(sep).join('/')) : false;
    return { inside, exists, ignored, real };
  }

  async worktreeCheck(key: string, a: { root: string; path: string }): Promise<{ inside: boolean; exists: boolean; ignored: boolean }> {
    const t = await this.target(key, a.root);
    if (!('key' in t)) return { inside: false, exists: false, ignored: false };
    const { inside, exists, ignored } = await this.worktreePath(t, a.path);
    return { inside, exists, ignored };
  }

  async worktreeAdd(key: string, a: { root: string; path: string; ref?: string; newName?: string }): Promise<GitOpResult> {
    const t = await this.target(key, a.root);
    if (!('key' in t)) return t;
    if (a.ref === undefined && a.newName === undefined) return fail('error', 'Pick a branch or a new name');
    return this.op(t, 'worktreeAdd', async (x) => {
      const where = await this.worktreePath(t, a.path);
      if (!where.inside) return fail('error', 'The folder must be inside the project (and not inside .git)');
      if (where.exists) return fail('error', 'That folder already exists');
      let branch: string | undefined;
      let track = false;
      if (a.ref !== undefined) {
        const found = await this.ref(t, a.ref);
        if (!found) return fail('stale', 'That branch is gone: look again');
        if (a.newName === undefined && found.ref.kind !== 'head') return fail('error', 'Pick a local branch, or give the new branch a name');
        branch = a.newName === undefined ? found.ref.short : found.ref.name;
        track = a.newName !== undefined && copiesRemote(found.ref, a.newName);
      }
      if (a.newName !== undefined && !(await this.newName(t.root, a.newName))) return fail('error', 'Not a valid branch name');
      const clash = a.newName !== undefined ? await this.clashOf(t.root, a.newName) : null;
      if (clash) return clash;
      const r = await x.run(build.worktreeAdd({ path: where.real, ...(branch !== undefined ? { branch } : {}), ...(a.newName !== undefined ? { newName: a.newName, track } : {}) }));
      return this.doneAnyway(r, () => this.hasWorktree(t, where.real));
    }, { refs: true });
  }

  /**
   * An automation run's worktree: no window. The runner names the project, the repository's
   * top level, the start (a full ref or an oid it just resolved) and the new branch; the same rules as the sheet's —
   * Read-only refuses, the folder inside the project, outside .git and not there yet, queued behind the store's writes.
   */
  async worktreeAddForRun(a: { project: string; root: string; path: string; start: string; newName: string }): Promise<GitOpResult> {
    if (this.readOnly()) return READ_ONLY;
    const repo = isAbsolute(a.root) ? await this.reads.repoRoot(a.root).catch(() => null) : null;
    if (!repo || repo.root !== a.root) return fail('error', 'Unknown repository');
    const t: Target = { key: AUTOMATION_KEY, root: repo.root, common: repo.common, name: basename(repo.root) };
    return this.op(t, 'worktreeAdd', async (x) => {
      const where = await this.worktreePath(t, a.path, a.project);
      if (!where.inside) return fail('error', 'The folder must be inside the project (and not inside .git)');
      if (where.exists) return fail('error', 'That folder already exists');
      if (!(await this.newName(t.root, a.newName))) return fail('error', 'Not a valid branch name');
      const clash = await this.clashOf(t.root, a.newName);
      if (clash) return clash;
      const r = await x.run(build.worktreeAdd({ path: where.real, branch: a.start, newName: a.newName }));
      return this.doneAnyway(r, () => this.hasWorktree(t, where.real));
    }, { refs: true });
  }

  /**
   * Close Run, a user action: a run's linked worktree inside the project, as git lists it, not
   * locked, with nothing left to commit (git would refuse too; this says why first). The branch always stays.
   */
  async worktreeRemoveForRun(a: { project: string; root: string; path: string }): Promise<GitOpResult> {
    if (this.readOnly()) return READ_ONLY;
    const repo = isAbsolute(a.root) ? await this.reads.repoRoot(a.root).catch(() => null) : null;
    if (!repo || repo.root !== a.root) return fail('error', 'Unknown repository');
    const t: Target = { key: AUTOMATION_KEY, root: repo.root, common: repo.common, name: basename(repo.root) };
    return this.op(t, 'worktreeRemove', async (x) => {
      const where = await this.worktreePath(t, a.path, a.project);
      if (!where.inside || !where.exists) return fail('error', 'That worktree isn\'t in the project anymore');
      const listed = (await this.reads.worktrees(t.root).catch(() => [])).find((w) => w.path === where.real);
      if (!listed || listed.path === t.root || listed.bare) return fail('error', 'That folder isn\'t a worktree of this repository');
      if (listed.locked) return fail('error', 'That worktree is locked');
      if ((await this.reads.status(where.real)).length > 0) return fail('conflict', "The worktree has changes that aren't committed, so it stays");
      const r = await x.run(build.worktreeRemove(where.real));
      // Windows keeps a folder a process still uses: git's text says "Permission denied".
      return currentPlatform() === 'win32' && r.outcome !== 'ok' && HELD_OPEN.test(r.message ?? '')
        ? { ...r, message: 'Something still has files open in that worktree (a dev server, an editor): close it, then Close Run again' } : r;
    }, { refs: true });
  }

  // ── stashes ─────────────────────────────────────────────────────────────────────────────────────────────────────────

  async stashPush(key: string, a: { root: string; message: string; untracked: boolean; staged: boolean }): Promise<GitOpResult> {
    const t = await this.target(key, a.root);
    if (!('key' in t)) return t;
    return this.op(t, 'stashPush', async (x) => {
      if (a.staged) {
        const [maj, min] = (await this.reads.facts(t.root)).gitVersion;
        if (maj < 2 || (maj === 2 && min < 35)) return fail('error', 'Stashing only the staged files needs git 2.35 or later');
      }
      const r = await x.run(build.stashPush({ message: a.message, untracked: a.untracked, staged: a.staged }));
      if (r.outcome !== 'ok') return r;
      const top = (await this.reads.stashes(t.root))[0];
      return top ? { ...r, stash: { oid: top.oid, message: top.message } } : r;
    }, { refs: true });
  }

  /** The stash at that index, if it is still the one the renderer saw. */
  private async stashAt(t: Target, index: number, oid: string): Promise<ScmStash | null> {
    const s = (await this.reads.stashes(t.root)).find((x) => x.index === index);
    return s && s.oid === oid ? s : null;
  }

  /** Refused upfront when the stash touches files changed now; a conflict keeps the stash. */
  async stashApply(key: string, a: { root: string; index: number; oid: string; pop: boolean }): Promise<GitOpResult> {
    const t = await this.target(key, a.root);
    if (!('key' in t)) return t;
    return this.op(t, 'stashApply', async (x) => {
      if (!(await this.stashAt(t, a.index, a.oid))) return fail('stale', 'The stash list moved: look again');
      const [files, changes] = await Promise.all([this.reads.stashFiles(t.root, a.oid), this.reads.status(t.root)]);
      const dirty = new Set<string>();
      for (const c of changes) { dirty.add(c.rel); if (c.origRel) dirty.add(c.origRel); }
      const overlap = files.filter((f) => dirty.has(f));
      if (overlap.length) return fail('conflict', overlap.length === 1 ? 'Commit or stash that file first' : `Commit or stash those ${overlap.length} files first`, { dirty: true, files: overlap });
      const r = await this.applyStash(t, x, a.oid, { pop: a.pop });
      if (r.outcome === 'conflict') {
        const n = r.files?.length ?? 0;
        return { ...r, message: `Applied with conflicts${n ? ` in ${plural(n, 'file')}` : ''}: resolve them in the terminal or ask a session${a.pop ? '. The stash is kept.' : ''}` };
      }
      return r;
    }, { refs: true });
  }

  async stashDrop(key: string, a: { root: string; index: number; oid: string }): Promise<GitOpResult> {
    const t = await this.target(key, a.root);
    if (!('key' in t)) return t;
    return this.op(t, 'stashDrop', async (x) => {
      const list = await this.reads.stashes(t.root);
      const s = list.find((e) => e.index === a.index && e.oid === a.oid);
      if (!s) return fail('stale', 'The stash list moved: look again');
      const r = await this.dropExact(t, x, s, list);
      if (r.outcome === 'ok') this.droppedStashes.set(s.oid, { common: t.common, message: s.message });
      return r;
    }, { refs: true });
  }

  /**
   * Drops the stash `s` (as `list` placed it): git names what it dropped, and when a session's stash push in between
   * moved the list and another one went, that one is stored back and the drop is stale.
   */
  private async dropExact(t: Target, x: Exec, s: ScmStash, list: ScmStash[], o: { cleanup?: boolean } = {}): Promise<GitOpResult> {
    const r = await x.run(build.stashDrop(s.index), o.cleanup ? { cleanup: true } : {});
    if (r.outcome !== 'ok') return r;
    const dropped = DROPPED.exec(r.output ?? '')?.[1] ?? s.oid;
    if (dropped !== s.oid) {
      // Its message: from the list read before, else its commit's subject (a stash commit's is its message).
      const was = list.find((e) => e.oid === dropped)?.message
        ?? (await this.reads.commitMeta(t.root, dropped).catch(() => null))?.message.split('\n')[0]?.trim();
      const back = await x.run(build.stashStore(dropped, was && validStashMessage(was) ? was : 'Restored stash'), { cleanup: true });
      return fail('stale', back.outcome === 'ok'
        ? 'The stash list moved: nothing was dropped. Look again'
        : `The stash list moved and another stash was dropped (${dropped.slice(0, 7)}): restore it from the terminal with git stash store`);
    }
    return { ...r, stash: { oid: dropped, message: s.message } };
  }

  /**
   * A stash's changes back by its commit id; with `pop`, that stash then dropped — found again by its id in a fresh
   * list (a session's `git stash` in between moves every index). A conflict keeps it, as `git stash pop` does.
   */
  private async applyStash(t: Target, x: Exec, oid: string, o: { pop: boolean; cleanup?: boolean }): Promise<GitOpResult> {
    const runOpts = o.cleanup ? { cleanup: true } : {};
    let r = await x.run(build.stashApply(oid), runOpts);
    // git refuses --index when the stash's staged part doesn't apply on its own here ("conflicts in index. Try without
    // --index."), and applies nothing. Without it the changes come back all the same, all unstaged.
    let unstaged = false;
    if (r.outcome !== 'ok' && INDEX_REFUSED.test(r.output ?? '')) {
      r = await x.run(build.stashApply(oid, { index: false }), runOpts);
      unstaged = r.outcome === 'ok';
    }
    const note = unstaged ? 'Applied, but what was staged in it is now unstaged' : undefined;
    if (r.outcome !== 'ok' || !o.pop) return note ? { ...r, warning: note } : r;
    const list = await this.reads.stashes(t.root).catch(() => [] as ScmStash[]);
    const s = list.find((e) => e.oid === oid);
    const drop = s ? await this.dropExact(t, x, s, list, { cleanup: true }) : fail('stale', 'it is no longer in the stash list');
    // Applied all the same: only the stash's place in the list is left to say.
    const kept = drop.outcome === 'ok' ? undefined : `The stash stays in the list: ${drop.message ?? 'it could not be dropped'}`;
    const warning = [note, kept].filter(Boolean).join('. ');
    return warning ? { ...r, warning } : r;
  }

  /** Undo of a drop: only a stash dropped here, with the message it had. */
  async stashRestore(key: string, a: { root: string; oid: string; message: string }): Promise<GitOpResult> {
    const t = await this.target(key, a.root);
    if (!('key' in t)) return t;
    return this.op(t, 'stashRestore', async (x) => {
      const d = this.droppedStashes.get(a.oid);
      if (!d || d.common !== t.common) return fail('stale', 'Only a stash Atelier dropped can be restored');
      const message = validStashMessage(d.message) ? d.message : 'Restored stash';
      const r = await x.run(build.stashStore(a.oid, message));
      if (r.outcome === 'ok') this.droppedStashes.delete(a.oid);
      return r;
    }, { refs: true });
  }

  // ── discard ─────────────────────────────────────────────────────────────────────────────────────────────────────────

  /**
   * Each file goes to the Trash first (fs/write.ts, the only file write); a failure stops there, before any git call
   * for it. Then HEAD's version comes back (both paths of a rename, whatever sits at its old path trashed first; a
   * deletion restored); a file new to the index is only unstaged; an untracked one only trashed. A file staged and then
   * changed or deleted again is kept (its staged version would be lost: no file holds it). Unmerged files and
   * submodules are left alone; so is anything that needs HEAD before the first commit. 'all': every change, read now
   * past the status cap, at most 10 000.
   */
  async discard(key: string, a: { root: string; rels: StageTarget }): Promise<GitOpResult> {
    const t = await this.target(key, a.root);
    if (!('key' in t)) return t;
    const bad = this.unknownRels(t, a.rels);
    if (bad) return bad;
    return this.op(t, 'discard', async (x) => {
      // A session committing holds index.lock: git would refuse the restore after the files went to the Trash.
      if (await this.reads.indexLock(t.root).catch(() => null)) return fail('busy', `Git is busy in ${t.name}: a session is committing. Try again.`);
      const all = await this.reads.status(t.root);
      let changes: StatusChange[];
      if (a.rels === 'all') {
        if (all.length > DISCARD_ALL_MAX) return fail('error', `Too many changes to discard at once (${all.length}): discard them in smaller groups`);
        changes = all;
      } else {
        const want = new Set(a.rels);
        changes = all.filter((c) => want.has(c.rel) || (!!c.origRel && want.has(c.origRel)));
      }
      const restore: string[] = []; const unstage: string[] = []; const skipped: string[] = []; const kept: string[] = [];
      let trashed = 0; let stopped: GitOpResult | null = null;
      const hasHead = (await this.reads.head(t.root)) !== null;
      const kindOf = (abs: string): 'file' | 'dir' | 'none' => {
        try { return lstatSync(abs).isDirectory() ? 'dir' : 'file'; } catch { return 'none'; }
      };
      changes: for (const c of changes) {
        // Nested repositories (`dir/`), conflicts, submodules, and any path git couldn't take literally: never discarded
        // from here (checked before the Trash step, so nothing is trashed that git would then refuse to restore).
        if (c.kind === 'U' || c.submodule || !validRel(c.rel) || (c.origRel !== undefined && !validRel(c.origRel))) { skipped.push(c.rel); continue; }
        // Staged, then changed or deleted again (MM, AM, MD, AD…): the staged version is in no file the Trash could
        // hold, and restoring would drop it from the index. Kept, the index untouched. Except a pure `git mv` edited
        // afterwards (RM, the index holding HEAD's own blob): nothing of it lives only in the index.
        if (c.stage === 'partial' && !pureRename(c)) { kept.push(c.rel); continue; }
        // Without a commit there is no HEAD to restore from: only new files (unstaged) and untracked ones (trashed).
        if (!hasHead && c.kind !== '?' && c.kind !== 'A') { skipped.push(c.rel); continue; }
        // A rename restores its old path too: whatever is there now (a new, untracked file) goes to the Trash first.
        const paths = c.kind === 'R' && c.origRel ? [c.rel, c.origRel] : [c.rel];
        const kinds = paths.map((p) => kindOf(join(t.root, p)));
        if (kinds.includes('dir')) { skipped.push(c.rel); continue; }
        for (const [i, p] of paths.entries()) {
          if (kinds[i] !== 'file') continue;
          const moved = await this.deps.trash(t.root, join(t.root, p)).catch((err: unknown) => ({ error: (err as Error).message }));
          if ('error' in moved) { stopped = fail('error', osWords(`Couldn't move ${p} to the Trash: nothing more was discarded`), { files: [p] }); break changes; }
          trashed++;
        }
        if (c.kind === '?') continue;
        if (c.kind === 'A') unstage.push(c.rel);
        else restore.push(...(c.kind === 'R' && c.origRel ? [c.origRel, c.rel] : [c.rel]));
      }
      const outputs: string[] = [];
      let r: GitOpResult = { outcome: 'ok' };
      if (restore.length && hasHead) {
        r = await x.run(build.restore(restore));
        if (r.output) outputs.push(r.output);
      }
      if (r.outcome === 'ok' && unstage.length) {
        r = await x.run(build.unstage(unstage, hasHead));
        if (r.output) outputs.push(r.output);
      }
      if (stopped && r.outcome === 'ok') return stopped;
      if (r.outcome !== 'ok') return { ...r, message: osWords(`${r.message ?? 'git failed'} (${plural(trashed, 'file')} already in the Trash)`) };
      const files = [...kept, ...skipped];
      if (kept.length && trashed === 0 && !restore.length && !unstage.length) return fail('state', KEPT_NOTE(kept.length), { files });
      const notes = [
        ...(kept.length ? [KEPT_NOTE(kept.length)] : []),
        ...(skipped.length ? [`${plural(skipped.length, 'file')} left alone (conflicts, submodules, folders)`] : [])
      ];
      return {
        outcome: 'ok', message: [osWords(`${plural(trashed, 'file')} moved to the Trash`), ...notes].join(' · '),
        ...(outputs.length ? { output: outputs.join('') } : {}), ...(files.length ? { files } : {})
      };
    });
  }

  // ── reads for the sheets ────────────────────────────────────────────────────────────────────────────────────────────

  /** `view`: asked by a view of many repositories (All Repositories' blocks), which waits for a read slot. */
  async facts(key: string, a: { root: string; view?: true }): Promise<GitFacts | null> {
    const t = await this.target(key, a.root);
    if (!('key' in t)) return null;
    const read = a.view ? viewFacts(this.reads.facts) : this.reads.facts;
    const [f, refs] = await Promise.all([read(t.root), this.deps.scm.refs(t.key, t.root).catch(() => null)]);
    const u = this.undoFor(t.root, f);
    const remotes = refs?.remotes ?? [];
    // Publish's "Open a pull request": a compare base per github.com remote, never the URL (it may hold a token).
    const githubRepos: Record<string, string> = {};
    await Promise.all(remotes.filter(validRemote).map(async (r) => {
      const base = await this.reads.githubRepo(t.root, r).catch(() => null);
      if (base) githubRepos[r] = base;
    }));
    return { ...f, root: t.root, undo: u ? { oid: u.oid, files: u.files } : null, remotes, githubRepos };
  }

  async incoming(key: string, a: { root: string }): Promise<string[]> {
    const t = await this.target(key, a.root);
    if (!('key' in t)) return [];
    return this.reads.incoming(t.root);
  }

  /**
   * The rejected push sheet: a manual fetch first (through the scheduler, behind any write), then the upstream's
   * commits HEAD lacks. The upstream's oid now is what main remembers: a lease may only name it.
   */
  async remoteCommits(key: string, a: { root: string; n: number }): Promise<{ commits: RemoteCommit[]; remoteOid: string | null; total: number }> {
    const t = await this.target(key, a.root);
    if (!('key' in t)) return { commits: [], remoteOid: null, total: 0 };
    await this.deps.scm.fetchNow(t.root, t.common).catch(() => null);
    const f = await this.reads.facts(t.root);
    const up = f.branch ? await this.reads.upstream(t.root, f.branch).catch(() => null) : null;
    const [commits, count] = await Promise.all([
      this.reads.remoteCommits(t.root, Math.min(Math.max(1, Math.floor(a.n)), 20)), this.reads.remoteCount(t.root).catch(() => 0)
    ]);
    if (f.branch && up) this.shown.set(t.root, { branch: f.branch, oid: up.oid }); else this.shown.delete(t.root);
    // The force sheet names how many commits it overwrites, past the few it lists.
    return { commits, remoteOid: up?.oid ?? null, total: Math.max(count, commits.length) };
  }

  // ── ✦ ──────────────────────────────────────────────────────────────────────────────────────────────────────────

  /**
   * Starts writing a commit message for the root's staged changes; the text streams to `send`. The input is built
   * here: the staged diff, the recent subjects, and (when the setting is on) what the sessions with sure attributions
   * on staged files were asked, as the account of the session with the most staged changed lines.
   */
  async message(key: string, a: { root: string; tweak?: { kind: MessageTweak; current: string } }, send: (e: ScmMessageEvent) => void): Promise<{ id: string } | { error: string }> {
    const s = this.deps.settings();
    if (s.gitActions !== 'on') return { error: READ_ONLY_MESSAGE };
    if (this.closing) return { error: 'Atelier is quitting' };
    if (s.commitMessages === 'off') return { error: 'Messages with Claude are off' };
    const t = await this.target(key, a.root);
    if (!('key' in t)) return { error: t.message ?? 'Unknown repository' };
    const claude = this.deps.claude();
    if (!claude) return { error: 'Claude Code was not found' };
    const model: MessageModel = s.commitMessages;
    const id = randomUUID();
    const ac = new AbortController();
    this.messages.set(id, ac);
    const emit = (e: ScmMessageEvent) => { try { send(e); } catch { /* window gone */ } };
    void (async () => {
      try {
        const src = await readMessageSources(t.root, { signal: ac.signal });
        if (src.files.length === 0 && !a.tweak) { emit({ id, error: 'Nothing is staged' }); return; }
        const { sessions, account } = this.messageSessions(t, src.files, src.numstat);
        const prompts = s.commitUsePrompts ? await promptsFor(sessions) : [];
        const { input, notes } = buildMessageInput({ ...src, prompts, secrets: [], language: s.commitLanguage, ...(a.tweak ? { tweak: a.tweak } : {}) });
        const res = await (this.deps.writeMessage ?? writeMessage)({
          claudeBin: claude, model, input, ...(account ? { configDir: account } : {}), signal: ac.signal, onChunk: (chunk) => emit({ id, chunk })
        });
        emit(res.ok ? { id, done: { text: res.text, model, ms: res.ms, notes } } : { id, error: res.reason });
      } catch (err) {
        emit({ id, error: ac.signal.aborted ? 'Stopped' : (err as Error).message || 'Claude could not write a message' });
      } finally {
        this.messages.delete(id);
      }
    })();
    return { id };
  }

  /** The sessions whose sure attributions cover staged files, and the account of the one with the most staged lines. */
  private messageSessions(t: Target, files: string[], numstat: { rel: string; added: number | null; removed: number | null }[]) {
    const staged = new Map(files.map((rel) => [join(t.root, rel), rel]));
    const lines = new Map(numstat.map((n) => [n.rel, (n.added ?? 0) + (n.removed ?? 0)]));
    const { attributions, terminals } = this.deps.sessions(t.key);
    const weight = new Map<string, number>();
    for (const at of attributions) {
      const rel = staged.get(at.path);
      if (rel === undefined || isUnsure(at)) continue;
      weight.set(at.terminalId, (weight.get(at.terminalId) ?? 0) + (lines.get(rel) ?? 0) + 1);
    }
    const sessions: { sessionId: string; cwd: string; configDir: string | null; title: string }[] = [];
    let best: { dir: string | undefined; w: number } | null = null;
    for (const term of terminals) {
      const w = weight.get(term.id);
      if (w === undefined || !term.session) continue;
      const dir = this.deps.accountDir(t.key, term.id);
      sessions.push({ sessionId: term.session.sessionId, cwd: term.session.cwd ?? term.cwd, configDir: dir ?? null, title: term.title });
      if (!best || w > best.w) best = { dir, w };
    }
    return { sessions, account: best?.dir };
  }

  // ── IPC ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

  /**
   * The git:* and scm:message channels: a trusted app page of a project window only, strict schemas, each
   * handler one GitOps method (which checks Read-only and the root first). Unknown senders get an error, never an op.
   */
  installIpc(projectOf: (wcId: number) => string | null, isTrusted: (e: IpcMainInvokeEvent) => boolean,
    handle: (channel: string, fn: (e: IpcMainInvokeEvent, arg: unknown) => unknown) => void): void {
    const keyOf = (e: IpcMainInvokeEvent) => {
      const k = projectOf(e.sender.id);
      if (!k || !isTrusted(e)) throw new Error('unauthorized sender');
      return k;
    };
    handle(IPC.gitStage, (e, arg) => this.stage(keyOf(e), gitPathsSchema.parse(arg)));
    handle(IPC.gitUnstage, (e, arg) => this.unstage(keyOf(e), gitPathsSchema.parse(arg)));
    handle(IPC.gitDiscard, (e, arg) => this.discard(keyOf(e), gitPathsSchema.parse(arg)));
    handle(IPC.gitCommit, (e, arg) => this.commit(keyOf(e), gitCommitSchema.parse(arg)));
    handle(IPC.gitUndoCommit, (e, arg) => this.undoCommit(keyOf(e), gitUndoCommitSchema.parse(arg)));
    handle(IPC.gitPush, (e, arg) => this.push(keyOf(e), gitPushSchema.parse(arg)));
    handle(IPC.gitPull, (e, arg) => this.pull(keyOf(e), gitPullSchema.parse(arg)));
    handle(IPC.gitSync, (e, arg) => this.sync(keyOf(e), gitSyncSchema.parse(arg)));
    handle(IPC.gitSyncAll, (e, arg) => { const k = keyOf(e); return this.syncAll(k, gitSyncAllSchema.parse(arg) ?? { skip: [] }); });
    handle(IPC.gitSwitch, (e, arg) => this.switchTo(keyOf(e), gitSwitchSchema.parse(arg)));
    handle(IPC.gitCheckBranchName, (e, arg) => this.checkBranchName(keyOf(e), gitCheckBranchNameSchema.parse(arg)));
    handle(IPC.gitBranchCreate, (e, arg) => this.branchCreate(keyOf(e), gitBranchCreateSchema.parse(arg)));
    handle(IPC.gitBranchRename, (e, arg) => this.branchRename(keyOf(e), gitBranchRenameSchema.parse(arg)));
    handle(IPC.gitBranchDelete, (e, arg) => this.branchDelete(keyOf(e), gitBranchDeleteSchema.parse(arg)));
    handle(IPC.gitBranchRestore, (e, arg) => this.branchRestore(keyOf(e), gitBranchRestoreSchema.parse(arg)));
    handle(IPC.gitWorktreeCheck, (e, arg) => this.worktreeCheck(keyOf(e), gitWorktreeCheckSchema.parse(arg)));
    handle(IPC.gitWorktreeAdd, (e, arg) => this.worktreeAdd(keyOf(e), gitWorktreeAddSchema.parse(arg)));
    handle(IPC.gitStashPush, (e, arg) => this.stashPush(keyOf(e), gitStashPushSchema.parse(arg)));
    handle(IPC.gitStashApply, (e, arg) => this.stashApply(keyOf(e), gitStashApplySchema.parse(arg)));
    handle(IPC.gitStashDrop, (e, arg) => this.stashDrop(keyOf(e), gitStashDropSchema.parse(arg)));
    handle(IPC.gitStashRestore, (e, arg) => this.stashRestore(keyOf(e), gitStashRestoreSchema.parse(arg)));
    handle(IPC.gitCancel, (e, arg) => { keyOf(e); this.cancel(gitIdSchema.parse(arg).id); });
    handle(IPC.gitFacts, (e, arg) => this.facts(keyOf(e), gitFactsSchema.parse(arg)));
    handle(IPC.gitIncoming, (e, arg) => this.incoming(keyOf(e), scmRootSchema.parse(arg)));
    handle(IPC.gitRemoteCommits, (e, arg) => this.remoteCommits(keyOf(e), gitRemoteCommitsSchema.parse(arg)));
    handle(IPC.gitRunning, (e, arg) => { const k = keyOf(e); noArgsSchema.parse(arg); return this.running(k); });
    handle(IPC.scmMessage, (e, arg) => {
      const k = keyOf(e);
      const sender = e.sender;
      return this.message(k, scmMessageSchema.parse(arg), (ev) => { if (!sender.isDestroyed()) sender.send(IPC.evScmMessage, ev); });
    });
    handle(IPC.scmMessageCancel, (e, arg) => { keyOf(e); this.messages.get(gitIdSchema.parse(arg).id)?.abort(); });
  }
}
