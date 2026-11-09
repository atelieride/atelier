import { isInside } from '@shared/paths';

// A git dir's entries that end a submodule's name in `.git/modules/<name>/…` (a name may hold slashes); `objects` and
// `logs` end it too, as nothing under them matters here.
const GIT_DIR_ENTRIES = new Set(['HEAD', 'index', 'refs', 'packed-refs', 'FETCH_HEAD', 'worktrees', 'reftable', 'config', 'modules', 'objects', 'logs']);

/**
 * The git dir a changed path (relative to the project root, or to an outside common dir as `.git/<path>`) lies in, and
 * the path's parts inside it: `app/.git` and ['refs', 'heads', 'x']; a submodule's own git dir, `.git/modules/<name>`
 * (nested ones too), with the parts inside that.
 */
export function locate(rel: string): { gitDir: string; inside: string[] } | null {
  const parts = rel.split(/[\\/]/);
  const g = parts.indexOf('.git');
  if (g === -1) return null;
  let dir = parts.slice(0, g + 1);
  let inside = parts.slice(g + 1);
  while (inside[0] === 'modules') {
    const end = inside.findIndex((s, i) => i >= 2 && GIT_DIR_ENTRIES.has(s));
    // `.git/modules/<name>` alone (a submodule added or gone): nothing inside it to look at.
    if (end < 0) return { gitDir: [...dir, ...inside].join('/'), inside: [] };
    dir = [...dir, ...inside.slice(0, end)];
    inside = inside.slice(end);
  }
  return { gitDir: dir.join('/'), inside };
}

/** What to do for a changed path (relative to the project root). */
export function classifyChange(_root: string, rel: string): 'ignore' | 'git' | 'file' {
  const parts = rel.split(/[\\/]/);
  if (parts.includes('node_modules') || parts.at(-1) === '.DS_Store') return 'ignore';
  const at = locate(rel);
  if (!at) return 'file';
  return insideKind(at.inside);
}

/** A path inside a git dir: one that moves a status, refs or the worktree list ('git'), or nothing ('ignore'). */
export function insideKind(inside: string[]): 'ignore' | 'git' {
  // Commit, checkout, stash, add: they change HEAD, index or refs. Objects and locks do not.
  if (inside[0] === 'HEAD' && inside.length === 1) return 'git';
  if (inside[0] === 'index' && inside.length === 1) return 'git';
  // A linked worktree's index lives in the main repo's .git: a commit inside the worktree writes it (worktrees in Changes).
  if (inside[0] === 'worktrees' && inside[2] === 'index' && inside.length === 3) return 'git';
  // A worktree added or removed (its admin folder may be reported alone): the working trees are listed again.
  if (inside[0] === 'worktrees' && inside.length <= 2) return 'git';
  if (inside[0] === 'refs') return 'git';
  // Source Control: packed refs, a fetch, a linked worktree's HEAD, config, reftable.
  if (scmKind(inside)) return 'git';
  return 'ignore';
}

/** What changed for Source Control inside a git dir (the path parts inside it), if anything. */
function scmKind(inside: string[]): 'refs' | 'head' | 'fetch' | null {
  const [a, b, c] = inside;
  const last = inside.at(-1) ?? '';
  if (inside.length === 1 && a === 'HEAD') return 'head';
  if (inside.length === 1 && a === 'packed-refs') return 'refs';
  if (inside.length === 1 && a === 'FETCH_HEAD') return 'fetch';
  if (a === 'refs' && inside.length > 1 && !last.endsWith('.lock')) return 'refs';
  // An upstream set (`branch -u`), a remote added: config only. Every ref and HEAD of a reftable repo (git 3's default).
  if (inside.length === 1 && a === 'config') return 'refs';
  if (a === 'reftable' && inside.length === 2 && !last.endsWith('.lock')) return 'refs';
  if (a === 'worktrees' && b && c === 'HEAD' && inside.length === 3) return 'head';
  if (a === 'worktrees' && b && c === 'reftable' && inside.length === 4 && !last.endsWith('.lock')) return 'head';
  // FETCH_HEAD is per worktree: a fetch run in a linked one writes it in its admin folder.
  if (a === 'worktrees' && b && c === 'FETCH_HEAD' && inside.length === 3) return 'fetch';
  return null;
}

/** A changed path (relative to the project root) that matters to Source Control: which git dir, and what. */
export function scmChange(rel: string): { gitDir: string; what: 'refs' | 'head' | 'fetch'; worktree: boolean } | null {
  const at = locate(rel);
  const what = at ? scmKind(at.inside) : null;
  // A linked worktree's HEAD (also written when one is added or removed): the switcher's entries may have changed.
  return at && what ? { gitDir: at.gitDir, what, worktree: at.inside[0] === 'worktrees' && what === 'head' } : null;
}

/** A linked worktree added or removed: `.git/worktrees`, its admin folder or its HEAD (worktrees in Changes). */
export function worktreeListChange(rel: string): boolean {
  const inside = locate(rel)?.inside;
  if (!inside || inside[0] !== 'worktrees') return false;
  const rest = inside.length - 1;
  return rest <= 1 || (rest === 2 && inside.at(-1) === 'HEAD');
}

/**
 * Which working trees of a repo a git change can move (worktrees in Changes): refs and fetches all of them (the default
 * branch, a shared branch), a linked worktree's admin files the linked ones, the main HEAD and index only the main one.
 */
export function gitChangeScope(rel: string): 'all' | 'linked' | 'own' | null {
  const at = locate(rel);
  if (!at) return null;
  const first = at.inside[0];
  if (first === 'worktrees') return 'linked';
  if (first === 'HEAD' || first === 'index') return 'own';
  return 'all';
}

/** The git dir a changed path (relative to the project root) lies in, a submodule's own included, if any. */
export function gitDirOf(rel: string): string | null {
  return locate(rel)?.gitDir ?? null;
}

export function repoOf(repos: string[], abs: string): string | null {
  let best: string | null = null;
  for (const r of repos) {
    if (isInside(r, abs) && (!best || r.length > best.length)) best = r;
  }
  return best;
}

/** Collects keys and delivers them after `ms` of quiet, but at the latest after `maxWait` (a file written continuously must not block everything). */
export class Debouncer {
  private keys = new Set<string>();
  private timer: NodeJS.Timeout | null = null;
  private first = 0;
  constructor(private readonly ms: number, private readonly flush: (keys: Set<string>) => void, private readonly maxWait = Infinity) {}
  add(key: string): void {
    if (this.keys.size === 0) this.first = Date.now();
    this.keys.add(key);
    if (this.timer) clearTimeout(this.timer);
    const wait = Math.max(0, Math.min(this.ms, this.first + this.maxWait - Date.now()));
    this.timer = setTimeout(() => this.fire(), wait);
  }
  private fire(): void {
    const k = this.keys;
    this.keys = new Set();
    this.timer = null;
    this.flush(k);
  }
  dispose(): void { if (this.timer) clearTimeout(this.timer); }
}
