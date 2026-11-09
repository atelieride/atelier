import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { e2eEnv } from './env';
import { FakeDocker } from '../support/fake-docker';
import { stageDocker, writeProject } from './docker-fixture';

// Product screenshots of the Docker view, at 2× like the site's: the real app, a fictional
// project, a fake engine. Run: npm run build && npx playwright test --config playwright.manual.config.ts
// tests/e2e/docker-shots.manual.ts — every PNG is looked at.
const OUT = resolve('e2e-shots/docker-view-product');
const WINDOW = { width: 1440, height: 900 };

async function shot(win: Page, name: string) {
  await win.mouse.move(WINDOW.width - 4, WINDOW.height - 4);
  await win.waitForTimeout(450);
  await win.screenshot({ path: join(OUT, `${name}.png`) });
}

test('Docker view, product shots', async () => {
  mkdirSync(OUT, { recursive: true });
  const dir = mkdtempSync(join(tmpdir(), 'dk-'));
  const fake = await FakeDocker.start(join(dir, 'd.sock'));
  const parent = mkdtempSync(join(tmpdir(), 'atl-prj-'));
  const root = join(parent, 'acme-store');
  mkdirSync(root);
  writeProject(root);
  const ids = stageDocker(fake, root);
  const { env, home } = e2eEnv({ ATELIER_TEST_DOCKER_SOCKET: fake.socket, ATELIER_CLAUDE_BIN: resolve('tests/e2e/fake-claude-prompt.pl') });
  const app: ElectronApplication = await electron.launch({ args: ['--force-device-scale-factor=2', 'out/main/index.js', `--project=${root}`], env });
  try {
    const win = await app.firstWindow();
    await app.evaluate(({ BrowserWindow }, s) => BrowserWindow.getAllWindows()[0]!.setContentSize(s.width, s.height), WINDOW);
    // A session to send lines to.
    await win.locator('.btn-new').click();
    await win.getByRole('menuitem', { name: 'Claude Session' }).click();
    await win.getByPlaceholder('Session name (optional)').fill('checkout-bug');
    await win.keyboard.press('Enter');
    await expect(win.locator('.session-row', { hasText: 'checkout-bug' })).toHaveClass(/state-done/, { timeout: 20000 });
    // Changes hidden: the Docker tab gets the room.
    await win.getByRole('button', { name: 'Changes (⌘⇧M)' }).click();

    await win.locator('.activity-bar .act-docker').click();
    await win.locator('.dk-row', { hasText: 'api' }).first().click();
    await expect(win.locator('.dk-ln', { hasText: 'checkout failed' })).toBeVisible({ timeout: 10000 });
    await expect(win.locator('.dk-stat').first().locator('.dk-stat-v')).toHaveText(/%$/, { timeout: 10000 });
    await win.waitForTimeout(6000);
    await shot(win, '01-logs');

    // On the time column: the end of a frame's text holds its "open the file" button.
    await win.locator('.dk-ln', { hasText: 'checkout failed' }).click({ position: { x: 40, y: 8 } });
    await win.locator('.dk-ln', { hasText: 'at checkout' }).click({ position: { x: 40, y: 8 }, modifiers: ['Shift'] });
    await expect(win.locator('.dk-selbar')).toBeVisible();
    await shot(win, '02-selection');

    await win.locator('.dk-selbar .btn-primary').click();
    await expect(win.locator('.xterm-rows:visible')).toContainText('TokenExpiredError', { timeout: 10000 });
    await shot(win, '03-sent-to-claude');

    await win.locator('.activity-bar .act-docker').click();
    await win.locator('.dk-group.is-mine .dk-row.is-stack').click();
    await expect(win.locator('.dk-svc', { hasText: 'postgres' }).first()).toBeVisible({ timeout: 10000 });
    await win.waitForTimeout(3000);
    await shot(win, '04-stack');

    await win.locator('.dk-row', { hasText: 'worker' }).first().click();
    await win.locator('.dk-views button', { hasText: 'Inspect' }).click();
    await expect(win.locator('.dk-why')).toBeVisible();
    await expect(win.locator('.dk-env-row.has-hint')).toBeVisible();
    await shot(win, '05-inspect');

    await win.locator('.dk-engine-chip').click();
    await expect(win.locator('.dk-disk-legend')).toBeVisible({ timeout: 10000 });
    fake.event(ids.web!, 'restart');
    await win.waitForTimeout(4000);
    await shot(win, '06-overview');

    fake.log(ids.api!, 'Error: Cannot find module \'./routes/legacy\'', true);
    fake.change(ids.api!, { name: 'api', project: 'acme-store', workingDir: root, configFiles: [join(root, 'compose.yml')], image: 'acme/api:dev', state: 'exited', exitCode: 1, restarts: 1, restartPolicy: 'unless-stopped' }, [{ action: 'die', attrs: { exitCode: '1' } }]);
    await expect(win.locator('.bell-btn .bell-count')).toHaveText('1', { timeout: 10000 });
    await win.locator('.bell-btn').click();
    await expect(win.locator('.notes-pop .note-row').first()).toContainText('api');
    await shot(win, '07-notification');
    await win.keyboard.press('Escape');

    await win.keyboard.press('F1');
    await win.locator('.palette-input').fill('redis');
    await expect(win.locator('.palette-section', { hasText: 'Containers' })).toBeVisible();
    await shot(win, '08-palette');
    await win.keyboard.press('Escape');

    await win.locator('.activity-bar .act-bottom').click();
    await win.locator('.set-nav-item', { hasText: 'Docker' }).click();
    await shot(win, '09-settings');
  } finally {
    await app.close();
    try { process.kill((JSON.parse(readFileSync(join(home, 'atelierd.json'), 'utf8')) as { pid: number }).pid, 'SIGTERM'); } catch { /* already stopped */ }
    await fake.close();
  }
});
