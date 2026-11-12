import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { e2eEnv } from './env';
import { look } from './shots';

// Claude accounts: with one account nothing changes; with two, New Session picks the
// account (Tab), the session runs with its CLAUDE_CONFIG_DIR, and the account shows where the session does. The fake
// Claude sends a transcript_path under the config dir it runs with, so atelierd learns the session's dir as it would.

type Api = { terminals: { list(): Promise<{ id: string; title: string; configDir?: string }[]> } };

async function launch(accounts: boolean, extra: Record<string, string> = {}, ownHome = false): Promise<{ app: ElectronApplication; home: string; ops: string; win: Page }> {
  const project = mkdtempSync(join(tmpdir(), 'atl-prj-'));
  const { env, home } = e2eEnv({ ATELIER_CLAUDE_BIN: resolve('tests/e2e/fake-claude.pl'), ...extra });
  const ops = join(home, 'cfg', '.claude_ops');
  // Settings › Claude › Accounts › Choose…: the folder the open panel would return.
  env.ATELIER_TEST_PICK_DIR = join(home, 'cfg', 'claude-work');
  // `ownHome`: the app's home is the test's, so Ops's folder is written `~/cfg/.claude_ops` wherever it shows.
  if (ownHome) env.HOME = home;
  if (accounts) {
    writeFileSync(join(home, 'preferences.json'), JSON.stringify({ claudeAccounts: {
      list: [{ id: 'default', name: 'Claude', dir: '', color: 1 }, { id: 'ops', name: 'Ops', dir: ops, color: 2 }], newSession: 'default', dismissed: []
    } }));
  }
  const app = await electron.launch({ args: ['out/main/index.js', `--project=${project}`], env });
  const win = await app.firstWindow();
  await expect(win.locator('.btn-new')).toBeVisible({ timeout: 15000 });
  return { app, home, ops, win };
}

async function stop(app: ElectronApplication, home: string) {
  await app.close();
  try { process.kill((JSON.parse(readFileSync(join(home, 'atelierd.json'), 'utf8')) as { pid: number }).pid, 'SIGTERM'); } catch { /* already stopped */ }
}

async function openSheet(win: Page) {
  await win.locator('.btn-new').click();
  await win.getByRole('menuitem', { name: 'Claude Session' }).click();
  await expect(win.getByPlaceholder('Session name (optional)')).toBeFocused();
}

/** A session name long enough to fill its row in the default sidebar. */
const HERO = 'Hero: the landing page, with a title long enough to fill its row';

const setTheme = (win: Page, theme: string) => win.evaluate(async (theme) => {
  await (window as unknown as { atelier: { settings: { set(p: object): Promise<unknown> } } }).atelier.settings.set({ theme });
}, theme);

const configDirOf = (win: Page, title: string) => win.evaluate(async (title) => {
  const api = (window as unknown as { atelier: Api }).atelier;
  return (await api.terminals.list()).find((x) => x.title === title)?.configDir;
}, title);

