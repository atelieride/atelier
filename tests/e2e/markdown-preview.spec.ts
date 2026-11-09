// Markdown preview: Source · Split · Preview in the file tab.
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { e2eEnv } from './env';
import { look } from './shots';

// Test repos isolated from the user's git configuration (global hooks, commit signing, ...).
const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const git = (cwd: string, ...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd, env: gitEnv });

const SHOTS = resolve('e2e-shots/markdown-preview');
// A 2×2 PNG.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFklEQVR42mP8z8DwnwEJMDIwMDAAABgWAgEnRo5bAAAAAElFTkSuQmCC', 'base64');

const DOC = [
  '---', 'status: draft', 'owner: platform', '---',
  '# Offline sync — design', '',
  'Notes sync across devices **without a server round-trip** on every edit.',
  'See the [storage spec](./storage.md#L2), the [CRDT paper](https://crdt.tech/papers) and [Goals](#goals).', '',
  '> [!NOTE]', '> Conflicts resolve per block, never per file.', '',
  '## Goals', '',
  '- [x] Edits work offline', '- [ ] Show who changed what', '',
  '## Queue', '',
  '| Event | Retries |', '| --- | --- |', '| `edit` | 5 |', '| `delete` | 3 |', '',
  '```ts', 'export async function flush(q: SyncQueue) {', '  for (const op of q.pending()) await send(op);', '}', '```', '',
  '![Flow](./flow.png) ![Badge](https://img.shields.io/badge/build-passing.svg)', '',
  '<script>alert(1)</script>', '',
  '## Notes', '',
  ...Array.from({ length: 40 }, (_, i) => `Paragraph ${i + 1}: the queue keeps every edit until a flush succeeds, then the next device merges it.\n`),
  '## Last', '', 'The end.'
].join('\n') + '\n';

async function launch(extra: Record<string, string> = {}, setup?: (project: string) => void): Promise<{ app: ElectronApplication; home: string; project: string; urlLog: string }> {
  const project = mkdtempSync(join(tmpdir(), 'atl-prj-'));
  mkdirSync(join(project, 'docs'));
  writeFileSync(join(project, 'docs', 'design.md'), DOC);
  writeFileSync(join(project, 'docs', 'storage.md'), '# Storage\nline two\nline three\n');
  writeFileSync(join(project, 'docs', 'flow.png'), PNG);
  setup?.(project);
  const urlLog = join(project, '..', `${project.split('/').at(-1)}-urls.log`);
  const { env, home } = e2eEnv({ ATELIER_CLAUDE_BIN: resolve('tests/e2e/fake-claude.pl'), ATELIER_TEST_URL_LOG: urlLog, ...extra });
  const app = await electron.launch({ args: ['out/main/index.js', `--project=${project}`], env });
  // Wide enough for the outline beside the page.
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1600, 1000));
  return { app, home, project, urlLog };
}

async function stop(app: ElectronApplication, home: string) {
  await app.close();
  try { process.kill((JSON.parse(readFileSync(join(home, 'atelierd.json'), 'utf8')) as { pid: number }).pid, 'SIGTERM'); } catch { /* already stopped */ }
}

/** The app menu shortcuts are tested by clicking the item (synthetic events do not go through NSMenu). */
async function menu(app: ElectronApplication, accelerator: string) {
  await app.evaluate(({ Menu, BrowserWindow }, acc) => {
    const walk = (items: Electron.MenuItem[]): Electron.MenuItem | undefined => {
      for (const it of items) { if (it.accelerator === acc) return it; const sub = it.submenu ? walk(it.submenu.items) : undefined; if (sub) return sub; }
      return undefined;
    };
    walk(Menu.getApplicationMenu()!.items)?.click(undefined, BrowserWindow.getAllWindows()[0]);
  }, accelerator);
}

async function openDesign(win: Page) {
  const file = win.locator('.tree-row', { hasText: 'design.md' });
  if (!(await file.isVisible())) {
    const folder = win.locator('.tree-row', { hasText: 'docs' }).first();
    if (!(await folder.isVisible())) await win.getByRole('button', { name: /Files/ }).click();
    await folder.click();
  }
  await file.dblclick();
  await expect(win.locator('.file-view:visible .md-switch')).toBeVisible();
}

