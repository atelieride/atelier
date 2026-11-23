import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { useApp } from '../store';
import { usePaneArea } from '../pane-area';
import { gridTemplate, STRIP_PX } from '../pane-place';
import { layoutPanes, type DividerBox } from '../split-layout';
import { arrivedPane } from '../split-tree';
import { enterPane } from '../transitions';
import { PaneDivider } from './PaneDivider';

const sameDividers = (a: DividerBox[], b: DividerBox[]) => a.length === b.length && a.every((d, i) => {
  const e = b[i]!;
  return d.index === e.index && d.dir === e.dir && d.path.join('/') === e.path.join('/')
    && d.rect.x === e.rect.x && d.rect.y === e.rect.y && d.rect.w === e.rect.w && d.rect.h === e.rect.h;
});

/**
 * The split view's geometry, kept in step with the workspace body: whenever the body changes size or the layout tree
 * changes, the panes are laid out again, the body's grid template gets every pane's lines (split only; the views placed
 * on them follow without re-rendering), the measure is published (usePaneArea: room checks, hit tests) and the dividers
 * are drawn on the gaps. A resize is handled in the ResizeObserver's callback, before the frame is painted, so the panes
 * never lag a frame behind the window; one observer for the body's whole life (a divider drag only lays out again).
 * A pane just made (a split, a tab moved to a new pane) springs in once its layout is applied and its line is drawn.
 */
export function PaneLayout() {
  const tree = useApp((s) => s.split.tree);
  const multi = useApp((s) => s.split.panes.length > 1);
  const [dividers, setDividers] = useState<DividerBox[]>([]);
  // The body is this marker's parent: its ref is attached before these effects run (the body's own ref is not yet).
  const marker = useRef<HTMLSpanElement>(null);
  const latest = useRef({ tree, multi });
  latest.current = { tree, multi };
  const apply = useCallback(() => {
    const el = marker.current?.parentElement;
    if (!el) return;
    const { tree: t, multi: split } = latest.current;
    const w = el.clientWidth;
    const h = el.clientHeight;
    const l = layoutPanes(t, w, h);
    if (split) {
      const g = gridTemplate(l.panes, w, h, STRIP_PX);
      el.style.setProperty('grid-template-columns', g.columns);
      el.style.setProperty('grid-template-rows', g.rows);
    } else {
      el.style.removeProperty('grid-template-columns');
      el.style.removeProperty('grid-template-rows');
    }
    usePaneArea.getState().set({ width: w, height: h }, l.panes);
    const next = split ? l.dividers : [];
    setDividers((cur) => (sameDividers(cur, next) ? cur : next));
  }, []);
  // The tree last laid out: the next one tells which pane is new (none for a layout read back, a resize, a close).
  const laid = useRef(tree);
  const [arrival, setArrival] = useState<{ pane: number } | null>(null);
  useLayoutEffect(() => {
    apply();
    const pane = multi ? arrivedPane(laid.current, tree) : null;
    laid.current = tree;
    if (pane !== null) setArrival({ pane });
  }, [apply, tree, multi]);
  // In the commit that adds the new dividers (this component's state), before the frame is painted.
  useLayoutEffect(() => {
    const el = marker.current?.parentElement;
    if (arrival && el) enterPane(el, arrival.pane);
  }, [arrival]);
  useLayoutEffect(() => {
    const el = marker.current?.parentElement;
    if (!el) return;
    const ro = new ResizeObserver(apply);
    ro.observe(el);
    return () => ro.disconnect();
  }, [apply]);
  return <><span ref={marker} hidden />{dividers.map((d) => <PaneDivider key={`${d.path.join('/')}:${d.index}`} box={d} />)}</>;
}
