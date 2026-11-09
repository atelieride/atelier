// The JSON view: a JSON value of the row inspector's row, in the inspector's
// place (its fields come back with ←, Esc). Head: Back, the column, the row and the size, Tree · Table · Raw, Close.
// Tree: find a key or value over the tree's data (↑/↓ between the hits, revealed where they are folded), Expand all,
// the breadcrumb of the selected node (ellipsized from the left: the leaf stays), line numbers, folds (depth ≥ 3 at first,
// "… N more" past 50 items, a budget of lines), the JSON navigation colors, unix times, URLs opening in the browser,
// strings holding JSON parsed in place (losslessly, marked), a note when a json value repeats a key; a node's hover
// actions (JsonLine.tsx) Copy, Path, SQL, Filter (the filter popover's pathEq / pathNull / pathExists), + Column (keeps
// the preview, reloads). Table (JsonTable.tsx): an array of objects, the union of its keys.
// Raw (JsonRaw.tsx): a json value as stored, a jsonb one pretty-printed, Copy all. The bottom bar: Path and SQL of the
// selected node, each with Copy. Every number as Postgres printed it (json-text.ts's lossless trees); Mask values'
// dots in what shows and what copies, a Table under a secret key refused. Big values: parsed after the panel shows,
// rows virtualized (a fixed line height, the lines on screen), find a slice at a time, Raw capped. Keyboard: the tree's
// ↑/↓ ←/→ Home End Enter, ⌘F finds, Esc closes the find then the view (the keyboard back where it came from); its keys
// are its own — no window listener. Lazy, with the table's chunk and its stylesheet.
import './json-tools.css';
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type MouseEvent, type ReactNode, type RefObject } from 'react';
import { PATH_KEYS_MAX, type DbPath } from '@shared/databases-filters';
import { isMod } from '@shared/keys';
import { isMasked, MASK, type FormatOpts } from '@shared/pg-format';
import { Icon, type IconName } from '../components/Icon';
import { tdt } from '../i18n/db-table';
import type { MenuItem } from '../menu-model';
import { radioNext } from '../radio';
import { useApp } from '../store';
import { addDerived, addFilterKeepingRow, pickOf } from './filter-actions';
import { MAX_FILTERS } from './filters';
import { bytesLabel } from './grid-model';
import type { Req } from './inspector-data';
import type { Field } from './inspector-model';
import {
  budgetHidden, budgetOf, crumbs, DERIVED_MAX, escClearsFind, findHits, idOf, jsonPathSql, jsonPathText, jsonRows, lineMenu, MAX_ITEMS, MAX_KEYS, MORE_STEP, nodeAt,
  nodeCopy, nodeDerived, nodeFilter, parsedAlong, parseString, revealPath, ROW_BUDGET, secretKey, startFind, tableTargetOf, treeKey, utf8Bytes, visiblePath,
  type JsonNode, type JsonRow, type LineMenuId, type TreeBudget
} from './json';
import { clipText, parseJsonInfo } from './json-text';
import { copyOut, useRange } from './json-ui';
import { Line, type RowActs } from './JsonLine';
import { JsonRaw } from './JsonRaw';
import { JsonTable } from './JsonTable';
import { useDb, type DbTabState } from './store';
import type { DbTabRef } from './tabs';

type JsonView = 'tree' | 'table' | 'raw';
const VIEWS: readonly JsonView[] = ['tree', 'table', 'raw'];
/** A tree line's height: fixed, so the lines on screen are known without measuring. */
const ROW_H = 20;
/** A value this long is parsed after the panel has drawn ("Reading the value…"), never in the click that opened it. */
const BIG = 1 << 20;
/** Nodes find reads a slice; a big value is searched once typing stops. */
const FIND_SLICE = 20_000;
const FIND_WAIT = 60;
const FIND_WAIT_BIG = 220;
/** "… N more" shows this many more lines past the budget too; a hit past it doubles it, up to the most. */
const BUDGET_STEP = 10_000;
const BUDGET_MAX = 1_000_000;
const NO: ReadonlySet<string> = new Set();
const NONE: ReadonlyMap<string, number> = new Map();
const NO_PATH: DbPath = [];

const db = () => useDb.getState();
const toast = (text: string, info = true) => useApp.getState().showToast(text, undefined, info ? 'info' : undefined);
const samePath = (a: readonly (string | number)[], b: readonly (string | number)[]) => a.length === b.length && a.every((p, i) => p === b[i]);

// ---------- opening and closing ----------

/** Tabs whose JSON view was just opened: the view takes the keyboard once, never when it is only drawn again. */
const opened = new Set<string>();

/**
 * Open in JSON View: from the grid (a double click, the cell menu) or the inspector's field. `column` and
 * `base` name the value (a JSON column: its column and path); the inspector shows (it opens if it was closed: Esc closes
 * both then), the root selected.
 */
