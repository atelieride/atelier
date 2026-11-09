// The column menu: a header's chevron, a right-click on it, or the
// cell menu's Column Menu…. A JSON column's starts with "Keys in these N rows" — the loaded values' key paths read
// losslessly (json.ts columnProfile: kinds, unix time, presence), each a "+ Column" (a JSON column: keeps the preview,
// reads again) or "column ✓" —, then Filter by Key…, Sort by Key… (a key typed or picked), the sorts, Hide Column, Copy
// Column Name, Copy Column as JSON Lines, Wrap Cells; any other column Sort Ascending, Sort Descending, Filter…, Hide
// Column (a JSON column: Remove Column), Copy Column Name, Wrap Cells. Masks as the grid's (a secret key's kind as
// dots, a masked column no profile). In its tab under its header, one popover at a time; its keys are its own: ↑/↓ Home
// End, Enter, Esc (the keyboard back to the grid), Tab going round. Lazy, with the table's chunk and its stylesheet.
import './json-tools.css';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { create } from 'zustand';
import { typeClass, type DbPath } from '@shared/databases-filters';
import { isMasked, type FormatOpts } from '@shared/pg-format';
import { pathText } from '@shared/pg-json';
import { copyText } from '../clipboard';
import { Icon, type IconName } from '../components/Icon';
import { tdt } from '../i18n/db-table';
import { kbd } from '../kbd';
import { useApp } from '../store';
import { addDerived, inspectedPick, openFilterAt, removeDerived, setColumns, sortBy, useFilterUi } from './filter-actions';
import { placeInBox } from './filter-layout';
import { parsePath, pathProblem } from './filters';
import { gridColumns, sortOf, type GridColumn } from './grid-model';
import { colMenuItems, columnJsonLines, columnProfile, DERIVED_MAX, profileLabel, type ColMenuId } from './json';
import { trapTab } from './popover-kit';
import { useDb, type DbTabState } from './store';
import { useTableUi } from './table-view';
import type { DbTabRef } from './tabs';

const tc = tdt.colMenu;
const WIDTH = 340;
/** Sort by Key…'s picks: the profile's first paths matching what is typed. */
const PICKS = 6;

interface ColMenu { key: string; col: number }
/** The column menu open in this window: its tab and its column (by its value's index in a row). */
export const useColMenu = create<{ open: ColMenu | null }>(() => ({ open: null }));

/**
 * Opens a column's menu — the tab's other popovers (the statement's, a filter's, the Columns checklist) close —, or
 * closes it when it is the one open (its chevron toggles).
 */
export function openColumnMenu(key: string, col: number): void {
  const f = useFilterUi.getState();
  f.closeFilter(key);
  f.closeCols(key);
  useTableUi.getState().closeSql(key);
  const cur = useColMenu.getState().open;
  useColMenu.setState({ open: cur && cur.key === key && cur.col === col ? null : { key, col } });
}

export function closeColumnMenu(key: string): void {
  if (useColMenu.getState().open?.key === key) useColMenu.setState({ open: null });
}

/** The tab's menu when it has one open (shown on Data only; it goes with the tab hidden or closed). */
export function ColumnMenuHost({ tab, st, masked, visible }: { tab: DbTabRef; st: DbTabState; masked: boolean; visible: boolean }) {
  const open = useColMenu((s) => (s.open?.key === tab.key ? s.open : null));
  useEffect(() => { if (!visible) closeColumnMenu(tab.key); }, [visible, tab.key]);
  useEffect(() => () => closeColumnMenu(tab.key), [tab.key]);
  if (!open || !visible || !st.data) return null;
  const g = gridColumns(st.data, tab.schema).find((x) => x.index === open.col);
  if (!g) return null;
  return <ColumnMenuBox key={open.col} tab={tab} st={st} g={g} masked={masked} />;
}

const toast = (text: string, info = true) => useApp.getState().showToast(text, undefined, info ? 'info' : undefined);

/** A menu item: its icon, label and hint; a checkbox for Wrap Cells. */
function Item({ icon, label, hint, checked, disabled, tip, onClick }: { icon?: IconName; label: string; hint?: string; checked?: boolean; disabled?: string | false; tip?: string; onClick: () => void }) {
  return (
    <button type="button" role={checked === undefined ? 'menuitem' : 'menuitemcheckbox'} aria-checked={checked} className="dbj-cm-item" data-mi="" tabIndex={-1}
      disabled={!!disabled} data-tip={disabled || tip} onClick={onClick}>
      {checked !== undefined ? <span className="dbj-cm-check" aria-hidden="true">{checked && <Icon name="check" size={12} stroke={2.2} />}</span>
        : <Icon name={icon ?? 'more'} size={14} />}
      <span className="dbj-cm-label">{label}</span>
      {hint && <span className="dbj-cm-hint">{hint}</span>}
    </button>
  );
}

