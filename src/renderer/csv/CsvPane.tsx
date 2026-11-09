// CSV viewer: a CSV tab's Table view (alone, or the right half of Split) — the tools row with
// the filter, the column filters' chips, the parse options, summaries, columns and Go to Row; the band of rows that
// don't match the header; the table; the column menu, the cell menu, the cell peek; the keyboard. Read-only: values
// change in the source.
import { useEffect, useMemo, useReducer, useRef, useState, type KeyboardEvent, type MouseEvent, type MutableRefObject } from 'react';
import { CsvTable, type CsvTableHandle } from './CsvTable';
import { CsvColumnMenu } from './CsvColumnMenu';
import { CsvOptionsPopover } from './CsvOptions';
import { CellPeek, GoToSheet } from './CsvParts';
import type { CsvCrumb } from './CsvAddress';
import type { CsvResult } from './csv-client';
import { copyCells, sample, COPY_FORMATS, type CopyBlock, type CopyFormat } from './copy';
import { address, groupInt, rangeAddress } from './format';
import { shortNumber, typeLabel } from './labels';
import { moveSelection, rangeOf, rowBounds, rowSelection, type Cell, type Sel } from './selection';
import { aggregates, filterLabel, nextSort, problemRows, visibleRows } from './view';
import type { CellRange, ColumnProfile, CsvOptions, Sort, ValueFilter } from './types';
import { copyText } from '../clipboard';
import { csvCellMenu } from '../menus';
import type { MenuItem } from '../menu-model';
import { Icon } from '../components/Icon';
import { t } from '../i18n/en';
import { useApp } from '../store';
import { sizeLabel } from '../scm/detail';
import { kbd } from '../kbd';
import { isSourceControlKey } from '@shared/keys';
import type { LineRange } from '../mention';

/** The document as the pane shows it: the last parse (null before the first), its time and the text's size. */
export interface CsvDoc { result: CsvResult | null; ms: number; bytes: number }

export interface CsvPaneHandle {
  focus(): void;
  /** ⌘F: the filter field (false when the pane shows no tools row). */
  focusFilter(): boolean;
  goToRow(): void;
  parseOptions(): void;
  /** Split, "Table follows the cursor": the cell under the editor's cursor. */
  selectCell(row: number, col: number): void;
  /** The selected rows' lines (⌘⌥C, ⌘L), null without a selection. */
  selectedLines(): LineRange | null;
  /** The file bar's Copy cell: the selected cell, or the range as TSV. */
  copySelection(): void;
}

/** What the file bar and the footer show for the pane. */
export interface CsvStatus {
  crumb: CsvCrumb | null;
  position: string | null;
  totals: { name: string; parts: [string, string][] }[];
  problems: number;
}

interface ViewState {
  query: string;
  filters: ValueFilter[];
  problemsOnly: boolean;
  sort: Sort[];
  hidden: number[];
  frozen: number;
  sel: Sel | null;
  scroll: { top: number; left: number };
  peek: boolean;
}

// Per file, kept while the app runs (the last few files): switching Source ↔ Table finds the table as it was left.
const MAX_STATES = 40;
const states = new Map<string, ViewState>();
const stateOf = (path: string): ViewState => {
  let s = states.get(path);
  if (!s) {
    s = { query: '', filters: [], problemsOnly: false, sort: [], hidden: [], frozen: 0, sel: null, scroll: { top: 0, left: 0 }, peek: false };
    states.set(path, s);
    if (states.size > MAX_STATES) states.delete(states.keys().next().value!);
  }
  return s;
};

const HEADER_KEY = 'atelier.csvCopyHeader';
const readHeader = (): boolean => { try { return localStorage.getItem(HEADER_KEY) !== 'false'; } catch { return true; } };
const writeHeader = (v: boolean) => { try { localStorage.setItem(HEADER_KEY, String(v)); } catch { /* this session only */ } };

type Popup = { kind: 'column'; col: number; left: number; top: number } | { kind: 'options' } | { kind: 'goto' } | null;

