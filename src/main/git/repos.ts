import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { join, resolve, toOut } from '../cpath';
import { parseWorktrees } from '@shared/git-history';
import { runGit } from './exec';
import { isBelow } from '@shared/paths';

const isRepo = (d: string) => existsSync(join(d, '.git'));
const skip = (name: string) => name === 'node_modules' || name.startsWith('.');

function dirs(d: string): string[] {
  try {
    return readdirSync(d).filter((n) => !skip(n)).map((n) => join(d, n)).filter((p) => { try { return statSync(p).isDirectory(); } catch { return false; } }).sort();
  } catch {
    return [];
  }
}

/**
 * The root if it is a repo, then the repos in subfolders up to depth 2. Real paths, like those of git and attributions
 * (a symlinked folder yields its target), each repo once.
 */
export function discoverRepos(root: string): string[] {
  const r = toOut(realpathSync(root));
  const out = new Set<string>();
  const add = (d: string) => { try { out.add(toOut(realpathSync(d))); } catch { /* gone meanwhile */ } };
  if (isRepo(r)) out.add(r);
  for (const d1 of dirs(r)) {
    if (isRepo(d1)) { add(d1); continue; }
    for (const d2 of dirs(d1)) if (isRepo(d2)) add(d2);
  }
  return [...out];
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
 * The discovered repos, each followed by its linked worktrees inside the project that discovery missed (hidden
 * folders), by path. A discovered repo that is a linked worktree of another one gets its `worktreeOf`. Worktrees
 * outside the project, prunable (folder gone) or bare are left out. When git can't list a repo's worktrees (a timeout
 * under load), the ones `previous` had for it stay.
 */
export async function listWorkingTrees(projectRoot: string, discovered: string[], previous: readonly WorkingTree[] = []): Promise<WorkingTree[]> {
  const known = new Set(discovered);
  const linked = new Map<string, string>();
  const lists = await Promise.all(discovered.map(async (r) => {
    // Under load git may not answer in time: the common dir is then read from the files git itself reads.
    const fallback = () => previous.find((t) => t.root === r)?.common ?? commonOfGitDir(gitDirOfTree(r) ?? join(r, '.git'));
    const common = await runGit(r, ['rev-parse', '--path-format=absolute', '--git-common-dir']).then((x) => real(x.trim()), fallback);
    const wts = await runGit(r, ['worktree', 'list', '--porcelain', '-z']).then(parseWorktrees, () => null);
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
