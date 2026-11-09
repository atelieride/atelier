import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, delimiter, dirname, join, resolve } from 'node:path';
import { e2eEnv } from './env';
import { look } from './shots';

// Open any file: Open File…, Finder drops, macOS open-file, tabs across restarts.

const daemonPid = (home: string) => (JSON.parse(readFileSync(join(home, 'atelierd.json'), 'utf8')) as { pid: number }).pid;
const command = (app: ElectronApplication, cmd: string) => app.evaluate(({ BrowserWindow }, c) => BrowserWindow.getAllWindows()[0]!.webContents.send('ev:command', c), cmd);
const tab = (win: Page, name: string) => win.locator('.tab', { hasText: name });

function fixture() {
  const project = realpathSync(mkdtempSync(join(tmpdir(), 'atl-prj-')));
  mkdirSync(join(project, 'src'));
  writeFileSync(join(project, 'src', 'a.ts'), 'export const a = 1;\n');
  const outside = realpathSync(mkdtempSync(join(tmpdir(), 'atl-out-')));
  writeFileSync(join(outside, 'notes.txt'), 'first line\n');
  writeFileSync(join(outside, 'other.json'), '{ "x": 1 }\n');
  return { project, outside, notes: join(outside, 'notes.txt'), other: join(outside, 'other.json') };
}

/** A Finder drop as the page sees it: Files on the DataTransfer (the paths come from ATELIER_TEST_DROP_PATHS). */
async function dropOn(win: Page, selector: string, phase: 'over' | 'drop') {
  await win.locator(selector).first().evaluate((el, p) => {
    const dt = new DataTransfer();
    dt.items.add(new File(['x'], 'dropped.txt'));
    const r = el.getBoundingClientRect();
    const at = { clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
    el.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true, ...at }));
    if (p === 'drop') el.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true, ...at }));
  }, phase);
}

test('Open File… opens a file outside the project: chip, ⌘S saves it, a change on disk reloads it', async () => {
  const { project, notes } = fixture();
  const longer = join(dirname(notes), 'release-notes.md');
  writeFileSync(longer, '# Notes\n');
  const { env, home } = e2eEnv({ ATELIER_CLAUDE_BIN: resolve('tests/e2e/fake-claude.pl'), ATELIER_TEST_PICK_FILES: `${longer}${delimiter}${notes}` });
  const app = await electron.launch({ args: ['out/main/index.js', `--project=${project}`], env });
  try {
    const win = await app.firstWindow();
    await expect(win.locator('.header')).toBeVisible();
    await command(app, 'open-file');
    // A tab a little too wide: the folder gives way, the name stays whole.
    const cut = (sel: string) => tab(win, 'release-notes.md').locator(sel).evaluate((el) => el.scrollWidth > el.clientWidth);
    await expect(tab(win, 'release-notes.md').locator('.tab-dir')).toBeVisible({ timeout: 10000 });
    expect(await cut('.tab-dir')).toBe(true);
    expect(await cut('.tab-name')).toBe(false);
    const strip = (await win.locator('.tabs').boundingBox())!;
    await look(win, 'test-results/open-any-file-tabs.png', { clip: { x: strip.x, y: strip.y, width: 560, height: strip.height } });
    await expect(tab(win, 'notes.txt')).toHaveClass(/is-active/, { timeout: 10000 });
    const view = win.locator('.file-view:visible');
    await expect(view.locator('.file-note.is-outside')).toHaveText('Outside project');
    await expect(view.locator('.cm-content')).toContainText('first line');
    // The tab says it at a glance: the folder holding the file, after its name; the tip says the rest.
    await expect(tab(win, 'notes.txt').locator('.tab-dir')).toHaveText(basename(dirname(notes)));
    await expect(tab(win, 'notes.txt')).toHaveAttribute('data-tip', /Outside project$/);
    await expect(tab(win, 'notes.txt')).toHaveAttribute('aria-description', /Outside project$/);
    await expect(tab(win, 'notes.txt').locator('.tab-dir')).toHaveAttribute('aria-hidden', 'true');
    await look(win, 'test-results/open-any-file-chip.png');

    await view.locator('.cm-content').click();
    await win.keyboard.press('Meta+ArrowDown');
    await win.keyboard.type('typed in Atelier\n');
    await win.keyboard.press('Meta+S');
    await expect.poll(() => readFileSync(notes, 'utf8'), { timeout: 5000 }).toContain('typed in Atelier');

    writeFileSync(notes, 'changed by another editor\n');
    await expect(view.locator('.cm-content')).toContainText('changed by another editor', { timeout: 10000 });
    // Another editor's atomic save (a new inode), then a plain write to the new file: both reload it.
    writeFileSync(join(dirname(notes), '.notes.tmp'), 'replaced atomically\n');
    renameSync(join(dirname(notes), '.notes.tmp'), notes);
    await expect(view.locator('.cm-content')).toContainText('replaced atomically', { timeout: 10000 });
    await win.waitForTimeout(300);
    writeFileSync(notes, 'written after the replace\n');
    await expect(view.locator('.cm-content')).toContainText('written after the replace', { timeout: 10000 });
  } finally {
    await app.close();
    try { process.kill(daemonPid(home), 'SIGTERM'); } catch { /* already stopped */ }
  }
});

