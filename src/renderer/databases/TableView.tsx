// A table tab: the toolbar (crumb, Read-only, the
// estimate, Grid · Record on Data, Data · Structure · Relations, Mask values, Refresh ⌘R, SQL — folded into ⋯ in a narrow
// pane, and a menu on the bar), the rows loaded as you scroll — as the grid, or one as a record (Tab on a
// row; the grid and the side inspector stay mounted, hidden, and come back as they were) —, the footer (rows loaded,
// Count exactly, the last fetch's time), the states; or the Structure or Relations view (their reads are
// structure-data.ts's, Refresh reads the visible view again).
// Claude (actions.ts): the grid's action bar keeps clear of an inspector lying over the rows; Structure's DDL
// card sends the schema to the session the Docker and Redis bars target.
// Loads when first shown — its connection connects then, main connects on demand; one the user disconnected this
// session
// waits for Connect — and from the top whenever the request changes. Behind DbTabView's lazy boundary with its
// stylesheet and strings.
import './table.css';
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type MouseEvent, type RefObject } from 'react';
import type { DbConnection, DbProblem } from '@shared/databases';
import type { DbTimes } from '@shared/pg-format';
import { Icon, type IconName } from '../components/Icon';
import { copyText } from '../clipboard';
import { onEscCancel } from '../confirms/InlineConfirm';
import { tdb } from '../i18n/db';
import { tdt } from '../i18n/db-table';
import { kbd } from '../kbd';
import { radioNext } from '../radio';
import { useApp } from '../store';
import { sendSchema, useTarget } from './actions';
import { ColumnMenuHost } from './ColumnMenu';
import { approxRows, countExactly, loadFirst, rowsLabel } from './data';
import { FilterBar } from './FilterBar';
import { applyHandoff, clearDerived, setFilters } from './filter-actions';
import { Grid } from './Grid';
import { ROW_H, WRAP_ROW_H } from './grid-model';
import { Inspector } from './Inspector';
import { forgetReads } from './inspector-data';
import { inspectorLayout } from './inspector-model';
import { useInspectorWidth } from './inspector-width';
import { connectHeld, useHeld } from './hold';
import { closeRecord, openRecord, openRow, takeKeys } from './record';
import { RecordView } from './RecordView';
import { RelationsView } from './RelationsView';
import { useDb, useDbTab, type DbTabState } from './store';
import { forgetStruct, refreshFor, useStruct, viewAt, viewMissing, wireStructure, type StructWire } from './structure-data';
import { StructureView } from './StructureView';
import { linkDouble } from './structure-ui';
import {
  agoText, foldOpen, onConnect, planLoad, progressCycles, refreshKeyAction, requestDeps, sqlFor, sqlShown, tableBody, toolbarMenu, useTableUi
} from './table-view';
import type { DbTabRef, DbTabView } from './tabs';

const VIEWS: readonly DbTabView[] = ['data', 'structure', 'relations'];
const VIEW_ICON: Record<DbTabView, IconName> = { data: 'table', structure: 'list', relations: 'fkArrow' };
/** Data's rows: the grid, or one row as a record. */
type RowsView = 'grid' | 'record';
const ROWS_VIEWS: readonly RowsView[] = ['grid', 'record'];
const ROWS_ICON: Record<RowsView, IconName> = { grid: 'dbTable', record: 'record' };
/** A load shows nothing for this long, then skeleton rows. */
const SKELETON_MS = 150;
const SKELETON_ROWS = 12;

/** True once `on` has held for `ms` (false again as soon as it stops). */
function useAfter(on: boolean, ms: number): boolean {
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (!on) { setDone(false); return; }
    const id = setTimeout(() => setDone(true), ms);
    return () => clearTimeout(id);
  }, [on, ms]);
  return on && done;
}

const api = () => window.atelier.databases;
const toast = (text: string, info = false) => useApp.getState().showToast(text, undefined, info ? 'info' : undefined);

