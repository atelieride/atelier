import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { e2eEnv } from './env';
import { look } from './shots';

// Split view with tab groups: up to three panes side by side, each with its own strip of tabs
// and its tab in front, one focused; the views are placed, never remounted.

const SHOTS = 'test-results';
type Api = { terminals: { list(): Promise<{ id: string; title: string; createdAt: number }[]>; input(id: string, data: string): void; rename(id: string, name: string | null): Promise<void> } };

/** Animations off (and the blinking cursor hidden) for screenshots that are looked at. */
const still = (win: Page) => win.addStyleTag({ content: '*, *::before, *::after { animation: none !important; transition: none !important; } .xterm-cursor-layer { display: none !important; }' });

async function stop(app: ElectronApplication, home: string) {
  await app.close();
  try { process.kill((JSON.parse(readFileSync(join(home, 'atelierd.json'), 'utf8')) as { pid: number }).pid, 'SIGTERM'); } catch { /* already stopped */ }
}

/** App menu items are clicked (synthetic key events do not go through NSMenu). */
async function menu(app: ElectronApplication, label: string) {
  await app.evaluate(({ Menu, BrowserWindow }, l) => {
    const walk = (items: Electron.MenuItem[]): Electron.MenuItem | undefined => {
      for (const it of items) { if (it.label === l) return it; const sub = it.submenu ? walk(it.submenu.items) : undefined; if (sub) return sub; }
      return undefined;
    };
    walk(Menu.getApplicationMenu()!.items)!.click(undefined, BrowserWindow.getAllWindows()[0]);
  }, label);
}

type Resize = { id: string; cols: number; rows: number };

/** From now on, every size the window tells atelierd for a terminal, as main receives them. */
const recordPtySizes = (app: ElectronApplication) => app.evaluate(({ ipcMain }) => {
  const g = globalThis as unknown as { ptySizes: Resize[] };
  g.ptySizes = [];
  ipcMain.on('term:resize', (_e, a: Resize) => { g.ptySizes.push(a); });
});

/**
 * Waits until a terminal's program was told the size its view shows (the footer's "cols×rows"): a pane that closes or
 * opens resizes the view at once and tells the program once the size has settled. Typed before that, zsh prints for
 * the old width, then redraws its prompt for the new one over the line above it (a command's output).
 */
async function ptySettled(app: ElectronApplication, win: Page, id: string) {
  await expect.poll(async () => {
    const shown = /\d+×\d+/.exec(await win.locator('.foot-dim', { hasText: '×' }).first().innerText())?.[0];
    const told = (await app.evaluate((_e, t) => (globalThis as unknown as { ptySizes: Resize[] }).ptySizes.filter((r) => r.id === t), id)).at(-1);
    return told !== undefined && shown === `${told.cols}×${told.rows}`;
  }).toBe(true);
}

/** The visible terminal views, left to right: their grid column and screen text. */
const slots = (win: Page) => win.evaluate(() => [...document.querySelectorAll<HTMLElement>('.workspace-body > .terminal-slot')]
  .filter((el) => el.style.display !== 'none')
  .map((el) => ({ col: Number(el.style.gridColumnStart || 1), text: el.querySelector('.xterm-rows')?.textContent ?? '' }))
  .sort((a, b) => a.col - b.col));
/**
 * Every visible view, picker and pane frame is exactly as wide as its pane's strip (one column, right under it) and runs
 * to the bottom: none runs over its neighbours.
 */
