// The open live demo. Loaded on
// intent by live-demo.ts, never with the page. One stage per page, built on first use and kept: after an exit the
// demo's iframe stays alive but hidden (paused), so opening again resumes where the visitor left.
//
// Opening, the launch (a Mac app opening from its Dock icon): the click presses the window (a copy of its frame, over
// the page, 160 ms down to .985 and darker; the page's own window leaves) and an "Opening Atelier…" pill beats where
// "Try it live" was, as the page dims to 70 %. The demo's iframe is created at once, at its final size (it lays out
// once), invisible, and starts loading on the next frame. When the demo says `ready`, and never sooner than 240 ms
// after the click, the live app itself zooms open from the window's place: from .93 to its size, downscaled (crisp)
// all the way, opaque by a third of the way, as the page goes fully dim, the header leaves and the copy and the pill
// fade. A feature row's view is sent at `ready`, before the app shows. The demo shares this page's main thread (same
// origin), so every motion is transforms and opacity, played by the compositor whatever the demo's scripts do.
// Leaving (the demo's `exit`, Back, a failure): the app shrinks a little toward the window and fades, the window's
// copy comes back at its place, the page undims.
// The stage's styles travel with it as a string (Astro's script bundling drops a stylesheet imported by a lazy chunk),
// added once, on first open: the page's CSS does not carry them.
import css from '../styles/live-demo.css?inline';
import { demoEntry, demoMessage, isDemoToPage, keyFromEvent, type DemoView, type MessageBody, type PageToDemo } from '../../../src/demo/protocol';
import { documentVisibility, visibleTimeout } from '../../../src/demo/visible-timeout';
import { readyTimeout } from '../lib/live-demo';

export interface OpenOptions {
  /** The control that opened it (focus returns there); null: opened by the page itself (/demo). */
  trigger: HTMLElement | null;
  /** The view the demo starts on (a MenuCommand or a demo view: feature rows). */
  view?: string;
  /** The /demo page: the URL is already /demo, nothing to press (the app opens from the screen's centre), and leaving
   *  goes home. */
  direct: boolean;
}

