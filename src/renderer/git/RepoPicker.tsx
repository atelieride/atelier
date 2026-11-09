import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from '../components/Icon';
import { t } from '../i18n/en';
import { useApp } from '../store';
import { pickerGroups, pickerRows, type PickerRow } from './picker';
import { rowCursor } from '../scm/picker';

/** Room between the chip and the popover, and from the window's edges. */
const GAP = 6;
const MARGIN = 8;
/** The popover is the Changes panel's width minus this. */
const INSET = 16;

/** Over the chip, as wide as the Changes panel minus 16 px, as tall as the room above it allows. */
function placeAbove(anchor: HTMLElement): { left: number; width: number; bottom: number; maxHeight: number } {
  const chip = anchor.getBoundingClientRect();
  const panel = (anchor.closest('.changes') ?? anchor).getBoundingClientRect();
  return {
    left: Math.max(MARGIN, panel.left + INSET / 2), width: Math.max(200, panel.width - INSET),
    bottom: window.innerHeight - chip.top + GAP, maxHeight: Math.max(160, chip.top - GAP - MARGIN)
  };
}

/** The path with its folder dimmed, the filter's match highlighted. */
function Path({ row }: { row: PickerRow }) {
  const text = row.dir + row.name;
  const part = (from: number, to: number): ReactNode => {
    const m = row.match;
    if (!m || m[1] <= from || m[0] >= to) return text.slice(from, to);
    const a = Math.max(m[0], from); const b = Math.min(m[1], to);
    return <>{text.slice(from, a)}<mark className="git-picker-match">{text.slice(a, b)}</mark>{text.slice(b, to)}</>;
  };
  return (
    <span className="git-picker-path">
      {row.dir && <span className="git-picker-dir">{part(0, row.dir.length)}</span>}
      <span className="git-picker-name">{part(row.dir.length, text.length)}</span>
    </span>
  );
}

function Row({ row, index, cursor, target, onPick, onHover }: { row: PickerRow; index: number; cursor: boolean; target: boolean; onPick: (root: string) => void; onHover: (i: number) => void }) {
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (cursor) ref.current?.scrollIntoView({ block: 'nearest' }); }, [cursor]);
  return (
    <button ref={ref} type="button" role="option" aria-selected={target} tabIndex={-1} className={`git-picker-row ${cursor ? 'is-cursor' : ''} ${target ? 'is-target' : ''}`}
      style={{ animationDelay: `${Math.min(index, 12) * 14}ms` }} onClick={() => onPick(row.root)} onMouseMove={() => onHover(index)}>
      <span className="git-picker-main">
        <span className="git-picker-title">
          <Path row={row} />
          {row.draft && <i className="git-picker-draft" data-tip={t.git.picker.draftTip} aria-label={t.git.picker.draftTip} />}
        </span>
        <span className="git-picker-branch mono">{row.branch}</span>
      </span>
      {row.committed && (
        <span className="git-picker-sha mono" data-tip={t.git.picker.committedTip(row.committed)}><Icon name="check" size={10} stroke={2.6} />{row.committed}</span>
      )}
      {row.staged > 0 && <span className="git-picker-count mono" data-tip={t.git.picker.stagedTip(row.staged)}>{row.staged}</span>}
    </button>
  );
}

/**
 * The commit drawer's repository picker: a popover opening upward from the target chip, the
 * Changes panel's width minus 16 px. Groups Staged, Changed, Committed just now and the clean rest; a filter field from
 * 6 repositories, though typing filters at any count. ↑↓ move, Enter chooses, Esc closes (the drawer stays). It lives in
 * a portal: the drawer's blur would otherwise be its containing block.
 */
