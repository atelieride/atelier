// Close Workspace…: asked in place, under the workspace's card or head. Enter moves its
// sessions and terminals to the workspace above (the default never stops anything); Stop them stops them resumable.
import { useApp } from '../store';
import { t } from '../i18n/en';
import { ConfirmPopover } from './ConfirmPopover';
import { cardOf } from '../workspace-view';
import { activitiesOf, workspacesOf } from '../workspaces';

export function WorkspaceCloseHost() {
  const id = useApp((s) => s.wsCloseAsk);
  const ws = useApp((s) => s.ws);
  const terminals = useApp((s) => s.terminals);
  const resumables = useApp((s) => s.resumables);
  const root = useApp((s) => s.project?.root ?? '');
  const openFiles = useApp((s) => s.openFiles);
  // Its files at a commit close with it too (the body says so); tables are Databases', never a workspace's.
  const revFiles = useApp((s) => s.revFiles);
  // Without atelierd's kill-resumable, stopped sessions don't come back under Resume: the button says so.
  const resumable = useApp((s) => s.daemon.closeStopAvailable !== false);
  // Its sessions and terminals move into a workspace (the one above, below for the first), never into an activity.
  const wss = ws ? workspacesOf(ws) : [];
  const i = id ? wss.findIndex((w) => w.id === id) : -1;
  if (!ws || !id || i === -1 || wss.length <= 1) return null;
  const w = wss[i]!;
  const target = wss[i === 0 ? 1 : i - 1]!;
  const acts = activitiesOf(ws, id).length;
  // The one in front: its live tabs, not its saved entry (which lags while it is in front).
  const card = cardOf(useApp.getState().workspacesNow() ?? ws, id, terminals, resumables, root, openFiles.map((f) => f.path), revFiles.map((f) => f.key));
  const cancel = () => useApp.getState().setWsCloseAsk(null);
  const answer = (how: 'move' | 'stop') => { cancel(); void useApp.getState().closeWorkspace(id, how); };
  const title = t.ws.closeTitle(w.name);
  const running = card.sessions + card.terminals;
  return (
    <ConfirmPopover key={id} anchor={`[data-ws-group="${CSS.escape(id)}"] .ws-head`} align="start" label={title} onCancel={cancel}>
      <div className="confirm-pop-text">
        <b>{title}</b>
        <span className="ws-close-body">{t.ws.closeBody(card.sessions, card.terminals, card.files, card.tabs)}</span>
        {acts > 0 && <span className="ws-close-body">{t.wsAct.closeWsActs(acts, target.name)}</span>}
        {!resumable && card.sessions > 0 && <span className="ws-close-body">{t.ws.stopNoResume}</span>}
      </div>
      <div className="ws-close-actions">
        {running > 0 && <button type="button" className="btn-primary sm" data-autofocus onClick={() => answer('move')}>{t.ws.moveThemTo(target.name)}<span className="confirm-key mono">↵</span></button>}
        {running > 0 && <button type="button" className="btn-ghost sm" onClick={() => answer('stop')}>{resumable ? t.ws.stopThem : t.ws.stopForGood}</button>}
        {running === 0 && <button type="button" className="btn-danger sm" data-autofocus onClick={() => answer('move')}>{t.ws.closeIt}<span className="confirm-key mono">↵</span></button>}
        <button type="button" className="btn-ghost sm" onClick={cancel}>{t.confirm.cancel}<span className="confirm-key mono">{t.confirm.esc}</span></button>
      </div>
    </ConfirmPopover>
  );
}
