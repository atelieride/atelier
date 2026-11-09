// Context usage's ways in and out: open the sheet for a session (the Session
// panel's tile, the session menus, the palette, the menu bar), and the session commands it types.
import type { ContextErrorKind, ContextReport } from '@shared/context-usage';
import type { TerminalInfo } from '@shared/protocol';
import { t } from './i18n/en';
import { useApp, type AppState } from './store';
import { compactSession, typeCommand } from './session-panel';

/** Shows the session first (as the Session panel does), then its Context sheet; a terminal without Claude has none. */
export function openContextSheet(id: string): void {
  const st = useApp.getState();
  if (!st.terminals.some((x) => x.id === id && x.session)) return;
  st.setActivity('sessions');
  st.select(id);
  setTimeout(() => useApp.getState().setContextSheet(id), 0);
}

/** File › Context Usage…: the selected Claude session, else the last one selected; none: it says so. */
export function openSelectedContextSheet(): void {
  const st = useApp.getState();
  const isSession = (id: string | null) => !!id && st.terminals.some((x) => x.id === id && x.session);
  const id = isSession(st.selectedId) ? st.selectedId : isSession(st.lastSession) ? st.lastSession : null;
  if (id) openContextSheet(id); else st.showToast(t.panel.noSession);
}

/** The terminal's last report, while it still runs the session it was made of. */
export function contextReportOf(st: Pick<AppState, 'contextReports'>, term: Pick<TerminalInfo, 'id' | 'session'>): ContextReport | null {
  const r = st.contextReports[term.id];
  return r && term.session && r.sessionId === term.session.sessionId ? r.report : null;
}

/** The newest analysis asked per terminal: an older one's answer (main stopped it for the newer) is dropped. */
const latest = new Map<string, number>();

/**
 * Asks main to analyse the terminal's session; the report goes to the store under the session it was asked
 * for. Only the newest request of a terminal reports back.
 */
export function analyzeContext(terminalId: string, sessionId: string, on: { done(r: ContextReport): void; failed(kind: ContextErrorKind, message: string): void }): void {
  const id = (latest.get(terminalId) ?? 0) + 1;
  latest.set(terminalId, id);
  const mine = () => latest.get(terminalId) === id;
  window.atelier.claude.contextUsage(terminalId).then((r) => {
    if (!mine()) return;
    if (r.ok) { useApp.getState().setContextReport(terminalId, sessionId, r.report); on.done(r.report); } else on.failed(r.kind, r.message);
  }, (err: unknown) => { if (mine()) on.failed('exit', err instanceof Error ? err.message : String(err)); });
}

/** The session's own /context, typed when Claude is at its prompt; the sheet closes on the terminal. */
export function runContextCommand(id: string): boolean {
  const ok = typeCommand(id, '/context');
  if (ok) useApp.getState().setContextSheet(null);
  return ok;
}

/** The Messages detail's Compact: the Session panel's own, then the sheet closes on the terminal. */
export function compactFromContext(id: string): boolean {
  const ok = compactSession(id);
  if (ok) useApp.getState().setContextSheet(null);
  return ok;
}
