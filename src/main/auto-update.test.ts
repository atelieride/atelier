import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import type { UpdateChannelSetting, UpdateStatus } from '@shared/update-feed';
import { rawPublicKey } from '@shared/update-sign.node';
import { AutoUpdater, SITE_SOURCE, buildChannelOf, parseTestUpdate, type AutoUpdateDeps, type FeedSource } from './auto-update';
import type { Opener, RawResponse } from './update-download';
// @ts-expect-error: .mjs script without types
import { feedYaml } from '../../scripts/make-feed.mjs';

const REQ = 'identifier "app.atelier.desktop" and certificate root = H"2cd6"';

/** A bundle's files the updater reads (no real signature: codesign is faked here, real in the integration test). */
function fixtureApp(path: string, o: { version: string; builtAt: number; protocol?: number; helper?: string }): string {
  const helperDir = join(path, `Contents/Resources/app.asar.unpacked/node_modules/node-pty/prebuilds/darwin-${process.arch}`);
  mkdirSync(helperDir, { recursive: true });
  writeFileSync(join(helperDir, 'spawn-helper'), o.helper ?? 'helper-v1');
  writeFileSync(join(path, 'Contents/Resources/atelier-build.json'), JSON.stringify({ protocol: o.protocol ?? 1, builtAt: o.builtAt }));
  writeFileSync(join(path, 'Contents/Info.plist'), `<plist><dict><key>CFBundleShortVersionString</key><string>${o.version}</string></dict></plist>`);
  return path;
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

interface Scenario {
  current?: string;
  setting?: UpdateChannelSetting;
  buildChannel?: 'stable' | 'beta' | null;
  releases?: unknown;
  feed?: Partial<Record<string, unknown>>;
  /** Changes the yml after signing. */
  tamper?: (yml: string) => string;
  zip?: string;
  newApp?: { version?: string; builtAt?: number; protocol?: number; helper?: string };
  codesign?: { strict?: boolean; requirement?: boolean };
  ownRequirement?: string | null;
  status?: Record<string, number>;
  available?: boolean;
  appLocation?: AutoUpdateDeps['appLocation'];
  now?: () => number;
}

function harness(sc: Scenario = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'atl-au-'));
  const home = join(dir, 'home');
  mkdirSync(home);
  const own = fixtureApp(join(dir, 'own/Atelier.app'), { version: sc.current ?? '0.1.0', builtAt: 1 });
  const next = fixtureApp(join(dir, 'next/Atelier.app'), { version: '0.2.0', builtAt: 2, ...sc.newApp });
  const zip = sc.zip ?? 'zip-bytes';
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const feed = {
    version: '0.2.0', path: 'Atelier-0.2.0-arm64.zip', sha512: createHash('sha512').update(zip).digest('base64'), size: Buffer.byteLength(zip),
    releaseDate: '2026-10-11T00:00:00.000Z', channel: 'stable', minimumSystemVersion: '12.0', protocol: 1, spawnHelper: sha256('helper-v1'),
    notes: '- New things', ...sc.feed
  };
  const signed = feedYaml(feed);
  const yml = sc.tamper ? sc.tamper(signed) : signed;
  const sig = sign(null, Buffer.from(signed), privateKey).toString('base64');
  const tag = `v${feed.version}`;
  const routes: Record<string, string> = {
    'https://api.test/releases': JSON.stringify(sc.releases ?? [{ tag_name: tag, draft: false, prerelease: feed.version.includes('-') }]),
    [`https://dl.test/${tag}/latest-mac.yml`]: yml,
    [`https://dl.test/${tag}/latest-mac.yml.sig`]: `${sig}\n`,
    [`https://dl.test/${tag}/${feed.path}`]: zip
  };
  // `requests`: paths without the query (most tests); `urls`: what was really asked (the active-install flags).
  const requests: string[] = [];
  const urls: string[] = [];
  const open: Opener = async (url) => {
    const path = url.split('?')[0]!;
    requests.push(path);
    urls.push(url);
    const body = routes[path];
    const status = sc.status?.[path] ?? (body === undefined ? 404 : 200);
    const res: RawResponse = {
      status, location: null, headers: status === 403 ? { 'x-ratelimit-remaining': '0' } : {}, close: () => {},
      body: { async *[Symbol.asyncIterator]() { if (body !== undefined && status === 200) yield Buffer.from(body); } }
    };
    return res;
  };
  const execs: string[][] = [];
  const exec = async (cmd: string, args: string[]) => {
    execs.push([cmd, ...args]);
    if (cmd === '/usr/bin/ditto') { cpSync(next, join(args[3]!, 'Atelier.app'), { recursive: true }); return ''; }
    if (cmd === '/usr/bin/codesign') {
      const withReq = args.includes('--test-requirement');
      if (withReq && sc.codesign?.requirement === false) throw new Error('test-requirement: code failed to satisfy specified code requirement(s)');
      if (!withReq && sc.codesign?.strict === false) throw new Error('a sealed resource is missing or invalid');
      return '';
    }
    throw new Error(`unexpected ${cmd}`);
  };
  const source: FeedSource = {
    releasesUrl: 'https://api.test/releases',
    assetUrl: (t, name) => `https://dl.test/${t}/${name}`,
    pageUrl: (t) => `https://page.test/${t}`,
    releasesPage: 'https://page.test/releases',
    allow: (u) => u.protocol === 'https:'
  };
  let setting: UpdateChannelSetting = sc.setting ?? 'auto';
  const statuses: UpdateStatus[] = [];
  const logs: string[] = [];
  const deps: AutoUpdateDeps = {
    home, version: sc.current ?? '0.1.0', protocol: 1, appPath: own, buildChannel: sc.buildChannel === undefined ? 'stable' : sc.buildChannel,
    channelSetting: () => setting, available: sc.available ?? true, source, publicKeys: [rawPublicKey(publicKey)], open, exec,
    ownRequirement: async () => (sc.ownRequirement === undefined ? REQ : sc.ownRequirement), systemVersion: '26.0',
    log: (m) => logs.push(m), onStatus: (s) => statuses.push(s), now: sc.now ?? (() => 1000), appLocation: sc.appLocation ?? (() => null)
  };
  const updater = new AutoUpdater(deps);
  const staged = join(home, 'updates/Atelier.app');
  return { updater, deps, home, staged, requests, urls, execs, statuses, logs, tag, setChannel: (s: UpdateChannelSetting) => { setting = s; } };
}

