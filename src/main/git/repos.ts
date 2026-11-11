import { existsSync, readdirSync, readFileSync, realpath as realpathCb, realpathSync, statSync } from 'node:fs';
import { access, readdir, stat } from 'node:fs/promises';
import { dirname, join, resolve, toOut } from '../cpath';
import { parseWorktrees } from '@shared/git-history';
import type { ScmWorktree } from '@shared/scm';
import { runGit } from './exec';
import { gitReadLimiter, type ReadLevel } from './read-limiter';
import { isBelow } from '@shared/paths';

/** Folders one scan reads at most: a few hundred milliseconds on a slow disk, far above what a usual depth needs. */
export const REPO_SEARCH_MAX_FOLDERS = 20_000;
/** Folders read at once: enough to hide the disk's latency, few enough to stay clear of the open-files limit. */
const READ_AT_ONCE = 32;

const skip = (name: string) => name === 'node_modules' || name.startsWith('.');
/**
 * node's own realpath, async: the one GitHub reads a project's root with (realpathSync). The native one differs: on
 * Windows a mapped drive comes back as \\server\share and a subst drive as its folder, on macOS a folder in its own
 * case; repositories found through it would not be under the root.
 */
const realpath = (p: string) => new Promise<string>((done, fail) => { realpathCb(p, (e, r) => (e ? fail(e) : done(r))); });
const isRepo = (d: string) => access(join(d, '.git')).then(() => true, () => false);

/** A folder's subfolders (symlinked ones too), by name; none when it can't be read. */
async function subfolders(d: string): Promise<string[]> {
  try {
    const entries = await readdir(d, { withFileTypes: true });
    const dirs = await Promise.all(entries.filter((e) => !skip(e.name)).map(async (e) => {
      if (e.isDirectory()) return e.name;
      if (!e.isSymbolicLink()) return null;
      return stat(join(d, e.name)).then((s) => (s.isDirectory() ? e.name : null), () => null);
    }));
    return dirs.filter((n): n is string => n !== null).sort();
  } catch {
    return [];
  }
}

export interface RepoSearchResult {
  repos: string[];
  /** The scan stopped at its folder cap: deeper folders may hold repos it didn't see. */
  capped: boolean;
}

/**
 * The repos of a project: the root if it is one, then every repo in its subfolders down to `depth` levels (the root is
 * level 0), inside other repos too. Hidden folders and node_modules are skipped; folders a .gitignore ignores are not
 * (repos cloned inside another one are usually ignored by it). Level by level, so the shallow repos are known first
 * when the scan reaches `maxFolders` folders read and stops. Real paths, like those of git and attributions (a
 * symlinked folder yields its target), each repo once, in the order of the folders they were found in.
 */
export async function discoverRepos(root: string, o: { depth: number; maxFolders?: number }): Promise<RepoSearchResult> {
  const max = o.maxFolders ?? REPO_SEARCH_MAX_FOLDERS;
  const start = toOut(await realpath(root));
  /** Where each repo was found (its path under the root, as segments) and its real path. */
  const found: { at: string[]; real: string }[] = [];
  const seen = new Set<string>();
  const add = async (at: string[], dir: string) => {
    let real: string;
    try { real = toOut(await realpath(dir)); } catch { return; /* gone meanwhile */ }
    if (seen.has(real)) return;
    seen.add(real);
    found.push({ at, real });
  };
  if (await isRepo(start)) await add([], start);
  let level: string[][] = [[]];
  let read = 0;
  let capped = false;
  for (let depth = 1; depth <= o.depth && level.length > 0 && !capped; depth++) {
    const next: string[][] = [];
    for (let i = 0; i < level.length; i += READ_AT_ONCE) {
      const wanted = level.slice(i, i + READ_AT_ONCE);
      const batch = wanted.slice(0, Math.max(0, max - read));
      read += batch.length;
      const children = (await Promise.all(batch.map(async (at) => (await subfolders(join(start, ...at))).map((n) => [...at, n])))).flat();
      const repos = await Promise.all(children.map((at) => isRepo(join(start, ...at))));
      for (const [k, at] of children.entries()) if (repos[k]) await add(at, join(start, ...at));
      next.push(...children);
      if (batch.length < wanted.length) { capped = true; break; }
    }
    level = next;
  }
  // Folder order: the root, then depth-first with each folder's subfolders by name.
  const before = (a: string[], b: string[]) => {
    for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i]! < b[i]! ? -1 : 1;
    return a.length - b.length;
  };
  return { repos: found.sort((a, b) => before(a.at, b.at)).map((f) => f.real), capped };
}

