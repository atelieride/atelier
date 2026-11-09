// JSON navigation: a JSON tab's Tree view (alone, or the right half of Split) — the tools
// row, the virtualized tree or the table of an array of objects, the invalid-JSON band, the keyboard, the selected
// row's actions and the context menu. Read-only: values change in the source.
import { useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState, type KeyboardEvent, type MouseEvent, type MutableRefObject, type ReactNode } from 'react';
import { findNode, nodeAtPath, type JsonError, type JsonNode } from './parse';
import type { Segment } from './scan';
import { allIds, buildRows, initialExpanded, pathKey, revealIds, rowPath, subtreeIds, type Hit, type NodeRow, type Row } from './rows';
import { buildTable, tableMeta, tableTarget, type Sort } from './table';
import { copyText } from '../clipboard';
import { copyValue } from './copy';
import { formatPath, groupNumber, type PathFormat } from './paths';
import { JsonTable } from './JsonTable';
import { Icon } from '../components/Icon';
import { t } from '../i18n/en';
import { useApp } from '../store';
import { jsonNodeMenu } from '../menus';
import { sizeLabel } from '../scm/detail';
import { kbd } from '../kbd';

/** The document as the pane shows it: the last valid parse, and the current error if the text is not valid now. */
export interface JsonDoc {
  root: JsonNode | null;
  nodes: number;
  ms: number;
  bytes: number;
  error: JsonError | null;
  empty: boolean;
}

export interface JsonPaneHandle {
  focus(): void;
  /** ⌘F: the filter field (false when the pane shows no tools row). */
  focusFilter(): boolean;
  /** ⌘⌥C: the selected value (its offsets are the last valid parse's: the file view maps them onto the text). */
  selected(): JsonNode | null;
  /** The file bar's segments: select that value (back to the tree from the table). */
  selectPath(path: Segment[]): void;
}

/** What the footer shows for the pane. */
export type PaneStatus = { mode: 'tree' } | { mode: 'table'; row: number | null; line: number | null };

interface ViewState {
  expanded: Set<string>;
  sel: string | null;
  query: string;
  layout: 'tree' | 'table';
  sort: Sort | null;
  tableQuery: string;
  tableSel: number | null;
  started: boolean;
  scrollTop: number;
}

// Per file, kept while the app runs: switching Source ↔ Tree finds the tree as it was left.
const states = new Map<string, ViewState>();
const stateOf = (path: string): ViewState => {
  let s = states.get(path);
  if (!s) {
    s = { expanded: new Set(), sel: null, query: '', layout: 'tree', sort: null, tableQuery: '', tableSel: null, started: false, scrollTop: 0 };
    states.set(path, s);
  }
  return s;
};

const ROW = 24;
const PAD_TOP = 6;
const OVERSCAN = 12;


function Hits({ text, hits, cls }: { text: string; hits: Hit[]; cls?: string }) {
  if (!hits.length) return <span className={cls}>{text}</span>;
  const out: ReactNode[] = [];
  let at = 0;
  hits.forEach(([a, b], i) => {
    if (a >= text.length) return;
    if (a > at) out.push(<span key={`p${i}`}>{text.slice(at, a)}</span>);
    out.push(<span key={`h${i}`} className="jt-hit">{text.slice(a, Math.min(b, text.length))}</span>);
    at = Math.min(b, text.length);
  });
  if (at < text.length) out.push(<span key="end">{text.slice(at)}</span>);
  return <span className={cls}>{out}</span>;
}

