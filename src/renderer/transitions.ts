import { EASE, ELASTIC, IN_OUT, play, reducedMotion, SOFT_SPRING } from './motion';
import { arc, crownKeyframes, revealOrigin, type Box, type Pt } from './motion-geometry';

// The in-app transitions: short moves that show where something went. A session picked in the sidebar has the
// selection glide to its row and the workspace rise in; a tab picked has the content slide in from its side; either
// way the tab crown stretches over to the new tab. A new session has a spark fly from the + to its row and its
// terminal open from there. A pane split off springs in from its side while its line draws. Each plays through
// play() (none under Reduce motion, none while the launch's landing plays), takes no pointer, moves the content by
// transform, opacity or clip-path only (a terminal measures its box: no size ever changes), and leaves nothing behind
// once it ends or a newer one cuts it short.

const GLIDE_MS = 380;
const CROWN_MS = 420;
const RISE_MS = 280;
const SLIDE_MS = 300;
const SPARK_MS = 560;
const RING_MS = 480;
const REVEAL_MS = 620;
const PANE_MS = 520;
const PANE_FADE_MS = 200;
const DRAW_MS = 260;
/** How far from its place a pane split off starts. */
const PANE_SHIFT = 48;
/** Past this, what changes is no longer that click's doing. */
const NAV_MS = 500;

/** Where a navigation comes from: a session row in the sidebar, a tab, or a session just launched (New Session). */
export type NavOrigin = 'sidebar' | 'tab' | 'launch';
let nav: { origin: NavOrigin; at: number } | null = null;

/** Notes where the navigation about to happen comes from. */
export function markNav(origin: NavOrigin): void {
  nav = { origin, at: performance.now() };
}

/**
 * Where the navigation now committing came from; null for any other (the keyboard, the palette, a notification…). The
 * sidebar and the tab strips it changes read it in the same commit, so it stays until that commit is done (a
 * microtask), then is cleared; unread, it lapses after NAV_MS.
 */
export function takeNav(): NavOrigin | null {
  const n = nav;
  if (!n || performance.now() - n.at > NAV_MS) { nav = null; return null; }
  queueMicrotask(() => { if (nav === n) nav = null; });
  return n.origin;
}

const px = (n: number) => `${n}px`;

/**
 * No transition now: under Reduce motion, or while the app's parts rise in at the end of the launch animation (the
 * root's data-intro, intro.ts), whose rise they would play over.
 */
const still = () => reducedMotion() || !!document.documentElement.dataset.intro;

interface Move { anim: Animation; end: () => void }
/** Runs `end` once, when `anim` finishes or is cancelled, or when a newer move calls it first. */
function move(anim: Animation, cleanup: () => void): Move {
  let done = false;
  const end = () => { if (!done) { done = true; cleanup(); } };
  anim.addEventListener('finish', end);
  anim.addEventListener('cancel', end);
  return { anim, end };
}
/** Ends `m` at once (what it added goes now, not at the next frame's cancel event) and stops its animation. */
function cut(m: Move | null | undefined): void {
  if (!m) return;
  m.end();
  m.anim.cancel();
}

let glide: (Move & { pill: HTMLElement; to: HTMLElement }) | null = null;

/**
 * Takes `data-gliding` off a row without its highlight's transition: the pill's fill and edge become the row's own. An
 * attribute, not a class: the row's class is React's, rewritten whenever the row re-renders.
 */
function handOver(row: HTMLElement): void {
  row.style.transition = 'none';
  delete row.dataset.gliding;
  void getComputedStyle(row).boxShadow;
  row.style.removeProperty('transition');
}

/** Where `el` rests: its box without the translation it may have now (a row's entrance). */
function restBox(el: Element): DOMRect {
  const r = el.getBoundingClientRect();
  const m = new DOMMatrixReadOnly(getComputedStyle(el).transform);
  return new DOMRect(r.left - m.m41, r.top - m.m42, r.width, r.height);
}
const sameBox = (a: DOMRect, b: DOMRect) => Math.abs(a.left - b.left) < 0.5 && Math.abs(a.top - b.top) < 0.5
  && Math.abs(a.width - b.width) < 0.5 && Math.abs(a.height - b.height) < 0.5;

