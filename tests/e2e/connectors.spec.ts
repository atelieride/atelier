import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { e2eEnv } from './env';
import { READ_TOOLS, startFake } from './fake-clickup-cli';
import { look } from './shots';

// Settings › Connectors against the local fake ClickUp: every status of ClickUp's details
// page, the gear dot, the toasts, the palette commands and the Disconnect confirm. Main follows
// the authorize page itself (ATELIER_TEST_FOLLOW_AUTH: no browser opens) and safeStorage is the test stand-in (never the
// Keychain). Notion's details page has its own e2e (notion.spec.ts).

/** Looked at by hand (git-ignored): one per status of the details page (named card-* as in v2.2), the gear dot, a toast. */
const SHOTS = resolve('e2e-shots/v2.2-connectors');

/** Animations off for screenshots that are looked at. */
const still = (win: Page) => win.addStyleTag({ content: '*, *::before, *::after { animation: none !important; transition: none !important; } .xterm-cursor-layer { display: none !important; }' });

async function stop(app: ElectronApplication, home: string) {
  await app.close();
  try { process.kill((JSON.parse(readFileSync(join(home, 'atelierd.json'), 'utf8')) as { pid: number }).pid, 'SIGTERM'); } catch { /* already stopped */ }
}

/** App menu items are clicked (synthetic key events do not go through NSMenu). */
async function menu(app: ElectronApplication, label: string) {
  await app.evaluate(({ Menu, BrowserWindow }, l) => {
    const walk = (items: Electron.MenuItem[]): Electron.MenuItem | undefined => {
      for (const it of items) { if (it.label === l) return it; const sub = it.submenu ? walk(it.submenu.items) : undefined; if (sub) return sub; }
      return undefined;
    };
    const item = walk(Menu.getApplicationMenu()!.items);
    if (!item) throw new Error(`no menu item ${l}`);
    item.click(undefined, BrowserWindow.getAllWindows()[0]);
  }, label);
}

/** Every toast that appeared since the last call (a toast is a new element each time, keyed by its nonce). */
async function watchToasts(win: Page) {
  await win.evaluate(() => {
    const w = window as unknown as { __toasts: string[]; __toastObs?: MutationObserver };
    w.__toasts = [];
    if (w.__toastObs) return;
    w.__toastObs = new MutationObserver((muts) => {
      for (const m of muts) for (const n of m.addedNodes) {
        if (!(n instanceof HTMLElement)) continue;
        const el = n.matches('.toast') ? n : n.querySelector('.toast');
        if (el) w.__toasts.push(el.textContent ?? '');
      }
    });
    w.__toastObs.observe(document.body, { childList: true, subtree: true });
  });
}
const toasts = (win: Page) => win.evaluate(() => (window as unknown as { __toasts: string[] }).__toasts);

const shot = async (loc: Locator, name: string) => { await look(loc, join(SHOTS, name)); };

