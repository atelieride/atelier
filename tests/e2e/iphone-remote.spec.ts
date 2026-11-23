// iPhone access end to end. Through the test relay (tests/support/test-relay.ts): Settings › iPhone turns access on,
// says when the relay can't be reached, takes a relay address only when Atelier may dial it, and connects to the test
// relay; the pairing sheet offers to turn access on, shows a live code (QR and text) that renews in place, and takes
// it back when it closes. From main's news (its remote handlers stood in for): the Allow / Deny question, the toast,
// the notices, the footer pill, the phone badge on the tab and the row, the size note and Fit to Window, the paired
// phones' list and Remove. And with a fake phone on Atelier's own Noise code (tests/support/fake-phone.ts): pairing by
// code, Allow, a phone typing in a terminal, access off and Remove dropping it. And the beta it is said to be, where
// pairing starts.
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { basename } from 'node:path';
import type { RemoteDeviceInfo, RemotePairing, RemotePairingEvent, RemoteStatus } from '../../src/shared/remote';
import { look, shotsOn } from './shots';
import { startTestRelay, type TestRelay } from '../support/test-relay';
import { FakePhone, type Msg } from '../support/fake-phone';
import { codeOnScreen, command, launchProject as launch, openIphoneSettings as openSection, pairPhone, settingsOf, settingsSet, stopDaemon } from './iphone-fixture';

const SHOTS = 'test-results/iphone-remote';

const setTheme = (win: Page, theme: string) => settingsSet(win, { theme });
/** A setting as main saved it. */
const saved = (win: Page, key: 'remoteRelay' | 'remoteAccess') => settingsOf(win).then((s) => s?.[key]);

test('Settings › iPhone: access on, an unreachable relay said, the relay field checked then used; Pair iPhone… shows a live code', async () => {
  test.setTimeout(120_000);
  const relay: TestRelay = await startTestRelay();
  // The default relay stands for a closed port in tests: the Relay server field points Atelier at the test relay.
  const { app, win, home } = await launch();
  try {
    // Access off: nobody paired yet, no status line.
    await openSection(app, win);
    const access = win.getByRole('switch', { name: 'Allow access from iPhone' });
    await expect(access).toHaveAttribute('aria-checked', 'false');
    await expect(win.locator('.iph-empty')).toContainText('No iPhone paired yet');
    await expect(win.locator('.iph-status')).toHaveCount(0);
    await look(win, `${SHOTS}/settings-off.png`, { settle: 300 });

    // On: the relay the setting names can't be reached (the closed port), and the status line says so.
    await access.click();
    await expect(win.locator('.iph-status')).toContainText("Can't reach the relay", { timeout: 15000 });
    await look(win, `${SHOTS}/settings-unreachable.png`, { settle: 300 });

    // An address Atelier won't dial is explained and never saved; the test relay is, and Atelier connects to it.
    const field = win.getByRole('textbox', { name: 'Relay server' });
    await field.fill('http://relay.test');
    await field.press('Enter');
    await expect(win.locator('#iph-relay-warn')).toContainText('http:// works only for this computer or your local network');
    await look(win, `${SHOTS}/settings-relay-invalid.png`, { settle: 200 });
    expect(await saved(win, 'remoteRelay')).toBe('https://relay.useatelier.dev');
    await field.fill(relay.url);
    await expect(win.locator('#iph-relay-warn')).toHaveCount(0);
    await field.press('Enter');
    await expect(win.locator('.iph-status')).toContainText('Connected to the relay', { timeout: 15000 });
    await expect(win.locator('.iph-status')).toContainText(new URL(relay.url).host);
    await expect(win.getByRole('button', { name: 'Use Default' })).toBeVisible();
    await look(win, `${SHOTS}/settings-online.png`, { settle: 300 });

    // Pair iPhone…: the code as a QR code and as text, offered to the relay for its five minutes.
    await win.getByRole('button', { name: 'Pair iPhone…' }).click();
    const sheet = win.locator('.pair-sheet');
    await expect(sheet).toBeVisible();
    await codeOnScreen(win);
    await expect(sheet.locator('.pair-qr svg path')).toHaveCount(1);
    await expect(sheet.locator('.pair-qr')).toHaveAttribute('data-qr', new RegExp(`^atelier://pair\\?v=1&c=[0-9A-Z]{12}&r=${encodeURIComponent(relay.url).replace(/\./g, '\\.')}&k=`));
    await expect(sheet.locator('.pair-left')).toContainText(/New code in [45]:\d\d/);
    await expect(sheet.locator('.pair-notice')).toHaveCount(0);
    await expect.poll(() => relay.offers().length).toBe(1);
    await look(win, `${SHOTS}/sheet-code.png`, { settle: 400 });
    // Closed, the code goes with it.
    await win.keyboard.press('Escape');
    await expect(sheet).toHaveCount(0);
    await expect.poll(() => relay.offers().length, { timeout: 10000 }).toBe(0);
    await expect(win.locator('.settings')).toBeVisible();

    // The same in a light theme.
    await setTheme(win, 'daylight');
    await look(win, `${SHOTS}/settings-light.png`, { settle: 400 });
    await win.getByRole('button', { name: 'Pair iPhone…' }).click();
    await codeOnScreen(win);
    await look(win, `${SHOTS}/sheet-code-light.png`, { settle: 400 });
  } finally {
    await app.close();
    stopDaemon(home);
    await relay.close();
  }
});

