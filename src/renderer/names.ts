// Session name sync: what the session title tells about the name it shows.
import type { TerminalInfo } from '@shared/protocol';
import { t } from './i18n/en';

/**
 * What a rename field's value means: undefined = nothing to do (left as shown: the title may be Claude's own name or a
 * label, which must not become a name handed to Claude), null = drop the given name, otherwise the new name.
 */
export function renameTo(term: TerminalInfo, value: string): string | null | undefined {
  const v = value.trim();
  if (v === term.title) return undefined;
  return v || null;
}

/** Commits a rename field (session bar, sidebar row, tab). */
export function commitRename(term: TerminalInfo, value: string): void {
  const name = renameTo(term, value);
  if (name !== undefined) void window.atelier.terminals.rename(term.id, name);
}

/** Where Claude stands on the name, when it isn't synced (the tab's tip says it; null when synced). */
export function syncTip(term: TerminalInfo): string | null {
  if (term.nameSync === 'pending') return t.namePending;
  if (term.nameSync === 'kept') return t.nameKept;
  return null;
}

/** The session title's tooltip (a split pane's or a pop-out's bar): "Rename", plus where Claude stands on the name. */
export function titleTip(term: TerminalInfo): string {
  const sync = syncTip(term);
  return sync ? `${t.rename} · ${sync}` : t.rename;
}

/**
 * A name's tooltip (sidebar row, tab, pane header): led by the full name, which an ellipsis may cut, then on its own
 * line what the element says besides (state, folder). The Tooltip renders the first line as the heading.
 */
export function nameTip(name: string, detail?: string | null): string | undefined {
  if (!name) return detail || undefined;
  return detail ? `${name}\n${detail}` : name;
}
