import { _electron as electron, expect, test, type Page } from '@playwright/test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { e2eEnv } from './env';
import { look } from './shots';

// One project window, in turn: the empty workspace, the project name, New Window from the palette (then File › New
// Window: still one welcome window), New Claude Session from the palette, and last the interface at 125%.
test('empty workspace, Open in Finder, New Window (palette and menu) only once, New Claude Session centered, traffic lights at 125%', async () => {
  const project = mkdtempSync(join(tmpdir(), 'atl-prj-'));
  const log = join(mkdtempSync(join(tmpdir(), 'atl-log-')), 'open.log');
  const { env, home } = e2eEnv({ ATELIER_CLAUDE_BIN: resolve('tests/e2e/fake-claude.pl'), ATELIER_TEST_URL_LOG: log });
  const app = await electron.launch({ args: ['out/main/index.js', `--project=${project}`], env });
  try {
    const first = await app.firstWindow();
    await expect(first.getByRole('button', { name: 'Open a terminal' })).toBeVisible();

    // The empty workspace's two buttons stay on one line with Windows' longer shortcuts (Ctrl+Shift+N is three times
    // ⌘N): on Windows their labels wrapped, two tall lumpy buttons. Windows' hints written in.
    await first.setViewportSize({ width: 1280, height: 800 });
    const buttons = first.locator('.ws-empty-actions button');
    await expect(buttons).toHaveCount(2);
    await first.evaluate(() => {
      const hints = document.querySelectorAll('.ws-empty-actions .kbd-in');
      hints[0]!.textContent = 'Ctrl+Shift+N';
      hints[1]!.textContent = 'Ctrl+Shift+T';
    });
    for (const b of await buttons.all()) {
      const box = (await b.boundingBox())!;
      expect(box.height).toBeLessThanOrEqual(40);
      // One line: the label is as tall as one line of text, not two.
      const lines = await b.evaluate((el) => {
        const text = [...el.childNodes].find((n) => n.nodeType === Node.TEXT_NODE)!;
        const r = document.createRange();
        r.selectNodeContents(text);
        return r.getClientRects().length;
      });
      expect(lines).toBe(1);
    }
    await look(first.locator('.ws-empty-card'), 'test-results/workspace-empty-windows-hints.png');

    // A click on the project name at the top left: the folder opens in the Finder.
    await first.getByRole('button', { name: 'Open in Finder' }).hover();
    await look(first.locator('.header'), 'test-results/header-finder-hover.png', { settle: 300 });
    await first.getByRole('button', { name: 'Open in Finder' }).click();
    await expect.poll(() => { try { return readFileSync(log, 'utf8'); } catch { return ''; } }).toContain(`finder:${project}`);

    // New Window from the palette opens the welcome window for another project.
    await first.keyboard.press('F1');
    await first.locator('.palette-input').fill('new window');
    const [welcome] = await Promise.all([app.waitForEvent('window'), first.keyboard.press('Enter')]);
    await expect(welcome.getByRole('button', { name: 'Open folder…' })).toBeVisible();
    await expect(first.locator('.palette')).toHaveCount(0);
    // Again, from File › New Window: the same welcome window is brought forward, another is not opened (the menu item
    // runs in main, synchronously).
    await app.evaluate(({ Menu }) => Menu.getApplicationMenu()!.getMenuItemById('new-window')!.click());
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(2);
    // The project stays open in its window.
    await expect(first.getByRole('button', { name: 'Open a terminal' })).toBeVisible();

    // New Claude Session from the palette: the name is asked in the center, where you were looking.
    await first.keyboard.press('F1');
    await first.locator('.palette-input').fill('New Claude');
    await first.keyboard.press('Enter');
    const name = first.getByPlaceholder('Session name (optional)');
    await expect(name).toBeFocused();
    const box = (await name.boundingBox())!;
    const width = await first.evaluate(() => window.innerWidth);
    expect(Math.abs(box.x + box.width / 2 - width / 2)).toBeLessThan(60);
    await look(first, 'test-results/new-session-centered.png');
    await name.fill('Centrata');
    await first.keyboard.press('Enter');
    await expect(first.locator('.session-row').first()).toContainText('Centrata', { timeout: 20000 });

    // Interface at 125%: the window traffic lights move with the header.
    const firstId = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().sort((a, b) => a.id - b.id)[0]!.id);
    const pos = () => app.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id)!.getWindowButtonPosition(), firstId);
    expect(await pos()).toEqual({ x: 16, y: 17 });
    await first.evaluate(() => (window as unknown as { atelier: { settings: { set(p: object): Promise<unknown> } } }).atelier.settings.set({ interfaceSize: 'larger' }));
    await expect.poll(pos).toEqual({ x: 20, y: 23 });
  } finally {
    await app.close();
    try { process.kill((JSON.parse(readFileSync(join(home, 'atelierd.json'), 'utf8')) as { pid: number }).pid, 'SIGTERM'); } catch { /* already stopped */ }
  }
});

