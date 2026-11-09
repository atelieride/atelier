import { describe, expect, test, vi } from 'vitest';
import { config } from '../../src/config';
import { WINDOWS_STORE, clientClass, countryOf, dataPoint, downloadSource, handle, pagesHandler, type CountedEvent, type Store } from '../../src/lib/update-endpoints';

// The app and the site only know useatelier.dev; these endpoints point at the files
// on GitHub Releases. Nothing here is trusted by the app (signed feed, sha512, code signature): the job is to answer
// correctly, never redirect anywhere else, and keep answering when GitHub is slow or rate-limits.

const GH = 'https://github.com/atelieride/atelier';
const API = 'https://api.github.com/repos/atelieride/atelier/releases?per_page=100';

const upstream = [
  { tag_name: 'v0.3.0-beta.2', draft: false, prerelease: true, body: 'notes', assets: [{ name: 'x' }] },
  { tag_name: 'v0.3.0-beta.1', draft: true, prerelease: true },
  { tag_name: 'v0.2.0', draft: false, prerelease: false },
  { tag_name: 'v0.2.0-beta.8', draft: false, prerelease: true },
  { tag_name: 'nightly', draft: false, prerelease: true },
  { tag_name: 'v1.0', draft: false, prerelease: false }
];

/** A store with expiries on a fake clock, like the edge cache. */
function memoryStore(clock: { now: number }): Store & { keys(): string[] } {
  const m = new Map<string, { body: string; until: number }>();
  return {
    async get(k) { const e = m.get(k); return e && e.until > clock.now ? e.body : null; },
    async put(k, body, ttl) { m.set(k, { body, until: clock.now + ttl * 1000 }); },
    keys: () => [...m.keys()]
  };
}

type Up = { status: number; body?: unknown } | 'timeout' | 'throw';

function setup(o: { up?: Up[]; token?: string; record?: (e: CountedEvent) => void } = {}) {
  const clock = { now: 1_000_000 };
  const store = memoryStore(clock);
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const queue = [...(o.up ?? [])];
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), headers: Object.fromEntries(new Headers(init?.headers).entries()) });
    const next = queue.shift() ?? { status: 200, body: upstream };
    if (next === 'throw') throw new Error('connection reset');
    if (next === 'timeout') {
      return new Promise<Response>((_, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('aborted'))));
    }
    return new Response(next.body === undefined ? '' : JSON.stringify(next.body), { status: next.status });
  }) as typeof fetch;
  const events: CountedEvent[] = [];
  const record = o.record ?? ((e: CountedEvent) => { events.push(e); });
  const get = (path: string, method = 'GET', headers: Record<string, string> = {}, cf?: Record<string, unknown>) => {
    const req = new Request(`https://useatelier.dev${path}`, { method, headers });
    if (cf) Object.defineProperty(req, 'cf', { value: cf });
    return handle(req, { fetch: fetchFn, store, token: o.token, timeoutMs: 50, record });
  };
  return { get, calls, clock, store, events };
}

const json = async (r: Response) => JSON.parse(await r.text()) as unknown;

