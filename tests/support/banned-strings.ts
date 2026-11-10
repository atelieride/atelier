import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
// @ts-expect-error: .mjs script without types
import { localWords } from '../../scripts/local-words.mjs';

/**
 * The repository: the nearest folder up from the working directory whose package.json is Atelier's. Three loaders read
 * this file: Vitest, Playwright (as CommonJS, where import.meta is a syntax error) and plain Node
 * (scripts/changelog-leaks.mjs, run by the release, as an ES module, where __dirname doesn't exist).
 */
function repoRoot(): string {
  for (let dir = process.cwd(); ; dir = dirname(dir)) {
    try {
      if ((JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { name?: string }).name === 'atelier') return dir;
    } catch { /* no package.json here */ }
    if (dirname(dir) === dir) throw new Error(`Not inside the Atelier repository: ${process.cwd()}`);
  }
}
const ROOT = repoRoot();

/**
 * Strings that must never appear on the website or in its screenshots: real paths, the company, personal email, the
 * test runs' temp folders, and the words of the developer's own copy (scripts/local-words.mjs: their user name…).
 */
const LOCAL: RegExp[] = (localWords(ROOT) as string[]).map((w) => new RegExp(w, 'i'));

export const SENSITIVE: readonly RegExp[] = [...LOCAL, /docsy/i, /\/Users\//, /\/private\/(?:var|tmp)\//, /\/var\/folders/, /gmail/i, /atl-(?:run|e2e|prj|tour|shots-home)-/];
// The temp prefixes are listed one by one: a generic atl-<word>- would also match the app's animation names
// (atl-pulse-dot, atl-fade-target) that ship in the site's CSS.

/** Screenshots must not show the author either (the site's footer names the author on purpose): package.json's. */
const AUTHOR = (JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { author: string }).author;
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
