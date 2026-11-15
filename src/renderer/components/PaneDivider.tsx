import { memo, useEffect, useRef, useState, type CSSProperties } from 'react';
import { t } from '../i18n/en';
import { useApp } from '../store';
import { usePaneArea } from '../pane-area';
import { DIVIDER_STEP_PX, dragDivider, type DividerBox } from '../split-layout';
import { sizesAt, type LayoutNode } from '../split-tree';

/** Half the grab area on each side of the 1 px gap. */
const GRAB = 4;

/**
 * A divider's grab area in the body: 9 px across its gap, along the whole gap. A vertical one is centered on its gap; a
 * horizontal one lies above it, so none of it covers the tab strip on top of the pane below (a press on a tab's top
 * edge picks the tab).
 */
export function grabStyle({ dir, rect }: DividerBox): CSSProperties {
  return dir === 'row'
    ? { left: rect.x - GRAB, top: rect.y, width: rect.w + 2 * GRAB, height: rect.h }
    : { left: rect.x, top: rect.y - 2 * GRAB, width: rect.w, height: rect.h + 2 * GRAB };
}

/**
 * The divider between two neighbours of a layout group: drag to resize (neither side below its minimum while the
 * workspace has room), double-click for equal sizes in that group, the arrow keys of its direction by 24 px when
 * focused. Between side-by-side panes it is vertical, between stacked ones horizontal. A thin line that brightens on
 * hover over a wider invisible grab area; the store is updated at most once a frame while dragging (the terminals refit
 * through their own ResizeObserver).
 */
export const PaneDivider = memo(function PaneDivider({ box }: { box: DividerBox }) {
  const { path, index, dir } = box;
  const pos = useApp((s) => Math.round((sizesAt(s.split.tree, path) ?? [1]).slice(0, index + 1).reduce((a, b) => a + b, 0) * 100));
  const [dragging, setDragging] = useState(false);
  const start = useRef<{ at: number; tree: LayoutNode } | null>(null);
  const frame = useRef(0);
  const pending = useRef<LayoutNode | null>(null);
  const flush = () => {
    if (frame.current) cancelAnimationFrame(frame.current);
    frame.current = 0;
    const next = pending.current;
    pending.current = null;
    const sizes = next ? sizesAt(next, path) : null;
    if (sizes) useApp.getState().setSizes(path, sizes);
  };
  useEffect(() => () => { if (frame.current) cancelAnimationFrame(frame.current); document.documentElement.classList.remove('is-resizing', 'is-resizing-rows'); }, []);
  const stop = () => {
    if (!start.current) return;
    start.current = null;
    flush();
    setDragging(false);
    document.documentElement.classList.remove('is-resizing', 'is-resizing-rows');
  };
  /** The tree with this divider moved by `delta` px from `tree`, at the body's current size. */
  const moved = (tree: LayoutNode, delta: number) => {
    const area = usePaneArea.getState().area;
    return area ? dragDivider(tree, path, index, delta, area.width, area.height) : tree;
  };
  const along = (e: { clientX: number; clientY: number }) => (dir === 'row' ? e.clientX : e.clientY);
  return (
    <div role="separator" aria-orientation={dir === 'row' ? 'vertical' : 'horizontal'} aria-label={t.split.divider} tabIndex={0}
      aria-valuenow={pos} aria-valuemin={0} aria-valuemax={100} data-pane-keep data-tip={t.split.dividerHint} data-dir={dir}
      className={`pane-divider ${dragging ? 'is-dragging' : ''}`} style={grabStyle(box)}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        start.current = { at: along(e), tree: useApp.getState().split.tree };
        setDragging(true);
        document.documentElement.classList.add(dir === 'row' ? 'is-resizing' : 'is-resizing-rows');
      }}
      onPointerMove={(e) => {
        const s = start.current;
        if (!s) return;
        pending.current = moved(s.tree, along(e) - s.at);
        if (!frame.current) frame.current = requestAnimationFrame(() => { frame.current = 0; flush(); });
      }}
      onPointerUp={(e) => { if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId); stop(); }}
      onPointerCancel={stop}
      onLostPointerCapture={stop}
      onDoubleClick={() => useApp.getState().equalizePanes(path)}
      onKeyDown={(e) => {
        const [less, more] = dir === 'row' ? ['ArrowLeft', 'ArrowRight'] : ['ArrowUp', 'ArrowDown'];
        const step = e.key === more ? DIVIDER_STEP_PX : e.key === less ? -DIVIDER_STEP_PX : 0;
        if (!step) return;
        e.preventDefault();
        const sizes = sizesAt(moved(useApp.getState().split.tree, step), path);
        if (sizes) useApp.getState().setSizes(path, sizes);
      }} />
  );
}, (a, b) => a.box.path.join('/') === b.box.path.join('/') && a.box.index === b.box.index && a.box.dir === b.box.dir
  && a.box.rect.x === b.box.rect.x && a.box.rect.y === b.box.rect.y && a.box.rect.w === b.box.rect.w && a.box.rect.h === b.box.rect.h);
