import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { expect, test } from 'vitest';

// The Pages Functions: thin route files, all answered by
// src/lib/update-endpoints.ts (tested in update-endpoints.test.ts), and a bundle wrangler can build.
const site = join(__dirname, '../..');
const dir = join(site, 'functions');

const ROUTES: Record<string, string> = {
  'updates/releases.ts': '/updates/releases',
  'updates/download/[tag]/[name].ts': '/updates/download/:tag/:name',
  'download/mac/index.ts': '/download/mac',
  'download/mac/beta.ts': '/download/mac/beta',
  'download/windows.ts': '/download/windows',
  'releases/index.ts': '/releases',
  'releases/[tag].ts': '/releases/:tag'
};

function files(d: string): string[] {
  return readdirSync(d).flatMap((n) => (statSync(join(d, n)).isDirectory() ? files(join(d, n)) : [join(d, n)]));
}

test('one route file per endpoint, each handing GET and HEAD to pagesHandler', () => {
  expect(existsSync(dir)).toBe(true);
  expect(files(dir).map((f) => relative(dir, f)).sort()).toEqual(Object.keys(ROUTES).sort());
  for (const f of Object.keys(ROUTES)) {
    const text = readFileSync(join(dir, f), 'utf8');
    expect(text, f).toMatch(/^import \{ pagesHandler \} from '(\.\.\/)+src\/lib\/update-endpoints';$/m);
    expect(text, f).toMatch(/^export const onRequestGet = pagesHandler;$/m);
    expect(text, f).toMatch(/^export const onRequestHead = pagesHandler;$/m);
    expect(text, f).not.toMatch(/onRequest(Post|Put|Patch|Delete)?\b(?!Get|Head)/);
  }
});

test('wrangler.toml binds Analytics Engine (EVENTS → useatelier_events) at the project\'s compatibility date', () => {
  const toml = readFileSync(join(site, 'wrangler.toml'), 'utf8');
  expect(toml).toMatch(/^name = "useatelier"$/m);
  expect(toml).toMatch(/^pages_build_output_dir = "\.\/dist"$/m);
  expect(toml).toMatch(/^compatibility_date = "2026-10-12"$/m);
  expect(toml).toMatch(/\[\[analytics_engine_datasets\]\]\nbinding = "EVENTS"\ndataset = "useatelier_events"/);
  // Secrets never live in the file: GITHUB_TOKEN stays a Pages secret.
  expect(toml).not.toMatch(/GITHUB_TOKEN|\[vars\]/);
});

test('wrangler bundles them, and only these paths go through a function (the rest stays static)', () => {
  const out = mkdtempSync(join(tmpdir(), 'pages-fn-'));
  const routesPath = join(out, '_routes.json');
  execFileSync(join(site, 'node_modules/.bin/wrangler'), ['pages', 'functions', 'build', 'functions', '--outdir', join(out, 'worker'), '--output-routes-path', routesPath], {
    cwd: site,
    stdio: 'pipe',
    // Its own home and logs: nothing read or written in the user's wrangler config.
    env: { ...process.env, HOME: out, XDG_CONFIG_HOME: out, WRANGLER_SEND_METRICS: 'false', WRANGLER_LOG_PATH: join(out, 'logs') }
  });
  expect(readdirSync(join(out, 'worker')).length).toBeGreaterThan(0);
  const routes = JSON.parse(readFileSync(routesPath, 'utf8')) as { include: string[] };
  expect(routes.include.sort()).toEqual(['/download/mac', '/download/mac/beta', '/download/windows', '/releases', '/releases/*', '/updates/download/*', '/updates/releases'].sort());
}, 60_000);
