/** How long a terminal's cursor blinks after the last input, focus or click. */
export const BLINK_REST_MS = 10_000;

interface Deps { enabled(): boolean; set(blink: boolean): void; setTimer(fn: () => void, ms: number): unknown; clearTimer(h: unknown): void }

/**
 * The cursor blinks while you work and rests when nobody types: xterm redraws a blinking cursor every 600 ms forever,
 * so a terminal left in front would keep producing frames (~1% GPU process, measured).
 */
export class BlinkIdle {
  private timer: unknown = null;
  /** The setting as last applied: settings reach the terminals before the store (adoptSettings). */
  private on: boolean | null = null;
  constructor(private readonly o: Deps) {}

  /** Input, focus or a click: blink (if the setting says so) for BLINK_REST_MS more. */
  wake(): void {
    this.stop();
    if (!(this.on ?? this.o.enabled())) { this.o.set(false); return; }
    this.o.set(true);
    this.timer = this.o.setTimer(() => { this.timer = null; this.o.set(false); }, BLINK_REST_MS);
  }

  /** Settings › Terminal › Blinking cursor changed: its new value, as it may not be in the store yet. */
  settingsChanged(enabled: boolean): void { this.on = enabled; this.wake(); }

  dispose(): void { this.stop(); }

  private stop(): void {
    if (this.timer !== null) { this.o.clearTimer(this.timer); this.timer = null; }
  }
}