export function openJsonView(key: string, target: { column: string; base?: DbPath }, from: 'grid' | 'fields'): void {
  const st = db().tab(key);
  const base = target.base && target.base.length > 0 ? { base: [...target.base] } : {};
  // The view already open on this value stays mounted (keyed by its value): a mark would wait for some later mount and
  // take the keyboard then. Another value mounts another view, which takes it.
  const same = st.inspector && st.json !== null && st.json.column === target.column && samePath(st.json.base ?? [], target.base ?? []);
  if (!same) opened.add(key);
  db().patchTab(key, { inspector: true, json: { column: target.column, ...base, path: [], from, opened: !st.inspector } });
}

/** Whether this tab's JSON view was just opened (once: the view drawn again — another window, a tab shown — never is). */
export function takeOpened(key: string): boolean {
  return opened.delete(key);
}

/**
 * What closing the JSON view does: Back — the fields again, the keyboard in the panel; Close — the inspector closes, the
 * grid has the keyboard; Esc — back where it was opened from: the fields, or the grid (and the inspector closes again
 * if the view opened it).
 */
export function jsonClosing(json: DbTabState['json'], how: 'back' | 'esc' | 'close'): { patch: Partial<DbTabState>; focus: 'grid' | 'panel' } {
  if (how === 'close') return { patch: { json: null, inspector: false }, focus: 'grid' };
  if (how === 'esc' && json?.from === 'grid') return { patch: json.opened ? { json: null, inspector: false } : { json: null }, focus: 'grid' };
  return { patch: { json: null }, focus: 'panel' };
}

function close(key: string, how: 'back' | 'esc' | 'close', from: HTMLElement | null, field: string): void {
  const tabEl = from?.closest<HTMLElement>('.dbt') ?? null;
  const { patch, focus } = jsonClosing(db().tab(key).json, how);
  db().patchTab(key, patch);
  // After the panel draws its fields again: the button that opened the view, else the panel; or the grid.
  requestAnimationFrame(() => {
    if (focus === 'grid') { (tabEl?.querySelector<HTMLElement>('.dbt-grid') ?? tabEl)?.focus({ preventScroll: true }); return; }
    const panel = tabEl?.querySelector<HTMLElement>('.dbi');
    const btn = [...(panel?.querySelectorAll<HTMLElement>('[data-json-open]') ?? [])].find((b) => b.dataset.jsonOpen === field);
    (btn ?? panel)?.focus({ preventScroll: true });
  });
}

// ---------- hooks ----------

interface Read { tree: JsonNode | undefined; duplicates: boolean }
const NOT_READ: Read = { tree: undefined, duplicates: false };
const read = (raw: string): Read => {
  const r = parseJsonInfo(raw);
  return { tree: r.value as JsonNode | undefined, duplicates: r.duplicates };
};

/** The value's tree (and whether a key repeated): parsed at once when small; a big one after the panel has drawn. */
function useTree(raw: string | null): Read & { reading: boolean } {
  const small = raw !== null && raw.length < BIG;
  const now = useMemo(() => (raw !== null && small ? read(raw) : NOT_READ), [raw, small]);
  const [big, setBig] = useState<{ raw: string; r: Read } | null>(null);
  useEffect(() => {
    if (raw === null || small) return;
    const t = setTimeout(() => setBig({ raw, r: read(raw) }), 16);
    return () => clearTimeout(t);
  }, [raw, small]);
  if (raw === null) return { ...NOT_READ, reading: false };
  if (small) return { ...now, reading: false };
  return big?.raw === raw ? { ...big.r, reading: false } : { ...NOT_READ, reading: true };
}

interface Found { q: string; hits: DbPath[]; capped: boolean; done: boolean }
const NOT_FOUND: Found = { q: '', hits: [], capped: false, done: true };

/** Find over the tree's data (json.ts startFind): a slice at a time, after typing pauses (longer for a big value). */
function useFind(tree: JsonNode | undefined, q: string, parsed: ReadonlySet<string>, secret: ((k: string) => boolean) | null, big: boolean): Found {
  const [found, setFound] = useState<Found>(NOT_FOUND);
  useEffect(() => {
    if (tree === undefined || q.trim() === '') { setFound(NOT_FOUND); return; }
    let stop = false;
    let timer: ReturnType<typeof setTimeout>;
    const f = startFind(tree, q, parsed, secret);
    const run = () => {
      if (stop) return;
      const done = f.step(FIND_SLICE);
      setFound({ q, hits: f.hits.slice(), capped: f.capped, done });
      if (!done) timer = setTimeout(run, 0);
    };
    timer = setTimeout(run, big ? FIND_WAIT_BIG : FIND_WAIT);
    return () => { stop = true; clearTimeout(timer); };
  }, [tree, q, parsed, secret, big]);
  return found;
}

// ---------- the view ----------

