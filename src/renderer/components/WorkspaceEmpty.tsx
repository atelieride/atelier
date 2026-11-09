import { useApp } from '../store';
import { t } from '../i18n/en';
import { kbd } from '../kbd';
import { inWorkspace, resumablesIn } from '../workspace-view';
import { pinnedFirst } from '../pins';
import { Icon } from './Icon';
import { WorkspaceGlyph } from './WorkspaceGlyph';

/**
 * A workspace with nothing in front: its name, the session it can resume (Enter), New Session
 * and New Terminal, which open in it.
 */
export function WorkspaceEmpty({ onSession, onTerminal }: { onSession: () => void; onTerminal: () => void }) {
  const ws = useApp((s) => s.ws);
  const root = useApp((s) => s.project?.root ?? '');
  const pins = useApp((s) => s.pins);
  const resumables = useApp((s) => s.resumables);
  const terminals = useApp((s) => s.terminals);
  const w = ws?.list.find((x) => x.id === ws.active);
  if (!ws || !w) return null;
  const next = pinnedFirst(resumablesIn(ws, w.id, resumables, root), pins)[0];
  // Its sessions or terminals still run, with their tabs closed or in windows of their own: not "nothing running".
  const running = inWorkspace(ws, w.id, terminals).length > 0;
  return (
    <div className="workspace-empty">
      <div className="ws-empty-card pop">
        <WorkspaceGlyph color={w.color} size={48} />
        <h2>{running ? t.ws.noTabsTitle(w.name) : t.ws.emptyTitle(w.name)}</h2>
        <p>{running ? t.ws.noTabsBody : next ? t.ws.emptyResume(next.title) : t.ws.emptyBody}</p>
        <div className="ws-empty-actions">
          {next && (
            <button type="button" className="btn-primary btn-lg" autoFocus onClick={() => void useApp.getState().resume(next.id)}>
              <Icon name="resume" size={14} />{t.ws.resumeName(next.title)}<span className="kbd-in">↵</span>
            </button>
          )}
          <button type="button" className={`${next ? 'btn-ghost' : 'btn-primary'} btn-lg`} onClick={onSession}><Icon name="sparkle" size={14} />{t.startSession}<span className="kbd-in">{kbd('⌘N')}</span></button>
          <button type="button" className="btn-ghost btn-lg" onClick={onTerminal}><Icon name="terminal" size={14} />{t.openTerminal}<span className="kbd-in">{kbd('⌘T')}</span></button>
        </div>
      </div>
    </div>
  );
}
