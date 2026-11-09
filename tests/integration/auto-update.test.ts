// The in-app updater end to end, without the network: a local server on 127.0.0.1 lays out a release like GitHub
// (API list, signed feed, ZIP behind a redirect), real ditto and real codesign on a tiny ad-hoc signed app. The running
// app's identity is injected as the fixture's own requirement (an ad-hoc cdhash, which the production reader refuses
// by design): the codesign checks themselves run for real.
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { AutoUpdater, localSource, type AutoUpdateDeps } from '../../src/main/auto-update';
import { UpdateWatcher } from '../../src/main/updates';
import type { UpdateStatus } from '../../src/shared/update-feed';
import { adhocRequirement, makeApp, makeRelease, nodeOpener, releaseRoutes, serve, testKey, type Route } from '../fixtures/update-fixture';

const servers: { close(): void }[] = [];
afterEach(() => { for (const s of servers.splice(0)) s.close(); });

const run = (cmd: string, args: string[]) => new Promise<string>((resolve, reject) => {
  execFile(cmd, args, { timeout: 60_000 }, (err, stdout, stderr) => (err ? reject(new Error(`${err.message} ${stderr}`)) : resolve(`${stdout}${stderr}`)));
});

async function setup(o: { routes?: (r: ReturnType<typeof releaseRoutes>, rel: ReturnType<typeof makeRelease>, dir: string) => Record<string, Route>; requirementOf?: 'next' | 'other'; nextApp?: { helper?: string; modify?: boolean } } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'atl-au-int-'));
  const home = join(dir, 'home');
  mkdirSync(home);
  const own = makeApp(join(dir, 'own'), { version: '0.1.0', builtAt: 1, sign: false });
  const next = makeApp(join(dir, 'next'), { version: '0.2.0', builtAt: 2, helper: o.nextApp?.helper });
  // A signed app changed afterwards: its seal is broken.
  if (o.nextApp?.modify) writeFileSync(join(next, 'Contents/Resources/atelier-build.json'), JSON.stringify({ protocol: 1, builtAt: 3 }));
  const other = makeApp(join(dir, 'other'), { version: '0.2.0', builtAt: 5 });
  const key = testKey();
  const rel = makeRelease({ version: '0.2.0', app: next, dir, key: key.privateKey });
  const base = releaseRoutes(rel);
  const srv = await serve(o.routes ? o.routes(base, rel, dir) : base);
  servers.push(srv.server);
  const requirement = adhocRequirement(o.requirementOf === 'other' ? other : next);
  const statuses: UpdateStatus[] = [];
  const logs: string[] = [];
  const deps: AutoUpdateDeps = {
    home, version: '0.1.0', protocol: 1, appPath: own, buildChannel: 'stable', channelSetting: () => 'auto', available: true,
    source: localSource(srv.base)!, publicKeys: [key.publicKey], open: nodeOpener, exec: run, ownRequirement: async () => requirement,
    systemVersion: '26.0', appLocation: () => null, log: (m) => logs.push(m), onStatus: (s) => statuses.push(s)
  };
  const updater = new AutoUpdater(deps);
  updater.init();
  return { updater, home, own, staged: join(home, 'updates/Atelier.app'), hits: srv.hits, statuses, logs, rel, base: srv.base, requirement };
}

test('a signed release from the local feed is downloaded, verified and staged: the footer\'s "Update ready" takes it from there', async () => {
  const h = await setup();
  const s = await h.updater.check({ manual: true });
  expect(s.phase).toEqual({ kind: 'ready', version: '0.2.0', notes: '- Faster everything' });
  // The ZIP came through the redirect to the "CDN".
  expect(h.hits).toContain(`/cdn/${h.rel.zipName}?token=x`);
  expect(h.statuses.some((x) => x.phase.kind === 'downloading' && x.phase.received === h.rel.zip.length)).toBe(true);
  // The staged bundle is intact and has the identity the running app expects.
  await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--test-requirement', `=${h.requirement}`, h.staged]);
  expect(readdirSync(join(h.home, 'updates')).sort()).toEqual(['Atelier.app', 'state.json', 'update.json']);
  // Exactly the state `npm run stage-update` leaves: UpdateWatcher (with a certificate identity) offers it.
  const watcher = new UpdateWatcher({
    appPath: h.own, stagedPath: h.staged, protocol: 1, exec: async () => 'designated => identifier "x" and certificate root = H"1"\n',
    spawnHelper: () => {}, quit: () => {}, canWrite: () => true
  });
  await watcher.init();
  expect(watcher.ready()).toBe(true);
});