test('the pairing sheet offers to turn access on, and a code that runs out renews in place', async () => {
  test.setTimeout(120_000);
  const relay = await startTestRelay();
  // A code lives 6 s here.
  const { app, win, home } = await launch({ ATELIER_TEST_RELAY_URL: relay.url, ATELIER_TEST_REMOTE_CODE_MS: '6000' });
  try {
    // Pair iPhone… from the menu with access off: the sheet offers to turn it on.
    await command(app, 'pair-iphone');
    const sheet = win.locator('.pair-sheet');
    await expect(sheet.getByRole('heading', { name: 'iPhone access is off' })).toBeVisible();
    await expect(sheet.getByRole('button', { name: 'Turn On and Pair' })).toBeFocused();
    await look(win, `${SHOTS}/sheet-off.png`, { settle: 300 });
    await sheet.getByRole('button', { name: 'Turn On and Pair' }).click();
    const first = await codeOnScreen(win);
    expect(await saved(win, 'remoteAccess')).toBe(true);
    // Until the relay connection is up, the sheet says the code can't reach a phone yet; then it goes quiet.
    await expect(sheet.locator('.pair-notice')).toHaveCount(0, { timeout: 15000 });

    // It runs out and renews by itself, in place: no blank sheet in between.
    const blank = await win.evaluate(() => new Promise<boolean>((resolve) => {
      let seen = false;
      const obs = new MutationObserver(() => { if (document.querySelector('.pair-body.is-starting')) seen = true; });
      obs.observe(document.body, { subtree: true, childList: true });
      const was = document.querySelector('.pair-code')?.textContent;
      const timer = setInterval(() => {
        const now = document.querySelector('.pair-code')?.textContent;
        if (now && now !== was) { clearInterval(timer); obs.disconnect(); resolve(seen); }
      }, 20);
    }));
    expect(blank).toBe(false);
    const second = await codeOnScreen(win, first);
    expect(second).not.toBe(first);
    await expect(sheet.locator('.pair-left')).toContainText(/New code in 0:0[3-6]/);
    // The relay knows the fresh code only.
    expect(relay.offers()).toHaveLength(1);

    // The menu's command and the palette's, with the sheet closed.
    await win.keyboard.press('Escape');
    await expect(sheet).toHaveCount(0);
    await command(app, 'open-palette');
    await win.locator('.palette-input').fill('>Pair iPhone');
    await expect(win.locator('.palette-item.is-active')).toContainText('Pair iPhone…');
    await win.keyboard.press('Enter');
    await expect(sheet).toBeVisible();
    await codeOnScreen(win);
  } finally {
    await app.close();
    stopDaemon(home);
    await relay.close();
  }
});

// ── What the windows show of main's news ──

const QR = 'atelier://pair?v=1&c=7K4Q9MXD2HTR&r=https%3A%2F%2Frelay.useatelier.dev&k=' + 'Q'.repeat(43) + '&n=Studio';
const pairingOf = (code: string, ms = 300_000): RemotePairing => ({ code, qr: QR.replace('7K4Q9MXD2HTR', code.replace(/-/g, '')), expiresAt: Date.now() + ms });
const device = (o: Partial<RemoteDeviceInfo>): RemoteDeviceInfo => ({ id: 'dev-1', name: 'Test iPhone', model: 'iPhone17,1', pairedAt: Date.now() - 86_400_000, lastSeenAt: Date.now(), connected: true, attached: [], ...o });
const statusOf = (o: Partial<RemoteStatus>): RemoteStatus => ({ enabled: true, available: true, relay: { state: 'online' }, devices: [], sized: [], ...o });

/** main's iPhone handlers answer as this test says, and record what the window asked. */
async function standIn(app: ElectronApplication, status: RemoteStatus, pairing: RemotePairing): Promise<void> {
  await app.evaluate(({ ipcMain }, o) => {
    const g = globalThis as unknown as { remote: { status: unknown; pairing: unknown; calls: unknown[][] } };
    g.remote = { status: o.status, pairing: o.pairing, calls: [] };
    for (const c of ['remote:status', 'remote:start-pairing', 'remote:stop-pairing', 'remote:decide', 'remote:remove-device']) ipcMain.removeHandler(c);
    ipcMain.handle('remote:status', () => g.remote.status);
    ipcMain.handle('remote:start-pairing', () => ({ ok: true, pairing: g.remote.pairing }));
    ipcMain.handle('remote:stop-pairing', () => { g.remote.calls.push(['stop']); });
    ipcMain.handle('remote:decide', (_e, a: { requestId: string; allow: boolean }) => { g.remote.calls.push(['decide', a.requestId, a.allow]); return true; });
    ipcMain.handle('remote:remove-device', (_e, a: { id: string }) => { g.remote.calls.push(['remove', a.id]); return true; });
    g.remote.calls = [];
  }, { status, pairing });
}
const calls = (app: ElectronApplication) => app.evaluate(() => (globalThis as unknown as { remote: { calls: unknown[][] } }).remote.calls);
const pushStatus = async (app: ElectronApplication, s: RemoteStatus) => {
  await app.evaluate(({ BrowserWindow }, s) => {
    (globalThis as unknown as { remote: { status: unknown } }).remote.status = s;
    for (const w of BrowserWindow.getAllWindows()) w.webContents.send('ev:remote', s);
  }, s);
};
const pushPairing = (app: ElectronApplication, e: RemotePairingEvent) => app.evaluate(({ BrowserWindow }, e) => { for (const w of BrowserWindow.getAllWindows()) w.webContents.send('ev:remote-pairing', e); }, e);

