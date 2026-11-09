// Git writes: the ops main runs, how they end, and the pure helpers both sides use.

export type GitOp = 'stage' | 'unstage' | 'commit' | 'undoCommit' | 'push' | 'pull' | 'sync' | 'switch'
  | 'branchCreate' | 'branchRename' | 'branchDelete' | 'branchRestore' | 'worktreeAdd' | 'worktreeRemove'
  | 'stashPush' | 'stashApply' | 'stashDrop' | 'stashRestore' | 'discard';

/** How an op ended. */
export type GitOutcome = 'ok' | 'busy' | 'auth' | 'network' | 'rejected' | 'hook' | 'sign' | 'identity'
  | 'conflict' | 'state' | 'stale' | 'nothing' | 'cancelled' | 'error';

export type GitPhase = 'queued' | 'running' | 'hook' | 'signing' | 'done';

export interface GitOpResult {
  outcome: GitOutcome;
  /** git's first meaningful line, scrubbed of credentials, at most 200 characters. */
  message?: string;
  sha?: string;
  /** The full output, for "Full log". */
  output?: string;
  /** The hook that failed (outcome 'hook') or ran last. */
  hook?: string;
  /** conflict: files with markers; dirty: files that would be overwritten. */
  files?: string[];
  /** A conflict because local changes would be overwritten (Stash and Pull / Stash and switch are offered). */
  dirty?: true;
  /** Ran without the user's shell environment ("Full log" notes it). */
  noShellEnv?: true;
  /** stashPush / stashDrop: what Undo needs. */
  stash?: { oid: string; message: string };
  /** branchDelete: what Undo needs. */
  branch?: { name: string; oid: string };
  /** commit: Undo is offered for this oid. */
  undo?: { oid: string };
  /** Done, but git also reported a failure (a post-checkout hook's): shown with the toast. */
  warning?: string;
  /**
   * stage / unstage / pull / push / sync: when git was done (main's clock). A status read that started then or later
   * shows the op, and one always follows: the checkbox shows the click until then (renderer git/stage-intents.ts), the
   * Sync button the counts the op leaves (renderer git/sync-intents.ts).
   */
  at?: number;
  /**
   * pull / push / sync that went through: what git now has for sure — nothing left to pull (behind 0), nothing left to
   * push to the upstream (ahead 0; not for a push to another remote), the remote a branch just published tracks.
   */
  left?: { ahead?: 0; behind?: 0; published?: string };
}

export interface GitOpEvent {
  id: string;
  root: string;
  op: GitOp;
  phase: GitPhase;
  hook?: string;
  chunk?: string;
  result?: GitOpResult;
  startedAt: number;
}

export const CO_AUTHOR_TRAILER = 'Co-Authored-By: Claude <noreply@anthropic.com>';

/** A commit message's cap: it goes to git through stdin, never argv. */
export const MESSAGE_MAX_BYTES = 64 * 1024;

/**
 * Where a file stands in the index, from porcelain v2's XY: only in the index → all, in the index and changed
 * again in the work tree → partial, not in the index → none.
 */
export function stageOf(xy: string): 'none' | 'all' | 'partial' {
  const x = xy[0] ?? '.'; const y = xy[1] ?? '.';
  if (x === '.') return 'none';
  return y === '.' ? 'all' : 'partial';
}

const TRAILER = /^([A-Za-z0-9][A-Za-z0-9-]*)\s*:\s*(.*)$/;

/**
 * Whether the message already has a Co-Authored-By trailer naming Claude (never added twice). Like git, the
 * trailers are the last paragraph, never the subject's, and every line of it must be a trailer (or a continuation).
 */
export function hasClaudeCoAuthor(message: string): boolean {
  const paragraphs = message.replace(/\r\n/g, '\n').trim().split(/\n[ \t]*\n/);
  if (paragraphs.length < 2) return false;
  const lines = paragraphs[paragraphs.length - 1]!.split('\n');
  const trailers: Array<[string, string]> = [];
  for (const line of lines) {
    if (/^[ \t]/.test(line) && trailers.length) continue;
    const m = TRAILER.exec(line);
    if (!m) return false;
    trailers.push([m[1]!, m[2]!]);
  }
  return trailers.some(([key, value]) => key.toLowerCase() === 'co-authored-by' && /\bclaude\b/i.test(value));
}

