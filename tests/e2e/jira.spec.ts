import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { ConnectorInfo, TaskList } from '../../src/shared/tasks';
import { e2eEnv, writePrefs } from './env';
import { JIRA_READ_TOOLS, startFakeJiraCli, type FakeJiraCli } from './fake-jira-cli';
import { look } from './shots';

// Jira end to end (Testing) against the local fake Jira (tests/fixtures/fake-jira.mjs:
// Rovo MCP v2 and Atlassian's authorization server on two loopback origins, never the real ones): connect from the list
// row, choose projects in the picker, Mine | Everyone, the saved filter, Disconnect; the palette's Jira section and a
// session started from an issue; the service-project rule in the automation editor; the API-token sign-in. Main follows
// the authorize page itself (ATELIER_TEST_FOLLOW_AUTH) and safeStorage is the test stand-in (never the Keychain).

/** Looked at by hand (git-ignored by default), next to the analysis boards. */
const SHOTS = process.env.ATELIER_JIRA_SHOTS ?? resolve('e2e-shots/connectors-jira');
const TOKEN = { email: 'ada@example.com', token: 'ATATT3xFfGF0-fake-api-token-0123456789' };
const TOKENS_PAGE = 'https://id.atlassian.com/manage-profile/security/api-tokens?appId=mcp-v2&expiryDays=max&selectedScopes=all';

/** Animations off for screenshots that are looked at. */
const still = (win: Page) => win.addStyleTag({ content: '*, *::before, *::after { animation: none !important; transition: none !important; } .xterm-cursor-layer { display: none !important; }' });

async function stop(app: ElectronApplication, home: string) {
  await app.close().catch(() => {});
  try { process.kill((JSON.parse(readFileSync(join(home, 'atelierd.json'), 'utf8')) as { pid: number }).pid, 'SIGTERM'); } catch { /* already stopped */ }
}

/** App menu items are clicked (synthetic key events do not go through NSMenu). */
async function menu(app: ElectronApplication, label: string) {
  await app.evaluate(({ Menu, BrowserWindow }, l) => {
    const walk = (items: Electron.MenuItem[]): Electron.MenuItem | undefined => {
      for (const it of items) { if (it.label === l) return it; const sub = it.submenu ? walk(it.submenu.items) : undefined; if (sub) return sub; }
      return undefined;
    };
    const item = walk(Menu.getApplicationMenu()!.items);
    if (!item) throw new Error(`no menu item ${l}`);
    item.click(undefined, BrowserWindow.getAllWindows()[0]);
  }, label);
}

async function palette(win: Page, query: string) {
  await win.mouse.move(1, 1);
  await win.keyboard.press('F1');
  await win.locator('.palette-input').fill(query);
}

/** A connector's section in the palette: its title row and the rows under it (siblings in one wrapper). */
const section = (win: Page, title: string): Locator =>
  win.locator('.palette-list > div').filter({ has: win.locator('.palette-section', { hasText: title }) });

/** The visible terminal's rows as one string: a long echoed line wraps over several rows. */
const screenText = (win: Page) => win.locator('.terminal-slot:visible .xterm-rows').first().evaluate((el) =>
  [...el.querySelectorAll(':scope > div')].map((r) => r.textContent ?? '').join(''));

async function launch(o: { extra?: Record<string, string>; apiToken?: typeof TOKEN } = {}) {
  const jira: FakeJiraCli = await startFakeJiraCli(o.apiToken ? { apiToken: o.apiToken } : {});
  const project = mkdtempSync(join(tmpdir(), 'atl-prj-'));
  // Links main opened instead of the browser (ATELIER_TEST_URL_LOG).
  const urlLog = join(mkdtempSync(join(tmpdir(), 'atl-urls-')), 'urls.log');
  const { env, home } = e2eEnv({
    ATELIER_CLAUDE_BIN: resolve('tests/e2e/fake-claude.pl'),
    ATELIER_TEST_JIRA_URL: jira.url, ATELIER_TEST_JIRA_AUTH_URL: jira.authUrl, ATELIER_TEST_FOLLOW_AUTH: '1', ATELIER_TEST_URL_LOG: urlLog,
    ...o.extra
  });
  writePrefs(home, { automationsEnabled: true });
  const app = await electron.launch({ args: ['out/main/index.js', `--project=${project}`], env });
  const win = await app.firstWindow();
  await expect(win.locator('.footer')).toBeVisible({ timeout: 15000 });
  await still(win);
  const list = () => (win.evaluate('window.atelier.connectors.list()') as Promise<{ connectors: ConnectorInfo[] }>).then((r) => r.connectors);
  const jiraInfo = () => list().then((cs) => cs.find((c) => c.id === 'jira'));
  const connect = async () => {
    await win.evaluate(`window.atelier.connectors.connect('jira')`);
    await expect.poll(() => jiraInfo().then((c) => c?.status), { timeout: 15000 }).toBe('connected');
  };
  const urls = () => (existsSync(urlLog) ? readFileSync(urlLog, 'utf8').split('\n').filter(Boolean) : []);
  // Only Jira's six read tools ever reached the fake.
  const done = async () => expect((await jira.calls()).filter((n) => !JIRA_READ_TOOLS.includes(n))).toEqual([]);
  const close = async () => { await stop(app, home); jira.close(); };
  return { jira, app, win, home, jiraInfo, connect, urls, done, close };
}

