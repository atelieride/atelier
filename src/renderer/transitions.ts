import { play, reducedMotion } from './motion';
import { arc, crownKeyframes, revealOrigin, type Box, type Pt } from './motion-geometry';

// The in-app transitions: short moves that show where something went. A session picked in the sidebar has the
// selection glide to its row and the workspace rise in; a tab picked has the content slide in from its side; either
// way the tab crown stretches over to the new tab. A new session has a spark fly from the + to its row and its
// terminal open from there. Each plays through play() (none under Reduce motion), takes no pointer, moves the content
// by transform, opacity or clip-path only (a terminal measures its box: no size ever changes), and leaves nothing
// behind once it ends or a newer one cuts it short.

/** --ease, the soft spring and the in-out curve (theme.css), as WAAPI takes them. */
const EASE = 'cubic-bezier(.2,.8,.2,1)';
const SOFT_SPRING = 'cubic-bezier(.3,1.3,.5,1)';
const IN_OUT = 'cubic-bezier(.7,0,.2,1)';
const GLIDE_MS = 380;
const CROWN_MS = 420;
const RISE_MS = 280;
const SLIDE_MS = 300;
const SPARK_MS = 560;
const RING_MS = 480;
const REVEAL_MS = 620;
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

let glide: (Move & { pill: HTMLElement }) | null = null;

/** Takes `.is-gliding` off a row without its highlight's transition: the pill's fill and edge become the row's own. */
function handOver(row: HTMLElement): void {
  row.style.transition = 'none';
  row.classList.remove('is-gliding');
  void getComputedStyle(row).boxShadow;
  row.style.removeProperty('transition');
}

/**
 * The sidebar's selection glides from `from` (or from where a glide still on its way is) to `to` with a soft spring,
 * then becomes `to`'s own highlight. The pill moves in a lane laid over the sidebar's visible box, first in it so the
 * rows paint over the pill, and cut at its edges as the rows are; `to` keeps its own fill and edge hidden
 * (`.is-gliding`) until the pill lands.
 */
export function glideSelection(from: HTMLElement, to: HTMLElement): void {
  const sidebar = to.closest<HTMLElement>('.sidebar');
  if (reducedMotion() || !sidebar || from === to) return;
  const now = glide?.pill.getBoundingClientRect();
  const start = now?.width ? now : from.getBoundingClientRect();
  cut(glide);
  const end = to.getBoundingClientRect();
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
  to.classList.add('is-gliding');
  const m = { ...move(anim, () => { lane.remove(); handOver(to); if (glide === m) glide = null; }), pill };
  glide = m;
}

const flights = new WeakMap<HTMLElement, Move & { fly: HTMLElement }>();

/** `el`'s left edge and width in `strip`'s scrolled content, where the strip's absolutely placed children are. */
function spanIn(strip: HTMLElement, el: HTMLElement): { left: number; width: number } {
  const r = el.getBoundingClientRect();
  return { left: r.left - strip.getBoundingClientRect().left - strip.clientLeft + strip.scrollLeft, width: r.width };
}

/**
 * The tab crown leaves `from` (or where a crown still on its way is), stretches over to `to`, then catches up with it.
 * `to`'s own crown waits under it (`.is-crown-landing`) until it lands.
 */
export function flyCrown(strip: HTMLElement, from: HTMLElement, to: HTMLElement): void {
  if (reducedMotion() || from === to) return;
  const was = flights.get(strip);
  const start = was ? spanIn(strip, was.fly) : spanIn(strip, from);
  cut(was);
  const fly = document.createElement('i');
  fly.className = 'tab-crown-fly';
  fly.style.top = px(to.offsetTop);
  strip.append(fly);
  const anim = play(fly, crownKeyframes(start, spanIn(strip, to)), { duration: CROWN_MS, easing: EASE });
  if (!anim) { fly.remove(); return; }
  to.classList.add('is-crown-landing');
  const m = { ...move(anim, () => { fly.remove(); to.classList.remove('is-crown-landing'); if (flights.get(strip) === m) flights.delete(strip); }), fly };
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

/**
 * A new session arrives: a small dot leaves `from` (the header's +) and arcs to `row`, a thin ring ripples out around
 * the row's avatar as it lands, then the session's terminal (`slot`) opens in a circle from the sidebar's side. The dot
 * and the ring move in a lane over the window that takes no pointer; the terminal is only clipped (its box never
 * changes), fully until the dot lands. Nothing plays when the + or the row is off screen; a newer spark cuts this one.
 */
export function sparkTo(from: HTMLElement, row: HTMLElement, slot: HTMLElement | null): void {
  if (reducedMotion() || !onScreen(from) || !onScreen(row, row.closest('.sidebar'))) return;
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
    play(ring, [{ transform: 'scale(1)', opacity: 0.9 }, { transform: 'scale(5)', opacity: 0 }], { duration: RING_MS, delay: SPARK_MS - 40, easing: EASE })
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
    && !el.classList.contains('pane-frame') && el.getClientRects().length > 0);
}
