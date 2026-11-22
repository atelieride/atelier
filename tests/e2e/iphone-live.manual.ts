// iPhone access, live: this Atelier, a real relay and the real iOS app, each in its own process. Not part of the
// suite: the iOS app's live check starts the relay, runs this spec, then the app's own UI test on a simulator.
//   ATELIER_LIVE_DIR    the folder both sides share: handoff.json (the code, the QR link, the terminal) goes there for
//                       the phone, and the screenshots (with ATELIER_E2E_SHOTS=1); the phone writes phone-confirming
//                       there while it waits for Allow, and phone-done (passed or failed) says the phone side ended;
//                       this side writes mac-typed once it has seen the phone's output and the marks
//   ATELIER_LIVE_RELAY  the relay's base URL (http://127.0.0.1:8787 by default), typed in Settings › iPhone
//   ATELIER_LIVE_TEXT   what the phone echoes (from-iphone-live by default)
// The Atelier is the e2e one (tests/e2e/env.ts): hidden, its own temporary home and atelierd, a fresh project with
// one plain terminal.
import { _electron as electron, expect, test, type Page } from '@playwright/test';
import { existsSync, mkdtempSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { homeHash } from '../../src/daemon/launchd';
import { e2eEnv } from './env';
import { look } from './shots';

const LIVE = process.env.ATELIER_LIVE_DIR ?? '';
const RELAY = process.env.ATELIER_LIVE_RELAY || 'http://127.0.0.1:8787';
const TEXT = process.env.ATELIER_LIVE_TEXT || 'from-iphone-live';
const DONE = join(LIVE, 'phone-done');

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

const codeOf = (win: Page) => win.locator('.pair-sheet .pair-code:not(.is-spent)');

test.skip(!LIVE, 'ATELIER_LIVE_DIR names the folder shared with the phone side');

test('live: the iOS app pairs through the relay, Allow, and types in a terminal', async () => {
  test.setTimeout(30 * 60_000);
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'atl-live-')));
  const { env, home } = e2eEnv();
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

    // Settings › iPhone: the relay, then access on.
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.webContents.send('ev:command', 'open-settings'));
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
    const handoff = { project: basename(root), terminal, host: hostname().replace(/\.local$/i, ''), relay: RELAY, text: TEXT };
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

    // The phone opens the terminal and types: its output on this side too, on a line of its own (the rows' text line by
    // line; drawn at the phone's width, the command itself may wrap anywhere), with the marks. Once the phone side has
    // passed, the output is in the terminal already: a minute more, then this side fails saying what it shows.
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
    await expect(win.locator(`[data-term-row="${terminal}"] .phone-badge`)).toBeVisible();
    await look(win, join(LIVE, 'mac-4-typed.png'), { settle: 400 });
    // The phone stays in the terminal until this side has its screenshot: leaving earlier would take the marks away.
    writeFileSync(join(LIVE, 'mac-typed'), '');

    // Atelier stays up until the phone side has checked its own screen.
    await expect.poll(phoneOutcome, { timeout: 15 * 60_000, intervals: [1000] }).not.toBe('');
    expect(phoneOutcome()).toBe('passed');
  } catch (e) {
    await (await app.firstWindow()).screenshot({ path: join(LIVE, 'mac-failure.png') }).catch(() => {});
    throw e;
  } finally {
    await app.close().catch(() => {});
    try { process.kill((JSON.parse(readFileSync(join(home, 'atelierd.json'), 'utf8')) as { pid: number }).pid, 'SIGTERM'); } catch { /* already stopped */ }
  }
});
