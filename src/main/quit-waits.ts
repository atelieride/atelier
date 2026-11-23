// What must end before the app exits once it quits: the stop requests of the windows that closed, the phones' goodbye.
// Each part is asked at the first will-quit whether it has something to wait for. Then the quit is held once while all
// of it ends, and the app exits with app.exit, which emits no second will-quit: a quit asked again after one wait
// would pass the other's hold and cut its wait short, and run every other will-quit handler twice.

export class QuitWaits {
  private readonly parts: (() => Promise<unknown> | null)[] = [];
  private asked = false;
  private holding = false;

  /** Something to wait for at the quit: the part gives its promise then, or null when there is nothing. */
  add(part: () => Promise<unknown> | null): void {
    this.parts.push(part);
  }

  /**
   * A will-quit: the first one asks every part, and holds the quit (preventDefault) until what they gave has ended
   * (well or not), then calls `exit`. A quit asked again meanwhile is held too.
   */
  willQuit(e: { preventDefault(): void }, exit: () => void): void {
    if (this.holding) { e.preventDefault(); return; }
    if (this.asked) return;
    this.asked = true;
    // A part that throws has nothing to wait for; the others still have theirs.
    const waits = this.parts.flatMap((part) => { try { const w = part(); return w ? [w] : []; } catch { return []; } });
    if (waits.length === 0) return;
    this.holding = true;
    e.preventDefault();
    void Promise.allSettled(waits).then(() => exit());
  }
}