test('main\'s news on screen: the Allow question, Deny, no answer, paired; the pill, the badges, the size note; Remove', async () => {
  test.setTimeout(120_000);
  const { app, win, home } = await launch();
  try {
    const id = (await win.locator('[data-term-row]').first().getAttribute('data-term-row'))!;
    await standIn(app, statusOf({}), pairingOf('AAAA-BBBB-CCCC'));
    await app.evaluate(({ ipcMain }) => {
      const g = globalThis as unknown as { resizes: { id: string; cols: number; rows: number }[] };
      g.resizes = [];
      ipcMain.on('term:resize', (_e, a: { id: string; cols: number; rows: number }) => { g.resizes.push(a); });
    });

    // A phone asks: who it is, what it may do, the time left; the safe answer has the keyboard.
    await command(app, 'pair-iphone');
    const sheet = win.locator('.pair-sheet');
    expect(await codeOnScreen(win)).toBe('AAAA-BBBB-CCCC');
    await pushPairing(app, { kind: 'request', request: { id: 'req-1', name: 'Test iPhone', model: 'iPhone17,1', expiresAt: Date.now() + 60_000 } });
    await expect(sheet.getByRole('heading', { name: 'Allow Test iPhone to use Atelier?' })).toBeVisible();
    await expect(sheet).toContainText('iPhone 16 Pro');
    await expect(sheet).toContainText('It will be able to see your sessions and type in them.');
    await expect(sheet.locator('.pair-left')).toContainText(/Answer within (1:00|0:5\d)/);
    await expect(sheet.getByRole('button', { name: 'Deny' })).toBeFocused();
    await look(win, `${SHOTS}/sheet-request.png`, { settle: 300 });

    // Deny: main is told; the spent code waits dimmed, then a fresh one comes with the reason.
    await sheet.getByRole('button', { name: 'Deny' }).click();
    await expect.poll(() => calls(app)).toContainEqual(['decide', 'req-1', false]);
    await pushPairing(app, { kind: 'denied', reason: 'declined' });
    await expect(sheet.locator('.pair-code.is-spent')).toHaveText('AAAA-BBBB-CCCC');
    await expect(sheet.locator('.pair-left')).toHaveText('New code coming…');
    await pushPairing(app, { kind: 'code', pairing: pairingOf('DDDD-EEEE-FFFF') });
    expect(await codeOnScreen(win, 'AAAA-BBBB-CCCC')).toBe('DDDD-EEEE-FFFF');
    await expect(sheet.locator('.pair-notice')).toContainText('Denied. That code is spent: here is a fresh one.');
    await look(win, `${SHOTS}/sheet-denied.png`, { settle: 300 });

    // No answer in time: a phone that only says "iPhone" is called by its model; then the fresh code says why.
    await pushPairing(app, { kind: 'request', request: { id: 'req-2', name: 'iPhone', model: 'iPhone15,4', expiresAt: Date.now() + 2_000 } });
    await expect(sheet.getByRole('heading', { name: 'Allow iPhone 15 to use Atelier?' })).toBeVisible();
    await expect(sheet.locator('.pair-ask-model')).toHaveCount(0);
    await expect(sheet.locator('.pair-left')).toContainText('Answer within 0:00', { timeout: 5000 });
    await pushPairing(app, { kind: 'denied', reason: 'expired' });
    await pushPairing(app, { kind: 'code', pairing: pairingOf('GGGG-HHHH-JJJJ') });
    expect(await codeOnScreen(win, 'DDDD-EEEE-FFFF')).toBe('GGGG-HHHH-JJJJ');
    await expect(sheet.locator('.pair-notice')).toContainText('No answer in time');

    // Allow: main is told, the buttons wait for the outcome; paired, the sheet closes with a toast, and pairing stops.
    await pushPairing(app, { kind: 'request', request: { id: 'req-3', name: 'Test iPhone', model: 'iPhone17,1', expiresAt: Date.now() + 60_000 } });
    await sheet.getByRole('button', { name: 'Allow' }).click();
    await expect.poll(() => calls(app)).toContainEqual(['decide', 'req-3', true]);
    await expect(sheet.getByRole('button', { name: 'Pairing…' })).toBeDisabled();
    await pushPairing(app, { kind: 'paired', device: device({ connected: false }) });
    await expect(sheet).toHaveCount(0);
    await expect(win.locator('.toast')).toContainText('iPhone paired');
    await expect.poll(() => calls(app)).toContainEqual(['stop']);

    // Connected, with this terminal open on the phone and sized by it: the pill, the badges, the note.
    await pushStatus(app, statusOf({ devices: [device({ attached: [id] }), device({ id: 'dev-2', name: 'iPhone', model: 'iPhone15,4', connected: false, lastSeenAt: Date.now() - 3 * 3_600_000 })], sized: [{ id, cols: 60, rows: 20 }] }));
    const pill = win.locator('.foot-iphone');
    await expect(pill).toHaveText('iPhone');
    await expect(pill).toHaveAttribute('data-tip', 'Connected now: Test iPhone');
    await expect(pill).toHaveAccessibleName('iPhone connected: Test iPhone');
    await expect(win.locator('.tab.is-active .phone-badge')).toHaveAttribute('data-tip', 'Open on iPhone');
    await expect(win.locator(`[data-term-row="${id}"] .phone-badge`)).toBeVisible();
    const note = win.locator('.terminal-slot:visible .size-note');
    await expect(note).toContainText('Sized for iPhone');
    await look(win, `${SHOTS}/marks.png`, { settle: 400 });
    await look(win.locator('.footer'), `${SHOTS}/footer-pill.png`, { settle: 100 });
    await look(win.locator('.tabs'), `${SHOTS}/tab-badge.png`, { settle: 100 });
    await look(win.locator(`[data-term-row="${id}"]`), `${SHOTS}/row-badge.png`, { settle: 100 });
    // The badges are a few pixels: a close-up of the tab and the row to look at.
    if (shotsOn()) {
      await win.evaluate(() => { document.documentElement.style.zoom = '2.5'; });
      await look(win, `${SHOTS}/badges-zoomed.png`, { settle: 300, clip: { x: 0, y: 0, width: 1400, height: 520 } });
      await win.evaluate(() => { document.documentElement.style.zoom = ''; });
    }

    // Fit to Window: this view's own size goes to the terminal; main then says no phone sizes it.
    await app.evaluate(() => { (globalThis as unknown as { resizes: unknown[] }).resizes = []; });
    await note.getByRole('button', { name: 'Fit to Window' }).click();
    await expect.poll(() => app.evaluate((_e, id) => (globalThis as unknown as { resizes: { id: string; cols: number }[] }).resizes.filter((r) => r.id === id).length, id)).toBeGreaterThan(0);
    await pushStatus(app, statusOf({ devices: [device({ attached: [id] })], sized: [] }));
    await expect(note).toHaveCount(0);

    // The pill opens Settings › iPhone: the phones, one connected (with what it has open), one last seen hours ago.
    await pushStatus(app, statusOf({ devices: [device({ attached: [id] }), device({ id: 'dev-2', name: 'iPhone', model: 'iPhone15,4', connected: false, lastSeenAt: Date.now() - 3 * 3_600_000 })] }));
    await pill.click();
    await expect(win.locator('.set-head h2')).toHaveText('iPhone');
    const connected = win.locator('.iph-device', { hasText: 'Test iPhone' });
    await expect(connected.locator('.iph-chip')).toHaveText('Connected');
    await expect(connected).toContainText('iPhone 16 Pro · 1 terminal open');
    const other = win.locator('.iph-device', { hasText: 'iPhone 15' });
    await expect(other.locator('.iph-seen')).toHaveText('Last seen 3 h ago');
    await look(win, `${SHOTS}/settings-paired.png`, { settle: 300 });

    // Remove asks in the row; Cancel gives the keyboard back to Remove, Remove tells main.
    await connected.getByRole('button', { name: 'Remove Test iPhone' }).click();
    const ask = connected.getByRole('group', { name: 'Remove Test iPhone?' });
    await expect(ask).toBeVisible();
    await look(win, `${SHOTS}/settings-remove.png`, { settle: 300 });
    await win.keyboard.press('Escape');
    await expect(ask).toHaveCount(0);
    await expect(win.locator('.settings')).toBeVisible();
    await expect(connected.getByRole('button', { name: 'Remove Test iPhone' })).toBeFocused();
    await connected.getByRole('button', { name: 'Remove Test iPhone' }).click();
    await connected.getByRole('button', { name: 'Remove', exact: true }).click();
    await expect.poll(() => calls(app)).toContainEqual(['remove', 'dev-1']);

    // Forget All asks too.
    await win.getByRole('button', { name: 'Forget All…' }).click();
    await expect(win.getByRole('group', { name: 'Forget all iPhones?' })).toBeVisible();
    await look(win, `${SHOTS}/settings-forget.png`, { settle: 300 });
    await win.keyboard.press('Escape');
    await expect(win.getByRole('button', { name: 'Forget All…' })).toBeFocused();

    // Access off: no pill, no badge, whatever the last list said.
    await pushStatus(app, statusOf({ enabled: false, relay: { state: 'offline' }, devices: [device({ attached: [id] })] }));
    await win.keyboard.press('Escape');
    await expect(win.locator('.settings')).toHaveCount(0);
    await expect(pill).toHaveCount(0);
    await expect(win.locator('.phone-badge')).toHaveCount(0);

    // The same marks in a light theme.
    await setTheme(win, 'daylight');
    await pushStatus(app, statusOf({ devices: [device({ attached: [id] })], sized: [{ id, cols: 60, rows: 20 }] }));
    await expect(pill).toBeVisible();
    await look(win, `${SHOTS}/marks-light.png`, { settle: 400 });
    await command(app, 'pair-iphone');
    await codeOnScreen(win);
    await pushPairing(app, { kind: 'request', request: { id: 'req-4', name: 'Test iPhone', model: 'iPhone17,1', expiresAt: Date.now() + 60_000 } });
    await expect(sheet.getByRole('heading', { name: 'Allow Test iPhone to use Atelier?' })).toBeVisible();
    await look(win, `${SHOTS}/sheet-request-light.png`, { settle: 300 });
  } finally {
    await app.close();
    stopDaemon(home);
  }
});

