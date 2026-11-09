// Narrow layouts: a crowded sidebar at its narrowest keeps every name
// readable and nothing in a row collides; chips go compact only when they would cut a name; the rows' close questions
// fit; the smallest window keeps a work area however wide the side panels were left.
import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { e2eEnv } from './env';
import { collisions, crowd, frames, shownWidth, sidebarByKeys, stage } from './narrow-fixture';
import { look } from './shots';


let app: ElectronApplication;
let win: Page;
let home: string;
let project: string;
let staged: ReturnType<typeof crowd>;
/** The crowd again, with some terminals' ports replaced (empty: none). */
const restagePorts = (ports: Record<string, { port: number; name: string }[]>) => stage(app, { list: staged.list, ports: { ...staged.ports, ...ports } }, project);
const six = [3000, 3081, 5173, 6006, 8080, 9229].map((port) => ({ port, name: 'node' }));

const ROW_PIECES = '.avatar, .term-icon, .session-title, .term-name, .term-cmd, .cwd-chip, .profile-chip, .account-chip, .row-popout, .port-chip, .session-activity, .work-chip, .sched-chip, .plan-badge, .resume-title, .resume-btn';
const still = (w: Page) => w.addStyleTag({ content: '*, *::before, *::after { animation: none !important; transition: none !important; }' });
const row = (name: string) => win.locator('.session-row, .term-row', { hasText: name });
const nameOf = (r: Locator) => r.locator('.session-title, .term-name').first();
/** What a name needs to read: all of it, or at least its first several letters. */
const readable = async (l: Locator) => {
  const [shown, full] = [await shownWidth(l), await l.evaluate((el) => el.scrollWidth)];
  return shown >= Math.min(full, 56) - 0.5;
};
/** The pointer off the rows (a row keeps its form under it), then the frame they measure in. */
const away = async () => { await win.mouse.move(900, 500); await frames(win); };
const visibleText = (l: Locator) => l.evaluateAll((els) => els.filter((e) => (e as HTMLElement).offsetWidth > 0 && getComputedStyle(e).display !== 'none').map((e) => (e as HTMLElement).innerText.trim()));

const git = (cwd: string, ...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });

test.beforeAll(async () => {
  project = realpathSync(mkdtempSync(join(tmpdir(), 'atl-prj-')));
  // A repository with changes: Source Control's card shows its name and how many.
  git(project, 'init', '-q', '-b', 'main');
  for (const f of ['a.ts', 'b.ts', 'c.ts']) writeFileSync(join(project, f), '1\n');
  git(project, 'add', '.');
  git(project, 'commit', '-q', '-m', 'first');
  for (const f of ['a.ts', 'b.ts', 'c.ts']) writeFileSync(join(project, f), '2\n');
  const e = e2eEnv({ ATELIER_CLAUDE_BIN: resolve('tests/e2e/fake-claude.pl') });
  home = e.home;
  app = await electron.launch({ args: ['out/main/index.js', `--project=${project}`], env: e.env });
  win = await app.firstWindow();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(1280, 800));
  await expect(win.locator('.sidebar')).toBeVisible();
  staged = crowd(project);
  await stage(app, staged, project);
  await expect(win.locator('.session-row')).toHaveCount(5);
  await still(win);
  await win.evaluate(() => { const w = window as unknown as { roErrors: string[] }; w.roErrors = []; window.addEventListener('error', (e) => { if (/ResizeObserver/.test(e.message)) w.roErrors.push(e.message); }); });
});

// Measuring rows never trips ResizeObserver's loop error (the page reports it to app.log), whatever a test does.
test.afterEach(async () => {
  const errors = await win.evaluate(() => { const w = window as unknown as { roErrors: string[] }; const e = w.roErrors; w.roErrors = []; return e; });
  expect(errors).toEqual([]);
});

test.afterAll(async () => {
  await app.close();
  try { process.kill((JSON.parse(readFileSync(join(home, 'atelierd.json'), 'utf8')) as { pid: number }).pid, 'SIGTERM'); } catch { /* already stopped */ }
});