/** A working tree of the project: a discovered repo or a linked worktree of one. */
export interface WorkingTree {
  root: string;
  /** The git common dir (real path): working trees of one repository share it. */
  common: string;
  /**
   * Its own git dir (real path): the common dir for a main checkout, `<common>/worktrees/<name>` for a linked worktree
   * (its HEAD and index), a submodule's `.git/modules/<name>`. Null when unreadable.
   */
  gitDir: string | null;
  /** The adopting working tree's root when this is a linked worktree of a discovered repo (see listWorkingTrees). */
  worktreeOf: string | null;
  /** A linked worktree discovery missed: in a hidden folder (`.claude/worktrees/x`) or deeper than it looks. */
  hidden: boolean;
}

/**
 * A working tree's own git dir, read from its `.git` (a folder, or a file naming it: `gitdir: …`), as a real path;
 * null when there is none to read. No git process: Changes reads it for every working tree after each listing.
 */
export function gitDirOfTree(root: string): string | null {
  const dotGit = join(root, '.git');
  try {
    if (statSync(dotGit).isDirectory()) return real(dotGit);
    const m = /^gitdir: (.+)$/m.exec(readFileSync(dotGit, 'utf8'));
    return m ? real(resolve(root, m[1]!.trim())) : null;
  } catch {
    return null;
  }
}

/** The common dir of a git dir: what its `commondir` file names (a linked worktree's), else the git dir itself. */
function commonOfGitDir(gitDir: string): string {
  try { return real(resolve(gitDir, readFileSync(join(gitDir, 'commondir'), 'utf8').trim())); } catch { return gitDir; }
}

const real = (p: string) => { try { return toOut(realpathSync(p)); } catch { return p; } };

/**
 * The project's working trees before git has listed them, read from the files git keeps (no git process: Source
 * Control shows them at once while a big folder's first listing runs): each discovered repo, a linked one tied to its
 * discovered main checkout, then each main checkout's linked worktrees inside the project that discovery missed
 * (hidden folders), from `<common>/worktrees/<name>/gitdir`. Gone or outside ones are left out, as git's listing does.
 */
export function quickTrees(projectRoot: string, discovered: readonly string[]): WorkingTree[] {
  const known = new Set(discovered);
  const trees = discovered.map((root) => {
    const gitDir = gitDirOfTree(root);
    return { root, common: commonOfGitDir(gitDir ?? join(root, '.git')), gitDir, worktreeOf: null as string | null, hidden: false };
  });
  const mainOf = new Map(trees.filter((t) => t.gitDir === t.common).map((t) => [t.common, t.root]));
  for (const t of trees) if (t.gitDir !== t.common) t.worktreeOf = mainOf.get(t.common) ?? null;
  const out: WorkingTree[] = [];
  for (const t of trees) {
    out.push(t);
    if (t.gitDir !== t.common) continue;
    let names: string[];
    try { names = readdirSync(join(t.common, 'worktrees')); } catch { continue; }
    const hidden: WorkingTree[] = [];
    for (const name of names) {
      const admin = join(t.common, 'worktrees', name);
      let dotGit: string;
      try { dotGit = readFileSync(join(admin, 'gitdir'), 'utf8').trim(); } catch { continue; }
      const root = dirname(resolve(admin, dotGit));
      if (!existsSync(root)) continue;
      const wt = real(root);
      if (known.has(wt) || !isBelow(projectRoot, wt)) continue;
      hidden.push({ root: wt, common: t.common, gitDir: real(admin), worktreeOf: t.root, hidden: true });
    }
    out.push(...hidden.sort((a, b) => (a.root < b.root ? -1 : 1)));
  }
  return out;
}

/**
 * The listing that covers the ones asked while another ran: every repo asked about, each at the level it was asked
 * at (a full bulk relist after dropped events stays bulk when one repository's commit asks for a live one).
 */
