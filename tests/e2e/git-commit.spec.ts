import { expect, test, type Locator, type Page } from '@playwright/test';
import { join } from 'node:path';
import { git, gitWritesProject, hookMarker, launchGitApp, write, type GitAppEnv } from './git-writes-fixture';
import { look } from './shots';

// The commit bar and drawer: the bar's states, opening by click, ⌥⌘K and the handle, closing by
// Esc (the draft kept), the chevron and the handle; the checkbox column with it; ⌘↵ commits and the drawer moves to
// the next repository with staged files; the last commit closes it and toasts with Push and Undo; 304 and 240 px.

const NAMES = ['acme-store', 'billing', 'plugins/payments'];

/** Three repositories with changed files; a session "auth-refactor" that edited acme-store's cart.ts (`session`). */
async function scene(session = true) {
  const p = gitWritesProject(NAMES, { 'src/cart.ts': 'cart 1\n', 'src/totals.ts': 'totals 1\n', 'src/invoice.ts': 'invoice 1\n', 'src/pay.ts': 'pay 1\n' });
  const cart = join(p.repo('acme-store'), 'src/cart.ts');
  const s = await launchGitApp(p.root, cart);
  await expect(s.panel).toContainText('All clean · 3 repos', { timeout: 10000 });
  write(cart, 'cart 2\n');
  write(join(p.repo('acme-store'), 'src/totals.ts'), 'totals 2\n');
  write(join(p.repo('billing'), 'src/invoice.ts'), 'invoice 2\n');
  write(join(p.repo('plugins/payments'), 'src/pay.ts'), 'pay 2\n');
  await expect(s.panel.locator('.change-row')).toHaveCount(4, { timeout: 8000 });
  const row = (name: string) => s.panel.locator('.change-row', { hasText: name });
  if (session) {
    await s.win.locator('.btn-new').click();
    await s.win.getByRole('menuitem', { name: 'Claude Session' }).click();
    await s.win.getByPlaceholder('Session name (optional)').fill('auth-refactor');
    await s.win.keyboard.press('Enter');
    await expect(row('cart.ts').locator('.dot:not(.unknown)')).toHaveCount(1, { timeout: 15000 });
  }
  return {
    ...p, ...s, row,
    bar: s.panel.locator('.git-bar'),
    drawer: s.panel.locator('.git-drawer'),
    field: s.panel.getByRole('textbox', { name: 'Commit message' })
  };
}

/** Drags the bar's or the drawer's handle by `dy` pixels (up is negative). */
/** Once the element's entrance (and anything else finite) is over: measured while it rises, a box is off. */
const settled = (l: Locator) => l.evaluate((el) => Promise.all(el.getAnimations({ subtree: true }).filter((a) => a.effect?.getTiming().iterations !== Infinity).map((a) => a.finished)));

async function dragHandle(win: Page, handle: Locator, dy: number) {
  const box = (await handle.boundingBox())!;
  const x = box.x + box.width / 2; const y = box.y + box.height / 2;
  await win.mouse.move(x, y);
  await win.mouse.down();
  await win.mouse.move(x, y + dy / 2, { steps: 4 });
  await win.mouse.move(x, y + dy, { steps: 4 });
  await win.mouse.up();
}

const log = (cwd: string) => git(cwd, 'log', '-1', '--format=%B').trim();

