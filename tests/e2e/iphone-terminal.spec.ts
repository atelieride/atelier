// A terminal a paired phone has open, in the window: a phone's size larger than its pane is clipped by the pane, its
// bottom rows (the prompt, the newest output) and the "Sized for iPhone" note in view; shown again from another tab,
// the terminal takes the window's size with no flash of the phone's; the phone badge never widens a tab or moves what
// a row shows; the footer pill keeps clear of the rest of the footer in the narrowest window.
import { expect, test, type Locator, type Page } from '@playwright/test';
import type { RemoteDeviceInfo, RemoteStatus } from '../../src/shared/remote';
import { look } from './shots';
import { layoutProblems } from './layout';
import { close, command, launchProject, launchWithPhone, menu, pairPhone, settingsSet, stopDaemon } from './iphone-fixture';

const SHOTS = 'test-results/iphone-terminal';

type TermApi = { atelier: { terminals: { list(): Promise<{ id: string; createdAt: number }[]>; rename(id: string, name: string): Promise<unknown> } } };

/** The id of the window's only terminal, renamed so the pane picker and the tabs can tell it from others. */
async function firstTerminal(win: Page, name: string): Promise<string> {
  const id = (await win.locator('[data-term-row]').first().getAttribute('data-term-row'))!;
  await win.evaluate(([id, name]) => (window as unknown as TermApi).atelier.terminals.rename(id!, name!), [id, name]);
  await expect(win.locator('.tab .tab-name')).toHaveText(name);
  return id;
}

/** A second terminal, in front, at its prompt. */
async function secondTerminal(win: Page, app: Parameters<typeof command>[0]): Promise<void> {
  await command(app, 'new-terminal');
  await expect(win.locator('.tab')).toHaveCount(2, { timeout: 10000 });
  await expect(win.locator('.terminal-slot:visible .xterm-rows').last()).toContainText('›', { timeout: 15000 });
}

const box = async (l: Locator) => (await l.boundingBox())!;
/** Whether the element drawn at (x, y) is part of `slot`'s terminal (its xterm). */
const terminalAt = (slot: Locator, x: number, y: number) => slot.evaluate((el, [x, y]) => {
  const hit = document.elementFromPoint(x!, y!);
  return !!hit && el.contains(hit) && !!hit.closest('.xterm');
}, [x, y]);

test('a phone\'s size taller and wider than its pane: the pane clips it, keeping the prompt, the newest output and the note in view', async () => {
  test.setTimeout(180_000);
  const l = await launchWithPhone({}, { size: [1280, 800] });
  const { app, win, phone } = l;
  try {
    const alpha = await firstTerminal(win, 'Alpha');
    await secondTerminal(win, app);
    // Two panes stacked: Alpha in the lower one, a few hundred pixels tall. Split before pairing: the window has long
    // given Alpha the pane's size when the phone opens it (the last view to ask owns the size).
    await menu(app, 'Split Down');
    await win.locator('.pane-picker .pp-item', { hasText: 'Alpha' }).click();
    await expect(win.locator('.terminal-slot:visible')).toHaveCount(2);
    await pairPhone(app, win, phone);

    // The phone opens Alpha at a size far larger than the pane, and fills its screen to the last row.
    await phone.state((s) => (s.sessions as { id: string }[]).some((x) => x.id === alpha), 10000);
    expect(await phone.attach(alpha, 160, 48)).toMatchObject({ t: 'snapshot', id: alpha, cols: 160, rows: 48 });
    phone.input(alpha, "clear; for i in $(seq 1 60); do echo line-$i; done\r");
    const slot = win.locator('.terminal-slot:visible').filter({ hasText: 'line-60' });
    await expect(slot).toHaveCount(1, { timeout: 10000 });
    const rows = slot.locator('.xterm-rows');
    await expect(rows.locator(':scope > div')).toHaveCount(48);
    const note = slot.locator('.size-note');
    await expect(note).toContainText('Sized for iPhone');
    await win.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    await look(win, `${SHOTS}/clipped-split.png`, { settle: 400 });

    const host = await box(slot.locator('.terminal-host'));
    const screen = await box(slot.locator('.xterm-screen'));
    expect(screen.height, 'drawn at the phone\'s 48 rows').toBeGreaterThan(host.height + 50);
    expect(screen.width, 'drawn at the phone\'s 160 columns').toBeGreaterThan(host.width + 50);
    // The bottom rows are the ones in view: the prompt's row and the newest output inside the pane, the oldest rows
    // above it, cut off; the left edge where it always is.
    const last = await box(rows.locator(':scope > div').last());
    const newest = await box(rows.locator(':scope > div', { hasText: 'line-60' }));
    for (const [what, r] of [['the last row', last], ['line-60', newest]] as const) {
      expect(r.y, what).toBeGreaterThanOrEqual(host.y - 1);
      expect(r.y + r.height, what).toBeLessThanOrEqual(host.y + host.height + 1);
    }
    expect((await box(rows.locator(':scope > div').first())).y).toBeLessThan(host.y);
    expect(Math.abs(screen.x - host.x)).toBeLessThan(1);
    // Nothing of it drawn past the pane's text area: below it and right of it, the slot's own margin shows.
    expect(await terminalAt(slot, host.x + 40, host.y + host.height + 4), 'below').toBe(false);
    expect(await terminalAt(slot, host.x + host.width + 4, host.y + host.height / 2), 'right').toBe(false);
    // The note and its Fit to Window in view, on top, and Fit to Window gives the terminal the pane's size back.
    const fit = note.getByRole('button', { name: 'Fit to Window' });
    const f = await box(fit);
    const s = await box(slot);
    expect(f.y + f.height).toBeLessThanOrEqual(s.y + s.height);
    expect(f.x + f.width).toBeLessThanOrEqual(s.x + s.width);
    expect(await fit.evaluate((el) => { const r = el.getBoundingClientRect(); return el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)); })).toBe(true);
    await settingsSet(win, { theme: 'daylight' });
    await look(win, `${SHOTS}/clipped-split-light.png`, { settle: 400 });
    const since = phone.messages.length;
    await fit.click();
    await expect(note).toHaveCount(0);
    expect((await phone.waitFor((m) => m.t === 'size' && m.id === alpha, { since, ms: 10000 })).rows).toBeLessThan(48);
    await expect(rows.locator(':scope > div')).not.toHaveCount(48);
    const fitted = await box(slot.locator('.xterm-screen'));
    expect(fitted.height).toBeLessThanOrEqual(host.height + 1);
  } finally {
    await close(l);
  }
});

