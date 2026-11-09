import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { e2eEnv } from './env';
import type { AtelierApi } from '../../src/shared/api';
import type { TriggerRule } from '../../src/shared/triggers';
import { look } from './shots';

// Output triggers. OS banners never reach macOS here: e2eEnv's ATELIER_TEST_NOTIFY_LOG makes main
// record them in a log, so the test also proves the banner path (setting, 30 s throttle) without touching the screen.

let notifyLog = '';
async function launch(): Promise<{ app: ElectronApplication; home: string; win: Page }> {
  const project = mkdtempSync(join(tmpdir(), 'atl-prj-'));
  execFileSync('git', ['init', '-q', '-b', 'main', project]);
  const { env, home } = e2eEnv();
  notifyLog = env.ATELIER_TEST_NOTIFY_LOG!;
  const app = await electron.launch({ args: ['out/main/index.js', `--project=${project}`], env });
  return { app, home, win: await app.firstWindow() };
}

async function stop(app: ElectronApplication, home: string) {
  await app.close();
  try { process.kill((JSON.parse(readFileSync(join(home, 'atelierd.json'), 'utf8')) as { pid: number }).pid, 'SIGTERM'); } catch { /* already stopped */ }
}

const api = (win: Page) => ({
  settings: () => win.evaluate(() => (window as unknown as { atelier: AtelierApi }).atelier.settings.get()),
  set: (patch: object) => win.evaluate((p) => (window as unknown as { atelier: AtelierApi }).atelier.settings.set(p as never), patch)
});
const banners = async (_app: ElectronApplication) => (existsSync(notifyLog) ? readFileSync(notifyLog, 'utf8').trim().split('\n').filter(Boolean)
  .map((l) => { const b = JSON.parse(l) as { title: string; body: string }; return { title: b.title, body: b.body }; }) : []);
const screen = (win: Page) => win.locator('.xterm-rows:visible');
const still = (win: Page) => win.addStyleTag({ content: '*, *::before, *::after { animation: none !important; transition: none !important; }' });

async function run(win: Page, cmd: string, until: RegExp | string) {
  await win.evaluate(async (c) => {
    const a = (window as unknown as { atelier: AtelierApi }).atelier;
    const [term] = await a.terminals.list();
    a.terminals.input(term!.id, c + '\r');
  }, cmd);
  await expect(screen(win)).toContainText(until, { timeout: 10000 });
}

const triggerRows = (win: Page) => win.locator('.notes-pop .note-row.kind-trigger');

