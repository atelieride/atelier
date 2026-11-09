// Source Control readers: refs, history pages, commit details and file contents, all
// through runGit's closed list. Refs only ever reach git as full refnames listed by readRefs (or full commit ids),
// after --end-of-options: a ref can never be read as an option, a range or a path.
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { isRepoRel } from '@shared/paths';
import { BLOB_MAX, DETAIL_FILE_CAP, EMPTY_TREE, HISTORY_CAP, HISTORY_PAGE, OID_RE, type ScmBlob, type ScmCommitDetail, type ScmLogPage, type ScmRefs, type ScmScope, type ScmStash, type ScmWorktree } from '@shared/scm';
import { LOG_FORMAT, REF_FORMAT, STASH_FORMAT, filterArgs, parseHistoryFilter, parseLog, parseRawDiff, parseRefs, parseStashes, parseWorktrees } from '@shared/git-history';
import { DIFF_GUARDS, GitTooLarge, LOG_GUARDS, SHOW_GUARDS, runGit, runGitBytes } from './exec';
import { probeDefault } from './compare';

const quiet = (p: Promise<string>) => p.then((s) => s.trim(), () => null);
const aborted = (signal?: AbortSignal) => !!signal?.aborted;

/**
 * When this object store was last fetched (ms), from any of its working trees: FETCH_HEAD is per worktree, so the
 * newest of `<common>/FETCH_HEAD` and `<common>/worktrees/<name>/FETCH_HEAD`. Null when never fetched.
 */
export async function lastFetchAt(common: string): Promise<number | null> {
  const names = await readdir(join(common, 'worktrees')).catch(() => [] as string[]);
  const times = await Promise.all([join(common, 'FETCH_HEAD'), ...names.map((n) => join(common, 'worktrees', n, 'FETCH_HEAD'))]
    .map((p) => stat(p).then((s) => s.mtimeMs, () => null)));
  const found = times.filter((x): x is number => x !== null);
  return found.length ? Math.max(...found) : null;
}

/**
 * HEAD's branch (null when detached): `symbolic-ref`, which names it in full whether it has commits or not and whatever
 * the ref storage (reftable leaves HEAD's file a stub). Never `--abbrev-ref`: a tag of the same name makes it answer
 * `heads/<name>`.
 */
export async function headBranch(repo: string): Promise<string | null> {
  const ref = await quiet(runGit(repo, ['symbolic-ref', '-q', 'HEAD']));
  return ref?.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : null;
}

/** Branches, remotes, tags, HEAD and the facts the History toolbar shows. Never throws: an error comes back in `error`. */
export async function readRefs(repo: string): Promise<ScmRefs> {
  const empty: ScmRefs = { root: repo, head: { branch: null, oid: null, detached: false }, refs: [], defaultBranch: null, shallow: false, fetchedAt: null, remotes: [], hasRemote: false, emptyTree: EMPTY_TREE.sha1 };
  try {
    const facts = (await runGit(repo, ['rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir', '--is-shallow-repository', '--show-object-format'])).trim().split('\n');
    const [, common, shallow, format] = facts as [string, string, string, string];
    const [refsOut, oid, symbolic, def, remoteNames] = await Promise.all([
      runGit(repo, ['for-each-ref', REF_FORMAT, 'refs/heads', 'refs/remotes', 'refs/tags']),
      quiet(runGit(repo, ['rev-parse', '--verify', '-q', 'HEAD'])),
      headBranch(repo),
      probeDefault(repo).catch(() => null),
      quiet(runGit(repo, ['remote']))
    ]);
    const remotes = (remoteNames ?? '').split('\n').map((s) => s.trim()).filter(Boolean).sort();
    const branch = symbolic;
    const refs = parseRefs(refsOut, remotes);
    const fetchedAt = await lastFetchAt(common);
    return {
      root: repo,
      head: { branch, oid: oid && OID_RE.test(oid) ? oid : null, detached: !!oid && branch === null },
      refs,
      defaultBranch: def,
      shallow: shallow === 'true',
      fetchedAt,
      remotes,
      hasRemote: remotes.length > 0 || refs.some((r) => r.kind === 'remote'),
      emptyTree: format === 'sha256' ? EMPTY_TREE.sha256 : EMPTY_TREE.sha1
    };
  } catch (err) {
    return { ...empty, error: (err as Error).message };
  }
}