test('Jira in Settings: connect, choose projects in the picker, Mine | Everyone, the saved filter, Disconnect', async () => {
  test.setTimeout(150_000);
  mkdirSync(SHOTS, { recursive: true });
  const t = await launch();
  const { app, win } = t;
  try {
    await menu(app, 'Connectors…');
    const dialog = win.getByRole('dialog', { name: 'Settings' });
    // The third row, with its description.
    await expect(dialog.locator('.conn-row')).toHaveCount(3);
    expect(await dialog.locator('.conn-row').evaluateAll((rows) => rows.map((r) => (r as HTMLElement).dataset.connector))).toEqual(['clickup', 'notion', 'jira']);
    const row = dialog.locator('.conn-row[data-connector="jira"]');
    await expect(row.locator('.conn-row-line')).toHaveText('Start sessions from the Jira issues in projects you choose.');

    // Connect from the row: connected, no project chosen yet.
    await row.getByRole('button', { name: 'Connect Jira' }).click();
    await expect(row).toHaveAttribute('data-status', 'connected', { timeout: 15000 });
    await expect(row.locator('.conn-chip')).toHaveText('Choose projects');
    await expect(row.locator('.conn-row-line')).toHaveText('Connected as Ada Lovelace · no projects chosen yet');
    await look(dialog, join(SHOTS, 'jira-list.png'));

    // The details: who and where, what next, Disconnect only, the empty state.
    await row.locator('.conn-row-open').click();
    const details = dialog.locator('.conn-details[data-connector="jira"]');
    await expect(details.locator('.conn-status')).toContainText('Connected as Ada Lovelace · acme.atlassian.net');
    await expect(details.locator('.conn-status')).toContainText('Now choose the projects Atelier may read.');
    await expect(details.locator('.conn-actions button')).toHaveText(['Disconnect']);
    await expect(details.locator('.nsrc-empty-title')).toHaveText('No projects yet');
    await expect(details).toContainText('Jira has no desktop app: issues open in your browser.');

    // The picker lists the first projects at once, with their keys and types; Service is amber.
    const picker = dialog.getByRole('dialog', { name: 'Add Jira projects' });
    const input = picker.getByRole('combobox', { name: 'Search projects' });
    await details.locator('.nsrc-empty .nsrc-add').click();
    await expect(input).toBeFocused();
    await expect(picker.locator('.nsp-ws')).toHaveText('acme.atlassian.net');
    await expect(picker.getByRole('option')).toHaveCount(4);
    await expect(picker.locator('.jsp-key')).toHaveText(['ATL', 'WEB', 'SUP', 'MKT']);
    await expect(picker.getByRole('option', { name: /SUP/ }).locator('.jsp-type')).toHaveText('Service');
    await expect(picker.getByRole('option', { name: /SUP/ }).locator('.jsp-type')).toHaveClass(/is-service/);
    await expect(picker.getByRole('option', { name: /ATL/ }).locator('.jsp-type')).toHaveText('Software');
    await expect(picker).toContainText('Not listed? Paste a link to the project or one of its issues.');
    await look(dialog, join(SHOTS, 'jira-picker.png'));
    // ↵ adds the active one (ATL): its row says whose issues and how many (7 of mine are open).
    await win.keyboard.press('Enter');
    await expect(picker).toHaveCount(0);
    const atl = details.locator('.nsrc-row[data-source="10001"]');
    await expect(atl.locator('.jsrc-key')).toHaveText('ATL');
    await expect(atl.locator('.nsrc-name')).toHaveText('Atelier');
    await expect(atl.locator('.jsrc-type')).toHaveText('Software');
    await expect(atl.locator('.nsrc-sub')).toHaveText('Assigned to me · 7 open', { timeout: 15000 });

    // Search "sup": the service project, with its warning line once added.
    await details.locator('.nsrc-head .nsrc-add').click();
    await input.fill('sup');
    await expect(picker.getByRole('option')).toHaveCount(1);
    await expect(picker.getByRole('option', { name: /Customer Support/ })).toHaveAttribute('aria-selected', 'true');
    await win.keyboard.press('Enter');
    await expect(picker).toHaveCount(0);
    const sup = details.locator('.nsrc-row[data-source="10003"]');
    await expect(sup).toHaveClass(/is-service/);
    await expect(sup).toContainText("Customers outside your company write these requests. Automations can't start from them unless you allow it.");
    await expect(sup.locator('.nsrc-sub')).toHaveText('Assigned to me · 1 open', { timeout: 15000 });

    // Again: a chosen one says "Added"; a link from another site is refused in one line; a word finds by name.
    await details.locator('.nsrc-head .nsrc-add').click();
    await expect(picker.getByRole('option', { name: /ATL/ })).toContainText('Added');
    await input.fill('website');
    await expect(picker.locator('.jsp-key')).toHaveText(['WEB']);
    await input.fill('https://other.atlassian.net/browse/OPS-1');
    await expect(picker.getByRole('option')).toHaveText([/Add this project/]);
    await win.keyboard.press('Enter');
    await expect(picker.getByRole('alert')).toHaveText('That link is from another Jira site.');
    await win.keyboard.press('Escape');
    await expect(picker).toHaveCount(0);
    await expect(dialog).toBeVisible();

    // Mine | Everyone (arrow keys, as every segmented control): ATL lists everyone's open issues.
    const scope = atl.getByRole('radiogroup', { name: 'Whose issues in ATL' });
    // Focused once the details settled after the picker closed (a re-render could take the focus back).
    await expect(async () => {
      await scope.getByRole('radio', { name: 'Mine' }).focus();
      await expect(scope.getByRole('radio', { name: 'Mine' })).toBeFocused({ timeout: 200 });
    }).toPass();
    await win.keyboard.press('ArrowRight');
    await expect(scope.getByRole('radio', { name: 'Everyone' })).toHaveAttribute('aria-checked', 'true');
    await expect(atl.locator('.nsrc-sub')).toHaveText('Everyone · 9 open', { timeout: 15000 });
    await expect.poll(() => t.jiraInfo().then((c) => c?.projects?.find((p) => p.key === 'ATL')?.everyone)).toBe(true);

    // The saved filter narrows it (only my open bugs: 2 in ATL), None widens it again.
    const filter = details.getByRole('button', { name: 'Only issues in a saved filter: None' });
    await filter.click();
    await win.getByRole('menuitem', { name: 'My open bugs' }).click();
    await expect(details.getByRole('button', { name: 'Only issues in a saved filter: My open bugs' })).toBeVisible();
    await expect(atl.locator('.nsrc-sub')).toHaveText('Everyone · 2 open', { timeout: 15000 });
    await expect(sup.locator('.nsrc-sub')).toHaveText('Assigned to me · 0 open', { timeout: 15000 });
    await details.locator('.conn-options').scrollIntoViewIfNeeded();
    await look(dialog, join(SHOTS, 'jira-details.png'));
    // The filter is deleted in Jira: the next refresh drops it and says so under the row.
    await t.jira.scenario('filter-gone');
    await details.locator('.conn-actions').getByRole('button', { name: 'Refresh' }).click();
    await expect(details.getByRole('button', { name: 'Only issues in a saved filter: None' })).toBeVisible({ timeout: 15000 });
    await expect(details.getByRole('note').filter({ hasText: 'Your saved filter is gone.' })).toBeVisible();
    await expect(atl.locator('.nsrc-sub')).toHaveText('Everyone · 9 open', { timeout: 15000 });
    await t.jira.scenario('normal');
    // Choosing again (here None) clears the line.
    await details.getByRole('button', { name: 'Only issues in a saved filter: None' }).click();
    await win.getByRole('menuitem', { name: 'None' }).click();
    await expect(details.getByText('Your saved filter is gone.')).toHaveCount(0);

    // The list: two projects and their open issues, the green chip with the site.
    await dialog.getByRole('button', { name: 'Back to Connectors' }).click();
    await expect(row.locator('.conn-chip')).toHaveText('Connected · acme.atlassian.net');
    await expect(row.locator('.conn-row-line')).toContainText('2 projects · 10 open issues');

    // A project that disappears (WEB deleted in Jira): its row turns amber with Remove, the list says so.
    expect(await win.evaluate(`window.atelier.connectors.addSource('jira', 'WEB')`)).toMatchObject({ ok: true, sourceIds: ['10002'] });
    await row.locator('.conn-row-open').click();
    const web = details.locator('.nsrc-row[data-source="10002"]');
    await expect(web.locator('.nsrc-sub')).toHaveText('Assigned to me · 0 open', { timeout: 15000 });
    await t.jira.scenario('project-gone');
    await details.locator('.conn-actions').getByRole('button', { name: 'Refresh' }).click();
    await expect(web).toHaveClass(/is-warn/, { timeout: 15000 });
    await expect(web).toContainText("Atelier can't read this project anymore: it was deleted, archived or you lost access.");
    await expect(atl.locator('.nsrc-sub')).toHaveText('Everyone · 9 open');
    await web.scrollIntoViewIfNeeded();
    await look(dialog, join(SHOTS, 'jira-unreadable.png'));
    await dialog.getByRole('button', { name: 'Back to Connectors' }).click();
    await expect(row.locator('.conn-chip')).toHaveText('1 project needs attention');
    await expect(win.locator('.activity-bar .act-bottom .act-dot')).toHaveCount(1);
    await row.locator('.conn-row-open').click();
    await web.getByRole('button', { name: 'Remove WEB Website' }).click();
    await expect(web).toHaveCount(0);
    await t.jira.scenario('normal');

    // Disconnect (with its confirm and where to revoke it): the row is back to Connect, the saved connection gone.
    await details.locator('.conn-actions').getByRole('button', { name: 'Disconnect' }).click();
    const confirm = details.getByRole('group', { name: 'Disconnect Jira?' });
    await expect(confirm).toContainText('id.atlassian.com › Connected apps');
    await confirm.getByRole('button', { name: 'Disconnect' }).click();
    await expect(details).toHaveAttribute('data-status', 'disconnected');
    await expect(details.getByRole('button', { name: 'Use an API token instead…' })).toBeVisible();
    await expect(details).toContainText('Atlassian Administration › Rovo MCP server');
    expect(existsSync(join(t.home, 'connectors', 'jira.bin'))).toBe(false);
    await t.done();
  } finally {
    await t.close();
  }
});