test('the bar by state, opening by click, ⌥⌘K and the handle; Esc keeps the draft; the column comes with it', async () => {
  // No session: nothing here depends on who wrote the files.
  const s = await scene(false);
  try {
    await expect(s.bar).toHaveText('Commit · nothing staged');
    // The bar is part of the column: the rows end above it.
    const [body, bar] = await Promise.all([s.panel.locator('.changes-body').boundingBox(), s.bar.boundingBox()]);
    expect(body!.y + body!.height).toBeLessThanOrEqual(bar!.y + 0.5);
    expect(bar!.height).toBe(44);

    git(s.repo('acme-store'), 'add', 'src/cart.ts', 'src/totals.ts');
    await expect(s.bar).toHaveText('Commit2in acme-store', { timeout: 8000 });
    git(s.repo('billing'), 'add', 'src/invoice.ts');
    git(s.repo('plugins/payments'), 'add', 'src/pay.ts');
    await expect(s.bar).toHaveText('Commit4in 3 repositories', { timeout: 8000 });
    // Staging from a terminal never opens it.
    await expect(s.drawer).toHaveCount(0);
    await expect(s.panel.locator('.git-check')).toHaveCount(0);

    // Click: the drawer on the repository with the most staged files, the field focused, the checkboxes in.
    await s.bar.locator('.git-bar-main').click();
    await expect(s.drawer).toBeVisible();
    await expect(s.drawer.locator('.git-chip')).toHaveText(/acme-store\s*main/);
    await expect(s.panel.locator('.git-check').first()).toBeVisible();
    await expect(s.field).toBeFocused();
    await s.field.fill('fix(cart): totals round half up');
    await expect(s.drawer.locator('.git-msg-count')).toHaveText('31 / 72');

    // Esc closes it; the draft stays and the bar shows it.
    await s.win.keyboard.press('Escape');
    await expect(s.drawer).toHaveCount(0);
    await expect(s.panel.locator('.git-check')).toHaveCount(0);
    await expect(s.bar.locator('.git-bar-draft')).toHaveText('fix(cart): totals round half up');
    await expect(s.bar.locator('.git-bar-count')).toHaveText('2');

    // ⌥⌘K (Git › Commit…): open again, the draft back in the field.
    await s.command('git-commit');
    await expect(s.drawer).toBeVisible();
    await expect(s.field).toHaveValue('fix(cart): totals round half up');
    // The chevron closes it.
    await s.drawer.getByRole('button', { name: 'Close' }).click();
    await expect(s.drawer).toHaveCount(0);

    // The handle: a short drag does nothing, up opens, down closes.
    await dragHandle(s.win, s.bar.locator('.git-handle'), -10);
    await expect(s.drawer).toHaveCount(0);
    await dragHandle(s.win, s.bar.locator('.git-handle'), -60);
    await expect(s.drawer).toBeVisible();
    await settled(s.drawer);
    // Dragged taller: up to 60% of the panel, remembered.
    const natural = (await s.drawer.boundingBox())!.height;
    const panel = (await s.panel.boundingBox())!;
    const panelH = panel.height;
    // Up to the panel's top (past 60% of it), inside the window.
    const top = (await s.drawer.locator('.git-handle').boundingBox())!;
    await dragHandle(s.win, s.drawer.locator('.git-handle'), panel.y + 10 - (top.y + top.height / 2));
    await settled(s.drawer);
    const tall = (await s.drawer.boundingBox())!.height;
    expect(tall).toBeGreaterThan(natural + 40);
    expect(tall).toBeLessThanOrEqual(Math.ceil(panelH * 0.6) + 1);
    // The message field takes the room.
    expect((await s.field.boundingBox())!.height).toBeGreaterThan(80);
    const handle = (await s.drawer.locator('.git-handle').boundingBox())!;
    await dragHandle(s.win, s.drawer.locator('.git-handle'), panel.y + panelH - 5 - (handle.y + handle.height / 2));
    await expect(s.drawer).toHaveCount(0);
    await s.command('git-commit');
    await expect.poll(async () => Math.abs((await s.drawer.boundingBox())!.height - tall)).toBeLessThan(2);
  } finally {
    await s.stop();
  }
});

test('⌘↵ commits and moves to the next repository; a checkbox elsewhere moves the target; the last commit closes and toasts', async () => {
  const s = await scene();
  try {
    git(s.repo('acme-store'), 'add', 'src/cart.ts', 'src/totals.ts');
    git(s.repo('billing'), 'add', 'src/invoice.ts');
    await expect(s.bar).toHaveText('Commit3in 2 repositories', { timeout: 8000 });
    await s.command('git-commit');
    await expect(s.drawer.locator('.git-chip')).toContainText('acme-store');
    // Nothing typed yet: Commit is disabled and says why.
    await expect(s.drawer.locator('.git-commit-main')).toHaveAttribute('data-tip', 'Write a message first');
    await expect(s.drawer.locator('.git-commit-main')).toContainText('Commit 2 files');
    // cart.ts is auth-refactor's: Co-authored-by shows, on by default.
    await expect(s.drawer.getByRole('button', { name: 'Co-authored-by Claude' })).toHaveAttribute('aria-pressed', 'true');
    await expect(s.drawer.locator('.git-others')).toHaveText(/1 staged in 1 more repo\s*Commit all…/);
    await s.field.fill('fix(cart): totals round half up\n\nThe last cent went missing.');

    // Screenshots at the default width and at the narrowest.
    await s.win.mouse.move(5, 300);
    await look(s.panel, 'test-results/git-drawer-304.png');
    const width = (px: number) => s.win.evaluate((w) => (document.querySelector('.body') as HTMLElement).style.setProperty('--changes-w', `${w}px`), px);
    await width(240);
    await expect(s.drawer.locator('.git-chip-branch')).toBeHidden();
    await expect(s.drawer.locator('.git-commit-short')).toHaveText('Commit 2');
    await expect(s.drawer.locator('.git-toggle.is-on .git-toggle-short')).toBeVisible();
    await expect(s.drawer.locator('.git-toggle.is-on .git-toggle-short')).toHaveText('Co-author');
    await expect(s.drawer.locator('.git-toggle.is-on .git-toggle-full')).toBeHidden();
    await expect(s.drawer.locator('.git-commit-full')).toBeHidden();
    await look(s.panel, 'test-results/git-drawer-240.png');
    await width(304);

    // ⌘↵: committed with the trailer; the drawer moves to billing with an empty field and the result notice.
    await s.field.press('Meta+Enter');
    await expect(s.drawer.locator('.git-chip')).toContainText('billing', { timeout: 15000 });
    expect(log(s.repo('acme-store'))).toBe('fix(cart): totals round half up\n\nThe last cent went missing.\n\nCo-Authored-By: Claude <noreply@anthropic.com>');
    const sha = git(s.repo('acme-store'), 'rev-parse', '--short=7', 'HEAD').trim();
    await expect(s.drawer.locator('.git-notice.is-result')).toHaveText(new RegExp(`${sha} in acme-store\\s*Undo`));
    await expect(s.field).toHaveValue('');
    await expect(s.drawer.getByRole('button', { name: 'Co-authored-by Claude' })).toHaveCount(0);

    // Staging in another repository through its checkbox moves the target there.
    await s.panel.getByRole('checkbox', { name: 'Stage payments' }).click();
    await expect(s.drawer.locator('.git-chip')).toContainText('payments', { timeout: 8000 });
    await expect(s.drawer.locator('.git-commit-main')).toContainText('Commit 1 file', { timeout: 8000 });
    await s.field.fill('feat(pay): pay 2');
    await s.win.keyboard.press('Meta+Enter');
    await expect(s.drawer.locator('.git-chip')).toContainText('billing', { timeout: 15000 });
    expect(log(s.repo('plugins/payments'))).toBe('feat(pay): pay 2');

    // The last one: the drawer closes and a toast offers Push and Undo.
    await s.field.fill('fix(invoice): invoice 2');
    await s.win.keyboard.press('Meta+Enter');
    await expect(s.drawer).toHaveCount(0, { timeout: 15000 });
    const billingSha = git(s.repo('billing'), 'rev-parse', '--short=7', 'HEAD').trim();
    const toast = s.win.locator('.toast');
    await expect(toast).toContainText(`Committed ${billingSha} to billing`);
    await expect(toast.locator('.toast-action')).toHaveText(['Push', 'Undo']);
    await expect(s.bar).toHaveText('Commit · nothing staged', { timeout: 8000 });
    expect(git(s.repo('billing'), 'status', '--porcelain').trim()).toBe('');
  } finally {
    await s.stop();
  }
});