const BETA_NOTE = 'iPhone access is in beta: the Atelier iPhone app is available to selected users for now, and soon to everyone.';

test('iPhone access says it is a beta where pairing starts: Settings › iPhone and the pairing sheet, dark and light', async () => {
  test.setTimeout(120_000);
  const { app, win, home } = await launch();
  try {
    // Settings › iPhone: a Beta chip beside the section's title, the note above its rows. No other section has one.
    await openSection(app, win);
    await expect(win.locator('.set-head .beta-chip')).toHaveText('Beta');
    await expect(win.locator('.iph-beta')).toHaveText(BETA_NOTE);
    await look(win, `${SHOTS}/beta-settings.png`, { settle: 300 });
    await win.locator('.set-nav-item', { hasText: 'Notifications' }).click();
    await expect(win.locator('.set-head h2')).toHaveText('Notifications');
    await expect(win.locator('.set-head .beta-chip')).toHaveCount(0);

    // The pairing sheet with access off: the chip beside its title, the note at its foot.
    await openSection(app, win);
    await win.getByRole('button', { name: 'Pair iPhone…' }).click();
    const sheet = win.locator('.pair-sheet');
    await expect(sheet.getByRole('heading', { name: 'iPhone access is off' })).toBeVisible();
    await expect(sheet.locator('.pair-head .beta-chip')).toHaveText('Beta');
    await expect(sheet.locator('.pair-beta')).toHaveText(BETA_NOTE);
    await look(win, `${SHOTS}/beta-sheet-off.png`, { settle: 300 });
    await win.keyboard.press('Escape');
    await expect(sheet).toHaveCount(0);

    // With a code on screen (main's handlers stood in for), the note stays under it; once a phone asks, the question
    // has the sheet to itself.
    await standIn(app, statusOf({}), pairingOf('AAAA-BBBB-CCCC'));
    await win.getByRole('button', { name: 'Pair iPhone…' }).click();
    expect(await codeOnScreen(win)).toBe('AAAA-BBBB-CCCC');
    await expect(sheet.locator('.pair-beta')).toHaveText(BETA_NOTE);
    await look(win, `${SHOTS}/beta-sheet-code.png`, { settle: 400 });
    await pushPairing(app, { kind: 'request', request: { id: 'req-1', name: 'Test iPhone', model: 'iPhone17,1', expiresAt: Date.now() + 60_000 } });
    await expect(sheet.getByRole('heading', { name: 'Allow Test iPhone to use Atelier?' })).toBeVisible();
    await expect(sheet.locator('.pair-beta')).toHaveCount(0);
    await expect(sheet.locator('.pair-head .beta-chip')).toHaveText('Beta');
    await win.keyboard.press('Escape');
    await expect(sheet).toHaveCount(0);

    // The same in a light theme.
    await setTheme(win, 'daylight');
    await expect(win.locator('.iph-beta')).toHaveText(BETA_NOTE);
    await win.locator('.iph-beta').scrollIntoViewIfNeeded();
    await look(win, `${SHOTS}/beta-settings-light.png`, { settle: 400 });
    await win.getByRole('button', { name: 'Pair iPhone…' }).click();
    await codeOnScreen(win);
    await expect(sheet.locator('.pair-beta')).toHaveText(BETA_NOTE);
    await look(win, `${SHOTS}/beta-sheet-code-light.png`, { settle: 400 });
  } finally {
    await app.close();
    stopDaemon(home);
  }
});

