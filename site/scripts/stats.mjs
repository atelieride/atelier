#!/usr/bin/env node
// Who uses Atelier, and how people get there: active installs and downloads from
// Analytics Engine, site visits from Web Analytics (useatelier.dev only), GitHub's asset counts as a cross-check. The
// answers come first, the details with --full. Reads the Cloudflare token and account id from the environment
// (CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID) or the Keychain, like `deploy`; never prints the token.
// Usage: npm --prefix site run stats [-- --days 30] [-- --full]
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const DATASET = 'useatelier_events';
const HOSTS = ['useatelier.dev', 'www.useatelier.dev'];
const RELEASES = 'https://api.github.com/repos/atelieride/atelier/releases?per_page=100';
const DAY = 86_400_000;
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Monday 00:00 UTC of the ISO week holding `date` (the app's `w` flag flips there). */
export function weekStart(date) {
  const d = midnight(date);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d;
}

export function monthStart(date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
}

export function sqlTime(date) {
  return `toDateTime('${date.toISOString().slice(0, 19).replace('T', ' ')}')`;
}

function midnight(date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

/** Midnight UTC of the report's first day: `days` whole days, today the last. */
const firstDay = (now, days) => new Date(midnight(now).getTime() - (days - 1) * DAY);
const isoDay = (date) => date.toISOString().slice(0, 10);
/** Analytics Engine's day buckets ("2026-10-20 00:00:00") and Web Analytics' dates, as YYYY-MM-DD. */
const dayOf = (v) => String(v).slice(0, 10);

/** Every Analytics Engine query. Downloads: blob1 channel, blob2 version, blob3 source, blob4 country, blob5 client.
 *  Checks: blob1 version, blob2 flagged|legacy, double2..4 the d/w/m flags (the first check of the day/week/month). */
export function queries({ now, days }) {
  // Whole UTC days, today included, like the per-day rows: every table counts the same span.
  const since = `timestamp >= ${sqlTime(firstDay(now, days))}`;
  const dl = `FROM ${DATASET} WHERE index1 = 'download' AND blob5 = 'browser' AND ${since}`;
  const checks = `FROM ${DATASET} WHERE index1 = 'check'`;
  const day = `toStartOfInterval(timestamp, INTERVAL '1' DAY)`;
  const week = weekStart(now);
  const month = monthStart(now);
  const lastWeek = new Date(week.getTime() - 7 * DAY);
  const lastMonth = monthStart(new Date(month.getTime() - DAY));
  return {
    downloadsByDay: `SELECT ${day} AS day, blob1 AS channel, SUM(_sample_interval) AS downloads ${dl} GROUP BY day, channel ORDER BY day DESC`,
    downloadsByChannel: `SELECT blob1 AS channel, blob2 AS version, SUM(_sample_interval) AS downloads ${dl} GROUP BY channel, version ORDER BY downloads DESC`,
    downloadsBySource: `SELECT blob3 AS source, SUM(_sample_interval) AS downloads ${dl} GROUP BY source ORDER BY downloads DESC LIMIT 20`,
    downloadsFromDemo: `SELECT SUM(_sample_interval) AS downloads ${dl} AND blob3 = 'demo'`,
    downloadsByCountry: `SELECT blob4 AS country, SUM(_sample_interval) AS downloads ${dl} GROUP BY country ORDER BY downloads DESC LIMIT 20`,
    bots: `SELECT SUM(_sample_interval) AS bot_requests FROM ${DATASET} WHERE index1 = 'download' AND blob5 = 'bot' AND ${since}`,
    dailyActive: `SELECT ${day} AS day, SUM(_sample_interval * double2) AS active ${checks} AND ${since} GROUP BY day ORDER BY day DESC`,
    // An install's version at its first check of a day: right for that day. (The w/m flags would pin it to the version
    // it ran at the start of the week or month.)
    activeByDayVersion: `SELECT ${day} AS day, blob1 AS version, SUM(_sample_interval * double2) AS active ${checks} AND timestamp >= ${sqlTime(firstDay(now, 7))} GROUP BY day, version ORDER BY day DESC`,
    thisWeek: `SELECT SUM(_sample_interval * double3) AS active ${checks} AND timestamp >= ${sqlTime(week)}`,
    lastWeek: `SELECT SUM(_sample_interval * double3) AS active ${checks} AND timestamp >= ${sqlTime(lastWeek)} AND timestamp < ${sqlTime(week)}`,
    thisMonth: `SELECT SUM(_sample_interval * double4) AS active ${checks} AND timestamp >= ${sqlTime(month)}`,
    lastMonth: `SELECT SUM(_sample_interval * double4) AS active ${checks} AND timestamp >= ${sqlTime(lastMonth)} AND timestamp < ${sqlTime(month)}`,
    legacy: `SELECT blob1 AS version, SUM(_sample_interval) AS requests ${checks} AND blob2 = 'legacy' AND ${since} GROUP BY version ORDER BY requests DESC`
  };
}

/** The most recent whole day with an active install (today, still partial, only when no other day has one), and the
 *  versions those installs ran that day. */
export function latestVersions(rows, today) {
  const used = rows.filter((r) => r.version !== 'other' && Number(r.active) > 0);
  if (used.length === 0) return null;
  const days = [...new Set(used.map((r) => dayOf(r.day)))].sort();
  const day = days.filter((d) => d !== today).at(-1) ?? days.at(-1);
  const versions = used.filter((r) => dayOf(r.day) === day).map((r) => ({ version: r.version, active: Number(r.active) }));
  return { day, versions: versions.sort((a, b) => b.active - a.active) };
}

/** The report's span in windows of at most 7 days, newest first: Web Analytics answers wider ones sampled 10×, which
 *  at our traffic turns a handful of visits into 0 or 10. */
export function webWindows({ now, days }) {
  const first = firstDay(now, days);
  const out = [];
  let end = now;
  let cursor = new Date(midnight(now).getTime() - 6 * DAY);
  while (end > first) {
    const start = cursor > first ? cursor : first;
    out.push({ start: start.toISOString(), end: end.toISOString() });
    end = start;
    cursor = new Date(cursor.getTime() - 7 * DAY);
  }
  return out;
}

/** Page views and visits (a visit is counted on its landing page) per day and path, on our hosts only. */
export function webQuery() {
  return `query ($account: String!, $start: Time!, $end: Time!) {
  viewer { accounts(filter: { accountTag: $account }) {
    rumPageloadEventsAdaptiveGroups(limit: 10000, filter: { datetime_geq: $start, datetime_lt: $end, requestHost_in: ${JSON.stringify(HOSTS).replace(',', ', ')} }) {
      count sum { visits } dimensions { date requestPath }
    }
  } }
}`;
}

/** The visit windows' outcomes (Promise.allSettled) as { groups }, { groups, partial } when some failed (their days
 *  are named), or { error } when none answered. */
export function visitsResult(windows, settled) {
  const failed = settled.flatMap((r, i) => (r.status === 'rejected' ? [{ ...windows[i], reason: r.reason?.message ?? String(r.reason) }] : []));
  if (failed.length === settled.length) return { error: failed[0]?.reason ?? 'no window to ask' };
  const groups = settled.flatMap((r) => (r.status === 'fulfilled' ? r.value : []));
  if (failed.length === 0) return { groups };
  const span = (w) => `${dayOf(w.start)} to ${isoDay(new Date(Date.parse(w.end) - 1))}`;
  return { groups, partial: `visits missing for ${failed.map(span).join(', ')}: ${failed[0].reason}` };
}

/** One row per day from today back to the first day with any data: site visits and views, download clicks for the
 *  Mac and for the Store, active installs. */
export function perDay({ now, days, downloads, active, web }) {
  const rows = new Map();
  for (let i = 0; i < days; i++) {
    const day = isoDay(new Date(midnight(now).getTime() - i * DAY));
    rows.set(day, { day, visits: 0, views: 0, mac: 0, store: 0, active: 0 });
  }
  for (const r of downloads) {
    const row = rows.get(dayOf(r.day));
    if (row) row[r.channel === 'windows' ? 'store' : 'mac'] += Number(r.downloads);
  }
  for (const r of active) {
    const row = rows.get(dayOf(r.day));
    if (row) row.active += Number(r.active);
  }
  for (const g of web) {
    const row = rows.get(g.date);
    if (row) { row.visits += g.visits; row.views += g.views; }
  }
  const list = [...rows.values()];
  const empty = (r) => r.visits + r.views + r.mac + r.store + r.active === 0;
  let last = list.length - 1;
  while (last > 0 && empty(list[last])) last--;
  return list.slice(0, last + 1);
}

/** A plain text table; day buckets lose their midnight time, numeric columns are right-aligned. */
export function table(rows, columns) {
  if (rows.length === 0) return '(none)';
  const cell = (v) => (v === null || v === undefined ? '' : typeof v === 'string' ? v.replace(/[ T]00:00:00(\.000)?Z?$/, '') : String(Math.round(Number(v) * 100) / 100));
  // Analytics Engine sends its sums as strings: a column is numeric when every cell reads as a number.
  const numeric = columns.map((c) => rows.every((r) => typeof r[c] === 'number' || /^-?\d+(\.\d+)?$/.test(String(r[c]))));
  const widths = columns.map((c) => Math.max(c.length, ...rows.map((r) => cell(r[c]).length)));
  const line = (vals) => vals.map((v, i) => (numeric[i] ? v.padStart(widths[i]) : i === vals.length - 1 ? v : v.padEnd(widths[i]))).join('  ');
  return [line(columns), ...rows.map((r) => line(columns.map((c) => cell(r[c]))))].join('\n');
}

/** Per release on GitHub (all time): DMG downloads (installs, the site's clicks included, since /download/mac sends
 *  people there) and ZIP downloads (updates fetched by the app). */
export function assetCounts(releases) {
  if (!Array.isArray(releases)) return [];
  return releases.flatMap((r) => {
    if (!r || typeof r.tag_name !== 'string' || !Array.isArray(r.assets)) return [];
    const version = r.tag_name.replace(/^v/, '');
    const count = (name) => {
      const a = r.assets.find((x) => x && x.name === name);
      return typeof a?.download_count === 'number' ? a.download_count : 0;
    };
    return [{ version, dmg: count(`Atelier-${version}-arm64.dmg`), zip: count(`Atelier-${version}-arm64.zip`) }];
  });
}

const sum = (rows, key) => rows.reduce((n, r) => n + Number(r[key] ?? 0), 0);

/** The whole report. `data.web` is visitsResult's answer; `data.github` is assetCounts' rows or null. */
export function report(data, { now, days, full }) {
  const date = `${WEEKDAYS[now.getUTCDay()]} ${now.getUTCDate()} ${MONTHS[now.getUTCMonth()]} ${now.getUTCFullYear()}`;
  const web = data.web.groups ?? null;
  const days_ = perDay({ now, days, downloads: data.downloadsByDay, active: data.dailyActive, web: web ?? [] });
  // From the query, not the rows: with --days 1 there is no row for yesterday.
  const activeOn = (offset) => sum(data.dailyActive.filter((r) => dayOf(r.day) === isoDay(new Date(midnight(now).getTime() - offset * DAY))), 'active');
  const mac = sum(days_, 'mac');
  const store = sum(days_, 'store');
  const latest = latestVersions(data.activeByDayVersion, isoDay(now));
  const span = days === 1 ? 'last day' : `last ${days} days`;
  const out = [
    `Atelier stats · ${date} · ${span} (UTC)`, '',
    'PEOPLE USING IT · Macs running Atelier (it checks for updates at launch and every 6 hours, online)',
    '  counted without any identifier: two Macs are two',
    `  today ${activeOn(0)} (so far) · yesterday ${activeOn(1)} · this week ${data.thisWeek} (last week ${data.lastWeek}) · this month ${data.thisMonth} (last month ${data.lastMonth})`,
    latest ? `  on ${latest.day}: ${latest.versions.map((v) => `${v.version} (${v.active})`).join(' · ')}` : '  no active install in the last 7 days',
    '  your own Mac counts too when its update channel is Beta or Stable',
    '  not counted: Windows (no update check: installs are in Partner Center › Analytics), local builds on Auto, updates Off',
    '',
    `FUNNEL · ${span}`,
    `  site visits ${web ? sum(days_, 'visits') : '?'} → download clicks ${mac + store} (Mac ${mac} · Microsoft Store ${store})`,
    '  clicks, not people: one person can click twice, and not everyone who downloads opens the app',
    '  the people using it (above) are not a step after these clicks: they count every Mac, however old its download',
    ...(web ? [] : [`  visits unavailable: ${data.web.error}`]),
    ...(data.web.partial ? [`  ${data.web.partial}`] : []),
    '',
    'PER DAY · visits, views: the site · mac, store: download clicks · active: Macs running Atelier that day',
    table(days_, ['day', 'visits', 'views', 'mac', 'store', 'active']),
    ''
  ];
  if (!full) return [...out, 'More (sources, countries, live demo, pages, GitHub, bots, old apps): npm --prefix site run stats -- --full'].join('\n');
  const pages = web ? [...web.reduce((m, g) => m.set(g.path, (m.get(g.path) ?? 0) + g.views), new Map())].map(([page, views]) => ({ page, views })).sort((a, b) => b.views - a.views).slice(0, 15) : null;
  const github = data.github ?? [];
  return [
    ...out,
    'BY CHANNEL AND VERSION · download clicks (Windows: the Store link, the Store picks the version)',
    table(data.downloadsByChannel, ['channel', 'version', 'downloads']), '',
    'WHERE THE CLICKS COME FROM · a page of ours, another site, a ?ref= tag, or direct (no referrer)',
    table(data.downloadsBySource, ['source', 'downloads']), '',
    'COUNTRIES',
    table(data.downloadsByCountry, ['country', 'downloads']), '',
    `LIVE DEMO · /demo views ${web ? sum(web.filter((g) => g.path === '/demo'), 'views') : '?'} · downloads from the demo ${data.downloadsFromDemo}`, '',
    'TOP PAGES',
    pages ? table(pages, ['page', 'views']) : '(unavailable)', '',
    'GITHUB · all time, per release: dmg = installer downloads (the site\'s Mac clicks included, never add the two), zip = updates the app fetched',
    data.github ? table([...github, { version: 'total', dmg: sum(github, 'dmg'), zip: sum(github, 'zip') }], ['version', 'dmg', 'zip']) : '(unavailable)', '',
    `BOTS AND TOOLS asking /download/mac: ${data.bots} (left out above)`, '',
    'OLD APPS · update checks without the flags: apps up to 0.2.0-beta.9; other = requests without the app\'s User-Agent',
    table(data.legacy, ['version', 'requests'])
  ].join('\n');
}

async function sql(token, account, query) {
  const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/analytics_engine/sql`, {
    method: 'POST', headers: { authorization: `Bearer ${token}` }, body: `${query} FORMAT JSON`
  });
  if (res.status === 401 || res.status === 403) {
    throw new Error('The Cloudflare token cannot read Analytics Engine: it needs "Account Analytics: Read" (Keychain item atelier-cloudflare-mcp).');
  }
  if (!res.ok) throw new Error(`Analytics Engine answered ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return (await res.json()).data ?? [];
}

async function visits(token, account, now, days) {
  const windows = webWindows({ now, days });
  const settled = await Promise.allSettled(windows.map(async ({ start, end }) => {
    const res = await fetch('https://api.cloudflare.com/client/v4/graphql', {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ query: webQuery(), variables: { account, start, end } })
    });
    if (!res.ok) throw new Error(`Web Analytics answered ${res.status}`);
    const body = await res.json();
    if (body.errors?.length) throw new Error(`Web Analytics: ${String(body.errors[0].message).slice(0, 200)}`);
    const groups = body.data.viewer.accounts[0]?.rumPageloadEventsAdaptiveGroups ?? [];
    return groups.map((g) => ({ date: g.dimensions.date, path: g.dimensions.requestPath, views: g.count, visits: g.sum.visits }));
  }));
  return visitsResult(windows, settled);
}

