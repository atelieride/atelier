// Folders where a new session or terminal can start, and the label of a row that runs in a subfolder.

import { isBelow } from '@shared/paths';

export interface FolderChoice { path: string; rel: string; label: string; hint: string; repo: boolean }

const SKIPPED = new Set(['.git', 'node_modules']);
const trim = (p: string) => (p.length > 1 && p.endsWith('/') ? p.slice(0, -1) : p);

function relUnder(p: string, root: string): string | null {
  const r = trim(root);
  if (p === r) return '';
  return isBelow(r, p) ? p.slice(r.length + 1) : null;
}

/**
 * Path of the folder relative to the project root, with a trailing slash ("api/", "apps/web/"); null for the root
 * itself, for folders outside it and when unknown. Claude reports the real path, so the real root counts too.
 */
export function relativeCwd(cwd: string | null | undefined, root: string | null | undefined, realRoot: string | null | undefined): string | null {
  if (!cwd || !root) return null;
  const c = trim(cwd);
  const rel = relUnder(c, root) ?? (realRoot ? relUnder(c, realRoot) : null);
  return rel ? `${rel}/` : null;
}

/** Keeps the end of a long label ("…/apps/web/"), cut at a folder boundary when one fits. */
export function truncateLeft(label: string, max: number): string {
  if (label.length <= max) return label;
  const tail = label.slice(label.length - (max - 1));
  const cut = tail.indexOf('/');
  return `…${cut >= 0 && cut < tail.length - 1 ? tail.slice(cut) : tail}`;
}

/**
 * The project's folders for the "in Folder…" sheet: the root first, then git repos, then the other folders, from
 * the file index (which already leaves out git-ignored files and build folders) plus the repo roots. Index and repo
 * paths are real paths; the result uses the window's spelling of the root.
 */
export function folderChoices(o: { files: { rel: string }[]; repos: { root: string; branch: string | null }[]; root: string; realRoot: string; name: string }): FolderChoice[] {
  const branches = new Map<string, string | null>();
  for (const r of o.repos) { const rel = relUnder(r.root, o.realRoot); if (rel !== null) branches.set(rel, r.branch); }
  const dirs = new Set<string>(branches.keys());
  for (const f of o.files) {
    const parts = f.rel.split('/');
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'));
  }
  const kept = [...dirs].filter((rel) => rel !== '' && !rel.split('/').some((c) => SKIPPED.has(c)));
  const byRel = (a: string, b: string) => a.localeCompare(b);
  const repos = kept.filter((rel) => branches.has(rel)).sort(byRel);
  const others = kept.filter((rel) => !branches.has(rel)).sort(byRel);
  const root = trim(o.root);
  return [
    { path: root, rel: '', label: o.name, hint: './', repo: branches.has('') },
    ...repos.map((rel) => ({ path: `${root}/${rel}`, rel, label: `${rel}/`, hint: branches.get(rel) ?? 'repo', repo: true })),
    ...others.map((rel) => ({ path: `${root}/${rel}`, rel, label: `${rel}/`, hint: '', repo: false }))
  ];
}
