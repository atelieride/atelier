// The Background tab's item list, rendered three ways; the tab's container queries show one: a sectioned list (≥ 640
// px), wrapping pills (360–639 px), one menu button (< 360 px).
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react';
import type { TerminalInfo } from '@shared/protocol';
import { scrollToReveal } from '../../background-output';
import { commandOf, type BgRow, type BgSection } from '../../background-view';
import { copyText } from '../../clipboard';
import { t } from '../../i18n/en';
import type { MenuItem } from '../../menu-model';
import { openBelow } from '../../menus';
import { useApp } from '../../store';
import { Icon } from '../Icon';
import { BG_GLYPH } from '../bg-shared';

const select = (id: string) => useApp.getState().selectBackgroundItem(id);

function rowMenu(term: TerminalInfo, r: BgRow): MenuItem[] {
  const display = commandOf(term, r.id);
  return display ? [{ id: 'copy', label: t.bg.copyCommand, icon: 'copy', run: () => void copyText(display) }] : [];
}

/** ↑/↓ (←/→ for the pills), Home/End: the row to select from the current one, or null for any other key. */
function step(rows: BgRow[], selected: string | null, key: string, sideways: boolean): BgRow | null {
  const i = rows.findIndex((r) => r.id === selected);
  const next = key === 'ArrowDown' || (sideways && key === 'ArrowRight') ? Math.min(rows.length - 1, i + 1)
    : key === 'ArrowUp' || (sideways && key === 'ArrowLeft') ? Math.max(0, i - 1)
    : key === 'Home' ? 0 : key === 'End' ? rows.length - 1 : null;
  return next === null ? null : rows[next] ?? null;
}

export function ItemPicker({ term, sections, selected }: { term: TerminalInfo; sections: BgSection[]; selected: string | null }) {
  const rows = sections.flatMap((s) => s.rows);
  const current = rows.find((r) => r.id === selected) ?? null;
  const onMenu = (e: MouseEvent, r: BgRow) => { const items = rowMenu(term, r); if (items.length) useApp.getState().openMenu(e, items); };
  // Moves the selection with the keyboard and the focus with it (to the same row in whichever view handled the key).
  const onKey = (e: KeyboardEvent<HTMLDivElement>, sideways: boolean) => {
    const to = step(rows, selected, e.key, sideways);
    if (!to) return;
    e.preventDefault();
    select(to.id);
    e.currentTarget.querySelector<HTMLElement>(`[data-id="${CSS.escape(to.id)}"]`)?.focus();
  };

  const openPicker = (el: HTMLElement) => {
    const items: MenuItem[] = [];
    sections.forEach((s, i) => {
      if (i > 0) items.push('sep');
      for (const r of s.rows) items.push({ id: r.id, label: r.label, icon: r.id === selected ? 'check' : BG_GLYPH[r.kind], hint: r.elapsed || undefined, run: () => select(r.id) });
    });
    openBelow(el, items);
  };

  return (
    <>
      <div className="bgv-list" role="listbox" aria-label={t.bg.items} onKeyDown={(e) => onKey(e, false)}>
        {sections.map((s) => (
          <div key={s.key} role="group" aria-label={s.title} className="bgv-group">
            <div className="bgv-group-label" aria-hidden="true">{s.title}<span className="mono">{s.rows.length}</span></div>
            {s.rows.map((r) => (
              <button key={r.id} type="button" role="option" data-id={r.id} aria-selected={r.id === selected} tabIndex={r.id === selected || (!current && r === rows[0]) ? 0 : -1}
                className={`bgv-row st-${r.state} depth-${r.depth}`} onClick={() => select(r.id)} onContextMenu={(e) => onMenu(e, r)}>
                {r.depth === 1 && <span className="bgp-nest mono" aria-hidden="true">└</span>}
                <span className={`bgp-icon k-${r.kind}`}><Icon name={BG_GLYPH[r.kind]} size={14} stroke={1.8} /></span>
                <span className="bgp-main">
                  <span className="bgp-line">
                    <span className="bgp-name">{r.label}</span>
                    <span className="bgp-grow" />
                    <span className="bgp-time mono">{r.elapsed}</span>
                  </span>
                  {r.sub && <span className={`bgp-sub ${r.kind === 'shell' || r.kind === 'monitor' ? 'mono' : ''}`}>{r.sub}</span>}
                </span>
              </button>
            ))}
          </div>
        ))}
      </div>
      <Pills rows={rows} selected={selected} current={current} onMenu={onMenu} onKey={onKey} />
      <div className="bgv-menu">
        <button type="button" className="bgv-menu-btn" aria-haspopup="menu" aria-label={current ? `${t.bg.chooseItem}: ${current.label}` : t.bg.chooseItem} onClick={(e) => openPicker(e.currentTarget)}>
          {current && <span className={`bgp-icon k-${current.kind}`}><Icon name={BG_GLYPH[current.kind]} size={13} stroke={1.8} /></span>}
          <span className="bgv-menu-label">{current?.label ?? t.bg.chooseItem}</span>
          <Icon name="chevronDown" size={12} stroke={2} />
        </button>
      </div>
    </>
  );
}

/**
 * The pills (360–639 px): a radio group bounded to three whole rows. It fades at the bottom while more pills are below,
 * and keeps the chosen pill in view when the selection or the layout changes.
 */
function Pills({ rows, selected, current, onMenu, onKey }: { rows: BgRow[]; selected: string | null; current: BgRow | null; onMenu: (e: MouseEvent, r: BgRow) => void; onKey: (e: KeyboardEvent<HTMLDivElement>, sideways: boolean) => void }) {
  const box = useRef<HTMLDivElement>(null);
  const [more, setMore] = useState(false);
  const measure = useCallback(() => {
    const el = box.current;
    if (el) setMore(el.clientHeight > 0 && el.scrollTop + el.clientHeight < el.scrollHeight - 1);
  }, []);
  const reveal = useCallback(() => {
    const el = box.current;
    const on = el?.querySelector<HTMLElement>('.bgv-pill.is-on');
    if (!el || !on || el.clientHeight === 0) return;
    el.scrollTop = scrollToReveal({ top: on.offsetTop, height: on.offsetHeight }, el);
  }, []);
  useLayoutEffect(() => { reveal(); measure(); }, [selected, rows.length, reveal, measure]);
  // Shown (the tab narrowed into this mode) or resized: the chosen pill comes back into view.
  useEffect(() => {
    const el = box.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => { reveal(); measure(); });
    ro.observe(el);
    return () => ro.disconnect();
  }, [reveal, measure]);
  return (
    <div className="bgv-pills">
      <div ref={box} className={`bgv-pills-in ${more ? 'has-more' : ''}`} role="radiogroup" aria-label={t.bg.items} onScroll={measure} onKeyDown={(e) => onKey(e, true)}>
        {rows.map((r) => (
          <button key={r.id} type="button" role="radio" data-id={r.id} aria-checked={r.id === selected} tabIndex={r.id === selected || (!current && r === rows[0]) ? 0 : -1}
            className={`bgv-pill st-${r.state} ${r.id === selected ? 'is-on' : ''}`} onClick={() => select(r.id)} onContextMenu={(e) => onMenu(e, r)} data-tip={r.label}>
            <span className={`bgp-icon k-${r.kind}`}><Icon name={BG_GLYPH[r.kind]} size={12} stroke={1.9} /></span>
            <span className="bgv-pill-label">{r.label}</span>
            {r.elapsed && <span className="bgv-pill-time mono">{r.elapsed}</span>}
          </button>
        ))}
      </div>
    </div>
  );
}
