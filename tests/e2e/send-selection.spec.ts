import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { e2eEnv } from './env';
import { look } from './shots';

// Send selection to a terminal: full-screen Claude (fake-claude-select.pl) captures
// the mouse and copies its own selection; the test plays that copy on the test clipboard log, never the real clipboard.

const SHOTS = resolve('e2e-shots/send-selection');
const SNIPPET = '     mkdir -p build && cd build\n     echo "ready: $(basename "$PWD")"';

async function launch(): Promise<{ app: ElectronApplication; home: string; clip: string }> {
  const project = mkdtempSync(join(tmpdir(), 'atl-prj-'));
  const { env, home } = e2eEnv({ ATELIER_CLAUDE_BIN: resolve('tests/e2e/fake-claude-select.pl') });
  const app = await electron.launch({ args: ['out/main/index.js', `--project=${project}`], env });
  return { app, home, clip: env.ATELIER_TEST_CLIPBOARD_LOG! };
}

async function stop(app: ElectronApplication, home: string) {
  await app.close();
  try { process.kill((JSON.parse(readFileSync(join(home, 'atelierd.json'), 'utf8')) as { pid: number }).pid, 'SIGTERM'); } catch { /* already stopped */ }
}

const row = (win: Page, text: string) => win.locator('.xterm-rows:visible > div', { hasText: text }).first();

/** A right-click on a word of the snippet (on a word, xterm on macOS would select it: it must not replace Claude's). */
async function rightClickWord(win: Page) {
  const box = (await row(win, 'mkdir -p build').boundingBox())!;
  await win.mouse.click(box.x + 64, box.y + box.height / 2, { button: 'right' });
}

/** A drag across the snippet in the session: Claude highlights it, then (the test's part) copies it. */
async function selectSnippet(win: Page, clip: string) {
  const a = (await row(win, 'mkdir -p build').boundingBox())!;
  const b = (await row(win, 'echo "ready').boundingBox())!;
  await win.mouse.move(a.x + 4, a.y + a.height / 2);
  await win.mouse.down();
  await win.mouse.move(b.x + 400, b.y + b.height / 2, { steps: 4 });
  await win.mouse.up();
  // Claude copies on release; Atelier looks at the clipboard for half a second after it.
  appendFileSync(clip, JSON.stringify(SNIPPET) + '\n');
  await win.waitForTimeout(150);
}

test('right-click in full-screen Claude: its selection runs in a new terminal or goes to one picked in the palette', async () => {
  mkdirSync(SHOTS, { recursive: true });
  const { app, home, clip } = await launch();
  try {
    const win = await app.firstWindow();
    await win.setViewportSize({ width: 1280, height: 800 });
    await win.getByRole('button', { name: 'Open a terminal' }).click();
    await expect(win.locator('.term-row')).toHaveCount(1, { timeout: 10000 });
    await win.locator('.btn-new').click();
    await win.getByRole('menuitem', { name: 'Claude Session' }).click();
    await win.getByPlaceholder('Session name (optional)').fill('build-folder');
    await win.keyboard.press('Enter');
    await expect(win.locator('.session-row', { hasText: 'build-folder' })).toHaveClass(/state-done/, { timeout: 20000 });
    await expect(row(win, 'mkdir -p build')).toBeVisible({ timeout: 10000 });

    // Nothing selected yet: the menu opens (Claude captures the mouse) and says how to get a selection.
    await row(win, 'Where do the build').click({ button: 'right', force: true });
    await expect(win.getByRole('menuitem', { name: 'Run in New Terminal' })).toBeDisabled();
    await win.keyboard.press('Escape');

    await selectSnippet(win, clip);
    await rightClickWord(win);
    await expect(win.getByRole('menuitem', { name: 'Run in New Terminal' })).toBeEnabled();
    // Copy takes Claude's selection too (xterm has none of its own there).
    await expect(win.getByRole('menuitem', { name: 'Copy' })).toBeEnabled();
    await look(win, join(SHOTS, 'menu.png'), { settle: 300 });

    // Send to…: the palette shows the text and the destinations; Enter types it into the terminal, unrun.
    await win.getByRole('menuitem', { name: 'Send to…' }).click();
    await expect(win.locator('.palette-send-head')).toContainText('mkdir -p build && cd build');
    await expect(win.locator('.palette-send-head')).toContainText('+1 line');
    await expect(win.locator('.palette-item').first()).toContainText('New Terminal');
    await expect(win.locator('.palette-item', { hasText: 'build-folder' })).toBeVisible();
    // The pointer left where the menu was (it would highlight the row under it), the entrance over: then the shot.
    await win.mouse.move(640, 760);
    await look(win, join(SHOTS, 'palette.png'), { settle: 400 });
    await win.locator('.palette-item', { hasText: 'Terminal 1' }).click();
    await expect(win.locator('.palette')).toHaveCount(0);
    await expect(row(win, 'mkdir -p build && cd build')).toBeVisible({ timeout: 10000 });
    await expect(row(win, 'echo "ready: $(basename "$PWD")"')).toBeVisible();
    await look(win, join(SHOTS, 'typed.png'));
    // Never run: once the line is dropped (⌃C) and a marker echoed after it, the snippet's output never showed.
    await win.locator('.xterm-helper-textarea:visible').focus();
    await win.keyboard.press('Control+C');
    await win.keyboard.type("echo SENT''-UNRUN\n");
    await expect(win.locator('.xterm-rows:visible')).toContainText('SENT-UNRUN', { timeout: 10000 });
    await expect(win.locator('.xterm-rows:visible')).not.toContainText('ready: build');

    // Run in New Terminal: a second terminal opens and runs it.
    await win.locator('.session-row', { hasText: 'build-folder' }).click();
    await rightClickWord(win);
    await win.getByRole('menuitem', { name: 'Run in New Terminal' }).click();
    await expect(win.locator('.term-row')).toHaveCount(2, { timeout: 10000 });
    await expect(win.locator('.xterm-rows:visible')).toContainText('ready: build', { timeout: 15000 });
    await look(win, join(SHOTS, 'ran.png'));
  } finally {
    await stop(app, home);
  }
});