test('quit and reopen: each project window comes back where it was and as big, its sessions bar as wide; a new window still opens centered', async () => {
  const project = mkdtempSync(join(tmpdir(), 'atl-prj-'));
  const { env, home } = e2eEnv({ ATELIER_CLAUDE_BIN: resolve('tests/e2e/fake-claude.pl') });
  writeFileSync(join(home, 'ui-state.json'), JSON.stringify({ openProjects: [], recent: [], quitInfoShown: true }));
  // Oldest first: the project's window, then the welcome window.
  const bounds = (app: Awaited<ReturnType<typeof electron.launch>>) => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().sort((a, b) => a.id - b.id).map((w) => w.getBounds()));
  const sidebarWidth = (w: Page) => w.locator('.sidebar').evaluate((el) => el.getBoundingClientRect().width);
  let app = await electron.launch({ args: ['out/main/index.js', `--project=${project}`], env });
  try {
    const first = await app.firstWindow();
    await expect(first.getByRole('button', { name: 'Open a terminal' })).toBeVisible();
    // The sessions bar widened by dragging its edge.
    expect(await sidebarWidth(first)).toBe(264);
    const handle = first.getByRole('separator', { name: 'Resize sessions bar' });
    const edge = (await handle.boundingBox())!;
    await first.mouse.move(edge.x + edge.width / 2, edge.y + 200);
    await first.mouse.down();
    await first.mouse.move(edge.x + edge.width / 2 + 100, edge.y + 200, { steps: 5 });
    await look(first, 'test-results/resize-drag.png', { clip: { x: 250, y: 40, width: 260, height: 300 } });
    await first.mouse.up();
    expect(await sidebarWidth(first)).toBe(364);
    const moved = { x: 40, y: 60, width: 1200, height: 760 };
    await app.evaluate(({ BrowserWindow }, b) => BrowserWindow.getAllWindows()[0]!.setBounds(b), moved);
    await app.close();
    app = await electron.launch({ args: ['out/main/index.js', `--project=${project}`], env });
    const again = await app.firstWindow();
    await expect(again.getByRole('button', { name: 'Open a terminal' })).toBeVisible();
    expect(await bounds(app)).toEqual([moved]);
    // The sessions bar's width came back too; a double click on its edge restores the default.
    expect(await sidebarWidth(again)).toBe(364);
    const edgeAgain = (await again.getByRole('separator', { name: 'Resize sessions bar' }).boundingBox())!;
    await again.mouse.dblclick(edgeAgain.x, edgeAgain.y + 200);
    expect(await sidebarWidth(again)).toBe(264);
    // New Window (the welcome window) has nothing to remember: the default size, centered.
    const [welcome] = await Promise.all([app.waitForEvent('window'), app.evaluate(({ Menu }) => Menu.getApplicationMenu()!.getMenuItemById('new-window')!.click())]);
    await expect(welcome.getByRole('button', { name: 'Open folder…' })).toBeVisible();
    const [, w] = await bounds(app);
    expect(w).not.toEqual(moved);
    expect(w!.width).toBe(1600);
  } finally {
    await app.close();
    try { process.kill((JSON.parse(readFileSync(join(home, 'atelierd.json'), 'utf8')) as { pid: number }).pid, 'SIGTERM'); } catch { /* already stopped */ }
  }
});

