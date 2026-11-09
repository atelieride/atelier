import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { e2eEnv } from './env';
import { look } from './shots';

// Launch flags: flags for all accounts and for one in Settings › Claude, the exact
// command previewed, New Session starting with them (⌥↵ without), and the rose Bypass badge once Claude reports the mode.
// The fake Claude prints its argv (ATELIER_FAKE_PRINT_ARGS), Atelier's --settings left out.

type Api = { terminals: { list(): Promise<{ id: string; title: string }[]>; input(id: string, data: string): void } };

async function launch(): Promise<{ app: ElectronApplication; home: string; win: Page }> {
  const project = mkdtempSync(join(tmpdir(), 'atl-prj-'));
  const { env, home } = e2eEnv({ ATELIER_CLAUDE_BIN: resolve('tests/e2e/fake-claude.pl'), ATELIER_FAKE_PRINT_ARGS: '1' });
  // The app's home is the test's: `~/notes` expands to a folder we know.
  env.HOME = home;
  writeFileSync(join(home, 'preferences.json'), JSON.stringify({
    claudePermissionMode: 'auto',
    claudeAccounts: { list: [{ id: 'default', name: 'Claude', dir: '', color: 1 }, { id: 'work', name: 'Work', dir: join(home, 'cfg', '.claude-work'), color: 2 }], newSession: 'default', dismissed: [] }
  }));
  const app = await electron.launch({ args: ['out/main/index.js', `--project=${project}`], env });
  const win = await app.firstWindow();
  await expect(win.locator('.btn-new')).toBeVisible({ timeout: 15000 });
  return { app, home, win };
}

async function stop(app: ElectronApplication, home: string) {
  await app.close();
  try { process.kill((JSON.parse(readFileSync(join(home, 'atelierd.json'), 'utf8')) as { pid: number }).pid, 'SIGTERM'); } catch { /* already stopped */ }
}

async function typeInto(win: Page, title: string, text: string) {
  await win.evaluate(async ({ title, text }) => {
    const api = (window as unknown as { atelier: Api }).atelier;
    const id = (await api.terminals.list()).find((x) => x.title === title)!.id;
    api.terminals.input(id, text);
  }, { title, text });
}

/** New Session on the Work account, named, started with Enter or ⌥Enter; resolves once its argv shows. */
async function startWork(win: Page, name: string, key: 'Enter' | 'Alt+Enter') {
  await win.locator('.btn-new').click();
  await win.getByRole('menuitem', { name: 'Claude Session' }).click();
  const input = win.getByPlaceholder('Session name (optional)');
  await expect(input).toBeFocused();
  await win.keyboard.press('Tab');
  await expect(win.locator('.new-session-accounts .acct-card').nth(1)).toHaveAttribute('aria-checked', 'true');
  await input.fill(name);
  await win.keyboard.press(key);
  await expect(win.locator('.session-row', { hasText: name })).toHaveCount(1, { timeout: 20000 });
  await expect(win.locator('.xterm-rows:visible')).toContainText('FAKE-CLAUDE args=', { timeout: 15000 });
  return (await win.locator('.xterm-rows:visible').textContent()) ?? '';
}

const still = (win: Page) => win.addStyleTag({ content: '*, *::before, *::after { animation: none !important; transition: none !important; }' });

