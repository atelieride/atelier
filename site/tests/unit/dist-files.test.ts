import { expect, test } from 'vitest';
import { distRole } from '../support/dist-files';

// How the build guard (tests/build/guard.test.ts) treats each built file. The demo build (demo-app/)
// is the app's bundle, not a page of the site: no page rules, no site-copy rule, but every secrecy rule.
test('site pages: every rule', () => {
  for (const f of ['index.html', 'demo.html', 'download.html', '404.html']) {
    expect(distRole(f), f).toEqual({ text: true, page: true, demoPage: false, notices: false, anonymous: false });
  }
});

test('site assets: text files get the content rules, binaries none', () => {
  expect(distRole('_astro/Base.abc.css')).toEqual({ text: true, page: false, demoPage: false, notices: false, anonymous: false });
  expect(distRole('sitemap.xml')).toEqual({ text: true, page: false, demoPage: false, notices: false, anonymous: false });
  expect(distRole('og.png')).toEqual({ text: false, page: false, demoPage: false, notices: false, anonymous: false });
  // Cloudflare Pages' headers file has no extension: still text, still scanned.
  expect(distRole('_headers')).toEqual({ text: true, page: false, demoPage: false, notices: false, anonymous: false });
});

test('the demo build: checked for anything sensitive, never as a page, and its library notices name their licenses', () => {
  expect(distRole('demo-app/index.html')).toEqual({ text: true, page: false, demoPage: true, notices: false, anonymous: true });
  expect(distRole('demo-app/assets/index-a1.js')).toEqual({ text: true, page: false, demoPage: false, notices: false, anonymous: true });
  // Third-party license notices: their authors' own e-mail addresses (gmail…) are theirs to publish, and the app's own
  // notice names its author; everything else in the demo build is anonymous (the site's footer names the author on
  // purpose).
  expect(distRole('demo-app/licenses.txt')).toEqual({ text: true, page: false, demoPage: false, notices: true, anonymous: false });
  expect(distRole('demo-app/manifest.json')).toEqual({ text: true, page: false, demoPage: false, notices: false, anonymous: true });
  expect(distRole('demo-app/fonts/sans.woff2')).toEqual({ text: false, page: false, demoPage: false, notices: false, anonymous: false });
  // Only the folder itself: a page whose name merely starts the same way is a page.
  expect(distRole('demo-application.html').page).toBe(true);
});
