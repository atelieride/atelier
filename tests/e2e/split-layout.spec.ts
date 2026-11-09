import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { e2eEnv } from './env';
import { look } from './shots';

// Split view with tab groups: Open to the Side, a tab's moves between panes,
// the pane's menu, dragging tabs between strips and panes, the dividers, and the layout — every pane's tabs, files
// included — saved per project and restored when the app comes back (atelierd kept the terminals).

const SHOTS = 'test-results';
type Api = { terminals: { list(): Promise<{ id: string; title: string; createdAt: number }[]>; rename(id: string, name: string | null): Promise<void> } };

const still = (win: Page) => win.addStyleTag({ content: '*, *::before, *::after { animation: none !important; transition: none !important; } .xterm-cursor-layer { display: none !important; }' });

async function stop(app: ElectronApplication, home: string) {
  await app.close().catch(() => {});
  try { process.kill((JSON.parse(readFileSync(join(home, 'atelierd.json'), 'utf8')) as { pid: number }).pid, 'SIGTERM'); } catch { /* already stopped */ }
}

async function menu(app: ElectronApplication, label: string) {
  await app.evaluate(({ Menu, BrowserWindow }, l) => {
    const walk = (items: Electron.MenuItem[]): Electron.MenuItem | undefined => {
      for (const it of items) { if (it.label === l) return it; const sub = it.submenu ? walk(it.submenu.items) : undefined; if (sub) return sub; }
      return undefined;
    };
    walk(Menu.getApplicationMenu()!.items)!.click(undefined, BrowserWindow.getAllWindows()[0]);
  }, label);
}

/** Each strip's tab names, left to right (one pane: the one strip). */
const strips = (win: Page) => win.evaluate(() => {
  const bars = [...document.querySelectorAll<HTMLElement>('.pane-strip')].sort((a, b) => Number(a.dataset.pane) - Number(b.dataset.pane));
  const of = (el: Element) => [...el.querySelectorAll('.tab .tab-name')].map((n) => n.textContent ?? '');
  const one = document.querySelector('.tabs');
  return bars.length ? bars.map(of) : one ? [of(one)] : [];
});
/** Each pane's tab in front, left to right. */
const fronts = (win: Page) => win.evaluate(() => [...document.querySelectorAll<HTMLElement>('.pane-strip')]
  .sort((a, b) => Number(a.dataset.pane) - Number(b.dataset.pane))
  .map((s) => s.querySelector('.tab.is-active .tab-name, .tab.is-front .tab-name')?.textContent ?? ''));
/** Each pane's content width (its frame), left to right. */
const widths = (win: Page) => win.evaluate(() => [...document.querySelectorAll<HTMLElement>('.workspace-body > .pane-frame')]
  .sort((a, b) => Number(a.dataset.pane) - Number(b.dataset.pane)).map((f) => f.getBoundingClientRect().width));
const focusedIndex = (win: Page) => win.evaluate(() => [...document.querySelectorAll<HTMLElement>('.pane-strip')]
  .sort((a, b) => Number(a.dataset.pane) - Number(b.dataset.pane)).findIndex((s) => s.classList.contains('is-focused')));
const termCount = (win: Page) => win.evaluate(async () => (await (window as unknown as { atelier: Api }).atelier.terminals.list()).length);
const strip = (win: Page, i: number) => win.locator(`.pane-strip[data-pane="${i}"]`);

async function launch(env: Record<string, string>, project: string) {
  const app = await electron.launch({ args: ['out/main/index.js', `--project=${project}`], env });
  const win = await app.firstWindow();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(1280, 800));
  return { app, win };
}

/** Plain terminals named in order (the last one in front). */
async function terminals(app: ElectronApplication, win: Page, names: string[]) {
  for (const [i, name] of names.entries()) {
    if (i === 0) await win.getByRole('button', { name: 'Open a terminal' }).click();
    else await menu(app, 'New Terminal');
    await expect(win.locator('.tab')).toHaveCount(i + 1, { timeout: 10000 });
    await expect(win.locator('.terminal-slot:visible .xterm-rows')).toContainText('›', { timeout: 15000 });
    await win.evaluate(async ([n, at]) => {
      const api = (window as unknown as { atelier: Api }).atelier;
      const list = (await api.terminals.list()).sort((a, b) => a.createdAt - b.createdAt);
      await api.terminals.rename(list[at as number]!.id, n as string);
    }, [name, i]);
    await expect(win.locator('.tab.is-active')).toHaveText([new RegExp(name)]);
  }
}

