import { _electron as electron, expect, test } from '@playwright/test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { e2eEnv } from './env';

// Arrows wrapping around the ends: src/renderer/palette-query.test.ts (stepActive) and language-mode.spec.ts.
test('palette arrows with the pointer resting on the list: the list scrolling under it does not move the selection', async () => {
  const project = mkdtempSync(join(tmpdir(), 'atl-prj-'));
  const { env, home } = e2eEnv();
  const app = await electron.launch({ args: ['out/main/index.js', `--project=${project}`], env });
  try {
    const win = await app.firstWindow();
    await win.getByRole('button', { name: 'Open a terminal' }).click();
    await expect(win.locator('.xterm-rows:visible')).toBeVisible({ timeout: 10000 });
    await win.keyboard.press('F1');
    await win.locator('.palette-input').fill('>');
    const items = win.locator('.palette-item');
    await expect.poll(() => items.count()).toBeGreaterThan(12);
    const list = await win.locator('.palette-list').boundingBox();
    // The pointer comes to rest in the middle of the list (a real move: that item is selected), then the keys take over.
    await win.mouse.move(list!.x + list!.width / 2, list!.y + list!.height / 2);
    await expect(win.locator('.palette-item.is-active')).not.toHaveText(await items.first().innerText());
    await win.locator('.palette-input').fill('> ');
    await win.locator('.palette-input').fill('>');
    await expect(items.first()).toHaveClass(/is-active/);
    await win.keyboard.press('ArrowUp');
    await win.waitForTimeout(300);
    await expect(items.last()).toHaveClass(/is-active/);
    await win.keyboard.press('ArrowDown');
    await win.waitForTimeout(300);
    await expect(items.first()).toHaveClass(/is-active/);
    // Moving the pointer again selects what is under it.
    await win.mouse.move(list!.x + list!.width / 2, list!.y + list!.height / 2 + 30);
    await expect(items.first()).not.toHaveClass(/is-active/);
  } finally {
    await app.close();
    try { process.kill((JSON.parse(readFileSync(join(home, 'atelierd.json'), 'utf8')) as { pid: number }).pid, 'SIGTERM'); } catch { /* already stopped */ }
  }
});
