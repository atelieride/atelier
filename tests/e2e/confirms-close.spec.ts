import { _electron as electron, expect, test } from '@playwright/test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { e2eEnv } from './env';
import { look } from './shots';

// In-app confirms: a busy session or terminal asks in its own row or under the
// tab it was asked from; a shell at its prompt closes at once. The session bar has no × (2026-10-26: the row and the
// menus close a session). No native dialog anywhere.
test('rows say "Close session" / "Close terminal", tabs "Close tab"; closing asks in the row or under the tab, Esc and Cancel keep it, Close closes; an idle shell closes at once', async () => {
  const project = mkdtempSync(join(tmpdir(), 'atl-prj-'));
  const { env, home } = e2eEnv({ ATELIER_CLAUDE_BIN: resolve('tests/e2e/fake-claude.pl') });
  const app = await electron.launch({ args: ['out/main/index.js', `--project=${project}`], env });
  const shots = process.env.ATELIER_E2E_SHOTS;
  try {
    // A native dialog would be a failure: main's dialog is replaced by one that records.
    await app.evaluate(({ dialog }) => {
      const g = globalThis as unknown as { nativeAsked: string[] };
      g.nativeAsked = [];
      const record = async (...a: unknown[]) => { const o = a.find((x) => x && typeof x === 'object' && 'message' in (x as object)) as { message: string }; g.nativeAsked.push(o?.message ?? '?'); return { response: 1, checkboxChecked: false }; };
      dialog.showMessageBox = record as typeof dialog.showMessageBox;
    });
    const win = await app.firstWindow();
    await win.getByRole('button', { name: 'Open a terminal' }).click();
    await expect(win.locator('.term-row')).toHaveCount(1, { timeout: 10000 });
    await win.locator('.btn-new').click();
    await win.getByRole('menuitem', { name: 'Claude Session' }).click();
    await win.keyboard.press('Enter');
    const row = win.locator('.session-row').first();
    await expect(row).toHaveClass(/state-waiting/, { timeout: 20000 });
    const title = (await row.locator('.session-title').textContent())!.trim();

    // Sidebar rows: aria-label and tooltip.
    const sessionClose = win.locator('.session-row .row-close');
    await expect(sessionClose).toHaveAttribute('aria-label', 'Close session');
    await expect(sessionClose).toHaveAttribute('data-tip', 'Close session');
    const termClose = win.locator('.term-row .row-close');
    await expect(termClose).toHaveAttribute('aria-label', 'Close terminal');
    await expect(termClose).toHaveAttribute('data-tip', 'Close terminal');
    // Tabs: their X only closes the tab (the session keeps running in the sidebar).
    const sessionTab = win.locator('.tab', { has: win.locator('.avatar') });
    await expect(sessionTab.locator('.tab-close')).toHaveAttribute('aria-label', 'Close tab');
    const termTab = win.locator('.tab', { has: win.locator('.tab-term') });
    await expect(termTab.locator('.tab-close')).toHaveAttribute('aria-label', 'Close tab');
    // Their menu closes for real with its own entry, as the rows' menu does.
    await sessionTab.click({ button: 'right' });
    await expect(win.getByRole('menuitem', { name: /^Close Tab/ })).toBeVisible();
    await expect(win.getByRole('menuitem', { name: 'Close Session…' })).toBeVisible();
    await win.keyboard.press('Escape');
    await win.locator('.term-row').click({ button: 'right' });
    await expect(win.getByRole('menuitem', { name: 'Close Terminal…' })).toBeVisible();
    await win.keyboard.press('Escape');
    // The session bar has no close button: the row and the menus close a session.
    await expect(win.locator('.session-bar')).toHaveCount(1);
    await expect(win.locator('.session-bar .sb-close')).toHaveCount(0);

    // The row's ×: the row turns into the question, Cancel focused.
    await row.hover();
    await row.locator('.row-close').click();
    const asking = win.locator('.session-row.is-confirming');
    await expect(asking).toBeVisible();
    await expect(asking).toContainText(`Close ${title}?`);
    await expect(asking).toContainText('Claude is waiting for you: it stops.');
    await expect(asking).toContainText('Resume it later from');
    await expect(asking.getByRole('button', { name: /^Cancel/ })).toBeFocused();
    if (shots) await win.waitForTimeout(500);
    if (shots) await win.screenshot({ path: join(shots, 'confirm-row.png') });
    await win.keyboard.press('Escape');
    await expect(asking).toHaveCount(0);
    await expect(row.locator('.row-main')).toBeFocused();
    await row.hover();
    await row.locator('.row-close').click();
    await asking.getByRole('button', { name: /^Cancel/ }).click();
    await expect(asking).toHaveCount(0);

    // A click elsewhere cancels too.
    await row.hover();
    await row.locator('.row-close').click();
    await expect(asking).toBeVisible();
    await win.locator('.workspace').click({ position: { x: 300, y: 300 } });
    await expect(asking).toHaveCount(0);

    // The tab's Close Session…: a popover under the tab; Cancel keeps the session.
    await sessionTab.click({ button: 'right' });
    await win.getByRole('menuitem', { name: 'Close Session…' }).click();
    const pop = win.locator('.confirm-pop');
    await expect(pop).toBeVisible();
    await expect(pop).toContainText(`Close ${title}?`);
    await expect(pop.getByRole('button', { name: /^Cancel/ })).toBeFocused();
    if (shots) await win.waitForTimeout(500);
    if (shots) await win.screenshot({ path: join(shots, 'confirm-tab.png') });
    await pop.getByRole('button', { name: /^Cancel/ }).click();
    await expect(pop).toHaveCount(0);

    // Close from the tab's popover: the session goes.
    await sessionTab.click({ button: 'right' });
    await win.getByRole('menuitem', { name: 'Close Session…' }).click();
    await pop.getByRole('button', { name: 'Close Session' }).click();
    await expect(win.locator('.session-row')).toHaveCount(0, { timeout: 10000 });

    // A plain terminal running a program asks in its row and names the program.
    const termRow = win.locator('.term-row').first();
    await termRow.click();
    await win.locator('.xterm-helper-textarea:visible').focus();
    await win.keyboard.type('sleep 300');
    await win.keyboard.press('Enter');
    await expect(termRow.locator('.term-cmd')).toContainText('sleep', { timeout: 10000 });
    await termRow.hover();
    await termRow.locator('.row-close').click();
    const termAsking = win.locator('.term-row.is-confirming');
    await expect(termAsking).toContainText('sleep stops.');
    if (shots) await win.waitForTimeout(500);
    if (shots) await win.screenshot({ path: join(shots, 'confirm-term.png') });
    await termAsking.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(win.locator('.term-row')).toHaveCount(0, { timeout: 10000 });

    // A shell at its prompt: no question.
    await win.getByRole('button', { name: 'Open a terminal' }).click();
    const idle = win.locator('.term-row').first();
    await expect(idle).toBeVisible({ timeout: 10000 });
    await idle.hover();
    await idle.locator('.row-close').click();
    await expect(win.locator('.term-row')).toHaveCount(0, { timeout: 10000 });
    await expect(win.locator('.term-row.is-confirming')).toHaveCount(0);

    // A shell slow to exit (as Claude is on Windows, seconds): its row says "Closing…" with no ×, nothing closes it
    // again (on Windows a second kill crashed atelierd), and it goes once the shell is gone.
    await win.getByRole('button', { name: 'Open a terminal' }).click();
    const slow = win.locator('.term-row').first();
    await expect(slow).toBeVisible({ timeout: 10000 });
    await slow.click();
    await win.locator('.xterm-helper-textarea:visible').focus();
    await win.keyboard.type("trap 'sleep 2; exit' HUP");
    await win.keyboard.press('Enter');
    await slow.hover();
    await slow.locator('.row-close').click();
    await expect(slow).toHaveClass(/is-closing/);
    // Its × is gone: the focus is on the row's own button, not lost.
    await expect(slow.locator('.row-main')).toBeFocused();
    await expect(slow.locator('.term-cmd')).toHaveText('Closing…');
    await expect(slow.locator('.row-close')).toHaveCount(0);
    await expect(slow.locator('.term-cmd')).toBeVisible();
    await expect(slow.locator('.row-pin')).toHaveCount(0);
    if (shots) await look(win, join(shots, 'closing-row.png'), { settle: 300 });
    await slow.click({ button: 'right' });
    await expect(win.getByRole('menuitem', { name: 'Close Terminal…' })).toHaveAttribute('aria-disabled', 'true');
    await win.keyboard.press('Escape');
    await expect(win.locator('.term-row.is-confirming')).toHaveCount(0);
    await expect(win.locator('.term-row')).toHaveCount(0, { timeout: 10000 });

    expect(await app.evaluate(() => (globalThis as unknown as { nativeAsked: string[] }).nativeAsked)).toEqual([]);
  } finally {
    await app.close();
    try { process.kill((JSON.parse(readFileSync(join(home, 'atelierd.json'), 'utf8')) as { pid: number }).pid, 'SIGTERM'); } catch { /* already stopped */ }
  }
});