test('every name stays readable and nothing in a row collides, from 200 px up, at rest and hovered', async () => {
  for (const w of [200, 232, 264, 328]) {
    await sidebarByKeys(win, w);
    await away();
    const rows = win.locator('.sidebar .session-row, .sidebar .term-row, .sidebar .resume-row');
    for (const r of await rows.all()) {
      const label = `${w} px · ${(await r.innerText()).split('\n')[0]}`;
      expect(await collisions(r, ROW_PIECES), label).toEqual([]);
      const name = r.locator('.session-title, .term-name, .resume-title').first();
      expect(await readable(name), `${label}: name cut to ${await shownWidth(name)} px`).toBe(true);
    }
    // Hovered, a terminal row makes room for pin and close: its name still shows, its chips don't move over it.
    for (const t of ['Terminal 1', 'storybook']) {
      const r = row(t);
      await r.hover();
      await frames(win);
      expect(await collisions(r, ROW_PIECES), `${w} px · ${t} hovered`).toEqual([]);
      expect(await shownWidth(nameOf(r)), `${w} px · ${t} hovered`).toBeGreaterThan(24);
    }
  }
  await look(win.locator('.sidebar'), 'test-results/narrow-sidebar-200.png');
  await sidebarByKeys(win, 456);
  await sidebarByKeys(win, 200);
});

test('a terminal shows one port and +N with room, one count chip when its name needs the room', async () => {
  await sidebarByKeys(win, 456);
  await away();
  const chips = row('Terminal 1').locator('.port-chip');
  expect(await visibleText(chips)).toEqual([':3000', '+5']);
  await sidebarByKeys(win, 200);
  await away();
  expect(await visibleText(chips)).toEqual(['6']);
  const all = row('Terminal 1').locator('.port-chip.port-all');
  await expect(all).toHaveAttribute('data-tip', /3000[\s\S]*9229/);
  // Its command gives way too, whole or not at all (never a sliver).
  const cmd = row('Terminal 1').locator('.term-cmd');
  expect(await cmd.evaluate((el) => (el as HTMLElement).offsetWidth === 0 || el.scrollWidth <= el.clientWidth)).toBe(true);
});

test('a session’s chips go compact only when they would cut its name', async () => {
  await sidebarByKeys(win, 264);
  await away();
  // "CI" has the room: its folder chip keeps its text.
  await expect(row('CI').locator('.cwd-chip bdi')).toBeVisible();
  // "Docs for the public API" with a folder, a profile and an account: glyphs, the name whole or nearly.
  const docs = row('Docs for the public');
  await expect(docs).toHaveAttribute('data-tight', '');
  await expect(docs.locator('.cwd-chip bdi')).toBeHidden();
  await expect(docs.locator('.cwd-chip svg')).toBeVisible();
  await expect(docs.locator('.profile-chip svg')).toBeVisible();
  await expect(docs.locator('.account-chip svg')).toBeVisible();
  // Wide enough again: full chips come back.
  await sidebarByKeys(win, 456);
  await away();
  await expect(docs).not.toHaveAttribute('data-tight');
  await expect(docs.locator('.cwd-chip bdi')).toBeVisible();
});

test('a terminal’s Docker ports stay on a crowded row (their chip is already compact)', async () => {
  await sidebarByKeys(win, 200);
  await away();
  const r = row('Terminal 1');
  await expect(r).toHaveAttribute('data-tight', '');
  // DockerPortChips' compact chip (docker/DockerPorts.tsx), where a compose terminal's row has it.
  await r.evaluate((el) => {
    const s = document.createElement('span');
    s.className = 'port-chips dk-port-chips test-whale';
    s.innerHTML = '<button type="button" class="port-chip mono">3</button>';
    el.querySelector(':scope > .port-chips')!.after(s);
  });
  await expect(r.locator('.test-whale .port-chip')).toBeVisible();
  await r.locator('.test-whale').evaluate((el) => el.remove());
});