describe('/updates/releases', () => {
  test('the published releases with a release tag, newest first, only the fields the app reads', async () => {
    const h = setup();
    const r = await h.get('/updates/releases');
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toMatch(/^application\/json/);
    expect(await json(r)).toEqual([
      { tag_name: 'v0.3.0-beta.2', draft: false, prerelease: true },
      { tag_name: 'v0.2.0', draft: false, prerelease: false },
      { tag_name: 'v0.2.0-beta.8', draft: false, prerelease: true }
    ]);
    expect(h.calls.map((c) => c.url)).toEqual([API]);
    expect(h.calls[0]!.headers).toMatchObject({ accept: 'application/vnd.github+json', 'user-agent': 'useatelier.dev' });
    expect(h.calls[0]!.headers.authorization).toBeUndefined();
  });

  test('with the GITHUB_TOKEN secret the upstream request is authenticated (5000/hour instead of 60)', async () => {
    const h = setup({ token: 'github_pat_x' });
    await h.get('/updates/releases');
    expect(h.calls[0]!.headers.authorization).toBe('Bearer github_pat_x');
  });

  test('cached for 5 minutes: one upstream request, then GitHub again', async () => {
    const h = setup();
    await h.get('/updates/releases');
    h.clock.now += 299_000;
    await h.get('/updates/releases');
    expect(h.calls).toHaveLength(1);
    h.clock.now += 2_000;
    await h.get('/updates/releases');
    expect(h.calls).toHaveLength(2);
  });

  test.each<[string, Up]>([
    ['rate-limited', { status: 403, body: { message: 'API rate limit exceeded' } }],
    ['down', { status: 502 }],
    ['slow', 'timeout'],
    ['unreachable', 'throw'],
    ['answering nonsense', { status: 200, body: { not: 'a list' } }]
  ])('GitHub %s: the last good list (kept 7 days) answers', async (_name, failure) => {
    const h = setup({ up: [{ status: 200, body: upstream }, failure] });
    const first = await (await h.get('/updates/releases')).text();
    h.clock.now += 6 * 86_400_000;
    const r = await h.get('/updates/releases');
    expect(r.status).toBe(200);
    expect(await r.text()).toBe(first);
  });

  test('while GitHub fails, the last good copy stands in for a minute: no request waits on GitHub again meanwhile', async () => {
    const h = setup({ up: [{ status: 200, body: upstream }, 'timeout'] });
    await h.get('/updates/releases');
    h.clock.now += 301_000;
    await h.get('/updates/releases');
    expect(h.calls).toHaveLength(2);
    h.clock.now += 59_000;
    expect((await h.get('/updates/releases')).status).toBe(200);
    expect(h.calls).toHaveLength(2);
    h.clock.now += 2_000;
    await h.get('/updates/releases');
    expect(h.calls).toHaveLength(3);
  });

  test('a cache that throws is a miss, never a 500', async () => {
    const broken: Store = { get: async () => { throw new Error('cache down'); }, put: async () => { throw new Error('cache down'); } };
    const ok = await handle(new Request('https://useatelier.dev/updates/releases'), { fetch: async () => new Response(JSON.stringify(upstream)), store: broken });
    expect(ok.status).toBe(200);
    const down = await handle(new Request('https://useatelier.dev/updates/releases'), { fetch: async () => new Response('', { status: 500 }), store: broken });
    expect(down.status).toBe(503);
  });

  test('GitHub failing and no copy at all: 503, nothing cached', async () => {
    const h = setup({ up: [{ status: 500 }] });
    const r = await h.get('/updates/releases');
    expect(r.status).toBe(503);
    expect(h.store.keys()).toEqual([]);
  });

  test('a copy older than 7 days is gone', async () => {
    const h = setup({ up: [{ status: 200, body: upstream }, { status: 500 }] });
    await h.get('/updates/releases');
    h.clock.now += 8 * 86_400_000;
    expect((await h.get('/updates/releases')).status).toBe(503);
  });

  test('at most 100 releases', async () => {
    const many = Array.from({ length: 150 }, (_, i) => ({ tag_name: `v0.0.${i}`, draft: false, prerelease: false }));
    const h = setup({ up: [{ status: 200, body: many }] });
    expect(((await json(await h.get('/updates/releases'))) as unknown[]).length).toBe(100);
  });
});

