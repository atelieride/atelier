// The update and download endpoints of useatelier.dev,
// served by the Pages Functions in site/functions. The app and the site only know these addresses; the files live on
// GitHub Releases, behind redirects that can point elsewhere one day without touching installed apps.
//
// Nothing here is trusted by the app (signed feed, sha512 and size, code signature): the job is to answer, never to
// redirect anywhere but the releases repo, and to keep answering when GitHub is slow or rate-limits. They also count
// downloads and update checks.
import { RELEASE_TAG, parseReleaseList, pickRelease, type UpdateChannel } from '../../../src/shared/update-feed';
import { REPO, REPO_URL as GH } from './repo';
import { PAGES } from './seo';

const UPSTREAM = `https://api.github.com/repos/${REPO}/releases?per_page=100`;
/** The Windows app's Store listing (the Store installs and updates it; no Windows feed). */
export const WINDOWS_STORE = 'https://apps.microsoft.com/detail/9N9FX0BQ20HF';
const FRESH = 'releases:fresh';
const STALE = 'releases:stale';
const FRESH_TTL = 300;
const STALE_TTL = 7 * 86_400;
const FAILED_TTL = 60;
const MAX_RELEASES = 100;

/** Short-lived strings by key (the edge cache in production, a map in tests). */
export interface Store {
  get(key: string): Promise<string | null>;
  put(key: string, body: string, ttlSeconds: number): Promise<void>;
}

export interface Deps {
  fetch: typeof fetch;
  store: Store;
  /** Pages secret GITHUB_TOKEN: optional, lifts GitHub's limit from 60 to 5000 requests per hour. */
  token?: string;
  timeoutMs?: number;
  /** ctx.waitUntil in production: cache writes finish after the answer. Without it they are awaited (tests). */
  defer?(p: Promise<unknown>): void;
  /** One counted request: Analytics Engine in production, absent in dev. */
  record?(e: CountedEvent): void;
}

/** What the endpoints count: no IP, no full User-Agent, no full referrer. */
export type CountedEvent =
  | { kind: 'download'; channel: UpdateChannel | 'windows'; version: string; source: string; country: string; client: 'browser' | 'bot' }
  | { kind: 'check'; version: string; flagged: boolean; d: boolean; w: boolean; m: boolean };

/** One Analytics Engine data point (dataset useatelier_events): index1 is the kind, blobs and doubles in a fixed order. */
export interface DataPoint { indexes: [string]; blobs: string[]; doubles: number[] }

export function dataPoint(e: CountedEvent): DataPoint {
  if (e.kind === 'download') return { indexes: ['download'], blobs: [e.channel, e.version, e.source, e.country, e.client], doubles: [1] };
  return { indexes: ['check'], blobs: [e.version, e.flagged ? 'flagged' : 'legacy'], doubles: [1, +e.d, +e.w, +e.m] };
}

const BOT = /bot|crawl|spider|slurp|preview|facebookexternalhit|curl|wget|python|go-http|headless|httpclient|java\//i;

/** Link unfurlers, crawlers and command-line tools count apart from people (an empty User-Agent is a tool). */
export function clientClass(ua: string | null): 'browser' | 'bot' {
  return !ua || BOT.test(ua) ? 'bot' : 'browser';
}

/** Names that only resolve on a private network (RFC 6762, 6761, 8375 and common intranet suffixes). */
const INTERNAL_HOST = /(^[^.]+$|\.(local|localhost|internal|intranet|lan|home|corp|private|test|invalid|home\.arpa)$)/;

/** Our own links that are not a page (`?from=`), by name: the live demo's "Download for Mac",
 *  whose document is the demo's iframe under /demo-app/. */
const FROM = ['demo'] as const;
const DEMO_APP = '/demo-app/';

/**
 * Where a download comes from: `?ref=<slug>` on links we post elsewhere; `?from=<name>` on our own links that are not
 * a page (FROM); else the referring page of ours (its path, if it is a real page; the demo's files count as `demo`) or
 * the other site's host name; else `direct`. Never the full referrer (its query is dropped), and never a private
 * network's names: an IP address counts as `ip`, an intranet host as `internal`.
 */
export function downloadSource(req: Request): string {
  const url = new URL(req.url);
  const ref = url.searchParams.get('ref');
  if (ref !== null && /^[a-z0-9-]{1,32}$/.test(ref)) return ref;
  const named = url.searchParams.get('from');
  if ((FROM as readonly (string | null)[]).includes(named)) return named!;
  const raw = req.headers.get('referer');
  if (!raw) return 'direct';
  let from: URL;
  try { from = new URL(raw); } catch { return 'direct'; }
  if (from.protocol !== 'https:' && from.protocol !== 'http:') return 'direct';
  if (from.host === url.host) {
    if (from.pathname.startsWith(DEMO_APP)) return 'demo';
    return (PAGES as readonly string[]).includes(from.pathname) ? from.pathname : 'site-other';
  }
  const host = from.hostname.toLowerCase();
  if (host.startsWith('[') || /^[\d.]+$/.test(host)) return 'ip';
  if (INTERNAL_HOST.test(host)) return 'internal';
  return host.slice(0, 64);
}