test('a compact row goes full again when its chips shrink (its server stopped), at the same width', async () => {
  await sidebarByKeys(win, 232);
  await away();
  const r = row('Terminal 1');
  await expect(r).toHaveAttribute('data-tight', '');
  await restagePorts({ 'n-term-ports': [] });
  await expect(r).not.toHaveAttribute('data-tight');
  await expect(r.locator('.term-cmd')).toHaveText('node');
  await expect(r.locator('.term-cmd')).toBeVisible();
  await restagePorts({});
  await expect(r).toHaveAttribute('data-tight', '');
});

test('after its close question the row still watches its name: ports arriving later make it compact', async () => {
  await sidebarByKeys(win, 232);
  await restagePorts({ 'n-term-ports': [] });
  const r = row('Terminal 1');
  await away();
  await expect(r).not.toHaveAttribute('data-tight');
  // Asked and cancelled: the row's content, its name included, is new.
  await r.hover();
  await r.getByRole('button', { name: 'Close Terminal' }).click();
  await expect(win.locator('.term-row.is-confirming')).toBeVisible();
  await win.keyboard.press('Escape');
  await expect(win.locator('.term-row.is-confirming')).toHaveCount(0);
  // The keyboard's focus comes back to the row a frame later (it keeps its form meanwhile); then the user moves on.
  await expect(r.locator('.row-main')).toBeFocused();
  await win.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await away();
  // Only its port chips render (the row itself doesn't): its name must still get its room.
  await restagePorts({ 'n-term-ports': six });
  await expect(r).toHaveAttribute('data-tight', '');
  expect(await readable(r.locator('.term-name'))).toBe(true);
});

test('the second line: one rendering of the work chip, PLAN as P, the waiting reason keeps its words', async () => {
  await sidebarByKeys(win, 200);
  await away();
  for (const chip of await win.locator('.sidebar .work-chip').all()) {
    expect(await chip.locator('.work-full, .work-short, .work-total').evaluateAll((els) => els.filter((e) => getComputedStyle(e).display !== 'none').length)).toBe(1);
  }
  const auth = row('Auth refactor');
  // PLAN as a bare P (the bypass mark's form); its text stays "plan" for the tooltip and screen readers.
  await expect(auth.locator('.plan-badge .plan-full')).toBeHidden();
  expect(await auth.locator('.plan-badge').evaluate((el) => getComputedStyle(el, '::after').content)).toBe('"P"');
  expect((await auth.locator('.plan-badge').boundingBox())!.width).toBeLessThanOrEqual(16);
  await expect(auth.locator('.plan-badge')).toHaveAttribute('data-tip', /Plan mode/);
  // Read as what it is, whatever its form (like the bypass mark).
  await expect(auth.locator('.plan-badge')).toHaveAttribute('role', 'img');
  await expect(auth.locator('.plan-badge')).toHaveAttribute('aria-label', 'Plan mode');
  expect(await shownWidth(auth.locator('.session-activity'))).toBeGreaterThanOrEqual(50);
});

test('a row’s close question fits a 200 px sidebar: no label leaves its button, nothing overlaps', async () => {
  await sidebarByKeys(win, 200);
  for (const [name, button] of [['Email campaign', 'Close Session'], ['Terminal 1', 'Close Terminal']] as const) {
    const r = row(name);
    await r.hover();
    await r.getByRole('button', { name: button }).click();
    const ask = win.locator('.is-confirming');
    await expect(ask).toBeVisible();
    expect(await collisions(ask, 'button, .confirm-note, .confirm-stops, .session-title, .avatar, .term-icon'), name).toEqual([]);
    for (const b of await ask.locator('button').all()) {
      expect(await b.evaluate((el) => el.scrollWidth <= el.clientWidth + 0.5), `${name}: "${await b.innerText()}" spills`).toBe(true);
    }
    await look(ask, `test-results/narrow-confirm-${button.split(' ')[1]!.toLowerCase()}.png`);
    await win.keyboard.press('Escape');
    await expect(ask).toBeHidden();
  }
});

