// Moving a file, a plain terminal or a table tab to another project's window: what may move, the menus' "Move to Window
// ›", the move from here (the buffer along, the tab gone
// once the other window said yes) and a tab arriving from elsewhere (adopted, or refused when this window has that file
// with no way to merge two buffers). Types only from @shared/popout: it is backend-only for the demo bundle.
import type { DbScope } from '@shared/databases';
import type { AdoptRequest, MoveResult, ProjectWindowInfo } from '@shared/popout';
import { useDb } from './databases/store';
import { parseDbTabKey } from './databases/tabs';
import { t } from './i18n/en';
import type { MenuItem } from './menu-model';
import { dockTargetAt } from './dock-target';
import { tabMove } from './popout-move';
import { isStarting } from './starting';
import { useApp, type AppState } from './store';
import type { TabKey } from './tabs-model';
import { isUntitled } from './untitled';

const st = () => useApp.getState();
const isAbs = (p: string) => p.startsWith('/') || /^[A-Za-z]:[\\/]/.test(p);

/**
 * A file on disk (never an untitled buffer), a terminal with no Claude session in it (nor one starting), or a table tab
 * of a connection this window shows (where it may go: refusedFor).
 */
export function canMoveToWindow(s: Pick<AppState, 'terminals' | 'starting'>, key: TabKey): boolean {
  if (key.startsWith('f:')) { const p = key.slice(2); return !isUntitled(p) && isAbs(p); }
  if (key.startsWith('db:')) return dbScopeOf(key) !== null;
  if (!key.startsWith('t:')) return false;
  const term = s.terminals.find((x) => x.id === key.slice(2));
  return !!term && !term.session && !isStarting(term, s.starting);
}

/** A table tab's connection's projects, as this window's snapshot has it; null when it doesn't show that connection. */
function dbScopeOf(key: TabKey): DbScope | null {
  const p = parseDbTabKey(key);
  return p ? useDb.getState().snap.connections.find((v) => v.conn.id === p.connId)?.conn.scope ?? null : null;
}

/**
 * Why the tab can't go to that window, or null: a table of a connection of one project goes nowhere else (no
 * per-project grant list) — "This connection belongs to <project>", named as the menus
 * name its window.
 */
function refusedFor(key: TabKey, root: string): string | null {
  if (!key.startsWith('db:')) return null;
  const scope = dbScopeOf(key);
  if (!scope || scope.kind === 'all' || scope.root === root) return null;
  const s = st();
  const at = s.projectWindows.findIndex((w) => w.root === scope.root);
  const name = at >= 0 ? windowLabels(s.projectWindows)[at]! : s.project?.root === scope.root ? s.project.name : scope.root.replace(/[\\/]+$/, '').split(/[\\/]/).at(-1) ?? scope.root;
  return t.db.tab.belongsTo(name);
}

/** The windows' names in the menus: the folder's, with its parent when two open projects share it. */
export function windowLabels(list: readonly ProjectWindowInfo[]): string[] {
  return list.map((w) => {
    if (list.filter((x) => x.name === w.name).length < 2) return w.name;
    const parent = w.root.replace(/[\\/]+$/, '').split(/[\\/]/).at(-2) ?? '';
    return parent ? `${w.name} — ${parent}` : w.name;
  });
}

/** The other project windows this window may send a tab to. */
function targets(): { root: string; label: string }[] {
  const s = st();
  const labels = windowLabels(s.projectWindows);
  return s.projectWindows.map((w, i) => ({ root: w.root, label: labels[i]! })).filter((w) => w.root !== s.project?.root);
}

/** Move to Window › (tab, sidebar row, pop-out bar): the other project windows; none alone or for what can't move. */
export function moveToWindowItems(key: TabKey): MenuItem[] {
  const list = targets();
  if (!list.length || !canMoveToWindow(st(), key)) return [];
  return [{
    id: 'move-to-window', label: t.moveWin.menu, icon: 'window', run: () => {},
    submenu: list.map((w) => {
      const why = refusedFor(key, w.root);
      return { id: `move-to-window:${w.root}`, label: w.label, ...(why ? { disabled: true, tip: why } : {}), run: () => { if (!why) void moveToWindow(key, w.root); } };
    })
  }];
}