test('the palette\'s Jira section, a session from ATL-3 (typed, not sent), and the service-project rule in the editor', async () => {
  test.setTimeout(150_000);
  mkdirSync(SHOTS, { recursive: true });
  const t = await launch({ extra: { ATELIER_CLAUDE_BIN: resolve('tests/e2e/fake-claude-prompt.pl'), ATELIER_FAKE_START_DELAY: '1' } });
  const { win } = t;
  try {
    await t.connect();
    // No project yet: the Jira section says what to do instead of rows.
    await palette(win, 'jira:');
    await expect(win.locator('.palette-mode')).toHaveText('jira');
    await expect(section(win, 'Jira').locator('.palette-item .palette-label')).toHaveText(['Choose Jira Projects…']);
    await win.keyboard.press('Escape');
    // A pasted key adds its project (main looks it up); then SUP by link.
    expect(await win.evaluate(`window.atelier.connectors.addSource('jira', 'ATL')`)).toMatchObject({ ok: true, sourceIds: ['10001'] });
    expect(await win.evaluate(`window.atelier.connectors.addSource('jira', 'https://acme.atlassian.net/browse/SUP-1')`)).toMatchObject({ ok: true, sourceIds: ['10003'] });
    await expect.poll(async () => ((await win.evaluate('window.atelier.tasks.list()')) as TaskList[])
      .find((l) => l.source === 'jira')?.tasks.length, { timeout: 15000 }).toBe(8);

    // The command names issues.
    await palette(win, '>Search Jira');
    await expect(win.locator('.palette-item .palette-label', { hasText: 'Search Jira Issues…' })).toHaveCount(1);
    await win.keyboard.press('Escape');

    // jira: → the JIRA section with its glyph; keys in mono, the project as list.
    await palette(win, 'jira:');
    await expect(win.locator('.palette-section')).toHaveText(['Jira']);
    await expect(win.locator('.palette-section svg')).toHaveCount(1);
    const rows = win.locator('.palette-item.task-item');
    await expect(rows).toHaveCount(8);
    const atl3 = rows.filter({ hasText: 'Billing export drops the last row' });
    await expect(atl3.locator('.task-id')).toHaveText('ATL-3');
    await expect(atl3.locator('.task-list')).toHaveText('Atelier');
    await look(win.locator('.palette'), join(SHOTS, 'jira-palette.png'));
    // With text: its search only reaches the chosen projects.
    await win.locator('.palette-input').fill('jira: export');
    await expect(rows).toHaveText([/Billing export drops the last row/]);
    await expect(win.locator('.palette')).toContainText('Only the projects you chose in Settings › Connectors are searched.');

    // Enter → its actions → Start in New Session: named after the key and title, the prompt typed and NOT sent, the chip
    // with the key.
    await win.keyboard.press('Enter');
    await expect(win.locator('.palette-task-head')).toContainText('Billing export drops the last row');
    await win.keyboard.press('Enter');
    await expect(win.locator('.session-row', { hasText: 'ATL-3 Billing export drops the last row' })).toBeVisible({ timeout: 10000 });
    const chip = win.locator('.session-bar .tchip');
    await expect(chip).toHaveText('ATL-3');
    await expect.poll(() => screenText(win), { timeout: 15000 }).toContain(
      'If a Jira MCP server is available, use it to read the whole task (description, comments, subtasks, attachments) before you start.⏎⏎Jira task ATL-3: Billing export drops the last row⏎https://acme.atlassian.net/browse/ATL-3');
    await expect(win.locator('.toast')).toContainText('ATL-3 is in the prompt · press Enter to send');
    // A click puts it away (it would sit over the automation sheet's footer for 5 s).
    await win.locator('.toast').click();
    await expect(win.locator('.toast')).toHaveCount(0);
    await chip.hover();
    await expect(win.locator('.tooltip')).toContainText('To Do · Atelier');
    // Still not sent, the tooltip's delay later.
    expect(await screenText(win)).not.toContain('FAKE-CLAUDE submitted');

    // The automation editor: SUP is a service project, so the automation can't turn on until Created by
    // names people.
    await win.locator('.activity-bar button[aria-label^="Automations"]').click();
    const side = win.locator('.au-side');
    await side.getByRole('button', { name: 'New Automation' }).first().click();
    const sheet = win.getByRole('dialog', { name: 'New automation' });
    await expect(sheet).toBeVisible();
    await expect(sheet.getByRole('radio', { name: 'Jira' })).toHaveAttribute('aria-checked', 'true');
    await sheet.locator('input.ae-input.is-wide').fill('Triage support requests');
    await sheet.getByRole('button', { name: 'Add Project…' }).click();
    const projects = win.locator('.ae-pop');
    await expect(projects.getByRole('option')).toHaveText(['ATL · Atelier', 'SUP · Customer Support'], { timeout: 10000 });
    await projects.getByRole('option', { name: 'SUP · Customer Support' }).click();
    const alert = sheet.locator('.ae-banner.is-err');
    await expect(alert).toHaveText('SUP is a service project. Customers outside your company create its requests, and a request is text Claude will read. Set Created by to people you trust, or remove SUP, to turn this automation on.');
    const turnOn = sheet.getByRole('button', { name: 'Save and Turn On…' });
    await expect(turnOn).toBeDisabled();
    // Matching now lists SUP's requests, each key on one line (a key never wraps at its dash).
    const key = sheet.locator('.ae-match .au-id').first();
    await expect(key).toHaveText(/^SUP-\d$/, { timeout: 10000 });
    expect((await key.boundingBox())!.height).toBeLessThan(20);
    // (No toast over the sheet's footer.)
    await expect(win.locator('.toast')).toHaveCount(0);
    await look(sheet, join(SHOTS, 'jira-automation-alert.png'));
    // Created by (it starts as "me"): the alert goes, the automation may turn on.
    await sheet.getByRole('button', { name: 'Add Condition' }).click();
    await sheet.locator('.ae-cond select').first().selectOption('createdBy');
    await expect(sheet.locator('.ae-cond .ae-vchip')).toHaveText(['Me']);
    await expect(alert).toHaveCount(0);
    await expect(turnOn).toBeEnabled();
    await t.done();
  } finally {
    await t.close();
  }
});

