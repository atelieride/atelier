import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { brotliCompressSync, constants } from 'node:zlib';
import { expect, test } from 'vitest';
import { SENSITIVE, SHOTS_ONLY, findBanned } from '../../../tests/support/banned-strings';
import { config } from '../../src/config';
import { BEACON_SRC, beaconTag } from '../../src/lib/analytics';
import { distRole } from '../support/dist-files';
import { disallowedLoads } from '../support/external-loads';

// Runs on the built site (npm --prefix site test builds it first). The folder is tests/build, not
// tests/dist: the repo's .gitignore ignores every dist/ folder, which once kept this guard out of git.
const dist = new URL('../../dist/', import.meta.url).pathname;
const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
  e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]);
// Which rules a file gets (support/dist-files.ts): the demo build under demo-app/ is not a page of the site.
const files = (role: 'text' | 'page' | 'demoPage') => walk(dist).filter((f) => distRole(f.slice(dist.length))[role]);
const textFiles = () => files('text');
const htmlFiles = () => files('page');

test('dist exists (npm --prefix site test builds it first)', () => {
  expect(existsSync(join(dist, 'index.html'))).toBe(true);
});

test('nothing sensitive in the built site', () => {
  const problems = textFiles().flatMap((f) => {
    const text = readFileSync(f, 'utf8');
    const role = distRole(f.slice(dist.length));
    const secret = role.notices ? SENSITIVE.filter((p) => !/gmail/.test(p.source)) : SENSITIVE;
    // The demo build never names the author (the site's footer does, on purpose).
    const author = role.anonymous ? SHOTS_ONLY : [];
    const hits = findBanned(text, [...secret, ...author]);
    return hits.map((h) => `${f.slice(dist.length)}: ${h}`);
  });
  expect(problems).toEqual([]);
});

// The demo build is never indexed, launched or not; robots.txt keeps crawlers out of it as well.
test('the demo build\'s HTML is noindex', () => {
  const missing = files('demoPage').filter((f) => !/<meta name="robots" content="noindex/.test(readFileSync(f, 'utf8')));
  expect(missing.map((f) => f.slice(dist.length))).toEqual([]);
});

test('before launch every page is noindex', () => {
  if (config.launched) return;
  const missing = htmlFiles().filter((f) => !readFileSync(f, 'utf8').includes('<meta name="robots" content="noindex">'));
  expect(missing.map((f) => f.slice(dist.length))).toEqual([]);
});

// Cloudflare Pages serves dist/x.html at /x and dist/x/index.html at /x/ (redirecting /x there): the canonical URL
// must be the address the page is actually served at, or search engines see a redirect.
test('every canonical URL is the address its page is served at', () => {
  const wrong = htmlFiles().filter((f) => !f.endsWith('404.html')).flatMap((f) => {
    const rel = f.slice(dist.length);
    const served = rel === 'index.html' ? '/' : rel.endsWith('/index.html') ? `/${rel.slice(0, -'index.html'.length)}` : `/${rel.slice(0, -'.html'.length)}`;
    const canonical = readFileSync(f, 'utf8').match(/<link rel="canonical" href="([^"]+)"/)?.[1];
    return canonical === new URL(served, config.siteUrl).href ? [] : [`${rel}: canonical ${canonical}, served at ${served}`];
  });
  expect(wrong).toEqual([]);
});

test('pages and stylesheets load nothing from other origins (fonts and images are self-hosted; the analytics beacon tag is the one exception)', () => {
  const beacon = beaconTag(config.webAnalyticsToken, process.env.SITE_NO_BEACON !== '1');
  const external = textFiles().filter((f) => /\.(html|css)$/.test(f)).flatMap((f) =>
    disallowedLoads(readFileSync(f, 'utf8'), config.siteUrl, beacon).map((u) => `${f.slice(dist.length)}: ${u}`));
  expect(external).toEqual([]);
});

test('with a Web Analytics token every page carries the beacon exactly once; without one, none does', () => {
  const counts = htmlFiles().map((f) => readFileSync(f, 'utf8').split(BEACON_SRC).length - 1);
  expect(new Set(counts)).toEqual(new Set([config.webAnalyticsToken && process.env.SITE_NO_BEACON !== '1' ? 1 : 0]));
});

test('home and download describe the app as structured data (SoftwareApplication)', () => {
  for (const page of ['index.html', 'download.html']) {
    const html = readFileSync(join(dist, page), 'utf8');
    const blocks = [...html.matchAll(/<script type="application\/ld\+json">([^<]*)<\/script>/g)].map((m) => JSON.parse(m[1]!) as Record<string, unknown>);
    expect(blocks.map((b) => b['@type']), page).toEqual(['SoftwareApplication']);
    expect(blocks[0]!.softwareVersion, page).toBe(config.version);
  }
});

