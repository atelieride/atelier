import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { e2eEnv } from './env';
import { look } from './shots';

// Claude Code's usage-limit pause and the Claude Code compatibility row in
// the real app: this build's atelierd, the fake Claude sending real hooks through the bridge ("ev:<what>" lines, see
// fake-claude.pl). Its status line puts the account at 100 % of the 5-hour window, reset in 2 hours (ATELIER_FAKE_5H):
// a rate_limit stop is then a usage limit Claude Code continues by itself. The fake's process is `perl`, so no Claude
// Code version is known (it counts as one that waits).

type Api = { terminals: { list(): Promise<{ id: string; title: string }[]>; input(id: string, data: string): void } };

const RESET_S = 7200;

async function launch(): Promise<{ app: ElectronApplication; home: string; win: Page; clipboardLog: string }> {
  const project = mkdtempSync(join(tmpdir(), 'atl-prj-'));
  const { env, home } = e2eEnv({ ATELIER_CLAUDE_BIN: resolve('tests/e2e/fake-claude.pl'), ATELIER_FAKE_5H: `100:${RESET_S}` });
  const app = await electron.launch({ args: ['out/main/index.js', `--project=${project}`], env });
  return { app, home, win: await app.firstWindow(), clipboardLog: env.ATELIER_TEST_CLIPBOARD_LOG! };
}

async function stop(app: ElectronApplication, home: string) {
  await app.close();
  try { process.kill((JSON.parse(readFileSync(join(home, 'atelierd.json'), 'utf8')) as { pid: number }).pid, 'SIGTERM'); } catch { /* already stopped */ }
}

const row = (win: Page, name: string) => win.locator('.session-row').filter({ has: win.locator('.session-title', { hasText: new RegExp(`^${name}$`) }) });
const subtitle = (win: Page, name: string) => row(win, name).locator('.session-activity');

async function newSession(win: Page, name: string) {
  await win.locator('.btn-new').click();
  await win.getByRole('menuitem', { name: 'Claude Session' }).click();
  await win.getByPlaceholder('Session name (optional)').fill(name);
  await win.keyboard.press('Enter');
  await expect(row(win, name)).toHaveClass(/state-waiting/, { timeout: 20000 });
}

/** Types into a session's prompt without selecting it. */
async function typeInto(win: Page, title: string, text: string) {
  await win.evaluate(async ({ title, text }) => {
    const api = (window as unknown as { atelier: Api }).atelier;
    const id = (await api.terminals.list()).find((x) => x.title === title)!.id;
    api.terminals.input(id, text);
  }, { title, text });
}

/** The grouped list: [section label, row titles] in order. */
const sections = (win: Page) => win.locator('.list.inbox').evaluateAll((lists) => {
  const out: [string, string[]][] = [];
  for (const el of lists[0]?.children ?? []) {
    if (el.classList.contains('inbox-head')) out.push([el.querySelector('.section-label')?.textContent ?? '', []]);
    else if (el.classList.contains('session-row')) out.at(-1)?.[1].push(el.querySelector('.session-title')?.textContent ?? '');
  }
  return out;
});

/** Animations off for screenshots that are looked at. */
const still = (win: Page) => win.addStyleTag({ content: '*, *::before, *::after { animation: none !important; transition: none !important; }' });

/** What the row says for a reset at `ms`, as the app writes it: the local clock, "tomorrow" when the day differs. */
function continuesLine(ms: number): string {
  const d = new Date(ms);
  const clock = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return `Usage limit · continues ${d.getDate() === new Date().getDate() ? '' : 'tomorrow '}at ${clock}`;
}

/** The texts copied in the test log, oldest first. */
const copied = (log: string) => { try { return readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as string); } catch { return []; } };

