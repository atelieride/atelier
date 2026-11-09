import { expect, test } from 'vitest';
import { assetCounts, latestVersions, visitsResult, monthStart, perDay, queries, report, sqlTime, table, webQuery, webWindows, weekStart } from '../../scripts/stats.mjs';

// npm run stats: the pure parts; the network calls run only by hand.

const NOW = new Date('2026-10-21T09:30:00Z'); // a Wednesday

test('ISO weeks start on Monday 00:00 UTC; months on the 1st', () => {
  expect(weekStart(new Date('2026-10-14T10:00:00Z')).toISOString()).toBe('2026-10-12T00:00:00.000Z'); // Wednesday
  expect(weekStart(new Date('2026-10-18T23:59:00Z')).toISOString()).toBe('2026-10-12T00:00:00.000Z'); // Sunday
  expect(weekStart(new Date('2026-10-19T00:00:00Z')).toISOString()).toBe('2026-10-19T00:00:00.000Z'); // Monday
  expect(monthStart(new Date('2026-10-14T10:00:00Z')).toISOString()).toBe('2026-10-01T00:00:00.000Z');
  expect(sqlTime(new Date('2026-10-12T00:00:00Z'))).toBe("toDateTime('2026-10-12 00:00:00')");
});

test('queries: one dataset, bots out of the download counts, actives summed from the flags', () => {
  const q = queries({ now: new Date('2026-10-14T10:00:00Z'), days: 30 });
  for (const sql of Object.values(q) as string[]) {
    expect(sql).toContain('FROM useatelier_events');
    expect(sql).toContain('_sample_interval');
  }
  // Whole UTC days, today included: the per-day rows, the funnel and the --full tables count the same span.
  expect(q.downloadsByDay).toBe("SELECT toStartOfInterval(timestamp, INTERVAL '1' DAY) AS day, blob1 AS channel, SUM(_sample_interval) AS downloads FROM useatelier_events WHERE index1 = 'download' AND blob5 = 'browser' AND timestamp >= toDateTime('2026-09-15 00:00:00') GROUP BY day, channel ORDER BY day DESC");
  for (const name of ['downloadsByChannel', 'downloadsBySource', 'downloadsFromDemo', 'downloadsByCountry', 'bots', 'dailyActive', 'legacy']) {
    expect(q[name as keyof typeof q]).toContain("timestamp >= toDateTime('2026-09-15 00:00:00')");
    expect(q[name as keyof typeof q]).not.toContain('NOW()');
  }
  expect(q.bots).toContain("blob5 = 'bot'");
  expect(q.dailyActive).toContain('SUM(_sample_interval * double2)');
  expect(q.thisWeek).toContain("toDateTime('2026-10-12 00:00:00')");
  expect(q.thisWeek).toContain('double3');
  expect(q.lastWeek).toContain("toDateTime('2026-10-05 00:00:00')");
  expect(q.thisMonth).toContain("toDateTime('2026-10-01 00:00:00')");
  expect(q.thisMonth).toContain('double4');
  expect(q.lastMonth).toContain("toDateTime('2026-09-01 00:00:00')");
  expect(q.legacy).toContain("blob2 = 'legacy'");
  expect(q.downloadsFromDemo).toContain("blob3 = 'demo'");
});

