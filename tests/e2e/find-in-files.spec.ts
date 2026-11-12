// Find in Files, the sidebar view: its activity item under Files, the first-open state, results streaming in grouped by
// file in path order (ignored and binary files left out), the invalid regex, no results, the multiline line, a minified
// file's thousands of matches in a list that keeps only what is on screen, collapse and expand, dismiss, the rows'
// menus from the keyboard, and the layout at the sidebar's narrowest width on either side of the window.
import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { AtelierApi } from '../../src/shared/api';
import { e2eEnv } from './env';
import { layoutProblems, NO_PROBLEMS } from './layout';
import { frames, sidebarByKeys } from './narrow-fixture';
import { look } from './shots';

let app: ElectronApplication;
let win: Page;
let home: string;
let project: string;

const git = (cwd: string, ...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
const write = (rel: string, body: string | Buffer) => {
  mkdirSync(dirname(join(project, rel)), { recursive: true });
  writeFileSync(join(project, rel), body);
};

const SESSION = [
  "import { TokenStore } from './tokens';",
  '',
  'export interface Session {',
  '  userId: string;',
  '  expiresAt: number;',
  '}',
  '',
  'const store = new TokenStore();',
  'const SKEW_MS = 30_000;',
  '',
  'export function readSession(token: string, now = Date.now()): Session | null {',
  '  const entry = store.get(token);',
  '  if (!entry) return null;',
  '  if (entry.expiresAt - SKEW_MS < now) {',
  '    store.delete(token);',
  '    return null;',
  '  }',
  '  return { userId: entry.userId, expiresAt: entry.expiresAt };',
  '}',
  ''
].join('\n');

const TOKENS = [
  'export class TokenStore {',
  '  private entries = new Map<string, { userId: string; expiresAt: number }>();',
  '',
  '  get(token: string) {',
  '    return this.entries.get(token);',
  '  }',
  '',
  '  set(token: string, userId: string, ttlMs: number) {',
  '    this.entries.set(token, { userId, expiresAt: Date.now() + ttlMs });',
  '  }',
  '',
  '  delete(token: string) {',
  '    this.entries.delete(token);',
  '  }',
  '}',
  ''
].join('\n');

/** A long name deep in folders, its match far down (line 1234) on a long line: what the narrowest sidebar must fit. */
const LONG_FILE = 'src/components/checkout/PaymentMethodSelectorWithSavedCards.tsx';
const LONG_BODY = [...Array.from({ length: 1233 }, (_, i) => `// line ${i + 1}`),
  'export const cartTotalForTheCheckoutPageWithEveryDiscountApplied = computeCartTotal(items, discounts, taxes, shippingOptions, giftCards);', ''].join('\n');

const activity = () => win.locator('.activity-bar .act[aria-label^="Find in Files"]');
const view = () => win.locator('.sidebar.is-search');
const field = () => view().getByRole('textbox', { name: 'Search files' });
const totals = () => view().locator('.fif-summary .fif-totals');
const list = () => view().locator('.fif-list');
const rows = () => view().locator('.fif-row');
const fileRows = () => view().locator('.fif-row.is-file');
const fileRow = (rel: string) => view().locator(`.fif-row.is-file[data-rel="${rel}"]`);
const matchRows = (rel: string) => view().locator(`.fif-row.is-match[data-rel="${rel}"]`);
const toggle = (name: string) => view().getByRole('button', { name, exact: true });
const menuLabels = () => win.locator('.ctx-menu .ctx-label');
const still = (w: Page) => w.addStyleTag({ content: '*, *::before, *::after { animation: none !important; transition: none !important; }' });

/**
 * Whether a match row shows its own match whole: inside the text's box and, when the text runs out of it, clear of the
 * "…" that ends it.
 */
const ownShown = (row: Locator) => row.evaluate((el) => {
  const text = el.querySelector<HTMLElement>('.fif-text')!;
  const t = text.getBoundingClientRect();
  const m = text.querySelector('mark.is-own')!.getBoundingClientRect();
  const ellipsis = text.scrollWidth > text.clientWidth + 0.5 ? 11.5 * 0.6 : 0;
  return m.left >= t.left - 0.5 && m.right <= t.right - ellipsis + 0.5;
});

/** A text on one line, whole (no wrap, no cut). */
const oneLine = (l: Locator) => l.evaluate((el) => {
  const r = document.createRange();
  r.selectNodeContents(el);
  const tops = new Set([...r.getClientRects()].filter((x) => x.width > 0).map((x) => Math.round(x.top)));
  return tops.size === 1 && el.scrollWidth <= el.clientWidth + 0.5;
});

async function search(q: string): Promise<void> {
  await field().fill(q);
}

/** Find in Files in front, back to a plain, empty search: every toggle off, the field empty. */
async function fresh(): Promise<void> {
  if (!(await view().isVisible())) await activity().click();
  await expect(field()).toBeVisible();
  for (const name of ['Match Case', 'Whole Word', 'Regular Expression']) {
    if ((await toggle(name).getAttribute('aria-pressed')) === 'true') await toggle(name).click();
  }
  await search('');
}

test.beforeAll(async () => {
  project = realpathSync(mkdtempSync(join(tmpdir(), 'atl-prj-')));
  git(project, 'init', '-q', '-b', 'main');
  write('.gitignore', 'notes.txt\n');
  write('notes.txt', 'a token in an ignored file\n');
  write('assets/blob.bin', Buffer.concat([Buffer.from('token'), Buffer.alloc(32), Buffer.from('token\n')]));
  write('docs/auth.md', '# Auth\n\nEvery request carries a session token in a cookie; `readSession` checks it.\n');
  write('src/auth/session.ts', SESSION);
  write('src/auth/tokens.ts', TOKENS);
  write('lib/app.min.js', `var a=1;${'zq;'.repeat(3000)}\n`);
  write(LONG_FILE, LONG_BODY);
  git(project, 'add', '.');
  git(project, 'commit', '-q', '-m', 'first');
  // Changed since the commit: its row carries the git letter, as in the tree.
  write(LONG_FILE, `${LONG_BODY}// changed\n`);
  const e = e2eEnv();
  home = e.home;
  app = await electron.launch({ args: ['out/main/index.js', `--project=${project}`], env: e.env });
  win = await app.firstWindow();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(1280, 800));
  await expect(win.locator('.sidebar')).toBeVisible();
  await still(win);
});