function copySql(sql: string): void {
  void copyText(sql).then((ok) => toast(ok ? tdt.copied : tdt.copyFailed, ok), () => toast(tdt.copyFailed));
}

/** Where the keyboard goes back after the popover: SQL's button, or ⋯ when the pane folded it, or the tab. */
function focusBack(...els: (HTMLElement | null)[]): void {
  els.find((el) => el?.isConnected && el.offsetParent !== null)?.focus({ preventScroll: true });
}

export function TableView({ tab, conn, visible, focused }: { tab: DbTabRef; conn: DbConnection | null; visible: boolean; focused: boolean }) {
  const st = useDbTab(tab.key);
  const connState = useDb((s) => s.snap.connections.find((v) => v.conn.id === tab.connId)?.state ?? 'idle');
  // A connection the user disconnected (main's hold): its tab doesn't connect it by
  // itself.
  const held = useHeld(tab.connId);
  // The catalog's estimate (210 rows"): the selected connection's catalog lists the schema shown.
  const listed = useDb((s) => (s.snap.catalog?.connId === tab.connId ? s.snap.catalog.rels.find((r) => r.schema === tab.schema && r.name === tab.name)?.estimate ?? null : null));
  const times = useApp((s) => s.settings.dbTimes);
  const timeoutSec = useApp((s) => s.settings.dbTimeoutSec);
  // This tab's key while its popover is open, else null (another tab's opening doesn't render this one).
  const openSqlKey = useTableUi((s) => (s.sql === tab.key ? tab.key : null));
  const sqlOpen = openSqlKey !== null;
  const root = useRef<HTMLDivElement>(null);
  const sqlBtn = useRef<HTMLButtonElement>(null);
  const foldBtn = useRef<HTMLButtonElement>(null);
  const sql = st.data?.sql ?? null;
  // In front with the keyboard (as DockerView and FileView): the tab takes the focus, so ⌘R reaches it at once — its
  // grid when the rows are there (↑/↓, ⌘C work at once; Grid takes it when they come).
  // On Structure or Relations the grid is hidden (it can't take the keyboard): the tab itself does; the record view
  // instead of the grid when it shows. On showing only: a view switch leaves the keyboard where the user is (the
  // view radios).
  const record = st.view === 'record';
  useEffect(() => {
    const el = root.current;
    const rows = tab.view === 'data' ? el?.querySelector<HTMLElement>(record ? '.dbrv-body' : '.dbt-grid') : null;
    if (visible && focused && el && !el.contains(document.activeElement)) (rows ?? el).focus({ preventScroll: true });
  }, [visible, focused]);
  // Back from the record view by its keys (Tab, Esc): the grid takes the keyboard on that row — after the grid put its
  // place back and brought the row into view (its effects run first).
  useLayoutEffect(() => {
    if (!record && takeKeys(tab.key, 'grid')) root.current?.querySelector<HTMLElement>('.dbt-grid')?.focus({ preventScroll: true });
  }, [record, tab.key]);
  // The popover goes with its tab — hidden, closed — and with its statement (a failed load clears it).
  useEffect(() => useTableUi.getState().sync(tab.key, visible, sql), [tab.key, visible, sql]);
  useEffect(() => () => useTableUi.getState().closeSql(tab.key), [tab.key]);
  // The inspector's reads go with the tab (they are cached while it is open); Structure's and Relations' too.
  useEffect(() => () => { forgetReads(tab.key); forgetStruct(tab.key); }, [tab.key]);
  // The tab's width as drawn (hidden: the last one kept): the row inspector goes beside the grid or over its rows by
  // it.
  useLayoutEffect(() => {
    const el = root.current;
    if (!el) return;
    const ui = useTableUi.getState();
    const measure = () => { if (el.clientWidth > 0) ui.setWidth(tab.key, el.clientWidth); };
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    measure();
    return () => { ro.disconnect(); ui.setWidth(tab.key, 0); };
  }, [tab.key]);
  const paneW = useTableUi((s) => s.widths[tab.key] ?? 0);
  // Opened on a key (Open ›, "N rows ›", Open Referenced Row): its filters become the tab's before it reads.
  useLayoutEffect(() => { if (st.handoff) applyHandoff(tab.key); }, [st.handoff, tab.key]);
  const ready = conn !== null;
  const masked = conn?.mask === true;

  // One load decision a render (table-view.ts planLoad): when first shown (on Data, its connection known and not held),
  // from the top whenever the request changed — a hidden tab waits until it is shown —, and once more after a failed
  // load when the connection is back (when shown, if it was hidden then). Both due at once: one read. The request as
  // the tab holds it now (a handoff applied just before is read at once, not after a render).
  const last = useRef<readonly unknown[] | null>(null);
  const prevConn = useRef(connState);
  const pending = useRef(false);
  useEffect(() => {
    const now = useDb.getState().tab(tab.key);
    const plan = planLoad({
      visible, view: tab.view, ready, held, last: last.current, req: requestDeps(now),
      pending: pending.current, prev: prevConn.current, cur: connState, failed: now.problem !== null
    });
    prevConn.current = connState;
    pending.current = plan.pending;
    last.current = plan.last;
    if (plan.load) void loadFirst(tab.key);
  }, [visible, tab.view, ready, held, st.filters, st.sort, st.columns, st.derived, tab.key, connState, st.problem]);

  // Structure and Relations: one step of structure-data.ts (wireStructure) whenever an input changes — what
  // the view in front shows, read once; the failed parts again once the connection came back; nothing by itself on a
  // connection the user disconnected this session (the Disconnected card until their Connect).
  const structMissing = useStruct((s) => viewMissing(s.tabs[tab.key], tab.view));
  const structAt = useStruct((s) => viewAt(s.tabs[tab.key], tab.view));
  const structWire = useRef<StructWire>({ back: false, conn: connState });
  useEffect(() => {
    structWire.current = wireStructure(tab.key, { connId: tab.connId, schema: tab.schema, name: tab.name }, structWire.current, { visible, view: tab.view, ready, held, connState });
  }, [visible, tab.view, tab.key, tab.connId, tab.schema, tab.name, ready, held, connState]);

  const refresh = () => {
    // Structure and Relations read what they show again; the rows stay as they are until Data's own Refresh.
    if (refreshFor(tab.key, { connId: tab.connId, schema: tab.schema, name: tab.name }, tab.view)) return;
    // A read: on a connection main holds it is their Connect (data.ts ask connects first).
    last.current = requestDeps(useDb.getState().tab(tab.key));
    void loadFirst(tab.key);
  };
  // The Disconnected card's Connect: one click, one read — a tab that already tried reads now.
  const connect = () => onConnect(last.current !== null, { connect: () => connectHeld(tab.connId), refresh });
  /**
   * The toolbar's Grid / Record: the record view on the focused row (else the last selected, else the first
   * on screen), or the grid on the record's row. The keyboard stays where the user is (the toggle, the menu's opener).
   */
  const setRows = (v: RowsView) => {
    const now = useDb.getState().tab(tab.key);
    if ((now.view === 'record') === (v === 'record')) return;
    if (v === 'grid') { closeRecord(tab.key); return; }
    const grid = root.current?.querySelector<HTMLElement>('.dbt-grid');
    openRecord(tab.key, openRow(now, Math.ceil((grid?.scrollTop ?? 0) / (now.wrap ? WRAP_ROW_H : ROW_H))));
  };
  const menu = () => toolbarMenu({ view: tab.view, masked, canMask: conn !== null, hasSql: !!st.data?.sql, record, inspector: st.inspector }, {
    view: (v) => useApp.getState().setDbView(tab.key, v),
    mask: () => { if (conn) void api().setMask(conn.id, !conn.mask).catch(() => toast(tdt.fail.mask)); },
    refresh,
    showSql: () => useTableUi.getState().openSql(tab.key),
    // As the popover shows it: Mask values on, its values as dots.
    copySql: () => { if (st.data?.sql) copySql(sqlFor(st.data.sql, masked)); },
    record: () => setRows(useDb.getState().tab(tab.key).view === 'record' ? 'grid' : 'record'),
    // As Enter in the grid: hidden, its JSON view goes with it.
    inspector: () => useDb.getState().patchTab(tab.key, useDb.getState().tab(tab.key).inspector ? { inspector: false, json: null } : { inspector: true })
  });
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const act = refreshKeyAction(e);
    if (!act) return;
    e.preventDefault();
    e.stopPropagation();
    // ⌘R held down: its repeats are this tab's, but read nothing.
    if (act === 'run') refresh();
  };
  // Shift+F10 with the tab itself focused (App sends it as a contextmenu event): the toolbar's menu. Elements inside
  // (the bar, later the grid's cells) open their own.
  const onRootMenu = (e: MouseEvent<HTMLDivElement>) => { if (e.target === e.currentTarget) useApp.getState().openMenu(e, menu()); };
  const closeSql = (refocus: boolean) => {
    useTableUi.getState().closeSql(tab.key);
    if (refocus) focusBack(sqlBtn.current, foldBtn.current, root.current);
  };

  // The row inspector: in the rows' box, its one place (a flip never mounts it again) —
  // beside the grid while the grid keeps a usable width, else over it; the toolbar, the filter bar, the footer and
  // their popovers stay above it and within reach. Inspector.tsx reads the layout from `paneW`.
  // The record view hides it, mounted, to come back as it was.
  const inspector = tab.view === 'data' && st.inspector ? <Inspector tab={tab} st={st} masked={masked} times={times} visible={visible} paneW={paneW} hidden={record} /> : null;
  // Lying over the rows (a narrow tab), the inspector's width is kept clear by the grid's action bar; the
  // width is the app's.
  const inspWidth = useInspectorWidth((s) => s.width);
  const over = inspector && !record ? inspectorLayout(paneW, inspWidth) : null;
  const inset = over?.overlay ? over.width : 0;
  // Claude: Structure's Send Schema pastes into the session the Docker and Redis bars target.
  const target = useTarget();
  // A double click begun on a Structure or Relations link lands here with its second press (structure-ui.tsx): it keeps
  // this table, nothing under the pointer takes it.
  const onDouble = (e: MouseEvent<HTMLDivElement>) => { linkDouble(tab.key, e); };
  return (
    <div ref={root} className="dbt" tabIndex={-1} onKeyDown={onKeyDown} onContextMenu={onRootMenu}
      onMouseDownCapture={onDouble} onMouseUpCapture={onDouble} onClickCapture={onDouble} onDoubleClickCapture={onDouble}>
      <Toolbar tab={tab} conn={conn} st={st} at={tab.view === 'data' ? st.at : structAt} estimate={listed ?? (st.filters.length === 0 ? st.estimate : null)}
        masked={masked} sqlOpen={sqlOpen} sqlBtn={sqlBtn} foldBtn={foldBtn} menu={menu} onRefresh={refresh} onRows={setRows} />
      {/* Beside the bar, not in it: the bar clips what doesn't fit. */}
      {/* Mask values on: the statement's values as dots, in what it shows and what its Copy copies. */}
      {sqlShown(openSqlKey, tab.key, visible, sql) && <SqlPopover sql={sqlFor(sql!, masked)} anchors={[sqlBtn, foldBtn]} onClose={closeSql} />}
      {/* A header's column menu, in the tab as the other popovers, under its header. */}
      <ColumnMenuHost tab={tab} st={st} masked={masked} visible={visible && tab.view === 'data'} />
      {/* The rows stay mounted on Structure and Relations, hidden: Data comes back where it was. */}
      <div className="dbt-data" style={{ display: tab.view === 'data' ? 'flex' : 'none' }}>
        {/* Filters and the columns: their popovers sit in the tab (.dbt), over the rows. */}
        <FilterBar tab={tab} st={st} masked={masked} visible={visible && tab.view === 'data'} />
        <div className="dbt-rows">
          <Body tab={tab} conn={conn} st={st} held={held} masked={masked} times={times} timeoutSec={timeoutSec} inset={inset} visible={visible} onRetry={refresh} onConnect={connect} />
          {inspector}
        </div>
        <Footer tabKey={tab.key} st={st} />
      </div>
      {/* Structure and Relations: nothing of a held connection is read by itself. */}
      {tab.view !== 'data' && (held && structMissing
        ? <Disconnected name={conn?.name ?? tab.connId} onConnect={() => connectHeld(tab.connId)} />
        : tab.view === 'structure'
          ? <StructureView tab={tab} width={paneW} onOpenDiagram={() => useApp.getState().setDbView(tab.key, 'relations')}
            sendSchema={{ label: target, run: () => void sendSchema({ connId: tab.connId, schema: tab.schema, name: tab.name }, tab.key) }} />
          : <RelationsView tab={tab} width={paneW} />)}
    </div>
  );
}

