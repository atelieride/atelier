// Commit message drafts, one per working tree, and the drawer's height, kept per project:
// they survive closing the drawer, switching projects and a relaunch. Saved in localStorage like scm/prefs.ts, which is
// shared by the project's windows. Plus the remembered Commit all and Publish choices, app-wide.
import { MESSAGE_MAX_BYTES } from '@shared/git-write';
import { isAbsPath } from '@shared/paths';

export interface ProjectDrafts { drafts: Record<string, string>; height: number | null }
export const MAX_DRAFT_PROJECTS = 50;
const KEY = 'atelier.gitDrafts';

/** A draft past git's message cap is cut there, on a character boundary. */
export function capDraft(text: string): string {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length <= MESSAGE_MAX_BYTES) return text;
  return new TextDecoder().decode(bytes.slice(0, MESSAGE_MAX_BYTES)).replace(/�+$/, '');
}

const abs = (k: string) => isAbsPath(k);

function projectOf(v: unknown): ProjectDrafts | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const drafts: Record<string, string> = {};
  if (o.drafts && typeof o.drafts === 'object' && !Array.isArray(o.drafts)) {
    for (const [root, text] of Object.entries(o.drafts)) if (abs(root) && typeof text === 'string' && text.trim()) drafts[root] = capDraft(text);
  }
  const height = typeof o.height === 'number' && Number.isFinite(o.height) && o.height > 0 ? o.height : null;
  return Object.keys(drafts).length || height !== null ? { drafts, height } : null;
}

export function parseGitDrafts(raw: string | null): Record<string, ProjectDrafts> {
  let o: unknown = {};
  try { o = raw ? JSON.parse(raw) : {}; } catch { return {}; }
  if (!o || typeof o !== 'object' || Array.isArray(o)) return {};
  const out: Record<string, ProjectDrafts> = {};
  for (const [project, v] of Object.entries(o)) { const p = abs(project) ? projectOf(v) : null; if (p) out[project] = p; }
  return out;
}

export function loadGitDrafts(project: string): ProjectDrafts {
  try { return parseGitDrafts(localStorage.getItem(KEY))[project] ?? { drafts: {}, height: null }; } catch { return { drafts: {}, height: null }; }
}

/** Changes the project's entry, which becomes the most recent one; the oldest projects past the cap go. */
function update(project: string, fn: (p: ProjectDrafts) => ProjectDrafts): void {
  try {
    const all = parseGitDrafts(localStorage.getItem(KEY));
    const next = fn(all[project] ?? { drafts: {}, height: null });
    const rest = Object.entries(all).filter(([p]) => p !== project);
    if (Object.keys(next.drafts).length || next.height !== null) rest.push([project, next]);
    localStorage.setItem(KEY, JSON.stringify(Object.fromEntries(rest.slice(-MAX_DRAFT_PROJECTS))));
  } catch { /* not saved: stays for this session */ }
}

/** Saves a working tree's draft; a blank one is forgotten (a commit clears its draft this way). */
export function saveGitDraft(project: string, root: string, text: string): void {
  update(project, (p) => {
    const { [root]: _old, ...drafts } = p.drafts;
    return { ...p, drafts: text.trim() ? { ...drafts, [root]: capDraft(text) } : drafts };
  });
}

/** The drawer's height dragged by hand; null: its natural height again. */
export function saveDrawerHeight(project: string, height: number | null): void {
  update(project, (p) => ({ ...p, height: height !== null && Number.isFinite(height) && height > 0 ? height : null }));
}

/** Commit all's mode and "Push after committing", Publish's "Open a pull request on GitHub after". */
export interface GitPrefs { mode: 'one' | 'per-repo'; pushAfter: boolean; openPr: boolean }
const PREFS_KEY = 'atelier.gitPrefs';
const PREFS_DEFAULTS: GitPrefs = { mode: 'per-repo', pushAfter: false, openPr: false };

export function parseGitPrefs(raw: string | null): GitPrefs {
  let o: Record<string, unknown> = {};
  try { const v: unknown = raw ? JSON.parse(raw) : {}; if (v && typeof v === 'object' && !Array.isArray(v)) o = v as Record<string, unknown>; } catch { /* broken: defaults */ }
  return { mode: o.mode === 'one' ? 'one' : 'per-repo', pushAfter: o.pushAfter === true, openPr: o.openPr === true };
}

export function loadGitPrefs(): GitPrefs {
  try { return parseGitPrefs(localStorage.getItem(PREFS_KEY)); } catch { return { ...PREFS_DEFAULTS }; }
}

export function saveGitPrefs(patch: Partial<GitPrefs>): void {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify({ ...loadGitPrefs(), ...patch })); } catch { /* not saved */ }
}
