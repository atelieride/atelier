// Tab pop-out windows: where tabs leave from and land in the main window's workspace.
import type { Point } from '@shared/popout';
import { zoomFactor } from '@shared/settings';
import { POPOUT_SIZE, useApp, type DockTarget, type TabDropTarget } from './store';
import { shelfIndexAt, shelvable } from './shelf';
import { canMoveToNewPane, dropZone, isSplit, paneOf, stripKeys } from './split';
import { dropTarget, type TabKey } from './tabs-model';
import { workspaceKey } from './workspaces';

/** The pop-out's bar above its tab (.popout-bar in layout.css, kept equal by a test), in CSS pixels. */
export const POPOUT_BAR_PX = 46;

/**
 * The size a tab popped out from the menu opens at: its view as big as it is shown now — the focused pane in a split,
 * else the workspace body — plus the pop-out's bar, in window pixels (CSS pixels × the interface size's zoom), rounded;
 * the default size when neither is on screen.
 */
export function paneSize(): { width: number; height: number } {
  const st = useApp.getState();
  const split = st.split;
  const el = (split.panes.length > 1 ? document.querySelector(`.pane-frame[data-pane="${split.focus}"]`) : null) ?? document.querySelector('.workspace-body');
  const r = el?.getBoundingClientRect();
  if (!r || r.width < 1 || r.height < 1) return { ...POPOUT_SIZE };
  const z = zoomFactor(st.settings.interfaceSize);
  return { width: Math.round(r.width * z), height: Math.round((r.height + POPOUT_BAR_PX) * z) };
}

const within = (r: DOMRect, p: Point) => p.x >= r.left && p.x < r.right && p.y >= r.top && p.y < r.bottom;

/** The panes' frames in the workspace body, in pane order: each pane's frame while split, the whole body with one. */
export function paneRects(body: Pick<Element, 'getBoundingClientRect' | 'querySelectorAll'>): { pane: number; rect: DOMRect }[] {
  const frames = [...body.querySelectorAll<HTMLElement>(':scope > .pane-frame')];
  if (!frames.length) return [{ pane: 0, rect: body.getBoundingClientRect() }];
  return frames.map((f, i) => ({ pane: Number(f.dataset.pane ?? i), rect: f.getBoundingClientRect() }));
}

/**
 * Drag back: where a pop-out released at client point `p` of the main window lands. Over the tab
 * strip: before the tab under the pointer (its right half: the next one), at the end over the strip's padding, over
 * "+" and the empty tab bar after it. Over the workspace: the pane under the pointer and the zone in it, as a dragged
 * tab. Anywhere else in the window (sidebar, header, session bar): the focused pane's middle, so it always lands
 * somewhere shown. Null without a workspace.
 */
export function dockTargetAt(p: Point, doc: Document = document): DockTarget | null {
  return targetAt(p, doc, true);
}

/**
 * A tab dragged inside the window: where it lands as `dockTargetAt` says over the strip
 * and the workspace; a file over the Sessions sidebar's shelf lands there; nowhere
 * elsewhere in the window (released over the rest of the sidebar or a header, nothing changes).
 */
export function tabDropAt(p: Point, doc: Document = document, key: TabKey | null = useApp.getState().tabDrag): TabDropTarget | null {
  return workspaceTargetAt(p, doc, key) ?? shelfTargetAt(p, doc, key) ?? ownPane(targetAt(p, doc, false), key);
}

/**
 * A dragged tab over its own pane: no middle (it is already there), and no edge when it is
 * alone in that pane (it would only move the pane). Elsewhere, and for a pop-out coming back, the target as computed.
 */
function ownPane(target: DockTarget | null, key: TabKey | null): DockTarget | null {
  if (!target || target.kind !== 'pane' || !key) return target;
  const st = useApp.getState();
  const own = isSplit(st.split) ? paneOf(st.split, key) === target.pane : target.pane === 0 && st.tabOrder.includes(key);
  if (!own) return target;
  if (target.zone === 'middle') return null;
  return canMoveToNewPane(st.split, st.tabOrder, key) ? target : null;
}

/**
 * Another workspace's head under the pointer, for a tab that can move (not a
 * project view).
 */
