// The demo build's stand-in for src/renderer/chime.ts (swapped in by compile/build.ts): a page on the site never makes a
// sound, so the notification chime is silent and WebAudio never reaches the bundle. The inbox and the dots still show.
import type * as App from '../../renderer/chime';

export const CHIME_GAP_MS: typeof App.CHIME_GAP_MS = 1500;

export const chimeFor: typeof App.chimeFor = () => false;

export class ChimeGate implements Pick<App.ChimeGate, 'pass'> {
  pass(_now: number): boolean { return false; }
}

export const playChime: typeof App.playChime = () => {};

/** The app's module's exports, every one: a new one is a type error here. */
const _surface: { [K in keyof typeof App]: unknown } = { CHIME_GAP_MS, chimeFor, ChimeGate, playChime };
void _surface;
