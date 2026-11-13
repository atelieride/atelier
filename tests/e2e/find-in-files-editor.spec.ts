// Find in Files, opening a result in the editor: the preview tab at the match, selected (no "Comment" pill for a
// selection the user did not make), every occurrence of the query highlighted and ticked on the scrollbar ruler; ⏎
// leaving the keyboard in the list while the results are walked; ⌘⏎ to the side; a double click keeping the tab; a
// Markdown file saved as Preview shown as source for the visit; a result shown once (not again when its view is made
// again); a match moved by an edit on disk; Esc, the find card and an emptied query taking the marks away; a file over
// 5 MB opened straight in the large view, its ruler ticked without a long task and kept from one result to the next; a
// minified file's single 4.5 MB line left to its result's own tick; a tab with unsaved changes searched as it shows.
import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { e2eEnv } from './env';
import { frames } from './narrow-fixture';
import { look } from './shots';

let app: ElectronApplication;
let win: Page;
let home: string;
let project: string;

const git = (cwd: string, ...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
const write = (rel: string, body: string) => {
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
  '  delete(token: string) {',
  '    this.entries.delete(token);',
  '  }',
  '}',
  ''
].join('\n');

const README = '# Sessions\n\nEach session has an expiry.\n\n## Expiry\n\nThe expiry is one hour.\n';
const MOVED = ['// moved', 'export const a = 1;', 'export const b = 2;', "export const zebra = 'stripes';", 'export const c = 3;', ''].join('\n');
/** Past 5 MB: the editor opens it read-only, in its large view. */
const BIG_LINES = 56_000;
const WALRUS_LINE = 30_000;
const NARWHAL_LINE = 45_000;
/** Two results of one query in the big file. */
const BELUGA_LINES = [10_000, 50_000];
/** A minified file: about 4.5 MB on one line (still under 5 MB: the usual editor), a word near each end. */
const MINIFIED = `var pelican=1;${'a=b+c;'.repeat(750_000)}var heron=2;\n`;
/** A file edited in its tab and left unsaved: searched as the tab shows it. */
const DRAFT = ['// a draft', 'export const ocelot = 1;', ''].join('\n');
/** A file changed since its commit (Margin and Diff to switch between), with two matches. */
const DIFFY = ['export const okapi = 1;', 'export const b = 2;', 'export const c = okapi + 1;', ''].join('\n');

const activity = () => win.locator('.activity-bar .act[aria-label^="Find in Files"]');
const view = () => win.locator('.sidebar.is-search');
const field = () => view().getByRole('textbox', { name: 'Search files' });
const totals = () => view().locator('.fif-summary .fif-totals');
const matchRow = (rel: string, line: number) => view().locator(`.fif-row.is-match[data-rel="${rel}"][data-line="${line}"]`);
const selectedRow = () => view().locator('.fif-row.is-selected');
const editor = () => win.locator('.file-view:visible').first();
const content = () => editor().locator('.cm-content');
const hits = () => editor().locator('.cm-fif-hit, .cm-fif-hit-strong');
const strong = () => editor().locator('.cm-fif-hit-strong');
const ticks = () => editor().locator('.cm-ruler-find');
const footPos = () => editor().locator('.foot-pos');
const fileTabs = () => win.locator('.tab[data-key^="f:"]');
const tab = (name: string) => win.locator('.tab[data-key^="f:"]', { hasText: name });
const sw = (name: string) => editor().locator('.md-switch').getByRole('radio', { name });
const pageSelection = () => win.evaluate(() => window.getSelection()?.toString() ?? '');
/** The text of the line the strong mark sits on. */
const strongLine = () => strong().evaluate((el) => el.closest('.cm-line')?.textContent ?? '');
/** The "Comment" pill that follows a selection the user made. */
const commentPill = () => win.locator('.lc-tip');
/**
 * Releasing Shift settles a selection at once (its "Comment" pill shows, without waiting for the quiet moment): sent
 * to `scope`'s editor, then two frames for the pill to be drawn if it is going to be.
 */
async function settleSelection(scope: Locator): Promise<void> {
  await scope.locator('.cm-editor').evaluate((el) => el.dispatchEvent(new KeyboardEvent('keyup', { key: 'Shift', bubbles: true })));
  await frames(win);
}
const still = (w: Page) => w.addStyleTag({ content: '*, *::before, *::after { animation: none !important; transition: none !important; }' });
const savedViews = () => win.evaluate(() => localStorage.getItem('atelier.markdownViews'));
/** A theme token as the page resolves it on a background. */
const tokenColor = (name: string) => win.evaluate((n) => {
  const probe = document.createElement('div');
  probe.style.background = `var(${n})`;
  document.body.append(probe);
  const c = getComputedStyle(probe).backgroundColor;
  probe.remove();
  return c;
}, name);

/** From now on, the longest task the page runs that holds it past 50 ms (`longestTask` reads it and stops). */
const watchLongTasks = () => win.evaluate(() => {
  const w = window as unknown as { longest: number; watch: PerformanceObserver };
  w.longest = 0;
  w.watch = new PerformanceObserver((list) => { for (const e of list.getEntries()) w.longest = Math.max(w.longest, e.duration); });
  w.watch.observe({ type: 'longtask' });
});
const longestTask = () => win.evaluate(() => { const w = window as unknown as { longest: number; watch: PerformanceObserver }; w.watch.disconnect(); return w.longest; });

async function search(q: string): Promise<void> {
  if (!(await view().isVisible())) await activity().click();
  await field().fill(q);
}

test.beforeAll(async () => {
  project = realpathSync(mkdtempSync(join(tmpdir(), 'atl-prj-')));
  git(project, 'init', '-q', '-b', 'main');
  write('README.md', README);
  write('src/auth/session.ts', SESSION);
  write('src/auth/tokens.ts', TOKENS);
  write('src/moved.ts', MOVED);
  const big = (i: number) => (i === WALRUS_LINE ? `${'x'.repeat(40)} walrus ${'x'.repeat(51)}` : i === NARWHAL_LINE ? `${'x'.repeat(40)} narwhal ${'x'.repeat(50)}`
    : BELUGA_LINES.includes(i) ? `${'x'.repeat(40)} beluga ${'x'.repeat(51)}` : 'x'.repeat(99));
  write('logs/big.log', Array.from({ length: BIG_LINES }, (_, i) => big(i + 1)).join('\n') + '\n');
  write('src/diffy.ts', DIFFY.replace('b = 2', 'b = 1'));
  write('src/kept.ts', 'export const quokka = true;\n');
  write('src/draft.ts', DRAFT);
  write('lib/app.min.js', MINIFIED);
  git(project, 'add', '.');
  git(project, 'commit', '-q', '-m', 'first');
  write('src/diffy.ts', DIFFY);
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

test('a click opens the preview tab at the match, selected, every occurrence highlighted and ticked on the ruler', async () => {
  await search('token');
  await expect(totals()).toHaveText('11 results in 2 files');
  await matchRow('src/auth/session.ts', 15).click();
  await expect(tab('session.ts')).toHaveClass(/is-preview/);
  await expect(tab('session.ts').locator('.tab-name')).toHaveCSS('font-style', 'italic');
  // A click moves the keyboard to the editor, the match selected there.
  await expect(content()).toBeFocused();
  await expect.poll(pageSelection).toBe('token');
  await expect(footPos()).toHaveText('Ln 15, Col 23');
  await expect(strong()).toHaveText('token');
  expect(await strongLine()).toBe('    store.delete(token);');
  // Every occurrence (the query ignores case): six, the selected one strong.
  await expect(hits()).toHaveText(['Token', 'token', 'Token', 'token', 'token', 'token']);
  await expect(hits().first()).toHaveCSS('background-color', await tokenColor('--hit-bg'));
  await expect(strong()).toHaveCSS('background-color', await tokenColor('--hit-strong'));
  // One tick per line with a match (lines 1, 8, 11, 12 and 15), the selected one lit.
  await expect(ticks()).toHaveCount(5);
  await expect(editor().locator('.cm-ruler-find.is-selected')).toHaveCount(1);
  // The match was selected for the user, not by them: no "Comment" pill for it.
  await settleSelection(editor());
  await expect(commentPill()).toHaveCount(0);
  await look(win, 'test-results/find-in-files-editor-open.png', { settle: 200 });
  // Their own selection gets it as always.
  await win.keyboard.press('Shift+ArrowLeft');
  await expect(commentPill()).toHaveCount(1);
});

test('⏎ in the list opens the result and leaves the keyboard there; walking on replaces the preview tab', async () => {
  await search('');
  await search('token');
  await expect(totals()).toHaveText('11 results in 2 files');
  await field().press('ArrowDown');
  await expect(selectedRow()).toBeFocused();
  await expect(selectedRow()).toHaveAttribute('data-rel', 'src/auth/session.ts');
  // The last result, in a file not open yet: its editor loads after the key.
  await win.keyboard.press('End');
  await win.keyboard.press('Enter');
  await expect(tab('tokens.ts')).toHaveClass(/is-preview/);
  await expect(fileTabs()).toHaveCount(1);
  await expect(strong()).toHaveText('token');
  expect(await strongLine()).toBe('    this.entries.delete(token);');
  await expect(footPos()).toHaveText('Ln 9, Col 30');
  // The editor has loaded and shown the match: nothing took the keyboard from the list since.
  await frames(win);
  await expect(selectedRow()).toBeFocused();
  await expect(content()).not.toBeFocused();
  await settleSelection(editor());
  await expect(commentPill()).toHaveCount(0);
  // The one before it, in the same file.
  await win.keyboard.press('ArrowUp');
  await win.keyboard.press('Enter');
  await expect(footPos()).toHaveText('Ln 8, Col 15');
  await expect(selectedRow()).toBeFocused();
  // Back to the first file's first result: the preview tab is replaced again, the keyboard still in the list.
  await win.keyboard.press('Home');
  await win.keyboard.press('ArrowDown');
  await win.keyboard.press('Enter');
  await expect(tab('session.ts')).toHaveClass(/is-preview/);
  await expect(fileTabs()).toHaveCount(1);
  await expect(strong()).toHaveText('Token');
  await expect(footPos()).toHaveText('Ln 1, Col 15');
  await frames(win);
  await expect(selectedRow()).toBeFocused();
  await expect(content()).not.toBeFocused();
  await look(win, 'test-results/find-in-files-editor-enter.png', { settle: 200 });
});

test('a Markdown file saved as Preview opens as source for the visit; its switch goes back to Preview; the saved view stays', async () => {
  await win.getByRole('button', { name: /^Files/ }).click();
  await win.locator('.tree-row', { hasText: 'README.md' }).click();
  await expect(tab('README.md')).toBeVisible();
  await sw('Preview').click();
  await expect(editor().locator('.md-preview')).toBeVisible();
  expect(JSON.parse((await savedViews())!)).toEqual({ [join(project, 'README.md')]: 'preview' });

  await search('expiry');
  await expect(totals()).toHaveText('3 results in 1 file');
  await matchRow('README.md', 7).click();
  await expect(sw('Source')).toHaveAttribute('aria-checked', 'true');
  await expect(editor().locator('.md-preview')).toHaveCount(0);
  await expect(content()).toBeFocused();
  await expect.poll(pageSelection).toBe('expiry');
  expect(await strongLine()).toBe('The expiry is one hour.');
  expect(JSON.parse((await savedViews())!)).toEqual({ [join(project, 'README.md')]: 'preview' });
  await look(win, 'test-results/find-in-files-editor-markdown.png', { settle: 200 });
  // The tab's switch: Preview again, nothing saved differently.
  await sw('Preview').click();
  await expect(editor().locator('.md-preview')).toBeVisible();
  expect(JSON.parse((await savedViews())!)).toEqual({ [join(project, 'README.md')]: 'preview' });
  // Another result: source again; the file opened from the tree afterwards shows its own view.
  await matchRow('README.md', 3).click();
  await expect(sw('Source')).toHaveAttribute('aria-checked', 'true');
  await expect.poll(pageSelection).toBe('expiry');
  await win.getByRole('button', { name: /^Files/ }).click();
  await win.locator('.tree-row', { hasText: 'README.md' }).click();
  await expect(sw('Preview')).toHaveAttribute('aria-checked', 'true');
  await expect(editor().locator('.md-preview')).toBeVisible();

  // ⏎ leaves the keyboard in the list for that open only: the switch's Source afterwards gives it to the code.
  await activity().click();
  await field().press('ArrowDown');
  await expect(selectedRow()).toHaveAttribute('data-line', '3');
  await win.keyboard.press('Enter');
  await expect(sw('Source')).toHaveAttribute('aria-checked', 'true');
  await expect(strong()).toHaveText('expiry');
  await expect(selectedRow()).toBeFocused();
  await sw('Preview').click();
  await expect(editor().locator('.md-preview')).toBeVisible();
  await sw('Source').click();
  await expect(content()).toBeFocused();
});

test('the result shown once: the view made again (Diff and back) brings neither the marks nor the selection back', async () => {
  await search('okapi');
  await expect(totals()).toHaveText('2 results in 1 file');
  await matchRow('src/diffy.ts', 3).click();
  await expect(strong()).toHaveText('okapi');
  await expect(hits()).toHaveCount(2);
  await editor().locator('.seg button', { hasText: 'Diff' }).click();
  await expect(editor().locator('.seg button', { hasText: 'Diff' })).toHaveClass(/is-on/);
  await expect(hits()).toHaveCount(0);
  await editor().locator('.seg button', { hasText: 'Margin' }).click();
  await expect(editor().locator('.seg button', { hasText: 'Margin' })).toHaveClass(/is-on/);
  await frames(win);
  await expect(hits()).toHaveCount(0);
  await expect(ticks()).toHaveCount(0);
});

test('the file changed on disk since the search: the moved occurrence is selected; gone, the line without a selection', async () => {
  await search('zebra');
  await expect(totals()).toHaveText('1 result in 1 file');
  write('src/moved.ts', `// added one\n// added two\n${MOVED}`);
  await matchRow('src/moved.ts', 4).click();
  await expect(tab('moved.ts')).toBeVisible();
  await expect(footPos()).toHaveText('Ln 6, Col 19');
  await expect.poll(pageSelection).toBe('zebra');
  expect(await strongLine()).toBe("export const zebra = 'stripes';");
  // No occurrence left near the line: the cursor at the result's line, nothing selected.
  write('src/moved.ts', MOVED.replace('zebra', 'horse'));
  await expect(content()).toContainText('horse');
  await matchRow('src/moved.ts', 4).click();
  await expect(footPos()).toHaveText('Ln 4, Col 1');
  await expect(strong()).toHaveCount(0);
  await expect.poll(pageSelection).toBe('');
});

test('Esc in the editor, the find card opening and an emptied query take the highlights and ticks away', async () => {
  await search('token');
  await expect(totals()).toHaveText('11 results in 2 files');
  await matchRow('src/auth/session.ts', 12).click();
  await expect(strong()).toHaveText('token');
  await expect(ticks()).toHaveCount(5);
  await win.keyboard.press('Escape');
  await expect(hits()).toHaveCount(0);
  await expect(ticks()).toHaveCount(0);
  // Esc took only the marks: the match is still selected.
  await expect.poll(pageSelection).toBe('token');

  await matchRow('src/auth/session.ts', 12).click();
  await expect(hits()).toHaveCount(6);
  await win.keyboard.press('Meta+f');
  await expect(win.locator('.find-card')).toBeVisible();
  await expect(hits()).toHaveCount(0);
  await win.keyboard.press('Escape');
  await expect(win.locator('.find-card')).toHaveCount(0);

  await matchRow('src/auth/session.ts', 12).click();
  await expect(hits()).toHaveCount(6);
  await expect(ticks()).toHaveCount(5);
  await field().fill('');
  await expect(hits()).toHaveCount(0);
  await expect(ticks()).toHaveCount(0);
});

test('a file over 5 MB opens straight in the read-only large view, at its match', async () => {
  await search('walrus');
  await expect(totals()).toHaveText('1 result in 1 file');
  await matchRow('logs/big.log', WALRUS_LINE).click();
  await expect(editor().locator('.file-foot')).toContainText('Read-only · large file');
  await expect(editor().locator('.file-large')).toHaveCount(0);
  // The strong mark is the occurrence the selection holds.
  await expect(strong()).toHaveText('walrus');
  expect(await strongLine()).toBe(`${'x'.repeat(40)} walrus ${'x'.repeat(51)}`);
  await look(win, 'test-results/find-in-files-editor-large.png', { settle: 200 });
});

test('in a file past 5 MB the ruler\'s ticks come without holding the page: no long task while they are found', async () => {
  // The file open first, at another result: what follows is the ruler's work alone, not the file's loading.
  await search('narwhal');
  await matchRow('logs/big.log', NARWHAL_LINE).click();
  await expect(strong()).toHaveText('narwhal');
  await expect(ticks()).toHaveCount(1);
  const tickTop = () => editor().evaluate((el) => el.querySelector<HTMLElement>('.cm-ruler-find.is-selected')?.style.top ?? null);
  const narwhalTick = await tickTop();
  await search('walrus');
  await expect(field()).toHaveValue('walrus');
  await expect(matchRow('logs/big.log', WALRUS_LINE)).toBeVisible();
  await watchLongTasks();
  await matchRow('logs/big.log', WALRUS_LINE).click();
  await expect(strong()).toHaveText('walrus');
  // The new tick, higher up than narwhal's (line 30,000 of 56,000), once the whole file has been scanned.
  await expect.poll(async () => { const top = await tickTop(); return top !== null && top !== narwhalTick; }).toBe(true);
  await expect(ticks()).toHaveCount(1);
  await frames(win);
  expect(await longestTask()).toBeLessThan(100);
});

test('the next result in the same file keeps the ruler\'s ticks: no blink, no new scan of a 5.6 MB file', async () => {
  await search('beluga');
  await expect(totals()).toHaveText('2 results in 1 file');
  await matchRow('logs/big.log', BELUGA_LINES[0]!).click();
  await expect(strong()).toHaveText('beluga');
  await expect(ticks()).toHaveCount(2);
  // Every change of the ruler's ticks from here on: the fewest ever shown.
  await editor().locator('.cm-ruler').evaluate((ruler) => {
    const w = window as unknown as { fewestTicks: number; tickWatch: MutationObserver };
    w.fewestTicks = ruler.querySelectorAll('.cm-ruler-find').length;
    w.tickWatch = new MutationObserver(() => { w.fewestTicks = Math.min(w.fewestTicks, ruler.querySelectorAll('.cm-ruler-find').length); });
    w.tickWatch.observe(ruler, { childList: true, subtree: true });
  });
  await matchRow('logs/big.log', BELUGA_LINES[1]!).click();
  await expect(strong()).toHaveText('beluga');
  expect(await strongLine()).toBe(`${'x'.repeat(40)} beluga ${'x'.repeat(51)}`);
  await expect(editor().locator('.cm-lineNumbers .cm-gutterElement', { hasText: new RegExp(`^${BELUGA_LINES[1]}$`) })).toBeVisible();
  await frames(win);
  await expect(ticks()).toHaveCount(2);
  await expect(editor().locator('.cm-ruler-find.is-selected')).toHaveCount(1);
  expect(await win.evaluate(() => { const w = window as unknown as { fewestTicks: number; tickWatch: MutationObserver }; w.tickWatch.disconnect(); return w.fewestTicks; })).toBe(2);
});

test('a minified file of one 4.5 MB line: its result gets its own tick, the line is not read for the others, nothing holds the page', async () => {
  await search('pelican');
  await matchRow('lib/app.min.js', 1).click();
  await expect(strong()).toHaveText('pelican');
  await expect(ticks()).toHaveCount(1);
  await search('heron');
  // The same file and line as pelican's row: told apart by its mark.
  const heron = matchRow('lib/app.min.js', 1).filter({ has: win.locator('mark', { hasText: 'heron' }) });
  await expect(heron).toBeVisible();
  await watchLongTasks();
  await heron.click();
  await expect(strong()).toHaveText('heron');
  await expect(editor().locator('.cm-ruler-find.is-selected')).toHaveCount(1);
  await frames(win);
  expect(await longestTask()).toBeLessThan(100);
});

test('⌘⏎ opens the result to the side, in a new split, as a kept tab; the keyboard stays in the list', async () => {
  await search('token');
  await expect(totals()).toHaveText('11 results in 2 files');
  // Another file in front first: the result goes beside it.
  await matchRow('src/auth/tokens.ts', 4).click();
  await expect(tab('tokens.ts')).toBeVisible();
  // The click's editor has the keyboard (and its match) before the list takes it back.
  await expect(content()).toBeFocused();
  await expect(strong()).toHaveText('token');
  await field().press('ArrowDown');
  await win.keyboard.press('Home');
  await win.keyboard.press('ArrowDown');
  await win.keyboard.press('ArrowDown');
  await expect(selectedRow()).toHaveAttribute('data-line', '1');
  await expect(selectedRow()).toBeFocused();
  await win.keyboard.press('Meta+Enter');
  await expect(win.locator('.workspace-body.is-split')).toBeVisible();
  const side = win.locator('.pane-strip[data-pane="1"] .tab[data-key^="f:"]');
  await expect(side).toHaveText([/session\.ts/]);
  await expect(side).not.toHaveClass(/is-preview/);
  const sideEditor = win.locator('section.file-view[aria-label="src/auth/session.ts"]');
  await expect(sideEditor).toBeVisible();
  await expect(sideEditor.locator('.cm-fif-hit-strong')).toHaveText('token');
  expect(await sideEditor.locator('.cm-fif-hit-strong').evaluate((el) => el.closest('.cm-line')?.textContent)).toBe("import { TokenStore } from './tokens';");
  await expect(sideEditor.locator('.foot-pos')).toHaveText('Ln 1, Col 36');
  await settleSelection(sideEditor);
  await expect(commentPill()).toHaveCount(0);
  await frames(win);
  await expect(selectedRow()).toBeFocused();
  await look(win, 'test-results/find-in-files-editor-side.png', { settle: 200 });
});

test('a double click on a result keeps its tab: the next result opens beside it', async () => {
  await search('quokka');
  await expect(totals()).toHaveText('1 result in 1 file');
  await matchRow('src/kept.ts', 1).dblclick();
  await expect(tab('kept.ts')).toBeVisible();
  await expect(tab('kept.ts')).not.toHaveClass(/is-preview/);
  await expect(win.locator('section.file-view[aria-label="src/kept.ts"] .cm-fif-hit-strong')).toHaveText('quokka');
  await search('okapi');
  await matchRow('src/diffy.ts', 1).click();
  await expect(tab('diffy.ts')).toHaveClass(/is-preview/);
  await expect(tab('kept.ts')).toBeVisible();
});

test('a tab with unsaved changes is searched as it shows: its new text found, the text still on disk not', async () => {
  await search('ocelot');
  await expect(totals()).toHaveText('1 result in 1 file');
  await matchRow('src/draft.ts', 2).click();
  const draft = win.locator('section.file-view[aria-label="src/draft.ts"]');
  await expect(draft.locator('.cm-content')).toBeFocused();
  await expect.poll(pageSelection).toBe('ocelot');
  // Typed over the selected match, not saved.
  await win.keyboard.type('margay');
  await expect(tab('draft.ts').locator('.tab-dirty')).toBeVisible();
  expect(readFileSync(join(project, 'src/draft.ts'), 'utf8')).toBe(DRAFT);
  await search('margay');
  await expect(matchRow('src/draft.ts', 2).locator('.fif-text')).toHaveText('export const margay = 1;');
  await expect(totals()).toHaveText('1 result in 1 file');
  await search('ocelot');
  await expect(view().locator('.fif-state')).toHaveText('No results.');
  await look(win, 'test-results/find-in-files-editor-unsaved.png', { settle: 200 });
  // The edit undone: the tab shows the disk's text again, and so does the search.
  await draft.locator('.cm-content').focus();
  await win.keyboard.press('Meta+z');
  await expect(draft.locator('.cm-line', { hasText: 'export const' })).toHaveText('export const ocelot = 1;');
  await search('margay');
  await expect(view().locator('.fif-state')).toHaveText('No results.');
  await search('ocelot');
  await expect(totals()).toHaveText('1 result in 1 file');
});