function workspaceTargetAt(p: Point, doc: Document, key: TabKey | null): TabDropTarget | null {
  const st = useApp.getState();
  if (!key || !st.ws?.on || st.popout || !workspaceKey(key) || st.activity !== 'sessions') return null;
  for (const el of doc.querySelectorAll<HTMLElement>('[data-ws-drop]')) {
    if (within(el.getBoundingClientRect(), p)) return { kind: 'workspace', id: el.dataset.wsDrop! };
  }
  return null;
}

/**
 * The Shelf under the pointer, for the dragged tab `key` (passed: the release reads it after the store let go of the
 * drag): before the row whose middle is below it, else last.
 */
function shelfTargetAt(p: Point, doc: Document, key: TabKey | null): TabDropTarget | null {
  const st = useApp.getState();
  if (!key?.startsWith('f:') || st.activity !== 'sessions' || !shelvable(key.slice(2), st.project?.realRoot ?? null)) return null;
  const shelf = doc.querySelector<HTMLElement>('.shelf');
  if (!shelf || !within(shelf.getBoundingClientRect(), p)) return null;
  const rows = [...shelf.querySelectorAll<HTMLElement>('.shelf-row[data-path]')].map((el) => {
    const r = el.getBoundingClientRect();
    return { path: el.dataset.path!, top: r.top, height: r.height };
  });
  return { kind: 'shelf', before: shelfIndexAt(rows, p.y) };
}

/**
 * Over a strip (`strip` in its bar `bar`, showing `order` for pane `pane`): before the tab under the pointer (its right
 * half: the next one), at the end over the strip's padding and right of it in the bar ("+", the pane tools, the empty
 * bar), before the first tab left of it; null when the point is not over that bar.
 */
function stripTargetAt(p: Point, pane: number, strip: Element | null, bar: Element | null, order: TabKey[]): DockTarget | null {
  const stripRect = strip?.getBoundingClientRect();
  const barRect = bar?.getBoundingClientRect();
  if (stripRect && barRect && within(barRect, p) && p.x >= stripRect.right) return { kind: 'strip', pane, before: null };
  if (!strip || !stripRect || !within(stripRect, p)) return null;
  // Only the tab under the pointer counts: one scrolled out of the strip's view lies outside its rect, never under it.
  const tabs = [...strip.querySelectorAll<HTMLElement>('.tab[data-key]')].map((el) => ({ key: el.dataset.key as TabKey, rect: el.getBoundingClientRect() }));
  const over = tabs.find((x) => p.x >= x.rect.left && p.x < x.rect.right);
  if (over) return { kind: 'strip', pane, before: dropTarget(order, over.key, over.rect, p.x) };
  const first = tabs[0];
  return { kind: 'strip', pane, before: first && p.x < first.rect.left ? first.key : null };
}

function targetAt(p: Point, doc: Document, fallback: boolean): DockTarget | null {
  const st = useApp.getState();
  if (isSplit(st.split)) {
    // One strip per pane: `.pane-strip[data-pane]`, each holding its `.tab-strip`.
    for (const bar of doc.querySelectorAll<HTMLElement>('.pane-strip')) {
      const pane = Number(bar.dataset.pane ?? 0);
      const hit = stripTargetAt(p, pane, bar.querySelector('.tab-strip'), bar, stripKeys(st.split, st.tabOrder, pane));
      if (hit) return hit;
    }
  } else {
    const hit = stripTargetAt(p, 0, doc.querySelector('.tab-strip'), doc.querySelector('.tabs'), st.tabOrder);
    if (hit) return hit;
  }
  const body = doc.querySelector<HTMLElement>('.workspace-body');
  if (!body) return null;
  if (within(body.getBoundingClientRect(), p)) {
    const rects = paneRects(body);
    // Between two frames (their 1 px gap): the nearest.
    const dist = (r: DOMRect) => (p.x < r.left ? r.left - p.x : p.x >= r.right ? p.x - r.right : 0);
    const hit = rects.reduce((a, b) => (dist(b.rect) < dist(a.rect) ? b : a));
    return { kind: 'pane', pane: hit.pane, zone: dropZone({ left: hit.rect.left, width: hit.rect.width }, p.x, st.split.panes.length) };
  }
  return fallback ? { kind: 'pane', pane: st.split.focus, zone: 'middle' } : null;
}
