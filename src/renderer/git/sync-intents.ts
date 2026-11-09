// The Sync button shows a pull, push or sync as soon as git is done: what main says the op left
// (GitOpResult.left: nothing to pull, nothing to push to the upstream, the upstream just published) is laid over every
// status read before it, until one read since comes in (`at`, main's clock: GitOpResult.at; main always sends that
// read, git-hub.ts requestStatus). The next read took seconds on a Windows PC, and statuses read during the op kept
// bringing the old ↓N back. Every override is a value, never a count worked out, so laying it twice changes nothing.
// Pure; the store keeps the list (git/slice.ts).
import type { RepoStatus } from '@shared/git';
import type { GitOpResult } from '@shared/git-write';
import { scmStatusOf, type ScmRef, type ScmRefs, type ScmRepoEntry, type ScmRepoStatus } from '@shared/scm';

export interface SyncIntent {
  root: string;
  /** When git was done. */
  at: number;
  ahead?: 0;
  behind?: 0;
  /** Publish Branch: the remote the branch now tracks a same-named branch of. */
  published?: string;
}

/** What main says a pull, push or sync that went through left (GitOpResult.left); null when it knows nothing of it. */
export function syncIntentOf(root: string, r: GitOpResult | undefined): SyncIntent | null {
  if (r?.outcome !== 'ok' || r.at === undefined || !r.left) return null;
  const { ahead, behind, published } = r.left;
  if (ahead === undefined && behind === undefined && !published) return null;
  return { root, at: r.at, ...(ahead === 0 ? { ahead } : {}), ...(behind === 0 ? { behind } : {}), ...(published ? { published } : {}) };
}

interface Counts { branch: string | null; ahead: number; behind: number; upstream?: string | null; upstreamGone?: boolean; checkedAt?: number }

/** The status as the ops it predates left it; the same object when they change nothing in it. */
export function applySync<T extends Counts>(root: string, s: T, intents: readonly SyncIntent[]): T {
  let out = s;
  for (const i of intents) {
    if (i.root !== root || (s.checkedAt !== undefined && s.checkedAt >= i.at)) continue;
    const patch: Partial<Counts> = {};
    if (i.ahead === 0 && out.ahead !== 0) patch.ahead = 0;
    if (i.behind === 0 && out.behind !== 0) patch.behind = 0;
    if (i.published && out.branch) {
      const upstream = `${i.published}/${out.branch}`;
      if (out.upstream !== upstream) patch.upstream = upstream;
      if (out.upstreamGone) patch.upstreamGone = false;
    }
    if (Object.keys(patch).length) out = { ...out, ...patch };
  }
  return out;
}

/**
 * Source Control's refs of the intent's working tree with its current branch's row as the op left it (↑↓, the upstream
 * a published branch now tracks): laid once, when the op is done; the refs read again right after replace it.
 */
export function syncRefs(refs: ScmRefs, i: SyncIntent): ScmRefs {
  let changed = false;
  const list = refs.refs.map((r) => {
    if (!r.current || r.kind !== 'head') return r;
    const patch: Partial<ScmRef> = {};
    if (i.ahead === 0 && r.ahead !== 0) patch.ahead = 0;
    if (i.behind === 0 && r.behind !== 0) patch.behind = 0;
    if (i.published) {
      const upstream = `refs/remotes/${i.published}/${r.short}`;
      if (r.upstream !== upstream) patch.upstream = upstream;
      if (r.gone) patch.gone = false;
    }
    if (!Object.keys(patch).length) return r;
    changed = true;
    return { ...r, ...patch };
  });
  return changed ? { ...refs, refs: list } : refs;
}

const SCM_KEYS: readonly (keyof ScmRepoStatus)[] = ['branch', 'detached', 'oid', 'ahead', 'behind', 'upstream', 'upstreamGone', 'changes', 'checkedAt'];
const sameScm = (a: ScmRepoStatus | null, b: ScmRepoStatus | null) => a === b || (!!a && !!b && SCM_KEYS.every((k) => a[k] === b[k]));

/**
 * Source Control's entries with each status the newest known: Changes' own read (`repos`, every git status main sends)
 * when it is as new or newer, so the Sync button never waits for the switcher's list to be asked again; the intents
 * laid over. The same list when nothing changes.
 */
export function freshEntries(list: ScmRepoEntry[], repos: readonly RepoStatus[], intents: readonly SyncIntent[]): ScmRepoEntry[] {
  const read = new Map(repos.map((r) => [r.root, r]));
  let changed = false;
  const out = list.map((e) => {
    const r = read.get(e.root);
    let s = r && (e.status?.checkedAt === undefined || e.status.checkedAt <= r.checkedAt) ? scmStatusOf(r) : e.status;
    if (s) s = applySync(e.root, s, intents);
    if (sameScm(s, e.status)) return e;
    changed = true;
    return { ...e, status: s };
  });
  return changed ? out : list;
}

/**
 * The intents still to lay over `seen`, every working tree of the project as main sent it: those no status read since
 * their op shows yet (a working tree no longer listed takes its intents with it). The same list when none went.
 */
export function settleSync(intents: SyncIntent[], seen: readonly { root: string; checkedAt?: number }[]): SyncIntent[] {
  if (intents.length === 0) return intents;
  const read = new Map(seen.map((s) => [s.root, s.checkedAt]));
  const kept = intents.filter((i) => read.has(i.root) && (read.get(i.root) ?? -Infinity) < i.at);
  return kept.length === intents.length ? intents : kept;
}