/** A side of a range: a listed refname, HEAD, or a full commit id. */
function knownRev(rev: string, refs: ScmRefs): boolean {
  return OID_RE.test(rev) || (rev === 'HEAD' && !!refs.head.oid) || refs.refs.some((r) => r.name === rev);
}

/** The revision arguments of a scope (pseudo-options, then --end-of-options and the revisions), or null if a ref is unknown. */
export function scopeArgs(scope: ScmScope, refs: ScmRefs): string[] | null {
  if (scope.kind === 'compare') {
    if (!knownRev(scope.base, refs) || !knownRev(scope.head, refs)) return null;
    return ['--end-of-options', `${scope.base}..${scope.head}`];
  }
  const fp = scope.firstParent ? ['--first-parent'] : [];
  if (scope.refs === 'all') return [...fp, '--branches', '--remotes', '--tags', '--end-of-options', ...(refs.head.oid ? ['HEAD'] : [])];
  if (!knownRev(scope.refs, refs)) return null;
  return [...fp, '--end-of-options', scope.refs];
}

/** A full commit id from a 4–40 hex prefix, or null. */
export async function resolveCommit(repo: string, prefix: string): Promise<string | null> {
  if (!/^[0-9a-f]{4,40}$/.test(prefix)) return null;
  const oid = await quiet(runGit(repo, ['rev-parse', '--verify', '-q', `${prefix}^{commit}`]));
  // git reads a refname first: a tag or branch named "feed" is not the commit "feed…".
  return oid && OID_RE.test(oid) && oid.startsWith(prefix) ? oid : null;
}

/** A page of history, newest first in topological order. */
export async function readLog(repo: string, scope: ScmScope, refs: ScmRefs, o: { skip: number; count: number; filter?: string; signal?: AbortSignal }): Promise<ScmLogPage> {
  const sc = scopeArgs(scope, refs);
  if (!sc) return { commits: [], done: true, capped: false, error: 'unknown ref' };
  const skip = Math.max(0, Math.min(o.skip, HISTORY_CAP));
  const count = Math.max(0, Math.min(o.count, HISTORY_PAGE * 10, HISTORY_CAP - skip));
  if (count === 0) return { commits: [], done: true, capped: true };
  try {
    let fa: { args: string[]; paths: string[] } = { args: [], paths: [] };
    if (o.filter) {
      const f = parseHistoryFilter(o.filter);
      const hit = f.sha ? await resolveCommit(repo, f.sha) : null;
      fa = filterArgs(f, !hit);
    }
    const [out, mergeBase] = await Promise.all([
      runGit(repo, ['log', ...LOG_GUARDS, '--topo-order', LOG_FORMAT, ...fa.args, `--skip=${skip}`, '-n', String(count), ...sc, '--', ...fa.paths], { signal: o.signal, timeoutMs: 20000 }),
      scope.kind === 'compare' && skip === 0 ? quiet(runGit(repo, ['merge-base', '--end-of-options', scope.base, scope.head], { signal: o.signal })) : Promise.resolve(undefined)
    ]);
    const commits = parseLog(out);
    return { commits, done: commits.length < count, capped: skip + commits.length >= HISTORY_CAP, ...(mergeBase !== undefined ? { mergeBase: mergeBase && OID_RE.test(mergeBase) ? mergeBase : null } : {}) };
  } catch (err) {
    if (aborted(o.signal)) throw err;
    return { commits: [], done: true, capped: false, error: (err as Error).message };
  }
}

/** Where a commit is in a scope's (unfiltered) history, or null when it isn't there (within the cap). */
export async function locateCommit(repo: string, scope: ScmScope, refs: ScmRefs, oid: string, signal?: AbortSignal): Promise<number | null> {
  const sc = scopeArgs(scope, refs);
  if (!sc || !OID_RE.test(oid)) return null;
  try {
    const out = await runGit(repo, ['rev-list', '--topo-order', '-n', String(HISTORY_CAP), ...sc, '--'], { signal, timeoutMs: 20000 });
    const i = out.split('\n').indexOf(oid);
    return i < 0 ? null : i;
  } catch (err) {
    if (aborted(signal)) throw err;
    return null;
  }
}

