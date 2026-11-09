import { expect, test, type Locator, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { PgServer } from '../support/pg-server';
import { SHOTS, connRow, dbIcon, front, gridRows, launchDb, openDbView, relRow, shot, stopDb, tabOf } from './databases-fixture';

// Connections end to end: Add Connection by URL with Test, a wrong password then
// the right one, production's frame, a server that stops and comes back, Remove; the sidebar's password note, its keys,
// a pasted URL; where the keyboard goes when the sheet closes; the remembered pick and an explicit Disconnect.

const PASSWORD = 's3cret-pg';

test.beforeAll(() => { mkdirSync(SHOTS, { recursive: true }); });

const sheet = (win: Page) => win.locator('.db-sheet');
const ctx = (win: Page) => win.locator('.ctx-menu').first();
/** Focus is on this element (or, for a locator, the element it resolves to). */
const focusedIs = (el: Locator) => el.evaluate((e) => e === document.activeElement);
/** A text pasted in the page (⌘V's paste event, with its text): never the real clipboard. */
async function pasteInto(target: Locator, text: string): Promise<void> {
  await target.evaluate((el, t) => {
    const dt = new DataTransfer();
    dt.setData('text/plain', t);
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  }, text);
}

test('Add Connection by URL: Test says the password is wrong, then Connected in; Save and Connect; production frames the tab and the footer; a stopped server, Try Again; Remove', async () => {
  test.setTimeout(150_000);
  const server = await PgServer.start({ password: PASSWORD });
  // No connection saved: Settings › Always shows the icon anyway.
  const l = await launchDb(server, { prefs: { showDatabases: 'always' } });
  const { win } = l;
  try {
    await expect(dbIcon(win)).toBeVisible({ timeout: 20000 });
    await dbIcon(win).click();
    const plus = win.locator('.db-side .sidebar-head').getByRole('button', { name: 'Add Connection…' });
    await plus.click();
    await expect(sheet(win)).toBeVisible();
    const url = sheet(win).getByLabel('Connection URL');
    await expect(url).toBeFocused();
    await url.fill(`postgres://postgres@127.0.0.1:${server.port}/postgres`);
    await shot(win, 'db-add-url');
    await sheet(win).getByRole('button', { name: 'Continue' }).click();
    // Step 2: the form, filled from the URL; the password asked first.
    await expect(sheet(win).getByLabel('Host')).toHaveValue('127.0.0.1');
    await expect(sheet(win).getByLabel('Port')).toHaveValue(String(server.port));
    const pw = sheet(win).getByLabel('Password');
    await expect(pw).toBeFocused();
    await pw.fill('wrong-password');
    await sheet(win).getByRole('button', { name: 'Test Connection' }).click();
    await expect(sheet(win).locator('.db-sheet-note.is-err')).toContainText('Wrong user or password', { timeout: 15000 });
    await shot(win, 'db-add-wrong');
    await pw.fill(PASSWORD);
    await sheet(win).getByRole('button', { name: /^Test (Connection|Again)$/ }).click();
    await expect(sheet(win).locator('.db-sheet-note.is-ok')).toContainText(/Connected in [\d,]+ ms/, { timeout: 15000 });
    await expect(sheet(win).locator('.db-sheet-note.is-ok')).toContainText('role postgres');
    // Production: its tabs framed in the theme's danger color.
    await sheet(win).getByRole('radio', { name: 'Production' }).click();
    await expect(sheet(win)).toContainText('Production frames its tabs in the theme’s danger color.');
    await shot(win, 'db-add-form');
    await sheet(win).getByRole('button', { name: 'Save and Connect' }).click();
    await expect(sheet(win)).toHaveCount(0);
    const row = connRow(win, 'postgres');
    await expect(row).toHaveClass(/is-prod/);
    await expect(row.locator('.db-env')).toHaveText('Prod');
    await expect(relRow(win, 'orders')).toBeVisible({ timeout: 20000 });
    // The tab: framed; its content's top hairline.
    await relRow(win, 'orders').click();
    await expect(tabOf(win, 'orders')).toHaveClass(/is-prod/);
    await expect(gridRows(front(win)).first()).toBeVisible({ timeout: 15000 });
    // The footer item: the danger color (its text tone), on hover too.
    const foot = win.locator('.db-foot-item');
    await expect(foot).toHaveClass(/is-prod/);
    const red = await win.evaluate(() => {
      const probe = document.createElement('span');
      probe.style.color = 'var(--text-error)';
      document.body.append(probe);
      const c = getComputedStyle(probe).color;
      probe.remove();
      return c;
    });
    await expect(foot).toHaveCSS('color', red);
    await foot.hover();
    await expect(foot).toHaveCSS('color', red);
    await shot(win, 'db-prod');

    // The server stops: the refusal under the row, with Try Again; back, Try Again connects.
    await server.stopListening();
    await row.click({ button: 'right' });
    await ctx(win).getByRole('menuitem', { name: 'Disconnect' }).click();
    await expect(row).toHaveClass(/is-idle/, { timeout: 10000 });
    await row.click();
    const note = win.locator('.db-note.is-err');
    // "Can't connect · connection refused <host:port>": the title, the detail under it.
    await expect(note.locator('.db-note-title')).toHaveText('Can\'t connect', { timeout: 15000 });
    await expect(note.locator('.db-note-detail')).toContainText(`connection refused 127.0.0.1:${server.port}`);
    await expect(note.getByRole('button', { name: 'Try Again' })).toBeVisible();
    await shot(win, 'db-refused');
    // Still down: Try Again says so again.
    await note.getByRole('button', { name: 'Try Again' }).click();
    await expect(note.locator('.db-note-detail')).toContainText('connection refused', { timeout: 15000 });
    await server.resume();
    await note.getByRole('button', { name: 'Try Again' }).click();
    await expect(row).toHaveClass(/is-connected/, { timeout: 15000 });
    await expect(note).toHaveCount(0);

    // Remove Connection…: asked in place; its tabs close with it.
    await row.click({ button: 'right' });
    await ctx(win).getByRole('menuitem', { name: 'Remove Connection…' }).click();
    const ask = win.locator('.confirm-pop', { hasText: 'Remove postgres?' });
    await expect(ask).toBeVisible();
    await expect(ask).toContainText('Its saved password goes too.');
    await shot(win, 'db-remove');
    await ask.getByRole('button', { name: 'Remove' }).click();
    await expect(connRow(win, 'postgres')).toHaveCount(0);
    await expect(tabOf(win, 'orders')).toHaveCount(0);
  } finally {
    await stopDb(l);
    await server.stop();
  }
});

test('the sidebar: a password typed wrong stays selected and the row keeps its height, the right one connects; ↑/↓; a pasted URL; the keyboard back where the sheet came from; Disconnect holds; the pick reconnects', async () => {
  test.setTimeout(180_000);
  const server = await PgServer.start({ password: PASSWORD });
  // Added by URL without its password (none typed in the sheet): it needs one.
  const l = await launchDb(server);
  const { win } = l;
  let again = l;
  try {
    // The URL put in and Enter pressed the moment the sheet appears (a snippet, dictation; Playwright's fill under load):
    // an Enter after text typed in the sheet is its answer, never swallowed as one meant for what came before.
    await openDbView(l);
    await win.evaluate(() => {
      (window as unknown as { urlField: Promise<void> }).urlField = new Promise<void>((done) => {
        const seen = new MutationObserver(() => { if (document.getElementById('db-f-url')) { seen.disconnect(); done(); } });
        seen.observe(document.body, { childList: true, subtree: true });
      });
    });
    await win.locator('.db-side .sidebar-head').getByRole('button', { name: 'Add Connection…' }).click();
    await win.evaluate(() => (window as unknown as { urlField: Promise<void> }).urlField);
    const url = sheet(win).getByLabel('Connection URL');
    await url.fill(l.url!);
    await url.press('Enter');
    await expect(sheet(win).getByLabel('Host')).toHaveValue('127.0.0.1');
    await sheet(win).getByRole('button', { name: 'Save and Connect' }).click();
    await expect(sheet(win)).toHaveCount(0);
    const row = connRow(win, 'postgres');
    await expect(row.locator('.db-conn-sub')).toHaveText('needs a password', { timeout: 15000 });
    const field = win.getByRole('textbox', { name: 'Password for postgres' }).or(win.locator('.db-pass-input'));
    await expect(field).toBeVisible();
    const note = win.locator('.db-note.is-pass');
    const connect = note.getByRole('button', { name: 'Connect' });
    await field.fill('not-it');
    await connect.click();
    await expect(note.locator('.db-note-err')).toHaveText('Wrong user or password', { timeout: 15000 });
    // The typed text stays, selected, the field focused.
    await expect(field).toHaveValue('not-it');
    await expect(field).toBeFocused();
    expect(await field.evaluate((e) => [(e as HTMLInputElement).selectionStart, (e as HTMLInputElement).selectionEnd])).toEqual([0, 6]);
    await shot(win, 'db-password-wrong');
    // A second wrong password: while Connect runs (aria-busy) the note keeps its height — the refusal stays said, no
    // line comes or goes — and the field its text. Every change to the note recorded as it happens.
    await field.fill('still-not-it');
    await note.evaluate((el) => {
      const w = window as unknown as { atlNote: { h: number; busy: boolean }[] };
      w.atlNote = [];
      const take = () => w.atlNote.push({ h: el.getBoundingClientRect().height, busy: el.querySelector('button[type="submit"]')?.getAttribute('aria-busy') === 'true' });
      take();
      new MutationObserver(take).observe(el, { subtree: true, childList: true, attributes: true, characterData: true });
      new ResizeObserver(take).observe(el);
    });
    await connect.click();
    await expect(field).toBeFocused({ timeout: 15000 });
    await expect(note.locator('.db-note-err')).toHaveText('Wrong user or password');
    const seen = await win.evaluate(() => (window as unknown as { atlNote: { h: number; busy: boolean }[] }).atlNote);
    expect(seen.some((s) => s.busy), 'the note was watched while Connect ran').toBe(true);
    expect([...new Set(seen.map((s) => Math.round(s.h * 2) / 2))], 'the note\'s height through the second try').toEqual([Math.round(seen[0]!.h * 2) / 2]);
    await expect(field).toHaveValue('still-not-it');
    await field.fill('');
    await win.keyboard.type(PASSWORD);
    await win.keyboard.press('Enter');
    await expect(row).toHaveClass(/is-connected/, { timeout: 15000 });
    await expect(relRow(win, 'orders')).toBeVisible({ timeout: 15000 });

    // ↑/↓ through the rows: the connection, then the catalog's.
    await row.focus();
    await win.keyboard.press('ArrowDown');
    expect(await win.evaluate(() => (document.activeElement as HTMLElement | null)?.matches('[data-nav]') ?? false)).toBe(true);
    expect(await focusedIs(row)).toBe(false);
    await win.keyboard.press('ArrowUp');
    expect(await focusedIs(row)).toBe(true);

    // + : the sheet; closed, the keyboard back on +.
    const plus = win.locator('.db-side .sidebar-head').getByRole('button', { name: 'Add Connection…' });
    await plus.focus();
    await win.keyboard.press('Enter');
    await expect(sheet(win)).toBeVisible();
    await win.keyboard.press('Escape');
    await expect(sheet(win)).toHaveCount(0);
    await expect(plus).toBeFocused();
    // A postgres:// URL pasted in the sidebar: Add Connection at its form; closed, the keyboard back on the row.
    await row.focus();
    await pasteInto(row, `postgresql://reader@db.example.neon.tech:5432/shop?sslmode=require`);
    await expect(sheet(win).getByLabel('Host')).toHaveValue('db.example.neon.tech');
    await expect(sheet(win).getByLabel('Database')).toHaveValue('shop');
    await expect(sheet(win).locator('.db-chip', { hasText: 'Neon' })).toBeVisible();
    await shot(win, 'db-pasted');
    await sheet(win).getByRole('button', { name: 'Cancel' }).click();
    await expect(sheet(win)).toHaveCount(0);
    await expect(row).toBeFocused();
    // Edit Connection… from the row's menu: another host asks for the password again; closed, back on the row.
    await row.click({ button: 'right' });
    await ctx(win).getByRole('menuitem', { name: 'Edit Connection…' }).click();
    await expect(sheet(win)).toBeVisible();
    await expect(sheet(win).getByLabel('Password')).toHaveAttribute('placeholder', '•••• saved');
    await sheet(win).getByLabel('Host').fill('localhost');
    await expect(sheet(win)).toContainText('Type the password for the new server');
    await shot(win, 'db-edit-new-server');
    await win.keyboard.press('Escape');
    await expect(sheet(win)).toHaveCount(0);
    await expect(row).toBeFocused();

    // Disconnect: it stays closed through a switch of views and back.
    await row.click({ button: 'right' });
    await ctx(win).getByRole('menuitem', { name: 'Disconnect' }).click();
    await expect(row).toHaveClass(/is-idle/);
    await win.locator('.activity-bar .act').first().click();
    await dbIcon(win).click();
    await expect(row).toHaveClass(/is-idle/);
    await expect(row.locator('.db-conn-sub')).toHaveText(/· not connected$/);
    await stopDb(l, false);

    // After a restart, the remembered pick connects when the view is shown.
    again = await launchDb(server, { again: { home: l.home, root: l.root, env: l.env } });
    const w2 = again.win;
    await expect(dbIcon(w2)).toBeVisible({ timeout: 20000 });
    await dbIcon(w2).click();
    await expect(connRow(w2, 'postgres')).toHaveClass(/is-connected/, { timeout: 15000 });
    await expect(relRow(w2, 'orders')).toBeVisible({ timeout: 15000 });
  } finally {
    await stopDb(again);
    await server.stop();
  }
});

