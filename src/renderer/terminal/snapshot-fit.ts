/**
 * atelierd's screen (attach, reconnection) is written into the xterm at whatever size it has then. A terminal behind
 * another tab has never been fitted (80×24): a full-screen program's screen comes out cut and shifted, and when the
 * PTY already has the pane's size nothing makes the program redraw. So the first fit after a screen was written at
 * another size asks for the screen again, now written at the right size (once: later fits are plain resizes).
 */
export class SnapshotFit {
  private at: { cols: number; rows: number } | null = null;

  /** A screen was written into the xterm, at its current size. */
  written(cols: number, rows: number): void { this.at = { cols, rows }; }

  /** The xterm was fitted: true if the screen written before must be asked again. */
  fitted(cols: number, rows: number): boolean {
    const at = this.at;
    this.at = null;
    return !!at && (at.cols !== cols || at.rows !== rows);
  }
}