const overflowing = (win: Page) => win.evaluate(() => {
  const body = document.querySelector('.workspace-body')!.getBoundingClientRect();
  const stripOf = (col: number) => document.querySelector<HTMLElement>(`.pane-strip[data-pane="${col - 1}"]`)?.getBoundingClientRect();
  return [...document.querySelectorAll<HTMLElement>('.workspace-body > .terminal-slot, .workspace-body > .file-view, .workspace-body > .pane-picker, .workspace-body > .pane-frame, .workspace-body > .session-bar')]
    .filter((el) => getComputedStyle(el).display !== 'none')
    .filter((el) => {
      const r = el.getBoundingClientRect();
      const s = stripOf(Number(el.style.gridColumnStart));
      const bar = el.classList.contains('session-bar');
      return !s || Math.abs(r.left - s.left) > 0.5 || Math.abs(r.right - s.right) > 0.5 || r.top < s.bottom - 0.5 || (!bar && Math.abs(r.bottom - body.bottom) > 0.5);
    }).map((el) => el.className);
});
const textOf = async (win: Page, col: number) => (await slots(win)).find((s) => s.col === col)?.text ?? '';
/** Each strip's tab names, left to right (one pane: the one strip). */
const strips = (win: Page) => win.evaluate(() => {
  const bars = [...document.querySelectorAll<HTMLElement>('.pane-strip')].sort((a, b) => Number(a.dataset.pane) - Number(b.dataset.pane));
  const of = (el: Element) => [...el.querySelectorAll('.tab .tab-name')].map((n) => n.textContent ?? '');
  const one = document.querySelector('.tabs');
  return bars.length ? bars.map(of) : one ? [of(one)] : [];
});
const strip = (win: Page, i: number) => win.locator(`.pane-strip[data-pane="${i}"]`);

async function idOf(win: Page, title: string) {
  return win.evaluate(async (t) => (await (window as unknown as { atelier: Api }).atelier.terminals.list()).find((x) => x.title === t)!.id, title);
}

/** Two plain terminals, Alpha then Bravo (Bravo in front), each ready (it ran a first command). */
async function alphaBravo(app: ElectronApplication, win: Page) {
  const ready = async (marker: string) => {
    await win.locator('.xterm-helper-textarea:visible').first().focus();
    await win.keyboard.type(`echo ${marker.slice(0, 2)}""${marker.slice(2)}\n`);
    await expect.poll(() => win.locator('.terminal-slot:visible .xterm-rows').first().evaluate((el) => el.textContent ?? ''), { timeout: 15000 }).toContain(marker);
  };
  await win.getByRole('button', { name: 'Open a terminal' }).click();
  await expect(win.locator('.xterm-rows:visible')).toBeVisible({ timeout: 10000 });
  await ready('ALPHAREADY');
  await win.evaluate(async () => { const api = (window as unknown as { atelier: Api }).atelier; await api.terminals.rename((await api.terminals.list())[0]!.id, 'Alpha'); });
  await menu(app, 'New Terminal');
  await expect(win.locator('.tab')).toHaveCount(2, { timeout: 10000 });
  await ready('BRAVOREADY');
  await win.evaluate(async () => {
    const api = (window as unknown as { atelier: Api }).atelier;
    const list = (await api.terminals.list()).sort((a, b) => a.createdAt - b.createdAt);
    await api.terminals.rename(list[1]!.id, 'Bravo');
  });
  await expect(win.locator('.tab', { hasText: 'Bravo' })).toHaveClass(/is-active/);
}

