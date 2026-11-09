// The selected connection's catalog in the Databases sidebar: the database chip (the
// server's other databases), the schema chip, the "Filter tables" field, and its sections — tables, views, materialized views with their estimated rows, enums that open
// to their values, functions that open to their signature — each folding, the
// folds remembered per connection. A click opens a table in the preview tab, a double click (or Enter) keeps it,
// ⌥-click opens it to the side. Large catalogs: rows are drawn again only when what they show changed, and
// a section shows 500 rows until Show all.
import { memo, useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { compactCount, type DbCatalog, type DbEnum, type DbFunction, type DbRel } from '@shared/databases';
import { Icon } from '../components/Icon';
import { tdb } from '../i18n/db';
import { openBelow } from '../menus';
import { useApp } from '../store';
import { databaseMenu, enumMenu, fnMenu, openRel, relMenu, schemaMenu, signatureOf, switchDatabase } from './menus';
import { capRows, catalogLists, foldedOf, sameCatalog, sameEnum, sameFn, sameRel, toggleFold, type FoldId } from './side';
import { useDb } from './store';
import { DB_TAB_ICON, dbTabKey } from './tabs';

const tc = tdb.catalog;

function estimateTip(r: DbRel): string {
  const rows = r.estimate === null ? tc.neverAnalyzed : tc.estimate(r.estimate);
  return r.partitions ? `${rows} · ${tc.partitions(r.partitions)}` : rows;
}

/** A section's head: drawn again only when what it shows changed. */
export const Fold = memo(function Fold({ connId, id, count, open }: { connId: string; id: FoldId; count: number; open: boolean }) {
  return (
    <button type="button" className="db-fold" aria-expanded={open} data-nav=""
      onClick={() => useDb.setState((s) => ({ folds: toggleFold(s.folds, connId, id) }))}>
      <Icon name="chevron" size={12} stroke={1.9} />
      <span className="section-label">{tc.sections[id]}</span><span className="db-sec-count">{count}</span>
    </button>
  );
});

const RelRow = memo(function RelRow({ connId, r, active }: { connId: string; r: DbRel; active: boolean }) {
  return (
    <button type="button" className={`db-rel${active ? ' is-selected' : ''}`} data-nav="" aria-current={active || undefined} data-tip={`${r.schema}.${r.name}\n${estimateTip(r)}`}
      onClick={(e) => openRel(connId, r, e.altKey ? { preview: false, side: true } : { preview: true })}
      onDoubleClick={() => openRel(connId, r, { preview: false })}
      // Enter keeps the table open (as a double click); Space is the button's own click: the preview.
      onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); openRel(connId, r, { preview: false }); } }}
      onContextMenu={(e) => useApp.getState().openMenu(e, relMenu(connId, r))}>
      <Icon name={DB_TAB_ICON[r.kind]} size={14} />
      <span className="db-rel-name">{r.name}</span>
      <span className="db-rel-count">{compactCount(r.estimate)}</span>
    </button>
  );
}, (a, b) => a.connId === b.connId && a.active === b.active && sameRel(a.r, b.r));

const EnumRow = memo(function EnumRow({ e, open, onToggle }: { e: DbEnum; open: boolean; onToggle: (k: string) => void }) {
  return (
    <>
      <button type="button" className="db-rel is-enum" data-nav="" aria-expanded={open} data-tip={`${e.schema}.${e.name}\n${tc.values(e.values.length)}`}
        onClick={() => onToggle(`e:${e.name}`)} onContextMenu={(ev) => useApp.getState().openMenu(ev, enumMenu(e))}>
        <Icon name="enumList" size={14} />
        <span className="db-rel-name">{e.name}</span>
        <span className="db-rel-count">{e.values.length}</span>
      </button>
      {/* The values as the grid shows them: a chip each, tinted by its place in the enum. */}
      {open && <div className="db-enum-vals">{e.values.map((v, i) => <span key={v} className={`csv-pill t${i % 8}`} data-tip={v}>{v}</span>)}</div>}
    </>
  );
}, (a, b) => a.open === b.open && a.onToggle === b.onToggle && sameEnum(a.e, b.e));

const FnRow = memo(function FnRow({ connId, f, open, onToggle }: { connId: string; f: DbFunction; open: boolean; onToggle: (k: string) => void }) {
  return (
    <>
      <button type="button" className="db-rel is-fn" data-nav="" aria-expanded={open} data-tip={signatureOf(f)}
        onClick={() => onToggle(`f:${f.oid}`)} onContextMenu={(ev) => useApp.getState().openMenu(ev, fnMenu(connId, f))}>
        <Icon name="fn" size={14} />
        <span className="db-rel-name">{f.name}<span className="db-dim">({f.args})</span></span>
        <span className="db-rel-ret">→ {f.returns}</span>
      </button>
      {open && <div className="db-fn-sig"><b>{f.schema}.{f.name}</b>({f.args})<br />→ {f.returns}</div>}
    </>
  );
}, (a, b) => a.connId === b.connId && a.open === b.open && a.onToggle === b.onToggle && sameFn(a.f, b.f));

/**
 * Drawn again only when the catalog shows something else: each snapshot main sends is a new object, and a
 * broadcast for another connection, a mask or a tab carries the same catalog.
 */
