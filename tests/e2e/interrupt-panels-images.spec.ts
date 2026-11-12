import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { copyFileSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { e2eEnv } from './env';
import { look } from './shots';

// Ctrl+C brings an interrupted turn back to ready, the side panels swap, image files open as
// images. Settings › Notifications › Send Test is checked in change-navigation.spec.ts.

type Api = {
  terminals: { list(): Promise<{ id: string; title: string }[]>; input(id: string, data: string): void };
  settings: { set(patch: Record<string, unknown>): Promise<unknown> };
};

async function launch(setup: (project: string) => void = () => {}) {
  const project = mkdtempSync(join(tmpdir(), 'atl-prj-'));
  setup(project);
  const { env, home } = e2eEnv({ ATELIER_CLAUDE_BIN: resolve('tests/e2e/fake-claude-keys.pl') });
  const app = await electron.launch({ args: ['out/main/index.js', `--project=${project}`], env });
  const win = await app.firstWindow();
  // The window listens for menu commands once it shows its project.
  await expect(win.locator('.btn-new')).toBeVisible({ timeout: 20000 });
  return { app, home, win };
}

async function stop(app: ElectronApplication, home: string) {
  await app.close();
  try { process.kill((JSON.parse(readFileSync(join(home, 'atelierd.json'), 'utf8')) as { pid: number }).pid, 'SIGTERM'); } catch { /* already stopped */ }
}

const command = (app: ElectronApplication, cmd: string) => app.evaluate(({ BrowserWindow }, c) => BrowserWindow.getAllWindows()[0]!.webContents.send('ev:command', c), cmd);

async function typeInto(win: Page, title: string, text: string) {
  await win.evaluate(async ({ title, text }) => {
    const api = (window as unknown as { atelier: Api }).atelier;
    api.terminals.input((await api.terminals.list()).find((x) => x.title === title)!.id, text);
  }, { title, text });
}

test('Ctrl+C during a turn: Claude Code sends no hook, the session still comes back to ready at once', async () => {
  const { app, home, win } = await launch();
  try {
    await win.locator('.btn-new').click();
    await win.getByRole('menuitem', { name: 'Claude Session' }).click();
    await win.getByPlaceholder('Session name (optional)').fill('Stop me');
    await win.keyboard.press('Enter');
    const row = win.locator('.session-row', { hasText: 'Stop me' });
    await expect(row).toHaveClass(/state-done/, { timeout: 20000 });
    await typeInto(win, 'Stop me', 'work\r');
    await expect(row).toHaveClass(/state-running/, { timeout: 10000 });
    await typeInto(win, 'Stop me', '\x03');
    await expect(row).toHaveClass(/state-idle/, { timeout: 5000 });
    await expect(win.locator('.xterm-rows')).toContainText('Interrupted');
    // The next prompt is Claude Code's own state again.
    await typeInto(win, 'Stop me', 'work\r');
    await expect(row).toHaveClass(/state-running/, { timeout: 10000 });
  } finally {
    await stop(app, home);
  }
});

test('Esc before Claude wrote anything: the prompt comes back with no hook and no line drawn, the session is ready again', async () => {
  // An interrupted turn: the take-back is told by the quiet after the key (Claude's spinner otherwise draws).
  const { app, home, win } = await launch();
  try {
    await win.locator('.btn-new').click();
    await win.getByRole('menuitem', { name: 'Claude Session' }).click();
    await win.getByPlaceholder('Session name (optional)').fill('Take back');
    await win.keyboard.press('Enter');
    const row = win.locator('.session-row', { hasText: 'Take back' });
    await expect(row).toHaveClass(/state-done/, { timeout: 20000 });
    await typeInto(win, 'Take back', 'work\r');
    await expect(row).toHaveClass(/state-running/, { timeout: 10000 });
    await typeInto(win, 'Take back', '\x1b');
    await expect(row).toHaveClass(/state-idle/, { timeout: 5000 });
    await expect(win.locator('.xterm-rows')).not.toContainText('Interrupted');
    await look(win, 'test-results/interrupted-take-back.png');
    // The prompt it gave back, sent again: Claude Code's own state.
    await typeInto(win, 'Take back', '\r');
    await expect(row).toHaveClass(/state-running/, { timeout: 10000 });
  } finally {
    await stop(app, home);
  }
});

test('Swap side panels: Changes on the left, the sidebar and activity bar on the right; from Settings, the View menu and back', async () => {
  const { app, home, win } = await launch();
  try {
    await expect(win.locator('.sidebar')).toBeVisible();
    if ((await win.locator('.changes').count()) === 0) await command(app, 'toggle-changes');
    const box = async (sel: string) => (await win.locator(sel).first().boundingBox())!;
    const xs = async () => ({ activity: (await box('.activity-bar')).x, sidebar: (await box('.sidebar')).x, workspace: (await box('.workspace')).x, changes: (await box('.changes')).x });
    await expect(win.locator('.changes')).toBeVisible();
    let x = await xs();
    expect(x.activity < x.sidebar && x.sidebar < x.workspace && x.workspace < x.changes).toBe(true);

    await command(app, 'open-settings');
    await win.locator('.set-nav-item', { hasText: 'Appearance' }).click();
    await win.getByRole('switch', { name: 'Swap side panels' }).click();
    await expect(win.locator('.body')).toHaveClass(/is-swapped/);
    await win.keyboard.press('Escape');
    x = await xs();
    expect(x.changes < x.workspace && x.workspace < x.sidebar && x.sidebar < x.activity).toBe(true);
    // The active view's marker sits on the bar's outer edge, the right one now.
    await look(win, 'test-results/side-panels-swapped.png');

    // The sidebar's edge widens it when dragged left now.
    const before = (await box('.sidebar')).width;
    const edge = win.getByRole('separator', { name: 'Resize sessions bar' });
    const e = (await edge.boundingBox())!;
    await win.mouse.move(e.x + e.width / 2, e.y + 200);
    await win.mouse.down();
    await win.mouse.move(e.x + e.width / 2 - 60, e.y + 200, { steps: 4 });
    await win.mouse.up();
    expect((await box('.sidebar')).width).toBeGreaterThan(before + 40);

    await command(app, 'swap-side-panels');
    await expect(win.locator('.body')).not.toHaveClass(/is-swapped/);
  } finally {
    await stop(app, home);
  }
});

test('an image file opens as an image: fitted, at actual size on click, with its size; a broken one says so', async () => {
  const { app, home, win } = await launch((project) => {
    copyFileSync(resolve('build/icon.png'), join(project, 'screenshot.png'));
    writeFileSync(join(project, 'broken.png'), 'not an image');
  });
  try {
    await win.getByRole('button', { name: /^Files/ }).click();
    await win.locator('.tree-row', { hasText: 'screenshot.png' }).click();
    const img = win.locator('.image-stage img');
    await expect(img).toBeVisible();
    const natural = await img.evaluate((el: HTMLImageElement) => [el.naturalWidth, el.naturalHeight]);
    expect(natural[0]).toBeGreaterThan(0);
    await expect(win.locator('.image-view .file-foot')).toContainText(`${natural[0]} × ${natural[1]} px`);
    // Fitted: never larger than the stage.
    const stage = (await win.locator('.image-stage').boundingBox())!;
    const fitted = (await img.boundingBox())!;
    expect(fitted.width).toBeLessThanOrEqual(stage.width);
    expect(fitted.y + fitted.height).toBeLessThanOrEqual(stage.y + stage.height);
    await look(win, 'test-results/image-view.png');
    await img.click();
    await expect(win.getByRole('radio', { name: '100%' })).toHaveAttribute('aria-checked', 'true');
    await expect.poll(async () => (await img.boundingBox())!.width).toBeCloseTo(natural[0]!, 0);
    // The zoom is a radio group: arrows move and choose.
    await win.getByRole('radio', { name: '100%' }).focus();
    await win.keyboard.press('ArrowLeft');
    await expect(win.getByRole('radio', { name: 'Fit' })).toHaveAttribute('aria-checked', 'true');
    await expect(win.getByRole('radio', { name: 'Fit' })).toBeFocused();

    await win.locator('.tree-row', { hasText: 'broken.png' }).click();
    await expect(win.locator('.image-view .file-empty').filter({ visible: true })).toHaveText("This image can't be shown.");
  } finally {
    await stop(app, home);
  }
});
