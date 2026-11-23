// The sidebar's arrangement for paired phones: grouping by state, the pins, the order rows were put in by hand, the
// workspaces with their activities and which place each row is in. While iPhone access is on, the project's main window
// sends it to main whenever it changes (main keeps the last one per project, so phones have it with the window closed
// too). Names and ids only: a workspace's folder goes as its name. Nothing here changes what the window shows.
import type { RemoteLayout } from '@shared/remote';
import { useApp } from '../store';
import type { ManualOrder } from '../row-order';
import { isOpen, placesInOrder, type WorkspacesState } from '../workspaces';

export interface LayoutSource {
  groupByState: boolean;
  pins: readonly string[];
  rowOrder: ManualOrder;
  ws: WorkspacesState | null;
  /** Settings › Activities inside workspaces. */
  activities: boolean;
}

const lastSegment = (p: string): string => p.split(/[\\/]/).filter(Boolean).at(-1) ?? '';

/** The layout as phones get it, from the window's state. */
export function layoutOf(s: LayoutSource): RemoteLayout {
  const base: RemoteLayout = { groupByState: s.groupByState, pins: [...s.pins], order: { sessions: [...s.rowOrder.sessions], terminals: [...s.rowOrder.terminals] } };
  const ws = s.ws;
  if (!ws?.on) return base;
  const places = placesInOrder(ws).map((w) => {
    const folder = w.folder ? lastSegment(w.folder) : '';
    return { id: w.id, name: w.name, color: w.color, ...(folder ? { folder } : {}), ...(w.parent ? { parent: w.parent } : {}), open: isOpen(ws, w.id) };
  });
  return { ...base, workspaces: { active: ws.active, activities: s.activities, places, members: { ...ws.members } } };
}

/** Changes settle this long before the layout goes (a drag is many changes). */
export const LAYOUT_SYNC_MS = 300;

/**
 * Sends the layout whenever it changes while iPhone access is on, from the project's main window only (never a
 * pop-out). Off, nothing is sent; turned on, the current one goes at once.
 */
export function installLayoutSync(): () => void {
  let sent = '';
  let timer: ReturnType<typeof setTimeout> | null = null;
  const flush = () => {
    timer = null;
    const st = useApp.getState();
    if (!st.settings.remoteAccess || !st.project || st.popout) return;
    const layout = layoutOf({ groupByState: st.groupByState, pins: st.pins, rowOrder: st.rowOrder, ws: st.ws, activities: st.settings.wsActivities });
    const key = `${st.project.root}\n${JSON.stringify(layout)}`;
    if (key === sent) return;
    sent = key;
    void window.atelier.remote.layout(layout).catch(() => { sent = ''; });
  };
  const off = useApp.subscribe((s, prev) => {
    if (!s.settings.remoteAccess) { sent = ''; return; }
    if (s.settings.remoteAccess === prev.settings.remoteAccess && s.groupByState === prev.groupByState && s.pins === prev.pins && s.rowOrder === prev.rowOrder
      && s.ws === prev.ws && s.settings.wsActivities === prev.settings.wsActivities && s.project === prev.project) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(flush, LAYOUT_SYNC_MS);
  });
  return () => { off(); if (timer) clearTimeout(timer); };
}
