import { _electron as electron, expect, test, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { e2eEnv, writePrefs } from './env';

// Screenshots of the UI the Oct 14 polish batch changed, for review by eye.
// Run: npx playwright test --config playwright.manual.config.ts tests/e2e/polish-shots.manual.ts
// Written to e2e-shots/polish-batch (git-ignored). Fictional projects in the run's temp root; test tmux server.

const OUT = resolve('e2e-shots/polish-batch');
type Api = { terminals: { list(): Promise<{ id: string; title: string }[]>; input(id: string, data: string): void } };
const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const git = (cwd: string, ...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd, env: gitEnv });

async function typeInto(win: Page, title: string, text: string) {
  await win.evaluate(async ({ title, text }) => {
    const api = (window as unknown as { atelier: Api }).atelier;
    const id = (await api.terminals.list()).find((x) => x.title === title)!.id;
    api.terminals.input(id, text);
  }, { title, text });
}

async function newSession(win: Page, name: string) {
  await win.locator('.btn-new').click();
  await win.getByRole('menuitem', { name: 'Claude Session' }).click();
  await win.getByPlaceholder('Session name (optional)').fill(name);
  await win.keyboard.press('Enter');
  await expect(win.locator('.session-row', { hasText: name })).toBeVisible({ timeout: 15000 });
}

/** Animations over (entrances, flashes, fades), so the shot shows the resting state. */
const settle = (win: Page, ms = 700) => win.waitForTimeout(ms);
const shot = (win: Page, name: string, clip?: { x: number; y: number; width: number; height: number }) =>
  win.screenshot({ path: join(OUT, `${name}.png`), ...(clip ? { clip } : {}) });