test('no channel (dev or stage-update build without opt-in): idle, no network', async () => {
  const h = harness({ buildChannel: null });
  h.updater.init();
  const s = await h.updater.check({ manual: true });
  expect(s.channel).toBeNull();
  expect(s.phase.kind).toBe('idle');
  expect(h.requests).toEqual([]);
  // Opting in from Settings turns it on.
  h.setChannel('stable');
  expect((await h.updater.check({ manual: true })).phase.kind).toBe('ready');
});

test('not a packaged build: never checks', async () => {
  const h = harness({ available: false });
  h.updater.init();
  expect((await h.updater.check({ manual: true })).phase.kind).toBe('idle');
  expect(h.requests).toEqual([]);
});

test('nothing newer on the channel: up to date, no feed downloaded', async () => {
  const h = harness({ releases: [{ tag_name: 'v0.1.0', draft: false, prerelease: false }, { tag_name: 'v0.9.0-beta.1', draft: false, prerelease: true }] });
  h.updater.init();
  const s = await h.updater.check({ manual: false });
  expect(s.phase.kind).toBe('up-to-date');
  expect(s.lastCheck).toBe(1000);
  expect(h.requests).toEqual(['https://api.test/releases']);
});

test('a newer signed release: downloaded, verified, staged where "Update ready" looks', async () => {
  const h = harness();
  h.updater.init();
  const s = await h.updater.check({ manual: false });
  expect(s.phase).toEqual({ kind: 'ready', version: '0.2.0', notes: '- New things' });
  expect(readFileSync(join(h.staged, 'Contents/Resources/atelier-build.json'), 'utf8')).toContain('"builtAt":2');
  expect(JSON.parse(readFileSync(join(h.home, 'updates/update.json'), 'utf8'))).toMatchObject({ version: '0.2.0', notes: '- New things' });
  // The phases the UI saw, in order.
  const kinds = h.statuses.map((x) => x.phase.kind).filter((k, i, a) => k !== a[i - 1]);
  expect(kinds).toEqual(['checking', 'downloading', 'verifying', 'ready']);
  // The code signature is checked twice: intact, then signed like the running app.
  expect(h.execs.filter((e) => e[0] === '/usr/bin/codesign').map((e) => e.slice(1, -1))).toEqual([
    ['--verify', '--deep', '--strict'], ['--verify', '--deep', '--strict', '--test-requirement', `=${REQ}`]
  ]);
  // The download folder is cleaned up.
  expect(readdirSync(join(h.home, 'updates')).sort()).toEqual(['Atelier.app', 'state.json', 'update.json']);
  // Checking again does not download it twice.
  const before = h.requests.length;
  expect((await h.updater.check({ manual: true })).phase.kind).toBe('ready');
  expect(h.requests.length - before).toBe(1);
});

