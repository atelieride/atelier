// A table tab's view: the table (TableView: toolbar, rows loaded as you scroll, footer) or the
// connection's overview (OverviewView; its ✦ Ask Claude is actions.ts's), in a pane or a pop-out. A
// connection this window doesn't show — another project's, or removed since — is said so in its place: the tab never
// breaks (a restore drops such tabs once main's first snapshot is in). Lazy, with the view's stylesheet;
// production's 2 px top hairline is databases.css's `.db-tab.is-prod`.
import '../databases.css';
import type { CSSProperties } from 'react';
import { Icon } from '../components/Icon';
import { t } from '../i18n/en';
import { tdt } from '../i18n/db-table';
import { overviewActions } from './actions';
import { OverviewView } from './OverviewView';
import { useDb } from './store';
import { TableView } from './TableView';
import { dbTabTip, type DbTabRef } from './tabs';

/** focused / place: as the other views' (split view: only the focused pane's tab takes the keyboard; its grid cell). */
export function DbTabView({ tab, visible, focused = visible, place }: { tab: DbTabRef; visible: boolean; focused?: boolean; place?: CSSProperties }) {
  const conn = useDb((s) => s.snap.connections.find((v) => v.conn.id === tab.connId)?.conn ?? null);
  // Before main's first snapshot nothing is known yet: never "isn't available" for a connection about to arrive.
  const missing = useDb((s) => s.loaded) && conn === null;
  const what = tab.kind === 'overview' ? t.db.tab.overview : `${tab.schema}.${tab.name}`;
  return (
    <section className={`dk-view db-tab${conn?.env === 'prod' ? ' is-prod' : ''}${missing ? ' is-missing' : ''}`} style={{ display: visible ? 'flex' : 'none', ...place }}
      aria-label={dbTabTip(tab, () => conn?.name ?? '')}>
      {missing ? (
        <div className="dk-center">
          <div className="dk-state">
            <span className="dk-state-icon" aria-hidden="true"><Icon name="databases" size={24} /></span>
            <h2 className="dk-state-title">{tdt.unavailable}</h2>
            <p className="dk-state-hint">{tdt.unavailableBody}</p>
            <p className="db-tab-sub"><span className="mono">{what}</span></p>
          </div>
        </div>
      ) : tab.kind === 'overview' ? <OverviewView tab={tab} conn={conn} visible={visible} focused={focused} actions={overviewActions(tab.connId)} />
        : <TableView tab={tab} conn={conn} visible={visible} focused={focused} />}
    </section>
  );
}