test('Settings › Connectors: connect, offline, signed out (dot + one toast), reconnect, unavailable, disconnect', async () => {
  mkdirSync(SHOTS, { recursive: true });
  const fake = await startFake();
  const project = mkdtempSync(join(tmpdir(), 'atl-prj-'));
  const { env, home } = e2eEnv({ ATELIER_CLAUDE_BIN: resolve('tests/e2e/fake-claude.pl'), ATELIER_TEST_CLICKUP_URL: fake.url, ATELIER_TEST_FOLLOW_AUTH: '1' });
  const app = await electron.launch({ args: ['out/main/index.js', `--project=${project}`], env });
  try {
    const win = await app.firstWindow();
    await expect(win.locator('.footer')).toBeVisible({ timeout: 15000 });
    await still(win);
    await watchToasts(win);
    const gear = win.locator('.activity-bar .act-bottom');
    const gearDot = gear.locator('.act-dot');

    // Atelier › Connectors… opens the section, after Claude in the nav.
    await menu(app, 'Connectors…');
    const dialog = win.getByRole('dialog', { name: 'Settings' });
    await expect(dialog.getByRole('heading', { name: 'Connectors' })).toBeVisible();
    const nav = await dialog.locator('.set-nav-item').allTextContents();
    expect(nav.indexOf('Connectors')).toBe(nav.indexOf('Claude') + 1);
    // The list first; what the v2.2 card held now lives on ClickUp's details page.
    await dialog.locator('.conn-row[data-connector="clickup"] .conn-row-open').click();
    const card = dialog.locator('.conn-details');
    const status = card.locator('.conn-status');

    // disconnected: icon, name, description, Read-only badge, "Not connected", Connect.
    await expect(card).toHaveAttribute('data-status', 'disconnected');
    await expect(card).toContainText('ClickUp');
    await expect(card).toContainText('Start sessions from your ClickUp tasks.');
    await expect(card.locator('.conn-badge')).toHaveText('Read-only');
    await expect(status).toHaveText('Not connected');
    await expect(card.locator('.conn-actions button')).toHaveText(['Connect']);
    await expect(gearDot).toHaveCount(0);
    await shot(dialog, 'card-disconnected.png');

    // connecting: the fake holds every MCP reply, so the flow waits after the sign-in. Countdown, Cancel, no toast.
    await fake.scenario('slow');
    await card.getByRole('button', { name: 'Connect' }).click();
    await expect(card).toHaveAttribute('data-status', 'connecting');
    await expect(status).toContainText('Waiting for you in the browser…');
    await expect(card.locator('.conn-countdown')).toHaveText(/^[45]:\d\d$/);
    await expect(card.locator('.conn-actions button')).toHaveText(['Cancel', 'Open the page again']);
    await shot(dialog, 'card-connecting.png');
    await card.getByRole('button', { name: 'Cancel' }).click();
    await expect(card).toHaveAttribute('data-status', 'disconnected');
    await expect(status).toHaveText('Not connected');
    expect(await toasts(win)).toEqual([]);

    // A refused sign-in: still "Not connected", why on the second line, and one toast.
    await fake.scenario('authorize-denied');
    await card.getByRole('button', { name: 'Connect' }).click();
    await expect(card.locator('.conn-sub')).toHaveText("You didn't allow access in ClickUp.", { timeout: 15000 });
    await expect(card).toHaveAttribute('data-status', 'disconnected');
    await expect(card.locator('.conn-status .conn-line')).toHaveText('Not connected');
    await expect(win.locator('.toast')).toHaveText("You didn't allow access in ClickUp.");
    await shot(dialog, 'card-disconnected-denied.png');
    expect(await toasts(win)).toEqual(["You didn't allow access in ClickUp."]);
    await watchToasts(win);

    // Flow 1: Connect → connected: account · workspace, updated, Disconnect + Refresh, the options.
    await fake.scenario('normal');
    await card.getByRole('button', { name: 'Connect' }).click();
    await expect(card).toHaveAttribute('data-status', 'connected', { timeout: 15000 });
    await expect(status).toContainText('Connected as Ada Fake · Fakeworks');
    await expect(status).toContainText(/Updated just now|Refreshing tasks…/);
    await expect(card.locator('.conn-actions button')).toHaveText(['Disconnect', 'Refresh']);
    const options = card.locator('.conn-options');
    await expect(options).toContainText('Workspace');
    await expect(options).toContainText('Fakeworks');
    await expect(options).toContainText('Assigned to me');
    const closed = options.getByRole('switch', { name: 'Include closed tasks' });
    await expect(closed).toHaveAttribute('aria-checked', 'false');
    await expect(status).toContainText('Updated just now');
    await shot(dialog, 'card-connected.png');
    await closed.click();
    await expect(closed).toHaveAttribute('aria-checked', 'true');
    await closed.click();
    await expect(closed).toHaveAttribute('aria-checked', 'false');
    // Open tasks in the desktop app: on by default, an app setting (survives Disconnect), saved in preferences.json.
    const inApp = options.getByRole('switch', { name: 'Open tasks in the ClickUp app' });
    await expect(inApp).toHaveAttribute('aria-checked', 'true');
    await expect(options).toContainText("When it's installed; otherwise in your browser.");
    await inApp.click();
    await expect(inApp).toHaveAttribute('aria-checked', 'false');
    await expect.poll(() => JSON.parse(readFileSync(join(home, 'preferences.json'), 'utf8')).openTasksInApp).toBe(false);
    await inApp.click();
    await expect(inApp).toHaveAttribute('aria-checked', 'true');
    expect(existsSync(join(home, 'connectors', 'clickup.bin'))).toBe(true);
    expect(await toasts(win)).toEqual([]);

    // offline: a 5xx on Refresh. Tasks kept, "showing tasks from hh:mm", Retry + Disconnect; Retry brings it back.
    await fake.scenario('mcp-500');
    await card.getByRole('button', { name: 'Refresh' }).click();
    await expect(card).toHaveAttribute('data-status', 'offline', { timeout: 15000 });
    await expect(status).toContainText(/Can't reach ClickUp — showing tasks from \d\d:\d\d/);
    await expect(card.locator('.conn-actions button')).toHaveText(['Retry', 'Disconnect']);
    await expect(gearDot).toHaveCount(0);
    await shot(dialog, 'card-offline.png');
    await fake.scenario('normal');
    await card.getByRole('button', { name: 'Retry' }).click();
    await expect(card).toHaveAttribute('data-status', 'connected', { timeout: 15000 });

    // Flow 2: ClickUp refuses the token → reconnect on the details page, the gear's amber dot, exactly one toast.
    await watchToasts(win);
    await fake.scenario('mcp-401');
    await card.getByRole('button', { name: 'Refresh' }).click();
    await expect(card).toHaveAttribute('data-status', 'reconnect', { timeout: 15000 });
    await expect(status).toHaveText('ClickUp signed you out. Reconnect to see your tasks.');
    await expect(card.locator('.conn-actions button')).toHaveText(['Reconnect', 'Disconnect']);
    await expect(card.locator('.conn-options')).toHaveCount(0);
    await expect(dialog.locator('.set-nav-item', { hasText: 'Connectors' }).locator('.set-nav-dot')).toHaveCount(1);
    await expect(gearDot).toHaveCount(1);
    await expect(gearDot).toHaveClass(/is-waiting/);
    const toast = win.locator('.toast');
    await expect(toast).toContainText('ClickUp signed you out. Reconnect to see your tasks.');
    await expect(toast.getByRole('button', { name: 'Reconnect' })).toBeVisible();
    await shot(dialog, 'card-reconnect.png');
    await look(win, join(SHOTS, 'toast-reconnect.png'), { clip: await clipAround(toast, 40) });
    // A moment later: still the one toast (never repeated per poll).
    await win.waitForTimeout(600);
    expect(await toasts(win)).toEqual(['ClickUp signed you out. Reconnect to see your tasks.Reconnect']);
    // Back to the list: the row says Signed out and keeps its Reconnect.
    await dialog.getByRole('button', { name: 'Back to Connectors' }).click();
    const row = dialog.locator('.conn-row[data-connector="clickup"]');
    await expect(row.locator('.conn-chip')).toContainText('Signed out');
    await expect(row.getByRole('button', { name: 'Reconnect ClickUp' })).toBeVisible();
    await look(dialog, join(SHOTS, 'list-signed-out.png'));

    // The palette offers what fits now: Reconnect and Disconnect, not Connect or Refresh.
    await win.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(gear).toHaveAttribute('aria-label', 'Settings · ClickUp needs attention');
    await look(win, join(SHOTS, 'gear-dot.png'), { clip: await clipAround(gear, 40) });
    await menu(app, 'Search…');
    await win.locator('.palette-input').fill('>ClickUp');
    const items = win.locator('.palette-item .palette-label');
    await expect(items).toHaveText(['Reconnect ClickUp…', 'Disconnect ClickUp…']);
    await win.locator('.palette-input').fill('>Refresh Tasks');
    await expect(win.locator('.palette-item .palette-label', { hasText: 'Refresh Tasks' })).toHaveCount(0);
    await win.keyboard.press('Escape');
    // Reopened from the menu, Settings starts on the list again (only the gear and the toasts go to the details).
    await menu(app, 'Connectors…');
    await expect(dialog.locator('.conn-list')).toBeVisible();
    await win.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);

    // Flow 3: back to normal, the gear (it opens Connectors while something needs you) → Reconnect → connected.
    await fake.scenario('normal');
    // The gear goes straight to ClickUp's details.
    await gear.click();
    await expect(dialog.getByRole('heading', { name: 'ClickUp' })).toBeVisible();
    await card.getByRole('button', { name: 'Reconnect' }).click();
    await expect(card).toHaveAttribute('data-status', 'connected', { timeout: 15000 });
    await expect(status).toContainText('Connected as Ada Fake · Fakeworks');
    await expect(gearDot).toHaveCount(0);

    // unavailable: replies Atelier can't read → "connector changed", one toast with Details; Retry brings it back.
    await watchToasts(win);
    await fake.scenario('schema-changed');
    await card.getByRole('button', { name: 'Refresh' }).click();
    await expect(card).toHaveAttribute('data-status', 'unavailable', { timeout: 15000 });
    await expect(status).toHaveText("ClickUp's connector changed: update Atelier.");
    await expect(card.locator('.conn-actions button')).toHaveText(['Retry', 'Disconnect']);
    await expect(gearDot).toHaveCount(1);
    // The toast says which, in the details page's words.
    await expect(toast).toContainText("ClickUp's connector changed: update Atelier.");
    await shot(dialog, 'card-unavailable.png');
    expect(await toasts(win)).toEqual(["ClickUp's connector changed: update Atelier.Details"]);
    // The toast's action opens the details of the connector that needs you, from anywhere.
    await win.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await toast.getByRole('button', { name: 'Details' }).click();
    await expect(card).toHaveAttribute('data-status', 'unavailable');
    await expect(dialog.locator('.conn-list')).toHaveCount(0);
    await fake.scenario('normal');
    await card.getByRole('button', { name: 'Retry' }).click();
    await expect(card).toHaveAttribute('data-status', 'connected', { timeout: 15000 });

    // Flow 4: the palette's "Disconnect ClickUp…" opens the confirm on the details page; Esc closes only the confirm.
    await win.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await menu(app, 'Search…');
    await win.locator('.palette-input').fill('>Disconnect ClickUp');
    await win.locator('.palette-input').press('Enter');
    const confirm = card.getByRole('group', { name: 'Disconnect ClickUp?' });
    await expect(confirm).toContainText('Atelier forgets the connection and its tasks. Sessions keep their task links.');
    await expect(confirm).toContainText("To also revoke Atelier's access in ClickUp, remove it under ClickUp › Settings › Apps.");
    await expect(confirm.getByRole('button', { name: 'Keep connected' })).toBeFocused();
    await shot(dialog, 'card-disconnect-confirm.png');
    await win.keyboard.press('Escape');
    await expect(confirm).toHaveCount(0);
    await expect(dialog).toBeVisible();
    await expect(card).toHaveAttribute('data-status', 'connected');
    // The details page's own Disconnect asks too; confirming forgets the connection and deletes the saved blob.
    await card.locator('.conn-actions').getByRole('button', { name: 'Disconnect' }).click();
    await confirm.getByRole('button', { name: 'Disconnect' }).click();
    await expect(card).toHaveAttribute('data-status', 'disconnected');
    await expect(status).toHaveText('Not connected');
    await expect(card.getByRole('button', { name: 'Connect' })).toBeFocused();
    expect(existsSync(join(home, 'connectors', 'clickup.bin'))).toBe(false);

    // Only read tools ever reached ClickUp.
    const calls = await fake.calls();
    expect(calls).toContain('clickup_filter_tasks');
    expect(calls.filter((n) => !READ_TOOLS.includes(n))).toEqual([]);
  } finally {
    await stop(app, home);
    fake.close();
  }
});