/** A connection the user disconnected this session: a calm card, their Connect the only way to read. */
function Disconnected({ name, onConnect }: { name: string; onConnect: () => void }) {
  return (
    <div className="dbt-center">
      <div className="dk-state is-compact">
        <span className="dk-state-icon" aria-hidden="true"><Icon name="databases" size={22} /></span>
        <h2 className="dk-state-title">{tdt.disconnected.title}</h2>
        <p className="dk-state-hint">{tdt.disconnected.body(name)}</p>
        <button type="button" className="btn-primary sm" onClick={onConnect}>{tdt.disconnected.connect}</button>
      </div>
    </div>
  );
}

function Toolbar({ tab, conn, st, at, estimate, masked, sqlOpen, sqlBtn, foldBtn, menu, onRefresh, onRows }: {
  tab: DbTabRef; conn: DbConnection | null; st: DbTabState; at: number | null; estimate: number | null; masked: boolean; sqlOpen: boolean;
  sqlBtn: RefObject<HTMLButtonElement | null>; foldBtn: RefObject<HTMLButtonElement | null>; menu: () => ReturnType<typeof toolbarMenu>; onRefresh: () => void;
  onRows: (v: RowsView) => void;
}) {
  const rows: RowsView = st.view === 'record' ? 'record' : 'grid';
  // "Updated 12 s ago": right when the rows (or Structure's, Relations' parts) come, and read again when the pointer or
  // the keyboard reaches Refresh.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => setNow(Date.now()), [at]);
  const tick = () => setNow(Date.now());
  const ago = agoText(at, now);
  const sql = st.data?.sql ?? null;
  const setView = (v: DbTabView) => useApp.getState().setDbView(tab.key, v);
  const toggleMask = () => {
    if (!conn) return;
    void api().setMask(conn.id, !conn.mask).catch(() => toast(tdt.fail.mask));
  };
  // ⋯ reads expanded while the menu it opened is the one on screen (as Header's New: by the store's menu object).
  const fold = useTableUi((s) => (s.fold?.key === tab.key ? s.fold : null));
  const foldExpanded = useApp((s) => foldOpen(s.menu, fold, tab.key));
  const openFold = () => {
    const r = foldBtn.current?.getBoundingClientRect();
    if (!r) return;
    useApp.getState().openMenu({ x: r.left, y: r.bottom + 4, anchor: { left: r.left, right: r.right, bottom: r.bottom } }, menu());
    useTableUi.setState({ fold: { key: tab.key, menu: useApp.getState().menu } });
  };
  return (
    <div className="dbt-bar" role="toolbar" aria-label={tab.name} onContextMenu={(e) => useApp.getState().openMenu(e, menu())}>
      <div className="dbt-crumb mono" data-tip={tdt.crumbTip(conn?.name ?? '', tab.schema, tab.name)}>
        {conn && <><span className="dbt-crumb-conn">{conn.name}</span><span className="dbt-crumb-sep" aria-hidden="true">/</span></>}
        <span className="dbt-crumb-schema">{tab.schema}</span><span className="dbt-crumb-sep" aria-hidden="true">/</span><b className="dbt-crumb-name">{tab.name}</b>
      </div>
      <span className="dbt-ro" data-tip={tdb.side.readOnly}><Icon name="lock" size={12} /><span className="dbt-ro-label">{tdt.readOnly}</span></span>
      {estimate !== null && <span className="dbt-est" data-tip={tdt.estimateTip}>{tdt.estimate(approxRows(estimate))}</span>}
      <span className="dbt-sp" />
      {/* Data's rows as the grid or one as a record; Tab does the same from the keyboard. A narrow pane folds
          it into ⋯ first (Record View there). */}
      {tab.view === 'data' && (
        <div className="dk-views dbt-rv" role="radiogroup" aria-label={tdt.record.viewsLabel} onKeyDown={(e) => {
          const next = radioNext(ROWS_VIEWS, rows, e.key);
          if (next === null) return;
          e.preventDefault();
          onRows(next);
          (e.currentTarget.querySelector(`[data-value="${next}"]`) as HTMLElement | null)?.focus();
        }}>
          {ROWS_VIEWS.map((v) => {
            const on = rows === v;
            return (
              <button key={v} type="button" className={on ? 'is-on' : undefined} role="radio" aria-checked={on} tabIndex={on ? 0 : -1} data-value={v}
                aria-label={tdt.record.views[v]} data-tip={tdt.record.tips[v]} data-kbd={kbd('⇥')} onClick={() => onRows(v)}>
                <Icon name={ROWS_ICON[v]} size={12} stroke={1.8} /><span className="dbt-rv-label">{tdt.record.views[v]}</span>
              </button>
            );
          })}
        </div>
      )}
      <div className="dk-views dbt-views" role="radiogroup" aria-label={tdt.viewsLabel} onKeyDown={(e) => {
        const next = radioNext(VIEWS, tab.view, e.key);
        if (next === null) return;
        e.preventDefault();
        setView(next);
        (e.currentTarget.querySelector(`[data-value="${next}"]`) as HTMLElement | null)?.focus();
      }}>
        {VIEWS.map((v) => {
          const on = tab.view === v;
          return (
            <button key={v} type="button" className={on ? 'is-on' : undefined} role="radio" aria-checked={on} tabIndex={on ? 0 : -1} data-value={v}
              aria-label={tdt.views[v]} data-tip={tdt.views[v]} onClick={() => setView(v)}>
              <Icon name={VIEW_ICON[v]} size={12} stroke={1.8} /><span className="dbt-views-label">{tdt.views[v]}</span>
            </button>
          );
        })}
      </div>
      <button type="button" className={`icon-btn dbt-ib${masked ? ' is-on' : ''}`} aria-label={tdt.mask} aria-pressed={masked} data-tip={tdt.maskTip(masked)}
        disabled={!conn} onClick={toggleMask}>
        <Icon name="eye" size={14} />
      </button>
      <button type="button" className="icon-btn dbt-ib" aria-label={tdt.refresh} data-tip={ago ? tdt.updated(ago) : tdt.refresh} data-kbd={kbd('⌘R')}
        onMouseEnter={tick} onFocus={tick} onClick={onRefresh}>
        <Icon name="refresh" size={14} />
      </button>
      <button ref={sqlBtn} type="button" className="dbt-sql" data-tip={tdt.sqlTip} aria-haspopup="dialog" aria-expanded={sqlOpen} disabled={!sql}
        onClick={() => { const ui = useTableUi.getState(); if (sqlOpen) ui.closeSql(tab.key); else ui.openSql(tab.key); }}>
        <Icon name="code" size={14} /><span className="dbt-sql-label">{tdt.sql}</span>
      </button>
      {/* A narrow pane (table.css): the Grid / Record toggle, then Mask, Refresh and SQL fold in here. */}
      <button ref={foldBtn} type="button" className={`icon-btn dbt-fold${foldExpanded ? ' is-open' : ''}`} aria-label={tdt.fold} aria-haspopup="menu" aria-expanded={foldExpanded}
        data-tip={tdt.fold} onClick={openFold}>
        <Icon name="more" size={14} />
      </button>
    </div>
  );
}

