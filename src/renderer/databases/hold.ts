// A connection the user disconnected stays closed when the user comes back to the view, until the user connects it
// themselves.
// The hold is main's: the sidebar's Disconnect sets it, a window's select, Connect, Try Again and a typed
// password let it go — for every window at once —, and each snapshot says it (DbConnView.held). The renderer keeps
// nothing of its own: these read it. One module the menus and the reads both import, so neither imports the other
// (menus → actions → data → menus was a cycle).
import type { DbSnapshot } from '@shared/databases';
import { tdb } from '../i18n/db';
import { useApp } from '../store';
import { useDb } from './store';

/** Whether main holds connection `id` in this snapshot (an explicit Disconnect, in this window or another). */
export const heldIn = (snap: DbSnapshot, id: string): boolean => snap.connections.some((v) => v.conn.id === id && v.held);

/** The same, now: for actions and event handlers. */
export const isHeld = (id: string): boolean => heldIn(useDb.getState().snap, id);

/** The same for a component: it re-renders when the hold of `id` changes, not with every snapshot. */
export const useHeld = (id: string): boolean => useDb((s) => heldIn(s.snap, id));

/**
 * The user's Connect on a Disconnected card: main lets the hold go for every window and connects it; the views read
 * once its
 * snapshot says so. A call that never got to main says so in a toast.
 */
export function connectHeld(id: string): void {
  void window.atelier.databases.connect(id).catch(() => useApp.getState().showToast(tdb.fail.connect));
}