test.afterAll(async () => {
  await app.close();
  try { process.kill((JSON.parse(readFileSync(join(home, 'atelierd.json'), 'utf8')) as { pid: number }).pid, 'SIGTERM'); } catch { /* already stopped */ }
});

test('the activity item right under Files opens FIND IN FILES: the field focused, the first-open copy, nothing to act on yet', async () => {
  const labels = await win.locator('.activity-bar .act').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label') ?? ''));
  const files = labels.findIndex((l) => l.startsWith('Files'));
  expect(labels[files + 1]).toBe('Find in Files (⌘⇧F)');
  await activity().click();
  await expect(view().locator('.sidebar-head .section-label')).toHaveText('Find in Files');
  await expect(view().locator('.sidebar-head .section-label')).toHaveCSS('text-transform', 'uppercase');
  await expect(field()).toBeFocused();
  await expect(field()).toHaveAttribute('placeholder', 'Search files');
  await expect(view()).toContainText('Searches every text file of the project, as the Files tree lists it: ignored files and build folders stay out unless you ask.');
  await expect(view()).toContainText('Select text anywhere and press ⇧⌘F.');
  for (const name of ['Refresh', 'Clear Results', 'Collapse All']) await expect(view().getByRole('button', { name })).toBeDisabled();
  await look(view(), 'test-results/find-in-files-first-open.png', { settle: 200 });
});