const sessionsOf = (s: Msg) => s.sessions as { id: string; project: string; title: string; claude: boolean }[];
const projectsOf = (s: Msg) => s.projects as { id: string; name: string; open: boolean }[];

// The whole way with a phone: the real handshakes, the real hub, the real terminal.
test('a phone pairs by code, Allow, types in a terminal; access off and Remove drop it', async () => {
  test.setTimeout(180_000);
  const relay = await startTestRelay();
  const { app, win, home, root } = await launch({ ATELIER_TEST_RELAY_URL: relay.url });
  const phone = new FakePhone({ relay: relay.url });
  try {
    await openSection(app, win);
    const access = win.getByRole('switch', { name: 'Allow access from iPhone' });
    await access.click();
    await expect(win.locator('.iph-status')).toContainText('Connected to the relay', { timeout: 15000 });
    await win.getByRole('button', { name: 'Pair iPhone…' }).click();
    const sheet = win.locator('.pair-sheet');
    const paired = phone.pairByCode(await codeOnScreen(win));
    await expect(sheet.getByRole('heading', { name: 'Allow Test iPhone to use Atelier?' })).toBeVisible({ timeout: 20000 });
    await expect(sheet).toContainText('iPhone 16 Pro');
    await look(win, `${SHOTS}/real-request.png`, { settle: 300 });
    await sheet.getByRole('button', { name: 'Allow' }).click();
    expect((await paired).t).toBe('welcome');
    await expect(sheet).toHaveCount(0);
    await expect(win.locator('.toast')).toContainText('iPhone paired');
    const row = win.locator('.iph-device', { hasText: 'Test iPhone' });
    await expect(row.locator('.iph-chip')).toHaveText('Connected');
    await expect(access).toHaveAttribute('aria-checked', 'true');
    await look(win, `${SHOTS}/real-settings-paired.png`, { settle: 300 });
    await win.keyboard.press('Escape');
    await expect(win.locator('.foot-iphone')).toHaveText('iPhone');
    await expect(win.locator('.foot-iphone')).toHaveAttribute('data-tip', 'Connected now: Test iPhone');

    // The phone sees the project and its terminal (by opaque ids, never a path), opens it and types.
    const id = (await win.locator('[data-term-row]').first().getAttribute('data-term-row'))!;
    const state = await phone.state((s) => sessionsOf(s).some((x) => x.id === id), 10000);
    const project = projectsOf(state).find((p) => p.name === basename(root));
    expect(project).toMatchObject({ open: true });
    expect(sessionsOf(state).find((x) => x.id === id)).toMatchObject({ project: project!.id, claude: false });
    expect(JSON.stringify(state)).not.toContain(root);
    expect(await phone.attach(id, 60, 20)).toMatchObject({ t: 'snapshot', id, cols: 60, rows: 20 });
    phone.input(id, 'echo phone-was-here\r');
    await phone.sees(id, 'phone-was-here', 10000);
    const rows = win.locator('.terminal-slot:visible .xterm-rows');
    // The command, then its output on a line of its own (the rows' text line by line).
    const echoed = /echo phone-was-here\s*\n\s*phone-was-here/;
    await expect(rows).toContainText(echoed, { useInnerText: true, timeout: 10000 });
    await expect(win.locator('.tab.is-active .phone-badge')).toBeVisible();
    await expect(win.locator(`[data-term-row="${id}"] .phone-badge`)).toBeVisible();
    const note = win.locator('.terminal-slot:visible .size-note');
    await expect(note).toContainText('Sized for iPhone');
    await expect(row).toHaveCount(0);
    // Drawn here at the phone's size, the terminal's one size: what the shell redraws for it lands where it does on the
    // phone. The phone's keyboard coming changes its rows: the shell redraws its prompt, and the output above stays
    // (drawn at this window's own width, the redraw went one line too high and wiped it).
    await expect(rows.locator(':scope > div')).toHaveCount(20);
    await expect(win.locator('.footer')).toContainText('60×20');
    const redraw = phone.messages.length;
    phone.resize(id, 60, 12);
    await expect(rows.locator(':scope > div')).toHaveCount(12);
    await phone.waitFor((m) => m.t === 'out' && m.id === id, { since: redraw, ms: 10000 });
    // What the phone types next comes after the redraw: once its output is here, the redraw is too.
    phone.input(id, 'echo after-redraw\r');
    await expect(rows).toContainText(/\n\s*after-redraw\s*(\n|$)/, { useInnerText: true, timeout: 10000 });
    await expect(rows).toContainText(/\n\s*phone-was-here\s*\n/, { useInnerText: true });
    await look(win, `${SHOTS}/real-phone-typed.png`, { settle: 400 });
    const since = phone.messages.length;
    await note.getByRole('button', { name: 'Fit to Window' }).click();
    await expect(note).toHaveCount(0);
    expect((await phone.waitFor((m) => m.t === 'size' && m.id === id, { since, ms: 10000 })).cols).toBeGreaterThan(60);
    // This window's own size again.
    await expect(rows.locator(':scope > div')).not.toHaveCount(12);
    await expect(win.locator('.footer')).not.toContainText('60×12');

    // Access off: the phone is told and dropped; nothing shows it any more.
    await openSection(app, win);
    await access.click();
    expect((await phone.waitFor((m) => m.t === 'bye', { ms: 10000 })).reason).toBe('disabled');
    await win.keyboard.press('Escape');
    await expect(win.locator('.foot-iphone')).toHaveCount(0);
    await expect(win.locator('.phone-badge')).toHaveCount(0);

    // On again, the phone connects as itself; Remove unpairs it and drops it at once.
    await openSection(app, win);
    await access.click();
    await expect(win.locator('.iph-status')).toContainText('Connected to the relay', { timeout: 15000 });
    expect((await phone.connect()).t).toBe('welcome');
    await expect(row.locator('.iph-chip')).toHaveText('Connected', { timeout: 10000 });
    await row.getByRole('button', { name: 'Remove Test iPhone' }).click();
    await row.getByRole('button', { name: 'Remove', exact: true }).click();
    expect((await phone.waitFor((m) => m.t === 'bye', { ms: 10000 })).reason).toBe('revoked');
    await expect(win.locator('.iph-empty')).toBeVisible();
    await win.keyboard.press('Escape');
    await expect(win.locator('.foot-iphone')).toHaveCount(0);
  } finally {
    phone.drop();
    await app.close();
    stopDaemon(home);
    await relay.close();
  }
});