/** What a commit needs to know about a working tree. */
export interface RepoFacts {
  /** user.name and user.email are both set. */
  identity: boolean;
  /** An operation in progress that a commit would conclude. */
  state: 'merge' | 'rebase' | 'cherry-pick' | 'revert' | null;
  detached: boolean;
  branch: string | null;
  head: string | null;
  /** The upstream's short name (origin/main), null without one. */
  upstream: string | null;
  /** HEAD is reachable from its upstream: amend and undo would rewrite shared history. */
  headPushed: boolean;
  headIsMerge: boolean;
  headHasParent: boolean;
  /** HEAD's full message (amend fills the field with it). */
  headMessage: string | null;
  hooks: { preCommit: boolean; commitMsg: boolean; prePush: boolean };
  gpgProgram: string | null;
  signs: boolean;
  gitVersion: [number, number, number];
}

/** The facts the renderer gets: main's, plus what it remembers of Atelier's own last commit and the remotes. */
export interface GitFacts extends RepoFacts {
  root: string;
  /** Undo is offered for this commit: main checked HEAD, upstream and parents. */
  undo: { oid: string; files: string[] } | null;
  remotes: string[];
  /**
   * Remote name → its GitHub compare base, `https://github.com/<owner>/<repo>`, for Publish's "Open a pull request on
   * GitHub after". Only github.com remotes; never a remote URL (it may carry credentials, main keeps it).
   */
  githubRepos?: Record<string, string>;
}

export type StageTarget = string[] | 'all';
export type SwitchCarry = 'none' | 'stash' | 'bring';
export type MessageTweak = 'shorter' | 'detail' | 'subject';

/** A ✦ run's stream (ev:scmMessage). */
export type ScmMessageEvent =
  | { id: string; chunk: string }
  | { id: string; done: { text: string; model: string; ms: number; notes: string[] } }
  | { id: string; error: string };

export interface RemoteCommit { oid: string; subject: string; author: string }

/** One repository's answer in Sync All. */
export interface SyncAllRow { root: string; result: GitOpResult | null; needsYou?: 'diverged' | 'no-upstream' | 'live' }

/**
 * The renderer's `window.atelier.git`. Every op answers a GitOpResult and never rejects for a git failure;
 * progress and output stream as ev:gitOp events carrying the op's id (what `cancel` takes).
 */
export interface GitApi {
  stage(root: string, rels: StageTarget): Promise<GitOpResult>;
  unstage(root: string, rels: StageTarget): Promise<GitOpResult>;
  /** expectHead: amend only if HEAD is still this commit (the one the drawer showed), else `stale`. */
  commit(o: { root: string; message: string; amend: boolean; coAuthor: boolean; noVerify: boolean; expectHead?: string }): Promise<GitOpResult>;
  /** Answers the undone commit's message in `message` (it becomes the draft). */
  undoCommit(root: string, oid: string): Promise<GitOpResult>;
  push(o: { root: string; publish?: { remote: string }; lease?: { oid: string } }): Promise<GitOpResult>;
  /** stash: Stash and Pull (stash, pull, pop that exact stash). */
  pull(o: { root: string; rebase: boolean; stash?: boolean }): Promise<GitOpResult>;
  sync(o: { root: string; rebase: boolean }): Promise<GitOpResult>;
  /** skip: roots whose incoming changes touch files live sessions are changing (answered `needsYou: 'live'`). */
  syncAll(o?: { skip: string[] }): Promise<SyncAllRow[]>;
  switchTo(o: { root: string; ref: string; carry: SwitchCarry }): Promise<GitOpResult>;
  /** `same`: a rename's current name (renaming into its own folder, feat → feat/x, is fine). */
  checkBranchName(root: string, name: string, same?: string): Promise<boolean>;
  branchCreate(o: { root: string; name: string; from?: string; switch: boolean }): Promise<GitOpResult>;
  branchRename(o: { root: string; ref: string; name: string }): Promise<GitOpResult>;
  branchDelete(o: { root: string; ref: string; force: boolean }): Promise<GitOpResult>;
  branchRestore(o: { root: string; name: string; oid: string }): Promise<GitOpResult>;
  worktreeCheck(root: string, path: string): Promise<{ inside: boolean; exists: boolean; ignored: boolean }>;
  worktreeAdd(o: { root: string; path: string; ref?: string; newName?: string }): Promise<GitOpResult>;
  stashPush(o: { root: string; message: string; untracked: boolean; staged: boolean }): Promise<GitOpResult>;
  stashApply(o: { root: string; index: number; oid: string; pop: boolean }): Promise<GitOpResult>;
  stashDrop(o: { root: string; index: number; oid: string }): Promise<GitOpResult>;
  stashRestore(o: { root: string; oid: string; message: string }): Promise<GitOpResult>;
  discard(root: string, rels: StageTarget): Promise<GitOpResult>;
  cancel(id: string): Promise<void>;
  facts(root: string): Promise<GitFacts | null>;
  /** Paths a pull would change (diff --name-only HEAD...@{u}). */
  incoming(root: string): Promise<string[]>;
  /** The upstream's commits HEAD doesn't have (after a fetch), at most `n`; the first one's oid is what a lease names. */
  remoteCommits(root: string, n: number): Promise<{ commits: RemoteCommit[]; remoteOid: string | null; total: number }>;
  /** Ops running or queued now (a window that opens mid-op). */
  running(): Promise<GitOpEvent[]>;
  /** ✦: starts writing; the text streams as ev:scmMessage events with this id. */
  message(o: { root: string; tweak?: { kind: MessageTweak; current: string } }): Promise<{ id: string } | { error: string }>;
  messageCancel(id: string): Promise<void>;
}

