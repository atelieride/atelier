import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { e2eEnv } from './env';
import { look } from './shots';

// Next / previous change in a file tab, Collapse folders in Files.

const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const git = (cwd: string, ...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd, env: gitEnv });

async function launch(setup: (project: string) => void) {
  const project = mkdtempSync(join(tmpdir(), 'atl-prj-'));
  setup(project);
  const urlLog = join(project, '..', `${basename(project)}-urls.log`);
  const { env, home } = e2eEnv({ ATELIER_CLAUDE_BIN: resolve('tests/e2e/fake-claude.pl'), ATELIER_TEST_URL_LOG: urlLog });
  const app = await electron.launch({ args: ['out/main/index.js', `--project=${project}`], env });
  const win = await app.firstWindow();
  await expect(win.locator('.btn-new')).toBeVisible({ timeout: 20000 });
  const opened = () => { try { return readFileSync(urlLog, 'utf8').trim().split('\n').filter(Boolean); } catch { return []; } };
  return { app, home, win, project, opened, notifyLog: env.ATELIER_TEST_NOTIFY_LOG! };
}

async function stop(app: ElectronApplication, home: string) {
  await app.close();
  try { process.kill((JSON.parse(readFileSync(join(home, 'atelierd.json'), 'utf8')) as { pid: number }).pid, 'SIGTERM'); } catch { /* already stopped */ }
}

const command = (app: ElectronApplication, cmd: string) => app.evaluate(({ BrowserWindow }, c) => BrowserWindow.getAllWindows()[0]!.webContents.send('ev:command', c), cmd);

test('a long changed file: the arrows and Go › Next / Previous Change jump between its changes, in Diff and Margin', async () => {
  const lines = Array.from({ length: 300 }, (_, i) => `export const v${i + 1} = ${i + 1};`);
  const { app, home, win } = await launch((project) => {
    git(project, 'init', '-q', '-b', 'main');
    writeFileSync(join(project, 'long.ts'), lines.join('\n') + '\n');
    git(project, 'add', '.');
    git(project, 'commit', '-q', '-m', 'first');
    const changed = [...lines];
    changed[19] = 'export const v20 = "changed";';
    changed[149] = 'export const v150 = "changed";';
    changed.splice(280, 0, 'export const added = true;');
    writeFileSync(join(project, 'long.ts'), changed.join('\n') + '\n');
  });
  try {
    const row = win.locator('.changes .change-row', { hasText: 'long.ts' });
    await expect(row).toBeVisible({ timeout: 10000 });
    await row.click();
    const view = win.locator('.file-view:visible');
    // Only the rows on screen are drawn: the first change is, the others are far below.
    await expect(view.locator('.cm-diff-add')).toHaveCount(1, { timeout: 10000 });
    const nav = view.getByRole('group', { name: 'Changes in this file' });
    const count = nav.locator('.change-nav-count');
    await expect(count).toHaveText('3 changes');
    const target = view.locator('.cm-target-line');

    await nav.getByRole('button', { name: 'Next change' }).click();
    await expect(count).toHaveText('1 / 3');
    await expect(target).toContainText('v20');
    await nav.getByRole('button', { name: 'Next change' }).click();
    await expect(count).toHaveText('2 / 3');
    await expect(target).toContainText('v150');
    await expect(target).toBeInViewport();
    await look(win, 'test-results/change-nav-diff.png');
    await command(app, 'next-change');
    await expect(count).toHaveText('3 / 3');
    await expect(target).toContainText('added');
    // Wraps around, both ways.
    await command(app, 'next-change');
    await expect(count).toHaveText('1 / 3');
    await nav.getByRole('button', { name: 'Previous change' }).click();
    await expect(count).toHaveText('3 / 3');
    await command(app, 'prev-change');
    await expect(count).toHaveText('2 / 3');

    // Margin: the same stops, on the file's own lines.
    await view.getByRole('button', { name: 'Margin' }).click();
    await expect(view.locator('.cm-diff-signs')).toHaveCount(0);
    await expect(count).toHaveText(/3 changes|\d \/ 3/, { timeout: 5000 });
    await command(app, 'next-change');
    await expect(target).toContainText('v20');
    await command(app, 'next-change');
    await expect(target).toContainText('v150');
    await expect(count).toHaveText('2 / 3');

    // No file in front: nothing to move to, said in a toast.
    await command(app, 'close-tab');
    await expect(view).toHaveCount(0);
    await command(app, 'next-change');
    await expect(win.locator('.toast')).toContainText('No changes to move to');
  } finally {
    await stop(app, home);
  }
});

