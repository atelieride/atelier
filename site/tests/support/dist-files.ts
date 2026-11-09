/**
 * How the build guard (tests/build/guard.test.ts) treats a built file, by its path relative to dist/.
 * - `text`: scanned for anything sensitive (SENSITIVE, the private repo's URL) and for loads from other origins.
 * - `page`: an HTML page of the site: title, description, canonical, noindex before launch, the analytics beacon.
 * - `demoPage`: the demo build's HTML: not a page of the site, but always noindex.
 * - `notices`: the demo build's third-party license notices: their authors' own e-mail addresses (gmail…) are theirs
 *   to publish, so that one SENSITIVE pattern is lifted there; every other one still applies.
 * - `anonymous`: the demo build, notices aside, never names the author either (SHOTS_ONLY, as the screenshots): the
 *   site's footer names the author on purpose, the app's world never does. The notices carry the app's own copyright
 *   line.
 */
export interface DistRole { text: boolean; page: boolean; demoPage: boolean; notices: boolean; anonymous: boolean }

export function distRole(rel: string): DistRole {
  // _headers: Cloudflare Pages' headers file, text with no extension.
  const text = /\.(html|css|js|mjs|xml|txt|svg|json|webmanifest)$/.test(rel) || rel === '_headers';
  const demo = rel.startsWith('demo-app/');
  const html = rel.endsWith('.html');
  const notices = rel === 'demo-app/licenses.txt';
  return { text, page: html && !demo, demoPage: html && demo, notices, anonymous: text && demo && !notices };
}
