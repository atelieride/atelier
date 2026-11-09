// A space with no tab: its icon, one line, one way to fill it. Closing a space's last
// tab never reopens anything by itself: this is what it shows then.
import { useApp } from '../store';
import { t } from '../i18n/en';
import type { OtherSpace } from '../spaces';
import { useDb } from '../databases/store';
import { newAutomation } from '../automations/actions';
import { Icon, type IconName } from './Icon';

const ICON: Record<OtherSpace, IconName> = { docker: 'whale', redis: 'redis', databases: 'databases', automations: 'automation' };

export function SpaceEmpty({ space }: { space: OtherSpace }) {
  const conns = useDb((s) => s.snap.connections.length);
  const copy = t.spaces.empty[space];
  const run = (): void => {
    const st = useApp.getState();
    if (space === 'docker') st.openDocker({ kind: 'overview' });
    else if (space === 'redis') st.openRedis('keys');
    else if (space === 'databases') useDb.getState().setSheet({ kind: 'add', step: 1 });
    else newAutomation();
  };
  // Databases with connections: the sidebar is the way (a table, a view, an overview), no button to compete with it.
  const hint = space === 'databases' && conns > 0 ? t.spaces.empty.databases.hint : null;
  return (
    <div className="workspace-empty space-empty" data-space={space}>
      <div className="ws-empty-card pop">
        <span className={`space-empty-mark is-${space}`} aria-hidden="true"><Icon name={ICON[space]} size={26} stroke={1.6} /></span>
        <h2>{copy.title}</h2>
        {hint ? <p>{hint}</p> : (
          <div className="ws-empty-actions">
            <button type="button" className="btn-primary btn-lg" onClick={run}><Icon name={space === 'automations' || space === 'databases' ? 'plus' : ICON[space]} size={14} />{copy.action}</button>
          </div>
        )}
      </div>
    </div>
  );
}