/**
 * The SQL popover: the exact statement, parameters inlined for reading, Copy (which takes the keyboard).
 * As the app's confirms (useDismiss, onEscCancel): Esc on the popover itself closes it and gives the keyboard back to
 * its button — nothing else in the window hears that Esc —, a press outside closes it (one on its own button toggles).
 */
function SqlPopover({ sql, anchors, onClose }: { sql: string; anchors: RefObject<HTMLElement | null>[]; onClose: (refocus: boolean) => void }) {
  const box = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    box.current?.querySelector<HTMLElement>('[data-autofocus]')?.focus({ preventScroll: true });
    const down = (e: PointerEvent) => {
      if (!(e.target instanceof Node) || box.current?.contains(e.target) || anchors.some((a) => a.current?.contains(e.target as Node))) return;
      close.current(false);
    };
    window.addEventListener('pointerdown', down, true);
    return () => window.removeEventListener('pointerdown', down, true);
  }, []);
  return (
    <div ref={box} className="dbt-pop" role="dialog" aria-label={tdt.sqlTitle} onKeyDown={onEscCancel(() => onClose(true))}>
      <div className="dbt-pop-head">
        <span className="section-label">{tdt.sqlTitle}</span>
        <span className="dbt-sp" />
        <button type="button" className="btn-ghost sm dbt-pop-copy" data-autofocus onClick={() => copySql(sql)}>
          <Icon name="copy" size={12} />{tdt.copy}
        </button>
        <button type="button" className="icon-btn" aria-label={tdt.close} onClick={() => onClose(true)}><Icon name="x" size={12} /></button>
      </div>
      <pre className="dbt-pop-sql mono">{sql}</pre>
      <p className="dbt-pop-note">{tdt.sqlNote}</p>
    </div>
  );
}