export function CsvPane(p: {
  path: string;
  doc: CsvDoc;
  options: CsvOptions;
  split: boolean;
  visible: boolean;
  handle: MutableRefObject<CsvPaneHandle | null>;
  onOptions: (o: CsvOptions) => void;
  /** The user selected a cell (Split: the editor's cursor goes there). */
  onPick: (row: number, col: number) => void;
  onShowSource: (row: number, col: number) => void;
  onCopied: (what: string) => void;
  onMention: (lines: LineRange) => void;
  onComment: (lines: LineRange) => void;
  onStatus: (s: CsvStatus) => void;
}) {
  const v = stateOf(p.path);
  const [, force] = useReducer((x: number) => x + 1, 0);
  const set = (patch: Partial<ViewState>) => { Object.assign(v, patch); force(); };
  // A parse made for the source alone carries no rows: the table waits for the next one.
  const res = p.doc.result?.partial ? null : p.doc.result;
  const data = res?.data ?? null;
  const profiles = res?.profiles ?? [];
  const decimal = res?.resolved.decimal ?? '.';
  const summaries = useApp((s) => s.settings.csvSummaries);
  const table = useRef<CsvTableHandle | null>(null);
  const filterRef = useRef<HTMLInputElement>(null);
  const paneRef = useRef<HTMLDivElement>(null);
  const [popup, setPopup] = useState<Popup>(null);
  const [copyHeader, setCopyHeader] = useState(readHeader);
  const uid = useMemo(() => Math.random().toString(36).slice(2, 8), []);

  // The filter applies once typing pauses on large files (a pass over every cell), at once on small ones.
  const [applied, setApplied] = useState(v.query);
  useEffect(() => {
    if (applied === v.query) return;
    const tm = setTimeout(() => setApplied(v.query), (data?.rows.length ?? 0) > 20_000 ? 150 : 0);
    return () => clearTimeout(tm);
  }, [v.query]);

  const width = data?.width ?? 0;
  const filters = v.filters.filter((f) => f.col < width);
  const cols = useMemo(() => profiles.map((x) => x.index).filter((c) => !v.hidden.includes(c)), [profiles, v.hidden]);
  // The query looks at the shown columns: a row never matches because of a value the user can't see.
  const rows = useMemo(() => (data ? visibleRows(data, profiles, { query: applied, filters, problemsOnly: v.problemsOnly, sort: v.sort.filter((s) => s.col < width), ...(v.hidden.length ? { columns: cols } : {}) }, decimal) : []),
    [data, profiles, applied, JSON.stringify(filters), v.problemsOnly, JSON.stringify(v.sort), decimal, cols]);
  const frozen = Math.min(v.frozen, cols.length);
  const bad = useMemo(() => (data ? problemRows(data) : new Set<number>()), [data]);
  const range = rangeOf(v.sel, rows, cols);
  const focusCell = range && v.sel ? v.sel.f : null;

  const nameOf = (c: number) => { const x = profiles[c]; return x ? (x.extra ? x.letter : x.name || x.letter) : ''; };
  const lineOf = (row: number) => data?.lines[row] ?? 1;
  const linesOf = (r: CellRange): LineRange => {
    let start = Infinity;
    let end = 0;
    for (let k = r.r0; k <= r.r1; k++) { const row = rows[k]!; start = Math.min(start, data!.lines[row]!); end = Math.max(end, data!.endLines[row]!); }
    return { start, end };
  };
  const rowsLabel = (r: CellRange) => { const b = rowBounds(rows, r); return t.csv.menu.rows(b.min + 1, b.max + 1); };

  // The selection's block of cells, for the copies.
  const block = (r: CellRange): CopyBlock => {
    const cs = cols.slice(r.c0, r.c1 + 1);
    return {
      names: cs.map(nameOf),
      rows: rows.slice(r.r0, r.r1 + 1).map((row) => cs.map((c) => data!.rows[row]![c] ?? '')),
      types: cs.map((c) => profiles[c]!.type)
    };
  };
  const copyOpts = (header = copyHeader) => ({ header, delimiter: res!.resolved.delimiter, decimal });
  const say = (text: string, what: string) => { void copyText(text).then((ok) => { if (ok) p.onCopied(what); }); };
  const cellsLabel = (r: CellRange) => { const n = (r.r1 - r.r0 + 1) * (r.c1 - r.c0 + 1); return `${groupInt(n)} ${n === 1 ? 'cell' : 'cells'}`; };
  const copyRange = (r: CellRange) => {
    if (r.r0 === r.r1 && r.c0 === r.c1) { const value = data!.rows[rows[r.r0]!]![cols[r.c0]!] ?? ''; say(value, value.length > 24 ? `${value.slice(0, 23)}…` : value || '(empty)'); return; }
    say(copyCells('tsv', block(r), copyOpts(false)), `${cellsLabel(r)} as TSV`);
  };
  const copyAs = (r: CellRange, f: CopyFormat) => say(copyCells(f, block(r), copyOpts()), `${cellsLabel(r)} as ${t.csv.menu.formats[f]}`);

  // The range's totals: a pass over its cells, only when the range changes.
  const rangeKey = range ? `${range.r0}:${range.c0}:${range.r1}:${range.c1}` : '';
  const totals = useMemo(() => (data && range && !(range.r0 === range.r1 && range.c0 === range.c1)
    ? aggregates(data, profiles, rows, cols, range, decimal).map((a) => ({
        name: nameOf(a.col),
        parts: ([[t.csv.sum, shortNumber(a.sum, decimal)], [t.csv.avg, shortNumber(a.avg, decimal)], [t.csv.min, shortNumber(a.min, decimal)], [t.csv.max, shortNumber(a.max, decimal)]] as [string, string][])
      }))
    : []), [data, profiles, rows, cols, rangeKey, decimal]);

  // The file bar and the footer follow the selection.
  const statusKey = useRef('');
  useEffect(() => {
    const crumb: CsvCrumb | null = (() => {
      if (!data || !range || !v.sel) return null;
      const f = v.sel.f;
      const prof = profiles[f.col];
      if (!prof) return null;
      if (range.r0 === range.r1 && range.c0 === range.c1) {
        return { address: address(f.row, f.col), column: nameOf(f.col), info: `${typeLabel(prof)} · ${t.csv.fieldOf(lineOf(f.row), f.col + 1, data.rows[f.row]!.length)}`, bad: bad.has(f.row) };
      }
      const b = rowBounds(rows, range);
      const lines = linesOf(range);
      return {
        address: rangeAddress({ r0: b.min, r1: b.max, c0: cols[range.c0]!, c1: cols[range.c1]! }),
        column: null,
        info: t.csv.rangeInfo(range.r1 - range.r0 + 1, range.c1 - range.c0 + 1, lines.start, lines.end)
      };
    })();
    const position = data && v.sel && range ? t.csv.position(v.sel.f.row + 1, lineOf(v.sel.f.row), profiles[v.sel.f.col]?.letter ?? '') : null;
    const s: CsvStatus = { crumb, position, totals, problems: data?.problems.length ?? 0 };
    const key = JSON.stringify(s);
    if (key === statusKey.current) return;
    statusKey.current = key;
    p.onStatus(s);
  });

  const select = (sel: Sel | null, pick = true, reveal = true) => {
    set({ sel });
    if (!sel) return;
    if (reveal) requestAnimationFrame(() => { const r = rangeOf(sel, rows, cols); if (r) table.current?.reveal(rows.indexOf(sel.f.row), cols.indexOf(sel.f.col)); });
    if (pick && p.split) p.onPick(sel.f.row, sel.f.col);
  };
  const goProblem = (dir: 1 | -1) => {
    if (!bad.size || !rows.length) return;
    const at = v.sel ? rows.indexOf(v.sel.f.row) : -1;
    for (let k = 1; k <= rows.length; k++) {
      const i = (((at + dir * k) % rows.length) + rows.length) % rows.length;
      if (bad.has(rows[i]!)) { const c = { row: rows[i]!, col: cols[0] ?? 0 }; select({ a: c, f: c }); return; }
    }
  };
  const goTo = (row: number, col: number | null) => {
    setPopup(null);
    if (!rows.includes(row)) set({ query: '', filters: [], problemsOnly: false });
    const c = { row, col: col !== null && cols.includes(col) ? col : v.sel?.f.col ?? cols[0] ?? 0 };
    requestAnimationFrame(() => { select({ a: c, f: c }); table.current?.focus(); });
  };
  const setFilter = (col: number, f: ValueFilter | null) => set({ filters: [...v.filters.filter((x) => x.col !== col), ...(f ? [f] : [])] });

  const openCellMenu = (e: MouseEvent | { clientX: number; clientY: number; preventDefault?: () => void }, cell: Cell) => {
    let r = range;
    const pr = rows.indexOf(cell.row);
    const pc = cols.indexOf(cell.col);
    if (!r || pr < r.r0 || pr > r.r1 || pc < r.c0 || pc > r.c1) { select({ a: cell, f: cell }, true, false); r = { r0: pr, c0: pc, r1: pr, c1: pc }; }
    const b = block(r);
    const value = data!.rows[cell.row]![cell.col] ?? '';
    const samples = Object.fromEntries(COPY_FORMATS.map((f) => [f, sample(f, b, copyOpts())])) as Record<CopyFormat, string>;
    const lines = linesOf(r);
    const canSession = useApp.getState().terminals.some((x) => x.session);
    const items: MenuItem[] = csvCellMenu({ value, column: nameOf(cell.col), rows: rowsLabel(r), block: t.csv.menu.block(r.r1 - r.r0 + 1, r.c1 - r.c0 + 1), samples, delimiter: res!.resolved.delimiter, header: copyHeader }, {
      copy: () => copyRange(r!),
      copyAs: (f) => copyAs(r!, f),
      toggleHeader: () => { setCopyHeader(!copyHeader); writeHeader(!copyHeader); },
      copyNames: () => { const names = b.names.join('\t'); say(names, t.csv.menu.copyNames.toLowerCase()); },
      filterBy: () => setFilter(cell.col, { col: cell.col, mode: 'in', values: [value] }),
      exclude: () => {
        const prev = v.filters.find((x) => x.col === cell.col && x.mode === 'out');
        setFilter(cell.col, { col: cell.col, mode: 'out', values: [...(prev?.values ?? []), value] });
      },
      sortAsc: () => set({ sort: [{ col: cell.col, dir: 'asc' }] }),
      sortDesc: () => set({ sort: [{ col: cell.col, dir: 'desc' }] }),
      showSource: () => p.onShowSource(cell.row, cell.col),
      comment: () => p.onComment(lines),
      mention: canSession ? () => p.onMention(lines) : null
    });
    useApp.getState().openMenu(e as MouseEvent, items);
  };

  const openColumnMenu = (col: number, at: DOMRect) => {
    const box = paneRef.current?.getBoundingClientRect();
    if (!box) return;
    const w = 320;
    setPopup({ kind: 'column', col, left: Math.max(8, Math.min(at.left - box.left - 6, box.width - w - 8)), top: at.bottom - box.top + 4 });
  };

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!data) return;
    const mod = e.metaKey || e.ctrlKey;
    let handled = true;
    const move = moveSelection(v.sel, e.key, { shift: e.shiftKey, mod: mod && !e.altKey, page: table.current?.page() ?? 10 }, rows, cols);
    if (move && !e.altKey) select(move);
    else if (e.code === 'KeyA' && mod && !e.shiftKey && !e.altKey) { if (rows.length && cols.length) select({ a: { row: rows[0]!, col: cols[0]! }, f: { row: rows.at(-1)!, col: cols.at(-1)! } }, false, false); }
    else if (e.code === 'KeyC' && mod && !e.shiftKey && !e.altKey) { if (range) copyRange(range); }
    else if (e.code === 'KeyL' && mod && !e.shiftKey && !e.altKey) { if (range) p.onMention(linesOf(range)); }
    else if (e.key === 'Enter' && e.altKey) { if (v.sel) p.onShowSource(v.sel.f.row, v.sel.f.col); }
    else if (e.key === ' ' && !mod) {
      if (v.sel) {
        const f = v.sel.f;
        set({ peek: !v.peek });
        // The peek takes room from the table: the cell stays in view above it.
        requestAnimationFrame(() => requestAnimationFrame(() => table.current?.reveal(rows.indexOf(f.row), cols.indexOf(f.col))));
      }
    }
    else if (e.key === 'Escape') { if (v.peek) set({ peek: false }); else if (v.sel) select({ a: v.sel.f, f: v.sel.f }, false, false); else handled = false; }
    else if (e.code === 'KeyG' && e.ctrlKey && !e.metaKey && !e.altKey && !isSourceControlKey(e)) setPopup({ kind: 'goto' });
    else if (e.key === 'F8') goProblem(e.shiftKey ? -1 : 1);
    else if ((e.key === 'F10' && e.shiftKey) || e.key === 'ContextMenu') {
      if (v.sel) {
        const el = paneRef.current?.querySelector<HTMLElement>('td.is-focus, td.is-anchor');
        const r = el?.getBoundingClientRect();
        openCellMenu({ clientX: r ? r.left + 8 : 100, clientY: r ? r.bottom : 100 }, v.sel.f);
      }
    } else handled = false;
    if (handled) { e.preventDefault(); e.stopPropagation(); }
  };

  p.handle.current = {
    focus: () => table.current?.focus(),
    focusFilter: () => { const f = filterRef.current; if (!f) return false; f.focus(); f.select(); return true; },
    goToRow: () => { if (data) setPopup({ kind: 'goto' }); },
    parseOptions: () => { if (res) setPopup({ kind: 'options' }); },
    selectCell: (row, col) => {
      if (!data || row < 0 || row >= data.rows.length) return;
      // The cursor already on the selection's focus (the echo of a pick, a range being extended): keep the range.
      if (v.sel && v.sel.f.row === row && v.sel.f.col === col) return;
      const c = { row, col: Math.min(col, Math.max(0, width - 1)) };
      select({ a: c, f: c }, false);
    },
    selectedLines: () => (range ? linesOf(range) : null),
    copySelection: () => { if (range) copyRange(range); }
  };
  useEffect(() => () => { if (p.handle.current) p.handle.current = null; }, []);

  if (!res || !data) return <div className={`csv-pane ${p.split ? 'is-split' : ''}`}><div className="json-empty" /></div>;

  const problems = data.problems;
  const quote = problems.find((x) => x.kind === 'quote');
  const fieldProblems = problems.filter((x) => x.kind === 'fields');
  const total = data.rows.length;
  const filtering = !!applied.trim() || filters.length > 0 || v.problemsOnly;
  const sortedBy = v.sort.length ? v.sort.map((s) => nameOf(s.col)).join(', ') : null;
  const big = p.doc.bytes >= 1024 * 1024;
  const delim = res.resolved.delimiter;
  const popupProfile = popup?.kind === 'column' ? profiles[popup.col] : undefined;
  const peekCell = v.peek && v.sel && range ? v.sel.f : null;
  const toggleColumn = (c: number) => set({ hidden: v.hidden.includes(c) ? v.hidden.filter((x) => x !== c) : [...v.hidden, c] });

  const columnsMenu = (e: MouseEvent) => {
    const items: MenuItem[] = [
      ...profiles.map((x): MenuItem => ({ id: `col-${x.index}`, label: `${x.letter} · ${x.extra ? t.csv.noHeader : x.name || x.letter}`, ...(v.hidden.includes(x.index) ? {} : { icon: 'check' as const }),
        disabled: !v.hidden.includes(x.index) && cols.length === 1, run: () => toggleColumn(x.index) })),
      'sep',
      { id: 'show-all', label: 'Show All Columns', disabled: v.hidden.length === 0, run: () => set({ hidden: [] }) }
    ];
    useApp.getState().openMenu(e, items);
  };

  return (
    <div ref={paneRef} className={`csv-pane ${p.split ? 'is-split' : ''}`}>
      {!p.split && (
        <div className="json-tools csv-tools">
          <label className="json-field">
            <Icon name="search" size={13} stroke={1.7} />
            <input ref={filterRef} type="text" value={v.query} placeholder={t.csv.filterRows} aria-label={t.csv.filterRows} spellCheck={false}
              onChange={(e) => set({ query: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === 'Escape') { e.preventDefault(); set({ query: '' }); table.current?.focus(); }
                if (e.key === 'ArrowDown' || e.key === 'Enter') { e.preventDefault(); if (!v.sel && rows[0] !== undefined && cols[0] !== undefined) select({ a: { row: rows[0], col: cols[0] }, f: { row: rows[0], col: cols[0] } }); table.current?.focus(); }
              }} />
            <span className="json-kbd">{kbd('⌘F')}</span>
          </label>
          <span className={`json-meta ${filtering && rows.length === 0 ? 'is-none' : ''}`} role="status">
            {filtering ? (rows.length ? t.csv.countOf(groupInt(rows.length), groupInt(total)) : t.csv.noMatches) : t.csv.count(groupInt(total), width, sortedBy)}
          </span>
          {filters.map((f) => (
            <span key={f.col} className="csv-fchip"><span className="csv-fchip-text">{filterLabel(f, profiles[f.col]!)}</span>
              <button type="button" className="csv-fchip-x" aria-label={t.csv.removeFilter} onClick={() => setFilter(f.col, null)}><Icon name="x" size={10} stroke={2.2} /></button>
            </span>
          ))}
          {v.problemsOnly && (
            <span className="csv-fchip is-bad"><span className="csv-fchip-text">{t.csv.onlyProblems}</span>
              <button type="button" className="csv-fchip-x" aria-label={t.csv.removeFilter} onClick={() => set({ problemsOnly: false })}><Icon name="x" size={10} stroke={2.2} /></button>
            </span>
          )}
          {(filters.length > 0 || v.problemsOnly) && <button type="button" className="csv-link" onClick={() => set({ filters: [], problemsOnly: false })}>{t.csv.clearFilters}</button>}
          {big && <span className="json-stat"><i />{t.csv.parsed(sizeLabel(p.doc.bytes), groupInt(total), width, p.doc.ms)}</span>}
          <span className="grow" />
          <button type="button" className={`csv-pchip ${popup?.kind === 'options' ? 'is-open' : ''}`} aria-haspopup="dialog" aria-expanded={popup?.kind === 'options'}
            onClick={() => setPopup(popup?.kind === 'options' ? null : { kind: 'options' })}>
            {t.csv.parseChip(t.csv.delimiterChar[delim]!, t.csv.delimiters[delim]!, res.resolved.header, res.resolved.decimal)}
          </button>
          <button type="button" className={`json-tool-btn ${summaries ? 'is-on' : ''}`} aria-pressed={summaries} aria-label={t.csv.summaries} data-tip={t.csv.summaries} onClick={() => void window.atelier.settings.set({ csvSummaries: !summaries })}>
            <Icon name="pulse" size={12} stroke={1.8} /><span className="json-tool-label">{t.csv.summaries}</span>
          </button>
          <button type="button" className="json-tool-btn" aria-haspopup="menu" onClick={columnsMenu}><Icon name="list" size={12} stroke={1.8} /><span className="json-tool-label is-keep">{t.csv.columns(cols.length, profiles.length)}</span></button>
          <button type="button" className="json-tool-btn" aria-label={t.csv.goToRow} onClick={() => setPopup({ kind: 'goto' })} data-tip={`${t.csv.goToRow} · ${kbd('⌃G')}`}><Icon name="arrowDown" size={12} stroke={1.8} /><span className="json-tool-label">{t.csv.goToRow}</span></button>
        </div>
      )}
      {(fieldProblems.length > 0 || quote) && (
        <div className="json-band csv-band" role="status">
          <span className="json-band-dot" />
          {fieldProblems.length > 0
            ? <span className="json-band-text"><b>{t.csv.band(fieldProblems.length, data.expected)}</b> {t.csv.bandFields(data.expected)}</span>
            : <span className="json-band-text"><b>{t.csv.unclosed}</b> {t.csv.unclosedAt(quote!.line)}</span>}
          {fieldProblems.length > 0 && <span className="json-band-at">{fieldProblems.slice(0, 3).map((x) => t.csv.rowFields(groupInt(x.row + 1), x.kind === 'fields' ? x.count : 0)).join('   ')}</span>}
          <span className="grow" />
          {fieldProblems.length > 0 && <button type="button" className="btn-ghost sm" onClick={() => { goProblem(1); table.current?.focus(); }}>{t.csv.nextProblem} <span className="json-kbd">F8</span></button>}
          <button type="button" className="btn-ghost sm" onClick={() => { const x = (fieldProblems[0] ?? quote)!; p.onShowSource(Math.max(0, x.row), 0); }}>{t.csv.showInSource}</button>
          {fieldProblems.length > 0 && !p.split && <button type="button" className="btn-ghost sm" aria-pressed={v.problemsOnly} onClick={() => set({ problemsOnly: !v.problemsOnly })}>{v.problemsOnly ? t.csv.allRows : t.csv.onlyProblems}</button>}
        </div>
      )}
      {total === 0
        ? <div className="json-empty">{t.csv.noRows}</div>
        : <CsvTable ref={table} id={`csv-${uid}`} data={data} profiles={profiles} decimal={decimal} rows={rows} cols={cols} frozen={frozen} sort={v.sort} summaries={summaries && !p.split}
            range={range} focusCell={focusCell} bad={bad} scroll={v.scroll} onScroll={(top, left) => { v.scroll = { top, left }; }}
            onCell={(cell, extend) => select({ a: extend && v.sel ? v.sel.a : cell, f: cell }, true, false)}
            onRow={(row, extend) => select(rowSelection(v.sel, row, extend, cols), true, false)}
            onSort={(col, add) => set({ sort: nextSort(v.sort, col, add) })}
            onHeaderMenu={openColumnMenu}
            onCellMenu={(e, cell) => openCellMenu(e, cell)}
            onOpen={(cell) => p.onShowSource(cell.row, cell.col)}
            onKeyDown={onKey} />}
      {peekCell && (
        <CellPeek address={address(peekCell.row, peekCell.col)} column={nameOf(peekCell.col)} value={data.rows[peekCell.row]?.[peekCell.col] ?? ''}
          onCopy={() => range && copyRange({ r0: rows.indexOf(peekCell.row), r1: rows.indexOf(peekCell.row), c0: cols.indexOf(peekCell.col), c1: cols.indexOf(peekCell.col) })}
          onShowSource={() => p.onShowSource(peekCell.row, peekCell.col)} onClose={() => { set({ peek: false }); table.current?.focus(); }} />
      )}
      {popup?.kind === 'column' && popupProfile && (
        <CsvColumnMenu profile={popupProfile} decimal={decimal} filter={v.filters.find((f) => f.col === popup.col)} style={{ left: popup.left, top: popup.top }}
          frozen={cols.indexOf(popup.col) >= 0 && cols.indexOf(popup.col) < frozen}
          visibleValues={rows.length}
          onSort={(dir) => { set({ sort: [{ col: popup.col, dir }] }); setPopup(null); }}
          onFilter={(f) => setFilter(popup.col, f)}
          onFreeze={() => { set({ frozen: cols.indexOf(popup.col) + 1 }); setPopup(null); }}
          onUnfreeze={() => { set({ frozen: 0 }); setPopup(null); }}
          onHide={() => { if (cols.length > 1) toggleColumn(popup.col); setPopup(null); }}
          onCopy={() => { say(rows.map((row) => data.rows[row]![popup.col] ?? '').join('\n'), `${groupInt(rows.length)} values`); setPopup(null); }}
          onClose={() => { setPopup(null); table.current?.focus(); }} />
      )}
      {popup?.kind === 'options' && (
        <CsvOptionsPopover options={p.options} detected={res.detected} style={{ right: 12, top: 44 }} ignore=".csv-pchip" onChange={p.onOptions} onClose={() => setPopup(null)} />
      )}
      {popup?.kind === 'goto' && <GoToSheet rows={total} onGo={goTo} onClose={() => { setPopup(null); table.current?.focus(); }} />}
    </div>
  );
}