/** A project without sessions: `names` repositories (a hook, a bare remote on request), the app on it. */
async function plain(names: string[], o: { hook?: boolean; remote?: boolean } = {}, reuse?: { root: string; appEnv: GitAppEnv }) {
  const p = reuse ? null : gitWritesProject(names, { 'src/cart.ts': 'cart 1\n', 'src/totals.ts': 'totals 1\n', 'README.md': '# repo\n' }, o);
  const root = reuse?.root ?? p!.root;
  const s = await launchGitApp(root, undefined, reuse?.appEnv);
  const repo = (name: string) => join(root, name);
  return {
    ...s, root, repo, remote: p?.remote,
    bar: s.panel.locator('.git-bar'),
    drawer: s.panel.locator('.git-drawer'),
    field: s.panel.getByRole('textbox', { name: 'Commit message' }),
    picker: s.win.locator('.git-picker'),
    chip: s.panel.locator('.git-chip')
  };
}

const PICKER_REPOS = ['acme-store', 'billing', 'docs', 'infra', 'plugins/payments', 'web'];

test('the repository picker: groups, the filter from 6 repositories, keys, the draft dot; drafts survive a relaunch', async () => {
  let s = await plain(PICKER_REPOS);
  try {
    await expect(s.panel).toContainText('All clean · 6 repos', { timeout: 10000 });
    write(join(s.repo('acme-store'), 'src/cart.ts'), 'cart 2\n');
    write(join(s.repo('acme-store'), 'src/totals.ts'), 'totals 2\n');
    write(join(s.repo('billing'), 'src/cart.ts'), 'billing cart 2\n');
    write(join(s.repo('docs'), 'README.md'), '# docs 2\n');
    git(s.repo('acme-store'), 'add', 'src/cart.ts', 'src/totals.ts');
    git(s.repo('billing'), 'add', 'src/cart.ts');
    await expect(s.bar).toHaveText('Commit3in 2 repositories', { timeout: 8000 });

    await s.command('git-commit');
    await expect(s.chip).toContainText('acme-store');
    await s.field.fill('feat(cart): totals in cents');

    // The chip opens it upward, as wide as the panel minus 16 px.
    await s.chip.click();
    await expect(s.picker).toBeVisible();
    // Measured once its entrance (a rise) is over: under load it can still be moving.
    await settled(s.picker);
    const [pick, panel, chip] = await Promise.all([s.picker.boundingBox(), s.panel.boundingBox(), s.chip.boundingBox()]);
    expect(Math.abs(pick!.width - (panel!.width - 16))).toBeLessThan(1.5);
    expect(pick!.y + pick!.height).toBeLessThanOrEqual(chip!.y + 0.5);
    await expect(s.picker.getByRole('textbox')).toHaveAttribute('placeholder', 'Filter 6 repositories');
    await expect(s.picker.getByRole('textbox')).toBeFocused();
    await expect(s.picker.locator('.git-picker-group-label')).toHaveText(['Staged', 'Changed', 'No changes']);
    const row = (name: string) => s.picker.locator('.git-picker-row', { has: s.win.locator('.git-picker-name', { hasText: new RegExp(`^${name}$`) }) });
    await expect(s.picker.locator('.git-picker-group', { hasText: 'Staged' }).locator('.git-picker-name')).toHaveText(['acme-store', 'billing']);
    await expect(row('acme-store').locator('.git-picker-count')).toHaveText('2');
    await expect(row('acme-store').locator('.git-picker-branch')).toHaveText('main');
    await expect(row('payments').locator('.git-picker-dir')).toHaveText('plugins/');
    // The draft typed for acme-store: its pink dot; billing has none.
    await expect(row('acme-store').locator('.git-picker-draft')).toHaveCount(1);
    await expect(row('billing').locator('.git-picker-draft')).toHaveCount(0);
    await s.win.mouse.move(5, 5);
    // The rows' entrance done.
    await look(s.win, 'test-results/git-picker.png', { settle: 400 });

    // Typing filters; Enter takes the first match: billing, its (empty) draft, the field focused again.
    await s.win.keyboard.type('bil');
    await expect(s.picker.locator('.git-picker-row')).toHaveCount(1);
    await s.win.keyboard.press('Enter');
    await expect(s.picker).toHaveCount(0);
    await expect(s.chip).toContainText('billing');
    await expect(s.field).toHaveValue('');
    await expect(s.field).toBeFocused();
    await s.field.fill('fix(billing): cart 2');

    // ⌘↑ from the field opens it; ↓ ↑ move; Esc closes the picker only (the drawer stays).
    await s.field.press('Meta+ArrowUp');
    await expect(s.picker).toBeVisible();
    await expect(row('billing').locator('.git-picker-draft')).toHaveCount(1);
    await expect(row('billing')).toHaveClass(/is-cursor/);
    await s.win.keyboard.press('ArrowUp');
    await expect(row('acme-store')).toHaveClass(/is-cursor/);
    await s.win.keyboard.press('Escape');
    await expect(s.picker).toHaveCount(0);
    await expect(s.drawer).toBeVisible();
    await expect(s.chip).toContainText('billing');
    await s.field.press('Meta+ArrowUp');
    await s.win.keyboard.press('ArrowUp');
    await s.win.keyboard.press('Enter');
    await expect(s.chip).toContainText('acme-store');
    await expect(s.field).toHaveValue('feat(cart): totals in cents');
  } finally {
    await s.stop();
  }

  // A relaunch: both drafts are still there.
  s = await plain(PICKER_REPOS, {}, { root: s.root, appEnv: s.appEnv });
  try {
    await expect(s.bar.locator('.git-bar-draft')).toHaveText('feat(cart): totals in cents', { timeout: 10000 });
    await s.command('git-commit');
    await expect(s.field).toHaveValue('feat(cart): totals in cents');
    await s.chip.click();
    await expect(s.picker.locator('.git-picker-draft')).toHaveCount(2);
    await s.picker.getByRole('option', { name: /billing/ }).click();
    await expect(s.field).toHaveValue('fix(billing): cart 2');
  } finally {
    await s.stop();
  }
});

