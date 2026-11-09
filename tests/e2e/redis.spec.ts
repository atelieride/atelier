import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { e2eEnv } from './env';
import { FakeRedis } from '../support/fake-redis';
import { acmeStore } from '../support/redis-fixtures';
import type { AtelierApi } from '../../src/shared/api';
import { isShell } from '../../src/shared/shells';
import { look } from './shots';

// Redis view: a fake Redis on a loopback port; the app is told that port is the only one it may
// contact, so it never meets the Mac's own Redis.

const SHOTS = resolve('e2e-shots/redis-view');

async function freePort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
  const p = (s.address() as { port: number }).port;
  await new Promise<void>((r) => s.close(() => r()));
  return p;
}

async function launch(port: number, o: { env?: Record<string, string>; dotenv?: string; prefs?: Record<string, unknown> } = {}): Promise<{ app: ElectronApplication; home: string; root: string; win: Page }> {
  const parent = mkdtempSync(join(tmpdir(), 'atl-prj-'));
  const root = join(parent, 'acme-store');
  mkdirSync(join(root, 'src', 'jobs'), { recursive: true });
  writeFileSync(join(root, 'src', 'jobs', 'send-receipt.ts'), Array.from({ length: 40 }, (_, i) => (i === 30 ? '  await mailer.send(receipt);' : `// line ${i + 1}`)).join('\n'));
  if (o.dotenv !== undefined) writeFileSync(join(root, '.env'), o.dotenv);
  const { env, home } = e2eEnv({ ATELIER_TEST_REDIS_PORTS: String(port), ATELIER_TEST_REDIS_PROBE_MS: '500', ...o.env });
  if (o.prefs) writeFileSync(join(home, 'preferences.json'), JSON.stringify(o.prefs));
  const app = await electron.launch({ args: ['out/main/index.js', `--project=${root}`], env });
  const win = await app.firstWindow();
  await win.setViewportSize({ width: 1440, height: 900 });
  return { app, home, root, win };
}

async function stop(app: ElectronApplication, home: string) {
  await app.close();
  try { process.kill((JSON.parse(readFileSync(join(home, 'atelierd.json'), 'utf8')) as { pid: number }).pid, 'SIGTERM'); } catch { /* already stopped */ }
}

const redisIcon = (win: Page) => win.locator('.activity-bar .act[aria-label^="Redis"]');
const ns = (win: Page, name: string) => win.locator('.rd-row.is-ns', { hasText: new RegExp(`^${name}:`) }).first();
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const key = (win: Page, k: string) => win.locator('.rd-krow', { has: win.locator('.rd-kname', { hasText: new RegExp(`^${esc(k)}$`) }) });
/** A Redis tab, one per view, named by it. */
const viewTab = (win: Page, name: string) => win.locator('.tab', { has: win.locator('.tab-name', { hasText: new RegExp(`^${name}$`) }) });
/** Shows a view: its tab when open, else the instance's menu in the sidebar opens it (Overview, Live). */
async function showView(win: Page, name: 'Overview' | 'Live' | 'Keys' | 'Queues') {
  if (await viewTab(win, name).count()) { await viewTab(win, name).click(); return; }
  await win.locator('.sidebar .dk-engine-chip').click({ button: 'right' });
  await win.getByRole('menuitem', { name }).click();
}

/** The floating bar under a value or a job: inside the pane, every button inside the bar with its whole content. Send
 *  is the one that gives way: a long session name ends in an ellipsis (a beta report: it ran over the next pane). */
