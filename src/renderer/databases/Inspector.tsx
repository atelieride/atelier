// The row inspector: on the tab's right, 280–560 px (kept per
// tab; its edge drags, ←/→ on it as the app's other splitters), Fields · JSON, ↑/↓ for the previous/next row — the
// grid's focus moves, the panel stays as it is (static UI: its sections keep their state). Fields: the grid's columns
// in its order with their type lines and values as opened, then its JSON columns; JSON as a tree read
// losslessly; a cut value's Load full value; a foreign key's peek card with Open ›; "N more fields", read for this
// row by its key when opened; Referenced by with each count. Every value masked as the grid's.
// Each section's read and failure is its own (inspector-data.ts), Retry only where reading again can help. A JSON
// value's Open in JSON View shows the JSON view (JsonInspector.tsx) in the fields' place, Back brings them again.
// Keyboard: Enter in the grid shows or hides it (Tab there opens the record view; the panel takes
// the keyboard by a click), Esc closes it and gives the keyboard back to the grid; its keys are its own (no window
// listener, nothing taken from terminals or editors). TableView mounts it in the rows' box, its one place (a flip never
// mounts it again), and keeps it mounted, hidden, while the record view shows (it comes back as it was); beside the grid
// or over its rows when the tab is too narrow is decided here, from the tab's width TableView measures (`paneW`,
// inspectorLayout). A row's fields — their reads (useRowData) and their rows (FieldRow) — are the record view's too
// (RecordView.tsx): one rendering of a value, its masks, its JSON tree, its card. Lazy, with its stylesheet.
import './inspector.css';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react';
import type { DbCell, DbFk, DbPage, DbPeek, DbProblem, DbRefCount } from '@shared/databases';
import { typeClass, type DbColumn } from '@shared/databases-filters';
import { cellText, formatCell, formatTimestamp, isMasked, MASK, type DbTimes, type FormatOpts } from '@shared/pg-format';
import { copyText } from '../clipboard';
import { Icon } from '../components/Icon';
import { tdt } from '../i18n/db-table';
import { radioNext } from '../radio';
import { JsonView } from '../redis/RedisValue';
import { useApp } from '../store';
import { bytesLabel, mimeLabel } from './grid-model';
import {
  clampWidth, derivedFields, fieldOrder, fkOf, fullRequestOf, hiddenRequest, INSPECTOR_DEFAULT, INSPECTOR_MAX, INSPECTOR_MIN, inspectorLayout, keyOf, peekCard,
  peekRequest, referencedFilters, referencingFilters, refRow, refsRequest, resizeStep, rowFields, rowId, rowJsonText, shownRow, tableName, typeLine,
  widthCap, type Field
} from './inspector-model';
import { openFiltered, readFull, readMore, readPeek, readRefs, readRels, readsGen, useInsp, type Req, type RowReads } from './inspector-data';
import { setInspectorWidth, useInspectorWidth } from './inspector-width';
import { utf8Bytes } from './json';
import { JsonInspector, openJsonView } from './JsonInspector';
import { clipText, isJsonText, looksJsonContainer, maskJson, parseJson } from './json-text';
import { useDb, type DbTabState } from './store';
import type { DbTabRef } from './tabs';

type View = 'fields' | 'json';
const VIEWS: readonly View[] = ['fields', 'json'];
/** A row's reads wait for it to settle: holding ↓ through the rows asks nothing for those it passes. */
const SETTLE_MS = 120;
/** Characters of a value laid out at most (a 16 MB value read whole would freeze the window); the cell's Copy Value takes all. */
const TEXT_MAX = 256 * 1024;
/** A JSON value up to this many characters is a tree; past it, its text (the JSON view, reads big ones). */
const TREE_MAX = 512 * 1024;
const CHIPS_MAX = 200;
/** An image previewed from a bytea value: up to 2 MB. */
const IMAGE_MAX = 2 * 1024 * 1024;
const CUT_SHOWN = 64 * 1024;
const NO_FOLDS: ReadonlySet<string> = new Set();
const INSP_DEFAULT = { view: 'fields', more: false } as const;
/** Problems reading again can't change: a role that can't read, a row gone, a value over 16 MB. */
const FINAL: ReadonlySet<DbProblem['kind']> = new Set(['denied', 'norow', 'toolarge']);
const retryable = (p: DbProblem) => !FINAL.has(p.kind);

const patchTab = (key: string, p: Partial<DbTabState>) => useDb.getState().patchTab(key, p);
const tabNow = (key: string) => useDb.getState().tab(key);

const toast = (text: string, info: boolean) => useApp.getState().showToast(text, undefined, info ? 'info' : undefined);
function copyOut(text: string): void {
  void copyText(text).then((ok) => toast(ok ? tdt.insp.copied : tdt.insp.copyFailed, ok), () => toast(tdt.insp.copyFailed, false));
}

/** A bytea's hex (without \x) as base64, for an image's data URL. */
function hexBase64(hex: string): string {
  let bin = '';
  for (let i = 0; i + 1 < hex.length; i += 2) bin += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16));
  return btoa(bin);
}