const APP_UA = /^Atelier\/(\d{1,5}\.\d{1,5}\.\d{1,5}(?:-beta\.\d{1,5})?) \(macOS\)$/;

/**
 * One update check: the app's version (from its User-Agent) and the periods it says this is the first check of
 * (`a`). No `a` at all: an app from before the flags (`legacy`); a malformed `a` counts the same way, and so
 * does any request without the app's User-Agent (`other`), so a tool asking with `a=dwm` adds no active install. The
 * User-Agent can be copied, so this keeps out casual noise, not a determined forger.
 */
export function checkEvent(req: Request): Extract<CountedEvent, { kind: 'check' }> {
  const version = APP_UA.exec(req.headers.get('user-agent') ?? '')?.[1] ?? 'other';
  const a = new URL(req.url).searchParams.get('a');
  const valid = version !== 'other' && a !== null && /^[dwm]{0,3}$/.test(a) && new Set(a).size === a.length;
  const has = (k: string) => valid && (a ?? '').includes(k);
  return { kind: 'check', version, flagged: valid, d: has('d'), w: has('w'), m: has('m') };
}

/** Cloudflare's two-letter country of the request (XX when unknown, Tor's T1 included). */
export function countryOf(req: Request): string {
  const c = (req as Request & { cf?: { country?: unknown } }).cf?.country;
  return typeof c === 'string' && /^[A-Z]{2}$/.test(c) ? c : 'XX';
}

const redirect = (location: string, maxAge: number) =>
  new Response(null, { status: 302, headers: { location, 'cache-control': `public, max-age=${maxAge}` } });
const notFound = () => new Response('Not found\n', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } });

/** The names CI publishes in a release (scripts/release-ci.mjs), for that release's version only. */
function assetAllowed(version: string, name: string): boolean {
  return name === 'latest-mac.yml' || name === 'latest-mac.yml.sig' || name === `Atelier-${version}-arm64.zip` || name === `Atelier-${version}-arm64.dmg`;
}

/** The published releases with a release tag, only the fields the app reads (parseReleaseList); null when unusable. */
function trim(json: unknown): string | null {
  if (!Array.isArray(json)) return null;
  const out = json.flatMap((r: unknown) => {
    if (!r || typeof r !== 'object') return [];
    const o = r as Record<string, unknown>;
    if (o.draft !== false || typeof o.tag_name !== 'string' || !RELEASE_TAG.test(o.tag_name)) return [];
    return [{ tag_name: o.tag_name, draft: false, prerelease: o.prerelease === true }];
  });
  return JSON.stringify(out.slice(0, MAX_RELEASES));
}

