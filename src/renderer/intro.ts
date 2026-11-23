import { markPaint } from './brand';
import { play, reducedMotion } from './motion';
import { markPlates, plateTargets, type Box } from './motion-geometry';

// The launch animation, in the first window of an app start: the mark's three plates leaf out and its Λ draws itself,
// then the plates open into the columns on screen (or gather on the Welcome card's mark) and the app's parts rise in.
// Plain DOM over the page, up before React's first frame. The first click or key skips it at once; at rest nothing of
// it is left, on screen or running.

/** Set once played: a reload of the window (which keeps its launch argument) plays nothing. */
const PLAYED = 'atelier-intro-played';
/** The mark's size at the centre of the window, px. */
const MARK = 200;
/** The mark's plates, back to front, as its file draws them. */
const OPACITY = [0.35, 0.6, 1];
/** A plate's corner radius against its side, as in the mark (11 of 40). */
const ROUND = 11 / 40;
const EASE = 'cubic-bezier(.2,.8,.2,1)';
const SPRING = 'cubic-bezier(.3,1.3,.5,1)';
const IN_OUT = 'cubic-bezier(.7,0,.2,1)';
/** How long after the hold the layout may take before the overlay gives up and fades away. */
const CAP = 4000;
/** Past the hold, CAP and this, the launch ends wherever it is: whatever went wrong, the overlay never stays. */
const DEADLINE = 1500;
/** The columns the plates open into. */
const COLUMNS = ['aside.sidebar', 'main.workspace', 'aside.changes'];
/**
 * The app's parts as they rise in once the overlay is gone, each group with its first step and its items (the first 8
 * shown) one step apart. Step n starts RISE_AT + n × RISE_STEP ms after the plates land (steps past RISE_LAST start
 * with it) and rises for RISE_FOR ms: the whole rise ends within RISE_AT + RISE_LAST × RISE_STEP + RISE_FOR ms.
 */
const RISE: [string, number][] = [
  ['.header', 0], ['.activity-bar', 1], ['.sidebar .sidebar-head, .sidebar .list > *', 1], ['.tabs, .session-bar', 2],
  ['.changes-head, .changes-body > *', 2], ['.terminal-slot, .workspace-empty', 3], ['.footer', 4],
  ['.welcome-card > :not(.logo)', 0]
];
const RISE_AT = 60;
const RISE_STEP = 18;
const RISE_LAST = 7;
const RISE_FOR = 300;
const SEAM: Keyframe[] = [
  { transform: 'scaleY(0)', opacity: 1 }, { transform: 'scaleY(1)', opacity: 1, offset: 0.45 }, { transform: 'scaleY(1)', opacity: 0 }
];

type Phase = 'mark' | 'morph' | 'landing' | 'done';

const px = (n: number) => `${n}px`;
const boxOf = (el: Element): Box => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; };
const geometry = (b: Box, radius?: number): Keyframe => ({ left: px(b.x), top: px(b.y), width: px(b.w), height: px(b.h), ...(radius === undefined ? {} : { borderRadius: px(radius) }) });
function place(el: HTMLElement | SVGElement, b: Box, radius?: number): void {
  Object.assign(el.style, geometry(b, radius));
}

/** Whether this window plays it now: never again after a reload, nor when its storage can't say. */
function firstPlay(win: Window): boolean {
  try {
    if (win.sessionStorage.getItem(PLAYED)) return false;
    win.sessionStorage.setItem(PLAYED, '1');
    return true;
  } catch { return false; }
}