test('a tampered feed is rejected before anything is downloaded; automatic checks do not loop on it', async () => {
  const h = harness({ tamper: (y) => y.replace('- New things', '- Evil things') });
  h.updater.init();
  const s = await h.updater.check({ manual: false });
  expect(s.phase).toMatchObject({ kind: 'error', error: 'signature', version: '0.2.0' });
  expect(existsSync(h.staged)).toBe(false);
  expect(h.requests.some((u) => u.endsWith('.zip'))).toBe(false);
  expect(h.logs.join('\n')).toMatch(/signature/);
  // The next automatic check keeps the error without fetching the feed again; "Check now" tries again.
  const n = h.requests.length;
  expect((await h.updater.check({ manual: false })).phase).toMatchObject({ kind: 'error', error: 'signature' });
  expect(h.requests.slice(n)).toEqual(['https://api.test/releases']);
  await h.updater.check({ manual: true });
  expect(h.requests.slice(n + 1)).toContain(`https://dl.test/${h.tag}/latest-mac.yml`);
});

test('a ZIP that does not match the signed sha512 is not extracted nor staged', async () => {
  // Same size, other bytes.
  const g = harness({ zip: 'zip-bytez', feed: { sha512: createHash('sha512').update('zip-bytes').digest('base64') } });
  g.updater.init();
  expect((await g.updater.check({ manual: true })).phase).toMatchObject({ kind: 'error', error: 'integrity' });
  expect(g.execs).toEqual([]);
  expect(existsSync(g.staged)).toBe(false);
  expect(existsSync(join(g.home, 'updates/download'))).toBe(false);
});

test('a ZIP larger than the feed says: cut at the signed size, refused', async () => {
  const h = harness({ zip: 'zip-bytes-and-more', feed: { size: 9 } });
  h.updater.init();
  expect((await h.updater.check({ manual: true })).phase).toMatchObject({ kind: 'error', error: 'integrity' });
  expect(existsSync(h.staged)).toBe(false);
});

test('a broken code signature or another signing identity: refused, nothing staged', async () => {
  const broken = harness({ codesign: { strict: false } });
  broken.updater.init();
  expect((await broken.updater.check({ manual: true })).phase).toMatchObject({ kind: 'error', error: 'integrity' });
  expect(existsSync(broken.staged)).toBe(false);
  const other = harness({ codesign: { requirement: false } });
  other.updater.init();
  expect((await other.updater.check({ manual: true })).phase).toMatchObject({ kind: 'error', error: 'identity' });
  expect(existsSync(other.staged)).toBe(false);
  expect(readdirSync(join(other.home, 'updates')).sort()).toEqual(['state.json']);
});

test('the running app has no certificate identity (ad-hoc): nothing to verify against, not downloaded', async () => {
  const h = harness({ ownRequirement: null });
  h.updater.init();
  expect((await h.updater.check({ manual: true })).phase).toMatchObject({ kind: 'error', error: 'unsigned-app' });
  expect(h.requests.some((u) => u.endsWith('.zip'))).toBe(false);
});

test('a release that needs an atelierd restart (protocol or spawn-helper): offered by hand, never downloaded', async () => {
  for (const feed of [{ protocol: 2 }, { spawnHelper: sha256('helper-v2') }]) {
    const h = harness({ feed });
    h.updater.init();
    expect((await h.updater.check({ manual: true })).phase).toEqual({ kind: 'needs-restart', version: '0.2.0', notes: '- New things' });
    expect(h.updater.releasePage()).toBe('https://page.test/v0.2.0');
    expect(h.requests.some((u) => u.endsWith('.zip'))).toBe(false);
  }
  // The feed said compatible but the bundle is not: the bundle wins.
  const h = harness({ newApp: { helper: 'helper-v2' } });
  h.updater.init();
  expect((await h.updater.check({ manual: true })).phase.kind).toBe('needs-restart');
  expect(existsSync(h.staged)).toBe(false);
});

