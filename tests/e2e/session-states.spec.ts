import { _electron as electron, expect, test } from '@playwright/test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { e2eEnv } from './env';
import { join, resolve } from 'node:path';
import { look } from './shots';

test('a Claude session goes from working to waiting for you to finished, with context and limits', async () => {
  const project = mkdtempSync(join(tmpdir(), 'atl-prj-'));
  const { env, home } = e2eEnv({ ATELIER_CLAUDE_BIN: resolve('tests/e2e/fake-claude.pl') });
  const app = await electron.launch({ args: ['out/main/index.js', `--project=${project}`], env });
  try {
    const win = await app.firstWindow();
    await win.locator('.btn-new').click();
    await win.getByRole('menuitem', { name: 'Claude Session' }).click();
    await win.getByPlaceholder('Session name (optional)').fill("L'interlocutore");
    await win.keyboard.press('Enter');

    const row = win.locator('.session-row').first();
    await expect(row).toContainText("L'interlocutore", { timeout: 20000 });
    await expect(row).toHaveClass(/state-waiting/, { timeout: 20000 });
    // v2.0 (states2): a permission request reads "Needs permission: <tool>".
    await expect(row).toContainText('Needs permission: Bash npm test');
    // Context used: in the session bar only, never in the row (it crowded the chips there).
    await expect(row).not.toContainText('58%');
    await expect(win.locator('.session-bar .ctx-pct')).toHaveText('58%');
    // Accessibility: the row is a list item with two side-by-side buttons, never a button inside another.
    await expect(win.getByRole('list').getByRole('listitem').filter({ hasText: "L'interlocutore" })).toHaveCount(1);
    await expect(win.locator('.sidebar [role="button"] button, .sidebar button button')).toHaveCount(0);
    await expect(row.getByRole('button', { name: /L'interlocutore/ })).toBeVisible();
    await expect(win.locator('.usage')).toContainText('42%');
    // Time to reset for both windows (it used to be only the 5h one).
    await expect(win.locator('.usage .usage-reset')).toHaveText([/^2h[012]m$/, /^3d4h$/]);
    // Session bar: one chip with the context and the model; the lines and the cost from the
    // status line are in the Session panel it opens, not in the bar; Ask without its key.
    const bar = win.locator('.session-bar');
    await expect(bar.locator('.sb-model')).toContainText('58%');
    await expect(bar.locator('.sb-model .sb-model-name')).toHaveText('Opus 5.5');
    await expect(bar).not.toContainText('$4.13');
    await expect(bar.locator('.sb-ask')).toHaveText('Ask');
    await look(bar, 'test-results/session-states-bar.png');
    await bar.locator('.sb-model').click();
    const stats = win.getByRole('group', { name: 'This session' });
    await expect(stats).toContainText('+120−30');
    await expect(stats).toContainText('$4.13');
    await expect(stats).toContainText('58%');
    await look(win.locator('.spanel'), 'test-results/session-states-panel.png');
    await win.keyboard.press('Escape');
    await expect(win.locator('.spanel')).toHaveCount(0);
    // A narrow bar (the smallest window): the chip keeps the context ring; the model's name gives way.
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(900, 640));
    await expect.poll(() => bar.evaluate((el) => el.getBoundingClientRect().width)).toBeLessThan(760);
    await expect(bar.locator('.sb-model .ctx-ring')).toBeVisible();
    await expect(bar.locator('.sb-model .sb-model-name')).toBeHidden();
    await look(bar, 'test-results/session-states-bar-narrow.png');
    await expect(win.locator('.footer')).toContainText('1 waiting');
    await look(win, 'test-results/session-states-ti-aspetta.png');

    await win.locator('.xterm-helper-textarea').focus();
    await win.keyboard.press('Enter');
    await expect(row).toHaveClass(/state-done/, { timeout: 10000 });
    await look(win, 'test-results/session-states-finita.png');
  } finally {
    await app.close();
    try {
      const info = JSON.parse(readFileSync(join(home, 'atelierd.json'), 'utf8')) as { pid: number };
      process.kill(info.pid, 'SIGTERM');
    } catch { /* service already stopped */ }
  }
});
