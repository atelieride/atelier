import type { TerminalInfo } from '@shared/protocol';
import { t } from './i18n/en';
import { useApp } from './store';

/** Whose background View › Background shows: the selected session, else one with background work, else the first. */
export function backgroundTarget(terminals: TerminalInfo[], selectedId: string | null): string | null {
  const sessions = terminals.filter((x) => x.session);
  return sessions.find((x) => x.id === selectedId)?.id ?? sessions.find((x) => (x.work?.entries.length ?? 0) > 0)?.id ?? sessions[0]?.id ?? null;
}

/** View › Background and its palette command: open the Background tab for the right session (the store pins the first item). */
export function showBackground(): void {
  const st = useApp.getState();
  const id = backgroundTarget(st.terminals, st.selectedId);
  if (id) st.openBackground({ terminalId: id });
  else st.showToast(t.bg.noSession, undefined, 'info');
}
