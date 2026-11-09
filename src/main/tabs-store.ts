import { readFileSync, statSync } from 'node:fs';
import { realOut, relative, sep } from './cpath';
import { homeLabel, type OpenFileEntry } from '@shared/files';
import { parseSavedTabs, type RestoredTabs, type SavedTabs } from '@shared/tabs-state';
import { writeFileAtomic } from '../daemon/fsutil';
import { insideProject } from './fs/files';
import { isAbsPath, isBelow } from '@shared/paths';

// The tabs of each project across restarts, in ATELIER_HOME/tabs.json (0600, atomic).

export const MAX_TAB_PROJECTS = 50;

/**
 * What a window may save: project files and files outside the project already granted to it (so the file can't be
 * used to plant grants); the order and the active key follow the files kept.
 */
export function keepAllowed(root: string, tabs: SavedTabs, granted: (path: string) => boolean, shelfOk: (path: string) => boolean = granted): SavedTabs {
  const inside = (f: string) => insideProject(root, f) !== null;
  const files = tabs.files.filter((f) => inside(f) || granted(f));
  return parseSavedTabs({ ...tabs, files, ...(tabs.shelf ? { shelf: tabs.shelf.filter((f) => inside(f) || shelfOk(f)) } : {}) }) ?? { files: [], order: [], active: null };
}

/**
 * Which outside files the Shelf may keep: granted for editing (a gesture), or already kept by
 * main for this project (away for one launch, a volume unmounted: the next restore checks them again). Never a
 * read-only grant: one made without a gesture must not come back editable if its folder stops being Claude's.
 */
export function shelfKeep(grants: { mode(root: string, real: string): 'edit' | 'read' | null }, root: string, stored: readonly string[]): (path: string) => boolean {
  return (f) => grants.mode(root, f) === 'edit' || stored.includes(f);
}

function regularFile(p: string): boolean {
  try { return statSync(p).isFile(); } catch { return false; }
}

function resolvesToItself(p: string): boolean {
  try { return realOut(p) === p; } catch { return false; }
}

/**
 * The saved tabs that are still there: a project file must still be a regular file inside the root; an outside one
 * is granted again only if it still resolves to itself (not swapped for a link). Gone ones leave the order too.
 */
export function restoreTabs(root: string, saved: SavedTabs, grant: (path: string) => string | null, home: string, label: (path: string) => string | null = () => null): RestoredTabs {
  // The Shelf's files: a project one as it is (no grant needed), an outside one granted again
  // on the same terms as an outside tab.
  const realRoot = insideProject(root, root) ?? root;
  const shelf = saved.shelf?.flatMap((f): OpenFileEntry[] => {
    const inside = insideProject(root, f);
    if (inside) return [{ path: f, rel: relative(realRoot, isBelow(realRoot, f) ? f : inside).split(sep).join('/'), external: false }];
    return resolvesToItself(f) && grant(f) === f ? [{ path: f, rel: label(f) ?? homeLabel(f, home), external: true }] : [];
  });
  const files: OpenFileEntry[] = [];
  for (const f of saved.files) {
    const inside = insideProject(root, f);
    if (inside) {
      // As it was spelled: the tree keeps a link's own name (src/link.ts), resolved inside the project.
      const realRoot = insideProject(root, root) ?? root;
      const shown = isBelow(realRoot, f) ? f : inside;
      if (regularFile(f)) files.push({ path: f, rel: relative(realRoot, shown).split(sep).join('/'), external: false });
      continue;
    }
    // Checked before granting: a link swapped in since must not grant its target, a file nobody chose.
    if (resolvesToItself(f) && grant(f) === f) files.push({ path: f, rel: label(f) ?? homeLabel(f, home), external: true });
  }
  const kept = new Set(files.map((f) => f.path));
  const order = saved.order.filter((k) => !k.startsWith('f:') || kept.has(k.slice(2)));
  const active = saved.active && (!saved.active.startsWith('f:') || kept.has(saved.active.slice(2))) ? saved.active : null;
  // The Databases space's table in front, as saved.
  const dbActive = saved.dbActive && order.includes(saved.dbActive) ? saved.dbActive : null;
  return { files, order, active, ...(shelf ? { shelf } : {}), ...(dbActive ? { dbActive } : {}) };
}

/**
 * readOnly: the outside files main held only through a read grant when it saved them,
 * so they come back read-only; absent in entries saved before main kept the mode.
 */
interface Entry { tabs: SavedTabs; at: number; readOnly?: string[] }

/** Main's read-only list as read back: the entry's own outside tab files only. */
function parseReadOnly(raw: unknown, tabs: SavedTabs): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const files = new Set([...tabs.files, ...(tabs.shelf ?? [])]);
  return raw.filter((f): f is string => typeof f === 'string' && isAbsPath(f) && files.has(f));
}

export class TabsStore {
  private readonly projects = new Map<string, Entry>();

  constructor(private readonly file: string, private readonly now: () => number = Date.now) {
    let raw: unknown;
    try { raw = JSON.parse(readFileSync(file, 'utf8')); } catch { return; }
    const list = (raw as { projects?: unknown } | null)?.projects;
    if (!list || typeof list !== 'object') return;
    for (const [root, v] of Object.entries(list as Record<string, unknown>)) {
      const tabs = parseSavedTabs((v as { tabs?: unknown } | null)?.tabs);
      const at = (v as { at?: unknown } | null)?.at;
      if (!isAbsPath(root) || !tabs) continue;
      const readOnly = parseReadOnly((v as { readOnly?: unknown } | null)?.readOnly, tabs);
      this.projects.set(root, { tabs, at: typeof at === 'number' ? at : 0, ...(readOnly ? { readOnly } : {}) });
    }
  }

  get(root: string): SavedTabs | null {
    return this.projects.get(root)?.tabs ?? null;
  }

  /** The outside files saved read-only for the project; null when its entry predates the list (or there is none). */
  readOnly(root: string): string[] | null {
    return this.projects.get(root)?.readOnly ?? null;
  }

  /** A file made editable by a gesture: no longer restored read-only, written at once (no tabs save may follow). */
  dropReadOnly(root: string, real: string): void {
    const cur = this.projects.get(root);
    if (!cur?.readOnly?.includes(real)) return;
    this.set(root, cur.tabs, cur.readOnly.filter((f) => f !== real));
  }

  set(root: string, tabs: SavedTabs, readOnly?: string[]): void {
    const cur = this.projects.get(root);
    if (cur && JSON.stringify(cur.tabs) === JSON.stringify(tabs) && JSON.stringify(cur.readOnly) === JSON.stringify(readOnly)) return;
    this.projects.set(root, { tabs, at: this.now(), ...(readOnly ? { readOnly } : {}) });
    if (this.projects.size > MAX_TAB_PROJECTS) {
      const oldest = [...this.projects].sort((a, b) => a[1].at - b[1].at).slice(0, this.projects.size - MAX_TAB_PROJECTS);
      for (const [r] of oldest) this.projects.delete(r);
    }
    writeFileAtomic(this.file, JSON.stringify({ projects: Object.fromEntries(this.projects) }), 0o600);
  }
}
