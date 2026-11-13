// Source Control's All Repositories view: the
// switch in the sidebar head, one block per working tree in a fixed order, and nothing moving while ops run. Remotes
// are bare repositories in the run's temp root; every clone has its own identity (no user config).
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { e2eEnv } from './env';
import { commit, git } from '../support/git-fixture';
import { look } from './shots';

const SHOTS = 'test-results';

async function menu(app: ElectronApplication, label: string) {
  await app.evaluate(({ Menu, BrowserWindow }, l) => {
    const walk = (items: Electron.MenuItem[]): Electron.MenuItem | undefined => {
      for (const it of items) { if (it.label === l) return it; const sub = it.submenu ? walk(it.submenu.items) : undefined; if (sub) return sub; }
      return undefined;
    };
    walk(Menu.getApplicationMenu()!.items)?.click(undefined, BrowserWindow.getAllWindows()[0]);
  }, label);
}

/**
 * A project folder with four repositories cloned from bare remotes: api (a staged file, a linked worktree x),
 * billing and web (one commit behind each), docs (clean).
 */
function project(): { root: string; other: (name: string) => string } {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'atl-scm-all-')));
  const root = join(base, 'proj');
  mkdirSync(root);
  const clone = (name: string, into: string) => {
    git(base, 'clone', '-q', join(base, `${name}.git`), into);
    git(into, 'config', 'user.name', 'Ada');
    git(into, 'config', 'user.email', 'ada@example.com');
    git(into, 'config', 'commit.gpgsign', 'false');
  };
  for (const name of ['api', 'billing', 'docs', 'web']) {
    const seed = join(base, `seed-${name}`);
    mkdirSync(seed);
    git(seed, 'init', '-q', '-b', 'main');
    commit(seed, 'feat: first', { 'a.txt': 'a\n' });
    git(base, 'clone', '-q', '--bare', seed, `${name}.git`);
    clone(name, join(root, name));
  }
  for (const name of ['billing', 'web']) {
    const other = join(base, `other-${name}`);
    clone(name, other);
    commit(other, 'feat: pushed meanwhile', { 'b.txt': 'b\n' });
    git(other, 'push', '-q', 'origin', 'main');
  }
  writeFileSync(join(root, 'api', 'staged.txt'), 'staged\n');
  git(join(root, 'api'), 'add', 'staged.txt');
  // As in a real project: the worktrees' folder is ignored, not a change of api's.
  writeFileSync(join(root, 'api', '.git', 'info', 'exclude'), '.claude/\n');
  git(join(root, 'api'), 'worktree', 'add', '-q', '-b', 'worktree-x', join(root, 'api', '.claude', 'worktrees', 'x'));
  return { root, other: (name) => join(base, `other-${name}`) };
}

async function launch(root: string, made = e2eEnv()): Promise<{ app: ElectronApplication; win: Page; stop: () => Promise<void>; made: ReturnType<typeof e2eEnv> }> {
  const app = await electron.launch({ args: ['out/main/index.js', `--project=${root}`], env: made.env });
  const win = await app.firstWindow();
  const stop = async () => {
    await app.close();
    try { process.kill((JSON.parse(readFileSync(join(made.home, 'atelierd.json'), 'utf8')) as { pid: number }).pid, 'SIGTERM'); } catch { /* already stopped */ }
  };
  await expect(win.locator('.activity-bar')).toBeVisible({ timeout: 15000 });
  await menu(app, 'Source Control');
  await expect(win.getByRole('radiogroup', { name: 'Source Control view' })).toBeVisible({ timeout: 15000 });
  return { app, win, stop, made };
}

const names = (win: Page) => win.locator('.scm-all-list > [role="listitem"]').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')));
/** Every block's top and height, rounded: what must not change while ops run. */
const boxes = (win: Page) => win.locator('.scm-all-list > [role="listitem"]').evaluateAll((els) => els.map((e) => { const r = e.getBoundingClientRect(); return [Math.round(r.top), Math.round(r.height)]; }));
const block = (win: Page, name: string) => win.getByRole('listitem', { name, exact: true });