function ColumnMenuBox({ tab, st, g, masked }: { tab: DbTabRef; st: DbTabState; g: GridColumn; masked: boolean }) {
  const box = useRef<HTMLDivElement>(null);
  const [mode, setMode] = useState<'menu' | 'sort'>('menu');
  const o: FormatOpts = { times: 'stored', now: 0, masked };
  const json = g.derived === null && typeClass(g.col) === 'json';
  const colMasked = isMasked(g.col, o);
  const column = g.derived ? g.derived.column : g.name;
  // The profile of the rows loaded when it opens (a page of big values: json.ts caps what it reads).
  const profile = useMemo(() => (json && !colMasked
    ? columnProfile(st.rows.map((r) => { const c = r[g.index]; return c && c.cut === undefined ? c.v : null; }), masked)
    : null), [json, colMasked, masked]);

  // Under its header (in the tab), slid to stay inside; hidden until placed.
  useLayoutEffect(() => {
    const el = box.current;
    const host = el?.offsetParent;
    if (!el || !(host instanceof HTMLElement)) return;
    const th = host.querySelector(`.dbt-grid th[data-col="${g.index}"]`);
    const hr = host.getBoundingClientRect();
    const ar = th?.getBoundingClientRect() ?? { left: hr.left + 16, right: hr.left + 16, top: hr.top + 80, bottom: hr.top + 124 };
    const p = placeInBox(ar, hr, { width: WIDTH });
    Object.assign(el.style, { left: `${p.left}px`, top: `${p.top}px`, width: `${p.width}px`, maxHeight: `${p.maxHeight}px`, visibility: 'visible' });
  }, [mode]);
  // The keyboard on its first item (Sort by Key…: on the key's field).
  useEffect(() => { box.current?.querySelector<HTMLElement>(mode === 'sort' ? 'input' : '[data-mi]:not(:disabled)')?.focus({ preventScroll: true }); }, [mode]);
  // A press outside closes it (its own chevron toggles it).
  useEffect(() => {
    const down = (e: PointerEvent) => {
      const t = e.target;
      if (!(t instanceof Element) || box.current?.contains(t)) return;
      if (t.closest(`th[data-col="${g.index}"] .dbt-th-menu`)) return;
      closeColumnMenu(tab.key);
    };
    window.addEventListener('pointerdown', down, true);
    return () => window.removeEventListener('pointerdown', down, true);
  }, [tab.key, g.index]);

  /** Closed, the keyboard back to the grid (a filter popover opening takes it instead). */
  const done = (refocus = true) => {
    const grid = box.current?.closest('.dbt')?.querySelector<HTMLElement>('.dbt-grid');
    closeColumnMenu(tab.key);
    if (refocus) grid?.focus({ preventScroll: true });
  };
  const now = () => useDb.getState().tab(tab.key);
  const ready = (st.tableCols ?? (st.columns === null && st.data ? st.data.columns : null)) !== null;
  const tableNames = (st.tableCols ?? st.data!.columns.filter((c) => !st.data!.hidden.includes(c.name))).map((c) => c.name);
  const shownNames = st.columns ?? tableNames;
  const canHide = shownNames.filter((n) => n !== g.name).length > 0;

  const run: Record<ColMenuId, () => void> = {
    'filter-key': () => { done(false); openFilterAt(tab.key, { anchor: 'add', edit: null, target: g.key }, { ready, toggle: false }); },
    filter: () => { done(false); openFilterAt(tab.key, { anchor: 'add', edit: null, target: g.key }, { ready, toggle: false }); },
    'sort-key': () => setMode('sort'),
    'sort-asc': () => { sortBy(tab.key, column, 'asc', g.derived?.path); done(); },
    'sort-desc': () => { sortBy(tab.key, column, 'desc', g.derived?.path); done(); },
    hide: () => { if (canHide) setColumns(tab.key, shownNames.filter((n) => n !== g.name)); done(); },
    remove: () => { if (g.derived) removeDerived(tab.key, g.derived); done(); },
    'copy-name': () => { void copyText(g.label).then((ok) => { if (ok) toast(tc.copiedName); }); done(); },
    'copy-lines': () => {
      const r = columnJsonLines(now().rows.map((row) => row[g.index]), { masked, column: colMasked });
      const n = now().rows.length;
      void copyText(r.text).then((ok) => { if (ok) toast(r.cut > 0 ? tdt.grid.cutInCopy(r.cut) : tc.copiedLines(n), r.cut === 0); });
      done();
    },
    wrap: () => { useDb.getState().patchTab(tab.key, { wrap: !now().wrap }); done(); }
  };
  const meta: Record<ColMenuId, { icon?: IconName; label: string; hint?: string; checked?: boolean; disabled?: string | false }> = {
    'filter-key': { icon: 'filter', label: tc.filterKey },
    filter: { icon: 'filter', label: tc.filter },
    'sort-key': { icon: 'jsonBranch', label: tc.sortKey },
    'sort-asc': { icon: 'arrowUp', label: tc.sortAsc },
    'sort-desc': { icon: 'arrowDown', label: tc.sortDesc },
    hide: { icon: 'eye', label: tc.hide, disabled: !canHide && tc.lastColumn },
    remove: { icon: 'x', label: tc.remove },
    'copy-name': { icon: 'copy', label: tc.copyName },
    'copy-lines': { icon: 'copy', label: tc.copyLines },
    wrap: { label: tc.wrap, hint: kbd('⌥Z'), checked: st.wrap }
  };
  const sorted = sortOf(st.sort, column, g.derived?.path ?? undefined);

  const addKey = (path: DbPath) => {
    if (now().derived.length >= DERIVED_MAX) { toast(tdt.json.act.tooMany); return; }
    // The inspected row stays inspected through the reload (as the JSON view's + Column does).
    addDerived(tab.key, { column: g.name, path }, { pick: inspectedPick(now()) });
    done();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      if (mode === 'sort') setMode('menu'); else done();
      return;
    }
    if (mode !== 'menu') { trapTab(e); return; }
    // A menu: Tab leaves it (closed), as the app's menus do; its items are reached with the arrows.
    if (e.key === 'Tab') { e.preventDefault(); done(); return; }
    const items = [...(box.current?.querySelectorAll<HTMLElement>('[data-mi]') ?? [])].filter((el) => !(el as HTMLButtonElement).disabled);
    const at = items.indexOf(document.activeElement as HTMLElement);
    const to = e.key === 'ArrowDown' ? (at + 1) % items.length : e.key === 'ArrowUp' ? (at <= 0 ? items.length - 1 : at - 1)
      : e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 : null;
    if (to === null || items.length === 0) return;
    e.preventDefault();
    e.stopPropagation();
    items[to]!.focus();
  };

  return (
    <div ref={box} className="dbj-cm" role="menu" aria-label={tc.label(g.label)} tabIndex={-1} style={{ visibility: 'hidden' }} onKeyDown={onKeyDown}>
      <div className="dbj-cm-scroll">
        {mode === 'sort' ? <SortByKey profile={profile?.stats.map((s) => s.path) ?? []} onSort={(path, dir) => { sortBy(tab.key, g.name, dir, path); done(); }} onBack={() => setMode('menu')} /> : (
          <>
            {json && (
              <Profile name={g.name} profile={profile} colMasked={colMasked} loaded={st.rows.length} derived={st.derived} onAdd={addKey} />
            )}
            {colMenuItems({ json, derived: g.derived !== null }).map((id, i) => {
              if (id === 'sep') return <div key={`s${i}`} className="dbj-cm-sep" role="separator" />;
              const m = meta[id];
              const on = (id === 'sort-asc' && sorted?.dir === 'asc') || (id === 'sort-desc' && sorted?.dir === 'desc');
              return <Item key={id} icon={m.icon} label={m.label} hint={m.hint ?? (on ? '✓' : undefined)} checked={m.checked} disabled={m.disabled} onClick={run[id]} />;
            })}
          </>
        )}
      </div>
    </div>
  );
}

