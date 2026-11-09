import { defineConfig, devices } from '@playwright/test';

// Runs against the built site (npm run e2e builds first); the run works inside its own temp root. Astro 7 moves the
// preview server to the background when it detects a coding agent; --ignore-lock keeps it in the foreground, where
// Playwright starts and stops it. e2e builds have no analytics beacon (SITE_NO_BEACON=1); should a run meet one anyway,
// Chromium cannot resolve its hosts, so tests never report visits.
// E2E_BROWSERS=1 adds WebKit (≈ Safari: npm run e2e:browsers) and Firefox (npm run e2e:firefox) for the live demo's
// browser e2e (live-demo-real, live-demo-browsers): the demo is where browsers differ most (keys in an iframe,
// postMessage, full screen, WebGL, workers). Off by default, so `npm run e2e` stays a Chromium run; the browsers live in
// node_modules like Chromium (npm run e2e:install:browsers). Playwright 1.64's Firefox (157) does not start on macOS
// 27.0.1 ("Could not find profile folder.", the same outside any sandbox and with the binary run by hand), so
// e2e:browsers is WebKit only until a Playwright update brings a Firefox that does.
// --in-process-gpu: on macOS 27, headless Chromium 156's GPU process exits (code 5) when a page draws with WebGL or at
// devicePixelRatio 2 (the live demo, the retina shots); after six restarts the browser aborts and every open page fails.
// --disable-gpu and SwiftShader crash the same way; GPU work inside the browser process does not.
const desktop = (name: 'Desktop Safari' | 'Desktop Firefox') => ({ ...devices[name], viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
export default defineConfig({
  testDir: 'tests/e2e',
  outputDir: 'test-results',
  globalSetup: '../tests/support/global-temp-root.ts',
  workers: 2,
  use: { baseURL: 'http://127.0.0.1:4329' },
  projects: [
    {
      name: 'chromium',
      use: {
        browserName: 'chromium',
        launchOptions: { args: ['--in-process-gpu', '--host-resolver-rules=MAP static.cloudflareinsights.com ~NOTFOUND, MAP cloudflareinsights.com ~NOTFOUND'] }
      }
    },
    ...(process.env.E2E_BROWSERS ? [
      { name: 'webkit', testMatch: /live-demo-(real|browsers)\.spec\.ts/, use: desktop('Desktop Safari') },
      { name: 'firefox', testMatch: /live-demo-(real|browsers)\.spec\.ts/, use: desktop('Desktop Firefox') }
    ] : [])
  ],
  webServer: { command: 'ASTRO_TELEMETRY_DISABLED=1 npx astro preview --port 4329 --host 127.0.0.1 --ignore-lock', url: 'http://127.0.0.1:4329', reuseExistingServer: false, timeout: 60000 }
});