async function upstream(d: Deps): Promise<string | null> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), d.timeoutMs ?? 8000);
  try {
    const headers: Record<string, string> = { accept: 'application/vnd.github+json', 'user-agent': 'useatelier.dev', 'x-github-api-version': '2022-11-28' };
    if (d.token) headers.authorization = `Bearer ${d.token}`;
    const res = await d.fetch(UPSTREAM, { headers, signal: ctl.signal });
    if (res.status !== 200) return null;
    return trim(JSON.parse(await res.text()));
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** A cache that fails is a miss: the answer comes from GitHub or the stale copy, never a 500. */
async function cached(d: Deps, key: string): Promise<string | null> {
  try { return await d.store.get(key); } catch { return null; }
}

async function save(d: Deps, key: string, body: string, ttl: number): Promise<void> {
  const p = d.store.put(key, body, ttl).catch(() => {});
  if (d.defer) d.defer(p); else await p;
}

/**
 * The release list: the 5-minute copy, else GitHub, else the last good copy (7 days, per data centre: the edge cache
 * may evict it sooner); null when there is none. While GitHub fails, the stale copy stands in as the fresh one for a
 * minute, so requests don't each wait on GitHub (or spend its rate limit) again.
 */
async function releaseList(d: Deps): Promise<string | null> {
  const fresh = await cached(d, FRESH);
  if (fresh !== null) return fresh;
  const body = await upstream(d);
  if (body !== null) {
    await save(d, FRESH, body, FRESH_TTL);
    await save(d, STALE, body, STALE_TTL);
    return body;
  }
  const stale = await cached(d, STALE);
  if (stale !== null) await save(d, FRESH, stale, FAILED_TTL);
  return stale;
}

async function latestDmg(req: Request, d: Deps, channel: UpdateChannel, record: (e: CountedEvent) => void): Promise<Response> {
  const body = await releaseList(d);
  if (body === null) return redirect(`${GH}/releases`, 60);
  const rel = pickRelease(parseReleaseList(JSON.parse(body)), channel);
  if (!rel) return redirect(new URL('/download', req.url).href, 300);
  if (req.method === 'GET') {
    record({ kind: 'download', channel, version: rel.version, source: downloadSource(req), country: countryOf(req), client: clientClass(req.headers.get('user-agent')) });
  }
  return redirect(`${GH}/releases/download/${rel.tag}/Atelier-${rel.version}-arm64.dmg`, 300);
}

export async function handle(req: Request, d: Deps): Promise<Response> {
  if (req.method !== 'GET' && req.method !== 'HEAD') return new Response('Method not allowed\n', { status: 405, headers: { allow: 'GET, HEAD' } });
  // Counting never changes or delays an answer: a recorder that throws is ignored.
  const record = (e: CountedEvent) => { try { d.record?.(e); } catch { /* not counted */ } };
  // Raw segments (the URL parser already resolved dot segments, %2e included): an encoded slash stays encoded and
  // fails the strict checks below. Every redirect target is rebuilt from constants plus an anchored tag and exact name.
  const p = new URL(req.url).pathname.split('/').slice(1);
  const route = p.join('/');

  if (route === 'updates/releases') {
    const check = checkEvent(req);
    const body = await releaseList(d);
    // The app marks a period reported only after a successful check and sends its flags again next time: a failed
    // check counts as a request, without them, or the same install would count twice.
    if (req.method === 'GET') record(body === null ? { ...check, d: false, w: false, m: false } : check);
    if (body === null) return new Response('Release list unavailable\n', { status: 503, headers: { 'retry-after': '300', 'cache-control': 'no-store' } });
    return new Response(body, { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'public, max-age=60' } });
  }
  if (p.length === 4 && p[0] === 'updates' && p[1] === 'download') {
    const [, , tag, name] = p as [string, string, string, string];
    const m = RELEASE_TAG.exec(tag);
    if (!m || !assetAllowed(m[1]!, name)) return notFound();
    return redirect(`${GH}/releases/download/${tag}/${name}`, 86_400);
  }
  if (route === 'download/mac') return latestDmg(req, d, 'stable', record);
  if (route === 'download/mac/beta') return latestDmg(req, d, 'beta', record);
  if (route === 'download/windows') {
    // The Store keeps the version: counted as channel `windows`, version `store`.
    if (req.method === 'GET') record({ kind: 'download', channel: 'windows', version: 'store', source: downloadSource(req), country: countryOf(req), client: clientClass(req.headers.get('user-agent')) });
    return redirect(WINDOWS_STORE, 300);
  }
  if (route === 'releases') return redirect(`${GH}/releases`, 86_400);
  if (p.length === 2 && p[0] === 'releases') {
    if (!RELEASE_TAG.test(p[1]!)) return notFound();
    return redirect(`${GH}/releases/tag/${p[1]}`, 86_400);
  }
  return notFound();
}

/** The part of the Workers Cache API the store uses (caches.default). */
interface CacheLike {
  match(key: string): Promise<Response | undefined>;
  put(key: string, res: Response): Promise<void>;
}

/** The edge cache as a Store: one synthetic URL per key, expiring with max-age. */
export function cacheStore(cache: CacheLike, origin: string): Store {
  const key = (k: string) => `${origin}/__update-endpoints/${k}`;
  return {
    async get(k) { const r = await cache.match(key(k)); return r ? r.text() : null; },
    async put(k, body, ttl) { await cache.put(key(k), new Response(body, { headers: { 'cache-control': `public, max-age=${ttl}` } })); }
  };
}

const noStore: Store = { get: async () => null, put: async () => {} };

/** The Analytics Engine binding (site/wrangler.toml): absent in dev and tests. */
interface AnalyticsEngine { writeDataPoint(p: DataPoint): void }

/** What a route file in site/functions exports as onRequestGet and onRequestHead. */
export function pagesHandler(ctx: { request: Request; env: { GITHUB_TOKEN?: string; EVENTS?: AnalyticsEngine }; waitUntil(p: Promise<unknown>): void }): Promise<Response> {
  const cache = (globalThis as unknown as { caches?: { default?: CacheLike } }).caches?.default;
  const store = cache ? cacheStore(cache, new URL(ctx.request.url).origin) : noStore;
  const events = ctx.env.EVENTS;
  return handle(ctx.request, {
    fetch: (input, init) => fetch(input, init), store, token: ctx.env.GITHUB_TOKEN || undefined, defer: (p) => ctx.waitUntil(p),
    record: events ? (e) => events.writeDataPoint(dataPoint(e)) : undefined
  });
}
