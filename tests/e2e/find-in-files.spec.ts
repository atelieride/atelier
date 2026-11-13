// Find in Files, the sidebar view: its activity item under Files, the first-open state, results streaming in grouped by
// file in path order (ignored and binary files left out), the invalid regex, no results, the multiline line, a minified
// file's thousands of matches in a list that keeps only what is on screen, collapse and expand, dismiss, the rows'
// menus from the keyboard, the filters, files changed since a search, the layout at the sidebar's narrowest width on
// either side of the window, and the results sent to a Claude session's prompt (fake-claude-prompt.pl) or copied.
import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
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

/** A test file with "expiresAt" once: what excluding the test files leaves out. */
const EXPIRY_TEST = [
  "import { expect, it } from 'vitest';",
  '',
  "it('ends an entry once expiresAt is past', () => {",
  '  expect(Date.now()).toBeGreaterThan(0);',
  '});',
  ''
].join('\n');

/** A line of about 100 characters whose match is past column 40: kept whole all the same, so copied whole. */
const IDLE_LINE = 'Idle sessions end after thirty minutes; the next request then meets the zebrafish login page again.';

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
/** The open menu as read: each item's label with its key hint in brackets, a separator as "—". */
const menuShape = () => win.locator('.ctx-menu').first().evaluate((m) => [...m.children].map((c) => {
  if (c.classList.contains('ctx-sep')) return '—';
  const hint = c.querySelector('.ctx-hint')?.textContent;
  return `${c.querySelector('.ctx-label')?.textContent ?? ''}${hint ? ` [${hint}]` : ''}`;
}));
const skippedLink = () => view().locator('.fif-skipped-link');
const still = (w: Page) => w.addStyleTag({ content: '*, *::before, *::after { animation: none !important; transition: none !important; }' });
const command = (cmd: string) => app.evaluate(({ BrowserWindow }, c) => BrowserWindow.getAllWindows()[0]!.webContents.send('ev:command', c), cmd);
const sizeTo = (w: number, h: number) => app.evaluate(({ BrowserWindow }, s) => BrowserWindow.getAllWindows()[0]!.setContentSize(s.w, s.h), { w, h });
/** What the app copied (the test copy log, never the real clipboard). */
const copies = (): unknown[] => {
  const log = join(home, 'test-clipboard.log');
  return existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as unknown) : [];
};

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
  write('docs/auth.md', `# Auth\n\nEvery request carries a session token in a cookie; \`readSession\` checks it.\n\n${IDLE_LINE}\n`);
  write('src/auth/session.ts', SESSION);
  write('src/auth/tokens.ts', TOKENS);
  write('src/auth/expiry.test.ts', EXPIRY_TEST);
  write('lib/app.min.js', `var a=1;${'zq;'.repeat(3000)}\n`);
  write(LONG_FILE, LONG_BODY);
  git(project, 'add', '.');
  git(project, 'commit', '-q', '-m', 'first');
  // Changed since the commit: its row carries the git letter, as in the tree.
  write(LONG_FILE, `${LONG_BODY}// changed\n`);
  // A file nobody may read: every search lists it under "files not searched".
  write('secret.txt', 'a token nobody can read\n');
  chmodSync(join(project, 'secret.txt'), 0o000);
  // Claude's prompt as a fake that echoes what is pasted into it and says when something is submitted.
  const e = e2eEnv({ ATELIER_CLAUDE_BIN: resolve('tests/e2e/fake-claude-prompt.pl') });
  home = e.home;
  // Which windows came forward (hidden in e2e, so never really): the pop-out's F4 must not raise the project window.
  e.env.ATELIER_TEST_REVEAL_LOG = join(home, 'test-reveals.log');
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
  await expect(view()).toContainText('Select text anywhere and press ⌘⇧F.');
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
  // The line is kept to its end: no word cut short, no "…" when nothing follows.
  await expect(matchRows('src/auth/session.ts').nth(3).locator('.fif-text')).toHaveText(/^….*readSession\(token: string, now = Date\.now\(\)\): Session \| null \{$/);
  await expect(matchRows('src/auth/session.ts').nth(3).locator('mark.is-own')).toHaveText('token');
  // However far along the line, a row's own match is never pushed out of sight.
  for (const r of await view().locator('.fif-row.is-match').all()) expect(await ownShown(r), await r.innerText()).toBe(true);
  await expect(view()).not.toContainText('notes.txt');
  await expect(view()).not.toContainText('blob.bin');
  // The unreadable file is named among the files not searched.
  await expect(skippedLink()).toHaveText('1 file not searched');
  // Each row's place in the tree, for assistive technologies (the list is virtualized).
  await expect(fileRow('src/auth/session.ts')).toHaveAttribute('aria-posinset', '2');
  await expect(fileRow('src/auth/session.ts')).toHaveAttribute('aria-setsize', '3');
  await expect(matchRows('src/auth/session.ts').nth(2)).toHaveAttribute('aria-posinset', '3');
  await expect(matchRows('src/auth/session.ts').nth(2)).toHaveAttribute('aria-setsize', '6');
  for (const name of ['Refresh', 'Clear Results', 'Collapse All']) await expect(view().getByRole('button', { name })).toBeEnabled();
  await look(win, 'test-results/find-in-files-results.png', { settle: 200 });

  // Copy Line: a line kept whole is copied whole.
  await matchRows('src/auth/session.ts').nth(3).click({ button: 'right' });
  await win.getByRole('menuitem', { name: 'Copy Line' }).click();
  await expect.poll(() => copies().at(-1)).toBe('export function readSession(token: string, now = Date.now()): Session | null {');

  // An empty field: the first-open state again, with the search just done first under Recent; a click runs it.
  await search('');
  await expect(rows()).toHaveCount(0);
  await expect(view().locator('.fif-recent-item').first()).toHaveText('token');
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

  // A line shorter than the cap whose match is far along it is kept, and copied, whole: nothing cut, no "…".
  await search('zebrafish');
  await expect(totals()).toHaveText('1 result in 1 file');
  await matchRows('docs/auth.md').first().click({ button: 'right' });
  await win.getByRole('menuitem', { name: 'Copy Line' }).click();
  await expect.poll(() => copies().at(-1)).toBe(IDLE_LINE);
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
  await expect(field()).toHaveAccessibleDescription(/Unclosed group: add \) or escape the \(/);
  await expect(view().getByRole('button', { name: 'Refresh' })).toBeDisabled();
  await expect(view()).not.toContainText('No results.');
  await look(view(), 'test-results/find-in-files-invalid.png', { settle: 200 });
  await toggle('Regular Expression').click();
  await expect(totals()).toHaveText('1 result in 1 file');
  await expect(view().locator('.fif-field')).not.toHaveClass(/is-error/);
  await expect(notice).toHaveCount(0);
});

