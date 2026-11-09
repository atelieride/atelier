// Tab drags: a tab pressed and moved 4 px is dragged with pointer events, never the
// system drag — so a release outside the window has no fly-back. Inside the window it lands on the strip (reorder) or
// a pane (PaneDropLayer); outside, main shows the ghost of the pop-out under the pointer and the release opens it there.
import type { GhostIcon, Point } from '@shared/popout';
import { useApp, type TabDropTarget } from './store';
import type { TabKey } from './tabs-model';
import { paneSize, tabDropAt } from './dock-target';
import { fronts, isSplit, stripKeys } from './split';
import { pastThreshold } from './popout-actions';
import { isStarting } from './starting';
import { themeOf } from '@shared/themes';

export type Release = { kind: 'out' } | { kind: 'drop'; target: TabDropTarget } | { kind: 'none' };

/** The window's own pixels (client coordinates): outside them the pointer is over the desktop or another window. */
export function insideViewport(p: Point, view: { width: number; height: number }): boolean {
  return p.x >= 0 && p.y >= 0 && p.x < view.width && p.y < view.height;
}

/** What releasing the drag at client point `p` does. */
export function releaseOf(p: Point, view: { width: number; height: number }, targetAt: (p: Point) => TabDropTarget | null): Release {
  if (!insideViewport(p, view)) return { kind: 'out' };
  const target = targetAt(p);
  return target ? { kind: 'drop', target } : { kind: 'none' };
}

/**
 * A strip target that leaves the tab where it is: in its own strip (`order`, the target pane's tabs), before itself or
 * before the tab after it (the end, for the last). Another pane's strip always moves it.
 */
export function sameSpot(order: TabKey[], key: TabKey, target: TabDropTarget): boolean {
  if (target.kind !== 'strip') return false;
  const i = order.indexOf(key);
  if (i < 0) return false;
  return target.before === key || target.before === (order[i + 1] ?? null);
}

/** Two targets that land the tab at the same place. */
export function sameTarget(a: TabDropTarget | null, b: TabDropTarget | null): boolean {
  if (!a || !b) return a === b;
  if (a.kind === 'strip') return b.kind === 'strip' && a.pane === b.pane && a.before === b.before;
  if (a.kind === 'shelf') return b.kind === 'shelf' && a.before === b.before;
  if (a.kind === 'workspace') return b.kind === 'workspace' && a.id === b.id;
  return b.kind === 'pane' && a.pane === b.pane && a.zone === b.zone;
}

/**
 * The ghost's glyph for a dragged tab: a session (or one still starting) shows its avatar, or its tile with avatars off
 *; another terminal its glyph; a file; any other view.
 */
export function ghostIcon(key: string, term: { session: boolean; starting: boolean } | undefined, avatars: boolean): GhostIcon {
  if (term) return term.session || term.starting ? (avatars ? 'session' : 'session-tile') : 'terminal';
  return key.startsWith('f:') ? 'file' : 'view';
}

/** The ghost's avatar colour: a plain hex colour only (anything else, none). */
export function ghostColor(c: string | undefined): string | undefined {
  return c && /^#[0-9a-fA-F]{3,8}$/.test(c) ? c : undefined;
}

/** How close to the strip's edge (CSS px) a dragged tab scrolls it, and by how much per frame. */
const EDGE_PX = 28;
const SCROLL_STEP = 9;

/** Which way an overflowing strip scrolls with the pointer at `x` over it: -1 near its left edge, 1 near its right. */
export function edgeScroll(x: number, strip: { left: number; right: number }, scroll: { left: number; max: number }): -1 | 0 | 1 {
  if (x < strip.left || x >= strip.right) return 0;
  if (x < strip.left + EDGE_PX && scroll.left > 0) return -1;
  if (x >= strip.right - EDGE_PX && scroll.left < scroll.max) return 1;
  return 0;
}

interface Drag {
  key: TabKey;
  tab: HTMLElement;
  strip: HTMLElement;
  pointerId: number;
  /** Screen point of the press: the threshold counts as main's drag loops do. */
  press: Point;
  /** The pointer's offset in the tab: the chip keeps it under the pointer. */
  grab: Point;
  started: boolean;
  chip: HTMLElement | null;
  size: { width: number; height: number };
  /** The last client point (the strip's autoscroll re-reads the target under it). */
  at: Point | null;
  /** The strip's autoscroll frame, while the pointer is near one of its edges. */
  frame: number;
  off: () => void;
}

let drag: Drag | null = null;
/** Counts the drags main heard of: a pop-out's late reply never ends a newer drag's ghost. */
let drags = 0;

