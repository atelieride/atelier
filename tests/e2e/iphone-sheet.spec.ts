// The pairing sheet and Settings › iPhone, as a person at the keyboard meets them: the window's commands never act
// behind the sheet (and the session behind it isn't seen); Esc and the relay field; what the sheet's off state knows
// before Settings › iPhone was ever opened; Settings asked main for nothing while arrowed through; Forget All; what a
// screen reader hears when a phone asks and when the code renews; Tab kept inside the sheet; two windows' sheets.
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { RemoteDeviceInfo, RemotePairing, RemotePairingEvent, RemotePairingStart, RemoteStatus } from '../../src/shared/remote';
import { e2eEnv, writePrefs } from './env';
import { look } from './shots';
import { startTestRelay } from '../support/test-relay';
import { FakePhone } from '../support/fake-phone';
import { codeOnScreen, command, launchProject, openIphoneSettings, settingsOf, settingsSet, stopDaemon } from './iphone-fixture';

const SHOTS = 'test-results/iphone-sheet';

const device = (o: Partial<RemoteDeviceInfo> = {}): RemoteDeviceInfo => ({ id: 'dev-1', name: 'Test iPhone', model: 'iPhone17,1', pairedAt: Date.now() - 86_400_000, lastSeenAt: Date.now() - 3_600_000, connected: false, attached: [], ...o });
const statusOf = (o: Partial<RemoteStatus> = {}): RemoteStatus => ({ enabled: true, available: true, relay: { state: 'online' }, devices: [], sized: [], ...o });
const QR = 'atelier://pair?v=1&c=AAAABBBBCCCC&r=https%3A%2F%2Frelay.useatelier.dev&k=' + 'Q'.repeat(43) + '&n=Studio';
const pairingOf = (code: string): RemotePairing => ({ code, qr: QR.replace('AAAABBBBCCCC', code.replace(/-/g, '')), expiresAt: Date.now() + 300_000 });

/** main's iPhone handlers answer as the test says, and record what the window asked. */
async function standIn(app: ElectronApplication, status: RemoteStatus, start: RemotePairingStart): Promise<void> {
  await app.evaluate(({ ipcMain }, o) => {
    const g = globalThis as unknown as { remote: { status: unknown; start: unknown; calls: unknown[][] } };
    g.remote = { status: o.status, start: o.start, calls: [] };
    for (const c of ['remote:status', 'remote:start-pairing', 'remote:stop-pairing', 'remote:decide', 'remote:reset']) ipcMain.removeHandler(c);
    ipcMain.handle('remote:status', () => { g.remote.calls.push(['status']); return g.remote.status; });
    ipcMain.handle('remote:start-pairing', () => g.remote.start);
    ipcMain.handle('remote:stop-pairing', () => { g.remote.calls.push(['stop']); });
    ipcMain.handle('remote:decide', (_e, a: { requestId: string; allow: boolean }) => { g.remote.calls.push(['decide', a.requestId, a.allow]); return true; });
    ipcMain.handle('remote:reset', () => { g.remote.calls.push(['reset']); });
  }, { status, start });
}
const calls = (app: ElectronApplication) => app.evaluate(() => (globalThis as unknown as { remote: { calls: unknown[][] } }).remote.calls);
const pushPairing = (app: ElectronApplication, e: RemotePairingEvent) => app.evaluate(({ BrowserWindow }, e) => { for (const w of BrowserWindow.getAllWindows()) w.webContents.send('ev:remote-pairing', e); }, e);
/** Every IPC call the page made before this one has reached main (one pipe, in order). */
const roundTrip = (win: Page) => win.evaluate(() => (window as unknown as { atelier: { appInfo(): Promise<unknown> } }).atelier.appInfo());

