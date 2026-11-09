import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { e2eEnv } from './env';
import { look } from './shots';

// Scheduled prompts with a fake Claude that logs every byte typed into it
// (fake-claude-keys.pl, bracketed paste on as Claude Code's prompt): schedule, see, clash, edit, delete + Undo, Send Now.

async function launch(extra: Record<string, string> = {}): Promise<{ app: ElectronApplication; home: string; keys: string }> {
  const project = mkdtempSync(join(tmpdir(), 'atl-prj-'));
  const keysDir = mkdtempSync(join(tmpdir(), 'atl-keys-'));
  const keys = join(keysDir, 'keys.log');
  writeFileSync(keys, '');
  const { env, home } = e2eEnv({ ATELIER_CLAUDE_BIN: resolve('tests/e2e/fake-claude-keys.pl'), ATELIER_FAKE_KEYS_LOG: keys, ATELIER_FAKE_BRACKETED: '1', ...extra });
  const app = await electron.launch({ args: ['out/main/index.js', `--project=${project}`], env });
  return { app, home, keys };
}

async function stop(app: ElectronApplication, home: string) {
  await app.close();
  try { process.kill((JSON.parse(readFileSync(join(home, 'atelierd.json'), 'utf8')) as { pid: number }).pid, 'SIGTERM'); } catch { /* already stopped */ }
}

async function newSession(win: Page, name: string) {
  await win.locator('.btn-new').click();
  await win.getByRole('menuitem', { name: 'Claude Session' }).click();
  await win.getByPlaceholder('Session name (optional)').fill(name);
  await win.keyboard.press('Enter');
  await expect(win.locator('.session-row', { hasText: name })).toHaveClass(/state-done/, { timeout: 20000 });
}

const sheet = (win: Page) => win.getByRole('dialog', { name: /Schedule a prompt|Edit scheduled prompt/ });

