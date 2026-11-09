// "Play a sound" (Settings › Notifications): Atelier's own chime, generated with WebAudio (no audio files). It plays in
// the window of the session's project whether or not that window is in front: the macOS banner, and its sound, only
// show for windows in the background, and only once macOS allows Atelier's notifications.
import type { NoteEntry } from '@shared/notifications';
import type { Settings } from '@shared/settings';

/** Chimes closer than this play once (a waiting session and a finish arriving together). */
export const CHIME_GAP_MS = 1500;

/**
 * Whether new notification-center entries chime: each kind only with its notification on, never for sessions on screen
 * (`viewing`: the terminals shown in the focused window, every pane of a split).
 */
export function chimeFor(entries: NoteEntry[], s: Settings, viewing: ReadonlySet<string>): boolean {
  if (!s.notifySound) return false;
  return entries.some((e) => {
    const on = e.kind === 'waiting' ? s.notifyWaiting : e.kind === 'trigger' ? s.notifyTriggers : e.kind === 'container' ? s.dockerNotify : e.kind === 'job' ? s.redisNotify : s.notifyDone;
    return on && e.sessions.some((x) => !viewing.has(x.id));
  });
}

export class ChimeGate {
  private last = -Infinity;
  pass(now: number): boolean {
    if (now - this.last < CHIME_GAP_MS) return false;
    this.last = now;
    return true;
  }
}

let ctx: AudioContext | null = null;
const gate = new ChimeGate();

/** Two soft bell notes, rising: noticeable, never alarming. */
export function playChime(now = Date.now()): void {
  if (!gate.pass(now)) return;
  try {
    ctx ??= new AudioContext();
    void ctx.resume().catch(() => {});
    const t0 = ctx.currentTime;
    for (const [i, freq] of [659.25, 987.77].entries()) {
      const t = t0 + i * 0.12;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, t);
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(0.09, t + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.55);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t);
      osc.stop(t + 0.6);
    }
  } catch { /* no audio: no sound */ }
}
