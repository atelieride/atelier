import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { e2eEnv } from './env';
import { look } from './shots';

// Split view in both directions: panes side by side or stacked, nested, up to four; every pane has its own strip on top
// of it; dividers in both orientations; the views are placed, never remounted.

const SHOTS = 'test-results';
type Api = { terminals: { list(): Promise<{ id: string; title: string; createdAt: number }[]>; rename(id: string, name: string | null): Promise<void> } };
type Box = { x: number; y: number; w: number; h: number };

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

/** The body, each pane's frame and each pane's strip, in pane order (CSS px, viewport coordinates). */
const geometry = (win: Page) => win.evaluate(() => {
  const box = (el: Element): Box => { const r = el.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; };
  const byPane = (sel: string) => [...document.querySelectorAll<HTMLElement>(sel)].sort((a, b) => Number(a.dataset.pane) - Number(b.dataset.pane)).map(box);
  return { body: box(document.querySelector('.workspace-body')!), frames: byPane('.workspace-body > .pane-frame'), strips: byPane('.workspace-body > .pane-strip') };
});
const near = (a: number, b: number, tol = 1) => Math.abs(a - b) <= tol;

test('split in both directions: side by side as before, ⌥-click stacks, every pane has its strip on top, the terminal keeps its view, dividers both ways', async () => {
  const project = mkdtempSync(join(tmpdir(), 'atl-prj-'));
  writeFileSync(join(project, 'notes.md'), 'Notes\n');
  const { env, home } = e2eEnv({ ATELIER_CLAUDE_BIN: resolve('tests/e2e/fake-claude.pl') });
  const app = await electron.launch({ args: ['out/main/index.js', `--project=${project}`], env });
  try {
    const win = await app.firstWindow();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(1440, 900));
    await alphaBravo(app, win);
    if (await win.locator('.changes-toggle.is-on').count()) await win.locator('.changes-toggle').click();

    // Split Right, Alpha picked into the new pane: two columns. Each strip sits on top of its pane, at the top of the
    // body, as wide as the pane; the panes share the width; the divider is on the gap.
    await menu(app, 'Split Right');
    await win.locator('.pane-picker .pp-item', { hasText: 'Alpha' }).click();
    await expect.poll(() => win.locator('.workspace-body > .pane-strip').count()).toBe(2);
    let g = await geometry(win);
    for (const i of [0, 1]) {
      expect(near(g.strips[i]!.y, g.body.y)).toBe(true);
      expect(near(g.strips[i]!.x, g.frames[i]!.x) && near(g.strips[i]!.w, g.frames[i]!.w)).toBe(true);
      expect(near(g.frames[i]!.y, g.strips[i]!.y + g.strips[i]!.h)).toBe(true);
    }
    expect(near(g.frames[0]!.w, g.frames[1]!.w, 1.5)).toBe(true);
    const vertical = win.locator('.workspace-body > .pane-divider[aria-orientation="vertical"]');
    await expect(vertical).toHaveCount(1);
    const v = (await vertical.boundingBox())!;
    expect(near(v.x + v.width / 2, g.frames[0]!.x + g.frames[0]!.w + 0.5, 1)).toBe(true);
    // The Changes toggle ends the strip of the pane in the top-right corner.
    await expect(win.locator('.pane-strip[data-pane="1"] .changes-toggle')).toHaveCount(1);

    // Alpha's terminal view, marked: after the layout changes it must be the very same element, scrollback intact.
    await win.locator('.workspace-body > .terminal-slot:visible', { hasText: 'ALPHAREADY' }).evaluate((el) => { el.dataset.mark = 'alpha'; });

    // ⌥ held over the right pane's Split button: it turns into Split Down; ⌥-click stacks an empty pane under Alpha.
    const right = win.locator('.pane-strip[data-pane="1"]');
    await right.hover();
    await win.keyboard.down('Alt');
    await expect(right.locator('.pane-split')).toHaveAttribute('aria-label', 'Split down');
    await right.locator('.pane-split').click({ modifiers: ['Alt'] });
    await win.keyboard.up('Alt');
    await expect(right.locator('.pane-split')).toHaveAttribute('aria-label', 'Split right');
    await expect.poll(() => win.locator('.workspace-body > .pane-strip').count()).toBe(3);
    await expect(win.locator('.pane-strip[data-pane="2"]')).toHaveClass(/is-focused/);
    await expect(win.locator('.workspace-body > .pane-picker')).toBeVisible();

    g = await geometry(win);
    // Bravo keeps the whole left column; Alpha (pane 1) over the new pane (pane 2), both as wide as the right column.
    expect(near(g.frames[0]!.y + g.frames[0]!.h, g.body.y + g.body.h)).toBe(true);
    expect(near(g.frames[1]!.x, g.frames[2]!.x) && near(g.frames[1]!.w, g.frames[2]!.w)).toBe(true);
    expect(near(g.strips[2]!.y, g.frames[1]!.y + g.frames[1]!.h + 1)).toBe(true);
    expect(near(g.frames[2]!.y, g.strips[2]!.y + g.strips[2]!.h)).toBe(true);
    expect(near(g.strips[1]!.h + g.frames[1]!.h, g.strips[2]!.h + g.frames[2]!.h, 1.5)).toBe(true);
    // The Changes toggle stays in the top-right pane's strip (pane 1).
    await expect(win.locator('.pane-strip[data-pane="1"] .changes-toggle')).toHaveCount(1);
    const alpha = win.locator('[data-mark="alpha"]');
    await expect(alpha).toBeVisible();
    await expect(alpha.locator('.xterm-rows')).toContainText('ALPHAREADY');
    await still(win);
    await look(win.locator('.workspace'), `${SHOTS}/split-stacked.png`);

    // The horizontal divider between Alpha and the new pane: a drag down grows Alpha, ↓ by 24 px more; the vertical
    // divider (another group) does not move. A double-click evens that group only.
    const horizontal = win.locator('.workspace-body > .pane-divider[aria-orientation="horizontal"]');
    await expect(horizontal).toHaveCount(1);
    const h0 = (await horizontal.boundingBox())!;
    const before = await geometry(win);
    await win.mouse.move(h0.x + h0.width / 2, h0.y + h0.height / 2);
    await win.mouse.down();
    await win.mouse.move(h0.x + h0.width / 2, h0.y + h0.height / 2 + 30, { steps: 3 });
    await win.mouse.move(h0.x + h0.width / 2, h0.y + h0.height / 2 + 60, { steps: 3 });
    await win.mouse.up();
    await expect.poll(async () => (await geometry(win)).frames[1]!.h - before.frames[1]!.h).toBeGreaterThan(55);
    g = await geometry(win);
    expect(near(g.frames[2]!.h, before.frames[2]!.h - 60, 3)).toBe(true);
    expect(near(g.frames[0]!.w, before.frames[0]!.w)).toBe(true);
    await horizontal.focus();
    await win.keyboard.press('ArrowDown');
    await expect.poll(async () => (await geometry(win)).frames[1]!.h - g.frames[1]!.h).toBeGreaterThan(20);
    // ←/→ belong to vertical dividers: nothing moves.
    const mid = await geometry(win);
    await win.keyboard.press('ArrowRight');
    expect((await geometry(win)).frames[1]!.h).toBe(mid.frames[1]!.h);
    // The vertical divider is moved first, then the horizontal one's double-click evens only the stack.
    await vertical.focus();
    await win.keyboard.press('ArrowLeft');
    await expect.poll(async () => (await geometry(win)).frames[0]!.w).toBeLessThan(mid.frames[0]!.w - 20);
    const leftWidth = (await geometry(win)).frames[0]!.w;
    await horizontal.dblclick();
    await expect.poll(async () => { const x = await geometry(win); return Math.abs((x.strips[1]!.h + x.frames[1]!.h) - (x.strips[2]!.h + x.frames[2]!.h)); }).toBeLessThan(2);
    expect(near((await geometry(win)).frames[0]!.w, leftWidth)).toBe(true);
    await expect(alpha).toBeVisible();

    // A new terminal in the lower pane (focused). Its ×'s tooltip says where its tab goes: the pane above.
    await win.locator('.pane-strip[data-pane="2"]').click({ position: { x: 60, y: 19 } });
    await menu(app, 'New Terminal');
    await expect(win.locator('.pane-strip[data-pane="2"] .tab')).toHaveCount(1, { timeout: 10000 });
    await expect(win.locator('.pane-strip[data-pane="2"] .pane-close')).toHaveAttribute('data-tip', 'Unsplit — its tab moves to the pane above');
    // Its tab dragged from the lower strip onto the upper one, after Alpha: it moves there and the emptied pane closes.
    const lower = (await win.locator('.pane-strip[data-pane="2"] .tab').boundingBox())!;
    const upper = (await win.locator('.pane-strip[data-pane="1"] .tab', { hasText: 'Alpha' }).boundingBox())!;
    await win.mouse.move(lower.x + lower.width / 2, lower.y + lower.height / 2);
    await win.mouse.down();
    await win.mouse.move(lower.x + lower.width / 2 + 20, lower.y + lower.height / 2 - 30, { steps: 4 });
    await win.mouse.move(upper.x + upper.width + 30, upper.y + upper.height / 2, { steps: 8 });
    await win.mouse.up();
    await expect.poll(() => win.locator('.workspace-body > .pane-strip').count()).toBe(2);
    await expect(win.locator('.pane-strip[data-pane="1"] .tab')).toHaveCount(2);
    await expect(win.locator('.pane-strip[data-pane="1"] .tab').first()).toContainText('Alpha');
    // The moved tab is in front there; Alpha's view is still the same element, now behind it.
    await expect(alpha).toHaveCount(1);
  } finally {
    await stop(app, home);
  }
});

