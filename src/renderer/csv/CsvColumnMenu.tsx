// CSV viewer: a column's menu — what it holds, sort, show only some values, freeze, hide, copy.
import { useMemo, useState, type CSSProperties, type KeyboardEvent } from 'react';
import { Popover } from './CsvParts';
import { groupInt } from './format';
import { binHeights, shortNumber, tintOf, typeLabel } from './labels';
import type { ColumnProfile, Decimal, ValueFilter } from './types';
import { Icon } from '../components/Icon';
import { t } from '../i18n/en';

/** Values checked in the list: every one without a filter. */
function checkedOf(p: ColumnProfile, f: ValueFilter | undefined): Set<string> {
  const all = p.top.map((x) => x.value);
  if (!f) return new Set(all);
  return new Set(f.mode === 'in' ? all.filter((v) => f.values.includes(v)) : all.filter((v) => !f.values.includes(v)));
}

/** The filter that keeps `checked`: none when all are, 'in' for the shorter list, else 'out'. */
export function filterFor(p: ColumnProfile, checked: Set<string>): ValueFilter | null {
  const all = p.top.map((x) => x.value);
  if (checked.size === all.length) return null;
  const off = all.filter((v) => !checked.has(v));
  return checked.size <= off.length ? { col: p.index, mode: 'in', values: all.filter((v) => checked.has(v)) } : { col: p.index, mode: 'out', values: off };
}