test('All Repositories: the switch, the blocks in their order with their marks and button, folds, and the choice after a relaunch', async () => {
  const p = project();
  let s = await launch(p.root);
  try {
    // One is today's view: the switcher's card.
    await expect(s.win.locator('.scm-sidebar .sw-card')).toBeVisible();
    await s.win.getByRole('radio', { name: 'All Repositories' }).click();
    await expect(s.win.getByRole('radio', { name: 'All Repositories' })).toHaveAttribute('aria-checked', 'true');
    await expect.poll(() => names(s.win), { timeout: 15000 }).toEqual(['api', 'x', 'billing', 'docs', 'web']);
    // ↻ (Fetch All) brings the remote commits in, if Changes' view fetch at launch hasn't
    // already: this view itself never fetches.
    await s.win.getByRole('button', { name: 'Fetch All Repositories' }).click();
    const api = block(s.win, 'api');
    await expect(api.locator('.sw-chip.is-changes')).toHaveText('1');
    await expect(api.locator('.ab-main')).toHaveText('Commit 1 file');
    // Only commits to pull: the button says Pull and carries ↓1 (once: not on the header too).
    await expect(block(s.win, 'billing').locator('.ab-main .ab-counts')).toHaveText('↓1', { timeout: 15000 });
    await expect(block(s.win, 'billing').locator('.ab-main .ab-label')).toHaveText('Pull');
    await expect(block(s.win, 'billing').locator('.ab-head .ab-counts')).toHaveCount(0);
    // Folded, the button is gone: the counts are on the header.
    await block(s.win, 'billing').getByRole('button', { name: 'Fold billing' }).click();
    await expect(block(s.win, 'billing').locator('.ab-head .ab-counts')).toHaveText('↓1');
    await block(s.win, 'billing').getByRole('button', { name: 'Unfold billing' }).click();
    // Sync All with only pulls to make: Pull All.
    await expect(s.win.locator('.scm-all-sync .git-sync-main')).toContainText('Pull All');
    await expect(block(s.win, 'docs').locator('.sw-chip.is-clean')).toBeVisible();
    await expect(block(s.win, 'docs').locator('.ab-main')).toHaveAttribute('aria-disabled', 'true');
    // The worktree starts folded: header only.
    await expect(block(s.win, 'x').locator('.ab-body')).toHaveCount(0);
    await expect(block(s.win, 'x').locator('.ab-wt')).toHaveCount(1);
    // The branch gives way first: a short name is never cut while its branch still has room to give.
    for (const name of ['api', 'x', 'billing']) expect(await block(s.win, name).locator('.ab-name').evaluate((e) => e.scrollWidth <= e.clientWidth)).toBe(true);
    await look(s.win.locator('.scm-sidebar'), `${SHOTS}/scm-all.png`, { settle: 300 });

    // Fold docs by hand, unfold the worktree: both remembered, with the view, after a relaunch.
    await block(s.win, 'docs').getByRole('button', { name: 'Fold docs' }).click();
    await block(s.win, 'x').getByRole('button', { name: 'Unfold x' }).click();
    await expect(block(s.win, 'docs').locator('.ab-body')).toHaveCount(0);
    await expect(block(s.win, 'x').locator('.ab-body')).toHaveCount(1);
    const made = s.made;
    await s.app.close();
    s = await launch(p.root, made);
    await expect.poll(() => names(s.win), { timeout: 15000 }).toEqual(['api', 'x', 'billing', 'docs', 'web']);
    await expect(block(s.win, 'docs').locator('.ab-body')).toHaveCount(0);
    await expect(block(s.win, 'x').locator('.ab-body')).toHaveCount(1);

    // The name opens that repository in the One view.
    await block(s.win, 'billing').getByRole('button', { name: 'billing', exact: true }).click();
    await expect(s.win.getByRole('radio', { name: 'One Repository' })).toHaveAttribute('aria-checked', 'true');
    await expect(s.win.locator('.scm-sidebar .sw-card')).toContainText('billing');
  } finally {
    await s.stop();
  }
});

