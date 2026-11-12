import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { e2eEnv } from './env';
import { look } from './shots';

// A render error no longer blanks the window (2026-10-11): the failing panel shows an error card, the rest stays, and
// the error lands in ATELIER_HOME/logs/app.log. ATELIER_TEST_RENDER_ERROR (devEnv, inert in the packaged app) makes a
// panel throw once the app has rendered. Copies go to the test copy log, never to the real clipboard.

async function launch(fault: string, files: Record<string, string> = {}): Promise<{ app: ElectronApplication; win: Page; home: string; copies: () => string[] }> {
  const project = mkdtempSync(join(tmpdir(), 'atl-prj-'));
  execFileSync('git', ['init', '-q', '-b', 'main', project]);
  for (const [name, text] of Object.entries(files)) writeFileSync(join(project, name), text);
  const { env, home } = e2eEnv({ ATELIER_TEST_RENDER_ERROR: fault });
  const log = env.ATELIER_TEST_CLIPBOARD_LOG!;
  const app = await electron.launch({ args: ['out/main/index.js', `--project=${project}`], env });
  const copies = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as string) : []);
  return { app, win: await app.firstWindow(), home, copies };
}

async function stop(app: ElectronApplication, home: string) {
  await app.close();
  try { process.kill((JSON.parse(readFileSync(join(home, 'atelierd.json'), 'utf8')) as { pid: number }).pid, 'SIGTERM'); } catch { /* already stopped */ }
}

const appLog = (home: string) => { const f = join(home, 'logs', 'app.log'); return existsSync(f) ? readFileSync(f, 'utf8') : ''; };
const still = (win: Page) => win.addStyleTag({ content: '*, *::before, *::after { animation: none !important; transition: none !important; }' });

test('a panel that throws while rendering shows its error card; the rest of the window keeps working; the error is logged', async () => {
  const { app, win, home, copies } = await launch('sidebar');
  try {
    const card = win.getByRole('alert', { name: 'Something went wrong in the sidebar' });
    await expect(card).toBeVisible({ timeout: 15000 });
    await expect(card).toContainText('Test render error in sidebar');
    // Not a blank window: the workspace, its tabs and the Changes panel are still there and usable.
    await expect(win.getByRole('button', { name: 'Open a terminal' })).toBeVisible();
    await win.getByRole('button', { name: 'Open a terminal' }).click();
    await expect(win.locator('.xterm-rows')).toContainText('›', { timeout: 15000 });
    await expect(win.locator('.changes')).toBeVisible();

    await expect.poll(() => appLog(home)).toContain('[renderer:boundary] (the sidebar) Error: Test render error in sidebar');
    expect(appLog(home)).toMatch(/\n {4}Component stack:/);
    expect(statSync(join(home, 'logs', 'app.log')).mode & 0o777).toBe(0o600);

    await card.getByRole('button', { name: 'Copy details' }).click();
    await expect(card.getByRole('button', { name: 'Copied' })).toBeVisible();
    expect(copies().at(-1)).toMatch(/^Atelier \S+ · the sidebar\nError: Test render error in sidebar\n\n/);
    await still(win);
    await look(win, 'test-results/error-boundary-sidebar.png');
  } finally {
    await stop(app, home);
  }
});

test('an error in the app itself shows the window-wide card; Reload window reloads; uncaught errors and rejections are logged', async () => {
  const { app, win, home } = await launch('app');
  try {
    const card = win.getByRole('alert', { name: 'Something went wrong in Atelier' });
    await expect(card).toBeVisible({ timeout: 15000 });
    await still(win);
    await look(win, 'test-results/error-boundary-app.png');

    await win.evaluate(() => {
      setTimeout(() => { throw new Error('late boom'); });
      void Promise.reject(new Error('lost promise'));
    });
    await expect.poll(() => appLog(home)).toContain('[renderer:error] Error: late boom');
    await expect.poll(() => appLog(home)).toContain('[renderer:rejection] Error: lost promise');

    const reloaded = win.waitForEvent('load');
    await card.getByRole('button', { name: 'Reload window' }).click();
    await reloaded;
    // The test fault is still set: the page came back and failed the same way, again on a card.
    await expect(win.getByRole('alert', { name: 'Something went wrong in Atelier' })).toBeVisible({ timeout: 15000 });
  } finally {
    await stop(app, home);
  }
});

test('a pane beside the code that throws (the JSON tree) shows its card in its place; the code and its unsaved edits stay', async () => {
  const { app, win, home } = await launch('json-tree', { 'app.json': '{\n  "name": "orbit"\n}\n' });
  try {
    if (!(await win.locator('.tree-row').first().isVisible())) await win.getByRole('button', { name: /^Files/ }).click();
    await win.locator('.tree-row', { hasText: 'app.json' }).first().dblclick();
    const fv = win.locator('.file-view:visible');
    await expect(fv.locator('.json-switch')).toBeVisible();
    await fv.locator('.cm-line', { hasText: '"name"' }).click();
    await win.keyboard.press('End');
    await win.keyboard.press('ArrowLeft');
    await win.keyboard.type('x');
    await expect(fv.locator('.foot-modified')).toBeVisible();
    await fv.locator('.json-switch').getByRole('radio', { name: 'Split' }).click();
    const card = fv.getByRole('alert', { name: 'Something went wrong in the tree' });
    await expect(card).toBeVisible();
    await expect(card).toContainText('safe in Source');
    // The editor was not unmounted: its buffer and its unsaved state are still there.
    await expect(fv.locator('.cm-content')).toBeVisible();
    await expect(fv.locator('.foot-modified')).toBeVisible();
    await expect.poll(() => appLog(home)).toContain('[renderer:boundary] (the tree) Error: Test render error in json-tree');
    await fv.locator('.json-switch').getByRole('radio', { name: 'Source' }).click();
    await expect(card).toBeHidden();
    await expect(fv.locator('.foot-modified')).toBeVisible();
    await expect(fv.locator('.cm-line', { hasText: '"orbitx"' })).toBeVisible();
    await still(win);
    await look(win, 'test-results/error-boundary-json-tree.png');
  } finally {
    await stop(app, home);
  }
});