test('Files › Collapse folders closes every open folder; disabled when none is open; from the palette too', async () => {
  const { app, home, win, project } = await launch((p) => {
    mkdirSync(join(p, 'src', 'deep', 'er'), { recursive: true });
    mkdirSync(join(p, 'docs'));
    writeFileSync(join(p, 'src', 'deep', 'er', 'x.ts'), 'x\n');
    writeFileSync(join(p, 'docs', 'a.md'), 'a\n');
  });
  try {
    await command(app, 'view-files');
    const tree = win.locator('.tree');
    // The tree shows real paths (/private/var/… for the temp folder): matched by their end.
    const folder = (name: string) => tree.locator(`.tree-row[data-path$="/${basename(project)}/${name}"]`);
    const collapse = win.locator('.sidebar-head').getByRole('button', { name: 'Collapse folders' });
    await expect(folder('src')).toBeVisible();
    await expect(collapse).toBeDisabled();
    await folder('src').click();
    await folder('src/deep').click();
    await folder('src/deep/er').click();
    await folder('docs').click();
    await expect(tree.locator('.tree-row', { hasText: 'x.ts' })).toBeVisible();
    await expect(tree.locator('.tree-row[aria-expanded="true"]')).toHaveCount(4);
    await expect(collapse).toBeEnabled();
    await look(win.locator('.sidebar'), 'test-results/files-collapse.png');

    await collapse.click();
    await expect(tree.locator('.tree-row[aria-expanded="true"]')).toHaveCount(0);
    await expect(tree.locator('.tree-row', { hasText: 'x.ts' })).toHaveCount(0);
    await expect(collapse).toBeDisabled();
    // Reopened, src shows its folders closed again (not the old expansion).
    await folder('src').click();
    await expect(folder('src/deep')).toHaveAttribute('aria-expanded', 'false');

    // Palette.
    await win.keyboard.press('F1');
    await win.locator('.palette-input').fill('>collapse all folders');
    await expect(win.locator('.palette-item', { hasText: 'Collapse all folders in Files' })).toBeVisible();
    await win.keyboard.press('Enter');
    await expect(tree.locator('.tree-row[aria-expanded="true"]')).toHaveCount(0);

    // A folder open inside a closed one is out of sight: nothing to collapse.
    await folder('src').click();
    await folder('src/deep').click();
    await expect(collapse).toBeEnabled();
    await folder('src').click();
    await expect(collapse).toBeDisabled();
    // Reopened, src still shows deep open.
    await folder('src').click();
    await expect(folder('src/deep')).toHaveAttribute('aria-expanded', 'true');
  } finally {
    await stop(app, home);
  }
});

test('a terminal opens the folder it is in now in Finder: right-click names it, ⌘⌥R and the palette too; a program capturing the mouse (tmux, vim) keeps its right-click, ⇧-right-click opens the menu', async () => {
  const { app, home, win, project, opened } = await launch((p) => { mkdirSync(join(p, 'api', 'src'), { recursive: true }); });
  try {
    await win.getByRole('button', { name: 'Open a terminal' }).click();
    const screen = win.locator('.xterm-rows:visible');
    await expect(screen).toContainText(/\S/, { timeout: 10000 });
    await win.evaluate(async () => {
      const api = (window as unknown as { atelier: { terminals: { list(): Promise<{ id: string }[]>; input(id: string, d: string): void } } }).atelier;
      api.terminals.input((await api.terminals.list())[0]!.id, 'cd api/src && echo moved-$((40+2))\r');
    });
    await expect(screen).toContainText('moved-42', { timeout: 10000 });

    // Right-click: the folder of the shell now (after cd), by name.
    await win.locator('.terminal-slot:visible').click({ button: 'right', position: { x: 200, y: 120 } });
    const item = win.getByRole('menuitem', { name: /Open “src” in Finder/ });
    await expect(item).toBeVisible();
    await expect(item).toContainText('⌘⌥R');
    await look(win, 'test-results/terminal-open-in-finder.png');
    await item.click();
    await expect.poll(opened).toEqual([expect.stringMatching(new RegExp(`^finder:/.*${basename(project)}/api/src$`))]);

    // ⌘⌥R (File › Reveal in Finder) and the palette: the same folder.
    await command(app, 'reveal-in-finder');
    await expect.poll(() => opened().length).toBe(2);
    await win.keyboard.press('F1');
    await win.locator('.palette-input').fill('>reveal in finder');
    await expect(win.locator('.palette-item', { hasText: 'Reveal in Finder' })).toBeVisible();
    await win.keyboard.press('Enter');
    await expect.poll(() => opened().length).toBe(3);
    expect(new Set(opened()).size).toBe(1);

    // A program capturing the mouse keeps its right-click: no Atelier menu on top (without it, the menu above).
    const slot = win.locator('.terminal-slot:visible');
    const menu = win.getByRole('menuitem', { name: /in Finder/ });
    // What tmux with `mouse on` asks the terminal for (mouse reports).
    await win.evaluate(async () => {
      const api = (window as unknown as { atelier: { terminals: { list(): Promise<{ id: string }[]>; input(id: string, d: string): void } } }).atelier;
      api.terminals.input((await api.terminals.list())[0]!.id, "printf '\\033[?1000h'; echo mouse-$((6*7))\r");
    });
    await expect(screen).toContainText('mouse-42', { timeout: 10000 });
    await slot.click({ button: 'right', position: { x: 200, y: 160 } });
    await win.waitForTimeout(500);
    await expect(menu).toHaveCount(0);
    await slot.click({ button: 'right', position: { x: 200, y: 160 }, modifiers: ['Shift'] });
    await expect(menu).toBeVisible();
  } finally {
    await stop(app, home);
  }
});