/** "Keys in these N rows": a line per key path, its kind and presence; a click adds it as a column. */
function Profile({ name, profile, colMasked, loaded, derived, onAdd }: {
  name: string; profile: ReturnType<typeof columnProfile> | null; colMasked: boolean; loaded: number; derived: DbTabState['derived']; onAdd: (p: DbPath) => void;
}) {
  if (colMasked || !profile) return <><p className="dbj-cm-note">{tc.maskedCol}</p><div className="dbj-cm-sep" role="separator" /></>;
  const head = profile.read < loaded ? tc.keysFirst(profile.read) : tc.keysIn(profile.read);
  const isCol = (p: DbPath) => derived.some((d) => d.column === name && d.path.length === p.length && d.path.every((x, i) => x === p[i]));
  return (
    <>
      <div className="dbj-cm-head"><span>{head}</span>{profile.stats.length > 0 && <span className="dbj-cm-present">{tc.presentIn}</span>}</div>
      {profile.stats.length === 0 ? <p className="dbj-cm-note">{tc.noKeys}</p> : profile.stats.map((s) => {
        const shown = isCol(s.path);
        // A path main's schema would refuse (a key past 256 characters, a NUL): no column, and why.
        const problem = shown ? null : pathProblem(s.path);
        const off = shown || problem !== null;
        const label = profileLabel(s.path);
        const pct = profile.objects > 0 ? Math.round((s.present / profile.objects) * 100) : 0;
        const whole = pathText(s.path);
        return (
          <button key={whole} type="button" role="menuitem" className="dbj-cm-key" data-mi="" tabIndex={-1} aria-disabled={off || undefined}
            aria-label={`${whole} · ${tc.kinds[s.kind]}${shown ? ` · ${tc.shown}` : problem ? ` · ${problem}` : ''}`} data-tip={problem ?? whole}
            onClick={() => { if (!off) onAdd(s.path); }}>
            <span className="dbj-cm-path"><span className="dbj-cm-pre">{label.pre}</span>{label.leaf}</span>
            {shown ? <span className="dbj-cm-kind is-shown">{tc.shown}</span>
              : <><span className="dbj-cm-kind">{tc.kinds[s.kind]}</span>{!problem && <span className="dbj-cm-add">{tc.add}</span>}</>}
            <span className="dbj-cm-bar" data-tip={tc.presentTip(s.present, profile.objects)}><i style={{ width: `${pct}%` }} /></span>
          </button>
        );
      })}
      <div className="dbj-cm-sep" role="separator" />
    </>
  );
}

