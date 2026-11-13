import { useEffect, useRef, useState, type DragEvent, type MouseEvent, type ReactNode } from 'react';
import { useApp } from '../store';
import { t } from '../i18n/en';
import { Icon } from './Icon';
import { WorkspaceGlyph } from './WorkspaceGlyph';
import { RenameInput } from './RenameInput';
import { workspaceMenu } from '../workspace-menus';
import { headDot, rowClickAction, wsColorVar, type WsCard } from '../workspace-view';
import { memberOf, type Workspace } from '../workspaces';
import { kbd } from '../kbd';
import { openBelow, sessionPlusMenu } from '../menus';
import { ACT_MIME, ROW_MIME, fromType, placeDrop, type PlaceTarget } from '../place-drop';

/**
 * Its own rows' zone in an open workspace that has activities: rows (and tabs from the strip) dropped there join its
 * own tabs, as on its head; while its own tabs are in front it takes nothing from the strip.
 */
export function WsOwnRows({ wsId, atOwn, children }: { wsId: string; atOwn: boolean; children: ReactNode }) {
  const { dropping, handlers } = usePlaceDrop({ id: wsId, kind: 'own' });
  return (
    <div className={`ws-own${dropping ? ' is-drop' : ''}`} {...(atOwn ? {} : { 'data-ws-drop': wsId })} {...handlers}>{children}</div>
  );
}

/**
 * A sidebar drop target (a workspace's head, its own rows, an activity): the drop state while a row, an activity's
 * head or a tab from the strip is over it, and the handlers that move what is dropped there.
 */
export function usePlaceDrop(target: PlaceTarget): { dropping: boolean; handlers: { onDragOver: (e: DragEvent) => void; onDragLeave: (e: DragEvent) => void; onDrop: (e: DragEvent) => void } } {
  const tab = useApp((s) => s.tabDragTarget?.kind === 'workspace' && s.tabDragTarget.id === target.id);
  const [over, setOver] = useState(false);
  const onDragOver = (e: DragEvent) => {
    if (!placeDrop(Array.from(e.dataTransfer.types), target)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (!over) setOver(true);
  };
  // Moving from the target onto one of its buttons is no leaving: the hint would flicker as they come and go.
  const onDragLeave = (e: DragEvent) => {
    if (e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget)) return;
    setOver(false);
  };
  const onDrop = (e: DragEvent) => {
    setOver(false);
    const what = placeDrop(Array.from(e.dataTransfer.types), target);
    if (!what) return;
    e.preventDefault();
    e.stopPropagation();
    const st = useApp.getState();
    if (what === 'activity') st.moveWsActivity(e.dataTransfer.getData(ACT_MIME), target.id);
    else { const id = e.dataTransfer.getData(ROW_MIME); if (id) st.moveToWorkspace(`t:${id}`, target.id); }
  };
  return { dropping: tab || over, handlers: { onDragOver, onDragLeave, onDrop } };
}

/** Props that make a sidebar row draggable onto a workspace's head; none while workspaces are off (rows behave as today). */
export function useRowDrag(id: string): { draggable?: true; onDragStart?: (e: DragEvent) => void } {
  const on = useApp((s) => !!s.ws?.on && !s.popout);
  if (!on) return {};
  return {
    draggable: true,
    onDragStart: (e) => {
      e.dataTransfer.setData(ROW_MIME, id);
      const ws = useApp.getState().ws;
      if (ws) e.dataTransfer.setData(fromType(memberOf(ws, id)), '');
      e.dataTransfer.effectAllowed = 'move';
    }
  };
}

/** How long a click on a row of another workspace waits for a second click (a double-click renames it there). */
export const DOUBLE_CLICK_MS = 220;

/**
 * A sidebar row's click and double-click. On a row of a workspace not in front (open in the sidebar) the click waits a
 * double-click's time before going there, so a double-click renames it in place without
 * switching; the keyboard's click (detail 0) goes at once. ⌥-click opens it to the side, as anywhere.
 */
export function useRowClick(id: string, select: (id: string) => void, rename: () => void): { onClick: (e: React.MouseEvent) => void; onDoubleClick: () => void } {
  const away = useApp((s) => !!s.ws?.on && !s.popout && memberOf(s.ws, id) !== s.ws.active);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  return {
    onClick: (e) => {
      const what = rowClickAction(away, e.detail, e.altKey);
      if (what === 'side') useApp.getState().openToSide(`t:${id}`);
      else if (what === 'now') select(id);
      else if (what === 'wait') {
        clearTimeout(timer.current);
        timer.current = setTimeout(() => select(id), DOUBLE_CLICK_MS);
      }
    },
    onDoubleClick: () => { clearTimeout(timer.current); rename(); }
  };
}

