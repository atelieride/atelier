import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { e2eEnv } from './env';

// Themes: the same screens in one theme, to look at or to compare two builds pixel by pixel
// (compare RGB, not RGBA: an alpha-only bounding box hides every color change; and runs differ by their temp names).
// Not part of any suite. THEME_PIXELS_OUT=<dir> [THEME=<id>] [TERMINAL_COLORS=dark] npx playwright test --config
// playwright.manual.config.ts tests/e2e/theme-pixels.manual.ts

type Api = { terminals: { list(): Promise<{ id: string; title: string }[]>; input(id: string, data: string): void } };
const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const git = (cwd: string, ...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd, env: gitEnv });
const CODE = `import { store } from './store';

// Sessions expire through the token store.
export async function expire(id: string, skewMs = 30_000): Promise<boolean> {
  const token = await store.get(id);
  if (!token) return false;
  return token.expiresAt - skewMs < Date.now();
}
`;

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

const command = (app: ElectronApplication, c: string) => app.evaluate(({ BrowserWindow }, c) => BrowserWindow.getAllWindows()[0]!.webContents.send('ev:command', c), c);

test('theme pixels', async () => {
  const out = resolve(process.env.THEME_PIXELS_OUT!);
  mkdirSync(out, { recursive: true });
  const project = mkdtempSync(join(tmpdir(), 'atl-prj-'));
  mkdirSync(join(project, 'src'));
  writeFileSync(join(project, 'src/session.ts'), CODE);
  writeFileSync(join(project, 'README.md'), '# acme\n');
  git(project, 'init', '-q', '-b', 'main');
  git(project, 'add', '-A');
  git(project, 'commit', '-q', '-m', 'init');
  writeFileSync(join(project, 'src/session.ts'), CODE.replace('30_000', '45_000') + '\nexport const SKEW = 45_000;\n');
  const { env } = e2eEnv({ ATELIER_CLAUDE_BIN: resolve('tests/e2e/fake-claude.pl') });
  const app = await electron.launch({ args: ['out/main/index.js', `--project=${project}`], env });
  try {
    const win = await app.firstWindow();
    await win.emulateMedia({ reducedMotion: 'reduce' });
    if (process.env.THEME) await win.evaluate((p) => (window as unknown as { atelier: { settings: { set(p: object): Promise<unknown> } } }).atelier.settings.set(p), { theme: process.env.THEME, ...(process.env.TERMINAL_COLORS ? { terminalColors: process.env.TERMINAL_COLORS } : {}) });
    const shot = async (name: string) => { await win.waitForTimeout(700); await win.screenshot({ path: join(out, `${name}.png`) }); };

    await newSession(win, 'Alpha');
    await newSession(win, 'Beta');
    await typeInto(win, 'Beta', '\r');
    await expect(win.locator('.session-row', { hasText: 'Beta' })).toHaveClass(/state-done/, { timeout: 15000 });
    await win.locator('.session-row', { hasText: 'Alpha' }).locator('.row-main').click();
    await expect(win.locator('.session-row', { hasText: 'Alpha' })).toHaveClass(/state-waiting/, { timeout: 15000 });
    await win.mouse.move(2, 400);
    await shot('main');

    await win.locator('.session-row', { hasText: 'Alpha' }).click({ button: 'right' });
    await shot('menu');
    await win.keyboard.press('Escape');

    await win.keyboard.press('F1');
    await win.locator('.palette-input').fill('session');
    await shot('palette');
    await win.locator('.palette-item', { hasText: 'session.ts' }).first().click();
    await expect(win.locator('.cm-content')).toContainText('expiresAt', { timeout: 10000 });
    await win.locator('.cm-content').click({ position: { x: 200, y: 60 } });
    await win.mouse.move(2, 400);
    await shot('editor');

    await command(app, 'open-settings');
    await expect(win.locator('.settings')).toBeVisible();
    for (const s of ['Appearance', 'Terminal', 'Editor', 'Keyboard']) {
      await win.locator('.set-nav-item', { hasText: new RegExp(`^${s}$`) }).first().click();
      await win.mouse.move(2, 400);
      await shot(`settings-${s.toLowerCase()}`);
    }
  } finally {
    await app.close();
  }
});