export interface JsonInspectorProps {
  tab: DbTabRef;
  st: DbTabState;
  json: NonNullable<DbTabState['json']>;
  /** The field's name: the column's, a JSON column's label. */
  name: string;
  /** The row's field (undefined: no row, or the column isn't in the rows loaded). */
  field: Field | undefined;
  o: FormatOpts;
  /** The row's key as the inspector's head shows it ("" without a row). */
  rowLabel: string;
  /** The row's key (its values by column): Filter and + Column select this row again after the reload. */
  rowKey: Readonly<Record<string, string>> | null;
  /** A json column (not jsonb): its text is as stored — Raw shows it so. */
  stored: boolean;
  /** Load full value's read of this field (a value cut at 64 KB). */
  full: Req<string> | undefined;
  /** The row has a key to read the whole value by. */
  canLoad: boolean;
  onLoad: (force: boolean) => void;
}

/** The value's state: what the view shows instead of a tree. */
type ValueState = { k: 'norow' } | { k: 'nofield' } | { k: 'null' } | { k: 'masked' } | { k: 'cut'; total: number } | { k: 'value'; raw: string };

function valueState(p: JsonInspectorProps): ValueState {
  if (!p.field) return { k: p.rowLabel === '' ? 'norow' : 'nofield' };
  const whole = p.full?.s === 'ok' ? p.full.v : null;
  const v = whole ?? p.field.cell.v;
  if (v === null) return { k: 'null' };
  if (isMasked(p.field.col, p.o)) return { k: 'masked' };
  const cut = p.field.cell.cut;
  if (cut !== undefined && whole === null) return p.o.masked ? { k: 'masked' } : { k: 'cut', total: cut };
  return { k: 'value', raw: v };
}

export function JsonInspector(p: JsonInspectorProps) {
  const { tab, json, name, o } = p;
  const root = useRef<HTMLDivElement>(null);
  const state = valueState(p);
  const raw = state.k === 'value' ? state.raw : null;
  const { tree, reading, duplicates } = useTree(raw);
  const size = useMemo(() => (raw === null ? null : bytesLabel(p.field?.cell.cut ?? utf8Bytes(raw))), [raw, p.field?.cell.cut]);
  const [view, setView] = useState<JsonView>('tree');
  // Strings shown parsed: the view's (the Table's target and every path go through them), kept while rows change.
  const [parsed, setParsed] = useState<ReadonlySet<string>>(NO);
  const secret = o.masked ? secretKey : null;
  const ready = tree !== undefined;
  // Which array the Table shows, once per value, selection and parse; under a secret key, refused.
  const target = useMemo(() => (tree === undefined ? null : tableTargetOf(tree, json.path as DbPath, parsed, secret)), [tree, json.path, parsed, secret]);
  const canTable = Array.isArray(target);
  const shownView: JsonView = view === 'table' && !canTable ? 'tree' : view;
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.defaultPrevented) return;
    // ⌘F (Ctrl+F on Windows) anywhere in the view: the Tree's find (the view's own key, never the window's).
    if (isMod(e) && !e.shiftKey && !e.altKey && (e.code === 'KeyF' || e.key.toLowerCase() === 'f')) {
      const find = root.current?.querySelector<HTMLInputElement>('.dbj-find input');
      if (!find) return;
      e.preventDefault();
      e.stopPropagation();
      find.focus();
      find.select();
      return;
    }
    if (e.key === 'Escape' && !e.metaKey && !e.ctrlKey && !e.altKey) {
      // The find's own Esc came first (it clears); this one closes the view — nothing else in the window hears it.
      e.preventDefault();
      e.stopPropagation();
      close(tab.key, 'esc', root.current, name);
    }
  };
  const meta = tdt.json.rowAt(p.rowLabel, size ?? (p.field?.cell.cut !== undefined ? bytesLabel(p.field.cell.cut) : ''));
  // The keyboard comes here when the view opens (Esc works at once; the tree takes it when the value is read) — only
  // then: drawn again (another window, the tab shown again), it stays where it is.
  // A value read at once (its tree drawn in this same render): the tree itself — its effect ran before this one (the e2e).
  useEffect(() => { if (takeOpened(tab.key)) (root.current?.querySelector<HTMLElement>('.dbj-tree') ?? root.current)?.focus({ preventScroll: true }); }, []);
  const tableTip = !ready ? undefined : target === 'masked' ? tdt.json.tableMasked : !canTable ? tdt.json.tableNone : undefined;
  return (
    <div ref={root} className="dbj" role="region" aria-label={tdt.json.label} tabIndex={-1} onKeyDown={onKeyDown}>
      <div className="dbj-head">
        <button type="button" className="icon-btn dbj-ib" aria-label={tdt.json.back} data-tip={tdt.json.back} onClick={() => close(tab.key, 'back', root.current, name)}>
          <Icon name="chevronLeft" size={14} />
        </button>
        <BracesGlyph />
        <span className="dbj-title">
          <span className="dbj-name mono" data-tip={name}>{name}</span>
          {meta && <span className="dbj-meta mono" data-tip={meta}>{meta}</span>}
        </span>
        <div className="dk-views dbj-views" role="radiogroup" aria-label={tdt.json.viewsLabel} onKeyDown={(e) => {
          const next = radioNext(VIEWS.filter((v) => v !== 'table' || canTable), shownView, e.key);
          if (next === null) return;
          e.preventDefault();
          setView(next);
          (e.currentTarget.querySelector(`[data-value="${next}"]`) as HTMLElement | null)?.focus();
        }}>
          {VIEWS.map((v) => {
            const off = v === 'table' && !canTable;
            return (
              <button key={v} type="button" role="radio" aria-checked={shownView === v} tabIndex={shownView === v ? 0 : -1} data-value={v} disabled={!ready || off}
                className={shownView === v ? 'is-on' : undefined} data-tip={off ? tableTip : undefined} onClick={() => setView(v)}>
                {tdt.json.views[v]}
              </button>
            );
          })}
        </div>
        <button type="button" className="icon-btn dbj-ib" aria-label={tdt.json.close} data-tip={tdt.json.close} onClick={() => close(tab.key, 'close', root.current, name)}>
          <Icon name="x" size={14} />
        </button>
      </div>
      {ready ? (
        <Value p={p} tree={tree} view={shownView} big={raw!.length >= BIG} root={root} parsed={parsed} setParsed={setParsed} secret={secret}
          target={canTable ? target : null} duplicates={duplicates} stored={p.stored ? raw : null} />
      ) : <StateCard p={p} state={state} reading={reading} raw={raw} />}
    </div>
  );
}

