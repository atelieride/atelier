// The Databases sidebar: the head with the number of connections, Refresh and
// Add Connection; the connections ("This project" / "Every project"), the picked connection's catalog; the read-only line
// at the bottom. None saved: how to add one. Loaded with its own chunk and
// stylesheet (the live demo's first paint).
import '../databases.css';
import { useEffect, useState, type ReactNode } from 'react';
import { Icon } from '../components/Icon';
import { t } from '../i18n/en';
import { tdb } from '../i18n/db';
import { useApp } from '../store';
import { Catalog } from './Catalog';
import { ConnRow, ProblemNote } from './ConnRow';
import { attempt, refreshSidebar, useSideWork } from './menus';
import { connectOnShow, navNext, pastedSheet, type ProblemAction } from './side';
import { useDb } from './store';
import { groupConnections } from './view';

const s = tdb.side;
const api = () => window.atelier.databases;
const addConnection = () => useDb.getState().setSheet({ kind: 'add', step: 1 });

/** A string with `code` in backticks, as nodes. */
function withCode(text: string): ReactNode[] {
  return text.split('`').map((part, i) => (i % 2 ? <code key={i}>{part}</code> : part));
}

/** No connection saved: how to add one — Add Connection, Paste a Connection URL. */
function EmptyState() {
  const paste = async () => {
    const text = await window.atelier.clipboard.read().catch(() => null);
    useDb.getState().setSheet((text && pastedSheet(text)) || { kind: 'add', step: 1 });
  };
  return (
    <div className="db-empty">
      <span className="db-empty-icon" aria-hidden="true"><Icon name="databases" size={22} /></span>
      <p className="db-empty-title">{s.emptyTitle}</p>
      <p className="db-empty-hint">{withCode(s.emptyHint)}</p>
      <button type="button" className="btn-primary" onClick={addConnection}><Icon name="plus" size={14} />{s.emptyAdd}</button>
      <button type="button" className="btn-ghost sm" onClick={() => void paste()}>{s.emptyPaste}</button>
    </div>
  );
}

const NAV_KEYS = ['ArrowDown', 'ArrowUp', 'Home', 'End'];

/**
 * ↑/↓, Home/End among the rows. From anywhere else in the sidebar — the filter (↓ only: the other keys move its caret),
 * a note's button, a card, the sidebar itself — the nearest row: ↓ the next one, ↑ the one before.
 */
function onKeys(e: React.KeyboardEvent<HTMLDivElement>): void {
  if (!NAV_KEYS.includes(e.key)) return;
  const from = e.target as HTMLElement;
  if (from.tagName === 'INPUT' && e.key !== 'ArrowDown') return;
  const rows = [...e.currentTarget.querySelectorAll<HTMLElement>('[data-nav]')];
  const before = from === e.currentTarget
    ? (e.key === 'ArrowUp' ? rows.length : 0)
    : rows.filter((r) => r.compareDocumentPosition(from) & Node.DOCUMENT_POSITION_FOLLOWING).length;
  const next = navNext(rows.length, rows.indexOf(from), e.key, before);
  if (next === null) return;
  e.preventDefault();
  rows[next]!.focus();
}

const REFRESH: readonly ProblemAction[] = ['refresh'];

export function DatabasesList() {
  const snap = useDb((st) => st.snap);
  const loaded = useDb((st) => st.loaded);
  const root = useApp((st) => st.project?.root ?? null);
  // Refresh running (its icon turns, the catalog dims), a database switching (the catalog keeps its place).
  const refreshing = useSideWork((st) => st.refreshing > 0);
  const switching = useSideWork((st) => st.switching);
  // The catalog's problem note while its Refresh runs: it stays until main answers.
  const [catPending, setCatPending] = useState(false);
  // Showing the view connects the remembered pick, once — never one main holds.
  const [onShow] = useState(() => connectOnShow((id) => void attempt(() => api().connect(id), tdb.fail.connect)));
  useEffect(() => onShow(snap, loaded), [onShow, snap, loaded]);

  const { project, all } = groupConnections(snap.connections, root);
  const both = project.length > 0 && all.length > 0;
  const empty = loaded && snap.connections.length === 0;
  const picked = snap.connections.find((v) => v.conn.id === snap.selected) ?? null;
  const catalog = snap.catalog && snap.catalog.connId === snap.selected ? snap.catalog : null;
  // Connected, but main couldn't read its catalog: said above the catalog (a stale one stays), with Refresh.
  const catProblem = picked?.state === 'connected' ? picked.problem : null;
  const catArea = !!catalog || picked?.state === 'connected' || catPending || (!!picked && switching === picked.conn.id);
  const row = (v: (typeof project)[number]) => <ConnRow key={v.conn.id} v={v} selected={v.conn.id === snap.selected} />;

  return (
    // Focusable, so a click in its empty space puts ⌘V here: a pasted connection URL opens Add Connection.
    <div className="db-side" tabIndex={-1} onKeyDown={onKeys}
      onPaste={(e) => {
        if (e.target instanceof HTMLInputElement && e.target.type === 'password') return;
        const sheet = pastedSheet(e.clipboardData.getData('text/plain'));
        if (!sheet) return;
        e.preventDefault();
        useDb.getState().setSheet(sheet);
      }}>
      <div className="sidebar-head">
        <span className="section-label">{t.db.title}</span>
        {snap.connections.length > 0 && <span className="section-label mono db-head-count">{snap.connections.length}</span>}
        <span className="grow" />
        <button type="button" className={`icon-btn${refreshing ? ' is-busy' : ''}`} aria-label={s.refresh} data-tip={s.refreshTip} disabled={!loaded || refreshing}
          aria-busy={refreshing || undefined} onClick={() => void refreshSidebar()}><Icon name="refresh" size={14} /></button>
        <button type="button" className="icon-btn" aria-label={s.add} data-tip={s.add} onClick={addConnection}><Icon name="plus" size={14} /></button>
      </div>
      {empty ? <EmptyState /> : (
        <div className={`db-list${refreshing ? ' is-refreshing' : ''}`}>
          {both && <div className="db-sec"><span className="section-label">{s.thisProject}</span></div>}
          {project.map(row)}
          {both && <div className="db-sec"><span className="section-label">{s.everyProject}</span></div>}
          {all.map(row)}
          {catArea && <div className="db-divider" />}
          {picked && (catProblem || catPending) && (
            <ProblemNote v={picked} p={catProblem} actions={REFRESH} onPending={(k) => setCatPending(k !== null)} />
          )}
          {catalog ? <Catalog cat={catalog} /> : catArea && !catProblem && !catPending && <p className="db-cat-note">{tdb.catalog.reading}</p>}
        </div>
      )}
      {empty ? (
        <div className="db-foot"><span>{s.hideIn}<button type="button" className="db-link" onClick={() => useApp.getState().setSettingsOpen('databases')}>{s.hideWhere}</button></span></div>
      ) : (
        <div className="db-foot">
          <Icon name="lock" size={14} />
          <span>{tdb.side.readOnly}</span>
        </div>
      )}
    </div>
  );
}
