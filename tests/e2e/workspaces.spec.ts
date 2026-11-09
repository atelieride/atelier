import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { e2eEnv } from './env';
import { look } from './shots';

// Workspaces: off by default; on per project; each with its own tabs; switching by card,
// the Go menu and ⌘J; moving a tab; closing; off and on again; a reload brings them back.

const SHOTS = 'test-results';
type Term = { id: string; title: string; createdAt: number };
type Api = { terminals: { list(): Promise<Term[]>; input(id: string, data: string): void; rename(id: string, name: string | null): Promise<void> } };

const still = (win: Page) => win.addStyleTag({ content: '*, *::before, *::after { animation: none !important; transition: none !important; } .xterm-cursor-layer { display: none !important; }' });

async function stop(app: ElectronApplication, home: string) {
  await app.close();
  try { process.kill((JSON.parse(readFileSync(join(home, 'atelierd.json'), 'utf8')) as { pid: number }).pid, 'SIGTERM'); } catch { /* already stopped */ }
}

/** App menu items are clicked (synthetic key events do not go through NSMenu). */
async function menu(app: ElectronApplication, label: string) {
  await app.evaluate(({ Menu, BrowserWindow }, l) => {
    const walk = (items: Electron.MenuItem[]): Electron.MenuItem | undefined => {
      for (const it of items) { if (it.label === l && it.visible) return it; const sub = it.submenu ? walk(it.submenu.items) : undefined; if (sub) return sub; }
      return undefined;
    };
    walk(Menu.getApplicationMenu()!.items)!.click(undefined, BrowserWindow.getAllWindows()[0]);
  }, label);
}
/** Whether a visible app menu item has that label (the Go menu's workspaces, New Workspace…). */
const hasMenu = (app: ElectronApplication, label: string) => app.evaluate(({ Menu }, l) => {
  const walk = (items: Electron.MenuItem[]): boolean => items.some((it) => (it.label === l && it.visible) || (it.submenu ? walk(it.submenu.items) : false));
  return walk(Menu.getApplicationMenu()!.items);
}, label);

const tabs = (win: Page) => win.locator('.tab-strip .tab').evaluateAll((els) => els.map((el) => (el.textContent ?? '').trim()));
/** The workspace in front's head, and a workspace's group by name. */
const front = (win: Page) => win.locator('.ws-group.is-active .ws-head');
const group = (win: Page, name: string) => win.locator('.ws-group', { has: win.locator('.ws-name', { hasText: new RegExp(`^${name}$`) }) });
const list = (win: Page) => win.evaluate(() => (window as unknown as { atelier: Api }).atelier.terminals.list());
async function rename(win: Page, newest: string) {
  await win.evaluate(async (n) => { const api = (window as unknown as { atelier: Api }).atelier; const all = (await api.terminals.list()).sort((a, b) => a.createdAt - b.createdAt); await api.terminals.rename(all.at(-1)!.id, n); }, newest);
}
async function typeInto(win: Page, title: string, text: string) {
  await win.evaluate(async ([t, x]) => { const api = (window as unknown as { atelier: Api }).atelier; const id = (await api.terminals.list()).find((y) => y.title === t)!.id; api.terminals.input(id, x!); }, [title, text]);
}