test('a failing pre-commit: on the bar, its output in the drawer; Retry; Undo Last Commit brings the files and the message back; Commit Without Hooks', async () => {
  const s = await plain(['acme-store', 'billing'], { hook: true });
  const undoEnabled = () => s.app.evaluate(({ Menu }) => Menu.getApplicationMenu()?.getMenuItemById('git-undo-commit')?.enabled ?? null);
  try {
    await expect(s.panel).toContainText('All clean · 2 repos', { timeout: 10000 });
    const acme = s.repo('acme-store');
    const start = git(acme, 'rev-parse', 'HEAD').trim();
    hookMarker(acme, 'fail', true);
    write(join(acme, 'src/cart.ts'), 'cart 2\n');
    git(acme, 'add', 'src/cart.ts');
    await expect(s.bar).toHaveText('Commit1in acme-store', { timeout: 8000 });
    expect(await undoEnabled()).toBe(false);

    await s.command('git-commit');
    await s.field.fill('fix(cart): round half up');
    // Held while the slow marker exists, so the run is caught.
    hookMarker(acme, 'slow', true);
    await s.field.press('Meta+Enter');
    // Closed while the hook runs: the bar names it, then the failure.
    await s.win.keyboard.press('Escape');
    await expect(s.bar).toContainText('Running pre-commit · acme-store', { timeout: 5000 });
    hookMarker(acme, 'slow', false);
    await expect(s.bar).toHaveText('pre-commit failed · acme-store', { timeout: 15000 });
    await expect(s.bar).toHaveClass(/is-failed/);
    expect(git(acme, 'rev-parse', 'HEAD').trim()).toBe(start);

    // The drawer: the failure and the hook's first lines; Full log shows it all in place.
    await s.bar.locator('.git-bar-main').click();
    const log = s.drawer.locator('.git-oplog');
    await expect(s.drawer.locator('.git-notice', { hasText: 'pre-commit failed · acme-store' })).toBeVisible();
    await expect(log).toContainText('lint: src/cart.ts:1 missing semicolon');
    await expect(log.getByRole('button', { name: 'Commit Without Hooks' })).toBeVisible();
    await log.getByRole('button', { name: 'Full log' }).click();
    await expect(log).toHaveClass(/is-full/);
    await expect(log).toContainText('lint: 1 problem (1 error)');
    await s.win.mouse.move(5, 5);
    await look(s.panel, 'test-results/git-hook-failed.png');
    // The bar no longer shows it once looked at.
    await s.win.keyboard.press('Escape');
    await expect(s.bar.locator('.git-bar-draft')).toHaveText('fix(cart): round half up');

    // Fixed: Retry commits with the hooks.
    hookMarker(acme, 'fail', false);
    await s.command('git-commit');
    await s.drawer.locator('.git-oplog').getByRole('button', { name: 'Retry' }).click();
    await expect(s.drawer).toHaveCount(0, { timeout: 15000 });
    expect(git(acme, 'log', '-1', '--format=%s').trim()).toBe('fix(cart): round half up');
    const sha = git(acme, 'rev-parse', '--short=7', 'HEAD').trim();
    await expect(s.win.locator('.toast')).toContainText(`Committed ${sha} to acme-store`);

    // Git › Undo Last Commit: enabled while main offers it; the file staged again, the message back as the draft.
    await expect.poll(undoEnabled, { timeout: 8000 }).toBe(true);
    await s.command('git-undo-commit');
    await expect.poll(() => git(acme, 'rev-parse', 'HEAD').trim(), { timeout: 10000 }).toBe(start);
    expect(git(acme, 'diff', '--cached', '--name-only').trim()).toBe('src/cart.ts');
    await expect(s.bar.locator('.git-bar-draft')).toHaveText('fix(cart): round half up', { timeout: 8000 });
    await expect.poll(undoEnabled, { timeout: 8000 }).toBe(false);

    // Failing again: Commit Without Hooks commits it.
    hookMarker(acme, 'fail', true);
    await s.command('git-commit');
    await expect(s.field).toHaveValue('fix(cart): round half up');
    await expect(s.drawer.locator('.git-commit-main')).toContainText('Commit 1 file', { timeout: 8000 });
    await s.field.press('Meta+Enter');
    await expect(s.drawer.locator('.git-oplog')).toContainText('missing semicolon', { timeout: 15000 });
    await s.drawer.locator('.git-oplog').getByRole('button', { name: 'Commit Without Hooks' }).click();
    await expect(s.drawer).toHaveCount(0, { timeout: 15000 });
    expect(git(acme, 'log', '-1', '--format=%s').trim()).toBe('fix(cart): round half up');
    expect(git(acme, 'status', '--porcelain').trim()).toBe('');
    await expect(s.bar).toHaveText('Commit · nothing staged', { timeout: 8000 });
  } finally {
    await s.stop();
  }
});