test('the bundle must be the version the feed names', async () => {
  const h = harness({ newApp: { version: '0.1.5' } });
  h.updater.init();
  expect((await h.updater.check({ manual: true })).phase).toMatchObject({ kind: 'error', error: 'integrity' });
  expect(existsSync(h.staged)).toBe(false);
});

test('channels: a stable user is never given a beta feed, a beta user gets the newest of both', async () => {
  const mislabeled = harness({ feed: { channel: 'beta' } });
  mislabeled.updater.init();
  expect((await mislabeled.updater.check({ manual: true })).phase).toMatchObject({ kind: 'error', error: 'feed' });
  const beta = harness({ buildChannel: 'beta', feed: { version: '0.2.0-beta.2', channel: 'beta', path: 'Atelier-0.2.0-beta.2-arm64.zip' }, newApp: { version: '0.2.0-beta.2' },
    releases: [{ tag_name: 'v0.1.1', draft: false, prerelease: false }, { tag_name: 'v0.2.0-beta.2', draft: false, prerelease: true }] });
  beta.updater.init();
  expect((await beta.updater.check({ manual: true })).phase).toMatchObject({ kind: 'ready', version: '0.2.0-beta.2' });
});

test('a feed for another version than its release tag is refused', async () => {
  const h = harness({ releases: [{ tag_name: 'v0.2.0', draft: false, prerelease: false }], feed: { version: '0.3.0' } });
  h.updater.init();
  // The yml lives under the tag the list named.
  expect((await h.updater.check({ manual: true })).phase.kind).toBe('error');
});

test('GitHub rate limit and network failures are quiet errors', async () => {
  const h = harness({ status: { 'https://api.test/releases': 403 } });
  h.updater.init();
  expect((await h.updater.check({ manual: false })).phase).toMatchObject({ kind: 'error', error: 'rate-limited' });
  const n = harness({ status: { 'https://api.test/releases': 500 } });
  n.updater.init();
  expect((await n.updater.check({ manual: false })).phase).toMatchObject({ kind: 'error', error: 'network' });
});

test('an app that cannot replace itself: nothing downloaded, a "location" state until it is moved', async () => {
  let where: 'translocated' | null = 'translocated';
  const h = harness({ appLocation: () => where });
  h.updater.init();
  expect((await h.updater.check({ manual: false })).phase).toEqual({ kind: 'location', version: '0.2.0', problem: 'translocated' });
  expect(h.requests.some((u) => u.endsWith('.zip'))).toBe(false);
  expect(existsSync(join(h.home, 'updates/download'))).toBe(false);
  expect(h.logs.join('\n')).toMatch(/translocated/);
  // Moved to Applications: the next check installs it.
  where = null;
  expect((await h.updater.check({ manual: false })).phase.kind).toBe('ready');
});

test('a release with a missing or unavailable file (HTTP 404/5xx on an asset): "incomplete", not a connection problem', async () => {
  for (const asset of ['latest-mac.yml', 'latest-mac.yml.sig', 'Atelier-0.2.0-arm64.zip']) {
    for (const code of [404, 502]) {
      const h = harness({ status: { [`https://dl.test/v0.2.0/${asset}`]: code } });
      h.updater.init();
      expect((await h.updater.check({ manual: true })).phase, `${asset} ${code}`).toMatchObject({ kind: 'error', error: 'incomplete', version: '0.2.0' });
      expect(existsSync(h.staged)).toBe(false);
      // The release page is one click away.
      expect(h.updater.releasePage()).toBe('https://page.test/releases');
    }
  }
  // Not for the release list itself: that is GitHub being unreachable.
  const list = harness({ status: { 'https://api.test/releases': 404 } });
  list.updater.init();
  expect((await list.updater.check({ manual: true })).phase).toMatchObject({ kind: 'error', error: 'network' });
});

