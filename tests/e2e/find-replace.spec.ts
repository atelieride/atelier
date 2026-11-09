// Editor find and replace card.
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { e2eEnv } from './env';
import { look } from './shots';

const SHOTS = resolve('e2e-shots/find-replace');

const SOURCE = [
  "import type { Session, SessionState } from '../shared/sessions';",
  'export function sortSessions(list: Session[]): Session[] {',
  '  return list; // session order',
  '}',
  ...Array.from({ length: 60 }, (_, i) => `const line${i} = ${i};`),
  'export const lastSession = null;'
].join('\n') + '\n';

async function launch(): Promise<{ app: ElectronApplication; home: string }> {
  const project = mkdtempSync(join(tmpdir(), 'atl-prj-'));
  writeFileSync(join(project, 'a.ts'), SOURCE);
  writeFileSync(join(project, 'many.txt'), Array.from({ length: 300 }, () => 'ab ab ab ab ab').join('\n') + '\n');
  // Not UTF-8: opens read-only.
  writeFileSync(join(project, 'latin.txt'), Buffer.from([0x73, 0x65, 0x73, 0x73, 0x69, 0x6f, 0x6e, 0x20, 0xe8, 0x0a]));
  const { env, home } = e2eEnv({ ATELIER_CLAUDE_BIN: resolve('tests/e2e/fake-claude.pl') });
  const app = await electron.launch({ args: ['out/main/index.js', `--project=${project}`], env });
  return { app, home };
}

async function stop(app: ElectronApplication, home: string) {
  await app.close();
  try { process.kill((JSON.parse(readFileSync(join(home, 'atelierd.json'), 'utf8')) as { pid: number }).pid, 'SIGTERM'); } catch { /* already stopped */ }
}

async function openFile(win: Page, name: string) {
  const row = win.locator('.tree-row', { hasText: name });
  if (!(await row.isVisible())) await win.getByRole('button', { name: /Files/ }).click();
  await row.dblclick();
  await expect(win.locator('.file-view:visible .cm-content')).toBeVisible();
}

const docText = (win: Page) => win.locator('.file-view:visible .cm-content').evaluate((el) => (el as HTMLElement).innerText);

test('⌘F floats the card over the code; typing counts, Enter moves, options and regex errors', async () => {
  const { app, home } = await launch();
  try {
    const win = await app.firstWindow();
    await openFile(win, 'a.ts');
    const firstLine = win.locator('.file-view:visible .cm-line').first();
    await win.locator('.file-view:visible .cm-content').click();
    await win.keyboard.press('Meta+ArrowUp');
    const before = (await firstLine.boundingBox())!.y;
    await win.keyboard.press('Meta+f');
    const card = win.locator('.find-card');
    await expect(card).toBeVisible();
    await expect(card).toHaveClass(/cm-search/);
    // The code doesn't move down.
    expect((await firstLine.boundingBox())!.y).toBe(before);
    await expect(win.getByRole('textbox', { name: 'Find' })).toBeFocused();

    await win.keyboard.type('session');
    const count = card.locator('.fc-count .fc-wide');
    await expect(count).toHaveText('8 results');
    await win.keyboard.press('Enter');
    await expect(count).toHaveText('1 of 8');
    await win.keyboard.press('Enter');
    await expect(count).toHaveText('2 of 8');
    await win.keyboard.press('Shift+Enter');
    await expect(count).toHaveText('1 of 8');
    await expect(win.locator('.cm-ruler-find').first()).toBeAttached();

    // ⌥C goes by the key, not the character it types.
    await win.keyboard.press('Alt+KeyC');
    await expect(card.getByRole('button', { name: 'Match Case' })).toHaveAttribute('aria-pressed', 'true');
    await expect(card.getByRole('textbox', { name: 'Find' })).toHaveValue('session');
    await expect(count).toHaveText(/^2 results$|^1 of 2$/);
    await win.keyboard.press('Alt+KeyC');

    await card.getByRole('button', { name: 'Regular Expression' }).click();
    await card.getByRole('textbox', { name: 'Find' }).fill('sess(ion');
    await expect(card.locator('.fc-error')).toHaveText('Unclosed group: add ) or escape the (');
    await expect(count).toHaveText('Invalid');
    await expect(card.locator('.fc-field').first()).toHaveClass(/is-error/);
    await card.getByRole('textbox', { name: 'Find' }).fill('nothing-like-this');
    await expect(count).toHaveText('No results');
    await expect(card.getByRole('button', { name: 'Next Match' })).toBeDisabled();

    mkdirSync(SHOTS, { recursive: true });
    await card.getByRole('textbox', { name: 'Find' }).fill('Session');
    await look(win.locator('.file-view:visible'), `${SHOTS}/find.png`);

    await win.keyboard.press('Escape');
    await expect(card).toHaveCount(0);
    await expect(win.locator('.file-view:visible .cm-content')).toBeFocused();
    await expect(win.locator('.cm-ruler-find')).toHaveCount(0);
  } finally {
    await stop(app, home);
  }
});