test("amend: HEAD's message, Amending <sha>, Amend Commit; rewording keeps the draft; Commit and Push; disabled once pushed", async () => {
  const s = await plain(['acme-store'], { remote: true });
  try {
    await expect(s.bar).toHaveText('Commit · nothing staged', { timeout: 10000 });
    const acme = s.repo('acme-store');
    write(join(acme, 'src/cart.ts'), 'cart 2\n');
    git(acme, 'add', 'src/cart.ts');
    await expect(s.bar).toHaveText('Commit1in acme-store', { timeout: 8000 });
    await s.command('git-commit');
    const amend = s.drawer.getByRole('button', { name: 'Amend', exact: true });
    // HEAD is the first commit, pushed already.
    await expect(amend).toHaveAttribute('aria-disabled', 'true');
    await expect(amend).toHaveAttribute('data-tip', 'Already pushed: amending would rewrite shared history');
    await s.field.fill('feat(cart): cart 2');
    await s.field.press('Meta+Enter');
    await expect(s.drawer).toHaveCount(0, { timeout: 15000 });
    const first = git(acme, 'rev-parse', '--short=7', 'HEAD').trim();

    // Nothing staged: a draft, then Amend fills HEAD's message (the draft stays aside).
    await s.command('git-commit');
    await s.field.fill('wip: next thing');
    await expect(amend).not.toHaveAttribute('aria-disabled', 'true', { timeout: 8000 });
    await amend.click();
    await expect(amend).toHaveAttribute('aria-pressed', 'true');
    await expect(s.field).toHaveValue('feat(cart): cart 2');
    await expect(s.drawer.locator('.git-amending')).toHaveText(`Amending ${first}`);
    await expect(s.drawer.locator('.git-commit-main')).toContainText('Amend Commit');
    // Off: the draft is back; on again from the ▾ menu, clicked at once: the commit's toast (8 s) sits beside the
    // Changes panel, never over its ▾ (a click waiting for the toast to go would time out).
    await amend.click();
    await expect(s.field).toHaveValue('wip: next thing');
    await look(s.win, 'test-results/git-toast-beside-changes.png');
    await s.drawer.getByRole('button', { name: 'More commit options' }).click({ timeout: 2000 });
    await s.win.getByRole('menuitem', { name: 'Amend Last Commit' }).click();
    await expect(s.field).toHaveValue('feat(cart): cart 2');
    await s.field.fill('feat(cart): cart 2, reworded');
    await s.win.mouse.move(5, 5);
    await look(s.panel, 'test-results/git-amend.png');
    // Reword with nothing staged.
    await s.field.press('Meta+Enter');
    await expect.poll(() => git(acme, 'log', '-1', '--format=%s').trim(), { timeout: 15000 }).toBe('feat(cart): cart 2, reworded');
    expect(git(acme, 'rev-list', '--count', 'HEAD').trim()).toBe('2');
    // Amend never touched the draft.
    await expect(s.bar.locator('.git-bar-draft')).toHaveText('wip: next thing', { timeout: 8000 });
    // Its toast comes once the facts name the reworded commit: Amend clicked before that would take the old HEAD, and
    // the fresh facts would then turn it off as a HEAD that moved (under load the click below beat them).
    const reworded = git(acme, 'rev-parse', '--short=7', 'HEAD').trim();
    await expect(s.win.locator('.toast')).toContainText(`Committed ${reworded} to acme-store`);

    // Amend on, then a commit from a terminal: HEAD is no longer the commit it showed, so it turns off and says so.
    await s.command('git-commit');
    await amend.click();
    await expect(amend).toHaveAttribute('aria-pressed', 'true');
    await expect(s.field).toHaveValue('feat(cart): cart 2, reworded');
    git(acme, 'commit', '-q', '--allow-empty', '-m', 'chore: from a terminal');
    await expect(amend).toHaveAttribute('aria-pressed', 'false', { timeout: 15000 });
    await expect(s.drawer.locator('.git-notice', { hasText: 'HEAD moved: amend turned off' })).toBeVisible();
    await expect(s.field).toHaveValue('wip: next thing');
    expect(git(acme, 'log', '-1', '--format=%s').trim()).toBe('chore: from a terminal');
    await s.win.keyboard.press('Escape');
    await expect(s.drawer).toHaveCount(0);

    // Commit and Push: the commit, then the push to the bare remote.
    write(join(acme, 'src/totals.ts'), 'totals 2\n');
    git(acme, 'add', 'src/totals.ts');
    await s.command('git-commit');
    await expect(s.drawer.locator('.git-commit-main')).toContainText('Commit 1 file', { timeout: 8000 });
    await s.field.fill('feat(totals): totals 2');
    await s.drawer.getByRole('button', { name: 'More commit options' }).click({ timeout: 2000 });
    await s.win.getByRole('menuitem', { name: 'Commit and Push' }).click();
    await expect.poll(() => git(acme, 'log', '-1', '--format=%s').trim(), { timeout: 15000 }).toBe('feat(totals): totals 2');
    const head = git(acme, 'rev-parse', 'HEAD').trim();
    await expect.poll(() => git(s.remote!('acme-store'), 'rev-parse', 'main').trim(), { timeout: 20000 }).toBe(head);
    // Its "Pushed to origin/main" toast waits behind the reword's Undo toast (8 s): git/actions.test.ts covers it.

    // Pushed: amend is off the table.
    await s.command('git-commit');
    await expect(amend).toHaveAttribute('aria-disabled', 'true', { timeout: 8000 });
    await expect(amend).toHaveAttribute('data-tip', 'Already pushed: amending would rewrite shared history');
  } finally {
    await s.stop();
  }
});