test('Source Control at 200 px: the repository’s name keeps its room, its changes become a count', async () => {
  await sidebarByKeys(win, 200);
  await win.getByRole('button', { name: /^Source Control/ }).click();
  const card = win.locator('.sw-card');
  await expect(card.locator('.sw-chip.is-changes')).toBeVisible();
  expect(await readable(card.locator('.sw-card-title .sw-label'))).toBe(true);
  // "3" on screen; "3 changes" for screen readers (the word is visually hidden, not removed).
  const word = card.locator('.sw-chip-word');
  await expect(word).toHaveCount(1);
  expect(await word.evaluate((el) => getComputedStyle(el).display !== 'none' && el.getBoundingClientRect().width <= 1)).toBe(true);
  expect(Math.round((await card.locator('.sw-chip.is-changes').boundingBox())!.width)).toBeLessThan(24);
  await expect(card.locator('.sw-chip.is-changes')).toHaveAttribute('data-tip', '3 changes');
  await win.getByRole('button', { name: /^Sessions/ }).click();
});

test('Source Control’s section counts line up on the right; a section’s + shows on hover beside its count, moving nothing', async () => {
  await sidebarByKeys(win, 264);
  await win.getByRole('button', { name: /^Source Control/ }).click();
  const head = (k: string) => win.locator(`.scm-section[data-key="${k}"] .scm-section-top`);
  const right = async (k: string) => { const b = (await head(k).locator('.scm-count').boundingBox())!; return b.x + b.width; };
  await expect(head('branches').locator('.scm-section-add')).toHaveCount(1);
  await away();
  // At rest the hidden + takes no room: every count ends where the others do.
  const tags = await right('tags');
  expect(Math.abs((await right('branches')) - tags)).toBeLessThan(0.6);
  expect(Math.abs((await right('stashes')) - tags)).toBeLessThan(0.6);
  // Hovered, the + shows left of the count, over nothing, and the count stays put.
  await head('branches').hover();
  const add = head('branches').locator('.scm-section-add');
  await expect(add).toHaveCSS('opacity', '1');
  expect(Math.abs((await right('branches')) - tags)).toBeLessThan(0.6);
  expect(await collisions(head('branches'), '.scm-section-add, .scm-count, .section-label, .scm-chev')).toEqual([]);
  await look(win.locator('.scm-section[data-key="branches"]'), 'test-results/narrow-scm-section-hover.png');
  await away();
  await win.getByRole('button', { name: /^Sessions/ }).click();
});

test('a narrow session bar keeps the waiting reason readable: the work chip as its total, the context ring alone', async () => {
  await sidebarByKeys(win, 264);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(960, 600));
  await expect.poll(() => win.evaluate(() => window.innerWidth)).toBe(960);
  if (!(await win.locator('.changes').isVisible())) await win.locator('.changes-toggle').click();
  await row('Auth refactor').locator('.row-main').click();
  const bar = win.locator('.session-bar');
  await expect(bar).toBeVisible();
  expect((await bar.boundingBox())!.width).toBeLessThanOrEqual(420);
  expect(await shownWidth(bar.locator('.sb-activity'))).toBeGreaterThanOrEqual(60);
  await expect(bar.locator('.work-total')).toBeVisible();
  await expect(bar.locator('.work-short')).toBeHidden();
  await expect(bar.locator('.ctx-pct')).toBeHidden();
  await look(bar, 'test-results/narrow-session-bar.png');
  // With ports (the crowded bar's glyph form), the same: one rendering, the total.
  await row('Email campaign').locator('.row-main').click();
  await expect(bar.locator('.work-total')).toBeVisible();
  await expect(bar.locator('.work-short')).toBeHidden();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(1280, 800));
});

