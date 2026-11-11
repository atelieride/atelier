// How Changes names repositories: by their folder, as always, except where two share a folder name (`ci` in
// `team-a/tools/` and in `team-b/tools/`): those show the shortest end of their path inside the project that tells them
// apart. Paths with forward slashes.
import { isBelow } from './paths';

const last = (p: string) => p.split('/').filter(Boolean).at(-1) ?? p;

/** Each root's name: its folder's, or for folder names two roots share, the end of its path that differs. */
export function distinctNames(roots: readonly string[], projectRoot: string): Map<string, string> {
  const parts = new Map(roots.map((r) => [r, r === projectRoot ? [] : isBelow(projectRoot, r) ? r.slice(projectRoot.length + 1).split('/') : r.split('/').filter(Boolean)]));
  const own = (r: string) => (r === projectRoot ? last(projectRoot) : parts.get(r)!.at(-1) ?? last(r));
  const groups = new Map<string, string[]>();
  for (const r of roots) groups.set(own(r), [...(groups.get(own(r)) ?? []), r]);
  const end = (p: readonly string[], k: number) => p.slice(-k).join('/');
  const out = new Map<string, string>();
  for (const [name, group] of groups) {
    if (group.length === 1) { out.set(group[0]!, name); continue; }
    for (const r of group) {
      if (r === projectRoot) { out.set(r, name); continue; }
      const p = parts.get(r)!;
      let k = 1;
      while (k < p.length && group.some((o) => o !== r && end(parts.get(o)!, k) === end(p, k))) k++;
      // Named like the project's own repository: said from the project's folder (`api/api` inside `api`).
      out.set(r, group.includes(projectRoot) && k === p.length && end(p, k) === name ? `${last(projectRoot)}/${end(p, k)}` : end(p, k));
    }
  }
  return out;
}
