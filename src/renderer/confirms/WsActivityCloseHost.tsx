// Close Activity…: asked in place, under the activity's head (centered at the top when the head isn't on screen).
// Enter moves what is inside back to its workspace (the default never stops anything); Stop them stops its terminals
// resumable and closes its file tabs.
import { useApp } from '../store';
import { t } from '../i18n/en';
import { ConfirmPopover } from './ConfirmPopover';
import { inWorkspace, wsActivityCloseText } from '../workspace-view';

export function WsActivityCloseHost() {
  const id = useApp((s) => s.wsActCloseAsk);
  const ws = useApp((s) => s.ws);
  const terminals = useApp((s) => s.terminals);
  const resumables = useApp((s) => s.resumables);
  const root = useApp((s) => s.project?.root ?? '');
  const openFiles = useApp((s) => s.openFiles);
  const revFiles = useApp((s) => s.revFiles);
  // Without atelierd's kill-resumable, stopped sessions don't come back under Resume: the button says so.
  const resumable = useApp((s) => s.daemon.closeStopAvailable !== false);
  const a = ws && id ? ws.list.find((w) => w.id === id) : undefined;
  const parent = a?.parent ? ws?.list.find((w) => w.id === a.parent) : undefined;
  if (!ws || !id || !a || !parent) return null;
  // The one in front: its live tabs, not its saved entry (which lags while it is in front).
  const text = wsActivityCloseText(useApp.getState().workspacesNow() ?? ws, id, terminals, resumables, root, openFiles.map((f) => f.path), revFiles.map((f) => f.key));
  // Only sessions wait under Resume: without one inside, nothing to say about an atelierd that can't keep them.
  const hasSession = inWorkspace(ws, id, terminals).some((x) => !!x.session);
  const cancel = () => useApp.getState().setWsActCloseAsk(null);
  const answer = (how: 'move' | 'stop') => { cancel(); void useApp.getState().closeWsActivity(id, how); };
  const title = t.wsAct.closeTitle(a.name);
  return (
    <ConfirmPopover key={id} anchor={`[data-wsa-group="${CSS.escape(id)}"] .wsa-head`} align="start" label={title} onCancel={cancel}>
      <div className="confirm-pop-text">
        <b>{title}</b>
        {text && <span className="ws-close-body">{text}</span>}
        <span className="ws-close-body">{t.wsAct.closeExplain(parent.name)}</span>
        {!resumable && hasSession && <span className="ws-close-body">{t.ws.stopNoResume}</span>}
      </div>
      <div className="ws-close-actions">
        <button type="button" className="btn-primary sm" data-autofocus onClick={() => answer('move')}>{t.ws.moveThemTo(parent.name)}<span className="confirm-key mono">↵</span></button>
        <button type="button" className="btn-ghost sm" onClick={() => answer('stop')}>{resumable ? t.ws.stopThem : t.ws.stopForGood}</button>
        <button type="button" className="btn-ghost sm" onClick={cancel}>{t.confirm.cancel}<span className="confirm-key mono">{t.confirm.esc}</span></button>
      </div>
    </ConfirmPopover>
  );
}
