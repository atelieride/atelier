import type { TerminalInfo } from '@shared/protocol';
import { addedMcp, type McpAdded } from '@shared/claude-config';

// New MCP servers: each live session's baseline, taken when its Claude starts, against what
// its config files set up now. Names only; main's poll calls tick().

/** A changed config is read again at most this often: Claude Code rewrites ~/.claude.json often, and it can be big. */
export const READ_EVERY_MS = 15_000;
/** How often main checks the files (size + mtime only). */
export const POLL_MS = 5_000;

/** Where a session's servers come from: one key per (folder, account), the files to stat, and the read. */
export interface McpPair {
  key: string;
  files: string[];
  /** The servers a session started now would load (loadableMcp), or null when a file can't be read. */
  read(): Promise<string[] | null>;
}

export interface McpWatchDeps {
  pairOf(term: TerminalInfo): McpPair;
  /** A file's signature (size + mtime), '' when missing. */
  stat(path: string): Promise<string>;
  now(): number;
  /** e2e: a shorter throttle (READ_EVERY_MS otherwise). */
  readEveryMs?: number;
}

interface Pair { pair: McpPair; sig: string; names: string[] | null; readAt: number; dirty: boolean }
interface Baseline { project: string; key: string; names: string[] | null }

export class McpWatch {
  private readonly baselines = new Map<string, Baseline>();
  private readonly pairs = new Map<string, Pair>();
  private added: Record<string, string[]> = {};

  constructor(private readonly deps: McpWatchDeps) {}

  /**
   * atelierd's list: a session that appears (first seen, or Claude started again in its terminal) gets its baseline
   * read now; one that goes (Claude quit, the terminal closed) drops it. A new session id with the session still there
   * (/clear, a compaction) keeps it: the process and its servers are the same.
   */
  async update(list: readonly TerminalInfo[]): Promise<void> {
    const live = new Set<string>();
    const reads: Promise<void>[] = [];
    // One read per (folder, account), however many sessions appear there at once (an app start with 8 open).
    const now = new Map<string, Promise<string[] | null>>();
    for (const t of list) {
      if (!t.session) continue;
      live.add(t.id);
      if (this.baselines.has(t.id)) continue;
      const pair = this.deps.pairOf(t);
      const b: Baseline = { project: t.projectRoot, key: pair.key, names: null };
      this.baselines.set(t.id, b);
      let names = now.get(pair.key);
      if (!names) { names = this.current(pair); now.set(pair.key, names); }
      reads.push(names.then((n) => { b.names = n; }));
    }
    for (const id of [...this.baselines.keys()]) if (!live.has(id)) this.baselines.delete(id);
    const used = new Set([...this.baselines.values()].map((b) => b.key));
    for (const key of [...this.pairs.keys()]) if (!used.has(key)) this.pairs.delete(key);
    await Promise.all(reads);
    this.compute();
  }

  /** Any live session: the poll runs only then. */
  live(): boolean {
    return this.baselines.size > 0;
  }

  /** One poll: stats every pair's files, reads a changed one again (throttled); true when the news changed. */
  async tick(): Promise<boolean> {
    const now = this.deps.now();
    await Promise.all([...this.pairs.values()].map(async (p) => {
      const sig = await this.sig(p.pair);
      if (sig !== p.sig) p.dirty = true;
      if (p.dirty && now - p.readAt >= (this.deps.readEveryMs ?? READ_EVERY_MS)) await this.read(p.pair);
    }));
    return this.compute();
  }

  /** A project's sessions with servers added since they started. */
  addedIn(project: string): McpAdded {
    return Object.fromEntries(Object.entries(this.added).filter(([id]) => this.baselines.get(id)?.project === project));
  }

  /** What a pair sets up now: its last read while its files are unchanged since, else a new read. */
  private async current(pair: McpPair): Promise<string[] | null> {
    const known = this.pairs.get(pair.key);
    if (known?.names && !known.dirty && (await this.sig(pair)) === known.sig) return known.names;
    return this.read(pair);
  }

  /** Reads a pair now (its signature first, so a change during the read is seen next time). */
  private async read(pair: McpPair): Promise<string[] | null> {
    const sig = await this.sig(pair);
    const names = await pair.read();
    this.pairs.set(pair.key, { pair, sig, names, readAt: this.deps.now(), dirty: false });
    return names;
  }

  private async sig(pair: McpPair): Promise<string> {
    return (await Promise.all(pair.files.map((f) => this.deps.stat(f)))).join('|');
  }

  private compute(): boolean {
    const next: Record<string, string[]> = {};
    for (const [id, b] of this.baselines) {
      const now = this.pairs.get(b.key)?.names;
      if (!b.names || !now) continue;
      const added = addedMcp(b.names, now);
      if (added.length > 0) next[id] = added;
    }
    const changed = JSON.stringify(next) !== JSON.stringify(this.added);
    this.added = next;
    return changed;
  }
}
