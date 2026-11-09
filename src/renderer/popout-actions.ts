// Tab pop-out windows: a pop-out giving its tab back to the main window — Move Back, ⌘W, the
// red light (main asks with popoutClose), or the handle released over the main window.
// Types only from @shared/popout: it is backend-only for the demo bundle (src/demo/compile/guard.ts).
import type { DockRequest, Point } from '@shared/popout';
import { t } from './i18n/en';
import { useApp } from './store';
import { tabMove } from './popout-move';
import type { TabKey } from './tabs-model';

function sendTab<T>(send: (r: DockRequest) => Promise<T>, stayed?: (r: T) => boolean): Promise<T | undefined> {
  const st = useApp.getState();
  if (!st.popout) return Promise.resolve(undefined);
  // A failed send leaves the window as it was (main closes it when the main window is gone).
  return tabMove(st, st.popout.key as TabKey, send, stayed).catch(() => undefined);
}

/** Move Back: the tab goes back to the main window with what it shows now (main closes this window). */
export const moveBack = (): Promise<void> => sendTab((r) => window.atelier.popout.dock(r)).then(() => {});

/**
 * The handle released: main docks the tab when the pointer is over the main window, else leaves the window there. A
 * press that never moved (a click) docks nothing: the drag ends without the tab's buffer.
 */
export const dragBackEnd = async (moved: boolean): Promise<void> => {
  if (!moved) { await window.atelier.popout.dragEnd({}).catch(() => {}); return; }
  // Over another project's window: main closes this one once it moved; a no stays here.
  const r = await sendTab((x) => window.atelier.popout.dragEnd(x), (x) => !!x && !x.ok);
  if (r && !r.ok) {
    const key = useApp.getState().popout?.key ?? '';
    useApp.getState().showToast(r.reason === 'refused' ? t.moveWin.refusedDrag(key.slice(2).split(/[\\/]/).at(-1) ?? key) : t.moveWin.failed);
  }
};

/** Main's DRAG_THRESHOLD (@shared/popout), kept equal by a test. */
export const HANDLE_THRESHOLD = 4;

/** A press on the handle becomes a drag once the pointer went this far (screen pixels, as main's drag loop counts). */
export function pastThreshold(start: Point, now: Point): boolean {
  return Math.hypot(now.x - start.x, now.y - start.y) >= HANDLE_THRESHOLD;
}