test('Jira with an API token: the form under Connect, a refused token, then connected; Disconnect says where to revoke it', async () => {
  test.setTimeout(120_000);
  mkdirSync(SHOTS, { recursive: true });
  const t = await launch({ apiToken: TOKEN });
  const { app, win } = t;
  try {
    await menu(app, 'Connectors…');
    const dialog = win.getByRole('dialog', { name: 'Settings' });
    await dialog.locator('.conn-row[data-connector="jira"] .conn-row-open').click();
    const details = dialog.locator('.conn-details[data-connector="jira"]');
    await details.getByRole('button', { name: 'Use an API token instead…' }).click();
    const form = details.getByRole('group', { name: 'Sign in with an API token' });
    const site = form.getByLabel('Site');
    await expect(site).toBeFocused();
    await expect(site).toHaveAttribute('placeholder', 'acme.atlassian.net');
    await expect(form.getByLabel('API token')).toHaveAttribute('type', 'password');
    await expect(form).toContainText('Your Atlassian admin must allow API tokens for the Rovo MCP server. Create a token with scopes for the Atlassian MCP V2 app');

    // Checked before anything is sent.
    await form.getByRole('button', { name: 'Connect with Token' }).click();
    await expect(form.getByRole('alert')).toHaveText('Enter your Jira site, like acme.atlassian.net.');

    // The tokens page opens in the browser (through main).
    await form.getByRole('button', { name: 'Open API Tokens Page' }).click();
    await expect.poll(() => t.urls()).toContain(TOKENS_PAGE);

    // A wrong token: Jira refuses it, the form says so and the token field is empty again.
    await site.fill('acme.atlassian.net');
    await form.getByLabel('E-mail').fill(TOKEN.email);
    await form.getByLabel('API token').fill('ATATT3xFfGF0-not-the-right-one-000');
    await look(dialog, join(SHOTS, 'jira-token-form.png'));
    await form.getByRole('button', { name: 'Connect with Token' }).click();
    await expect(form.getByLabel('API token')).toHaveValue('');
    await expect(form.getByRole('alert')).toHaveText('Jira refused this API token. Check the e-mail, the site, and that the token is for the Atlassian MCP V2 app.', { timeout: 15000 });
    await expect(details).toHaveAttribute('data-status', 'disconnected');

    // What was typed stays (only the token goes); the right one with ↵: connected, nothing chosen yet; the form is gone.
    await expect(site).toHaveValue('acme.atlassian.net');
    await expect(form.getByLabel('E-mail')).toHaveValue(TOKEN.email);
    await form.getByLabel('API token').fill(TOKEN.token);
    await win.keyboard.press('Enter');
    await expect(details).toHaveAttribute('data-status', 'connected', { timeout: 15000 });
    await expect(form).toHaveCount(0);
    await expect(details.locator('.conn-status')).toContainText('Connected as Ada Lovelace · acme.atlassian.net');
    await expect(details.locator('.nsrc-empty-title')).toHaveText('No projects yet');
    expect(await t.jiraInfo()).toMatchObject({ signIn: 'token', tokenUser: TOKEN.email });

    // Disconnect: nothing to revoke from here; the copy says where the token lives.
    await details.locator('.conn-actions').getByRole('button', { name: 'Disconnect' }).click();
    const confirm = details.getByRole('group', { name: 'Disconnect Jira?' });
    await expect(confirm).toContainText('Atelier deletes its copy of the API token. To revoke the token itself, open id.atlassian.com › Security › API tokens.');
    await confirm.getByRole('button', { name: 'Disconnect' }).click();
    await expect(details).toHaveAttribute('data-status', 'disconnected');
    expect(existsSync(join(t.home, 'connectors', 'jira.bin'))).toBe(false);
    await t.done();
  } finally {
    await t.close();
  }
});
