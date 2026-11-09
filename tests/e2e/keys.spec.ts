import { _electron as electron, expect, test } from '@playwright/test';
import { chmodSync, constants, copyFileSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { AtelierApi } from '../../src/shared/api';
import { e2eEnv } from './env';

test('F1 opens the palette even with focus in the terminal; Shift+Enter: ESC + Enter wherever Claude Code is in front, hooks or not (newline), plain Enter in a shell', async () => {
  const project = mkdtempSync(join(tmpdir(), 'atl-prj-'));
  const { env, home } = e2eEnv({ ATELIER_CLAUDE_BIN: resolve('tests/e2e/fake-claude.pl') });
  const app = await electron.launch({ args: ['out/main/index.js', `--project=${project}`], env });
  try {
    const win = await app.firstWindow();
    // Shell: cat -v would show the ESC as ^[; here only the Enter must arrive.
    await win.getByRole('button', { name: 'Open a terminal' }).click();
    await expect(win.locator('.xterm-rows:visible')).toBeVisible({ timeout: 10000 });
    await win.locator('.xterm-helper-textarea:visible').focus();
    // F1 opens the palette even with focus in the terminal (xterm does not keep it).
    await win.keyboard.press('F1');
    await expect(win.locator('.palette-input')).toBeVisible({ timeout: 3000 });
    await win.keyboard.press('Escape');
    await expect(win.locator('.palette-input')).toHaveCount(0);
    await win.locator('.xterm-helper-textarea:visible').focus();
    await win.keyboard.type('cat -v\n');
    await win.waitForTimeout(500);
    await win.keyboard.type('shell');
    await win.keyboard.press('Shift+Enter');
    await expect(win.locator('.xterm-rows:visible')).toContainText('shellshell', { timeout: 5000 });
    await expect(win.locator('.xterm-rows:visible')).not.toContainText('shell^[');

    // Claude Code in front without Atelier's hooks (claude typed in a bash or plain zsh profile, or run by its path): no
    // session, but its process is named after its version. A stand-in: the test's node binary as `2.1.99` (an APFS
    // clone), idle; the terminal's echo shows what Shift+Enter sends.
    await win.keyboard.press('Control+C');
    const bin = mkdtempSync(join(tmpdir(), 'atl-cc-'));
    copyFileSync(process.execPath, join(bin, '2.1.99'), constants.COPYFILE_FICLONE);
    chmodSync(join(bin, '2.1.99'), 0o755);
    await win.keyboard.type(`'${join(bin, '2.1.99')}' -e 'setTimeout(() => {}, 600000)'\n`);
    await expect.poll(() => win.evaluate(async () => {
      const [t] = await (window as unknown as { atelier: AtelierApi }).atelier.terminals.list();
      return t ? { fg: t.foreground, session: !!t.session } : null;
    }), { timeout: 10000 }).toEqual({ fg: '2.1.99', session: false });
    await win.keyboard.type('nohooks');
    await win.keyboard.press('Shift+Enter');
    await expect(win.locator('.xterm-rows:visible')).toContainText('nohooks^[', { timeout: 5000 });

    // Claude session (fake): the terminal echo shows the ESC as ^[.
    await win.locator('.btn-new').click();
    await win.getByRole('menuitem', { name: 'Claude Session' }).click();
    await win.keyboard.press('Enter');
    await expect(win.locator('.session-row').first()).toHaveClass(/state-waiting/, { timeout: 20000 });
    await win.locator('.xterm-helper-textarea:visible').focus();
    await win.keyboard.type('x');
    await win.keyboard.press('Shift+Enter');
    await expect(win.locator('.xterm-rows:visible')).toContainText('x^[', { timeout: 5000 });
  } finally {
    await app.close();
    try { process.kill((JSON.parse(readFileSync(join(home, 'atelierd.json'), 'utf8')) as { pid: number }).pid, 'SIGTERM'); } catch { /* already stopped */ }
  }
});