/** An image held in a bytea value (previewed in the inspector, the data URL built here, once per value). */
function Preview({ mime, hex }: { mime: string; hex: string }) {
  const src = useMemo(() => `data:${mime};base64,${hexBase64(hex.slice(2))}`, [mime, hex]);
  return <img className="dbi-img" alt="" src={src} />;
}

/** A value as text, wrapped in its area; past TEXT_MAX characters its start (never half a surrogate pair) and a note. */
function LongText({ s, className = 'dbi-text' }: { s: string; className?: string }) {
  const cut = s.length > TEXT_MAX;
  return (
    <>
      <span className={className}>{cut ? clipText(s, TEXT_MAX) : s}</span>
      {cut && <span className="dbi-sub">{tdt.insp.clipped(bytesLabel(TEXT_MAX))}</span>}
    </>
  );
}

/** A read's failure in its place: why, and Retry where reading again can help. */
export function Failed({ text, p, onRetry }: { text: string; p: DbProblem; onRetry: () => void }) {
  return (
    <div className="dbi-err" role="alert">
      <Icon name="warning" size={12} />
      <span className="dbi-err-t" data-tip={p.message}>{text}</span>
      {retryable(p) && <button type="button" className="dbt-link" onClick={onRetry}>{tdt.insp.retry}</button>}
    </div>
  );
}

/**
 * A value as opened: exact, whole, wrapped in its area. JSON is JsonField's. `cut`: its whole
 * length when main cut it (a bytea's size is the server's).
 */
function Value({ v, col, o, cut }: { v: string | null; col: DbColumn; o: FormatOpts; cut?: number }): ReactNode {
  const view = formatCell(v, col, o, cut);
  switch (view.k) {
    case 'null': return <span className="dbt-nul">NULL</span>;
    case 'empty': return <span className="dbt-emp">{tdt.grid.empty}</span>;
    case 'blank': return <span className="dbt-blank">{'␣'.repeat(Math.min(3, view.count))}<span className="dbt-blank-n">{tdt.grid.spaces(view.count)}</span></span>;
    case 'masked': return <span className="dbt-mask">{MASK}</span>;
    // Exact digits, never grouped nor rounded ("1240.00").
    case 'num': return <span className={view.neg ? 'dbt-num is-neg' : 'dbt-num'}>{v}</span>;
    case 'bool': return <span className={`dbt-bool ${view.on ? 'is-t' : 'is-f'}`}><i />{view.on ? 'true' : 'false'}</span>;
    case 'time': {
      if (col.typeName === 'date' || v === null) return <span className="dbi-text">{view.text}</span>;
      const t = formatTimestamp(v, col.typeName === 'timestamptz' ? 'timestamptz' : 'timestamp', o);
      const sub = [t.rel, t.unix !== null ? tdt.insp.utc(t.utc.replace(/\+00$/, '')) : null, t.unix !== null ? tdt.insp.unixTime(String(t.unix)) : null].filter(Boolean).join(' · ');
      return <><span className="dbi-text">{view.text}</span>{sub && <span className="dbi-sub">{sub}</span>}</>;
    }
    case 'array': case 'lexemes': {
      const items = view.k === 'array' ? view.items.map((x) => ({ text: x ?? 'NULL', nul: x === null, pos: '' })) : view.items.map((x) => ({ text: x.word, nul: false, pos: x.pos }));
      if (items.length === 0) return <span className="dbt-ach is-more">{'{}'}</span>;
      return (
        <>
          <span className="dbi-chips">
            {items.slice(0, CHIPS_MAX).map((x, i) => <span key={i} className={x.nul ? 'dbt-ach is-null' : 'dbt-ach'}>{x.text}{x.pos ? <i>{x.pos}</i> : null}</span>)}
            {items.length > CHIPS_MAX && <span className="dbt-ach is-more">{`+${items.length - CHIPS_MAX}`}</span>}
          </span>
          <span className="dbi-sub">{tdt.insp.items(items.length)}</span>
        </>
      );
    }
    case 'enum': return <span className={`dbt-en t${view.tint}`}>{view.text}</span>;
    case 'bytes': {
      const image = view.mime?.startsWith('image/') && v !== null && view.size <= IMAGE_MAX && v.length === 2 + view.size * 2;
      return (
        <>
          {image && <Preview mime={view.mime!} hex={v!} />}
          <span className="dbi-bytes">
            {view.mime && <span className="dbt-ach">{mimeLabel(view.mime)}</span>}
            <span className="dbt-size">{bytesLabel(view.size)}</span>
          </span>
          {!image && v !== null && <LongText s={v} className="dbi-text dbi-hex" />}
        </>
      );
    }
    case 'json': case 'uuid': case 'range': case 'geo': case 'text': return <LongText s={view.k === 'text' || view.k === 'range' || view.k === 'geo' ? view.text : v ?? ''} />;
  }
}

/** A JSON value: its tree (masked keys as dots, numbers as written), or its text when it isn't whole JSON. */
function JsonField({ raw, o, folds, onToggle }: { raw: string; o: FormatOpts; folds: ReadonlySet<string>; onToggle: (p: string) => void }) {
  const text = useMemo(() => maskJson(raw, o.masked), [raw, o.masked]);
  const tree = useMemo(() => (text.length <= TREE_MAX ? parseJson(text) : undefined), [text]);
  if (tree === undefined) return <LongText s={text} />;
  return <div className="dbi-json"><JsonView value={tree} folds={folds} onToggle={onToggle} /></div>;
}