test('workspaces: off by default; on; a new one with its own tabs; switching by card and the Go menu; move a tab; close; off and on; reload', async () => {
  const project = mkdtempSync(join(tmpdir(), 'atl-prj-'));
  writeFileSync(join(project, 'notes.md'), 'Notes\n');
  const { env, home } = e2eEnv({ ATELIER_CLAUDE_BIN: resolve('tests/e2e/fake-claude.pl') });
  const app = await electron.launch({ args: ['out/main/index.js', `--project=${project}`], env });
  try {
    const win = await app.firstWindow();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(1280, 800));
    await win.getByRole('button', { name: 'Open a terminal' }).click();
    await expect(win.locator('.tab-strip .tab')).toHaveCount(1, { timeout: 10000 });
    await rename(win, 'Alpha');
    await expect(win.locator('.tab', { hasText: 'Alpha' })).toBeVisible();

    // A terminal's row: its Pin and Close take no room until the row is hovered (as a session's), so its chips reach
    // the row's end.
    const alphaRow = win.locator('.sidebar .term-row', { hasText: 'Alpha' });
    await win.mouse.move(900, 500);
    const gap = () => alphaRow.evaluate((r) => {
      const kids = [...r.children].filter((el) => el.getBoundingClientRect().width > 0 && getComputedStyle(el).opacity !== '0');
      return r.getBoundingClientRect().right - Math.max(...kids.map((el) => el.getBoundingClientRect().right));
    });
    expect(await gap()).toBeLessThan(12);
    await alphaRow.hover();
    await expect(alphaRow.locator('.row-close')).toHaveCSS('opacity', '1');
    expect(await alphaRow.locator('.row-close').evaluate((el) => el.getBoundingClientRect().width)).toBeGreaterThan(20);
    await win.mouse.move(900, 500);

    // Off by default: today's sidebar, no workspace items in the menu.
    await expect(win.locator('.ws-head')).toHaveCount(0);
    expect(await hasMenu(app, 'New Workspace…')).toBe(false);

    // On (View › Toggle Workspaces for This Project): everything in Workspace 1, the rows as they were.
    await menu(app, 'Toggle Workspaces for This Project');
    await expect(front(win)).toContainText('Workspace 1');
    await expect(win.locator('.sidebar .term-row', { hasText: 'Alpha' })).toBeVisible();
    await expect.poll(() => hasMenu(app, 'New Workspace…')).toBe(true);
    await expect.poll(() => hasMenu(app, 'Workspace 1')).toBe(true);

    // File › New Workspace…: Billing, starting with a terminal; it comes to the front with only its tab.
    await menu(app, 'New Workspace…');
    const sheet = win.getByRole('dialog', { name: 'New Workspace' });
    await expect(sheet).toBeVisible();
    await sheet.getByRole('radio', { name: 'Terminal' }).click();
    await sheet.locator('.nws-input').first().fill('Billing');
    await still(win);
    await look(sheet, `${SHOTS}/workspaces-sheet.png`);
    await sheet.locator('.nws-input').first().press('Enter');
    await expect(sheet).toHaveCount(0);
    await expect(front(win)).toContainText('Billing');
    // The next color nobody uses: Workspace 1 has the first, Billing the second.
    await expect(win.locator('.ws-group.is-active')).toHaveAttribute('style', /--ws-2/);
    await expect.poll(() => tabs(win), { timeout: 10000 }).toHaveLength(1);
    await rename(win, 'Bravo');
    await expect.poll(() => tabs(win)).toEqual(['Bravo']);
    // Workspace 1, left behind, stays open (revised 2026-11-08): switching never folds one.
    const one = group(win, 'Workspace 1');
    await expect(one.locator('.ws-chev')).toHaveAttribute('aria-expanded', 'true');
    await expect(one.locator('.ws-body .term-row', { hasText: 'Alpha' })).toBeVisible();
    // Its chevron folds it into its head: no box, no rows, no dot (nothing going on in it).
    await one.locator('.ws-chev').click();
    await expect(one.locator('.ws-head')).toBeVisible();
    await expect(one.locator('.ws-body')).toHaveCount(0);
    await expect(one.locator('.ws-dot')).toHaveCount(0);
    await expect(one.locator('.ws-chev')).toHaveAttribute('aria-expanded', 'false');
    // The quiet head: no tint or ring on the active one either; its rows indented on a guide.
    const head = await front(win).evaluate((el) => ({ bg: getComputedStyle(el).backgroundColor, ring: getComputedStyle(el).boxShadow }));
    expect(head).toEqual({ bg: 'rgba(0, 0, 0, 0)', ring: 'none' });
    expect(await win.locator('.ws-group.is-active .ws-body').evaluate((el) => getComputedStyle(el).borderLeftWidth)).toBe('1px');
    await win.mouse.move(900, 500);
    await look(win.locator('.sidebar'), `${SHOTS}/workspaces-sidebar.png`);

    // Its name brings it back, open: Alpha alone; Billing, left behind, stays open until its chevron folds it.
    await one.locator('.ws-name-btn').click();
    await expect(front(win)).toContainText('Workspace 1');
    await expect.poll(() => tabs(win)).toEqual(['Alpha']);
    await expect(one.locator('.ws-body')).toBeVisible();
    await expect(group(win, 'Billing').locator('.ws-body .term-row', { hasText: 'Bravo' })).toBeVisible();
    await win.mouse.move(900, 500);
    await look(win.locator('.sidebar'), `${SHOTS}/workspaces-left-open.png`);
    await group(win, 'Billing').locator('.ws-chev').click();
    await expect(group(win, 'Billing').locator('.ws-body')).toHaveCount(0);
    await expect(front(win)).toContainText('Workspace 1');

    // Peek: Billing's chevron shows its rows without leaving Workspace 1.
    await group(win, 'Billing').locator('.ws-chev').click();
    // Its "+" shows under the pointer or for the keyboard, not because a click left the chevron focused.
    await win.mouse.move(900, 500);
    await expect(group(win, 'Billing').locator('.ws-plus')).toHaveCSS('opacity', '0');
    await group(win, 'Billing').locator('.ws-chev').focus();
    await win.keyboard.press('Shift+Tab');
    await win.keyboard.press('Tab');
    await expect(group(win, 'Billing').locator('.ws-plus')).toHaveCSS('opacity', '1');
    const bravoRow = group(win, 'Billing').locator('.term-row', { hasText: 'Bravo' });
    await expect(bravoRow).toBeVisible();
    await expect(front(win)).toContainText('Workspace 1');
    await expect.poll(() => tabs(win)).toEqual(['Alpha']);
    // A double-click renames the row in place, still without switching.
    await bravoRow.locator('.row-main').dblclick();
    const renaming = group(win, 'Billing').locator('.term-row .rename-input');
    await expect(renaming).toBeFocused();
    await expect(renaming).toHaveValue('Bravo');
    // Past the double-click's wait: still in Workspace 1.
    await win.evaluate(() => new Promise((r) => setTimeout(r, 400)));
    await expect(front(win)).toContainText('Workspace 1');
    await win.keyboard.press('Escape');
    await expect(renaming).toHaveCount(0);
    await expect(bravoRow).toBeVisible();
    await win.mouse.move(900, 500);
    await look(win.locator('.sidebar'), `${SHOTS}/workspaces-peek.png`);
    // A click on its row goes there, with that tab; both stay open.
    await bravoRow.locator('.row-main').click();
    await expect(front(win)).toContainText('Billing');
    await expect.poll(() => tabs(win)).toEqual(['Bravo']);
    await expect(group(win, 'Workspace 1').locator('.ws-body')).toBeVisible();
    await expect(group(win, 'Billing').locator('.ws-body')).toBeVisible();
    // The chevron folds the one in front too, and opens it again.
    await front(win).locator('.ws-chev').click();
    await expect(win.locator('.ws-group.is-active .ws-body')).toHaveCount(0);
    await front(win).locator('.ws-name-btn').click();
    await expect(win.locator('.ws-group.is-active .ws-body')).toBeVisible();
    await expect.poll(() => tabs(win)).toEqual(['Bravo']);
    // "+" on another workspace's head: the Sessions drop-down; New Claude Session brings
    // that workspace forward with New Session open.
    await group(win, 'Workspace 1').locator('.ws-head').hover();
    await group(win, 'Workspace 1').locator('.ws-plus').click();
    await expect(win.locator('.ctx-menu [role="menuitem"]')).toHaveText([/New Claude Session/, /Session in Folder…/]);
    await expect(front(win)).toContainText('Billing');
    await win.getByRole('menuitem', { name: /New Claude Session/ }).click();
    await expect(front(win)).toContainText('Workspace 1');
    await expect(win.getByRole('dialog', { name: 'New Session' })).toBeVisible();
    await win.keyboard.press('Escape');
    await expect(win.getByRole('dialog', { name: 'New Session' })).toHaveCount(0);
    await expect.poll(() => tabs(win)).toEqual(['Alpha']);
    // Go › Billing (⌘⌥2's item).
    await menu(app, 'Billing');
    await expect(front(win)).toContainText('Billing');
    await expect.poll(() => tabs(win)).toEqual(['Bravo']);
    // Both terminals kept running all along.
    expect(await list(win)).toHaveLength(2);

    // Move Bravo to Workspace 1 from its tab's menu: Billing is left empty, with its empty state.
    await win.locator('.tab', { hasText: 'Bravo' }).click({ button: 'right' });
    await win.getByRole('menuitem', { name: /Move to Workspace/ }).hover();
    await win.getByRole('menuitem', { name: 'Workspace 1' }).click();
    await expect.poll(() => tabs(win)).toEqual([]);
    await expect(win.locator('.workspace-empty h2')).toHaveText('Nothing running in Billing');
    await look(win.locator('.workspace'), `${SHOTS}/workspaces-empty.png`);
    await group(win, 'Workspace 1').locator('.ws-name-btn').click();
    await expect.poll(() => tabs(win)).toEqual(['Alpha', 'Bravo']);

    // Close the empty Billing from its head's menu: no question; one workspace left.
    await group(win, 'Billing').locator('.ws-head').click({ button: 'right' });
    await win.getByRole('menuitem', { name: 'Close Workspace…' }).click();
    await expect(win.locator('.ws-group')).toHaveCount(1);

    // Off: today's sidebar and one strip; nothing stopped. On again: Workspace 1 back as it was.
    await menu(app, 'Toggle Workspaces for This Project');
    await expect(win.locator('.ws-head')).toHaveCount(0);
    await expect.poll(() => tabs(win)).toEqual(['Alpha', 'Bravo']);
    expect(await list(win)).toHaveLength(2);
    await menu(app, 'Toggle Workspaces for This Project');
    await expect(front(win)).toContainText('Workspace 1');

    // Changes' This workspace · All, in its Filters: one radio group, All by default, the
    // arrows move the choice; a choice other than the usual one lights the funnel with a dot.
    const changes = win.locator('aside.changes');
    const funnel = changes.getByRole('button', { name: /^Filters/ });
    await expect(changes.locator('.changes-ws')).toHaveCount(0);
    await funnel.click();
    const pop = changes.getByRole('dialog', { name: 'Filters' });
    // Opening puts the focus on the chosen grouping.
    await expect(pop.getByRole('radio', { name: 'Repository' })).toBeFocused();
    // Both groups fill their row; Group by in equal halves (Show too when its words fit, else This workspace grows).
    const sizes = (name: string) => pop.getByRole('radiogroup', { name }).evaluate((g) => {
      const [a, b] = [...g.querySelectorAll('button')].map((x) => x.getBoundingClientRect().width);
      return { group: g.getBoundingClientRect().width, a: a!, b: b! };
    });
    const by = await sizes('Group by');
    expect(Math.abs(by.a - by.b)).toBeLessThan(1.5);
    for (const s of [by, await sizes('Show')]) expect(s.a + s.b).toBeGreaterThan(s.group - 12);
    const thisWs = pop.getByRole('radio', { name: 'This workspace' });
    // Its words whole, never cut, at the default width and the narrowest panel (240 px).
    const whole = () => thisWs.evaluate((b) => {
      const text = document.createRange();
      text.selectNodeContents(b);
      const room = b.getBoundingClientRect().right - parseFloat(getComputedStyle(b).paddingRight);
      return text.getBoundingClientRect().right <= room + 0.5;
    });
    expect(await whole()).toBe(true);
    // All by default: every change of the project.
    const all = pop.getByRole('radio', { name: 'All' });
    await expect(all).toHaveAttribute('aria-checked', 'true');
    await look(pop, `${SHOTS}/workspaces-changes-scope.png`);
    await all.focus();
    await win.keyboard.press('ArrowLeft');
    await expect(thisWs).toHaveAttribute('aria-checked', 'true');
    await expect(thisWs).toBeFocused();
    await win.keyboard.press('Escape');
    await expect(pop).toHaveCount(0);
    // Esc gives the focus back to the funnel, lit with a dot; its name and tooltip say which filter.
    await expect(funnel).toBeFocused();
    await expect(funnel).toHaveClass(/is-lit/);
    await expect(funnel.locator('.cf-dot')).toHaveCount(1);
    await expect(funnel).toHaveAttribute('aria-label', 'Filters · this workspace');
    await expect(funnel).toHaveAttribute('data-tip', 'Filters · this workspace');
    await look(changes, `${SHOTS}/workspaces-changes-lit.png`);
    // Under the pointer the dot's ring takes the button's fill (no pale halo on light themes).
    await funnel.hover();
    await expect.poll(() => funnel.evaluate((b) => getComputedStyle(b.querySelector('.cf-dot')!).boxShadow.includes(getComputedStyle(b).backgroundColor))).toBe(true);
    await funnel.click();
    // Reset goes away: the focus lands on the grouping at once (an Esc right after it still closes the popover).
    const focusAfterReset = await pop.getByRole('button', { name: 'Reset' }).evaluate((b) => { (b as HTMLElement).focus(); (b as HTMLElement).click(); return document.activeElement?.textContent ?? null; });
    expect(focusAfterReset).toBe('Repository');
    await expect(all).toHaveAttribute('aria-checked', 'true');
    await expect(pop.getByRole('button', { name: 'Reset' })).toHaveCount(0);
    await win.keyboard.press('Escape');
    await expect(pop).toHaveCount(0);
    await expect(funnel).not.toHaveClass(/is-lit/);
    await expect(funnel).toHaveAttribute('aria-label', 'Filters');
    // The narrowest panel (240 px): the words still whole, the popover inside the panel.
    await changes.evaluate((el) => el.style.setProperty('--changes-w', '240px'));
    await funnel.click();
    expect(await whole()).toBe(true);
    const inside = await pop.evaluate((p) => { const r = p.getBoundingClientRect(), c = p.closest('aside')!.getBoundingClientRect(); return r.left >= c.left && r.right <= c.right; });
    expect(inside).toBe(true);
    await look(pop, `${SHOTS}/workspaces-changes-scope-narrow.png`);
    await win.keyboard.press('Escape');
    await changes.evaluate((el) => el.style.removeProperty('--changes-w'));

    // Every tab closed, the terminals still running: the empty state says so (not "nothing running").
    await menu(app, 'Close Tab');
    await menu(app, 'Close Tab');
    await expect.poll(() => tabs(win)).toEqual([]);
    await expect(win.locator('.workspace-empty h2')).toHaveText('No tab open in Workspace 1');
    await win.locator('.sidebar .term-row', { hasText: 'Alpha' }).locator('.row-main').click();
    await expect.poll(() => tabs(win)).toEqual(['Alpha']);
    await win.locator('.sidebar .term-row', { hasText: 'Bravo' }).locator('.row-main').click();
    await expect.poll(() => tabs(win)).toEqual(['Alpha', 'Bravo']);

    // A reload (the window opening again) brings the workspaces back from the project's saved state.
    await win.evaluate(() => new Promise((r) => setTimeout(r, 600)));
    await win.reload();
    await expect(front(win)).toContainText('Workspace 1', { timeout: 15000 });
    await expect.poll(() => tabs(win), { timeout: 10000 }).toEqual(['Alpha', 'Bravo']);
  } finally {
    await stop(app, home);
  }
});

