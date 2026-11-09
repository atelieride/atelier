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

/** Types into a session's prompt without selecting it (as if it answered while you look elsewhere). */
async function typeInto(win: Page, title: string, text: string) {
  await win.evaluate(async ({ title, text }) => {
    const api = (window as unknown as { atelier: Api }).atelier;
    const id = (await api.terminals.list()).find((x) => x.title === title)!.id;
    api.terminals.input(id, text);
  }, { title, text });
}

/** The grouped list: [section label, row titles] in order (one list, a head before each section's rows). */
const sections = (win: Page) => win.locator('.list.inbox').evaluateAll((lists) => {
  const out: [string, string[]][] = [];
  for (const el of lists[0]?.children ?? []) {
    if (el.classList.contains('inbox-head')) out.push([el.querySelector('.section-label')?.textContent ?? '', []]);
    else if (el.classList.contains('session-row')) out.at(-1)![1].push(el.querySelector('.session-title')?.textContent ?? '');
  }
  return out;
});

test('Inbox: sessions grouped by state, pins first, moving between sections; remembered; menu and palette', async () => {
  const { app, home } = await launch();
  try {
    const win = await app.firstWindow();
    for (const name of ['Alfa', 'Beta', 'Gamma', 'Delta']) await newSession(win, name);
    // On by default; the icon turns it off for a flat list.
    const toggle = win.getByRole('button', { name: 'Group by state' });
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(() => sections(win)).toEqual([['Needs you', ['Delta', 'Gamma', 'Beta', 'Alfa']]]);
    // The state heads carry no number (the macro areas' heads do: 2026-11-02).
    await expect(win.locator('.inbox-head .count')).toHaveCount(0);
    await expect(win.locator('.sidebar-head', { hasText: 'Sessions' }).locator('.count')).toHaveText('4');
    // Another view and back (Files, then Sessions): rows keep their places (when each entered its section is kept).
    await command(app, 'view-files');
    await expect(win.locator('.list.inbox')).toHaveCount(0);
    await command(app, 'view-sessions');
    await expect.poll(() => sections(win)).toEqual([['Needs you', ['Delta', 'Gamma', 'Beta', 'Alfa']]]);
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await expect(win.locator('.inbox-head')).toHaveCount(0);
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');

    // Pinned first inside its section.
    await win.locator('.session-row', { hasText: 'Alfa' }).click({ button: 'right' });
    await win.getByRole('menuitem', { name: 'Pin', exact: true }).click();
    await expect.poll(() => sections(win)).toEqual([['Needs you', ['Alfa', 'Delta', 'Gamma', 'Beta']]]);

    // Beta finishes off screen (ready for review), Gamma keeps working, Delta (on screen) stops on an error.
    await typeInto(win, 'Beta', '\r');
    await typeInto(win, 'Gamma', 'hold\r');
    await typeInto(win, 'Delta', 'fail\r');
    await expect.poll(() => sections(win), { timeout: 10000 }).toEqual([
      ['Needs you', ['Alfa', 'Delta']], ['Ready for review', ['Beta']], ['Working', ['Gamma']]
    ]);
    await expect(win.locator('.session-row', { hasText: 'Delta' })).toContainText('Rate limit');
    await look(win.locator('.sidebar'), 'test-results/inbox-grouped.png');

    // Looking at Beta: seen, so it is just idle now (and it enters its new section with the entrance motion).
    await win.locator('.session-row', { hasText: 'Beta' }).locator('.row-main').click();
    await expect.poll(() => sections(win), { timeout: 10000 }).toEqual([
      ['Needs you', ['Alfa', 'Delta']], ['Working', ['Gamma']], ['Idle', ['Beta']]
    ]);
    await expect(win.locator('.session-row', { hasText: 'Beta' })).toHaveClass(/\benter\b/);

    // Remembered after a reload.
    await win.reload();
    await expect(win.locator('.session-row')).toHaveCount(4, { timeout: 15000 });
    await expect(win.getByRole('button', { name: 'Group by state' })).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(() => sections(win)).toEqual([['Needs you', ['Alfa', 'Delta']], ['Working', ['Gamma']], ['Idle', ['Beta']]]);

    // Palette and View menu toggle it too.
    await win.keyboard.press('F1');
    await win.locator('.palette-input').fill('>group sessions');
    await expect(win.locator('.palette-item', { hasText: 'Group sessions by state' })).toBeVisible();
    await win.keyboard.press('Enter');
    await expect(win.locator('.inbox-head')).toHaveCount(0);
    await expect(win.getByRole('button', { name: 'Group by state' })).toHaveAttribute('aria-pressed', 'false');
    // Turned off, it stays off after a reload.
    await win.reload();
    await expect(win.locator('.session-row')).toHaveCount(4, { timeout: 15000 });
    await expect(win.getByRole('button', { name: 'Group by state' })).toHaveAttribute('aria-pressed', 'false');
    await expect(win.locator('.inbox-head')).toHaveCount(0);
    await command(app, 'toggle-group-by-state');
    await expect(win.locator('.inbox-head')).toHaveCount(3);
  } finally {
    await stop(app, home);
  }
});