async function barFits(win: Page, where: string, view = win.locator('.rd-view:visible')) {
  // `view`: the Redis view holding the bar (views side by side).
  const pane = (await view.boundingBox())!;
  const bar = view.locator('.rd-selbar:visible');
  const b = (await bar.boundingBox())!;
  expect(b.x, `${where}: the bar starts inside the pane`).toBeGreaterThanOrEqual(pane.x);
  expect(b.x + b.width, `${where}: the bar ends inside the pane`).toBeLessThanOrEqual(pane.x + pane.width + 0.5);
  for (const el of await bar.locator('button:visible').all()) {
    const name = `${where}: "${(await el.innerText()).trim()}"`;
    const r = (await el.boundingBox())!;
    expect(r.x, `${name} starts inside the bar`).toBeGreaterThanOrEqual(b.x - 0.5);
    expect(r.x + r.width, `${name} ends inside the bar`).toBeLessThanOrEqual(b.x + b.width + 0.5);
    expect(await el.evaluate((e) => e.scrollWidth - e.clientWidth), `${name} holds its content`).toBeLessThanOrEqual(1);
  }
  const label = bar.getByRole('button', { name: /^Send to/ }).locator('.dk-ellipsis');
  await expect(label, `${where}: Send keeps the start of the name`).toHaveText(/^Send to narrow/);
  return label;
}

async function shot(win: Page, name: string) {
  await win.mouse.move(1430, 890);
  await look(win, join(SHOTS, `${name}.png`), { settle: 400 });
}