test('two accounts: the arrow keys and Tab pick the account in New Session; the session runs with its config dir', async () => {
  const { app, home, ops, win } = await launch(true, {}, true);
  try {
    await openSheet(win);
    const cards = win.locator('.new-session-accounts .acct-card');
    const name = win.getByPlaceholder('Session name (optional)');
    // The arrow keys pick the account too…
    await expect(cards.nth(0)).toHaveAttribute('aria-checked', 'true');
    await win.keyboard.press('ArrowRight');
    await expect(cards.nth(1)).toHaveAttribute('aria-checked', 'true');
    await win.keyboard.press('ArrowRight');
    await expect(cards.nth(0)).toHaveAttribute('aria-checked', 'true');
    await win.keyboard.press('ArrowLeft');
    await expect(cards.nth(1)).toHaveAttribute('aria-checked', 'true');
    await expect(win.locator('.nsa-head')).toContainText('←→');
    await look(win.locator('.new-session'), 'test-results/claude-accounts-arrows-empty.png');
    await expect(name).toBeFocused();
    // …but with a name typed ←/→ are the caret's again (the hint says so).
    await name.fill('Hero');
    await expect(win.locator('.nsa-head')).not.toContainText('←→');
    await win.keyboard.press('ArrowLeft');
    await expect(cards.nth(1)).toHaveAttribute('aria-checked', 'true');
    expect(await name.evaluate((el: HTMLInputElement) => el.selectionStart)).toBe(3);
    await look(win.locator('.new-session'), 'test-results/claude-accounts-arrows.png');
    await win.keyboard.press('Escape');

    // Tab, from a fresh sheet.
    await openSheet(win);
    await expect(cards).toHaveCount(2);
    await expect(cards.nth(0)).toHaveAttribute('aria-checked', 'true');
    await expect(cards.nth(0)).toContainText('Claude');
    await expect(cards.nth(1)).toContainText('Ops');
    await expect(cards.nth(1).locator('.acct-dir')).toHaveText('~/cfg/.claude_ops');
    await win.getByPlaceholder('Session name (optional)').fill(HERO);
    // Ctrl+Tab stays the app's Next Tab: it never switches account.
    await win.keyboard.press('Control+Tab');
    await expect(cards.nth(0)).toHaveAttribute('aria-checked', 'true');
    await win.keyboard.press('Tab');
    await expect(cards.nth(1)).toHaveAttribute('aria-checked', 'true');
    await expect(win.getByPlaceholder('Session name (optional)')).toBeFocused();
    // Screen readers hear the choice (the cards are not Tab stops).
    await expect(win.locator('#new-session-account')).toHaveText('Account: Ops');
    await win.keyboard.press('Shift+Tab');
    await expect(cards.nth(0)).toHaveAttribute('aria-checked', 'true');
    await win.keyboard.press('Shift+Tab');
    await expect(cards.nth(1)).toHaveAttribute('aria-checked', 'true');
    await win.keyboard.press('Enter');
    await expect(win.locator('.session-row', { hasText: 'Hero' })).toHaveCount(1, { timeout: 20000 });
    await expect.poll(() => configDirOf(win, HERO), { timeout: 15000 }).toBe(ops);

    // The account's limits, once seen, show on its card the next time.
    await openSheet(win);
    await expect(cards.nth(1).locator('.acct-usage')).toContainText('42%', { timeout: 10000 });
    await expect(cards.nth(0).locator('.acct-usage')).toHaveCount(0);
    await look(win.locator('.new-session'), 'test-results/claude-accounts-new-session.png');
    // Picked, its bars draw in the selection's ink, not the brand: the chosen step is neutral now,
    // its ink Docsy Night's --text; a brand bar on its groove would fall under 3:1 (themes.test.ts measures).
    await setTheme(win, 'docsy-night');
    await expect(win.locator('html')).toHaveAttribute('data-theme', 'docsy-night');
    await win.keyboard.press('Tab');
    await expect(cards.nth(1)).toHaveAttribute('aria-checked', 'true');
    await expect(cards.nth(1).locator('.usage-bar > .tone-brand').first()).toHaveCSS('background-color', 'rgb(232, 234, 238)');
    await look(win.locator('.new-session'), 'test-results/claude-accounts-picked-docsy-night.png');
    await setTheme(win, 'aurora');
    await win.keyboard.press('Escape');

    // The palette's "New session as Ops" opens the sheet on Ops.
    await win.keyboard.press('F1');
    await win.locator('.palette-input').fill('>new session as');
    // Each "New session as …" shows its account's color, not a generic icon.
    const asItem = (name: string) => win.locator('.palette-item', { hasText: `New session as ${name}` });
    await expect(asItem('Claude').locator('.palette-account-dot')).toHaveAttribute('style', /--person-1/);
    await expect(asItem('Ops').locator('.palette-account-dot')).toHaveAttribute('style', /--person-2/);
    await expect(asItem('Ops').locator('.palette-cmd svg')).toHaveCount(0);
    await look(win.locator('.palette'), 'test-results/claude-accounts-palette.png');
    await win.locator('.palette-input').fill('>new session as ops');
    await win.keyboard.press('Enter');
    await expect(cards.nth(1)).toHaveAttribute('aria-checked', 'true');
    // File › New Session with Account › Claude while the sheet is open: it switches to that account.
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.webContents.send('ev:command', 'new-session-account:default'));
    await expect(cards.nth(0)).toHaveAttribute('aria-checked', 'true');
    await win.keyboard.press('Escape');

    // Seeing the account: a chip on the other account's row only, its name in the meter, every account on hover.
    await openSheet(win);
    await win.getByPlaceholder('Session name (optional)').fill('Main');
    await win.keyboard.press('Enter');
    const row = (name: string) => win.locator('.session-row', { hasText: name });
    await expect(row('Main')).toHaveCount(1, { timeout: 20000 });
    await expect(row('Hero').locator('.account-chip')).toHaveText('Ops');
    await expect(row('Main').locator('.account-chip')).toHaveCount(0);
    // The title line clips (overflow): the chip keeps a pixel of room above and below it, or the clip, snapped to
    // device pixels, eats its border on rows that start on a fraction of a pixel.
    const room = await row('Hero').locator('.account-chip').evaluate((chip) => {
      const c = chip.getBoundingClientRect();
      const l = chip.closest('.session-line')!.getBoundingClientRect();
      return Math.min(c.top - l.top, l.bottom - c.bottom);
    });
    expect(room).toBeGreaterThanOrEqual(0.9);
    // A long title gives way first: the account's short name stays whole, never "D…".
    const clipped = (sel: string) => row('Hero').locator(sel).evaluate((el) => el.scrollWidth > el.clientWidth);
    expect(await clipped('.session-title')).toBe(true);
    expect(await clipped('.account-chip')).toBe(false);
    await look(win.locator('.sidebar'), 'test-results/claude-accounts-sidebar.png');
    const meter = win.locator('.usage');
    await row('Hero').click();
    await expect(meter.locator('.usage-dir')).toHaveText('Ops', { timeout: 10000 });
    // The tab of the session in front says its account too.
    await expect(win.locator('.tab.is-active .account-chip')).toHaveText('Ops');
    await row('Main').click();
    await expect(meter.locator('.usage-dir')).toHaveText('Claude');
    await row('Hero').click();
    await meter.hover();
    const pop = win.locator('.usage-pop');
    await expect(pop.locator('.usage-pop-row')).toHaveCount(2);
    await expect(pop.locator('.usage-pop-row.is-current')).toContainText('Ops · this session');
    // Folders as people write them, under the home: the popover's rows, the limits' tooltips, the chip's.
    await expect(pop.locator('.usage-pop-row.is-current')).toHaveAttribute('data-tip', '~/cfg/.claude_ops');
    await expect(meter.locator('.usage-part').first()).toHaveAttribute('title', / · ~\/cfg\/\.claude_ops$/);
    await expect(row('Hero').locator('.account-chip')).toHaveAttribute('data-tip', 'Claude account: Ops · ~/cfg/.claude_ops');
    await look(win.locator('.header'), 'test-results/claude-accounts-meter.png');
    await look(pop, 'test-results/claude-accounts-meter-popover.png');
    await win.mouse.move(5, 300);
    await expect(pop).toHaveCount(0);
    await look(win.locator('.sidebar'), 'test-results/claude-accounts-sidebar.png');
  } finally {
    await stop(app, home);
  }
});

