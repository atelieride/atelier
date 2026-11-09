// The site's performance and SEO check. Manual,
// never in `npm test`: `npm --prefix site run perf -- --out <file.json> [--against <baseline.json>]`. Needs a built
// site (SITE_NO_BEACON=1, so nothing is reported) and Chromium inside site/node_modules (`npm run e2e:install`).
// Measures the home page and /features before any interaction (requests and their brotli size, long tasks, layout
// shifts, LCP) on desktop and phone, then Lighthouse (median of 3) on desktop and mobile for /, /features and /demo when
// they exist. With --against, prints the deltas and exits 1 when the contract is broken; a profile the baseline lacks
// (/features before it existed) is held to the baseline's home (/features carries what the old home carried). Every
// non-performance audit that does not
// pass is listed (and recorded) under its page, so a score below 100 says why. `--only "/demo desktop"` runs that one
// Lighthouse profile and nothing else (investigating; no contract check).
import { chromium } from '@playwright/test';
import { launch } from 'chrome-launcher';
import lighthouse from 'lighthouse';
import desktopConfig from 'lighthouse/core/config/desktop-config.js';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { brotliCompressSync, constants } from 'node:zlib';

const site = fileURLToPath(new URL('..', import.meta.url));
const dist = join(site, 'dist');
const PORT = 4331;
const BASE = `http://127.0.0.1:${PORT}`;
const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const out = opt('--out');
const against = opt('--against');
const only = opt('--only');
if (!out) { console.error('usage: perf-check.mjs --out <file.json> [--against <baseline.json>]'); process.exit(2); }
if (!existsSync(join(dist, 'index.html'))) { console.error('no site/dist: build it first (SITE_NO_BEACON=1 npm --prefix site run build)'); process.exit(2); }

// Chromium's headless shell from site/node_modules (Playwright's own download): Lighthouse drives it too.
function chromePath() {
  const dir = join(site, 'node_modules/playwright-core/.local-browsers');
  const shell = readdirSync(dir).find((d) => d.startsWith('chromium_headless_shell-'));
  if (!shell) throw new Error('no Chromium in site/node_modules: npm --prefix site run e2e:install');
  const root = join(dir, shell);
  const sub = readdirSync(root).find((d) => d.startsWith('chrome-headless-shell-'));
  return join(root, sub, 'chrome-headless-shell');
}

const brotli = (file) => brotliCompressSync(readFileSync(file), { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }).length;
function fileOf(url) {
  const u = new URL(url);
  if (u.origin !== BASE) return null;
  let p = decodeURIComponent(u.pathname);
  if (p.endsWith('/')) p += 'index.html';
  const candidates = [join(dist, p), join(dist, `${p}.html`)];
  return candidates.find((f) => existsSync(f)) ?? null;
}

