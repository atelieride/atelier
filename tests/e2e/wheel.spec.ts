import { _electron as electron, expect, test } from '@playwright/test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { e2eEnv } from './env';

// Full-screen Claude Code captures the mouse and scrolls one line per wheel event received: xterm.js sends
// only one per movement (even if it is worth 10 lines), so scrolling felt slow. Now: one event per line.
test('wheel with the mouse captured by a program: one event per scrolled line, not one per movement', async () => {
  const project = mkdtempSync(join(tmpdir(), 'atl-prj-'));
  const { env, home } = e2eEnv({ ATELIER_CLAUDE_BIN: resolve('tests/e2e/fake-claude.pl') });
  const app = await electron.launch({ args: ['out/main/index.js', `--project=${project}`], env });
  try {
    const win = await app.firstWindow();
    await win.getByRole('button', { name: 'Open a terminal' }).click();
    const rows = win.locator('.xterm-rows:visible');
    await expect(rows).toBeVisible({ timeout: 10000 });
    await win.locator('.xterm-helper-textarea:visible').focus();
    // Mouse captured with SGR encoding (like Claude Code), then cat -v shows each event received. The marker (split in
    // the typed line so its echo never matches) is printed once stty has run: from then on the tty holds every event.
    await win.keyboard.type("printf '\\033[?1000h\\033[?1006h'; stty -icanon -echo; echo WHEEL''READY; cat -v\n");
    await expect(rows).toContainText('WHEELREADY', { timeout: 10000 });
    const box = (await rows.boundingBox())!;
    await win.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    const cell = await rows.evaluate((el) => (el.firstElementChild as HTMLElement).getBoundingClientRect().height);
    await win.mouse.wheel(0, -cell * 10.5);
    await expect.poll(async () => ((await rows.textContent()) ?? '').split('^[[<64;').length - 1, { timeout: 5000 }).toBe(10);
  } finally {
    await app.close();
    try { process.kill((JSON.parse(readFileSync(join(home, 'atelierd.json'), 'utf8')) as { pid: number }).pid, 'SIGTERM'); } catch { /* already stopped */ }
  }
});

// 2026-10-29: after a restart or an update, full-screen Claude couldn't be scrolled until it was typed into. The screen
// atelierd sends a new window kept the mouse tracking but not its SGR encoding: xterm reported the wheel in X10 bytes
// (onBinary), which Atelier never sends. A new xterm also drew its cursor over the program's, which had hidden it.
test('reopening the app: a program capturing the mouse still gets the wheel, and its hidden cursor stays hidden', async () => {
  const project = mkdtempSync(join(tmpdir(), 'atl-prj-'));
  const { env, home } = e2eEnv({ ATELIER_CLAUDE_BIN: resolve('tests/e2e/fake-claude.pl') });
  let app = await electron.launch({ args: ['out/main/index.js', `--project=${project}`], env });
  try {
    let win = await app.firstWindow();
    await win.getByRole('button', { name: 'Open a terminal' }).click();
    let rows = win.locator('.xterm-rows:visible');
    await expect(rows).toContainText('›', { timeout: 10000 });
    await win.locator('.xterm-helper-textarea:visible').focus();
    // The shell's cursor is drawn: the checks below that find none are not empty.
    await expect(rows.locator('.xterm-cursor')).toHaveCount(1);
    await win.keyboard.type("printf '\\033[?1000h\\033[?1006h\\033[?25l'; stty -icanon -echo; echo WHEEL''READY; cat -v\n");
    await expect(rows).toContainText('WHEELREADY', { timeout: 10000 });
    await expect(rows.locator('.xterm-cursor')).toHaveCount(0);
    // The app quits, atelierd and the program don't: the new window gets atelierd's screen.
    await app.close();
    app = await electron.launch({ args: ['out/main/index.js', `--project=${project}`], env });
    win = await app.firstWindow();
    rows = win.locator('.xterm-rows:visible');
    await expect(rows).toContainText('WHEELREADY', { timeout: 10000 });
    await win.locator('.xterm-helper-textarea:visible').focus();
    await expect(rows.locator('.xterm-cursor')).toHaveCount(0);
    const box = (await rows.boundingBox())!;
    await win.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    const cell = await rows.evaluate((el) => (el.firstElementChild as HTMLElement).getBoundingClientRect().height);
    await win.mouse.wheel(0, -cell * 3.5);
    await expect.poll(async () => ((await rows.textContent()) ?? '').split('^[[<64;').length - 1, { timeout: 5000 }).toBe(3);
  } finally {
    await app.close();
    try { process.kill((JSON.parse(readFileSync(join(home, 'atelierd.json'), 'utf8')) as { pid: number }).pid, 'SIGTERM'); } catch { /* already stopped */ }
  }
});
