// The film below the live demo's gate. Loaded by film.ts on the pill's tap, or
// for a tablet's muted autoplay once the visitor has interacted and the frame is in view; never with the page.
// - A tablet: the player fills the hero's frame over the screenshot, which stays the page's image (no layout shift):
//   the film, 16:9, with the captions the page draws over its bottom and three controls, sound, pause and full screen.
//   Off screen it pauses; back on screen it goes on, unless the visitor paused it.
// A phone never plays it here: film.ts opens the film full screen there, inside the tap (iOS allows it nowhere else).
// Its styles travel with it as a string, like the sheet's.
import css from '../styles/film-inline.css?inline';
import type { Film } from './film-sheet';
import { enterFullscreen, onLeaveFullscreen } from './fullscreen';

const SOUND_OFF = '<svg width="15" height="15" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 8v4h3l4 3V5L6 8z"/><path d="M13 8l4 4M17 8l-4 4"/></svg>';
const SOUND_ON = '<svg width="15" height="15" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 8v4h3l4 3V5L6 8z"/><path d="M13.5 7.5a4 4 0 0 1 0 5M15.5 5.5a7 7 0 0 1 0 9"/></svg>';
const PAUSE = '<svg width="14" height="14" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true"><rect x="5" y="4" width="3.4" height="12" rx="1"/><rect x="11.6" y="4" width="3.4" height="12" rx="1"/></svg>';
const PLAY = '<svg width="14" height="14" viewBox="0 0 10 10" aria-hidden="true"><path fill="currentColor" d="M2.5 1.3v7.4a.5.5 0 0 0 .76.43l6-3.7a.5.5 0 0 0 0-.86l-6-3.7a.5.5 0 0 0-.76.43z"/></svg>';
const FULL = '<svg width="15" height="15" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3.5 7.5v-4h4M16.5 7.5v-4h-4M3.5 12.5v4h4M16.5 12.5v4h-4"/></svg>';

interface Player { video: HTMLVideoElement; setSound(on: boolean, restart: boolean, start?: boolean): void; suspend(): void }
let player: Player | null = null;

let styled = false;
const style = () => {
  if (styled) return;
  styled = true;
  const el = document.createElement('style');
  el.textContent = css;
  document.head.append(el);
};