test('quit with two projects open: both reopen, each where it was', async () => {
  const one = mkdtempSync(join(tmpdir(), 'atl-prj-one-'));
  const two = mkdtempSync(join(tmpdir(), 'atl-prj-two-'));
  const { env, home } = e2eEnv({ ATELIER_CLAUDE_BIN: resolve('tests/e2e/fake-claude.pl') });
  writeFileSync(join(home, 'ui-state.json'), JSON.stringify({ openProjects: [one, two], recent: [one, two], quitInfoShown: true }));
  const place = { [one]: { x: 40, y: 60, width: 1200, height: 760 }, [two]: { x: 300, y: 120, width: 1100, height: 700 } };
  // Each project window by the project its header shows.
  const byProject = async (app: Awaited<ReturnType<typeof electron.launch>>) => {
    const out: Record<string, Awaited<ReturnType<typeof app.browserWindow>>> = {};
    for (const page of app.windows()) {
      await expect(page.getByRole('button', { name: 'Open a terminal' })).toBeVisible();
      const text = await page.locator('.header').innerText();
      const root = [one, two].find((r) => text.includes(basename(r)));
      if (root) out[root] = await app.browserWindow(page);
    }
    return out;
  };
  let app = await electron.launch({ args: ['out/main/index.js'], env });
  try {
    await expect.poll(() => app.windows().length).toBe(2);
    for (const [root, w] of Object.entries(await byProject(app))) await w.evaluate((w, b) => w.setBounds(b), place[root]!);
    await app.close();
    app = await electron.launch({ args: ['out/main/index.js'], env });
    await expect.poll(() => app.windows().length).toBe(2);
    const reopened = await byProject(app);
    expect(Object.keys(reopened).sort()).toEqual([one, two].sort());
    for (const [root, w] of Object.entries(reopened)) expect(await w.evaluate((w) => w.getBounds())).toEqual(place[root]);
  } finally {
    await app.close();
    try { process.kill((JSON.parse(readFileSync(join(home, 'atelierd.json'), 'utf8')) as { pid: number }).pid, 'SIGTERM'); } catch { /* already stopped */ }
  }
});

test('welcome window: the arrow keys walk Open Folder and the recent folders, Enter opens one, where the welcome window was moved', async () => {
  const project = mkdtempSync(join(tmpdir(), 'atl-prj-'));
  const one = mkdtempSync(join(tmpdir(), 'atl-prj-one-'));
  const two = mkdtempSync(join(tmpdir(), 'atl-prj-two-'));
  const { env, home } = e2eEnv({ ATELIER_CLAUDE_BIN: resolve('tests/e2e/fake-claude.pl') });
  writeFileSync(join(home, 'ui-state.json'), JSON.stringify({ openProjects: [], recent: [one, two], quitInfoShown: true }));
  const app = await electron.launch({ args: ['out/main/index.js', `--project=${project}`], env });
  try {
    const first = await app.firstWindow();
    await expect(first.getByRole('button', { name: 'Open a terminal' })).toBeVisible();
    const [welcome] = await Promise.all([app.waitForEvent('window'), app.evaluate(({ Menu }) => Menu.getApplicationMenu()!.getMenuItemById('new-window')!.click())]);
    const rows = welcome.locator('.recent-row .recent-name');
    await expect(rows.filter({ hasText: basename(two) })).toBeVisible();
    // The open project is a recent folder too: [project, one, two], whatever the order, walked as shown.
    const names = await rows.allTextContents();
    expect(names).toHaveLength(3);
    // Moved before choosing a project: the project opens where the welcome window was.
    const moved = { x: 40, y: 60, width: 1200, height: 760 };
    await (await app.browserWindow(welcome)).evaluate((w, b) => w.setBounds(b), moved);
    // The e2e window is never active, so toBeFocused (which wants a focused document) can't be used: the element itself.
    const focused = () => welcome.evaluate(() => document.activeElement?.querySelector('.recent-name')?.textContent ?? document.activeElement?.textContent ?? '');
    // Nothing focused: the first arrow lands on the first recent folder, the next ones move on, the last one stays.
    await welcome.keyboard.press('ArrowDown');
    await expect.poll(focused).toBe(names[0]);
    await welcome.keyboard.press('ArrowDown');
    await expect.poll(focused).toBe(names[1]);
    await welcome.keyboard.press('ArrowDown');
    await welcome.keyboard.press('ArrowDown');
    await expect.poll(focused).toBe(names[2]);
    await welcome.keyboard.press('Home');
    await expect.poll(focused).toBe('Open folder…');
    await welcome.keyboard.press('End');
    await expect.poll(focused).toBe(names[2]);
    await welcome.keyboard.press('ArrowUp');
    await expect.poll(focused).toBe(names[1]);
    const target = names[1]!;
    // Enter on the focused recent folder opens it (in a project window; the welcome window closes).
    // The welcome window closes as the project opens, possibly before the key press returns: that is the expected end.
    const [opened] = await Promise.all([app.waitForEvent('window'), welcome.keyboard.press('Enter').catch(() => {})]);
    await expect(opened.locator('.project-name')).toHaveText(target);
    expect(await (await app.browserWindow(opened)).evaluate((w) => w.getBounds())).toEqual(moved);
  } finally {
    await app.close();
    try { process.kill((JSON.parse(readFileSync(join(home, 'atelierd.json'), 'utf8')) as { pid: number }).pid, 'SIGTERM'); } catch { /* already stopped */ }
  }
});

