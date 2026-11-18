// Source Control's All Repositories view: the
// switch in the sidebar head, one block per working tree in a fixed order, and nothing moving while ops run. Remotes
// are bare repositories in the run's temp root; every clone has its own identity (no user config).
import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
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

/** `<base>/<name>.git`, a bare remote with one commit. */
function remote(base: string, name: string): void {
  const seed = join(base, `seed-${name}`);
  mkdirSync(seed);
  git(seed, 'init', '-q', '-b', 'main');
  commit(seed, 'feat: first', { 'a.txt': 'a\n' });
  git(base, 'clone', '-q', '--bare', seed, `${name}.git`);
}

/** A clone of `<base>/<name>.git` into `into`, with an identity of its own. */
function clone(base: string, name: string, into: string): void {
  git(base, 'clone', '-q', join(base, `${name}.git`), into);
  git(into, 'config', 'user.name', 'Ada');
  git(into, 'config', 'user.email', 'ada@example.com');
  git(into, 'config', 'commit.gpgsign', 'false');
}

/** A commit pushed to `<base>/<name>.git` from another clone: one more to pull everywhere else. */
function pushedMeanwhile(base: string, name: string): void {
  const other = join(base, `other-${name}`);
  clone(base, name, other);
  commit(other, 'feat: pushed meanwhile', { 'b.txt': 'b\n' });
  git(other, 'push', '-q', 'origin', 'main');
}

/**
 * A project folder with four repositories cloned from bare remotes: api (a staged file, a linked worktree x),
 * billing and web (one commit behind each), docs (clean).
 */
function project(): { root: string; other: (name: string) => string } {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'atl-scm-all-')));
  const root = join(base, 'proj');
  mkdirSync(root);
  for (const name of ['api', 'billing', 'docs', 'web']) {
    remote(base, name);
    clone(base, name, join(root, name));
  }
  for (const name of ['billing', 'web']) pushedMeanwhile(base, name);
  writeFileSync(join(root, 'api', 'staged.txt'), 'staged\n');
  git(join(root, 'api'), 'add', 'staged.txt');
  // As in a real project: the worktrees' folder is ignored, not a change of api's.
  writeFileSync(join(root, 'api', '.git', 'info', 'exclude'), '.claude/\n');
  git(join(root, 'api'), 'worktree', 'add', '-q', '-b', 'worktree-x', join(root, 'api', '.claude', 'worktrees', 'x'));
  return { root, other: (name) => join(base, `other-${name}`) };
}

/**
 * `<parent>/<name>`, a repository inside the project's `parent` (ignored there, so its header notes it as nested) with
 * every mark at once: a change, three commits to pull and two to push.
 */
