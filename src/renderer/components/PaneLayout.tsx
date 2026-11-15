import { useLayoutEffect, useState, type RefObject } from 'react';
import { useApp } from '../store';
import { usePaneArea } from '../pane-area';
import { gridTemplate, STRIP_PX } from '../pane-place';
import { layoutPanes, type DividerBox } from '../split-layout';
import { PaneDivider } from './PaneDivider';

/**
 * The split view's geometry, kept in step with the workspace body: whenever the body changes size or the layout tree
 * changes, the panes are laid out again, the body's grid template gets every pane's lines (split only; the views placed
 * on them follow without re-rendering), the measure is published (usePaneArea: room checks, hit tests) and the dividers
 * are drawn on the gaps. A resize is handled in the ResizeObserver's callback, before the frame is painted, so the panes
 * never lag a frame behind the window.
 */
export function PaneLayout({ body }: { body: RefObject<HTMLDivElement | null> }) {
  const tree = useApp((s) => s.split.tree);
  const multi = useApp((s) => s.split.panes.length > 1);
  const [dividers, setDividers] = useState<DividerBox[]>([]);
  useLayoutEffect(() => {
    const el = body.current;
    if (!el) return;
    const apply = () => {
      const w = el.clientWidth;
      const h = el.clientHeight;
      const l = layoutPanes(tree, w, h);
      if (multi) {
        const g = gridTemplate(l.panes, w, h, STRIP_PX);
        el.style.setProperty('grid-template-columns', g.columns);
        el.style.setProperty('grid-template-rows', g.rows);
      } else {
        el.style.removeProperty('grid-template-columns');
        el.style.removeProperty('grid-template-rows');
      }
      usePaneArea.getState().set({ width: w, height: h }, l.panes);
      setDividers(multi ? l.dividers : []);
    };
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(el);
    return () => ro.disconnect();
  }, [body, tree, multi]);
  return <>{dividers.map((d) => <PaneDivider key={`${d.path.join('/')}:${d.index}`} box={d} />)}</>;
}