/** What a field row needs from the inspector (or the record view). */
export interface Ctx {
  tab: DbTabRef;
  page: DbPage;
  cells: readonly DbCell[];
  id: string;
  o: FormatOpts;
  rr: RowReads | undefined;
  key: Record<string, string> | null;
  fields: ReadonlyMap<string, Field>;
  folds: Readonly<Record<string, ReadonlySet<string>>>;
  fold: (field: string, path: string) => void;
  /** A JSON value offers Open in JSON View: the inspector's. */
  jsonView: boolean;
}

function FieldName({ name, col, type, size }: { name: string; col: DbColumn | null; type: string; size?: string }) {
  return (
    <div className="dbi-fk">
      <span className="dbi-fn" data-tip={name}>{col?.isPk && <Icon name="key" size={11} />}<span className="dbi-fn-t">{name}</span></span>
      {col && <span className="dbi-ft" data-tip={type}>{size ? `${type} · ${size}` : type}</span>}
    </div>
  );
}

/**
 * One field: name and type line, the value (Load full value for a cut one), a foreign key's peek card under it.
 * `fold`: its JSON folds' key (a JSON column's, its grid key).
 */
export function FieldRow({ c, name, fold, field, fk, pending }: { c: Ctx; name: string; fold?: string; field: Field | undefined; fk: DbFk | 'wait' | DbProblem | null; pending: ReactNode }) {
  if (!field) {
    return (
      <div className="dbi-f">
        <FieldName name={name} col={null} type="" />
        <div className="dbi-fv">{pending}</div>
      </div>
    );
  }
  const { col, cell } = field;
  const full = c.rr?.full[name];
  const whole = full?.s === 'ok' ? full.v : null;
  const v = whole ?? cell.v;
  const masked = isMasked(col, c.o);
  const isJsonCol = typeClass(col) === 'json';
  // A JSON column's object or array, as shown: cut, it is no longer whole JSON; loaded whole, it is again.
  const container = field.derived !== undefined && v !== null && looksJsonContainer(v);
  const cutNow = cell.cut !== undefined && whole === null;
  // Mask values on, a JSON value cut at 64 KB can't be read for its keys: dots whole, nothing to load.
  const hidden = masked || (c.o.masked && (isJsonCol || container) && cutNow);
  const json = !hidden && !cutNow && v !== null && (isJsonCol || (container && isJsonText(v)));
  // Open in JSON View: a JSON value, a cut one too (the view loads it whole), a JSON column's object or array.
  const openable = !hidden && v !== null && (isJsonCol || container);
  const open = openable && c.jsonView;
  // Its size: main's count for a value it cut (loaded whole since), else the value's own (64 KB at most).
  const size = json ? bytesLabel(cell.cut ?? utf8Bytes(v!)) : undefined;
  const folds = fold ?? name;
  return (
    <div className={`dbi-f${json || openable ? ' is-wide' : ''}`}>
      <FieldName name={name} col={col} type={field.type ?? typeLine(col, c.tab.schema)} size={size} />
      {(json || open) && (
        <div className="dbi-facts">
          {open && (
            <button type="button" className="icon-btn dbi-ib" aria-label={tdt.json.open} data-tip={tdt.json.open} data-json-open={name}
              onClick={() => openJsonView(c.tab.key, field.derived ? { column: field.derived.column, base: field.derived.path } : { column: name }, 'fields')}>
              <Icon name="tree" size={12} />
            </button>
          )}
          {json && (
            <button type="button" className="icon-btn dbi-ib" aria-label={tdt.insp.copyJson} data-tip={tdt.insp.copyJson} onClick={() => copyOut(maskJson(v!, c.o.masked))}>
              <Icon name="copy" size={12} />
            </button>
          )}
        </div>
      )}
      <div className="dbi-fv">
        {hidden ? <span className="dbt-mask">{MASK}</span>
          : json ? <JsonField raw={v!} o={c.o} folds={c.folds[folds] ?? NO_FOLDS} onToggle={(p) => c.fold(folds, p)} /> : <Value v={v} col={col} o={c.o} cut={cell.cut} />}
        {cutNow && !hidden && <CutNote c={c} name={name} field={field} cut={cell.cut!} full={full} />}
      </div>
      {fk !== null && <PeekCard c={c} fk={fk} />}
    </div>
  );
}

/**
 * A value main cut at 64 KB: how much shows, Load full value (by the row's key; a JSON column by its
 * column and path), or why it can't.
 */