test('shown again from another tab, a terminal a phone sized takes the window\'s size with no flash of the phone\'s', async () => {
  test.setTimeout(180_000);
  const l = await launchWithPhone({}, { size: [1280, 800] });
  const { app, win, phone } = l;
  try {
    await pairPhone(app, win, phone);
    const alpha = await firstTerminal(win, 'Alpha');
    await phone.state((s) => (s.sessions as { id: string }[]).some((x) => x.id === alpha), 10000);
    expect(await phone.attach(alpha, 50, 12)).toMatchObject({ t: 'snapshot', id: alpha });
    await expect(win.locator('.terminal-slot:visible .size-note')).toContainText('Sized for iPhone');
    await expect(win.locator('.terminal-slot:visible .xterm-rows > div')).toHaveCount(12);
    // Another tab in front; Alpha keeps the phone's size behind it.
    await secondTerminal(win, app);
    await expect(win.locator('.terminal-slot:visible .size-note')).toHaveCount(0);

    // Every change to what Alpha's view draws, from the moment it is shown again.
    await win.evaluate(() => {
      const g = window as unknown as { seen: { notes: number; rows: number[] } };
      g.seen = { notes: 0, rows: [] };
      new MutationObserver((list) => {
        for (const m of list) for (const n of m.addedNodes) if (n instanceof HTMLElement && n.matches('.size-note, :has(.size-note)')) g.seen.notes++;
      }).observe(document.body, { subtree: true, childList: true });
      const shown = () => [...document.querySelectorAll<HTMLElement>('.terminal-slot')].find((s) => s.style.display !== 'none' && s.querySelector('.xterm-rows'));
      const rowsOf = [...document.querySelectorAll<HTMLElement>('.terminal-slot .xterm-rows')];
      for (const r of rowsOf) new MutationObserver(() => { if (shown()?.contains(r)) g.seen.rows.push(r.children.length); }).observe(r, { childList: true });
    });
    const since = phone.messages.length;
    await win.locator('.tab', { hasText: 'Alpha' }).click();
    // The window takes the size back as it shows the terminal: the phone is told.
    expect((await phone.waitFor((m) => m.t === 'size' && m.id === alpha, { since, ms: 10000 })).rows).toBeGreaterThan(12);
    await expect(win.locator('.terminal-slot:visible .xterm-rows > div')).not.toHaveCount(12);
    // Main's news that no phone owns Alpha's size any more reached the window (a round trip after the phone's), then
    // two frames for what it changes.
    await win.evaluate(() => (window as unknown as { atelier: { remote: { status(): Promise<unknown> } } }).atelier.remote.status());
    await win.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    const seen = await win.evaluate(() => (window as unknown as { seen: { notes: number; rows: number[] } }).seen);
    expect(seen.notes, 'the size note never showed').toBe(0);
    expect(seen.rows, 'never drawn at the phone\'s 12 rows').not.toContain(12);
    await expect(win.locator('.terminal-slot:visible .size-note')).toHaveCount(0);
  } finally {
    await close(l);
  }
});