const sw = (win: Page, name: string) => win.locator('.file-view:visible .md-switch').getByRole('radio', { name });

test('the switch and ⇧⌘V: GFM rendered with Aurora, outline, front matter, alerts, colored code; the view is remembered; a wide pane; Split follows the buffer; links and ⌘F', async () => {
  const { app, home, urlLog } = await launch();
  try {
    const win = await app.firstWindow();
    await openDesign(win);
    await expect(sw(win, 'Source')).toHaveAttribute('aria-checked', 'true');
    await menu(app, 'CmdOrCtrl+Shift+V');
    const pv = win.locator('.file-view:visible .md-preview');
    await expect(pv).toBeVisible();
    await expect(sw(win, 'Preview')).toHaveAttribute('aria-checked', 'true');
    await expect(win.locator('.file-view:visible .file-body')).toBeHidden();
    await expect(win.locator('.tab.is-active .tab-md')).toBeVisible();
    // Rendered: title, front matter pills, alert, task boxes, table, code colored by the editor's highlighter.
    await expect(pv.locator('h1')).toHaveText(/Offline sync — design/);
    await expect(pv.locator('.md-pill.is-waiting')).toContainText('draft');
    await expect(pv.locator('.md-alert.is-note .md-alert-title')).toHaveText('Note');
    await expect(pv.locator('.md-check.is-on')).toHaveCount(1);
    await expect(pv.locator('.md-check')).toHaveCount(2);
    await expect(pv.locator('.md-table td').first()).toHaveText('edit');
    await expect(pv.locator('.md-code-lang')).toHaveText('ts');
    await expect.poll(() => pv.locator('.md-code pre span[style*="color"]').count()).toBeGreaterThan(3);
    // Raw HTML: the script never reaches the page, a chip says so.
    await expect(pv.locator('script')).toHaveCount(0);
    await expect(pv.locator('.md-dropped')).toContainText('script');
    // Images: the local one through main, the remote one a placeholder.
    await expect(pv.locator('img.md-img')).toHaveAttribute('src', /^data:image\/png;base64,/);
    await expect(pv.locator('.md-img-off.is-remote')).toContainText('img.shields.io');
    // The outline: four headings, footer words.
    await expect(pv.locator('.md-toc-row')).toHaveCount(4);
    await expect(win.locator('.file-view:visible .foot-words')).toContainText('words');
    mkdirSync(SHOTS, { recursive: true });
    await look(win, join(SHOTS, '01-preview.png'));

    // An outline row scrolls the page to its heading and becomes current.
    const scroll = pv.locator('.md-scroll');
    await pv.locator('.md-toc-row', { hasText: 'Last' }).click();
    await expect.poll(() => scroll.evaluate((el) => el.scrollTop)).toBeGreaterThan(300);
    await expect(pv.locator('.md-toc-row.is-on')).toHaveText(/Last/);
    await look(win, join(SHOTS, '02-outline-scrolled.png'));

    // ⇧⌘V back to Source; the choice is remembered when the file opens again.
    await menu(app, 'CmdOrCtrl+Shift+V');
    await expect(win.locator('.file-view:visible .file-body')).toBeVisible();
    await expect(pv).toBeHidden();
    await sw(win, 'Preview').click();
    await win.keyboard.press('Meta+w');
    await openDesign(win);
    await expect(win.locator('.file-view:visible .md-preview')).toBeVisible();

    // A wide pane: the page and the outline grow with it, up to a readable measure; a narrow one keeps them as they were.
    const measure = () => win.evaluate(() => {
      const box = (sel: string) => document.querySelector<HTMLElement>(`.file-view:not([hidden]) ${sel}`)?.getBoundingClientRect().width ?? 0;
      return { pane: box('.md-preview'), page: box('.md-article'), outline: box('.md-outline') };
    });
    const setWidth = (w: number) => app.evaluate(({ BrowserWindow }, w) => BrowserWindow.getAllWindows()[0]?.setSize(w, 1000), w);
    await expect(win.locator('.file-view:visible .md-outline')).toBeVisible();
    await expect.poll(async () => (await measure()).pane).toBeLessThan(1200);
    const narrow = await measure();
    expect(narrow.page).toBeLessThanOrEqual(720);
    expect(narrow.outline).toBe(236);
    await setWidth(2000);
    // As wide as the display allows (the window never outgrows it).
    await expect.poll(async () => (await measure()).pane).toBeGreaterThan(1300);
    const wide = await measure();
    expect(wide.page).toBeGreaterThan(760);
    expect(wide.page).toBeLessThanOrEqual(840);
    expect(wide.outline).toBeGreaterThan(256);
    expect(wide.outline).toBeLessThanOrEqual(320);
    await look(win.locator('.file-view:visible .md-preview'), 'test-results/markdown-wide.png');
    await setWidth(1600);
    await expect.poll(async () => (await measure()).pane).toBeLessThan(1200);

    // Split follows the buffer while typing (unsaved), scrolls with the editor; Show in Source puts the cursor on the line.
    await sw(win, 'Split').click();
    await expect(pv).toBeVisible();
    await expect(win.locator('.file-view:visible .file-body')).toBeVisible();
    // Typing at the end shows up in the preview without saving.
    await win.locator('.file-view:visible .cm-content').click();
    await win.keyboard.press('Meta+ArrowDown');
    await win.keyboard.type('\n## Fresh heading\n');
    await expect(pv.locator('h2', { hasText: 'Fresh heading' })).toBeVisible();
    await expect(win.locator('.file-view:visible .foot-modified')).toBeVisible();
    // The editor at the end: the preview followed it down to its own end (wrapped text is taller).
    await expect(pv.locator('h2', { hasText: 'Fresh heading' })).toBeInViewport();
    await look(win, join(SHOTS, '03-split.png'));

    // Preview only: ⌥ double-click on the table goes back to Source with the cursor on that row's line.
    await sw(win, 'Preview').click();
    await pv.locator('.md-scroll').evaluate((el) => { el.scrollTop = 0; });
    await pv.locator('.md-table td', { hasText: 'delete' }).dblclick({ modifiers: ['Alt'] });
    await expect(win.locator('.file-view:visible .file-body')).toBeVisible();
    await expect(win.locator('.file-view:visible .foot-pos')).toHaveText(/Ln 23,/);

    // Links: a project file opens in a tab at its line, an anchor scrolls, a URL goes to the browser; ⌘F finds rendered text.
    await sw(win, 'Preview').click();
    // Hover says where it goes.
    await expect(pv.locator('a.md-link', { hasText: 'storage spec' })).toHaveAttribute('data-tip', /docs\/storage\.md:2 · Opens in a tab/);
    await pv.locator('a.md-link', { hasText: 'CRDT paper' }).click();
    await expect.poll(() => { try { return readFileSync(urlLog, 'utf8'); } catch { return ''; } }).toContain('https://crdt.tech/papers');

    // ⌘F: the find card over the page, counting the rendered text (not the markup).
    await pv.locator('.md-scroll').click({ position: { x: 5, y: 5 } });
    await win.keyboard.press('Meta+f');
    const card = win.locator('.file-view:visible .md-find-layer .find-card');
    await expect(card).toBeVisible();
    await win.keyboard.type('flush');
    // 1 in the code block + 40 paragraphs.
    await expect(card.locator('.fc-sr')).toHaveText(/of 41/);
    await win.keyboard.press('Enter');
    await expect(card.locator('.fc-sr')).toHaveText(/^2 of 41/);
    // The card doesn't sit on the outline: the outline moves down while it is open.
    const cardBox = (await card.boundingBox())!;
    await expect.poll(async () => (await pv.locator('.md-toc').boundingBox())!.y).toBeGreaterThan(cardBox.y + cardBox.height);
    await look(win, join(SHOTS, '04-find.png'));
    await win.keyboard.press('Escape');
    await expect(card).toBeHidden();

    // Anchor: scrolls to Goals.
    await scroll.evaluate((el) => { el.scrollTop = 0; });
    await pv.locator('a.md-link', { hasText: 'Goals' }).click();
    await expect.poll(() => scroll.evaluate((el) => el.scrollTop)).toBeGreaterThan(50);

    // A project file: a tab, at line 2.
    await pv.locator('a.md-link', { hasText: 'storage spec' }).click();
    await expect(win.locator('.file-view:visible .crumb')).toContainText('storage.md');
    await expect(win.locator('.file-view:visible .foot-pos')).toHaveText(/Ln 2,/);
  } finally {
    await stop(app, home);
  }
});