function Body({ tab, conn, st, held, masked, times, timeoutSec, inset, visible, onRetry, onConnect }: {
  tab: DbTabRef; conn: DbConnection | null; st: DbTabState; held: boolean; masked: boolean; times: DbTimes; timeoutSec: number; inset: number;
  visible: boolean; onRetry: () => void; onConnect: () => void;
}) {
  const waited = useAfter(st.loading || (!st.data && !st.problem), SKELETON_MS);
  const body = tableBody(st, waited, held);
  if (body === 'rows' && st.data) {
    // The record view in the grid's place: the grid stays mounted, hidden, its place in the rows kept.
    const record = st.view === 'record';
    return (
      <div className={`dbt-body${st.loading ? ' is-busy' : ''}`} aria-busy={st.loading || undefined}>
        {st.loading && <span className="dbt-progress" aria-hidden="true" style={{ '--dbt-cycles': progressCycles(timeoutSec) } as CSSProperties}><i /></span>}
        <Grid tabKey={tab.key} table={tab} st={st} page={st.data} masked={masked} times={times} inset={inset} away={record} />
        {record && <RecordView tab={tab} st={st} masked={masked} times={times} visible={visible && tab.view === 'data'} />}
      </div>
    );
  }
  // The user's own Connect: the hold goes, and the tab reads (table-view.ts onConnect).
  if (body === 'disconnected') return <Disconnected name={conn?.name ?? tab.connId} onConnect={onConnect} />;
  if (body === 'skeleton') {
    return (
      <div className="dbt-body dbt-skel" role="status" aria-label={tdt.loading}>
        {Array.from({ length: SKELETON_ROWS }, (_, i) => <span key={i} className="dbt-skel-bar" style={{ animationDelay: `${(i % 4) * 90}ms` }} />)}
      </div>
    );
  }
  if (body === 'error' && st.problem) {
    return (
      <ProblemCard problem={st.problem} onRetry={onRetry} onClear={st.filters.length > 0 ? () => setFilters(tab.key, []) : null}
        onClearDerived={st.derived.length > 0 ? () => clearDerived(tab.key) : null} />
    );
  }
  if (body === 'empty') {
    const filtered = st.filters.length > 0;
    return (
      <div className="dbt-center">
        <div className="dk-state is-compact">
          <span className="dk-state-icon" aria-hidden="true"><Icon name={filtered ? 'filter' : 'dbTable'} size={22} /></span>
          <h2 className="dk-state-title">{filtered ? tdt.emptyFiltered : tdt.empty}</h2>
          {/* Filters removed: the preview is kept, as for any filter change. */}
          {filtered && <button type="button" className="btn-ghost sm" onClick={() => setFilters(tab.key, [])}>{tdt.clearFilters}</button>}
        </div>
      </div>
    );
  }
  return <div className="dbt-body" />;
}

