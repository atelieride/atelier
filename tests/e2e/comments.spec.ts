import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { e2eEnv } from './env';
import { look } from './shots';

// Test repos isolated from the user's git configuration (global hooks, commit signing, ...).
const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const git = (cwd: string, ...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd, env: gitEnv });
const SHOTS = 'test-results';
const lines = (n: number) => Array.from({ length: n }, (_, i) => `const r${i + 1} = ${(i + 1) * 10};`).join('\n') + '\n';

type Api = { terminals: { list(): Promise<{ id: string; title: string }[]>; input(id: string, data: string): void } };

async function stop(app: ElectronApplication, home: string) {
  await app.close();
  try { process.kill((JSON.parse(readFileSync(join(home, 'atelierd.json'), 'utf8')) as { pid: number }).pid, 'SIGTERM'); } catch { /* already stopped */ }
}

async function typeInto(win: Page, title: string, text: string) {
  await win.evaluate(async ({ title, text }) => {
    const api = (window as unknown as { atelier: Api }).atelier;
    api.terminals.input((await api.terminals.list()).find((x) => x.title === title)!.id, text);
  }, { title, text });
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

const terminalText = (win: Page) => win.locator('.terminal-slot:visible .xterm-rows').evaluate((el) =>
  [...el.querySelectorAll(':scope > div')].map((r) => (r.textContent ?? '').replace(/\s+$/, '')).join('\n'));

test('comment on review lines → gutter marker and pending chip → Send types one paste (no Enter) only when the prompt is free; Undo; outdated after an edit; ⌘⌥C', async () => {
  const project = mkdtempSync(join(tmpdir(), 'atl-prj-'));
  mkdirSync(join(project, 'src'));
  writeFileSync(join(project, 'src', 'rate.ts'), lines(12));
  git(project, 'init', '-q', '-b', 'dev');
  git(project, 'add', '.');
  git(project, 'commit', '-q', '-m', 'first');
  const file = join(project, 'src', 'rate.ts');
  const changed = lines(12).replace('const r4 = 40;', 'const r4 = 4000;').replace('const r5 = 50;', 'const r5 = 5000;');
  writeFileSync(file, changed);

  const { env, home } = e2eEnv({ ATELIER_CLAUDE_BIN: resolve('tests/e2e/fake-claude-review.pl'), ATELIER_FAKE_EDIT: file });
  const app = await electron.launch({ args: ['out/main/index.js', `--project=${project}`], env });
  try {
    const win = await app.firstWindow();
    await win.locator('.btn-new').click();
    await win.getByRole('menuitem', { name: 'Claude Session' }).click();
    await win.getByPlaceholder('Session name (optional)').fill('Alfa');
    await win.keyboard.press('Enter');
    const row = win.locator('.session-row', { hasText: 'Alfa' });
    await expect(row).toHaveClass(/state-waiting/, { timeout: 20000 });
    await expect(win.locator('.changes .change-row', { hasText: 'rate.ts' }).locator('.dot:not(.unknown)')).toHaveCount(1, { timeout: 10000 });

    // Select the two new lines in Alfa's review: the "Comment" button shows at the selection.
    await row.click({ button: 'right' });
    await win.getByRole('menuitem', { name: 'Review Session' }).click();
    const view = win.locator('.review-view');
    await view.locator('.cm-line', { hasText: 'const r4 = 4000;' }).click();
    await view.locator('.cm-line', { hasText: 'const r5 = 5000;' }).click({ modifiers: ['Shift'] });
    const tip = win.locator('.lc-tip');
    await expect(tip).toBeVisible();
    await look(win, `${SHOTS}/comments-selection.png`);
    await tip.click();

    // The box under the lines: the file's session as target, ⌘Enter saves.
    const box = view.locator('.lc-box');
    await expect(box).toBeVisible();
    await expect(box.locator('.lc-lines')).toHaveText('Lines 4–5');
    await expect(box.locator('.lc-target')).toContainText('To Alfa');
    await expect(box.locator('textarea')).toBeFocused();
    await win.keyboard.type('Use seconds,');
    await win.keyboard.press('Enter');
    await win.keyboard.type('not milliseconds.');
    await look(win, `${SHOTS}/comments-box.png`);
    await win.keyboard.press('Meta+Enter');
    await expect(box).toHaveCount(0);
    const card = view.locator('.lc-card');
    await expect(card).toContainText('Use seconds,\nnot milliseconds.');
    await expect(view.locator('.lc-mark')).toHaveCount(1);
    await expect(row.locator('.row-pending')).toHaveText('1');
    const send = view.locator('.rv-send');
    await expect(view.locator('.rv-pending-chip')).toContainText('1 pending');

    // Claude is waiting on a dialog: Send says why and types nothing.
    await expect(send).toHaveAttribute('aria-disabled', 'true');
    await expect(send).toHaveAttribute('data-tip', 'Answer Claude first');
    await look(win, `${SHOTS}/comments-pending.png`);
    await send.click({ force: true });
    await expect(win.locator('.toast')).toContainText('Answer Claude first');
    await expect(row.locator('.row-pending')).toHaveText('1');

    // Answered: the turn finishes, the prompt is free.
    await typeInto(win, 'Alfa', '\r');
    await expect(row).toHaveClass(/state-done/, { timeout: 10000 });
    await expect(send).not.toHaveAttribute('aria-disabled', 'true');
    await send.click();

    // One paste in the prompt, nothing submitted; the drafts are cleared.
    await expect(win.locator('.tab.is-active')).toContainText('Alfa');
    await expect.poll(() => terminalText(win), { timeout: 10000 }).toContain('Review comments:⏎@src/rate.ts#L4-5 Use seconds,⏎  not milliseconds.');
    await expect(win.locator('.toast')).toContainText('1 comment typed into Alfa · press Enter to send');
    await expect(row.locator('.row-pending')).toHaveCount(0);
    await win.waitForTimeout(600);
    expect(await terminalText(win)).not.toContain('FAKE-CLAUDE submitted');
    // Your Enter sends it.
    await win.keyboard.press('Enter');
    await expect.poll(() => terminalText(win), { timeout: 10000 }).toContain('FAKE-CLAUDE submitted=Review comments:⏎@src/rate.ts#L4-5 Use seconds,⏎  not milliseconds.');
    await look(win, `${SHOTS}/comments-sent.png`);
    // Undo brings the draft back.
    await win.locator('.toast').getByRole('button', { name: 'Undo' }).click();
    await expect(row.locator('.row-pending')).toHaveText('1');

    // In the editor: the same comment under its lines, then outdated once the file changes there.
    await win.locator('.tab', { hasText: 'Review ·' }).click();
    await view.locator('.rv-open').click();
    const editor = win.locator('.file-view:visible');
    await expect(editor.locator('.lc-card')).toContainText('Use seconds,');
    await expect(editor.locator('.lc-mark')).toHaveCount(1);
    await expect(editor.locator('.lc-outdated')).toHaveCount(0);
    writeFileSync(file, changed.replace('const r5 = 5000;', 'const r5 = 5;'));
    await expect(editor.locator('.lc-outdated')).toHaveText('Outdated', { timeout: 10000 });
    await expect(editor.locator('.lc-mark.is-outdated')).toHaveCount(1);
    await look(win, `${SHOTS}/comments-outdated.png`);

    // ⌘⌥C (Review › Comment on Selection) on a selection in the editor; Esc cancels the box.
    // The Outdated card was just drawn again (its React content lands a moment later): a click before the editor has
    // measured it again lands on stale line heights (the end of the file), so click until the cursor is on line 9.
    await expect(async () => {
      await editor.locator('.cm-line', { hasText: 'const r9 = 90;' }).click();
      await expect(editor.locator('.file-foot')).toContainText('Ln 9,', { timeout: 300 });
    }).toPass({ timeout: 5000 });
    await win.keyboard.press('Shift+ArrowDown');
    await menu(app, 'CmdOrCtrl+Alt+C');
    await expect(editor.locator('.lc-box .lc-lines')).toHaveText('Lines 9–10');
    await win.keyboard.press('Escape');
    await expect(editor.locator('.lc-box')).toHaveCount(0);
    // Without a selection it says what to do.
    await menu(app, 'CmdOrCtrl+Alt+C');
    await expect(win.locator('.toast')).toContainText('Select the lines to comment on');

    // Drafts survive a reload of the window.
    await win.reload();
    await expect(win.locator('.session-row', { hasText: 'Alfa' }).locator('.row-pending')).toHaveText('1', { timeout: 15000 });
  } finally {
    await stop(app, home);
  }
});

/** A project with a two-line change in src/rate.ts, the app on it and the review of all changes open. */
async function openReview(): Promise<{ app: ElectronApplication; home: string; win: Page; view: ReturnType<Page['locator']> }> {
  const project = mkdtempSync(join(tmpdir(), 'atl-prj-'));
  mkdirSync(join(project, 'src'));
  const file = join(project, 'src', 'rate.ts');
  writeFileSync(file, lines(12));
  git(project, 'init', '-q', '-b', 'dev');
  git(project, 'add', '.');
  git(project, 'commit', '-q', '-m', 'first');
  writeFileSync(file, lines(12).replace('const r4 = 40;', 'const r4 = 4000;').replace('const r5 = 50;', 'const r5 = 5000;'));
  const { env, home } = e2eEnv({ ATELIER_CLAUDE_BIN: resolve('tests/e2e/fake-claude.pl') });
  const app = await electron.launch({ args: ['out/main/index.js', `--project=${project}`], env });
  const win = await app.firstWindow();
  await expect(win.locator('.changes .change-row')).toHaveCount(1, { timeout: 10000 });
  await win.keyboard.press('F1');
  await win.locator('.palette-input').fill('>review all');
  await win.keyboard.press('Enter');
  const view = win.locator('.review-view');
  await expect(view.locator('.cm-line', { hasText: 'const r5 = 5000;' })).toBeVisible({ timeout: 10000 });
  return { app, home, win, view };
}

/** From now on, counts the "Comment" buttons put in the page. */
const countTips = (win: Page) => win.evaluate(() => {
  const w = window as unknown as { tipsAdded: number; tipsObserver?: MutationObserver };
  w.tipsObserver?.disconnect();
  w.tipsAdded = 0;
  w.tipsObserver = new MutationObserver((ms) => {
    for (const m of ms) for (const n of m.addedNodes) if (n instanceof HTMLElement && (n.matches('.lc-tip') || n.querySelector('.lc-tip'))) w.tipsAdded++;
  });
  w.tipsObserver.observe(document.body, { childList: true, subtree: true });
});
const tipsAdded = (win: Page) => win.evaluate(() => (window as unknown as { tipsAdded: number }).tipsAdded);

/** Drags a mouse selection from the start of one line to the middle of another, checking along the way. */
async function dragSelect(win: Page, scope: ReturnType<Page['locator']>, from: string, to: string, during: () => Promise<void>) {
  const a = (await scope.locator('.cm-line', { hasText: from }).boundingBox())!;
  const b = (await scope.locator('.cm-line', { hasText: to }).boundingBox())!;
  const x0 = a.x + 2; const y0 = a.y + a.height / 2;
  const x1 = b.x + 60; const y1 = b.y + b.height / 2;
  await win.mouse.move(x0, y0);
  await win.mouse.down();
  for (let i = 1; i <= 8; i++) {
    await win.mouse.move(x0 + ((x1 - x0) * i) / 8, y0 + ((y1 - y0) * i) / 8);
    await during();
  }
  // Holding still longer than a keyboard selection takes to settle: still a drag.
  await win.waitForTimeout(400);
  await during();
}

test('the Comment button shows once the selection is finished (not during a mouse drag, on mouse up; on Shift up); the review is read-only without a caret; a comment that grows under a line of a short file', async () => {
  const { app, home, win, view } = await openReview();
  try {
    const tip = win.locator('.lc-tip');
    const none = async () => { expect(await tip.count()).toBe(0); expect(await tipsAdded(win)).toBe(0); };

    // Review: a drag over two lines.
    await countTips(win);
    await dragSelect(win, view, 'const r4 = 4000;', 'const r5 = 5000;', none);
    await win.mouse.up();
    await expect(tip).toBeVisible();
    await win.waitForTimeout(400);
    expect(await tipsAdded(win)).toBe(1);
    await expect(tip).toHaveCount(1);
    await tip.click();
    await expect(view.locator('.lc-box .lc-lines')).toHaveText('Lines 4–5');
    await win.keyboard.press('Escape');

    // The editor: a drag, then a keyboard selection with Shift held.
    await view.locator('.rv-open').click();
    const editor = win.locator('.file-view:visible');
    await expect(editor.locator('.cm-line', { hasText: 'const r8 = 80;' })).toBeVisible({ timeout: 10000 });
    await countTips(win);
    await dragSelect(win, editor, 'const r7 = 70;', 'const r9 = 90;', none);
    await win.mouse.up();
    await expect(tip).toBeVisible();
    await win.waitForTimeout(400);
    expect(await tipsAdded(win)).toBe(1);

    await editor.locator('.cm-line', { hasText: 'const r2 = 20;' }).click();
    await expect(tip).toHaveCount(0);
    await countTips(win);
    await win.keyboard.down('Shift');
    for (let i = 0; i < 3; i++) { await win.keyboard.press('ArrowDown'); await none(); }
    await win.keyboard.up('Shift');
    await expect(tip).toBeVisible();
    await win.waitForTimeout(400);
    expect(await tipsAdded(win)).toBe(1);

    await editor.locator('.cm-line', { hasText: 'const r2 = 20;' }).click();
    await expect(tip).toHaveCount(0);

    // Back to the review. It is read-only without a caret: a click shows no cursor, the pointer is an arrow; selections
    // still comment.
    await win.keyboard.press('F1');
    await win.locator('.palette-input').fill('>review all');
    await win.keyboard.press('Enter');
    await expect(view.locator('.cm-line', { hasText: 'const r5 = 5000;' })).toBeVisible({ timeout: 10000 });
    const line = view.locator('.cm-line', { hasText: 'const r4 = 4000;' });
    await line.click();
    await expect(view.locator('.cm-editor')).toHaveClass(/cm-focused/);
    await expect(view.locator('.cm-cursor:visible')).toHaveCount(0);
    expect(await view.locator('.cm-content').evaluate((el) => getComputedStyle(el).caretColor)).toBe('rgba(0, 0, 0, 0)');
    expect(await line.evaluate((el) => getComputedStyle(el).cursor)).toBe('default');
    await look(win, `${SHOTS}/review-no-caret.png`, { animations: 'disabled' });

    // A mouse selection: the Comment button opens the box.
    await dragSelect(win, view, 'const r4 = 4000;', 'const r5 = 5000;', async () => {});
    await win.mouse.up();
    await win.locator('.lc-tip').click();
    await expect(view.locator('.lc-box .lc-lines')).toHaveText('Lines 4–5');
    await win.keyboard.press('Escape');
    await expect(view.locator('.lc-box')).toHaveCount(0);
    // And ⌘⌥C on a mouse selection.
    await dragSelect(win, view, 'const r4 = 4000;', 'const r5 = 5000;', async () => {});
    await win.mouse.up();
    await expect(win.locator('.lc-tip')).toBeVisible();
    await menu(app, 'CmdOrCtrl+Alt+C');
    await expect(view.locator('.lc-box .lc-lines')).toHaveText('Lines 4–5');
    await win.keyboard.press('Escape');
    await expect(view.locator('.lc-box')).toHaveCount(0);

    // A comment that grows under a line of a short file: a click below it lands on the line clicked (the editor measures
    // it again).
    await view.locator('.cm-line', { hasText: 'const r4 = 4000;' }).click();
    await view.locator('.cm-line', { hasText: 'const r5 = 5000;' }).click({ modifiers: ['Shift'] });
    await win.locator('.lc-tip').click();
    await expect(view.locator('.lc-box textarea')).toBeFocused();
    await win.keyboard.type('Grow');
    await win.keyboard.press('Meta+Enter');
    await expect(view.locator('.lc-box')).toHaveCount(0);

    // The file in the editor: shorter than the editor, its card under line 5.
    await view.locator('.rv-open').click();
    const card = editor.locator('.lc-card');
    await expect(card.locator('.lc-text')).toHaveText('Grow');
    const pos = editor.locator('.foot-pos');
    // The card gets taller (Edit: a textarea): the lines below it move down, and a click still lands where it points.
    const r8 = editor.locator('.cm-line', { hasText: 'const r8 = 80;' });
    const before = (await r8.boundingBox())!.y;
    await card.getByRole('button', { name: 'Edit' }).click();
    await expect(card.locator('textarea')).toBeFocused();
    await expect.poll(async () => (await r8.boundingBox())!.y).toBeGreaterThan(before + 20);
    await r8.click();
    await expect(pos).toHaveText(/^Ln 8,/);
    await editor.locator('.cm-line', { hasText: 'const r11 = 110;' }).click();
    await expect(pos).toHaveText(/^Ln 11,/);
  } finally {
    await stop(app, home);
  }
});

test('a comment being written (box or card in Edit) survives its diff being rebuilt; ⌘Enter and Esc give the keyboard back', async () => {
  const project = mkdtempSync(join(tmpdir(), 'atl-prj-'));
  mkdirSync(join(project, 'src'));
  const file = join(project, 'src', 'rate.ts');
  writeFileSync(file, lines(12));
  git(project, 'init', '-q', '-b', 'dev');
  git(project, 'add', '.');
  git(project, 'commit', '-q', '-m', 'first');
  let disk = lines(12).replace('const r4 = 40;', 'const r4 = 4000;').replace('const r5 = 50;', 'const r5 = 5000;');
  writeFileSync(file, disk);
  const edit = (from: string, to: string) => { disk = disk.replace(from, to); writeFileSync(file, disk); };

  const { env, home } = e2eEnv({ ATELIER_CLAUDE_BIN: resolve('tests/e2e/fake-claude.pl') });
  const app = await electron.launch({ args: ['out/main/index.js', `--project=${project}`], env });
  try {
    const win = await app.firstWindow();
    await expect(win.locator('.changes .change-row')).toHaveCount(1, { timeout: 10000 });
    await win.keyboard.press('F1');
    await win.locator('.palette-input').fill('>review all');
    await win.keyboard.press('Enter');
    const view = win.locator('.review-view');
    const content = view.locator('.cm-content');
    await view.locator('.cm-line', { hasText: 'const r4 = 4000;' }).click();
    await view.locator('.cm-line', { hasText: 'const r5 = 5000;' }).click({ modifiers: ['Shift'] });
    await win.locator('.lc-tip').click();
    const box = view.locator('.lc-box textarea');
    await expect(box).toBeFocused();
    await win.keyboard.type('Keep this');

    // The file changes on disk (a new hunk, then the commented line itself): the diff is redrawn, the text stays.
    edit('const r10 = 100;', 'const r10 = 1000;');
    await expect(content).toContainText('const r10 = 1000;', { timeout: 10000 });
    await expect(box).toHaveValue('Keep this');
    edit('const r5 = 5000;', 'const r5 = 5001;');
    await expect(content).toContainText('const r5 = 5001;', { timeout: 10000 });
    await expect(box).toHaveValue('Keep this');
    await expect(box).toBeFocused();
    await win.keyboard.type(' text');
    // ⌘Enter saves; the keyboard is back in the review (j/k/n/p work at once).
    await win.keyboard.press('Meta+Enter');
    await expect(view.locator('.lc-box')).toHaveCount(0);
    await expect(view.locator('.rv-scroll')).toBeFocused();
    const card = view.locator('.lc-card');
    await expect(card.locator('.lc-text')).toHaveText('Keep this text');

    // A card in Edit mode: same.
    await card.getByRole('button', { name: 'Edit' }).click();
    const cardInput = card.locator('textarea');
    await expect(cardInput).toBeFocused();
    await win.keyboard.type(' too');
    edit('const r11 = 110;', 'const r11 = 1100;');
    await expect(content).toContainText('const r11 = 1100;', { timeout: 10000 });
    await expect(cardInput).toHaveValue('Keep this text too');
    await look(win, `${SHOTS}/comments-edit-kept.png`, { animations: 'disabled' });
    await win.keyboard.press('Escape');
    await expect(cardInput).toHaveCount(0);
    await expect(card.locator('.lc-text')).toHaveText('Keep this text');
    await expect(view.locator('.rv-scroll')).toBeFocused();

    // The normal editor: the box keeps its text across a disk change; ⌘Enter gives the editor the keyboard back.
    await view.locator('.rv-open').click();
    const editor = win.locator('.file-view:visible');
    await editor.locator('.cm-line', { hasText: 'const r8 = 80;' }).click();
    await win.keyboard.press('Shift+ArrowDown');
    await menu(app, 'CmdOrCtrl+Alt+C');
    const ebox = editor.locator('.lc-box textarea');
    await expect(ebox).toBeFocused();
    await win.keyboard.type('Editor note');
    edit('const r12 = 120;', 'const r12 = 1200;');
    await expect(editor.locator('.cm-content')).toContainText('const r12 = 1200;', { timeout: 10000 });
    await expect(ebox).toHaveValue('Editor note');
    await win.keyboard.press('Meta+Enter');
    await expect(editor.locator('.lc-box')).toHaveCount(0);
    await expect(editor.locator('.cm-content')).toBeFocused();
    // Its card in Edit mode while the commented line changes (the card is drawn again, now Outdated): the text stays.
    const ecard = editor.locator('.lc-card', { has: win.locator('.lc-lines', { hasText: 'Lines 8–9' }) });
    await expect(ecard.locator('.lc-text')).toHaveText('Editor note');
    await ecard.getByRole('button', { name: 'Edit' }).click();
    await win.keyboard.type(' edited');
    edit('const r9 = 90;', 'const r9 = 99;');
    await expect(ecard.locator('.lc-outdated')).toHaveText('Outdated', { timeout: 10000 });
    await expect(ecard.locator('textarea')).toHaveValue('Editor note edited');
    await expect(ecard.locator('textarea')).toBeFocused();
    await win.keyboard.press('Escape');
    await expect(ecard.locator('textarea')).toHaveCount(0);
    await expect(editor.locator('.cm-content')).toBeFocused();

    // The editor's diff mode is built again on every change of the file: the box keeps its text there too.
    await win.locator('.changes .change-row', { hasText: 'rate.ts' }).click();
    const diffView = win.locator('.file-view:visible');
    await expect(diffView.locator('.cm-diff-add').first()).toBeVisible({ timeout: 10000 });
    await diffView.locator('.cm-line', { hasText: 'const r2 = 20;' }).click();
    await win.keyboard.press('Shift+ArrowDown');
    await menu(app, 'CmdOrCtrl+Alt+C');
    const dbox = diffView.locator('.lc-box textarea');
    await expect(dbox).toBeFocused();
    await win.keyboard.type('Diff note');
    edit('const r1 = 10;', 'const r1 = 11;');
    await expect(diffView.locator('.cm-content')).toContainText('const r1 = 11;', { timeout: 10000 });
    await expect(dbox).toHaveValue('Diff note');
    await expect(dbox).toBeFocused();
    await win.keyboard.press('Escape');
    await expect(diffView.locator('.lc-box')).toHaveCount(0);
    await expect(diffView.locator('.cm-content')).toBeFocused();
  } finally {
    await stop(app, home);
  }
});