test('the phone badge never widens a tab nor moves what a terminal\'s row shows', async () => {
  test.setTimeout(180_000);
  const l = await launchWithPhone({}, { size: [1280, 800] });
  const { app, win, phone } = l;
  try {
    await pairPhone(app, win, phone);
    const alpha = await firstTerminal(win, 'Alpha');
    await secondTerminal(win, app);
    // The pointer away from the tabs and the rows (a hovered tab shows its close button).
    await win.mouse.move(900, 500);
    const tab = win.locator('.tab', { hasText: 'Alpha' });
    const next = win.locator('.tab').nth(1);
    const row = win.locator(`[data-term-row="${alpha}"]`);
    const measure = async () => ({ tab: await box(tab), next: await box(next), name: await box(row.locator('.term-name')), cmd: await box(row.locator('.term-cmd')), row: await box(row) });
    const before = await measure();

    await phone.state((s) => (s.sessions as { id: string }[]).some((x) => x.id === alpha), 10000);
    await phone.attach(alpha, 50, 20);
    await expect(tab.locator('.phone-badge')).toBeVisible();
    await expect(row.locator('.phone-badge')).toBeVisible();
    await win.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    const after = await measure();
    await look(win.locator('.tabs'), `${SHOTS}/badge-tab.png`, { settle: 300 });
    await look(row, `${SHOTS}/badge-row.png`, { settle: 100 });
    expect(after.tab.width, 'the tab keeps its width').toBeCloseTo(before.tab.width, 0);
    expect(after.next.x, 'the tab after it stays put').toBeCloseTo(before.next.x, 0);
    expect(after.row.height).toBeCloseTo(before.row.height, 0);
    expect(after.name.x).toBeCloseTo(before.name.x, 0);
    expect(after.cmd.x, 'the command stays put').toBeCloseTo(before.cmd.x, 0);
    // Hovered, the tab shows its close button where the badge was, still at the same width.
    await tab.hover();
    await expect(tab.locator('.tab-close')).toBeVisible();
    expect((await box(tab)).width).toBeCloseTo(before.tab.width, 0);
    await look(win.locator('.tabs'), `${SHOTS}/badge-tab-hover.png`, { settle: 300 });
    // The same in a light theme, the pointer away.
    await settingsSet(win, { theme: 'daylight' });
    await win.mouse.move(900, 500);
    await look(win.locator('.tabs'), `${SHOTS}/badge-tab-light.png`, { settle: 400 });
  } finally {
    await close(l);
  }
});

const device = (o: Partial<RemoteDeviceInfo>): RemoteDeviceInfo => ({ id: 'dev-1', name: 'Test iPhone', model: 'iPhone17,1', pairedAt: Date.now() - 86_400_000, lastSeenAt: Date.now(), connected: true, attached: [], ...o });
const statusOf = (o: Partial<RemoteStatus>): RemoteStatus => ({ enabled: true, available: true, relay: { state: 'online' }, devices: [], sized: [], ...o });

test('the footer pill in the narrowest window: nothing in the footer overlaps, wraps or is cut', async () => {
  test.setTimeout(120_000);
  const { app, win, home } = await launchProject({}, { size: [960, 600] });
  try {
    // Two phones connected, as main tells every window.
    const status = statusOf({ devices: [device({}), device({ id: 'dev-2', name: 'iPhone', model: 'iPhone15,4' })] });
    await app.evaluate(({ BrowserWindow }, s) => { for (const w of BrowserWindow.getAllWindows()) w.webContents.send('ev:remote', s); }, status);
    const pill = win.locator('.foot-iphone');
    await expect(pill).toHaveText('2 iPhones');
    // Named as Settings › iPhone names them: the phone iOS only calls "iPhone" by its model.
    await expect(pill).toHaveAttribute('data-tip', 'Connected now: Test iPhone, iPhone 15');
    await expect(pill).toHaveAccessibleName('2 iPhones connected: Test iPhone, iPhone 15');
    const footer = win.locator('.footer');
    await look(footer, `${SHOTS}/pill-narrow.png`, { settle: 300 });
    const problems = await layoutProblems(footer, ['.foot-item', '.foot-iphone', '.foot-update', '.foot-dim', '.footer-warn', '.footer-action', '.db-foot']);
    expect(problems).toEqual({ overlaps: [], outside: [], wrapped: [], clipped: [] });
    const p = await box(pill);
    const f = await box(footer);
    expect(p.x + p.width).toBeLessThanOrEqual(f.x + f.width);
    await settingsSet(win, { theme: 'daylight' });
    await look(footer, `${SHOTS}/pill-narrow-light.png`, { settle: 400 });
  } finally {
    await app.close();
    stopDaemon(home);
  }
});