test('Cancel during a slow hook, from the drawer and from the bar: the op ends and the bar is back to normal', async () => {
  const s = await plain(['acme-store'], { hook: true });
  try {
    await expect(s.bar).toHaveText('Commit · nothing staged', { timeout: 10000 });
    const acme = s.repo('acme-store');
    const start = git(acme, 'rev-parse', 'HEAD').trim();
    hookMarker(acme, 'slow', true);
    write(join(acme, 'src/cart.ts'), 'cart 2\n');
    git(acme, 'add', 'src/cart.ts');
    await expect(s.bar).toHaveText('Commit1in acme-store', { timeout: 8000 });

    await s.command('git-commit');
    await s.field.fill('fix(cart): slow');
    await s.field.press('Meta+Enter');
    const running = s.drawer.locator('.git-oplog.is-running');
    await expect(running).toContainText('Running pre-commit · acme-store', { timeout: 8000 });
    await running.getByRole('button', { name: 'Cancel' }).click();
    await expect(running).toHaveCount(0, { timeout: 5000 });
    await expect(s.drawer.locator('.git-commit-main')).toContainText('Commit 1 file');
    await expect(s.drawer.locator('.git-commit-split')).not.toHaveClass(/is-disabled/);

    await s.field.press('Meta+Enter');
    await expect(running).toBeVisible({ timeout: 8000 });
    await s.win.keyboard.press('Escape');
    await expect(s.bar).toHaveClass(/is-running/);
    await s.bar.getByRole('button', { name: 'Cancel' }).click();
    await expect(s.bar).not.toHaveClass(/is-running/, { timeout: 5000 });
    await expect(s.bar).not.toHaveClass(/is-failed/);
    await expect(s.bar.locator('.git-bar-draft')).toHaveText('fix(cart): slow');
    expect(git(acme, 'rev-parse', 'HEAD').trim()).toBe(start);
    expect(git(acme, 'diff', '--cached', '--name-only').trim()).toBe('src/cart.ts');
  } finally {
    // A hook still waiting (a failed Cancel) ends, so quitting never asks.
    hookMarker(s.repo('acme-store'), 'slow', false);
    await s.stop();
  }
});

