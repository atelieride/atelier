// The film's controls. This is all the page loads for the film before any
// interaction, so it stays tiny: it arms a few listeners. The rest comes on demand:
// - on the desktop (the live demo's gate), "Watch the film" loads the sheet (film-sheet.ts) on intent and opens it on a
//   click; without the script, the link is the film itself;
// - below the gate, the hero's pill loads the inline player (film-inline.ts) and plays it with sound; and, unless the
//   visitor asked for less motion or data, the film starts muted by itself once they have interacted with the page and
//   the hero's frame is at least half on screen. Nothing of the film is fetched before one of those.
// Both are armed whatever the screen: CSS shows one or the other (the gate's media query), and a window narrowed or
// widened after the page loaded (or DevTools' device mode) must find the visible one working. The autoplay reads the
// gate when it would start; widening the window over a film playing in the hero pauses it (its frame hides).
import { DEMO_GATE } from '../lib/live-demo';
import { FILM_PHONE, autoplayAllowed } from '../lib/film';
import type { Film } from './film-sheet';
import { enterFullscreen, onLeaveFullscreen, standardFullscreen, type WebKitVideo } from './fullscreen';

type Sheet = typeof import('./film-sheet');
type Inline = typeof import('./film-inline');
let sheet: Promise<Sheet> | null = null;
let inline: Promise<Inline> | null = null;
const loadSheet = () => (sheet ??= import('./film-sheet').catch((e: unknown) => { sheet = null; throw e; }));
const loadInline = () => (inline ??= import('./film-inline').catch((e: unknown) => { inline = null; throw e; }));

let phoneFilm: WebKitVideo | null = null;
type Orientation = ScreenOrientation & { lock?: (o: string) => Promise<void>; unlock?: () => void };

/** A phone: the film full screen, with sound, the browser's controls and captions, asking for landscape (Android locks
 *  it; iOS's own player turns with the phone). Here, not in a lazy module: it must all happen inside the tap, which is
 *  the only place iOS allows full screen (and sound). Its own video, off screen until it is full screen: the hero keeps
 *  its screenshot. Leaving full screen pauses it; the next tap goes on. `fallback`: no full screen to be had. */
function playFullscreen(film: Film, fallback: () => void) {
  if (!phoneFilm) {
    const v: WebKitVideo = document.createElement('video');
    v.className = 'film-phone';
    v.controls = true;
    // An iPhone has no full screen API for a page: there a video without playsinline that plays in a tap opens iOS's
    // own full screen player (webkitEnterFullscreen would throw: no metadata yet). Elsewhere it plays inline, and the
    // standard API puts it full screen.
    v.playsInline = standardFullscreen(v);
    v.preload = 'auto';
    v.setAttribute('aria-label', 'Atelier, a 38-second film with narration');
    // Off screen, out of the flow; full screen overrides all of it.
    v.style.cssText = 'position:fixed;left:-4px;top:-4px;width:1px;height:1px';
    v.innerHTML = `<source src="${film.inline.webm}" type='video/webm; codecs="vp9, opus"'><source src="${film.inline.mp4}" type="video/mp4"><track kind="captions" src="${film.captions}" srclang="en" label="English" default>`;
    document.body.append(v);
    if (v.textTracks[0]) v.textTracks[0].mode = 'showing';
    onLeaveFullscreen(v, () => { v.pause(); (screen.orientation as Orientation | undefined)?.unlock?.(); });
    v.addEventListener('ended', () => { if (document.fullscreenElement === v) void document.exitFullscreen(); });
    phoneFilm = v;
  }
  const v = phoneFilm;
  v.muted = false;
  void v.play().catch(() => { /* the player's own play button is there */ });
  // iOS on an iPhone: the play above is the full screen.
  if (!standardFullscreen(v)) { if (!v.webkitEnterFullscreen) { v.pause(); fallback(); } return; }
  void enterFullscreen(v).then((ok) => {
    if (!ok) { v.pause(); fallback(); return; }
    (screen.orientation as Orientation | undefined)?.lock?.('landscape').catch(() => { /* not on this device: the visitor turns it */ });
  });
}