// ── A terminal a phone sized, in the window ──

/** The phone opens the window's terminal at its own size; the terminal's id. */
async function phoneOpens(win: Page, phone: FakePhone, cols: number, rows: number): Promise<string> {
  const id = (await win.locator('[data-term-row]').first().getAttribute('data-term-row'))!;
  await phone.state((s) => sessionsOf(s).some((x) => x.id === id), 10000);
  expect(await phone.attach(id, cols, rows)).toMatchObject({ t: 'snapshot', id, cols, rows });
  return id;
}

// The window's terminal answers a program's queries (device attributes, cursor position, mode reports) through the
// path keys take: an answer is no keystroke, so the phone keeps the size, and the window keeps drawing it at the
// phone's. Any key pressed in the window takes it back.
test('a phone keeps a terminal\'s size through the window\'s answers to its program; any key pressed in the window takes it back', async () => {
  test.setTimeout(180_000);
  const relay = await startTestRelay();
  const { app, win, home } = await launch({ ATELIER_TEST_RELAY_URL: relay.url });
  const phone = new FakePhone({ relay: relay.url });
  try {
    await pairPhone(app, win, phone);
    const id = await phoneOpens(win, phone, 50, 20);
    const rows = win.locator('.terminal-slot:visible .xterm-rows');
    const note = win.locator('.terminal-slot:visible .size-note');
    await expect(note).toContainText('Sized for iPhone');
    await expect(rows.locator(':scope > div')).toHaveCount(20);
    await expect(win.locator('.footer')).toContainText('50×20');

    // From the phone, a program asks the terminal three questions and reads each answer. Only the window answers (the
    // fake phone has no terminal), and each answer reaches main before the program prints: once it has, a size taken
    // back would have reached the phone already, in order.
    const since = phone.messages.length;
    phone.input(id, "printf '\\033[c'; read -s -t 5 -d c a; printf '\\033[6n'; read -s -t 5 -d R b; printf '\\033[?2004$p'; read -s -t 5 -d y c; echo \"ans\"\"wered ${#a} ${#b} ${#c}\"\r");
    await expect.poll(() => phone.screen(id), { timeout: 15000 }).toMatch(/answered [1-9]\d* [1-9]\d* [1-9]\d*/);
    expect(phone.messages.slice(since).filter((m) => m.t === 'size')).toEqual([]);
    await expect(note).toContainText('Sized for iPhone');
    await expect(rows.locator(':scope > div')).toHaveCount(20);
    await expect(win.locator('.footer')).toContainText('50×20');
    await look(win, `${SHOTS}/answers-kept-size.png`, { settle: 300 });

    // A key typed in the window takes the size back: the phone is told, the note goes, the window's own size again.
    const typed = phone.messages.length;
    await win.locator('.terminal-slot:visible .xterm-helper-textarea').focus();
    await win.keyboard.type('echo mac-typed');
    expect((await phone.waitFor((m) => m.t === 'size' && m.id === id, { since: typed, ms: 10000 })).cols).toBeGreaterThan(50);
    await expect(note).toHaveCount(0);
    await expect(rows.locator(':scope > div')).not.toHaveCount(20);
    // Every key pressed in the window takes it back, the ones that type nothing too: an arrow, Tab (no file to complete
    // in the empty project). The phone's view resized takes the size again before each.
    for (const key of ['ArrowLeft', 'Tab']) {
      phone.resize(id, 50, 20);
      await expect(note).toContainText('Sized for iPhone');
      await expect(rows.locator(':scope > div')).toHaveCount(20);
      const pressed = phone.messages.length;
      await win.keyboard.press(key);
      expect((await phone.waitFor((m) => m.t === 'size' && m.id === id, { since: pressed, ms: 10000 })).cols, key).toBeGreaterThan(50);
      await expect(note).toHaveCount(0);
      await expect(rows.locator(':scope > div')).not.toHaveCount(20);
    }
    await look(win, `${SHOTS}/keys-took-size.png`, { settle: 300 });
    await win.keyboard.press('Enter');
    await expect(rows).toContainText(/\n\s*mac-typed\s*(\n|$)/, { useInnerText: true, timeout: 10000 });
  } finally {
    phone.drop();
    await app.close();
    stopDaemon(home);
    await relay.close();
  }
});