test('split view: a strip per pane, the picker, typing in the focused pane, focus keys, three panes, exits, the pane ×, Unsplit All; one pane looks as before', async () => {
  const project = mkdtempSync(join(tmpdir(), 'atl-prj-'));
  writeFileSync(join(project, 'notes.md'), 'Notes\n');
  const { env, home } = e2eEnv({ ATELIER_CLAUDE_BIN: resolve('tests/e2e/fake-claude.pl') });
  const app = await electron.launch({ args: ['out/main/index.js', `--project=${project}`], env });
  try {
    const win = await app.firstWindow();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(1280, 800));
    await alphaBravo(app, win);

    // ⌘\ (Split Right): the tabs stay on the left; an empty focused pane on the right with its own (empty) strip and the
    // picker, which offers Alpha — it sits in the left strip, so it would move here.
    await menu(app, 'Split Right');
    await expect(win.locator('.workspace-body.is-split')).toBeVisible();
    await expect(win.locator('.tabs.is-split > .pane-strip')).toHaveCount(2);
    expect(await strips(win)).toEqual([['Alpha', 'Bravo'], []]);
    const picker = win.locator('.pane-picker');
    await expect(picker.locator('.pp-item')).toHaveText([/Alpha/]);
    await expect(picker.locator('.pp-item .pp-moves')).toHaveText('moves here');
    await expect(strip(win, 1)).toHaveClass(/is-focused/);
    expect(await overflowing(win)).toEqual([]);
    await still(win);
    await look(win.locator('.workspace'), `${SHOTS}/split-picker.png`);

    // Picking Alpha: it moves to the right pane. Bravo | Alpha, one view each, each in front of its own strip.
    await picker.locator('.pp-item', { hasText: 'Alpha' }).click();
    await expect(picker).toHaveCount(0);
    expect(await strips(win)).toEqual([['Bravo'], ['Alpha']]);
    await expect.poll(async () => (await slots(win)).map((s) => s.col)).toEqual([1, 2]);
    // (A view shown at a new width is redrawn from atelierd's snapshot at that size: polled.)
    await expect.poll(() => textOf(win, 1)).toContain('BRAVOREADY');
    await expect.poll(() => textOf(win, 2)).toContain('ALPHAREADY');
    await expect(strip(win, 0).locator('.tab.is-front')).toHaveText([/Bravo/]);
    await expect(win.locator('.tab.is-active')).toHaveText([/Alpha/]);

    // Typing goes to the focused pane (Alpha, right); ⌘⌥← moves it to Bravo.
    await win.keyboard.type('echo MA""RKONE\n');
    await expect.poll(() => textOf(win, 2)).toContain('MARKONE');
    expect(await textOf(win, 1)).not.toContain('MARKONE');
    await menu(app, 'Focus Previous Pane');
    await expect(strip(win, 0)).toHaveClass(/is-focused/);
    // ⌘⌥→ and ⌘\ pressed inside the terminal (the menu takes them in the app): xterm sends nothing for them.
    await win.keyboard.press('Meta+Alt+ArrowRight');
    await win.keyboard.press('Meta+Backslash');
    await win.keyboard.type('echo MA""RKTWO\n');
    await expect.poll(() => textOf(win, 1)).toContain('MARKTWO');
    expect(await textOf(win, 1)).toContain('echo MA""RKTWO');
    expect(await textOf(win, 2)).not.toContain('MARKTWO');
    // Next wraps: from Bravo (left) to Alpha, then back to Bravo.
    await menu(app, 'Focus Next Pane');
    await expect(strip(win, 1)).toHaveClass(/is-focused/);
    await menu(app, 'Focus Next Pane');
    await expect(strip(win, 0)).toHaveClass(/is-focused/);

    // A sidebar click on Alpha (in front on the right) moves the focus there: never a second view of it.
    await win.locator('.term-row', { hasText: 'Alpha' }).click();
    await expect(strip(win, 1)).toHaveClass(/is-focused/);
    await expect.poll(async () => (await slots(win)).length).toBe(2);
    await win.keyboard.type('echo MA""RKTHREE\n');
    await expect.poll(() => textOf(win, 2)).toContain('MARKTHREE');
    // Clicking into the left pane focuses it.
    const left = (await win.locator('.workspace-body > .pane-frame').nth(0).boundingBox())!;
    await win.mouse.click(left.x + 120, left.y + 200);
    await expect(strip(win, 0)).toHaveClass(/is-focused/);

    // A third pane: Split Right from Bravo puts it in the middle; nothing left to offer, a new session opens in it.
    await menu(app, 'Split Right');
    await expect(win.locator('.pane-picker .pp-none')).toBeVisible();
    await expect(win.locator('.workspace-body.is-split > .pane-frame')).toHaveCount(3);
    await win.locator('.pane-picker').getByRole('button', { name: /New session/ }).click();
    await win.getByPlaceholder('Session name (optional)').fill('Charlie');
    await win.keyboard.press('Enter');
    await expect(win.locator('.session-row', { hasText: 'Charlie' })).toHaveClass(/state-waiting/, { timeout: 20000 });
    expect(await strips(win)).toEqual([['Bravo'], ['Charlie'], ['Alpha']]);
    // Its session bar sits under its strip, without avatar or name (the tab right above says who).
    const bar = win.locator('.workspace-body > .session-bar');
    await expect(bar).toHaveClass(/is-focused/);
    expect(await bar.evaluate((el) => el.style.gridColumnStart)).toBe('2');
    await expect(bar.locator('.sb-title, .avatar')).toHaveCount(0);
    await expect.poll(async () => (await slots(win)).length).toBe(3);
    expect(await overflowing(win)).toEqual([]);
    // The waiting glow is the pane's own (Charlie needs permission), not the whole workspace's.
    await expect(win.locator('.workspace-body > .pane-frame.is-waiting')).toHaveCount(1);
    expect(await win.locator('.workspace-body > .pane-frame.is-waiting').evaluate((el) => el.style.gridColumnStart)).toBe('2');
    await expect(win.locator('.workspace-body.is-waiting')).toHaveCount(0);
    // No pane marks, no linked hover, no pane headers any more; each strip ends with its tools, the last with Changes.
    await expect(win.locator('.pane-mark, .is-linked, .workspace-body > .pane-head')).toHaveCount(0);
    for (const i of [0, 1, 2]) await expect(strip(win, i).locator('.tab-tools .pane-split, .tab-tools .pane-close')).toHaveCount(2);
    await expect(win.locator('.changes-toggle')).toHaveCount(1);
    await expect(strip(win, 2).locator('.changes-toggle')).toHaveCount(1);
    // The focused pane's tab wears the crown; the others' fronts their quiet one, with the same full-contrast name
    //.
    expect(await win.locator('.tab.is-active').evaluate((el) => getComputedStyle(el).backgroundImage)).toContain('linear-gradient');
    await expect(win.locator('.tab.is-front')).toHaveText([/Bravo/, /Alpha/]);
    const nameColor = (sel: string) => win.locator(sel).first().evaluate((el) => getComputedStyle(el).color);
    expect(await nameColor('.tab.is-front')).toBe(await nameColor('.tab.is-active'));

    // The pane ×: its tooltip says where its tab goes, and the tab lights up while it is hovered.
    const x = strip(win, 1).locator('.pane-close');
    await expect(x).toHaveAttribute('aria-label', 'Unsplit');
    await expect(x).toHaveAttribute('data-tip', 'Unsplit — its tab moves to the left pane');
    await expect(strip(win, 0).locator('.pane-close')).toHaveAttribute('data-tip', 'Unsplit — its tab moves to the right pane');
    await x.hover();
    await expect(strip(win, 1).locator('.tab.is-leaving')).toHaveText([/Charlie/]);
    await expect(win.locator('.tab.is-leaving')).toHaveCount(1);
    await expect(win.locator('.tooltip', { hasText: 'Unsplit — its tab moves to the left pane' })).toBeVisible();
    // Its own hover: rose.
    await expect.poll(() => x.evaluate((el) => getComputedStyle(el).color)).toBe('rgb(251, 113, 133)');
    await look(win, `${SHOTS}/split-unsplit-hover.png`, { settle: 250 });
    await win.mouse.move(5, 5);
    await expect(win.locator('.tab.is-leaving')).toHaveCount(0);
    // Three panes in the 1280 px window: Changes closed, then open (the narrowest panes). The toggle sits in the last
    // strip but is the window's: clicking it leaves the focus on Charlie's pane.
    if (await win.locator('.changes-toggle.is-on').count()) await win.locator('.changes-toggle').click();
    await expect(strip(win, 1)).toHaveClass(/is-focused/);
    await look(win.locator('.workspace'), `${SHOTS}/split-3panes.png`, { settle: 400 });
    await win.locator('.changes-toggle').click();
    await expect(strip(win, 1)).toHaveClass(/is-focused/);
    await look(win.locator('.workspace'), `${SHOTS}/split-3panes-changes.png`, { settle: 400 });

    // Bravo (left, alone in its pane, not focused) exits: its pane closes, the focus stays on Charlie.
    const bravo = await idOf(win, 'Bravo');
    await win.evaluate((id) => (window as unknown as { atelier: Api }).atelier.terminals.input(id, 'exit\n'), bravo);
    await expect(win.locator('.workspace-body.is-split > .pane-frame')).toHaveCount(2, { timeout: 10000 });
    await expect(bar).toHaveClass(/is-focused/);
    expect(await bar.evaluate((el) => el.style.gridColumnStart)).toBe('1');
    expect(await strips(win)).toEqual([['Charlie'], ['Alpha']]);
    await look(win.locator('.workspace'), `${SHOTS}/split-2panes.png`, { settle: 300 });
    // At the 960 px minimum with Changes open: the strips and the bar adapt, nothing wraps or overlaps.
    if (!(await win.locator('.changes-toggle.is-on').count())) await win.locator('.changes-toggle').click();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(960, 700));
    await look(win.locator('.workspace'), `${SHOTS}/split-2panes-960.png`, { settle: 500 });
    const messy = () => win.evaluate(() => [...document.querySelectorAll<HTMLElement>('.workspace-body > .session-bar, .pane-strip')].flatMap((h) => {
      const r = h.getBoundingClientRect();
      const kids = [...h.children].filter((c) => getComputedStyle(c).display !== 'none' && getComputedStyle(c).visibility !== 'hidden')
        .map((c) => ({ c: c.className.toString(), b: c.getBoundingClientRect() })).filter((k) => k.b.width > 0);
      return kids.filter((k, i) => k.b.right > r.right + 0.5 || k.b.top < r.top - 0.5 || k.b.bottom > r.bottom + 0.5 || (i > 0 && kids[i - 1]!.b.right > k.b.left + 0.5))
        .map((k) => `${h.className}: ${k.c} [${Math.round(k.b.left)}–${Math.round(k.b.right)} in ${Math.round(r.left)}–${Math.round(r.right)}]`);
    }));
    await expect.poll(messy).toEqual([]);
    // Each narrow strip keeps its tab in front readable: the pane tools give way first (Split Right, then "+").
    for (const i of [0, 1]) {
      // The room the tabs are shown in (the tab row scrolls inside it): enough for a tab's icon and some of its name.
      expect(await strip(win, i).locator('.tab-strip').evaluate((el) => el.clientWidth), `strip ${i}`).toBeGreaterThan(80);
    }
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(1280, 800));

    // Charlie's pane ×: its tab joins the right pane (before Alpha); Alpha stays in front; nothing closes.
    await strip(win, 0).locator('.pane-close').click();
    await win.mouse.move(5, 5);
    await expect(win.locator('.workspace-body.is-split')).toHaveCount(0);
    expect(await strips(win)).toEqual([['Charlie', 'Alpha']]);
    await expect(win.locator('.tab.is-active')).toHaveText([/Alpha/]);

    // Split again, pick Charlie with the keyboard; Unsplit All keeps the focused one in front.
    await menu(app, 'Split Right');
    await expect(win.locator('.pane-picker .pp-item')).toHaveText([/Charlie/]);
    await win.keyboard.press('Enter');
    await expect(win.locator('.workspace-body > .session-bar')).toHaveClass(/is-focused/);
    expect(await strips(win)).toEqual([['Alpha'], ['Charlie']]);
    await menu(app, 'Unsplit All');
    await expect(win.locator('.workspace-body.is-split')).toHaveCount(0);
    await expect(win.locator('.workspace > .session-bar')).toBeVisible();
    await expect(win.locator('.tab.is-active')).toHaveText([/Charlie/]);
    // One pane looks as before the split view: one bar of tabs, the session bar above, no grid, no pane frame or tools.
    await expect(win.locator('.workspace-body.is-split, .tabs.is-split, .pane-strip, .pane-head, .pane-frame, .tab-tools')).toHaveCount(0);
    await look(win.locator('.workspace'), `${SHOTS}/split-1pane.png`, { settle: 400 });

    // ⌘W on the focused pane's only tab: the tab and its pane close.
    await menu(app, 'Split Right');
    await win.locator('.pane-picker .pp-item', { hasText: 'Alpha' }).click();
    await expect.poll(async () => (await slots(win)).length).toBe(2);
    await menu(app, 'Close Tab');
    await expect(win.locator('.workspace-body.is-split')).toHaveCount(0);
    await expect(win.locator('.tab', { hasText: 'Alpha' })).toHaveCount(0);
    await expect(win.locator('.tab.is-active')).toHaveText([/Charlie/]);
    // The fourth pane is refused with a toast.
    await menu(app, 'Split Right');
    await menu(app, 'Split Right');
    await menu(app, 'Split Right');
    await expect(win.locator('.workspace-body.is-split > .pane-frame')).toHaveCount(3);
    await expect(win.locator('.toast')).toContainText('Up to three panes side by side');

    // A file from the palette opens in the focused (empty, rightmost) pane, as a tab of its strip; it takes the whole pane
    // (no bar above it), its own file bar inside.
    await win.keyboard.press('F1');
    await win.locator('.palette-input').fill('notes');
    await win.locator('.palette-item', { hasText: 'notes.md' }).click();
    await expect(win.locator('.workspace-body > .file-view')).toBeVisible();
    expect(await win.locator('.workspace-body > .file-view').evaluate((el) => el.style.gridColumnStart)).toBe('3');
    await expect(strip(win, 2).locator('.tab.is-active')).toHaveText([/notes\.md/]);
    await expect(win.locator('.pane-picker')).toHaveCount(1);
    expect(await overflowing(win)).toEqual([]);
    await win.locator('.workspace-body .cm-content').click();
    await win.keyboard.type('# Split');
    await expect(strip(win, 2).locator('.tab-dirty')).toHaveCount(1);
    await look(win.locator('.workspace'), `${SHOTS}/split-file.png`, { settle: 300 });
  } finally {
    await stop(app, home);
  }
});