function CutNote({ c, name, field, cut, full }: { c: Ctx; name: string; field: Field; cut: number; full: Req<string> | undefined }) {
  const load = (force: boolean) => {
    if (c.key) void readFull(c.tab.key, c.id, name, fullRequestOf(c.tab, c.key, name, field), force);
  };
  return (
    <div className="dbi-cut">
      <span className="dbi-cut-t">{tdt.insp.cut(bytesLabel(CUT_SHOWN), bytesLabel(cut))}</span>
      {!c.key ? <span className="dbi-dim">{tdt.insp.noKey}</span>
        : full?.s === 'err' ? <Failed text={tdt.insp.failed(full.p.message)} p={full.p} onRetry={() => load(true)} />
          : <button type="button" className="dbt-link" disabled={full?.s === 'wait'} aria-busy={full?.s === 'wait' || undefined} onClick={() => load(false)}>
            {full?.s === 'wait' ? tdt.insp.loadingFull : tdt.insp.loadFull}
          </button>}
    </div>
  );
}

/** A card waiting for its read: the same two lines as a read one (static UI). */
function PeekWait({ label }: { label: string }) {
  return (
    <div className="dbi-peek is-wait" aria-busy="true">
      <div className="dbi-peek-head"><span className="dbi-peek-label">{label}</span></div>
      <div className="dbi-peek-sub">&nbsp;</div>
    </div>
  );
}

/** A card's read failed: why on one line each (ellipsized, whole in the tooltip), Retry where it can help. */
function PeekFailed({ label, p, onRetry }: { label: string; p: DbProblem; onRetry: () => void }) {
  return (
    <div className="dbi-peek is-err" role="alert">
      <div className="dbi-peek-head">
        <span className="dbi-peek-label" data-tip={label}>{label}</span>
        {retryable(p) && <button type="button" className="dbi-peek-open" onClick={onRetry}>{tdt.insp.retry}</button>}
      </div>
      <div className="dbi-peek-sub" data-tip={p.message}><span className="dbi-peek-subt">{p.message}</span></div>
    </div>
  );
}

/**
 * The FK peek card: label · chip · Open › on one line (the label gives way first with an ellipsis,
 * the chip last, Open › never), the lines under it one each; narrower than ~300 px the chip goes to the first of them
 * (CSS). A masked enum's chip is neutral. Reading, failed, or no row behind the key: said in the same place.
 */
function PeekCard({ c, fk }: { c: Ctx; fk: DbFk | 'wait' | DbProblem }) {
  if (fk === 'wait') return <PeekWait label={tdt.insp.reading} />;
  if (!('name' in fk)) return <PeekFailed label={tdt.insp.failed(fk.message)} p={fk} onRetry={() => void readRels(c.tab.key, c.tab, true)} />;
  const table = tableName(fk.to, c.tab.schema);
  const r = c.rr?.peeks[fk.name];
  if (!r || r.s === 'wait') return <PeekWait label={tdt.insp.peek.reading(table)} />;
  if (r.s === 'err') {
    return (
      <PeekFailed label={tdt.insp.peek.failed(table)} p={r.p} onRetry={() => {
        const req = peekRequest(c.tab.connId, fk, (n) => c.fields.get(n)?.cell);
        if (req) void readPeek(c.tab.key, c.id, fk.name, req, true);
      }} />
    );
  }
  const card = peekCard(r.v, fk, c.tab.schema, c.o);
  if (!card) return <div className="dbi-peek is-none"><div className="dbi-peek-head"><span className="dbi-peek-label" data-tip={tdt.insp.peek.none(table)}>{tdt.insp.peek.none(table)}</span></div></div>;
  const filters = referencedFilters(fk, c.fields);
  const chip = (sub: boolean) => {
    if (!card.chip) return null;
    const cls = ['dbt-en', card.chip.tint !== null ? `t${card.chip.tint}` : '', 'dbi-peek-chip', card.chip.tint === null ? 'is-masked' : '', sub ? 'is-sub' : ''].filter(Boolean).join(' ');
    return <span className={cls} data-tip={card.chip.text}>{card.chip.text}</span>;
  };
  return (
    <div className="dbi-peek">
      <div className="dbi-peek-head">
        <span className="dbi-peek-label" data-tip={card.label}>{card.label}</span>
        {chip(false)}
        <button type="button" className="dbi-peek-open" data-tip={filters ? tdt.insp.peek.openTip(card.table) : tdt.insp.peek.cantOpen} disabled={!filters}
          onClick={() => { if (filters) openFiltered(c.tab.connId, { schema: fk.to.schema, name: fk.to.table }, filters, true); }}>
          {tdt.insp.peek.open}
        </button>
      </div>
      {card.subs.map((s, i) => (
        <div key={i} className="dbi-peek-sub" data-tip={s}>{i === 0 && chip(true)}<span className="dbi-peek-subt">{s}</span></div>
      ))}
    </div>
  );
}

/**
 * Referenced by: each foreign key pointing at this table, this row's count, a click opens them (a preview).
 * Rows with nothing to open stay focusable with their name in the tooltip (aria-disabled, item 14).
 */