test('the version an install runs comes from the daily flag, never from the first check of the month', () => {
  const q = queries({ now: NOW, days: 30 });
  expect(q.activeByDayVersion).toBe("SELECT toStartOfInterval(timestamp, INTERVAL '1' DAY) AS day, blob1 AS version, SUM(_sample_interval * double2) AS active FROM useatelier_events WHERE index1 = 'check' AND timestamp >= toDateTime('2026-10-15 00:00:00') GROUP BY day, version ORDER BY day DESC");
  expect(q).not.toHaveProperty('activeByVersion');
  expect(latestVersions([
    { day: '2026-10-21 00:00:00', version: '0.2.0-beta.17', active: 0 },
    { day: '2026-10-20 00:00:00', version: '0.2.0-beta.17', active: 1 },
    { day: '2026-10-20 00:00:00', version: '0.2.0-beta.18', active: 2 },
    { day: '2026-10-20 00:00:00', version: 'other', active: 0 },
    { day: '2026-10-19 00:00:00', version: '0.2.0-beta.16', active: 1 }
  ], '2026-10-21')).toEqual({ day: '2026-10-20', versions: [{ version: '0.2.0-beta.18', active: 2 }, { version: '0.2.0-beta.17', active: 1 }] });
  // Today is still partial: yesterday, the last whole day, wins; today only when nothing came before.
  const yesterdayAndToday = [{ day: '2026-10-21 00:00:00', version: '0.2.0-beta.18', active: '1' }, { day: '2026-10-20 00:00:00', version: '0.2.0-beta.17', active: '5' }];
  expect(latestVersions(yesterdayAndToday, '2026-10-21')).toEqual({ day: '2026-10-20', versions: [{ version: '0.2.0-beta.17', active: 5 }] });
  expect(latestVersions(yesterdayAndToday.slice(0, 1), '2026-10-21')).toEqual({ day: '2026-10-21', versions: [{ version: '0.2.0-beta.18', active: 1 }] });
  expect(latestVersions([], '2026-10-21')).toBeNull();
});

test('site visits: 7-day windows (wider ones come back sampled 10×), only useatelier.dev', () => {
  expect(webWindows({ now: NOW, days: 30 })).toEqual([
    { start: '2026-10-15T00:00:00.000Z', end: '2026-10-21T09:30:00.000Z' },
    { start: '2026-10-08T00:00:00.000Z', end: '2026-10-15T00:00:00.000Z' },
    { start: '2026-10-01T00:00:00.000Z', end: '2026-10-08T00:00:00.000Z' },
    { start: '2026-09-24T00:00:00.000Z', end: '2026-10-01T00:00:00.000Z' },
    { start: '2026-09-22T00:00:00.000Z', end: '2026-09-24T00:00:00.000Z' }
  ]);
  expect(webWindows({ now: NOW, days: 1 })).toEqual([{ start: '2026-10-21T00:00:00.000Z', end: '2026-10-21T09:30:00.000Z' }]);
  const q = webQuery();
  expect(q).toContain('rumPageloadEventsAdaptiveGroups');
  expect(q).toContain('requestHost_in: ["useatelier.dev", "www.useatelier.dev"]');
  expect(q).toContain('accountTag: $account');
  expect(q).toContain('dimensions { date requestPath }');
});

test('per day: every day from today back, zeros included, Mac apart from the Store, days before any data left out', () => {
  const rows = perDay({
    now: NOW, days: 30,
    downloads: [
      { day: '2026-10-20 00:00:00', channel: 'beta', downloads: '2' },
      { day: '2026-10-20 00:00:00', channel: 'stable', downloads: '1' },
      { day: '2026-10-20 00:00:00', channel: 'windows', downloads: '4' },
      { day: '2026-10-17 00:00:00', channel: 'beta', downloads: '1' }
    ],
    active: [{ day: '2026-10-19 00:00:00', active: '1' }, { day: '2026-10-17 00:00:00', active: '2' }],
    web: [
      { date: '2026-10-20', path: '/', views: 9, visits: 5 },
      { date: '2026-10-20', path: '/demo', views: 3, visits: 1 },
      { date: '2026-10-16', path: '/', views: 2, visits: 2 }
    ]
  });
  expect(rows).toEqual([
    { day: '2026-10-21', visits: 0, views: 0, mac: 0, store: 0, active: 0 },
    { day: '2026-10-20', visits: 6, views: 12, mac: 3, store: 4, active: 0 },
    { day: '2026-10-19', visits: 0, views: 0, mac: 0, store: 0, active: 1 },
    { day: '2026-10-18', visits: 0, views: 0, mac: 0, store: 0, active: 0 },
    { day: '2026-10-17', visits: 0, views: 0, mac: 1, store: 0, active: 2 },
    { day: '2026-10-16', visits: 2, views: 2, mac: 0, store: 0, active: 0 }
  ]);
});