function build(film: Film, box: HTMLElement, pill: HTMLButtonElement): Player {
  style();
  box.innerHTML = `
    <div class="fi-stage">
      <video muted loop playsinline preload="auto" aria-label="Atelier, a 38-second film; its captions follow it">
        <source src="${film.inline.webm}" type='video/webm; codecs="vp9, opus"'>
        <source src="${film.inline.mp4}" type="video/mp4">
        <track kind="metadata" src="${film.captions}" srclang="en" label="English" default>
        <track kind="captions" src="${film.captions}" srclang="en" label="English">
      </video>
      <p class="film-caption"></p>
    </div>
    <div class="fi-ctrls">
      <button class="film-sound" type="button" aria-pressed="false"></button>
      <button class="film-pause" type="button"></button>
      <button class="film-full" type="button" aria-label="Full screen">${FULL}</button>
    </div>`;
  const video = box.querySelector('video')!;
  const caption = box.querySelector<HTMLElement>('.film-caption')!;
  const soundBtn = box.querySelector<HTMLButtonElement>('.film-sound')!;
  const pauseBtn = box.querySelector<HTMLButtonElement>('.film-pause')!;
  const fullBtn = box.querySelector<HTMLButtonElement>('.film-full')!;
  video.muted = true;
  /** The visitor paused it: coming back on screen does not resume it. */
  let userPaused = false;

  // The captions: the browser parses the file, the page draws the cue (a hidden track raises cuechange all the same).
  // A metadata track: no browser ever shows it itself (a captions track may be, with the system's captions preference).
  const track = video.textTracks[0];
  // The captions track is the browser's own drawing, for full screen only (the page's caption is not there).
  const native = video.textTracks[1];
  if (native) native.mode = 'disabled';
  if (track) {
    track.mode = 'hidden';
    track.addEventListener('cuechange', () => {
      const cue = track.activeCues?.[0] as VTTCue | undefined;
      caption.textContent = cue?.text ?? '';
    });
  }

  const showSound = () => {
    const on = !video.muted;
    soundBtn.setAttribute('aria-pressed', String(on));
    soundBtn.innerHTML = `${on ? SOUND_ON : SOUND_OFF}<span>${on ? 'Sound on' : 'Tap for sound'}</span>`;
  };
  const showPause = () => {
    pauseBtn.innerHTML = video.paused ? PLAY : PAUSE;
    pauseBtn.setAttribute('aria-label', video.paused ? 'Play the film' : 'Pause the film');
  };
  const go = () => video.play().catch(() => {
    // Sound refused without a gesture: go on muted, the sound button is there.
    if (!video.muted) { video.muted = true; showSound(); return video.play().catch(() => { /* the poster stays */ }); }
  });
  /** `start`: the autoplay's first play, muted. Otherwise asking for sound plays it, muting leaves a paused film paused. */
  const setSound = (on: boolean, restart: boolean, start = false) => {
    video.muted = !on;
    // With sound it plays once, from the top; at the end it goes back to looping in silence.
    video.loop = !on;
    if (restart) video.currentTime = 0;
    if (on || start || !video.paused) { userPaused = false; void go(); }
    showSound();
  };
  video.addEventListener('playing', () => {
    box.classList.add('is-on');
    // The pill gives way to the player's controls; a keyboard on it lands on the sound button.
    const focused = document.activeElement === pill;
    pill.hidden = true;
    if (focused) soundBtn.focus();
  });
  video.addEventListener('play', showPause);
  video.addEventListener('pause', showPause);
  // At the end with sound it starts over in silence, looping.
  video.addEventListener('ended', () => { video.muted = true; video.loop = true; video.currentTime = 0; void go(); showSound(); });
  soundBtn.addEventListener('click', () => setSound(video.muted, video.muted));
  video.addEventListener('click', () => { if (video.muted) setSound(true, true); });
  pauseBtn.addEventListener('click', () => {
    if (video.paused) { userPaused = false; void go(); } else { userPaused = true; video.pause(); }
  });
  // Full screen: with sound (from the top if it was silent), the browser's controls and captions; back in the frame
  // as it was, playing on.
  fullBtn.addEventListener('click', () => {
    if (video.muted) setSound(true, true);
    else { userPaused = false; void go(); }
    video.controls = true;
    if (native) native.mode = 'showing';
    void enterFullscreen(video).then((ok) => { if (!ok) leave(); });
  });
  const leave = () => { video.controls = false; if (native) native.mode = 'disabled'; };
  onLeaveFullscreen(video, leave);
  // Off screen it rests; back in view it goes on (unless the visitor paused it).
  new IntersectionObserver((entries) => {
    const visible = entries.some((e) => e.isIntersecting);
    if (!visible && !video.paused) video.pause();
    else if (visible && video.paused && !userPaused && box.classList.contains('is-on')) void go();
  }, { threshold: 0.25 }).observe(box.closest('.window') ?? box);
  showSound();
  showPause();
  // Paused as if by the visitor: coming back into view does not resume it, a tap on the pill or Play does.
  const suspend = () => { userPaused = true; video.pause(); };
  return { video, setSound, suspend };
}

/** Plays the film in the hero: with sound (the pill's tap, from the top) or muted (the autoplay, which never
 *  interrupts a film already playing with sound). */
export function playInline(film: Film, box: HTMLElement, pill: HTMLButtonElement, sound: boolean): void {
  const first = !player;
  player ??= build(film, box, pill);
  if (sound) player.setSound(true, true);
  else if (first) player.setSound(false, false, true);
}

/** Pauses the film in the hero (the window widened past the gate: its frame now shows the live demo). */
export function pauseInline(): void {
  player?.suspend();
}