test('every page: a unique title of at most 60 characters and a description of at most 160', () => {
  const decode = (s: string) => s.replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&');
  const pages = htmlFiles().filter((f) => !f.endsWith('404.html')).map((f) => {
    const html = readFileSync(f, 'utf8');
    return {
      page: f.slice(dist.length),
      title: decode(html.match(/<title>([^<]*)<\/title>/)?.[1] ?? ''),
      description: decode(html.match(/<meta name="description" content="([^"]*)"/)?.[1] ?? '')
    };
  });
  const problems = pages.flatMap((p) => [
    ...(!p.title || p.title.length > 60 ? [`${p.page}: title "${p.title}"`] : []),
    ...(!p.description || p.description.length > 160 ? [`${p.page}: description is ${p.description.length} characters`] : [])
  ]);
  expect(problems).toEqual([]);
  expect(new Set(pages.map((p) => p.title)).size).toBe(pages.length);
});

// The performance contract: before any interaction the home page carries one more
// small deferred script for the live demo, and nothing of the stage it opens (that loads on intent).
test('the home page\'s live-demo script is at most 4 KB brotli, a deferred module; the stage is not part of the load', () => {
  const html = readFileSync(join(dist, 'index.html'), 'utf8');
  const tags = [...html.matchAll(/<script type="module" src="(\/_astro\/LiveDemo[^"]+\.js)"><\/script>/g)].map((m) => m[1]!);
  expect(tags).toHaveLength(1);
  const size = brotliCompressSync(readFileSync(join(dist, tags[0]!)), { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }).length;
  expect(size).toBeLessThanOrEqual(4096);
  // Nothing static pulls the stage in: it is only ever imported dynamically, and the page never links it.
  expect(html).not.toMatch(/live-demo-stage/);
  const entry = readFileSync(join(dist, tags[0]!), 'utf8');
  expect(entry).not.toMatch(/^import[^;]*live-demo-stage/m);
  // Nor merged into it (a static import anywhere would make the bundler do that): none of the stage's code is there.
  expect(entry).not.toMatch(/demo-backdrop|atelier-demo/);
});

test('llms.txt is built', () => {
  expect(readFileSync(join(dist, 'llms.txt'), 'utf8')).toMatch(/^# Atelier\n/);
});

/** Cloudflare Pages' _headers: each unindented line a path pattern, the indented lines under it its headers. */
function headersFile(text: string): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {};
  let path = '';
  for (const line of text.split('\n')) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    if (!/^\s/.test(line)) { path = line.trim(); out[path] = {}; continue; }
    const at = line.indexOf(':');
    out[path]![line.slice(0, at).trim()] = line.slice(at + 1).trim();
  }
  return out;
}

// The demo build may be framed by the site only: frame-ancestors works as a header, never in the
// page's meta CSP. Its hashed assets never change under a name, so browsers keep them a year.
test('_headers: the demo build is framed by the site only, its hashed assets are cached for good; the film\'s captions are text/vtt', () => {
  const p = join(dist, '_headers');
  expect(existsSync(p)).toBe(true);
  const rules = headersFile(readFileSync(p, 'utf8'));
  expect(rules['/demo-app/*']).toEqual({ 'Content-Security-Policy': "frame-ancestors 'self'", 'X-Frame-Options': 'SAMEORIGIN' });
  expect(rules['/demo-app/assets/*']).toEqual({ 'Cache-Control': 'public, max-age=31536000, immutable' });
  // The film's captions: a <track> is read only as text/vtt.
  expect(rules['/_astro/*.vtt']).toEqual({ 'Content-Type': 'text/vtt; charset=utf-8' });
  // Only those: anything else the site serves keeps Cloudflare's defaults.
  expect(Object.keys(rules).sort()).toEqual(['/_astro/*.vtt', '/demo-app/*', '/demo-app/assets/*']);
  // Every file the demo build writes there is hashed (the immutable rule would otherwise pin a stale file).
  const assets = readdirSync(join(dist, 'demo-app/assets'));
  expect(assets.length).toBeGreaterThan(0);
  for (const f of assets) expect(f, f).toMatch(/-[\w-]{8,}\.\w+$/);
});

test('every frosted surface keeps its unprefixed backdrop-filter (Chromium ignores the -webkit- one)', () => {
  // The CSS minifier keeps only the last of `backdrop-filter` and `-webkit-backdrop-filter` in a rule: written
  // unprefixed first, the site's floating bars and pills lost their blur in Chromium (2026-11-08).
  const css = walk(dist).filter((f) => f.endsWith('.css') && !f.includes('/demo-app/')).map((f) => readFileSync(f, 'utf8'))
    .concat(htmlFiles().flatMap((f) => [...readFileSync(f, 'utf8').matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]!)));
  const rules = css.flatMap((c) => [...c.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ sel: m[1]!.trim(), body: m[2]! })));
  const prefixedOnly = rules.filter((r) => /-webkit-backdrop-filter:/.test(r.body) && !/(^|[;{\s])backdrop-filter:/.test(r.body)).map((r) => r.sel);
  expect(prefixedOnly).toEqual([]);
  expect(rules.filter((r) => /(^|[;\s])backdrop-filter:\s*blur/.test(r.body)).length).toBeGreaterThan(3);
});