/** A plain terminal that starts the fake Claude by hand with another config dir, as an alias like claude-ops does. */
async function claudeByHand(win: Page, configDir: string, name: string) {
  await win.locator('.btn-new').click();
  await win.getByRole('menuitem', { name: /^Terminal\s*⌘T$/ }).click();
  await expect(win.locator('.xterm-rows:visible')).toBeVisible({ timeout: 10000 });
  await win.locator('.xterm-helper-textarea:visible').focus();
  const text = () => win.locator('.xterm-rows:visible').evaluate((el) => el.textContent ?? '');
  // Typed before zsh draws its prompt (the Atelier prompt's ›), the first keys can be lost ("cho SHELLREADY"); under
  // load even just after it ("HELL""READY", seen in a full run): typed again on a cleared line until the shell echoes it.
  await expect.poll(text, { timeout: 15000 }).toContain('›');
  await expect(async () => {
    await win.keyboard.press('Control+U');
    await win.keyboard.type('echo SHELL""READY\n');
    await expect.poll(text, { timeout: 4000 }).toContain('SHELLREADY');
  }).toPass({ timeout: 20000 });
  await win.keyboard.type(`CLAUDE_CONFIG_DIR='${configDir}' claude -n ${name}\n`);
  await expect(win.locator('.session-row', { hasText: name })).toHaveCount(1, { timeout: 20000 });
}