/** Starts dragging a tab and moves over (x, y); the caller releases it (`win.mouse.up()`). */
async function dragTab(win: Page, tab: string, x: number, y: number) {
  const box = (await win.locator('.tab', { hasText: tab }).boundingBox())!;
  await win.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await win.mouse.down();
  await win.mouse.move(box.x + box.width / 2 + 20, box.y + box.height / 2 + 30, { steps: 4 });
  await win.mouse.move(x, y, { steps: 8 });
}

async function tabMenu(win: Page, tab: string, item: string) {
  await win.locator('.tab', { hasText: tab }).click({ button: 'right' });
  await win.getByRole('menuitem', { name: new RegExp(`^${item}`) }).click();
}

test('open to the side, a tab\'s moves, the pane\'s menu and Split Right; tabs dragged between strips and panes', async () => {
  const project = mkdtempSync(join(tmpdir(), 'atl-prj-'));
  const { env, home } = e2eEnv();
  const { app, win } = await launch(env, project);
  try {
    await terminals(app, win, ['Alpha', 'Bravo', 'Charlie']);
    // One pane: the bar as it was (no strips, no pane tools).
    await expect(win.locator('.pane-split, .pane-strip')).toHaveCount(0);

    // A row's menu: Alpha moves out to a new pane on the right, focused.
    await win.locator('.term-row', { hasText: 'Alpha' }).click({ button: 'right' });
    await win.getByRole('menuitem', { name: /Open to the Side/ }).click();
    await expect.poll(() => strips(win)).toEqual([['Bravo', 'Charlie'], ['Alpha']]);
    expect(await focusedIndex(win)).toBe(1);
    await expect(win.locator('.tab.is-active')).toHaveText([/Alpha/]);

    // A tab's menu: Bravo to the right pane (its end, in front there); then Alpha to a new pane on the right.
    await tabMenu(win, 'Bravo', 'Move to Right Pane');
    await expect.poll(() => strips(win)).toEqual([['Charlie'], ['Alpha', 'Bravo']]);
    expect(await fronts(win)).toEqual(['Charlie', 'Bravo']);
    await tabMenu(win, 'Alpha', 'Move to New Pane Right');
    await expect.poll(() => strips(win)).toEqual([['Charlie'], ['Bravo'], ['Alpha']]);
    expect(await focusedIndex(win)).toBe(2);
    // At three panes Split Right stays, quiet, and says why.
    await expect(strip(win, 0).locator('.pane-split')).toHaveAttribute('aria-disabled', 'true');
    await expect(strip(win, 0).locator('.pane-split')).toHaveAttribute('data-tip', 'Up to three panes side by side');

    // The pane's menu on its strip's empty part (the press focuses that pane): Unsplit on the first one. Its tab joins
    // the right neighbour, before that pane's own; the neighbour's front stays in front.
    const s0 = (await strip(win, 0).boundingBox())!;
    await win.mouse.click(s0.x + s0.width - 90, s0.y + s0.height / 2, { button: 'right' });
    await expect(win.getByRole('menuitem', { name: /Split Right/ })).toHaveAttribute('aria-disabled', 'true');
    await win.getByRole('menuitem', { name: 'Unsplit', exact: true }).click();
    await expect.poll(() => strips(win)).toEqual([['Charlie', 'Bravo'], ['Alpha']]);
    expect(await focusedIndex(win)).toBe(0);
    expect(await fronts(win)).toEqual(['Bravo', 'Alpha']);

    // ⌥-click on a row of the focused pane's other tab: it moves out to a new pane right of it.
    await win.locator('.term-row', { hasText: 'Charlie' }).click({ modifiers: ['Alt'] });
    await expect.poll(() => strips(win)).toEqual([['Bravo'], ['Charlie'], ['Alpha']]);
    expect(await focusedIndex(win)).toBe(1);
    // ⌥-click on one in front of another pane only moves the focus.
    await win.locator('.term-row', { hasText: 'Alpha' }).click({ modifiers: ['Alt'] });
    await expect.poll(() => focusedIndex(win)).toBe(2);
    expect(await strips(win)).toEqual([['Bravo'], ['Charlie'], ['Alpha']]);

    // Split Right from a strip's button (two panes): an empty pane right of that pane, with the picker; a session
    // sitting in another pane's strip says it moves here. Esc closes the empty pane again.
    await menu(app, 'Unsplit');
    await expect.poll(() => strips(win)).toEqual([['Bravo'], ['Charlie', 'Alpha']]);
    await strip(win, 0).locator('.pane-split').click();
    await expect.poll(() => strips(win)).toEqual([['Bravo'], [], ['Charlie', 'Alpha']]);
    expect(await focusedIndex(win)).toBe(1);
    await expect(win.locator('.pane-picker .pp-item')).toHaveText([/Alpha/]);
    await expect(win.locator('.pane-picker .pp-item .pp-moves')).toHaveText('moves here');
    await still(win);
    await look(win.locator('.workspace'), `${SHOTS}/split-empty-pane.png`, { settle: 200 });
    await win.keyboard.press('Escape');
    await expect.poll(() => strips(win)).toEqual([['Bravo'], ['Charlie', 'Alpha']]);
    expect(await focusedIndex(win)).toBe(0);

    // Dragging tabs, from one pane again (Bravo in front).
    await menu(app, 'Unsplit All');
    await expect(win.locator('.workspace-body.is-split')).toHaveCount(0);
    await expect.poll(() => strips(win)).toEqual([['Bravo', 'Charlie', 'Alpha']]);
    await expect(win.locator('.tab.is-active')).toHaveText([/Bravo/]);
    if (await win.locator('.changes-toggle.is-on').count()) await win.locator('.changes-toggle').click();
    const body = (await win.locator('.workspace-body').boundingBox())!;

    // Alpha over the right edge band of the only pane: the right half lights up ("New pane").
    await dragTab(win, 'Alpha', body.x + body.width - 30, body.y + body.height / 2);
    const drop = win.locator('.pane-drop');
    await expect(drop).toHaveAttribute('data-zone', 'right');
    await expect(drop).toContainText('New pane');
    // (It slides between zones: measured until settled.)
    await expect.poll(async () => (await drop.boundingBox())!.x).toBeGreaterThan(body.x + body.width / 2 - 10);
    await look(win.locator('.workspace'), `${SHOTS}/split-drop-edge.png`);
    await win.mouse.up();
    await expect.poll(() => strips(win)).toEqual([['Bravo', 'Charlie'], ['Alpha']]);
    expect(await focusedIndex(win)).toBe(1);
    await expect(win.locator('.pane-drop-layer')).toHaveCount(0);

    // Bravo into the middle of the right pane: it moves there ("Move to this pane"), in front, focused.
    const right = (await win.locator('.workspace-body > .pane-frame').nth(1).boundingBox())!;
    await dragTab(win, 'Bravo', right.x + right.width / 2, right.y + right.height / 2);
    await expect(drop).toHaveAttribute('data-zone', 'middle');
    await expect(drop).toContainText('Move to this pane');
    await look(win.locator('.workspace'), `${SHOTS}/split-drop-middle.png`, { settle: 250 });
    await win.mouse.up();
    await expect.poll(() => strips(win)).toEqual([['Charlie'], ['Alpha', 'Bravo']]);
    expect(await focusedIndex(win)).toBe(1);
    expect(await fronts(win)).toEqual(['Charlie', 'Bravo']);

    // Over its own pane's middle a dragged tab finds nothing to do: no zone, nothing moves.
    await dragTab(win, 'Alpha', right.x + right.width / 2, right.y + right.height / 2);
    await expect(drop).toHaveCount(0);
    await win.mouse.up();
    expect(await strips(win)).toEqual([['Charlie'], ['Alpha', 'Bravo']]);

    // Into another strip, before a tab (its left half): there; the pane it left, emptied, closes.
    const alpha = (await strip(win, 1).locator('.tab', { hasText: 'Alpha' }).boundingBox())!;
    await dragTab(win, 'Charlie', alpha.x + 8, alpha.y + alpha.height / 2);
    await expect(strip(win, 1).locator('.tab.is-drop')).toHaveText([/Alpha/]);
    await look(win.locator('.workspace'), `${SHOTS}/split-drop-strip.png`, { settle: 200 });
    await win.mouse.up();
    await expect(win.locator('.workspace-body.is-split')).toHaveCount(0);
    await expect.poll(() => strips(win)).toEqual([['Charlie', 'Alpha', 'Bravo']]);
    await expect(win.locator('.tab.is-active')).toHaveText([/Charlie/]);
    await expect(win.locator('.pane-drop-layer')).toHaveCount(0);

    // Dropped on the one strip: today's reordering.
    const first = (await win.locator('.tab', { hasText: 'Charlie' }).boundingBox())!;
    await dragTab(win, 'Bravo', first.x + 6, first.y + first.height / 2);
    await win.mouse.up();
    await expect.poll(() => strips(win)).toEqual([['Bravo', 'Charlie', 'Alpha']]);
  } finally {
    await stop(app, home);
  }
});