/** A staged file whose name looks like a secret: only its path goes to ✦, never its content. */
export function looksSecret(rel: string): boolean {
  const base = (rel.split('/').pop() ?? '').toLowerCase();
  return base.startsWith('.env') || base.endsWith('.pem') || base.endsWith('.key') || base.startsWith('id_rsa')
    || base.endsWith('.p12') || base.startsWith('credentials');
}

/** A refname's length cap. */
export const MAX_REF = 255;

// git's refname rules (check-ref-format): no control character, space, ~ ^ : ? * [ \, no `..`, `@{`, `//`, no
// component starting with `.` or ending with `.lock`, not ending with `/` or `.`.
const REF_BAD = /[\x00-\x20\x7f~^:?*[\\]|\.\.|@\{|\/\/|^\/|\/$|\.$|^\.|\/\.|\.lock(?:\/|$)/;

// A name git would read as something else than a branch: a refspec force (`+main`), a full refname (`refs/heads/x`
// names refs/heads/refs/heads/x as a branch, but `refs/x` elsewhere), HEAD or a pseudo-ref (ORIG_HEAD, FETCH_HEAD…,
// also as a last component), an object id.
const NOT_A_BRANCH = /^[+-]|^refs\/|(?:^|\/)(?:[A-Z_]*_)?HEAD$|^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** A branch name: git's refname rules, never `-`/`+` first, `@`, HEAD-like, `refs/…` or an oid, ≤ 255 characters. */
export function validBranchName(name: string): boolean {
  return typeof name === 'string' && name.length > 0 && name.length <= MAX_REF && name !== '@' && !NOT_A_BRANCH.test(name) && !REF_BAD.test(name);
}

/**
 * The existing branch a new name clashes with: one that is its folder (feat for feat/x) or lives in it (feat/x for
 * feat). git's refs can't be both ("cannot lock ref … exists; cannot create"). `except`: a rename's old name.
 */
export function branchClash(branches: readonly string[], name: string, except?: string): string | null {
  return branches.find((b) => b !== except && (name.startsWith(`${b}/`) || b.startsWith(`${name}/`))) ?? null;
}

/**
 * How a branch stands with its upstream (as status names it, `origin/main`) for a plain push or Sync: none; gone (its
 * remote branch was deleted: status names it but has no counts); other — a branch of another name, or a local one
 * (made from origin/main, branch.autoSetupMerge: Push and Sync would aim at main, so main refuses and Publish gives it
 * its own); or its own. The remote is the part before the first `/`: Atelier pushes only to remotes without one.
 */
export type UpstreamKind = 'none' | 'gone' | 'other' | 'own';
export function upstreamKind(branch: string | null | undefined, upstream: string | null | undefined, gone: boolean | undefined): UpstreamKind {
  if (!branch || !upstream) return 'none';
  if (gone) return 'gone';
  const slash = upstream.indexOf('/');
  return slash > 0 && upstream.slice(slash + 1) === branch ? 'own' : 'other';
}

/**
 * What a sync button does and says (Source Control's split button, All Repositories' blocks and Sync All): Pull with
 * only commits to pull, Push with only commits to push, Sync with both — and Sync when in sync (it asks the remote).
 */
export function syncAction(c: { ahead: number; behind: number }): 'pull' | 'push' | 'sync' {
  if (c.behind > 0 && c.ahead === 0) return 'pull';
  if (c.ahead > 0 && c.behind === 0) return 'push';
  return 'sync';
}

/** A status's ahead and behind as "to push" and "to pull": only against an upstream of its own name, else 0. */
export function trackedCounts(s: { branch: string | null; upstream?: string | null; upstreamGone?: boolean; ahead: number; behind: number }): { ahead: number; behind: number } {
  return upstreamKind(s.branch, s.upstream, s.upstreamGone) === 'own' ? { ahead: s.ahead, behind: s.behind } : { ahead: 0, behind: 0 };
}
