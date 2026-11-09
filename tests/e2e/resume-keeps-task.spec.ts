import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { e2eEnv } from './env';
import type { AtelierApi } from '../../src/shared/api';
import { look } from './shots';

// A session waiting under Resume keeps its task link and its pin, also when a resume is stopped before its Claude starts
// (its window closed meanwhile, as during Resume all): atelierd gives the entry back under the resumed terminal's id,
// where the app had already moved the link and the pin. It once came back under the old id and both were pruned.

const SID = '66666666-6666-4666-8666-666666666666';
const LINK = { source: 'clickup', taskId: 'abc101', displayId: 'ENG-101', title: 'Fix the login redirect', url: 'https://app.clickup.com/t/abc101' };
const daemonPid = (home: string) => (JSON.parse(readFileSync(join(home, 'atelierd.json'), 'utf8')) as { pid: number }).pid;
const terminals = (win: Page) => win.evaluate(async () => (await (window as unknown as { atelier: AtelierApi }).atelier.terminals.list()).map((t) => ({ id: t.id, title: t.title, root: t.projectRoot, state: t.session?.state ?? null })));

/**
 * The page's window is closed (its red button) and its sessions wait under Resume: at once when nothing is busy, else
 * through the window's question (Stop and Close).
 */
async function closeWindow(app: ElectronApplication, win: Page, o: { asks?: boolean } = {}) {
  const gone = win.waitForEvent('close');
  const bw = await app.browserWindow(win);
  await bw.evaluate((b) => { setTimeout(() => b.close(), 0); });
  if (o.asks) await win.locator('.confirm-sheet.close-sessions').getByRole('button', { name: 'Stop and Close' }).click();
  await gone;
}

/** Opens the project again, as `atelier <folder>` would; its new window. */
async function reopen(app: ElectronApplication, project: string): Promise<Page> {
  await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter((b) => !b.isDestroyed()).length)).toBe(0);
  const next = app.waitForEvent('window');
  await app.evaluate(({ app: a }, p) => { a.emit('second-instance', {}, [`--project=${p}`]); }, project);
  const win = await next;
  await expect(win.locator('.header')).toBeVisible();
  return win;
}

test('a resume stopped before its Claude starts keeps the session’s task link and pin under Resume', async () => {
  const project = mkdtempSync(join(tmpdir(), 'atl-prj-'));
  const gate = join(mkdtempSync(join(tmpdir(), 'atl-gate-')), 'go');
  const { env, home } = e2eEnv({ ATELIER_TEST_CLOSE_SESSIONS: '', ATELIER_CLAUDE_BIN: resolve('tests/e2e/fake-claude.pl'), ATELIER_FAKE_SESSION_ID: SID, ATELIER_FAKE_START_GATE: gate });
  /** One waiting Claude starts (it takes the gate file away). */
  const release = async () => {
    writeFileSync(gate, '');
    await expect.poll(() => existsSync(gate), { timeout: 15000 }).toBe(false);
  };
  const app = await electron.launch({ args: ['out/main/index.js', `--project=${project}`], env });
  let win = await app.firstWindow();
  try {
    await expect(win.locator('.header')).toBeVisible();
    void win.evaluate(() => (window as unknown as { atelier: AtelierApi }).atelier.terminals.createSession({ cols: 100, rows: 30, name: 'Alfa' }));
    await release();
    await expect(win.locator('.session-row', { hasText: 'Alfa' })).toBeVisible({ timeout: 15000 });
    await expect.poll(async () => (await terminals(win)).find((x) => x.title === 'Alfa')?.state, { timeout: 15000 }).toBe('waiting');
    // Started from a task (the link a task's Start Session saves), and pinned.
    const alfa = (await terminals(win)).find((x) => x.title === 'Alfa')!;
    await win.evaluate(({ root, id, link }) => { localStorage.setItem('atelier.taskLinks', JSON.stringify({ [root]: { [id]: link } })); }, { root: alfa.root, id: alfa.id, link: LINK });
    await win.reload();
    await expect(win.locator('.header')).toBeVisible();
    await win.locator('.session-row', { hasText: 'Alfa' }).click({ button: 'right' });
    await win.getByRole('menuitem', { name: 'Pin' }).click();
    await win.locator('.session-row', { hasText: 'Alfa' }).click();
    await expect(win.locator('.session-bar .tchip')).toHaveText('ENG-101', { timeout: 10000 });
    // Its turn ends: nothing busy, the window closes without asking.
    await win.evaluate((id) => { (window as unknown as { atelier: AtelierApi }).atelier.terminals.input(id, '\r'); }, alfa.id);
    await expect.poll(async () => (await terminals(win)).find((x) => x.title === 'Alfa')?.state, { timeout: 15000 }).toBe('done');

    await closeWindow(app, win);
    win = await reopen(app, project);
    const row = win.locator('.resume-row', { hasText: 'Alfa' });
    await expect(row).toBeVisible({ timeout: 15000 });
    await expect(row.locator('.av-pin')).toBeVisible();

    // Resumed, then its window closed while its Claude still waits to start (`claude --resume` in the foreground: the
    // window asks): the entry comes back under Resume.
    await row.getByRole('button', { name: 'Resume' }).click();
    await expect(win.locator('.session-row', { hasText: 'Alfa' })).toBeVisible({ timeout: 15000 });
    await expect(win.locator('.xterm-rows:visible')).toContainText('FAKE-CLAUDE starting', { timeout: 15000 });
    await closeWindow(app, win, { asks: true });
    win = await reopen(app, project);
    const again = win.locator('.resume-row', { hasText: 'Alfa' });
    await expect(again).toBeVisible({ timeout: 15000 });
    await expect(again.locator('.av-pin')).toBeVisible();

    // Resumed for real: the task chip and the pin are back on the session.
    await again.getByRole('button', { name: 'Resume' }).click();
    await release();
    const session = win.locator('.session-row', { hasText: 'Alfa' });
    await expect(session).toBeVisible({ timeout: 15000 });
    await expect(session.locator('.av-pin')).toBeVisible();
    await session.click();
    await expect(win.locator('.session-bar .tchip')).toHaveText('ENG-101', { timeout: 10000 });
    await win.mouse.move(0, 0);
    await look(win, 'test-results/resume-keeps-task.png', { settle: 400 });
  } finally {
    await app.evaluate(({ app: a }) => a.exit(0)).catch(() => {});
    await app.close().catch(() => {});
    try { process.kill(daemonPid(home), 'SIGTERM'); } catch { /* already stopped */ }
  }
});
