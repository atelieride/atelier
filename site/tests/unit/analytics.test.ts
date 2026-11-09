import { expect, test } from 'vitest';
import { BEACON_SRC, beaconTag } from '../../src/lib/analytics';

// Cloudflare Web Analytics.
const token = '0123456789abcdef0123456789abcdef';

test('the beacon: one deferred script from Cloudflare with the site token', () => {
  expect(BEACON_SRC).toBe('https://static.cloudflareinsights.com/beacon.min.js');
  expect(beaconTag(token, true)).toBe(`<script defer src="${BEACON_SRC}" data-cf-beacon='{"token":"${token}"}'></script>`);
});

test('opening the live demo counts as a page view of /demo: the beacon\'s SPA tracking (on by default) stays on', () => {
  // The stage moves the URL to /demo with history.pushState (scripts/live-demo-stage.ts); the beacon follows pushState
  // and popstate unless data-cf-beacon says "spa": false (developers.cloudflare.com/web-analytics/get-started/web-analytics-spa/).
  const config = /data-cf-beacon='([^']*)'/.exec(beaconTag(token, true))![1]!;
  expect(JSON.parse(config)).toEqual({ token });
  expect(JSON.parse(config).spa).not.toBe(false);
});

test('no token, or a build that opts out (dev, e2e): no beacon', () => {
  expect(beaconTag(null, true)).toBe('');
  expect(beaconTag(token, false)).toBe('');
});

test('a token that is not 32 hex characters stops the build instead of breaking the markup', () => {
  expect(() => beaconTag("x' onload='alert(1)", true)).toThrow(/token/);
});