// Every request on load, the page left alone 3 s after the network settles, no pointer over it.
const OBSERVE = () => {
  window.__perf = { longtasks: [], cls: 0, shifts: [], lcp: null };
  new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__perf.longtasks.push({ start: e.startTime, duration: e.duration, from: e.attribution?.map((a) => a.containerSrc || a.name) }); }).observe({ type: 'longtask', buffered: true });
  new PerformanceObserver((l) => { for (const e of l.getEntries()) if (!e.hadRecentInput) { window.__perf.cls += e.value; window.__perf.shifts.push(e.sources?.map((s) => s.node?.nodeName + '.' + (s.node?.className ?? ''))); } }).observe({ type: 'layout-shift', buffered: true });
  new PerformanceObserver((l) => { const e = l.getEntries().at(-1); window.__perf.lcp = { time: e.startTime, element: e.element ? `${e.element.nodeName}${e.element.className ? '.' + e.element.className : ''}` : null, url: e.url }; }).observe({ type: 'largest-contentful-paint', buffered: true });
};
async function loadProfile(browser, name, contextOptions, path = '/') {
  const context = await browser.newContext(contextOptions);
  const page = await context.newPage();
  await page.addInitScript(OBSERVE);
  const requests = [];
  page.on('request', (r) => requests.push(r.url()));
  await page.mouse.move(0, 0);
  await page.goto(`${BASE}${path}`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(3000);
  const perf = await page.evaluate(() => window.__perf);
  await context.close();
  const files = requests.map((url) => {
    const f = fileOf(url);
    return { url: url.replace(BASE, ''), brotli: f ? brotli(f) : null };
  });
  return {
    name,
    requests: files,
    bytes: files.reduce((n, f) => n + (f.brotli ?? 0), 0),
    demoRequests: files.filter((f) => f.url.startsWith('/demo-app/')).map((f) => f.url),
    longtasks: perf.longtasks,
    cls: Number(perf.cls.toFixed(4)),
    lcp: perf.lcp
  };
}

async function lighthouseScores(path, formFactor, runs = 3) {
  const results = [];
  for (let i = 0; i < runs; i++) {
    const userDataDir = mkdtempSync(join(tmpdir(), 'atl-run-perf-'));
    const chrome = await launch({ chromePath: chromePath(), chromeFlags: ['--headless=new', '--no-first-run', '--in-process-gpu'], userDataDir, logLevel: 'silent' });
    try {
      const r = await lighthouse(`${BASE}${path}`, { port: chrome.port, output: 'json', logLevel: 'error' }, formFactor === 'desktop' ? desktopConfig : undefined);
      const c = r.lhr.categories;
      const a = r.lhr.audits;
      // Audits that count and do not pass, outside performance (which has its own numbers).
      const failing = ['accessibility', 'best-practices', 'seo'].flatMap((cat) => c[cat].auditRefs
        .filter((ref) => ref.weight > 0 && a[ref.id].score !== null && a[ref.id].score < 1)
        .map((ref) => ({ category: cat, id: ref.id, title: a[ref.id].title, items: (a[ref.id].details?.items ?? []).slice(0, 5).map((i) => JSON.stringify(i).slice(0, 300)) })));
      results.push({
        performance: Math.round(c.performance.score * 100), accessibility: Math.round(c.accessibility.score * 100),
        bestPractices: Math.round(c['best-practices'].score * 100), seo: Math.round(c.seo.score * 100),
        lcp: Math.round(a['largest-contentful-paint'].numericValue), tbt: Math.round(a['total-blocking-time'].numericValue),
        cls: Number(a['cumulative-layout-shift'].numericValue.toFixed(4)), bytes: Math.round(a['total-byte-weight'].numericValue),
        failing
      });
    } finally {
      await chrome.kill();
      rmSync(userDataDir, { recursive: true, force: true });
    }
  }
  // The median run by performance score: one noisy run never decides.
  results.sort((x, y) => x.performance - y.performance);
  return { ...results[Math.floor(results.length / 2)], runs: results.map((r) => r.performance) };
}

function startPreview() {
  const child = spawn('npx', ['astro', 'preview', '--port', String(PORT), '--host', '127.0.0.1', '--ignore-lock'], { cwd: site, env: { ...process.env, ASTRO_TELEMETRY_DISABLED: '1' }, stdio: 'ignore' });
  return child;
}
async function waitFor(url, ms = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { if ((await fetch(url)).ok) return; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`preview did not start at ${url}`);
}

const preview = startPreview();
try {
  await waitFor(`${BASE}/`);
  if (only) {
    const [path, form] = only.split(' ');
    const v = await lighthouseScores(path, form, 1);
    writeFileSync(out, JSON.stringify({ at: new Date().toISOString(), lighthouse: { [only]: v } }, null, 2));
    console.log(`lighthouse ${only}: perf ${v.performance}, a11y ${v.accessibility}, bp ${v.bestPractices}, seo ${v.seo}`);
    for (const f of v.failing) console.log(`  ${f.category} › ${f.id}: ${f.title}${f.items.map((i) => `\n      ${i}`).join('')}`);
    process.exit(0);
  }
  // --in-process-gpu: on macOS 27 the headless shell's GPU process exits at devicePixelRatio 2 (playwright.config.ts).
  const browser = await chromium.launch({ executablePath: chromePath(), args: ['--in-process-gpu'] });
  const desktop = { viewport: { width: 1440, height: 900 } };
  const phone = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 };
  const features = existsSync(join(dist, 'features.html'));
  const load = [
    await loadProfile(browser, 'desktop', desktop),
    await loadProfile(browser, 'phone', phone),
    ...(features ? [await loadProfile(browser, 'features desktop', desktop, '/features'), await loadProfile(browser, 'features phone', phone, '/features')] : [])
  ];
  await browser.close();
  const paths = ['/', ...(features ? ['/features'] : []), ...(existsSync(join(dist, 'demo.html')) ? ['/demo'] : [])];
  const lh = {};
  for (const p of paths) for (const f of ['desktop', 'mobile']) lh[`${p} ${f}`] = await lighthouseScores(p, f);
  const report = { at: new Date().toISOString(), load, lighthouse: lh };
  writeFileSync(out, JSON.stringify(report, null, 2));
  for (const l of load) console.log(`${l.name}: ${l.requests.length} requests, ${(l.bytes / 1024).toFixed(1)} KB brotli, CLS ${l.cls}, long tasks ${l.longtasks.length}, LCP ${l.lcp?.element} ${Math.round(l.lcp?.time ?? 0)} ms, demo requests ${l.demoRequests.length}`);
  for (const [k, v] of Object.entries(lh)) {
    console.log(`lighthouse ${k}: perf ${v.performance} (${v.runs.join('/')}), a11y ${v.accessibility}, bp ${v.bestPractices}, seo ${v.seo}, LCP ${v.lcp} ms, TBT ${v.tbt} ms, CLS ${v.cls}, ${(v.bytes / 1024).toFixed(0)} KB`);
    for (const f of v.failing) console.log(`  ${f.category} › ${f.id}: ${f.title}`);
  }

  if (against) {
    const base = JSON.parse(readFileSync(against, 'utf8'));
    const problems = [];
    for (const l of load) {
      // A page the baseline did not have is held to the baseline's home (same form factor); its LCP is its own.
      const own = base.load.find((x) => x.name === l.name);
      const b = own ?? base.load.find((x) => x.name === l.name.replace(/^features /, ''));
      const grew = l.bytes - b.bytes;
      if (grew > 4096) problems.push(`${l.name}: +${(grew / 1024).toFixed(1)} KB before interaction (allowed 4 KB)`);
      if (l.demoRequests.length) problems.push(`${l.name}: loads demo files before interaction: ${l.demoRequests.join(', ')}`);
      if (l.cls > b.cls + 0.001) problems.push(`${l.name}: CLS ${b.cls} → ${l.cls}`);
      if (l.longtasks.length > b.longtasks.length) problems.push(`${l.name}: long tasks ${b.longtasks.length} → ${l.longtasks.length}`);
      if (own && b.lcp?.element && l.lcp?.element !== b.lcp.element) problems.push(`${l.name}: LCP element ${b.lcp.element} → ${l.lcp?.element}`);
    }
    for (const [k, v] of Object.entries(lh)) {
      const b = base.lighthouse[k] ?? base.lighthouse[k.replace(/^\/features /, '/ ')];
      if (!b) continue;
      for (const cat of ['performance', 'accessibility', 'bestPractices', 'seo']) {
        const floor = b[cat] === 100 && cat !== 'performance' ? 100 : b[cat] - 2;
        if (v[cat] < floor) problems.push(`lighthouse ${k} ${cat}: ${b[cat]} → ${v[cat]}`);
      }
    }
    console.log(problems.length ? `\nContract broken:\n- ${problems.join('\n- ')}` : '\nContract kept.');
    if (problems.length) process.exitCode = 1;
  }
} finally {
  preview.kill();
}