const hero = document.querySelector<HTMLElement>('[data-film]');
const film = hero ? (JSON.parse(hero.dataset.film!) as Film) : null;
const gate = matchMedia(DEMO_GATE);
/** A phone, upright or held sideways (the hero's phone crop is ≤ 480 px wide: Window.astro). */
const phone = matchMedia(FILM_PHONE);

if (hero && film) {
  for (const b of hero.querySelectorAll<HTMLAnchorElement>('[data-film-open]')) {
    // Intent, as the live demo's controls read it: 150 ms of hover, or focus.
    const intent = () => { loadSheet().catch(() => { /* the click tries again, or follows the link */ }); };
    let hover = 0;
    b.addEventListener('pointerenter', () => { hover = window.setTimeout(intent, 150); });
    b.addEventListener('pointerleave', () => clearTimeout(hover));
    b.addEventListener('focus', intent);
    b.addEventListener('click', (e) => {
      // A modified or middle click is the browser's (the film in a new tab).
      if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      e.preventDefault();
      loadSheet().then((s) => s.openSheet(film, b), () => { location.href = b.href; });
    });
  }

  const box = hero.querySelector<HTMLElement>('[data-film-inline]');
  const pill = hero.querySelector<HTMLButtonElement>('.film-pill');
  if (box && pill) {
    // The module once loaded, so a tap plays it in the tap itself: some browsers allow sound only then (older WebKit
    // drops the gesture across an import).
    let ready: Inline | null = null;
    const withPlayer = (go: (m: Inline) => void) => {
      if (ready) { go(ready); return; }
      void loadInline().then((m) => { ready = m; go(m); });
    };
    const play = (sound: boolean) => withPlayer((m) => m.playInline(film, box, pill, sound));
    // A finger on the pill is the intent: the player's module loads while the tap completes.
    pill.addEventListener('pointerdown', () => { void loadInline().then((m) => { ready = m; }, () => { /* the tap tries again */ }); });
    // A phone opens the film full screen (in landscape where the device allows it); a tablet plays it in the frame.
    pill.addEventListener('click', () => {
      if (phone.matches) playFullscreen(film, () => play(true));
      else play(true);
    });
    gate.addEventListener('change', () => { if (gate.matches) ready?.pauseInline(); });

    const media = (q: string) => matchMedia(q).matches;
    const saveData = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData === true;
    if (autoplayAllowed({ reducedMotion: media('(prefers-reduced-motion: reduce)'), saveData, reducedData: media('(prefers-reduced-data: reduce)') })) {
      const EVENTS = ['scroll', 'wheel', 'touchstart', 'pointerdown', 'keydown'] as const;
      const first = () => {
        for (const ev of EVENTS) removeEventListener(ev, first, true);
        const seen = new IntersectionObserver((entries) => {
          // Above the gate the hero shows the live demo, never the film; a phone plays it only when asked (full screen).
          // Keep waiting: the window may change.
          if (gate.matches || phone.matches || !entries.some((e) => e.isIntersecting)) return;
          seen.disconnect();
          play(false);
        }, { threshold: 0.5 });
        // The frame, not the player's box: that one has no size until the film is in it.
        seen.observe(box.closest('.window') ?? box);
      };
      for (const ev of EVENTS) addEventListener(ev, first, { capture: true, passive: true });
    }

    // A link to the film (the releases README, a shared URL: /#film) asks for it: on the desktop the sheet opens (with
    // sound if the browser lets a page start it; else its play button is there); below the gate the hero's frame comes
    // into view; on a tablet the film starts there, muted, unless motion or data should be spared; a phone waits for the
    // tap on its pill (full screen needs one).
    if (location.hash === '#film') {
      const open = hero.querySelector<HTMLAnchorElement>('[data-film-open]');
      if (gate.matches && open) {
        void loadSheet().then((s) => s.openSheet(film, open), () => { /* the bar's button is there */ });
      } else {
        (box.closest('.window') ?? box).scrollIntoView({ block: 'center' });
        if (!phone.matches && autoplayAllowed({ reducedMotion: media('(prefers-reduced-motion: reduce)'), saveData, reducedData: media('(prefers-reduced-data: reduce)') })) play(false);
      }
    }
  }
}