test('workspaces: ⌘J follows a session waiting in another workspace; Close with Move keeps its sessions running', async () => {
  const project = mkdtempSync(join(tmpdir(), 'atl-prj-'));
  const { env, home } = e2eEnv({ ATELIER_CLAUDE_BIN: resolve('tests/e2e/fake-claude.pl') });
  const app = await electron.launch({ args: ['out/main/index.js', `--project=${project}`], env });
  try {
    const win = await app.firstWindow();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(1280, 800));
    await win.getByRole('button', { name: 'Open a terminal' }).click();
    await expect(win.locator('.tab-strip .tab')).toHaveCount(1, { timeout: 10000 });
    await rename(win, 'Alpha');
    await menu(app, 'Toggle Workspaces for This Project');
    await expect(front(win)).toContainText('Workspace 1');

    // Review: a Claude session in a new workspace, its first message answered, then asking for a permission.
    await menu(app, 'New Workspace…');
    const sheet = win.getByRole('dialog', { name: 'New Workspace' });
    await sheet.locator('.nws-input').first().fill('Review');
    await sheet.locator('.nws-input').first().press('Enter');
    await expect(front(win)).toContainText('Review');
    await expect.poll(async () => (await list(win)).length, { timeout: 15000 }).toBe(2);
    await rename(win, 'Claude');
    await expect.poll(() => win.locator('.terminal-slot:visible .xterm-rows').first().evaluate((el) => el.textContent ?? ''), { timeout: 15000 }).toContain('FAKE-CLAUDE waiting');
    await typeInto(win, 'Claude', '\r');

    // Back in Workspace 1, Review folded by its chevron: its head shows one amber dot once its session
    // asks.
    await group(win, 'Workspace 1').locator('.ws-name-btn').click();
    await expect.poll(() => tabs(win)).toEqual(['Alpha']);
    await group(win, 'Review').locator('.ws-chev').click();
    await expect(group(win, 'Review').locator('.ws-body')).toHaveCount(0);
    await typeInto(win, 'Claude', 'ev:permission\r');
    const dot = group(win, 'Review').locator('.ws-head .ws-dot.is-waiting');
    await expect(dot).toBeVisible({ timeout: 15000 });
    // The dot alone, no number beside it; its tooltip says how many (revised 2026-11-02).
    await expect(dot).toHaveText('');
    await expect(dot).toHaveAttribute('data-tip', /1 waiting/);
    await win.mouse.move(900, 500);
    await look(win.locator('.sidebar'), `${SHOTS}/workspaces-waiting-card.png`);
    // Peeking at it: the waiting row has no amber box, only its avatar's ring and its amber line.
    await group(win, 'Review').locator('.ws-chev').click();
    const waiting = group(win, 'Review').locator('.session-row.state-waiting');
    await expect(waiting).toBeVisible();
    expect(await waiting.evaluate((el) => [getComputedStyle(el).backgroundColor, getComputedStyle(el).boxShadow])).toEqual(['rgba(0, 0, 0, 0)', 'none']);
    await group(win, 'Review').locator('.ws-chev').click();

    // Go › Next Session Needing Attention (⌘J): Review comes to the front with its session.
    await menu(app, 'Next Session Needing Attention');
    await expect(front(win)).toContainText('Review');
    await expect(win.locator('.tab.is-active')).toContainText('Claude');

    // Close Review with Move: the confirm asks; Enter moves its session to Workspace 1, still running.
    await front(win).click({ button: 'right' });
    await win.getByRole('menuitem', { name: 'Close Workspace…' }).click();
    const confirm = win.getByRole('alertdialog', { name: 'Close “Review”?' });
    await expect(confirm).toBeVisible();
    await look(confirm, `${SHOTS}/workspaces-close.png`);
    await confirm.getByRole('button', { name: /Move them to Workspace 1/ }).click();
    await expect(win.locator('.ws-group')).toHaveCount(1);
    await expect(front(win)).toContainText('Workspace 1');
    await expect.poll(() => tabs(win)).toEqual(['Alpha', expect.stringContaining('Claude')]);
    expect(await list(win)).toHaveLength(2);
  } finally {
    await stop(app, home);
  }
});