/** Plays the launch over `doc`; the layout counts as ready only once `holdMs` have passed. */
export function startIntro(doc: Document, win: Window, holdMs: number): void {
  if (reducedMotion() || !firstPlay(win)) return;
  const root = doc.documentElement;
  const anims = new Set<Animation>();
  const timers: number[] = [];
  let observer: MutationObserver | null = null;
  let phase: Phase = 'mark';

  /** Plays through the motion gate and keeps the animation until it ends, so a skip can cancel it. */
  const run = (el: Element, kf: Keyframe[], o: KeyframeAnimationOptions): Animation | null => {
    const a = play(el, kf, o);
    if (a) {
      anims.add(a);
      const drop = () => anims.delete(a);
      a.addEventListener('finish', drop);
      a.addEventListener('cancel', drop);
    }
    return a;
  };
  /** Resolves once every animation given has finished; rejects when one is cancelled (a skip, or from outside). */
  const after = (list: (Animation | null)[]) => Promise.all(list.map((a) => a?.finished));

  const overlay = doc.createElement('div');
  overlay.className = 'intro';
  overlay.setAttribute('aria-hidden', 'true');
  const unit = markPlates({ x: 0, y: 0, w: 72, h: 72 });
  const plates = unit.map((u, i) => {
    const p = doc.createElement('div');
    p.className = 'intro-plate';
    p.innerHTML = markPaint(u, OPACITY[i]!);
    return p;
  });
  overlay.append(...plates);
  // The mark's Λ (its path, moved by the mark's own 6-unit offset), one stroke drawn from end to end.
  overlay.insertAdjacentHTML('beforeend', '<svg class="intro-lambda" viewBox="0 0 72 72"><path pathLength="1" d="M40 40 L48 20 L56 40"/></svg>');
  const lambda = overlay.lastElementChild as SVGSVGElement;

  let mark: Box = { x: 0, y: 0, w: MARK, h: MARK };
  let from: Box[] = [];
  // At the centre, and again if the window changes size before the plates leave (a window opening maximized).
  const placeMark = () => {
    mark = { x: (win.innerWidth - MARK) / 2, y: (win.innerHeight - MARK) / 2, w: MARK, h: MARK };
    from = markPlates(mark);
    plates.forEach((p, i) => place(p, from[i]!, from[i]!.w * ROUND));
    place(lambda, mark);
  };
  placeMark();
  win.addEventListener('resize', placeMark);
  doc.body.append(overlay);

  // While the overlay covers the window the first click or key was meant for it: it skips the launch and goes no
  // further, unless it is a confirm's (a question is drawn above the overlay and keeps its input). Once the overlay
  // is gone, it only cuts the parts' rise short.
  const skip = (e: Event) => {
    if (overlay.isConnected && !(e.target instanceof Element && e.target.closest('.confirm-sheet'))) { e.preventDefault(); e.stopImmediatePropagation(); }
    end();
  };
  win.addEventListener('pointerdown', skip, { capture: true });
  win.addEventListener('keydown', skip, { capture: true });

  // 1 · The plates leaf out from under the front one, front first, with a small spring; the Λ draws itself.
  const front = from[2]!;
  const leaf = plates.map((p, i) => run(p, [
    { transform: `translate(${px(front.x - from[i]!.x)}, ${px(front.y - from[i]!.y)}) scale(.55)`, opacity: 0 },
    { transform: 'none', opacity: 1 }
  ], { duration: 480, delay: (2 - i) * 70, easing: SPRING, fill: 'backwards' }));
  const draw = run(lambda.firstElementChild!, [{ strokeDashoffset: '1', opacity: 0 }, { opacity: 1, offset: 0.15 }, { strokeDashoffset: '0', opacity: 1 }],
    { duration: 360, delay: 240, easing: IN_OUT, fill: 'backwards' });
  const start = win.performance.now();
  const hold = new Promise<void>((r) => { timers.push(win.setTimeout(r, holdMs)); });
  // Every step hands a failure (an exception, an animation cancelled from outside) to end(): the launch stops there.
  void Promise.all([after([...leaf, draw]), hold]).then(waitForLayout).catch(end);
  timers.push(win.setTimeout(end, holdMs + CAP + DEADLINE));

  const shown = () => doc.querySelector('main.workspace') ?? doc.querySelector('.welcome-card .logo');
  const unwatch = () => { observer?.disconnect(); observer = null; };

  // 2 · The mark holds still until the layout is there (no loop meanwhile), for at most CAP after the hold.
  function waitForLayout(): void {
    if (phase !== 'mark') return;
    if (shown()) { morph().catch(end); return; }
    observer = new MutationObserver(() => { if (shown()) { unwatch(); morph().catch(end); } });
    observer.observe(doc.getElementById('root') ?? doc.body, { childList: true, subtree: true });
    timers.push(win.setTimeout(() => {
      if (phase !== 'mark') return;
      unwatch();
      try { leave(); } catch { end(); }
    }, Math.max(0, start + holdMs + CAP - win.performance.now())));
  }

  // 3 · The plates open into the columns shown, left to right (two plates share the first when there are only two),
  // and take their colors as the mark's paint fades; or they gather on the Welcome card's mark, the Λ with them.
  async function morph(): Promise<void> {
    phase = 'morph';
    win.removeEventListener('resize', placeMark);
    const cols = COLUMNS.map((s) => doc.querySelector<HTMLElement>(s)).filter((e): e is HTMLElement => !!e && e.getBoundingClientRect().width > 0)
      .sort((a, b) => boxOf(a).x - boxOf(b).x);
    const logo = cols.length > 0 ? null : doc.querySelector('.welcome-card .logo');
    // The Welcome card enters with a small pop: its mark is measured once in place.
    const card = logo?.closest('.welcome-card');
    if (card) await Promise.all(card.getAnimations().map((a) => a.finished.catch(() => undefined)));
    if (phase !== 'morph') return;
    const boxes = cols.map(boxOf);
    const welcome = logo ? boxOf(logo) : null;
    if (boxes.length === 0 && !welcome) { leave(); return; }
    const to = plateTargets(boxes, from, welcome);
    const moves: (Animation | null)[] = [];
    plates.forEach((p, i) => {
      const b = to[i]!;
      const radius = welcome ? b.w * ROUND : 0;
      place(p, b, radius);
      moves.push(run(p, [geometry(from[i]!, from[i]!.w * ROUND), geometry(b, radius)], { duration: 480, delay: i * 40, easing: IN_OUT, fill: 'backwards' }));
      if (welcome) return;
      const fade: KeyframeAnimationOptions = { duration: 360, delay: 120 + i * 40, easing: EASE, fill: 'backwards' };
      const paint = p.firstElementChild as SVGElement;
      paint.style.opacity = '0';
      moves.push(run(paint, [{ opacity: 1 }, { opacity: 0 }], fade));
      // A plate under the next one (both on the first column) stays clear: two layers of a translucent panel would
      // land darker than the panel itself.
      if (to[i + 1] === b) return;
      const color = getComputedStyle(cols[boxes.indexOf(b)]!).backgroundColor;
      p.style.backgroundColor = color;
      moves.push(run(p, [{ backgroundColor: 'transparent' }, { backgroundColor: color }], fade));
    });
    if (welcome) {
      place(lambda, welcome);
      moves.push(run(lambda, [geometry(mark), geometry(welcome)], { duration: 480, delay: 80, easing: IN_OUT, fill: 'backwards' }));
    } else {
      lambda.style.opacity = '0';
      moves.push(run(lambda, [{ opacity: 1 }, { opacity: 0 }], { duration: 160, easing: EASE }));
      seams(cols, boxes);
    }
    void after(moves).then(land).catch(end);
  }

  /** One hairline at each inner edge between columns, on the border that edge already has. */
  function seams(cols: HTMLElement[], boxes: Box[]): void {
    for (let k = 0; k + 1 < cols.length; k++) {
      const a = boxes[k]!;
      const right = parseFloat(getComputedStyle(cols[k]!).borderRightWidth) || 0;
      const left = parseFloat(getComputedStyle(cols[k + 1]!).borderLeftWidth) || 0;
      const x = right > 0 ? a.x + a.w - right : left > 0 ? boxes[k + 1]!.x : a.x + a.w;
      const s = doc.createElement('i');
      s.className = 'intro-seam';
      place(s, { x, y: a.y, w: 1, h: a.h });
      doc.body.append(s);
      const anim = run(s, SEAM, { duration: 760, delay: 380 + k * 40, easing: EASE, fill: 'backwards' });
      if (!anim) { s.remove(); continue; }
      anim.addEventListener('finish', () => s.remove());
      anim.addEventListener('cancel', () => s.remove());
    }
  }

  // 4 · The plates now look like the panels under them: the overlay goes, and the parts rise in. They rise as script
  // animations, which play over the parts' own CSS entrances (a row's) without restarting them. The root says the
  // landing is on until they end, for other motion to stay out of its way.
  function land(): void {
    if (phase !== 'morph') return;
    phase = 'landing';
    overlay.remove();
    root.dataset.intro = 'landing';
    const visible = (el: Element) => el.getClientRects().length > 0;
    const parts = RISE.flatMap(([sel, first]) => [...doc.querySelectorAll(sel)].filter(visible).slice(0, 8).map((el, k) =>
      run(el, [{ opacity: 0, transform: 'translateY(6px)' }, { opacity: 1, transform: 'none' }],
        { duration: RISE_FOR, delay: RISE_AT + Math.min(first + k, RISE_LAST) * RISE_STEP, easing: EASE, fill: 'backwards' })));
    void after(parts).then(end, end);
  }

  /** No layout in time: the overlay fades out over the app as it is. */
  function leave(): void {
    phase = 'landing';
    overlay.style.opacity = '0';
    void after([run(overlay, [{ opacity: 1 }, { opacity: 0 }], { duration: 240, easing: EASE })]).then(end, end);
  }

  function end(): void {
    if (phase === 'done') return;
    phase = 'done';
    unwatch();
    for (const t of timers) win.clearTimeout(t);
    win.removeEventListener('resize', placeMark);
    win.removeEventListener('pointerdown', skip, { capture: true });
    win.removeEventListener('keydown', skip, { capture: true });
    for (const a of [...anims]) a.cancel();
    overlay.remove();
    delete root.dataset.intro;
  }
}