test('the smallest window keeps a work area with both side panels at their widest; an edge drag responds at once', async () => {
  const saved = async () => JSON.parse(await win.evaluate(() => localStorage.getItem('atelier.panels') ?? '{}')) as { sidebar?: number; changes?: number };
  // Both panels widened in a large window, then the window made as small as it goes.
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(1600, 1000));
  if (!(await win.locator('.changes').isVisible())) await win.locator('.changes-toggle').click();
  await expect(win.locator('.changes')).toBeVisible();
  await sidebarByKeys(win, 480);
  const changesEdge = win.getByRole('separator', { name: 'Resize Changes' });
  await changesEdge.focus();
  for (let i = 0; i < 16; i++) await win.keyboard.press('ArrowLeft');
  expect(await saved()).toEqual({ sidebar: 480, changes: 560 });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(960, 600));
  // The page at its new size first (the work area was wide enough before the resize too).
  await expect.poll(() => win.evaluate(() => window.innerWidth)).toBe(960);
  await frames(win);
  const box = async (sel: string) => (await win.locator(sel).first().boundingBox())!;
  await expect.poll(async () => (await box('.workspace')).width).toBeGreaterThanOrEqual(239.5);
  const page = await win.evaluate(() => ({ scroll: document.documentElement.scrollWidth, inner: window.innerWidth }));
  expect(page.scroll).toBeLessThanOrEqual(page.inner);
  const changes = await box('.changes');
  expect(changes.x + changes.width).toBeLessThanOrEqual(page.inner + 0.5);
  // Changes gives way first, down to its 240 px; the edge says the width drawn, the saved widths are kept.
  expect(Math.round(changes.width)).toBe(240);
  await expect(changesEdge).toHaveAttribute('aria-valuenow', '240');
  expect(await saved()).toEqual({ sidebar: 480, changes: 560 });
  // A toast sits beside Changes as drawn, over the work area (never over the sidebar).
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.webContents.send('ev:shell-env-auto', { phase: 'failed', error: 'test' }));
  const toast = win.locator('.toast');
  await expect(toast).toBeVisible();
  const tb = (await toast.boundingBox())!;
  expect(tb.x + tb.width).toBeLessThanOrEqual(changes.x + 0.5);
  expect(tb.x + tb.width).toBeGreaterThan((await box('.workspace')).x + 100);
  await toast.click();
  // Widening a panel with no room left changes nothing, and never lowers its saved width; nor does a click on an edge
  // that wobbles a pixel.
  await changesEdge.focus();
  await win.keyboard.press('ArrowLeft');
  const sideEdge = win.getByRole('separator', { name: 'Resize sessions bar' });
  const edge = await sideEdge.boundingBox();
  const [x, y] = [edge!.x + edge!.width / 2, edge!.y + edge!.height / 2];
  await win.mouse.move(x, y);
  await win.mouse.down();
  await win.mouse.move(x + 30, y);
  await win.mouse.up();
  await win.mouse.move(x, y);
  await win.mouse.down();
  await win.mouse.move(x, y + 6);
  await win.mouse.move(x - 1, y + 3);
  await win.mouse.up();
  expect(await saved()).toEqual({ sidebar: 480, changes: 560 });
  // The window grows again: the saved widths come back.
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(1600, 1000));
  await expect.poll(async () => Math.round((await box('.changes')).width)).toBe(560);
  expect(Math.round((await box('.sidebar')).width)).toBe(480);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(960, 600));
  // The sidebar, drawn narrower than its saved 480 px: dragging its edge 40 px left narrows it by 40 px at once.
  await expect.poll(async () => (await box('.sidebar')).width).toBeLessThan(479);
  const sidebarBefore = (await box('.sidebar')).width;
  const e2 = (await sideEdge.boundingBox())!;
  const [x2, y2] = [e2.x + e2.width / 2, e2.y + e2.height / 2];
  await win.mouse.move(x2, y2);
  await win.mouse.down();
  await win.mouse.move(x2 - 20, y2);
  await win.mouse.move(x2 - 40, y2);
  await win.mouse.up();
  await expect.poll(async () => Math.round((await box('.sidebar')).width)).toBe(Math.round(sidebarBefore - 40));
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(1280, 800));
});

test('a closing terminal says so on a crowded row', async () => {
  await sidebarByKeys(win, 200);
  const r = row('Terminal 1');
  await r.hover();
  await r.getByRole('button', { name: 'Close Terminal' }).click();
  await win.locator('.term-row.is-confirming').getByRole('button', { name: 'Close', exact: true }).click();
  await expect(r.locator('.term-cmd')).toHaveText('Closing…');
  await away();
  await expect(r.locator('.term-cmd')).toBeVisible();
});