test('a feed changed after signing is rejected: nothing downloaded, nothing staged', async () => {
  const h = await setup({ routes: (r, rel) => ({ ...r, [`/updates/download/${rel.tag}/latest-mac.yml`]: rel.yml.replace('Faster', 'Slower') }) });
  expect((await h.updater.check({ manual: true })).phase).toMatchObject({ kind: 'error', error: 'signature' });
  expect(h.hits.some((u) => u.includes('.zip'))).toBe(false);
  expect(existsSync(h.staged)).toBe(false);
  expect(h.logs.join('\n')).toMatch(/signature/);
});

test('a ZIP swapped on the server (same size, other bytes) is rejected before extraction', async () => {
  const h = await setup({ routes: (r, rel) => {
    const zip = Buffer.from(rel.zip);
    zip[zip.length - 30] = zip[zip.length - 30]! ^ 0xff;
    return { ...r, [`/cdn/${rel.zipName}?token=x`]: zip };
  } });
  expect((await h.updater.check({ manual: true })).phase).toMatchObject({ kind: 'error', error: 'integrity' });
  expect(existsSync(h.staged)).toBe(false);
  expect(existsSync(join(h.home, 'updates/download'))).toBe(false);
});

test('an app whose code signature is broken, or signed by someone else, is never staged', async () => {
  const broken = await setup({ nextApp: { modify: true } });
  expect((await broken.updater.check({ manual: true })).phase).toMatchObject({ kind: 'error', error: 'integrity' });
  expect(existsSync(broken.staged)).toBe(false);
  const stranger = await setup({ requirementOf: 'other' });
  expect((await stranger.updater.check({ manual: true })).phase).toMatchObject({ kind: 'error', error: 'identity' });
  expect(existsSync(stranger.staged)).toBe(false);
});

test('a redirect to a host outside the allowed ones is not followed', async () => {
  const h = await setup({ routes: (r, rel) => ({ ...r, [`/updates/download/${rel.tag}/${rel.zipName}`]: { redirect: 'http://localhost:1/evil.zip' } }) });
  expect((await h.updater.check({ manual: true })).phase).toMatchObject({ kind: 'error', error: 'network' });
  expect(h.logs.join('\n')).toMatch(/not allowed/);
  expect(existsSync(h.staged)).toBe(false);
});

test('a bundle with another spawn-helper than the feed declared: the gate stops it, offered by hand', async () => {
  const h = await setup({ nextApp: { helper: 'helper-v2' } });
  expect((await h.updater.check({ manual: true })).phase.kind).toBe('needs-restart');
  expect(existsSync(h.staged)).toBe(false);
  expect(h.updater.releasePage()).toBe(`${h.base}/releases/v0.2.0`);
});

test('the local source only accepts 127.0.0.1 over http with a port', () => {
  expect(localSource('http://127.0.0.1:4000')).not.toBeNull();
  expect(localSource('http://localhost:4000')).toBeNull();
  expect(localSource('https://github.com')).toBeNull();
  expect(localSource('http://127.0.0.1')).toBeNull();
  const s = localSource('http://127.0.0.1:4000')!;
  // The layout of useatelier.dev.
  expect(s.releasesUrl).toBe('http://127.0.0.1:4000/updates/releases');
  expect(s.assetUrl('v1.0.0', 'latest-mac.yml')).toBe('http://127.0.0.1:4000/updates/download/v1.0.0/latest-mac.yml');
  expect(s.releasesPage).toBe('http://127.0.0.1:4000/releases');
  expect(s.allow(new URL('http://127.0.0.1:4000/x'))).toBe(true);
  expect(s.allow(new URL('http://127.0.0.1:4001/x'))).toBe(false);
});
