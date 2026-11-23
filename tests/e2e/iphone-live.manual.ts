// iPhone access, live: this Atelier, a real relay and the real iOS app, each in its own process. Not part of the
// suite: whoever runs it starts the relay, then this spec and the iOS app's own UI test on a simulator side by side;
// the two sides take turns through the folder below.
//   ATELIER_LIVE_DIR    the folder both sides share: handoff.json (the code, the QR link, the rows and places the phone
//                       acts on) goes there for the phone, and the screenshots (with ATELIER_E2E_SHOTS=1). The two
//                       sides take turns through empty files there: the phone writes phone-<step> once it has done a
//                       step (phone-created holds the id of the terminal it started), this side writes mac-<step> once
//                       it has seen the step's effect, or mac-failed; phone-done (passed or failed) says the phone side
//                       ended. push.json says what the push check saw.
//   ATELIER_LIVE_RELAY  the relay's base URL (http://127.0.0.1:8787 by default), typed in Settings › iPhone
//   ATELIER_LIVE_TEXT   what the phone echoes (from-iphone-live by default)
// The Atelier is the e2e one (tests/e2e/env.ts): hidden, its own temporary home and atelierd, the stand-in for Claude
// Code with a real-looking permission dialog, and "away from this Mac" forced so a session that starts waiting rings
// the phone. A fresh project with workspaces and activities on: in Workspace 1 a plain terminal and a Claude session
// waiting for a permission; an activity, Release, empty and not in front.
//   1. pairing: Settings › iPhone, the relay, access on, Pair iPhone…, Allow once the phone asks;
//   2. the phone sees the workspace, the activity and the waiting row (phone-sidebar → mac-sidebar);
//   3. it allows the permission from the row: the session's own dialog says it was allowed (phone-allowed → mac-allowed);
//   4. it renames that session: the row says so (phone-renamed → mac-renamed);
//   5. it starts a terminal in Release: the row lands in that activity (phone-created → mac-created);
//   6. it types in the plain terminal: the output and the phone's marks here (mac-typed);
//   7. once the phone side has passed (the app quit, as a phone in a pocket): a session that starts waiting sends a
//      push for the phone's registration, the local relay (no APNs credentials) answers 503 NotConfigured, and the
//      registration is kept: a second session's push goes out too.
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { existsSync, mkdtempSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { homeHash } from '../../src/daemon/launchd';
import { e2eEnv } from './env';
import { look } from './shots';
import { command, menu, settingsSet, stopDaemon } from './iphone-fixture';

const LIVE = process.env.ATELIER_LIVE_DIR ?? '';
const RELAY = process.env.ATELIER_LIVE_RELAY || 'http://127.0.0.1:8787';
const TEXT = process.env.ATELIER_LIVE_TEXT || 'from-iphone-live';
const DONE = join(LIVE, 'phone-done');
const WORKSPACE = 'Workspace 1';
const ACTIVITY = 'Release';
const RENAMED = 'Ship 2.0';

/** Written whole or not at all: the phone side may read it at any moment. */
function handOff(name: string, value: unknown): void {
  const path = join(LIVE, name);
  writeFileSync(`${path}.tmp`, JSON.stringify(value, null, 2));
  renameSync(`${path}.tmp`, path);
}

/** The phone side's outcome once it has ended ('passed' or 'failed'), else ''. */
const phoneOutcome = (): string => (existsSync(DONE) ? readFileSync(DONE, 'utf8').trim() || 'ended' : '');

/**
 * `step`, unless the phone side fails first (that would otherwise cost the whole timeout here). A phone side that
 * passed did its part: this side's own check still decides.
 */
async function unlessPhoneFails<T>(what: string, step: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setInterval> | undefined;
  const ended = new Promise<never>((_, reject) => {
    timer = setInterval(() => {
      const outcome = phoneOutcome();
      if (outcome && outcome !== 'passed') reject(new Error(`the phone side ended (${outcome}) before ${what}`));
    }, 500);
  });
  try { return await Promise.race([step, ended]); } finally { clearInterval(timer); }
}

/** The phone has done `step` (phone-<step>): what it wrote there. */
async function phoneDid(step: string, timeout = 10 * 60_000): Promise<string> {
  const path = join(LIVE, `phone-${step}`);
  await unlessPhoneFails(`phone-${step}`, expect.poll(() => existsSync(path), { timeout, intervals: [250] }).toBe(true));
  return readFileSync(path, 'utf8').trim();
}

/** This side has seen the step's effect: the phone goes on. */
const macSaw = (step: string) => writeFileSync(join(LIVE, `mac-${step}`), '');

const codeOf = (win: Page) => win.locator('.pair-sheet .pair-code:not(.is-spent)');
const rowIds = (win: Page) => win.locator('[data-term-row]').evaluateAll((rows) => rows.map((r) => r.getAttribute('data-term-row')!));

/** A new Claude session in the place in front, from the menu's New Claude Session: its id, once it asks for a permission. */
async function newWaitingSession(app: ElectronApplication, win: Page): Promise<string> {
  const before = new Set(await rowIds(win));
  await command(app, 'new-session');
  // Its name sheet: no name, the automatic one.
  const name = win.getByPlaceholder('Session name (optional)');
  await expect(name).toBeFocused();
  await name.press('Enter');
  let id = '';
  await expect.poll(async () => { id = (await rowIds(win)).find((x) => !before.has(x)) ?? ''; return id; }, { timeout: 30_000 }).not.toBe('');
  await expect(win.locator(`[data-term-row="${id}"]`)).toContainText('Needs permission', { timeout: 30_000 });
  return id;
}

test.skip(!LIVE, 'ATELIER_LIVE_DIR names the folder shared with the phone side');

test('live: the iOS app pairs through the relay, mirrors the sidebar, acts on its rows, types in a terminal and rings while away', async () => {
  test.setTimeout(40 * 60_000);
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'atl-live-')));
  const { env, home } = e2eEnv({
    ATELIER_CLAUDE_BIN: resolve('tests/e2e/fake-claude.pl'),
    ATELIER_FAKE_PERMISSION_KEYS: '1',
    ATELIER_TEST_REMOTE_AWAY: '1'
  });
  // So whoever runs this can stop this Atelier's atelierd and its launchd jobs if this process is killed.
  handOff('atelier.json', { home, jobs: homeHash(home) });
  const app = await electron.launch({ args: ['out/main/index.js', `--project=${root}`], env });
  let paired = false;
  try {
    const win = await app.firstWindow();
    await win.getByRole('button', { name: 'Open a terminal' }).click();
    const rows = win.locator('.terminal-slot:visible .xterm-rows');
    await expect(rows).toContainText('›', { timeout: 30_000 });
    const terminal = (await win.locator('[data-term-row]').first().getAttribute('data-term-row'))!;
    const termRow = win.locator(`[data-term-row="${terminal}"]`);

    // Workspaces, then a Claude session in Workspace 1 that asks for a permission.
    await menu(app, 'Toggle Workspaces for This Project');
    await expect(win.locator('.ws-group.is-active')).toContainText(WORKSPACE);
    const claude = await newWaitingSession(app, win);
    const claudeRow = win.locator(`[data-term-row="${claude}"]`);
    await expect(rows).toContainText('Do you want to proceed?', { timeout: 15_000 });
    // Activities, and Release made from the workspace's "+"; then Workspace 1 back in front, so a terminal the phone
    // starts in Release lands there because it asked for it.
    await settingsSet(win, { wsActivities: true });
    const ws = win.locator('.ws-group', { has: win.locator('.ws-name', { hasText: new RegExp(`^${WORKSPACE}$`) }) });
    await ws.locator('.ws-head').hover();
    await ws.locator('.ws-plus').click();
    await win.getByRole('menuitem', { name: 'New Activity…' }).click();
    const input = win.locator('.wsa-head .rename-input');
    await expect(input).toBeFocused();
    await input.fill(ACTIVITY);
    await input.press('Enter');
    const activity = win.locator('.wsa-group', { has: win.locator('.wsa-name', { hasText: new RegExp(`^${ACTIVITY}$`) }) });
    await expect(activity).toHaveClass(/is-current/);
    await ws.locator('.ws-name-btn').click();
    await expect(activity).not.toHaveClass(/is-current/);
    await termRow.click();
    await expect(rows).toContainText('›');

    // Settings › iPhone: the relay, then access on.
    await command(app, 'open-settings');
    await win.locator('.set-nav-item', { hasText: 'iPhone' }).click();
    const field = win.getByRole('textbox', { name: 'Relay server' });
    await field.fill(RELAY);
    await field.press('Enter');
    await expect(win.getByRole('button', { name: 'Use Default' })).toBeVisible();
    await win.getByRole('switch', { name: 'Allow access from iPhone' }).click();
    await expect(win.locator('.iph-status')).toContainText('Connected to the relay', { timeout: 30_000 });

    // Pair iPhone…: the code and the QR link go to the phone side, again whenever the code renews.
    await win.getByRole('button', { name: 'Pair iPhone…' }).click();
    const sheet = win.locator('.pair-sheet');
    await expect(codeOf(win)).toHaveText(/^[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/, { timeout: 30_000 });
    const handoff = {
      project: basename(root), terminal, claude, workspace: WORKSPACE, activity: ACTIVITY, rename: RENAMED,
      host: hostname().replace(/\.local$/i, ''), relay: RELAY, text: TEXT
    };
    let shared = '';
    const share = async (): Promise<void> => {
      const code = (await codeOf(win).innerText({ timeout: 2000 }).catch(() => '')).trim();
      const link = await sheet.locator('.pair-qr').getAttribute('data-qr', { timeout: 2000 }).catch(() => null);
      if (!/^[0-9A-Z-]{14}$/.test(code) || !link || code === shared) return;
      shared = code;
      handOff('handoff.json', { ...handoff, code, link });
    };
    await share();
    expect(shared).not.toBe('');
    await look(win, join(LIVE, 'mac-1-code.png'), { settle: 300 });
    const refresher = setInterval(() => { if (!paired) void share(); }, 2000);

    // The phone asks; Allow.
    const ask = sheet.getByRole('heading', { name: /^Allow .+ to use Atelier\?$/ });
    try {
      await unlessPhoneFails('asking to pair', expect(ask).toBeVisible({ timeout: 15 * 60_000 }));
    } finally {
      clearInterval(refresher);
    }
    await look(win, join(LIVE, 'mac-2-request.png'), { settle: 300 });
    // Allow once the phone shows its side of the question (phone-confirming), well within the minute Allow waits.
    await expect.poll(() => existsSync(join(LIVE, 'phone-confirming')), { timeout: 30_000, intervals: [250] }).toBe(true);
    await sheet.getByRole('button', { name: 'Allow' }).click();
    paired = true;
    await expect(sheet).toHaveCount(0, { timeout: 30_000 });
    await expect(win.locator('.toast')).toContainText('iPhone paired');
    await expect(win.locator('.iph-device .iph-chip')).toHaveText('Connected', { timeout: 30_000 });
    await look(win, join(LIVE, 'mac-3-paired.png'), { settle: 300 });
    await win.keyboard.press('Escape');
    await expect(win.locator('.settings')).toHaveCount(0);

    // The phone shows the workspace, the activity and the waiting row.
    await phoneDid('sidebar');
    await look(win, join(LIVE, 'mac-4-sidebar.png'), { settle: 300 });
    macSaw('sidebar');

    // Allowed from the phone's row: the dialog's own "Yes" was chosen, and the session went on.
    await phoneDid('allowed');
    await claudeRow.click();
    await expect(rows).toContainText('FAKE-CLAUDE allowed', { timeout: 30_000 });
    await expect(rows).not.toContainText('FAKE-CLAUDE denied');
    await expect(claudeRow).not.toContainText('Needs permission');
    await look(win, join(LIVE, 'mac-5-allowed.png'), { settle: 300 });
    macSaw('allowed');

    // Renamed from the phone.
    await phoneDid('renamed');
    await expect(claudeRow.locator('.session-title')).toHaveText(RENAMED, { timeout: 30_000 });
    await look(win, join(LIVE, 'mac-6-renamed.png'), { settle: 300 });
    macSaw('renamed');

    // A terminal started from the phone in Release: its row is in that activity.
    const created = await phoneDid('created');
    expect(created).toMatch(/\S/);
    const chev = activity.locator('.wsa-chev');
    if ((await chev.getAttribute('aria-expanded')) === 'false') await chev.click();
    await expect(activity.locator(`[data-term-row="${created}"]`)).toBeVisible({ timeout: 30_000 });
    await look(win, join(LIVE, 'mac-7-activity.png'), { settle: 300 });
    // The plain terminal in front again before the phone opens it (showing it here later could take its size back).
    await termRow.click();
    await expect(rows).toContainText('›');
    macSaw('created');

    // The phone opens the plain terminal and types: its output on this side too, on a line of its own (the rows' text
    // line by line; drawn at the phone's width, the command itself may wrap anywhere), with the marks. Once the phone
    // side has passed, the output is in the terminal already: a minute more, then this side fails saying what it shows.
    const echoed = new RegExp(`\\n\\s*${TEXT}\\s*\\n`);
    const typingBy = Date.now() + 10 * 60_000;
    let phonePassedAt = 0;
    for (let shown = await rows.innerText(); !echoed.test(shown); shown = await rows.innerText()) {
      const outcome = phoneOutcome();
      if (outcome && outcome !== 'passed') throw new Error(`the phone side ended (${outcome}) before typing`);
      if (outcome === 'passed') phonePassedAt ||= Date.now();
      if (Date.now() > typingBy || (phonePassedAt && Date.now() - phonePassedAt > 60_000)) {
        throw new Error(`the terminal never showed the output of "echo ${TEXT}"; it shows:\n${shown}`);
      }
      await win.waitForTimeout(250);
    }
    await expect(win.locator('.foot-iphone')).toBeVisible();
    await expect(win.locator('.tab.is-active .phone-badge')).toBeVisible();
    await expect(termRow.locator('.phone-badge')).toBeVisible();
    await look(win, join(LIVE, 'mac-8-typed.png'), { settle: 400 });
    // The phone stays in the terminal until this side has its screenshot: leaving earlier would take the marks away.
    macSaw('typed');

    // Atelier stays up until the phone side has checked its own screen.
    await expect.poll(phoneOutcome, { timeout: 15 * 60_000, intervals: [1000] }).not.toBe('');
    expect(phoneOutcome()).toBe('passed');

    // Push, with the app closed and the user away (forced): the phone registered when its notifications were turned
    // on (its push key and token kept in the secret store, written only by a registration); the relay answers each
    // push in app.log's words, and only for a push this Atelier sent.
    const registration = join(home, 'connectors', 'remote-push.bin');
    await expect.poll(() => existsSync(registration), { timeout: 30_000, message: 'the phone never registered for notifications' }).toBe(true);
    const appLog = join(home, 'logs', 'app.log');
    // When the relay answered 503 NotConfigured, by app.log's own time stamps (this Mac's clock, as Date.now()).
    const answers = (): number[] => {
      try {
        return [...readFileSync(appLog, 'utf8').matchAll(/^(\S+) \[main:remote\] push: the relay answered 503 NotConfigured$/gm)].map((m) => Date.parse(m[1]!));
      } catch { return []; }
    };
    const answeredSince = (t: number) => answers().filter((at) => at >= t).length;
    const firstAt = Date.now();
    const first = await newWaitingSession(app, win);
    await expect.poll(() => answeredSince(firstAt), { timeout: 30_000, message: 'no push answered 503 NotConfigured' }).toBe(1);
    // 503 isn't a dead token: the registration stays, and the next session that waits rings the phone again.
    expect(existsSync(registration)).toBe(true);
    const secondAt = Date.now();
    const second = await newWaitingSession(app, win);
    await expect.poll(() => answeredSince(secondAt), { timeout: 30_000, message: 'the registration was dropped after a 503' }).toBe(1);
    // One push for each session, no more.
    expect(answeredSince(firstAt)).toBe(2);
    expect(existsSync(registration)).toBe(true);
    await look(win, join(LIVE, 'mac-9-push.png'), { settle: 300 });
    handOff('push.json', {
      registered: true, answered: '503 NotConfigured', pushes: answeredSince(firstAt), keptAfter503: true,
      sessions: [{ id: first, startedAt: new Date(firstAt).toISOString() }, { id: second, startedAt: new Date(secondAt).toISOString() }],
      log: readFileSync(appLog, 'utf8').split('\n').filter((l) => l.includes('[main:remote] push:'))
    });
  } catch (e) {
    writeFileSync(join(LIVE, 'mac-failed'), String(e).slice(0, 2000));
    await (await app.firstWindow()).screenshot({ path: join(LIVE, 'mac-failure.png') }).catch(() => {});
    throw e;
  } finally {
    await app.close().catch(() => {});
    stopDaemon(home);
  }
});
