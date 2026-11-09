// What a commit, a pull, a push or a branch sheet needs to know before git writes anything.
// Reads only: every git call goes through runGit's closed list, and the only files looked at
// are the work tree's git paths (HEAD, the in-progress markers) and the three hooks in the effective hooks folder.
import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { RepoFacts } from '@shared/git-write';
import { EMPTY_TREE, OID_RE } from '@shared/scm';
import { DIFF_GUARDS, LOG_GUARDS, runGit } from './exec';
import { headBranch } from './history';

// One type for main and the renderer. Here: branch is also an unborn branch's name; upstream is null too when its
// remote-tracking ref was never fetched; hooks are executables in the effective folder (core.hooksPath respected,
// samples never count); gpgProgram is the program configured for gpg.format (gpg.program, gpg.ssh.program,
// gpg.x509.program), null for git's default; gitVersion is [0, 0, 0] when unknown.
export type { RepoFacts };

const quiet = (p: Promise<string>) => p.then((s) => s.trim(), () => null);
const succeeds = (p: Promise<unknown>) => p.then(() => true, () => false);
const config = (root: string, key: string) => runGit(root, ['config', '--get', key]).then((s) => s.replace(/\n$/, ''), () => null);

/** git's booleans: true/yes/on, a non-zero number, or a key with no value. */
export function gitBool(v: string | null): boolean {
  if (v === null) return false;
  const s = v.trim().toLowerCase();
  return s === '' || s === 'true' || s === 'yes' || s === 'on' || (/^-?\d+$/.test(s) && Number(s) !== 0);
}

export function parseGitVersion(out: string): [number, number, number] {
  const m = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(out);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)] : [0, 0, 0];
}

// The git binary doesn't change under a running app: asked once (a failure is asked again next time).
let versionOnce: Promise<[number, number, number]> | null = null;
function gitVersion(root: string): Promise<[number, number, number]> {
  versionOnce ??= runGit(root, ['version']).then(parseGitVersion);
  return versionOnce.catch(() => { versionOnce = null; return [0, 0, 0] as [number, number, number]; });
}

const MARKERS = ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply'] as const;
const HOOKS = { preCommit: 'pre-commit', commitMsg: 'commit-msg', prePush: 'pre-push' } as const;