/** Board 2's braces glyph, drawn here rather than in Icon.tsx: the first paint carries none of it. */
function BracesGlyph() {
  return (
    <svg className="dbj-glyph" width={14} height={14} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M7.5 3.5c-2 0-2 1-2 2.5v1.5c0 1.2-.7 2-1.8 2.5 1.1.5 1.8 1.3 1.8 2.5V14c0 1.5 0 2.5 2 2.5M12.5 3.5c2 0 2 1 2 2.5v1.5c0 1.2.7 2 1.8 2.5-1.1.5-1.8 1.3-1.8 2.5V14c0 1.5 0 2.5-2 2.5" />
    </svg>
  );
}

/** What shows instead of the tree: no row, no such column, NULL, masked, cut (Load full value), reading, not JSON. */
function StateCard({ p, state, reading, raw }: { p: JsonInspectorProps; state: ValueState; reading: boolean; raw: string | null }) {
  const j = tdt.json;
  let body: ReactNode;
  if (state.k === 'norow') body = <p className="dbj-state-t">{j.noRow}</p>;
  else if (state.k === 'nofield') body = <p className="dbj-state-t">{j.notLoaded}</p>;
  else if (state.k === 'null') body = <><span className="dbt-nul">NULL</span><p className="dbj-state-t">{j.nullValue}</p></>;
  else if (state.k === 'masked') body = <><span className="dbt-mask">{MASK}</span><p className="dbj-state-t">{j.masked}</p></>;
  else if (state.k === 'cut') {
    const f = p.full;
    body = (
      <>
        <p className="dbj-state-t is-cut">{tdt.insp.cut(bytesLabel(64 * 1024), bytesLabel(state.total))}</p>
        {!p.canLoad ? <p className="dbj-state-t">{tdt.insp.noKey}</p>
          : f?.s === 'err' ? <><p className="dbj-state-t is-err" role="alert">{tdt.insp.failed(f.p.message)}</p><button type="button" className="btn-ghost sm" onClick={() => p.onLoad(true)}>{tdt.insp.retry}</button></>
            : <button type="button" className="btn-ghost sm" disabled={f?.s === 'wait'} aria-busy={f?.s === 'wait' || undefined} onClick={() => p.onLoad(false)}>
              {f?.s === 'wait' ? tdt.insp.loadingFull : tdt.insp.loadFull}
            </button>}
      </>
    );
  } else if (reading) body = <p className="dbj-state-t" aria-busy="true">{j.reading}</p>;
  else body = <><p className="dbj-state-t">{j.notJsonValue}</p>{raw !== null && <pre className="dbj-state-raw mono">{clipText(raw, 4096)}</pre>}</>;
  return <div className="dbj-state" role="status">{body}</div>;
}

interface ValueProps {
  p: JsonInspectorProps;
  tree: JsonNode;
  view: JsonView;
  big: boolean;
  root: RefObject<HTMLDivElement | null>;
  parsed: ReadonlySet<string>;
  setParsed: (f: (x: ReadonlySet<string>) => ReadonlySet<string>) => void;
  secret: ((k: string) => boolean) | null;
  /** The Table's array (JsonInspector's tableTargetOf), when it has one. */
  target: DbPath | null;
  duplicates: boolean;
  /** A json column's text as stored (Raw shows it); null for jsonb. */
  stored: string | null;
}