test('two accounts: the empty state\'s Start a Claude session asks for the account as ⌘N does, with workspaces off and on', async () => {
  const { app, home, ops, win } = await launch(true);
  try {
    const sheet = win.getByRole('dialog', { name: 'New Session' });
    const cards = sheet.locator('.new-session-accounts .acct-card');
    const startButton = () => win.locator('.workspace-empty').getByRole('button', { name: /^Start a Claude session/ });
    // Workspaces off: the project's empty state. The click opens New Session with the accounts, it starts nothing.
    await startButton().click();
    await expect(sheet).toBeVisible();
    await expect(cards).toHaveCount(2);
    await expect(cards.nth(0)).toHaveAttribute('aria-checked', 'true');
    await look(win, 'test-results/claude-accounts-empty-state-sheet.png');
    await win.keyboard.press('Escape');
    await expect(sheet).toHaveCount(0);
    expect(await win.evaluate(async () => (await (window as unknown as { atelier: Api }).atelier.terminals.list()).length)).toBe(0);

    // Workspaces on (View › Toggle Workspaces for This Project): the workspace's empty state, the same sheet; the
    // account picked there is the one the session runs with.
    await app.evaluate(({ Menu, BrowserWindow }) => {
      const walk = (items: Electron.MenuItem[]): Electron.MenuItem | undefined => {
        for (const it of items) { if (it.label === 'Toggle Workspaces for This Project') return it; const sub = it.submenu ? walk(it.submenu.items) : undefined; if (sub) return sub; }
        return undefined;
      };
      walk(Menu.getApplicationMenu()!.items)!.click(undefined, BrowserWindow.getAllWindows()[0]);
    });
    await expect(win.locator('.workspace-empty h2')).toHaveText('Nothing running in Workspace 1');
    await startButton().click();
    await expect(sheet).toBeVisible();
    await expect(cards).toHaveCount(2);
    await win.getByPlaceholder('Session name (optional)').fill('Empty state');
    await win.keyboard.press('Tab');
    await expect(cards.nth(1)).toHaveAttribute('aria-checked', 'true');
    await win.keyboard.press('Enter');
    await expect(win.locator('.session-row', { hasText: 'Empty state' })).toHaveCount(1, { timeout: 20000 });
    await expect.poll(() => configDirOf(win, 'Empty state'), { timeout: 15000 }).toBe(ops);
  } finally {
    await stop(app, home);
  }
});