test('a row changing section keeps the keyboard focus and an unfinished rename; Esc cancels a rename everywhere; ⌘⇧N again resets the resume: filter', async () => {
  const { app, home } = await launch();
  try {
    const win = await app.firstWindow();
    for (const name of ['Alfa', 'Beta']) await newSession(win, name);
    const heads = () => win.locator('.inbox-head .section-label').allTextContents();
    await expect.poll(heads).toEqual(['Needs you']);

    // The keyboard is on Alfa's row when Alfa starts working: it moves to Working with the focus.
    const alfa = win.locator('.session-row', { hasText: 'Alfa' }).locator('.row-main');
    await alfa.focus();
    await typeInto(win, 'Alfa', 'hold\r');
    await expect.poll(heads, { timeout: 10000 }).toEqual(['Needs you', 'Working']);
    await expect(alfa).toBeFocused();

    // Renaming Beta when it finishes: the field stays, with what you typed and the focus.
    await win.locator('.session-row', { hasText: 'Beta' }).locator('.row-main').dblclick();
    const input = win.locator('.session-row .rename-input');
    await input.fill('Beta renamed');
    await typeInto(win, 'Beta', '\r');
    await expect(win.locator('.session-row.state-done')).toHaveCount(1, { timeout: 10000 });
    await expect.poll(heads).not.toContain('Needs you');
    await expect(input).toBeFocused();
    await expect(input).toHaveValue('Beta renamed');
    await win.keyboard.press('Enter');
    await expect(win.locator('.session-row .session-title', { hasText: 'Beta renamed' })).toHaveCount(1, { timeout: 5000 });

    // Esc cancels a rename everywhere: the sidebar row, the tab (Rename… from its menu).
    const beta = win.locator('.session-row', { hasText: 'Beta renamed' });
    await beta.locator('.row-main').dblclick();
    await input.fill('Zeta');
    await win.keyboard.press('Escape');
    await expect(input).toHaveCount(0);
    await win.locator('.tab', { hasText: 'Beta renamed' }).click({ button: 'right' });
    await win.getByRole('menuitem', { name: 'Rename…' }).click();
    await win.locator('.tab .rename-input').fill('Zeta');
    await win.keyboard.press('Escape');
    await expect(win.locator('.tab .rename-input')).toHaveCount(0);
    // A rename that went through anyway would be back by now.
    await win.waitForTimeout(600);
    await expect(beta.locator('.session-title')).toHaveText('Beta renamed');
    await expect(win.locator('.tab', { hasText: 'Beta renamed' })).toHaveCount(1);
    await expect(win.locator('.session-row .session-title', { hasText: 'Zeta' })).toHaveCount(0);
    // Enter still renames.
    await beta.locator('.row-main').dblclick();
    await input.fill('Omega');
    await win.keyboard.press('Enter');
    await expect(win.locator('.session-row .session-title', { hasText: 'Omega' })).toHaveCount(1, { timeout: 5000 });

    // ⌘⇧N with the palette already on resume: and a typed filter: back to a clean resume:.
    await command(app, 'resume-session');
    await expect(win.locator('.palette-input')).toHaveValue('resume:');
    await win.locator('.palette-input').fill('resume:xyz');
    await command(app, 'resume-session');
    await expect(win.locator('.palette-input')).toHaveValue('resume:');
  } finally {
    await stop(app, home);
  }
});