function RefsSection({ c, refs, known }: { c: Ctx; refs: Req<DbRefCount[]> | undefined; known: readonly DbRefCount[] | null }) {
  const list = refs?.s === 'ok' ? refs.v : known;
  if (refs?.s === 'ok' && refs.v.length === 0) return null;
  if (!list && refs?.s !== 'err') return null;
  const counting = refs?.s !== 'ok';
  const retry = () => void readRefs(c.tab.key, c.id, refsRequest(c.tab, c.page, c.cells), true);
  return (
    <section className="dbi-refs" aria-label={tdt.insp.refs.title}>
      <h3 className="section-label dbi-sec">{tdt.insp.refs.title}</h3>
      {refs?.s === 'err' && <Failed text={tdt.insp.refs.failed} p={refs.p} onRetry={retry} />}
      {(list ?? []).map((rc) => {
        const row = refRow(rc, c.tab.schema);
        const filters = row.open && !counting ? referencingFilters(rc.fk, c.fields) : null;
        const name = `${row.table}${row.cols}`;
        return (
          <button key={rc.fk.name} type="button" className={`dbi-ref${counting ? ' is-wait' : !row.open ? ' is-none' : ''}`} aria-disabled={!filters || undefined}
            data-tip={counting ? name : row.tip}
            onClick={() => { if (filters) openFiltered(c.tab.connId, { schema: rc.fk.from.schema, name: rc.fk.from.table }, filters, true); }}>
            <Icon name="dbTable" size={14} />
            <span className="dbi-ref-t">{row.table}<span className="dbi-ref-c">{row.cols}</span></span>
            <span className="dbi-ref-n">{counting ? (refs?.s === 'err' ? '' : tdt.insp.refs.counting) : row.label}</span>
          </button>
        );
      })}
    </section>
  );
}

/** The whole row as a JSON tree: what Copy Row as JSON writes, masked, numbers as printed. */
function RowJson({ c, read, folds, onToggle }: { c: Ctx; read: DbPeek | null; folds: ReadonlySet<string>; onToggle: (p: string) => void }) {
  const text = useMemo(() => maskJson(rowJsonText(c.page, c.cells, read, c.tab, c.o), c.o.masked), [c.page, c.cells, read, c.tab, c.o]);
  const tree = useMemo(() => parseJson(text), [text]);
  return (
    <div className="dbi-rowjson">
      <div className="dbi-rowjson-head">
        <span className="section-label">{tdt.insp.views.json}</span>
        <button type="button" className="icon-btn dbi-ib" aria-label={tdt.insp.copyJson} data-tip={tdt.insp.copyJson} onClick={() => copyOut(text)}><Icon name="copy" size={12} /></button>
      </div>
      {tree === undefined ? <LongText s={text} /> : <div className="dbi-json is-row"><JsonView value={tree} folds={folds} onToggle={onToggle} /></div>}
    </div>
  );
}

/** What a row's fields need, read and shown: the inspector's and the record view's. */
export interface RowData {
  page: DbPage | null;
  cells: readonly DbCell[] | undefined;
  id: string | null;
  o: FormatOpts;
  rr: RowReads | undefined;
  /** The hidden fields' read, once in. */
  read: DbPeek | null;
  /** That read found no row: it is gone since. */
  gone: boolean;
  key: Record<string, string> | null;
  order: { shown: string[]; more: string[] };
  fields: ReadonlyMap<string, Field>;
  derived: readonly { key: string; name: string; field: Field }[];
  /** Each displayed foreign key's card, by the field it goes under (its first column shown). */
  placed: ReadonlyMap<string, DbFk | 'wait' | DbProblem>;
  /** Fields asked for aren't loaded: the row is read by its key. */
  needRead: boolean;
  folds: Readonly<Record<string, ReadonlySet<string>>>;
  fold: (field: string, path: string) => void;
  /** What a field row needs; null without a row. */
  c: Ctx | null;
  /** A hidden field not read yet: reading, or not read (no key to read it by, the read failed or found no row). */
  pending: ReactNode;
  /** The row's key for a head, each value as the grid shows it — masked when its column is; a table
   *  without a key: the row's place among those loaded. */
  keyText: string;
  /** The hidden fields' read again (its Retry). */
  retryMore: () => void;
}

/**
 * A row's fields and their reads (the record view's too): the grid's in its order and the others
 * — read for this row by its key once asked for (`more`: "N more fields" open, or the record view's every column) —,
 * the foreign keys' cards, Referenced by (`refs`: the inspector's). Each read waits for the row to settle (holding ↓
 * through the rows asks nothing for those it passes), and only while it is shown (`visible`). `jsonView`: a JSON value
 * offers Open in JSON View.
 */
