// The film's pure parts, unit-tested; scripts/film*.ts do the DOM. Imported by
// the page's first script, so it stays tiny and imports nothing.

/** The film's length, in seconds. */
export const FILM_SECONDS = 38.8;

export interface Chapter { at: number; title: string }

/** Where each part of the film starts (its scenes' cuts). */
export const CHAPTERS: readonly Chapter[] = [
  { at: 0, title: 'Sessions' },
  { at: 8.4, title: 'Shortcuts' },
  { at: 13, title: 'Terminals' },
  { at: 16.6, title: 'Files' },
  { at: 20.15, title: 'Automations' },
  { at: 26.74, title: 'Git · Docker · Redis' },
  { at: 31.03, title: 'Always alive' }
];

/** The chapter playing at `t`: the last one started (the first before any, or for a time that is not one). */
export function chapterAt(t: number): number {
  let i = 0;
  CHAPTERS.forEach((c, k) => { if (t >= c.at) i = k; });
  return i;
}

/** m:ss, as the button and the chapters show it. */
export const clock = (s: number): string => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

/** A phone, for the film (it opens full screen there, never in the hero): as narrow as the hero's phone crop
 *  (Window.astro), or as short as a phone held sideways. */
export const FILM_PHONE = '(max-width: 480px), (max-height: 480px)';

export interface AutoplayEnv { reducedMotion: boolean; saveData: boolean; reducedData: boolean }

/** Whether the film may start on its own, muted (phones and tablets): never for a visitor who asked for less motion
 *  or less data; the pill still plays it on a tap. */
export const autoplayAllowed = (e: AutoplayEnv): boolean => !e.reducedMotion && !e.saveData && !e.reducedData;
