import { expect, test } from 'vitest';
import { prefetchLinks } from '../../src/lib/demo-prefetch';
import { DEMO_GATE, readyTimeout } from '../../src/lib/live-demo';

test('the gate: wide desktop screens with a real pointer', () => {
  expect(DEMO_GATE).toBe('(min-width: 1100px) and (hover: hover) and (pointer: fine)');
});

test('intent prefetch: the entry, then the first-paint files, under /demo-app/, each fetched the way the demo will use it', () => {
  expect(prefetchLinks({ entry: 'assets/index-a.js', firstPaint: ['assets/index-b.css', 'assets/vendor-c.js', 'assets/index-a.js', 'fonts/sans.woff2', 'assets/logo.svg'] })).toEqual([
    { href: '/demo-app/assets/index-a.js', as: 'script', crossorigin: false },
    { href: '/demo-app/assets/index-b.css', as: 'style', crossorigin: false },
    { href: '/demo-app/assets/vendor-c.js', as: 'script', crossorigin: false },
    // Fonts are always fetched in CORS mode: a prefetch without crossorigin would not be reused.
    { href: '/demo-app/fonts/sans.woff2', as: 'font', crossorigin: true },
    { href: '/demo-app/assets/logo.svg', as: null, crossorigin: false }
  ]);
});

test('the fonts the demo loads before its first frame are prefetched too, as fonts', () => {
  expect(prefetchLinks({ entry: 'assets/index-a.js', firstPaint: ['assets/index-a.js'], fonts: ['assets/sans-1.woff2'] })).toEqual([
    { href: '/demo-app/assets/index-a.js', as: 'script', crossorigin: false },
    { href: '/demo-app/assets/sans-1.woff2', as: 'font', crossorigin: true }
  ]);
});

test('no demo built (no manifest) or a malformed one: nothing to prefetch', () => {
  for (const m of [null, undefined, {}, { entry: '../x.js', firstPaint: [] }, { entry: 'a.js', firstPaint: ['https://evil.example/b.js'] }, { entry: 'a.js', firstPaint: [], fonts: ['../x.woff2'] }, { entry: 'a.js', firstPaint: [], fonts: 'x.woff2' }]) {
    expect(prefetchLinks(m), JSON.stringify(m)).toEqual([]);
  }
});

test('the ready timeout: 10 s unless the page says otherwise (tests shorten it), within sane bounds', () => {
  expect(readyTimeout(undefined)).toBe(10000);
  expect(readyTimeout(null)).toBe(10000);
  expect(readyTimeout('')).toBe(10000);
  expect(readyTimeout('1500')).toBe(1500);
  expect(readyTimeout('nope')).toBe(10000);
  expect(readyTimeout('5')).toBe(100);
  expect(readyTimeout('999999')).toBe(60000);
});