test('dividers resize and equalize; every pane\'s tabs — a file too — come back after a restart, nothing new started', async () => {
  const project = mkdtempSync(join(tmpdir(), 'atl-prj-'));
  writeFileSync(join(project, 'notes.md'), 'Notes\n');
  const { env, home } = e2eEnv();
  let { app, win } = await launch(env, project);
  try {
    await terminals(app, win, ['Alpha', 'Bravo', 'Charlie']);
    if (await win.locator('.changes-toggle.is-on').count()) await win.locator('.changes-toggle').click();
    await win.locator('.term-row', { hasText: 'Alpha' }).click({ modifiers: ['Alt'] });
    await expect.poll(() => strips(win)).toEqual([['Bravo', 'Charlie'], ['Alpha']]);
    const [w0, w1] = await widths(win);
    expect(Math.abs(w0! - w1!)).toBeLessThan(2);
    // The strips sit exactly over their panes.
    const s1 = (await strip(win, 1).boundingBox())!;
    const f1 = (await win.locator('.workspace-body > .pane-frame').nth(1).boundingBox())!;
    expect(Math.abs(s1.x - f1.x)).toBeLessThan(1);
    expect(Math.abs(s1.width - f1.width)).toBeLessThan(1);

    // Hover: the divider's line lights up.
    const divider = win.getByRole('separator', { name: 'Resize panes' });
    const d = (await divider.boundingBox())!;
    await win.mouse.move(d.x + d.width / 2, d.y + d.height / 2);
    await look(win.locator('.workspace'), `${SHOTS}/split-divider-hover.png`, { settle: 400 });
    await expect.poll(() => divider.evaluate((el) => getComputedStyle(el, '::after').opacity)).toBe('1');

    // Dragged 150 px right: the left pane (and its strip) grows by that much.
    await win.mouse.down();
    await win.mouse.move(d.x + d.width / 2 + 75, d.y + d.height / 2, { steps: 5 });
    await win.mouse.move(d.x + d.width / 2 + 150, d.y + d.height / 2, { steps: 5 });
    await win.mouse.up();
    await expect.poll(async () => Math.round((await widths(win))[0]! - w0!)).toBeGreaterThan(145);
    expect((await widths(win))[0]! - w0!).toBeLessThan(155);
    await expect.poll(async () => Math.abs((await strip(win, 0).boundingBox())!.width - (await widths(win))[0]!)).toBeLessThan(1);
    // Not below 240 px: dragged far left, the left pane stops there; its strip keeps "+" and the pane tools.
    const d2 = (await divider.boundingBox())!;
    await win.mouse.move(d2.x + 4, d2.y + 200);
    await win.mouse.down();
    await win.mouse.move(d2.x - 2000, d2.y + 200, { steps: 6 });
    await win.mouse.up();
    await expect.poll(async () => Math.round((await widths(win))[0]!)).toBe(240);
    for (const part of ['.tab-new', '.pane-split', '.pane-close']) {
      const b = (await strip(win, 0).locator(part).boundingBox())!;
      const s = (await strip(win, 0).boundingBox())!;
      expect(b.x + b.width, part).toBeLessThanOrEqual(s.x + s.width + 0.5);
    }
    await look(win.locator('.tabs'), `${SHOTS}/split-strip-240.png`, { settle: 200 });
    // The window at its 960 px minimum: the stored share would be under 240 px, the pane keeps 240.
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(960, 700));
    await expect.poll(async () => Math.round((await widths(win))[0]!)).toBe(240);
    expect((await widths(win))[1]!).toBeGreaterThanOrEqual(240);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(1280, 800));
    await expect.poll(async () => (await widths(win))[1]!).toBeGreaterThan(500);
    // Double-click: equal widths.
    await divider.dblclick();
    await expect.poll(async () => { const [a, b] = await widths(win); return Math.abs(a! - b!) < 2; }).toBe(true);
    // Keyboard: focused, → moves it by 24 px.
    await divider.focus();
    await win.keyboard.press('ArrowRight');
    await expect.poll(async () => Math.round((await widths(win))[0]! - w0!)).toBe(24);
    expect(Math.abs(Number(await divider.getAttribute('aria-valuenow')) - ((w0! + 24) / (w0! + w1!)) * 100)).toBeLessThanOrEqual(1);

    // A third pane with a file (opened to the side from the palette), then a known layout.
    await win.keyboard.press('F1');
    await win.locator('.palette-input').fill('notes');
    await win.locator('.palette-item', { hasText: 'notes.md' }).click({ modifiers: ['Alt'] });
    await expect.poll(() => strips(win)).toEqual([['Bravo', 'Charlie'], ['Alpha'], ['notes.md']]);
    const left = (await win.locator('.workspace-body > .pane-frame').first().boundingBox())!;
    await win.mouse.click(left.x + left.width / 2, left.y + 200);
    await expect.poll(() => focusedIndex(win)).toBe(0);
    const div0 = (await win.getByRole('separator', { name: 'Resize panes' }).first().boundingBox())!;
    await win.mouse.move(div0.x + 4, div0.y + 300);
    await win.mouse.down();
    await win.mouse.move(div0.x + 4 + 60, div0.y + 300, { steps: 4 });
    await win.mouse.up();
    const ws = await widths(win);
    const ratio = ws[0]! / (ws[0]! + ws[1]!);
    const count = await termCount(win);
    // Saved (debounced) before the app closes: three panes with their tabs, the left one focused, at the dragged ratio.
    type Saved = { v: number; panes: { tabs: string[] }[]; fractions: number[]; focus: number };
    const saved = () => win.evaluate(() => Object.values(JSON.parse(localStorage.getItem('atelier.splitLayout') ?? '{}') as Record<string, Saved>)[0] ?? null);
    await expect.poll(async () => { const l = await saved(); return !!l && l.v === 2 && l.panes.length === 3 && l.focus === 0 && Math.abs(l.fractions[0]! / (l.fractions[0]! + l.fractions[1]!) - ratio) < 0.02; }).toBe(true);
    expect((await saved())!.panes[2]!.tabs[0]).toMatch(/^f:.*notes\.md$/);
    await app.close();

    // Back with the same home (atelierd kept the terminals): the same three panes, notes.md in its own; the same widths,
    // the left one focused with Charlie in front.
    ({ app, win } = await launch(env, project));
    await expect.poll(() => strips(win), { timeout: 15000 }).toEqual([['Bravo', 'Charlie'], ['Alpha'], ['notes.md']]);
    expect(await focusedIndex(win)).toBe(0);
    await expect(win.locator('.tab.is-active')).toHaveText([/Charlie/]);
    if (await win.locator('.changes-toggle.is-on').count()) await win.locator('.changes-toggle').click();
    await expect.poll(async () => { const [a, b] = await widths(win); return Math.abs(a! / (a! + b!) - ratio) < 0.02; }).toBe(true);
    await win.waitForTimeout(500);
    expect(await termCount(win)).toBe(count);
    await expect(win.locator('.tab')).toHaveCount(4);
    await expect(win.locator('.workspace-body > .file-view:visible')).toHaveCount(1);
    await expect(win.locator('.terminal-slot:visible .xterm-rows').first()).toContainText('›', { timeout: 15000 });
    await still(win);
    await look(win.locator('.workspace'), `${SHOTS}/split-restored.png`, { settle: 300 });
  } finally {
    await stop(app, home);
  }
});