test('the window\'s commands never act behind the pairing sheet, and the session behind it isn\'t marked seen', async () => {
  test.setTimeout(120_000);
  const { app, win, home } = await launchProject({ ATELIER_CLAUDE_BIN: resolve('tests/e2e/fake-claude.pl') });
  try {
    const sheet = win.locator('.pair-sheet');
    // ⌘W closes the sheet, not the tab under it.
    await command(app, 'pair-iphone');
    await expect(sheet.getByRole('heading', { name: 'iPhone access is off' })).toBeVisible();
    await command(app, 'close-tab');
    await expect(sheet).toHaveCount(0);
    await expect(win.locator('.tab')).toHaveCount(1);
    // ⌘K: the sheet goes, the palette comes; never the palette over the sheet.
    await command(app, 'pair-iphone');
    await expect(sheet).toBeVisible();
    await command(app, 'open-palette');
    await expect(win.locator('.palette-input')).toBeVisible();
    await expect(sheet).toHaveCount(0);
    await win.keyboard.press('Escape');
    // Pair iPhone… again keeps the sheet as it is.
    await command(app, 'pair-iphone');
    await expect(sheet.getByRole('button', { name: 'Turn On and Pair' })).toBeFocused();
    await command(app, 'pair-iphone');
    await expect(sheet).toHaveCount(1);
    await win.keyboard.press('Escape');

    // A Claude session in front, the window looking at it; main records the window's "seen" instead of passing it on.
    await command(app, 'new-session');
    await win.getByPlaceholder('Session name (optional)').fill('Alfa');
    await win.keyboard.press('Enter');
    const row = win.locator('.session-row', { hasText: 'Alfa' });
    await expect(row).toHaveClass(/state-waiting/, { timeout: 20000 });
    const id = (await row.getAttribute('data-term-row'))!;
    await app.evaluate(({ ipcMain }) => {
      const g = globalThis as unknown as { seen: string[] };
      g.seen = [];
      ipcMain.removeHandler('term:mark-seen');
      ipcMain.handle('term:mark-seen', (_e, id: string) => { g.seen.push(id); });
    });
    await win.evaluate(() => { document.hasFocus = () => true; window.dispatchEvent(new Event('focus')); });
    // The sheet over it, the turn ends: unread, and not seen while the sheet covers it.
    await command(app, 'pair-iphone');
    await expect(sheet).toBeVisible();
    await win.evaluate((id) => (window as unknown as { atelier: { terminals: { input(id: string, d: string): void } } }).atelier.terminals.input(id, '\r'), id);
    await expect(row).toHaveClass(/is-unread/, { timeout: 15000 });
    await roundTrip(win);
    expect(await app.evaluate(() => (globalThis as unknown as { seen: string[] }).seen)).not.toContain(id);
    // The sheet closed: the window is looking at it again.
    await win.keyboard.press('Escape');
    await expect(sheet).toHaveCount(0);
    await expect.poll(() => app.evaluate(() => (globalThis as unknown as { seen: string[] }).seen)).toContain(id);
  } finally {
    await app.close();
    stopDaemon(home);
  }
});

test('Settings › iPhone: Esc in the relay field puts the saved address back; with the saved one there, it closes Settings', async () => {
  test.setTimeout(120_000);
  const { app, win, home } = await launchProject();
  try {
    await openIphoneSettings(app, win);
    const field = win.getByRole('textbox', { name: 'Relay server' });
    await field.fill('https://relay.test/typed');
    await field.press('Escape');
    await expect(field).toHaveValue('https://relay.useatelier.dev');
    await expect(win.locator('.settings')).toBeVisible();
    await field.press('Escape');
    await expect(win.locator('.settings')).toHaveCount(0);
    expect((await settingsOf(win))?.remoteRelay).toBe('https://relay.useatelier.dev');
  } finally {
    await app.close();
    stopDaemon(home);
  }
});

