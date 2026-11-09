import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { t } from '../i18n/en';
import { useApp } from '../store';
import type { DropZone } from '../split';
import { dockTargetAt, paneRects } from '../dock-target';
import { spaceOf } from '../spaces';
import type { TabKey } from '../tabs-model';
import { Icon } from './Icon';

interface Hit { pane: number; zone: DropZone; box: { left: number; top: number; width: number; height: number } }

const sameHit = (a: Hit | null, b: Hit | null) => a?.pane === b?.pane && a?.zone === b?.zone && a?.box.width === b?.box.width && a?.box.left === b?.box.left;

/**
 * Where a dragged tab would land in the workspace (drags with the pointer): another pane's middle moves it into that
 * pane ("Move to this pane"; its own pane's has no zone); a left
 * or right edge band opens a new pane on that side (fewer than three panes, not for a tab alone in that pane). The
 * pointer is captured by the strip while it drags, so this layer only shows, from the point the store holds; the
 * release is applied by tab-drag.ts (which also computes where it lands, tabDragTarget). A pop-out dragged back over the window lights up the same
 * zones from the point main sends, and the middle says the tab moves back here.
 */
export function PaneDropLayer() {
  const drag = useApp((s) => s.tabDrag);
  const point = useApp((s) => (s.tabDrag ? s.tabDragAt : s.dockHover));
  // Another project's tab: it moves here, not back.
  const across = useApp((s) => !s.tabDrag && !!s.dockHover?.across);
  const dragTarget = useApp((s) => s.tabDragTarget);
  const count = useApp((s) => s.split.panes.length);
  // A pop-out of another space: it goes back to its own space, whatever pane is under it.
  const away = useApp((s) => { const k = !s.tabDrag ? s.dockHover?.key : undefined; const sp = k ? spaceOf(k as TabKey) : null; return sp && sp !== s.space ? sp : null; });
  const [hit, setHit] = useState<Hit | null>(null);
  const layer = useRef<HTMLDivElement>(null);
  // A drag that ended (dropped, cancelled with Esc, released elsewhere) leaves nothing lit for the next one.
  useEffect(() => { if (!point) setHit(null); }, [point]);

  /** The lit area for a pane and zone, in the layer's coordinates (split: each pane's content frame; one pane: the whole body). */
  const boxOf = (pane: number, zone: DropZone, origin: DOMRect, r: DOMRect): Hit => {
    // A new pane takes about half of this one: the half on that side lights up; the middle lights up the whole pane.
    const half = r.width / 2;
    const left = zone === 'right' ? r.left + half : r.left;
    const inset = 6;
    return { pane, zone, box: { left: left - origin.left + inset, top: r.top - origin.top + inset, width: (zone === 'middle' ? r.width : half) - 2 * inset, height: r.height - 2 * inset } };
  };
  useLayoutEffect(() => {
    if (!point) return;
    if (away) {
      // The whole workspace lights up, saying where it goes.
      const el = layer.current;
      const r = el?.getBoundingClientRect();
      const next: Hit | null = r ? { pane: 0, zone: 'middle', box: { left: 6, top: 6, width: r.width - 12, height: r.height - 12 } } : null;
      setHit((cur) => (sameHit(cur, next) ? cur : next));
      return;
    }
    const target = drag ? dragTarget : dockTargetAt(point);
    const el = layer.current;
    const body = el?.parentElement;
    const rects = el && body ? paneRects(body) : [];
    const at = target?.kind === 'pane' ? rects.find((x) => x.pane === target.pane) : undefined;
    const next = target?.kind === 'pane' && el && at ? boxOf(target.pane, target.zone, el.getBoundingClientRect(), at.rect) : null;
    setHit((cur) => (sameHit(cur, next) ? cur : next));
  }, [point, drag, dragTarget, count, away]);
  if (!drag && !point) return null;

  const docking = !drag;
  return (
    <div className="pane-drop-layer" ref={layer}>
      {hit && (
        <div className={`pane-drop is-${hit.zone}`} style={hit.box} data-zone={hit.zone} data-pane={hit.pane}>
          <span className="pane-drop-label">
            <Icon name={hit.zone !== 'middle' ? 'split' : docking ? 'dock' : 'splitFocus'} size={13} stroke={1.8} />
            {away ? t.spaces.backTo(t.spaces.names[away]) : hit.zone !== 'middle' ? t.split.dropNew : docking ? (across ? t.moveWin.dropHere : t.popout.dropHere) : t.split.dropHere}
          </span>
        </div>
      )}
    </div>
  );
}