/** A whole JSON value: the find bar (Tree), the breadcrumb, the view, the bottom bar. */
function Value({ p, tree, view, big, root, parsed, setParsed, secret, target, duplicates, stored }: ValueProps) {
  const { tab, json, o } = p;
  const column = json.column;
  const base = (json.base ?? NO_PATH) as DbPath;
  const uid = useId();
  const treeEl = useRef<HTMLDivElement>(null);
  const [folds, setFolds] = useState<ReadonlySet<string>>(NO);
  const [shown, setShown] = useState<ReadonlyMap<string, number>>(NONE);
  const [all, setAll] = useState(false);
  // Lines built at most: "… N more" and a hit past them take it further — for this value only:
  // another row's value starts from the first budget again.
  const [grown, setGrown] = useState<TreeBudget>(() => ({ tree, n: ROW_BUDGET }));
  const budget = budgetOf(grown, tree);
  const setBudget = (f: (n: number) => number) => setGrown((g) => ({ tree, n: f(budgetOf(g, tree)) }));
  const [q, setQ] = useState('');
  const [cur, setCur] = useState(-1);
  // A "… N more" line has the keyboard (it is no node: the selection stays its container's).
  const [moreAt, setMoreAt] = useState<string | null>(null);
  // Bumped to scroll the selected line into view again when the selection itself didn't change.
  const [tick, setTick] = useState(0);
  const reveal = useRef(false);
  const zone = useMemo(() => ({ times: o.times, ...(o.tz ? { tz: o.tz } : {}) }), [o.times, o.tz]);
  const rows = useMemo(() => jsonRows(tree, folds, parsed, { all, shown, secret, zone, budget }), [tree, folds, parsed, all, shown, secret, zone, budget]);
  const index = useMemo(() => {
    const m = new Map<string, number>();
    rows.forEach((r, i) => { if (r.role !== 'close') m.set(r.id, i); });
    return m;
  }, [rows]);
  const sel = json.path as DbPath;
  const selIndex = (moreAt !== null ? index.get(moreAt) : undefined) ?? index.get(idOf(sel)) ?? -1;
  const found = useFind(tree, q, parsed, secret, big);
  const hitRows = useMemo(() => new Set(findHits(rows, q)), [rows, q]);
  const curHit = cur >= 0 ? found.hits[cur] : undefined;

  /** The selected node (the bottom bar, the breadcrumb, the Table view): kept with the tab. */
  const select = (path: DbPath, show: boolean) => {
    setMoreAt(null);
    reveal.current = show;
    const now = db().tab(tab.key).json;
    if (now && !samePath(now.path, path)) db().patchTab(tab.key, { json: { ...now, path: [...path] } });
    else if (show) setTick((t) => t + 1);
  };
  /** A node shown wherever it is: its ancestors opened, enough items shown, selected, scrolled to. */
  const goTo = (path: DbPath) => {
    const r = revealPath(tree, path, { folds, shown, parsed, all });
    setFolds(r.folds);
    setShown(r.shown);
    select(path, true);
  };
  const goHit = (i: number) => {
    const n = found.hits.length;
    if (n === 0) return;
    const k = ((i % n) + n) % n;
    setCur(k);
    goTo(found.hits[k]!);
  };
  // A new find, or another row's value: its first hit, as soon as it is found (the keyboard stays where it is).
  useEffect(() => { setCur(-1); }, [q, tree]);
  useEffect(() => {
    if (cur === -1 && found.q === q && q.trim() !== '' && found.hits.length > 0) goHit(0);
  }, [found, q, cur]);

  // The selected line in view after a key, a hit, a breadcrumb step; past the budget, the budget grows until it shows —
  // only for a node the budget hides (one folded away, or past a "… N more", shows by opening, not by more lines).
  useLayoutEffect(() => {
    const el = treeEl.current;
    if (!reveal.current || !el) return;
    if (selIndex < 0) {
      if (rows.length >= budget && budget < BUDGET_MAX && nodeAt(tree, sel, parsed) !== undefined && budgetHidden(tree, sel, { folds, shown, parsed, all })) {
        setBudget((b) => Math.min(BUDGET_MAX, b * 2));
      }
      return;
    }
    reveal.current = false;
    const top = selIndex * ROW_H;
    if (top < el.scrollTop) el.scrollTop = top;
    else if (top + ROW_H > el.scrollTop + el.clientHeight) el.scrollTop = top + ROW_H - el.clientHeight;
  }, [selIndex, rows, tick]);
  // The keyboard in the tree once the value is read — only while it is still in the view: rows browsed in the grid (a
  // NULL row, then a value) never take it from there.
  useEffect(() => {
    const a = document.activeElement;
    if (a instanceof Node && root.current?.contains(a)) treeEl.current?.focus({ preventScroll: true });
  }, []);

  // ---------- a node's actions ----------

  const toggle = (id: string) => setFolds((f) => {
    const next = new Set(f);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const more = (id: string, kind: JsonRow['kind']) => {
    setShown((m) => new Map(m).set(id, (m.get(id) ?? (kind === 'array' ? MAX_ITEMS : MAX_KEYS)) + MORE_STEP));
    // A "… N more" the budget made shows more too.
    if (rows.length >= budget) setBudget((b) => b + BUDGET_STEP);
  };
  const parse = (r: JsonRow) => {
    const s = nodeAt(tree, r.path, parsed);
    if (typeof s !== 'string' || parseString(s) === undefined) { toast(tdt.json.notJson); return; }
    setParsed((x) => new Set(x).add(r.id));
  };
  const unparse = (r: JsonRow) => setParsed((x) => { const n = new Set(x); n.delete(r.id); return n; });
  const along = (path: DbPath) => parsedAlong(tree, path, parsed);
  const pathOf = (path: DbPath) => jsonPathText(base, path, along(path));
  const sqlOf = (path: DbPath) => jsonPathSql(column, base, path, along(path));
  const fullPath = (path: DbPath) => [...base, ...path];
  const isColumn = (path: DbPath) => db().tab(tab.key).derived.some((d) => d.column === column && samePath(d.path, fullPath(path)));
  const reach = (r: JsonRow) => !r.parsedFromString && base.length + r.path.length > 0 && base.length + r.path.length <= PATH_KEYS_MAX;
  const copyValue = (r: JsonRow) => copyOut(nodeCopy(nodeAt(tree, r.path, parsed), secret, r.masked), tdt.json.copiedValue);
  const filter = (r: JsonRow) => {
    const f = nodeFilter(column, base, r.path, nodeAt(tree, r.path, parsed), along(r.path));
    if (!f) { toast(r.parsedFromString ? tdt.json.act.inString : tdt.json.act.noFilter); return; }
    if (db().tab(tab.key).filters.length >= MAX_FILTERS) { toast(tdt.filters.full(MAX_FILTERS)); return; }
    // The filter popover's own path (a masked value's chip shows dots); the same row selected again when the rows
    // come — set only when it reloads.
    if (!addFilterKeepingRow(tab.key, f, p.rowKey)) toast(tdt.json.act.already);
  };
  const addColumn = (r: JsonRow) => {
    const d = nodeDerived(column, base, r.path, along(r.path));
    if (!d) { toast(r.parsedFromString ? tdt.json.act.inString : tdt.json.act.noColumn); return; }
    if (db().tab(tab.key).derived.length >= DERIVED_MAX) { toast(tdt.json.act.tooMany); return; }
    if (addDerived(tab.key, d, { pick: pickOf(p.rowKey) })) toast(tdt.json.columnAdded(jsonPathText([], d.path, NO)));
  };
  const openUrl = (url: string) => void window.atelier.openUrl(url).catch(() => {});

  /** A line's right-click menu (Shift+F10 on the tree): json.ts lineMenu's items, each run here. */
  const rowMenu = (r: JsonRow): MenuItem[] => {
    const run: Record<LineMenuId, () => void> = {
      copy: () => copyValue(r),
      path: () => copyOut(pathOf(r.path), tdt.json.copiedPath),
      sql: () => copyOut(sqlOf(r.path), tdt.json.copiedSql),
      filter: () => filter(r),
      column: () => addColumn(r),
      url: () => { if (r.url) openUrl(r.url); },
      parse: () => parse(r),
      unparse: () => unparse(r)
    };
    const icons: Partial<Record<LineMenuId, IconName>> = { copy: 'copy', path: 'path', sql: 'code', filter: 'filter', column: 'jsonBranch', url: 'externalLink', parse: 'tree' };
    return lineMenu(r, { hasPath: base.length + r.path.length > 0, reach: reach(r), shown: isColumn(r.path) })
      .map((it): MenuItem => (it === 'sep' ? 'sep' : { ...it, ...(icons[it.id] ? { icon: icons[it.id] } : {}), run: run[it.id] }));
  };

  // ---------- the tree's keyboard ----------

  const onTreeKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.metaKey || e.ctrlKey || e.altKey || e.target !== e.currentTarget) return;
    const act = treeKey(e.key, rows, selIndex);
    // The arrows are the tree's here, even at its ends (never the inspector's row moves).
    if (!act) {
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) { e.preventDefault(); e.stopPropagation(); }
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    if (act.kind === 'move') {
      const r = rows[act.to]!;
      if (r.role === 'more') { reveal.current = true; setMoreAt(r.id); setTick((t) => t + 1); } else select(r.path, true);
    } else if (act.kind === 'toggle') toggle(act.id);
    else if (act.kind === 'url') openUrl(act.url);
    else {
      const r = rows[selIndex];
      if (r) more(act.id, r.kind);
    }
  };
  // Shift+F10 on the tree (App sends a contextmenu to it): the selected line's menu, under it.
  const onTreeMenu = (e: MouseEvent<HTMLDivElement>) => {
    const r = rows[selIndex];
    if (e.target !== e.currentTarget || !r || r.role === 'more' || r.role === 'close') return;
    e.preventDefault();
    e.stopPropagation();
    const el = document.getElementById(`${uid}-${selIndex}`)?.getBoundingClientRect();
    useApp.getState().openMenu(el ? { x: el.left + 40, y: el.bottom } : e, rowMenu(r));
  };

  // ---------- the find's keyboard ----------

  const onFindKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape' && !e.metaKey && !e.ctrlKey && !e.altKey) {
      // Esc closes the find first: cleared, the keyboard back in the tree.
      e.preventDefault();
      e.stopPropagation();
      setQ('');
      treeEl.current?.focus({ preventScroll: true });
      return;
    }
    if ((e.key === 'Enter' && !e.nativeEvent.isComposing) || e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      e.stopPropagation();
      goHit(cur + (e.key === 'ArrowUp' || (e.key === 'Enter' && e.shiftKey) ? -1 : 1));
    }
  };
  const onViewKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.defaultPrevented) return;
    // Esc closes the find first where it shows and holds something, the view itself next (JsonInspector).
    if (e.key === 'Escape' && !e.metaKey && !e.ctrlKey && !e.altKey && escClearsFind(view, q)) {
      e.preventDefault();
      e.stopPropagation();
      setQ('');
      treeEl.current?.focus({ preventScroll: true });
    }
  };

  // ---------- render ----------

  // The bar and the breadcrumb follow the selected node while it is in the value (folded away too); another row's value
  // without it: the root. With Mask values on, only what the tree still shows: down to a masked key.
  const selNode = useMemo(
    () => (sel.length === 0 || nodeAt(tree, sel, parsed) !== undefined ? visiblePath(tree, sel, parsed, secret) : NO_PATH), [tree, sel, parsed, secret]
  );
  return (
    <div className="dbj-body" onKeyDown={onViewKey}>
      {view === 'tree' && (
        <div className="dbj-findbar">
          <div className="db-input dbj-find">
            <Icon name="search" size={13} />
            <input value={q} placeholder={tdt.json.find} aria-label={tdt.json.findLabel} spellCheck={false} autoComplete="off"
              onChange={(e) => setQ(e.target.value)} onKeyDown={onFindKey} />
            {q.trim() !== '' && (
              <span className="dbj-count mono" aria-live="polite">
                {found.q !== q || (!found.done && found.hits.length === 0) ? tdt.json.searching : tdt.json.hits(cur + 1, found.hits.length, found.capped)}
              </span>
            )}
          </div>
          <button type="button" className="icon-btn dbj-ib" aria-label={tdt.json.prevHit} data-tip={tdt.json.prevHit} disabled={found.hits.length === 0} onClick={() => goHit(cur - 1)}>
            <Icon name="arrowUp" size={13} />
          </button>
          <button type="button" className="icon-btn dbj-ib" aria-label={tdt.json.nextHit} data-tip={tdt.json.nextHit} disabled={found.hits.length === 0} onClick={() => goHit(cur + 1)}>
            <Icon name="arrowDown" size={13} />
          </button>
          <button type="button" className="btn-ghost sm dbj-expand" aria-pressed={all} data-tip={all ? tdt.json.collapseAll : tdt.json.expandAll}
            onClick={() => { setAll((a) => !a); setFolds(NO); }}>
            <Icon name={all ? 'collapseAll' : 'unfoldAll'} size={13} /><span className="dbj-expand-l">{all ? tdt.json.collapseAll : tdt.json.expandAll}</span>
          </button>
        </div>
      )}
      {/* A json value repeated a key: the tree keeps the last, as JavaScript does; Raw shows all. */}
      {view === 'tree' && duplicates && <p className="dbj-note" role="note">{tdt.json.duplicates}</p>}
      {view !== 'raw' && <Crumbs name={p.name} path={selNode} onPick={(path) => goTo(path)} />}
      {view === 'tree' && (
        <Tree uid={uid} name={p.name} treeEl={treeEl} rows={rows} selIndex={selIndex} hits={hitRows} curHit={curHit} onKeyDown={onTreeKey} onMenu={onTreeMenu}
          act={{
            pick: (r) => {
              treeEl.current?.focus({ preventScroll: true });
              if (r.role === 'more') more(idOf(r.path), r.kind);
              else select(r.path, false);
            },
            toggle, copy: copyValue, path: (r) => copyOut(pathOf(r.path), tdt.json.copiedPath), sql: (r) => copyOut(sqlOf(r.path), tdt.json.copiedSql),
            filter, column: addColumn, isColumn: (r) => isColumn(r.path), reach, hasPath: (r) => base.length + r.path.length > 0, url: openUrl, parse, unparse,
            menu: (e, r) => { e.preventDefault(); e.stopPropagation(); select(r.path, false); useApp.getState().openMenu(e, rowMenu(r)); }
          }} />
      )}
      {view === 'table' && target && <JsonTable tree={tree} target={target} parsed={parsed} secret={secret} sel={sel} onPick={(path) => select(path, false)} />}
      {view === 'raw' && <JsonRaw tree={tree} stored={stored} secret={secret} />}
      {view !== 'raw' && <Bar path={pathOf(selNode)} sql={sqlOf(selNode)} />}
    </div>
  );
}