test('revoked while Atelier was closed: at launch, the reconnect card, the gear dot and one toast', async () => {
  const fake = await startFake();
  const project = mkdtempSync(join(tmpdir(), 'atl-prj-'));
  const { env, home } = e2eEnv({ ATELIER_CLAUDE_BIN: resolve('tests/e2e/fake-claude.pl'), ATELIER_TEST_CLICKUP_URL: fake.url, ATELIER_TEST_FOLLOW_AUTH: '1' });
  const launch = () => electron.launch({ args: ['out/main/index.js', `--project=${project}`], env });
  let app = await launch();
  try {
    const first = await app.firstWindow();
    await expect(first.locator('.footer')).toBeVisible({ timeout: 15000 });
    type Api = { connectors: { connect(id: 'clickup'): Promise<unknown>; list(): Promise<{ connectors: { status: string }[] }> } };
    const api = <T>(fn: (a: Api) => Promise<T>) => first.evaluate(`(${fn.toString()})(window.atelier)`) as Promise<T>;
    await api((a) => a.connectors.connect('clickup'));
    await expect.poll(() => api((a) => a.connectors.list().then((r) => r.connectors[0]?.status)), { timeout: 15000 }).toBe('connected');
  } finally {
    await stop(app, home);
  }
  // ClickUp forgets the token (revoked, password reset) while the app is closed.
  await fetch(`${fake.url}/__revoke`, { method: 'POST' });
  app = await launch();
  try {
    const win = await app.firstWindow();
    await expect(win.locator('.footer')).toBeVisible({ timeout: 15000 });
    await watchToasts(win);
    const toast = win.locator('.toast');
    await expect(toast).toContainText('ClickUp signed you out. Reconnect to see your tasks.', { timeout: 15000 });
    const gear = win.locator('.activity-bar .act-bottom');
    await expect(gear.locator('.act-dot')).toHaveCount(1);
    // Never repeated: the launch fetch and the window's first list make one toast, nothing comes after it.
    await win.waitForTimeout(1500);
    expect((await toasts(win)).filter((x) => x.includes('signed you out')).length).toBeLessThanOrEqual(1);
    await expect(toast).toHaveCount(1);
    // The gear goes straight to the connector that needs you.
    await gear.click();
    const dialog = win.getByRole('dialog', { name: 'Settings' });
    await expect(dialog.getByRole('heading', { name: 'ClickUp' })).toBeVisible();
    await expect(dialog.locator('.conn-details')).toHaveAttribute('data-status', 'reconnect');
    await expect(dialog.locator('.conn-details .conn-line')).toHaveText('ClickUp signed you out. Reconnect to see your tasks.');
    const calls = await fake.calls();
    expect(calls.filter((n) => !READ_TOOLS.includes(n))).toEqual([]);
  } finally {
    await stop(app, home);
    fake.close();
  }
});

/** A screenshot clip around an element, inside the window. */
async function clipAround(loc: Locator, pad: number) {
  const b = (await loc.boundingBox())!;
  const x = Math.max(0, b.x - pad);
  const y = Math.max(0, b.y - pad);
  return { x, y, width: b.width + pad * 2, height: b.height + pad * 2 };
}