test('nothing staged, then a failing pre-commit: the files stay staged, the field has the focus again (Esc closes, ⌘↵ retries)', async () => {
  const s = await plain(['acme-store'], { hook: true });
  try {
    const repo = s.repo('acme-store');
    hookMarker(repo, 'fail', true);
    write(join(repo, 'src/cart.ts'), 'cart 2\n');
    await expect(s.panel.locator('.change-row')).toHaveText([/cart\.ts/], { timeout: 8000 });
    await s.command('git-commit');
    await s.field.fill('fix: cart 2');
    await s.field.press('Meta+Enter');
    await s.drawer.locator('.git-ask').getByRole('button', { name: 'Stage All and Commit' }).press('Enter');
    await expect(s.drawer.locator('.git-oplog.is-failed')).toContainText('missing semicolon', { timeout: 15000 });
    expect(git(repo, 'diff', '--cached', '--name-only').trim()).toBe('src/cart.ts');
    // The question is gone with its focused button: the focus is back where you type, so the drawer's keys work.
    await expect(s.field).toBeFocused();
    await s.win.keyboard.press('Escape');
    await expect(s.drawer).toHaveCount(0);
  } finally {
    hookMarker(s.repo('acme-store'), 'fail', false);
    await s.stop();
  }
});

/** A setting, as Settings sets it. */
const setSetting = (win: Page, patch: object) => win.evaluate((p) => (window as unknown as { atelier: { settings: { set(p: object): Promise<unknown> } } }).atelier.settings.set(p), patch);
const settingOf = (win: Page, key: string) => win.evaluate((k) => (window as unknown as { atelier: { settings: { get(): Promise<Record<string, unknown>> } } }).atelier.settings.get().then((x) => x[k]), key);

