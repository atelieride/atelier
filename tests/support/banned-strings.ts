import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
// @ts-expect-error: .mjs script without types
import { localWords } from '../../scripts/local-words.mjs';

/**
 * Strings that must never appear on the website or in its screenshots: real paths, the company, personal email, the
 * test runs' temp folders, and the words of the developer's own copy (scripts/local-words.mjs: their user name…).
 */
const LOCAL: RegExp[] = (localWords(resolve(__dirname, '../..')) as string[]).map((w) => new RegExp(w, 'i'));

export const SENSITIVE: readonly RegExp[] = [...LOCAL, /docsy/i, /\/Users\//, /\/private\/(?:var|tmp)\//, /\/var\/folders/, /gmail/i, /atl-(?:run|e2e|prj|tour|shots-home)-/];
// The temp prefixes are listed one by one: a generic atl-<word>- would also match the app's animation names
// (atl-pulse-dot, atl-fade-target) that ship in the site's CSS.

/** Screenshots must not show the author either (the site's footer names the author on purpose): package.json's. */
const AUTHOR = (JSON.parse(readFileSync(resolve(__dirname, '../../package.json'), 'utf8')) as { author: string }).author;
export const SHOTS_ONLY: readonly RegExp[] = AUTHOR.split(/\s+/).filter(Boolean).map((w) => new RegExp(w, 'i'));

/** The matched text of every pattern found in `text`, in pattern order (empty: clean). */
export function findBanned(text: string, patterns: readonly RegExp[]): string[] {
  const hits: string[] = [];
  for (const p of patterns) {
    const m = new RegExp(p.source, p.flags.replace('g', '')).exec(text);
    if (m) hits.push(m[0]);
  }
  return hits;
}
