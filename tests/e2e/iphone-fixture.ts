// What the iPhone access specs share: a project window with a terminal at its prompt, a test relay
// (tests/support/test-relay.ts) and a fake phone (tests/support/fake-phone.ts) for it, Settings › iPhone, a phone paired
// by code with Allow, the code on the pairing sheet, the window's commands and menu items, a Claude session started
// from the window, and the check that a Claude session's terminal kept the window's size.
import { _electron as electron, expect, type ElectronApplication, type Page } from '@playwright/test';
import { mkdtempSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { e2eEnv } from './env';
import { startTestRelay, type TestRelay } from '../support/test-relay';
import { FakePhone } from '../support/fake-phone';
import type { RemoteStatus } from '../../src/shared/remote';

/** A command as the menu sends it, to the first window (or `win`, a window's index). */
export const command = (app: ElectronApplication, c: string, win = 0) =>
  app.evaluate(({ BrowserWindow }, o) => BrowserWindow.getAllWindows()[o.win]!.webContents.send('ev:command', o.c), { c, win });

/** The test's own atelierd, stopped once its app has quit (its terminals go with it). */
export const stopDaemon = (home: string) => { try { process.kill((JSON.parse(readFileSync(join(home, 'atelierd.json'), 'utf8')) as { pid: number }).pid, 'SIGTERM'); } catch { /* already stopped */ } };

/** App menu items are clicked (synthetic key events do not go through NSMenu). */
export async function menu(app: ElectronApplication, label: string): Promise<void> {
  await app.evaluate(({ Menu, BrowserWindow }, l) => {
    const walk = (items: Electron.MenuItem[]): Electron.MenuItem | undefined => {
      for (const it of items) { if (it.label === l && it.visible) return it; const sub = it.submenu ? walk(it.submenu.items) : undefined; if (sub) return sub; }
      return undefined;
    };
    walk(Menu.getApplicationMenu()!.items)!.click(undefined, BrowserWindow.getAllWindows()[0]);
  }, label);
}

type SettingsApi = { atelier: { settings: { get(): Promise<Record<string, unknown> | null>; set(p: object): Promise<unknown> } } };
/** Settings changed as the window changes them (main saves them and tells every window). */
export const settingsSet = (win: Page, patch: object) => win.evaluate((p) => (window as unknown as SettingsApi).atelier.settings.set(p), patch);
/** The settings as main saved them. */
export const settingsOf = (win: Page) => win.evaluate(() => (window as unknown as SettingsApi).atelier.settings.get());

export interface Project { app: ElectronApplication; win: Page; home: string; root: string }

/**
 * A project with a terminal open at its prompt. `size`: the window's content size (the specs whose screenshots and
 * layouts expect one); without it, the window as it opens.
 */
export async function launchProject(extra: Record<string, string> = {}, o: { size?: [number, number] } = {}): Promise<Project> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'atl-iph-')));
  const { env, home } = e2eEnv(extra);
  const app = await electron.launch({ args: ['out/main/index.js', `--project=${root}`], env });
  const win = await app.firstWindow();
  if (o.size) await app.evaluate(({ BrowserWindow }, [w, h]) => BrowserWindow.getAllWindows()[0]!.setContentSize(w, h), o.size);
  await win.getByRole('button', { name: 'Open a terminal' }).click();
  await expect(win.locator('.terminal-slot:visible .xterm-rows')).toContainText('›', { timeout: 15000 });
  return { app, win, home, root };
}

export interface Launched extends Project { relay: TestRelay; phone: FakePhone }

/** launchProject with a test relay for this Atelier to dial and a phone for that relay. */
export async function launchWithPhone(extra: Record<string, string> = {}, o: { size?: [number, number] } = {}): Promise<Launched> {
  const relay = await startTestRelay();
  const p = await launchProject({ ATELIER_TEST_RELAY_URL: relay.url, ...extra }, o);
  return { ...p, relay, phone: new FakePhone({ relay: relay.url }) };
}

/** The phone dropped, the app quit, its atelierd stopped, the relay closed. */
export async function close(l: Launched): Promise<void> {
  l.phone.drop();
  await l.app.close();
  stopDaemon(l.home);
  await l.relay.close();
}

/** Settings › iPhone, opening Settings when it is closed. */
export async function openIphoneSettings(app: ElectronApplication, win: Page): Promise<void> {
  if (!(await win.locator('.settings').isVisible())) await command(app, 'open-settings');
  await win.locator('.set-nav-item', { hasText: 'iPhone' }).click();
  await expect(win.locator('.set-head h2')).toHaveText('iPhone');
}