test('Redis: appears when a server starts; namespaces, keys, values; TTL, delete and undo; queues; live; overview; settings', async () => {
  mkdirSync(SHOTS, { recursive: true });
  const port = await freePort();
  const { app, home, win } = await launch(port, { dotenv: `REDIS_URL=redis://127.0.0.1:${port}\n` });
  let fake: FakeRedis | null = null;
  try {
    // The project mentions Redis but none answers: the icon shows (dimmed) with the not-running state.
    await expect(redisIcon(win)).toBeVisible({ timeout: 15000 });
    await expect(redisIcon(win)).toHaveClass(/is-dim/);
    await redisIcon(win).click();
    // The sidebar's card (Keys, opened on entering the Redis space).
    await expect(win.locator('.sidebar .rd-state.is-stopped')).toContainText('Redis isn’t answering');
    await expect(win.locator('.sidebar .rd-state.is-stopped')).toContainText(`127.0.0.1:${port}`);
    await shot(win, 'stopped');

    // It starts: found on its own, nothing to refresh.
    fake = await FakeRedis.start({ port, version: '8.4.0' });
    acmeStore(fake);
    await expect(win.locator('.dk-engine-chip')).toContainText('redis 8.4', { timeout: 15000 });
    await expect(redisIcon(win)).not.toHaveClass(/is-dim/);
    await expect(win.locator('.rd-section', { hasText: 'Queues' })).toContainText('BullMQ', { timeout: 15000 });
    await expect(win.locator('.rd-row', { hasText: 'email-queue' }).locator('.rd-pill.is-err')).toHaveText('3 failed');
    await expect(win.locator('.rd-row', { hasText: 'canvas-queue' }).locator('.rd-pill.is-warn')).toHaveText('paused');
    await expect(ns(win, 'cache')).toBeVisible();
    await expect(win.locator('.rd-row.is-owned', { hasText: 'bull' })).toContainText('shown in Queues');
    // The list takes the whole sidebar down to its foot (no empty band under a list that scrolls).
    const list = (await win.locator('.rd-list').boundingBox())!;
    const foot = (await win.locator('.rd-foot').boundingBox())!;
    expect(foot.y - (list.y + list.height), 'the list reaches the foot').toBeLessThan(2);
    await expect(win.locator('.rd-row.is-owned', { hasText: 'bull' })).toBeInViewport();

    // A namespace: its keys with type, TTL and size; the first opens; JSON pretty with folds.
    // A namespace opens on the right, never under its row: its arrow always points right, selected or not. A queue
    // library's namespace (bull:) shows the queues icon instead: it opens Queues.
    const glyph = (row: ReturnType<Page['locator']>) => row.locator('svg path').first().getAttribute('d');
    const chevron = await glyph(ns(win, 'cache'));
    expect(await glyph(win.locator('.rd-row.is-owned', { hasText: 'bull' })), 'bull: shows another icon than the arrow').not.toBe(chevron);
    await ns(win, 'cache').click();
    await expect(win.locator('.tab.is-active .tab-name')).toHaveText('Keys');
    await expect(win.locator('.rd-view:visible .rd-head .dk-name')).toContainText('cache');
    await expect(ns(win, 'cache')).toHaveClass(/is-selected/);
    expect(await glyph(ns(win, 'cache')), 'the selected namespace keeps its right arrow').toBe(chevron);
    await key(win, 'cache:products:page:1').click();
    await expect(win.locator('.rd-pane .rd-key')).toHaveText('cache:products:page:1');
    await expect(win.locator('.rd-chip', { hasText: 'detected' })).toContainText('JSON');
    await expect(win.locator('.rd-jl', { hasText: '"generatedAt"' })).toBeVisible();
    await expect(win.locator('.rd-jchip').first()).toBeVisible();
    await expect(win.locator('.rd-meta-cell', { hasText: 'TTL' }).locator('.mono')).toHaveClass(/is-hot/);
    await shot(win, 'keys');

    // A hash: fields as a table, the secret masked (the eye shows it).
    await ns(win, 'sess').click();
    await key(win, 'sess:u:4021:a91f').click();
    await expect(win.locator('.rd-table tr', { hasText: 'csrf' })).toContainText('•••• (masked)');
    await win.locator('.rd-table tr', { hasText: 'csrf' }).getByRole('button', { name: 'Show value' }).click();
    await expect(win.locator('.rd-table tr', { hasText: 'csrf' })).toContainText('f3a9c0d1e2b4');

    // A counter re-read every second.
    await ns(win, 'rate').click();
    await key(win, 'rate:login:ip:127.0.0.1').click();
    await expect(win.locator('.rd-counter-v')).toHaveText('17');
    fake.str('rate:login:ip:127.0.0.1', '18', 40_000);
    await expect(win.locator('.rd-counter-v')).toHaveText('18', { timeout: 5000 });
    await shot(win, 'counter');

    // Set TTL from the popover: 1 min.
    await ns(win, 'cache').click();
    await key(win, 'cache:home:hero:it').click();
    await win.getByRole('button', { name: 'Set TTL…' }).click();
    await win.locator('.rd-ttl-pop').getByRole('button', { name: '1 min' }).click();
    await expect(win.locator('.rd-undo')).toContainText('expires in 1m');
    expect(fake.ttlOf('cache:home:hero:it')).toBeLessThanOrEqual(60_000);

    // Delete a key: asked first, then gone, then back with Undo.
    await key(win, 'cache:product:8812').click();
    await win.locator('.rd-meta-actions').getByRole('button', { name: 'Delete' }).click();
    await expect(win.locator('.rd-modal')).toContainText('Delete cache:product:8812?');
    await shot(win, 'confirm-delete');
    await win.locator('.rd-modal .btn-danger').click();
    await expect(win.locator('.rd-undo')).toContainText('Deleted cache:product:8812');
    expect(fake.get('cache:product:8812')).toBeNull();
    await shot(win, 'undo');
    await win.locator('.rd-undo').getByRole('button', { name: 'Undo' }).click();
    await expect.poll(() => fake!.get('cache:product:8812')?.type ?? null).toBe('hash');

    // Delete matching: the count and three names first.
    await ns(win, 'cache').click();
    await win.getByRole('button', { name: 'Delete matching…' }).click();
    await expect(win.locator('.rd-modal-title')).toHaveText(/Delete \d+ keys\?/);
    await expect(win.locator('.rd-modal-sample')).toContainText('more');
    await win.locator('.rd-modal').getByRole('button', { name: 'Cancel' }).click();

    // Queues: cards, the failed jobs, a job's error and stack (its project frame a link), data masked.
    await win.locator('.rd-row', { hasText: 'email-queue' }).click();
    await expect(win.locator('.rd-qcard.is-selected')).toContainText('email-queue');
    await expect(win.locator('.rd-qcard', { hasText: 'canvas-queue' })).toContainText('paused · no worker');
    await expect(win.locator('.rd-jrow:not(.is-head)')).toHaveCount(3, { timeout: 10000 });
    await expect(win.locator('.rd-jlist-foot')).toContainText('Same reason on all 3 jobs');
    await expect(win.locator('.rd-errbox-reason')).toHaveText('connect ECONNREFUSED 127.0.0.1:1025');
    await expect(win.locator('.rd-frame .link-btn', { hasText: 'src/jobs/send-receipt.ts:31' })).toBeVisible();
    await expect(win.locator('.rd-jdata')).toContainText('m••••@example.com');
    await expect(win.locator('.rd-jdetail-head')).toContainText('Failed · 3/3 attempts');
    await shot(win, 'queues');

    // Retry: asked first; the job leaves failed for wait.
    await win.locator('.rd-jdetail-head').getByRole('button', { name: 'Retry' }).click();
    await win.locator('.rd-modal .btn-primary').click();
    await expect.poll(() => (fake!.get('bull:email-queue:failed') as { v: Map<string, number> } | null)?.v.has('8812') ?? false).toBe(false);
    expect((fake.get('bull:email-queue:wait') as { v: Buffer[] }).v[0]?.toString()).toBe('8812');
    await expect(win.locator('.rd-undo')).toContainText('Retried #8812');

    // Live: the monitor runs only while Live shows.
    expect(fake.connections.some((c) => c.monitor)).toBe(false);
    await showView(win, 'Live');
    await expect.poll(() => fake!.connections.some((c) => c.monitor), { timeout: 10000 }).toBe(true);
    for (let i = 0; i < 4; i++) {
      fake.emitMonitor(['GET', `cache:product:88${20 + i}`], '127.0.0.1:50211');
      fake.emitMonitor(['SET', `cache:product:88${20 + i}`, '{"id":1}', 'EX', '300'], '127.0.0.1:50211');
    }
    fake.emitMonitor(['HGETALL', 'sess:u:4021:a91f'], '127.0.0.1:50211');
    fake.emitMonitor(['DEL', 'cache:products:page:1'], '127.0.0.1:50211');
    await expect(win.locator('.rd-ml', { hasText: 'sess:u:4021:a91f' })).toBeVisible({ timeout: 10000 });
    await expect(win.locator('.rd-ml', { hasText: 'cache:product:8820' }).first()).toContainText('→ miss');
    await expect(win.locator('.rd-ml .rd-cmd.is-del')).toHaveText('DEL');
    await expect(win.locator('.rd-slow-row')).toHaveCount(3, { timeout: 10000 });
    await expect(win.locator('.rd-clients tr', { hasText: 'bull:email-queue' })).toBeVisible({ timeout: 10000 });
    await shot(win, 'live');
    // Another tab in front: Live stops listening (its tab stays open).
    await showView(win, 'Keys');
    await expect.poll(() => fake!.connections.some((c) => c.monitor), { timeout: 10000 }).toBe(false);
    await expect(viewTab(win, 'Live')).toHaveCount(1);

    // Overview: tiles and the honest reading of the hit ratio; keys without a TTL in cache:.
    await showView(win, 'Overview');
    // Live's tab is still open with its own overview column: what is checked is the view in front.
    const shown = win.locator('.rd-view:visible');
    await expect(shown.locator('.rd-tile', { hasText: 'Hit ratio' })).toContainText('32%');
    await expect(shown.locator('.rd-note.is-info')).toContainText('queue polling');
    await expect(shown.locator('.rd-note.is-amber')).toContainText('have no TTL');
    await shot(win, 'overview');
    await shown.locator('.rd-note.is-amber').getByRole('button', { name: 'Show them' }).click();
    await expect(win.locator('.rd-filter-chip')).toContainText('No TTL');
    await expect(win.locator('.rd-krow:not(.is-head)')).toHaveCount(15);

    // The footer: memory, ops and failed jobs; it opens Queues.
    await expect(win.locator('.rd-foot-item')).toContainText('redis ·');
    await expect(win.locator('.rd-foot-item')).toContainText('failed job');

    // Read-only: no edit buttons; main refuses too.
    await win.evaluate(() => (window as unknown as { atelier: AtelierApi }).atelier.settings.set({ redisEdits: 'readonly' }));
    await win.locator('.rd-krow:not(.is-head)').first().click();
    await expect(win.locator('.rd-meta-actions')).toHaveCount(0);
    await expect(win.locator('.rd-foot')).toContainText('Read-only');
    const refused = await win.evaluate(async () => { const a = (window as unknown as { atelier: AtelierApi }).atelier; const s = await a.redis.snapshot(); return a.redis.write({ db: 0, instance: s.pick!, op: { op: 'delete', keys: ['cache:home:hero:it'] } }); });
    expect(refused).toEqual({ ok: false, reason: 'refused' });

    // Never: no icon.
    await win.evaluate(() => (window as unknown as { atelier: AtelierApi }).atelier.settings.set({ showRedis: 'never' }));
    await expect(redisIcon(win)).toHaveCount(0);
    await expect(win.locator('.tab[data-key^="rd:"]')).toHaveCount(0);
    await expect(win.locator('.sidebar.is-redis')).toHaveCount(0);
    // Only what the view asked, through the write path: never KEYS, never FLUSHALL.
    expect(fake.log.some((l) => ['KEYS', 'FLUSHALL', 'CONFIG SET'].includes(l[0]!.toUpperCase()))).toBe(false);
  } finally {
    await stop(app, home);
    await fake?.stop();
  }
});