async function executable(p: string): Promise<boolean> {
  try {
    if (!(await stat(p)).isFile()) return false;
    await access(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** The facts of one working tree. Rejects only when `root` isn't a git work tree. */
export async function readRepoFacts(root: string): Promise<RepoFacts> {
  // --git-path resolves per work tree (a linked worktree's MERGE_HEAD) and follows core.hooksPath (relative: to the top).
  const paths = (await runGit(root, ['rev-parse', '--path-format=absolute', '--git-dir', ...MARKERS.flatMap((m) => ['--git-path', m]), '--git-path', 'hooks']))
    .split('\n');
  const marker = Object.fromEntries(MARKERS.map((m, i) => [m, paths[i + 1]!])) as Record<(typeof MARKERS)[number], string>;
  const hooksDir = paths[MARKERS.length + 1]!;

  const [head, symbolic, upstream, name, email, gpgsign, format, version, present, hooks] = await Promise.all([
    quiet(runGit(root, ['rev-parse', '--verify', '-q', 'HEAD'])),
    // HEAD's branch, born or not (an unborn one rev-parse can't name), whatever the ref storage.
    headBranch(root),
    quiet(runGit(root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'])),
    config(root, 'user.name'), config(root, 'user.email'), config(root, 'commit.gpgsign'), config(root, 'gpg.format'),
    gitVersion(root),
    Promise.all(MARKERS.map((m) => stat(marker[m]).then(() => true, () => false))),
    Promise.all(Object.values(HOOKS).map((h) => executable(join(hooksDir, h))))
  ]);
  const oid = head && OID_RE.test(head) ? head : null;
  const has = Object.fromEntries(MARKERS.map((m, i) => [m, present[i]!])) as Record<(typeof MARKERS)[number], boolean>;
  const state: RepoFacts['state'] = has['rebase-merge'] || has['rebase-apply'] ? 'rebase' : has.MERGE_HEAD ? 'merge'
    : has.CHERRY_PICK_HEAD ? 'cherry-pick' : has.REVERT_HEAD ? 'revert' : null;

  const branch = symbolic;

  const fmt = (format ?? '').trim().toLowerCase();
  const programKey = fmt === 'ssh' ?'gpg.ssh.program' : fmt === 'x509' ? 'gpg.x509.program' : 'gpg.program';
  const [parents, message, onUpstream, onRemote, program] = await Promise.all([
    oid ? quiet(runGit(root, ['rev-parse', `${oid}^@`])) : Promise.resolve(null),
    oid ? runGit(root, ['show', ...LOG_GUARDS, '--no-patch', '--format=%B', oid]).then((s) => s.replace(/\n+$/, ''), () => null) : Promise.resolve(null),
    oid && upstream ? succeeds(runGit(root, ['merge-base', '--is-ancestor', 'HEAD', '@{u}'])) : Promise.resolve(false),
    // Shared already when any remote-tracking branch has it (pushed elsewhere, or a branch made on a pushed commit).
    oid ? quiet(runGit(root, ['for-each-ref', '--contains=HEAD', '--count=1', '--format=%(refname)', 'refs/remotes'])).then((s) => !!s) : Promise.resolve(false),
    config(root, programKey)
  ]);
  const pushed = onUpstream || onRemote;
  const parentCount = parents ? parents.split('\n').filter((p) => OID_RE.test(p.trim())).length : 0;

  return {
    identity: !!name?.trim() && !!email?.trim(),
    state,
    detached: !!oid && branch === null,
    branch,
    head: oid,
    upstream: upstream && upstream !== '@{u}' ? upstream : null,
    headPushed: pushed,
    headIsMerge: parentCount > 1,
    headHasParent: parentCount > 0,
    headMessage: message,
    hooks: { preCommit: hooks[0]!, commitMsg: hooks[1]!, prePush: hooks[2]! },
    gpgProgram: program?.trim() || null,
    signs: gitBool(gpgsign),
    gitVersion: version
  };
}

const hasUpstream = (root: string) => quiet(runGit(root, ['rev-parse', '--verify', '-q', '@{u}'])).then((s) => !!s && OID_RE.test(s));

/** The paths a pull would change (both sides of a rename), since the merge base: `diff --name-only HEAD...@{u}`. */
export async function incomingPaths(root: string): Promise<string[]> {
  if (!(await hasUpstream(root))) return [];
  const out = await runGit(root, ['diff', ...DIFF_GUARDS, '--name-only', '--no-renames', '-z', 'HEAD...@{u}', '--']);
  return out.split('\0').filter(Boolean);
}

/** The upstream's commits HEAD doesn't have, newest first, at most `n` (the rejected push sheet). */
export async function remoteCommits(root: string, n: number): Promise<{ oid: string; subject: string; author: string }[]> {
  const count = Math.min(Math.floor(n), 100);
  if (!(count > 0) || !(await hasUpstream(root))) return [];
  const out = await runGit(root, ['log', ...LOG_GUARDS, '--format=%H%x00%an%x00%s', '-n', String(count), 'HEAD..@{u}', '--']);
  return out.split('\n').filter(Boolean).map((line) => {
    const [oid = '', author = '', subject = ''] = line.split('\0');
    return { oid, subject, author };
  }).filter((c) => OID_RE.test(c.oid));
}

/**
 * The files a stash touches: its tracked changes (the stash commit against the HEAD it was made on) and, when
 * it was made with -u, its new files (the third parent, a root commit, against the empty tree). Sorted, unique.
 */
export async function stashFiles(root: string, oid: string): Promise<string[]> {
  if (!OID_RE.test(oid)) throw new Error('stashFiles: not a commit id');
  const names = (out: string) => out.split('\0').filter(Boolean);
  const [tracked, untrackedOid, format] = await Promise.all([
    runGit(root, ['diff', ...DIFF_GUARDS, '--name-only', '--no-renames', '-z', `${oid}^1`, oid, '--']),
    quiet(runGit(root, ['rev-parse', '--verify', '-q', `${oid}^3`])),
    quiet(runGit(root, ['rev-parse', '--show-object-format']))
  ]);
  const files = new Set(names(tracked));
  if (untrackedOid && OID_RE.test(untrackedOid)) {
    const empty = format === 'sha256' ? EMPTY_TREE.sha256 : EMPTY_TREE.sha1;
    for (const f of names(await runGit(root, ['diff', ...DIFF_GUARDS, '--name-only', '--no-renames', '-z', empty, untrackedOid, '--']))) files.add(f);
  }
  return [...files].sort();
}

const GITHUB_URL = [
  // https, credentials allowed (and dropped); never http, never another host that merely contains github.com.
  /^https:\/\/(?:[^@/\s]+@)?github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i,
  // scp-like (git@github.com:o/r) and ssh://git@github.com/o/r, no port.
  /^(?:ssh:\/\/git@github\.com\/|git@github\.com:)([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i
];
const GITHUB_NAME = /^[A-Za-z0-9._-]+$/;

/**
 * A remote URL's GitHub repository as `https://github.com/<owner>/<repo>` (Publish's compare page), null for any
 * other host or shape. The only thing of a remote URL that leaves main: no credentials, no path beyond owner/repo.
 */
export function githubRepoBase(url: string): string | null {
  const s = typeof url === 'string' ? url.trim() : '';
  for (const re of GITHUB_URL) {
    const m = re.exec(s);
    if (!m) continue;
    const [owner, repo] = [m[1]!, m[2]!];
    if (!GITHUB_NAME.test(owner) || !GITHUB_NAME.test(repo) || /^\.+$/.test(owner) || /^\.+$/.test(repo) || repo === '.git') return null;
    return `https://github.com/${owner}/${repo}`;
  }
  return null;
}

/** A configured remote's GitHub compare base (`config --get remote.<name>.url`, runGit's exact form), or null. */
export async function githubRepoOf(root: string, remote: string): Promise<string | null> {
  if (typeof remote !== 'string' || !/^[A-Za-z0-9_][A-Za-z0-9._-]{0,99}$/.test(remote)) throw new Error(`githubRepoOf: remote not allowed: ${remote}`);
  const url = await runGit(root, ['config', '--get', `remote.${remote}.url`]).catch(() => null);
  return url === null ? null : githubRepoBase(url);
}

// A branch name as it reaches `--exclude=` (a glob for --branches) and `refs/heads/<name>`: nothing that reads as an
// option, a range, a revision suffix or a glob.
const SAFE_BRANCH = /^(?!-)(?!.*\.\.)(?!.*\/\/)(?!\/)(?!.*\/$)[^\0-\x20\x7f~^:?*[\\]+$/;

/**
 * A local branch's upstream as its remote knows it: the remote, the ref there (branch.<b>.merge, e.g.
 * refs/heads/main: what `--force-with-lease=<ref>:<oid>` names) and the remote-tracking ref's oid. Null without an
 * upstream (or one never fetched).
 */
export async function upstreamOf(root: string, branch: string): Promise<{ remote: string; ref: string; oid: string } | null> {
  if (!SAFE_BRANCH.test(branch) || branch.includes('@{')) throw new Error(`upstreamOf: branch not allowed: ${branch}`);
  const out = await quiet(runGit(root, ['for-each-ref', '--format=%(upstream:remotename)%00%(upstream:remoteref)%00%(upstream)', `refs/heads/${branch}`]));
  const line = out?.split('\n').find(Boolean);
  if (!line) return null;
  const [remote = '', ref = '', tracking = ''] = line.split('\0');
  if (!remote || !ref.startsWith('refs/') || !tracking.startsWith('refs/remotes/')) return null;
  const oid = await quiet(runGit(root, ['rev-parse', '--verify', '-q', tracking]));
  return oid && OID_RE.test(oid) ? { remote, ref, oid } : null;
}

/**
 * Where a plain push of a local branch goes: its push remote (branch.<b>.pushRemote, remote.pushDefault, else
 * its upstream's remote), the ref a configured `remote.<name>.push` refspec maps it to ('' without one), and its
 * upstream's remote and ref there ('' without an upstream). Null when it has no push remote.
 */
export async function pushTargetOf(root: string, branch: string): Promise<{ remote: string; ref: string; upstreamRemote: string; upstreamRef: string } | null> {
  if (!SAFE_BRANCH.test(branch) || branch.includes('@{')) throw new Error(`pushTargetOf: branch not allowed: ${branch}`);
  const out = await quiet(runGit(root, ['for-each-ref', '--format=%(push:remotename)%00%(push:remoteref)%00%(upstream:remotename)%00%(upstream:remoteref)', `refs/heads/${branch}`]));
  const line = out?.split('\n').find(Boolean);
  if (!line) return null;
  const [remote = '', ref = '', upstreamRemote = '', upstreamRef = ''] = line.split('\0');
  return remote ? { remote, ref, upstreamRemote, upstreamRef } : null;
}

/**
 * Commits on `refs/heads/<branch>` that no other branch, remote branch or tag reaches: what `branch -D` would
 * leave unreachable.
 */
export async function unmergedCommits(root: string, branch: string): Promise<number> {
  if (!SAFE_BRANCH.test(branch) || branch.includes('@{')) throw new Error(`unmergedCommits: branch not allowed: ${branch}`);
  const ref = `refs/heads/${branch}`;
  if (!(await quiet(runGit(root, ['rev-parse', '--verify', '-q', ref])))) throw new Error(`unmergedCommits: unknown branch: ${branch}`);
  const out = await runGit(root, ['rev-list', '--count', ref, '--not', `--exclude=${branch}`, '--branches', '--remotes', '--tags', '--']);
  return Number(out.trim()) || 0;
}
