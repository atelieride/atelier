import { type DragEvent, type MouseEvent, type ReactNode } from 'react';
import { usePlaceDrop } from './WorkspaceGroup';
import { ACT_MIME, fromType } from '../place-drop';
import { useApp } from '../store';
import { t } from '../i18n/en';
import { Icon } from './Icon';
import { RenameInput } from './RenameInput';
import { headDot, wsColorVar, type WsActivityCard } from '../workspace-view';
import type { Workspace } from '../workspaces';
import { kbd } from '../kbd';
import { openBelow, sessionPlusMenu } from '../menus';
import { wsActivityMenu } from '../workspace-menus';
import { newTerminalIn } from '../launch';

/**
 * An activity in its workspace's body, at the same indent as the workspace's own rows: a head — chevron, glyph and
 * name, the folded state's dot, "+" — and, open, its rows on a neutral band, indented under its head. The chevron
 * folds or opens without switching; the name brings the activity forward and leaves it as it is in the sidebar. Folded
 * and in front, its head is the selected box: it stands for the tab in front.
 */
export function WsActivityGroup({ a, color, current, open, card, children }: { a: Workspace; color: number; current: boolean; open: boolean; card: WsActivityCard; children?: ReactNode }) {
  const editing = useApp((s) => s.wsRenaming === a.id);
  const st = useApp.getState;
  // Rows and tabs dropped on its head (or its band, open) move into it.
  const { dropping, handlers } = usePlaceDrop({ id: a.id, kind: 'activity' });
  // Its head dragged onto another workspace's head moves it there with everything in it.
  const drag = editing ? {} : {
    draggable: true as const,
    onDragStart: (e: DragEvent) => {
      e.dataTransfer.setData(ACT_MIME, a.id);
      if (a.parent) e.dataTransfer.setData(fromType(a.parent), '');
      e.dataTransfer.effectAllowed = 'move';
    }
  };
  const toggle = () => st().toggleWorkspaceOpen(a.id);
  // "+": the activity comes forward first, so what starts belongs to it.
  const here = (run: () => void) => () => { if (st().ws?.active !== a.id) st().switchWorkspace(a.id); run(); };
  const plus = (e: MouseEvent<HTMLButtonElement>) => openBelow(e.currentTarget, sessionPlusMenu({
    session: here(() => st().setNewSessionOpen(true)),
    folder: here(() => st().setFolderSheet({ kind: 'session' })),
    terminal: here(() => void newTerminalIn())
  }));
  const menu = (e: MouseEvent) => st().openMenu(e, wsActivityMenu(a.id));
  const dot = open ? null : headDot(card.dots);
  const stopRename = () => st().setWsRenaming(null);
  const glyph = <span className="wsa-glyph"><Icon name="wsActivity" size={15} stroke={1.5} /></span>;
  return (
    <section className={`wsa-group${open ? ' is-open' : ''}${current ? ' is-current' : ''}${dropping ? ' is-drop' : ''}`} aria-label={a.name} data-wsa-group={a.id}
      {...(current ? {} : { 'data-ws-drop': a.id })} style={{ '--ws-c': wsColorVar(color) } as React.CSSProperties} {...handlers}>
      {/* Shift+F10 on its buttons opens this menu too (App's handler sends a contextmenu that bubbles here). */}
      <div className={`wsa-head${current && !open ? ' is-selected' : ''}`} data-tip={card.label} onContextMenu={menu} {...drag}>
        <button type="button" className="ws-chev wsa-chev" aria-expanded={open} aria-label={open ? t.wsAct.hideRows(a.name) : t.wsAct.showRows(a.name)}
          data-tip={open ? t.wsAct.hideRows(a.name) : t.wsAct.showRows(a.name)} onClick={toggle}>
          <Icon name={open ? 'chevronDown' : 'chevron'} size={12} stroke={2} />
        </button>
        {editing
          ? (
            <div className="wsa-name-btn">
              {glyph}
              <RenameInput value={a.name} onCommit={(v) => { stopRename(); st().renameWorkspace(a.id, v); }} onCancel={stopRename} />
            </div>
          )
          : (
            <button type="button" className="wsa-name-btn" aria-label={current ? a.name : t.wsAct.showTabs(a.name)}
              {...(current ? { 'aria-current': 'location' as const } : {})} onClick={current ? undefined : () => st().switchWorkspace(a.id)}>
              {glyph}
              <span className="wsa-name">{a.name}</span>
            </button>
          )}
        {dot && !dropping && <span className={`ws-dot is-${dot.kind}`} data-tip={card.label} aria-hidden="true"><i /></span>}
        {!dropping && (
          <button type="button" className="icon-btn wsa-plus" aria-label={t.wsAct.newIn(a.name)} data-tip={t.wsAct.newIn(a.name)}
            aria-haspopup="menu" {...(current ? { 'data-kbd': kbd('⌘N') } : {})} onClick={plus}><Icon name="plus" size={12} /></button>
        )}
        {dropping && <span className="ws-drop-hint" aria-hidden="true">{t.ws.dropHere(a.name)}</span>}
      </div>
      {open && <div className="wsa-body">{children}</div>}
    </section>
  );
}