export function JsonPane(p: {
  path: string;
  doc: JsonDoc;
  split: boolean;
  visible: boolean;
  format: PathFormat;
  /** Split, "Tree follows the cursor": the path under the editor's cursor. */
  follow: Segment[] | null;
  handle: MutableRefObject<JsonPaneHandle | null>;
  /** The selected value changed (the file bar's path); null: nothing selected. */
  onSelection: (path: Segment[] | null, node: JsonNode | null) => void;
  /** The user picked a value (Split: the editor's cursor goes there). */
  onPick: (node: JsonNode) => void;
  onShowSource: (node: JsonNode) => void;
  onGoToError: () => void;
  /** A copy was made: the file bar confirms it. */
  onCopied: (what: string) => void;
  onMention: (node: JsonNode) => void;
  onStatus: (s: PaneStatus) => void;
}) {
  const v = useRef(stateOf(p.path)).current;
  const [, force] = useReducer((x: number) => x + 1, 0);
  const set = (patch: Partial<ViewState>) => { Object.assign(v, patch); force(); };
  const root = p.doc.root;
  const treeRef = useRef<HTMLDivElement>(null);
  const filterRef = useRef<HTMLInputElement>(null);
  const [box, setBox] = useState({ top: v.scrollTop, height: 600 });
  const uid = useMemo(() => Math.random().toString(36).slice(2, 8), []);

  // The first look at a file: small documents open two levels.
  if (root && !v.started) { v.started = true; v.expanded = initialExpanded(root, p.doc.nodes); }

  // The filter applies once typing pauses on large documents (a pass over every value), at once on small ones.
  const [applied, setApplied] = useState(v.query);
  useEffect(() => {
    if (applied === v.query) return;
    const t = setTimeout(() => setApplied(v.query), p.doc.nodes > 20_000 ? 150 : 0);
    return () => clearTimeout(t);
  }, [v.query]);
  const { rows, matches } = useMemo(() => (root ? buildRows(root, { expanded: v.expanded, query: applied }) : { rows: [] as Row[], matches: 0 }), [root, v.expanded, applied]);
  const selIndex = v.sel ? rows.findIndex((r) => r.id === v.sel) : -1;
  const selRow = selIndex >= 0 ? rows[selIndex]! : null;
  const selPath = selRow ? selRow.path : v.sel ? rowPath(v.sel) : null;
  // Exactly the selected value: after an edit removed it, nothing (never its parent in its place).
  const selNode = root && selPath ? findNode(root, selPath) : null;

  // Table: the array of objects the selection is in (or the root).
  const target = root ? tableTarget(root, selPath ?? []) : null;
  const tableNode = root && target ? nodeAtPath(root, target).at(-1)! : null;
  const showTable = !p.split && v.layout === 'table' && !!tableNode;
  const table = useMemo(() => (showTable && tableNode ? buildTable(tableNode, { query: v.tableQuery, sort: v.sort }) : null), [showTable, tableNode, v.tableQuery, v.sort]);
  const pendingScroll = useRef(false);

  // The file bar follows the selection (the table's array in Table).
  const reported = useRef<string>('');
  useEffect(() => {
    const path = showTable ? target : selPath;
    const node = showTable ? tableNode : selNode;
    const key = `${path ? pathKey(path) : ''}|${node?.from ?? ''}|${node?.to ?? ''}`;
    if (reported.current === key) return;
    reported.current = key;
    p.onSelection(path, node);
  });
  useEffect(() => {
    const row = showTable && v.tableSel !== null ? tableNode?.children?.[v.tableSel] ?? null : null;
    p.onStatus(showTable ? { mode: 'table', row: row && v.tableSel !== null ? v.tableSel + 1 : null, line: row?.line ?? null } : { mode: 'tree' });
  }, [showTable, v.tableSel, tableNode]);

  // Split: the tree selects the value under the editor's cursor.
  const followKey = p.follow ? pathKey(p.follow) : null;
  useEffect(() => {
    if (!root || !p.follow) return;
    const chain = nodeAtPath(root, p.follow);
    const path = p.follow.slice(0, chain.length - 1);
    if (!path.length) return;
    const id = pathKey(path);
    if (v.sel === id) return;
    const add = revealIds(root, path).filter((x) => !v.expanded.has(x));
    set({ sel: id, ...(add.length ? { expanded: new Set([...v.expanded, ...add]) } : {}) });
    pendingScroll.current = true;
  }, [followKey, root]);

  // Virtualized rows: what the scroll box shows, plus some.
  useLayoutEffect(() => {
    const el = treeRef.current;
    if (!el) return;
    if (Math.abs(el.scrollTop - v.scrollTop) > 1) el.scrollTop = v.scrollTop;
    const ro = new ResizeObserver(() => setBox({ top: el.scrollTop, height: el.clientHeight }));
    ro.observe(el);
    setBox({ top: el.scrollTop, height: el.clientHeight });
    return () => ro.disconnect();
  }, [showTable, !!root, p.visible]);
  const first = Math.max(0, Math.floor((box.top - PAD_TOP) / ROW) - OVERSCAN);
  const last = Math.min(rows.length, Math.ceil((box.top + box.height) / ROW) + OVERSCAN);

  const scrollToIndex = (i: number) => {
    const el = treeRef.current;
    if (!el || i < 0) return;
    const top = PAD_TOP + i * ROW;
    if (top < el.scrollTop) el.scrollTop = top - ROW;
    else if (top + ROW > el.scrollTop + el.clientHeight) el.scrollTop = top + 2 * ROW - el.clientHeight;
  };
  useLayoutEffect(() => {
    if (!pendingScroll.current) return;
    pendingScroll.current = false;
    scrollToIndex(selIndex);
  });

  const select = (row: Row, pick = true) => {
    set({ sel: row.id });
    pendingScroll.current = true;
    if (pick && row.kind === 'node') p.onPick(row.node);
  };
  const toggle = (row: Row, deep = false) => {
    if (row.kind === 'node' && !row.box) return;
    const ids = deep && row.kind === 'node' && root ? subtreeIds(root, row.path) : [row.id];
    const next = new Set(v.expanded);
    const open = row.open;
    for (const id of ids) { if (open) next.delete(id); else next.add(id); }
    set({ expanded: next });
  };
  const setSubtree = (row: NodeRow, open: boolean) => {
    if (!root || !row.box) return;
    const next = new Set(v.expanded);
    for (const id of subtreeIds(root, row.path)) { if (open) next.add(id); else next.delete(id); }
    set({ expanded: next });
  };

  const copy = (text: string, what: string) => { void copyText(text).then((ok) => { if (ok) p.onCopied(what); }); };
  const copyNodeValue = (n: JsonNode) => copy(copyValue(n), n.children ? t.json.copiedJson(n.type) : t.json.copiedValue);
  const copyNodePath = (path: Segment[], fmt: PathFormat = p.format) => copy(formatPath(path, fmt), formatPath(path, fmt) || t.json.menu.formats.pointer);
  const keyOf = (row: NodeRow) => (typeof row.key === 'string' ? row.key : null);

  const menuFor = (e: MouseEvent, row: NodeRow) => {
    e.preventDefault();
    select(row, false);
    const paths = { jq: formatPath(row.path, 'jq'), js: formatPath(row.path, 'js'), pointer: formatPath(row.path, 'pointer') };
    const k = keyOf(row);
    useApp.getState().openMenu(e, jsonNodeMenu({ box: row.box, paths, format: p.format }, {
      copyValue: () => copyNodeValue(row.node),
      copyKey: k !== null ? () => copy(k, t.json.copiedKey) : null,
      copyPath: () => copyNodePath(row.path),
      copyPathAs: (f) => copyNodePath(row.path, f),
      openFormatSetting: () => useApp.getState().setSettingsOpen('editor'),
      showSource: () => p.onShowSource(row.node),
      filterByKey: k !== null && k !== '' ? () => set({ query: k }) : null,
      expandChildren: row.box ? () => setSubtree(row, true) : null,
      collapseChildren: row.box ? () => setSubtree(row, false) : null,
      mention: useApp.getState().terminals.some((x) => x.session) ? () => p.onMention(row.node) : null
    }));
  };

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!rows.length) return;
    const i = selIndex;
    const row = selRow;
    const mod = e.metaKey || e.ctrlKey;
    const go = (k: number) => { const r = rows[Math.max(0, Math.min(rows.length - 1, k))]; if (r) select(r); };
    const page = Math.max(1, Math.floor((treeRef.current?.clientHeight ?? 240) / ROW) - 1);
    let handled = true;
    if (e.key === 'ArrowDown') go(i < 0 ? 0 : i + 1);
    else if (e.key === 'ArrowUp') go(i < 0 ? 0 : i - 1);
    else if (e.key === 'PageDown') go(i + page);
    else if (e.key === 'PageUp') go(i - page);
    else if (e.key === 'Home') go(0);
    else if (e.key === 'End') go(rows.length - 1);
    else if (!row) handled = false;
    else if (e.key === 'ArrowRight') {
      if (e.altKey && row.kind === 'node') setSubtree(row, true);
      else if ((row.kind === 'chunk' || row.box) && !row.open) toggle(row);
      else if (row.kind === 'chunk' || row.box) go(i + 1);
    } else if (e.key === 'ArrowLeft') {
      if (e.altKey && row.kind === 'node') setSubtree(row, false);
      else if ((row.kind === 'chunk' || row.box) && row.open) toggle(row);
      else if (row.parent) { const k = rows.findIndex((r) => r.id === row.parent); if (k >= 0) go(k); }
    } else if (e.key === 'Enter' && e.altKey) { if (row.kind === 'node') p.onShowSource(row.node); }
    else if (e.key === 'Enter') toggle(row);
    else if (mod && e.altKey && e.shiftKey && e.code === 'KeyC') copyNodePath(row.path);
    else if (mod && !e.altKey && !e.shiftKey && e.code === 'KeyC') { if (row.kind === 'node') copyNodeValue(row.node); }
    else if (mod && !e.altKey && !e.shiftKey && e.code === 'KeyL') { if (row.kind === 'node') p.onMention(row.node); }
    else handled = false;
    if (handled) { e.preventDefault(); e.stopPropagation(); }
  };

  p.handle.current = {
    focus: () => (showTable ? document.querySelector<HTMLElement>(`#jtab-${uid}`) : treeRef.current)?.focus(),
    focusFilter: () => { const f = filterRef.current; if (!f) return false; f.focus(); f.select(); return true; },
    selected: () => selNode,
    selectPath: (path) => {
      if (!root) return;
      const add = revealIds(root, path).filter((x) => !v.expanded.has(x));
      set({ layout: 'tree', sel: pathKey(path), ...(add.length ? { expanded: new Set([...v.expanded, ...add]) } : {}) });
      pendingScroll.current = true;
      requestAnimationFrame(() => treeRef.current?.focus());
    }
  };
  useEffect(() => () => { if (p.handle.current) p.handle.current = null; }, []);

  const rowEl = (row: Row, index: number) => {
    const sel = index === selIndex;
    const guides = Array.from({ length: row.depth }, (_, k) => <span key={k} className="jt-guide" />);
    const chev = (
      <button type="button" tabIndex={-1} className={`jt-chev ${row.open ? 'is-open' : ''}`} aria-label={row.open ? t.json.collapse(row.kind === 'chunk' ? row.label : String(row.key)) : t.json.expand(row.kind === 'chunk' ? row.label : String(row.key))}
        onMouseDown={(e) => e.preventDefault()} onClick={(e) => { e.stopPropagation(); select(row, false); toggle(row, e.altKey); treeRef.current?.focus(); }}>
        <Icon name="chevron" size={11} stroke={2.2} />
      </button>
    );
    const common = {
      id: `jt-${uid}-${index}`, role: 'treeitem', 'aria-level': row.depth + 1, 'aria-selected': sel,
      onMouseDown: (e: MouseEvent) => { if (e.button === 0) { select(row); } },
      onDoubleClick: () => toggle(row)
    } as const;
    if (row.kind === 'chunk') {
      return (
        <div key={row.id} {...common} aria-expanded={row.open} className={`jt-row ${sel ? 'is-sel' : ''}`}>
          {guides}{chev}<span className="jt-range">{row.label}</span>{!row.open && <span className="jt-pv">{row.preview}</span>}
        </div>
      );
    }
    const n = row.node;
    const key = row.key === null ? null : typeof row.key === 'number' ? String(row.key) : row.key === '' ? '""' : row.key;
    return (
      <div key={row.id} {...common} aria-expanded={row.box ? row.open : undefined} className={`jt-row ${sel ? 'is-sel' : ''} ${row.miss ? 'is-miss' : ''}`} onContextMenu={(e) => menuFor(e, row)}>
        {guides}
        {row.box ? chev : <span className="jt-nochev" />}
        <span className="jt-main">
          {key !== null && <><Hits text={key} hits={row.keyHits} cls={`jt-key ${typeof row.key === 'number' ? 'is-idx' : ''}`} /><span className="jt-colon">:</span></>}
          {row.box
            ? <><span className="jt-chip">{row.chip}</span>{row.preview !== null && <span className="jt-pv">{row.preview}</span>}</>
            : <Hits text={row.value ?? ''} hits={row.valueHits} cls={`jt-v-${n.type}`} />}
        </span>
        <span className="jt-lno">L{n.line}</span>
        {sel && (
          <span className="jt-acts" onMouseDown={(e) => e.stopPropagation()}>
            <button type="button" className="json-act" tabIndex={-1} aria-label={t.json.copyValue} data-tip={`${t.json.copyValue} · ${kbd('⌘C')}`} onClick={() => copyNodeValue(n)}><Icon name="copy" size={13} stroke={1.7} /></button>
            <button type="button" className="json-act" tabIndex={-1} aria-label={t.json.copyPath} data-tip={`${t.json.copyPath} · ${kbd('⌥⇧⌘C')}`} onClick={() => copyNodePath(row.path)}><Icon name="path" size={13} stroke={1.7} /></button>
            <button type="button" className="json-act" tabIndex={-1} aria-label={t.json.showInSource} data-tip={`${t.json.showInSource} · ${kbd('⌥⏎')}`} onClick={() => p.onShowSource(n)}><Icon name="code" size={13} stroke={1.7} /></button>
          </span>
        )}
      </div>
    );
  };

  const err = p.doc.error;
  const filtering = !!v.query.trim();
  const big = p.doc.bytes >= 1024 * 1024;
  const layoutSeg = target && !p.split && (
    <span className="seg" role="radiogroup" aria-label={t.json.layout}>
      {(['tree', 'table'] as const).map((l) => (
        <button key={l} type="button" role="radio" aria-checked={(showTable ? 'table' : 'tree') === l} className={(showTable ? 'table' : 'tree') === l ? 'is-on' : ''}
          onClick={() => set({ layout: l })}>{l === 'tree' ? t.json.layoutTree : t.json.layoutTable}</button>
      ))}
    </span>
  );

  let body: ReactNode;
  if (!root) {
    body = p.doc.empty
      ? <div className="json-empty">{t.json.empty}</div>
      : err
        ? <div className="json-empty"><b>{t.json.neverValid}</b><span className="json-empty-msg">{err.message} · {err.line}:{err.col}</span>
            <button type="button" className="btn-ghost sm" onClick={p.onGoToError}>{t.json.showInSource}</button></div>
        : <div className="json-empty" />;
  } else if (showTable && tableNode && target && table) {
    body = <JsonTable id={`jtab-${uid}`} model={table} sort={v.sort} sel={v.tableSel}
      onSort={(sort) => set({ sort })} onSelect={(i) => set({ tableSel: i })}
      onOpen={(path) => {
        const full = [...target, ...path];
        const add = revealIds(root, full).filter((x) => !v.expanded.has(x));
        set({ layout: 'tree', sel: pathKey(full), expanded: new Set([...v.expanded, ...add]) });
        pendingScroll.current = true;
        requestAnimationFrame(() => treeRef.current?.focus());
      }}
      onShowSource={p.onShowSource}
      onMenu={(e, i) => {
        const node = tableNode.children![i]!;
        const path = [...target, i];
        const row: NodeRow = { kind: 'node', id: pathKey(path), node, key: i, path, depth: 0, parent: null, box: true, open: false, chip: '', preview: null, value: null, line: node.line, miss: false, keyHits: [], valueHits: [] };
        // The tree finds it selected and visible when the user goes back to it.
        const add = revealIds(root, path).filter((x) => !v.expanded.has(x));
        if (add.length) v.expanded = new Set([...v.expanded, ...add]);
        menuFor(e, row);
      }} />;
  } else {
    body = (
      <div ref={treeRef} className={`json-tree ${err ? 'is-stale' : ''}`} role="tree" tabIndex={0} aria-label={t.json.tree}
        aria-activedescendant={selIndex >= 0 ? `jt-${uid}-${selIndex}` : undefined} onKeyDown={onKey}
        onScroll={(e) => { const top = e.currentTarget.scrollTop; v.scrollTop = top; setBox((b) => ({ ...b, top })); }}>
        {rows.length === 0 && filtering
          ? <div className="json-empty">{t.json.matches(0)}</div>
          : (
            <div className="jt-rows" style={{ height: rows.length * ROW, paddingTop: first * ROW }}>
              {rows.slice(first, last).map((r, k) => rowEl(r, first + k))}
            </div>
          )}
      </div>
    );
  }

  return (
    <div className={`json-pane ${p.split ? 'is-split' : ''}`}>
      {err && root && (
        <div className="json-band" role="status">
          <span className="json-band-dot" />
          <span className="json-band-text"><b>{t.json.invalid}</b> · {t.json.lastValid}</span>
          <span className="json-band-at">{err.line}:{err.col}</span>
          <span className="grow" />
          <button type="button" className="btn-ghost sm" onClick={p.onGoToError}>{t.json.goToError}</button>
        </div>
      )}
      {root && !p.split && (showTable ? (
        <div className="json-tools">
          <label className="json-field">
            <Icon name="search" size={13} stroke={1.7} />
            <input ref={filterRef} type="text" value={v.tableQuery} placeholder={t.json.filterRows} aria-label={t.json.filterRows} spellCheck={false}
              onChange={(e) => set({ tableQuery: e.target.value })}
              onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); set({ tableQuery: '' }); p.handle.current?.focus(); } }} />
            <span className="json-kbd">{kbd('⌘F')}</span>
          </label>
          {table && <span className="json-meta">{tableMeta({ shown: table.rows.length, total: table.total, columns: table.columns.length, sort: v.sort })}</span>}
          <span className="grow" />
          {layoutSeg}
        </div>
      ) : (
        <div className="json-tools">
          <label className="json-field">
            <Icon name="search" size={13} stroke={1.7} />
            <input ref={filterRef} type="text" value={v.query} placeholder={t.json.filter} aria-label={t.json.filter} spellCheck={false}
              onChange={(e) => set({ query: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === 'Escape') { e.preventDefault(); set({ query: '' }); treeRef.current?.focus(); }
                if (e.key === 'ArrowDown' || e.key === 'Enter') { e.preventDefault(); if (!selRow && rows[0]) select(rows[0]); treeRef.current?.focus(); }
              }} />
            <span className="json-kbd">{kbd('⌘F')}</span>
          </label>
          {filtering && <>
            <span className={`json-count ${matches === 0 ? 'is-none' : ''}`} role="status">{t.json.matches(matches)}</span>
            <button type="button" className="json-tool-btn" onClick={() => { set({ query: '' }); filterRef.current?.focus(); }}>{t.json.clear}</button>
          </>}
          {big && <span className="json-stat"><i />{t.json.parsed(sizeLabel(p.doc.bytes), groupNumber(p.doc.nodes), p.doc.ms)}</span>}
          <span className="grow" />
          {layoutSeg}
          <button type="button" className="json-tool-btn" onClick={() => root && set({ expanded: new Set(allIds(root)) })}><Icon name="unfoldAll" size={12} stroke={1.8} /><span className="json-tool-label">{t.json.expandAll}</span></button>
          <button type="button" className="json-tool-btn" onClick={() => set({ expanded: new Set() })}><Icon name="collapseAll" size={12} stroke={1.8} /><span className="json-tool-label">{t.json.collapseAll}</span></button>
        </div>
      ))}
      {body}
    </div>
  );
}

