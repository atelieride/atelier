import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { e2eEnv } from './env';
import type { AtelierApi } from '../../src/shared/api';
import { look } from './shots';

// Keep closed sessions under Resume: off (the default), closing a session asks and
// ends it as before; on, an idle one closes without a question and waits under Resume with its pin, a working one asks
// and says so, Resume brings it back, the Resume row's × dismisses it.

// Resumables need a real session id (a UUID): the fake sessions share one, their terminals tell them apart.
const SID = '66666666-6666-4666-8666-666666666666';
const LINK = { source: 'clickup', taskId: 'abc101', displayId: 'ENG-101', title: 'Fix the login redirect', url: 'https://app.clickup.com/t/abc101' };
const daemonPid = (home: string) => (JSON.parse(readFileSync(join(home, 'atelierd.json'), 'utf8')) as { pid: number }).pid;
const terminals = (win: Page) => win.evaluate(async () => (await (window as unknown as { atelier: AtelierApi }).atelier.terminals.list()).map((t) => ({ id: t.id, title: t.title, projectRoot: t.projectRoot })));
const api = (win: Page) => ({
  session: (name: string) => win.evaluate((n) => (window as unknown as { atelier: AtelierApi }).atelier.terminals.createSession({ cols: 100, rows: 30, name: n }), name),
  state: (title: string) => win.evaluate(async (t) => (await (window as unknown as { atelier: AtelierApi }).atelier.terminals.list()).find((x) => x.title === t)?.session?.state ?? null, title),
  type: (title: string, text: string) => win.evaluate(async ({ title, text }) => {
    const a = (window as unknown as { atelier: AtelierApi }).atelier;
    const id = (await a.terminals.list()).find((x) => x.title === title)!.id;
    a.terminals.input(id, text);
  }, { title, text })
});

async function launch() {
  const project = mkdtempSync(join(tmpdir(), 'atl-prj-'));
  const { env, home } = e2eEnv({ ATELIER_CLAUDE_BIN: resolve('tests/e2e/fake-claude.pl'), ATELIER_FAKE_SESSION_ID: SID });
  const app = await electron.launch({ args: ['out/main/index.js', `--project=${project}`], env });
  const win = await app.firstWindow();
  await expect(win.locator('.header')).toBeVisible();
  return { app, win, home };
}

const shut = async (app: ElectronApplication, home: string) => {
  await app.close().catch(() => {});
  try { process.kill(daemonPid(home), 'SIGTERM'); } catch { /* already stopped */ }
};

/** A session whose turn is over (the fake starts waiting on a permission: Enter ends its turn). */
async function doneSession(win: Page, name: string) {
  await api(win).session(name);
  await expect.poll(() => api(win).state(name), { timeout: 15000 }).toBe('waiting');
  await api(win).type(name, '\r');
  await expect.poll(() => api(win).state(name), { timeout: 10000 }).toBe('done');
}

const sessionRow = (win: Page, name: string) => win.locator('.session-row', { hasText: name });
const resumeRow = (win: Page, name: string) => win.locator('.resume-row', { hasText: name });

async function closeFromRow(win: Page, name: string) {
  const row = sessionRow(win, name);
  await row.hover();
  await row.locator('.row-close').click();
}

test('off (the default): closing an idle session asks as before and ends it — nothing under Resume', async () => {
  const { app, win, home } = await launch();
  try {
    await doneSession(win, 'Alfa');
    await closeFromRow(win, 'Alfa');
    const asking = win.locator('.session-row.is-confirming');
    await expect(asking.locator('.confirm-stops')).toHaveText('Claude stops.');
    await expect(asking.locator('.confirm-note')).toContainText('Resume a session…');
    await asking.locator('.btn-danger').click();
    await expect(sessionRow(win, 'Alfa')).toHaveCount(0, { timeout: 10000 });
    // atelierd sends the resumables before the list without the terminal: had it kept one, it would be there by now.
    await expect(win.locator('.resume-row')).toHaveCount(0);
    expect(await win.evaluate(() => (window as unknown as { atelier: AtelierApi }).atelier.resumables())).toEqual([]);
  } finally {
    await shut(app, home);
  }
});