// The beta report: two terminals side by side, a file opened from Changes lands in the
// focused pane; closing it gives that pane its terminal back and the split stays.
test('split view: closing a file opened from Changes in a pane keeps the split', async () => {
  const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  const git = (cwd: string, ...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd, env: gitEnv });
  const project = mkdtempSync(join(tmpdir(), 'atl-prj-'));
  writeFileSync(join(project, 'context.md'), '# Context\n');
  writeFileSync(join(project, 'other.md'), '# Other\n');
  git(project, 'init', '-q', '-b', 'main');
  git(project, 'add', '.');
  git(project, 'commit', '-q', '-m', 'first');
  writeFileSync(join(project, 'context.md'), '# Context\n\nChanged.\n');
  writeFileSync(join(project, 'other.md'), '# Other\n\nChanged.\n');
  const { env, home } = e2eEnv({ ATELIER_CLAUDE_BIN: resolve('tests/e2e/fake-claude.pl') });
  const app = await electron.launch({ args: ['out/main/index.js', `--project=${project}`], env });
  try {
    const win = await app.firstWindow();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(1280, 800));
    await win.getByRole('button', { name: 'Open a terminal' }).click();
    await expect(win.locator('.xterm-rows:visible')).toBeVisible({ timeout: 10000 });
    await menu(app, 'New Terminal');
    await expect(win.locator('.tab')).toHaveCount(2, { timeout: 10000 });
    // Side by side: the second terminal on the left, the first picked into the new pane; then the focus goes left.
    await menu(app, 'Split Right');
    await win.locator('.pane-picker .pp-item').first().click();
    await expect.poll(async () => (await slots(win)).length).toBe(2);
    await menu(app, 'Focus Previous Pane');

    const row = win.locator('.changes .change-row', { hasText: 'context.md' });
    await expect(row).toBeVisible({ timeout: 15000 });
    await row.click();
    await expect(win.locator('.workspace-body > .file-view:visible')).toBeVisible();
    await win.locator('.tab', { hasText: 'context.md' }).locator('.tab-close').click();

    await expect(win.locator('.workspace-body > .pane-frame')).toHaveCount(2);
    await expect.poll(async () => (await slots(win)).map((s) => s.col)).toEqual([1, 2]);

    // An empty pane (Split Right from the left one: the middle) filled by a file from Changes (a
    // preview), then a second file: it replaces the first in that pane; the split stays.
    await menu(app, 'Split Right');
    await expect(win.locator('.workspace-body > .pane-frame')).toHaveCount(3);
    await row.click();
    await expect(strip(win, 1).locator('.tab .tab-name')).toHaveText(['context.md']);
    await win.locator('.changes .change-row', { hasText: 'other.md' }).click();
    await expect(strip(win, 1).locator('.tab .tab-name')).toHaveText(['other.md']);
    await expect(win.locator('.workspace-body > .pane-frame')).toHaveCount(3);
  } finally {
    await stop(app, home);
  }
});