/** A commit's message and changed files, against `against` (another parent, a merge base), its first parent or the empty tree. */
export async function readCommit(repo: string, oid: string, against: string | null, emptyTree: string, signal?: AbortSignal): Promise<ScmCommitDetail> {
  if (!OID_RE.test(oid) || (against !== null && !OID_RE.test(against))) return { oid, message: '', base: '', files: [], more: 0, error: 'bad commit' };
  try {
    const [message, parents] = await Promise.all([
      runGit(repo, ['show', ...SHOW_GUARDS, '--no-patch', '--format=%B', oid], { signal }),
      runGit(repo, ['rev-parse', `${oid}^@`], { signal })
    ]);
    const base = against ?? parents.split('\n').map((s) => s.trim()).find((p) => OID_RE.test(p)) ?? emptyTree;
    const [raw, counts] = await Promise.all([
      runGit(repo, ['diff', ...DIFF_GUARDS, '--raw', '--no-abbrev', '-z', '-M', base, oid], { signal }),
      // Line counts are a bonus: without them (a timeout on a huge commit) the files still show.
      runGit(repo, ['diff', ...DIFF_GUARDS, '--numstat', '-z', '-M', base, oid], { signal }).catch((err) => { if (aborted(signal)) throw err; return ''; })
    ]);
    const files = parseRawDiff(raw, counts);
    return { oid, message: message.replace(/\n+$/, ''), base, files: files.slice(0, DETAIL_FILE_CAP), more: Math.max(0, files.length - DETAIL_FILE_CAP) };
  } catch (err) {
    if (aborted(signal)) throw err;
    return { oid, message: '', base: '', files: [], more: 0, error: (err as Error).message };
  }
}

const safeRel = (rel: string) => isRepoRel(rel);

/** A file's content at a commit: text (UTF-8, or decoded lossily when it isn't), binary, too large or missing. */
export async function readBlob(repo: string, oid: string, rel: string): Promise<ScmBlob> {
  if (!OID_RE.test(oid) || !safeRel(rel)) return { kind: 'missing' };
  let buf: Buffer;
  try {
    buf = await runGitBytes(repo, ['show', ...SHOW_GUARDS, `${oid}:${rel}`], { maxBytes: BLOB_MAX });
  } catch (err) {
    if (!(err instanceof GitTooLarge)) return { kind: 'missing' };
    const size = Number((await runGit(repo, ['cat-file', '-s', `${oid}:${rel}`]).catch(() => '')).trim());
    return size > 0 ? { kind: 'tooLarge', size } : { kind: 'tooLarge' };
  }
  if (buf.subarray(0, 8192).includes(0)) return { kind: 'binary', size: buf.length };
  try {
    return { kind: 'text', text: new TextDecoder('utf-8', { fatal: true }).decode(buf), notUtf8: false };
  } catch {
    return { kind: 'text', text: new TextDecoder('utf-8').decode(buf), notUtf8: true };
  }
}

export async function readWorktrees(repo: string): Promise<ScmWorktree[]> {
  try { return parseWorktrees(await runGit(repo, ['worktree', 'list', '--porcelain', '-z'])); } catch { return []; }
}

/** The newest 20 stashes (their list only, not their contents). */
export async function readStashes(repo: string): Promise<ScmStash[]> {
  if (!(await quiet(runGit(repo, ['rev-parse', '--verify', '-q', 'refs/stash'])))) return [];
  try { return parseStashes(await runGit(repo, ['log', ...LOG_GUARDS, '-g', STASH_FORMAT, '-n', '20', 'refs/stash'])); } catch { return []; }
}

const revLike = (r: string) => OID_RE.test(r) || r === 'HEAD' || /^refs\/(?:heads|remotes|tags)\//.test(r);

/** How far head is ahead of base and behind it. */
export async function aheadBehind(repo: string, base: string, head: string): Promise<{ ahead: number; behind: number } | null> {
  if (!revLike(base) || !revLike(head)) return null;
  const out = await quiet(runGit(repo, ['rev-list', '--left-right', '--count', '--end-of-options', `${base}...${head}`, '--']));
  const m = out ? /^(\d+)\s+(\d+)$/.exec(out) : null;
  return m ? { ahead: Number(m[2]), behind: Number(m[1]) } : null;
}
