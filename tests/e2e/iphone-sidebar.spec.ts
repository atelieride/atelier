// iPhone access shows what the sidebar shows, end to end, with a fake phone on Atelier's own Noise code
// (tests/support/fake-phone.ts) through the test relay (tests/support/test-relay.ts): the sidebar's arrangement
// (workspaces, an activity, grouping, pins) as a layout the phone groups rows by.
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { mkdtempSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { e2eEnv } from './env';
import { look } from './shots';
import { startTestRelay, type TestRelay } from '../support/test-relay';
import { FakePhone, type Msg } from '../support/fake-phone';

const SHOTS = 'test-results/iphone-sidebar';

const command = (app: ElectronApplication, c: string) => app.evaluate(({ BrowserWindow }, c) => BrowserWindow.getAllWindows()[0]!.webContents.send('ev:command', c), c);
const stopDaemon = (home: string) => { try { process.kill((JSON.parse(readFileSync(join(home, 'atelierd.json'), 'utf8')) as { pid: number }).pid, 'SIGTERM'); } catch { /* already stopped */ } };

/** App menu items are clicked (synthetic key events do not go through NSMenu). */
async function menu(app: ElectronApplication, label: string): Promise<void> {
  await app.evaluate(({ Menu, BrowserWindow }, l) => {
    const walk = (items: Electron.MenuItem[]): Electron.MenuItem | undefined => {
      for (const it of items) { if (it.label === l && it.visible) return it; const sub = it.submenu ? walk(it.submenu.items) : undefined; if (sub) return sub; }
      return undefined;
    };
    walk(Menu.getApplicationMenu()!.items)!.click(undefined, BrowserWindow.getAllWindows()[0]);
  }, label);
}

interface Launched { app: ElectronApplication; win: Page; home: string; root: string; relay: TestRelay; phone: FakePhone }

/** A project with a terminal open at its prompt, the fake Claude for its sessions, a test relay and a phone for it. */
async function launch(extra: Record<string, string> = {}): Promise<Launched> {
  const relay = await startTestRelay();
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'atl-iphs-')));
  const { env, home } = e2eEnv({ ATELIER_TEST_RELAY_URL: relay.url, ATELIER_CLAUDE_BIN: resolve('tests/e2e/fake-claude.pl'), ...extra });
  const app = await electron.launch({ args: ['out/main/index.js', `--project=${root}`], env });
  const win = await app.firstWindow();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(1280, 800));
  await win.getByRole('button', { name: 'Open a terminal' }).click();
  await expect(win.locator('.terminal-slot:visible .xterm-rows')).toContainText('›', { timeout: 15000 });
  return { app, win, home, root, relay, phone: new FakePhone({ relay: relay.url }) };
}

async function close(l: Launched): Promise<void> {
  l.phone.drop();
  await l.app.close();
  stopDaemon(l.home);
  await l.relay.close();
}

/** Settings › iPhone: access on, a phone paired by code with Allow, Settings closed. */
async function pair(l: Launched): Promise<void> {
  const { app, win, phone } = l;
  if (!(await win.locator('.settings').isVisible())) await command(app, 'open-settings');
  await win.locator('.set-nav-item', { hasText: 'iPhone' }).click();
  await win.getByRole('switch', { name: 'Allow access from iPhone' }).click();
  await expect(win.locator('.iph-status')).toContainText('Connected to the relay', { timeout: 15000 });
  await win.getByRole('button', { name: 'Pair iPhone…' }).click();
  const code = win.locator('.pair-sheet .pair-code:not(.is-spent)');
  await expect(code).toHaveText(/^[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/, { timeout: 15000 });
  const paired = phone.pairByCode((await code.innerText()).trim());
  await win.locator('.pair-sheet').getByRole('button', { name: 'Allow' }).click({ timeout: 20000 });
  expect((await paired).t).toBe('welcome');
  await win.keyboard.press('Escape');
  await expect(win.locator('.settings')).toHaveCount(0);
}

const projectOf = (s: Msg, root: string) => (s.projects as { id: string; name: string }[]).find((p) => p.name === basename(root))!;
/** The latest layout the phone got for a project. */
const latestLayout = (phone: FakePhone, project: string) => [...phone.messages].reverse().find((m) => m.t === 'layout' && m.project === project);

test('the sidebar\'s arrangement reaches the phone: grouping, workspaces, an activity and which row is where', async () => {
  test.setTimeout(180_000);
  const l = await launch();
  const { app, win, phone, root } = l;
  try {
    await pair(l);
    const state = await phone.state();
    const project = projectOf(state, root).id;
    // Never arranged with access on before: null, then the window's own as soon as access is on.
    await expect.poll(() => (latestLayout(phone, project)?.layout as Msg | null)?.groupByState, { timeout: 10000 }).toBe(true);
    expect(latestLayout(phone, project)!.layout).not.toHaveProperty('workspaces');

    // Workspaces and activities on, an activity made from the workspace's "+".
    await menu(app, 'Toggle Workspaces for This Project');
    await expect(win.locator('.ws-group.is-active')).toContainText('Workspace 1');
    await expect.poll(async () => app.evaluate(({ Menu }) => {
      const walk = (items: Electron.MenuItem[]): Electron.MenuItem | undefined => {
        for (const it of items) { if (it.label === 'Activities Inside Workspaces') return it; const sub = it.submenu ? walk(it.submenu.items) : undefined; if (sub) return sub; }
        return undefined;
      };
      return walk(Menu.getApplicationMenu()!.items)?.enabled;
    })).toBe(true);
    await menu(app, 'Activities Inside Workspaces');
    const ws = win.locator('.ws-group', { has: win.locator('.ws-name', { hasText: /^Workspace 1$/ }) });
    await ws.locator('.ws-head').hover();
    await ws.locator('.ws-plus').click();
    await win.getByRole('menuitem', { name: 'New Activity…' }).click();
    const input = win.locator('.wsa-head .rename-input');
    await expect(input).toBeFocused();
    await input.fill('SSO with Okta');
    await input.press('Enter');
    await expect(win.locator('.wsa-group', { hasText: 'SSO with Okta' })).toHaveClass(/is-current/);

    const terminal = (state.sessions as { id: string }[])[0]!.id;
    await expect.poll(() => {
      const w = (latestLayout(phone, project)?.layout as Msg | null)?.workspaces as Msg | undefined;
      return w ? (w.places as Msg[]).map((p) => [p.name, p.parent !== undefined]) : null;
    }, { timeout: 10000 }).toEqual([['Workspace 1', false], ['SSO with Okta', true]]);
    const layout = latestLayout(phone, project)!.layout as { workspaces: { active: string; activities: boolean; places: { id: string; name: string; color: number; parent?: string; open: boolean }[]; members: Record<string, string> } };
    const [main, sso] = layout.workspaces.places;
    expect(sso!.parent).toBe(main!.id);
    expect(layout.workspaces.active).toBe(sso!.id);
    expect(layout.workspaces.activities).toBe(true);
    // The terminal opened before workspaces stays in the workspace's own rows.
    expect(layout.workspaces.members[terminal] ?? layout.workspaces.active).not.toBe(sso!.id);
    expect(JSON.stringify(layout)).not.toContain(root);

    // Grouping by state off in the sidebar: the phone follows.
    await win.getByRole('button', { name: /group by state/i }).first().click();
    await expect.poll(() => (latestLayout(phone, project)?.layout as Msg | null)?.groupByState, { timeout: 10000 }).toBe(false);
    await look(win, `${SHOTS}/layout-sidebar.png`, { settle: 300 });
  } finally {
    await close(l);
  }
});
