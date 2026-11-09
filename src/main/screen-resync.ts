/**
 * After the Mac wakes or a display comes and goes, the windows move and resize while the programs in the terminals keep
 * drawing: a window's xterm can end up out of step with atelierd's screen (Claude's box drawn over stale rows, until
 * the app restarts). Once the events settle, the screens are asked again from atelierd (TerminalHub.resyncScreens).
 */
export class ScreenResync {
  private timer: unknown = null;
  private disposed = false;

  constructor(private readonly o: {
    delayMs: number;
    run: () => void;
    setTimer: (fn: () => void, ms: number) => unknown;
    clearTimer: (h: unknown) => void;
  }) {}

  /** A wake or display event: runs once, delayMs after the last one. */
  poke(): void {
    if (this.disposed) return;
    if (this.timer !== null) this.o.clearTimer(this.timer);
    this.timer = this.o.setTimer(() => { this.timer = null; this.o.run(); }, this.o.delayMs);
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer !== null) this.o.clearTimer(this.timer);
    this.timer = null;
  }
}

/** `display-metrics-changed`: its size, scale or rotation moves windows; the work area alone (the Dock, the menu bar) doesn't. */
export function isLayoutChange(changedMetrics: string[]): boolean {
  return changedMetrics.some((m) => m !== 'workArea');
}