test('a usage-limit stop reads as a pause under Working with no "stopped" entry; Claude Code continuing makes it work again, its auto-continue off makes it today\'s error', async () => {
  const { app, home, win } = await launch();
  try {
    await newSession(win, 'Paused');
    await newSession(win, 'NoResume');
    // Both answer their permission request and finish their turn.
    for (const name of ['Paused', 'NoResume']) await typeInto(win, name, '\r');
    for (const name of ['Paused', 'NoResume']) await expect(row(win, name)).toHaveClass(/state-done/, { timeout: 10000 });

    // A new turn stopped by the usage limit: a pause until the 5-hour window resets, about 2 hours from now.
    await typeInto(win, 'Paused', 'ev:work\rev:limit\r');
    const line = subtitle(win, 'Paused');
    await expect(line).toHaveText(/^Usage limit · continues (tomorrow )?at \d\d:\d\d$/, { timeout: 10000 });
    // The fake's reset was set when it started, some seconds ago: the clock is that of now + 2 h, give or take two minutes.
    const now = Date.now();
    expect([-120_000, -60_000, 0, 60_000, 120_000].map((d) => continuesLine(now + RESET_S * 1000 + d))).toContain(await line.textContent());
    await expect(line).toHaveAttribute('data-tip', 'Claude Code continues this task by itself when your usage limit resets. Esc in the session cancels.');
    // Never an error: the badge is muted, the row sits under Working, nothing needs you.
    const paused = row(win, 'Paused');
    await expect(paused).toHaveClass(/state-idle/);
    await expect(paused).not.toHaveClass(/state-error/);
    // Quiet: a pause needs nothing, so the row isn't unread (its finished turn before was).
    await expect(paused).not.toHaveClass(/is-unread/);
    await expect.poll(() => sections(win)).toContainEqual(['Working', ['Paused']]);
    expect((await sections(win)).map(([label]) => label)).not.toContain('Needs you');
    await still(win);
    await look(win.locator('.sidebar'), 'test-results/limit-pause-row.png');

    // Claude Code continues the task by itself at the reset: working again, the pause gone.
    await typeInto(win, 'Paused', 'ev:notify:quota_auto_resume_fired\r');
    await expect(paused).toHaveClass(/state-running/);
    await expect(paused).not.toContainText('Usage limit');
    await expect.poll(() => sections(win)).toContainEqual(['Working', ['Paused']]);

    // Another session pauses too, then Claude Code says it won't continue (auto-continue off): today's error, under
    // Needs you.
    await typeInto(win, 'NoResume', 'ev:work\rev:limit\r');
    await expect(subtitle(win, 'NoResume')).toHaveText(/^Usage limit · continues /, { timeout: 10000 });
    await typeInto(win, 'NoResume', 'ev:notify:quota_auto_resume_disabled\r');
    await expect(subtitle(win, 'NoResume')).toHaveText('Rate limit');
    await expect(subtitle(win, 'NoResume')).toHaveAttribute('data-tip', 'Claude Code error: rate_limit');
    await expect(row(win, 'NoResume')).toHaveClass(/state-error/);
    await expect.poll(() => sections(win)).toContainEqual(['Needs you', ['NoResume']]);

    // The notification center: the stop that needs you has its entry; the pause never got one (it came earlier, so it
    // would be there by now).
    await win.locator('.bell-btn').click();
    const stopped = win.locator('.notes-pop .note-row').filter({ hasText: 'Stopped with an error' });
    await expect(stopped).toHaveCount(1, { timeout: 10000 });
    await expect(stopped.locator('.note-title')).toHaveText('NoResume');
    await expect(stopped.locator('.note-detail')).toHaveText('Stopped with an error · Rate limit');
    await win.keyboard.press('Escape');
  } finally {
    await stop(app, home);
  }
});

test('Settings › Claude › Claude Code compatibility: a notification type Atelier doesn\'t know is listed, Copy gives it for a bug report, Clear empties the notebook', async () => {
  const { app, home, win, clipboardLog } = await launch();
  try {
    await newSession(win, 'Notes');
    // Only what Atelier knows (start, prompt, tools, status line, permission, Stop), then one type it doesn't.
    await typeInto(win, 'Notes', '\rev:notify:brand_new_type\r');
    await expect(row(win, 'Notes')).toHaveClass(/state-done/, { timeout: 10000 });

    await win.getByRole('button', { name: 'Settings' }).click();
    const dialog = win.getByRole('dialog', { name: 'Settings' });
    await dialog.getByRole('button', { name: 'Claude' }).click();
    const compat = dialog.getByTestId('claude-compat');
    const fold = compat.locator('.compat-fold');
    // atelierd announces its notebook at most every 2 s.
    await expect(fold).toHaveText("1 value Atelier doesn't recognize yet", { timeout: 10000 });
    await expect(fold).toHaveAttribute('aria-expanded', 'false');
    await fold.click();
    await expect(fold).toHaveAttribute('aria-expanded', 'true');
    const entries = compat.locator('.compat-list li');
    await expect(entries).toHaveCount(1);
    await expect(entries).toHaveText(/^Notification · notification type · brand_new_type · unknown version · 1× · last \d\d:\d\d$/);
    // The row fits the sheet at its default width: nothing spills sideways.
    expect(await compat.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(0);
    expect(await compat.locator('.compat-list').evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(0);
    await still(win);
    await look(compat, 'test-results/limit-pause-compat.png');

    // Copy: the versions, then the entry with its full date, through main's clipboard (a test log here).
    await compat.getByRole('button', { name: 'Copy', exact: true }).click();
    await expect.poll(() => copied(clipboardLog).at(-1)).toMatch(/^Atelier \S+\nClaude Code unknown\nNotification · notification type · brand_new_type · unknown version · 1× · last \d{4}-\d\d-\d\dT[\d:.]+Z$/);
    await expect(win.locator('.toast')).toContainText('Copied');

    // The palette's command: Settings › Claude at the row, the keyboard on the list's toggle.
    await win.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await win.keyboard.press('F1');
    await win.locator('.palette-input').fill('>Claude Code Compatibility');
    await expect(win.locator('.palette-item', { hasText: 'Claude Code Compatibility…' })).toBeVisible();
    await win.keyboard.press('Enter');
    await expect(fold).toBeFocused();

    // Clear: the notebook is empty again.
    await compat.getByRole('button', { name: 'Clear', exact: true }).click();
    await expect(compat.locator('.compat-status')).toHaveText('Everything Claude Code sends is recognized.');
    await expect(entries).toHaveCount(0);
    await expect(compat.getByRole('button', { name: 'Clear', exact: true })).toBeDisabled();
  } finally {
    await stop(app, home);
  }
});