const isoDate = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export function CsvColumnMenu(p: {
  profile: ColumnProfile;
  decimal: Decimal;
  filter: ValueFilter | undefined;
  frozen: boolean;
  visibleValues: number;
  style: CSSProperties;
  onSort: (dir: 'asc' | 'desc') => void;
  onFilter: (f: ValueFilter | null) => void;
  onFreeze: () => void;
  onUnfreeze: () => void;
  onHide: () => void;
  onCopy: () => void;
  onClose: () => void;
}) {
  const prof = p.profile;
  const [query, setQuery] = useState('');
  const checked = checkedOf(prof, p.filter);
  const listable = prof.top.length > 0 && prof.type !== 'integer' && prof.type !== 'decimal' && prof.type !== 'date' && prof.type !== 'datetime';
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? prof.top.filter((x) => x.value.toLowerCase().includes(q)) : prof.top;
  }, [query, prof]);
  const most = Math.max(1, ...prof.top.map((x) => x.count));
  const numeric = prof.type === 'integer' || prof.type === 'decimal';
  const dated = prof.type === 'date' || prof.type === 'datetime';
  const fmt = (n: number | null) => (n === null ? '—' : dated ? isoDate(n) : shortNumber(n, p.decimal));
  const toggle = (v: string, only: boolean) => {
    const next = only ? new Set([v]) : new Set(checked);
    if (!only) { if (next.has(v)) next.delete(v); else next.add(v); }
    p.onFilter(filterFor(prof, next));
  };
  // ↑↓ move between the values; Space and Enter toggle (the rows are buttons).
  const onListKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const items = [...e.currentTarget.querySelectorAll<HTMLElement>('.csv-v')];
    const at = items.indexOf(document.activeElement as HTMLElement);
    items[Math.max(0, Math.min(items.length - 1, at + (e.key === 'ArrowDown' ? 1 : -1)))]?.focus();
  };
  const name = prof.extra ? t.csv.noHeader : prof.name || prof.letter;

  return (
    <Popover className="csv-colmenu" style={p.style} label={t.csv.columnMenu(name)} onClose={p.onClose}>
      <div className="csv-pop-head"><span className="csv-letter is-on">{prof.letter}</span><b>{name}</b><span className="csv-pop-type">{typeLabel(prof)} · {t.csv.values(groupInt(prof.count + prof.empty))}</span></div>
      <div className="csv-stats">
        {numeric || dated ? <>
          <span><i>{t.csv.stats.min}</i><b>{fmt(prof.min)}</b></span>
          <span><i>{t.csv.stats.max}</i><b>{fmt(prof.max)}</b></span>
          <span><i>{t.csv.stats.mean}</i><b>{fmt(prof.mean)}</b></span>
          {numeric && <span><i>{t.csv.stats.sum}</i><b>{fmt(prof.sum)}</b></span>}
        </> : null}
        <span><i>{t.csv.stats.distinct}</i><b>{groupInt(prof.distinct)}</b></span>
        <span><i>{t.csv.stats.empty}</i><b>{groupInt(prof.empty)}</b></span>
      </div>
      {prof.bins && prof.bins.some((b) => b > 0) && (
        <div className="csv-hist" aria-hidden="true">{binHeights(prof.bins, 40).map((h, i) => <i key={i} style={{ height: h }} />)}</div>
      )}
      <div className="csv-sorts">
        <button type="button" className="csv-sort-btn" onClick={() => p.onSort('asc')}><Icon name="arrowUp" size={13} stroke={1.8} />{t.csv.sortAsc}</button>
        <button type="button" className="csv-sort-btn" onClick={() => p.onSort('desc')}><Icon name="arrowDown" size={13} stroke={1.8} />{t.csv.sortDesc}</button>
      </div>
      {listable && <>
        <div className="csv-pop-label">{t.csv.showValues}<button type="button" className="csv-link" onClick={() => p.onFilter(null)}>{t.csv.selectAll}</button></div>
        {prof.top.length > 8 && (
          <label className="csv-mini"><Icon name="search" size={12} stroke={1.8} />
            <input type="text" value={query} placeholder={t.csv.searchValues(groupInt(prof.top.length))} aria-label={t.csv.searchValues(groupInt(prof.top.length))} spellCheck={false} onChange={(e) => setQuery(e.target.value)} />
          </label>
        )}
        <div className="csv-vals" role="group" aria-label={t.csv.showValues} onKeyDown={onListKey}>
          {shown.slice(0, 200).map((x) => {
            const on = checked.has(x.value);
            return (
              <button key={x.value} type="button" role="checkbox" aria-checked={on} className="csv-v" onClick={(e) => toggle(x.value, e.altKey)}>
                <span className={`csv-cb ${on ? 'is-on' : ''}`}>{on && <Icon name="check" size={10} stroke={3} />}</span>
                {prof.type === 'category' && !prof.codes ? <span className={`csv-pill t${tintOf(prof, x.value)}`}>{x.value || '(empty)'}</span>
                  : <span className="csv-v-text">{x.value || '(empty)'}</span>}
                <span className="csv-only" onClick={(e) => { e.stopPropagation(); toggle(x.value, true); }}>{t.csv.only}</span>
                <span className="csv-v-count">{groupInt(x.count)}</span>
                <span className="csv-meter"><i style={{ width: `${(x.count / most) * 100}%` }} /></span>
              </button>
            );
          })}
        </div>
      </>}
      {!listable && !numeric && !dated && prof.distinct > 0 && <div className="csv-pop-note">{t.csv.tooManyValues(groupInt(prof.distinct))}</div>}
      <div className="csv-pop-sep" />
      {p.frozen
        ? <button type="button" className="csv-mi" onClick={p.onUnfreeze}><Icon name="unsplit" size={14} stroke={1.7} />{t.csv.unfreeze}</button>
        : <button type="button" className="csv-mi" onClick={p.onFreeze}><Icon name="lock" size={14} stroke={1.7} />{t.csv.freeze}</button>}
      <button type="button" className="csv-mi" onClick={p.onHide}><Icon name="eye" size={14} stroke={1.7} />{t.csv.hide}</button>
      <button type="button" className="csv-mi" onClick={p.onCopy}><Icon name="copy" size={14} stroke={1.7} />{t.csv.copyColumn}<span className="csv-mi-k">{t.csv.visibleValues(groupInt(p.visibleValues))}</span></button>
    </Popover>
  );
}