test('⌥⌘F replaces; ⌘↵ replaces all with a toast and Undo; the empty result after it stays quiet', async () => {
  const { app, home } = await launch();
  try {
    const win = await app.firstWindow();
    await openFile(win, 'a.ts');
    await win.locator('.file-view:visible .cm-content').click();
    await win.keyboard.press('Meta+ArrowUp');
    await win.keyboard.press('Meta+Alt+f');
    const card = win.locator('.find-card');
    await expect(card.getByRole('textbox', { name: 'Replace' })).toBeFocused();
    await card.getByRole('textbox', { name: 'Find' }).fill('session');
    await card.getByRole('textbox', { name: 'Replace' }).fill('task');
    // The first Enter selects the next match, the second replaces it (and moves on).
    await card.getByRole('textbox', { name: 'Replace' }).press('Enter');
    await expect(card.locator('.fc-count .fc-wide')).toHaveText('1 of 8');
    await card.getByRole('textbox', { name: 'Replace' }).press('Enter');
    await expect(card.locator('.fc-count .fc-wide')).toHaveText('1 of 7');
    expect(await docText(win)).toContain('{ task, SessionState');
    await look(win.locator('.file-view:visible'), `${SHOTS}/replace.png`);
    await card.getByRole('textbox', { name: 'Replace' }).press('Meta+Enter');
    await expect(win.locator('.toast')).toContainText('Replaced 7 occurrences');
    await expect(card.locator('.fc-count')).toHaveClass(/is-quiet/);
    await expect(card.locator('.fc-count .fc-wide')).toHaveText('No results');
    expect(await docText(win)).not.toMatch(/session/i);
    await win.locator('.toast').getByRole('button', { name: 'Undo' }).click();
    await expect.poll(() => docText(win)).toContain('sortSessions');
    expect(await docText(win)).toContain('{ task, SessionState');

    // The card remembers the query for the next one in this window.
    await win.keyboard.press('Escape');
    await win.locator('.file-view:visible .cm-content').click();
    await win.keyboard.press('Meta+f');
    await expect(card.getByRole('textbox', { name: 'Find' })).toHaveValue('session');

    // Narrow (a split pane): short counter and "All".
    await win.keyboard.press('Enter');
    await win.locator('.file-view:visible').evaluate((el) => { (el as HTMLElement).style.width = '360px'; });
    await expect(card.locator('.fc-count .fc-narrow')).toBeVisible();
    await expect(card.locator('.fc-count .fc-narrow')).toHaveText(/^\d+\/7$/);
    await expect(card.locator('.fc-count .fc-wide')).toBeHidden();
    await look(win.locator('.file-view:visible'), `${SHOTS}/narrow.png`);
  } finally {
    await stop(app, home);
  }
});

test('read-only file: find only; palette and context menu open the card; Go to Line', async () => {
  const { app, home } = await launch();
  try {
    const win = await app.firstWindow();
    await openFile(win, 'latin.txt');
    await win.locator('.file-view:visible .cm-content').click();
    await win.keyboard.press('Meta+Alt+f');
    const card = win.locator('.find-card');
    await expect(card).toBeVisible();
    await expect(card.locator('.fc-chev')).toHaveCount(0);
    await expect(card.getByRole('textbox', { name: 'Replace' })).toHaveCount(0);
    await win.keyboard.press('Escape');

    await openFile(win, 'a.ts');
    await win.keyboard.press('F1');
    await win.locator('.palette-input').fill('>Find and Replace');
    await win.locator('.palette-item', { hasText: 'Find and Replace' }).click();
    await expect(card.getByRole('textbox', { name: 'Replace' })).toBeFocused();
    await win.keyboard.press('Escape');
    await expect(card).toHaveCount(0);

    await win.locator('.file-view:visible .cm-content').click({ button: 'right' });
    await win.getByRole('menuitem', { name: 'Find and Replace' }).click();
    await expect(card.getByRole('textbox', { name: 'Replace' })).toBeFocused();
    await win.keyboard.press('Escape');

    // Go to Line, CodeMirror's dialog in the Aurora look (tests/integration/goto-line-css.test.ts guards the styles).
    await win.locator('.file-view:visible .cm-content').click({ button: 'right' });
    await win.getByRole('menuitem', { name: 'Go to Line…' }).click();
    await expect(win.locator('.cm-goto-line')).toBeVisible();
    await look(win.locator('.file-view:visible'), `${SHOTS}/goto-line.png`);
  } finally {
    await stop(app, home);
  }
});