export function relistPlan(live: ReadonlySet<string> | 'all', bulk: ReadonlySet<string> | 'all'): { stale: ReadonlySet<string> | 'all'; level: (repo: string) => ReadLevel } {
  const stale = live === 'all' || bulk === 'all' ? 'all' : new Set([...live, ...bulk]);
  return { stale, level: (repo) => (live === 'all' || live.has(repo) ? 'live' : 'bulk') };
}

/** What git said about a discovered repo: its common dir and its worktrees (null when git didn't answer). */
export interface RepoList { common: string; wts: ScmWorktree[] | null }

/**
 * The discovered repos, each followed by its linked worktrees inside the project that discovery missed (hidden
 * folders), by path. A discovered repo that is a linked worktree of another one gets its `worktreeOf`. Worktrees
 * outside the project, prunable (folder gone) or bare are left out. When git can't list a repo's worktrees (a timeout
 * under load), the ones `previous` had for it stay.
 *
 * `lists` keeps git's answers between calls: only the repos in `stale`, and those it has no answer for, are asked again
 * (a commit in one repository of hundreds asks about that one). Git is asked through the shared limiter at `level`.
 */
export async function listWorkingTrees(projectRoot: string, discovered: string[], previous: readonly WorkingTree[] = [],
  o: { lists?: Map<string, RepoList>; stale?: ReadonlySet<string> | 'all'; level?: ReadLevel | ((repo: string) => ReadLevel) } = {}): Promise<WorkingTree[]> {
  const known = new Set(discovered);
  const linked = new Map<string, string>();
  const stale = o.stale ?? 'all';
  const levelOf = typeof o.level === 'function' ? o.level : () => (o.level as ReadLevel | undefined) ?? 'live';
  for (const r of o.lists?.keys() ?? []) if (!known.has(r)) o.lists!.delete(r);
  const lists = await Promise.all(discovered.map(async (r) => {
    const cached = o.lists?.get(r);
    if (cached && stale !== 'all' && !stale.has(r)) return { r, ...cached };
    const git = (args: string[]) => gitReadLimiter.run(levelOf(r), () => runGit(r, args));
    // Under load git may not answer in time: the common dir is then read from the files git itself reads.
    const fallback = () => previous.find((t) => t.root === r)?.common ?? commonOfGitDir(gitDirOfTree(r) ?? join(r, '.git'));
    const common = await git(['rev-parse', '--path-format=absolute', '--git-common-dir']).then((x) => real(x.trim()), fallback);
    const wts = await git(['worktree', 'list', '--porcelain', '-z']).then(parseWorktrees, () => null);
    // No answer is not one to keep: the next listing asks again.
    if (wts) o.lists?.set(r, { common, wts }); else o.lists?.delete(r);
    return { r, common, wts };
  }));
  // Every working tree lists them all: one adopts the others — the main one (listed first), or, when that one is
  // outside the project (the project is a linked worktree of a repository elsewhere), the first discovered with its
  // common dir.
  const adopter = new Map<string, string>();
  for (const { r, common, wts } of lists) {
    const main = wts?.[0] ? real(wts[0].path) : null;
    if (main === r) adopter.set(common, r);
    else if (!adopter.has(common) && main !== null && !known.has(main)) adopter.set(common, r);
  }
  const adopted = lists.map(({ r, common, wts }) => {
    const hidden: string[] = [];
    if (wts === null) {
      // Not listed this time (a timeout): the ones the last listing had stay.
      for (const t of previous) if (t.worktreeOf === r && !t.hidden) linked.set(t.root, r);
      hidden.push(...previous.filter((t) => t.worktreeOf === r && t.hidden).map((t) => t.root));
    } else if (adopter.get(common) === r) {
      for (const w of wts) {
        if (w.prunable || w.bare) continue;
        const p = real(w.path);
        if (!isBelow(projectRoot, p) || p === r) continue;
        if (known.has(p)) linked.set(p, r);
        else hidden.push(p);
      }
    }
    return { r, common, hidden: hidden.sort() };
  });
  const out: WorkingTree[] = [];
  for (const { r, common, hidden } of adopted) {
    out.push({ root: r, common, gitDir: gitDirOfTree(r), worktreeOf: linked.get(r) ?? null, hidden: false });
    for (const p of hidden) out.push({ root: p, common, gitDir: gitDirOfTree(p), worktreeOf: r, hidden: true });
  }
  return out;
}
