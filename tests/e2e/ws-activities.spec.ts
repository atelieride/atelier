import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { e2eEnv } from './env';
import { collisions, shownWidth, sidebarByKeys } from './narrow-fixture';
import { look } from './shots';

// Activities inside workspaces: turned on, made from the "+", their own tabs, the workspace's own
// tabs, the band, drags, Move to ›, ⌘J into a folded one, Close with Move and Stop, the setting off and on, a reload.

const SHOTS = 'test-results';
type Term = { id: string; title: string; createdAt: number; session: unknown };
type Api = { terminals: { list(): Promise<Term[]>; input(id: string, data: string): void; rename(id: string, name: string | null): Promise<void> }; settings: { set(p: object): Promise<unknown> } };

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
/** An app menu item's state: shown, enabled, checked (undefined: no such item). */
const menuItem = (app: ElectronApplication, label: string) => app.evaluate(({ Menu }, l) => {
  const walk = (items: Electron.MenuItem[]): Electron.MenuItem | undefined => {
    for (const it of items) { if (it.label === l) return it; const sub = it.submenu ? walk(it.submenu.items) : undefined; if (sub) return sub; }
    return undefined;
  };
  const it = walk(Menu.getApplicationMenu()!.items);
  return it ? { visible: it.visible, enabled: it.enabled, checked: it.checked } : undefined;
}, label);

const api = (win: Page) => win.evaluate(() => (window as unknown as { atelier: Api }).atelier.terminals.list());
const tabs = (win: Page) => win.locator('.tab-strip .tab').evaluateAll((els) => els.map((el) => (el.textContent ?? '').trim()));
const group = (win: Page, name: string) => win.locator('.ws-group', { has: win.locator('.ws-name', { hasText: new RegExp(`^${name}$`) }) });
const act = (win: Page, name: string) => win.locator('.wsa-group', { has: win.locator('.wsa-name', { hasText: new RegExp(`^${name}$`) }) });
async function rename(win: Page, newest: string) {
  await win.evaluate(async (n) => { const a = (window as unknown as { atelier: Api }).atelier; const all = (await a.terminals.list()).sort((x, y) => x.createdAt - y.createdAt); await a.terminals.rename(all.at(-1)!.id, n); }, newest);
}
async function typeInto(win: Page, title: string, text: string) {
  await win.evaluate(async ([t, x]) => { const a = (window as unknown as { atelier: Api }).atelier; const id = (await a.terminals.list()).find((y) => y.title === t)!.id; a.terminals.input(id, x!); }, [title, text]);
}
const away = (win: Page) => win.mouse.move(900, 500);
const left = (l: Locator) => l.evaluate((el) => el.getBoundingClientRect().left);

/** A project with a terminal (Alpha), workspaces on, activities on. */
async function launch() {
  const project = mkdtempSync(join(tmpdir(), 'atl-prj-'));
  writeFileSync(join(project, 'okta.ts'), 'export const okta = 1;\n');
  const { env, home } = e2eEnv({ ATELIER_CLAUDE_BIN: resolve('tests/e2e/fake-claude.pl') });
  const app = await electron.launch({ args: ['out/main/index.js', `--project=${project}`], env });
  const win = await app.firstWindow();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(1280, 800));
  await win.getByRole('button', { name: 'Open a terminal' }).click();
  await expect(win.locator('.tab-strip .tab')).toHaveCount(1, { timeout: 10000 });
  await rename(win, 'Alpha');
  await expect(win.locator('.tab', { hasText: 'Alpha' })).toBeVisible();
  return { app, win, home, project };
}

/** "+" › New Activity… on workspace `ws`, named `name`. */
async function newActivity(win: Page, ws: string, name: string) {
  await group(win, ws).locator('.ws-head').hover();
  await group(win, ws).locator('.ws-plus').click();
  await win.getByRole('menuitem', { name: 'New Activity…' }).click();
  const input = win.locator('.wsa-head .rename-input');
  await expect(input).toBeFocused();
  await expect(input).toHaveValue('New activity');
  await input.fill(name);
  await input.press('Enter');
  await expect(act(win, name)).toHaveClass(/is-current/);
}

