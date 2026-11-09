import { _electron as electron, expect, test, type Page } from '@playwright/test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { e2eEnv } from './env';

type Api = { terminals: { list(): Promise<{ id: string; title: string }[]>; input(id: string, data: string): void } };

async function typeInto(win: Page, title: string, text: string) {
  await win.evaluate(async ({ title, text }) => {
    const api = (window as unknown as { atelier: Api }).atelier;
    const id = (await api.terminals.list()).find((x) => x.title === title)!.id;
    api.terminals.input(id, text);
  }, { title, text });
}

const inTerminal = (win: Page) => win.evaluate(() => !!document.activeElement?.closest('.terminal-slot'));
// The e2e window is never really activated (windows stay hidden): leaving and coming back is the window's blur and focus.
const leaveAndComeBack = (win: Page) => win.evaluate(() => { window.dispatchEvent(new Event('blur')); window.dispatchEvent(new Event('focus')); });

test('coming back to the window: the keyboard is back in the terminal, not on the chip just clicked', async () => {
  const project = mkdtempSync(join(tmpdir(), 'atl-prj-'));
  const urlLog = join(tmpdir(), `atl-urls-${process.pid}.log`);
  const { env, home } = e2eEnv({ ATELIER_CLAUDE_BIN: resolve('tests/e2e/fake-claude.pl'), ATELIER_TEST_URL_LOG: urlLog, ATELIER_TEST_PORTS_POLL_MS: '500' });
  const app = await electron.launch({ args: ['out/main/index.js', `--project=${project}`], env });
  try {
    const win = await app.firstWindow();
    await win.locator('.btn-new').click();
    await win.getByRole('menuitem', { name: 'Claude Session' }).click();
    await win.getByPlaceholder('Session name (optional)').fill('Dev');
    await win.keyboard.press('Enter');
    await expect(win.locator('.session-row', { hasText: 'Dev' })).toBeVisible({ timeout: 15000 });
    // The fake Claude takes events once its first turn is over.
    await typeInto(win, 'Dev', '\r');
    await expect(win.locator('.session-row', { hasText: 'Dev' })).toHaveClass(/state-done/, { timeout: 10000 });
    await typeInto(win, 'Dev', 'ev:listen:1\r');
    const chip = win.locator('.session-bar .port-chip').first();
    await expect(chip).toBeVisible({ timeout: 15000 });
    await expect.poll(() => inTerminal(win)).toBe(true);

    // A chip that opens the browser gives the keyboard back to the terminal right away.
    await chip.click();
    await expect.poll(() => readFileSync(urlLog, 'utf8')).toContain('http://localhost:');
    await expect.poll(() => inTerminal(win)).toBe(true);

    // Any other control the mouse focused (the Services button here) gives it back once the window comes forward.
    const other = win.locator('.session-bar button').filter({ hasNot: win.locator('.port-dot') }).first();
    await other.evaluate((el) => (el as HTMLElement).focus());
    expect(await inTerminal(win)).toBe(false);
    await leaveAndComeBack(win);
    await expect.poll(() => inTerminal(win)).toBe(true);

    // After a rename (its input is gone a moment later) the terminal is still what the keyboard comes back to.
    const sessionRow = win.locator('.session-row', { hasText: 'Dev' });
    await sessionRow.locator('.row-main').dblclick();
    await win.locator('.session-row .rename-input').fill('Dev server');
    await win.keyboard.press('Enter');
    await expect(win.locator('.session-row', { hasText: 'Dev server' })).toBeVisible();
    await chip.click();
    await expect.poll(() => inTerminal(win)).toBe(true);
    await other.evaluate((el) => (el as HTMLElement).focus());
    await leaveAndComeBack(win);
    await expect.poll(() => inTerminal(win)).toBe(true);

    // Keyboard focus stays where it is: someone who tabbed to a button finds it there.
    await other.evaluate((el) => (el as HTMLElement).focus());
    await win.keyboard.press('Tab');
    expect(await win.evaluate(() => document.activeElement?.matches(':focus-visible'))).toBe(true);
    const kept = await win.evaluate(() => document.activeElement?.outerHTML.slice(0, 60) ?? '');
    expect(await inTerminal(win)).toBe(false);
    await leaveAndComeBack(win);
    expect(await win.evaluate(() => document.activeElement?.outerHTML.slice(0, 60) ?? '')).toBe(kept);
  } finally {
    await app.close();
    try { process.kill((JSON.parse(readFileSync(join(home, 'atelierd.json'), 'utf8')) as { pid: number }).pid, 'SIGTERM'); } catch { /* already stopped */ }
  }
});
