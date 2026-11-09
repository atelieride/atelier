import { _electron as electron, expect, test, type Page } from '@playwright/test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { e2eEnv } from './env';
import { look } from './shots';

// Usage meter per Claude config dir: two sessions run Claude with different config dirs, i.e. two
// accounts. The default one resets later at 0%, the other is at 22%: the meter shows the selected session's account,
// never the app-wide "later reset wins" merge, and names the dir while there are two.

/** A new plain terminal that starts the fake Claude with its own config dir and 5h window. */
async function claudeIn(win: Page, configDir: string, fiveHour: string, rows: number, name: string) {
  await win.locator('.btn-new').click();
  await win.getByRole('menuitem', { name: /^Terminal\s*⌘T$/ }).click();
  await expect(win.locator('.xterm-rows:visible')).toBeVisible({ timeout: 10000 });
  await win.locator('.xterm-helper-textarea:visible').focus();
  const text = () => win.locator('.xterm-rows:visible').evaluate((el) => el.textContent ?? '');
  // Typed before zsh draws its prompt (the Atelier prompt's ›), the first keys can be lost ("cho SHELLREADY"); under
  // load even just after it ("HELL""READY", seen in a full run): typed again on a cleared line until the shell echoes it.
  await expect.poll(text, { timeout: 15000 }).toContain('›');
  await expect(async () => {
    await win.keyboard.press('Control+U');
    await win.keyboard.type('echo SHELL""READY\n');
    await expect.poll(text, { timeout: 4000 }).toContain('SHELLREADY');
  }).toPass({ timeout: 20000 });
  await win.keyboard.type(`CLAUDE_CONFIG_DIR='${configDir}' ATELIER_FAKE_5H=${fiveHour} claude -n ${name}\n`);
  await expect(win.locator('.session-row')).toHaveCount(rows, { timeout: 20000 });
}

test('the usage meter follows the selected session\'s Claude config dir', async () => {
  const project = mkdtempSync(join(tmpdir(), 'atl-prj-'));
  const { env, home } = e2eEnv({ ATELIER_CLAUDE_BIN: resolve('tests/e2e/fake-claude.pl') });
  const app = await electron.launch({ args: ['out/main/index.js', `--project=${project}`], env });
  try {
    const win = await app.firstWindow();
    const meter = win.locator('.usage');
    await claudeIn(win, join(home, 'cfg', '.claude'), '0:17100', 1, 'Main');
    // One account: the meter looks as it always did, no name.
    await expect(meter).toContainText('0%', { timeout: 10000 });
    await expect(meter.locator('.usage-dir')).toHaveCount(0);

    await claudeIn(win, join(home, 'cfg', '.claude_ops'), '22:13500', 2, 'Ops');
    const rowOf = (name: string) => win.locator('.session-row', { hasText: name });
    await rowOf('Ops').click();
    await expect(meter.locator('.usage-dir')).toHaveText('.claude_ops', { timeout: 10000 });
    await expect(meter.locator('.usage-pct').first()).toHaveText('22%');
    await expect(meter.locator('.usage-reset').first()).toHaveText(/^3h4[45]m$/);
    await expect(meter.locator('.usage-part').first()).toHaveAttribute('title', /^5h window resets in 3h4[45]m · .*\/\.claude_ops$/);
    await look(meter, 'test-results/usage-config-dir-ops.png');

    await rowOf('Main').click();
    await expect(meter.locator('.usage-dir')).toHaveText('.claude');
    await expect(meter.locator('.usage-pct').first()).toHaveText('0%');
    await expect(meter.locator('.usage-reset').first()).toHaveText(/^4h4[45]m$/);
    await look(win.locator('.header'), 'test-results/usage-config-dir-header.png');

    // A plain terminal has no account: the meter keeps the one shown last.
    await rowOf('Ops').click();
    await expect(meter.locator('.usage-dir')).toHaveText('.claude_ops');
    await win.locator('.btn-new').click();
    await win.getByRole('menuitem', { name: /^Terminal\s*⌘T$/ }).click();
    await expect(win.locator('.term-row.is-selected')).toHaveCount(1, { timeout: 10000 });
    await expect(meter.locator('.usage-dir')).toHaveText('.claude_ops');
    await expect(meter.locator('.usage-pct').first()).toHaveText('22%');
  } finally {
    await app.close();
    try {
      const info = JSON.parse(readFileSync(join(home, 'atelierd.json'), 'utf8')) as { pid: number };
      process.kill(info.pid, 'SIGTERM');
    } catch { /* service already stopped */ }
  }
});