test('activities: on; New Activity… from the "+"; its tabs alone, folded; the workspace\'s own tabs; the band; drags; Move to ›; ⌘J into a folded one', async () => {
  const { app, win, home } = await launch();
  try {
    // Before workspaces: the switch in View is there but disabled.
    expect(await menuItem(app, 'Activities Inside Workspaces')).toMatchObject({ enabled: false, checked: false });
    await menu(app, 'Toggle Workspaces for This Project');
    await expect(win.locator('.ws-group.is-active')).toContainText('Workspace 1');
    // Activities off: the "+" menu is today's.
    await group(win, 'Workspace 1').locator('.ws-head').hover();
    await group(win, 'Workspace 1').locator('.ws-plus').click();
    await expect(win.locator('.ctx-menu [role="menuitem"]')).toHaveText([/New Claude Session/, /Session in Folder…/]);
    await win.keyboard.press('Escape');

    // On from View › Activities Inside Workspaces.
    await expect.poll(async () => (await menuItem(app, 'Activities Inside Workspaces'))?.enabled).toBe(true);
    await menu(app, 'Activities Inside Workspaces');
    await expect.poll(async () => (await menuItem(app, 'Activities Inside Workspaces'))?.checked).toBe(true);
    await group(win, 'Workspace 1').locator('.ws-head').hover();
    await group(win, 'Workspace 1').locator('.ws-plus').click();
    await expect(win.locator('.ctx-menu [role="menuitem"]')).toHaveText([/New Claude Session/, /Session in Folder…/, /New Terminal/, /New Activity…/]);
    await win.keyboard.press('Escape');

    // New Activity… from the "+": its name typed in its head; it comes forward empty, folded.
    await newActivity(win, 'Workspace 1', 'SSO with Okta');
    const sso = act(win, 'SSO with Okta');
    await expect(sso.locator('.wsa-chev')).toHaveAttribute('aria-expanded', 'false');
    await expect(sso.locator('.wsa-head')).toHaveClass(/is-selected/);
    await expect.poll(() => tabs(win)).toEqual([]);
    await expect(win.locator('.workspace-empty h2')).toHaveText('SSO with Okta');
    await expect(win.locator('.workspace-empty')).toContainText('Nothing open in this activity.');
    await expect(win.locator('.workspace-empty')).toContainText('Drag sessions, terminals or tabs onto it in the sidebar');
    await still(win);
    await away(win);
    await look(win.locator('.workspace'), `${SHOTS}/ws-activities-empty.png`);

    // A terminal from its empty state, and a Claude session from its "+": both land in it.
    await win.locator('.workspace-empty').getByRole('button', { name: /terminal/i }).click();
    await expect.poll(() => tabs(win), { timeout: 10000 }).toHaveLength(1);
    await rename(win, 'Okta mock');
    await sso.locator('.wsa-head').hover();
    await sso.locator('.wsa-plus').click();
    await expect(win.locator('.ctx-menu [role="menuitem"]')).toHaveText([/New Claude Session/, /Session in Folder…/, /New Terminal/]);
    await win.getByRole('menuitem', { name: /New Claude Session/ }).click();
    await win.getByPlaceholder('Session name (optional)').fill('okta-callback');
    await win.keyboard.press('Enter');
    await expect.poll(async () => (await api(win)).some((x) => x.title === 'okta-callback' && x.session), { timeout: 20000 }).toBe(true);
    await expect.poll(() => tabs(win)).toHaveLength(2);
    await expect(win.locator('.terminal-slot:visible .xterm-rows').first()).toContainText('FAKE-CLAUDE waiting', { timeout: 15000 });
    await typeInto(win, 'okta-callback', '\r');

    // The workspace's name: its own tabs alone; SSO folded and not lit.
    await group(win, 'Workspace 1').locator('.ws-name-btn').click();
    await expect.poll(() => tabs(win)).toEqual(['Alpha']);
    await expect(sso).not.toHaveClass(/is-current/);
    await expect(sso.locator('.wsa-head')).not.toHaveClass(/is-selected/);
    // The activity's name: its tabs alone; it stays folded, its head the selected box; the workspace's name steps down.
    await sso.locator('.wsa-name-btn').click();
    await expect.poll(() => tabs(win)).toHaveLength(2);
    expect((await tabs(win)).join(' ')).toContain('Okta mock');
    await expect(sso.locator('.wsa-chev')).toHaveAttribute('aria-expanded', 'false');
    await expect(sso.locator('.wsa-head')).toHaveClass(/is-selected/);
    await expect(group(win, 'Workspace 1')).toHaveClass(/in-act/);
    await away(win);
    await look(win.locator('.sidebar'), `${SHOTS}/ws-activities-folded-current.png`);
    // The brightest label is where you are: the activity's name; the workspace's steps down — unless the workspace is
    // folded, its activities out of sight: then its name is lit again.
    const color = (l: Locator) => l.evaluate((el) => getComputedStyle(el).color);
    const textColor = await win.evaluate(() => { const p = document.createElement('span'); p.style.color = 'var(--text)'; document.body.append(p); const c = getComputedStyle(p).color; p.remove(); return c; });
    const wsName = group(win, 'Workspace 1').locator('.ws-name');
    expect(await color(sso.locator('.wsa-name'))).toBe(textColor);
    expect(await color(wsName)).not.toBe(textColor);
    const wsChev = group(win, 'Workspace 1').locator('.ws-head .ws-chev');
    await wsChev.click();
    await away(win);
    expect(await color(wsName)).toBe(textColor);
    await wsChev.click();
    await expect(sso).toBeVisible();

    // Its chevron: the band, no box; its rows indented under its head, right of the workspace's own rows, a row's icon
    // centred under the activity's glyph.
    await sso.locator('.wsa-chev').click();
    await expect(sso).toHaveClass(/is-open/);
    await expect(sso.locator('.wsa-head')).not.toHaveClass(/is-selected/);
    const mockRow = sso.locator('.term-row', { hasText: 'Okta mock' });
    const alphaRow = group(win, 'Workspace 1').locator('.ws-own .term-row', { hasText: 'Alpha' });
    await expect(mockRow).toBeVisible();
    expect(await left(mockRow)).toBeGreaterThan(await left(alphaRow));
    const centre = (l: Locator) => l.evaluate((el) => { const r = el.getBoundingClientRect(); return r.left + r.width / 2; });
    expect(Math.abs(await centre(mockRow.locator('.term-icon')) - await centre(sso.locator('.wsa-glyph')))).toBeLessThanOrEqual(1);
    expect(await sso.evaluate((el) => getComputedStyle(el).backgroundColor)).not.toBe('rgba(0, 0, 0, 0)');
    await away(win);
    await look(win.locator('.sidebar'), `${SHOTS}/ws-activities-band.png`);

    // A second activity from the workspace's menu.
    await group(win, 'Workspace 1').locator('.ws-head').click({ button: 'right' });
    await win.getByRole('menuitem', { name: 'New Activity…' }).click();
    await win.locator('.wsa-head .rename-input').fill('Password reset');
    await win.locator('.wsa-head .rename-input').press('Enter');
    const reset = act(win, 'Password reset');
    await expect(reset).toHaveClass(/is-current/);
    await expect.poll(() => tabs(win)).toEqual([]);

    // Drag a row onto its head: the drop state on the target while over it; then the row moves into it (the place in front).
    const target = reset.locator('.wsa-head');
    await mockRow.hover();
    await win.mouse.down();
    const box = (await target.boundingBox())!;
    await win.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 8 });
    await expect(reset).toHaveClass(/is-drop/);
    await look(win.locator('.sidebar'), `${SHOTS}/ws-activities-drop.png`);
    await win.mouse.up();
    await expect(reset).not.toHaveClass(/is-drop/);
    await expect.poll(() => tabs(win)).toEqual(['Okta mock']);
    await expect(sso.locator('.term-row', { hasText: 'Okta mock' })).toHaveCount(0);

    // A Claude session's row moves the same way, into the activity in front and back out to another one.
    await sso.locator('.session-row', { hasText: 'okta-callback' }).dragTo(reset.locator('.wsa-head'));
    await expect.poll(() => tabs(win)).toEqual(['Okta mock', expect.stringContaining('okta-callback')]);
    await expect(sso.locator('.session-row', { hasText: 'okta-callback' })).toHaveCount(0);
    await reset.locator('.wsa-chev').click();
    await reset.locator('.session-row', { hasText: 'okta-callback' }).dragTo(sso.locator('.wsa-head'));
    await expect.poll(() => tabs(win)).toEqual(['Okta mock']);
    await expect(sso.locator('.session-row', { hasText: 'okta-callback' })).toBeVisible();
    await expect(win.locator('.toast')).toContainText('Moved okta-callback to SSO with Okta');
    await reset.locator('.wsa-chev').click();

    // Drag the tab from the strip onto the other activity's head: it leaves the strip, its toast names it.
    await win.locator('.tab', { hasText: 'Okta mock' }).dragTo(sso.locator('.wsa-head'));
    await expect.poll(() => tabs(win)).toEqual([]);
    await expect(win.locator('.toast')).toContainText('Moved Okta mock to SSO with Okta');
    await expect(sso.locator('.term-row', { hasText: 'Okta mock' })).toBeVisible();

    // Move to › from a tab: every place, indented activities, a check where it is; into the workspace's own tabs.
    await sso.locator('.wsa-name-btn').click();
    await expect.poll(() => tabs(win)).toHaveLength(2);
    await win.locator('.tab', { hasText: 'Okta mock' }).click({ button: 'right' });
    await win.getByRole('menuitem', { name: /^Move to$/ }).hover();
    const sub = win.locator('.ctx-submenu');
    await expect(sub.locator('[role="menuitemradio"]')).toHaveText(['Workspace 1', 'SSO with Okta', 'Password reset']);
    await expect(sub.getByRole('menuitemradio', { name: 'SSO with Okta' })).toHaveAttribute('aria-checked', 'true');
    await expect(sub.locator('.ctx-item.is-indent')).toHaveCount(2);
    await look(win, `${SHOTS}/ws-activities-move-to.png`);
    await sub.getByRole('menuitemradio', { name: 'Workspace 1' }).click();
    await expect(win.locator('.toast')).toContainText('Moved Okta mock to Workspace 1');
    await expect.poll(() => tabs(win)).toHaveLength(1);
    await win.locator('.toast').getByRole('button', { name: 'Go' }).click();
    await expect(group(win, 'Workspace 1')).not.toHaveClass(/in-act/);
    await expect.poll(() => tabs(win)).toEqual(['Alpha', 'Okta mock']);

    // ⌘J from the own tabs into a folded activity: SSO folded, its session asks; it comes forward and stays folded.
    await sso.locator('.wsa-chev').click();
    await expect(sso).not.toHaveClass(/is-open/);
    await typeInto(win, 'okta-callback', 'ev:permission\r');
    await expect(sso.locator('.ws-dot.is-waiting')).toBeVisible({ timeout: 15000 });
    await expect(sso.locator('.wsa-head')).toHaveAttribute('data-tip', /SSO with Okta · 1 needs you/);
    await away(win);
    await look(win.locator('.sidebar'), `${SHOTS}/ws-activities-waiting.png`);
    await menu(app, 'Next Session Needing Attention');
    await expect(sso).toHaveClass(/is-current/);
    await expect(sso.locator('.wsa-chev')).toHaveAttribute('aria-expanded', 'false');
    await expect(win.locator('.tab.is-active')).toContainText('okta-callback');

    // The narrowest sidebar and the default: nothing in an activity's head collides, its name still reads.
    for (const w of [200, 264]) {
      await sidebarByKeys(win, w);
      await away(win);
      for (const head of await win.locator('.sidebar .wsa-head').all()) {
        const label = `${w} px · ${await head.innerText()}`;
        expect(await collisions(head, '.wsa-chev, .wsa-name-btn, .ws-dot, .wsa-plus'), label).toEqual([]);
        const name = head.locator('.wsa-name');
        const [seen, full] = [await shownWidth(name), await name.evaluate((el) => el.scrollWidth)];
        expect(seen, `${label}: name cut to ${seen} px`).toBeGreaterThanOrEqual(Math.min(full, 56) - 0.5);
      }
      await look(win.locator('.sidebar'), `${SHOTS}/ws-activities-${w}.png`);
    }
    // Everything kept running all along.
    expect(await api(win)).toHaveLength(3);
  } finally {
    await stop(app, home);
  }
});

