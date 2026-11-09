import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { e2eEnv } from './env';
import { look } from './shots';

// Hiding the sidebar: the view in front clicked again hides it and the work area takes
// its width; any item shows it again; View › Sidebar (⌘B) and the palette toggle it; the choice is remembered.

async function launch(): Promise<{ app: ElectronApplication; home: string; win: Page }> {
  const project = mkdtempSync(join(tmpdir(), 'atl-prj-'));
  execFileSync('git', ['init', '-q', '-b', 'main', project]);
  writeFileSync(join(project, 'a.ts'), 'export const a = 1;\n');
  const { env, home } = e2eEnv();
  const app = await electron.launch({ args: ['out/main/index.js', `--project=${project}`], env });
  return { app, home, win: await app.firstWindow() };
}

async function stop(app: ElectronApplication, home: string) {
  await app.close();
  try { process.kill((JSON.parse(readFileSync(join(home, 'atelierd.json'), 'utf8')) as { pid: number }).pid, 'SIGTERM'); } catch { /* already stopped */ }
}

/** A menu command, as the native menu sends it (Playwright's keys never reach macOS's menu). */
const command = (app: ElectronApplication, cmd: string) => app.evaluate(({ BrowserWindow }, c) => BrowserWindow.getAllWindows()[0]!.webContents.send('ev:command', c), cmd);

test('the view in front clicked again hides the sidebar; an item, ⌘B and the palette show it; remembered on reload', async () => {
  const { app, home, win } = await launch();
  try {
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(1280, 800));
    const sidebar = win.locator('.body > .sidebar');
    const edge = win.getByRole('separator', { name: 'Resize sessions bar' });
    const bar = win.locator('.activity-bar');
    const item = (name: RegExp) => bar.getByRole('button', { name });
    const active = bar.locator('.act.is-active');
    const work = async () => Math.round((await win.locator('.body > .workspace').boundingBox())!.width);
    await expect(sidebar).toBeVisible();
    await expect(active).toHaveAttribute('aria-label', /^Sessions/);
    const narrow = await work();

    // The view in front clicked again: no sidebar, no edge, no item in front, the work area that much wider.
    await item(/^Sessions/).click();
    await expect(sidebar).toHaveCount(0);
    await expect(edge).toHaveCount(0);
    await expect(active).toHaveCount(0);
    await expect.poll(work).toBeGreaterThan(narrow + 200);
    await look(win, 'test-results/hide-sidebar-hidden.png', { animations: 'disabled' });

    // Another item: shown on its view.
    await item(/^Files/).click();
    await expect(sidebar).toBeVisible();
    await expect(sidebar.locator('.tree-row', { hasText: 'a.ts' })).toBeVisible();
    await expect(edge).toHaveCount(1);
    await expect(active).toHaveAttribute('aria-label', /^Files/);
    await expect.poll(work).toBe(narrow);

    // View › Sidebar (⌘B): hidden, then shown on the view it had.
    await command(app, 'toggle-sidebar');
    await expect(sidebar).toHaveCount(0);
    await expect(active).toHaveCount(0);
    await command(app, 'toggle-sidebar');
    await expect(sidebar.locator('.tree-row', { hasText: 'a.ts' })).toBeVisible();
    await expect(active).toHaveAttribute('aria-label', /^Files/);

    // The palette, with the key in its hint.
    await win.keyboard.press('F1');
    await win.locator('.palette-input').fill('>sidebar');
    const entry = win.locator('.palette-item', { hasText: 'Show or hide the sidebar' });
    await expect(entry.locator('.palette-hint')).toHaveText('⌘B');
    await win.keyboard.press('Enter');
    await expect(sidebar).toHaveCount(0);

    // Remembered: the window comes back hidden; a view key shows it.
    await win.reload();
    await expect(bar).toBeVisible({ timeout: 10000 });
    await expect(sidebar).toHaveCount(0);
    await expect(active).toHaveCount(0);
    await command(app, 'view-sessions');
    await expect(sidebar).toBeVisible();
    await expect(active).toHaveAttribute('aria-label', /^Sessions/);
    await look(win, 'test-results/hide-sidebar-shown.png', { animations: 'disabled' });
  } finally {
    await stop(app, home);
  }
});

test('hidden under the keyboard or a row\'s question: the keyboard goes to the terminal, the question to a popover and back; mirrored', async () => {
  const { app, home, win } = await launch();
  try {
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(1280, 800));
    const sidebar = win.locator('.body > .sidebar');
    const focused = () => win.evaluate(() => document.activeElement?.className ?? '');
    // A terminal running a program: closing it asks in its row.
    await win.getByRole('button', { name: 'Open a terminal' }).click();
    const row = win.locator('.term-row').first();
    await expect(row).toBeVisible({ timeout: 10000 });
    await win.locator('.xterm-helper-textarea:visible').focus();
    await win.keyboard.type('sleep 300');
    await win.keyboard.press('Enter');
    await expect(row.locator('.term-cmd')).toContainText('sleep', { timeout: 10000 });
    await row.hover();
    await row.locator('.row-close').click();
    const asking = win.locator('.term-row.is-confirming');
    await expect(asking).toContainText('sleep stops.');

    // Hidden: the question moves to a popover; shown again, back in its row.
    await command(app, 'toggle-sidebar');
    await expect(sidebar).toHaveCount(0);
    await expect(win.locator('.confirm-pop')).toContainText('sleep stops.');
    await command(app, 'toggle-sidebar');
    await expect(asking).toContainText('sleep stops.');
    await expect(win.locator('.confirm-pop')).toHaveCount(0);
    await asking.getByRole('button', { name: 'Cancel' }).click();
    await expect(asking).toHaveCount(0);

    // The keyboard in the sidebar (a button of its head) or on its edge: hidden, it lands in the terminal in front.
    for (const there of [sidebar.getByRole('button').first(), win.getByRole('separator', { name: 'Resize sessions bar' })]) {
      await there.focus();
      await command(app, 'toggle-sidebar');
      await expect(sidebar).toHaveCount(0);
      await expect.poll(focused).toContain('xterm-helper-textarea');
      await command(app, 'toggle-sidebar');
      await expect(sidebar).toBeVisible();
    }

    // Swap side panels: the sidebar on the right hides the same way, the work area takes its width.
    await win.evaluate(() => (window as unknown as { atelier: { settings: { set(p: object): Promise<unknown> } } }).atelier.settings.set({ swapSidePanels: true }));
    await expect(win.locator('.body')).toHaveClass(/is-swapped/);
    const work = async () => Math.round((await win.locator('.body > .workspace').boundingBox())!.width);
    const narrow = await work();
    await win.locator('.activity-bar .act.is-active').click();
    await expect(sidebar).toHaveCount(0);
    await expect.poll(work).toBeGreaterThan(narrow + 200);
    await look(win, 'test-results/hide-sidebar-swapped.png', { animations: 'disabled' });
  } finally {
    await stop(app, home);
  }
});