/**
 * The sidebar's selection glides from `from` (or from where a glide still on its way is) to `to` with a soft spring,
 * then becomes `to`'s own highlight. The pill moves in a lane laid over the sidebar's visible box, first in it so the
 * rows paint over the pill, and cut at its edges as the rows are; `to` keeps its own fill and edge hidden
 * (`data-gliding`) until the pill lands. Should `to` move meanwhile (another section, the list re-sorted or
 * scrolled), the pill would land beside it: the glide stops there and the row shows its own highlight at once.
 */
export function glideSelection(from: HTMLElement, to: HTMLElement): void {
  const sidebar = to.closest<HTMLElement>('.sidebar');
  if (still() || !sidebar || from === to) return;
  const now = glide?.pill.getBoundingClientRect();
  const start = now?.width ? now : from.getBoundingClientRect();
  cut(glide);
  const end = restBox(to);
  if (!start.width || !end.width) return;
  const s = sidebar.getBoundingClientRect();
  const x = s.left + sidebar.clientLeft;
  const y = s.top + sidebar.clientTop;
  const lane = document.createElement('div');
  lane.className = 'motion-lane';
  Object.assign(lane.style, { left: px(x), top: px(y), width: px(sidebar.clientWidth), height: px(sidebar.clientHeight) });
  const pill = document.createElement('div');
  pill.className = 'motion-pill';
  pill.style.borderRadius = getComputedStyle(to).borderRadius;
  lane.append(pill);
  const at = (r: DOMRect): Keyframe => ({ left: px(r.left - x), top: px(r.top - y), width: px(r.width), height: px(r.height) });
  sidebar.prepend(lane);
  const anim = play(pill, [at(start), at(end)], { duration: GLIDE_MS, easing: SOFT_SPRING });
  if (!anim) { lane.remove(); return; }
  to.dataset.gliding = '';
  const m = { ...move(anim, () => { lane.remove(); handOver(to); if (glide === m) glide = null; }), pill, to };
  glide = m;
  const watch = () => {
    if (glide !== m) return;
    if (!to.isConnected || !sameBox(restBox(to), end)) { cut(m); return; }
    requestAnimationFrame(watch);
  };
  requestAnimationFrame(watch);
}

/** A row moving to another section: the selection on its way to it stops, and the row shows its own highlight now. */
export function cutGlide(row: HTMLElement | null): void {
  if (glide && glide.to === row) cut(glide);
}

const flights = new WeakMap<HTMLElement, Move & { fly: HTMLElement }>();

/** `el`'s left edge and width in `strip`'s scrolled content, where the strip's absolutely placed children are. */
function spanIn(strip: HTMLElement, el: HTMLElement): { left: number; width: number } {
  const r = el.getBoundingClientRect();
  return { left: r.left - strip.getBoundingClientRect().left - strip.clientLeft + strip.scrollLeft, width: r.width };
}

/**
 * The tab crown leaves `from` (or where a crown still on its way is), stretches over to `to`, then catches up with it.
 * `to`'s own crown waits under it (`data-crown-landing`: the tab's class is React's) until it lands.
 */
export function flyCrown(strip: HTMLElement, from: HTMLElement, to: HTMLElement): void {
  if (still() || from === to) return;
  const was = flights.get(strip);
  const start = was ? spanIn(strip, was.fly) : spanIn(strip, from);
  cut(was);
  const fly = document.createElement('i');
  fly.className = 'tab-crown-fly';
  fly.style.top = px(to.offsetTop);
  strip.append(fly);
  const anim = play(fly, crownKeyframes(start, spanIn(strip, to)), { duration: CROWN_MS, easing: EASE });
  if (!anim) { fly.remove(); return; }
  to.dataset.crownLanding = '';
  const m = { ...move(anim, () => { fly.remove(); delete to.dataset.crownLanding; if (flights.get(strip) === m) flights.delete(strip); }), fly };
  flights.set(strip, m);
}