/** Sort by Key…: a key path typed as the bottom bar writes it (or one of the profile's), then which way. */
function SortByKey({ profile, onSort, onBack }: { profile: readonly DbPath[]; onSort: (p: DbPath, dir: 'asc' | 'desc') => void; onBack: () => void }) {
  const [text, setText] = useState('');
  const [tried, setTried] = useState(false);
  const path = parsePath(text);
  const problem = text.trim() === '' ? tdt.filters.err.path : !path ? tdt.filters.err.badPath : pathProblem(path);
  const q = text.trim().toLowerCase();
  const picks = profile.map((p) => pathText(p)).filter((p) => q === '' || (p.toLowerCase().includes(q) && p.toLowerCase() !== q)).slice(0, PICKS);
  const go = (dir: 'asc' | 'desc') => {
    setTried(true);
    if (!problem && path) onSort(path, dir);
  };
  return (
    <div className="dbj-cm-form">
      <div className="dbj-cm-head"><span>{tc.sortKey}</span></div>
      <div className={`db-input${tried && problem ? ' is-invalid' : ''}`}>
        <Icon name="jsonBranch" size={13} />
        <input value={text} placeholder={tc.keyHint} aria-label={tc.keyPath} spellCheck={false} autoComplete="off" aria-invalid={(tried && !!problem) || undefined}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); go(e.shiftKey ? 'desc' : 'asc'); } }} />
      </div>
      {tried && problem && <p className="dbj-cm-err" role="alert">{problem}</p>}
      {picks.length > 0 && (
        <div className="dbj-cm-picks">
          {picks.map((p) => <button key={p} type="button" className="dbj-cm-pick" data-tip={p} onClick={() => setText(p)}>{p}</button>)}
        </div>
      )}
      <div className="dbj-cm-foot">
        <button type="button" className="btn-ghost sm" onClick={onBack}>{tdt.filters.cancel}</button>
        <button type="button" className="btn-ghost sm" onClick={() => go('desc')}><Icon name="arrowDown" size={12} />{tc.desc}</button>
        <button type="button" className="btn-primary sm" onClick={() => go('asc')}><Icon name="arrowUp" size={12} />{tc.asc}</button>
      </div>
    </div>
  );
}
