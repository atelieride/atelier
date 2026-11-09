// Review "Against main": what a branch changes since it left the repo's default branch. Read-only:
// rev-parse, merge-base, rev-list, diff and show through runGit's closed list.
import { isRepoRel } from '@shared/paths';
import type { FileChange, MergeInfo, RepoCompare, RepoStatus } from '@shared/git';
import { DIFF_GUARDS as GUARDS, SHOW_GUARDS, runGit } from './exec';
import { parseNameStatus, parseNumstat } from './parse';
import type { DefaultRef } from './merge-cache';
const MAX_CHANGES = 2000;
/** A full commit id (SHA-1 or SHA-256): the only revisions besides HEAD a review reads content at. */
export const OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** The default branch: the one origin/HEAD points at, else a local main, then master (null: nothing to compare to). */
export function pickDefault(probe: { originHead: string | null; main: boolean; master: boolean }): { ref: string; base: string } | null {
  const o = probe.originHead;
  if (o && o.includes('/')) return { ref: o, base: o.slice(o.indexOf('/') + 1) };
  if (probe.main) return { ref: 'main', base: 'main' };
  if (probe.master) return { ref: 'master', base: 'master' };
  return null;
}

const quiet = (p: Promise<string>) => p.then((s) => s.trim() || null, () => null);

export async function probeDefault(repo: string) {
  const originHead = await quiet(runGit(repo, ['rev-parse', '--abbrev-ref', '--verify', '-q', 'refs/remotes/origin/HEAD']));
  if (originHead && originHead.includes('/')) return pickDefault({ originHead, main: false, master: false });
  const main = (await quiet(runGit(repo, ['rev-parse', '--verify', '-q', 'refs/heads/main']))) !== null;
  const master = main ? false : (await quiet(runGit(repo, ['rev-parse', '--verify', '-q', 'refs/heads/master']))) !== null;
  return pickDefault({ originHead: null, main, master });
}

/** Every file the branch changes since it diverged from the default branch, or why the comparison isn't offered. */
export async function readCompare(repo: string, status: RepoStatus): Promise<RepoCompare> {
  const root = repo;
  if (!status.oid) return { root, ok: false, reason: 'no-head' };
  try {
    const def = await probeDefault(repo);
    if (!def) return { root, ok: false, reason: 'no-default' };
    if (!status.detached && status.branch === def.base) return { root, ok: false, reason: 'on-default' };
    const mergeBase = (await runGit(repo, ['merge-base', 'HEAD', def.ref])).trim();
    if (!OID.test(mergeBase)) return { root, ok: false, reason: 'error' };
    const commits = Number((await runGit(repo, ['rev-list', '--count', `${mergeBase}..HEAD`])).trim()) || 0;
    const tracked = parseNameStatus(await runGit(repo, ['diff', ...GUARDS, '--name-status', '-z', '-M', mergeBase]), repo);
    const counts = parseNumstat(await runGit(repo, ['diff', ...GUARDS, '--numstat', '-z', '-M', mergeBase]));
    for (const c of tracked) {
      const n = counts.get(c.rel);
      if (n) { c.added = n.added; c.removed = n.removed; }
    }
    // Untracked files are part of what the branch changes too (the status already counted their lines).
    const untracked: FileChange[] = status.changes.filter((c) => c.kind === '?').map((c) => ({ ...c }));
    const changes = [...tracked, ...untracked].slice(0, MAX_CHANGES);
    return { root, ok: true, base: def.base, ref: def.ref, mergeBase, commits, changes };
  } catch {
    return { root, ok: false, reason: 'error' };
  }
}

/** The repo's default branch with its commit (worktrees in Changes: what a branch has to merge is measured against it). */
export async function probeDefaultRef(repo: string): Promise<DefaultRef | null> {
  const def = await probeDefault(repo);
  if (!def) return null;
  const oid = await quiet(runGit(repo, ['rev-parse', '--verify', '-q', `${def.ref}^{commit}`]));
  return oid && OID.test(oid) ? { ...def, oid } : null;
}

/** Commits the working tree's HEAD adds over the default branch and the files they change (null on any error). */
export async function mergeAgainst(repo: string, def: DefaultRef): Promise<MergeInfo | null> {
  try {
    const mergeBase = (await runGit(repo, ['merge-base', 'HEAD', def.oid])).trim();
    if (!OID.test(mergeBase)) return null;
    const commits = Number((await runGit(repo, ['rev-list', '--count', `${mergeBase}..HEAD`])).trim()) || 0;
    const names = async (from: string) => (await runGit(repo, ['diff', ...GUARDS, '--name-only', '-z', from, 'HEAD'])).split('\0').filter(Boolean);
    const changed = commits ? await names(mergeBase) : [];
    // Squash or rebase merged: the branch's files already read the same on the default branch.
    const differ = changed.length ? new Set(await names(def.oid)) : new Set<string>();
    const all = changed.filter((f) => differ.has(f));
    return { base: def.base, commits, files: all.slice(0, MAX_CHANGES), truncated: Math.max(0, all.length - MAX_CHANGES), merged: commits > 0 && all.length === 0 };
  } catch {
    return null;
  }
}

/**
 * What a working tree's branch has to merge into the default branch (worktrees in Changes): commits since the merge
 * base and the files they change. Null with no HEAD, no default branch, on the default branch, or on any error.
 */
export async function readMerge(repo: string, status: RepoStatus): Promise<MergeInfo | null> {
  if (!status.oid || status.error) return null;
  const def = await probeDefaultRef(repo).catch(() => null);
  if (!def || (!status.detached && status.branch === def.base)) return null;
  return mergeAgainst(repo, def);
}

/** A file's content at HEAD or at a commit id (null: not there, or a suspicious revision or path). */
export async function readContentAt(repo: string, rev: string, rel: string): Promise<string | null> {
  if (rev !== 'HEAD' && !OID.test(rev)) return null;
  if (!isRepoRel(rel)) return null;
  try {
    return await runGit(repo, ['show', ...SHOW_GUARDS, `${rev}:${rel}`]);
  } catch {
    return null;
  }
}
