// The live demo's controls (plan "Performance and SEO contract"). This is
// all the page loads for the demo before any interaction, so it stays tiny and idle:
// - outside the gate (phones, tablets, narrow windows) it does nothing at all, past one matchMedia check;
// - inside, it arms the controls once the page has loaded and gone idle (a click before that follows the link to
//   /demo, which works on its own);
// - intent (150 ms of hover, or focus) loads the stage (live-demo-stage.ts, its styles) and prefetches the demo's first
//   paint, so a click usually finds both in the cache; a click opens the demo in place.
import { DEMO_GATE } from '../lib/live-demo';
import type { PrefetchLink } from '../lib/demo-prefetch';

/** The demo's entry and first-paint files, from its manifest, inlined at build time (astro.config.mjs). */
declare const __DEMO_PREFETCH__: PrefetchLink[];

type Stage = typeof import('./live-demo-stage');
let stage: Promise<Stage> | null = null;
const loadStage = () => (stage ??= import('./live-demo-stage').catch((e: unknown) => { stage = null; throw e; }));

let prefetched = false;
function intent() {
  loadStage().catch(() => { /* the click will try again, or follow the link */ });
  if (prefetched) return;
  prefetched = true;
  // prefetch, not modulepreload: the demo runs in its own document (the iframe), which never sees this page's module
  // map; the HTTP cache is what they share, and prefetch fills it without parsing anything on this page's thread.
  for (const p of __DEMO_PREFETCH__) {
    const link = document.createElement('link');
    link.rel = 'prefetch';
    link.href = p.href;
    if (p.as) link.as = p.as;
    if (p.crossorigin) link.crossOrigin = 'anonymous';
    document.head.append(link);
  }
}

/** Makes a [data-live-demo] window (LiveDemo.astro) open the demo: its own control, plus any element naming it in
 *  data-live-demo-for. `view`: the demo starts there (feature rows). Exported for pages that build their own. */
export function initLiveDemo(root: HTMLElement, view = root.dataset.demoView) {
  const id = root.dataset.liveDemo;
  const controls = [...root.querySelectorAll<HTMLElement>(':scope > .demo-hit'), ...(id ? document.querySelectorAll<HTMLElement>(`[data-live-demo-for="${CSS.escape(id)}"]`) : [])];
  const open = (trigger: HTMLElement | null) => loadStage().then(
    (s) => s.openDemo(root, { trigger, view, direct: trigger === null }),
    () => { location.href = '/demo'; });
  let hover = 0;
  // The pointer on the window lights its other controls (a feature row's "Try it": the row's window has no pill).
  const own = controls.filter((c) => c.classList.contains('demo-hit'));
  const others = controls.filter((c) => !own.includes(c));
  const hot = (on: boolean) => { for (const o of others) o.toggleAttribute('data-hot', on); };
  for (const c of own) {
    c.addEventListener('pointerenter', () => hot(true));
    c.addEventListener('pointerleave', () => hot(false));
  }
  for (const c of controls) {
    c.addEventListener('pointerenter', () => { hover = window.setTimeout(intent, 150); });
    c.addEventListener('pointerleave', () => clearTimeout(hover));
    c.addEventListener('focus', intent);
    c.addEventListener('click', (e) => {
      // A modified or middle click is the browser's (a new tab on /demo).
      if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      e.preventDefault();
      void open(c);
    });
    // The window acts as a button: Space opens it as well (Enter already clicks a link).
    c.addEventListener('keydown', (e) => { if (e.key === ' ' && !e.repeat) { e.preventDefault(); void open(c); } });
  }
  root.dataset.armed = '';
  if ('demoAuto' in root.dataset) void open(null);
}

if (matchMedia(DEMO_GATE).matches) {
  const arm = () => {
    const go = () => document.querySelectorAll<HTMLElement>('[data-live-demo]').forEach((el) => initLiveDemo(el));
    if ('requestIdleCallback' in window) requestIdleCallback(go, { timeout: 2000 }); else setTimeout(go, 200);
  };
  if (document.readyState === 'complete') arm(); else addEventListener('load', arm, { once: true });
}
