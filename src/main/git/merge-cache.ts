// What each working tree's branch has to merge (worktrees in Changes), computed only when it can have changed: the
// default branch is probed once per git common dir until refs move, and a summary is computed once per (HEAD, default
// branch) pair. A burst of statuses across many worktrees then costs no git call beyond the statuses themselves.
import type { MergeInfo, RepoStatus } from '@shared/git';

export interface DefaultRef { ref: string; base: string; oid: string }

export class MergeSummaries {
  private defaults = new Map<string, Promise<DefaultRef | null>>();
  private last = new Map<string, { key: string; info: MergeInfo | null }>();

  constructor(
    private readonly probe: (repo: string) => Promise<DefaultRef | null>,
    private readonly compute: (repo: string, def: DefaultRef) => Promise<MergeInfo | null>
  ) {}

  /** The working tree's summary, and whether it differs from the last one given for it. */
  async summary(common: string, root: string, st: RepoStatus): Promise<{ changed: boolean; info: MergeInfo | null }> {
    let def: DefaultRef | null = null;
    if (st.oid && !st.error) {
      let p = this.defaults.get(common);
      if (!p) { p = this.probe(root).catch(() => null); this.defaults.set(common, p); }
      def = await p;
    }
    const onDefault = !def || (!st.detached && st.branch === def.base);
    const key = onDefault ? 'none' : `${st.oid}:${def!.oid}`;
    const prev = this.last.get(root);
    if (prev && prev.key === key) return { changed: false, info: prev.info };
    const info = onDefault ? null : await this.compute(root, def!).catch(() => null);
    this.last.set(root, { key, info });
    return { changed: true, info };
  }

  /** Refs or a HEAD moved in a git common dir: its default branch may have moved too. */
  invalidate(common: string): void {
    this.defaults.delete(common);
  }

  /** A working tree that left the project. */
  forget(root: string): void {
    this.last.delete(root);
  }
}
