// Restart Session from the menus, the palette and the menu bar.
import { useApp } from './store';
import { t } from './i18n/en';
import { panelAvailability } from './session-panel';

/**
 * The restart, asked in the sidebar row when background work would stop (the Sessions view shown for it); armed, a
 * toast says it waits for Claude (the row's chip says it too).
 */
export function restartFromMenu(id: string): void {
  const st = useApp.getState();
  const was = st.restarts[id];
  st.restartSession(id, 'row');
  const now = useApp.getState();
  if (now.restartAsk?.id === id) { st.setActivity('sessions'); st.select(id); return; }
  if (was || !now.restarts[id]?.armed) return;
  // What it waits for: a draft in Claude's prompt is the user's to send or clear (or one Atelier can't rule out).
  const term = now.terminals.find((x) => x.id === id);
  st.showToast(panelAvailability(term) === 'draft' ? t.restart.armedDraft : t.restart.armedToast, undefined, 'info');
}

/** File › Restart Session: the selected Claude session, else the last one selected; none: it says so. */
export function restartSelected(): void {
  const st = useApp.getState();
  const isSession = (id: string | null) => !!id && st.terminals.some((x) => x.id === id && x.session);
  const id = isSession(st.selectedId) ? st.selectedId : isSession(st.lastSession) ? st.lastSession : null;
  if (id) restartFromMenu(id); else st.showToast(t.panel.noSession);
}