describe('/updates/download/<tag>/<name>', () => {
  test.each([
    ['v0.2.0', 'latest-mac.yml'],
    ['v0.2.0', 'latest-mac.yml.sig'],
    ['v0.2.0', 'Atelier-0.2.0-arm64.zip'],
    ['v0.3.0-beta.2', 'Atelier-0.3.0-beta.2-arm64.dmg']
  ])('%s/%s → the file on GitHub Releases', async (tag, name) => {
    const h = setup();
    const r = await h.get(`/updates/download/${tag}/${name}`);
    expect(r.status).toBe(302);
    expect(r.headers.get('location')).toBe(`${GH}/releases/download/${tag}/${name}`);
    // No list needed to point at a file.
    expect(h.calls).toEqual([]);
  });

  test.each([
    'v0.2/latest-mac.yml',
    'v0.2.0/Atelier-0.2.1-arm64.zip',
    'v0.2.0/Atelier-0.2.0-x64.zip',
    // The Windows MSIX is a release asset too, but nothing of the app's or the site's fetches it through here:
    // it goes to the Store from the published release, and Windows updates come from the Store.
    'v0.2.0/Atelier-0.2.0-x64.msix',
    'v0.3.0-beta.2/Atelier-0.3.0-beta.2-x64.msix',
    'v0.2.0/notes.txt',
    'v0.2.0/latest-mac.yml/x',
    'v0.2.0/..%2Flatest-mac.yml',
    'v0.2.0%2F..%2Fv0.1.0/latest-mac.yml',
    '..%2F..%2Fother%2Frepo/latest-mac.yml',
    'v0.2.0/latest-mac.yml%3F',
    'v0.2.0/',
    'v0.2.0'
  ])('%s → 404, never a redirect', async (rest) => {
    const r = await setup().get(`/updates/download/${rest}`);
    expect(r.status).toBe(404);
    expect(r.headers.get('location')).toBeNull();
  });
});

describe('/download/mac', () => {
  test('the DMG of the newest stable release', async () => {
    const r = await setup().get('/download/mac');
    expect(r.status).toBe(302);
    expect(r.headers.get('location')).toBe(`${GH}/releases/download/v0.2.0/Atelier-0.2.0-arm64.dmg`);
  });

  test('/download/mac/beta: the newest of betas and stables', async () => {
    const r = await setup().get('/download/mac/beta');
    expect(r.headers.get('location')).toBe(`${GH}/releases/download/v0.3.0-beta.2/Atelier-0.3.0-beta.2-arm64.dmg`);
  });

  test('no stable release yet → the download page', async () => {
    const r = await setup({ up: [{ status: 200, body: [{ tag_name: 'v0.2.0-beta.8', draft: false, prerelease: true }] }] }).get('/download/mac');
    expect(r.status).toBe(302);
    expect(r.headers.get('location')).toBe('https://useatelier.dev/download');
  });

  test('no list at all (GitHub down, nothing cached) → the releases page on GitHub, not an error', async () => {
    const r = await setup({ up: [{ status: 500 }] }).get('/download/mac');
    expect(r.status).toBe(302);
    expect(r.headers.get('location')).toBe(`${GH}/releases`);
  });
});

