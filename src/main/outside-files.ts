// The files outside each project open in its tabs: watched for disk changes, never evicted from
// the grants. The tabs report (debounced) says what is open; a file opened a moment ago counts even if a report sent
// before it arrives later.

export class OutsideFiles {
  private readonly byRoot = new Map<string, Set<string>>();
  private readonly fresh = new Map<string, Map<string, number>>();

  constructor(private readonly watch: (root: string, files: Set<string>) => void, private readonly now: () => number = Date.now, private readonly graceMs = 3000) {}

  /** Opened now (drop, Open File…, macOS): watched right away. */
  opened(root: string, files: string[]): void {
    const fresh = this.fresh.get(root) ?? new Map<string, number>();
    for (const f of files) fresh.set(f, this.now());
    this.fresh.set(root, fresh);
    this.set(root, new Set([...(this.byRoot.get(root) ?? []), ...files]));
  }

  /** The window's report of its open outside files. */
  reported(root: string, files: string[]): void {
    const fresh = this.fresh.get(root);
    const keep = new Set(files);
    if (fresh) {
      for (const [f, at] of fresh) {
        if (this.now() - at < this.graceMs) keep.add(f);
        else fresh.delete(f);
      }
    }
    this.set(root, keep);
  }

  get(root: string): ReadonlySet<string> {
    return this.byRoot.get(root) ?? new Set();
  }

  close(root: string): void {
    this.byRoot.delete(root);
    this.fresh.delete(root);
  }

  private set(root: string, files: Set<string>): void {
    this.byRoot.set(root, files);
    this.watch(root, files);
  }
}