test('one account: New Session looks and works as it always did; Settings › Claude › Accounts: a folder seen in a session becomes an account in one click; add, check, remove', async () => {
  const { app, home, ops, win } = await launch(false);
  try {
    // One account: no account cards, no chip, no "New session as" in the palette.
    await openSheet(win);
    await expect(win.locator('.new-session-accounts')).toHaveCount(0);
    await win.getByPlaceholder('Session name (optional)').fill('Solo');
    await win.keyboard.press('Enter');
    await expect(win.locator('.session-row', { hasText: 'Solo' })).toHaveCount(1, { timeout: 20000 });
    await expect(win.locator('.session-row', { hasText: 'Solo' }).locator('.account-chip')).toHaveCount(0);
    await win.keyboard.press('F1');
    await win.locator('.palette-input').fill('>new session as');
    await expect(win.locator('.palette-item', { hasText: 'New session as' })).toHaveCount(0);
    await win.keyboard.press('Escape');

    const openClaude = async () => {
      await win.locator('.activity-bar .act-bottom').click();
      await win.locator('.set-nav-item', { hasText: 'Claude' }).click();
    };
    await openClaude();
    const list = win.locator('.acct-list .acct-row');
    await expect(list).toHaveCount(1);
    await expect(list.first()).toContainText('Claude');
    await expect(list.first()).toContainText('Default');
    await expect(win.locator('.set-row', { hasText: 'New sessions start with' })).toHaveCount(0);
    await expect(win.locator('.acct-detected')).toHaveCount(0);
    await win.keyboard.press('Escape');

    // claude-ops typed in a terminal: its folder is offered, once, by a toast and in Settings.
    await claudeByHand(win, ops, 'Opsrun');
    await expect(win.locator('.session-row', { hasText: 'Opsrun' }).locator('.account-chip')).toHaveText('.claude_ops', { timeout: 10000 });
    await expect(win.locator('.toast', { hasText: 'New Claude account' })).toBeVisible({ timeout: 10000 });
    await openClaude();
    const detected = win.locator('.acct-detected');
    await expect(detected).toContainText('.claude_ops');
    await expect(detected).toContainText('Opsrun');
    await detected.getByRole('button', { name: 'Add account' }).click();
    const form = win.locator('.acct-form');
    await expect(form.getByLabel('Name')).toHaveValue('Ops');
    await expect(form.getByLabel('Folder')).toHaveValue(/\.claude_ops$/);
    await form.getByRole('button', { name: 'Save' }).click();
    await expect(list).toHaveCount(2);
    await expect(detected).toHaveCount(0);
    // Focus goes back to "Add account", not to the page.
    await expect(win.getByRole('button', { name: 'Add account' })).toBeFocused();
    await expect(win.locator('.set-row', { hasText: 'New sessions start with' })).toHaveCount(1);

    // Another one from the open panel; a folder another account has is refused, with the reason.
    await win.getByRole('button', { name: 'Add account' }).click();
    await form.getByLabel('Name').fill('Work');
    await form.getByLabel('Folder').fill(ops);
    await form.getByRole('button', { name: 'Save' }).click();
    await expect(form.getByRole('alert')).toContainText('Another account uses this folder');
    await expect(form.getByLabel('Folder')).toHaveAttribute('aria-invalid', 'true');
    await form.getByRole('button', { name: 'Choose…' }).click();
    await expect(form.getByLabel('Folder')).toHaveValue(/claude-work$/);
    await form.getByRole('button', { name: 'Save' }).click();
    await expect(list).toHaveCount(3);
    await look(win.locator('.settings'), 'test-results/claude-accounts-settings.png');

    // Remove Work: its row goes, its folder and sessions are untouched.
    await list.nth(2).getByRole('button', { name: 'More' }).click();
    await win.getByRole('menuitem', { name: 'Remove' }).click();
    await expect(list).toHaveCount(2);
    await win.keyboard.press('Escape');
    await expect(win.locator('.session-row', { hasText: 'Opsrun' }).locator('.account-chip')).toHaveText('Ops');

    // Removing Ops while its session runs: the folder is not offered straight back.
    await openClaude();
    await list.nth(1).getByRole('button', { name: 'More' }).click();
    await win.getByRole('menuitem', { name: 'Remove' }).click();
    await expect(list).toHaveCount(1);
    await expect(win.locator('.acct-detected')).toHaveCount(0);
  } finally {
    await stop(app, home);
  }
});

const daemonPid = (home: string) => (JSON.parse(readFileSync(join(home, 'atelierd.json'), 'utf8')) as { pid: number }).pid;

test('after an atelierd restart a session resumes with its account', async () => {
  // Resumables need a real session id (a UUID).
  const { app, home, ops, win } = await launch(true, { ATELIER_FAKE_SESSION_ID: '88888888-8888-4888-8888-888888888888' });
  try {
    await win.evaluate(() => (window as unknown as { atelier: { terminals: { createSession(o: object): Promise<unknown> } } }).atelier.terminals.createSession({ cols: 100, rows: 30, name: 'Hero', account: 'ops' }));
    await expect.poll(() => configDirOf(win, 'Hero'), { timeout: 15000 }).toBe(ops);
    const first = daemonPid(home);
    process.kill(first, 'SIGTERM');
    const resumeRow = win.locator('.resume-row', { hasText: 'Hero' });
    await expect(resumeRow).toBeVisible({ timeout: 30000 });
    await expect.poll(() => { try { return daemonPid(home); } catch { return first; } }, { timeout: 30000 }).not.toBe(first);
    await expect(resumeRow.locator('.account-chip')).toHaveText('Ops');
    await look(win.locator('.sidebar'), 'test-results/claude-accounts-resume.png');
    await resumeRow.getByRole('button', { name: 'Resume' }).click();
    await expect(win.locator('.xterm-rows:visible')).toContainText('FAKE-CLAUDE args=--resume 88888888-8888-4888-8888-888888888888', { timeout: 15000 });
    await expect.poll(() => configDirOf(win, 'Hero'), { timeout: 15000 }).toBe(ops);
  } finally {
    await stop(app, home);
  }
});