/** `el`'s middle is inside the window, and inside `within`'s box when given (the list it scrolls in). */
function onScreen(el: Element, within?: Element | null): boolean {
  const r = el.getBoundingClientRect();
  if (!r.width || !r.height) return false;
  const x = r.left + r.width / 2;
  const y = r.top + r.height / 2;
  const b = within?.getBoundingClientRect();
  return x >= 0 && y >= 0 && x <= innerWidth && y <= innerHeight && (!b || (x >= b.left && x <= b.right && y >= b.top && y <= b.bottom));
}
const boxOf = (r: DOMRect): Box => ({ x: r.left, y: r.top, w: r.width, h: r.height });
const middle = (r: DOMRect): Pt => [r.left + r.width / 2, r.top + r.height / 2];

let spark: { anims: Animation[]; end: () => void } | null = null;
/** The arc's points: enough for a smooth curve between WAAPI's straight steps. */
const ARC_STEPS = 12;
/** The ring's size as the dot lands and once spread (five times): it grows its box, so its edge stays as thin. */
const RING_FROM = 7;
const RING_TO = 35;

/**
 * A new session arrives: a small dot leaves `from` (the header's +) and arcs to `row`, a thin ring ripples out around
 * the row's avatar as it lands, then the session's terminal (`slot`) opens in a circle from the sidebar's side. The dot
 * and the ring move in a lane over the window that takes no pointer; the terminal is only clipped (its box never
 * changes), fully until the dot lands. Nothing plays when the + or the row is off screen; a newer spark cuts this one.
 */
export function sparkTo(from: HTMLElement, row: HTMLElement, slot: HTMLElement | null): void {
  if (still() || !onScreen(from) || !onScreen(row, row.closest('.sidebar'))) return;
  const was = spark;
  if (was) { was.end(); for (const a of was.anims) a.cancel(); }
  const p0 = middle(from.getBoundingClientRect());
  const target = row.querySelector('.avatar')?.getBoundingClientRect();
  const r = row.getBoundingClientRect();
  // The row may still be rising in (its entrance): the dot lands where it comes to rest. No avatar: its leading edge.
  const shift = new DOMMatrixReadOnly(getComputedStyle(row).transform);
  const land: Pt = target ? middle(target) : [r.left + 14, r.top + r.height / 2];
  const p2: Pt = [land[0] - shift.m41, land[1] - shift.m42];
  const rest: Box = { x: r.left - shift.m41, y: r.top - shift.m42, w: r.width, h: r.height };

  const lane = document.createElement('div');
  lane.className = 'motion-fx';
  const dot = document.createElement('i');
  dot.className = 'motion-spark';
  const ring = document.createElement('i');
  ring.className = 'motion-ring';
  Object.assign(ring.style, { left: px(p2[0]), top: px(p2[1]) });
  lane.append(dot, ring);
  document.body.append(lane);
  // Along the arc, fading in as it leaves the +; at the row it shrinks away into the ring.
  const flight: Keyframe[] = arc(p0, p2, ARC_STEPS).map(([x, y], i) => ({ transform: `translate(${px(x)}, ${px(y)})`, opacity: i ? 1 : 0 }));
  flight.push({ transform: `translate(${px(p2[0])}, ${px(p2[1])}) scale(0)`, opacity: 0 });
  const anims = [
    play(dot, flight, { duration: SPARK_MS, easing: IN_OUT }),
    play(ring, [{ width: px(RING_FROM), height: px(RING_FROM), opacity: 0.9 }, { width: px(RING_TO), height: px(RING_TO), opacity: 0 }], { duration: RING_MS, delay: SPARK_MS - 40, easing: EASE })
  ];
  const s = slot?.getBoundingClientRect();
  if (slot && s?.width) {
    // From the sidebar's side of the terminal: its left edge, its right one when the side panels are swapped.
    const [x, y] = revealOrigin(boxOf(s), rest);
    const at = `at ${px(rest.x + rest.w / 2 > s.left + s.width / 2 ? s.width : x)} ${px(y)}`;
    // Held closed while the dot flies, then open in a circle.
    anims.push(play(slot, [
      { clipPath: `circle(0px ${at})` },
      { clipPath: `circle(0px ${at})`, offset: SPARK_MS / (SPARK_MS + REVEAL_MS), easing: IN_OUT },
      { clipPath: `circle(150% ${at})` }
    ], { duration: SPARK_MS + REVEAL_MS, easing: 'linear' }));
  }
  const [flying, rippling] = anims;
  if (!flying || !rippling) { lane.remove(); for (const a of anims) a?.cancel(); return; }
  flying.addEventListener('finish', () => dot.remove());
  // The ring is the last of the two to go: the lane goes with it.
  const m = { anims: anims.filter((a): a is Animation => !!a), ...move(rippling, () => { lane.remove(); if (spark === m) spark = null; }) };
  spark = m;
}

