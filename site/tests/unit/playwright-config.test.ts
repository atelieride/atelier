import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import config from '../../playwright.config';

// e2e builds leave the beacon out (SITE_NO_BEACON=1), but a run against a production build must not report visits
// either: Chromium cannot resolve the beacon's host.
test('e2e browsers never reach Cloudflare Web Analytics', () => {
  const chromium = config.projects?.find((p) => p.name === 'chromium');
  expect(chromium?.use?.launchOptions?.args).toContain('--host-resolver-rules=MAP static.cloudflareinsights.com ~NOTFOUND, MAP cloudflareinsights.com ~NOTFOUND');
  // By default every project is Chromium (WebKit and Firefox come with E2E_BROWSERS=1 only).
  expect(config.projects?.map((p) => p.name)).toEqual(['chromium']);
});

// macOS 27: headless Chromium's GPU process exits when a page draws at devicePixelRatio 2 (the config's comment). The
// perf check's own browsers, Playwright's and Lighthouse's, keep the GPU work in the browser process too.
test('the perf check starts both of its browsers with --in-process-gpu, as the e2e do', () => {
  const perf = readFileSync(new URL('../../scripts/perf-check.mjs', import.meta.url), 'utf8');
  const chromium = config.projects?.find((p) => p.name === 'chromium');
  expect(chromium?.use?.launchOptions?.args).toContain('--in-process-gpu');
  expect(perf).toMatch(/chromium\.launch\(\{[^}]*args: \['--in-process-gpu'\]/);
  expect(perf).toMatch(/chromeFlags: \[[^\]]*'--in-process-gpu'/);
});

test('WebKit and Firefox take no host rules: the scripts that run them always build without the beacon', () => {
  const scripts = (JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { scripts: Record<string, string> }).scripts;
  const browsers = Object.entries(scripts).filter(([, s]) => s.includes('E2E_BROWSERS='));
  expect(browsers.map(([k]) => k).sort()).toEqual(['e2e:browsers', 'e2e:firefox']);
  for (const [name, s] of browsers) expect(s, name).toMatch(/^SITE_NO_BEACON=1 npm run build && /);
});

// Visual checks that only write screenshots to look at (no assertion of their own, fixed waits) stay out of
// `npm run e2e`: the manual config runs them (npm run shots:demo), against the same built site and server.
test('the live demo\'s screenshot-only checks run from the manual config, never in npm run e2e', async () => {
  const { existsSync } = await import('node:fs');
  const manual = (await import('../../playwright.manual.config')).default;
  const at = (p: string) => new URL(`../../${p}`, import.meta.url);
  expect(existsSync(at('tests/e2e/live-demo-visual.spec.ts'))).toBe(false);
  expect(existsSync(at('tests/e2e/live-demo-visual.manual.ts'))).toBe(true);
  expect(config.testMatch ?? '**/*.@(spec|test).?(c|m)[jt]s?(x)').not.toMatch(/manual/);
  expect(manual.testMatch).toEqual(['**/*.manual.ts']);
  expect(manual.webServer).toEqual(config.webServer);
  expect(manual.projects?.map((p) => p.name)).toEqual(['chromium']);
  expect(manual.projects?.[0]?.use?.launchOptions?.args).toEqual(config.projects?.[0]?.use?.launchOptions?.args);
  const scripts = (JSON.parse(readFileSync(at('package.json'), 'utf8')) as { scripts: Record<string, string> }).scripts;
  expect(scripts['shots:demo']).toBe('SITE_NO_BEACON=1 npm run build && PLAYWRIGHT_BROWSERS_PATH=0 playwright test --config playwright.manual.config.ts');
});
