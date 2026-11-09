import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { e2eEnv } from './env';
import type { AtelierApi } from '../../src/shared/api';
import { look } from './shots';

// Closing a project window stops what runs in it: nothing busy → no question,
// the Claude session waits under Resume, the shell is gone, the Shelf stays; something busy → the window asks (Keep in
// Background, Stop and Close, Cancel); ⌘Q asks once for every window. The setting decides here (no test override).

const SID = '88888888-8888-4888-8888-888888888888';
// The fake Claude starts waiting on a permission: Enter ends its turn (done), "hold" keeps it working until the next line.
const daemonPid = (home: string) => (JSON.parse(readFileSync(join(home, 'atelierd.json'), 'utf8')) as { pid: number }).pid;
const api = (win: Page) => ({
  session: (name: string) => win.evaluate((n) => (window as unknown as { atelier: AtelierApi }).atelier.terminals.createSession({ cols: 100, rows: 30, name: n }), name),
  terminal: () => win.evaluate(() => (window as unknown as { atelier: AtelierApi }).atelier.terminals.create({ cols: 100, rows: 30 })),
  state: (title: string) => win.evaluate(async (t) => (await (window as unknown as { atelier: AtelierApi }).atelier.terminals.list()).find((x) => x.title === t)?.session?.state ?? null, title),
  shellTitle: () => win.evaluate(async () => (await (window as unknown as { atelier: AtelierApi }).atelier.terminals.list()).find((x) => !x.session)!.title),
  type: (title: string, text: string) => win.evaluate(async ({ title, text }) => {
    const a = (window as unknown as { atelier: AtelierApi }).atelier;
    const id = (await a.terminals.list()).find((x) => x.title === title)!.id;
    a.terminals.input(id, text);
  }, { title, text }),
  count: () => win.evaluate(async () => (await (window as unknown as { atelier: AtelierApi }).atelier.terminals.list()).length),
  shellPid: () => win.evaluate(async () => (await (window as unknown as { atelier: AtelierApi }).atelier.terminals.list()).find((x) => !x.session)?.pid ?? 0)
});

/** The shell runs a command in the foreground (its terminal's foreground group isn't its own), as main reads it. */
const runsCommand = (pid: number) => {
  if (!pid) return false;
  try {
    const [pgid, tpgid] = execFileSync('/bin/ps', ['-o', 'pgid=,tpgid=', '-p', String(pid)], { encoding: 'utf8' }).trim().split(/\s+/).map(Number);
    return pgid !== tpgid;
  } catch { return false; }
};

/** Counts the native dialogs main would show (none expected: the window asks). */
const stubNative = (app: ElectronApplication) => app.evaluate(({ dialog }) => {
  const g = globalThis as unknown as { nativeAsked: number };
  g.nativeAsked = 0;
  dialog.showMessageBox = (async () => { g.nativeAsked++; return { response: 2, checkboxChecked: false }; }) as typeof dialog.showMessageBox;
});
const nativeAsked = (app: ElectronApplication) => app.evaluate(() => (globalThis as unknown as { nativeAsked: number }).nativeAsked);

/** The page's window is closed (its red button). */
async function closeWindow(app: ElectronApplication, win: Page) {
  const bw = await app.browserWindow(win);
  await bw.evaluate((b) => { setTimeout(() => b.close(), 0); });
}

/** Ends the app without its quit question (a failed test may leave something busy); atelierd is stopped after. */
const shut = async (app: ElectronApplication) => {
  await app.evaluate(({ app: a }) => a.exit(0)).catch(() => {});
  await app.close().catch(() => {});
};

/** Opens the project again, as `atelier <folder>` would; its new window. */
async function reopen(app: ElectronApplication, project: string): Promise<Page> {
  // The page goes a moment before its window: until then the project counts as open (its window would come forward).
  await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter((b) => !b.isDestroyed()).length)).toBe(0);
  const next = app.waitForEvent('window');
  await app.evaluate(({ app: a }, p) => { a.emit('second-instance', {}, [`--project=${p}`]); }, project);
  const win = await next;
  await expect(win.locator('.header')).toBeVisible();
  return win;
}