test('Pull on one block, Sync on another right after: both run on their own, no block moves, both end in sync', async () => {
  const p = project();
  // Git as slow as on a busy PC: the running state lasts long enough to be seen and measured.
  const s = await launch(p.root, e2eEnv({ ATELIER_TEST_GIT_WRITE_DELAY_MS: '1200' }));
  try {
    await s.win.getByRole('radio', { name: 'All Repositories' }).click();
    await s.win.getByRole('button', { name: 'Fetch All Repositories' }).click();
    await expect(block(s.win, 'billing').locator('.ab-counts')).toHaveText('↓1', { timeout: 15000 });
    await expect(block(s.win, 'web').locator('.ab-counts')).toHaveText('↓1', { timeout: 15000 });
    const before = await boxes(s.win);

    await block(s.win, 'billing').locator('.ab-head').hover();
    await block(s.win, 'billing').getByRole('button', { name: 'Pull', exact: true }).click();
    await block(s.win, 'web').locator('.ab-main').click();
    await expect(block(s.win, 'billing').locator('.ab-btn')).toHaveClass(/is-running/);
    await expect(block(s.win, 'web').locator('.ab-btn')).toHaveClass(/is-running/);
    expect(await boxes(s.win)).toEqual(before);
    await look(s.win.locator('.scm-sidebar'), `${SHOTS}/scm-all-running.png`);

    for (const name of ['billing', 'web']) {
      await expect(block(s.win, name).locator('.sw-chip.is-clean')).toBeVisible({ timeout: 20000 });
      await expect(block(s.win, name).locator('.ab-btn')).not.toHaveClass(/is-running/);
    }
    expect(await boxes(s.win)).toEqual(before);
    for (const name of ['billing', 'web']) expect(git(join(p.root, name), 'log', '-1', '--format=%s').trim()).toBe('feat: pushed meanwhile');
  } finally {
    // A write still running would ask before quitting: let it end, so a failure above reports itself.
    await expect(s.win.locator('.ab-btn.is-running')).toHaveCount(0, { timeout: 20000 }).catch(() => {});
    await s.stop();
  }
});

test('Pull All: the repositories pull at the same time; one that can\'t stops nothing, and Show lists it', async () => {
  const p = project();
  // billing has a file of its own where the incoming commit adds one: git refuses that pull, web's still goes through.
  writeFileSync(join(p.root, 'billing', 'b.txt'), 'mine\n');
  // Git as slow as on a busy PC: both pulls are seen running together.
  const s = await launch(p.root, e2eEnv({ ATELIER_TEST_GIT_WRITE_DELAY_MS: '1500' }));
  try {
    await s.win.getByRole('radio', { name: 'All Repositories' }).click();
    await s.win.getByRole('button', { name: 'Fetch All Repositories' }).click();
    await expect(block(s.win, 'billing').locator('.ab-head .ab-counts, .ab-main .ab-counts')).toHaveText('↓1', { timeout: 15000 });
    await expect(block(s.win, 'web').locator('.ab-main .ab-counts')).toHaveText('↓1', { timeout: 15000 });
    const main = s.win.locator('.scm-all-sync .git-sync-main');
    await expect(main).toContainText('Pull All');
    await main.click();

    // Both at the same moment, not one after the other.
    await expect(s.win.locator('.ab-btn.is-running')).toHaveCount(2);
    await expect(block(s.win, 'billing').locator('.ab-btn')).toHaveClass(/is-running/);
    await expect(block(s.win, 'web').locator('.ab-btn')).toHaveClass(/is-running/);

    const toast = s.win.locator('.toast');
    await expect(toast).toContainText('Pulled 1 repository · 1 needs you', { timeout: 20000 });
    await expect(block(s.win, 'web').locator('.sw-chip.is-clean')).toBeVisible({ timeout: 15000 });
    expect(git(join(p.root, 'web'), 'log', '-1', '--format=%s').trim()).toBe('feat: pushed meanwhile');
    expect(git(join(p.root, 'billing'), 'log', '-1', '--format=%s').trim()).toBe('feat: first');
    expect(readFileSync(join(p.root, 'billing', 'b.txt'), 'utf8')).toBe('mine\n');

    await toast.getByRole('button', { name: 'Show' }).click();
    const sheet = s.win.getByRole('dialog', { name: 'Pull All Repositories' });
    await expect(sheet).toBeVisible();
    await expect(sheet.locator('.git-sheet-body')).toHaveText('1 pulled · 1 needs you');
    await expect(sheet.locator('.git-sheet-row')).toHaveCount(2);
    await expect(sheet.locator('.git-sheet-row.is-needs')).toContainText('billing');
    await expect(sheet.locator('.git-sheet-row.is-ok')).toContainText('web');
    await expect(sheet.locator('.git-sheet-row.is-ok')).toContainText('Pulled');
    await look(sheet, `${SHOTS}/scm-all-pull-all.png`, { settle: 300 });

    // Show selects billing in Source Control, where its own Pull says what to do.
    await sheet.locator('.git-sheet-row.is-needs').getByRole('button', { name: 'Show' }).click();
    await expect(sheet).toHaveCount(0);
    await expect(s.win.getByRole('radio', { name: 'One Repository' })).toHaveAttribute('aria-checked', 'true');
    await expect(s.win.locator('.scm-sidebar .sw-card')).toContainText('billing');
  } finally {
    await expect(s.win.locator('.ab-btn.is-running')).toHaveCount(0, { timeout: 20000 }).catch(() => {});
    await s.stop();
  }
});