export function useRowData({ tab, st, index, masked, times, visible, more, refs, jsonView }: {
  tab: DbTabRef; st: DbTabState; index: number | null; masked: boolean; times: DbTimes; visible: boolean; more: boolean; refs: boolean; jsonView: boolean;
}): RowData {
  const [folds, setFolds] = useState<Record<string, ReadonlySet<string>>>({});
  const page = st.data;
  const cells = index !== null ? st.rows[index] : undefined;
  // Ages ("2h") read the clock when the row is shown.
  const o = useMemo<FormatOpts>(() => ({ times, now: Date.now(), masked, width: 'full' }), [times, masked, index, page]);
  const id = page && cells && index !== null ? rowId(page, cells, index) : null;
  const reads = useInsp((s) => s.tabs[tab.key]);
  // The reads' generation: a new first page starts one, and every read below asks again for it.
  const gen = useInsp(readsGen(tab.key));
  const rr = id !== null ? reads?.rows[id] : undefined;
  const rels = reads?.rels;
  const read = rr?.more?.s === 'ok' ? rr.more.v : null;
  const gone = read !== null && read.row === null;

  const order = page ? fieldOrder(page, st.columns, st.tableCols ?? read?.columns ?? null) : { shown: [], more: [] };
  const fields = useMemo(() => (page && cells ? rowFields(page, cells, read) : new Map<string, Field>()), [page, cells, read]);
  const derived = useMemo(() => (page && cells ? derivedFields(page, cells, tab.schema) : []), [page, cells, tab.schema]);
  const shownNames = more ? [...order.shown, ...order.more] : order.shown;
  const inPage = (n: string) => !!page?.columns.some((c) => c.name === n);
  // The hidden fields are read for this row, by its key, once they are asked for and some aren't loaded.
  const needRead = more && (order.more.some((n) => !inPage(n)) || (!st.tableCols && st.columns !== null));
  const key = page && cells ? keyOf(page, cells) : null;

  // Each displayed foreign key's card goes under its first column shown; its read waits for the table's foreign keys.
  const out = rels?.s === 'ok' ? rels.v.out : null;
  const placed = new Map<string, DbFk | 'wait' | DbProblem>();
  const seen = new Set<string>();
  for (const n of shownNames) {
    const f = fields.get(n);
    if (!f?.col.fk || f.cell.v === null) continue;
    if (!out) { placed.set(n, rels?.s === 'err' ? rels.p : 'wait'); continue; }
    const fk = fkOf(n, out);
    if (!fk || seen.has(fk.name) || !peekRequest(tab.connId, fk, (c) => fields.get(c)?.cell)) continue;
    seen.add(fk.name);
    placed.set(n, fk);
  }
  const peekNames = [...placed.values()].map((x) => (typeof x === 'object' && 'name' in x ? x.name : '')).join('\n');
  const hasFk = !!page && (page.columns.some((c) => c.fk) || !!read?.columns.some((c) => c.fk));

  // The row's reads, once it settles: Referenced by (the inspector's), the table's foreign keys (once per tab and page).
  useEffect(() => {
    if (!visible || !page || !cells || id === null) return;
    const t = setTimeout(() => {
      if (refs) void readRefs(tab.key, id, refsRequest(tab, page, cells));
      if (hasFk) void readRels(tab.key, tab);
    }, SETTLE_MS);
    return () => clearTimeout(t);
  }, [visible, id, page?.columns, hasFk, tab.key, gen, refs]);
  // The cards' rows, once the foreign keys are known (and again when the hidden fields bring more).
  useEffect(() => {
    if (!visible || id === null || !out) return;
    const t = setTimeout(() => {
      for (const fk of placed.values()) {
        if (typeof fk !== 'object' || !('name' in fk)) continue;
        const req = peekRequest(tab.connId, fk, (c) => fields.get(c)?.cell);
        if (req) void readPeek(tab.key, id, fk.name, req);
      }
    }, SETTLE_MS);
    return () => clearTimeout(t);
  }, [visible, id, out, peekNames, fields, gen]);
  useEffect(() => {
    if (!visible || !needRead || id === null || !page || !cells) return;
    const req = hiddenRequest(tab, page, cells);
    if (!req) return;
    const t = setTimeout(() => void readMore(tab.key, id, req), SETTLE_MS);
    return () => clearTimeout(t);
  }, [visible, needRead, id, gen]);

  const fold = (field: string, path: string) => setFolds((f) => {
    const next = new Set(f[field] ?? NO_FOLDS);
    if (next.has(path)) next.delete(path); else next.add(path);
    return { ...f, [field]: next };
  });
  const c: Ctx | null = page && cells && id !== null ? { tab, page, cells, id, o, rr, key, fields, folds, fold, jsonView } : null;
  const keyText = key && page ? page.rowKey.map((k) => {
    const col = fields.get(k)?.col;
    return col ? cellText(key[k] ?? null, col, o) : key[k] ?? '';
  }).join(' · ') : index !== null ? tdt.insp.rowAt(index + 1) : '';
  const pending: ReactNode = !key || rr?.more?.s === 'err' || gone
    ? <span className="dbi-dim">{tdt.insp.notRead}</span>
    : <span className="dbi-dim" aria-busy="true">{tdt.insp.reading}</span>;
  const retryMore = () => {
    const req = page && cells ? hiddenRequest(tab, page, cells) : null;
    if (req && id !== null) void readMore(tab.key, id, req, true);
  };
  return { page, cells, id, o, rr, read, gone, key, order, fields, derived, placed, needRead, folds, fold, c, pending, keyText, retryMore };
}

/**
 * `paneW`: the tab's width as drawn (TableView measures it; 0: not yet). `hidden`: the record view shows:
 * kept mounted — its folds, its JSON view, its width come back as they were —, reading nothing meanwhile.
 */
export interface InspectorProps { tab: DbTabRef; st: DbTabState; masked: boolean; times: DbTimes; visible: boolean; paneW: number; hidden?: boolean }