/** A press on a tab (primary button, not on its close button or a rename field): the start of a possible drag. */
export function pressTab(e: PointerEvent, key: TabKey, tab: HTMLElement, strip: HTMLElement): void {
  // ⌃-click is the context menu on macOS.
  if (e.button !== 0 || e.ctrlKey || drag) return;
  if ((e.target as Element | null)?.closest?.('.tab-close, input, textarea')) return;
  const r = tab.getBoundingClientRect();
  const d: Drag = { key, tab, strip, pointerId: e.pointerId, press: { x: e.screenX, y: e.screenY }, grab: { x: e.clientX - r.left, y: e.clientY - r.top }, started: false, chip: null, size: { width: 0, height: 0 }, at: null, frame: 0, off: () => {} };
  const move = (ev: PointerEvent) => { if (ev.pointerId === d.pointerId) onMove(d, ev); };
  const up = (ev: PointerEvent) => { if (ev.pointerId === d.pointerId) onUp(d, ev); };
  const cancel = (ev: PointerEvent) => { if (ev.pointerId === d.pointerId) finish(d, false); };
  // The strip's own capture lost (the tab's, handed to the strip at begin, bubbles up here and doesn't count).
  const lost = (ev: PointerEvent) => { if (ev.target === strip) cancel(ev); };
  const key_ = (ev: KeyboardEvent) => {
    if (ev.key !== 'Escape' || !d.started) return;
    ev.preventDefault();
    ev.stopPropagation();
    finish(d, false);
  };
  const blur = () => finish(d, false);
  // The store ended it (its tab closed, its terminal exited): the drag goes with it.
  const unsub = useApp.subscribe((s, prev) => { if (d.started && prev.tabDrag === d.key && s.tabDrag !== d.key) finish(d, false); });
  window.addEventListener('pointermove', move, true);
  window.addEventListener('pointerup', up, true);
  window.addEventListener('pointercancel', cancel, true);
  window.addEventListener('keydown', key_, true);
  window.addEventListener('blur', blur);
  strip.addEventListener('lostpointercapture', lost);
  // Captured from the press: a fast flick's first moves, already out of the window, arrive as a slow drag's do (the
  // tab keeps the click; begin() hands the capture to the strip).
  try { tab.setPointerCapture(e.pointerId); } catch { /* the pointer is gone: the release ends it */ }
  d.off = () => {
    window.removeEventListener('pointermove', move, true);
    window.removeEventListener('pointerup', up, true);
    window.removeEventListener('pointercancel', cancel, true);
    window.removeEventListener('keydown', key_, true);
    window.removeEventListener('blur', blur);
    strip.removeEventListener('lostpointercapture', lost);
    unsub();
  };
  drag = d;
}

function view() {
  return { width: window.innerWidth, height: window.innerHeight };
}

function onMove(d: Drag, e: PointerEvent): void {
  const p = { x: e.clientX, y: e.clientY };
  const inside = insideViewport(p, view());
  // The button is up over the window (a release that never came): nothing is being dragged. Out of the window macOS
  // may report a move with no button while it is still held, so only a move inside counts.
  if (inside && !(e.buttons & 1)) { finish(d, false); return; }
  if (!d.started) {
    if (!pastThreshold(d.press, { x: e.screenX, y: e.screenY })) return;
    // Its tab went away while pressed (⌘W, its terminal ended): nothing to drag.
    if (!useApp.getState().tabOrder.includes(d.key)) { finish(d, false); return; }
    begin(d);
    if (drag !== d) return;
  }
  d.at = inside ? p : null;
  track(d);
  if (d.chip) {
    d.chip.style.transform = `translate(${p.x - d.grab.x}px, ${p.y - d.grab.y}px)`;
    d.chip.classList.toggle('is-out', !inside);
  }
  autoscroll(d);
}

/** The store learns where the pointer is and where the tab would land there (the strip's caret, the pane zones). */
function track(d: Drag): void {
  const target = d.at ? tabDropAt(d.at, document, d.key) : null;
  // The same target keeps its object: what reads only the target (the strip's caret) doesn't render on every move.
  const cur = useApp.getState().tabDragTarget;
  useApp.setState({ tabDragAt: d.at, tabDragTarget: sameTarget(cur, target) ? cur : target });
}

/** Near an edge of an overflowing strip, the strip scrolls each frame (the target under the pointer follows). */
function autoscroll(d: Drag): void {
  const dir = () => {
    if (!d.at) return 0;
    const r = d.strip.getBoundingClientRect();
    if (d.at.y < r.top || d.at.y >= r.bottom) return 0;
    return edgeScroll(d.at.x, r, { left: d.strip.scrollLeft, max: d.strip.scrollWidth - d.strip.clientWidth });
  };
  if (d.frame || !dir()) return;
  const step = () => {
    d.frame = 0;
    const s = dir();
    if (drag !== d || !s) return;
    d.strip.scrollLeft += s * SCROLL_STEP;
    track(d);
    d.frame = requestAnimationFrame(step);
  };
  d.frame = requestAnimationFrame(step);
}

