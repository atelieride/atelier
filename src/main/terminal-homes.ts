// Terminals moved to another project's window. atelierd keeps the
// project a terminal was made in; main keeps where it was moved since (terminal id → project root) and relabels
// atelierd's terminal and resumable lists with it before anything reads them, so every consumer sees one project.
// Saved in ui-state.json; pruned once atelierd no longer has the terminal (nor its resume entry).
import { isAbsPath } from '@shared/paths';

/** ui-state.json's `homes`: at most this many (a terminal is moved by hand; anything more is junk). */
export const MAX_HOMES = 500;
const ID_MAX = 128;

/** From the file: string ids (short) to absolute roots, at most MAX_HOMES. */
export function normalizeHomes(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, string> = {};
  for (const [id, root] of Object.entries(raw as Record<string, unknown>)) {
    if (Object.keys(out).length >= MAX_HOMES) break;
    if (id.length > 0 && id.length <= ID_MAX && typeof root === 'string' && isAbsPath(root)) out[id] = root;
  }
  return out;
}

export class TerminalHomes {
  private readonly homes: Map<string, string>;

  constructor(saved: Record<string, string>, private readonly save: (homes: Record<string, string>) => void) {
    this.homes = new Map(Object.entries(normalizeHomes(saved)));
  }

  /** The project a terminal was moved to, if it was. */
  get(id: string): string | undefined { return this.homes.get(id); }

  /**
   * The terminal now belongs to `to`'s window. `made`: the project atelierd knows it by (moved back there: no home
   * left).
   */
  set(id: string, made: string, to: string): void {
    if (to === made) this.homes.delete(id); else this.homes.set(id, to);
    this.save(this.snapshot());
  }

  /**
   * A resume entry resumed: atelierd made a new terminal (a new id) in the project it stored. When the entry's terminal
   * had been moved, the new one has the same home, and atelierd's reply reads as that project already.
   */
  resumed<T extends { id: string; projectRoot: string }>(oldId: string, info: T): T {
    const root = this.homes.get(oldId);
    if (!root || root === info.projectRoot) return info;
    this.set(info.id, info.projectRoot, root);
    return { ...info, projectRoot: root };
  }

  /** atelierd's list with moved terminals' projects; the same array when nothing in it moved. */
  relabel<T extends { id: string; projectRoot: string }>(list: T[]): T[] {
    if (this.homes.size === 0 || !list.some((x) => this.homes.has(x.id))) return list;
    return list.map((x) => {
      const root = this.homes.get(x.id);
      return root && root !== x.projectRoot ? { ...x, projectRoot: root } : x;
    });
  }

  /** atelierd's terminals and resume entries now: the homes of anything else go (saved only on a change). */
  prune(terminals: Iterable<string>, resumables: Iterable<string>): void {
    const alive = new Set([...terminals, ...resumables]);
    let changed = false;
    for (const id of [...this.homes.keys()]) if (!alive.has(id)) { this.homes.delete(id); changed = true; }
    if (changed) this.save(this.snapshot());
  }

  snapshot(): Record<string, string> { return Object.fromEntries(this.homes); }
}