export const Catalog = memo(function Catalog({ cat }: { cat: DbCatalog }) {
  const filter = useDb((s) => s.filter);
  const folds = useDb((s) => s.folds);
  const activeTab = useApp((s) => s.activeTab);
  const [draft, setDraft] = useState(filter);
  // Enums and functions opened to their values or signature, sections shown whole past the cap (this view only).
  const [opened, setOpened] = useState<ReadonlySet<string>>(() => new Set());
  const [whole, setWhole] = useState<ReadonlySet<FoldId>>(() => new Set());
  useEffect(() => { const h = setTimeout(() => useDb.setState({ filter: draft }), 300); return () => clearTimeout(h); }, [draft]);
  const lists = useMemo(() => catalogLists(cat, filter), [cat, filter]);
  const folded = foldedOf(folds, cat.connId);
  const toggle = useCallback((k: string) => setOpened((o) => { const n = new Set(o); if (n.has(k)) n.delete(k); else n.add(k); return n; }), []);
  /** A section: its fold head, then (open) its first 500 rows and, past them, Show all N. */
  const section = <T,>(id: FoldId, rows: T[], row: (x: T) => ReactNode) => {
    if (rows.length === 0) return null;
    const open = !folded.includes(id);
    const { shown, more } = capRows(rows, whole.has(id));
    return (
      <>
        <Fold connId={cat.connId} id={id} count={rows.length} open={open} />
        {open && shown.map(row)}
        {open && more > 0 && <button type="button" className="db-more" data-nav="" onClick={() => setWhole((w) => new Set(w).add(id))}>{tc.showAll(rows.length)}</button>}
      </>
    );
  };
  const rel = (r: DbRel) => <RelRow key={r.name} connId={cat.connId} r={r} active={activeTab === dbTabKey(cat.connId, r.schema, r.name)} />;
  const empty = cat.rels.length + cat.enums.length + cat.functions.length === 0;
  const none = !empty && lists.tables.length + lists.views.length + lists.matviews.length + lists.enums.length + lists.functions.length === 0;
  return (
    <>
      <div className="db-cat-bar">
        {/* The database it reads, the server's others a pick away (a click, Enter or Space, Shift+F10). */}
        <button type="button" className="db-schema db-database mono" aria-haspopup="menu" aria-label={tc.databaseTip(cat.database)} data-tip={tc.databaseTip(cat.database)}
          onClick={(e) => openBelow(e.currentTarget, databaseMenu(cat))} onContextMenu={(e) => useApp.getState().openMenu(e, databaseMenu(cat))}>
          <Icon name="databases" size={12} /><span className="db-schema-name">{cat.database}</span><Icon name="chevronDown" size={11} stroke={2} />
        </button>
        <button type="button" className="db-schema mono" aria-haspopup="menu" aria-label={tc.schemaTip(cat.schema)} data-tip={tc.schemaTip(cat.schema)}
          onClick={(e) => openBelow(e.currentTarget, schemaMenu(cat))} onContextMenu={(e) => useApp.getState().openMenu(e, schemaMenu(cat))}>
          <span className="db-schema-name">{cat.schema}</span><Icon name="chevronDown" size={11} stroke={2} />
        </button>
        <label className="db-filter">
          <Icon name="search" size={13} />
          <input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder={tc.filter} aria-label={tc.filter} spellCheck={false}
            onKeyDown={(e) => { if (e.key === 'Escape' && draft) { e.stopPropagation(); setDraft(''); } }} />
        </label>
      </div>
      {section('tables', lists.tables, rel)}
      {section('views', lists.views, rel)}
      {section('matviews', lists.matviews, rel)}
      {section('enums', lists.enums, (e) => <EnumRow key={e.name} e={e} open={opened.has(`e:${e.name}`)} onToggle={toggle} />)}
      {section('functions', lists.functions, (f) => <FnRow key={f.oid} connId={cat.connId} f={f} open={opened.has(`f:${f.oid}`)} onToggle={toggle} />)}
      {cat.noRels ? <NoTables cat={cat} /> : empty && <p className="db-cat-note">{tc.none}</p>}
      {none && <p className="db-cat-note">{tc.noMatch(filter.trim())}</p>}
    </>
  );
}, (a, b) => sameCatalog(a.cat, b.cat));

/** The server's other databases a database without tables lists at first; Show all N for the rest. */
const OTHERS_CAP = 10;

/**
 * A database without a table, view or materialized view in any schema: said, and the server's other
 * databases one click away each — the maintenance `postgres` is often the one picked by mistake.
 */
function NoTables({ cat }: { cat: DbCatalog }) {
  const [all, setAll] = useState(false);
  const others = cat.databases.filter((d) => d !== cat.database);
  const { shown, more } = capRows(others, all, OTHERS_CAP);
  return (
    <>
      <p className="db-cat-note">{tc.noTables(cat.database)}</p>
      {others.length > 0 && (
        <>
          <div className="db-sec"><span className="section-label">{tc.otherDatabases}</span></div>
          {shown.map((d) => (
            <button key={d} type="button" className="db-rel db-other-db" data-nav="" data-tip={tc.switchTo(d)} onClick={() => void switchDatabase(cat.connId, d)}>
              <Icon name="databases" size={14} /><span className="db-rel-name">{d}</span>
            </button>
          ))}
          {more > 0 && <button type="button" className="db-more" data-nav="" onClick={() => setAll(true)}>{tc.showAll(others.length)}</button>}
        </>
      )}
    </>
  );
}
