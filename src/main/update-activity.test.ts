import { expect, test } from 'vitest';
import { SITE_SOURCE } from './auto-update';
import { activityParam, parseReported, periodKeys, withActivity } from './update-activity';
import { requestHeaders } from './update-download';

// Active installs without an identifier.

test('UTC day, ISO week (Monday first, the Thursday\'s year) and month', () => {
  expect(periodKeys(Date.UTC(2026, 9, 14, 10))).toEqual({ d: '2026-10-14', w: '2026-W42', m: '2026-10' });
  expect(periodKeys(Date.UTC(2026, 9, 18, 23, 59))).toMatchObject({ w: '2026-W42' }); // Sunday
  expect(periodKeys(Date.UTC(2026, 9, 19, 0, 0))).toMatchObject({ w: '2026-W43' }); // Monday
  expect(periodKeys(Date.UTC(2021, 0, 3))).toEqual({ d: '2021-01-03', w: '2020-W53', m: '2021-01' });
  expect(periodKeys(Date.UTC(2024, 11, 30))).toEqual({ d: '2024-12-30', w: '2025-W01', m: '2024-12' });
  expect(periodKeys(Date.UTC(2026, 0, 1))).toMatchObject({ w: '2026-W01' });
  expect(periodKeys(1000)).toEqual({ d: '1970-01-01', w: '1970-W01', m: '1970-01' });
});

test('the flags: periods not reported yet, always in d, w, m order', () => {
  const now = { d: '2026-10-14', w: '2026-W42', m: '2026-10' };
  expect(activityParam(now, {})).toBe('dwm');
  expect(activityParam(now, now)).toBe('');
  expect(activityParam(now, { d: '2026-10-13', w: '2026-W42', m: '2026-10' })).toBe('d');
  expect(activityParam(now, { d: '2026-10-11', w: '2026-W41', m: '2026-10' })).toBe('dw');
  // A clock that went back: a different key, reported again.
  expect(activityParam(now, { d: '2026-10-20', w: '2026-W43', m: '2026-10' })).toBe('dw');
});

test('the saved keys: strings only, short, anything else forgotten', () => {
  expect(parseReported({ d: '2026-10-14', w: '2026-W42', m: '2026-10' })).toEqual({ d: '2026-10-14', w: '2026-W42', m: '2026-10' });
  expect(parseReported({ d: 5, w: 'x'.repeat(11), m: '2026-10', other: 'y' })).toEqual({ m: '2026-10' });
  for (const bad of [null, undefined, 'dwm', 3, []]) expect(parseReported(bad)).toEqual({});
});

test('the release list URL with the flags still passes the updater\'s checks', () => {
  const url = withActivity(SITE_SOURCE.releasesUrl, 'dwm');
  expect(url).toBe('https://useatelier.dev/updates/releases?a=dwm');
  expect(withActivity(SITE_SOURCE.releasesUrl, '')).toBe('https://useatelier.dev/updates/releases?a=');
  expect(SITE_SOURCE.allow(new URL(url))).toBe(true);
  expect(requestHeaders(url, 'Atelier/1.0 (macOS)')).toMatchObject({ Accept: 'application/json' });
});
