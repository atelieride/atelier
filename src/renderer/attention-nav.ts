import type { TerminalInfo } from '@shared/protocol';
import type { TabKey } from './tabs-model';
import { useApp } from './store';
import { t } from './i18n/en';
import { isLimitPaused, waitKind } from '@shared/session-view';
import { effectiveState } from '@shared/background';
import { memberOf, union, workspaceOf, type WorkspacesState } from './workspaces';

// A permission request blocks the work outright: it comes before a question (or an unspecified wait, older atelierd).
const permission = (x: TerminalInfo) => waitKind(x.session) === 'permission';
const waiting = (x: TerminalInfo) => waitKind(x.session) !== null;
// Finished (not while it still works in the background) or stopped by an error, and not yet seen. Paused at a usage
// limit is no error to jump to: Claude Code goes on by itself.
const unreadDone = (x: TerminalInfo) => { const st = effectiveState(x); return (st === 'done' || st === 'error') && !!x.session?.unread && !isLimitPaused(x.session); };

/**
 * ⌘J: the next session that needs attention, in tab order starting from the one after the current.
 * First whoever waits for a permission, then for an answer; if none is, whoever finished and you haven't looked at yet.
 * Terminals whose tab is closed (still running, in the sidebar) come after the tabs, in list order. null if none.
 */
export function nextAttention(list: TerminalInfo[], order: TabKey[], currentId: string | null): string | null {
  const byId = new Map(list.map((x) => [x.id, x]));
  const tabbed = order.filter((k) => k.startsWith('t:')).map((k) => k.slice(2)).filter((id) => byId.has(id));
  const inTabs = new Set(tabbed);
  const ids = [...tabbed, ...list.map((x) => x.id).filter((id) => !inTabs.has(id))];
  const start = currentId ? ids.indexOf(currentId) : -1;
  const ring = [...ids.slice(start + 1), ...ids.slice(0, start + 1)];
  // The current session comes last: ⌘J must go elsewhere if there is something else to see.
  const others = ring.filter((id) => id !== currentId);
  for (const want of [permission, waiting, unreadDone]) {
    const hit = others.find((id) => want(byId.get(id)!));
    if (hit) return hit;
  }
  return currentId && byId.has(currentId) && (waiting(byId.get(currentId)!) || unreadDone(byId.get(currentId)!)) ? currentId : null;
}

/**
 * The sessions ⌘J may go to: with workspaces on (`ws`) and "follows" off, only those of the workspace in front — its
 * own and its activities'; otherwise every one.
 */
export function attentionReach(ws: WorkspacesState | null, list: TerminalInfo[], follows: boolean): TerminalInfo[] {
  if (!ws || follows) return list;
  const here = workspaceOf(ws, ws.active);
  return list.filter((x) => workspaceOf(ws, memberOf(ws, x.id)) === here);
}

/** ⌘J, the footer and the palette: go to the next session that needs attention, or say so if there is none. */
export function goToAttention(): void {
  const st = useApp.getState();
  // Workspaces on: every place's tabs in the sidebar's order, the one in front's as shown; with
  // "follows" off, only the workspace in front's sessions. Selecting one elsewhere brings its place forward.
  const ws = st.ws?.on && !st.popout ? st.ws : null;
  const list = attentionReach(ws, st.terminals, st.settings.wsJumpFollows);
  const order = ws ? union(ws, st.tabOrder) : st.tabOrder;
  const id = nextAttention(list, order, st.activeTab === 'term' ? st.selectedId : null);
  if (!id) { st.showToast(t.nothingNeedsYou, undefined, 'info'); return; }
  st.setActivity('sessions', { keepHidden: true });
  st.select(id);
}

/** The session shown right now that has just finished: it must be marked as seen (null if there is none or you aren't looking at it). */
export function seenNow(list: TerminalInfo[], selectedId: string | null, activeTab: string, focused: boolean, covered = false): string | null {
  // With Settings or the palette over the terminal you aren't really looking at it.
  if (!focused || covered || activeTab !== 'term' || !selectedId) return null;
  const cur = list.find((x) => x.id === selectedId);
  return cur?.session?.unread ? cur.id : null;
}