/** The palette's commands for the tab in front: Move Tab to “B”, one per other window that may take it. */
export function moveToWindowCommands(key: TabKey | null): { root: string; label: string }[] {
  return key && canMoveToWindow(st(), key) ? targets().filter((w) => refusedFor(key, w.root) === null).map((w) => ({ root: w.root, label: t.moveWin.command(w.label) })) : [];
}

/**
 * Sends the tab with its view and buffer (frozen until the answer). A file leaves once the other window took it; a
 * terminal leaves with the list main sends. In a pop-out main closes the window instead. No: a toast says why.
 */
export async function moveToWindow(key: TabKey, root: string): Promise<void> {
  const name = targets().find((w) => w.root === root)?.label ?? root;
  let r: MoveResult;
  try {
    r = await tabMove(st(), key, (req) => window.atelier.projectWindows.moveTab({ to: root, key, ...req }), (x) => !x.ok);
  } catch {
    r = { ok: false, reason: 'failed' };
  }
  // A file or a table leaves this window now; a terminal with the list main sends; a pop-out is closed by main.
  if (r.ok) { if (!st().popout && (key.startsWith('f:') || key.startsWith('db:'))) st().dropMovedTab(key); return; }
  st().showToast(r.reason === 'refused' ? t.moveWin.refused(fileName(key), name) : r.reason === 'session' ? t.moveWin.session : t.moveWin.failed);
}

const fileName = (key: TabKey) => key.slice(2).split(/[\\/]/).at(-1) ?? key.slice(2);
const lf = (s: string) => s.replace(/\r\n/g, '\n');

/**
 * A tab another window sends: open it here; this window shows that file already — its own comes forward, unless the
 * buffer coming has unsaved changes (two buffers of one file can't merge: refused, the sender keeps it).
 */
export function adoptDecision(s: Pick<AppState, 'popout' | 'project' | 'openFiles' | 'poppedOut'>, r: AdoptRequest): 'open' | 'own' | 'refuse' {
  if (s.popout || !s.project) return 'refuse';
  // A table tab this window has in a pop-out: that window comes forward, never a second tab here (it has no buffer to merge).
  if (r.key.startsWith('db:')) return s.poppedOut.includes(r.key as TabKey) ? 'own' : 'open';
  if (!r.key.startsWith('f:')) return 'open';
  const path = r.key.slice(2);
  if (!s.openFiles.some((f) => f.path === path) && !s.poppedOut.includes(r.key as TabKey)) return 'open';
  const h = r.handoff;
  const changed = !!h && (h.saved === null || lf(h.state.doc) !== lf(h.saved));
  return changed ? 'refuse' : 'own';
}

/** Takes (or refuses) a tab another window sends, and answers main. */
export function applyAdopt(r: AdoptRequest): void {
  const s = st();
  const answer = (ok: boolean, reason?: 'open-there') => void window.atelier.projectWindows.adopted({ id: r.id, ok, ...(reason ? { reason } : {}) }).catch(() => {});
  // Past its deadline the sender gave up and kept the tab: a second buffer of that file must never open here.
  if (Date.now() > r.deadline) { answer(false); return; }
  const decision = adoptDecision(s, r);
  if (decision === 'refuse') { answer(false, s.popout || !s.project ? undefined : 'open-there'); return; }
  const key = r.key as TabKey;
  // A terminal comes with the list main sent just before: one this window doesn't list never lands (main puts it back).
  if (key.startsWith('t:') && !s.terminals.some((x) => x.id === key.slice(2))) { answer(false); return; }
  const target = r.at ? dockTargetAt(r.at) : null;
  if (decision === 'own') {
    if (s.poppedOut.includes(key)) void window.atelier.popout.focus(key).catch(() => {});
    else s.applyDock({ key }, target);
  } else s.applyDock({ key: r.key, ...(r.payload ? { payload: r.payload } : {}), ...(r.handoff ? { handoff: r.handoff } : {}) }, target);
  answer(true);
}