test('the release page: the release of an update to install by hand, otherwise the releases list', async () => {
  const h = harness();
  h.updater.init();
  expect(h.updater.releasePage()).toBe('https://page.test/releases');
  const r = harness({ feed: { protocol: 2 } });
  r.updater.init();
  await r.updater.check({ manual: true });
  expect(r.updater.releasePage()).toBe('https://page.test/v0.2.0');
});

test('a minimum macOS above this one: not installed', async () => {
  const h = harness({ feed: { minimumSystemVersion: '99.0' } });
  h.updater.init();
  expect((await h.updater.check({ manual: true })).phase).toMatchObject({ kind: 'error', error: 'system' });
});

test('one check at a time', async () => {
  const h = harness();
  h.updater.init();
  const [a, b] = await Promise.all([h.updater.check({ manual: true }), h.updater.check({ manual: true })]);
  expect(a.phase.kind).toBe('ready');
  expect(b.phase.kind).toBe('ready');
  expect(h.requests.filter((u) => u === 'https://api.test/releases')).toHaveLength(1);
});

test('after the restart: "What\'s new" once with the staged notes; a staged update survives a relaunch', async () => {
  const h = harness();
  h.updater.init();
  await h.updater.check({ manual: true });
  expect(h.updater.takeWhatsNew()).toBeNull();
  // Relaunch before restarting: still ready.
  const again = new AutoUpdater({ ...(h.updater as unknown as { o: AutoUpdateDeps }).o });
  again.init();
  expect(again.status().phase).toEqual({ kind: 'ready', version: '0.2.0', notes: '- New things' });
  // Relaunch on 0.2.0 (the swap happened).
  const after = new AutoUpdater({ ...(h.updater as unknown as { o: AutoUpdateDeps }).o, version: '0.2.0' });
  after.init();
  // The version of the launch before this one (the rollback copy is dropped once it equals the running version).
  expect(after.lastRunVersion()).toBe('0.1.0');
  // With the version it came from: the sheet shows every release in between.
  expect(after.takeWhatsNew()).toEqual({ version: '0.2.0', notes: '- New things', since: '0.1.0' });
  expect(after.takeWhatsNew()).toBeNull();
  expect(after.status().currentNotes).toBe('- New things');
  expect(after.status().phase.kind).toBe('idle');
  const later = new AutoUpdater({ ...(h.updater as unknown as { o: AutoUpdateDeps }).o, version: '0.2.0' });
  later.init();
  expect(later.lastRunVersion()).toBe('0.2.0');
  expect(later.takeWhatsNew()).toBeNull();
});

test('the build channel comes from the stamp CI bakes into release builds; none otherwise', () => {
  const dir = mkdtempSync(join(tmpdir(), 'atl-au-ch-'));
  const app = fixtureApp(join(dir, 'Atelier.app'), { version: '0.2.0', builtAt: 1 });
  expect(buildChannelOf(app)).toBeNull();
  writeFileSync(join(app, 'Contents/Resources/atelier-build.json'), JSON.stringify({ protocol: 1, builtAt: 1, channel: 'beta' }));
  expect(buildChannelOf(app)).toBe('beta');
  writeFileSync(join(app, 'Contents/Resources/atelier-build.json'), JSON.stringify({ protocol: 1, builtAt: 1, channel: 'nightly' }));
  expect(buildChannelOf(app)).toBeNull();
  expect(buildChannelOf(null)).toBeNull();
});

test('the tests\' updater flag: a local feed, a fixture app, its identity and a test key, or nothing', () => {
  const ok = { feed: 'http://127.0.0.1:4000', app: '/tmp/x/Atelier.app', requirement: 'cdhash H"ab"', publicKey: Buffer.alloc(32).toString('base64'), channel: 'beta' };
  expect(parseTestUpdate(JSON.stringify(ok))).toEqual(ok);
  expect(parseTestUpdate(undefined)).toBeNull();
  expect(parseTestUpdate('nope')).toBeNull();
  expect(parseTestUpdate(JSON.stringify({ ...ok, feed: 'https://github.com' }))).toBeNull();
  expect(parseTestUpdate(JSON.stringify({ ...ok, app: 'relative/Atelier.app' }))).toBeNull();
  expect(parseTestUpdate(JSON.stringify({ ...ok, extra: 1 }))).toBeNull();
});