const entering = new WeakMap<HTMLElement, Animation>();

/**
 * What a navigation shows comes in: rising (`up`, picked in the sidebar) or from the side of the tab picked. A newer
 * entrance of the same element replaces the one still playing.
 */
export function enterView(target: HTMLElement, dir: 'up' | 'left' | 'right'): void {
  if (still()) return;
  const offset = dir === 'up' ? 'translateY(6px)' : `translateX(${dir === 'right' ? 14 : -14}px)`;
  const was = entering.get(target);
  if (was?.playState === 'running') was.cancel();
  const anim = play(target, [{ transform: offset, opacity: 0 }, { transform: 'none', opacity: 1 }], { duration: dir === 'up' ? RISE_MS : SLIDE_MS, easing: EASE });
  if (anim) entering.set(target, anim);
}

/**
 * What pane `pane` shows under its strip, to move as one: with one pane (null), the whole workspace body; split, the
 * pane's views and panels in its body band (its strip, a session's bar and its frame stay where they are).
 */
export function paneContent(body: HTMLElement, pane: number | null): HTMLElement[] {
  if (pane === null) return [body];
  return [...body.children].filter((el): el is HTMLElement => el instanceof HTMLElement
    && el.style.gridColumnStart === `p${pane}l` && el.style.gridRowEnd === `p${pane}b`
    && !el.classList.contains('pane-frame') && !el.classList.contains('pane-under') && el.getClientRects().length > 0);
}

type Edge = 'left' | 'top' | 'right' | 'bottom';
/** Where a pane's content starts from, by the edge of the pane its line is on: from the far side of that line. */
const FROM: Record<Edge, string> = {
  left: `translateX(${PANE_SHIFT}px)`, top: `translateY(${PANE_SHIFT}px)`,
  right: `translateX(${-PANE_SHIFT}px)`, bottom: `translateY(${-PANE_SHIFT}px)`
};

/** Pane `pane`'s box in the body: what of it carries its index (its strip on top, its frame down to its bottom). */
function paneRect(body: HTMLElement, pane: number): DOMRect | null {
  const parts = [...body.querySelectorAll<HTMLElement>(`:scope > [data-pane="${pane}"]`)]
    .map((el) => el.getBoundingClientRect()).filter((r) => r.width > 0 && r.height > 0);
  if (!parts.length) return null;
  const left = Math.min(...parts.map((r) => r.left));
  const top = Math.min(...parts.map((r) => r.top));
  return new DOMRect(left, top, Math.max(...parts.map((r) => r.right)) - left, Math.max(...parts.map((r) => r.bottom)) - top);
}

/**
 * The line a pane (at `box`) was split off on: of the dividers along its edges, one as long as that whole edge (the
 * line between it and the pane it was split from; one between larger groups runs further), the one on its left or
 * above it first (a pane split off to the right or below). Null when no divider borders it so.
 */