test('welcome window: a recent folder\'s × (shown on hover) or Delete forgets it, in the saved state and the next welcome window too', async () => {
  const project = mkdtempSync(join(tmpdir(), 'atl-prj-'));
  const one = mkdtempSync(join(tmpdir(), 'atl-prj-one-'));
  const two = mkdtempSync(join(tmpdir(), 'atl-prj-two-'));
  const three = mkdtempSync(join(tmpdir(), 'atl-prj-three-'));
  const { env, home } = e2eEnv({ ATELIER_CLAUDE_BIN: resolve('tests/e2e/fake-claude.pl') });
  writeFileSync(join(home, 'ui-state.json'), JSON.stringify({ openProjects: [], recent: [one, two, three], quitInfoShown: true }));
  const app = await electron.launch({ args: ['out/main/index.js', `--project=${project}`], env });
  const newWindow = () => Promise.all([app.waitForEvent('window'), app.evaluate(({ Menu }) => Menu.getApplicationMenu()!.getMenuItemById('new-window')!.click())]).then(([w]) => w);
  const saved = () => (JSON.parse(readFileSync(join(home, 'ui-state.json'), 'utf8')) as { recent: string[] }).recent;
  try {
    const first = await app.firstWindow();
    await expect(first.getByRole('button', { name: 'Open a terminal' })).toBeVisible();
    const welcome = await newWindow();
    const names = welcome.locator('.recent-row .recent-name');
    await expect(names).toHaveCount(4);
    const item = (p: string) => welcome.locator('.recent-item').filter({ has: welcome.locator('.recent-name', { hasText: basename(p) }) });

    // The × stays out of sight until the pointer is on its row, and stays out of the arrow keys' walk.
    const forget = item(one).getByRole('button', { name: 'Remove from Recent' });
    await expect(forget).toHaveCSS('opacity', '0');
    await item(one).hover();
    await expect(forget).toHaveCSS('opacity', '1');
    await look(welcome, 'test-results/welcome-forget-recent-hover.png', { settle: 300 });
    await forget.click();
    await expect(item(one)).toHaveCount(0);
    await expect(names).toHaveCount(3);
    expect(saved()).not.toContain(one);
    // Still a folder on disk: only the list forgets it.
    expect(saved()).toContain(two);

    // The × is not one of the items the arrow keys walk (Open Folder and the rows).
    await expect(welcome.locator('[data-welcome-item]')).toHaveCount(4);

    // From the keyboard: Backspace (or Delete) on a focused recent folder forgets it, and the focus goes on to the row
    // that took its place. Rows now: the open project, two, three (the project's place in the list is not fixed).
    const focused = () => welcome.evaluate(() => document.activeElement?.querySelector('.recent-name')?.textContent ?? '');
    const order = await names.allTextContents();
    await item(two).locator('.recent-row').focus();
    await welcome.keyboard.press('Backspace');
    await expect(item(two)).toHaveCount(0);
    const after = order.filter((n) => n !== basename(two));
    await expect.poll(focused).toBe(after[order.indexOf(basename(two))] ?? after.at(-1));
    await expect.poll(saved).not.toContain(two);

    // A held key forgets one folder, not the rows that move up under the focus.
    await welcome.evaluate(() => document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace', repeat: true, bubbles: true })));
    await expect(names).toHaveCount(2);

    // The last row forgotten: the focus goes to the row now last.
    await welcome.locator('.recent-row').last().focus();
    const last = await focused();
    await welcome.keyboard.press('Delete');
    await expect(names).toHaveCount(1);
    await expect.poll(focused).toBe(after.filter((n) => n !== last).at(-1));
    const kept = after.filter((n) => n !== last);

    // The next welcome window remembers.
    await (await app.browserWindow(welcome)).evaluate((w) => w.close());
    await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1);
    const again = await newWindow();
    await expect(again.locator('.recent-row .recent-name')).toHaveText(kept);
  } finally {
    await app.close();
    try { process.kill((JSON.parse(readFileSync(join(home, 'atelierd.json'), 'utf8')) as { pid: number }).pid, 'SIGTERM'); } catch { /* already stopped */ }
  }
});

