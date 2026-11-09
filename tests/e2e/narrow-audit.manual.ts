import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { e2eEnv, writePrefs } from './env';
import { crowd, sidebarByKeys, sidebarTo, stage } from './narrow-fixture';

// Narrow layouts audit: the crowded sidebar at every width, its questions,
// and the window at its smallest, for review by eye. Asserts nothing.
// Run: npx playwright test --config playwright.manual.config.ts tests/e2e/narrow-audit.manual.ts
// Written to e2e-shots/narrow (git-ignored). NARROW_ZOOM=larger: the same at 125 %.

const OUT = resolve('e2e-shots/narrow', process.env.NARROW_ZOOM ?? 'default');
const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const git = (cwd: string, ...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd, env: gitEnv });
const still = (win: Page) => win.addStyleTag({ content: '*, *::before, *::after { animation: none !important; transition: none !important; }' });

/** The real window (a page screenshot is cut at the viewport's CSS size when the interface is zoomed). */
async function capture(app: ElectronApplication, name: string) {
  const png = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0]!.webContents.capturePage()).toPNG().toString('base64'));
  writeFileSync(join(OUT, name), Buffer.from(png, 'base64'));
}

async function stop(app: ElectronApplication, home: string) {
  await app.close();
  try { process.kill((JSON.parse(readFileSync(join(home, 'atelierd.json'), 'utf8')) as { pid: number }).pid, 'SIGTERM'); } catch { /* already stopped */ }
}

test('narrow layouts audit', async () => {
  mkdirSync(OUT, { recursive: true });
  const project = realpathSync(mkdtempSync(join(tmpdir(), 'atl-prj-')));
  git(project, 'init', '-q', '-b', 'main');
  mkdirSync(join(project, 'apps/web'), { recursive: true });
  for (const f of ['app.ts', 'apps/web/index.tsx', 'README.md']) writeFileSync(join(project, f), '1\n');
  git(project, 'add', '.');
  git(project, 'commit', '-q', '-m', 'first');
  for (const f of ['app.ts', 'apps/web/index.tsx']) writeFileSync(join(project, f), '2\n');
  writeFileSync(join(project, 'apps/web/a-new-component-with-a-long-name.tsx'), 'x\n');

  const { env, home } = e2eEnv({ ATELIER_CLAUDE_BIN: resolve('tests/e2e/fake-claude.pl') });
  writePrefs(home, { interfaceSize: process.env.NARROW_ZOOM ?? 'default' });
  const app = await electron.launch({ args: ['out/main/index.js', `--project=${project}`], env });
  try {
    const win = await app.firstWindow();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(1280, 800));
    await expect(win.locator('.sidebar')).toBeVisible();
    await win.waitForTimeout(1500);
    const c = crowd(project);
    await stage(app, c);
    await expect(win.locator('.session-row')).toHaveCount(5);
    await still(win);
    const sidebar = win.locator('.sidebar');
    const shot = (name: string) => sidebar.screenshot({ path: join(OUT, `${name}.png`) });

    for (const w of [200, 232, 264, 300, 360, 420]) {
      await sidebarTo(win, w);
      await win.mouse.move(900, 500);
      await win.waitForTimeout(150);
      await shot(`sidebar-${w}`);
      // Hovered: pin and close over the title's end.
      await win.locator('.session-row', { hasText: 'Email campaign' }).hover();
      await win.waitForTimeout(100);
      await win.locator('.term-row', { hasText: 'Terminal 1' }).hover();
      await win.waitForTimeout(100);
      await shot(`sidebar-${w}-hover-term`);
      await win.locator('.session-row', { hasText: 'Auth refactor' }).hover();
      await win.waitForTimeout(100);
      await shot(`sidebar-${w}-hover-session`);
    }

    // The other views at the narrowest sidebar.
    await sidebarTo(win, 200);
    for (const [view, file] of [['Files (⌘⇧2)', 'files'], ['Source Control (⌃⇧G)', 'scm']] as const) {
      await win.getByRole('button', { name: view }).click();
      await win.waitForTimeout(500);
      await shot(`sidebar-200-${file}`);
    }
    await win.getByRole('button', { name: 'Sessions (⌘⇧1)' }).click();

    // The close questions: a working session and a terminal running node.
    for (const w of [200, 232, 264, 320]) {
      await sidebarTo(win, w);
      const row = win.locator('.session-row', { hasText: 'Email campaign' });
      await row.hover();
      await row.getByRole('button', { name: 'Close Session' }).click();
      await expect(win.locator('.session-row.is-confirming')).toBeVisible();
      await win.waitForTimeout(100);
      await shot(`confirm-session-${w}`);
      await win.keyboard.press('Escape');
      const term = win.locator('.term-row', { hasText: 'Terminal 1' });
      await term.hover();
      await term.getByRole('button', { name: 'Close Terminal' }).click();
      await expect(win.locator('.term-row.is-confirming')).toBeVisible();
      await win.waitForTimeout(100);
      await shot(`confirm-term-${w}`);
      await win.keyboard.press('Escape');
    }

    // The window at its smallest, with both side panels at their widest and at their defaults.
    await sidebarTo(win, 264);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(960, 600));
    await win.waitForTimeout(300);
    await capture(app, 'window-960.png');
    const changes = win.locator('.changes-toggle');
    if (!(await win.locator('.changes').isVisible())) await changes.click();
    // As wide as it goes.
    await sidebarByKeys(win, 480);
    await win.waitForTimeout(300);
    await capture(app, 'window-960-wide-sidebar.png');
    // Changes at its widest too (16 px a key; on the right, ← widens it).
    const edge = win.getByRole('separator', { name: 'Resize Changes' });
    await edge.focus();
    for (let i = 0; i < 16; i++) await win.keyboard.press('ArrowLeft');
    await win.waitForTimeout(300);
    await capture(app, 'window-960-both-wide.png');
    for (let i = 0; i < 16; i++) await win.keyboard.press('ArrowRight');
    const side = win.getByRole('separator', { name: 'Resize sessions bar' });
    await side.focus();
    for (let i = 0; i < 6; i++) await win.keyboard.press('ArrowLeft');
    await win.waitForTimeout(300);

    // A session in front: its bar, at the smallest window, with Changes open.
    await win.locator('.session-row', { hasText: 'Email campaign' }).click();
    await win.waitForTimeout(400);
    await capture(app, 'window-960-session.png');
    await win.locator('.session-row', { hasText: 'Auth refactor' }).click();
    await win.waitForTimeout(400);
    await capture(app, 'window-960-session-waiting.png');

    // Resume (kept sessions) and the update pill.
    await stage(app, c, project);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.webContents.send('ev:update', true));
    await win.waitForTimeout(400);
    for (const w of [200, 264]) {
      // From the keyboard: the smallest window may cap the sidebar.
      await sidebarByKeys(win, w);
      await win.mouse.move(700, 300);
      await shot(`sidebar-${w}-resume`);
    }
    await capture(app, 'window-960-update.png');

    // Settings and the palette at the smallest window.
    await win.getByRole('button', { name: 'Settings', exact: true }).first().click();
    await win.waitForTimeout(500);
    await capture(app, 'window-960-settings.png');
    await win.keyboard.press('Escape');
    await win.waitForTimeout(300);
    await win.locator('.search').click();
    await win.waitForTimeout(400);
    await capture(app, 'window-960-palette.png');
    await win.keyboard.press('Escape');
  } finally {
    await stop(app, home);
  }
});
