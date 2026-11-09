// Source Control preferences per project: the selected repository, collapsed
// sections, Graph or First parent, the detail panel's height and the last History scope. A viewer's convenience in
// localStorage, like the pins: every value is checked when read.
import type { ScmScope } from '@shared/scm';
import { isAbsPath } from '@shared/paths';

export interface ScmPrefs {
  repo?: string; collapsed?: string[]; firstParent?: boolean; detailHeight?: number; scope?: { repo: string; scope: ScmScope };
  /** One repository (the switcher, today's view) or All Repositories. */
  view?: 'one' | 'all';
  /** All Repositories: the blocks folded (true) or unfolded (false) by hand, by working tree root. */
  folds?: Record<string, boolean>;
}

/** Folds kept per project: a project's working trees, generously. */
const MAX_FOLDS = 200;

const KEY = 'atelier.scm';
export const MAX_SCM_PROJECTS = 50;
const REF = /^(?:HEAD|refs\/(?:heads|remotes|tags)\/[^\0\s~^:?*[\\]+)$/;
const OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const rev = (x: unknown): x is string => typeof x === 'string' && (REF.test(x) || OID.test(x));

function scopeOf(v: unknown): ScmScope | null {
  if (!v || typeof v !== 'object') return null;
  const s = v as Record<string, unknown>;
  if (s.kind === 'refs' && (s.refs === 'all' || (typeof s.refs === 'string' && REF.test(s.refs))) && typeof s.firstParent === 'boolean') return { kind: 'refs', refs: s.refs as string, firstParent: s.firstParent };
  if (s.kind === 'compare' && rev(s.base) && rev(s.head)) return { kind: 'compare', base: s.base, head: s.head };
  return null;
}

function prefsOf(v: unknown): ScmPrefs | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p: ScmPrefs = {};
  if (typeof o.repo === 'string' && isAbsPath(o.repo)) p.repo = o.repo;
  if (Array.isArray(o.collapsed)) p.collapsed = o.collapsed.filter((x): x is string => typeof x === 'string').slice(0, 100);
  if (typeof o.firstParent === 'boolean') p.firstParent = o.firstParent;
  if (typeof o.detailHeight === 'number' && Number.isFinite(o.detailHeight) && o.detailHeight > 0) p.detailHeight = o.detailHeight;
  const sc = o.scope as { repo?: unknown; scope?: unknown } | undefined;
  const scope = sc ? scopeOf(sc.scope) : null;
  if (sc && typeof sc.repo === 'string' && isAbsPath(sc.repo) && scope) p.scope = { repo: sc.repo, scope };
  if (o.view === 'one' || o.view === 'all') p.view = o.view;
  if (o.folds && typeof o.folds === 'object' && !Array.isArray(o.folds)) {
    // The newest ones: a fold is saved last when made.
    const folds = Object.entries(o.folds as Record<string, unknown>).filter((e): e is [string, boolean] => isAbsPath(e[0]) && typeof e[1] === 'boolean').slice(-MAX_FOLDS);
    if (folds.length) p.folds = Object.fromEntries(folds);
  }
  return p;
}

export function parseScmPrefs(raw: string | null): Record<string, ScmPrefs> {
  let o: unknown = {};
  try { o = raw ? JSON.parse(raw) : {}; } catch { return {}; }
  if (!o || typeof o !== 'object' || Array.isArray(o)) return {};
  const out: Record<string, ScmPrefs> = {};
  for (const [root, v] of Object.entries(o)) { const p = prefsOf(v); if (p && Object.keys(p).length) out[root] = p; }
  return out;
}

export function loadScmPrefs(root: string): ScmPrefs {
  try { return parseScmPrefs(localStorage.getItem(KEY))[root] ?? {}; } catch { return {}; }
}

/** Merges `patch` into the project's preferences; the project becomes the most recent one. */
export function saveScmPrefs(root: string, patch: Partial<ScmPrefs>): void {
  try {
    const all = parseScmPrefs(localStorage.getItem(KEY));
    const next = { ...(all[root] ?? {}), ...patch };
    const rest = Object.entries(all).filter(([r]) => r !== root);
    rest.push([root, next]);
    localStorage.setItem(KEY, JSON.stringify(Object.fromEntries(rest.slice(-MAX_SCM_PROJECTS))));
  } catch { /* not saved: stays for this session */ }
}
