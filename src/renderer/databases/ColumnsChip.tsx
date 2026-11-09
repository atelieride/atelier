// The Columns chip: a checklist of the table's columns — Show
// All, typed to find one past eight — applied with Apply (Enter): hidden columns aren't read from the server (main still
// reads the row's key columns to name it: they hide from view only, as a key's tooltip says). Never none: main would
// read them all. Keyboard and placement as the filter popover (FilterPopover.tsx). Lazy, with the table's chunk.
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { DbColumn } from '@shared/databases-filters';
import { Icon } from '../components/Icon';
import { tdt } from '../i18n/db-table';
import { setColumns, toggleColumns } from './filter-actions';
import { chosenColumns, columnsLabel, shownColumns } from './filters';
import { shortType } from './grid-model';
import { CheckList, entersApply, trapTab, useOutside, usePlaced } from './popover-kit';

const tc = tdt.columns;
const WIDTH = 300;

/** Board 1's columns glyph, drawn here rather than in Icon.tsx: the first paint carries none of it. */
function ColumnsGlyph() {
  return (
    <svg width={12} height={12} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="4" width="14" height="12" rx="2" /><path d="M8 4v12M12 4v12" />
    </svg>
  );
}

/**
 * The chip: "9 of 12" with a choice (tinted), "12 columns" without; it opens and closes the checklist — the tab's other
 * popovers (the statement's, a filter's) close as it opens.
 */
export function ColumnsChip({ tabKey, cols, chosen, open }: { tabKey: string; cols: readonly DbColumn[]; chosen: readonly string[] | null; open: boolean }) {
  const shown = shownColumns(cols, chosen).size;
  return (
    <button type="button" className={`dbt-cchip${shown < cols.length ? ' is-on' : ''}${open ? ' is-open' : ''}`} data-fanchor="columns" aria-haspopup="dialog" aria-expanded={open}
      aria-label={`${tc.title}: ${columnsLabel(shown, cols.length)}`} data-tip={tc.tip} onClick={() => toggleColumns(tabKey)}>
      <ColumnsGlyph /><span className="dbt-cchip-label">{columnsLabel(shown, cols.length)}</span>
    </button>
  );
}

/** The checklist (a draft until Apply): Esc or Cancel leaves the choice as it was. */
export function ColumnsPopover({ tabKey, cols, chosen, onClose }: { tabKey: string; cols: readonly DbColumn[]; chosen: readonly string[] | null; onClose: (refocus: boolean) => void }) {
  const [on, setOn] = useState(() => shownColumns(cols, chosen));
  const [q, setQ] = useState('');
  const box = useRef<HTMLDivElement>(null);
  usePlaced(box, ['columns'], WIDTH, []);
  useOutside(box, 'columns', () => onClose(false));
  useEffect(() => { box.current?.querySelector<HTMLElement>('[data-autofocus]')?.focus({ preventScroll: true }); }, []);
  const s = q.trim().toLowerCase();
  const list = s ? cols.filter((c) => c.name.toLowerCase().includes(s)) : cols;
  const none = on.size === 0;
  const toggle = (name: string) => setOn((prev) => {
    const next = new Set(prev);
    if (next.has(name)) next.delete(name);
    else next.add(name);
    return next;
  });
  const apply = () => {
    if (none) return;
    setColumns(tabKey, chosenColumns(cols, on));
    onClose(true);
  };
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onClose(true);
      return;
    }
    trapTab(e);
    if (e.key === 'Enter' && !e.repeat && !e.nativeEvent.isComposing && entersApply(e.target)) {
      e.preventDefault();
      apply();
    }
  };
  return (
    <div ref={box} className="dbt-fpop dbt-cpop" role="dialog" aria-label={tc.title} style={{ visibility: 'hidden' }} onKeyDown={onKey}>
      <div className="dbt-cpop-head">
        <span className="section-label">{tc.title}</span>
        <span className="dbt-sp" />
        <button type="button" className="dbt-link" disabled={on.size === cols.length} onClick={() => setOn(new Set(cols.map((c) => c.name)))}>{tc.showAll}</button>
      </div>
      {cols.length > 8 && (
        <div className="dbt-fpop-find db-input">
          <Icon name="search" size={14} />
          <input data-autofocus value={q} placeholder={tc.find} aria-label={tc.find} spellCheck={false} autoComplete="off" onChange={(e) => setQ(e.target.value)} />
        </div>
      )}
      <div className="dbt-fpop-list dbt-cpop-list">
        <CheckList label={tc.title} autoFocus={cols.length <= 8} onToggle={toggle} items={list.map((c) => ({
          value: c.name, label: c.name, sub: shortType(c.type), checked: on.has(c.name),
          ...(c.isPk ? { icon: 'key' as const, tip: tc.keyTip } : c.fk ? { icon: 'fkArrow' as const } : {})
        }))} />
      </div>
      {none && <p className="db-field-err dbt-fpop-err" role="alert">{tc.none}</p>}
      <div className="dbt-fpop-foot">
        <span className="dbt-cpop-count">{tc.count(on.size, cols.length)}</span>
        <span className="dbt-sp" />
        <button type="button" className="btn-ghost sm" onClick={() => onClose(true)}>{tdt.filters.cancel}</button>
        <button type="button" className="btn-primary sm" disabled={none} onClick={apply}>{tdt.filters.apply}</button>
      </div>
    </div>
  );
}