test('typing streams results grouped by file in path order; ignored and binary files stay out; Recent keeps the query', async () => {
  await fresh();
  await search('token');
  await expect(totals()).toHaveText('14 results in 3 files');
  await expect(view().locator('.fif-progress')).toHaveCount(0);
  expect(await fileRows().evaluateAll((els) => els.map((e) => e.getAttribute('data-rel')))).toEqual(['docs/auth.md', 'src/auth/session.ts', 'src/auth/tokens.ts']);
  await expect(fileRow('src/auth/session.ts').locator('.fif-name')).toHaveText('session.ts');
  await expect(fileRow('src/auth/session.ts').locator('.fif-dir')).toHaveText('src/auth');
  await expect(fileRow('src/auth/session.ts').locator('.fif-count')).toHaveText('6');
  await expect(matchRows('src/auth/session.ts')).toHaveCount(6);
  await expect(matchRows('src/auth/tokens.ts')).toHaveCount(7);
  // A row per match: line 1 holds two, each row with both marked and its own one strong.
  const first = matchRows('src/auth/session.ts').first();
  await expect(first.locator('.fif-text')).toHaveText("import { TokenStore } from './tokens';");
  await expect(first.locator('mark')).toHaveText(['Token', 'token']);
  await expect(first.locator('mark.is-own')).toHaveText('Token');
  await expect(matchRows('src/auth/session.ts').nth(1).locator('mark.is-own')).toHaveText('token');
  await expect(first.locator('.fif-ln')).toHaveText('1');
  // Leading whitespace is dropped; a match further along starts a little before it, after "…".
  await expect(matchRows('src/auth/tokens.ts').nth(1).locator('.fif-text')).toHaveText('get(token: string) {');
  await expect(matchRows('src/auth/tokens.ts').nth(1).locator('.fif-ln')).toHaveText('4');
  await expect(matchRows('src/auth/session.ts').nth(3).locator('.fif-text')).toHaveText(/^….*readSession\(token: string/);
  await expect(matchRows('src/auth/session.ts').nth(3).locator('mark.is-own')).toHaveText('token');
  // However far along the line, a row's own match is never pushed out of sight.
  for (const r of await view().locator('.fif-row.is-match').all()) expect(await ownShown(r), await r.innerText()).toBe(true);
  await expect(view()).not.toContainText('notes.txt');
  await expect(view()).not.toContainText('blob.bin');
  for (const name of ['Refresh', 'Clear Results', 'Collapse All']) await expect(view().getByRole('button', { name })).toBeEnabled();
  await look(win, 'test-results/find-in-files-results.png', { settle: 200 });

  // An empty field: the first-open state again, with the search just done under Recent; a click runs it.
  await search('');
  await expect(rows()).toHaveCount(0);
  await expect(view().locator('.fif-recent-item')).toHaveText(['token']);
  await look(view(), 'test-results/find-in-files-recent.png', { settle: 200 });
  await view().locator('.fif-recent-item', { hasText: 'token' }).click();
  await expect(field()).toHaveValue('token');
  await expect(field()).toBeFocused();
  await expect(totals()).toHaveText('14 results in 3 files');

  // Clear Results empties the field and the list.
  await view().getByRole('button', { name: 'Clear Results' }).click();
  await expect(field()).toHaveValue('');
  await expect(rows()).toHaveCount(0);
  await expect(field()).toBeFocused();
});

test('an invalid regular expression marks the field and says why and the way out; .* off finds the text as written', async () => {
  await fresh();
  await toggle('Regular Expression').click();
  await expect(toggle('Regular Expression')).toHaveAttribute('aria-pressed', 'true');
  await search('readSession(token');
  const notice = view().locator('.fif-notice.is-error');
  await expect(notice).toContainText('Unclosed group: add ) or escape the (');
  await expect(notice).toContainText('Turn off .* to search the text as written.');
  await expect(view().locator('.fif-field')).toHaveClass(/is-error/);
  await expect(field()).toHaveAttribute('aria-invalid', 'true');
  await expect(view()).not.toContainText('No results.');
  await look(view(), 'test-results/find-in-files-invalid.png', { settle: 200 });
  await toggle('Regular Expression').click();
  await expect(totals()).toHaveText('1 result in 1 file');
  await expect(view().locator('.fif-field')).not.toHaveClass(/is-error/);
  await expect(notice).toHaveCount(0);
});

test('no match says "No results."; a query holding a line break says searches match within a line', async () => {
  await fresh();
  await search('zzqqxxnothere');
  await expect(view().locator('.fif-state')).toHaveText('No results.');
  await expect(rows()).toHaveCount(0);
  await look(view(), 'test-results/find-in-files-no-results.png', { settle: 200 });
  await search('a\\nb');
  await expect(view().locator('.fif-state')).toHaveText('Searches match within a line.');
});

test('a minified one-line file with 3,000 matches: every row reachable, only what is on screen in the page', async () => {
  await fresh();
  await search('zq');
  await expect(totals()).toHaveText('3,000 results in 1 file');
  await expect(fileRow('lib/app.min.js').locator('.fif-count')).toHaveText('3,000');
  // 26 px for the file, 22 px for each match.
  expect(await list().evaluate((el) => el.scrollHeight)).toBeGreaterThanOrEqual(26 + 3000 * 22);
  expect(await rows().count()).toBeLessThan(120);
  await list().evaluate((el) => { el.scrollTop = el.scrollHeight; });
  await frames(win);
  await expect(view().locator('.fif-row[data-i="3000"]')).toBeVisible();
  await expect(view().locator('.fif-row[data-i="1"]')).toHaveCount(0);
  expect(await rows().count()).toBeLessThan(120);
  // Its match far past the kept text: the row says so with "…".
  await expect(view().locator('.fif-row[data-i="3000"] .fif-text')).toHaveText('…');
  await list().evaluate((el) => { el.scrollTop = 0; });
});

test('a file collapses and expands with a click, ← and →, and Collapse All / Expand All', async () => {
  await fresh();
  await search('token');
  await expect(totals()).toHaveText('14 results in 3 files');
  const session = fileRow('src/auth/session.ts');
  await session.click();
  await expect(session).toHaveAttribute('aria-expanded', 'false');
  await expect(matchRows('src/auth/session.ts')).toHaveCount(0);
  await expect(session).toBeFocused();
  await win.keyboard.press('ArrowRight');
  await expect(session).toHaveAttribute('aria-expanded', 'true');
  await expect(matchRows('src/auth/session.ts')).toHaveCount(6);
  await win.keyboard.press('ArrowLeft');
  await expect(matchRows('src/auth/session.ts')).toHaveCount(0);
  await session.click();
  await expect(matchRows('src/auth/session.ts')).toHaveCount(6);
  // ↓ walks into the file's matches; ← on a match goes back to its file.
  await session.focus();
  await win.keyboard.press('ArrowDown');
  await expect(matchRows('src/auth/session.ts').first()).toBeFocused();
  await win.keyboard.press('ArrowLeft');
  await expect(session).toBeFocused();
  // Esc puts the keyboard back in the field.
  await win.keyboard.press('Escape');
  await expect(field()).toBeFocused();

  await view().getByRole('button', { name: 'Collapse All' }).click();
  await expect(view().locator('.fif-row.is-match')).toHaveCount(0);
  await expect(fileRows()).toHaveCount(3);
  await view().getByRole('button', { name: 'Expand All' }).click();
  await expect(view().locator('.fif-row.is-match')).toHaveCount(14);
});

test('hover turns the line number into ×: dismissing a match or a whole file updates the counts', async () => {
  await fresh();
  await search('token');
  await expect(totals()).toHaveText('14 results in 3 files');
  const m = matchRows('src/auth/tokens.ts').first();
  await expect(m.getByRole('button', { name: 'Dismiss' })).toBeHidden();
  await m.hover();
  await expect(m.locator('.fif-ln')).toBeHidden();
  await m.getByRole('button', { name: 'Dismiss' }).click();
  await expect(totals()).toHaveText('13 results in 3 files');
  await expect(fileRow('src/auth/tokens.ts').locator('.fif-count')).toHaveText('6');
  const f = fileRow('docs/auth.md');
  await f.hover();
  await f.getByRole('button', { name: 'Dismiss' }).click();
  await expect(totals()).toHaveText('12 results in 2 files');
  await expect(fileRow('docs/auth.md')).toHaveCount(0);
  // ⌘⌫ on the selected row dismisses it too.
  await fileRow('src/auth/session.ts').click();
  await win.keyboard.press('Meta+Backspace');
  await expect(totals()).toHaveText('6 results in 1 file');
});

test('Shift+F10 opens the row\'s menu: a file\'s and a match\'s items, in order', async () => {
  await fresh();
  await search('token');
  await expect(totals()).toHaveText('14 results in 3 files');
  await field().focus();
  await win.keyboard.press('ArrowDown');
  await expect(fileRow('docs/auth.md')).toBeFocused();
  await win.keyboard.press('Shift+F10');
  await expect(menuLabels()).toHaveText(['Open', 'Open to the Side', 'Reveal in Files', 'Copy Path', 'Copy Relative Path', 'Dismiss']);
  await win.keyboard.press('Escape');
  await expect(menuLabels()).toHaveCount(0);
  await win.keyboard.press('ArrowDown');
  await expect(matchRows('docs/auth.md').first()).toBeFocused();
  await win.keyboard.press('Shift+F10');
  await expect(menuLabels()).toHaveText(['Open', 'Open to the Side', 'Copy Line', 'Dismiss']);
  await look(win, 'test-results/find-in-files-match-menu.png', { settle: 200, clip: { x: 0, y: 40, width: 640, height: 360 } });
  await win.keyboard.press('Escape');
});

test('at the sidebar\'s narrowest (200 px), on the left and swapped to the right: nothing overlaps, wraps or is cut', async () => {
  await fresh();
  await search('cart');
  await expect(totals()).toHaveText('2 results in 1 file');
  await expect(fileRow(LONG_FILE).locator('.tree-badge')).toHaveText('M');
  const FILE_PARTS = ['.fif-chev', '.file-icon', '.fif-name', '.fif-dir', '.tree-dots', '.tree-badge', '.fif-count', '.fif-x'];
  const MATCH_PARTS = ['.fif-text', '.fif-ln', '.fif-x'];
  const HEAD_PARTS = ['.section-label', '.icon-btn'];
  const FIELD_PARTS = ['.fif-field input', '.fif-opt', '.fif-funnel'];
  const check = async (where: string) => {
    await win.mouse.move(640, 790);
    await frames(win);
    const head = view().locator('.sidebar-head');
    expect(await layoutProblems(head, HEAD_PARTS), `${where}: head`).toEqual(NO_PROBLEMS);
    expect(await oneLine(head.locator('.section-label')), `${where}: the head's name on one line, whole`).toBe(true);
    expect(await layoutProblems(view().locator('.fif-query'), FIELD_PARTS), `${where}: field`).toEqual(NO_PROBLEMS);
    expect(await layoutProblems(view().locator('.fif-summary'), ['.fif-totals']), `${where}: summary`).toEqual(NO_PROBLEMS);
    const f = fileRow(LONG_FILE);
    expect(await layoutProblems(f, FILE_PARTS), `${where}: file row`).toEqual(NO_PROBLEMS);
    for (const m of await matchRows(LONG_FILE).all()) {
      expect(await layoutProblems(m, MATCH_PARTS), `${where}: match row`).toEqual(NO_PROBLEMS);
      expect(await ownShown(m), `${where}: its match in sight`).toBe(true);
    }
    // Hovered: × takes the count's (or the line number's) place without crowding the text.
    await f.hover();
    expect(await layoutProblems(f, FILE_PARTS), `${where}: file row hovered`).toEqual(NO_PROBLEMS);
    const m = matchRows(LONG_FILE).first();
    await m.hover();
    expect(await layoutProblems(m, MATCH_PARTS), `${where}: match row hovered`).toEqual(NO_PROBLEMS);
    // The pieces that must stay whole: the count, the line number.
    expect(await f.locator('.fif-name').evaluate((el) => getComputedStyle(el).textOverflow)).toBe('ellipsis');
  };
  await sidebarByKeys(win, 200);
  expect(await view().evaluate((el) => Math.round(el.getBoundingClientRect().width))).toBe(200);
  await check('left');
  await look(view(), 'test-results/find-in-files-200.png');
  await win.evaluate(() => (window as unknown as { atelier: AtelierApi }).atelier.settings.set({ swapSidePanels: true }));
  await expect(win.locator('.body')).toHaveClass(/is-swapped/);
  await check('swapped');
  await look(win, 'test-results/find-in-files-200-swapped.png');
  await win.evaluate(() => (window as unknown as { atelier: AtelierApi }).atelier.settings.set({ swapSidePanels: false }));
  await sidebarByKeys(win, 264);
});