function nestedEverything(root: string, parent: string, name: string): void {
  const base = dirname(root);
  const into = join(root, parent, name);
  remote(base, name);
  clone(base, name, into);
  writeFileSync(join(root, parent, '.git', 'info', 'exclude'), `${name}/\n`);
  const other = join(base, `other-${name}`);
  clone(base, name, other);
  for (const n of [1, 2, 3]) commit(other, `feat: theirs ${n}`, { [`t${n}.txt`]: `${n}\n` });
  git(other, 'push', '-q', 'origin', 'main');
  for (const n of [1, 2]) commit(into, `feat: mine ${n}`, { [`m${n}.txt`]: `${n}\n` });
  git(into, 'fetch', '-q');
  writeFileSync(join(into, 'a.txt'), 'changed\n');
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

    // billing through its header's menu, web through its button.
    await block(s.win, 'billing').getByRole('button', { name: 'Actions for billing' }).click();
    await s.win.getByRole('menuitem', { name: 'Pull', exact: true }).click();
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

/** A header's ⋯ and its count buttons: each drawn whole inside the header and at least `min` px wide. */
const headControls = (head: Locator, min: number) => head.evaluate((el, min) => {
  const box = el.getBoundingClientRect();
  return [...el.querySelectorAll<HTMLElement>('.ab-count, .ab-menu')].flatMap((c) => {
    const r = c.getBoundingClientRect();
    return r.width >= min && r.left >= box.left - 1 && r.right <= box.right + 1 ? [] : [`${c.getAttribute('aria-label')}: ${Math.round(r.left)}–${Math.round(r.right)} in ${Math.round(box.left)}–${Math.round(box.right)}`];
  });
}, min);

test('every sidebar width, 200 to 480 px: nothing spills or wraps, and the question\'s buttons line up', async () => {
  const p = project();
  writeFileSync(join(p.root, 'docs', 'notes.md'), 'notes\n');
  nestedEverything(p.root, 'web', 'guides');
  const s = await launch(p.root);
  try {
    await s.win.getByRole('radio', { name: 'All Repositories' }).click();
    await s.win.getByRole('button', { name: 'Fetch All Repositories' }).click();
    await expect(block(s.win, 'billing').locator('.ab-counts')).toHaveText('↓1', { timeout: 15000 });
    await expect(block(s.win, 'docs').locator('.sw-chip.is-changes')).toHaveText('1', { timeout: 15000 });
    // Folded, billing's header carries its count as a button.
    await block(s.win, 'billing').getByRole('button', { name: 'Fold billing' }).click();
    await expect(block(s.win, 'billing').locator('.ab-head').getByRole('button', { name: 'Pull 1 commit' })).toBeVisible();
    // The busiest header: the nested note, a change, ↓3 ↑2 and ⋯ (its button commits, so the counts are on the header).
    const guides = block(s.win, 'guides');
    await expect(guides.locator('.ab-note')).toHaveText('nested', { timeout: 15000 });
    await expect(guides.locator('.ab-head .ab-counts')).toHaveText('↓3↑2', { timeout: 15000 });
    await expect(guides.locator('.sw-chip.is-changes')).toHaveText('1');
    const docs = block(s.win, 'docs');
    await docs.getByRole('textbox', { name: 'Commit message for docs' }).fill('docs: notes');
    for (const w of [480, 320, 264, 230, 200]) {
      await s.win.evaluate((px) => (document.querySelector('.body') as HTMLElement).style.setProperty('--sidebar-w', `${px}px`), w);
      await docs.locator('.ab-main').click();
      await expect(docs.getByRole('alertdialog')).toBeVisible();
      expect(await spills(s.win), `at ${w}px`).toEqual([]);
      expect(await askAligned(s.win), `at ${w}px`).toBe('ok');
      // The counts and ⋯ never give way; the name keeps something to read.
      for (const name of ['billing', 'guides']) {
        const head = block(s.win, name).locator('.ab-head');
        expect(await headControls(head, 16), `${name} at ${w}px`).toEqual([]);
        expect(await head.locator('.ab-name').evaluate((e) => e.getBoundingClientRect().width), `${name} at ${w}px`).toBeGreaterThan(24);
      }
      if (w === 264 || w === 200) await look(s.win.locator('.scm-sidebar'), `${SHOTS}/scm-all-${w}.png`, { settle: 200 });
      await docs.getByRole('alertdialog').getByRole('button', { name: 'Cancel' }).click();
    }
  } finally {
    await s.stop();
  }
});

test('a header never changes under the pointer: the marks stay, a folded block\'s count pulls, ⋯ is always there', async () => {
  const p = project();
  git(join(p.root, 'docs'), 'checkout', '-q', '-b', 'feature/the-whole-branch-name');
  // Git as slow as on a busy PC: the pull lasts long enough for its running state to be seen.
  const s = await launch(p.root, e2eEnv({ ATELIER_TEST_GIT_WRITE_DELAY_MS: '1200' }));
  try {
    await s.win.getByRole('radio', { name: 'All Repositories' }).click();
    await s.win.evaluate(() => (document.querySelector('.body') as HTMLElement).style.setProperty('--sidebar-w', '360px'));
    await s.win.getByRole('button', { name: 'Fetch All Repositories' }).click();
    const docs = block(s.win, 'docs');
    const billing = block(s.win, 'billing');
    const branch = docs.locator('.ab-branch-name');
    await expect(branch).toHaveText('feature/the-whole-branch-name', { timeout: 15000 });
    // Folded, billing's header carries what there is to pull: the count is the button.
    await billing.getByRole('button', { name: 'Fold billing' }).click();
    const pull = billing.locator('.ab-head').getByRole('button', { name: 'Pull 1 commit' });
    await expect(pull).toHaveText('↓1', { timeout: 15000 });
    const parts = (b: typeof docs) => Promise.all(['.ab-name', '.ab-branch', '.ab-marks'].map((sel) => b.locator(sel).boundingBox()));

    // The pointer elsewhere: the branch shows whole, ⋯ is already there.
    await s.win.locator('.scm-sidebar .sidebar-head .section-label').hover();
    expect(await branch.evaluate((e) => e.scrollWidth <= e.clientWidth)).toBe(true);
    for (const b of [docs, billing]) await expect(b.locator('.ab-head').getByRole('button', { name: /^Actions for/ })).toBeVisible();
    const [docsAt, billingAt] = [await parts(docs), await parts(billing)];
    await look(s.win.locator('.scm-sidebar'), `${SHOTS}/scm-all-branch.png`, { settle: 200 });

    // Under the pointer: the marks still show, nothing moved, and no action appears that the marks don't already say.
    await docs.locator('.ab-head').hover();
    await expect(docs.locator('.ab-marks')).toBeVisible();
    expect(await parts(docs)).toEqual(docsAt);
    await expect(docs.locator('.ab-head').getByRole('button', { name: /^(Fetch|Pull|Push)/ })).toHaveCount(0);
    await billing.locator('.ab-head').hover();
    await expect(billing.locator('.ab-marks')).toBeVisible();
    expect(await parts(billing)).toEqual(billingAt);
    await look(s.win.locator('.scm-sidebar'), `${SHOTS}/scm-all-branch-hover.png`, { settle: 200 });

    // ⋯ holds Fetch, Pull and Push, once each: without an upstream (docs' branch) and with one (billing, whose
    // repository menu fetches too).
    for (const b of [docs, billing]) {
      await b.locator('.ab-menu').click();
      for (const name of ['Fetch', 'Pull', 'Push']) await expect(s.win.getByRole('menuitem', { name, exact: true })).toHaveCount(1);
      await s.win.keyboard.press('Escape');
      await expect(s.win.getByRole('menuitem')).toHaveCount(0);
    }

    // The count pulls: in sync after it, the header's parts where they were.
    await pull.click();
    // Folded, there is no button to say it runs: the count does, a spinner over it.
    await expect(billing.locator('.ab-head').getByRole('button', { name: 'Pulling…' })).toHaveAttribute('aria-busy', 'true');
    await expect(billing.locator('.ab-marks .git-spin')).toBeVisible();
    await expect(billing.locator('.sw-chip.is-clean')).toBeVisible({ timeout: 20000 });
    expect(git(join(p.root, 'billing'), 'log', '-1', '--format=%s').trim()).toBe('feat: pushed meanwhile');
    expect((await parts(billing))[0]).toEqual(billingAt[0]);
  } finally {
    // A write still running would ask before quitting: let it end, so a failure above reports itself.
    await expect(s.win.locator('.ab-marks .git-spin')).toHaveCount(0, { timeout: 20000 }).catch(() => {});
    await s.stop();
  }
});

/** Checks that let the test go on, each reported at the end. */
const soft = expect.configure({ soft: true });

/** The app's focus ring, as the box-shadow a control draws with it. */
const focusRing = (win: Page) => win.evaluate(() => {
  const probe = document.body.appendChild(document.createElement('i'));
  probe.style.boxShadow = 'var(--focus-ring)';
  const ring = getComputedStyle(probe).boxShadow;
  probe.remove();
  return ring;
});

test('a header\'s count used from the keyboard keeps the focus and its room while it runs; once it is gone, ⋯ has the focus', async () => {
  const p = project();
  // web: a file staged, so its button commits and its count sits on its header, unfolded.
  writeFileSync(join(p.root, 'web', 'c.txt'), 'c\n');
  git(join(p.root, 'web'), 'add', 'c.txt');
  // Git as slow as on a busy PC: each pull runs long enough to be looked at.
  const s = await launch(p.root, e2eEnv({ ATELIER_TEST_GIT_WRITE_DELAY_MS: '2500' }));
  try {
    await s.win.getByRole('radio', { name: 'All Repositories' }).click();
    await s.win.getByRole('button', { name: 'Fetch All Repositories' }).click();
    const billing = block(s.win, 'billing');
    await billing.getByRole('button', { name: 'Fold billing' }).click();
    const pull = billing.locator('.ab-head').getByRole('button', { name: 'Pull 1 commit' });
    await expect(pull).toHaveText('↓1', { timeout: 15000 });

    // From the keyboard the count comes right after the name; its focus ring shows under the pointer too.
    await billing.getByRole('button', { name: 'billing', exact: true }).focus();
    await s.win.keyboard.press('Tab');
    await expect(pull).toBeFocused();
    const ring = await focusRing(s.win);
    const shadow = () => pull.evaluate((e) => getComputedStyle(e).boxShadow);
    await expect.poll(shadow).toBe(ring);
    await billing.locator('.ab-name').hover();
    await soft.poll(shadow).toBe(ring);
    await pull.hover();
    await soft.poll(shadow).toBe(ring);

    // Enter pulls. Meanwhile the count stays where it was, with the focus, off and saying so, a spinner over it: the
    // marks keep their width.
    const marks = billing.locator('.ab-marks');
    const width = (await marks.boundingBox())!.width;
    await s.win.keyboard.press('Enter');
    const busy = billing.locator('.ab-head').getByRole('button', { name: 'Pulling…' });
    await expect(busy).toHaveAttribute('aria-busy', 'true');
    await expect(busy).toBeFocused();
    await expect(busy).toHaveAttribute('aria-disabled', 'true');
    await expect(marks.locator('.git-spin')).toBeVisible();
    expect((await marks.boundingBox())!.width).toBe(width);
    await look(billing, `${SHOTS}/scm-all-count-busy.png`);
    // Pressed meanwhile, it doesn't darken as if it would run.
    await s.win.mouse.down();
    soft(await busy.evaluate((e) => getComputedStyle(e).filter)).toBe('none');
    await s.win.mouse.up();
    // In sync, the count is gone: ⋯, on the same header, has the focus.
    await expect(billing.locator('.sw-chip.is-clean')).toBeVisible({ timeout: 20000 });
    await expect(billing.locator('.ab-menu')).toBeFocused();

    // web pulls from its header: the button that runs carries the count from then on, so the header's goes, and ⋯ has
    // the focus.
    const web = block(s.win, 'web');
    await expect(web.locator('.ab-main')).toHaveText('Commit 1 file');
    await web.locator('.ab-head').getByRole('button', { name: 'Pull 1 commit' }).focus();
    await s.win.keyboard.press('Enter');
    await expect(web.locator('.ab-btn')).toHaveClass(/is-running/);
    await expect(web.locator('.ab-head .ab-counts')).toHaveCount(0);
    await expect(web.locator('.ab-menu')).toBeFocused();
    // ⋯ meanwhile: Pull and Push off, saying why.
    await s.win.keyboard.press('Enter');
    for (const name of ['Pull', 'Push']) {
      const item = s.win.getByRole('menuitem', { name, exact: true });
      await soft(item).toHaveAttribute('aria-disabled', 'true');
      await soft(item).toHaveAttribute('data-tip', 'Pulling…');
    }
    await s.win.keyboard.press('Escape');
  } finally {
    // A write still running would ask before quitting: let it end, so a failure above reports itself.
    await expect(s.win.locator('.ab-marks .git-spin, .ab-btn.is-running')).toHaveCount(0, { timeout: 20000 }).catch(() => {});
    await s.stop();
  }
});

test('a header\'s ↑ pushes; in Read-only the counts only say', async () => {
  const p = project();
  commit(join(p.root, 'docs'), 'docs: to push', { 'd.txt': 'd\n' });
  const s = await launch(p.root);
  try {
    await s.win.getByRole('radio', { name: 'All Repositories' }).click();
    await s.win.getByRole('button', { name: 'Fetch All Repositories' }).click();
    const docs = block(s.win, 'docs');
    await docs.getByRole('button', { name: 'Fold docs' }).click();
    const push = docs.locator('.ab-head').getByRole('button', { name: 'Push 1 commit' });
    await expect(push).toHaveText('↑1', { timeout: 15000 });
    await push.click();
    await expect(docs.locator('.sw-chip.is-clean')).toBeVisible({ timeout: 20000 });
    expect(git(join(dirname(p.root), 'docs.git'), 'log', '-1', '--format=%s').trim()).toBe('docs: to push');

    // Read-only: the same counts, saying only.
    await s.win.evaluate(() => (window as unknown as { atelier: { settings: { set(p: object): Promise<unknown> } } }).atelier.settings.set({ gitActions: 'read-only' }));
    const billing = block(s.win, 'billing');
    await expect(billing).toHaveClass(/is-ro/);
    await expect(billing.locator('.ab-head .ab-counts')).toHaveText('↓1');
    await expect(billing.locator('.ab-head .ab-counts').getByLabel('1 to pull')).toBeVisible();
    await expect(billing.locator('.ab-head button.ab-count')).toHaveCount(0);
  } finally {
    await s.stop();
  }
});