test('polish batch screenshots', async () => {
  mkdirSync(OUT, { recursive: true });
  const tmuxDir = tmpdir();
  const server = `apsh-${process.pid}`;
  const tmuxEnv = { ...process.env, TMUX_TMPDIR: tmuxDir };
  delete (tmuxEnv as Record<string, string | undefined>).TMUX;
  const tmux = (...a: string[]) => execFileSync('tmux', ['-L', server, ...a], { env: tmuxEnv });

  const project = realpathSync(mkdtempSync(join(tmpdir(), 'atl-prj-')));
  git(project, 'init', '-q', '-b', 'main');
  for (const f of ['app.ts', 'sidebar.tsx', 'services.tsx']) writeFileSync(join(project, f), '1\n');
  writeFileSync(join(project, '.gitignore'), 'api.log\n');
  git(project, 'add', '.');
  git(project, 'commit', '-q', '-m', 'first');
  writeFileSync(join(project, 'app.ts'), '2\n');
  const apiLog = join(project, 'api.log');
  writeFileSync(apiLog, 'Server listening on port 3999\nGET /api/health 200 3ms\n');
  tmux('new-session', '-d', '-s', 'shots', '-x', '160', '-y', '40', '-c', project, `tail -n +1 -f '${apiLog}'`);
  tmux('select-pane', '-t', 'shots:0.0', '-T', 'api');

  const recentA = mkdtempSync(join(tmpdir(), 'atl-prj-billing-'));
  const recentB = mkdtempSync(join(tmpdir(), 'atl-prj-website-'));
  const { env, home } = e2eEnv({ TMUX_TMPDIR: tmuxDir, ATELIER_TMUX_SERVER: server, ATELIER_CLAUDE_BIN: resolve('tests/e2e/fake-claude.pl'), PATH: '/usr/bin:/bin:/usr/sbin:/sbin' });
  writePrefs(home, { showServices: true });
  delete env.TMUX;
  writeFileSync(join(home, 'ui-state.json'), JSON.stringify({ openProjects: [], recent: [recentA, recentB], quitInfoShown: true }));
  const app = await electron.launch({ args: ['out/main/index.js', `--project=${project}`], env });
  try {
    const win = await app.firstWindow();
    const sidebar = async () => (await win.locator('.sidebar').boundingBox())!;

    // Sessions, one pinned, finished ones showing their last message time.
    await win.getByRole('button', { name: 'Group by state' }).click();
    await newSession(win, 'Refactor the session sidebar layout and the pin badge');
    await newSession(win, 'Docs');
    await newSession(win, 'Fix the flaky services e2e');
    for (const n of ['Refactor the session sidebar layout and the pin badge', 'Docs']) await typeInto(win, n, '\r');
    const row = (n: string) => win.locator('.session-row', { hasText: n });
    await expect(row('Docs')).toHaveClass(/state-done/, { timeout: 10000 });
    await row('Refactor the session sidebar layout and the pin badge').click({ button: 'right' });
    await win.getByRole('menuitem', { name: 'Pin', exact: true }).click();
    await win.mouse.move(700, 500);
    await settle(win, 1200);
    const sb = await sidebar();
    await shot(win, '01-sidebar-pin-badge-and-last-message', { x: sb.x, y: sb.y, width: sb.width, height: 260 });
    await row('Fix the flaky services e2e').hover();
    await settle(win, 300);
    await shot(win, '02-sidebar-hover-buttons-over-title', { x: sb.x, y: sb.y, width: sb.width, height: 260 });
    await row('Refactor the session sidebar layout and the pin badge').hover();
    await settle(win, 300);
    await shot(win, '03-sidebar-hover-pinned-row', { x: sb.x, y: sb.y, width: sb.width, height: 260 });

    // The context ring at a low value, in the session bar.
    await row('Docs').locator('.row-main').click();
    await typeInto(win, 'Docs', 'ev:ctx:14\r');
    await expect(win.locator('.session-bar .ctx-ring')).toContainText('14%', { timeout: 10000 });
    await win.locator('.session-bar .ctx-ring').hover();
    await settle(win, 400);
    const bar = (await win.locator('.session-bar').boundingBox())!;
    await shot(win, '04-session-bar-context-14pct', { x: bar.x, y: bar.y, width: bar.width, height: bar.height });

    // A file joining Changes flashes in (shot mid-flash), and a collapsed group's count pulsing.
    const changes = win.locator('.changes');
    await expect(changes.locator('.change-row', { hasText: 'app.ts' })).toBeVisible({ timeout: 10000 });
    writeFileSync(join(project, 'sidebar.tsx'), '2\n');
    await expect(changes.locator('.change-row', { hasText: 'sidebar.tsx' })).toHaveClass(/\bis-new\b/, { timeout: 8000 });
    await win.waitForTimeout(120);
    const ch = (await changes.boundingBox())!;
    await shot(win, '05-changes-new-file-flash', { x: ch.x, y: ch.y, width: ch.width, height: 200 });

    // Services, a long error line cut, then shown whole, then the whole card wrapped.
    await win.getByRole('button', { name: 'Services (⌘⇧3)' }).click();
    const svc = win.locator('.svc-row', { hasText: 'api' });
    await expect(svc).toBeVisible({ timeout: 15000 });
    await svc.click();
    const grid = win.locator('.services-grid');
    appendFileSync(apiLog, `Error: [GET] /health >> StatusCode:: 401, ErrorCode:: AUTH_REQUIRED, message:: ${'token expired for the billing service, '.repeat(6)}retry after login\n`);
    const long = grid.locator('.log-line', { hasText: 'retry after login' });
    await expect(long).toBeVisible({ timeout: 10000 });
    const card = (await grid.locator('.svc-card').boundingBox())!;
    const cardClip = { x: card.x, y: card.y, width: card.width, height: 220 };
    await win.mouse.move(5, 500);
    await settle(win, 300);
    await shot(win, '06-services-long-line-cut', cardClip);
    await long.hover();
    await settle(win, 300);
    await shot(win, '07-services-hover-chevron-and-paste', cardClip);
    await long.locator('.log-text').click();
    await expect(long).toHaveClass(/\bis-expanded\b/);
    await settle(win, 300);
    await shot(win, '08-services-line-expanded', cardClip);
    await long.locator('.log-text').click();
    await grid.getByRole('button', { name: 'Wrap lines' }).click();
    await win.mouse.move(5, 500);
    await settle(win, 300);
    await shot(win, '09-services-wrap-lines', cardClip);
    await grid.locator('.svc-head').click({ button: 'right' });
    await settle(win, 300);
    const menu = (await win.locator('.ctx-menu').boundingBox())!;
    await shot(win, '10-services-card-menu', { x: card.x, y: card.y, width: Math.max(card.width / 2, menu.x + menu.width - card.x + 20), height: Math.max(160, menu.y + menu.height - card.y + 20) });
    await win.keyboard.press('Escape');

    // The welcome window, walked with the arrow keys.
    const [welcome] = await Promise.all([app.waitForEvent('window'), app.evaluate(({ Menu }) => Menu.getApplicationMenu()!.getMenuItemById('new-window')!.click())]);
    await expect(welcome.locator('.recent-row').nth(1)).toBeVisible();
    await welcome.keyboard.press('ArrowDown');
    await welcome.keyboard.press('ArrowDown');
    await settle(welcome, 500);
    await welcome.screenshot({ path: join(OUT, '11-welcome-arrow-keys.png') });
  } finally {
    await app.close();
    try { tmux('kill-server'); } catch { /* already stopped */ }
    try { process.kill((JSON.parse(readFileSync(join(home, 'atelierd.json'), 'utf8')) as { pid: number }).pid, 'SIGTERM'); } catch { /* already stopped */ }
  }
});