export function Inspector({ tab, st, masked, times, visible, paneW, hidden = false }: InspectorProps) {
  const root = useRef<HTMLElement>(null);
  const [dragging, setDragging] = useState(false);
  // The app's width, the same in every tab.
  const width = useInspectorWidth((s) => s.width);
  const ui = st.insp ?? INSP_DEFAULT;
  const index = shownRow(st);
  const { page, id, o, rr, read, gone, key, order, fields, derived, needRead, folds, fold, placed, c, pending, keyText, retryMore } =
    useRowData({ tab, st, index, masked, times, visible: visible && !hidden, more: ui.more, refs: true, jsonView: true });
  // The last Referenced by seen in this tab: shown while the next row counts, so the section doesn't jump.
  const known = useRef<readonly DbRefCount[] | null>(null);
  if (rr?.refs?.s === 'ok') known.current = rr.refs.v;

  // ---------- actions ----------

  const setUi = (p: Partial<typeof ui>) => patchTab(tab.key, { insp: { ...(tabNow(tab.key).insp ?? INSP_DEFAULT), ...p } });
  /** The grid's focus to the previous or next row (the grid scrolls there, its Shift anchor with it); the panel stays. */
  const move = (d: 1 | -1) => {
    const now = tabNow(tab.key);
    const n = now.rows.length;
    if (n === 0) return;
    const from = shownRow(now) ?? (d > 0 ? -1 : n);
    const to = Math.max(0, Math.min(n - 1, from + d));
    if (to === from) return;
    const first = now.data ? now.data.columns.findIndex((c) => !now.data!.hidden.includes(c.name)) : 0;
    patchTab(tab.key, { selection: [to], focus: { row: to, col: now.focus?.col ?? Math.max(0, first) } });
  };
  /** Esc or ×: closed (its JSON view with it), the keyboard back to the grid (the tab itself while it has no rows). */
  const close = () => {
    const tabEl = root.current?.closest<HTMLElement>('.dbt');
    patchTab(tab.key, { inspector: false, json: null });
    (tabEl?.querySelector<HTMLElement>('.dbt-grid') ?? tabEl)?.focus({ preventScroll: true });
  };
  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === 'Escape') {
      // The inspector's own: nothing else in the window hears it.
      e.preventDefault();
      e.stopPropagation();
      close();
      return;
    }
    if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && !e.shiftKey) {
      e.preventDefault();
      // The control under the keyboard may go with the row: the panel keeps the keyboard.
      if (e.target !== root.current) root.current?.focus({ preventScroll: true });
      move(e.key === 'ArrowDown' ? 1 : -1);
    }
  };

  // ---------- the width ----------

  const lay = inspectorLayout(paneW, width);
  const cap = widthCap(paneW, lay.overlay);
  // What the user chose is kept, whole: the tab's width caps what is drawn (inspectorLayout), not this —
  // and it is the app's, so every tab draws it and the next start too.
  const setWidth = (w: number) => setInspectorWidth(w);
  /** A drag moves the panel's edge itself (nothing drawn again on the way, as far as the cap); the width is kept on release. */
  const startDrag = (e: PointerEvent<HTMLDivElement>) => {
    const panel = root.current;
    if (e.button !== 0 || !panel) return;
    e.preventDefault();
    const el = e.currentTarget;
    el.setPointerCapture?.(e.pointerId);
    const x0 = e.clientX;
    const w0 = lay.width;
    let w = w0;
    setDragging(true);
    document.documentElement.classList.add('is-resizing');
    const moveTo = (ev: globalThis.PointerEvent) => {
      w = clampWidth(w0 - (ev.clientX - x0));
      panel.style.width = `${Math.min(cap, w)}px`;
    };
    const up = () => {
      el.removeEventListener('pointermove', moveTo);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      document.documentElement.classList.remove('is-resizing');
      setDragging(false);
      if (w !== w0) setWidth(w);
      else panel.style.width = `${w0}px`;
    };
    el.addEventListener('pointermove', moveTo);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  };

  // ---------- render ----------

  const n = st.rows.length;
  const moreNames = order.more.join(', ');
  // The JSON view in the fields' place: its value is a field of this row — a column's, or a JSON
  // column's (by its column and path) — read whole by Load full value as the field's own (the same read, the same key).
  const jv = st.json;
  const jsonOf = (): { name: string; field: Field | undefined } => {
    if (!jv) return { name: '', field: undefined };
    if (!jv.base) return { name: jv.column, field: fields.get(jv.column) };
    const d = derived.find((x) => x.field.derived!.column === jv.column && x.field.derived!.path.length === jv.base!.length && x.field.derived!.path.every((p, i) => p === jv.base![i]));
    return d ? { name: d.name, field: d.field } : { name: `${jv.column} → ${jv.base.join('.')}`, field: undefined };
  };
  const jf = jsonOf();
  // A json column (not jsonb) keeps its text as stored: the JSON view's Raw shows it so.
  const stored = !!jv && (page?.columns.find((x) => x.name === jv.column) ?? st.tableCols?.find((x) => x.name === jv.column))?.typeName === 'json';
  const jsonView = jv ? (
    <JsonInspector key={`${jv.column}\n${(jv.base ?? []).join('\n')}`} tab={tab} st={st} json={jv} name={jf.name} field={c ? jf.field : undefined} o={o}
      rowLabel={c ? keyText : ''} rowKey={c ? key : null} stored={stored} full={rr?.full[jf.name]} canLoad={!!key}
      onLoad={(force) => { if (key && jf.field && id !== null) void readFull(tab.key, id, jf.name, fullRequestOf(tab, key, jf.name, jf.field), force); }} />
  ) : null;
  return (
    <aside ref={root} className={`dbi${lay.overlay ? ' is-over' : ''}`} role="complementary" aria-label={tdt.insp.label} tabIndex={-1}
      style={hidden ? { width: lay.width, display: 'none' } : { width: lay.width }} onKeyDown={onKeyDown}>
      <div role="separator" aria-orientation="vertical" aria-label={tdt.insp.resize} tabIndex={0} aria-valuenow={lay.width} aria-valuemin={INSPECTOR_MIN} aria-valuemax={INSPECTOR_MAX}
        className={`resizer dbi-rs${dragging ? ' is-dragging' : ''}`} data-tip={tdt.insp.resizeTip} onPointerDown={startDrag}
        onDoubleClick={() => setWidth(INSPECTOR_DEFAULT)}
        onKeyDown={(e) => {
          // From the width drawn (a narrow tab draws it narrower than kept): the edge moves at once.
          const w = resizeStep(e.key, lay.width);
          if (w === null) return;
          e.preventDefault();
          setWidth(w);
        }} />
      {jsonView ?? <>
      <div className="dbi-head">
        <span className="section-label">{tdt.insp.row}</span>
        <span className="dbi-key mono" data-tip={keyText || undefined}>{keyText}</span>
        <span className="dbi-sp" />
        <div className="dk-views dbi-views" role="radiogroup" aria-label={tdt.insp.viewsLabel} onKeyDown={(e) => {
          const next = radioNext(VIEWS, ui.view, e.key);
          if (next === null) return;
          e.preventDefault();
          setUi({ view: next });
          (e.currentTarget.querySelector(`[data-value="${next}"]`) as HTMLElement | null)?.focus();
        }}>
          {VIEWS.map((v) => (
            <button key={v} type="button" role="radio" aria-checked={ui.view === v} tabIndex={ui.view === v ? 0 : -1} data-value={v} className={ui.view === v ? 'is-on' : undefined}
              onClick={() => setUi({ view: v })}>{tdt.insp.views[v]}</button>
          ))}
        </div>
        <button type="button" className="icon-btn dbi-ib" aria-label={tdt.insp.prev} data-tip={tdt.insp.prev} disabled={index === null || index === 0} onClick={() => move(-1)}>
          <Icon name="arrowUp" size={14} />
        </button>
        <button type="button" className="icon-btn dbi-ib" aria-label={tdt.insp.next} data-tip={tdt.insp.next} disabled={index !== null && index >= n - 1} onClick={() => move(1)}>
          <Icon name="arrowDown" size={14} />
        </button>
        <button type="button" className="icon-btn dbi-ib" aria-label={tdt.insp.close} data-tip={tdt.insp.close} onClick={close}><Icon name="x" size={14} /></button>
      </div>
      <div className="dbi-body">
        {!c ? <p className="dbi-empty">{tdt.insp.none}</p> : ui.view === 'json' ? (
          <RowJson c={c} read={read} folds={folds.$row ?? NO_FOLDS} onToggle={(p) => fold('$row', p)} />
        ) : (
          <>
            {order.shown.map((name) => <FieldRow key={name} c={c} name={name} field={fields.get(name)} fk={placed.get(name) ?? null} pending={pending} />)}
            {/* The grid's JSON columns, after the table's own. */}
            {derived.map((d) => <FieldRow key={d.key} c={c} name={d.name} fold={d.key} field={d.field} fk={null} pending={pending} />)}
            {order.more.length > 0 && (
              <button type="button" className="dbi-more" aria-expanded={ui.more} data-tip={tdt.insp.moreTip(ui.more)} onClick={() => setUi({ more: !ui.more })}>
                <Icon name={ui.more ? 'chevronDown' : 'chevron'} size={12} />
                <span className="dbi-more-n">{tdt.insp.more(order.more.length)}</span>
                <span className="dbi-more-names mono" data-tip={moreNames}>{` · ${moreNames}`}</span>
              </button>
            )}
            {ui.more && order.more.length > 0 && (
              <div className="dbi-morelist">
                {!key && needRead && <p className="dbi-dim dbi-note">{tdt.insp.noKeyMore}</p>}
                {gone && <p className="dbi-dim dbi-note">{tdt.insp.gone}</p>}
                {rr?.more?.s === 'err' && <Failed text={tdt.insp.failed(rr.more.p.message)} p={rr.more.p} onRetry={retryMore} />}
                {order.more.map((name) => <FieldRow key={name} c={c} name={name} field={fields.get(name)} fk={placed.get(name) ?? null} pending={pending} />)}
              </div>
            )}
            <RefsSection c={c} refs={rr?.refs} known={known.current} />
          </>
        )}
      </div>
      </>}
    </aside>
  );
}
