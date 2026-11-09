import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { CHAPTERS, FILM_PHONE, FILM_SECONDS, autoplayAllowed, chapterAt, clock } from '../../src/lib/film';

// The film on the site: its pure parts and its captions file.

test('the chapters follow the film, in order, the first at 0 and every one inside it', () => {
  expect(CHAPTERS.map((c) => c.title)).toEqual(['Sessions', 'Shortcuts', 'Terminals', 'Files', 'Automations', 'Git · Docker · Redis', 'Always alive']);
  expect(CHAPTERS[0]!.at).toBe(0);
  for (let i = 1; i < CHAPTERS.length; i++) expect(CHAPTERS[i]!.at).toBeGreaterThan(CHAPTERS[i - 1]!.at);
  expect(CHAPTERS.at(-1)!.at).toBeLessThan(FILM_SECONDS);
});

test('the chapter at a time: the last one started, the first before any', () => {
  expect(chapterAt(0)).toBe(0);
  expect(chapterAt(8.39)).toBe(0);
  expect(chapterAt(8.4)).toBe(1);
  expect(chapterAt(27)).toBe(5);
  expect(chapterAt(38)).toBe(6);
  expect(chapterAt(-1)).toBe(0);
  expect(chapterAt(Number.NaN)).toBe(0);
});

test('the clock reads m:ss', () => {
  expect(clock(0)).toBe('0:00');
  expect(clock(8.4)).toBe('0:08');
  expect(clock(FILM_SECONDS)).toBe('0:38');
  expect(clock(71)).toBe('1:11');
});

test('muted autoplay only without reduced motion, Save-Data or reduced data', () => {
  const all = { reducedMotion: false, saveData: false, reducedData: false };
  expect(autoplayAllowed(all)).toBe(true);
  expect(autoplayAllowed({ ...all, reducedMotion: true })).toBe(false);
  expect(autoplayAllowed({ ...all, saveData: true })).toBe(false);
  expect(autoplayAllowed({ ...all, reducedData: true })).toBe(false);
});

// The captions are the narration: every cue well formed, in order, none overlapping, all inside the film.
const toSeconds = (t: string) => { const [h, m, s] = t.split(':'); return Number(h) * 3600 + Number(m) * 60 + Number(s); };
const vtt = readFileSync(new URL('../../src/assets/film/film.vtt', import.meta.url), 'utf8');
const cues = vtt.trim().split(/\n\n+/).slice(1).map((block) => {
  const [timing, ...text] = block.split('\n');
  const m = /^(\d\d:\d\d:\d\d\.\d{3}) --> (\d\d:\d\d:\d\d\.\d{3})$/.exec(timing!);
  return { ok: !!m, start: m ? toSeconds(m[1]!) : NaN, end: m ? toSeconds(m[2]!) : NaN, text: text.join(' ') };
});

test('the captions file is WebVTT, every cue timed, in order, inside the film', () => {
  expect(vtt.startsWith('WEBVTT\n')).toBe(true);
  expect(cues.every((c) => c.ok && c.text.length > 0)).toBe(true);
  for (let i = 0; i < cues.length; i++) {
    expect(cues[i]!.end).toBeGreaterThan(cues[i]!.start);
    if (i > 0) expect(cues[i]!.start).toBeGreaterThanOrEqual(cues[i - 1]!.end);
  }
  expect(cues.at(-1)!.end).toBeLessThanOrEqual(FILM_SECONDS);
});

test('the captions say the narration, product names spelled as written (the voice was given "Reddiss")', () => {
  const said = cues.map((c) => c.text).join(' ');
  expect(said).toContain('Five Claude Code sessions.');
  expect(said).toContain('Jira, ClickUp or Notion');
  expect(said).toContain('And Redis, one click away.');
  expect(said).not.toMatch(/Reddiss/);
  expect(said.endsWith('Atelier. Never lose track.')).toBe(true);
});

test('a phone, for the film: ≤ 480 px wide (the hero\'s phone crop) or ≤ 480 px tall (one held sideways)', () => {
  expect(FILM_PHONE).toBe('(max-width: 480px), (max-height: 480px)');
});