/** The code the pairing sheet shows now; with `not`, the one that replaced it. */
export async function codeOnScreen(win: Page, not?: string): Promise<string> {
  const code = win.locator('.pair-sheet .pair-code:not(.is-spent)');
  if (not) await expect(code).not.toHaveText(not, { timeout: 15000 });
  await expect(code).toHaveText(/^[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/, { timeout: 15000 });
  return (await code.innerText()).trim();
}

/** The session rows the window lists, their terminal ids in order. */
export const rowIds = (win: Page) => win.locator('[data-term-row]').evaluateAll((rows) => rows.map((r) => r.getAttribute('data-term-row')!));

/** A new Claude session in the place in front, from the menu's New Claude Session: its id, once it asks for a permission. */
export async function newWaitingSession(app: ElectronApplication, win: Page): Promise<string> {
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

/**
 * The sizes the stand-in for Claude Code recorded in `sizeFile` (its ATELIER_FAKE_SIZE_FILE: a `<cols>x<rows>` line at
 * its prompt, then one after each SIGWINCH), in order.
 */
export const sizeLines = (sizeFile: string): string[] => readFileSync(sizeFile, 'utf8').trim().split('\n');

/** The size the window shows its visible terminal at, as the footer says it ("claude · 79×31": "79x31"); '' if none. */
export async function footerSize(win: Page): Promise<string> {
  const label = win.locator('.foot-dim', { hasText: '×' });
  if (await label.count() === 0) return '';
  const m = /(\d+)×(\d+)$/.exec((await label.first().innerText()).trim());
  return m ? `${m[1]}x${m[2]}` : '';
}

/**
 * The line of `sizeFile` that later sizes are compared with: its last one, once it is the size the window shows the
 * Claude session at (in front), on two reads in a row. Lines before it may hold a size the session had while hidden.
 */
export async function sizeBaseline(win: Page, sizeFile: string): Promise<number> {
  let last = '';
  await expect.poll(async () => {
    const lines = sizeLines(sizeFile);
    const now = `${lines.length} lines, the last ${lines.at(-1)}, shown at ${await footerSize(win)}`;
    const settled = lines.at(-1) === await footerSize(win) && now === last;
    last = now;
    return settled;
  }, { timeout: 30_000, message: 'the stand-in never recorded the size the window shows it at' }).toBe(true);
  return sizeLines(sizeFile).length - 1;
}

type RemoteApi = { atelier: { remote: { status(): Promise<RemoteStatus> } } };
/**
 * A Claude session's terminal still has the window's size: every size the stand-in recorded in `sizeFile` from line
 * `from` on (its first by default; see sizeBaseline) is that line's, the remote status the window gets lists no phone
 * sizing it, and the window shows no size note.
 */
export async function sizeKept(win: Page, id: string, sizeFile: string, what: string, from = 0): Promise<void> {
  const sizes = sizeLines(sizeFile).slice(from);
  expect(sizes.length, `${what}: no size recorded from line ${from + 1} on`).toBeGreaterThan(0);
  expect(sizes.filter((s) => s !== sizes[0]), `${what}: the stand-in's terminal changed size (from ${sizes[0]})`).toEqual([]);
  const status = await win.evaluate(() => (window as unknown as RemoteApi).atelier.remote.status());
  expect(status.sized.filter((s) => s.id === id), `${what}: a phone sized it`).toEqual([]);
  await expect(win.locator('.terminal-slot:visible .size-note'), `${what}: the size note`).toHaveCount(0);
}

/** Settings › iPhone: access on, `phone` paired by code with Allow, Settings closed. */
export async function pairPhone(app: ElectronApplication, win: Page, phone: FakePhone): Promise<void> {
  await openIphoneSettings(app, win);
  await win.getByRole('switch', { name: 'Allow access from iPhone' }).click();
  await expect(win.locator('.iph-status')).toContainText('Connected to the relay', { timeout: 15000 });
  await win.getByRole('button', { name: 'Pair iPhone…' }).click();
  const paired = phone.pairByCode(await codeOnScreen(win));
  const sheet = win.locator('.pair-sheet');
  await sheet.getByRole('button', { name: 'Allow' }).click({ timeout: 20000 });
  expect((await paired).t).toBe('welcome');
  await expect(sheet).toHaveCount(0);
  await win.keyboard.press('Escape');
  await expect(win.locator('.settings')).toHaveCount(0);
}
