// Tab pop-out windows: what a tab takes when it leaves a window — its payload and, for a file,
// its editor's buffer. The buffer is taken with the editor frozen until the other side answered (a keystroke meanwhile
// would stay behind); whatever the answer, or a throw, the editor takes edits again (after a move that worked its
// window is gone anyway).
import type { DockRequest } from '@shared/popout';
import { beginMove, endMove, putHandoff, takeHandoff } from './editor/handoff';
import { handoffOf } from './editor/savers';
import { payloadOf, type PayloadState } from './popout-payload';
import type { TabKey } from './tabs-model';

/**
 * `stayed`: the answer says the tab did not leave. A file whose editor isn't built yet (moved again right after it
 * arrived) takes the buffer still waiting for that editor; it is put back for it when the move fails.
 */
export async function tabMove<T>(st: PayloadState, key: TabKey, send: (r: DockRequest) => Promise<T>, stayed?: (r: T) => boolean): Promise<T> {
  const payload = payloadOf(st, key);
  const path = key.startsWith('f:') ? key.slice(2) : null;
  if (path) beginMove(path);
  let waiting: ReturnType<typeof takeHandoff> = null;
  try {
    const live = path ? handoffOf(path) : undefined;
    if (path && !live) waiting = takeHandoff(path);
    const handoff = live ?? waiting ?? undefined;
    const r = await send({ ...(payload ? { payload } : {}), ...(handoff ? { handoff } : {}) });
    if (waiting && stayed?.(r)) putHandoff(waiting);
    return r;
  } catch (e) {
    if (waiting) putHandoff(waiting);
    throw e;
  } finally {
    if (path) endMove(path);
  }
}
