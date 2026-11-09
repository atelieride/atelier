// The film in a sheet over the page, on the desktop. Loaded on intent by
// film.ts, never with the page. One sheet per page, built on first use and kept: closing pauses the film, opening
// again resumes it. A native modal dialog: it traps the focus, Esc closes it, the page behind is inert.
// Its styles travel with it as a string (Astro's script bundling drops a stylesheet imported by a lazy chunk).
import css from '../styles/film-sheet.css?inline';
import { CHAPTERS, chapterAt, clock } from '../lib/film';

/** The film's files, as Hero.astro writes them in the hero's data-film. */
export interface Film {
  sheet: { webm: string; mp4: string; poster: string };
  inline: { webm: string; mp4: string };
  captions: string;
  download: string;
}

const PLAY = '<svg width="9" height="9" viewBox="0 0 10 10" aria-hidden="true"><path fill="currentColor" d="M2.5 1.3v7.4a.5.5 0 0 0 .76.43l6-3.7a.5.5 0 0 0 0-.86l-6-3.7a.5.5 0 0 0-.76.43z"/></svg>';
const CLOSE = '<svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M5 5l10 10M15 5L5 15"/></svg>';

let dialog: HTMLDialogElement | null = null;
let video: HTMLVideoElement | null = null;
let trigger: HTMLElement | null = null;

function build(film: Film): HTMLDialogElement {
  const style = document.createElement('style');
  style.textContent = css;
  document.head.append(style);

  const d = document.createElement('dialog');
  d.className = 'film-sheet';
  d.setAttribute('aria-labelledby', 'film-sheet-title');
  d.innerHTML = `
    <div class="fs-body">
      <header class="fs-head">
        <div class="fs-titles"><p class="fs-eyebrow">The film</p><h2 id="film-sheet-title">Atelier in 38 seconds</h2></div>
        <span class="fs-esc" aria-hidden="true">esc</span>
        <button class="fs-close" type="button" aria-label="Close" autofocus>${CLOSE}</button>
      </header>
      <div class="fs-player">
        <video controls playsinline preload="metadata" poster="${film.sheet.poster}" aria-label="Atelier, a 38-second film with narration">
          <source src="${film.sheet.webm}" type='video/webm; codecs="vp9, opus"'>
          <source src="${film.sheet.mp4}" type="video/mp4">
          <track kind="captions" src="${film.captions}" srclang="en" label="English" default>
        </video>
      </div>
      <nav class="fs-chapters" aria-label="Chapters">
        ${CHAPTERS.map((c, i) => `<button type="button" data-chapter="${i}"><span class="fs-at">${clock(c.at)}</span>${c.title}</button>`).join('')}
      </nav>
      <footer class="fs-foot">
        <span class="fs-ask">Seen enough?</span>
        <a class="fs-try" href="/demo"><span class="fs-play">${PLAY}</span>Try it live<span class="fs-sep" aria-hidden="true">·</span><span class="fs-soft">in your browser</span></a>
        <a class="fs-get" href="${film.download}">Download for macOS</a>
        <p class="fs-credit">Music by Sascha Ende (ende.app, CC BY 4.0) · Voice: Kokoro</p>
      </footer>
    </div>`;
  document.body.append(d);

  const v = d.querySelector('video')!;
  const chapters = [...d.querySelectorAll<HTMLButtonElement>('[data-chapter]')];
  const mark = () => {
    const now = chapterAt(v.currentTime);
    chapters.forEach((b, i) => b.setAttribute('aria-current', String(i === now)));
  };
  v.addEventListener('timeupdate', mark);
  v.addEventListener('seeked', mark);
  mark();
  for (const b of chapters) {
    b.addEventListener('click', () => {
      v.currentTime = CHAPTERS[Number(b.dataset.chapter)]!.at;
      void v.play().catch(() => { /* the controls are there */ });
      mark();
    });
  }
  d.querySelector('.fs-close')!.addEventListener('click', () => d.close());
  // A click on the dimmed page (the dialog's own box, outside the sheet) closes it too; only when it also started there:
  // a press on the player let go over the page is a click on their common ancestor, the dialog (as the search sheet,
  // scripts/nav.ts).
  let downOnBackdrop = false;
  d.addEventListener('pointerdown', (e) => { downOnBackdrop = e.target === d; });
  d.addEventListener('click', (e) => { if (e.target === d && downOnBackdrop) d.close(); downOnBackdrop = false; });
  d.addEventListener('close', () => {
    v.pause();
    trigger?.focus();
  });
  // Try it live: the sheet gives way to the live demo, opened as the hero's own link opens it (scripts/live-demo.ts);
  // before the demo's script has armed it, that link goes to /demo, which works on its own.
  d.querySelector<HTMLAnchorElement>('.fs-try')!.addEventListener('click', (e) => {
    const demo = document.querySelector<HTMLElement>('[data-live-demo-for="hero"]');
    if (!demo || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    trigger = null;
    d.close();
    demo.click();
  });
  video = v;
  return d;
}

/** Opens the sheet and plays the film with sound (the click that opened it is the gesture), from where it was. */
export function openSheet(film: Film, from: HTMLElement): void {
  dialog ??= build(film);
  trigger = from;
  if (!dialog.open) dialog.showModal();
  void video!.play().catch(() => { /* blocked or no codec: the controls and the poster are there */ });
}