test('Redis: invisible without Redis (Auto), shows up the moment one answers', async () => {
  const port = await freePort();
  const { app, home, win } = await launch(port);
  let fake: FakeRedis | null = null;
  try {
    await expect(win.locator('.activity-bar .act').first()).toBeVisible({ timeout: 15000 });
    // Two probes at least (PROBE_MS 500) found nothing.
    await win.waitForTimeout(1000);
    await expect(redisIcon(win)).toHaveCount(0);
    await expect(win.locator('.rd-foot-item')).toHaveCount(0);
    fake = await FakeRedis.start({ port });
    await expect(redisIcon(win)).toBeVisible({ timeout: 15000 });
    await expect(redisIcon(win)).not.toHaveClass(/is-dim/);
  } finally {
    await stop(app, home);
    await fake?.stop();
  }
});

test('Redis: Queues in a narrow pane — cards in one row, the list above the job, every button inside the pane', async () => {
  const port = await freePort();
  const fake = await FakeRedis.start({ port, version: '8.4.0' });
  acmeStore(fake);
  const { app, home, win } = await launch(port, { env: { ATELIER_CLAUDE_BIN: resolve('tests/e2e/fake-claude-prompt.pl') } });
  try {
    await win.locator('.btn-new').click();
    await win.getByRole('menuitem', { name: 'Claude Session' }).click();
    // A long name, as sessions get (the beta report's was a sentence with a UUID): Send to it must stay in its bar.
    await win.getByPlaceholder('Session name (optional)').fill('narrow · index failure for UUID 36341188-1cb4-4574-8c1f-b0cfc3f23a23 in prod');
    await win.keyboard.press('Enter');
    // A Claude session (the bars' Send target).
    await expect(win.locator('.session-row', { hasText: 'narrow' })).toHaveClass(/state-done/, { timeout: 20000 });
    await expect(redisIcon(win)).toBeVisible({ timeout: 15000 });
    await redisIcon(win).click();
    // Redis is a space of its own: Queues goes to the side of another Redis tab (Live), not a session's;
    // a slightly narrower window gives Queues' pane the width it had beside a session with Changes open.
    await win.setViewportSize({ width: 1380, height: 900 });
    await showView(win, 'Live');
    await win.locator('.rd-row', { hasText: 'email-queue' }).click();
    await viewTab(win, 'Queues').click({ modifiers: ['Alt'] });
    await expect(win.locator('.pane-divider')).toHaveCount(1);
    await expect(win.locator('.rd-jrow:not(.is-head)')).toHaveCount(3, { timeout: 10000 });
    const queues = win.locator('.rd-view[data-view="queues"]');
    const pane = (await queues.boundingBox())!;
    expect(pane.width).toBeLessThan(560);
    const inside = async (name: string, el: ReturnType<Page['locator']>) => {
      await expect(el, name).toBeVisible();
      const b = (await el.boundingBox())!;
      expect(b.x, `${name} starts inside the pane`).toBeGreaterThanOrEqual(pane.x);
      expect(b.x + b.width, `${name} ends inside the pane`).toBeLessThanOrEqual(pane.x + pane.width + 0.5);
    };
    await inside('Retry', win.locator('.rd-jdetail-head').getByRole('button', { name: 'Retry' }));
    await inside('Remove', win.locator('.rd-jdetail-head').getByRole('button', { name: 'Remove' }));
    await inside('Ask Claude', win.getByRole('button', { name: 'Ask Claude Why It Failed' }));
    await inside('the error', win.locator('.rd-errbox'));
    // The bar's own box keeps its max-width; what overflows is its buttons.
    for (const b of await win.locator('.rd-jdetail .rd-selbar button:visible').all()) await inside(`bar button "${await b.innerText()}"`, b);
    await barFits(win, `the job bar in a ${Math.round(pane.width)} px pane`, queues);
    // The cards keep to one row (they scroll sideways): the job keeps its room below.
    const cards = await win.locator('.rd-qcard').evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().y)));
    expect(new Set(cards).size).toBe(1);
    expect((await win.locator('.rd-jdetail').boundingBox())!.height).toBeGreaterThan(220);
    await shot(win, 'narrow');
    // Wider, Copy job JSON back in the bar (the width of the beta report, ~610 px: Changes takes no room in Redis, so
    // the window is narrower for it): the name gives way, not the bar.
    await win.setViewportSize({ width: 1540, height: 900 });
    await expect.poll(async () => (await queues.boundingBox())!.width).toBeGreaterThan(560);
    await expect(queues.locator('.rd-selbar').getByRole('button', { name: 'Copy job JSON' })).toBeVisible();
    const wide = await barFits(win, `the job bar in a ${Math.round((await queues.boundingBox())!.width)} px pane`, queues);
    expect(await wide.evaluate((e) => e.scrollWidth > e.clientWidth), 'the name ends in an ellipsis').toBe(true);
    await shot(win, 'narrow-long-name');
    // Narrower still (three panes, a phone crop on the website): the job's name stays readable, nothing leaves the pane.
    // (No Changes in Redis: a narrower window for the same ~340 px pane.)
    await win.setViewportSize({ width: 1000, height: 900 });
    await expect.poll(async () => (await queues.boundingBox())!.width).toBeLessThan(380);
    const narrow = (await queues.boundingBox())!;
    for (const b of await win.locator('.rd-jdetail-head button:visible, .rd-jdetail .rd-selbar button:visible, .rd-jlist-head button:visible, .rd-jlist-foot button:visible').all()) {
      const r = (await b.boundingBox())!;
      expect(r.x + r.width, `"${await b.innerText()}" ends inside the ${Math.round(narrow.width)} px pane`).toBeLessThanOrEqual(narrow.x + narrow.width + 0.5);
    }
    await barFits(win, `the job bar in a ${Math.round(narrow.width)} px pane`, queues);
    expect((await win.locator('.rd-jdetail-name').boundingBox())!.width, 'the job name is readable').toBeGreaterThan(60);
    expect((await win.locator('.rd-jlist-foot button').boundingBox())!.height, 'Ask Claude about all 3 on one line').toBeLessThan(34);
    await shot(win, 'narrower');
    // The other views at that width: looked at in the screenshots.
    await ns(win, 'cache').click();
    // The list is shorter above the value: scrolled down to the key, as the user would.
    await win.locator('.rd-kscroll').evaluate((el) => { el.scrollTop = el.scrollHeight; });
    await key(win, 'cache:products:page:1').click();
    await expect(win.locator('.rd-pane .rd-key')).toHaveText('cache:products:page:1');
    // Keys: the list above the value, the value as wide as the pane.
    const value = (await win.locator('.rd-pane').boundingBox())!;
    expect(value.x + value.width, 'the value ends inside the pane').toBeLessThanOrEqual(narrow.x + narrow.width + 0.5);
    expect(value.width, 'the value is as wide as the pane').toBeGreaterThan(narrow.width - 4);
    await barFits(win, `the value bar in a ${Math.round(narrow.width)} px pane`, win.locator('.rd-view[data-view="keys"]'));
    await shot(win, 'narrower-keys');
    await showView(win, 'Overview');
    await shot(win, 'narrower-overview');
    // Live: the monitor alone (Overview is one click away).
    await showView(win, 'Live');
    await expect(win.locator('.rd-live')).toBeVisible();
    expect((await win.locator('.rd-live').boundingBox())!.width, 'the monitor is as wide as the pane').toBeGreaterThan(narrow.width - 4);
    await shot(win, 'narrower-live');
  } finally {
    await stop(app, home);
    await fake.stop();
  }
});

