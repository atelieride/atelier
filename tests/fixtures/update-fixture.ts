// Test-only release fixtures for the in-app updater: a tiny ad-hoc signed Atelier.app, its ZIP (as CI makes it), a
// signed feed (throwaway Ed25519 key made per run) and a local HTTP server on 127.0.0.1 that lays them out like
// GitHub Releases. Nothing here touches the network beyond 127.0.0.1, the user's apps or keychain.
import { execFileSync } from 'node:child_process';
import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { chmodSync, copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, get, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join, resolve } from 'node:path';
import { createGunzip } from 'node:zlib';
import { requestHeaders, type Opener } from '../../src/main/update-download';
import { rawPublicKey } from '../../src/shared/update-sign.node';

const MAKE_FEED = resolve(__dirname, '../../scripts/make-feed.mjs');

/** A bundle with what the updater reads: Info.plist, build stamp, node-pty's spawn-helper; signed ad-hoc if asked. */
export function makeApp(dir: string, o: { version: string; builtAt: number; protocol?: number; helper?: string; sign?: boolean }): string {
  const app = join(dir, 'Atelier.app');
  const helperDir = join(app, `Contents/Resources/app.asar.unpacked/node_modules/node-pty/prebuilds/darwin-${process.arch}`);
  mkdirSync(helperDir, { recursive: true });
  mkdirSync(join(app, 'Contents/MacOS'), { recursive: true });
  writeFileSync(join(helperDir, 'spawn-helper'), o.helper ?? 'helper-v1');
  writeFileSync(join(app, 'Contents/Resources/atelier-build.json'), JSON.stringify({ protocol: o.protocol ?? 1, builtAt: o.builtAt }));
  // A real Mach-O executable, like the real app: a script's signature lives in extended attributes, which `ditto -c -k`
  // doesn't keep on every macOS (the CI runner's macOS 15 dropped them and the staged copy lost its identity).
  copyFileSync('/usr/bin/true', join(app, 'Contents/MacOS/Atelier'));
  chmodSync(join(app, 'Contents/MacOS/Atelier'), 0o755);
  writeFileSync(join(app, 'Contents/Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>app.atelier.updater-test</string>
<key>CFBundleExecutable</key><string>Atelier</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key>
<string>${o.version}</string>
<key>LSMinimumSystemVersion</key><string>12.0</string>
</dict></plist>
`);
  if (o.sign !== false) execFileSync('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'ignore' });
  return app;
}

/** The ad-hoc identity of a bundle as a requirement (`cdhash H"…"`): what the test injects as "the running app's". */
export function adhocRequirement(app: string): string {
  const out = execFileSync('/usr/bin/codesign', ['-d', '-r-', app], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  // The whole expression: a universal binary has one cdhash per architecture (`cdhash H"…" or cdhash H"…"`).
  const m = /designated => (cdhash H"[0-9a-f]+"(?: or cdhash H"[0-9a-f]+")*)\s*$/m.exec(out);
  if (!m) throw new Error(`no cdhash requirement in: ${out}`);
  return m[1]!;
}

export function zipApp(app: string, zip: string): Buffer {
  execFileSync('/usr/bin/ditto', ['-c', '-k', '--keepParent', app, zip]);
  return readFileSync(zip);
}

export interface Release { tag: string; version: string; channel: 'stable' | 'beta'; zipName: string; zip: Buffer; yml: string; sig: string }

export function testKey(): { privateKey: KeyObject; publicKey: string } {
  const k = generateKeyPairSync('ed25519');
  return { privateKey: k.privateKey, publicKey: rawPublicKey(k.publicKey) };
}

/** A release as CI makes it: the ZIP (ditto --keepParent), latest-mac.yml from scripts/make-feed.mjs, its signature. */
export function makeRelease(o: { version: string; app: string; dir: string; key: KeyObject; notes?: string }): Release {
  const channel = o.version.includes('-') ? 'beta' : 'stable';
  const zipName = `Atelier-${o.version}-arm64.zip`;
  const zip = zipApp(o.app, join(o.dir, zipName));
  const changelog = join(o.dir, 'CHANGELOG.md');
  writeFileSync(changelog, `## ${o.version}\n${o.notes ?? '- Faster everything'}\n`);
  const out = join(o.dir, 'latest-mac.yml');
  // The real CI script (run as a process: the e2e runner loads this file as CommonJS).
  execFileSync(process.execPath, [MAKE_FEED, '--zip', join(o.dir, zipName), '--app', o.app, '--version', o.version, '--changelog', changelog, '--out', out], { stdio: 'ignore' });
  const yml = readFileSync(out, 'utf8');
  return { tag: `v${o.version}`, version: o.version, channel, zipName, zip, yml, sig: `${sign(null, Buffer.from(yml), o.key).toString('base64')}\n` };
}

export type Route = Buffer | string | { redirect: string };

/**
 * useatelier.dev's layout on 127.0.0.1: the release list, and assets served directly
 * (small files) or through a redirect to a "CDN" path, like the endpoint → GitHub → release CDN chain.
 */
export function releaseRoutes(rel: Release, o: { yml?: string; zip?: Buffer; zipRedirect?: string } = {}): Record<string, Route> {
  const dl = `/updates/download/${rel.tag}`;
  return {
    '/updates/releases': JSON.stringify([{ tag_name: rel.tag, draft: false, prerelease: rel.channel === 'beta' }]),
    [`${dl}/latest-mac.yml`]: o.yml ?? rel.yml,
    [`${dl}/latest-mac.yml.sig`]: rel.sig,
    [`${dl}/${rel.zipName}`]: { redirect: o.zipRedirect ?? `/cdn/${rel.zipName}?token=x` },
    [`/cdn/${rel.zipName}?token=x`]: o.zip ?? rel.zip
  };
}

export async function serve(routes: Record<string, Route>): Promise<{ base: string; server: Server; hits: string[] }> {
  const hits: string[] = [];
  const server = createServer((req, res) => {
    hits.push(req.url ?? '');
    // Exact first (the CDN route keys its own query), then the path: the release list carries the app's `?a=` flags.
    const r = routes[req.url ?? ''] ?? routes[(req.url ?? '').split('?')[0]!];
    if (r === undefined) { res.writeHead(404).end(); return; }
    if (typeof r === 'object' && !Buffer.isBuffer(r)) { res.writeHead(302, { Location: r.redirect }).end(); return; }
    const body = Buffer.from(r);
    res.writeHead(200, { 'Content-Length': body.length }).end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, server, hits };
}

/**
 * The updater's transport over node:http (the app uses Electron's net): no redirects followed here, the app's request
 * headers, and a gzip body decoded with its headers kept as sent, like Chromium does.
 */
export const nodeOpener: Opener = (url, signal) => new Promise((resolve, reject) => {
  const req = get(url, { signal, headers: requestHeaders(url, 'Atelier-test') }, (res) => {
    const headers: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(res.headers)) headers[k] = Array.isArray(v) ? v.join(', ') : v;
    const body = headers['content-encoding'] === 'gzip' ? res.pipe(createGunzip()) : res;
    resolve({ status: res.statusCode ?? 0, location: res.headers.location ?? null, headers, body, close: () => res.destroy() });
  });
  req.on('error', reject);
});