/**
 * Postgres's message, its detail, the hint (a timeout's own), SQLSTATE, Try Again — none for a role that
 * can't read —, and with filters Clear Filters beside it (`onClear`): a filter that fails every time never loops;
 * with JSON columns, Remove JSON Columns (`onClearDerived`): a key path main refuses never leaves the tab stuck.
 */
function ProblemCard({ problem, onRetry, onClear, onClearDerived }: { problem: DbProblem; onRetry: () => void; onClear: (() => void) | null; onClearDerived: (() => void) | null }) {
  const hint = problem.kind === 'canceled' ? tdt.timeoutHint : problem.hint;
  const retry = problem.kind !== 'denied';
  return (
    <div className="dbt-center">
      <div className="dk-state is-compact dbt-problem" role="alert">
        <span className="dk-state-icon" aria-hidden="true"><Icon name="warning" size={22} /></span>
        <h2 className="dk-state-title">{problem.message}</h2>
        {problem.detail && <p className="dbt-problem-detail">{problem.detail}</p>}
        {hint && <p className="dk-state-hint">{hint}</p>}
        {problem.code && <p className="dbt-problem-code mono">{tdt.sqlState(problem.code)}</p>}
        {(retry || onClear || onClearDerived) && (
          <div className="dbt-problem-actions">
            {retry && <button type="button" className="btn-ghost sm" onClick={onRetry}><Icon name="refresh" size={12} />{tdt.tryAgain}</button>}
            {onClear && <button type="button" className="btn-ghost sm" onClick={onClear}>{tdt.clearFilters}</button>}
            {onClearDerived && <button type="button" className="btn-ghost sm" onClick={onClearDerived}>{tdt.clearDerived}</button>}
          </div>
        )}
      </div>
    </div>
  );
}