test('"Finished" only after a long turn (1 min by default): a quick reply gets no banner and no bell entry; "Always" gets both; Send Test shows a banner', async () => {
  const { app, home, win, notifyLog } = await launch(() => {});
  // "Finished" banners only (a waiting session gets its own "Needs permission" banner).
  const banners = () => { try { return readFileSync(notifyLog, 'utf8').trim().split('\n').filter(Boolean).filter((l) => (JSON.parse(l) as { body: string }).body === 'Finished').length; } catch { return 0; } };
  // "Finished" rows in the notification center (the popover opened and closed again around the read).
  const entries = async () => {
    await command(app, 'show-notifications');
    const n = await win.locator('.notes-pop .note-row', { hasText: 'Finished' }).count();
    await command(app, 'show-notifications');
    return n;
  };
  const type = (text: string) => win.evaluate(async (text) => {
    const api = (window as unknown as { atelier: { terminals: { list(): Promise<{ id: string; title: string }[]>; input(id: string, d: string): void } } }).atelier;
    api.terminals.input((await api.terminals.list()).find((x) => x.title === 'Quick')!.id, text);
  }, text);
  const settings = (patch: Record<string, unknown>) => win.evaluate((p) => (window as unknown as { atelier: { settings: { set(p: Record<string, unknown>): Promise<unknown> } } }).atelier.settings.set(p), patch);
  try {
    await settings({ notifyDone: true });
    await win.locator('.btn-new').click();
    await win.getByRole('menuitem', { name: 'Claude Session' }).click();
    await win.getByPlaceholder('Session name (optional)').fill('Quick');
    await win.keyboard.press('Enter');
    const row = win.locator('.session-row', { hasText: 'Quick' });
    await expect(row).toHaveClass(/state-waiting/, { timeout: 20000 });
    // A quick turn (Atelier saw the terminal before Claude started in it): quiet.
    await type('\r');
    await expect(row).toHaveClass(/state-done/, { timeout: 10000 });
    // The finish waits FINISH_WINDOW_MS (2.5 s) for others to group with and is judged by the setting then: let it go
    // out under "1 min" before switching to "Always" (nothing observable marks a batch that notifies nobody).
    await win.waitForTimeout(2500);
    expect(banners()).toBe(0);
    expect(await entries()).toBe(0);

    // "Always": the next quick turn notifies, banner and bell.
    await settings({ notifyDoneAfter: 'always' });
    await type('ev:prompt\r');
    await expect(row).toHaveClass(/state-running/, { timeout: 10000 });
    await type('ev:stop\r');
    await expect.poll(banners, { timeout: 10000 }).toBe(1);
    await expect.poll(entries, { timeout: 10000 }).toBe(1);

    // Settings › Notifications shows the choice.
    await command(app, 'open-settings');
    await win.locator('.set-nav-item', { hasText: 'Notifications' }).click();
    const seg = win.getByRole('radiogroup', { name: '“Finished” only after working for' });
    await expect(seg.getByRole('radio', { name: 'Always' })).toHaveAttribute('aria-checked', 'true');
    await look(win, 'test-results/notify-done-after.png');

    // Send Test shows a banner (not a "Finished" one).
    await win.getByRole('button', { name: 'Send Test' }).click();
    await expect.poll(() => { try { return readFileSync(notifyLog, 'utf8'); } catch { return ''; } }).toContain('"title":"Atelier"');
    await expect(win.getByRole('button', { name: 'Open', exact: true })).toBeVisible();
    expect(banners()).toBe(1);
  } finally {
    await stop(app, home);
  }
});
