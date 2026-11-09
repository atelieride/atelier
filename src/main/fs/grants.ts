import { statSync } from 'node:fs';
import { isAbsolute, realOut } from '../cpath';

/** Files outside the project a project may read and save. */
export const MAX_GRANTS = 200;
export const MAX_PATH_BYTES = 4096;
export type GrantMode = 'edit' | 'read';

function realFile(p: string): string | null {
  if (!isAbsolute(p) || Buffer.byteLength(p) > MAX_PATH_BYTES) return null;
  try {
    // Native realpath: on APFS it returns the real spelling, so one file is one grant.
    const real = realOut(p);
    return statSync(real).isFile() ? real : null;
  } catch {
    return null;
  }
}

/**
 * Grants of single files outside a project, by project root. A grant only comes from a user gesture the page can't fake
 * (main's open panel, main's save panel for Save Outside the Project…, a Finder drop turned into paths by the preload,
 * macOS open-file, a restore of an earlier grant); it is the file's real path, so nothing else in its folder becomes
 * readable.
 */
export class GrantStore {
  /** Oldest first. */
  private readonly byRoot = new Map<string, string[]>();
  /** The real paths granted read-only, by project; every other grant is for editing. */
  private readonly readOnly = new Map<string, Set<string>>();

  /**
   * upgraded: a read grant just became an edit one (a gesture), so what main saved as read-only for it (tabs,
   * pop-outs) can say so at once.
   */
  constructor(private readonly max = MAX_GRANTS, private readonly open: (root: string) => ReadonlySet<string> = () => new Set(), private readonly upgraded: (root: string, real: string) => void = () => {}) {}

  /**
   * Grants a regular file by its real path; null for anything else. 'read' (a file in Claude's temp folder, granted
   * without a gesture) can be read but never saved; a later 'edit' grant (a gesture) upgrades it, never the reverse.
   * A read grant takes only the real path its caller checked: a link put there since then grants nothing.
   */
  grant(root: string, path: string, mode: GrantMode = 'edit'): string | null {
    const real = realFile(path);
    if (!real || (mode === 'read' && real !== path)) return null;
    const before = this.byRoot.get(root) ?? [];
    const ro = this.readOnly.get(root) ?? new Set<string>();
    const upgrade = mode === 'edit' && ro.has(real);
    if (mode === 'edit') ro.delete(real);
    else if (!before.includes(real)) ro.add(real);
    const list = before.filter((p) => p !== real);
    list.push(real);
    const open = this.open(root);
    while (list.length > this.max) {
      // Read grants first (a page can make them at will), then the oldest one not open.
      const r = list.findIndex((p) => ro.has(p) && !open.has(p) && p !== real);
      const i = r >= 0 ? r : list.findIndex((p) => !open.has(p));
      ro.delete(list.splice(i >= 0 ? i : 0, 1)[0]!);
    }
    this.byRoot.set(root, list);
    this.readOnly.set(root, ro);
    if (upgrade) this.upgraded(root, real);
    return real;
  }

  /**
   * A grant gone again (made for a move the target window refused or never
   * answered): `path` as the grant checked it, its real path.
   */
  revoke(root: string, path: string): void {
    const real = realFile(path);
    if (!real) return;
    const list = this.byRoot.get(root);
    if (list) this.byRoot.set(root, list.filter((p) => p !== real));
    this.readOnly.get(root)?.delete(real);
  }

  /** How a real path is granted to the project, or null when it isn't. */
  mode(root: string, real: string): GrantMode | null {
    if (!this.has(root, real)) return null;
    return this.readOnly.get(root)?.has(real) ? 'read' : 'edit';
  }

  has(root: string, real: string): boolean {
    return this.byRoot.get(root)?.includes(real) ?? false;
  }

  /** The real path `path` resolves to now, if that is a granted file of the project. */
  check(root: string, path: string): string | null {
    const real = realFile(path);
    return real && this.has(root, real) ? real : null;
  }

  list(root: string): string[] {
    return [...(this.byRoot.get(root) ?? [])];
  }
}