test('⌘L in the editor and in the preview: the lines behind the selection go to the Claude session prompt (@file#L2-3)', async () => {
  // The project path is deliberately not resolved: /var is a symlink to /private/var, like a project opened through a symlink.
  const { app, home } = await launch();
  try {
    const win = await app.firstWindow();
    await win.locator('.btn-new').click();
    await win.getByRole('menuitem', { name: 'Claude Session' }).click();
    await win.keyboard.press('Enter');
    await expect(win.locator('.session-row').first()).toHaveClass(/state-waiting/, { timeout: 20000 });
    await openDesign(win);
    // In the editor: back to the session's terminal, with the mention written (without Enter).
    const content = win.locator('.file-view:visible .cm-content');
    await expect(content).toContainText('Offline sync');
    await content.click();
    await win.keyboard.press('Meta+ArrowUp');
    await win.keyboard.press('ArrowDown');
    await win.keyboard.press('Shift+ArrowDown');
    await win.keyboard.press('Shift+ArrowDown');
    await win.keyboard.press('Meta+l');
    await expect(win.locator('.xterm-rows:visible')).toContainText('@docs/design.md#L2-3', { timeout: 5000 });

    // In the preview.
    await openDesign(win);
    await sw(win, 'Preview').click();
    const pv = win.locator('.file-view:visible .md-preview');
    // Select the first paragraph (lines 7–8 of the file).
    await pv.locator('.md-article > p').first().click({ clickCount: 3 });
    await win.keyboard.press('Meta+l');
    await expect(win.locator('.xterm-rows:visible')).toContainText('@docs/design.md#L7-8', { timeout: 5000 });
  } finally {
    await stop(app, home);
  }
});