test('Finder drop: the pill outside the terminal, a file opens, a project folder shows in the tree, the terminal still takes its own', async () => {
  const { project, other, notes } = fixture();
  const { env, home } = e2eEnv({ ATELIER_CLAUDE_BIN: resolve('tests/e2e/fake-claude.pl') });
  const list = join(home, 'drop-paths.txt');
  env.ATELIER_TEST_DROP_PATHS = list;
  const app = await electron.launch({ args: ['out/main/index.js', `--project=${project}`], env });
  try {
    const win = await app.firstWindow();
    await win.getByRole('button', { name: 'Open a terminal' }).click();
    await expect(win.locator('.xterm-rows:visible')).toBeVisible({ timeout: 10000 });

    // Over the terminal: no pill (its own highlight); over the tab strip: the pill.
    await dropOn(win, '.terminal-slot:visible', 'over');
    await expect(win.locator('.file-drop-pill')).toHaveCount(0);
    // Leaving the terminal (a real drag sends this on its way out).
    await win.locator('.terminal-slot:visible').evaluate((el) => el.dispatchEvent(new DragEvent('dragleave', { bubbles: true, relatedTarget: null })));
    await dropOn(win, '.tabs', 'over');
    await expect(win.locator('.file-drop-pill')).toHaveText('Drop to open');
    // Still dragging (dragover keeps coming) once the entrance is over: the pill as it looks.
    await win.waitForTimeout(200);
    await dropOn(win, '.tabs', 'over');
    await look(win, 'test-results/open-any-file-pill.png');
    await expect(win.locator('.file-drop-pill')).toHaveCount(0, { timeout: 2000 });

    writeFileSync(list, `${other}\n`);
    await dropOn(win, '.tabs', 'drop');
    await expect(tab(win, 'other.json')).toHaveClass(/is-active/, { timeout: 10000 });
    await expect(win.locator('.file-view:visible .file-note.is-outside')).toBeVisible();

    // On the editor: the file opens; nothing is pasted into the document in front (CodeMirror would).
    writeFileSync(list, `${notes}\n`);
    await dropOn(win, '.file-view:visible .cm-content', 'drop');
    await expect(tab(win, 'notes.txt')).toHaveClass(/is-active/, { timeout: 10000 });
    await tab(win, 'other.json').click();
    await expect(win.locator('.file-view:visible .cm-content')).toHaveText('{ "x": 1 }');
    await expect(tab(win, 'other.json').locator('.tab-dirty')).toHaveCount(0);

    writeFileSync(list, `${join(project, 'src')}\n`);
    await dropOn(win, '.tabs', 'drop');
    await expect(win.locator('.tree-row', { hasText: 'src' })).toBeVisible({ timeout: 10000 });

    // A drop on the terminal stays the terminal's: nothing opens.
    writeFileSync(list, `${join(project, 'src', 'a.ts')}\n`);
    await win.locator('.tab', { hasText: /zsh|Terminal/ }).first().click();
    await dropOn(win, '.terminal-slot:visible', 'drop');
    await win.waitForTimeout(500);
    await expect(tab(win, 'a.ts')).toHaveCount(0);

    // On a tab (which takes tab drags): the file opens.
    await dropOn(win, '.tab[data-key^="t:"]', 'drop');
    await expect(tab(win, 'a.ts')).toHaveClass(/is-active/, { timeout: 10000 });
    // A project file's tab has no folder hint.
    await expect(tab(win, 'a.ts').locator('.tab-dir')).toHaveCount(0);
  } finally {
    await app.close();
    try { process.kill(daemonPid(home), 'SIGTERM'); } catch { /* already stopped */ }
  }
});