test('a plain text table, columns padded to the widest cell, numbers to the right', () => {
  expect(table([{ day: '2026-10-14 00:00:00', n: 3 }, { day: '2026-10-13 00:00:00', n: 12 }], ['day', 'n']))
    .toBe('day          n\n2026-10-14   3\n2026-10-13  12');
  expect(table([], ['day'])).toBe('(none)');
  // Analytics Engine sends its sums as strings.
  expect(table([{ country: 'PL', downloads: '11' }, { country: 'US', downloads: '5' }], ['country', 'downloads']))
    .toBe('country  downloads\nPL              11\nUS               5');
});

test('GitHub, per release: DMGs are installs, ZIPs are in-app updates; other assets and malformed input ignored', () => {
  const releases = [
    { tag_name: 'v0.3.0', assets: [{ name: 'Atelier-0.3.0-arm64.dmg', download_count: 12 }, { name: 'Atelier-0.3.0-arm64.zip', download_count: 40 }, { name: 'latest-mac.yml', download_count: 99 }] },
    { tag_name: 'v0.2.0', assets: [] },
    { nope: true }
  ];
  expect(assetCounts(releases)).toEqual([{ version: '0.3.0', dmg: 12, zip: 40 }, { version: '0.2.0', dmg: 0, zip: 0 }]);
  expect(assetCounts({ message: 'rate limited' })).toEqual([]);
});

const DATA = {
  downloadsByDay: [
    { day: '2026-10-20 00:00:00', channel: 'beta', downloads: '2' },
    { day: '2026-10-20 00:00:00', channel: 'windows', downloads: '1' },
    { day: '2026-10-18 00:00:00', channel: 'beta', downloads: '5' }
  ],
  dailyActive: [{ day: '2026-10-20 00:00:00', active: '1' }, { day: '2026-10-15 00:00:00', active: '2' }],
  activeByDayVersion: [{ day: '2026-10-20 00:00:00', version: '0.2.0-beta.17', active: '1' }],
  thisWeek: 1, lastWeek: 2, thisMonth: 2, lastMonth: 0,
  web: { groups: [{ date: '2026-10-20', path: '/', views: 9, visits: 5 }, { date: '2026-10-20', path: '/demo', views: 3, visits: 0 }, { date: '2026-10-15', path: '/', views: 20, visits: 15 }] },
  downloadsByChannel: [{ channel: 'beta', version: '0.2.0-beta.17', downloads: '7' }, { channel: 'windows', version: 'store', downloads: '1' }],
  downloadsBySource: [{ source: 'direct', downloads: '5' }, { source: '/', downloads: '3' }],
  downloadsFromDemo: 0,
  downloadsByCountry: [{ country: 'IT', downloads: '8' }],
  bots: '7',
  legacy: [{ version: '0.2.0-beta.9', requests: '4' }],
  github: [{ version: '0.2.0-beta.17', dmg: 1, zip: 1 }, { version: '0.2.0-beta.16', dmg: 2, zip: 1 }]
};

test('the report opens with the answers: people using it, then the funnel from visits to clicks', () => {
  const out = report(DATA, { now: NOW, days: 30, full: false });
  const lines = out.split('\n');
  expect(lines[0]).toBe('Atelier stats · Wed 21 Oct 2026 · last 30 days (UTC)');
  expect(out).toContain('today 0 (so far) · yesterday 1 · this week 1 (last week 2) · this month 2 (last month 0)');
  expect(out).toContain('on 2026-10-20: 0.2.0-beta.17 (1)');
  expect(out).toContain('your own Mac counts too when its update channel is Beta or Stable');
  expect(out).toContain('Windows');
  // Visits and clicks share the span; the people using it are not a step after them (any old download, Mac only).
  expect(out).toContain('  site visits 20 → download clicks 8 (Mac 7 · Microsoft Store 1)\n');
  expect(out).not.toMatch(/→ \d+ people/);
  expect(out).toContain('clicks, not people');
  // The funnel comes before the day table, the details only with --full.
  expect(out.indexOf('PEOPLE USING IT')).toBeLessThan(out.indexOf('FUNNEL'));
  expect(out.indexOf('FUNNEL')).toBeLessThan(out.indexOf('PER DAY'));
  expect(out).toContain('day         visits  views  mac  store  active\n2026-10-21       0      0    0      0       0\n2026-10-20       5     12    2      1       1');
  // The d flag is the day's first update check: at launch, then every 6 hours, online.
  expect(out).toContain('visits, views: the site · mac, store: download clicks · active: Macs running Atelier that day');
  expect(out).toContain('PEOPLE USING IT · Macs running Atelier (it checks for updates at launch and every 6 hours, online)');
  expect(out).not.toContain('opened');
  expect(out).not.toContain('GITHUB');
  expect(out).toContain('--full');
});