async function main() {
  const i = process.argv.indexOf('--days');
  const days = i > 0 ? Math.max(1, Math.min(90, Number(process.argv[i + 1]) || 30)) : 30;
  const full = process.argv.includes('--full');
  const now = new Date();
  const keychain = (item) => execFileSync('/usr/bin/security', ['find-generic-password', '-s', item, '-w'], { encoding: 'utf8' }).trim();
  const token = process.env.CLOUDFLARE_API_TOKEN || keychain('atelier-cloudflare-mcp');
  // The account holding the site (not a secret, but not the repository's business either).
  const account = process.env.CLOUDFLARE_ACCOUNT_ID || keychain('atelier-cloudflare-account');
  const q = queries({ now, days });
  const names = Object.keys(q);
  const rows = Object.fromEntries(names.map((n, k) => [n, k]));
  const results = await Promise.all(names.map((n) => sql(token, account, q[n])));
  const all = (name) => results[rows[name]];
  const one = (name) => Number(Object.values(all(name)[0] ?? {})[0] ?? 0);
  const web = await visits(token, account, now, days);
  let github = null;
  if (full) {
    try {
      const res = await fetch(RELEASES, { headers: { accept: 'application/vnd.github+json', 'user-agent': 'atelier-stats' } });
      if (res.ok) github = assetCounts(await res.json());
    } catch { /* offline or rate-limited: shown as unavailable */ }
  }
  console.log(report({
    downloadsByDay: all('downloadsByDay'), dailyActive: all('dailyActive'), activeByDayVersion: all('activeByDayVersion'),
    thisWeek: one('thisWeek'), lastWeek: one('lastWeek'), thisMonth: one('thisMonth'), lastMonth: one('lastMonth'),
    web,
    downloadsByChannel: all('downloadsByChannel'), downloadsBySource: all('downloadsBySource'),
    downloadsFromDemo: one('downloadsFromDemo'), downloadsByCountry: all('downloadsByCountry'), bots: one('bots'),
    legacy: all('legacy'), github
  }, { now, days, full }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => { console.error(err.message); process.exit(1); });
}