test('commit from a block with ⌘↵; nothing staged asks over the block, which keeps its height; Cancel keeps the message', async () => {
  const p = project();
  const s = await launch(p.root);
  try {
    await s.win.getByRole('radio', { name: 'All Repositories' }).click();
    const api = block(s.win, 'api');
    const field = api.getByRole('textbox', { name: 'Commit message for api' });
    await field.fill('feat: staged from the block');
    await field.press('ControlOrMeta+Enter');
    await expect.poll(() => git(join(p.root, 'api'), 'log', '-1', '--format=%s').trim(), { timeout: 15000 }).toBe('feat: staged from the block');
    await expect(field).toHaveValue('');
    await expect(api.locator('.ab-main .ab-counts')).toHaveText('↑1', { timeout: 15000 });
    await expect(api.locator('.ab-main .ab-label')).toHaveText('Push');

    // A change nobody staged in docs, made while its message is being typed: the status that comes keeps the text.
    const docs = block(s.win, 'docs');
    const docsField = docs.getByRole('textbox', { name: 'Commit message for docs' });
    await docsField.fill('docs: notes');
    writeFileSync(join(p.root, 'docs', 'notes.md'), 'notes\n');
    await expect(docs.locator('.sw-chip.is-changes')).toHaveText('1', { timeout: 15000 });
    await expect(docsField).toHaveValue('docs: notes');
    // Commit (the setting asks by default) asks over the block.
    const before = await boxes(s.win);
    await docs.locator('.ab-main').click();
    const ask = docs.getByRole('alertdialog');
    await expect(ask).toBeVisible();
    expect(await boxes(s.win)).toEqual(before);
    await look(s.win.locator('.scm-sidebar'), `${SHOTS}/scm-all-ask.png`, { settle: 300 });
    await ask.getByRole('button', { name: 'Cancel' }).click();
    await expect(ask).toHaveCount(0);
    await expect(docsField).toBeFocused();
    await expect(docsField).toHaveValue('docs: notes');
    // Asked again: a click anywhere else closes it too.
    await docs.locator('.ab-main').click();
    await expect(ask).toBeVisible();
    await s.win.locator('.scm-sidebar .sidebar-head .section-label').click();
    await expect(ask).toHaveCount(0);
    expect(git(join(p.root, 'docs'), 'log', '-1', '--format=%s').trim()).toBe('feat: first');
  } finally {
    await s.stop();
  }
});

/** What spills: a head, button, field or bar whose content is wider than it, or a child drawn outside it. */
const spills = (win: Page) => win.evaluate(() => {
  const bad: string[] = [];
  // The head's label: shown whole, or not at all (never "SOURCE CONTR…").
  const label = document.querySelector<HTMLElement>('.scm-sidebar .sidebar-head .section-label');
  if (label && label.offsetParent && label.scrollWidth > label.clientWidth + 1) bad.push('section-label cut');
  for (const el of document.querySelectorAll<HTMLElement>('.scm-sidebar .sidebar-head, .scm-all-sync, .ab-head, .ab-field, .ab-btn, .ab-ask')) {
    const box = el.getBoundingClientRect();
    if (el.scrollWidth > el.clientWidth + 1) bad.push(`${el.className}: content ${el.scrollWidth} > ${el.clientWidth}`);
    if (el.classList.contains('ab-head') && box.height > 35) bad.push(`ab-head: ${Math.round(box.height)}px tall`);
    for (const c of el.querySelectorAll<HTMLElement>('*')) {
      const r = c.getBoundingClientRect();
      if (r.width && getComputedStyle(c).visibility !== 'hidden' && (r.right > box.right + 1 || r.left < box.left - 1)) { bad.push(`${el.className} > ${c.className || c.tagName}: outside`); break; }
    }
  }
  return bad;
});
/** The question's two buttons: on one row (same top), or one above the other with the same edges. */
const askAligned = (win: Page) => win.evaluate(() => {
  const [a, b] = [...document.querySelectorAll<HTMLElement>('.ab-ask .git-ask-actions > button')].map((e) => e.getBoundingClientRect());
  if (!a || !b) return 'no buttons';
  const row = Math.abs(a.top - b.top) < 1;
  const column = Math.abs(a.left - b.left) < 1 && Math.abs(a.right - b.right) < 1;
  return row || column ? 'ok' : `misaligned: (${Math.round(a.left)},${Math.round(a.top)})-(${Math.round(a.right)}) vs (${Math.round(b.left)},${Math.round(b.top)})-(${Math.round(b.right)})`;
});