test('nothing staged: Commit asks to stage everything; Esc and Cancel; Always; Don’t commit; the Stage All line', async () => {
  const s = await plain(['acme-store']);
  try {
    const repo = s.repo('acme-store');
    const staged = () => git(repo, 'diff', '--cached', '--name-only').trim();
    const ask = s.drawer.locator('.git-ask');
    const line = s.drawer.locator('.git-notice.is-unstaged');
    write(join(repo, 'src/cart.ts'), 'cart 2\n');
    write(join(repo, 'src/new.ts'), 'new\n');
    await expect(s.panel.locator('.change-row')).toHaveCount(2, { timeout: 8000 });
    await s.command('git-commit');
    await expect(s.drawer).toBeVisible();
    // The Stage All line; Commit waits only for a message.
    await expect(line).toHaveText(/Nothing staged · 2 changes\s*Stage All/);
    await expect(s.drawer.locator('.git-commit-main')).toHaveAttribute('data-tip', 'Write a message first');
    await s.field.fill('feat: cart 2');
    await expect(s.drawer.locator('.git-commit-main')).not.toHaveAttribute('aria-disabled', 'true');

    // ⌘↵ asks, its main button focused; Esc closes only the question (drawer, message and index as they were).
    await s.field.press('Meta+Enter');
    await expect(ask).toHaveText(/Nothing is staged in acme-store\. Stage all 2 changes \(1 new file\) and commit them\?\s*Always\s*Stage All and Commit/);
    await expect(ask.getByRole('button', { name: 'Stage All and Commit' })).toBeFocused();
    // At the default width Always and the answer share one row (Cancel is the × in the corner).
    const [always, go] = await Promise.all([ask.getByRole('button', { name: 'Always' }).boundingBox(), ask.getByRole('button', { name: 'Stage All and Commit' }).boundingBox()]);
    expect(Math.abs(always!.y - go!.y)).toBeLessThan(2);
    await s.win.mouse.move(5, 300);
    await look(s.panel, 'test-results/git-ask-stage-all.png');
    // The narrowest panel: the answer on a row of its own, never a button on two lines.
    const width = (px: number) => s.win.evaluate((w) => (document.querySelector('.body') as HTMLElement).style.setProperty('--changes-w', `${w}px`), px);
    await width(240);
    expect((await ask.getByRole('button', { name: 'Stage All and Commit' }).boundingBox())!.height).toBeLessThan(30);
    await look(s.panel, 'test-results/git-ask-stage-all-240.png');
    await width(304);
    await s.win.keyboard.press('Escape');
    await expect(ask).toHaveCount(0);
    await expect(s.drawer).toBeVisible();
    await expect(s.field).toHaveValue('feat: cart 2');
    expect(staged()).toBe('');
    // Cancel: the same.
    await s.field.press('Meta+Enter');
    await ask.getByRole('button', { name: 'Cancel' }).click();
    await expect(ask).toHaveCount(0);
    expect(staged()).toBe('');

    // Enter on Stage All and Commit: every change staged and committed, the drawer closes.
    await s.field.press('Meta+Enter');
    await expect(ask.getByRole('button', { name: 'Stage All and Commit' })).toBeFocused();
    await s.win.keyboard.press('Enter');
    await expect(s.drawer).toHaveCount(0, { timeout: 15000 });
    expect(git(repo, 'show', '--name-only', '--format=%s', 'HEAD').trim().split('\n')).toEqual(['feat: cart 2', '', 'src/cart.ts', 'src/new.ts']);
    expect(git(repo, 'status', '--porcelain').trim()).toBe('');

    // Commit and Push asks with its own button.
    write(join(repo, 'src/totals.ts'), 'totals 2\n');
    // The row itself, not a count: a committed file's row can linger until the next status read.
    await expect(s.panel.locator('.change-row')).toHaveText([/totals\.ts/], { timeout: 8000 });
    await s.command('git-commit');
    await s.field.fill('fix: totals 2');
    await s.drawer.getByRole('button', { name: 'More commit options' }).click();
    await s.win.getByRole('menuitem', { name: 'Commit and Push' }).click();
    await expect(ask.getByRole('button', { name: 'Stage All, Commit and Push' })).toBeFocused();
    await expect(ask).toContainText('Stage all 1 change and commit it, then push?');
    await ask.getByRole('button', { name: 'Cancel' }).click();

    // Always: commits, and from then on Commit doesn't ask (the setting is Stage all).
    await s.field.press('Meta+Enter');
    await ask.getByRole('button', { name: 'Always' }).click();
    await expect(s.drawer).toHaveCount(0, { timeout: 15000 });
    expect(log(repo)).toBe('fix: totals 2');
    await expect.poll(() => settingOf(s.win, 'commitNothingStaged')).toBe('stage-all');
    write(join(repo, 'README.md'), '# repo 2\n');
    await expect(s.panel.locator('.change-row')).toHaveText([/README\.md/], { timeout: 8000 });
    await s.command('git-commit');
    await s.field.fill('docs: readme 2');
    await s.field.press('Meta+Enter');
    await expect(s.drawer).toHaveCount(0, { timeout: 15000 });
    expect(log(repo)).toBe('docs: readme 2');

    // Don't commit: Commit disabled as before. The Stage All line still ticks everything; one unticked stays out.
    await setSetting(s.win, { commitNothingStaged: 'never' });
    write(join(repo, 'src/cart.ts'), 'cart 3\n');
    write(join(repo, 'src/totals.ts'), 'totals 3\n');
    await expect(s.panel.locator('.change-row')).toHaveText([/cart\.ts/, /totals\.ts/], { timeout: 8000 });
    await s.command('git-commit');
    await s.field.fill('fix: cart 3');
    await expect(s.drawer.locator('.git-commit-main')).toHaveAttribute('data-tip', 'Nothing staged in acme-store');
    await line.getByRole('button', { name: 'Stage All' }).click();
    await expect(s.panel.getByRole('checkbox', { name: 'Stage cart.ts' })).toBeChecked({ timeout: 8000 });
    await expect(s.panel.getByRole('checkbox', { name: 'Stage totals.ts' })).toBeChecked();
    await expect(line).toHaveCount(0);
    await s.panel.getByRole('checkbox', { name: 'Stage totals.ts' }).click();
    await expect(s.drawer.locator('.git-commit-main')).toContainText('Commit 1 file', { timeout: 8000 });
    await s.field.press('Meta+Enter');
    await expect(s.drawer).toHaveCount(0, { timeout: 15000 });
    expect(git(repo, 'show', '--name-only', '--format=%s', 'HEAD').trim().split('\n')).toEqual(['fix: cart 3', '', 'src/cart.ts']);
    expect(git(repo, 'status', '--porcelain').trim()).toBe('M src/totals.ts');
  } finally {
    await s.stop();
  }
});
