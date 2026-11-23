// What a paired phone does to this project's rows, followed by its main window: a session the phone started in a
// workspace or activity joins that place once its row is here (quietly, as a move made by hand would, without
// bringing anything forward), and a session it resumes keeps the row's pin, manual place and workspace.
import type { RemoteRowsEvent } from '@shared/remote';
import { useApp } from '../store';

/** A new row that never shows up within this long is forgotten. */
const JOIN_MS = 30_000;

export function installPhoneRows(): () => void {
  const joins = new Map<string, { place: string; at: number }>();
  let queued = false;
  // Once the store is done with the list that brought the row (it is in the place in front by then).
  const apply = () => {
    queued = false;
    const st = useApp.getState();
    for (const [id, j] of joins) {
      if (Date.now() - j.at > JOIN_MS) { joins.delete(id); continue; }
      if (!st.terminals.some((t) => t.id === id)) continue;
      joins.delete(id);
      st.moveToWorkspace(`t:${id}`, j.place, { quiet: true });
    }
  };
  const later = () => { if (!queued) { queued = true; setTimeout(apply, 0); } };
  const off = window.atelier.on.remoteRows((e: RemoteRowsEvent) => {
    const st = useApp.getState();
    if (st.popout || !st.project) return;
    if (e.kind === 'join') { joins.set(e.id, { place: e.place, at: Date.now() }); later(); }
    else if (e.kind === 'resuming') st.phoneResuming(e.id);
    else st.phoneResumed(e.from, e.to);
  });
  const offList = useApp.subscribe((s, prev) => { if (joins.size && s.terminals !== prev.terminals) later(); });
  return () => { off(); offList(); };
}
