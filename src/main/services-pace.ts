import type { ServicesStatus } from '@shared/services';

/** Services' pace: full while someone may look, slow otherwise (the footer's count still moves). */
export const SERVICES_PACE = { tickMs: 1000, listMs: 3000, restMs: 30_000, idleCaptureMs: 5000, watchedCaptureMs: 1000 } as const;

/** A 1 s interval may fire a little early: half a tick of tolerance keeps a 1 s pace at 1 s, not 2 s. */
const due = (since: number, every: number) => since >= every - SERVICES_PACE.tickMs / 2;

/**
 * tmux list-panes: every 3 s while focused, also with no server or no panes (a tmux started now shows at once, and a
 * failed list is cheap); every 30 s in the background or without tmux at all.
 */
export function listDue(o: { last: number; now: number; focused: boolean; status: ServicesStatus; panes: number }): boolean {
  const every = o.focused && o.status !== 'no-tmux' ? SERVICES_PACE.listMs : SERVICES_PACE.restMs;
  return due(o.now - o.last, every);
}

/** capture-pane: a watched pane every 1 s and the others every 5 s while focused; every 30 s in the background. */
export function captureDue(o: { last: number; now: number; focused: boolean; watched: boolean }): boolean {
  const every = !o.focused ? SERVICES_PACE.restMs : o.watched ? SERVICES_PACE.watchedCaptureMs : SERVICES_PACE.idleCaptureMs;
  return due(o.now - o.last, every);
}
