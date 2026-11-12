/** How long a pane's size must stay put before a program on the normal buffer is told it. */
export const SETTLE_MS = 100;

/**
 * The size a terminal's program is told (its PTY), apart from the size xterm shows, which follows the pane every frame.
 *
 * On the normal buffer a program can't redraw what has scrolled into the scrollback: each width it is told leaves its
 * output wrapped at that width there. A divider or a window dragged changes the width every frame, and Claude Code's
 * classic renderer, resized like that while it writes, stacked one copy of the same lines per width. So there the
 * program gets the size once it has settled. A full-screen program (alternate buffer) redraws its whole screen: it gets
 * every size at once and follows the drag live.
 */
export class PtySize {
  private pending: { cols: number; rows: number } | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly send: (cols: number, rows: number) => void) {}

  /** The pane resized and xterm was fitted to it. */
  fitted(cols: number, rows: number, alternate: boolean): void {
    if (alternate) { this.now(cols, rows); return; }
    this.pending = { cols, rows };
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), SETTLE_MS);
  }

  /** Sent at once (an attach, a terminal shown again, other font metrics): a size still settling is dropped. */
  now(cols: number, rows: number): void {
    this.drop();
    this.send(cols, rows);
  }

  /** The size still settling, sent at once (the pane hides or goes): its program never keeps a size xterm left. */
  flush(): void {
    const p = this.pending;
    this.drop();
    if (p) this.send(p.cols, p.rows);
  }

  private drop(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.pending = null;
  }
}
