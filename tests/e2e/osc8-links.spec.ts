import { _electron as electron, expect, test } from '@playwright/test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { e2eEnv } from './env';

test('OSC 8 https link in the terminal: no native dialog, goes through the Atelier safe open', async () => {
  const project = mkdtempSync(join(tmpdir(), 'atl-prj-'));
  const urlLog = join(mkdtempSync(join(tmpdir(), 'atl-url-')), 'urls.txt');
  const { env, home } = e2eEnv({ ATELIER_TEST_URL_LOG: urlLog });
  const app = await electron.launch({ args: ['out/main/index.js', `--project=${project}`], env });
  try {
    const win = await app.firstWindow();
    const dialogs: string[] = [];
    win.on('dialog', (d) => { dialogs.push(d.message()); void d.dismiss(); });
    await win.getByRole('button', { name: 'Open a terminal' }).click();
    await expect(win.locator('.xterm-rows')).toContainText('›', { timeout: 10000 });
    await win.locator('.xterm-helper-textarea').focus();
    await win.keyboard.type("printf '\\033]8;;https://example.com/da-atelier\\033\\\\CLICCAMI\\033]8;;\\033\\\\\\n'\n");
    await expect(win.locator('.xterm-rows')).toContainText('CLICCAMI', { timeout: 10000 });
    // The real output line (the one starting with the link text), not the typed command.
    await expect.poll(() => win.evaluate(() => [...document.querySelectorAll('.xterm-rows > div')].some((r) => (r.textContent ?? '').startsWith('CLICCAMI'))), { timeout: 10000 }).toBe(true);
    const box = await win.evaluate(() => {
      const row = [...document.querySelectorAll('.xterm-rows > div')].find((r) => (r.textContent ?? '').startsWith('CLICCAMI'))!;
      const range = document.createRange();
      const text = document.createTreeWalker(row, NodeFilter.SHOW_TEXT).nextNode()!;
      range.setStart(text, 0); range.setEnd(text, 4);
      const r = range.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    });
    await win.mouse.move(box.x, box.y);
    await expect(win.locator('.xterm-cursor-pointer')).toBeVisible({ timeout: 5000 });
    await win.mouse.click(box.x, box.y);
    await expect.poll(() => { try { return readFileSync(urlLog, 'utf8'); } catch { return ''; } }, { timeout: 5000 }).toContain('https://example.com/da-atelier');
    expect(dialogs).toEqual([]);
  } finally {
    await app.close();
    try { process.kill((JSON.parse(readFileSync(join(home, 'atelierd.json'), 'utf8')) as { pid: number }).pid, 'SIGTERM'); } catch { /* already stopped */ }
  }
});
