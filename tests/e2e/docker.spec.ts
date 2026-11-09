import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { chmodSync, constants, copyFileSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { e2eEnv } from './env';
import { FakeDocker } from '../support/fake-docker';
import { stageDocker, writeProject } from './docker-fixture';
import { look } from './shots';

// Docker view: a fake engine on a Unix socket in the test's temp root; the app never meets a real
// one. Every request it sends must be a GET.

const SHOTS = resolve('e2e-shots/docker-view');

async function launch(socket: string, extra: Record<string, string> = {}): Promise<{ app: ElectronApplication; home: string; root: string; win: Page }> {
  const parent = mkdtempSync(join(tmpdir(), 'atl-prj-'));
  const root = join(parent, 'acme-store');
  mkdirSync(root);
  writeProject(root);
  const { env, home } = e2eEnv({ ATELIER_TEST_DOCKER_SOCKET: socket, ...extra });
  const app = await electron.launch({ args: ['out/main/index.js', `--project=${root}`], env });
  const win = await app.firstWindow();
  await win.setViewportSize({ width: 1440, height: 900 });
  return { app, home, root, win };
}

async function stop(app: ElectronApplication, home: string) {
  await app.close();
  try { process.kill((JSON.parse(readFileSync(join(home, 'atelierd.json'), 'utf8')) as { pid: number }).pid, 'SIGTERM'); } catch { /* already stopped */ }
}

const dockerIcon = (win: Page) => win.locator('.activity-bar .act-docker');
const row = (win: Page, name: string) => win.locator('.dk-row', { has: win.locator('.dk-row-title', { hasText: new RegExp(`^${name}$`) }) }).first();
/** A Docker tab is named by what it shows: the container, the stack, "Overview". */
const tabNamed = (win: Page, name: string) => win.locator('.tab', { has: win.locator('.tab-name', { hasText: new RegExp(`^${name}$`) }) });
const activeTabName = (win: Page) => win.locator('.tab.is-active .tab-name');

async function shot(win: Page, name: string) {
  await win.mouse.move(1430, 890);
  await look(win, join(SHOTS, `${name}.png`), { settle: 350 });
}

test('Docker: the sidebar, a container\'s logs, the stack, Inspect, the overview; read-only throughout', async () => {
  mkdirSync(SHOTS, { recursive: true });
  const dir = mkdtempSync(join(tmpdir(), 'dk-'));
  const fake = await FakeDocker.start(join(dir, 'd.sock'));
  const { app, home, root, win } = await launch(fake.socket);
  const ids = stageDocker(fake, root);
  try {
    await expect(dockerIcon(win)).toBeVisible({ timeout: 15000 });
    await dockerIcon(win).click();
    await expect(win.locator('.dk-engine-chip')).toContainText('OrbStack · 27.3');
    await expect(win.locator('.dk-group.is-mine .dk-group-name')).toHaveText('acme-store');
    // The crashed worker comes first in its group, with its restarts.
    await expect(win.locator('.dk-group.is-mine .dk-row:not(.is-stack) .dk-row-title').first()).toHaveText('worker');
    await expect(row(win, 'worker').locator('.dk-restarts')).toHaveText('↻ 3');
    await expect(win.locator('.activity-bar .act-docker .act-dot.is-error')).toBeVisible();
    await expect(win.locator('.dk-elsewhere')).toContainText('Elsewhere');

    // A container's logs: levels, statuses, the trace folded after two frames, JSON folded to its message.
    await row(win, 'api').click();
    await expect(activeTabName(win)).toHaveText('api');
    // A sidebar click opens the preview tab.
    await expect(tabNamed(win, 'api')).toHaveClass(/is-preview/);
    await expect(win.locator('.dk-ln', { hasText: 'checkout failed' })).toHaveClass(/lv-error/, { timeout: 10000 });
    await expect(win.locator('.dk-ln', { hasText: 'POST /api/checkout' }).locator('.dk-status.s5')).toHaveText('500');
    await expect(win.locator('.dk-fold')).toContainText('3 more frames');
    await expect(win.locator('.dk-ln', { hasText: 'slow query 412 ms' }).locator('.dk-json-chip')).toHaveText('{…} 3 keys');
    await expect(win.locator('.dk-seg-n.is-err')).toHaveText('4');
    // The stats strip fills from the stats stream.
    await expect(win.locator('.dk-stat').first().locator('.dk-stat-v')).toHaveText(/%$/, { timeout: 10000 });
    await shot(win, 'logs');

    // Select the error and its first frame: the bar offers to send them to Claude.
    await win.locator('.dk-ln', { hasText: 'checkout failed' }).click();
    await win.locator('.dk-ln', { hasText: 'at verify' }).click({ modifiers: ['Shift'] });
    await expect(win.locator('.dk-selbar')).toContainText('2 lines');
    // Centred over the lines, once its entrance animation is over.
    await win.waitForTimeout(400);
    const bar = (await win.locator('.dk-selbar').boundingBox())!;
    const pane = (await win.locator('.dk-logs').boundingBox())!;
    expect(Math.abs(bar.x + bar.width / 2 - (pane.x + pane.width / 2))).toBeLessThan(2);
    await shot(win, 'selection');
    await win.keyboard.press('Escape');
    await expect(win.locator('.dk-selbar')).toHaveCount(0);

    // Errors only: errors and their frames.
    await win.locator('.dk-seg button', { hasText: 'Errors' }).click();
    await expect(win.locator('.dk-ln.lv-error')).toHaveCount(4);
    // Warnings only: as many lines as the count says, no error among them.
    await win.locator('.dk-seg button', { hasText: 'Warnings' }).click();
    await expect(win.locator('.dk-ln.lv-error')).toHaveCount(0);
    await expect(win.locator('.dk-ln.lv-warn')).toHaveCount(Number(await win.locator('.dk-seg-n.is-warn').textContent()));
    await win.locator('.dk-seg button', { hasText: 'All' }).click();

    // A new line arrives live.
    fake.log(ids.api!, 'GET /api/live-check 204 0.8 ms');
    await expect(win.locator('.dk-ln', { hasText: '/api/live-check' })).toBeVisible({ timeout: 5000 });

    // A line too long for the pane shows a chevron on hover (a short one doesn't): it shows the line whole, again folds
    // it, without picking it; → and ← do the same on the picked line.
    fake.log(ids.api!, `warn: cache miss for ${Array.from({ length: 60 }, (_, i) => `products:page:${i}`).join(',')} END-OF-LINE`);
    const long = win.locator('.dk-ln', { hasText: 'cache miss for' });
    await expect(long).toBeVisible({ timeout: 5000 });
    await win.locator('.dk-ln', { hasText: '/api/live-check' }).hover();
    await expect(win.locator('.dk-ln', { hasText: '/api/live-check' }).locator('.dk-more')).toHaveCount(0);
    await long.hover();
    const more = long.locator('.dk-more');
    await expect(more).toBeVisible();
    await look(win, join(SHOTS, 'expand-hover.png'), { settle: 200 });
    await expect(more).toHaveAttribute('aria-expanded', 'false');
    const folded = (await long.boundingBox())!.height;
    await more.click();
    await expect(long).toHaveClass(/is-expanded/);
    await expect(more).toHaveAttribute('aria-expanded', 'true');
    expect((await long.boundingBox())!.height).toBeGreaterThan(folded * 2);
    await expect(long).toBeInViewport({ ratio: 1 });
    await expect(win.locator('.dk-selbar')).toHaveCount(0);
    await shot(win, 'expanded');
    await more.click();
    await expect(long).not.toHaveClass(/is-expanded/);
    expect((await long.boundingBox())!.height).toBe(folded);
    await long.click();
    await win.keyboard.press('ArrowRight');
    await expect(long).toHaveClass(/is-expanded/);
    await win.keyboard.press('ArrowLeft');
    await expect(long).not.toHaveClass(/is-expanded/);
    await win.keyboard.press('Escape');

    // The whole stack, merged in time, each line tagged with its service.
    await win.locator('.dk-group.is-mine .dk-row.is-stack').click();
    await expect(activeTabName(win)).toHaveText('acme-store');
    // It took the preview's place: api's tab is gone.
    await expect(tabNamed(win, 'api')).toHaveCount(0);
    await expect(win.locator('.dk-svc', { hasText: 'postgres' }).first()).toBeVisible({ timeout: 10000 });
    await expect(win.locator('.dk-svc', { hasText: 'redis' }).first()).toBeVisible();
    await shot(win, 'stack');

    // The crashed worker: Inspect says why, masks secrets, points at the localhost mistake.
    await row(win, 'worker').click();
    await win.locator('.dk-views button', { hasText: 'Inspect' }).click();
    // Switching its view keeps it: no preview any more.
    await expect(tabNamed(win, 'worker')).not.toHaveClass(/is-preview/);
    await expect(win.locator('.dk-why')).toContainText('Why it stopped');
    await expect(win.locator('.dk-why .dk-fact').first()).toHaveText('1');
    await expect(win.locator('.dk-why-lines')).toContainText('ECONNREFUSED');
    await expect(win.locator('.dk-env-row', { hasText: 'STRIPE_KEY' }).locator('.dk-mask')).toBeVisible();
    await expect(win.locator('.dk-env-row', { hasText: 'DATABASE_URL' })).toContainText('postgres://acme:');
    await expect(win.locator('.dk-env-row', { hasText: 'DATABASE_URL' })).not.toContainText('s3cr3t-pass');
    await expect(win.locator('.dk-env-row.has-hint')).toContainText('did you mean redis:6379?');
    await expect(win.locator('.dk-kv', { hasText: 'Compose' })).toContainText('compose.yml:17');
    await shot(win, 'inspect');
    // The eye shows one secret.
    await win.locator('.dk-env-row', { hasText: 'STRIPE_KEY' }).getByRole('button').click();
    await expect(win.locator('.dk-env-row', { hasText: 'STRIPE_KEY' })).toContainText('sk_test_51Hx0000');

    // The engine overview: stacks, resources, disk, events.
    await win.locator('.dk-engine-chip').click();
    await expect(win.locator('.dk-stack-card')).toHaveCount(2);
    await expect(win.locator('.dk-disk-legend')).toContainText('Build cache', { timeout: 10000 });
    await expect(win.locator('.dk-table .dk-tr:not(.dk-th)')).toHaveCount(6, { timeout: 10000 });
    fake.event(ids.web!, 'restart');
    await expect(win.locator('.dk-ev', { hasText: 'restart' })).toBeVisible();
    await shot(win, 'overview');

    // Nothing on screen, nothing streamed: another view in the sidebar, another tab in front.
    await row(win, 'api').click();
    await expect.poll(() => fake.streaming('/stats'), { timeout: 10000 }).toBeGreaterThan(0);
    await win.locator('.activity-bar .act').first().click();
    // Sessions is a space of its own: no Docker tab among its tabs.
    await expect(win.locator('.tabs .tab[data-key^="dk:"]')).toHaveCount(0);
    await win.locator('.btn-new').click();
    await win.getByRole('menuitem', { name: /^Terminal(?! with)/ }).first().click();
    await expect.poll(() => fake.streaming('/stats'), { timeout: 10000 }).toBe(0);
    // Back: Docker's tabs as left, no terminal among them; the lines are there at once (main kept them).
    await dockerIcon(win).click();
    await expect(win.locator('.tabs .tab[data-key^="t:"]')).toHaveCount(0);
    await tabNamed(win, 'api').click();
    await expect(win.locator('.dk-ln', { hasText: 'checkout failed' })).toBeVisible({ timeout: 2000 });

    expect(fake.nonGet()).toEqual([]);
  } finally {
    await stop(app, home);
    await fake.close();
  }
});

test('Docker → Claude: selected lines typed into a session; a crash lands in the notification center; the palette finds containers', async () => {
  mkdirSync(SHOTS, { recursive: true });
  const dir = mkdtempSync(join(tmpdir(), 'dk-'));
  const fake = await FakeDocker.start(join(dir, 'd.sock'));
  const { app, home, root, win } = await launch(fake.socket, { ATELIER_CLAUDE_BIN: resolve('tests/e2e/fake-claude-prompt.pl') });
  const ids = stageDocker(fake, root);
  try {
    // A Claude session waiting at its prompt.
    await win.locator('.btn-new').click();
    await win.getByRole('menuitem', { name: 'Claude Session' }).click();
    // A long name, as sessions get: Send to it must stay in its bar (a beta report on Redis' bar, the same one).
    await win.getByPlaceholder('Session name (optional)').fill('debug · checkout answers 401 after the token refresh, see INC-2231 and the api logs from 20:50');
    await win.keyboard.press('Enter');
    await expect(win.locator('.session-row', { hasText: 'debug' })).toHaveClass(/state-done/, { timeout: 20000 });

    await dockerIcon(win).click();
    await row(win, 'api').click();
    await win.locator('.dk-ln', { hasText: 'checkout failed' }).click();
    await win.locator('.dk-ln', { hasText: 'at checkout' }).click({ modifiers: ['Shift'] });
    await expect(win.locator('.dk-selbar')).toContainText('3 lines');
    await expect(win.locator('.dk-selbar .btn-primary')).toContainText('Send to debug');
    // A narrower window: the name ends in an ellipsis, every button stays in the bar whole, the bar in the view. (Changes,
    // Sessions' own, takes no room in Docker: the window is narrower for the same view.)
    await win.setViewportSize({ width: 700, height: 900 });
    await expect.poll(async () => (await win.locator('.dk-view:visible').boundingBox())!.width).toBeLessThan(420);
    const view = (await win.locator('.dk-view:visible').boundingBox())!;
    const selbar = (await win.locator('.dk-selbar').boundingBox())!;
    expect(selbar.x, 'the bar starts inside the view').toBeGreaterThanOrEqual(view.x);
    expect(selbar.x + selbar.width, 'the bar ends inside the view').toBeLessThanOrEqual(view.x + view.width + 0.5);
    for (const el of await win.locator('.dk-selbar button:visible').all()) {
      const name = `"${(await el.innerText()).trim() || await el.getAttribute('aria-label')}"`;
      const r = (await el.boundingBox())!;
      expect(r.x + r.width, `${name} ends inside the bar`).toBeLessThanOrEqual(selbar.x + selbar.width + 0.5);
      expect(await el.evaluate((e) => e.scrollWidth - e.clientWidth), `${name} holds its content`).toBeLessThanOrEqual(1);
    }
    const label = win.locator('.dk-selbar .btn-primary .dk-ellipsis');
    await expect(label).toHaveText(/^Send to debug/);
    expect(await label.evaluate((e) => e.scrollWidth > e.clientWidth), 'the name ends in an ellipsis').toBe(true);
    // The head and the logs' toolbar at that width: the container's name whole (it shrank to nothing), every button
    // inside the view (Inspect and the menu ran off its edge, the toolbar's last chip too).
    const front = win.locator('.dk-view:visible');
    await expect(front.locator('.dk-head .dk-name')).toHaveText('api');
    expect(await front.locator('.dk-head .dk-name').evaluate((e) => e.clientWidth > 0 && e.scrollWidth <= e.clientWidth), 'the name is whole').toBe(true);
    for (const el of await front.locator('.dk-head button:visible, .dk-toolbar button:visible, .dk-toolbar .dk-search').all()) {
      const name = `"${(await el.innerText()).trim() || await el.getAttribute('aria-label') || 'filter'}"`;
      const r = (await el.boundingBox())!;
      expect(r.x, `${name} starts inside the view`).toBeGreaterThanOrEqual(view.x);
      expect(r.x + r.width, `${name} ends inside the ${Math.round(view.width)} px view`).toBeLessThanOrEqual(view.x + view.width + 0.5);
    }
    // Two lines, the filter above the rest, also with the longest time range.
    // Lines: items' middles more than 8 px apart (on one line they differ by their heights).
    const rows = () => win.locator('.dk-toolbar > :visible').evaluateAll((els) => els.filter((e) => e.getBoundingClientRect().width > 0)
      .map((e) => { const r = e.getBoundingClientRect(); return (r.top + r.bottom) / 2; }).sort((a, b) => a - b)
      .reduce((n, y, i, ys) => n + (i > 0 && y - ys[i - 1]! > 8 ? 1 : 0), 1));
    expect(await rows(), 'the toolbar on two lines').toBe(2);
    await win.locator('.dk-toolbar').getByRole('button', { name: /^Since/ }).click();
    await win.getByRole('menuitem', { name: '15 min' }).click();
    await expect(win.locator('.dk-toolbar')).toContainText('Last 15 min');
    expect(await rows(), 'the toolbar on two lines with "Last 15 min"').toBe(2);
    await shot(win, 'narrow-head');
    await win.locator('.dk-toolbar').getByRole('button', { name: /^Since/ }).click();
    await win.getByRole('menuitem', { name: 'All', exact: true }).click();
    await expect(win.locator('.dk-toolbar')).toContainText('All lines');
    await win.setViewportSize({ width: 1440, height: 900 });
    await win.locator('.dk-selbar .btn-primary').click();
    // The session comes to the front with the lines in its prompt, not sent.
    await expect(win.locator('.session-row.is-selected', { hasText: 'debug' })).toBeVisible();
    await expect(win.locator('.xterm-rows:visible')).toContainText('Lines from the logs of the Docker container `api`', { timeout: 10000 });
    await expect(win.locator('.xterm-rows:visible')).toContainText('TokenExpiredError: jwt expired');
    await expect(win.locator('.xterm-rows:visible')).not.toContainText('FAKE-CLAUDE submitted');

    // The api crashes (exit 1, no kill before it): an entry in the notification center, with its last error line.
    fake.log(ids.api!, 'Error: Cannot find module \'./routes/legacy\'', true);
    fake.change(ids.api!, { name: 'api', project: 'acme-store', workingDir: root, configFiles: [join(root, 'compose.yml')], image: 'acme/api:dev', state: 'exited', exitCode: 1 }, [{ action: 'die', attrs: { exitCode: '1' } }]);
    const bell = win.locator('.bell-btn');
    await expect(bell.locator('.bell-count')).toHaveText('1', { timeout: 10000 });
    await bell.click();
    const note = win.locator('.notes-pop .note-row').first();
    await expect(note).toContainText('api');
    await expect(note).toContainText('Exited (1) · Error: Cannot find module');
    await expect(note.locator('.note-whale')).toBeVisible();
    await shot(win, 'notification');
    await note.click();
    // It opens the container's Inspect, and the entry is read.
    await expect(win.locator('.dk-why')).toBeVisible();
    await expect(activeTabName(win)).toHaveText('api');
    await expect(bell.locator('.bell-count')).toHaveCount(0);
    await expect(win.locator('.activity-bar .act-docker .act-dot.is-error')).toBeVisible();

    // A docker stop (kill, then die 143) never notifies.
    fake.event(ids.web!, 'kill', { signal: '15' });
    fake.event(ids.web!, 'die', { exitCode: '143' });
    await win.waitForTimeout(800);
    await expect(bell.locator('.bell-count')).toHaveCount(0);

    // The palette: containers by name; Enter shows the logs.
    await win.keyboard.press('F1');
    await win.locator('.palette-input').fill('postg');
    await expect(win.locator('.palette-section', { hasText: 'Containers' })).toBeVisible();
    const item = win.locator('.palette-item', { hasText: 'postgres' }).first();
    await expect(item).toContainText('acme-store · Show Logs');
    await shot(win, 'palette');
    await win.keyboard.press('Enter');
    await expect(activeTabName(win)).toHaveText('postgres');
    await expect(win.locator('.dk-ln', { hasText: 'order_items_v2' }).first()).toBeVisible({ timeout: 10000 });
    // Its commands, with the shortcut.
    await win.keyboard.press('F1');
    await win.locator('.palette-input').fill('>docker');
    await expect(win.locator('.palette-item', { hasText: 'Docker: Engine Overview' })).toBeVisible();
    await expect(win.locator('.palette-item', { hasText: /^Docker⌃⇧D$/ })).toBeVisible();
    await win.keyboard.press('Escape');

    // The whole stack and Inspect in the narrow window: nothing off the view's edge either (looked at in the shots). No
    // Changes in Docker: a narrower window for the same view.
    await win.setViewportSize({ width: 860, height: 900 });
    await expect.poll(async () => (await win.locator('.dk-view:visible').boundingBox())!.width).toBeLessThan(560);
    const inView = async (where: string) => {
      const v = (await win.locator('.dk-view:visible').boundingBox())!;
      for (const el of await win.locator('.dk-head > :visible, .dk-toolbar > :visible').all()) {
        const r = (await el.boundingBox())!;
        expect(r.x + r.width, `${where}: "${(await el.innerText()).trim()}" ends inside the view`).toBeLessThanOrEqual(v.x + v.width + 0.5);
      }
    };
    await win.locator('.dk-view:visible .dk-views button', { hasText: 'Inspect' }).click();
    await expect(win.locator('.dk-view:visible').locator('.dk-why, .dk-inspect').first()).toBeVisible();
    await inView('Inspect');
    await shot(win, 'narrow-inspect');
    await win.getByText('Whole stack').click();
    await expect(win.locator('.dk-view:visible .dk-head .dk-name')).toHaveText('acme-store');
    await inView('the stack');
    await shot(win, 'narrow-stack');
    await win.setViewportSize({ width: 1440, height: 900 });

    expect(fake.nonGet()).toEqual([]);
  } finally {
    await stop(app, home);
    await fake.close();
  }
});

test('Docker ports: a terminal running docker in the compose folder shows the stack\'s published ports; the footer sums it up', async () => {
  mkdirSync(SHOTS, { recursive: true });
  const dir = mkdtempSync(join(tmpdir(), 'dk-'));
  const fake = await FakeDocker.start(join(dir, 'd.sock'));
  // A stand-in `docker`, first on PATH: the test's own node binary under that name (an APFS clone: instant, no
  // space), so the terminal's foreground process is called docker, as the real CLI's is.
  const bin = mkdtempSync(join(tmpdir(), 'dk-bin-'));
  copyFileSync(process.execPath, join(bin, 'docker'), constants.COPYFILE_FICLONE);
  chmodSync(join(bin, 'docker'), 0o755);
  const { app, home, root, win } = await launch(fake.socket);
  stageDocker(fake, root);
  try {
    await expect(win.locator('.footer .foot-item', { hasText: 'docker 5/6 · 1 failed' })).toBeVisible({ timeout: 15000 });
    await win.getByRole('button', { name: 'Open a terminal' }).click();
    await expect(win.locator('.term-row')).toHaveCount(1, { timeout: 10000 });
    await expect(win.locator('.term-row .dk-port-chips')).toHaveCount(0);
    await win.locator('.xterm-helper-textarea:visible').focus();
    const screen = () => win.locator('.xterm-rows:visible').evaluate((el) => el.textContent ?? '');
    // Typed before zsh draws its prompt (the Atelier prompt's ›), the first keys can be lost ("cho SHELLREADY").
    await expect.poll(screen, { timeout: 15000 }).toContain('›');
    // The shell is ready once it ran a first command (the echo prints what the typed line does not contain).
    await win.keyboard.type('echo SHELL""READY\n');
    await expect.poll(screen, { timeout: 15000 }).toContain('SHELLREADY');
    await win.keyboard.type(`PATH='${bin}':$PATH docker -e 'setTimeout(() => {}, 60000)'\n`);
    // The row, short of room: one whale chip with the count; its menu lists them.
    const chip = win.locator('.term-row .dk-port-chips .port-chip');
    await expect(chip).toHaveText('6', { timeout: 15000 });
    await chip.click();
    await expect(win.getByRole('menuitem', { name: 'Open localhost:3000 · api' })).toBeVisible();
    await win.keyboard.press('Escape');
    await shot(win, 'ports');
    await win.locator('.footer .foot-item', { hasText: 'docker 5/6' }).click();
    await expect(activeTabName(win)).toHaveText('acme-store');
  } finally {
    await stop(app, home);
    await fake.close();
  }
});

test('Docker states: hidden without an engine (Auto), shown on Always; an engine that starts and stops; Settings › Docker', async () => {
  mkdirSync(SHOTS, { recursive: true });
  const dir = mkdtempSync(join(tmpdir(), 'dk-'));
  const socket = join(dir, 'd.sock');
  const { app, home, root, win } = await launch(socket, { ATELIER_TEST_DOCKER_PROBE_MS: '500' });
  let fake: FakeDocker | null = null;
  try {
    await expect(win.locator('.activity-bar')).toBeVisible({ timeout: 15000 });
    // Past a probe (every 500 ms here).
    await win.waitForTimeout(800);
    // Auto with no engine anywhere: no icon at all.
    await expect(dockerIcon(win)).toHaveCount(0);
    // Always: the icon, and a sidebar that says what to do.
    await win.locator('.activity-bar .act-bottom').click();
    await win.locator('.set-nav-item', { hasText: 'Docker' }).click();
    await win.locator('.set-row', { hasText: 'Show Docker' }).getByRole('radio', { name: 'Always' }).click();
    await win.keyboard.press('Escape');
    await expect(dockerIcon(win)).toBeVisible();
    await dockerIcon(win).click();
    await expect(win.locator('.dk-state.is-compact .dk-state-title')).toHaveText('No Docker engine found');
    await shot(win, 'absent');

    // An engine comes up: the icon appears without a reload.
    fake = await FakeDocker.start(socket);
    stageDocker(fake, root);
    await expect(dockerIcon(win)).toBeVisible({ timeout: 10000 });
    // Docker is still in front: its list fills in by itself (a click on the item in front would hide the sidebar).
    await expect(dockerIcon(win)).toHaveClass(/is-active/);
    await expect(row(win, 'api')).toBeVisible();
    await row(win, 'api').click();
    await expect(win.locator('.dk-ln').first()).toBeVisible({ timeout: 10000 });

    // It stops: the sidebar and the tab say so, and wait for it.
    await fake.close();
    fake = null;
    await expect(win.locator('.dk-state.is-compact .dk-state-title')).toHaveText('Docker isn’t running', { timeout: 10000 });
    await expect(win.locator('.dk-view:visible .dk-state-title')).toHaveText('Docker isn’t running');
    await expect(win.locator('.dk-state-wait').first()).toContainText('waiting on');
    await shot(win, 'stopped');

    // Back: running again, the tab shows its container.
    fake = await FakeDocker.start(socket);
    stageDocker(fake, root);
    await expect(row(win, 'api')).toBeVisible({ timeout: 10000 });
    await expect(win.locator('.dk-view:visible .dk-name')).toHaveText('api');

    // Settings › Docker: Never hides the view.
    await win.locator('.activity-bar .act-bottom').click();
    await win.locator('.set-nav-item', { hasText: 'Docker' }).click();
    await expect(win.locator('.set-row', { has: win.getByRole('radiogroup', { name: 'Engine' }) })).toContainText('d.sock');
    await shot(win, 'settings');
    await win.locator('.set-row', { hasText: 'Show Docker' }).getByRole('radio', { name: 'Never' }).click();
    await win.keyboard.press('Escape');
    // The view goes at once and Sessions comes forward, its sidebar shown.
    await expect(win.locator('.activity-bar .act.is-active')).toHaveAttribute('aria-label', /^Sessions/);
    await expect(win.locator('.body > .sidebar.is-sessions')).toBeVisible();
    await expect(dockerIcon(win)).toHaveCount(0);
    const before = fake.requests.length;
    // Longer than a probe's interval (500 ms here).
    await win.waitForTimeout(800);
    // Never: no request at all.
    expect(fake.requests.length).toBe(before);
    expect(fake.nonGet()).toEqual([]);
  } finally {
    await stop(app, home);
    await fake?.close();
  }
});