/** The selected node's path, the leaf always in view: a narrow panel cuts the start, never the end. Each step selects. */
function Crumbs({ name, path, onPick }: { name: string; path: DbPath; onPick: (p: DbPath) => void }) {
  const steps = [name, ...crumbs(path)];
  const n = steps.length;
  return (
    <nav className="dbj-crumbs mono" aria-label={tdt.json.crumbs}>
      {steps.map((s, i) => (
        // Laid out from the right (row-reverse, the order reversed): the overflow goes out on the left.
        <span key={i} className={`dbj-ci${i === n - 1 ? ' is-leaf' : ''}`} style={{ order: n - 1 - i }}>
          {i > 0 && <span className="dbj-csep" aria-hidden="true">›</span>}
          <button type="button" className="dbj-crumb" data-tip={s} aria-current={i === n - 1 ? 'location' : undefined} onClick={() => onPick(path.slice(0, i))}>{s}</button>
        </span>
      ))}
    </nav>
  );
}

/** The tree: only the lines on screen are drawn (a fixed line height), the rest is the scroller's height. */
function Tree({ uid, name, treeEl, rows, selIndex, hits, curHit, onKeyDown, onMenu, act }: {
  uid: string; name: string; treeEl: RefObject<HTMLDivElement | null>; rows: readonly JsonRow[]; selIndex: number; hits: ReadonlySet<number>; curHit: DbPath | undefined;
  onKeyDown: (e: KeyboardEvent<HTMLDivElement>) => void; onMenu: (e: MouseEvent<HTMLDivElement>) => void; act: RowActs;
}) {
  const { first, last } = useRange(treeEl, rows.length, ROW_H);
  const digits = String(rows.length).length;
  const curId = curHit ? idOf(curHit) : null;
  return (
    <div ref={treeEl} className="dbj-tree" role="tree" tabIndex={0} aria-label={tdt.json.treeLabel(name)}
      aria-activedescendant={selIndex >= first && selIndex < last ? `${uid}-${selIndex}` : undefined} onKeyDown={onKeyDown} onContextMenu={onMenu}
      style={{ '--dbj-no': `${Math.max(3, digits) + 1}ch` } as CSSProperties}>
      <div className="dbj-lines" style={{ height: rows.length * ROW_H }}>
        <div className="dbj-win" style={{ transform: `translateY(${first * ROW_H}px)` }}>
          {rows.slice(first, last).map((r, j) => {
            const i = first + j;
            return <Line key={r.id} id={`${uid}-${i}`} r={r} n={i + 1} sel={i === selIndex} hit={hits.has(i)} cur={r.id === curId} act={act} />;
          })}
        </div>
      </div>
    </div>
  );
}

/** The bottom bar: Path and SQL of the selected node, each one line (ellipsized, whole in its tooltip) and Copy. */
function Bar({ path, sql }: { path: string; sql: string }) {
  const b = tdt.json.bar;
  return (
    <div className="dbj-bar">
      <div className="dbj-bar-row">
        <span className="dbj-bar-l">{b.path}</span>
        <code className="dbj-bar-code mono" data-tip={path || undefined}>{path || <span className="dbj-dim">{tdt.json.root}</span>}</code>
        <button type="button" className="icon-btn dbj-bar-copy" aria-label={b.copyPath} data-tip={b.copyPath} disabled={!path} onClick={() => copyOut(path, tdt.json.copiedPath)}>
          <Icon name="copy" size={12} />
        </button>
      </div>
      <div className="dbj-bar-row">
        <span className="dbj-bar-l">{b.sql}</span>
        <code className="dbj-bar-code is-sql mono" data-tip={sql}>{sql}</code>
        <button type="button" className="icon-btn dbj-bar-copy" aria-label={b.copySql} data-tip={b.copySql} onClick={() => copyOut(sql, tdt.json.copiedSql)}>
          <Icon name="copy" size={12} />
        </button>
      </div>
    </div>
  );
}