test('no match says "No results." with the files not searched; a query holding a line break says searches match within a line', async () => {
  await fresh();
  await search('zzqqxxnothere');
  await expect(view().locator('.fif-state')).toHaveText('No results. · 1 file not searched');
  await expect(rows()).toHaveCount(0);
  await look(view(), 'test-results/find-in-files-no-results.png', { settle: 200 });

  // The files not searched: each with its reason; Esc closes the list and gives the keyboard back to the link.
  await skippedLink().click();
  const pop = view().locator('.fif-skipped');
  await expect(pop).toContainText('secret.txt');
  await expect(pop).toContainText('Unreadable · 24 B');
  await look(view(), 'test-results/find-in-files-skipped.png', { settle: 200 });
  await win.keyboard.press('Escape');
  await expect(pop).toHaveCount(0);
  await expect(skippedLink()).toBeFocused();
  // A new search closes it.
  await skippedLink().click();
  await expect(pop).toBeVisible();
  await search('zzqqxxnothere2');
  await expect(view().locator('.fif-state')).toHaveText('No results. · 1 file not searched');
  await expect(pop).toHaveCount(0);

  await search('a\\nb');
  await expect(view().locator('.fif-state')).toHaveText('Searches match within a line.');
  await expect(field()).toHaveAccessibleDescription('Searches match within a line.');
  await expect(view().getByRole('button', { name: 'Refresh' })).toBeDisabled();
});

test('a minified one-line file with 3,000 matches: every row reachable, only what is on screen in the page', async () => {
  await fresh();
  await search('zq');
  await expect(totals()).toHaveText('3,000 results in 1 file');
  // Past 999 the pill says so; the exact count is in its tip.
  await expect(fileRow('lib/app.min.js').locator('.fif-count')).toHaveText('999+');
  await expect(fileRow('lib/app.min.js').locator('.fif-count')).toHaveAttribute('aria-label', '3,000 results');
  await expect(fileRow('lib/app.min.js').locator('.fif-count')).toHaveAttribute('data-tip', '3,000 results');
  // 26 px for the file, 22 px for each match.
  expect(await list().evaluate((el) => el.scrollHeight)).toBeGreaterThanOrEqual(26 + 3000 * 22);
  expect(await rows().count()).toBeLessThan(120);
  // The line goes on past the kept text (2,000 characters): the row ends with "…", and so does its copy. The row shows
  // at most 250 characters of it.
  await expect(view().locator('.fif-row[data-i="1"] .fif-text')).toHaveText(/…$/);
  expect(await view().locator('.fif-row[data-i="1"] .fif-text').evaluate((el) => (el.textContent ?? '').length)).toBeLessThanOrEqual(252);
  await view().locator('.fif-row[data-i="1"]').click({ button: 'right' });
  await win.getByRole('menuitem', { name: 'Copy Line' }).click();
  await expect.poll(() => copies().at(-1)).toMatch(/^var a=1;zq;.*…$/);
  expect((copies().at(-1) as string).length).toBe(2001);

  await list().evaluate((el) => { el.scrollTop = el.scrollHeight; });
  await frames(win);
  await expect(view().locator('.fif-row[data-i="3000"]')).toBeVisible();
  // Row 1 stays in the page (selected by its menu, it keeps the keyboard); its neighbours are gone.
  await expect(view().locator('.fif-row[data-i="2"]')).toHaveCount(0);
  expect(await rows().count()).toBeLessThan(120);
  // Its match far past the kept text: the row says so with "…".
  await expect(view().locator('.fif-row[data-i="3000"] .fif-text')).toHaveText('…');

  // The selection survives the view going away and coming back: in sight again.
  await field().focus();
  await win.keyboard.press('ArrowDown');
  await win.keyboard.press('End');
  await expect(view().locator('.fif-row[data-i="3000"]')).toBeFocused();
  await win.locator('.activity-bar .act[aria-label^="Files"]').click();
  await expect(view()).toHaveCount(0);
  await activity().click();
  await expect(view().locator('.fif-row[data-i="3000"]')).toBeInViewport();
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

  // The head and the list's menu agree on what is open: a dismissed file, open when it went, counts for neither.
  await fileRow('src/auth/session.ts').click();
  await fileRow('src/auth/tokens.ts').click();
  await fileRow('docs/auth.md').hover();
  await fileRow('docs/auth.md').getByRole('button', { name: 'Dismiss' }).click();
  await expect(view().getByRole('button', { name: 'Expand All' })).toBeVisible();
  await view().locator('.fif-summary').click({ button: 'right' });
  await expect(menuLabels()).toContainText(['Expand All']);
  await expect(menuLabels()).not.toContainText(['Collapse All']);
  await win.keyboard.press('Escape');
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
  // The last row gone, the keyboard goes back to the field rather than nowhere.
  await expect(fileRow('src/auth/tokens.ts')).toBeFocused();
  await win.keyboard.press('Meta+Backspace');
  await expect(rows()).toHaveCount(0);
  await expect(field()).toBeFocused();
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
  expect(await menuShape()).toEqual(['Open', 'Open to the Side [⌘⏎]', 'Reveal in Files', '—', 'Copy Path', 'Copy Relative Path', '—', 'Dismiss [⌘⌫]']);
  await win.keyboard.press('Escape');
  await expect(menuLabels()).toHaveCount(0);
  await win.keyboard.press('ArrowDown');
  await expect(matchRows('docs/auth.md').first()).toBeFocused();
  await win.keyboard.press('Shift+F10');
  await expect(menuLabels()).toHaveText(['Open', 'Open to the Side', 'Copy Line', 'Dismiss']);
  expect(await menuShape()).toEqual(['Open', 'Open to the Side [⌘⏎]', 'Copy Line', 'Dismiss [⌘⌫]']);
  await look(win, 'test-results/find-in-files-match-menu.png', { settle: 200, clip: { x: 0, y: 40, width: 640, height: 360 } });
  await win.keyboard.press('Escape');
});