describe('/download/windows (the Microsoft Store)', () => {
  test('the Store listing, without asking GitHub', async () => {
    const h = setup();
    const r = await h.get('/download/windows');
    expect(r.status).toBe(302);
    expect(r.headers.get('location')).toBe('https://apps.microsoft.com/detail/9N9FX0BQ20HF');
    expect(h.calls).toEqual([]);
  });

  test('the same listing as the site\'s buttons (config.windowsStoreUrl), or none yet', () => {
    expect([null, WINDOWS_STORE]).toContain(config.windowsStoreUrl);
  });

  test('counted like a DMG: channel windows, version store, source, country, client; HEAD is not', async () => {
    const h = setup();
    await h.get('/download/windows?ref=hn', 'GET', { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/141.0' }, { country: 'DE' });
    await h.get('/download/windows', 'HEAD');
    expect(h.events).toEqual([{ kind: 'download', channel: 'windows', version: 'store', source: 'hn', country: 'DE', client: 'browser' }]);
    expect(dataPoint(h.events[0]!).blobs).toEqual(['windows', 'store', 'hn', 'DE', 'browser']);
  });

  test('nothing else under /download/windows', async () => {
    expect((await setup().get('/download/windows/beta')).status).toBe(404);
  });
});

describe('download counting', () => {
  const browser = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36';

  test('one event per GET that ends at a DMG: channel, version, source page, country, client', async () => {
    const h = setup();
    await h.get('/download/mac', 'GET', { referer: 'https://useatelier.dev/download', 'user-agent': browser }, { country: 'IT' });
    await h.get('/download/mac/beta', 'GET', { 'user-agent': browser });
    expect(h.events).toEqual([
      { kind: 'download', channel: 'stable', version: '0.2.0', source: '/download', country: 'IT', client: 'browser' },
      { kind: 'download', channel: 'beta', version: '0.3.0-beta.2', source: 'direct', country: 'XX', client: 'browser' }
    ]);
  });

  test('HEAD (link previews) and redirects that are not a DMG are not counted', async () => {
    const h = setup();
    await h.get('/download/mac', 'HEAD');
    expect(h.events).toEqual([]);
    const noStable = setup({ up: [{ status: 200, body: [{ tag_name: 'v0.2.0-beta.8', draft: false, prerelease: true }] }] });
    await noStable.get('/download/mac');
    expect(noStable.events).toEqual([]);
    const down = setup({ up: [{ status: 500 }] });
    await down.get('/download/mac');
    expect(down.events).toEqual([]);
  });

  test('the answer is the same with a recorder that throws', async () => {
    const ok = await setup().get('/download/mac');
    const broken = await setup({ record: () => { throw new Error('binding down'); } }).get('/download/mac');
    expect(broken.status).toBe(ok.status);
    expect(broken.headers.get('location')).toBe(ok.headers.get('location'));
    expect(broken.headers.get('cache-control')).toBe(ok.headers.get('cache-control'));
  });

  test.each<[string, Record<string, string>, string]>([
    ['/download/mac?ref=hn', {}, 'hn'],
    ['/download/mac?ref=hn', { referer: 'https://news.ycombinator.com/item?id=1' }, 'hn'],
    ['/download/mac?ref=Bad_Ref', { referer: 'https://useatelier.dev/' }, '/'],
    [`/download/mac?ref=${'x'.repeat(33)}`, {}, 'direct'],
    ['/download/mac', { referer: 'https://useatelier.dev/support?thanks=1' }, '/support'],
    ['/download/mac', { referer: 'https://useatelier.dev/old-page' }, 'site-other'],
    ['/download/mac', { referer: 'https://News.YCombinator.com/item?id=1' }, 'news.ycombinator.com'],
    ['/download/mac', { referer: `https://${'a'.repeat(80)}.example/x` }, 'a'.repeat(64)],
    // Hosts on a private network say nothing useful and may name a company's machines: kept as a category only.
    ['/download/mac', { referer: 'http://192.168.1.20:8080/wiki' }, 'ip'],
    ['/download/mac', { referer: 'https://[fd00::1]/x' }, 'ip'],
    ['/download/mac', { referer: 'http://intranet/page' }, 'internal'],
    ['/download/mac', { referer: 'http://localhost:4321/' }, 'internal'],
    ['/download/mac', { referer: 'https://wiki.acme.corp/tools' }, 'internal'],
    ['/download/mac', { referer: 'https://nas.home.arpa/' }, 'internal'],
    ['/download/mac', { referer: 'https://build.internal/x' }, 'internal'],
    ['/download/mac', { referer: 'https://mbp.local/x' }, 'internal'],
    ['/download/mac', { referer: 'https://git.lan/x' }, 'internal'],
    ['/download/mac', { referer: 'not a url' }, 'direct'],
    ['/download/mac', { referer: 'android-app://com.slack/' }, 'direct'],
    ['/download/mac', {}, 'direct'],
    // The live demo's "Download for Mac" (src/demo/shell/menu-model.ts › DOWNLOAD_HREF): its page is the demo's iframe,
    // /demo-app/index.html, not one of PAGES. The `from` it adds names it, a browser that sends no referrer included;
    // without it, a referrer from the demo's files says the same. Only known values: anything else is ignored.
    ['/download/mac?from=demo', { referer: 'https://useatelier.dev/demo-app/index.html' }, 'demo'],
    ['/download/mac?from=demo', {}, 'demo'],
    ['/download/mac', { referer: 'https://useatelier.dev/demo-app/index.html' }, 'demo'],
    ['/download/mac', { referer: 'https://useatelier.dev/demo-app/assets/x.js' }, 'demo'],
    ['/download/mac?from=evil', { referer: 'https://useatelier.dev/' }, '/'],
    ['/download/mac?from=Demo', {}, 'direct'],
    ['/download/mac?from=demo-app', {}, 'direct'],
    ['/download/mac', { referer: 'https://other.example/demo-app/index.html' }, 'other.example'],
    ['/download/mac', { referer: 'https://useatelier.dev/demo-apps' }, 'site-other']
  ])('%s with %j → source %s', (path, headers, source) => {
    expect(downloadSource(new Request(`https://useatelier.dev${path}`, { headers }))).toBe(source);
  });

  test.each<[string | null, 'browser' | 'bot']>([
    ['Mozilla/5.0 (Macintosh) Safari/605.1.15', 'browser'],
    ['Mozilla/5.0 (compatible; Googlebot/2.1)', 'bot'],
    ['Slackbot-LinkExpanding 1.0', 'bot'],
    ['facebookexternalhit/1.1', 'bot'],
    ['curl/8.7.1', 'bot'],
    ['python-requests/2.32', 'bot'],
    ['Mozilla/5.0 HeadlessChrome/141.0', 'bot'],
    ['', 'bot'],
    [null, 'bot']
  ])('client %j → %s', (ua, client) => {
    expect(clientClass(ua)).toBe(client);
  });

  test.each<[unknown, string]>([['IT', 'IT'], ['T1', 'XX'], ['it', 'XX'], [42, 'XX'], [undefined, 'XX']])('country %j → %s', (country, out) => {
    const req = new Request('https://useatelier.dev/download/mac');
    Object.defineProperty(req, 'cf', { value: country === undefined ? undefined : { country } });
    expect(countryOf(req)).toBe(out);
  });

  test('data points: index = kind, blobs and doubles in a fixed order', () => {
    expect(dataPoint({ kind: 'download', channel: 'beta', version: '0.3.0-beta.2', source: 'hn', country: 'IT', client: 'browser' }))
      .toEqual({ indexes: ['download'], blobs: ['beta', '0.3.0-beta.2', 'hn', 'IT', 'browser'], doubles: [1] });
    expect(dataPoint({ kind: 'check', version: '0.3.0', flagged: true, d: true, w: false, m: true }))
      .toEqual({ indexes: ['check'], blobs: ['0.3.0', 'flagged'], doubles: [1, 1, 0, 1] });
  });
});

describe('update-check counting', () => {
  const app = (v: string) => ({ 'user-agent': `Atelier/${v} (macOS)` });

  test.each<[string, Record<string, string>, Omit<Extract<CountedEvent, { kind: 'check' }>, 'kind'>]>([
    ['/updates/releases?a=dwm', app('0.3.0'), { version: '0.3.0', flagged: true, d: true, w: true, m: true }],
    ['/updates/releases?a=d', app('0.3.0-beta.1'), { version: '0.3.0-beta.1', flagged: true, d: true, w: false, m: false }],
    ['/updates/releases?a=mw', app('0.3.0'), { version: '0.3.0', flagged: true, d: false, w: true, m: true }],
    ['/updates/releases?a=', app('0.3.0'), { version: '0.3.0', flagged: true, d: false, w: false, m: false }],
    ['/updates/releases', app('0.2.0-beta.9'), { version: '0.2.0-beta.9', flagged: false, d: false, w: false, m: false }],
    ['/updates/releases?a=dd', app('0.3.0'), { version: '0.3.0', flagged: false, d: false, w: false, m: false }],
    ['/updates/releases?a=x', app('0.3.0'), { version: '0.3.0', flagged: false, d: false, w: false, m: false }],
    ['/updates/releases?a=dwmx', app('0.3.0'), { version: '0.3.0', flagged: false, d: false, w: false, m: false }],
    // Flags count only from the app's User-Agent: a plain `curl ...?a=dwm` cannot add active installs.
    ['/updates/releases?a=dwm', { 'user-agent': 'curl/8.7.1' }, { version: 'other', flagged: false, d: false, w: false, m: false }],
    ['/updates/releases?a=dwm', { 'user-agent': 'Atelier/1.0 (macOS)' }, { version: 'other', flagged: false, d: false, w: false, m: false }],
    ['/updates/releases?a=dwm', {}, { version: 'other', flagged: false, d: false, w: false, m: false }],
    // At most five digits per part: a longer version is not stored as is.
    ['/updates/releases?a=d', app('99999.0.0-beta.99999'), { version: '99999.0.0-beta.99999', flagged: true, d: true, w: false, m: false }],
    ['/updates/releases?a=d', app('1.0.999999'), { version: 'other', flagged: false, d: false, w: false, m: false }],
    ['/updates/releases?a=d', app(`1.0.0-beta.${'9'.repeat(500)}`), { version: 'other', flagged: false, d: false, w: false, m: false }]
  ])('%s with %j', async (path, headers, fields) => {
    const h = setup();
    await h.get(path, 'GET', headers, { country: 'IT' });
    expect(h.events).toEqual([{ kind: 'check', ...fields }]);
  });

  test('the answer does not depend on `a`, nor on a recorder that throws; HEAD is not counted', async () => {
    const plain = await setup().get('/updates/releases');
    const flagged = await setup().get('/updates/releases?a=dwm', 'GET', app('0.3.0'));
    const broken = await setup({ record: () => { throw new Error('binding down'); } }).get('/updates/releases?a=dwm');
    for (const r of [flagged, broken]) {
      expect(r.status).toBe(plain.status);
      expect(r.headers.get('cache-control')).toBe(plain.headers.get('cache-control'));
      expect(r.headers.get('content-type')).toBe(plain.headers.get('content-type'));
    }
    const body = await plain.text();
    expect(await flagged.text()).toBe(body);
    expect(await broken.text()).toBe(body);
    const head = setup();
    await head.get('/updates/releases?a=dwm', 'HEAD');
    expect(head.events).toEqual([]);
  });

  // The app marks a period reported only after a successful check (src/main/update-activity.ts): after a 503 it sends
  // the same flags again, so the failed request counts without them.
  test('a check is counted without its flags when the list is unavailable (the app will send them again)', async () => {
    const h = setup({ up: [{ status: 500 }] });
    expect((await h.get('/updates/releases?a=dwm', 'GET', app('0.3.0'))).status).toBe(503);
    expect(h.events).toEqual([{ kind: 'check', version: '0.3.0', flagged: true, d: false, w: false, m: false }]);
  });
});

describe('/releases', () => {
  test('the list and a release page on GitHub', async () => {
    const h = setup();
    expect((await h.get('/releases')).headers.get('location')).toBe(`${GH}/releases`);
    expect((await h.get('/releases/v0.2.0')).headers.get('location')).toBe(`${GH}/releases/tag/v0.2.0`);
    expect((await h.get('/releases/nightly')).status).toBe(404);
    expect(h.calls).toEqual([]);
  });
});

describe('everything else', () => {
  test.each(['/updates', '/updates/releases/', '/download/mac/stable', '/releases/v0.2.0/x', '/nope'])('%s → 404', async (p) => {
    expect((await setup().get(p)).status).toBe(404);
  });

  test('HEAD answers like GET; other methods get 405', async () => {
    const h = setup();
    expect((await h.get('/updates/download/v0.2.0/latest-mac.yml', 'HEAD')).status).toBe(302);
    expect((await h.get('/updates/releases', 'POST')).status).toBe(405);
  });
});

describe('pagesHandler: the production wiring (edge cache, secret, waitUntil)', () => {
  test('the list is fetched with the secret, cached under the site origin with max-age, writes deferred to waitUntil', async () => {
    const stored = new Map<string, Response>();
    const cache = {
      match: async (k: string) => stored.get(k)?.clone(),
      put: async (k: string, r: Response) => { stored.set(k, r); }
    };
    const seen: Headers[] = [];
    vi.stubGlobal('caches', { default: cache });
    vi.stubGlobal('fetch', async (_u: string, init: RequestInit) => { seen.push(new Headers(init.headers)); return new Response(JSON.stringify(upstream)); });
    try {
      const deferred: Promise<unknown>[] = [];
      const ctx = { request: new Request('https://useatelier.dev/updates/releases'), env: { GITHUB_TOKEN: 'github_pat_y' }, waitUntil: (p: Promise<unknown>) => { deferred.push(p); } };
      expect((await pagesHandler(ctx)).status).toBe(200);
      expect(seen[0]!.get('authorization')).toBe('Bearer github_pat_y');
      expect(deferred.length).toBe(2);
      await Promise.all(deferred);
      expect([...stored.keys()].sort()).toEqual(['https://useatelier.dev/__update-endpoints/releases:fresh', 'https://useatelier.dev/__update-endpoints/releases:stale']);
      expect(stored.get('https://useatelier.dev/__update-endpoints/releases:fresh')!.headers.get('cache-control')).toBe('public, max-age=300');
      expect(stored.get('https://useatelier.dev/__update-endpoints/releases:stale')!.headers.get('cache-control')).toBe('public, max-age=604800');
      // The second request is answered from the cache.
      expect((await pagesHandler({ ...ctx, waitUntil: () => {} })).status).toBe(200);
      expect(seen).toHaveLength(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  test('events go to the EVENTS binding when it exists, nowhere when it does not', async () => {
    vi.stubGlobal('caches', undefined);
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify(upstream)));
    try {
      const points: unknown[] = [];
      const req = () => new Request('https://useatelier.dev/download/mac', { headers: { 'user-agent': 'Mozilla/5.0 Safari/605.1.15' } });
      const r = await pagesHandler({ request: req(), env: { EVENTS: { writeDataPoint: (p) => { points.push(p); } } }, waitUntil: () => {} });
      expect(r.status).toBe(302);
      expect(points).toEqual([{ indexes: ['download'], blobs: ['stable', '0.2.0', 'direct', 'XX', 'browser'], doubles: [1] }]);
      expect((await pagesHandler({ request: req(), env: {}, waitUntil: () => {} })).status).toBe(302);
      const throwing = { writeDataPoint: () => { throw new Error('quota'); } };
      expect((await pagesHandler({ request: req(), env: { EVENTS: throwing }, waitUntil: () => {} })).status).toBe(302);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  test('no edge cache and no secret: still answers, unauthenticated', async () => {
    const seen: Headers[] = [];
    vi.stubGlobal('caches', undefined);
    vi.stubGlobal('fetch', async (_u: string, init: RequestInit) => { seen.push(new Headers(init.headers)); return new Response(JSON.stringify(upstream)); });
    try {
      const r = await pagesHandler({ request: new Request('https://useatelier.dev/updates/releases'), env: { GITHUB_TOKEN: '' }, waitUntil: () => {} });
      expect(r.status).toBe(200);
      expect(seen[0]!.get('authorization')).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