test('Redis: a password from the project .env, offered by name; then Send to a session and Ask Claude about a failed job', async () => {
  mkdirSync(SHOTS, { recursive: true });
  const port = await freePort();
  const fake = await FakeRedis.start({ port, password: 's3cret-pw' });
  acmeStore(fake);
  const { app, home, win } = await launch(port, { dotenv: 'REDIS_HOST=redis\nREDIS_PASSWORD=s3cret-pw\n', env: { ATELIER_CLAUDE_BIN: resolve('tests/e2e/fake-claude-prompt.pl') } });
  try {
    await expect(redisIcon(win)).toBeVisible({ timeout: 15000 });
    await redisIcon(win).click();
    await expect(win.locator('.sidebar .rd-state.is-auth')).toContainText('wants a password', { timeout: 15000 });
    await expect(win.locator('.sidebar .rd-env-found')).toContainText('Found REDIS_PASSWORD in .env');
    await expect(win.locator('body')).not.toContainText('s3cret-pw');
    await shot(win, 'auth');
    await win.locator('.sidebar .rd-env-found').getByRole('button', { name: 'Use It' }).click();
    await expect(win.locator('.dk-engine-chip')).toContainText('redis', { timeout: 15000 });

    // A Claude session waiting at its prompt.
    await win.locator('.activity-bar .act').first().click();
    await win.locator('.btn-new').click();
    await win.getByRole('menuitem', { name: 'Claude Session' }).click();
    await win.getByPlaceholder('Session name (optional)').fill('debug');
    await win.keyboard.press('Enter');
    await expect(win.locator('.session-row', { hasText: 'debug' })).toHaveClass(/state-done/, { timeout: 20000 });
    // Its prompt is on screen (bracketed paste on) before another tab covers it.
    await expect(win.locator('.xterm-rows:visible')).toContainText('>', { timeout: 10000 });
    // And atelierd has seen Claude in front (its foreground poll is 1 s): until then the shell is, and Send says busy.
    const front = () => win.evaluate(async () => (await (window as unknown as { atelier: AtelierApi }).atelier.terminals.list()).find((x) => x.title === 'debug')?.foreground ?? '');
    await expect.poll(async () => { const fg = await front(); return fg !== '' && !isShell(fg); }, { timeout: 10000 }).toBe(true);

    await redisIcon(win).click();
    await ns(win, 'cache').click();
    await key(win, 'cache:product:8812').click();
    // Its value loaded: Send builds the prompt from it (before that, the button does nothing).
    await expect(win.locator('.rd-pane .rd-key')).toHaveText('cache:product:8812');
    await expect(win.locator('.rd-meta-cell', { hasText: 'TTL' })).toBeVisible();
    await expect(win.locator('.rd-selbar .btn-primary')).toContainText('Send to debug');
    await win.locator('.rd-selbar .btn-primary').click();
    await expect(win.locator('.xterm-rows:visible')).toContainText('This is a Redis key from my local', { timeout: 10000 });
    await expect(win.locator('.xterm-rows:visible')).toContainText('cache:product:8812');

    await redisIcon(win).click();
    await win.locator('.rd-row', { hasText: 'email-queue' }).click();
    await expect(win.locator('.rd-errbox-reason')).toBeVisible({ timeout: 10000 });
    await win.getByRole('button', { name: 'Ask Claude Why It Failed' }).click();
    await expect(win.locator('.tab.is-active')).toContainText('redis email-queue #8812', { timeout: 20000 });
    await expect(win.locator('.xterm-rows:visible')).toContainText('A BullMQ job failed in queue "email-queue"', { timeout: 20000 });
    await expect(win.locator('.xterm-rows:visible')).not.toContainText('m.rossi@example.com');
  } finally {
    await stop(app, home);
    await fake.stop();
  }
});