test('Settings › iPhone: the relay field warns once its address is used, not while it is typed', async () => {
  test.setTimeout(120_000);
  const { app, win, home } = await launchProject();
  try {
    await openIphoneSettings(app, win);
    const field = win.getByRole('textbox', { name: 'Relay server' });
    const warn = win.locator('#iph-relay-warn');
    // Typing: no warning yet.
    await field.fill('h');
    await expect(warn).toHaveCount(0);
    await expect(field).not.toHaveAttribute('aria-invalid', 'true');
    // Enter: the warning, and nothing saved.
    await field.press('Enter');
    await expect(warn).toHaveText('Use an address that starts with https://.');
    await expect(field).toHaveAttribute('aria-invalid', 'true');
    expect((await settingsOf(win))?.remoteRelay).toBe('https://relay.useatelier.dev');
    // Once shown, it follows the typing until the address is one Atelier can use.
    await field.fill('http://relay.test');
    await expect(warn).toContainText('http:// works only for this computer or your local network');
    await field.fill('https://relay.test');
    await expect(warn).toHaveCount(0);
    await expect(field).not.toHaveAttribute('aria-invalid', 'true');
    // Typed wrong again, then left: the warning on blur.
    await field.fill('relay.test');
    await expect(warn).toHaveCount(0);
    await field.press('Tab');
    await expect(warn).toHaveText('Use an address that starts with https://.');
    await warn.scrollIntoViewIfNeeded();
    await look(win, `${SHOTS}/relay-warned.png`, { settle: 300 });
    // Esc puts the saved address back, and the warning goes with what was typed.
    await field.focus();
    await field.press('Escape');
    await expect(field).toHaveValue('https://relay.useatelier.dev');
    await expect(warn).toHaveCount(0);
    expect((await settingsOf(win))?.remoteRelay).toBe('https://relay.useatelier.dev');
  } finally {
    await app.close();
    stopDaemon(home);
  }
});

test('Pair iPhone… before Settings › iPhone was ever opened: on a Mac that can\'t keep the keys, the sheet says so and offers nothing to turn on', async () => {
  test.setTimeout(120_000);
  const { app, win, home } = await launchProject();
  try {
    await standIn(app, statusOf({ enabled: false, available: false, relay: { state: 'offline' } }), { ok: false, reason: 'disabled', message: 'Turn on access from iPhone first.' });
    await command(app, 'pair-iphone');
    const sheet = win.locator('.pair-sheet');
    await expect(sheet.getByRole('heading', { name: 'iPhone access is unavailable' })).toBeVisible();
    await expect(sheet.getByRole('button', { name: 'Turn On and Pair' })).toHaveCount(0);
    await expect(sheet).toContainText("This computer can't keep the keys for iPhone access encrypted");
    await expect(sheet.getByRole('button', { name: 'Close' }).last()).toBeFocused();
    await look(win, `${SHOTS}/sheet-unavailable.png`, { settle: 300 });
    expect(await calls(app)).toContainEqual(['status']);
    await settingsSet(win, { theme: 'daylight' });
    await look(win, `${SHOTS}/sheet-unavailable-light.png`, { settle: 400 });
  } finally {
    await app.close();
    stopDaemon(home);
  }
});

test('arrowed through, Settings › iPhone asks main nothing; shown, it asks once', async () => {
  test.setTimeout(120_000);
  const { app, win, home } = await launchProject();
  try {
    await standIn(app, statusOf({ enabled: false, relay: { state: 'offline' } }), { ok: false, reason: 'disabled', message: '' });
    const statusCalls = async () => (await calls(app)).filter((c) => c[0] === 'status').length;
    // Shown and stayed on: asked once, the paired phones shown from the answer.
    await openIphoneSettings(app, win);
    await expect(win.locator('.iph-empty')).toContainText('No iPhone paired yet');
    expect(await statusCalls()).toBe(1);
    await win.locator('.set-nav-item', { hasText: 'Notifications' }).click();
    await expect(win.locator('.set-head h2')).toHaveText('Notifications');
    // Down past iPhone to Keyboard, as fast as keys repeat: Settings › iPhone shows in passing and asks nothing.
    await win.keyboard.press('ArrowDown');
    await win.keyboard.press('ArrowDown');
    await expect(win.locator('.set-head h2')).toHaveText('Keyboard');
    await roundTrip(win);
    expect(await statusCalls()).toBe(1);
    // Back on iPhone, staying: asked again.
    await win.keyboard.press('ArrowUp');
    await expect(win.locator('.set-head h2')).toHaveText('iPhone');
    await expect.poll(statusCalls).toBe(2);
  } finally {
    await app.close();
    stopDaemon(home);
  }
});

