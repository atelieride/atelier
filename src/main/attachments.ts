const HOLD_MAX = 256 * 1024;

/** Which windows are watching which terminals. The service keeps a single listener per terminal. */
export class Attachments {
  private byTerm = new Map<string, Set<number>>();
  /** Attaches on their way, by `wcId id`: the input typed meanwhile, held for when they complete. */
  private pending = new Map<string, { held: string[]; size: number; refs: number; overflow: boolean }>();
  /**
   * By `wcId id`, the last pane size a window asked for when it could not reach atelierd (attach on its way, service
   * unreachable): sent once the attach completes. Otherwise its xterm and the PTY stayed different sizes and full-screen
   * programs drew for a grid nobody saw. A size that did reach it is never sent again (a same-size resize can repaint a
   * Windows console; with two windows the PTY would bounce between their sizes).
   */
  private undelivered = new Map<string, { cols: number; rows: number }>();

  add(wcId: number, id: string): void {
    let s = this.byTerm.get(id);
    if (!s) { s = new Set(); this.byTerm.set(id, s); }
    s.add(wcId);
  }

  has(wcId: number, id: string): boolean {
    return this.byTerm.get(id)?.has(wcId) ?? false;
  }

  watchers(id: string): number[] {
    return [...(this.byTerm.get(id) ?? [])];
  }

  /**
   * true if it was the last window: then it must be detached in the service too. Never while another window's attach
   * is on its way (a terminal moved between windows): atelierd keeps one listener
   * per terminal, and detaching it then would leave that window with its snapshot and no output.
   */
  remove(wcId: number, id: string): boolean {
    const s = this.byTerm.get(id);
    if (!s || !s.delete(wcId)) return false;
    if (s.size > 0) return false;
    this.byTerm.delete(id);
    return ![...this.pending.keys()].some((k) => k.endsWith(` ${id}`) && !k.startsWith(`${wcId} `));
  }

  /**
   * A window starts attaching: input it sends before the attach completes is held (hold), not dropped. A second attach
   * of the same terminal from the same window (a remount) shares the entry: it goes when the last one ends.
   */
  begin(wcId: number, id: string): void {
    const p = this.pending.get(`${wcId} ${id}`);
    if (p) p.refs += 1;
    else this.pending.set(`${wcId} ${id}`, { held: [], size: 0, refs: 1, overflow: false });
  }

  /**
   * true if the input was held for a pending attach. All or nothing: past 256 KB what was held goes and nothing more is
   * kept (never the tail of a paste without its head).
   */
  hold(wcId: number, id: string, data: string): boolean {
    const p = this.pending.get(`${wcId} ${id}`);
    if (!p || p.overflow) return false;
    if (p.size + data.length > HOLD_MAX) { p.overflow = true; p.held = []; p.size = 0; return false; }
    p.held.push(data);
    p.size += data.length;
    return true;
  }

  /**
   * An attach completed: the window watches the terminal; returns what it typed meanwhile, in order. null when the
   * window is gone (closed mid-attach): it does not become a watcher.
   */
  complete(wcId: number, id: string): string[] | null {
    const key = `${wcId} ${id}`;
    const p = this.pending.get(key);
    if (!p) return null;
    const held = p.held;
    p.held = [];
    p.size = 0;
    if (--p.refs <= 0) this.pending.delete(key);
    this.add(wcId, id);
    return held;
  }

  /** An attach failed: once the last one of this window ends, what was held goes. */
  abort(wcId: number, id: string): void {
    const key = `${wcId} ${id}`;
    const p = this.pending.get(key);
    if (p && --p.refs <= 0) this.pending.delete(key);
  }

  /** A window resized its pane: one atelierd didn't get is kept while the window watches the terminal or attaches to it. */
  sized(wcId: number, id: string, cols: number, rows: number, delivered: boolean): void {
    const key = `${wcId} ${id}`;
    if (delivered) this.undelivered.delete(key);
    else if (this.has(wcId, id) || this.pending.has(key)) this.undelivered.set(key, { cols, rows });
  }

  /** The size to send now that the attach completed, once. */
  takeUndelivered(wcId: number, id: string): { cols: number; rows: number } | null {
    const key = `${wcId} ${id}`;
    const size = this.undelivered.get(key) ?? null;
    this.undelivered.delete(key);
    return size;
  }

  /** Window closed: the terminals nobody else is watching. */
  removeWindow(wcId: number): string[] {
    for (const k of [...this.pending.keys()]) if (k.startsWith(`${wcId} `)) this.pending.delete(k);
    for (const k of [...this.undelivered.keys()]) if (k.startsWith(`${wcId} `)) this.undelivered.delete(k);
    return [...this.byTerm.keys()].filter((id) => this.remove(wcId, id));
  }

  forgetTerminal(id: string): void {
    this.byTerm.delete(id);
    for (const k of [...this.undelivered.keys()]) if (k.endsWith(` ${id}`)) this.undelivered.delete(k);
  }

  terminalsOf(wcId: number): string[] {
    return [...this.byTerm.entries()].filter(([, s]) => s.has(wcId)).map(([id]) => id);
  }
}