test('macOS open-file (Open With, open -a, atelier): routed to the project holding the file, even while its page loads', async () => {
  const { project, other } = fixture();
  const { env, home } = e2eEnv({ ATELIER_CLAUDE_BIN: resolve('tests/e2e/fake-claude.pl') });
  const app = await electron.launch({ args: ['out/main/index.js', `--project=${project}`], env });
  try {
    const openFile = (p: string) => app.evaluate(({ app: a }, path) => { a.emit('open-file', { preventDefault: () => {} }, path); }, p);
    // Right away: the window's page may not listen yet; main holds it for the page.
    await openFile(join(project, 'src', 'a.ts'));
    const win = await app.firstWindow();
    await expect(tab(win, 'a.ts')).toHaveClass(/is-active/, { timeout: 10000 });
    await expect(win.locator('.file-view:visible .file-note.is-outside')).toHaveCount(0);
    await openFile(other);
    await expect(tab(win, 'other.json')).toHaveClass(/is-active/, { timeout: 10000 });
    await expect(win.locator('.file-view:visible .file-note.is-outside')).toBeVisible();
  } finally {
    await app.close();
    try { process.kill(daemonPid(home), 'SIGTERM'); } catch { /* already stopped */ }
  }
});

test('after a restart the file tabs come back in order with the tab in front; a deleted file does not; a terminal in front comes back too', async () => {
  const { project, notes, other } = fixture();
  const { env, home } = e2eEnv({ ATELIER_CLAUDE_BIN: resolve('tests/e2e/fake-claude.pl'), ATELIER_TEST_PICK_FILES: `${notes}${delimiter}${other}` });
  const launch = () => electron.launch({ args: ['out/main/index.js', `--project=${project}`], env });
  try {
    let app = await launch();
    let win = await app.firstWindow();
    // a.ts, then a terminal (it enters after the tab in front), then the outside files: a terminal between file tabs.
    await win.getByRole('button', { name: /Files/ }).click();
    await win.locator('.tree-row', { hasText: 'src' }).click();
    await win.locator('.tree-row', { hasText: 'a.ts' }).dblclick();
    await expect(tab(win, 'a.ts')).toHaveClass(/is-active/);
    await command(app, 'new-terminal');
    await expect(win.locator('.xterm-rows:visible')).toBeVisible({ timeout: 10000 });
    await command(app, 'open-file');
    await expect(tab(win, 'other.json')).toHaveClass(/is-active/, { timeout: 10000 });
    await tab(win, 'notes.txt').click();
    const order = async (w: Page) => (await w.locator('.tab').allTextContents()).map((s) => s.trim());
    const before = await order(win);
    expect(before.findIndex((s) => s.includes('Terminal'))).toBe(1);
    // Saved (debounced) once all four tabs are in, with notes.txt in front.
    const saved = () => { try { return Object.values((JSON.parse(readFileSync(join(home, 'tabs.json'), 'utf8')) as { projects: Record<string, { tabs: { order: string[]; active: string | null } }> }).projects).map((e) => ({ tabs: e.tabs.order.length, active: e.tabs.active })); } catch { return []; } };
    await expect.poll(saved).toEqual([{ tabs: 4, active: `f:${notes}` }]);
    await app.close();

    app = await launch();
    win = await app.firstWindow();
    await expect(tab(win, 'notes.txt')).toHaveClass(/is-active/, { timeout: 15000 });
    await expect(win.locator('.file-view:visible .cm-content')).toContainText('first line');
    await expect(win.locator('.file-view:visible .file-note.is-outside')).toBeVisible();
    expect(await order(win)).toEqual(before);
    await look(win, 'test-results/open-any-file-restored.png');

    // The terminal in front this time, the window closed at once (saved on its way out); other.json deleted meanwhile.
    await win.locator('.tab[data-key^="t:"]').first().click();
    await expect(win.locator('.tab[data-key^="t:"]').first()).toHaveClass(/is-active/);
    await app.close();
    unlinkSync(other);

    app = await launch();
    win = await app.firstWindow();
    await expect(win.locator('.tab[data-key^="t:"]').first()).toHaveClass(/is-active/, { timeout: 15000 });
    await expect(tab(win, 'notes.txt')).toBeVisible();
    await expect(tab(win, 'a.ts')).toBeVisible();
    await expect(tab(win, 'other.json')).toHaveCount(0);
    await app.close();
  } finally {
    try { process.kill(daemonPid(home), 'SIGTERM'); } catch { /* already stopped */ }
  }
});