test('Forget All…: offered only with a phone paired or access on; its confirm forgets them all', async () => {
  test.setTimeout(120_000);
  const { app, win, home } = await launchProject();
  try {
    await standIn(app, statusOf({ enabled: false, relay: { state: 'offline' } }), { ok: false, reason: 'disabled', message: '' });
    await openIphoneSettings(app, win);
    await expect(win.locator('.iph-empty')).toBeVisible();
    const forget = win.getByRole('button', { name: 'Forget All…' });
    await expect(forget).toBeDisabled();
    await forget.scrollIntoViewIfNeeded();
    await look(win, `${SHOTS}/forget-disabled.png`, { settle: 300 });

    // A phone paired (access still off): Forget All… asks, then forgets.
    const paired = statusOf({ enabled: false, relay: { state: 'offline' }, devices: [device()] });
    await app.evaluate(({ BrowserWindow }, s) => {
      (globalThis as unknown as { remote: { status: unknown } }).remote.status = s;
      for (const w of BrowserWindow.getAllWindows()) w.webContents.send('ev:remote', s);
    }, paired);
    await expect(win.locator('.iph-device', { hasText: 'Test iPhone' })).toBeVisible();
    await expect(forget).toBeEnabled();
    await forget.click();
    const ask = win.getByRole('group', { name: 'Forget all iPhones?' });
    await expect(ask).toBeVisible();
    await ask.getByRole('button', { name: 'Forget All', exact: true }).click();
    await expect.poll(() => calls(app)).toContainEqual(['reset']);
    await expect(ask).toHaveCount(0);
  } finally {
    await app.close();
    stopDaemon(home);
  }
});

test('a renewed code is said in the same live region as the one before', async () => {
  test.setTimeout(120_000);
  const { app, win, home } = await launchProject();
  try {
    await standIn(app, statusOf(), { ok: true, pairing: pairingOf('AAAA-BBBB-CCCC') });
    await command(app, 'pair-iphone');
    const sheet = win.locator('.pair-sheet');
    expect(await codeOnScreen(win)).toBe('AAAA-BBBB-CCCC');
    // The code's live region stays the same element when the code renews: its new text is announced.
    await sheet.locator('[aria-live]', { hasText: 'AAAA-BBBB-CCCC' }).evaluate((el) => { el.setAttribute('data-mark', 'first'); });
    await pushPairing(app, { kind: 'code', pairing: pairingOf('DDDD-EEEE-FFFF') });
    expect(await codeOnScreen(win, 'AAAA-BBBB-CCCC')).toBe('DDDD-EEEE-FFFF');
    await expect(sheet.locator('[aria-live][data-mark="first"]')).toContainText('DDDD-EEEE-FFFF');
    await expect(sheet.locator('[aria-live]')).toHaveCount(1);
  } finally {
    await app.close();
    stopDaemon(home);
  }
});