// Settings › Appearance › Use workspaces in every project (2026-11-02): on, the project has them whatever its own
// switch says (that switch and View's toggle set aside); off, a project that had them only through it goes back off,
// one on by its own choice stays on.
test('workspaces in every project: on from Settings, the project switch set aside; off again, each project decides', async () => {
  const project = mkdtempSync(join(tmpdir(), 'atl-prj-'));
  const { env, home } = e2eEnv({ ATELIER_CLAUDE_BIN: resolve('tests/e2e/fake-claude.pl') });
  const app = await electron.launch({ args: ['out/main/index.js', `--project=${project}`], env });
  const toggleEnabled = () => app.evaluate(({ Menu }) => Menu.getApplicationMenu()!.items.find((m) => m.label === 'View')!.submenu!.items.find((it) => it.label === 'Toggle Workspaces for This Project')!.enabled);
  try {
    const win = await app.firstWindow();
    await win.getByRole('button', { name: 'Open a terminal' }).click();
    await expect(win.locator('.tab-strip .tab')).toHaveCount(1, { timeout: 10000 });
    await expect(win.locator('.ws-head')).toHaveCount(0);

    await win.getByRole('button', { name: 'Settings' }).click();
    const dialog = win.getByRole('dialog', { name: 'Settings' });
    await dialog.locator('.set-nav-item', { hasText: 'Appearance' }).click();
    const own = dialog.getByRole('switch', { name: /^Use workspaces in atl-prj-/ });
    const everywhere = dialog.getByRole('switch', { name: 'Use workspaces in every project' });
    await expect(own).toHaveAttribute('aria-checked', 'false');
    await everywhere.click();
    await expect(front(win)).toContainText('Workspace 1');
    await expect(own).toHaveAttribute('aria-checked', 'true');
    await expect(own).toBeDisabled();
    await expect.poll(toggleEnabled).toBe(false);
    await look(dialog, `${SHOTS}/workspaces-everywhere-settings.png`);
    expect((JSON.parse(readFileSync(join(home, 'preferences.json'), 'utf8')) as { workspacesEverywhere: boolean }).workspacesEverywhere).toBe(true);

    // Off: this project had them only through the setting, so they go back off (the tab stays).
    await everywhere.click();
    await expect(win.locator('.ws-head')).toHaveCount(0);
    await expect(own).toBeEnabled();
    await expect(own).toHaveAttribute('aria-checked', 'false');
    await expect.poll(toggleEnabled).toBe(true);
    await expect(win.locator('.tab-strip .tab')).toHaveCount(1);

    // On by the project's own choice: the setting going on and off again leaves them on.
    await own.click();
    await expect(front(win)).toContainText('Workspace 1');
    await everywhere.click();
    await everywhere.click();
    await expect(everywhere).toHaveAttribute('aria-checked', 'false');
    await expect(front(win)).toContainText('Workspace 1');
  } finally {
    await stop(app, home);
  }
});