test('activities: Close with Move and with Stop; the setting off and on; a reload brings back the activities, folds and place in front', async () => {
  const { app, win, home } = await launch();
  try {
    await menu(app, 'Toggle Workspaces for This Project');
    await expect(win.locator('.ws-group.is-active')).toContainText('Workspace 1');
    await win.evaluate(() => (window as unknown as { atelier: Api }).atelier.settings.set({ wsActivities: true }));
    await expect.poll(async () => (await menuItem(app, 'New Activity…'))?.visible).toBe(true);

    // File › New Activity…: SSO, with a terminal.
    await menu(app, 'New Activity…');
    await win.locator('.wsa-head .rename-input').fill('SSO');
    await win.locator('.wsa-head .rename-input').press('Enter');
    await win.locator('.workspace-empty').getByRole('button', { name: /terminal/i }).click();
    await expect.poll(() => tabs(win), { timeout: 10000 }).toHaveLength(1);
    await rename(win, 'Okta mock');
    // Reset, with a Claude session.
    await newActivity(win, 'Workspace 1', 'Reset');
    await win.locator('.workspace-empty').getByRole('button', { name: /session/i }).first().click();
    await win.getByPlaceholder('Session name (optional)').fill('mail');
    await win.keyboard.press('Enter');
    await expect.poll(async () => (await api(win)).some((x) => x.title === 'mail' && x.session), { timeout: 20000 }).toBe(true);
    await expect(win.locator('.terminal-slot:visible .xterm-rows').first()).toContainText('FAKE-CLAUDE waiting', { timeout: 15000 });
    expect(await api(win)).toHaveLength(3);

    // Close SSO from its menu: the question; Enter moves what is inside back to Workspace 1, nothing stops.
    await act(win, 'SSO').locator('.wsa-head').click({ button: 'right' });
    await win.getByRole('menuitem', { name: 'Close Activity…' }).click();
    const confirm = win.getByRole('alertdialog', { name: 'Close “SSO”?' });
    await expect(confirm).toBeVisible();
    await expect(confirm).toContainText('Okta mock is running.');
    await expect(confirm).toContainText('Moving them puts their tabs back in Workspace 1.');
    await look(confirm, `${SHOTS}/ws-activities-close.png`);
    // Move is the default: it has the keyboard, so Enter stops nothing (an Enter right as it appears is swallowed on
    // purpose: the click answers here).
    const moveThem = confirm.getByRole('button', { name: /Move them to Workspace 1/ });
    await expect(moveThem).toBeFocused();
    await moveThem.click();
    await expect(act(win, 'SSO')).toHaveCount(0);
    await expect(group(win, 'Workspace 1').locator('.ws-own .term-row', { hasText: 'Okta mock' })).toBeVisible();
    expect(await api(win)).toHaveLength(3);

    // Close Reset with Stop: its session stops and waits under Resume in Workspace 1's own rows.
    await act(win, 'Reset').locator('.wsa-head').click({ button: 'right' });
    await win.getByRole('menuitem', { name: 'Close Activity…' }).click();
    await win.getByRole('alertdialog', { name: 'Close “Reset”?' }).getByRole('button', { name: /Stop them/ }).click();
    await expect(act(win, 'Reset')).toHaveCount(0);
    await expect.poll(async () => (await api(win)).length, { timeout: 15000 }).toBe(2);
    await expect(group(win, 'Workspace 1').locator('.resume-row', { hasText: 'mail' })).toBeVisible({ timeout: 15000 });

    // Docs, with Delta in front, open in the sidebar.
    await newActivity(win, 'Workspace 1', 'Docs');
    await win.locator('.workspace-empty').getByRole('button', { name: /terminal/i }).click();
    await expect.poll(() => tabs(win), { timeout: 10000 }).toHaveLength(1);
    await rename(win, 'Delta');
    await act(win, 'Docs').locator('.wsa-chev').click();
    await expect(act(win, 'Docs')).toHaveClass(/is-open/);

    // The setting off: one list, the workspace's own tabs then Docs', Delta still in front; nothing stops.
    await menu(app, 'Activities Inside Workspaces');
    await expect(win.locator('.wsa-group')).toHaveCount(0);
    await expect.poll(() => tabs(win)).toEqual(['Alpha', 'Okta mock', 'Delta']);
    await expect(win.locator('.tab.is-active')).toContainText('Delta');
    expect(await api(win)).toHaveLength(3);
    await away(win);
    await look(win.locator('.sidebar'), `${SHOTS}/ws-activities-off.png`);
    // On again: Docs back with Delta, open as it was; the workspace's own tabs in front.
    await menu(app, 'Activities Inside Workspaces');
    await expect(act(win, 'Docs')).toHaveClass(/is-open/);
    await expect(act(win, 'Docs').locator('.term-row', { hasText: 'Delta' })).toBeVisible();
    await expect.poll(() => tabs(win)).toEqual(['Alpha', 'Okta mock']);

    // Docs in front; a reload brings the activity, its fold and the place in front back.
    await act(win, 'Docs').locator('.wsa-name-btn').click();
    await expect.poll(() => tabs(win)).toEqual(['Delta']);
    await win.evaluate(() => new Promise((r) => setTimeout(r, 600)));
    await win.reload();
    await expect(act(win, 'Docs')).toHaveClass(/is-current/, { timeout: 15000 });
    await expect(act(win, 'Docs')).toHaveClass(/is-open/);
    await expect.poll(() => tabs(win), { timeout: 10000 }).toEqual(['Delta']);

    // Minimal Ink: the band and the head in another theme.
    await win.evaluate(() => (window as unknown as { atelier: Api }).atelier.settings.set({ theme: 'ink' }));
    await expect(win.locator('html')).toHaveAttribute('data-theme', 'ink');
    await away(win);
    await look(win.locator('.sidebar'), `${SHOTS}/ws-activities-ink.png`, { settle: 150 });
    await win.evaluate(() => (window as unknown as { atelier: Api }).atelier.settings.set({ theme: 'aurora' }));
  } finally {
    await stop(app, home);
  }
});
