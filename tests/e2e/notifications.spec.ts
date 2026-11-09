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

const command = (app: ElectronApplication, cmd: string) => app.evaluate(({ BrowserWindow }, c) => BrowserWindow.getAllWindows()[0]!.webContents.send('ev:command', c), cmd);

async function newSession(win: Page, name: string) {
  await win.locator('.btn-new').click();
  await win.getByRole('menuitem', { name: 'Claude Session' }).click();
  await win.getByPlaceholder('Session name (optional)').fill(name);
  await win.keyboard.press('Enter');
  await expect(win.locator('.session-row', { hasText: name })).toHaveClass(/state-waiting/, { timeout: 20000 });
}

async function typeInto(win: Page, titles: string[], text: string) {
  await win.evaluate(async ({ titles, text }) => {
    const api = (window as unknown as { atelier: Api }).atelier;
    const list = await api.terminals.list();
    for (const title of titles) api.terminals.input(list.find((x) => x.title === title)!.id, text);
  }, { titles, text });
}

const rows = (win: Page) => win.locator('.notes-pop .note-row').evaluateAll((els) => els.map((el) => [
  el.querySelector('.note-title')?.textContent ?? '', el.querySelector('.note-detail')?.textContent ?? '', el.classList.contains('is-unread')
]));

test('notification center: bell count, grouped finishes, keyboard, read rules, persistence, mark all, clear; e2e pages are muted; a finished session shows when its last message was', async () => {
  const { app, home } = await launch();
  try {
    const win = await app.firstWindow();
    // The chime plays in these tests (and the dictation tones in theirs), muted: nobody at the Mac hears a run.
    expect(await app.evaluate(({ webContents }) => webContents.getAllWebContents().map((wc) => wc.isAudioMuted()))).not.toContain(false);
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.webContents.isAudioMuted())).toBe(true);
    // Every finish gets its entry (the fake's turns last seconds; the 1-minute default would keep them out).
    await win.evaluate(() => (window as unknown as { atelier: { settings: { set(p: Record<string, unknown>): Promise<unknown> } } }).atelier.settings.set({ notifyDoneAfter: 'always' }));
    const bell = win.locator('.bell-btn');
    const count = bell.locator('.bell-count');
    await expect(bell).toBeVisible({ timeout: 10000 });
    await expect(count).toHaveCount(0);

    // Empty state.
    await bell.click();
    await expect(win.locator('.notes-pop')).toContainText('Nothing yet. Sessions that need you or finish show up here.');
    await look(win.locator('.notes-pop'), 'test-results/notifications-empty.png');
    await win.keyboard.press('Escape');
    await expect(win.locator('.notes-pop')).toHaveCount(0);

    for (const name of ['Alfa', 'Beta', 'Gamma', 'Delta']) await newSession(win, name);
    // The fake Claude prompts at once, then asks for a permission: busy rows show their activity, not a time.
    const alfa = win.locator('.session-row', { hasText: 'Alfa' });
    await expect(alfa.locator('.session-activity.is-time')).toHaveCount(0);
    // Each new session is on screen when it starts waiting: with the window in front its entry arrives read.
    const focused = await win.evaluate(() => document.hasFocus());
    if (focused) await expect(count).toHaveCount(0);
    else await expect(count).toHaveText('4');

    // Three finish within a few seconds (off screen, OS "finished" notifications off by default): one entry.
    await typeInto(win, ['Alfa', 'Beta'], '\r');
    await win.waitForTimeout(700);
    await typeInto(win, ['Gamma'], '\r');
    await expect.poll(async () => { await command(app, 'show-notifications'); const r = await rows(win); await command(app, 'show-notifications'); return r[0]?.[0]; }, { timeout: 10000 }).toBe('3 sessions finished');
    // A finished session shows when its last message was; never "ready".
    const time = alfa.locator('.session-activity.is-time');
    await expect(time).toHaveText('just now');
    await expect(time).toHaveAttribute('data-tip', /^Last message [A-Z][a-z]{2} \d{1,2}, \d{2}:\d{2}$/);
    await expect(alfa).not.toContainText('ready');
    await look(win.locator('.sidebar'), 'test-results/last-message.png');

    await command(app, 'show-notifications');
    const pop = win.locator('.notes-pop');
    await expect(pop.locator('.notes-day')).toHaveText(['Today']);
    expect(await rows(win)).toEqual([
      ['3 sessions finished', 'Alfa, Beta, Gamma', true],
      ['Delta', 'Needs permission · Bash npm test', !focused],
      ['Gamma', 'Needs permission · Bash npm test', !focused],
      ['Beta', 'Needs permission · Bash npm test', !focused],
      ['Alfa', 'Needs permission · Bash npm test', !focused]
    ]);
    await expect(count).toHaveText(focused ? '1' : '5');
    await look(pop, 'test-results/notifications-popover.png');
    await look(win, 'test-results/notifications-window.png');
    // The header stays on one line with the "N unread" pill (it was a few px wider than the popover: the pill and "Mark
    // all as read" wrapped onto two lines).
    const head = pop.locator('.notes-head');
    await expect(head.locator('.notes-unread')).toBeVisible();
    for (const c of await head.evaluate((el) => [...el.children].map((x) => ({ cls: x.className, h: x.getBoundingClientRect().height, clip: x.scrollWidth - x.clientWidth })))) {
      expect(c.h, c.cls).toBeLessThanOrEqual(26);
      expect(c.clip, c.cls).toBeLessThanOrEqual(0);
    }
    // Nothing spills out of it either.
    expect(await head.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(0);

    // Keyboard: the newest entry has focus; ↓↓↓ then Enter opens Beta's entry: Beta selected, popover closed.
    await expect(pop.locator('.note-row').first()).toBeFocused();
    // Tab and Shift+Tab stay inside the popover; Esc closes it and gives the keyboard to the bell.
    const inside = () => win.evaluate(() => !!document.activeElement?.closest('.notes-pop'));
    for (const key of ['Tab', 'Tab', 'Tab', 'Tab', 'Tab', 'Tab', 'Tab', 'Tab', 'Shift+Tab', 'Shift+Tab', 'Shift+Tab', 'Shift+Tab', 'Shift+Tab', 'Shift+Tab', 'Shift+Tab', 'Shift+Tab']) {
      await win.keyboard.press(key);
      expect(await inside(), key).toBe(true);
    }
    await win.keyboard.press('Escape');
    await expect(pop).toHaveCount(0);
    await expect(bell).toBeFocused();
    await command(app, 'show-notifications');
    await expect(pop.locator('.note-row').first()).toBeFocused();
    await win.keyboard.press('ArrowDown');
    await win.keyboard.press('ArrowDown');
    await win.keyboard.press('ArrowDown');
    await expect(pop.locator('.note-row').nth(3)).toBeFocused();
    await win.keyboard.press('Enter');
    await expect(pop).toHaveCount(0);
    await expect(win.locator('.session-row.is-selected')).toContainText('Beta');

    // Viewing Gamma reads it everywhere (its entry, and its part of the group).
    await win.locator('.session-row', { hasText: 'Gamma' }).locator('.row-main').click();
    await command(app, 'show-notifications');
    await expect.poll(() => rows(win)).toEqual([
      ['3 sessions finished', 'Alfa, Beta, Gamma', true],
      ['Delta', 'Needs permission · Bash npm test', !focused],
      ['Gamma', 'Needs permission · Bash npm test', false],
      ['Beta', 'Needs permission · Bash npm test', false],
      ['Alfa', 'Needs permission · Bash npm test', !focused]
    ]);

    // Click on the group (Beta and Gamma seen already): its first unseen session, Alfa; the entry is read.
    await pop.locator('.note-row').first().click();
    await expect(win.locator('.session-row.is-selected')).toContainText('Alfa');
    await command(app, 'show-notifications');
    await expect.poll(async () => (await rows(win))[0]).toEqual(['3 sessions finished', 'Alfa, Beta, Gamma', false]);
    await win.keyboard.press('Escape');

    // Delta finishes off screen: a single entry, unread.
    await typeInto(win, ['Delta'], '\r');
    const unread = focused ? '1' : '2';
    await expect(count).toHaveText(unread, { timeout: 10000 });

    // Kept after a reload. The session in front before it (Alfa) is in front again: Delta's
    // entry stays unread.
    await win.reload();
    await expect(win.locator('.session-row')).toHaveCount(4, { timeout: 15000 });
    await expect(win.locator('.session-row.is-selected')).toContainText('Alfa');
    await expect(count).toHaveText(unread);
    await win.keyboard.press('F1');
    await win.locator('.palette-input').fill('>show notif');
    await win.keyboard.press('Enter');
    await expect(win.locator('.notes-pop .note-row')).toHaveCount(6);
    expect((await rows(win))[0]).toEqual(['Delta', 'Finished', true]);
    await win.keyboard.press('Escape');

    // One more finishing off screen, then Mark all as read and Clear.
    await newSession(win, 'Echo');
    await win.locator('.session-row', { hasText: 'Alfa' }).locator('.row-main').click();
    await typeInto(win, ['Echo'], '\r');
    await expect(count).toBeVisible({ timeout: 10000 });
    await bell.click();
    await win.getByRole('button', { name: 'Mark all as read' }).click();
    await expect(count).toHaveCount(0);
    await expect(win.locator('.notes-pop .note-row.is-unread')).toHaveCount(0);
    await win.getByRole('button', { name: 'Clear' }).click();
    await expect(win.locator('.notes-pop')).toContainText('Nothing yet.');
    // Outside click closes it.
    await win.locator('.sidebar').click({ position: { x: 100, y: 400 } });
    await expect(win.locator('.notes-pop')).toHaveCount(0);
  } finally {
    await stop(app, home);
  }
});
