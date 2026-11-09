// Source Control: what main reads from git, read-only, and what the renderer shows.
import type { RepoStatus } from './git';

export type RefKind = 'head' | 'remote' | 'tag';

export interface ScmRef {
  /** Full refname: refs/heads/main, refs/remotes/origin/main, refs/tags/v1. */
  name: string;
  /** main, origin/main, v1. */
  short: string;
  kind: RefKind;
  /** The remote of a remote branch ('origin'). */
  remote?: string;
  /** The commit it points at (annotated tags peeled). */
  oid: string;
  /** Full refname of a local branch's upstream. */
  upstream: string | null;
  ahead: number;
  behind: number;
  /** The upstream is configured but no longer exists. */
  gone: boolean;
  /** The branch HEAD is on. */
  current: boolean;
  /** Unix seconds: the committer date for branches, the creator (tagger) date for tags. */
  date: number;
}

export interface ScmHead { branch: string | null; oid: string | null; detached: boolean }

export interface ScmRefs {
  root: string;
  head: ScmHead;
  refs: ScmRef[];
  /** The repo's default branch (origin/HEAD, else main, else master): ref to compare with, its branch name. */
  defaultBranch: { ref: string; base: string } | null;
  shallow: boolean;
  /** mtime of FETCH_HEAD (ms), null when the repo was never fetched. */
  fetchedAt: number | null;
  /** The configured remotes' names, sorted. */
  remotes: string[];
  /** A remote is configured or a remote branch exists. */
  hasRemote: boolean;
  /** The empty tree's id for this repo's object format (a root commit's diff base). */
  emptyTree: string;
  error?: string;
}

export interface ScmPerson { name: string; email: string }

export interface ScmCommit {
  oid: string;
  parents: string[];
  author: ScmPerson;
  /** Unix seconds. */
  authorAt: number;
  committer: ScmPerson;
  committerAt: number;
  subject: string;
  /** From Co-authored-by trailers. */
  coAuthors: ScmPerson[];
}

/** What a history shows: every branch or one ref (first parents only, or the whole graph), or base..head. */
export type ScmScope = { kind: 'refs'; refs: 'all' | string; firstParent: boolean } | { kind: 'compare'; base: string; head: string };

export interface ScmLogPage {
  commits: ScmCommit[];
  /** No more commits after these. */
  done: boolean;
  /** The scope's cap (HISTORY_CAP) was reached. */
  capped: boolean;
  /** Compare scope: where head left base (null when they share no history). */
  mergeBase?: string | null;
  error?: string;
}

export type ScmChangeKind = 'M' | 'A' | 'D' | 'R' | 'T';

export interface ScmFileChange {
  rel: string;
  origRel?: string;
  kind: ScmChangeKind;
  /** null: binary. */
  added: number | null;
  removed: number | null;
  oldMode: string;
  newMode: string;
  oldOid: string;
  newOid: string;
}

export interface ScmCommitDetail {
  oid: string;
  /** The full message (subject, body, trailers). */
  message: string;
  /** What the files are compared against: the first parent, another commit, or the empty tree. */
  base: string;
  files: ScmFileChange[];
  /** Files past DETAIL_FILE_CAP, not listed. */
  more: number;
  error?: string;
}

export type ScmBlob = { kind: 'text'; text: string; notUtf8: boolean } | { kind: 'binary'; size: number } | { kind: 'tooLarge'; size?: number } | { kind: 'missing' };

export interface ScmWorktree { path: string; head: string | null; branch: string | null; detached: boolean; bare: boolean; locked: boolean; prunable: boolean }

export interface ScmStash { index: number; oid: string; message: string; at: number }

export interface ScmRepoStatus {
  branch: string | null; detached: boolean; oid: string | null; ahead: number; behind: number; upstream: string | null; upstreamGone?: boolean; changes: number;
  /** When the read it comes from started (RepoStatus.checkedAt): the newer of two statuses wins. */
  checkedAt?: number;
}

/** A working tree's status as Source Control lists it (main's entries, and the renderer's from Changes' newer reads). */
export function scmStatusOf(st: RepoStatus | undefined): ScmRepoStatus | null {
  return st && !st.error
    ? { branch: st.branch, detached: st.detached, oid: st.oid, ahead: st.ahead, behind: st.behind, upstream: st.upstream ?? null, upstreamGone: !!st.upstreamGone, changes: st.changes.length + st.truncated, checkedAt: st.checkedAt }
    : null;
}

/** A working tree the switcher lists: a repo of the project, or a linked worktree of one in a hidden folder. */
export interface ScmRepoEntry {
  root: string;
  /** Path inside the project ('' for the project root). */
  rel: string;
  name: string;
  /** The main worktree's root when this entry is a linked worktree. */
  worktreeOf: string | null;
  /** Absolute git common dir: events name it. */
  common: string;
  status: ScmRepoStatus | null;
}

/** Refs, a HEAD or a fetch changed in a repository (its git common dir). Worktrees' statuses come with Changes' own. */
export interface ScmEvent { common: string; what: 'refs' | 'head' | 'fetch' }

/** How a fetch ended. */
export type FetchOutcome = 'ok' | 'auth' | 'busy' | 'network' | 'error';
export type FetchReason = 'view' | 'manual';

/** What Source Control shows of a repository's fetches (per git common dir). */
export interface ScmFetchState {
  common: string;
  running: boolean;
  /** The last outcome worth showing (busy and network never replace it). */
  last: { outcome: 'ok' | 'auth' | 'error'; at: number; message?: string } | null;
}

/** A fetch asked by the renderer: null outcome when nothing ran (a view fetch the gates skipped). */
export interface ScmFetchAnswer { state: ScmFetchState | null; outcome: FetchOutcome | null; message?: string }

export const HISTORY_PAGE = 400;
export const HISTORY_CAP = 20000;
export const DETAIL_FILE_CAP = 2000;
export const BLOB_MAX = 2 * 1024 * 1024;
export const FILTER_MAX = 200;
export const EMPTY_TREE = { sha1: '4b825dc642cb6eb9a060e54bf8d69288fbee4904', sha256: '6ef19b41225c5369f1c104d45d8d85efa9b057b53b14b4b9b939dd74decc5321' } as const;
/** A full commit id (SHA-1 or SHA-256). */
export const OID_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
