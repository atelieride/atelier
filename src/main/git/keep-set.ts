// The attribution keep set: files Atelier's own ops make clean for a while (a commit whose Undo
// is offered, files stashed by Stash and Pull until the pop) keep their sessions. Their paths join the `dirty` list of
// every prune of that root while held, the daemon's (`attrPrune`) and the app-side Bash one alike.
import { join } from '../cpath';
import { isAbsPath } from '@shared/paths';

export class KeepSet {
  /** Per working tree root, one entry per hold (several ops may hold the same file). */
  private holds = new Map<string, Set<readonly string[]>>();

  /** Holds `paths` (absolute, or relative to `root`) for `root`; answers the release, which may be called any number of times. */
  hold(root: string, paths: string[]): () => void {
    const held: readonly string[] = paths.map((p) => (isAbsPath(p) ? p : join(root, p)));
    let set = this.holds.get(root);
    if (!set) { set = new Set(); this.holds.set(root, set); }
    set.add(held);
    return () => {
      const s = this.holds.get(root);
      if (!s?.delete(held)) return;
      if (s.size === 0) this.holds.delete(root);
    };
  }

  /** Every path held for that root. */
  paths(root: string): string[] {
    const s = this.holds.get(root);
    if (!s) return [];
    const out = new Set<string>();
    for (const held of s) for (const p of held) out.add(p);
    return [...out];
  }

  /** A prune's dirty list with the kept paths it lacks (the same list when nothing is kept). */
  static withKept(dirty: string[], kept: readonly string[]): string[] {
    if (kept.length === 0) return dirty;
    const have = new Set(dirty);
    return [...dirty, ...kept.filter((p) => !have.has(p))];
  }
}