test('every sidebar width, 200 to 480 px: nothing spills or wraps, and the question\'s buttons line up', async () => {
  const p = project();
  writeFileSync(join(p.root, 'docs', 'notes.md'), 'notes\n');
  const s = await launch(p.root);
  try {
    await s.win.getByRole('radio', { name: 'All Repositories' }).click();
    await s.win.getByRole('button', { name: 'Fetch All Repositories' }).click();
    await expect(block(s.win, 'billing').locator('.ab-counts')).toHaveText('↓1', { timeout: 15000 });
    await expect(block(s.win, 'docs').locator('.sw-chip.is-changes')).toHaveText('1', { timeout: 15000 });
    const docs = block(s.win, 'docs');
    await docs.getByRole('textbox', { name: 'Commit message for docs' }).fill('docs: notes');
    for (const w of [480, 320, 264, 230, 200]) {
      await s.win.evaluate((px) => (document.querySelector('.body') as HTMLElement).style.setProperty('--sidebar-w', `${px}px`), w);
      await docs.locator('.ab-main').click();
      await expect(docs.getByRole('alertdialog')).toBeVisible();
      expect(await spills(s.win), `at ${w}px`).toEqual([]);
      expect(await askAligned(s.win), `at ${w}px`).toBe('ok');
      if (w === 264 || w === 200) await look(s.win.locator('.scm-sidebar'), `${SHOTS}/scm-all-${w}.png`, { settle: 200 });
      await docs.getByRole('alertdialog').getByRole('button', { name: 'Cancel' }).click();
    }
  } finally {
    await s.stop();
  }
});

test('a long branch shows whole while the actions are hidden; under the pointer it gives way to them, and the name stays put', async () => {
  const p = project();
  git(join(p.root, 'docs'), 'checkout', '-q', '-b', 'feature/the-whole-branch-name');
  const s = await launch(p.root);
  try {
    await s.win.getByRole('radio', { name: 'All Repositories' }).click();
    await s.win.evaluate(() => (document.querySelector('.body') as HTMLElement).style.setProperty('--sidebar-w', '360px'));
    const docs = block(s.win, 'docs');
    const branch = docs.locator('.ab-branch-name');
    await expect(branch).toHaveText('feature/the-whole-branch-name', { timeout: 15000 });
    // The pointer elsewhere: the marks take only their own room, the branch everything up to them.
    await s.win.locator('.scm-sidebar .sidebar-head .section-label').hover();
    await expect(docs.locator('.ab-acts')).toHaveCSS('opacity', '0');
    expect(await branch.evaluate((e) => e.scrollWidth <= e.clientWidth)).toBe(true);
    const name = await docs.locator('.ab-name').boundingBox();
    await look(s.win.locator('.scm-sidebar'), `${SHOTS}/scm-all-branch.png`, { settle: 200 });

    // Under the pointer: the actions in the marks' place, the branch cut short of them, the name where it was.
    await docs.locator('.ab-head').hover();
    await expect(docs.locator('.ab-acts')).toHaveCSS('opacity', '1');
    const [b, acts] = await Promise.all([docs.locator('.ab-branch').boundingBox(), docs.locator('.ab-acts').boundingBox()]);
    expect(b!.x + b!.width).toBeLessThanOrEqual(acts!.x);
    expect(await docs.locator('.ab-name').boundingBox()).toEqual(name);
    await look(s.win.locator('.scm-sidebar'), `${SHOTS}/scm-all-branch-hover.png`, { settle: 200 });
  } finally {
    await s.stop();
  }
});