test('triggers editor: examples off on first run, add, invalid regex error, fix, toggle, action, delete, keyboard; in terminals: notify once per 30 s, banner throttled, disabled rule silent, highlight, filter, no match on the attach replay', async () => {
  const { app, home, win } = await launch();
  try {
    await expect(win.getByRole('button', { name: 'Settings' })).toBeVisible({ timeout: 10000 });
    // From the palette: Settings › Terminal, scrolled to the triggers.
    await win.keyboard.press('F1');
    await win.locator('.palette-input').fill('>Edit output triggers');
    await win.keyboard.press('Enter');
    const dialog = win.getByRole('dialog', { name: 'Settings' });
    await expect(dialog.getByRole('heading', { name: 'Terminal' })).toBeVisible();
    const section = dialog.getByRole('region', { name: 'Triggers' });
    await expect(section).toBeInViewport();
    // Two disabled examples.
    await expect(section.getByRole('switch', { name: 'Trigger tests failed enabled' })).toHaveAttribute('aria-checked', 'false');
    await expect(section.getByRole('switch', { name: 'Trigger ERROR enabled' })).toHaveAttribute('aria-checked', 'false');

    // Add: the new field has focus; an invalid regex shows its error inline and is not saved.
    await section.getByRole('button', { name: 'Add Trigger' }).click();
    const field = section.getByRole('textbox', { name: 'Pattern' }).last();
    await expect(field).toBeFocused();
    await win.keyboard.type('/a(b/');
    await expect(section.getByRole('alert')).toContainText('Invalid regular expression');
    await expect(field).toHaveAttribute('aria-invalid', 'true');
    await win.keyboard.press('Enter');
    expect((await api(win).settings()).triggers).toHaveLength(2);
    // Nested repetition is refused too, with its own words.
    await field.fill('/(a+)+$/');
    await expect(section.getByRole('alert')).toContainText('Nested repetition');
    // Overlapping alternatives too; the hint says complex patterns may be paused.
    await field.fill('/(\\w|\\d)+$/');
    await expect(section.getByRole('alert')).toContainText('Alternatives that can match the same text');
    await expect(section).toContainText('Complex patterns may be paused');
    await field.fill('/(a+)+$/');
    await section.getByRole('button', { name: 'Add Trigger' }).scrollIntoViewIfNeeded();
    await still(win);
    await look(dialog, 'test-results/triggers-invalid.png');

    // Fixed: saved on Enter.
    await field.fill('/tests? failed/i');
    await expect(section.getByRole('alert')).toHaveCount(0);
    await win.keyboard.press('Enter');
    await expect.poll(async () => (await api(win).settings()).triggers.map((r: TriggerRule) => r.pattern)).toEqual(['tests failed', 'ERROR', '/tests? failed/i']);

    // Toggle an example on, switch the new one to Highlight with the keyboard (radio group arrows).
    await section.getByRole('switch', { name: 'Trigger ERROR enabled' }).click();
    const card = section.getByRole('group', { name: 'Trigger /tests? failed/i' });
    await card.getByRole('radio', { name: 'Notify' }).focus();
    await win.keyboard.press('ArrowRight');
    await expect(card.getByRole('radio', { name: 'Highlight' })).toHaveAttribute('aria-checked', 'true');
    await card.getByRole('radio', { name: 'All' }).click();
    await card.getByRole('radio', { name: 'Terminals' }).click();
    await expect.poll(async () => (await api(win).settings()).triggers.map((r: TriggerRule) => [r.pattern, r.enabled, r.action, r.scope])).toEqual([
      ['tests failed', false, 'notify', 'all'], ['ERROR', true, 'highlight', 'all'], ['/tests? failed/i', true, 'highlight', 'terminals']
    ]);
    await still(win);
    await look(dialog, 'test-results/triggers-editor.png');

    // Esc in an edited field brings the saved pattern back (the sheet stays open).
    await card.getByRole('textbox', { name: 'Pattern' }).fill('/half(');
    await win.keyboard.press('Escape');
    await expect(card.getByRole('textbox', { name: 'Pattern' })).toHaveValue('/tests? failed/i');
    await expect(dialog).toBeVisible();

    // Delete: gone from the settings, the keyboard stays in the list.
    await section.getByRole('button', { name: 'Delete trigger /tests? failed/i' }).click();
    await expect.poll(async () => (await api(win).settings()).triggers).toHaveLength(2);
    await expect(section.getByRole('button', { name: 'Delete trigger ERROR' })).toBeFocused();
    // The OS banner setting lives with the other notifications.
    await dialog.getByRole('button', { name: 'Notifications' }).click();
    await expect(dialog.getByRole('switch', { name: 'When a trigger matches' })).toHaveAttribute('aria-checked', 'true');
    await win.keyboard.press('Escape');
    await expect(dialog).toBeHidden();

    // In terminals.
    await win.getByRole('button', { name: 'Open a terminal' }).click();
    await expect(screen(win)).toContainText(/main ›/, { timeout: 10000 });
    await api(win).set({
      triggers: [
        { id: 'n', pattern: 'tests failed', action: 'notify', scope: 'all', enabled: true },
        { id: 'h', pattern: '/ERR[A-Z]+/', action: 'highlight', scope: 'terminals', enabled: true },
        { id: 'off', pattern: 'silent match', action: 'notify', scope: 'all', enabled: false }
      ]
    });

    // Three matches within 30 s (two commands): one entry, one banner. The typed command itself never matches.
    await run(win, "printf 'one tests %s\\ntwo tests %s\\n' failed failed", /two tests failed.* main ›\s*$/);
    await run(win, "printf 'three tests %s\\n' failed; printf 'silent %s\\n' match", /silent match.* main ›\s*$/);
    // Highlight: the matched text gets a decoration (not the typed command's ERR%s). Once it shows, the output before it
    // was matched too: the center and the banners are checked after it.
    await run(win, "printf 'boom ERR%s here\\n' ORX", /boom ERRORX here/);
    const hits = win.locator('.terminal-slot:visible .trg-hit');
    await expect(hits).toHaveCount(1);
    await expect(hits.first()).toBeVisible();
    await still(win);
    await look(win.locator('.terminal-slot:visible'), 'test-results/triggers-highlight.png');

    await win.locator('.bell-btn').click();
    await expect(triggerRows(win)).toHaveCount(1);
    await expect(triggerRows(win).locator('.note-title')).toHaveText('Trigger: tests failed');
    await expect(triggerRows(win).locator('.note-detail')).toContainText('one tests failed');
    await expect(win.locator('.notes-pop .note-title', { hasText: 'silent' })).toHaveCount(0);
    expect(await banners(app)).toEqual([{ title: 'Trigger: tests failed', body: expect.stringContaining('one tests failed') }]);
    await still(win);
    await look(win.locator('.notes-pop'), 'test-results/triggers-center.png');
    await win.keyboard.press('Escape');

    // Palette: "Show trigger matches" filters the center.
    await win.keyboard.press('F1');
    await win.locator('.palette-input').fill('>Show trigger matches');
    await win.keyboard.press('Enter');
    const pop = win.locator('.notes-pop.is-triggers');
    await expect(pop).toBeVisible();
    await expect(pop.locator('.notes-title')).toHaveText('Trigger matches');
    await expect(pop.locator('.note-row')).toHaveCount(1);
    await expect(pop.getByRole('button', { name: 'Show trigger matches only' })).toHaveAttribute('aria-pressed', 'true');
    await win.keyboard.press('Escape');

    // Reload: the attach snapshot replays "tests failed" lines; they are not new output (the renderer's 30 s memory is
    // gone with the reload, so a match would add an entry).
    // A fresh match after the replay does add one (and main still throttles its banner): with the replay matched there
    // would be three.
    await win.reload();
    await expect(screen(win)).toContainText(/boom ERRORX here/, { timeout: 10000 });
    await run(win, "printf 'four tests %s\\n' failed", /four tests failed.* main ›\s*$/);
    await win.locator('.bell-btn').click();
    await expect(triggerRows(win)).toHaveCount(2);
    await expect(triggerRows(win).filter({ hasText: 'four tests failed' })).toHaveCount(1);
    expect(await banners(app)).toHaveLength(1);
  } finally {
    await stop(app, home);
  }
});