test('--full adds the details: channels, sources, countries, demo, pages, GitHub with totals, bots, old apps', () => {
  const out = report(DATA, { now: NOW, days: 30, full: true });
  for (const heading of ['BY CHANNEL AND VERSION', 'WHERE THE CLICKS COME FROM', 'COUNTRIES', 'LIVE DEMO', 'TOP PAGES', 'GITHUB', 'BOTS', 'OLD APPS']) {
    expect(out).toContain(heading);
  }
  expect(out).toContain('/demo views 3 · downloads from the demo 0');
  expect(out).toMatch(/total\s+3\s+2/);
  expect(out).toContain('dmg = installer downloads (the site\'s Mac clicks included, never add the two)');
  expect(out).not.toContain('dmg = installs');
  expect(out).toContain('OLD APPS · update checks without the flags: apps up to 0.2.0-beta.9; other = requests without the app\'s User-Agent');
});

test('visits unavailable: said plainly, the rest of the report still printed', () => {
  const out = report({ ...DATA, web: { error: 'Web Analytics answered 403' } }, { now: NOW, days: 30, full: true });
  expect(out).toContain('site visits ? → download clicks 8 (Mac 7 · Microsoft Store 1)');
  expect(out).toContain('visits unavailable: Web Analytics answered 403');
  expect(out).toContain('PER DAY');
  expect(out).toContain('TOP PAGES\n(unavailable)');
});

test('one day: singular, and yesterday still counted', () => {
  const out = report(DATA, { now: new Date('2026-10-21T09:30:00Z'), days: 1, full: false });
  expect(out.split('\n')[0]).toBe('Atelier stats · Wed 21 Oct 2026 · last day (UTC)');
  expect(out).toContain('FUNNEL · last day');
  expect(out).toContain('today 0 (so far) · yesterday 1 ·');
});

test('visits: a failed window costs only its days', () => {
  const windows = [{ start: '2026-10-15T00:00:00.000Z', end: '2026-10-21T09:30:00.000Z' }, { start: '2026-10-08T00:00:00.000Z', end: '2026-10-15T00:00:00.000Z' }];
  const group = { date: '2026-10-20', path: '/', views: 9, visits: 5 };
  expect(visitsResult(windows, [{ status: 'fulfilled', value: [group] }, { status: 'fulfilled', value: [] }])).toEqual({ groups: [group] });
  expect(visitsResult(windows, [{ status: 'fulfilled', value: [group] }, { status: 'rejected', reason: new Error('Web Analytics answered 400') }]))
    .toEqual({ groups: [group], partial: 'visits missing for 2026-10-08 to 2026-10-14: Web Analytics answered 400' });
  expect(visitsResult(windows, [{ status: 'rejected', reason: new Error('Web Analytics answered 403') }, { status: 'rejected', reason: new Error('Web Analytics answered 403') }]))
    .toEqual({ error: 'Web Analytics answered 403' });
  const out = report({ ...DATA, web: { groups: [group], partial: 'visits missing for 2026-10-08 to 2026-10-14: Web Analytics answered 400' } }, { now: NOW, days: 30, full: false });
  expect(out).toContain('site visits 5 → download clicks 8');
  expect(out).toContain('  visits missing for 2026-10-08 to 2026-10-14: Web Analytics answered 400');
});