async function launch(project: string, env: Record<string, string>) {
  const app = await electron.launch({ args: ['out/main/index.js', `--project=${project}`], env });
  const win = await app.firstWindow();
  await expect(win.locator('.header')).toBeVisible();
  await stubNative(app);
  return { app, win };
}

test('nothing busy: the window closes at once; the Claude session waits under Resume, the shell is gone, the Shelf stays', async () => {
  const project = mkdtempSync(join(tmpdir(), 'atl-prj-'));
  writeFileSync(join(project, 'notes.md'), '# notes\n');
  const { env, home } = e2eEnv({ ATELIER_TEST_CLOSE_SESSIONS: '', ATELIER_CLAUDE_BIN: resolve('tests/e2e/fake-claude.pl'), ATELIER_FAKE_SESSION_ID: SID });
  const { app, win } = await launch(project, env);
  try {
    await api(win).session('Alfa');
    await expect.poll(() => api(win).state('Alfa'), { timeout: 15000 }).toBe('waiting');
    await api(win).type('Alfa', '\r');
    await expect.poll(() => api(win).state('Alfa'), { timeout: 10000 }).toBe('done');
    await api(win).terminal();
    await expect(win.locator('.term-row')).toHaveCount(1, { timeout: 15000 });
    // A file on the Shelf (from the tree's menu).
    await win.locator('.activity-bar').getByRole('button', { name: /^Files/ }).click();
    await win.locator('.tree-row', { hasText: 'notes.md' }).click({ button: 'right' });
    await win.getByRole('menuitem', { name: 'Add to Shelf' }).click();
    await win.locator('.activity-bar').getByRole('button', { name: /^Sessions/ }).click();
    await expect(win.locator('.shelf-row')).toHaveCount(1);

    const gone = win.waitForEvent('close');
    await closeWindow(app, win);
    await gone;
    expect(await nativeAsked(app)).toBe(0);

    const again = await reopen(app, project);
    await expect(again.locator('.resume-row', { hasText: 'Alfa' })).toBeVisible({ timeout: 15000 });
    await expect(again.locator('.session-row')).toHaveCount(0);
    await expect(again.locator('.term-row')).toHaveCount(0);
    expect(await api(again).count()).toBe(0);
    await expect(again.locator('.shelf-row', { hasText: 'notes.md' })).toBeVisible();
    await again.mouse.move(0, 0);
    await look(again.locator('.sidebar'), 'test-results/close-sessions-idle-resume.png', { settle: 400 });
  } finally {
    await shut(app);
    try { process.kill(daemonPid(home), 'SIGTERM'); } catch { /* already stopped */ }
  }
});

