// What the filter popover and the Columns checklist share: placed inside
// their tab under the bar's element they hang from, closed by a press outside, Tab going round their own controls,
// Enter applying from a field, a checklist with one Tab stop. Lazy, with the table's chunk.
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type RefObject } from 'react';
import { Icon, type IconName } from '../components/Icon';
import { placeInBox } from './filter-layout';

/**
 * Places `box` (absolute, in its tab: its offsetParent) under the bar's element `[data-fanchor="<anchor>"]` — the first
 * of `anchors` still there —, again when `deps` or the tab's size change. Hidden until placed (no jump).
 */
export function usePlaced(box: RefObject<HTMLElement | null>, anchors: readonly string[], width: number, deps: readonly unknown[]): void {
  const place = useRef(() => {});
  place.current = () => {
    const el = box.current;
    const host = el?.offsetParent;
    if (!el || !(host instanceof HTMLElement)) return;
    const a = anchors.map((k) => host.querySelector(`.dbt-fbar [data-fanchor="${k}"]`)).find((x): x is HTMLElement => x instanceof HTMLElement);
    const hr = host.getBoundingClientRect();
    const ar = a?.getBoundingClientRect() ?? { left: hr.left + 16, right: hr.left + 16, top: hr.top + 46, bottom: hr.top + 86 };
    const p = placeInBox(ar, hr, { width });
    Object.assign(el.style, { left: `${p.left}px`, top: `${p.top}px`, width: `${p.width}px`, maxHeight: `${p.maxHeight}px`, visibility: 'visible' });
  };
  useLayoutEffect(() => place.current(), deps);
  useEffect(() => {
    const host = box.current?.offsetParent;
    if (!(host instanceof HTMLElement)) return;
    const ro = new ResizeObserver(() => place.current());
    ro.observe(host);
    return () => ro.disconnect();
  }, []);
}

/** A press outside the popover and its anchor closes it (the anchor toggles it itself). As SqlPopover, useDismiss. */
export function useOutside(box: RefObject<HTMLElement | null>, anchor: string, onOutside: () => void): void {
  const cb = useRef(onOutside);
  cb.current = onOutside;
  useEffect(() => {
    const down = (e: PointerEvent) => {
      const t = e.target;
      if (!(t instanceof Element) || box.current?.contains(t)) return;
      const host = box.current?.offsetParent;
      const a = host?.querySelector(`.dbt-fbar [data-fanchor="${anchor}"]`);
      if (a?.contains(t)) return;
      cb.current();
    };
    window.addEventListener('pointerdown', down, true);
    return () => window.removeEventListener('pointerdown', down, true);
  }, [box, anchor]);
}

/** Tab and Shift+Tab go round the popover's own controls (it sits over the grid: the keyboard stays in it). */
export function trapTab(e: KeyboardEvent<HTMLElement>): void {
  if (e.key !== 'Tab') return;
  const all = [...e.currentTarget.querySelectorAll<HTMLElement>('input, select, button, [tabindex="0"]')]
    .filter((el) => !(el as HTMLButtonElement).disabled && el.tabIndex >= 0 && el.offsetParent !== null);
  if (all.length === 0) return;
  const at = all.indexOf(document.activeElement as HTMLElement);
  if (!e.shiftKey && at === all.length - 1) { e.preventDefault(); all[0]!.focus(); }
  else if (e.shiftKey && at <= 0) { e.preventDefault(); all[all.length - 1]!.focus(); }
}

/** What Enter applies from: a field, a checkbox, a radio; a button (Cancel, Remove, a pick) keeps its own Enter. */
export function entersApply(t: EventTarget): boolean {
  if (!(t instanceof HTMLElement)) return false;
  // A checklist's item or a boolean's true · false (a radio: arrows choose, Enter applies — T31's e2e).
  if (t instanceof HTMLButtonElement) return t.getAttribute('role') === 'checkbox' || t.getAttribute('role') === 'radio';
  return t instanceof HTMLInputElement || t instanceof HTMLSelectElement;
}

export interface CheckItem { value: string; label: string; sub?: string; tip?: string; icon?: IconName; checked: boolean }

/**
 * A checklist: one Tab stop, ↑/↓ Home End move, Space toggles; Enter is the popover's (Apply). Each item a checkbox
 * button with its name (ellipsized) and a dim line (a type). `field`, `autoFocus`: the popover's marks, on the item that
 * has the Tab stop (a problem focuses it; a step starts on it).
 */
export function CheckList({ items, label, onToggle, field, autoFocus = false }: {
  items: readonly CheckItem[]; label: string; onToggle: (v: string) => void; field?: string; autoFocus?: boolean;
}) {
  const [at, setAt] = useState(0);
  const list = useRef<HTMLDivElement>(null);
  const cur = Math.min(at, Math.max(0, items.length - 1));
  const move = (i: number) => {
    setAt(i);
    const el = list.current?.querySelectorAll<HTMLElement>('[role="checkbox"]')[i];
    el?.focus();
    el?.scrollIntoView({ block: 'nearest' });
  };
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const last = items.length - 1;
    const to = e.key === 'ArrowDown' ? Math.min(last, cur + 1) : e.key === 'ArrowUp' ? Math.max(0, cur - 1) : e.key === 'Home' ? 0 : e.key === 'End' ? last : null;
    if (to !== null && last >= 0) { e.preventDefault(); move(to); return; }
    // Enter applies (the popover hears it); a button would take it as a click.
    if (e.key === 'Enter') e.preventDefault();
  };
  return (
    <div ref={list} className="dbt-check" role="group" aria-label={label} onKeyDown={onKey}>
      {items.map((it, i) => (
        <button role="checkbox" aria-checked={it.checked} type="button" key={it.value} tabIndex={i === cur ? 0 : -1} data-tip={it.tip}
          data-field={i === cur ? field : undefined} data-autofocus={i === cur && autoFocus ? '' : undefined}
          className={`dbt-check-item${it.checked ? ' is-on' : ''}`} onClick={() => { setAt(i); onToggle(it.value); }}>
          <span className="dbt-check-box" aria-hidden="true">{it.checked && <Icon name="check" size={11} stroke={2.4} />}</span>
          {it.icon && <span className={`dbt-check-icon is-${it.icon}`} aria-hidden="true"><Icon name={it.icon} size={12} /></span>}
          <span className="dbt-check-label">{it.label}</span>
          {it.sub && <span className="dbt-check-sub">{it.sub}</span>}
        </button>
      ))}
    </div>
  );
}