/** Drags tab `name` (pressed in its strip) to client point (x, y) and keeps the button down. */
async function dragTabTo(win: Page, name: string, x: number, y: number) {
  const box = (await win.locator('.tab', { hasText: name }).boundingBox())!;
  await win.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await win.mouse.down();
  await win.mouse.move(box.x + box.width / 2 + 20, box.y + box.height / 2 + 30, { steps: 4 });
  await win.mouse.move(x, y, { steps: 8 });
}

test('a tab dropped on a pane\'s bottom edge stacks it there; at the minimum window an edge without room only moves the tab', async () => {
  const project = mkdtempSync(join(tmpdir(), 'atl-prj-'));
  const { env, home } = e2eEnv({ ATELIER_CLAUDE_BIN: resolve('tests/e2e/fake-claude.pl') });
  const app = await electron.launch({ args: ['out/main/index.js', `--project=${project}`], env });
  try {
    const win = await app.firstWindow();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(1440, 900));
    await alphaBravo(app, win);
    if (await win.locator('.changes-toggle.is-on').count()) await win.locator('.changes-toggle').click();

    // Bravo dragged onto the bottom band of the only pane: the bottom half lights up; released, Bravo has its own pane
    // under Alpha's, as wide as it.
    const body = (await win.locator('.workspace-body').boundingBox())!;
    await dragTabTo(win, 'Bravo', body.x + body.width / 2, body.y + body.height - 20);
    const drop = win.locator('.pane-drop[data-zone="bottom"]');
    await expect(drop).toBeVisible();
    const lit = (await drop.boundingBox())!;
    expect(near(lit.y, body.y + body.height / 2, 10)).toBe(true);
    expect(near(lit.width, body.width - 12, 2)).toBe(true);
    // Its label shows a window cut across (Split Down's glyph).
    await expect(drop.locator('path[d="M3 10h14"]')).toHaveCount(1);
    await still(win);
    await look(win.locator('.workspace'), `${SHOTS}/split-drop-bottom.png`);
    await win.mouse.up();
    await expect.poll(() => win.locator('.workspace-body > .pane-strip').count()).toBe(2);
    await expect(win.locator('.pane-strip[data-pane="0"] .tab')).toHaveText([/Alpha/]);
    await expect(win.locator('.pane-strip[data-pane="1"] .tab')).toHaveText([/Bravo/]);
    await expect(win.locator('.pane-strip[data-pane="1"]')).toHaveClass(/is-focused/);
    const g = await geometry(win);
    expect(near(g.strips[0]!.x, g.strips[1]!.x) && near(g.strips[0]!.w, g.strips[1]!.w)).toBe(true);
    expect(g.strips[1]!.y).toBeGreaterThan(g.frames[0]!.y + 100);

    // Back to one pane, then the minimum window with Changes open: two columns still fit, a third does not.
    await win.locator('.pane-strip[data-pane="1"] .pane-close').click();
    await expect(win.locator('.workspace-body.is-split')).toHaveCount(0);
    await win.locator('.changes-toggle').click();
    await expect(win.locator('.changes-toggle.is-on')).toHaveCount(1);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(960, 600));
    await menu(app, 'Split Right');
    await expect.poll(() => win.locator('.workspace-body > .pane-strip').count()).toBe(2);
    // Alpha over the right pane's right edge: no room for a third column, so the pane itself lights up (Move to this pane).
    const right = (await win.locator('.workspace-body > .pane-frame[data-pane="1"]').boundingBox())!;
    await dragTabTo(win, 'Alpha', right.x + right.width - 6, right.y + right.height / 2);
    await expect(win.locator('.pane-drop[data-zone="middle"]')).toBeVisible();
    await expect(win.locator('.pane-drop[data-zone="right"]')).toHaveCount(0);
    await win.mouse.up();
    await expect(win.locator('.pane-strip[data-pane="1"] .tab')).toHaveText([/Alpha/]);
    await expect(win.locator('.workspace-body > .pane-strip')).toHaveCount(2);
    // ⌘\ says why instead of making a pane too narrow to use.
    await menu(app, 'Split Right');
    await expect(win.locator('.toast')).toContainText('Not enough room: widen the window or hide a panel');
    await expect(win.locator('.workspace-body > .pane-strip')).toHaveCount(2);
  } finally {
    await stop(app, home);
  }
});