test('⌥C, ⌥W and ⌥R in the field turn Match Case, Whole Word and Regular Expression on and off', async () => {
  await fresh();
  await search('token');
  await expect(totals()).toHaveText('14 results in 3 files');
  await field().focus();
  await win.keyboard.press('Alt+c');
  await expect(toggle('Match Case')).toHaveAttribute('aria-pressed', 'true');
  await expect(totals()).toHaveText('11 results in 3 files');
  await win.keyboard.press('Alt+w');
  await expect(toggle('Whole Word')).toHaveAttribute('aria-pressed', 'true');
  await win.keyboard.press('Alt+r');
  await expect(toggle('Regular Expression')).toHaveAttribute('aria-pressed', 'true');
  // Nothing typed into the query by the way.
  await expect(field()).toHaveValue('token');
  for (const k of ['Alt+c', 'Alt+w', 'Alt+r']) await win.keyboard.press(k);
  for (const name of ['Match Case', 'Whole Word', 'Regular Expression']) await expect(toggle(name)).toHaveAttribute('aria-pressed', 'false');
  await expect(totals()).toHaveText('14 results in 3 files');
});

test('filters: "Search the whole project" clears the paths and leaves Include ignored files as it is; the lit funnel answers the pointer', async () => {
  await fresh();
  const funnel = view().getByRole('button', { name: 'Filters' });
  /** A color as the page computes it (rgb…), for comparing a token with a computed background. */
  const bgOf = (css: string) => win.evaluate((c) => { const d = document.createElement('div'); d.style.background = c; document.body.appendChild(d); const v = getComputedStyle(d).backgroundColor; d.remove(); return v; }, css);
  await funnel.click();
  // Open but not lit: under the pointer, the plain hover, not the lit tint.
  await expect(funnel).not.toHaveClass(/is-lit/);
  const neutral = await bgOf('var(--bg-3)');
  await expect.poll(() => funnel.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(neutral);
  await view().getByRole('textbox', { name: 'Files to include' }).fill('docs/');
  await search('TokenStore');
  await expect(view().locator('.fif-state')).toHaveText('No results in docs/. Search the whole project');
  const ignored = view().getByRole('switch', { name: 'Include ignored files' });
  await ignored.click();
  await expect(ignored).toHaveAttribute('aria-checked', 'true');
  await view().getByRole('button', { name: 'Search the whole project' }).click();
  await expect(view().getByRole('textbox', { name: 'Files to include' })).toHaveValue('');
  await expect(ignored).toHaveAttribute('aria-checked', 'true');
  await expect(totals()).toHaveText('3 results in 2 files');
  // Still lit (Include ignored files is on), and it reacts under the pointer like every button.
  await funnel.click();
  await expect(funnel).toHaveClass(/is-lit/);
  await win.mouse.move(640, 790);
  const rest = await funnel.evaluate((el) => getComputedStyle(el).backgroundColor);
  await funnel.hover();
  await expect.poll(() => funnel.evaluate((el) => getComputedStyle(el).backgroundColor)).not.toBe(rest);
  await funnel.click();
  await ignored.click();
  await funnel.click();
  await expect(funnel).not.toHaveClass(/is-lit/);
});

test('filters: src/ narrows, **/*.test.ts leaves the tests out, the funnel stays lit closed; "No results in src/" leads to the whole project; Include ignored files finds the ignored file', async () => {
  await fresh();
  const funnel = view().getByRole('button', { name: 'Filters' });
  const include = view().getByRole('textbox', { name: 'Files to include' });
  const exclude = view().getByRole('textbox', { name: 'Files to exclude' });
  const ignored = view().getByRole('switch', { name: 'Include ignored files' });
  const rels = () => fileRows().evaluateAll((els) => els.map((e) => e.getAttribute('data-rel')));
  await search('token');
  await expect(totals()).toHaveText('14 results in 3 files');
  await funnel.click();
  await include.fill('src/');
  await expect(totals()).toHaveText('13 results in 2 files');
  expect(await rels()).toEqual(['src/auth/session.ts', 'src/auth/tokens.ts']);
  // The test file holds the query once: excluding the test files leaves it out.
  await search('expiresAt');
  await expect(totals()).toHaveText('7 results in 3 files');
  await exclude.fill('**/*.test.ts');
  await expect(totals()).toHaveText('6 results in 2 files');
  expect(await rels()).toEqual(['src/auth/session.ts', 'src/auth/tokens.ts']);
  await win.mouse.move(640, 790);
  await look(view(), 'test-results/find-in-files-filters.png', { settle: 200 });
  // Closed, the funnel still says a filter is on.
  await funnel.click();
  await expect(view().locator('.fif-filters')).toHaveCount(0);
  await expect(funnel).toHaveClass(/is-lit/);
  // A match only outside src/: no results there, and the way to the whole project, which clears both paths.
  await search('zebrafish');
  await expect(view().locator('.fif-state')).toHaveText('No results in src/. Search the whole project');
  await view().getByRole('button', { name: 'Search the whole project' }).click();
  await expect(totals()).toHaveText('1 result in 1 file');
  await expect(funnel).not.toHaveClass(/is-lit/);
  await funnel.click();
  await expect(include).toHaveValue('');
  await expect(exclude).toHaveValue('');
  // An ignored file is searched only on request.
  await search('ignored file');
  await expect(view().locator('.fif-state')).toHaveText('No results. · 1 file not searched');
  await ignored.click();
  await expect(totals()).toHaveText('1 result in 1 file');
  expect(await rels()).toEqual(['notes.txt']);
  await expect(matchRows('notes.txt').first().locator('mark.is-own')).toHaveText('ignored file');
  await ignored.click();
  await expect(view().locator('.fif-state')).toHaveText('No results. · 1 file not searched');
  await funnel.click();
  await expect(funnel).not.toHaveClass(/is-lit/);
});

test('a notice that arrives once rows are on screen sits right under the last of them', async () => {
  await fresh();
  await search('token');
  await expect(totals()).toHaveText('14 results in 3 files');
  appendFileSync(join(project, 'src/auth/tokens.ts'), '// touched\n');
  const line = view().locator('.fif-foot .fif-quiet', { hasText: 'Files changed since this search' });
  await expect(line).toBeVisible({ timeout: 15000 });
  const last = (await rows().last().boundingBox())!;
  const at = (await line.boundingBox())!;
  expect(at.y - (last.y + last.height)).toBeLessThan(40);
  await expect(line).toHaveText('Files changed since this search · Refresh');
  await look(view(), 'test-results/find-in-files-stale.png', { settle: 200 });
  await line.getByRole('button', { name: 'Refresh' }).click();
  await expect(line).toHaveCount(0);
  await expect(totals()).toHaveText('14 results in 3 files');
  // A new file is a change too; nothing runs again by itself, Refresh does.
  write('src/auth/pangolin.ts', 'export const pangolinToken = 1;\n');
  await expect(line).toBeVisible({ timeout: 15000 });
  await expect(totals()).toHaveText('14 results in 3 files');
  await line.getByRole('button', { name: 'Refresh' }).click();
  await expect(line).toHaveCount(0);
  await expect(totals()).toHaveText('15 results in 4 files');
});

test('at the 600 px window height, ten recent searches with the filters open still reach the bottom', async () => {
  await fresh();
  const recent = Array.from({ length: 10 }, (_, i) => ({ query: `recent query ${i + 1}`, matchCase: i % 2 === 0, wholeWord: false, regex: i % 3 === 0 }));
  await win.evaluate(({ root, list }) => {
    const all = JSON.parse(localStorage.getItem('atelier.search.recent') ?? '{}') as Record<string, unknown>;
    localStorage.setItem('atelier.search.recent', JSON.stringify({ ...all, [root]: list }));
  }, { root: project, list: recent });
  // Read again when the field empties.
  await search('x');
  await search('');
  await expect(view().locator('.fif-recent-item')).toHaveCount(10);
  await sizeTo(1280, 600);
  await view().getByRole('button', { name: 'Filters' }).click();
  const end = view().locator('.fif-about.is-keys');
  await view().locator('.fif-empty').evaluate((el) => { el.scrollTop = el.scrollHeight; });
  await expect(end).toBeInViewport({ ratio: 1 });
  await look(win, 'test-results/find-in-files-600.png', { settle: 200 });
  await view().getByRole('button', { name: 'Filters' }).click();
  await sizeTo(1280, 800);
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
    expect(await layoutProblems(view().locator('.fif-summary'), ['.fif-totals', '.fif-skipped-link', '.fif-send']), `${where}: summary`).toEqual(NO_PROBLEMS);
    expect(await oneLine(view().locator('.fif-totals')), `${where}: the totals whole`).toBe(true);
    // Not even a fraction of a pixel short of its text: that much already draws the ellipsis.
    expect(await view().locator('.fif-totals').evaluate((el) => {
      const r = document.createRange();
      r.selectNodeContents(el);
      return r.getBoundingClientRect().width - el.getBoundingClientRect().width;
    }), `${where}: the totals' text fits their box`).toBeLessThanOrEqual(0);
    // Send to session stays within reach: its sparkle at least, the name in its tip.
    await expect(view().locator('.fif-send svg')).toBeInViewport({ ratio: 1 });
    await expect(view().locator('.fif-send')).toHaveAttribute('data-tip', 'Send to session');
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

test('the sidebar shown again leaves the keyboard where it was; the activity item puts it in the field', async () => {
  await fresh();
  await win.getByRole('button', { name: 'Open a terminal' }).click();
  const term = win.locator('.xterm-helper-textarea:visible');
  await expect(term).toBeFocused({ timeout: 10000 });
  await command('toggle-sidebar');
  await expect(view()).toHaveCount(0);
  await command('toggle-sidebar');
  await expect(field()).toBeVisible();
  await frames(win);
  await expect(term).toBeFocused();
  await expect(field()).not.toBeFocused();
  // Nothing holding the keyboard (as in a browser where a click leaves buttons unfocused): the field takes it.
  await win.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await command('toggle-sidebar');
  await expect(view()).toHaveCount(0);
  await command('toggle-sidebar');
  await expect(field()).toBeFocused();
  // In front, its item hides the sidebar; once more, it opens the view on purpose: the field takes the keyboard.
  await activity().click();
  await expect(view()).toHaveCount(0);
  await activity().click();
  await expect(field()).toBeFocused();
});

const editor = () => win.locator('.file-view:visible').first();
const content = () => editor().locator('.cm-content');
const strongLine = () => editor().locator('.cm-fif-hit-strong').evaluate((el) => el.closest('.cm-line')?.textContent ?? '');
const selectedRow = () => view().locator('.fif-row.is-selected');
const pageSelection = (w: Page = win) => w.evaluate(() => window.getSelection()?.toString() ?? '');
const activeTab = () => win.locator('.tab.is-active');
/** The field's text, and whether all of it is selected (what ⌘⇧F leaves, ready to type over). */
const fieldSelection = () => field().evaluate((el: HTMLInputElement) => ({ value: el.value, whole: el.selectionStart === 0 && el.selectionEnd === el.value.length }));
/** The visible terminal's row holding `text`. */
const termRow = (text: RegExp) => win.locator('.xterm-rows:visible > div', { hasText: text }).last();
/** "SKEW_MS" on line 9 of session.ts, selected with the keyboard: after "const ", seven characters. */
async function selectSkew(): Promise<void> {
  await editor().locator('.cm-line', { hasText: 'const SKEW_MS' }).click();
  await win.keyboard.press('Home');
  for (let i = 0; i < 6; i++) await win.keyboard.press('ArrowRight');
  for (let i = 0; i < 7; i++) await win.keyboard.press('Shift+ArrowRight');
  await expect.poll(() => pageSelection()).toBe('SKEW_MS');
}

test('⌘⇧F with a word selected in the editor: the sidebar comes back on Find in Files with that word searched, its text selected', async () => {
  await fresh();
  await search('readSession');
  await expect(totals()).toHaveText('2 results in 2 files');
  await matchRows('src/auth/session.ts').first().click();
  await expect(content()).toBeFocused();
  await selectSkew();
  // From anywhere: the sidebar hidden (or on another view) comes back on Find in Files.
  await command('toggle-sidebar');
  await expect(view()).toHaveCount(0);
  await command('find-in-files');
  await expect(field()).toBeFocused();
  await expect.poll(fieldSelection).toEqual({ value: 'SKEW_MS', whole: true });
  await expect(totals()).toHaveText('2 results in 1 file');
  // Nothing selected: the field as it was, its text selected to type over.
  await command('view-files');
  await expect(view()).toHaveCount(0);
  await content().focus();
  await win.keyboard.press('ArrowRight');
  await command('find-in-files');
  await expect(field()).toBeFocused();
  await expect.poll(fieldSelection).toEqual({ value: 'SKEW_MS', whole: true });
});

test('right after a result opens, its match selected, ⌘⇧F keeps the query that found it (a regular expression too)', async () => {
  await fresh();
  await toggle('Regular Expression').click();
  await search('Token\\w+');
  // TokenStore three times, and "tokens" in the import's path.
  await expect(totals()).toHaveText('4 results in 2 files');
  await matchRows('src/auth/session.ts').first().click();
  await expect(content()).toBeFocused();
  await expect.poll(() => pageSelection()).toBe('TokenStore');
  await command('find-in-files');
  await expect(field()).toBeFocused();
  await expect.poll(fieldSelection).toEqual({ value: 'Token\\w+', whole: true });
  await expect(toggle('Regular Expression')).toHaveAttribute('aria-pressed', 'true');
  // Selected by the user, the same text is the query (escaped for the regular expression).
  await content().focus();
  await win.keyboard.press('ArrowLeft');
  for (let i = 0; i < 10; i++) await win.keyboard.press('Shift+ArrowRight');
  await expect.poll(() => pageSelection()).toBe('TokenStore');
  await command('find-in-files');
  await expect.poll(fieldSelection).toEqual({ value: 'TokenStore', whole: true });
});

test('⌘⇧F with text selected in a Markdown preview searches it', async () => {
  await fresh();
  await search('cookie');
  await matchRows('docs/auth.md').first().click();
  await editor().locator('.md-switch').getByRole('radio', { name: 'Preview' }).click();
  const page = editor().locator('.md-preview .md-scroll');
  await expect(page).toContainText('Every request carries');
  // "session token", selected in the rendered page as a drag would.
  await page.evaluate((el) => {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const at = n.textContent?.indexOf('session token') ?? -1;
      if (at < 0) continue;
      const r = document.createRange();
      r.setStart(n, at);
      r.setEnd(n, at + 'session token'.length);
      (el as HTMLElement).focus();
      window.getSelection()?.removeAllRanges();
      window.getSelection()?.addRange(r);
      return;
    }
  });
  await expect.poll(() => pageSelection()).toBe('session token');
  await command('find-in-files');
  await expect(field()).toBeFocused();
  await expect.poll(fieldSelection).toEqual({ value: 'session token', whole: true });
  await expect(totals()).toHaveText('1 result in 1 file');
});

test('⌘⇧F with text selected in a terminal searches it; F4 there stays the program\'s', async () => {
  await fresh();
  const terminals = () => win.evaluate(async () => (await (window as unknown as { atelier: AtelierApi }).atelier.terminals.list()).length);
  await command((await terminals()) > 0 ? 'show-terminal' : 'new-terminal');
  const term = win.locator('.xterm-helper-textarea:visible');
  await expect(term).toBeVisible({ timeout: 10000 });
  await win.evaluate(async () => {
    const api = (window as unknown as { atelier: AtelierApi }).atelier;
    const t = (await api.terminals.list())[0]!;
    api.terminals.input(t.id, "echo TokenStore'' done\r");
  });
  await expect(termRow(/^TokenStore done/)).toBeVisible({ timeout: 10000 });
  await termRow(/^TokenStore done/).dblclick({ position: { x: 12, y: 6 }, force: true });
  await expect(term).toBeFocused();
  await command('find-in-files');
  await expect(field()).toBeFocused();
  await expect.poll(fieldSelection).toEqual({ value: 'TokenStore', whole: true });
  await expect(totals()).toHaveText('3 results in 2 files');
  // A result chosen, then the keyboard back in the terminal: F4 is the program's, the results stay where they are.
  await matchRows('src/auth/session.ts').first().click();
  await expect(selectedRow()).toHaveAttribute('data-line', '1');
  await command('show-terminal');
  await term.focus();
  await win.keyboard.press('F4');
  await win.keyboard.press('Shift+F4');
  await frames(win);
  await frames(win);
  await expect(term).toBeFocused();
  await expect(selectedRow()).toHaveAttribute('data-rel', 'src/auth/session.ts');
  await expect(selectedRow()).toHaveAttribute('data-line', '1');
  await expect(activeTab()).not.toContainText('.ts');
});

test('F4 and ⇧F4 walk the results across files from the editor, wrapping; from the list, the keyboard stays in the list', async () => {
  await fresh();
  await search('TokenStore');
  await expect(totals()).toHaveText('3 results in 2 files');
  await matchRows('src/auth/session.ts').first().click();
  await expect(content()).toBeFocused();
  await expect.poll(strongLine).toBe("import { TokenStore } from './tokens';");
  await win.keyboard.press('F4');
  await expect(selectedRow()).toHaveAttribute('data-line', '8');
  await expect.poll(strongLine).toBe('const store = new TokenStore();');
  await expect(content()).toBeFocused();
  await expect.poll(() => pageSelection()).toBe('TokenStore');
  // The next file: its preview tab replaces this one, the keyboard follows into its editor.
  await win.keyboard.press('F4');
  await expect(selectedRow()).toHaveAttribute('data-rel', 'src/auth/tokens.ts');
  await expect(activeTab()).toContainText('tokens.ts');
  await expect.poll(strongLine).toBe('export class TokenStore {');
  await expect(content()).toBeFocused();
  // Past the last result: the first again; ⇧F4 back.
  await win.keyboard.press('F4');
  await expect(selectedRow()).toHaveAttribute('data-rel', 'src/auth/session.ts');
  await expect(selectedRow()).toHaveAttribute('data-line', '1');
  await expect(activeTab()).toContainText('session.ts');
  await win.keyboard.press('Shift+F4');
  await expect(selectedRow()).toHaveAttribute('data-rel', 'src/auth/tokens.ts');
  await expect.poll(strongLine).toBe('export class TokenStore {');
  // Every file collapsed: F4 opens the one its next match is in, and the list shows that row.
  await view().getByRole('button', { name: 'Collapse All' }).click();
  await expect(view().locator('.fif-row.is-match')).toHaveCount(0);
  await content().focus();
  await win.keyboard.press('F4');
  await expect(selectedRow()).toHaveAttribute('data-line', '1');
  await expect(selectedRow()).toHaveAttribute('data-rel', 'src/auth/session.ts');
  await expect(selectedRow()).toBeInViewport();
  await expect(fileRow('src/auth/session.ts')).toHaveAttribute('aria-expanded', 'true');
  // The keyboard in the list: F4 moves it with the selection; the editor shows each result without taking it.
  await selectedRow().focus();
  await win.keyboard.press('F4');
  await expect(selectedRow()).toHaveAttribute('data-line', '8');
  await expect(selectedRow()).toBeFocused();
  await expect.poll(strongLine).toBe('const store = new TokenStore();');
  await frames(win);
  await expect(selectedRow()).toBeFocused();
  await expect(content()).not.toBeFocused();
  await look(win, 'test-results/find-in-files-f4.png', { settle: 200 });
});

test('the palette: Find in Files always; Next and Previous Search Result while there are results', async () => {
  await fresh();
  await search('TokenStore');
  await expect(totals()).toHaveText('3 results in 2 files');
  await matchRows('src/auth/session.ts').first().click();
  await win.keyboard.press('F1');
  await win.locator('.palette-input').fill('>search result');
  await expect(win.locator('.palette-item', { hasText: 'Next Search Result' }).locator('.palette-hint')).toHaveText('F4');
  await expect(win.locator('.palette-item', { hasText: 'Previous Search Result' }).locator('.palette-hint')).toHaveText('⇧F4');
  await look(win.locator('.palette'), 'test-results/find-in-files-palette.png', { settle: 200 });
  await win.locator('.palette-item', { hasText: 'Next Search Result' }).click();
  await expect(selectedRow()).toHaveAttribute('data-line', '8');
  await expect.poll(strongLine).toBe('const store = new TokenStore();');
  await expect(content()).toBeFocused();
  await win.keyboard.press('F1');
  await win.locator('.palette-input').fill('>Find in Files');
  await expect(win.locator('.palette-item', { hasText: 'Find in Files' }).locator('.palette-hint')).toHaveText('⌘⇧F');
  // Nothing to walk once the results are cleared: only Find in Files is left.
  await win.keyboard.press('Escape');
  await view().getByRole('button', { name: 'Clear Results' }).click();
  await win.keyboard.press('F1');
  await win.locator('.palette-input').fill('>search result');
  await expect(win.locator('.palette-item', { hasText: /Next Search Result|Previous Search Result/ })).toHaveCount(0);
  await win.locator('.palette-input').fill('>Find in Files');
  await win.locator('.palette-item', { hasText: 'Find in Files' }).click();
  await expect(field()).toBeFocused();
});

test('the find card\'s "Search in all files" hands its query and options to Find in Files; ⌘⇧F in the card does the same', async () => {
  await fresh();
  await search('TokenStore');
  await matchRows('src/auth/session.ts').first().click();
  await expect(content()).toBeFocused();
  await win.keyboard.press('Meta+f');
  const card = editor().locator('.find-card');
  await expect(card).toBeVisible();
  await card.getByRole('textbox', { name: 'Find' }).fill('Session');
  await card.getByRole('button', { name: 'Match Case' }).click();
  const all = editor().getByRole('button', { name: 'Search in all files' });
  await expect(all).toBeVisible();
  await expect(all).toHaveAttribute('data-kbd', '⌘⇧F');
  // Under the card, at its right edge, whole and on one line; the same in a narrow pane (the card's compact form).
  const placed = async () => {
    const [c, b] = [(await card.boundingBox())!, (await all.boundingBox())!];
    expect(b.y).toBeGreaterThanOrEqual(c.y + c.height);
    expect(Math.abs(b.x + b.width - (c.x + c.width))).toBeLessThanOrEqual(1);
    // The card's own parts (its screen-reader line is clipped on purpose), and the pill.
    expect(await layoutProblems(editor(), ['.fc-field', '.fc-count', '.fc-all'])).toEqual(NO_PROBLEMS);
  };
  await placed();
  await sizeTo(760, 800);
  await expect(editor().locator('.fc-narrow').first()).toBeVisible();
  await placed();
  await look(editor(), 'test-results/find-in-files-card-narrow.png', { settle: 200 });
  await sizeTo(1280, 800);
  await all.hover();
  await look(editor(), 'test-results/find-in-files-card.png', { settle: 300 });
  await all.click();
  await expect(field()).toBeFocused();
  await expect.poll(fieldSelection).toEqual({ value: 'Session', whole: true });
  await expect(toggle('Match Case')).toHaveAttribute('aria-pressed', 'true');
  await expect(totals()).toHaveText('4 results in 2 files');
  // The keyboard in the card: ⌘⇧F carries what it holds.
  await card.getByRole('textbox', { name: 'Find' }).fill('SKEW_MS');
  await card.getByRole('button', { name: 'Match Case' }).click();
  await expect(card.getByRole('textbox', { name: 'Find' })).toBeFocused();
  await command('find-in-files');
  await expect(field()).toBeFocused();
  await expect.poll(fieldSelection).toEqual({ value: 'SKEW_MS', whole: true });
  await expect(toggle('Match Case')).toHaveAttribute('aria-pressed', 'false');
  await expect(totals()).toHaveText('2 results in 1 file');
});

test('F4 leaves the results alone while the palette or Settings is in front', async () => {
  await fresh();
  await search('TokenStore');
  await matchRows('src/auth/session.ts').first().click();
  await expect(selectedRow()).toHaveAttribute('data-line', '1');
  await win.keyboard.press('F1');
  const input = win.locator('.palette-input');
  await expect(input).toBeFocused();
  await win.keyboard.press('F4');
  await frames(win);
  await expect(input).toBeFocused();
  await expect(selectedRow()).toHaveAttribute('data-line', '1');
  await win.keyboard.press('Escape');
  await expect(input).toHaveCount(0);
  await command('open-settings');
  const sheet = win.locator('.settings[role="dialog"]');
  await expect(sheet).toBeVisible();
  await win.keyboard.press('Shift+F4');
  await frames(win);
  await expect(sheet).toBeVisible();
  await expect(selectedRow()).toHaveAttribute('data-line', '1');
  await win.keyboard.press('Escape');
  await expect(sheet).toHaveCount(0);
});

test('F4 in a pop-out: its project window walks the results; one in the pop-out\'s file comes back marked and the project window stays behind', async () => {
  await fresh();
  await search('TokenStore');
  await expect(totals()).toHaveText('3 results in 2 files');
  await matchRows('src/auth/session.ts').first().click();
  const mainId = await (await app.browserWindow(win)).evaluate((w) => w.webContents.id);
  const log = join(home, 'test-reveals.log');
  /** The windows brought forward since the last call. */
  const revealed = () => { const ids = existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean).map(Number) : []; writeFileSync(log, ''); return ids; };
  await win.locator('.tab', { hasText: 'session.ts' }).click({ button: 'right' });
  const [pop] = await Promise.all([app.waitForEvent('window'), win.getByRole('menuitem', { name: 'Move to New Window' }).click()]);
  await expect(pop.locator('.popout-bar')).toBeVisible({ timeout: 15000 });
  await still(pop);
  const popLine = () => pop.locator('.cm-fif-hit-strong').evaluate((el) => el.closest('.cm-line')?.textContent ?? '');
  // F4 in a pop-out no result was walked into yet: the next match is in its own file, shown there, selected and
  // marked (not only its line); the project window, which holds the results, is not brought forward, and the Settings
  // sheet left open there stays open.
  await command('open-settings');
  const sheet = win.locator('.settings[role="dialog"]');
  await expect(sheet).toBeVisible();
  await pop.locator('.cm-content').focus();
  revealed();
  await pop.keyboard.press('F4');
  await expect(selectedRow()).toHaveAttribute('data-line', '8');
  await expect.poll(popLine).toBe('const store = new TokenStore();');
  await expect.poll(() => pageSelection(pop)).toBe('TokenStore');
  await expect(pop.locator('.cm-content')).toBeFocused();
  expect(revealed()).not.toContain(mainId);
  await frames(win);
  await expect(sheet).toBeVisible();
  await win.keyboard.press('Escape');
  await expect(sheet).toHaveCount(0);
  // The next one is in another file: it opens in the project window, which comes forward.
  await pop.keyboard.press('F4');
  await expect(selectedRow()).toHaveAttribute('data-rel', 'src/auth/tokens.ts');
  await expect(activeTab()).toContainText('tokens.ts');
  await expect.poll(revealed).toContain(mainId);
  // Shown, the keyboard in its editor (before the palette opens over it).
  await expect.poll(strongLine).toBe('export class TokenStore {');
  await expect(content()).toBeFocused();
  // ⇧F4 from the pop-out again: back in its file, the project window left where it is, its palette open as it was.
  await win.keyboard.press('F1');
  await expect(win.locator('.palette-input')).toBeFocused();
  await pop.locator('.cm-content').focus();
  await pop.keyboard.press('Shift+F4');
  await expect(selectedRow()).toHaveAttribute('data-line', '8');
  await expect.poll(popLine).toBe('const store = new TokenStore();');
  expect(revealed()).not.toContain(mainId);
  await expect(win.locator('.palette-input')).toBeFocused();
  await win.keyboard.press('Escape');
  await expect(win.locator('.palette-input')).toHaveCount(0);
  // View › Find in Files given in the pop-out runs in the project window: a selection the user left in an editor there
  // is not the query (the user is in the pop-out).
  await content().focus();
  await win.keyboard.press('Home');
  for (let i = 0; i < 6; i++) await win.keyboard.press('Shift+ArrowRight');
  await expect.poll(() => pageSelection()).toBe('export');
  const popId = await (await app.browserWindow(pop)).evaluate((w) => w.webContents.id);
  await app.evaluate(({ BrowserWindow, Menu }, id) => {
    const walk = (items: Electron.MenuItem[]): Electron.MenuItem | undefined => {
      for (const it of items) { if (it.label === 'Find in Files') return it; const sub = it.submenu ? walk(it.submenu.items) : undefined; if (sub) return sub; }
      return undefined;
    };
    walk(Menu.getApplicationMenu()!.items)!.click(undefined, BrowserWindow.getAllWindows().find((b) => b.webContents.id === id));
  }, popId);
  await expect(field()).toBeFocused();
  await expect.poll(fieldSelection).toEqual({ value: 'TokenStore', whole: true });
  await Promise.all([pop.waitForEvent('close'), pop.locator('.popout-bar').getByRole('button', { name: 'Move Back' }).click()]);
});

/** The visible terminal's screen as one text: its rows joined, so a wrapped line reads whole. */
const screenText = () => win.locator('.terminal-slot:visible .xterm-rows').first().evaluate((el) =>
  [...el.querySelectorAll(':scope > div')].map((r) => r.textContent ?? '').join('').replaceAll(' ', ' '));

test('✦ Send to session offers this project\'s Claude sessions and a new one, no plain terminal: the block lands in the prompt unsent; Copy All Results copies the same text', async () => {
  test.setTimeout(120_000);
  await fresh();
  // A plain terminal and a Claude session of this project.
  await win.evaluate(async () => {
    const api = (window as unknown as { atelier: AtelierApi }).atelier;
    await api.terminals.create({ cols: 100, rows: 30, name: 'plain shell' });
    await api.terminals.createSession({ cols: 100, rows: 30, name: 'auth refactor' });
  });
  // Shown once first, so its terminal has the pane's size before anything is typed into it (what this test reads is
  // the screen as drawn).
  await win.locator('.tab', { hasText: 'auth refactor' }).click();
  await expect.poll(screenText, { timeout: 15000 }).toContain('FAKE-CLAUDE starting');
  await search('TokenStore');
  await expect(totals()).toHaveText('3 results in 2 files');
  // A dismissed row stays out of what is sent and copied.
  const dismissed = matchRows('src/auth/session.ts').nth(1);
  await dismissed.hover();
  await dismissed.getByRole('button', { name: 'Dismiss' }).click();
  await expect(totals()).toHaveText('2 results in 2 files');
  const block = [
    'Search "TokenStore" (match case off, whole word off, regex off) — 2 results in 2 files',
    "src/auth/session.ts:1  import { TokenStore } from './tokens';",
    'src/auth/tokens.ts:1  export class TokenStore {'
  ].join('\n');
  const typed = block.replaceAll('\n', '⏎');

  // The summary's menu: the results copied or sent, then the list's own items.
  await view().locator('.fif-summary').click({ button: 'right' });
  expect(await menuShape()).toEqual(['Copy All Results', 'Send to Session…', '—', 'Collapse All', 'Clear Results']);
  await win.getByRole('menuitem', { name: 'Copy All Results' }).click();
  await expect.poll(() => copies().at(-1)).toBe(block);

  // ✦ Send to session: the send step, limited to Claude sessions, with a new one.
  const palette = win.locator('.palette');
  await view().getByRole('button', { name: 'Send to session' }).click();
  await expect(palette.locator('.palette-send-head')).toContainText('Search "TokenStore" (match case off');
  await expect(palette.locator('.palette-send-head')).toContainText('+2 lines');
  await expect(palette.locator('.palette-input')).toHaveAttribute('placeholder', 'Search sessions');
  await expect(palette.locator('.palette-section')).toHaveText(['Sessions']);
  await expect(palette.locator('.palette-item .palette-label')).toHaveText(['auth refactor', 'New session']);
  // Claude's prompt ready (its bracketed paste on): the session can take the text.
  const session = palette.locator('.palette-item', { hasText: 'auth refactor' });
  await expect(session).not.toHaveClass(/\bis-off\b/, { timeout: 20000 });
  await win.mouse.move(640, 790);
  await look(win, 'test-results/find-in-files-send.png', { settle: 300 });
  await session.click();
  await expect(palette).toHaveCount(0);
  await expect(win.locator('.tab.is-active .tab-name')).toHaveText('auth refactor');
  await expect.poll(screenText, { timeout: 15000 }).toContain(typed);
  // In the prompt, not sent: what the user then types joins it, and their Enter sends the whole of it. Typed at a
  // person's pace: an Enter pressed by the app once the paste settled would come between two keys and split it.
  const sentByUser = async () => {
    await expect(win.locator('.xterm-helper-textarea:visible')).toBeFocused();
    await win.keyboard.type(' END', { delay: 200 });
    await win.keyboard.press('Enter');
    await expect.poll(screenText, { timeout: 10000 }).toContain(`FAKE-CLAUDE submitted=${typed} END`);
  };
  await sentByUser();
  // The results stay as they were.
  await expect(totals()).toHaveText('2 results in 2 files');

  // Send to Session… from the list's empty area, New session: a session of its own, the block typed in once Claude is
  // ready, not sent.
  await view().locator('.fif-rest').click({ button: 'right' });
  await win.getByRole('menuitem', { name: 'Send to Session…' }).click();
  await palette.locator('.palette-item', { hasText: 'New session' }).click();
  await expect(win.locator('.tab.is-active .tab-name')).toHaveText('search TokenStore', { timeout: 15000 });
  await expect.poll(screenText, { timeout: 20000 }).toContain(typed);
  await expect(win.locator('.toast', { hasText: 'The search results are in the prompt. Review them and press Enter to send.' })).toBeVisible();
  await sentByUser();
});
