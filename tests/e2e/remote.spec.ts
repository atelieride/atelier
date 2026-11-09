import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { e2eEnv } from './env';
import { look } from './shots';

type Api = { terminals: { list(): Promise<{ id: string; title: string }[]>; input(id: string, data: string): void } };

async function launch(): Promise<{ app: ElectronApplication; home: string }> {
  const project = mkdtempSync(join(tmpdir(), 'atl-prj-'));
  const { env, home } = e2eEnv({ ATELIER_CLAUDE_BIN: resolve('tests/e2e/fake-claude.pl') });
  const app = await electron.launch({ args: ['out/main/index.js', `--project=${project}`], env });
  return { app, home };
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
  await expect(win.locator('.session-row', { hasText: name.slice(0, 20) })).toHaveClass(/state-waiting/, { timeout: 20000 });
}

async function typeInto(win: Page, title: string, text: string) {
  await win.evaluate(async ({ title, text }) => {
    const api = (window as unknown as { atelier: Api }).atelier;
    api.terminals.input((await api.terminals.list()).find((x) => x.title === title)!.id, text);
  }, { title, text });
}

/** Lines the fake Claude received in its prompt (Enter included), in the visible terminal. */
const received = (win: Page) => win.locator('.terminal-slot:visible .xterm-rows').evaluate((el) =>
  [...el.querySelectorAll(':scope > div')].map((r) => (r.textContent ?? '').trim()).filter((l) => l.startsWith('FAKE-CLAUDE got=')));

/** The keyboard is in the visible terminal (xterm's input field). */
const terminalFocused = (win: Page) => win.evaluate(() => {
  const el = document.activeElement;
  return !!el?.classList.contains('xterm-helper-textarea') && (el.closest('.terminal-slot') as HTMLElement | null)?.style.display !== 'none';
});

test('Continue on Phone types /remote-control <title> without Enter, only when Claude\'s prompt is free; Claude sessions only', async () => {
  const { app, home } = await launch();
  try {
    const win = await app.firstWindow();
    const long = 'Fix the login bug on the settings page and then the profile one';
    await newSession(win, long);
    const row = win.locator('.session-row').first();
    const rows = win.locator('.terminal-slot:visible .xterm-rows');
    const cmd = `/remote-control ${long.slice(0, 60).trim()}`;

    // Waiting = a permission dialog is open in real Claude Code: typing would answer it. Disabled, with the reason.
    await row.click({ button: 'right' });
    const asking = win.getByRole('menuitem', { name: 'Continue on Phone' });
    await expect(asking).toHaveAttribute('aria-disabled', 'true');
    await expect(asking).toHaveAttribute('data-tip', 'Answer Claude first');
    await asking.click({ force: true });
    await win.keyboard.press('Escape');
    // The palette (the session bar has no phone button since 2026-10-26): its hint says why, picking it too.
    const fromPalette = async () => {
      await win.keyboard.press('F1');
      await win.locator('.palette-input').fill('>continue on phone');
      return win.locator('.palette-item', { hasText: 'Continue on phone' });
    };
    await expect(await fromPalette()).toContainText('Answer Claude first');
    await win.keyboard.press('Enter');
    await expect(win.locator('.toast')).toContainText('Answer Claude first');
    await win.waitForTimeout(500);
    await expect(rows).not.toContainText('/remote-control');

    // Answered: it finishes and its prompt is free.
    await typeInto(win, long, '\r');
    await expect(row).toHaveClass(/state-done/, { timeout: 10000 });

    // From the row's menu: the title, cut to 60 characters, typed without Enter; the keyboard goes to the terminal.
    await row.click({ button: 'right' });
    const item = win.getByRole('menuitem', { name: 'Continue on Phone' });
    await expect(item).not.toHaveAttribute('aria-disabled', 'true');
    await look(win, 'test-results/remote-menu.png');
    await item.click();
    await expect(rows).toContainText(cmd, { timeout: 10000 });
    await expect(win.locator('.toast')).toContainText('Press Enter to connect');
    await expect.poll(() => terminalFocused(win)).toBe(true);
    expect(await received(win)).toEqual([]);
    // Your Enter sends it (the exact list then proves Atelier pressed no Enter of its own).
    await win.keyboard.press('Enter');
    await expect.poll(() => received(win), { timeout: 10000 }).toEqual([`FAKE-CLAUDE got=${cmd}`]);

    // From the palette.
    await expect(await fromPalette()).toContainText('/remote-control');
    await win.keyboard.press('Enter');
    await expect.poll(() => terminalFocused(win)).toBe(true);
    expect(await received(win)).toEqual([`FAKE-CLAUDE got=${cmd}`]);
    await win.keyboard.press('Enter');
    await expect.poll(() => received(win), { timeout: 10000 }).toEqual([`FAKE-CLAUDE got=${cmd}`, `FAKE-CLAUDE got=${cmd}`]);

    // A session at work: disabled everywhere, with the reason; nothing is typed.
    await newSession(win, 'Busy');
    await typeInto(win, 'Busy', 'hold\r');
    const busy = win.locator('.session-row', { hasText: 'Busy' });
    await expect(busy).toHaveClass(/state-running/, { timeout: 10000 });
    await expect.poll(() => received(win)).toEqual(['FAKE-CLAUDE got=hold']);
    await busy.click({ button: 'right' });
    const off = win.getByRole('menuitem', { name: 'Continue on Phone' });
    await expect(off).toHaveAttribute('aria-disabled', 'true');
    await expect(off).toHaveAttribute('data-tip', 'Available when Claude\'s prompt is free');
    await off.click({ force: true });
    await win.keyboard.press('Escape');
    await expect(await fromPalette()).toContainText('Available when Claude\'s prompt is free');
    await win.keyboard.press('Enter');
    await expect(win.locator('.toast')).toContainText('Available when Claude\'s prompt is free');
    await win.waitForTimeout(500);
    expect(await received(win)).toEqual(['FAKE-CLAUDE got=hold']);
    await expect(win.locator('.terminal-slot:visible .xterm-rows')).not.toContainText('/remote-control');

    // Plain terminals: not offered.
    await win.keyboard.press('F1');
    await win.locator('.palette-input').fill('>new terminal');
    await win.locator('.palette-item', { has: win.locator('.palette-label', { hasText: /^New terminal$/ }) }).click();
    await expect(win.locator('.term-row')).toHaveCount(1, { timeout: 10000 });
    await win.locator('.term-row').click({ button: 'right' });
    await expect(win.getByRole('menuitem', { name: 'Rename…' })).toBeVisible();
    await expect(win.getByRole('menuitem', { name: 'Continue on Phone' })).toHaveCount(0);
  } finally {
    await stop(app, home);
  }
});