test('launch flags: set in Settings, previewed exactly, run by New Session; ⌥↵ starts without; Bypass shows', async () => {
  const { app, home, win } = await launch();
  try {
    // The palette opens Settings › Claude at the flags, the field focused.
    await win.keyboard.press('F1');
    await win.locator('.palette-input').fill('>launch flags');
    await win.locator('.palette-item', { hasText: 'Claude Launch Flags…' }).click();
    const section = win.locator('.lf-section');
    await expect(section).toBeVisible();
    const field = section.getByLabel('Add a flag');
    await expect(field).toBeFocused();
    // Arriving doesn't open the suggestions over the card; ↓ does, and Esc closes them, then clears the draft, before
    // a third Esc closes Settings.
    await expect(section.locator('.lf-suggest')).toHaveCount(0);
    await win.keyboard.press('ArrowDown');
    await expect(section.getByRole('listbox')).toBeVisible();
    await win.keyboard.press('Escape');
    await expect(section.locator('.lf-suggest')).toHaveCount(0);
    await expect(section).toBeVisible();
    await field.fill('--ver');
    await win.keyboard.press('Escape');
    await win.keyboard.press('Escape');
    await expect(field).toHaveValue('');
    await expect(section).toBeVisible();
    // A word after a flag that takes none is refused: it would reach Claude as a prompt.
    await field.fill('--verbose hello');
    await win.keyboard.press('Enter');
    await expect(section.getByRole('alert')).toContainText('--verbose takes no value');

    // A reserved flag is refused with where it is set; a typed one becomes a chip, ~ expanded in the preview.
    await field.fill('--model opus');
    await win.keyboard.press('Enter');
    await expect(section.getByRole('alert')).toContainText('set Model above');
    await expect(field).toHaveAttribute('aria-invalid', 'true');
    await field.fill('--add-dir ~/notes');
    await win.keyboard.press('Enter');
    await expect(section.locator('.lf-field .lf-chip')).toHaveText(['--add-dir ~/notes']);
    const preview = section.getByTestId('lf-preview');
    await expect(preview).toHaveText(`claude --name='Fix the login bug' --permission-mode auto '--add-dir' '${home}/notes'`);

    // Work: the shared flags dim, then the skip flag from the suggestions, rose everywhere it applies.
    await section.getByRole('radio', { name: 'Work' }).click();
    await expect(section.locator('.lf-shared .lf-chip')).toHaveText(['--add-dir ~/notes']);
    await field.focus();
    // The suggestions cover the account rows under them (the rows fade in too: their own layers must stay below).
    await section.getByRole('radio', { name: 'All accounts' }).click();
    await field.focus();
    // The field at the top of the sheet's scroll, so the list opens over the rows rather than past the sheet's bottom
    // (where the scroll leaves the field after focus() varies).
    await field.evaluate((el) => el.scrollIntoView({ block: 'start' }));
    await field.fill('--');
    await expect(section.locator('.lf-suggest')).toBeVisible();
    await still(win);
    const covered = () => win.evaluate(() => {
      // While they fade in, the card and each row are layers of their own (as in the app): the card must stay on top.
      for (const el of document.querySelectorAll<HTMLElement>('.lf-card, .acct-row')) el.style.isolation = 'isolate';
      const list = document.querySelector('.lf-suggest')!.getBoundingClientRect();
      // Only what shows of the rows: the sheet's scrolling body clips them (a row scrolled below it is not covered).
      let view = document.querySelector('.acct-row')!.parentElement;
      while (view && !/(auto|scroll)/.test(getComputedStyle(view).overflowY)) view = view.parentElement;
      const clip = view ? view.getBoundingClientRect() : { top: 0, bottom: innerHeight };
      return [...document.querySelectorAll('.acct-row')].flatMap((row) => {
        const r = row.getBoundingClientRect();
        const top = Math.max(r.top, list.top, clip.top);
        const bottom = Math.min(r.bottom, list.bottom - 4, clip.bottom - 1);
        if (bottom <= top) return [];
        // Along the row: its dot and name on the left, its badges and meters on the right.
        return [24, list.width / 2, list.width - 60].map((x) => !!document.elementFromPoint(list.left + x, (top + bottom) / 2)?.closest('.lf-suggest'));
      });
    });
    // Polled: the list settles where it opens a frame or two after the field's input.
    // Polled: the list settles where it opens a frame or two after the field's input.
    await expect.poll(async () => { const c = await covered(); return c.length > 0 && c.every(Boolean); }).toBe(true)
    await look(win.locator('.settings'), 'test-results/launch-flags-suggest.png');
    await section.getByRole('radio', { name: 'Work' }).click();
    await field.focus();
    await field.fill('skip');
    await section.getByRole('option', { name: /--dangerously-skip-permissions/ }).click();
    await expect(section.locator('.lf-field .lf-chip.is-danger')).toHaveText(['--dangerously-skip-permissions']);
    await expect(section.locator('.lf-danger')).toContainText('Work sessions will skip permission prompts.');
    await expect(preview).toHaveText(`CLAUDE_CONFIG_DIR='${home}/cfg/.claude-work' claude --name='Fix the login bug' '--add-dir' '${home}/notes' '--dangerously-skip-permissions'`);
    await expect(win.locator('.set-row', { hasText: 'Permission mode' }).locator('.set-warn.is-danger')).toHaveText('Not used for Work: the launch flags skip permissions.');
    await expect(win.locator('.acct-row', { hasText: 'Work' }).locator('.lf-badge.is-danger')).toHaveText('Skips permissions');
    await expect(win.locator('.acct-row', { hasText: 'Default' }).locator('.lf-badge')).toHaveText('1 flag');
    // Backspace on the empty field removes the last chip; the shared switch leaves the shared flags out.
    await field.focus();
    await win.keyboard.press('Backspace');
    await expect(section.locator('.lf-field .lf-chip')).toHaveCount(0);
    await field.fill('--dangerously-skip-permissions');
    await win.keyboard.press('Enter');
    await still(win);
    await look(win.locator('.settings'), 'test-results/launch-flags-settings.png');
    await win.keyboard.press('Escape');

    // New Session on Work: the flags row in rose, then the exact argv; ⌥↵ starts the next one without them.
    const bold = await startWork(win, 'Bold', 'Enter');
    expect(bold).toContain(`FAKE-CLAUDE args=--name=Bold --add-dir ${home}/notes --dangerously-skip-permissions`);
    expect(bold).not.toContain('--permission-mode');
    await win.locator('.btn-new').click();
    await win.getByRole('menuitem', { name: 'Claude Session' }).click();
    await win.keyboard.press('Tab');
    await expect(win.locator('.nsf-flags.is-danger .lf-chip')).toHaveText(['--add-dir ~/notes', '--dangerously-skip-permissions']);
    await expect(win.locator('.new-session .popover-hint').first()).toContainText('without flags');
    await look(win.locator('.palette.new-session'), 'test-results/launch-flags-new-session.png');
    await win.keyboard.press('Escape');
    const careful = await startWork(win, 'Careful', 'Alt+Enter');
    expect(careful).toContain('FAKE-CLAUDE args=--name=Careful --permission-mode auto');
    expect(careful).not.toContain('--dangerously-skip-permissions');

    // Claude reports bypassPermissions: a small rose "B" in the row and the bar, spelled out in its tooltip and label.
    await typeInto(win, 'Bold', '\rev:work\rev:mode:bypassPermissions\r');
    const boldRow = win.locator('.session-row', { hasText: 'Bold' });
    const badge = boldRow.locator('.plan-badge.is-bypass');
    await expect(badge).toHaveText('B', { timeout: 10000 });
    await expect(badge).toHaveAttribute('aria-label', 'Bypass permissions');
    await expect(badge).toHaveAttribute('data-tip', /^Bypass permissions:/);
    expect((await badge.boundingBox())!.width).toBeLessThanOrEqual(16);
    await expect(win.locator('.session-row', { hasText: 'Careful' }).locator('.plan-badge')).toHaveCount(0);
    await boldRow.click();
    await expect(win.locator('.session-bar .plan-badge.is-bypass').first()).toBeVisible();
    await look(win.locator('.sidebar'), 'test-results/launch-flags-sidebar.png');
    await look(win.locator('.session-bar').first(), 'test-results/launch-flags-bar.png');
  } finally {
    await stop(app, home);
  }
});