test('workspaces: Changes shows every change by default (All), and a change made by hand shows under This workspace too', async () => {
  // An edit by hand was missing under This workspace and the panel said "Working tree clean".
  const project = mkdtempSync(join(tmpdir(), 'atl-prj-'));
  const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  const run = (...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: project, env: gitEnv });
  writeFileSync(join(project, 'NOTES.md'), 'one\n');
  writeFileSync(join(project, 'app.ts'), '1\n');
  run('init', '-q', '-b', 'main');
  run('add', '.');
  run('commit', '-q', '-m', 'first');
  const { env, home } = e2eEnv({ ATELIER_CLAUDE_BIN: resolve('tests/e2e/fake-claude-edit.pl'), ATELIER_FAKE_EDIT: join(project, 'app.ts') });
  const app = await electron.launch({ args: ['out/main/index.js', `--project=${project}`], env });
  try {
    const win = await app.firstWindow();
    const changes = win.locator('aside.changes');
    await expect(changes.locator('.clean-note')).toHaveText('Working tree clean', { timeout: 10000 });
    await menu(app, 'Toggle Workspaces for This Project');
    await expect(front(win)).toContainText('Workspace 1');
    writeFileSync(join(project, 'NOTES.md'), 'two\n');
    const row = changes.locator('.change-row', { hasText: 'NOTES.md' });
    await expect(row).toBeVisible({ timeout: 8000 });
    const funnel = changes.getByRole('button', { name: /^Filters/ });
    await expect(funnel).not.toHaveClass(/is-lit/);
    await funnel.click();
    const pop = changes.getByRole('dialog', { name: 'Filters' });
    await expect(pop.getByRole('radio', { name: 'All' })).toHaveAttribute('aria-checked', 'true');
    await pop.getByRole('radio', { name: 'This workspace' }).click();
    await win.keyboard.press('Escape');
    await expect(funnel).toHaveClass(/is-lit/);
    await expect(row).toBeVisible();
    await expect(changes.locator('.clean-note')).toHaveCount(0);
    await look(changes, `${SHOTS}/workspaces-changes-by-hand.png`);

    // Back to clean; then another workspace's session edits a file. Under This workspace, Workspace 1 hides it and says
    // so: never "clean".
    writeFileSync(join(project, 'NOTES.md'), 'one\n');
    await expect(changes.locator('.clean-note')).toHaveText('Working tree clean', { timeout: 8000 });
    writeFileSync(join(project, 'app.ts'), '2\n');
    await menu(app, 'New Workspace…');
    const sheet = win.getByRole('dialog', { name: 'New Workspace' });
    await sheet.locator('.nws-input').first().fill('Review');
    await sheet.locator('.nws-input').first().press('Enter');
    await expect(front(win)).toContainText('Review');
    const appRow = changes.locator('.change-row', { hasText: 'app.ts' });
    await expect(appRow.locator('.dot:not(.unknown)')).toHaveCount(1, { timeout: 15000 });
    await group(win, 'Workspace 1').locator('.ws-name-btn').click();
    await expect(front(win)).toContainText('Workspace 1');
    await expect(appRow).toHaveCount(0);
    await expect(changes.locator('.clean-note')).toHaveText('Nothing in this workspace · 1 file elsewhere');
    // One line (the full sentence is its tooltip).
    expect(await changes.locator('.clean-note-text').evaluate((el) => el.getBoundingClientRect().height)).toBeLessThan(20);
    await expect(funnel).toHaveClass(/is-lit/);
    await look(changes, `${SHOTS}/workspaces-changes-elsewhere.png`);
  } finally {
    await stop(app, home);
  }
});