test('schedule a prompt from the bar, see it, clash and fix, edit, delete with Undo, Send Now types it into Claude', async () => {
  const { app, home, keys } = await launch();
  try {
    const win = await app.firstWindow();
    await newSession(win, 'Sched');

    // The bar's button opens the composer on this session; Schedule stays off until text and a time.
    await win.locator('.session-bar .sb-schedule').click();
    const s = sheet(win);
    await expect(s).toBeVisible();
    await expect(s.locator('.sp-target')).toContainText('Sched');
    // A click on the sheet's own text keeps the keyboard in it: Esc still closes it.
    await s.locator('.sp-title').click();
    await win.keyboard.press('Escape');
    await expect(s).toBeHidden();
    await win.locator('.session-bar .sb-schedule').click();
    await expect(s).toBeVisible();
    const submit = s.getByRole('button', { name: /^Schedule/ });
    await expect(submit).toBeDisabled();
    await s.getByRole('textbox', { name: 'What should Claude do then?' }).fill('run the tests');
    await expect(submit).toBeDisabled();
    await s.getByRole('button', { name: /^In 1 hour/ }).click();
    await expect(s.locator('.sp-summary')).toHaveText(/^Sends (today|tomorrow) at \d\d:\d\d · in (1 h|59 min)$/);
    const first = await s.getByRole('textbox', { name: 'Time' }).inputValue();
    // In 1 hour may cross midnight: the second prompt goes on the same day.
    const tomorrow = (await s.locator('.sp-summary').innerText()).startsWith('Sends tomorrow');
    await look(win, 'test-results/scheduled-prompts-composer.png', { settle: 300 });
    await win.keyboard.press('Meta+Enter');
    await expect(s).toBeHidden();
    await expect(win.locator('.toast')).toContainText(`Scheduled for`);

    // The chip in the bar and the time on the row.
    const chip = win.locator('.session-bar .sp-chip');
    await expect(chip).toContainText(first);
    await expect(win.locator('.session-row .sp-chip')).toContainText(first);

    // The row's menu: a second prompt at the same minute is refused before submitting, and the fix moves it on.
    await win.locator('.session-row', { hasText: 'Sched' }).click({ button: 'right' });
    await win.getByRole('menuitem', { name: /^Schedule Prompt…/ }).click();
    await s.getByRole('textbox', { name: 'What should Claude do then?' }).fill('update the docs');
    if (tomorrow) await s.getByRole('radio', { name: 'Tomorrow' }).click();
    await s.getByRole('textbox', { name: 'Time' }).fill(first);
    await expect(s.getByRole('alert')).toContainText(`${first} is taken: “run the tests”`);
    await expect(s.getByRole('button', { name: /^Schedule/ })).toBeDisabled();
    await look(win, 'test-results/scheduled-prompts-clash.png', { settle: 300 });
    await s.getByRole('alert').getByRole('button', { name: /^Use / }).click();
    await expect(s.getByRole('alert')).toBeHidden();
    await s.getByRole('button', { name: /^Schedule/ }).click();
    await expect(chip).toContainText('+1');

    // The popover lists both; a click on a row edits it.
    await chip.click();
    const pop = win.getByRole('dialog', { name: 'Scheduled Prompts: Sched' });
    await expect(pop).toBeVisible();
    await expect(pop.locator('.spp-row')).toHaveCount(2);
    await expect(pop.locator('.spp-text').first()).toHaveText('run the tests');
    await look(win, 'test-results/scheduled-prompts-popover.png', { settle: 300 });
    await pop.locator('.spp-main').first().click();
    await expect(sheet(win)).toHaveAccessibleName('Edit scheduled prompt');
    await sheet(win).getByRole('textbox', { name: 'What should Claude do then?' }).fill('run all the tests');
    await sheet(win).getByRole('button', { name: /^Save/ }).click();
    await expect(win.locator('.toast')).toContainText('Saved · sends');

    // Delete the second, then Undo brings it back.
    await chip.click();
    await pop.locator('.spp-row').nth(1).hover();
    await pop.locator('.spp-row').nth(1).getByRole('button', { name: 'Delete' }).click();
    await expect(win.locator('.toast')).toContainText('Scheduled prompt deleted');
    await expect(pop.locator('.spp-row')).toHaveCount(1);
    await win.locator('.toast').getByRole('button', { name: 'Undo' }).click();
    await expect(pop.locator('.spp-row')).toHaveCount(2);

    // Send Now: typed into Claude as one bracketed paste, then Enter; the row goes, the toast says so.
    const before = readFileSync(keys, 'latin1').length;
    await pop.locator('.spp-row').first().hover();
    await pop.locator('.spp-row').first().getByRole('button', { name: 'Send Now' }).click();
    await expect.poll(() => readFileSync(keys, 'latin1').slice(before), { timeout: 10000 }).toBe('\x1b[200~run all the tests\x1b[201~\r');
    await expect(win.locator('.toast')).toContainText('Sent to Sched', { timeout: 10000 });
    await expect(chip).not.toContainText('+1');
  } finally {
    await stop(app, home);
  }
});

test('an atelierd without scheduled prompts: no bar button, the menu item disabled and saying why', async () => {
  const { app, home } = await launch({ ATELIER_TEST_NO_PROFILES: 'schedules' });
  try {
    const win = await app.firstWindow();
    await newSession(win, 'Old');
    await expect(win.locator('.session-bar .sb-model')).toBeVisible();
    await expect(win.locator('.session-bar .sb-schedule')).toHaveCount(0);
    await win.locator('.session-row', { hasText: 'Old' }).click({ button: 'right' });
    const item = win.getByRole('menuitem', { name: /^Schedule Prompt…/ });
    await expect(item).toHaveAttribute('aria-disabled', 'true');
    await expect(item).toHaveAttribute('data-tip', /Restart atelierd/);
  } finally {
    await stop(app, home);
  }
});