type Phase = 'closed' | 'opening' | 'open' | 'closing';
type Point = { x: number; y: number };
const html = document.documentElement;
/** The app never shows sooner than this after the click: a launch, not a glitch. */
const BEAT = 240;
/** A start this slow says so (the pill's second line). */
const SLOW = 2500;
/** A Mac window's zoom: quick out of the gate, a long soft landing. */
const ZOOM = 'cubic-bezier(.16, 1, .3, 1)';
/** Leaving gathers speed; the page undims with a plain ease-out. */
const SHRINK = 'cubic-bezier(.4, 0, .9, .6)';
const UNDIM = 'cubic-bezier(.4, 0, .2, 1)';
const MARK = '<svg width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5.5 15.5L10 4.5l4.5 11"/></svg>';
const SVG = (d: string, size: number) => `<svg width="${size}" height="${size}" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;

let phase: Phase = 'closed';
let root: HTMLElement | null = null;
let opts: OpenOptions = { trigger: null, direct: false };
let iframe: HTMLIFrameElement | null = null;
let ready = false;
let failed = false;
let view: string | undefined;
/** Cancels the wait for `ready` (visible time only: a background tab stalls the demo's frames). */
let cancelWait = () => { /* not waiting */ };
/** An opening waiting for `ready` (true) or given up (false: a failure, a close). */
let waiting: ((ok: boolean) => void) | null = null;
/** Each opening and closing: an opening whose turn has passed stops at its next step. */
let gen = 0;
let scrollTop = 0;
let inerted: HTMLElement[] = [];
/** The stage's animations under way: the app's, the page's dim, the pressed window's, the pill's. */
let running: Animation[] = [];
let slowTimer = 0;
/** Where the app opens from and closes to: the window's centre on screen (or the screen's). */
let spot: Point = { x: 0, y: 0 };
let ui: ReturnType<typeof build> | null = null;

const el = (tag: string, cls?: string) => { const e = document.createElement(tag); if (cls) e.className = cls; return e; };
const frameOf = () => root?.querySelector<HTMLElement>('.frame') ?? null;
/** What leaves the page while the demo is open: the window with what floats on it (the hero's bar). */
const windowOf = () => root?.querySelector<HTMLElement>('.window') ?? frameOf();
const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const ease = () => getComputedStyle(html).getPropertyValue('--ease').trim() || 'ease';
const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const frames2 = () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));

function build() {
  const style = el('style');
  style.textContent = css;
  document.head.append(style);
  const stage = el('div', 'demo-stage');
  stage.hidden = true;
  stage.tabIndex = -1;
  stage.setAttribute('role', 'dialog');
  stage.setAttribute('aria-modal', 'true');
  stage.setAttribute('aria-label', 'Atelier live demo');
  const backdrop = el('div', 'demo-backdrop');
  // The window pressed: a copy of its frame at its place, over the dimming page.
  const press = el('div', 'demo-press');
  press.hidden = true;
  press.setAttribute('aria-hidden', 'true');
  // The open window, its shadow and edge on a layer behind it; the live app in it.
  const shade = el('div', 'demo-shade');
  const win = el('div', 'demo-win');
  // "Opening Atelier…": a status (its text is set as it shows, so it is announced), which also describes the dialog
  // while the demo starts (the focus lands on the stage, and a screen reader reads it with the dialog's name).
  const pill = el('div', 'demo-launch');
  pill.id = 'demo-launch';
  pill.setAttribute('role', 'status');
  pill.hidden = true;
  stage.setAttribute('aria-describedby', pill.id);
  stage.append(backdrop, press, shade, win, pill);
  // The failure toast: in the page from the start (empty) so screen readers announce it when it fills.
  const toast = el('div', 'demo-toast');
  toast.setAttribute('role', 'status');
  toast.hidden = true;
  document.body.append(stage, toast);
  // A click on the dimmed edge would take the focus out of the demo: keep it there.
  backdrop.addEventListener('pointerdown', (e) => { e.preventDefault(); focusDemo(); });
  addEventListener('message', onMessage);
  addEventListener('popstate', onPopState);
  addEventListener('keydown', (e) => { if (e.key === 'Escape' && !toast.hidden && phase === 'closed') hideToast(); });
  return { stage, backdrop, press, shade, win, pill, toast };
}

/** Starts a script animation of the stage (filling both ways: it holds its ends until the stage settles). */
function animate(e: Element, k: Keyframe[], o: KeyframeAnimationOptions) {
  const a = e.animate(k, { fill: 'both', ...o });
  running.push(a);
  return a;
}
/** Every animation of the stage (or of `e` only) stopped, back to its own styles: always in the same task as what
 *  replaces them, so no frame shows the gap. */
function settle(e?: Element) {
  for (const a of running) if (!e || (a.effect as KeyframeEffect).target === e) a.cancel();
  running = e ? running.filter((a) => (a.effect as KeyframeEffect).target !== e) : [];
}
/** The open window's own coordinates of a point on screen (its layout box: whatever a motion does to it). */
const within = (e: HTMLElement, p: Point) => `${p.x - e.offsetLeft}px ${p.y - e.offsetTop}px`;
const done = (as: Animation[]) => Promise.all(as.map((a) => a.finished)).then(() => true, () => false);

/** Opens the demo from `from`, a [data-live-demo] window. */
export async function openDemo(from: HTMLElement, o: OpenOptions) {
  if (phase !== 'closed') return;
  const u = (ui ??= build());
  const g = ++gen, t0 = performance.now(), still = reduced(), resumed = ready;
  root = from;
  opts = o;
  view = o.view;
  failed = false;
  hideToast();
  scrollTop = scrollY;
  // From the hero: a history entry of its own, so Back leaves the demo (Forward, back here, opens it again).
  if (!o.direct && !(history.state as { demo?: boolean } | null)?.demo) history.pushState({ demo: true }, '', '/demo');
  phase = 'opening';
  html.dataset.demo = 'opening';
  // A modal: the page behind can be neither focused nor clicked, nor read out.
  inerted = [...document.body.children].filter((c): c is HTMLElement => c instanceof HTMLElement && c !== u.stage && c !== u.toast && !c.inert);
  for (const c of inerted) c.inert = true;
  addEventListener('keydown', onKey, true);
  // The window pressed, at once (the /demo page has none to press: the app opens from the screen's centre).
  const frame = o.direct ? null : frameOf();
  const f = frame?.getBoundingClientRect() ?? null;
  spot = centre(f);
  if (frame && f) {
    const copy = pressed(frame, f);
    const w = windowOf();
    if (w) w.style.visibility = 'hidden';
    animate(copy.dim, [{ opacity: 0 }, { opacity: 1 }], { duration: 220, easing: ease() });
    if (!still) animate(copy.frame, [{ transform: 'none' }, { transform: 'scale(.985)' }], { duration: 160, easing: ease() });
  }
  u.stage.hidden = false;
  u.stage.focus({ preventScroll: true });
  animate(u.backdrop, [{ opacity: 0 }, { opacity: 0.7 }], { duration: 600, easing: ease() });
  // The demo boots (or wakes); a first start shows the pill while it does.
  if (!iframe) load();
  else if (ready) post({ type: 'resume' });
  if (!ready) launching(f, still);
  if (!(await whenReady()) || g !== gen) return;
  // The view first, unseen (a feature row): two frames for it to draw before the app shows.
  const had = view !== undefined;
  sendView();
  await Promise.all([resumed ? null : wait(BEAT - (performance.now() - t0)), had ? frames2() : null]);
  if (g !== gen) return;
  await zoomOpen(g, still);
}

/** The window's frame, copied (the same decoded image, lights and live layers), at its place over the dim. */
function pressed(frame: HTMLElement, f: DOMRect) {
  const u = ui!;
  const copy = frame.cloneNode(true) as HTMLElement;
  for (const img of copy.querySelectorAll('img')) { img.alt = ''; img.loading = 'eager'; }
  const dim = el('i', 'demo-press-dim');
  copy.append(dim);
  u.press.replaceChildren(copy);
  Object.assign(u.press.style, { left: `${f.left}px`, top: `${f.top}px`, width: `${f.width}px` });
  u.press.hidden = false;
  return { frame: copy, dim };
}

/** Where the window is for the eye: the centre of its part on screen (the hero runs past the fold), or the screen's. */
function centre(f: DOMRect | null): Point {
  if (!f) return { x: innerWidth / 2, y: innerHeight / 2 };
  const top = Math.max(f.top, 0), bottom = Math.min(f.bottom, innerHeight);
  return { x: (f.left + f.right) / 2, y: bottom > top ? (top + bottom) / 2 : innerHeight / 2 };
}

/** The pill, where "Try it live" was (a feature row has none: the window's centre on screen), while the demo starts. */
function launching(f: DOMRect | null, still: boolean) {
  const u = ui!;
  const hover = f ? root?.querySelector<HTMLElement>('.demo-pill') : null;
  const r = hover && Number(getComputedStyle(hover).opacity) > 0.5 ? hover.getBoundingClientRect() : null;
  const at = r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : spot;
  Object.assign(u.pill.style, { left: `${at.x}px`, top: `${at.y}px` });
  u.pill.innerHTML = `<span class="demo-launch-mark" aria-hidden="true">${MARK}</span><span class="demo-launch-text"><span>Opening Atelier…</span> <span class="demo-launch-more"><small></small></span></span>`;
  u.pill.hidden = false;
  loading(true);
  if (!still) animate(u.pill, [{ opacity: 0, transform: 'translate(-50%, -50%) scale(.92)' }, { opacity: 1, transform: 'translate(-50%, -50%)' }], { duration: 240, easing: ZOOM });
  // A slow start (a slow machine, a cold cache) says so, quietly; the beat goes on.
  slowTimer = window.setTimeout(() => {
    u.pill.querySelector('small')!.textContent = 'First start takes a moment';
    u.pill.classList.add('is-slow');
  }, SLOW);
}

function loading(on: boolean) {
  const s = ui!.stage;
  s.classList.toggle('is-loading', on);
  if (on) s.setAttribute('aria-busy', 'true'); else s.removeAttribute('aria-busy');
}

/** The pill gone (its text with it, so it is not read as the dialog's description any more). */
function unlaunch() {
  const u = ui!;
  clearTimeout(slowTimer);
  loading(false);
  u.pill.hidden = true;
  u.pill.classList.remove('is-slow');
  u.pill.replaceChildren();
}

/** The live app zooms open from the window's place, its own size at the end: scaled down, never up, so it stays crisp
 *  (the compositor rasters it at its largest scale, 1). The page goes fully dim; the copy and the pill fade. */
async function zoomOpen(g: number, still: boolean) {
  const u = ui!;
  phase = 'open';
  html.dataset.demo = 'open';
  // The dim and the pill go on from where they are (the copy keeps its press while it fades).
  const dim = getComputedStyle(u.backdrop).opacity, pill = getComputedStyle(u.pill).opacity;
  settle(u.backdrop);
  settle(u.pill);
  clearTimeout(slowTimer);
  loading(false);
  u.stage.classList.add('is-ready');
  focusDemo();
  u.win.style.transformOrigin = u.shade.style.transformOrigin = within(u.win, spot);
  const zoom = [u.win, u.shade].flatMap((e) => still
    ? [animate(e, [{ opacity: 0 }, { opacity: 1 }], { duration: 180, easing: ease() })]
    : [animate(e, [{ transform: 'scale(.93)' }, { transform: 'none' }], { duration: 300, easing: ZOOM }),
      animate(e, [{ opacity: 0 }, { opacity: 1, offset: 0.3 }, { opacity: 1 }], { duration: 300 })]);
  animate(u.backdrop, [{ opacity: dim }, { opacity: 1 }], { duration: 300, easing: ease() });
  if (!u.press.hidden) animate(u.press, [{ opacity: 1 }, { opacity: 0 }], { duration: 220, easing: ease() });
  if (!u.pill.hidden) animate(u.pill, [{ opacity: pill }, { opacity: 0 }], { duration: 140, easing: ease() });
  if (!(await done(zoom)) || g !== gen) return;
  settle();
  rest();
}

/** The open stage at rest: no animation, no transform, nothing of the launch left. */
function rest() {
  const u = ui!;
  u.press.hidden = true;
  u.press.replaceChildren();
  unlaunch();
  u.win.style.transformOrigin = u.shade.style.transformOrigin = '';
}

function whenReady() {
  return ready ? Promise.resolve(true) : new Promise<boolean>((r) => { waiting = r; });
}
function stopWaiting(ok: boolean) {
  const w = waiting;
  waiting = null;
  w?.(ok);
}

function load() {
  const u = ui!;
  ready = false;
  const f = document.createElement('iframe');
  f.title = 'Atelier live demo';
  // Same origin: no sandbox (with scripts and same-origin allowed it would restrict nothing); the demo's own CSP
  // (connect-src 'none') is what keeps it off the network.
  f.allow = 'fullscreen; keyboard-map; clipboard-write';
  f.addEventListener('error', fail);
  u.win.append(f);
  iframe = f;
  // The directory, not its index.html (Cloudflare Pages redirects that), from the next frame: the press's first frame
  // is committed to the compositor before the demo starts its work.
  requestAnimationFrame(() => { if (iframe === f) f.src = demoEntry(import.meta.env.DEV); });
  cancelWait = visibleTimeout(readyTimeout(root?.dataset.demoTimeout), fail, documentVisibility(document));
}

function post(m: MessageBody<PageToDemo>) {
  iframe?.contentWindow?.postMessage(demoMessage(m), location.origin);
}
function focusDemo() {
  if (!iframe || !ready || phase !== 'open') return;
  iframe.focus();
  post({ type: 'focus' });
}
function sendView() {
  if (view) post({ type: 'open', view: view as DemoView });
  view = undefined;
}

function onMessage(e: MessageEvent) {
  // Only the demo's own window, from this origin, with a message of the protocol's exact shape.
  if (!iframe || e.source !== iframe.contentWindow || e.origin !== location.origin || !isDemoToPage(e.data)) return;
  const m = e.data;
  if (m.type === 'ready') {
    if (ready) return;
    ready = true;
    cancelWait();
    stopWaiting(true);
  } else if (m.type === 'exit') leave();
  else if (m.type === 'failed') fail();
  else if (m.type === 'fullscreen') { if (phase === 'open') iframe.requestFullscreen?.().catch(() => { /* refused: the demo stays in its frame */ }); }
  // 'checklist': nothing on the page shows it (yet).
}

/** While the demo is open every key is the app's. Keys pressed inside the iframe never reach this
 *  page; one that does means the focus slipped out (a click on the edge): it goes back in, and so does the key. */
function onKey(e: KeyboardEvent) {
  e.preventDefault();
  e.stopImmediatePropagation();
  if (phase !== 'open' || !ready) return;
  focusDemo();
  post({ type: 'key', key: keyFromEvent(e) });
}

/** A way out chosen inside the demo, or a failure. From the hero the demo has a history entry: going back through it
 *  keeps Back and Forward consistent (popstate then closes). The /demo page goes home, unless the demo failed: then
 *  the page stays, with the toast. */
function leave() {
  if (phase === 'closed' || phase === 'closing') return;
  if (!opts.direct && (history.state as { demo?: boolean } | null)?.demo) history.back();
  else if (opts.direct && !failed) location.assign('/');
  else void close();
}

function fail() {
  cancelWait();
  stopWaiting(false);
  iframe?.remove();
  iframe = null;
  ready = false;
  if (phase === 'closed' || phase === 'closing') return;
  failed = true;
  leave();
}

function onPopState(e: PopStateEvent) {
  const demo = (e.state as { demo?: boolean } | null)?.demo === true;
  if (demo && phase === 'closed' && root && !opts.direct) void openDemo(root, { ...opts, direct: false });
  else if (!demo && phase !== 'closed') void close();
}

/** Leaving: the app shrinks toward the window's place and fades (gone by about 110 ms), the window's copy comes back
 *  where the window is, the page undims; a launch cut short unpresses the window and the pill fades. Everything starts
 *  from where it is on screen. */
async function close() {
  if (phase === 'closed' || phase === 'closing') return;
  const u = ui!, still = reduced();
  ++gen;
  phase = 'closing';
  stopWaiting(false);
  clearTimeout(slowTimer);
  removeEventListener('keydown', onKey, true);
  if (document.fullscreenElement) await document.exitFullscreen().catch(() => { /* already out */ });
  if (ready) post({ type: 'pause' });
  else if (iframe) { cancelWait(); iframe.remove(); iframe = null; } // still loading: the next opening starts afresh
  html.dataset.demo = 'closing';
  for (const c of inerted) c.inert = false;
  inerted = [];
  // The page back where it was before the window comes back (something may have scrolled it under the demo), so the
  // window lands on the frame's real place.
  if (Math.abs(scrollY - scrollTop) > 1) scrollTo({ top: scrollTop, behavior: 'instant' });
  // What is on screen now, read before anything changes.
  const style = (e: Element) => getComputedStyle(e);
  const app = Number(style(u.win).opacity), from = style(u.win).transform, dim = style(u.backdrop).opacity, pill = style(u.pill).opacity;
  const copy = u.press.hidden ? null : u.press.firstElementChild as HTMLElement | null;
  const press = copy ? { scale: style(copy).transform, dim: style(copy.lastElementChild!).opacity, opacity: style(u.press).opacity } : null;
  settle();
  const out: Animation[] = [];
  if (app > 0) {
    const fade = [{ opacity: app }, { opacity: 0, offset: 0.55 }, { opacity: 0 }];
    for (const e of [u.win, u.shade]) {
      if (still) out.push(animate(e, [{ opacity: app }, { opacity: 0 }], { duration: 160, easing: ease() }));
      else {
        e.style.transformOrigin = within(u.win, spot);
        out.push(animate(e, [{ transform: from }, { transform: 'scale(.95)' }], { duration: 200, easing: SHRINK }), animate(e, fade, { duration: 200 }));
      }
    }
  }
  // The window: unpressed where the launch had pressed it, or back at its place under the fading app.
  const frame = opts.direct ? null : frameOf();
  if (press && copy) {
    out.push(animate(copy.lastElementChild!, [{ opacity: press.dim }, { opacity: 0 }], { duration: 160, easing: ease() }));
    if (press.scale !== 'none') out.push(animate(copy, [{ transform: press.scale }, { transform: 'none' }], { duration: 160, easing: ease() }));
    if (Number(press.opacity) < 1) out.push(animate(u.press, [{ opacity: press.opacity }, { opacity: 1 }], { duration: 160, easing: ease() }));
  } else if (frame) {
    pressed(frame, frame.getBoundingClientRect()).dim.remove();
    out.push(animate(u.press, [{ opacity: 0 }, { opacity: 1 }], { duration: 200, delay: 40, easing: ease() }));
  }
  if (!u.pill.hidden) out.push(animate(u.pill, [{ opacity: pill }, { opacity: 0 }], { duration: 140, easing: ease() }));
  out.push(animate(u.backdrop, [{ opacity: dim }, { opacity: 0 }], { duration: 260, delay: app > 0 ? 100 : 0, easing: UNDIM }));
  await done(out);
  u.stage.hidden = true;
  settle();
  rest();
  u.stage.classList.remove('is-ready');
  const w = windowOf();
  if (w) w.style.visibility = '';
  delete html.dataset.demo;
  phase = 'closed';
  // Forward pressed during the close came back to the demo's entry while popstate could not act: follow the URL.
  if (!failed && !opts.direct && root && (history.state as { demo?: boolean } | null)?.demo) { void openDemo(root, { ...opts, direct: false }); return; }
  opts.trigger?.focus({ preventScroll: true });
  if (failed) { failed = false; showToast(); }
}

let toastTimer = 0;
function showToast() {
  const t = ui!.toast;
  t.innerHTML = `${SVG('<circle cx="10" cy="10" r="7.2"/><path d="M10 6.6v4.2M10 13.6h.01"/>', 20)}<p><strong>The live demo couldn't start.</strong> <a href="/download">Download Atelier</a> to try it for real.</p><button type="button" class="demo-toast-close" aria-label="Close">${SVG('<path d="M5.5 5.5l9 9M14.5 5.5l-9 9"/>', 14)}</button>`;
  t.querySelector('button')!.addEventListener('click', hideToast);
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(hideToast, 10000);
}
function hideToast() {
  clearTimeout(toastTimer);
  if (ui) { ui.toast.hidden = true; ui.toast.replaceChildren(); }
}