test('View menu: Split Down, focus the pane above and below, move the tab up and down', async () => {
  const project = mkdtempSync(join(tmpdir(), 'atl-prj-'));
  const { env, home } = e2eEnv({ ATELIER_CLAUDE_BIN: resolve('tests/e2e/fake-claude.pl') });
  const app = await electron.launch({ args: ['out/main/index.js', `--project=${project}`], env });
  try {
    const win = await app.firstWindow();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(1440, 900));
    await alphaBravo(app, win);
    const strips = () => win.evaluate(() => [...document.querySelectorAll<HTMLElement>('.workspace-body > .pane-strip')]
      .sort((a, b) => Number(a.dataset.pane) - Number(b.dataset.pane)).map((s) => [...s.querySelectorAll('.tab .tab-name')].map((n) => n.textContent ?? '')));
    const focused = () => win.locator('.workspace-body > .pane-strip.is-focused').getAttribute('data-pane');

    // Split Down: an empty pane under Bravo's, focused; Alpha picked into it.
    await menu(app, 'Split Down');
    await expect.poll(() => win.locator('.workspace-body > .pane-strip').count()).toBe(2);
    await win.locator('.pane-picker .pp-item', { hasText: 'Alpha' }).click();
    await expect.poll(strips).toEqual([['Bravo'], ['Alpha']]);
    let g = await geometry(win);
    expect(near(g.strips[0]!.x, g.strips[1]!.x) && g.strips[1]!.y > g.frames[0]!.y).toBe(true);
    expect(await focused()).toBe('1');

    await menu(app, 'Focus Pane Above');
    await expect.poll(focused).toBe('0');
    await menu(app, 'Focus Pane Below');
    await expect.poll(focused).toBe('1');
    // At the bottom edge, below wraps to the farthest pane across: the top one.
    await menu(app, 'Focus Pane Below');
    await expect.poll(focused).toBe('0');
    await menu(app, 'Focus Pane Below');
    await expect.poll(focused).toBe('1');

    // Alpha up into Bravo's pane: the lower pane closes. Down again from the edge: a new pane below.
    await menu(app, 'Move Tab to Pane Above');
    await expect(win.locator('.workspace-body.is-split')).toHaveCount(0);
    await expect(win.locator('.tabs .tab')).toHaveText([/Bravo/, /Alpha/]);
    await menu(app, 'Move Tab to Pane Below');
    await expect.poll(strips).toEqual([['Bravo'], ['Alpha']]);
    g = await geometry(win);
    expect(near(g.strips[0]!.w, g.strips[1]!.w) && g.strips[1]!.y > g.frames[0]!.y).toBe(true);
  } finally {
    await stop(app, home);
  }
});