/** Past the threshold: the pointer is captured (moves and the release keep coming outside the window), the chip shows. */
function begin(d: Drag): void {
  d.started = true;
  try { d.strip.setPointerCapture(d.pointerId); } catch { /* the pointer is gone: the release ends it */ }
  const st = useApp.getState();
  st.setTabDrag(d.key);
  // Ended meanwhile (the store let go of it): nothing more to set up.
  if (drag !== d) return;
  d.size = paneSize();
  document.documentElement.classList.add('is-tab-dragging');
  const chip = document.createElement('div');
  chip.className = `tab-drag-chip${d.tab.classList.contains('is-active') ? ' is-active' : ''}`;
  chip.setAttribute('aria-hidden', 'true');
  for (const n of d.tab.childNodes) chip.append(n.cloneNode(true));
  document.body.append(chip);
  d.chip = chip;
  const term = d.key.startsWith('t:') ? st.terminals.find((x) => x.id === d.key.slice(2)) : undefined;
  const title = (d.tab.querySelector('.tab-name')?.textContent ?? '').slice(0, TITLE_MAX);
  const icon = ghostIcon(d.key, term && { session: !!term.session, starting: isStarting(term, st.starting) }, st.settings.sessionAvatars);
  // Only an avatar wears the session's colour.
  const color = term && icon !== 'session-tile' ? ghostColor(term.color) : undefined;
  const rect = viewRect(d.key);
  const reduced = document.documentElement.dataset.motion === 'reduced';
  // The theme on screen (a preview included): the ghost wears it.
  const theme = themeOf(document.documentElement.dataset.theme ?? 'aurora').id;
  drags++;
  void window.atelier.popout.tearStart({ key: d.key, title, icon, ...(color ? { color } : {}), size: d.size, ...(rect ? { rect } : {}), ...(reduced ? { reduced } : {}), ...(theme !== 'aurora' ? { theme } : {}) }).catch(() => {});
}

/** popout.tearStart's longest title (the IPC schema's). */
export const TITLE_MAX = 300;

/** The tab's view on screen (the pane it is in front of, or the workspace body when it is the one in front), for the ghost. */
function viewRect(key: TabKey): { x: number; y: number; width: number; height: number } | undefined {
  const st = useApp.getState();
  const at = fronts(st.split).indexOf(key);
  const el = isSplit(st.split)
    ? (at >= 0 ? document.querySelector(`.workspace-body > .pane-frame[data-pane="${at}"]`) : null)
    : (st.activeKey() === key ? document.querySelector('.workspace-body') : null);
  const r = el?.getBoundingClientRect();
  return r && r.width >= 1 && r.height >= 1 ? { x: r.left, y: r.top, width: r.width, height: r.height } : undefined;
}

function onUp(d: Drag, e: PointerEvent): void {
  if (!d.started) { finish(d, false); return; }
  // The click a drag ends with never reaches the tab under it.
  const swallow = (ev: Event) => { ev.stopPropagation(); ev.preventDefault(); };
  window.addEventListener('click', swallow, true);
  setTimeout(() => window.removeEventListener('click', swallow, true), 0);
  finish(d, true, { x: e.clientX, y: e.clientY });
}

/** The drag ends: released at `at` (applied), or cancelled. Main's ghost goes unless a pop-out takes its place. */
function finish(d: Drag, release: boolean, at?: Point): void {
  if (drag !== d) return;
  drag = null;
  d.off();
  if (d.frame) cancelAnimationFrame(d.frame);
  d.chip?.remove();
  document.documentElement.classList.remove('is-tab-dragging');
  try {
    for (const el of [d.strip, d.tab]) if (el.hasPointerCapture(d.pointerId)) el.releasePointerCapture(d.pointerId);
  } catch { /* gone */ }
  if (!d.started) return;
  const st = useApp.getState();
  // Where it lands is read from the page as the drag left it: the empty Shelf shows only while a drag is on.
  const r = release && at && st.tabOrder.includes(d.key) ? releaseOf(at, view(), (p) => tabDropAt(p, document, d.key)) : null;
  st.setTabDrag(null);
  const seq = drags;
  // Only while no newer drag started: a pop-out's late reply would end that one's ghost.
  const end = () => { if (seq === drags) void window.atelier.popout.tearEnd().catch(() => {}); };
  if (!r) { end(); return; }
  if (r.kind === 'out') { void st.popOut(d.key, 'cursor', d.size).finally(end); return; }
  end();
  if (r.kind !== 'drop') return;
  if (r.target.kind === 'pane') st.dropTab(d.key, r.target.pane, r.target.zone);
  // On the Shelf: the file is kept there, its tab stays open.
  else if (r.target.kind === 'shelf') { const f = st.openFiles.find((x) => `f:${x.path}` === d.key); if (f) st.addToShelf(f.path, f.rel, r.target.before); }
  // On another workspace's card: the tab moves there.
  else if (r.target.kind === 'workspace') st.moveToWorkspace(d.key, r.target.id);
  else if (!sameSpot(stripKeys(st.split, st.tabOrder, r.target.pane), d.key, r.target)) st.moveTabToPane(d.key, r.target.pane, r.target.before);
}