test('tabs move between panes with ⌃⌘←/→ and the strip; a file with unsaved edits keeps its text and undo; ⌘W down to a pane\'s last tab closes it and the keyboard stays in the pane on its left', async () => {
  const project = mkdtempSync(join(tmpdir(), 'atl-prj-'));
  writeFileSync(join(project, 'notes.md'), 'Notes\n');
  writeFileSync(join(project, 'todo.md'), 'Todo\n');
  const { env, home } = e2eEnv({ ATELIER_CLAUDE_BIN: resolve('tests/e2e/fake-claude.pl') });
  const app = await electron.launch({ args: ['out/main/index.js', `--project=${project}`], env });
  try {
    const win = await app.firstWindow();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(1280, 800));
    await recordPtySizes(app);
    await alphaBravo(app, win);
    if (await win.locator('.changes-toggle.is-on').count()) await win.locator('.changes-toggle').click();

    // ⌃⌘→ in one pane: Bravo (in front) moves out to a new pane on the right.
    await menu(app, 'Move Tab to Right Pane');
    expect(await strips(win)).toEqual([['Alpha'], ['Bravo']]);
    await expect(strip(win, 1)).toHaveClass(/is-focused/);
    // A file opened in the left pane, edited (not saved).
    await menu(app, 'Focus Previous Pane');
    await win.keyboard.press('F1');
    await win.locator('.palette-input').fill('notes');
    await win.locator('.palette-item', { hasText: 'notes.md' }).click();
    await expect.poll(() => strips(win)).toEqual([['Alpha', 'notes.md'], ['Bravo']]);
    const editor = win.locator('.workspace-body > .file-view:visible .cm-content');
    await editor.click();
    await win.keyboard.press('Meta+End');
    await win.keyboard.type('Unsaved line');
    await expect(win.locator('.tab', { hasText: 'notes.md' }).locator('.tab-dirty')).toHaveCount(1);

    // Dragged into the right strip, before Bravo: there, in front, with its text; its undo still knows the edit.
    const target = (await strip(win, 1).locator('.tab', { hasText: 'Bravo' }).boundingBox())!;
    const box = (await win.locator('.tab', { hasText: 'notes.md' }).boundingBox())!;
    await win.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await win.mouse.down();
    await win.mouse.move(box.x + box.width / 2 + 20, box.y + box.height / 2 + 30, { steps: 4 });
    await win.mouse.move(target.x + 8, target.y + target.height / 2, { steps: 8 });
    await win.mouse.up();
    await expect.poll(() => strips(win)).toEqual([['Alpha'], ['notes.md', 'Bravo']]);
    await expect(strip(win, 1).locator('.tab.is-active')).toHaveText([/notes\.md/]);
    expect(await win.locator('.workspace-body > .file-view:visible').evaluate((el) => el.style.gridColumnStart)).toBe('2');
    await expect(editor).toContainText('Unsaved line');
    await editor.click();
    await win.keyboard.press('Meta+z');
    await expect(editor).not.toContainText('Unsaved line');
    await win.keyboard.press('Meta+Shift+z');
    await expect(editor).toContainText('Unsaved line');

    // ⌃⌘← moves it back into the left pane (its end).
    await menu(app, 'Move Tab to Left Pane');
    await expect.poll(() => strips(win)).toEqual([['Alpha', 'notes.md'], ['Bravo']]);
    await expect(strip(win, 0)).toHaveClass(/is-focused/);
    await expect(editor).toContainText('Unsaved line');

    // Review Focus 5: two more files in the right pane, then ⌘W three times there. Its last tab closes it; the left pane
    // takes the focus and the keyboard goes to its view (typing reaches Alpha's terminal).
    await menu(app, 'Focus Next Pane');
    await win.keyboard.press('F1');
    await win.locator('.palette-input').fill('todo');
    await win.locator('.palette-item', { hasText: 'todo.md' }).click();
    await expect.poll(() => strips(win)).toEqual([['Alpha', 'notes.md'], ['Bravo', 'todo.md']]);
    await menu(app, 'Focus Previous Pane');
    await win.locator('.tab', { hasText: 'Alpha' }).click();
    await menu(app, 'Focus Next Pane');
    await menu(app, 'Close Tab');
    await expect.poll(() => strips(win)).toEqual([['Alpha', 'notes.md'], ['Bravo']]);
    await expect(strip(win, 1).locator('.tab.is-active')).toHaveText([/Bravo/]);
    await menu(app, 'Close Tab');
    await expect(win.locator('.workspace-body.is-split')).toHaveCount(0);
    expect(await strips(win)).toEqual([['Alpha', 'notes.md']]);
    await expect(win.locator('.tab.is-active')).toHaveText([/Alpha/]);
    await ptySettled(app, win, await idOf(win, 'Alpha'));
    await win.keyboard.type('echo AF""TERCLOSE\n');
    await expect.poll(() => textOf(win, 1)).toContain('AFTERCLOSE');
  } finally {
    await stop(app, home);
  }
});