test('Split: Claude writing the file does not move the page the user is reading; scrolled up by hand, it stops following the end', async () => {
  const { app, home, project } = await launch();
  try {
    const win = await app.firstWindow();
    await openDesign(win);
    await sw(win, 'Split').click();
    const pv = win.locator('.file-view:visible .md-preview');
    const page = pv.locator('.md-scroll');
    await expect(pv.locator('h1')).toBeVisible();
    // Reading the middle (the cursor stays on line 1): the page follows the editor's scroll.
    await win.locator('.file-view:visible .cm-scroller').evaluate((el) => { el.scrollTop = 1200; });
    await expect.poll(() => page.evaluate((el) => el.scrollTop)).toBeGreaterThan(400);
    const before = await page.evaluate((el) => el.scrollTop);
    await win.waitForTimeout(1200);
    // Claude appends to the file: the page shows it and stays where it was.
    appendFileSync(join(project, 'docs', 'design.md'), '\nAppended by Claude.\n');
    await expect(pv.getByText('Appended by Claude.')).toBeAttached();
    await win.waitForTimeout(300);
    expect(Math.abs((await page.evaluate((el) => el.scrollTop)) - before)).toBeLessThan(40);

    // The editor at its end, then the page scrolled up by hand: a resize doesn't snap it back to the end.
    await win.locator('.file-view:visible .cm-content').click();
    await win.keyboard.press('Meta+ArrowDown');
    await expect.poll(() => page.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop)).toBeLessThan(4);
    await page.hover();
    await win.mouse.wheel(0, -1500);
    await expect.poll(() => page.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop)).toBeGreaterThan(500);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1500, 1000));
    await win.waitForTimeout(400);
    // Not snapped back to the end (re-synced to the editor's top line at most, which can sit near the end).
    expect(await page.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop)).toBeGreaterThan(200);
  } finally {
    await stop(app, home);
  }
});