/** Board 1's footer: "300 loaded of ~2,300", Count exactly, the last fetch's time, the scroll hint. Always there on Data. */
function Footer({ tabKey, st }: { tabKey: string; st: DbTabState }) {
  const [counting, setCounting] = useState(false);
  const label = rowsLabel(st);
  const ok = st.data !== null && st.problem === null && st.rows.length > 0;
  const showCount = ok && st.more !== 'end' && !(st.exact !== null && st.rows.length >= st.exact);
  const count = async () => {
    setCounting(true);
    const p = await countExactly(tabKey);
    setCounting(false);
    if (p) toast(tdt.countFailed(p.message));
  };
  return (
    <div className="dbt-foot">
      <span className="dbt-foot-label" data-tip={label || undefined}>{label}</span>
      {showCount && (
        <button type="button" className="dbt-link dbt-count" data-tip={tdt.countTip} disabled={counting} aria-busy={counting || undefined} onClick={() => void count()}>
          {counting ? tdt.counting : tdt.count}
        </button>
      )}
      {ok && st.data && <span className="dbt-ms mono">{tdt.ms(st.data.ms)}</span>}
      <span className="dbt-sp" />
      {ok && st.more === 'idle' && <span className="dbt-foot-hint"><Icon name="arrowDown" size={12} /><span>{tdt.scrollHint}</span></span>}
    </div>
  );
}
