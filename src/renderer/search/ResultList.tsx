// Find in Files' result list: a row per file, then a row per match under it. Virtualized: only the rows on screen, a few
// more on each side and the selected one are in the page, so 20,000 matches scroll as smoothly as twenty. Rows only
// append while a search streams in; the keyboard walks it as a tree (↑↓, ←→, ⏎, ⌘⏎, ⌘⌫, Esc back to the field).
import { forwardRef, memo, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';
import { isMod, isOtherMod } from '@shared/keys';
import { buildRows as changeRows, type ChangeRow } from '../changes';
import { FileIcon } from '../components/FileIcon';
import { Icon } from '../components/Icon';
import { OriginMarks } from '../components/OriginMarks';
import { useApp } from '../store';
import { TREE_GIT_LETTER, treeGitMap, type TreeGit } from '../tree-git';
import { openFileResult, openResult } from './actions';
import { ts } from './copy';
import { searchAreaMenu, searchFileMenu, searchMatchMenu } from './menus';
import { fileKey, pillCount, previewWindow, treePositions, type Row } from './model';
import { centerOn, leadFor, rowTops, scrollToShow, textChars, visibleRange } from './rows-geometry';
import { useSearch } from './store';

export interface ResultListHandle {
  /** The keyboard into the list: on the selected row, or the first. */
  focusRow(): void;
}

type FileRow = Extract<Row, { kind: 'file' }>;
type MatchRow = Extract<Row, { kind: 'match' }>;

const OVERSCAN = 12;

const nameOf = (rel: string) => rel.slice(rel.lastIndexOf('/') + 1);
const dirOf = (rel: string) => (rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '.');

function rowMenu(e: MouseEvent, row: Row): void {
  e.preventDefault();
  e.stopPropagation();
  useSearch.getState().select(row.key);
  useApp.getState().openMenu(e, row.kind === 'file' ? searchFileMenu(row) : searchMatchMenu(row));
}

function dismissButton(key: string): ReactNode {
  return (
    <button type="button" className="fif-x" tabIndex={-1} aria-label={ts.dismiss} data-tip={ts.dismiss}
      onMouseDown={(e) => e.stopPropagation()} onClick={(e) => { e.stopPropagation(); useSearch.getState().dismiss(key); }}>
      <Icon name="x" size={12} stroke={1.8} />
    </button>
  );
}

/**
 * A match row's text: the line from its first non-blank character, or from just before its match when that would
 * push the match past the row's `room` (in characters); every match marked, its own one more strongly.
 */
function LineText({ row, room }: { row: MatchRow; room: number }) {
  const own = row.line.ranges[row.index];
  const p = previewWindow(row.line, row.index, leadFor(room, own ? own[1] - own[0] : 0));
  const parts: ReactNode[] = [];
  if (p.cut) parts.push('…');
  let at = 0;
  p.marks.forEach(([a, b], k) => {
    if (a > at) parts.push(p.text.slice(at, a));
    parts.push(<mark key={k} className={k === p.strong ? 'is-own' : undefined}>{p.text.slice(a, b)}</mark>);
    at = b;
  });
  if (at < p.text.length) parts.push(p.text.slice(at));
  // The line goes on past what was kept: said so, as the row's own end (the box's own "…" covers what doesn't fit).
  if (p.cutEnd) parts.push('…');
  return <span className="fif-text mono">{parts}</span>;
}

interface RowProps { row: Row; i: number; top: number; selected: boolean; tabbable: boolean; room: number; pos: { pos: number; size: number }; change: ChangeRow | undefined; git: TreeGit | undefined }

const RowView = memo(function RowView({ row, i, top, selected, tabbable, room, pos, change, git }: RowProps) {
  const common = {
    role: 'treeitem', tabIndex: tabbable ? 0 : -1, 'aria-selected': selected, 'aria-posinset': pos.pos, 'aria-setsize': pos.size,
    'data-key': row.key, 'data-rel': row.file.rel, 'data-i': i,
    style: { top }, onContextMenu: (e: MouseEvent) => rowMenu(e, row),
    // The row with the keyboard is the selected one, however it got there (Tab, a click).
    onFocus: () => { const s = useSearch.getState(); if (s.selected !== row.key) s.select(row.key); }
  } as const;
  if (row.kind === 'file') {
    const name = nameOf(row.file.rel);
    return (
      <div {...common} aria-level={1} aria-expanded={!row.collapsed} className={`fif-row is-file${selected ? ' is-selected' : ''}`}
        onClick={() => { const s = useSearch.getState(); s.select(row.key); s.toggleCollapsed(row.key); }}>
        <span className={`fif-chev${row.collapsed ? '' : ' is-open'}`} aria-hidden="true"><Icon name="chevron" size={12} stroke={2} /></span>
        <FileIcon name={name} />
        <span className="fif-name">{name}</span>
        <span className="fif-dir mono">{dirOf(row.file.rel)}</span>
        {change && change.by.length > 0 && <span className="tree-dots"><OriginMarks row={change} /></span>}
        {git && <span className={`tree-badge mono g-${git}`}>{TREE_GIT_LETTER[git]}</span>}
        <span className="fif-count mono" aria-label={ts.results(row.count)} data-tip={ts.results(row.count)}>{pillCount(row.count)}</span>
        {dismissButton(row.key)}
      </div>
    );
  }
  return (
    <div {...common} aria-level={2} data-line={row.line.line} className={`fif-row is-match${selected ? ' is-selected' : ''}`}
      onClick={() => { useSearch.getState().select(row.key); openResult(row.file, row.line, row.index, { side: false, keepFocus: false }); }}
      // As in the Files tree, a double click keeps the preview tab open.
      onDoubleClick={() => useApp.getState().keepOpen(row.file.path)}>
      <LineText row={row} room={room} />
      <span className="fif-ln mono">{row.line.line}</span>
      {dismissButton(row.key)}
    </div>
  );
}, (a, b) => a.i === b.i && a.top === b.top && a.selected === b.selected && a.tabbable === b.tabbable && a.room === b.room && a.change === b.change && a.git === b.git
  && a.pos.pos === b.pos.pos && a.pos.size === b.pos.size
  && a.row.key === b.row.key && a.row.file === b.row.file
  && (a.row.kind === 'file' ? b.row.kind === 'file' && a.row.collapsed === b.row.collapsed && a.row.count === b.row.count : b.row.kind === 'match' && a.row.line === b.row.line));

export const ResultList = forwardRef<ResultListHandle, { rows: Row[]; onEscape: () => void }>(function ResultList({ rows, onEscape }, ref) {
  const scroller = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ top: 0, height: 0, width: 0 });
  const [, rerender] = useState(0);
  const selected = useSearch((s) => s.selected);
  const tops = useMemo(() => rowTops(rows.map((r) => r.kind)), [rows]);
  const index = useMemo(() => new Map(rows.map((r, i) => [r.key, i])), [rows]);
  const places = useMemo(() => treePositions(rows), [rows]);
  const sel = selected === null ? -1 : index.get(selected) ?? -1;
  /** Set when the keyboard moved the selection: the next render shows that row whole and focuses it. */
  const focusAfter = useRef(false);
  /** Set by ⌘⌫: once the rows have changed, the selection goes to the row now at this place. */
  const after = useRef<number | null>(null);

  // The marks the tree shows for a file: who changed it, and its git letter.
  const repos = useApp((s) => s.repos);
  const attributions = useApp((s) => s.attributions);
  const realRoot = useApp((s) => s.project?.realRoot ?? s.project?.root ?? '');
  const changes = useMemo(() => new Map(changeRows(repos, attributions).map((r) => [r.path, r])), [repos, attributions]);
  const git = useMemo(() => treeGitMap(repos, realRoot).files, [repos, realRoot]);

  const move = (i: number) => {
    const r = rows[i];
    if (!r) return;
    focusAfter.current = true;
    useSearch.getState().select(r.key);
    rerender((n) => n + 1);
  };

  useImperativeHandle(ref, () => ({ focusRow: () => move(sel >= 0 ? sel : 0) }));

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    // Mounted again (the view shown again) with a row selected: back in sight, in the middle.
    if (sel >= 0) el.scrollTop = centerOn(tops, sel, el.clientHeight);
    const measure = () => setView({ top: el.scrollTop, height: el.clientHeight, width: el.clientWidth });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Before the effect below: a selection it moves is focused on the render that follows, once that row is drawn.
  useLayoutEffect(() => {
    if (!focusAfter.current) return;
    focusAfter.current = false;
    const el = scroller.current;
    if (!el || sel < 0) return;
    const top = scrollToShow(tops, sel, el.scrollTop, el.clientHeight);
    if (top !== el.scrollTop) {
      el.scrollTop = top;
      setView({ top, height: el.clientHeight, width: el.clientWidth });
    }
    el.querySelector<HTMLElement>(`.fif-row[data-i="${sel}"]`)?.focus({ preventScroll: true });
  });

  useLayoutEffect(() => {
    if (after.current === null) return;
    const i = Math.min(after.current, rows.length - 1);
    after.current = null;
    if (i >= 0) move(i);
  }, [rows]);

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const k = e.nativeEvent;
    if (k.isComposing || isOtherMod(k)) return;
    const mod = isMod(k);
    const row = rows[sel];
    switch (e.key) {
      case 'ArrowDown': move(sel < 0 ? 0 : Math.min(rows.length - 1, sel + 1)); break;
      case 'ArrowUp': move(sel < 0 ? 0 : Math.max(0, sel - 1)); break;
      case 'Home': move(0); break;
      case 'End': move(rows.length - 1); break;
      case 'ArrowLeft':
        if (!row) return;
        if (row.kind === 'file') { if (!row.collapsed) useSearch.getState().toggleCollapsed(row.key); } else move(index.get(fileKey(row.file.path)) ?? sel);
        break;
      case 'ArrowRight':
        if (row?.kind !== 'file') return;
        if (row.collapsed) useSearch.getState().toggleCollapsed(row.key);
        else move(sel + 1);
        break;
      case 'Enter':
        if (!row) return;
        // The keyboard stays in the list, to walk on to the next result.
        if (row.kind === 'match') openResult(row.file, row.line, row.index, { side: mod, keepFocus: true });
        else if (mod) openFileResult(row.file, { side: true, keepFocus: true });
        else useSearch.getState().toggleCollapsed(row.key);
        break;
      case 'Backspace':
      case 'Delete':
        if (!mod || !row) return;
        after.current = sel;
        useSearch.getState().dismiss(row.key);
        break;
      case 'Escape': onEscape(); break;
      default: return;
    }
    e.preventDefault();
    e.stopPropagation();
  };

  const { start, end } = visibleRange(tops, view.top, view.height, OVERSCAN);
  const shown: number[] = [];
  for (let i = start; i < end; i++) shown.push(i);
  // The selected row stays in the page while it is scrolled away: it keeps the keyboard.
  if (sel >= 0 && (sel < start || sel >= end)) shown.push(sel);
  // Tab reaches the list on its selected row, else on the first one drawn.
  const tabbable = sel >= 0 ? sel : start;
  const room = textChars(view.width);
  return (
    <div ref={scroller} className="fif-list" role="tree" aria-label={ts.list} onKeyDown={onKey}
      onScroll={(e) => { const el = e.currentTarget; setView({ top: el.scrollTop, height: el.clientHeight, width: el.clientWidth }); }}
      onContextMenu={(e) => { e.preventDefault(); useApp.getState().openMenu(e, searchAreaMenu()); }}>
      <div className="fif-canvas" role="presentation" style={{ height: tops[rows.length] }}>
        {shown.map((i) => {
          const r = rows[i]!;
          return <RowView key={r.key} row={r} i={i} top={tops[i]!} selected={i === sel} tabbable={i === tabbable} room={room} pos={places[i]!}
            change={r.kind === 'file' ? changes.get(r.file.path) : undefined} git={r.kind === 'file' ? git.get(r.file.path) : undefined} />;
        })}
      </div>
    </div>
  );
});