test('⌥↵ puts a cursor on every match, past 1000 too; ⌘F inside the card keeps a typed query; card buttons keep the keyboard; the wheel over the card scrolls the code', async () => {
  const { app, home } = await launch();
  try {
    const win = await app.firstWindow();
    await openFile(win, 'a.ts');
    const content = win.locator('.file-view:visible .cm-content');
    await content.click();
    await win.keyboard.press('Meta+ArrowUp');
    await win.keyboard.press('Meta+f');
    const card = win.locator('.find-card');
    const field = card.getByRole('textbox', { name: 'Find' });

    // A regex survives ⌘F pressed again in the card (no reseeding from the match just selected).
    await card.getByRole('button', { name: 'Regular Expression' }).click();
    await field.fill('Session\\w*');
    await field.press('Enter');
    await expect(card.locator('.fc-count .fc-wide')).toHaveText(/^1 of /);
    await field.press('Meta+f');
    await expect(field).toHaveValue('Session\\w*');
    await card.getByRole('button', { name: 'Regular Expression' }).click();

    // ⌥↵: every match selected, typing replaces them all.
    await field.fill('session');
    await field.press('Alt+Enter');
    await expect(content).toBeFocused();
    await win.keyboard.type('X');
    await expect.poll(() => docText(win)).not.toMatch(/session/i);
    expect(await docText(win)).toContain('{ X, XState }');
    await win.keyboard.press('Meta+z');

    // Replace all by mouse: the keyboard stays in the card, so Esc still closes it and returns to the code.
    await win.keyboard.press('Meta+Alt+f');
    await card.getByRole('textbox', { name: 'Find' }).fill('lastSession');
    await card.getByRole('textbox', { name: 'Replace' }).fill('lastTask');
    await card.getByRole('button', { name: 'Replace all' }).click();
    await expect(win.locator('.toast')).toContainText('Replaced 1 occurrence');
    await win.keyboard.press('Escape');
    await expect(card).toHaveCount(0);
    await expect(content).toBeFocused();

    // A right-click in the card is not the editor's menu.
    await win.keyboard.press('Meta+f');
    await card.getByRole('textbox', { name: 'Find' }).click({ button: 'right' });
    await expect(win.getByRole('menuitem', { name: 'Go to Line…' })).toHaveCount(0);
    await win.keyboard.press('Escape');

    // ⌥↵ past 1000 matches.
    await openFile(win, 'many.txt');
    await content.click();
    await win.keyboard.press('Meta+f');
    await field.fill('ab');
    await expect(card.locator('.fc-count .fc-wide')).toHaveText('1,500 results');

    // The wheel over the card moves the code under it.
    const scroller = win.locator('.file-view:visible .cm-scroller');
    const top = () => scroller.evaluate((el) => el.scrollTop);
    const before = await top();
    await card.hover();
    await win.mouse.wheel(0, 400);
    await expect.poll(top).toBeGreaterThan(before);

    await field.press('Alt+Enter');
    await expect(content).toBeFocused();
    await win.keyboard.type('X');
    await win.keyboard.press('Meta+f');
    await field.fill('ab');
    await expect(card.locator('.fc-count .fc-wide')).toHaveText('No results');
    await field.fill('X');
    await expect(card.locator('.fc-count .fc-wide')).toHaveText('1,500 results');
  } finally {
    await stop(app, home);
  }
});

test('Diff view: find only, matches counted in the diff', async () => {
  const project = mkdtempSync(join(tmpdir(), 'atl-prj-'));
  const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  const git = (...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: project, env: gitEnv });
  git('init', '-q', '-b', 'main');
  writeFileSync(join(project, 'a.ts'), SOURCE);
  git('add', '.');
  git('commit', '-q', '-m', 'first');
  writeFileSync(join(project, 'a.ts'), SOURCE.replace('// session order', '// newest session first'));
  const { env, home } = e2eEnv({ ATELIER_CLAUDE_BIN: resolve('tests/e2e/fake-claude.pl') });
  const app = await electron.launch({ args: ['out/main/index.js', `--project=${project}`], env });
  try {
    const win = await app.firstWindow();
    await openFile(win, 'a.ts');
    await win.locator('.file-view:visible .seg').getByRole('button', { name: 'Diff' }).click();
    await expect(win.locator('.file-view:visible .cm-diff-add').first()).toBeVisible();
    await win.locator('.file-view:visible .cm-content').click();
    await win.keyboard.press('Meta+Alt+f');
    const card = win.locator('.find-card');
    await expect(card).toBeVisible();
    await expect(card.locator('.fc-chev')).toHaveCount(0);
    await expect(card.getByRole('textbox', { name: 'Replace' })).toHaveCount(0);
    await card.getByRole('textbox', { name: 'Find' }).fill('session');
    // Both the removed and the added line are in the diff: one more match than the file.
    await expect(card.locator('.fc-count .fc-wide')).toHaveText('9 results');
    await win.keyboard.press('F1');
    await win.locator('.palette-input').fill('>Find');
    await expect(win.locator('.palette-item', { hasText: 'Find in File' })).toBeVisible();
    await expect(win.locator('.palette-item', { hasText: 'Find and Replace' })).toHaveCount(0);
  } finally {
    await stop(app, home);
  }
});
