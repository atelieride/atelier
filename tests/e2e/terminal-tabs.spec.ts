import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { e2eEnv } from './env';
import { look } from './shots';

async function launch(): Promise<{ app: ElectronApplication; home: string; project: string }> {
  const project = mkdtempSync(join(tmpdir(), 'atl-prj-'));
  for (const n of ['a.ts', 'b.md', 'c.json']) writeFileSync(join(project, n), `// ${n}\n`);
  const { env, home } = e2eEnv();
  const app = await electron.launch({ args: ['out/main/index.js', `--project=${project}`], env });
  return { app, home, project };
}

const command = (app: ElectronApplication, cmd: string) => app.evaluate(({ BrowserWindow }, c) => BrowserWindow.getAllWindows()[0]!.webContents.send('ev:command', c), cmd);

async function stop(app: ElectronApplication, home: string) {
  await app.close();
  try { process.kill((JSON.parse(readFileSync(join(home, 'atelierd.json'), 'utf8')) as { pid: number }).pid, 'SIGTERM'); } catch { /* already stopped */ }
}

test('a new terminal opens as a tab; closing the tab keeps the terminal in the sidebar, its row shows it again; Close Terminal… really closes', async () => {
  const { app, home } = await launch();
  try {
    const win = await app.firstWindow();
    await win.getByRole('button', { name: 'Open a terminal' }).click();
    await expect(win.locator('.term-row')).toHaveCount(1, { timeout: 10000 });
    await win.locator('.terminal-slot:visible .xterm-helper-textarea').focus();
    await win.keyboard.type('echo FIRST-$((40+2))\n');
    await expect(win.locator('.terminal-slot:visible .xterm-rows')).toContainText('FIRST-42', { timeout: 10000 });
    await win.locator('.tab-new').click();
    await win.getByRole('menuitem', { name: /^Terminal\s*⌘T$/ }).click();
    await expect(win.locator('.term-row')).toHaveCount(2, { timeout: 10000 });
    const termTabs = win.locator('.tab', { has: win.locator('.tab-term') });
    await expect(termTabs).toHaveCount(2);
    await expect(termTabs.first().locator('.tab-close')).toHaveAttribute('aria-label', 'Close tab');

    // The X of a tab hides it: no confirmation, the terminal keeps running and keeps its row.
    await termTabs.first().locator('.tab-close').click();
    await expect(termTabs).toHaveCount(1);
    // Still listed (the reload below proves it again, long after the click).
    await expect(win.locator('.term-row')).toHaveCount(2);
    // ⌘W (File › Close Tab) on the last tab: no tab left, the empty state with both rows still listed.
    await win.locator('.tab.is-active').click();
    await app.evaluate(({ Menu, BrowserWindow }) => {
      const walk = (items: Electron.MenuItem[]): Electron.MenuItem | undefined => {
        for (const it of items) { if (it.label === 'Close Tab') return it; const sub = it.submenu ? walk(it.submenu.items) : undefined; if (sub) return sub; }
        return undefined;
      };
      walk(Menu.getApplicationMenu()!.items)?.click(undefined, BrowserWindow.getAllWindows()[0]);
    });
    await expect(win.locator('.tab')).toHaveCount(0);
    await expect(win.locator('.workspace-empty')).toBeVisible();
    await expect(win.locator('.term-row')).toHaveCount(2);
    await expect(win.locator('.term-row.is-selected')).toHaveCount(0);
    await look(win, 'test-results/tabs-hidden-empty.png');

    // Clicking the first terminal's row brings its tab back, with its screen intact.
    await win.locator('.term-row .row-main').first().click();
    await expect(termTabs).toHaveCount(1);
    await expect(win.locator('.tab.is-active')).toHaveCount(1);
    await expect(win.locator('.workspace-empty')).toHaveCount(0);
    await expect(win.locator('.terminal-slot:visible .xterm-rows')).toContainText('FIRST-42');
    await expect(win.locator('.term-row').first()).toHaveClass(/is-selected/);

    // Remembered for the project: after a reload the second terminal's tab is still closed.
    await win.reload();
    await expect(win.locator('.term-row')).toHaveCount(2, { timeout: 10000 });
    await expect(termTabs).toHaveCount(1);
    await expect(win.locator('.terminal-slot:visible .xterm-rows')).toContainText('FIRST-42', { timeout: 10000 });

    // The tab menu: Close Others hides the other tab, Close Terminal… really closes (the sidebar row goes too).
    await win.locator('.term-row .row-main').nth(1).click();
    await expect(termTabs).toHaveCount(2);
    await termTabs.first().click({ button: 'right' });
    await win.getByRole('menuitem', { name: 'Close Others' }).click();
    await expect(termTabs).toHaveCount(1);
    await expect(win.locator('.term-row')).toHaveCount(2);
    await termTabs.first().click({ button: 'right' });
    await win.getByRole('menuitem', { name: 'Close Terminal…' }).click();
    await expect(win.locator('.term-row')).toHaveCount(1, { timeout: 10000 });
    await expect(termTabs).toHaveCount(0);
    await expect(win.locator('.workspace-empty')).toBeVisible();
  } finally {
    await stop(app, home);
  }
});