/**
 * Where the note and the terminal's drawn screen (its rows at the phone's size) are, in the window's pixels, once the
 * last change of size is laid out (two frames).
 */
async function noteAndScreen(win: Page) {
  await win.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  const note = await win.locator('.terminal-slot:visible .size-note').boundingBox();
  const screen = await win.locator('.terminal-slot:visible .xterm-screen').boundingBox();
  const slot = await win.locator('.terminal-slot:visible').boundingBox();
  if (!note || !screen || !slot) throw new Error('nothing to measure');
  const overlap = note.x < screen.x + screen.width && screen.x < note.x + note.width && note.y < screen.y + screen.height && screen.y < note.y + note.height;
  return { note, screen, slot, overlap };
}

// The note on a terminal a phone sized sits where it covers none of the terminal's text: the pane's free corner
// beside the phone's narrower screen, or just under its rows in a pane barely wider than the phone. Only when the
// phone's size fills the pane both ways is there no such room: then the corner all the same, Fit to Window in reach.
test('the size note never covers the terminal\'s text, in a wide pane or a narrow one', async () => {
  test.setTimeout(180_000);
  const relay = await startTestRelay();
  const { app, win, home } = await launch({ ATELIER_TEST_RELAY_URL: relay.url });
  const phone = new FakePhone({ relay: relay.url });
  try {
    await pairPhone(app, win, phone);
    const id = await phoneOpens(win, phone, 50, 20);
    const rows = win.locator('.terminal-slot:visible .xterm-rows');
    const note = win.locator('.terminal-slot:visible .size-note');
    await expect(note).toContainText('Sized for iPhone');
    // Lines as long as the phone's width, on every row the phone shows.
    phone.input(id, "clear; for i in {1..40}; do printf '%050d\\n' $i; done\r");
    await expect(rows).toContainText('00000000000000000000000000000000000000000000000040');
    const wide = await noteAndScreen(win);
    await look(win, `${SHOTS}/note-wide.png`, { settle: 400 });
    expect(wide.overlap, JSON.stringify(wide)).toBe(false);
    // In the corner, beside the drawn screen.
    expect(wide.note.x).toBeGreaterThan(wide.screen.x + wide.screen.width);
    expect(wide.note.y).toBeLessThan(wide.screen.y + 20);

    // A window resized takes the size back; the phone takes it again, in a pane six columns wider than the phone.
    const cell = { width: wide.screen.width / 50, height: wide.screen.height / 20 };
    const content = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.getContentSize());
    const narrow = Math.round(content[0]! - (wide.slot.width - (wide.screen.width + 32 + 6 * cell.width)));
    await app.evaluate(({ BrowserWindow }, w) => BrowserWindow.getAllWindows()[0]!.setContentSize(w, 800), narrow);
    await expect(note).toHaveCount(0);
    phone.resize(id, 50, 20);
    await expect(note).toContainText('Sized for iPhone');
    await expect(rows.locator(':scope > div')).toHaveCount(20);
    const keyboard = await noteAndScreen(win);
    await look(win, `${SHOTS}/note-narrow.png`, { settle: 400 });
    expect(keyboard.overlap, JSON.stringify(keyboard)).toBe(false);
    expect(keyboard.note.y).toBeGreaterThan(keyboard.screen.y + keyboard.screen.height);

    // The phone's keyboard gone: taller, a few rows short of the pane; the note follows the rows down.
    const fits = Math.floor((keyboard.slot.height - 26) / cell.height);
    phone.resize(id, 50, fits - 3);
    await expect(rows.locator(':scope > div')).toHaveCount(fits - 3);
    const taller = await noteAndScreen(win);
    await look(win, `${SHOTS}/note-narrow-taller.png`, { settle: 400 });
    expect(taller.overlap, JSON.stringify(taller)).toBe(false);
    expect(taller.note.y).toBeGreaterThan(taller.screen.y + taller.screen.height);

    // The phone's size fills the pane: no room left, the corner, and Fit to Window gives the window its size back.
    phone.resize(id, 50, fits);
    await expect(rows.locator(':scope > div')).toHaveCount(fits);
    const full = await noteAndScreen(win);
    expect(full.note.y).toBeLessThan(full.screen.y + 20);
    await look(win, `${SHOTS}/note-narrow-full.png`, { settle: 400 });
    const since = phone.messages.length;
    await note.getByRole('button', { name: 'Fit to Window' }).click();
    await expect(note).toHaveCount(0);
    expect((await phone.waitFor((m) => m.t === 'size' && m.id === id, { since, ms: 10000 })).cols).toBeGreaterThan(50);
  } finally {
    phone.drop();
    await app.close();
    stopDaemon(home);
    await relay.close();
  }
});