const menuAt = (id: string) => (e: React.MouseEvent) => useApp.getState().openMenu(e, workspaceMenu(id));

/**
 * A workspace in the sidebar: a quiet head — chevron, glyph, name, the folded state's dot, "+" —
 * and, open, its rows indented under a guide. The chevron folds or opens without switching (peek); the name brings
 * another workspace's own tabs to the front, and from one of its activities its own tabs (at its own tabs it folds).
 * Rows and tabs dropped on its head move into its own tabs, unless they are in front.
 * `active`: one of its places is in front; `inAct`: that place is one of its activities.
 */
export function WorkspaceGroup({ w, active, inAct = false, open, card, children }: { w: Workspace; active: boolean; inAct?: boolean; open: boolean; card: WsCard; children: ReactNode }) {
  const atOwn = active && !inAct;
  const { dropping, handlers } = usePlaceDrop({ id: w.id, kind: 'workspace' });
  const editing = useApp((s) => s.wsRenaming === w.id);
  const st = useApp.getState;
  const toggle = () => st().toggleWorkspaceOpen(w.id);
  // The Sessions drop-down: either way the session starts in this workspace.
  const here = (run: () => void) => () => { if (w.id !== st().ws?.active) st().switchWorkspace(w.id); run(); };
  const plus = (e: MouseEvent<HTMLButtonElement>) => openBelow(e.currentTarget, sessionPlusMenu({
    session: here(() => st().setNewSessionOpen(true)),
    folder: here(() => st().setFolderSheet({ kind: 'session' }))
  }));
  const dot = open ? null : headDot(card.dots);
  const stopRename = () => st().setWsRenaming(null);
  const name = (
    <>
      <WorkspaceGlyph color={w.color} />
      {editing
        ? <RenameInput value={w.name} onCommit={(v) => { stopRename(); st().renameWorkspace(w.id, v); }} onCancel={stopRename} />
        : <span className="ws-name">{w.name}</span>}
      {!editing && card.folder && <span className="ws-folder mono" data-tip={w.folder ?? undefined}>{card.folder}</span>}
    </>
  );
  return (
    <section className={`ws-group${active ? ' is-active' : ''}${open ? ' is-open' : ''}${inAct ? ' in-act' : ''}`} aria-label={w.name} data-ws-group={w.id}
      {...(active ? { 'data-ws-active': w.id } : {})} style={{ '--ws-c': wsColorVar(w.color) } as React.CSSProperties}>
      {/* Shift+F10 on its buttons opens this menu too (App's handler sends a contextmenu that bubbles here). */}
      <div className={`ws-head${dropping ? ' is-drop' : ''}`} {...(atOwn ? {} : { 'data-ws-drop': w.id })}
        onContextMenu={menuAt(w.id)} {...handlers}>
        <button type="button" className="ws-chev" aria-expanded={open} aria-label={`${open ? t.ws.hideRows : t.ws.showRows} · ${w.name}`}
          data-tip={open ? t.ws.hideRows : t.ws.showRows} onClick={toggle}>
          <Icon name={open ? 'chevronDown' : 'chevron'} size={13} stroke={2} />
        </button>
        {editing
          ? <div className="ws-name-btn">{name}</div>
          : (
            <button type="button" className="ws-name-btn" aria-label={atOwn ? w.name : inAct ? t.wsAct.ownTabs(w.name) : t.ws.switchTo(card.label)}
              data-tip={atOwn ? undefined : inAct ? t.wsAct.ownTabs(w.name) : card.label}
              {...(atOwn ? { 'aria-expanded': open } : {})} onClick={atOwn ? toggle : () => st().switchWorkspace(w.id)}>
              {name}
            </button>
          )}
        {dot && !dropping && (
          <span className={`ws-dot is-${dot.kind}`} data-tip={card.label} aria-hidden="true"><i /></span>
        )}
        {!dropping && (
          <button type="button" className="icon-btn ws-plus" aria-label={t.ws.newSessionIn(w.name)} data-tip={t.ws.newSessionIn(w.name)}
            aria-haspopup="menu" {...(atOwn ? { 'data-kbd': kbd('⌘N') } : {})} onClick={plus}><Icon name="plus" size={13} /></button>
        )}
        {dropping && <span className="ws-drop-hint" aria-hidden="true">{t.ws.dropHere(w.name)}</span>}
      </div>
      {open && <div className="ws-body">{children}</div>}
    </section>
  );
}