export function RepoPicker({ anchor, onPick, onClose }: { anchor: HTMLElement; onPick: (root: string) => void; onClose: () => void }) {
  const repos = useApp((s) => s.repos);
  const root = useApp((s) => s.project?.root ?? null);
  const realRoot = useApp((s) => s.project?.realRoot ?? null);
  const project = useMemo(() => [root, realRoot].filter((x): x is string => !!x), [root, realRoot]);
  const target = useApp((s) => s.gitTarget);
  const drafts = useApp((s) => s.gitDrafts);
  const results = useApp((s) => s.gitResult);
  const [query, setQuery] = useState('');
  const groups = useMemo(() => pickerGroups({ repos, project, drafts, results, query }), [repos, project, drafts, results, query]);
  const rows = pickerRows(groups);
  // The cursor is the repository it is on, not a row number: rows move between groups as sessions stage.
  const [at, setAt] = useState<string | null>(target);
  const cursor = rowCursor(rows.map((r) => r.root), at);
  const setCursor = (i: number) => setAt(rows[i]?.root ?? null);
  const box = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLInputElement>(null);
  // Above the chip, the panel's width minus 16 px, placed before the first paint; it follows the window's size.
  const [place, setPlace] = useState(() => placeAbove(anchor));
  const showField = groups.filter || query !== '';

  // The drawer may still be rising (or growing) when it opens: follow the chip until it stays put, and on resize.
  useLayoutEffect(() => {
    let frame = 0; let still = 0; let left = 0; let last = '';
    const follow = () => {
      const next = placeAbove(anchor);
      const key = JSON.stringify(next);
      if (key === last) still++;
      else { still = 0; last = key; setPlace(next); }
      if (still < 3 && --left > 0) frame = requestAnimationFrame(follow);
    };
    const restart = () => { cancelAnimationFrame(frame); still = 0; left = 60; follow(); };
    restart();
    window.addEventListener('resize', restart);
    return () => { cancelAnimationFrame(frame); window.removeEventListener('resize', restart); };
  }, [anchor]);
  // A press outside closes it (the chip toggles it itself).
  useEffect(() => {
    const down = (e: MouseEvent) => {
      const at = e.target as Node;
      if (!box.current?.contains(at) && !anchor.contains(at)) onClose();
    };
    window.addEventListener('mousedown', down, true);
    return () => window.removeEventListener('mousedown', down, true);
  }, [anchor, onClose]);
  // The field takes the keys; without it, the list does.
  useEffect(() => { (showField ? field.current : box.current)?.focus({ preventScroll: true }); }, [showField]);
  useEffect(() => { if (query) setAt(null); }, [query]);
  // The first row shown is pinned by its root at once: Enter before any arrow must still pick what was highlighted.
  useEffect(() => {
    if (at !== null && rows.some((r) => r.root === at)) return;
    const first = rows[0]?.root ?? null;
    if (first !== at) setAt(first);
  });

  const onKey = (e: ReactKeyboardEvent) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (rows.length) setCursor((cursor + (e.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      const r = rows[cursor];
      if (r) onPick(r.root);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    } else if (!showField && e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey && e.key !== ' ') {
      // Typing filters, even below 6 repositories: the field shows up with the first character.
      e.preventDefault();
      setQuery(e.key);
    }
  };

  const group = (key: string, label: string, list: PickerRow[], offset: number) => list.length > 0 && (
    <div className="git-picker-group" data-group={key} role="group" aria-label={label}>
      <span className="git-picker-group-label">{label}</span>
      {list.map((r, i) => (
        <Row key={r.root} row={r} index={offset + i} cursor={cursor === offset + i} target={r.root === target} onPick={onPick} onHover={setCursor} />
      ))}
    </div>
  );
  const { staged, changed, committed, clean } = groups;
  return createPortal(
    <div ref={box} className="git-picker" role="listbox" aria-label={t.git.picker.label} tabIndex={-1} onKeyDown={onKey}
      style={place}>
      {showField && (
        <label className="git-picker-filter">
          <Icon name="search" size={12} stroke={1.8} />
          <input ref={field} value={query} placeholder={t.git.picker.filter(groups.total)} aria-label={t.git.picker.filter(groups.total)} spellCheck={false}
            onChange={(e) => setQuery(e.currentTarget.value)} />
        </label>
      )}
      <div className="git-picker-list">
        {group('staged', t.git.picker.staged, staged, 0)}
        {group('changed', t.git.picker.changed, changed, staged.length)}
        {group('committed', t.git.picker.committed, committed, staged.length + changed.length)}
        {group('clean', t.git.picker.clean, clean, staged.length + changed.length + committed.length)}
        {rows.length === 0 && <p className="git-picker-empty">{t.git.picker.noMatch(query)}</p>}
      </div>
      <div className="git-picker-foot mono">{t.git.picker.keys}</div>
    </div>,
    document.body
  );
}