test('on: an idle session closes at once and waits under Resume with its pin; a working one asks; Resume and × act on the row', async () => {
  const { app, win, home } = await launch();
  try {
    // Turned on where people find it: Settings › Claude.
    await win.getByRole('button', { name: 'Settings' }).click();
    const dialog = win.getByRole('dialog', { name: 'Settings' });
    await dialog.getByRole('button', { name: 'Claude' }).click();
    const toggle = dialog.getByRole('switch', { name: 'Keep closed sessions under Resume' });
    await expect(toggle).toBeEnabled();
    await expect(toggle).toHaveAttribute('aria-checked', 'false');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
    await look(dialog, 'test-results/keep-closed-sessions-setting.png', { settle: 300 });
    await win.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);

    // Idle, pinned and started from a task (the link a task's Start Session saves): no question, the row goes and comes
    // back under Resume, pin badge included; the link follows it.
    await doneSession(win, 'Beta');
    const beta = (await terminals(win)).find((x) => x.title === 'Beta')!;
    await win.evaluate(({ root, id, link }) => { localStorage.setItem('atelier.taskLinks', JSON.stringify({ [root]: { [id]: link } })); }, { root: beta.projectRoot, id: beta.id, link: LINK });
    await win.reload();
    await expect(win.locator('.header')).toBeVisible();
    await sessionRow(win, 'Beta').click();
    await expect(win.locator('.session-bar .tchip')).toHaveText('ENG-101', { timeout: 10000 });
    await sessionRow(win, 'Beta').click({ button: 'right' });
    await win.getByRole('menuitem', { name: 'Pin', exact: true }).click();
    await closeFromRow(win, 'Beta');
    await expect(win.locator('.session-row.is-confirming')).toHaveCount(0);
    await expect(resumeRow(win, 'Beta')).toBeVisible({ timeout: 10000 });
    await expect(sessionRow(win, 'Beta')).toHaveCount(0);
    await expect(resumeRow(win, 'Beta').locator('.av-pin')).toBeVisible();

    // Working: it asks, and says where it goes.
    await api(win).session('Gamma');
    await expect.poll(() => api(win).state('Gamma'), { timeout: 15000 }).toBe('waiting');
    await api(win).type('Gamma', 'hold\r');
    await expect.poll(() => api(win).state('Gamma'), { timeout: 10000 }).toBe('running');
    await closeFromRow(win, 'Gamma');
    const asking = win.locator('.session-row.is-confirming');
    await expect(asking.locator('.confirm-stops')).toHaveText('Claude is working: it stops.');
    await expect(asking.locator('.confirm-note')).toHaveText('It waits under Resume.');
    await win.mouse.move(0, 0);
    await look(win.locator('.sidebar'), 'test-results/keep-closed-sessions-ask.png', { settle: 300 });
    await asking.locator('.btn-danger').click();
    await expect(resumeRow(win, 'Gamma')).toBeVisible({ timeout: 10000 });
    await expect(sessionRow(win, 'Gamma')).toHaveCount(0);
    await win.mouse.move(0, 0);
    await look(win.locator('.sidebar'), 'test-results/keep-closed-sessions-resume.png', { settle: 400 });

    // The Resume row's ×: gone from Resume.
    await resumeRow(win, 'Gamma').getByRole('button', { name: 'Dismiss' }).click();
    await expect(resumeRow(win, 'Gamma')).toHaveCount(0, { timeout: 10000 });

    // Resume: back as a session, still pinned, still linked to its task.
    await resumeRow(win, 'Beta').locator('.resume-btn').click();
    await expect(sessionRow(win, 'Beta')).toBeVisible({ timeout: 15000 });
    await expect(resumeRow(win, 'Beta')).toHaveCount(0);
    await win.mouse.move(600, 400);
    await expect(sessionRow(win, 'Beta').locator('.av-pin')).toBeVisible();
    await sessionRow(win, 'Beta').click();
    await expect(win.locator('.session-bar .tchip')).toHaveText('ENG-101', { timeout: 10000 });
  } finally {
    await shut(app, home);
  }
});