test('the production source: every address on useatelier.dev, GitHub only behind it', () => {
  expect(SITE_SOURCE.releasesUrl).toBe('https://useatelier.dev/updates/releases');
  expect(SITE_SOURCE.assetUrl('v0.2.0-beta.1', 'latest-mac.yml')).toBe('https://useatelier.dev/updates/download/v0.2.0-beta.1/latest-mac.yml');
  expect(SITE_SOURCE.pageUrl('v0.2.0')).toBe('https://useatelier.dev/releases/v0.2.0');
  expect(SITE_SOURCE.releasesPage).toBe('https://useatelier.dev/releases');
  for (const u of [SITE_SOURCE.releasesUrl, SITE_SOURCE.assetUrl('v1.0.0', 'x.zip')]) expect(SITE_SOURCE.allow(new URL(u))).toBe(true);
  // The redirect hops to the files on GitHub Releases.
  expect(SITE_SOURCE.allow(new URL('https://github.com/atelieride/atelier/releases/download/v1.0.0/x.zip'))).toBe(true);
  expect(SITE_SOURCE.allow(new URL('https://release-assets.githubusercontent.com/x'))).toBe(true);
  expect(SITE_SOURCE.allow(new URL('https://api.github.com/repos/atelieride/atelier/releases'))).toBe(false);
  expect(SITE_SOURCE.allow(new URL('http://127.0.0.1:4000/x'))).toBe(false);
});

const UP_TO_DATE = [{ tag_name: 'v0.1.0', draft: false, prerelease: false }];
const listCalls = (h: { urls: string[] }) => h.urls.filter((u) => u.startsWith('https://api.test/releases')).map((u) => new URL(u).search);

test('active installs: the first successful check of a UTC day, ISO week and month says so', async () => {
  let now = Date.UTC(2026, 9, 14, 10); // Wednesday
  const h = harness({ releases: UP_TO_DATE, now: () => now });
  h.updater.init();
  await h.updater.check({ manual: false });
  await h.updater.check({ manual: true });
  now = Date.UTC(2026, 9, 15, 0, 5); // next day
  await h.updater.check({ manual: false });
  now = Date.UTC(2026, 9, 19, 9); // Monday: a new ISO week
  await h.updater.check({ manual: false });
  now = Date.UTC(2026, 9, 31, 9); // Saturday of the next week
  await h.updater.check({ manual: false });
  now = Date.UTC(2026, 10, 1, 9); // Sunday 1 November: same ISO week, new month
  await h.updater.check({ manual: false });
  now = Date.UTC(2026, 9, 20, 9); // the clock went back
  await h.updater.check({ manual: false });
  expect(listCalls(h)).toEqual(['?a=dwm', '?a=', '?a=d', '?a=dw', '?a=dw', '?a=dm', '?a=dwm']);
});

test('the reported periods survive a relaunch; a failed list fetch reports again next time; a corrupt state starts over', async () => {
  const now = () => Date.UTC(2026, 9, 14, 10);
  const failing = harness({ releases: UP_TO_DATE, now, status: { 'https://api.test/releases': 500 } });
  failing.updater.init();
  await failing.updater.check({ manual: false });
  await failing.updater.check({ manual: true });
  expect(listCalls(failing)).toEqual(['?a=dwm', '?a=dwm']);
  const h = harness({ releases: UP_TO_DATE, now });
  h.updater.init();
  await h.updater.check({ manual: false });
  const again = new AutoUpdater(h.deps);
  again.init();
  await again.check({ manual: false });
  expect(listCalls(h)).toEqual(['?a=dwm', '?a=']);
  expect(JSON.parse(readFileSync(join(h.home, 'updates/state.json'), 'utf8')).reported).toEqual({ d: '2026-10-14', w: '2026-W42', m: '2026-10' });
  writeFileSync(join(h.home, 'updates/state.json'), '{"reported": "nonsense"');
  const fresh = new AutoUpdater(h.deps);
  fresh.init();
  await fresh.check({ manual: false });
  expect(listCalls(h).at(-1)).toBe('?a=dwm');
});

test('channel off: no check, so nothing is sent at all', async () => {
  const h = harness({ setting: 'off' });
  h.updater.init();
  await h.updater.check({ manual: true });
  expect(h.urls).toEqual([]);
});
