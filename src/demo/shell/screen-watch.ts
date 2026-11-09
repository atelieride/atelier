import type { Cancel, Clock } from '../engine/clock';

/** How often the shell looks at the screen for "Things to try" items it can only see there. */
export const SCREEN_WATCH_MS = 600;

/**
 * Looks at the screen every 600 ms on the demo's clock, until `look` says it has seen everything it waits for. On the
 * clock, not on a timer of its own: the page's `pause` (the demo closed, its iframe hidden, where `document.hidden`
 * stays false) and a background tab stop it with the rest of the world.
 */
export function watchScreen(clock: Clock, look: () => boolean): Cancel {
  const cancel = clock.every(SCREEN_WATCH_MS, () => { if (look()) cancel(); });
  return cancel;
}
