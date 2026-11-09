/**
 * What git ignores in each repo: a change there (build output, logs) asks for no status. From
 * `git ls-files --others --ignored --exclude-standard --directory -z`: an ignored folder is listed once, with its slash.
 * A folder that is not ignored but only holds ignored files is listed too, together with those files: such a folder
 * (one with a listed entry under it) is not ignored itself.
 */
export const LS_IGNORED_ARGS = ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z'];
export const IGNORE_REFRESH_MS = 60_000;

export function parseIgnored(out: string): string[] {
  return out.split('\0').filter((p) => p.length > 0);
}

interface Listed { files: Set<string>; dirs: string[]; key: string }

export class IgnoreCache {
  private sets = new Map<string, Listed>();
  /** When each repo was last listed, or tried: a failing listing waits too (no spawn per watcher batch). */
  private tried = new Map<string, number>();
  private inflight = new Map<string, Promise<void>>();
  private again = new Set<string>();

  /** `onChanged`: what git ignores changed (a path may have become visible): its repo wants a status. */
  constructor(private readonly list: (repo: string) => Promise<string>, private readonly now: () => number = Date.now,
    private readonly onChanged: (repo: string) => void = () => {}) {}

  /** `force`: the rules changed (a .gitignore saved): a listing already running is followed by another one. */
  refresh(repo: string, force = false): Promise<void> {
    const running = this.inflight.get(repo);
    if (running) {
      if (force) this.again.add(repo);
      return running;
    }
    this.tried.set(repo, this.now());
    const p = this.list(repo).then((out) => {
      const paths = parseIgnored(out);
      // A folder with nothing listed inside it. Sorted, the paths under a folder come right after it: one look at the
      // next path, not a scan of all of them per folder (thousands of __pycache__/ made that quadratic, every minute).
      const sorted = [...new Set(paths)].sort();
      const dirs = sorted.filter((x, i) => x.endsWith('/') && !sorted[i + 1]?.startsWith(x));
      const next: Listed = { files: new Set(paths.filter((x) => !x.endsWith('/'))), dirs, key: [...dirs, '\0', ...paths.filter((x) => !x.endsWith('/'))].join('\n') };
      const prev = this.sets.get(repo);
      this.sets.set(repo, next);
      if (prev && prev.key !== next.key) this.onChanged(repo);
    }).catch(() => { /* git gone or the listing too large: keep the previous set */ })
      .finally(() => {
        this.inflight.delete(repo);
        if (this.again.delete(repo)) void this.refresh(repo);
      });
    this.inflight.set(repo, p);
    return p;
  }

  /** `rel`: the path relative to the repo, with forward slashes. */
  ignored(repo: string, rel: string): boolean {
    const s = this.sets.get(repo);
    if (!s) return false;
    if (s.files.has(rel)) return true;
    return s.dirs.some((d) => rel.startsWith(d) || rel === d.slice(0, -1));
  }

  stale(repo: string): boolean {
    const at = this.tried.get(repo);
    return at === undefined || this.now() - at >= IGNORE_REFRESH_MS;
  }
}
