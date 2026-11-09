import { expect, test } from 'vitest';
import { DEMO_SOURCE, demoEntry, demoMessage, isDemoManifest, isDemoToPage, isPageToDemo, keyFromEvent } from '../../../src/demo/protocol';

// Cloudflare Pages and astro preview serve the folder (and redirect index.html to it, a round trip); astro dev only
// serves files from public/, so in development the iframe names the file.
test('the demo entry: the folder when built, its index.html in astro dev', () => {
  expect(demoEntry(false)).toBe('/demo-app/');
  expect(demoEntry(true)).toBe('/demo-app/index.html');
});

// The postMessage protocol between the website and the demo it frames, shared by both sides.
const m = (o: Record<string, unknown>) => ({ source: DEMO_SOURCE, ...o });
const key = { key: 'k', code: 'KeyK', metaKey: true, ctrlKey: false, altKey: false, shiftKey: false, repeat: false };

test('demo → page: every message the demo sends is recognised', () => {
  for (const ok of [m({ type: 'ready' }), m({ type: 'exit' }), m({ type: 'fullscreen' }), m({ type: 'failed', reason: 'bridge threw' }), m({ type: 'checklist', done: 3, total: 8 })]) {
    expect(isDemoToPage(ok), JSON.stringify(ok)).toBe(true);
    expect(isPageToDemo(ok), JSON.stringify(ok)).toBe(false);
  }
});

test('page → demo: every message the page sends is recognised', () => {
  for (const ok of [m({ type: 'focus' }), m({ type: 'pause' }), m({ type: 'resume' }), m({ type: 'key', key }), m({ type: 'open', view: 'view-docker' }), m({ type: 'open', view: 'new-terminal-profile:zsh' }), m({ type: 'open', view: 'demo:editor' })]) {
    expect(isPageToDemo(ok), JSON.stringify(ok)).toBe(true);
    expect(isDemoToPage(ok), JSON.stringify(ok)).toBe(false);
  }
});

test('anything else is refused: other sources, unknown types, extra or missing fields, wrong types', () => {
  const bad: unknown[] = [
    null, undefined, 'ready', 42, [], { type: 'ready' }, { source: 'other', type: 'ready' }, m({ type: 'nope' }), m({}),
    m({ type: 'ready', extra: 1 }), m({ type: 'failed' }), m({ type: 'failed', reason: 3 }), m({ type: 'failed', reason: 'x'.repeat(501) }),
    m({ type: 'checklist', done: 9, total: 8 }), m({ type: 'checklist', done: -1, total: 8 }), m({ type: 'checklist', done: 1.5, total: 8 }),
    m({ type: 'checklist', done: 1 }), m({ type: 'checklist', done: 1, total: 1000 }),
    m({ type: 'key' }), m({ type: 'key', key: { ...key, metaKey: 'yes' } }), m({ type: 'key', key: { ...key, key: '' } }),
    m({ type: 'key', key: { ...key, extra: true } }), m({ type: 'key', key: { ...key, code: 'x'.repeat(40) } }),
    m({ type: 'open', view: 'View Docker' }), m({ type: 'open', view: '' }), m({ type: 'open', view: `view-${'x'.repeat(64)}` }), m({ type: 'open' })
  ];
  for (const b of bad) {
    expect(isDemoToPage(b), JSON.stringify(b)).toBe(false);
    expect(isPageToDemo(b), JSON.stringify(b)).toBe(false);
  }
});

test('demoMessage stamps the source; keyFromEvent copies exactly the fields a re-dispatch needs', () => {
  expect(demoMessage({ type: 'exit' })).toEqual({ source: 'atelier-demo', type: 'exit' });
  const e = { ...key, target: {}, isComposing: false, location: 0, preventDefault() {} };
  const k = keyFromEvent(e);
  expect(k).toEqual(key);
  expect(isPageToDemo(demoMessage({ type: 'key', key: k }))).toBe(true);
});

test('the demo build\'s manifest: an entry and the first-paint files, as safe paths under /demo-app/', () => {
  expect(isDemoManifest({ entry: 'assets/index-a1.js', firstPaint: ['assets/index-b2.css', 'assets/vendor-c3.js'] })).toBe(true);
  expect(isDemoManifest({ entry: 'assets/index.js', firstPaint: [], version: '0.3.0' })).toBe(true); // extra keys: the build may add some
  for (const bad of [null, {}, { entry: 'a.js' }, { entry: '', firstPaint: [] }, { entry: '/abs.js', firstPaint: [] }, { entry: '../up.js', firstPaint: [] },
    { entry: 'https://evil.example/x.js', firstPaint: [] }, { entry: 'a.js', firstPaint: ['ok.js', 'a/../../b.js'] }, { entry: 'a.js', firstPaint: [3] },
    { entry: 'a.js', firstPaint: 'b.js' }, { entry: 'a\\b.js', firstPaint: [] }]) {
    expect(isDemoManifest(bad), JSON.stringify(bad)).toBe(false);
  }
});