test('git changes in the preview: bars beside the changed blocks, ⌥F5 steps through them; Comment on Lines opens Split with the box', async () => {
  // A committed file, then changed: its HEAD version is the base of the margin marks.
  const { app, home } = await launch({}, (project) => {
    git(project, 'init', '-q');
    git(project, 'add', '-A');
    git(project, 'commit', '-q', '-m', 'base');
    const file = join(project, 'docs', 'design.md');
    writeFileSync(file, readFileSync(file, 'utf8')
      .replace('on every edit.', 'on every single edit.')
      .replace('- [ ] Show who changed what', '- [ ] Show who changed what\n- [ ] Resume a paused sync'));
  });
  try {
    const win = await app.firstWindow();
    await openDesign(win);
    await sw(win, 'Preview').click();
    const pv = win.locator('.file-view:visible .md-preview');
    await expect(pv.locator('.md-bar.is-mod')).toHaveCount(1);
    await expect(pv.locator('.md-bar.is-add')).toHaveCount(1);
    await expect(win.locator('.file-view:visible .change-nav-count')).toHaveText('2 changes');
    await menu(app, 'Alt+F5');
    await expect(win.locator('.file-view:visible .change-nav-count')).toHaveText('1 / 2');
    await menu(app, 'Alt+F5');
    await expect(win.locator('.file-view:visible .change-nav-count')).toHaveText('2 / 2');
    await look(win, join(SHOTS, '05-changes.png'));

    // Comment on the first paragraph's lines from the preview: Split opens with the box under them.
    await pv.locator('.md-scroll').evaluate((el) => { el.scrollTop = 0; });
    await pv.locator('.md-article > p').first().click({ clickCount: 3 });
    await pv.locator('.md-article > p').first().click({ button: 'right' });
    await win.getByRole('menuitem', { name: 'Comment on Lines' }).click();
    await expect(sw(win, 'Split')).toHaveAttribute('aria-checked', 'true');
    await expect(win.locator('.file-view:visible .lc-box')).toHaveAttribute('aria-label', 'Lines 7–8');
  } finally {
    await stop(app, home);
  }
});

test('a crowded file bar: a new file with a long name never wraps its note or pushes the switch past the pane', async () => {
  const long = 'migrating-postgres-and-redis-from-managed-providers-to-self-hosted-services.md';
  const { app, home } = await launch({}, (project) => {
    git(project, 'init', '-q');
    git(project, 'add', '-A');
    git(project, 'commit', '-q', '-m', 'base');
    writeFileSync(join(project, 'docs', long), DOC);
  });
  try {
    const win = await app.firstWindow();
    const folder = win.locator('.tree-row', { hasText: 'docs' }).first();
    if (!(await folder.isVisible())) await win.getByRole('button', { name: /Files/ }).click();
    await folder.click();
    await win.locator('.tree-row', { hasText: long }).dblclick();
    await sw(win, 'Preview').click();
    const bar = win.locator('.file-view:visible .file-bar');
    await expect(bar.locator('.file-note')).toHaveText('New file (not in HEAD)');
    await expect(bar.locator('.change-nav')).toBeVisible();
    for (const width of [1600, 1300, 1100, 960]) {
      await app.evaluate(({ BrowserWindow }, w) => BrowserWindow.getAllWindows()[0]?.setSize(w, 1000), width);
      await expect.poll(() => bar.evaluate((el) => {
        const box = el.getBoundingClientRect();
        const pad = parseFloat(getComputedStyle(el).paddingRight);
        const out = [...el.children].filter((c) => { const r = c.getBoundingClientRect(); return r.width > 0 && (r.right > box.right - pad + 0.5 || r.height > box.height); });
        return out.map((c) => c.className);
      }), { message: `width ${width}` }).toEqual([]);
      const note = bar.locator('.file-note');
      if (await note.isVisible()) expect((await note.boundingBox())!.height, `note on one line at ${width}`).toBeLessThan(22);
      await look(win, join(SHOTS, `07-crowded-bar-${width}.png`));
    }
  } finally {
    await stop(app, home);
  }
});