test('when a phone asks: an alert dialog, its question tied to Deny; Tab kept inside the sheet over Settings', async () => {
  test.setTimeout(120_000);
  const { app, win, home } = await launchProject();
  try {
    await standIn(app, statusOf(), { ok: true, pairing: pairingOf('AAAA-BBBB-CCCC') });
    await command(app, 'open-settings');
    await command(app, 'pair-iphone');
    const sheet = win.locator('.pair-sheet');
    expect(await codeOnScreen(win)).toBe('AAAA-BBBB-CCCC');

    // Tab with a code on screen: the sheet's one button keeps the keyboard.
    await sheet.getByRole('button', { name: 'Close' }).focus();
    await win.keyboard.press('Tab');
    await expect(sheet.getByRole('button', { name: 'Close' })).toBeFocused();

    // A phone asks: an alert dialog whose question Deny, focused, carries.
    await pushPairing(app, { kind: 'request', request: { id: 'req-1', name: 'Test iPhone', model: 'iPhone17,1', expiresAt: Date.now() + 60_000 } });
    const alert = win.getByRole('alertdialog');
    await expect(alert).toBeVisible();
    const deny = alert.getByRole('button', { name: 'Deny' });
    await expect(deny).toBeFocused();
    await expect(deny).toHaveAccessibleDescription(/Allow Test iPhone to use Atelier\?.*It will be able to see your sessions and type in them\./);
    await expect(alert).toHaveAccessibleDescription(/Allow Test iPhone to use Atelier\?/);
    // Tab and ⇧Tab go round the sheet's buttons, never to Settings under it.
    const allow = alert.getByRole('button', { name: 'Allow' });
    const x = alert.getByRole('button', { name: 'Close' });
    await win.keyboard.press('Tab');
    await expect(allow).toBeFocused();
    await win.keyboard.press('Tab');
    await expect(x).toBeFocused();
    await win.keyboard.press('Shift+Tab');
    await expect(allow).toBeFocused();
    await win.keyboard.press('Tab');
    await win.keyboard.press('Tab');
    await expect(deny).toBeFocused();
    expect(await win.evaluate(() => !!document.activeElement?.closest('.pair-sheet'))).toBe(true);
    await look(win, `${SHOTS}/sheet-alert.png`, { settle: 300 });
    await settingsSet(win, { theme: 'daylight' });
    await look(win, `${SHOTS}/sheet-alert-light.png`, { settle: 400 });
  } finally {
    await app.close();
    stopDaemon(home);
  }
});

test('two windows with the sheet open: one closed, the other gets a fresh code a phone pairs with', async () => {
  test.setTimeout(180_000);
  const relay = await startTestRelay();
  const a = realpathSync(mkdtempSync(join(tmpdir(), 'atl-iph-a-')));
  const b = realpathSync(mkdtempSync(join(tmpdir(), 'atl-iph-b-')));
  const { env, home } = e2eEnv({ ATELIER_TEST_RELAY_URL: relay.url });
  // Both windows were open at the last quit; iPhone access is on.
  writeFileSync(join(home, 'ui-state.json'), JSON.stringify({ openProjects: [a, b], recent: [a, b], quitInfoShown: true }));
  writePrefs(home, { remoteAccess: true });
  const app = await electron.launch({ args: ['out/main/index.js'], env });
  const phone = new FakePhone({ relay: relay.url });
  try {
    await expect.poll(() => app.windows().length, { timeout: 15000 }).toBe(2);
    const [one, two] = app.windows() as [Page, Page];
    for (const w of [one, two]) await expect(w.locator('.project-chip')).toBeVisible({ timeout: 15000 });
    await app.evaluate(({ BrowserWindow }) => { for (const w of BrowserWindow.getAllWindows()) w.webContents.send('ev:command', 'pair-iphone'); });
    const first = await codeOnScreen(one);
    expect(await codeOnScreen(two)).toBe(first);
    await expect.poll(() => relay.offers().length, { timeout: 15000 }).toBe(1);

    // The first window's sheet closed: its code goes; the other window's sheet shows a fresh one, the relay's only.
    await one.locator('.pair-sheet').getByRole('button', { name: 'Close' }).click();
    await expect(one.locator('.pair-sheet')).toHaveCount(0);
    const fresh = await codeOnScreen(two, first);
    await expect.poll(() => relay.offers().length, { timeout: 15000 }).toBe(1);
    // That code works: a phone pairs with it, Allowed in the second window.
    const paired = phone.pairByCode(fresh);
    const sheet = two.locator('.pair-sheet');
    await expect(sheet.getByRole('heading', { name: 'Allow Test iPhone to use Atelier?' })).toBeVisible({ timeout: 20000 });
    await sheet.getByRole('button', { name: 'Allow' }).click();
    expect((await paired).t).toBe('welcome');
    await expect(sheet).toHaveCount(0);
    await expect(one.locator('.pair-sheet')).toHaveCount(0);
    expect(fresh).not.toBe(first);
  } finally {
    phone.drop();
    await app.close();
    stopDaemon(home);
    await relay.close();
  }
});