test('busy: the window asks; Cancel keeps it, Keep in Background leaves everything running, Stop and Close stops it', async () => {
  const project = mkdtempSync(join(tmpdir(), 'atl-prj-'));
  const { env, home } = e2eEnv({ ATELIER_TEST_CLOSE_SESSIONS: '', ATELIER_CLAUDE_BIN: resolve('tests/e2e/fake-claude.pl'), ATELIER_FAKE_SESSION_ID: SID });
  const { app, win } = await launch(project, env);
  try {
    await api(win).session('Alfa');
    await expect.poll(() => api(win).state('Alfa'), { timeout: 15000 }).toBe('waiting');
    await api(win).terminal();
    await expect(win.locator('.term-row')).toHaveCount(1, { timeout: 15000 });
    const shell = await api(win).shellTitle();
    // Claude working, a command running in the shell.
    await api(win).type('Alfa', 'hold\r');
    await api(win).type(shell, 'sleep 45\r');
    await expect.poll(() => api(win).state('Alfa'), { timeout: 10000 }).toBe('running');
    // Its pid comes a moment after create (the shell's launchd job reports it).
    await expect.poll(async () => runsCommand(await api(win).shellPid()), { timeout: 10000 }).toBe(true);

    // Cancel: the window stays, nothing stops.
    await closeWindow(app, win);
    const sheet = win.locator('.confirm-sheet.close-sessions');
    await expect(sheet).toBeVisible({ timeout: 10000 });
    await expect(sheet).toContainText(`Close “${project.split('/').at(-1)}”?`);
    await expect(sheet.locator('.close-busy-row', { hasText: 'Alfa' })).toContainText('Working');
    await expect(sheet.locator('.close-busy-row', { hasText: 'sleep 45' })).toContainText('Running');
    await expect(sheet.getByRole('button', { name: 'Keep in Background' })).toBeFocused();
    await look(win, 'test-results/close-sessions-sheet.png', { settle: 400 });
    await win.keyboard.press('Escape');
    await expect(sheet).toHaveCount(0);
    await expect(win.locator('.header')).toBeVisible();
    expect(await api(win).count()).toBe(2);

    // Keep in Background: the window goes, the sessions run on.
    let gone = win.waitForEvent('close');
    await closeWindow(app, win);
    await sheet.getByRole('button', { name: 'Keep in Background' }).click();
    await gone;
    let again = await reopen(app, project);
    await expect(again.locator('.session-row', { hasText: 'Alfa' })).toBeVisible({ timeout: 15000 });
    await expect(again.locator('.resume-row')).toHaveCount(0);
    expect(await api(again).count()).toBe(2);

    // Stop and Close: both stop (Claude still holds its turn); the Claude session waits under Resume.
    await expect.poll(() => api(again).state('Alfa'), { timeout: 10000 }).toBe('running');
    gone = again.waitForEvent('close');
    await closeWindow(app, again);
    const sheet2 = again.locator('.confirm-sheet.close-sessions');
    await expect(sheet2).toBeVisible({ timeout: 10000 });
    await sheet2.getByRole('button', { name: 'Stop and Close' }).click();
    await gone;
    again = await reopen(app, project);
    await expect(again.locator('.resume-row', { hasText: 'Alfa' })).toBeVisible({ timeout: 15000 });
    expect(await api(again).count()).toBe(0);
    expect(await nativeAsked(app)).toBe(0);
  } finally {
    await shut(app);
    try { process.kill(daemonPid(home), 'SIGTERM'); } catch { /* already stopped */ }
  }
});

test('⌘Q asks once in the window when a session is busy: Keep in Background quits and the session runs on; an idle quit stops it', async () => {
  const project = mkdtempSync(join(tmpdir(), 'atl-prj-'));
  const { env, home } = e2eEnv({ ATELIER_TEST_CLOSE_SESSIONS: '', ATELIER_CLAUDE_BIN: resolve('tests/e2e/fake-claude.pl'), ATELIER_FAKE_SESSION_ID: SID });
  let { app, win } = await launch(project, env);
  try {
    await api(win).session('Alfa');
    await expect.poll(() => api(win).state('Alfa'), { timeout: 15000 }).toBe('waiting');
    await api(win).type('Alfa', 'hold\r');
    await expect.poll(() => api(win).state('Alfa'), { timeout: 10000 }).toBe('running');

    await app.evaluate(({ app: a }) => { setTimeout(() => a.quit(), 0); });
    const sheet = win.locator('.confirm-sheet.close-sessions');
    await expect(sheet).toContainText('Quit Atelier?');
    await expect(sheet).toContainText('Working');
    await look(win, 'test-results/close-sessions-quit.png', { settle: 400 });
    const closed = app.waitForEvent('close');
    await sheet.getByRole('button', { name: 'Keep in Background' }).click();
    await closed;

    // Opened again: Alfa still runs (atelierd kept it).
    ({ app, win } = await launch(project, env));
    await expect(win.locator('.session-row', { hasText: 'Alfa' })).toBeVisible({ timeout: 15000 });
    await expect(win.locator('.resume-row')).toHaveCount(0);
    // Idle now: quitting asks nothing and stops it.
    await api(win).type('Alfa', '\r');
    await expect.poll(() => api(win).state('Alfa'), { timeout: 10000 }).not.toBe('running');
    const closed2 = app.waitForEvent('close');
    await app.evaluate(({ app: a }) => { setTimeout(() => a.quit(), 0); });
    await closed2;

    ({ app, win } = await launch(project, env));
    await expect(win.locator('.resume-row', { hasText: 'Alfa' })).toBeVisible({ timeout: 15000 });
    await expect(win.locator('.session-row')).toHaveCount(0);
  } finally {
    await shut(app);
    try { process.kill(daemonPid(home), 'SIGTERM'); } catch { /* already stopped */ }
  }
});