function splitLine(body: HTMLElement, box: DOMRect): { el: HTMLElement; edge: Edge } | null {
  const near = (a: number, b: number) => Math.abs(a - b) < 1.5;
  const found: { el: HTMLElement; edge: Edge }[] = [];
  for (const el of body.querySelectorAll<HTMLElement>(':scope > .pane-divider')) {
    const r = el.getBoundingClientRect();
    // The 1 px gap: in the middle of a vertical divider's grab area, in the last pixel of a horizontal one's.
    if (el.dataset.dir === 'row') {
      if (!near(r.top, box.top) || !near(r.bottom, box.bottom)) continue;
      const x = r.left + r.width / 2;
      if (near(x, box.left - 0.5)) found.push({ el, edge: 'left' });
      else if (near(x, box.right + 0.5)) found.push({ el, edge: 'right' });
    } else {
      if (!near(r.left, box.left) || !near(r.right, box.right)) continue;
      const y = r.bottom - 0.5;
      if (near(y, box.top - 0.5)) found.push({ el, edge: 'top' });
      else if (near(y, box.bottom + 0.5)) found.push({ el, edge: 'bottom' });
    }
  }
  const first: Edge[] = ['left', 'top', 'right', 'bottom'];
  return found.sort((a, b) => first.indexOf(a.edge) - first.indexOf(b.edge))[0] ?? null;
}

const lines = new WeakMap<HTMLElement, Move>();

/**
 * A divider's line draws itself along the gap from its middle, a plain hairline (`data-drawing`: the divider's class is
 * React's), then fades into the gap's own line as the pane comes to rest. Only its pseudo-element moves: the grab area
 * keeps its box.
 */
function drawLine(el: HTMLElement): void {
  cut(lines.get(el));
  const along = el.dataset.dir === 'row' ? 'scaleY' : 'scaleX';
  const anim = play(el, [
    { transform: `${along}(0)`, opacity: 1, easing: EASE },
    { transform: `${along}(1)`, opacity: 1, offset: DRAW_MS / PANE_MS, easing: EASE },
    { transform: `${along}(1)`, opacity: 0 }
  ], { duration: PANE_MS, pseudoElement: '::after' });
  if (!anim) return;
  el.dataset.drawing = '';
  const m = move(anim, () => { delete el.dataset.drawing; if (lines.get(el) === m) lines.delete(el); });
  lines.set(el, m);
}

/**
 * Pane `index` was just split off, already laid out where it rests (every terminal has fitted once, to its final
 * size): its content springs in from the far side of the line it was split off on, past its place and back, fading in
 * at the start, while that line draws. Split off to the right it comes from the right, below it rises from below (from
 * the left or above for a pane put before its neighbour). Its strip, a session's bar and its frame stay where they are.
 */
export function enterPane(body: HTMLElement, index: number): void {
  if (still()) return;
  const box = paneRect(body, index);
  if (!box) return;
  const line = splitLine(body, box);
  const from = FROM[line?.edge ?? 'left'];
  const content = paneContent(body, index);
  const moves: Animation[] = [];
  for (const el of content) {
    const was = entering.get(el);
    if (was?.playState === 'running') was.cancel();
    const anim = play(el, [{ transform: from }, { transform: 'none' }], { duration: PANE_MS, easing: ELASTIC });
    play(el, [{ opacity: 0 }, { opacity: 1 }], { duration: PANE_FADE_MS, easing: EASE });
    if (anim) { entering.set(el, anim); moves.push(anim); }
  }
  if (moves[0]) underPane(body, index, moves[0]);
  if (line) drawLine(line.el);
}

/**
 * Under pane `index`'s content while `anim` brings it in: the pane's own background where the content has not arrived
 * yet, never the body's (the colour of the lines between panes). First in the body, so all the pane shows paints over
 * it; it goes when `anim` ends, or as soon as the pane's box changes (a newer layout).
 */
function underPane(body: HTMLElement, index: number, anim: Animation): void {
  const under = document.createElement('div');
  under.className = 'pane-under';
  Object.assign(under.style, { gridColumn: `p${index}l / p${index}r`, gridRow: `p${index}s / p${index}b` });
  body.prepend(under);
  let sized = false;
  // Its first call is its size now; any later one, a new layout.
  const ro = new ResizeObserver(() => { if (sized) gone(); sized = true; });
  const gone = () => { ro.disconnect(); under.remove(); };
  ro.observe(under);
  move(anim, gone);
}
