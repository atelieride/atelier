import { _electron as electron, expect, test } from '@playwright/test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { e2eEnv } from './env';

// The e2e tests run while someone works on the Mac (even inside Atelier): the test windows must never cover their work.
// They stay hidden (never shown, focused or raised) while the page still renders, lays out, animates and takes input.
test('in e2e the windows stay hidden and never take focus, yet the UI renders and works', async () => {
  const project = mkdtempSync(join(tmpdir(), 'atl-prj-'));
  const { env, home } = e2eEnv({ ATELIER_CLAUDE_BIN: resolve('tests/e2e/fake-claude.pl') });
  const app = await electron.launch({ args: ['out/main/index.js', `--project=${project}`], env });
  try {
    const win = await app.firstWindow();
    await expect(win.getByRole('button', { name: 'Open a terminal' })).toBeVisible();
    const state = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((w) => ({ visible: w.isVisible(), focused: w.isFocused() })));
    expect(await state()).toEqual([{ visible: false, focused: false }]);
    // No Dock tile: force-quitting a test app from the Dock would kill its process coalition (the user's sessions).
    expect(await app.evaluate(({ app: a }) => a.dock?.isVisible())).toBe(false);
    // The page behaves as if visible: animation frames run (xterm renders on them) and the visibility API says so.
    const page = await win.evaluate(() => new Promise<{ visibility: string; frames: number }>((done) => {
      let frames = 0;
      const tick = () => { frames += 1; if (frames < 3) requestAnimationFrame(tick); else done({ visibility: document.visibilityState, frames }); };
      requestAnimationFrame(tick);
    }));
    expect(page).toEqual({ visibility: 'visible', frames: 3 });
    // A terminal opens and renders its prompt; New Window (welcome) and a notification-free reveal never show a window.
    await win.getByRole('button', { name: 'Open a terminal' }).click();
    await expect(win.locator('.xterm-screen').first()).toBeVisible();
    await app.evaluate(({ Menu }) => Menu.getApplicationMenu()?.getMenuItemById('new-window')?.click());
    await expect.poll(async () => (await state()).length).toBe(2);
    // A second New Window brings the existing welcome window "to the front": in e2e that must stay a no-op.
    await app.evaluate(({ Menu }) => Menu.getApplicationMenu()?.getMenuItemById('new-window')?.click());
    await win.waitForTimeout(500);
    expect((await state()).length).toBe(2);
    expect((await state()).every((w) => !w.visible && !w.focused)).toBe(true);
    // Screenshots still contain the interface (not a blank frame).
    const shot = await win.screenshot();
    expect(shot.length).toBeGreaterThan(20000);
  } finally {
    await app.close();
    try { process.kill((JSON.parse(readFileSync(join(home, 'atelierd.json'), 'utf8')) as { pid: number }).pid, 'SIGTERM'); } catch { /* already stopped */ }
  }
});
