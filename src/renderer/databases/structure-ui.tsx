// What Structure and Relations share: a table link — a node of
// the diagram, an FK's target in the Columns table —, a part's failure in its place, a first read's quiet bars. Lazy,
// with the table's chunk; styles in structure.css (the views import it).
import type { KeyboardEvent, MouseEvent } from 'react';
import type { DbProblem, DbRel } from '@shared/databases';
import { Icon } from '../components/Icon';
import { tdt } from '../i18n/db-table';
import { useApp } from '../store';
import type { TabKey } from '../tabs-model';
import { openRel, relMenu } from './menus';
import { dbTabKey } from './tabs';

/** How long a link's click waits for its second (a double click), at most. */
const DOUBLE_MS = 500;
/** The table a link's click just opened as the preview, and until when its double click may come. */
let opened: { key: TabKey; until: number } | null = null;

/**
 * A press on the table tab `key` (TableView's capture handlers, on its own element): the second of a double click begun
 * on a link. Its first click opened this preview over the tab hosting the link, so the second lands here, never on the
 * link (the e2e: the link's own double click could not be reached). That double click keeps the table, and what lies
 * under the pointer (a row, a toolbar button) never takes its presses. True when the press was one (taken).
 */
export function linkDouble(key: TabKey, e: { type: string; detail: number; preventDefault(): void; stopPropagation(): void }): boolean {
  if (!opened || opened.key !== key || e.detail < 2 || Date.now() > opened.until) return false;
  e.preventDefault();
  e.stopPropagation();
  if (e.type === 'dblclick') {
    opened = null;
    useApp.getState().keepDbTab(key);
  }
  return true;
}

/**
 * What a table link does: a click opens the preview (⌥-click: to the side), a double click or Enter a kept tab, Space
 * (the button's own click) the preview, a right-click the table's menu. Buttons, so they take Tab; no listener outside
 * them (the opened table's own element hears a double click's second press: linkDouble). The tab hosting the link is
 * never the preview it replaces: a view switch kept it.
 */
export function tableLink(connId: string, target: { schema: string; name: string }) {
  // A foreign key always points at a table (a partitioned one is a table too).
  const r: DbRel = { schema: target.schema, name: target.name, kind: 'table', estimate: null };
  return {
    onClick: (e: MouseEvent) => {
      if (e.altKey) { openRel(connId, r, { preview: false, side: true }); return; }
      openRel(connId, r, { preview: true });
      // A pointer's click (Space and Enter come with no detail): its second press may follow, on the table it opened.
      opened = e.detail === 1 ? { key: dbTabKey(connId, r.schema, r.name), until: Date.now() + DOUBLE_MS } : null;
    },
    onDoubleClick: () => openRel(connId, r, { preview: false }),
    onKeyDown: (e: KeyboardEvent) => { if (e.key === 'Enter') { e.preventDefault(); openRel(connId, r, { preview: false }); } },
    onContextMenu: (e: MouseEvent) => useApp.getState().openMenu(e, relMenu(connId, r))
  };
}

/** A part's failure in its place: what failed, Postgres's words in the tooltip, Retry unless the role can't read. */
export function PartFailed({ title, p, onRetry }: { title: string; p: DbProblem; onRetry: () => void }) {
  return (
    <div className="dbs-err" role="alert">
      <Icon name="warning" size={12} />
      <span className="dbs-err-t" data-tip={p.code ? `${p.message}\nSQLSTATE ${p.code}` : p.message}>{`${title} · ${p.message}`}</span>
      {p.kind !== 'denied' && <button type="button" className="dbt-link" onClick={onRetry}>{tdt.struct.retry}</button>}
    </div>
  );
}

/** A first read: quiet bars in the part's place (no spinner: the place keeps its size). */
export function Skeleton({ rows = 4, className = '' }: { rows?: number; className?: string }) {
  return <div className={`dbs-skel${className}`} aria-hidden="true">{Array.from({ length: rows }, (_, i) => <span key={i} style={{ animationDelay: `${(i % 4) * 90}ms` }} />)}</div>;
}