test('tab menus: Shift+F10 with Home/End and Tab; close to the right, close files; recent files in the palette', async () => {
  const { app, home } = await launch();
  try {
    const win = await app.firstWindow();
    await win.getByRole('button', { name: /^Files/ }).click();
    await win.locator('.tree-row', { hasText: 'a.ts' }).click();
    await win.locator('.tree-row', { hasText: 'b.md' }).click();
    // A file just opened from the tree already has focus: ⌘F opens search right away.
    await expect(win.locator('.file-view:visible .cm-content')).toBeFocused();
    await win.keyboard.press('Meta+f');
    await expect(win.locator('.cm-search')).toBeVisible();
    await win.keyboard.press('Escape');

    // The palette with an empty search lists recently opened files, without the active one.
    await command(app, 'open-palette');
    const recent = win.locator('.palette-list > div', { has: win.locator('.palette-section', { hasText: 'Recent files' }) });
    await expect(recent).toBeVisible();
    await expect(recent.locator('.palette-item')).toHaveCount(1);
    await expect(recent).toContainText('a.ts');
    await look(win, 'test-results/palette-palette-recent.png');
    await win.keyboard.press('Escape');
    await expect(win.locator('.palette')).toHaveCount(0);

    // Shift+F10 opens the menu of the focused tab; End goes to the last item, Tab closes the menu.
    await win.locator('.tab.is-active').focus();
    await win.keyboard.press('Shift+F10');
    await expect(win.locator('.ctx-menu')).toBeVisible();
    await win.keyboard.press('End');
    await expect(win.locator('.ctx-item.is-active')).toHaveText('Close All');
    await win.keyboard.press('Tab');
    await expect(win.locator('.ctx-menu')).toHaveCount(0);

    // Double click: normal tabs (a single click would reuse the preview tab).
    for (const n of ['a.ts', 'b.md', 'c.json']) await win.locator('.tree-row', { hasText: n }).dblclick();
    const fileTabs = win.locator('.tab', { has: win.locator('.file-icon') });
    await expect(fileTabs).toHaveCount(3);
    await fileTabs.first().click({ button: 'right' });
    await expect(win.locator('.ctx-menu')).toBeVisible();
    await win.getByRole('menuitem', { name: 'Close to the Right' }).click();
    await expect(fileTabs).toHaveCount(1);
    await expect(win.locator('.ctx-menu')).toHaveCount(0);
    // The menu also closes with Esc and by clicking outside.
    await fileTabs.first().click({ button: 'right' });
    await win.keyboard.press('Escape');
    await expect(win.locator('.ctx-menu')).toHaveCount(0);
    await fileTabs.first().click({ button: 'right' });
    await win.getByRole('menuitem', { name: 'Close Files' }).click();
    await expect(fileTabs).toHaveCount(0);
  } finally {
    await stop(app, home);
  }
});

test('palette with F1 (app menu), closed by a click on the top bar; + New → Terminal', async () => {
  const { app, home } = await launch();
  try {
    const win = await app.firstWindow();
    await expect(win.locator('.header')).toBeVisible();
    // Playwright's synthetic events do not go through the macOS menu: the menu item with F1 is used.
    const accel = await app.evaluate(({ Menu, BrowserWindow }) => {
      const walk = (items: Electron.MenuItem[]): Electron.MenuItem | undefined => {
        for (const it of items) { if (it.accelerator === 'F1') return it; const sub = it.submenu ? walk(it.submenu.items) : undefined; if (sub) return sub; }
        return undefined;
      };
      const item = walk(Menu.getApplicationMenu()!.items);
      item?.click(undefined, BrowserWindow.getAllWindows()[0]);
      return item?.accelerator ?? null;
    });
    expect(accel).toBe('F1');
    await expect(win.locator('.palette')).toBeVisible();
    await win.mouse.click(300, 20);
    await expect(win.locator('.palette')).toHaveCount(0);

    await win.locator('.btn-new').click();
    await win.getByRole('menuitem', { name: /^Terminal\s*⌘T$/ }).click();
    await expect(win.locator('.term-row')).toHaveCount(1, { timeout: 10000 });
  } finally {
    await stop(app, home);
  }
});

test('the menu does not close if something scrolls on its own, and on close focus returns to the terminal; Shift+F10 there sends nothing', async () => {
  const { app, home } = await launch();
  try {
    const win = await app.firstWindow();
    await win.getByRole('button', { name: 'Open a terminal' }).click();
    await expect(win.locator('.term-row')).toHaveCount(1, { timeout: 10000 });
    const tab = win.locator('.tab').first();
    await tab.click({ button: 'right' });
    await expect(win.locator('.ctx-menu')).toBeVisible();
    // A scrolling log or a reloaded file fires scroll events without the user touching anything.
    await win.evaluate(() => document.querySelector('.sidebar')?.dispatchEvent(new Event('scroll')));
    await win.waitForTimeout(200);
    await expect(win.locator('.ctx-menu')).toBeVisible();
    await win.keyboard.press('Escape');
    await expect(win.locator('.ctx-menu')).toHaveCount(0);

    await win.locator('.terminal-slot:visible').click();
    await win.locator('.terminal-slot:visible').click({ button: 'right' });
    await expect(win.locator('.ctx-menu')).toBeVisible();
    await win.keyboard.press('Escape');
    await win.keyboard.type('echo FOCUS-$((40+2))\n');
    await expect(win.locator('.xterm-rows')).toContainText('FOCUS-42', { timeout: 10000 });

    // Shift+F10 in the terminal opens the menu without sending the key sequence to the shell.
    await win.keyboard.type('echo A');
    await win.keyboard.press('Shift+F10');
    await expect(win.locator('.ctx-menu')).toBeVisible();
    await win.keyboard.press('Escape');
    await win.keyboard.type('B\n');
    await expect(win.locator('.xterm-rows')).toContainText('echo AB', { timeout: 10000 });
    await expect(win.locator('.xterm-rows')).not.toContainText('2~');
  } finally {
    await stop(app, home);
  }
});
