// A terminal has one size, and several views may show it: Atelier windows, and paired phones. The view that most
// recently attached, resized or typed owns it; when the owner stops showing the terminal, the most recent other view
// with a size of its own takes it back. Viewers are numbers (a window's webContents id; a phone's negative key). Pure:
// TerminalHub sends what this says to atelierd and tells the views.

export interface Size { cols: number; rows: number }

const same = (a: Size, b: Size) => a.cols === b.cols && a.rows === b.rows;
const key = (viewer: number, id: string) => `${viewer} ${id}`;

export class TerminalSizes {
  /** What atelierd was last sent (or created the terminal with); absent: not known. */
  private readonly sizes = new Map<string, Size>();
  private readonly owners = new Map<string, number>();
  /** Each viewer's own size for each terminal, and when it asked (the most recent takes the size back). */
  private readonly asks = new Map<string, { size: Size; seq: number }>();
  private seq = 0;

  current(id: string): Size | undefined { return this.sizes.get(id); }
  owner(id: string): number | undefined { return this.owners.get(id); }
  asked(viewer: number, id: string): Size | undefined { return this.asks.get(key(viewer, id))?.size; }

  /**
   * A viewer's size for a terminal (its attach or resize), kept as its own; with `take` it becomes the terminal's. The
   * size atelierd must get now, or null when the terminal has it already (or the viewer didn't take it).
   */
  ask(viewer: number, id: string, size: Size, take = true): Size | null {
    this.asks.set(key(viewer, id), { size: { ...size }, seq: ++this.seq });
    if (!take) return null;
    this.owners.set(id, viewer);
    const cur = this.sizes.get(id);
    if (cur && same(cur, size)) return null;
    this.sizes.set(id, { ...size });
    return { ...size };
  }

  /** The terminal has this size and nobody asked for it (created at it). */
  known(id: string, size: Size): void { this.sizes.set(id, { ...size }); }

  /**
   * `viewer` typed: it takes the size back with its own, when the owner is one `mayTake` lets it take the size from.
   * The size to send, or null.
   */
  takeBack(viewer: number, id: string, mayTake: (owner: number) => boolean): Size | null {
    const owner = this.owners.get(id);
    if (owner === undefined || owner === viewer || !mayTake(owner)) return null;
    const mine = this.asks.get(key(viewer, id));
    if (!mine) return null;
    const out = this.ask(viewer, id, mine.size);
    return out;
  }

  /**
   * `viewer` no longer shows the terminal: its own size goes. When it owned the size, the most recent of `others` with
   * a size takes it back. The size to send then, or null.
   */
  leave(viewer: number, id: string, others: readonly number[]): Size | null {
    this.asks.delete(key(viewer, id));
    if (this.owners.get(id) !== viewer) return null;
    this.owners.delete(id);
    let next: { viewer: number; size: Size; seq: number } | null = null;
    for (const o of others) {
      const a = this.asks.get(key(o, id));
      if (a && (!next || a.seq > next.seq)) next = { viewer: o, ...a };
    }
    return next ? this.ask(next.viewer, id, next.size) : null;
  }

  /** The terminals whose size a viewer `pred` accepts owns. */
  owned(pred: (viewer: number) => boolean): string[] {
    return [...this.owners].filter(([, v]) => pred(v)).map(([id]) => id);
  }

  forgetTerminal(id: string): void {
    this.sizes.delete(id);
    this.owners.delete(id);
    for (const k of [...this.asks.keys()]) if (k.endsWith(` ${id}`)) this.asks.delete(k);
  }

  /** A viewer gone (a window closed, a phone's channel over): its sizes and ownership with it. */
  forgetViewer(viewer: number): void {
    for (const k of [...this.asks.keys()]) if (k.startsWith(`${viewer} `)) this.asks.delete(k);
    for (const [id, v] of [...this.owners]) if (v === viewer) this.owners.delete(id);
  }

  /** atelierd's connection was lost: what its terminals have is unknown until sent again; the viewers' own stay. */
  unknown(): void { this.sizes.clear(); }
}
