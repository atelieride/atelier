// The repositories each project hides from Atelier: ATELIER_HOME/hidden-repos.json, 0600, written atomically.
// Paths inside the project only, by project root: no file content, nothing about the repositories themselves.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeFileAtomic } from '../daemon/fsutil';
import { isAbsPath } from '@shared/paths';
import { HIDDEN_REPOS_MAX_PER_PROJECT, HIDDEN_REPOS_MAX_PROJECTS, isHiddenRel } from '@shared/hidden-repos';

export interface HiddenRepos {
  /** The project's hidden paths, sorted. */
  list(project: string): string[];
  /** Hides `rel` in the project; the new list. Throws on a bad path, past the limits or when the file can't be written. */
  add(project: string, rel: string): string[];
  /** Shows `rel` again; the new list. Throws when the file can't be written. */
  remove(project: string, rel: string): string[];
}

const clean = (v: unknown): string[] => (Array.isArray(v) ? [...new Set(v.filter(isHiddenRel))].sort().slice(0, HIDDEN_REPOS_MAX_PER_PROJECT) : []);

export function createHiddenRepos(home: string): HiddenRepos {
  const file = join(home, 'hidden-repos.json');
  let projects: Record<string, string[]> | null = null;
  // A file that can't be read (damaged, another version) hides nothing; the next change writes a sound one.
  const load = (): Record<string, string[]> => {
    if (projects) return projects;
    projects = {};
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8')) as { version?: unknown; projects?: unknown };
      const p = raw.version === 1 && raw.projects && typeof raw.projects === 'object' ? (raw.projects as Record<string, unknown>) : {};
      for (const [root, list] of Object.entries(p).slice(0, HIDDEN_REPOS_MAX_PROJECTS)) {
        const rels = clean(list);
        if (isAbsPath(root) && rels.length) projects[root] = rels;
      }
    } catch { /* missing or unreadable */ }
    return projects;
  };
  // File first, then memory: a failed write changes nothing.
  const commit = (project: string, rels: string[], base: Record<string, string[]> = load()): string[] => {
    const next = { ...base };
    if (rels.length) next[project] = rels; else delete next[project];
    writeFileAtomic(file, JSON.stringify({ version: 1, projects: next }, null, 2), 0o600);
    projects = next;
    return rels;
  };
  return {
    list: (project) => [...(load()[project] ?? [])],
    add: (project, rel) => {
      if (!isAbsPath(project) || !isHiddenRel(rel)) throw new Error('not a path this project can hide');
      const now = load()[project] ?? [];
      if (now.includes(rel)) return [...now];
      if (now.length >= HIDDEN_REPOS_MAX_PER_PROJECT) throw new Error('too many hidden repositories');
      if (!now.length && Object.keys(load()).length >= HIDDEN_REPOS_MAX_PROJECTS) {
        // Full: the projects whose folder is gone (moved, deleted) make room; the ones still there keep what they hide.
        const there = Object.fromEntries(Object.entries(load()).filter(([root]) => existsSync(root)));
        if (Object.keys(there).length >= HIDDEN_REPOS_MAX_PROJECTS) throw new Error('too many projects with hidden repositories');
        return commit(project, [rel], there);
      }
      return commit(project, [...now, rel].sort());
    },
    remove: (project, rel) => {
      const now = load()[project] ?? [];
      if (!now.includes(rel)) return [...now];
      return commit(project, now.filter((r) => r !== rel));
    }
  };
}
