import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { e2eEnv } from './env';
import { groupChanges } from './changes-filters';
import { git, gitWritesProject, launchGitApp, write } from './git-writes-fixture';
import { look } from './shots';

// Staging in Changes: the staged dot and the header count with the drawer closed, staging from a
// terminal showing up, the context menus staging without opening the drawer, the by-session repository prefix.

const NAMES = ['acme-store', 'billing', 'plugins/payments'];

async function open(edit: string, root: string): Promise<{ app: ElectronApplication; win: Page; panel: Locator; stop: () => Promise<void> }> {
  const { env, home } = e2eEnv({ ATELIER_CLAUDE_BIN: resolve('tests/e2e/fake-claude-edit.pl'), ATELIER_FAKE_EDIT: edit });
  const app = await electron.launch({ args: ['out/main/index.js', `--project=${root}`], env });
  const win = await app.firstWindow();
  const stop = async () => {
    await app.close();
    try { process.kill((JSON.parse(readFileSync(join(home, 'atelierd.json'), 'utf8')) as { pid: number }).pid, 'SIGTERM'); } catch { /* already stopped */ }
  };
  return { app, win, panel: win.locator('.changes'), stop };
}

/** A project of three repositories with four changed files; a session "auth-refactor" that edited acme-store's cart.ts. */
async function scene() {
  const p = gitWritesProject(NAMES, { 'src/cart.ts': 'cart 1\n', 'src/totals.ts': 'totals 1\n', 'src/invoice.ts': 'invoice 1\n', 'src/pay.ts': 'pay 1\n' });
  const cart = join(p.repo('acme-store'), 'src/cart.ts');
  const s = await open(cart, p.root);
  await expect(s.panel).toContainText('All clean · 3 repos', { timeout: 10000 });
  write(cart, 'cart 2\n');
  write(join(p.repo('acme-store'), 'src/totals.ts'), 'totals 2\n');
  write(join(p.repo('billing'), 'src/invoice.ts'), 'invoice 2\n');
  write(join(p.repo('plugins/payments'), 'src/pay.ts'), 'pay 2\n');
  await expect(s.panel.locator('.change-row')).toHaveCount(4, { timeout: 8000 });
  await s.win.locator('.btn-new').click();
  await s.win.getByRole('menuitem', { name: 'Claude Session' }).click();
  await s.win.getByPlaceholder('Session name (optional)').fill('auth-refactor');
  await s.win.keyboard.press('Enter');
  const row = (name: string) => s.panel.locator('.change-row', { hasText: name });
  await expect(row('cart.ts').locator('.dot:not(.unknown)')).toHaveCount(1, { timeout: 15000 });
  return { ...p, ...s, row, head: (name: string) => s.panel.locator('.change-group-head', { hasText: name }) };
}

/** Where a row's parts are: what must not move when its file gets staged. */
const geometry = (row: Locator) => row.evaluate((el) => {
  const r = el.getBoundingClientRect();
  const icon = el.querySelector('.file-icon')!.getBoundingClientRect();
  const name = el.querySelector('.change-name')!.getBoundingClientRect();
  return { height: r.height, iconX: icon.x, nameX: name.x, nameW: name.width };
});

test('staging from a terminal shows the dot (full, half) and "N staged · M" with no layout shift; by session the repository prefix; the menus stage and unstage without opening the drawer', async () => {
  const s = await scene();
  try {
    const cart = s.row('cart.ts');
    const before = await geometry(cart);
    await expect(cart.locator('.git-dot')).toHaveCount(0);
    await expect(s.head('acme-store')).toContainText('2 files');

    // `git add` as in a terminal (Claude's own included): the index changes, Changes follows.
    git(s.repo('acme-store'), 'add', 'src/cart.ts');
    await expect(cart.locator('.git-dot.is-all')).toHaveCount(1, { timeout: 8000 });
    await expect(s.head('acme-store')).toContainText('1 staged · 2');
    expect(await geometry(cart)).toEqual(before);
    // The dot on the icon's bottom-right corner, over it (measured once its entrance, a scale with overshoot, ended).
    await cart.locator('.git-dot').evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)));
    const [icon, dot] = await Promise.all([cart.locator('.file-icon').boundingBox(), cart.locator('.git-dot').boundingBox()]);
    expect(dot!.x + dot!.width / 2).toBeGreaterThan(icon!.x + icon!.width / 2);
    expect(dot!.y + dot!.height / 2).toBeGreaterThan(icon!.y + icon!.height / 2);
    await expect(cart).toHaveAttribute('title', /· Staged$/);

    // Part of a file staged: the half ring.
    const totals = join(s.repo('acme-store'), 'src/totals.ts');
    git(s.repo('acme-store'), 'add', 'src/totals.ts');
    write(totals, 'totals 3\n');
    await expect(s.row('totals.ts').locator('.git-dot.is-partial')).toHaveCount(1, { timeout: 8000 });
    await expect(s.head('acme-store')).toContainText('2 staged · 2');

    // The drawer stays closed: no checkbox column; no read-only footer with git actions on.
    await expect(s.panel.locator('.git-check')).toHaveCount(0);
    await expect(s.panel.locator('.changes-foot')).toHaveCount(0);
    await s.win.mouse.move(5, 300);
    await look(s.panel, 'test-results/git-staging-dot.png');

    // By session with several repositories: the folder line starts with the repository's path.
    await groupChanges(s.panel, 'session');
    await expect(s.row('pay.ts').locator('.change-dir')).toHaveText('plugins/payments › src');
    await expect(s.row('pay.ts').locator('.change-dir-repo')).toHaveText('plugins/payments');
    // A session header on hover: "Commit…" in place of its count.
    const pill = s.panel.locator('.change-group-row', { hasText: 'auth-refactor' }).locator('.git-commit-pill');
    await expect(pill).toHaveCSS('opacity', '0');
    await s.head('auth-refactor').hover();
    await expect(pill).toHaveCSS('opacity', '1');
    await expect(s.head('auth-refactor').locator('.change-count')).toHaveCSS('visibility', 'hidden');
    await look(s.panel, 'test-results/git-staging-by-session.png');

    // The menus stage and unstage a file and a repository without opening the drawer.
    await groupChanges(s.panel, 'repo');
    const invoice = s.row('invoice.ts');
    await invoice.click({ button: 'right' });
    await s.win.getByRole('menuitem', { name: 'Stage', exact: true }).click();
    await expect(invoice.locator('.git-dot.is-all')).toHaveCount(1, { timeout: 8000 });
    await expect(s.head('billing')).toContainText('1 staged · 1');
    // The dot shows the click at once (stage-intents.ts): git catches up a moment later.
    const billingStaged = () => git(s.repo('billing'), 'diff', '--cached', '--name-only').trim();
    await expect.poll(billingStaged, { timeout: 8000 }).toBe('src/invoice.ts');
    await expect(s.panel.locator('.git-check')).toHaveCount(0);

    await invoice.click({ button: 'right' });
    await s.win.getByRole('menuitem', { name: 'Unstage', exact: true }).click();
    await expect(invoice.locator('.git-dot')).toHaveCount(0, { timeout: 8000 });
    await expect.poll(billingStaged, { timeout: 8000 }).toBe('');

    // A repository header: Stage All covers the whole repository.
    await s.head('payments').click({ button: 'right' });
    await s.win.getByRole('menuitem', { name: 'Stage All', exact: true }).click();
    await expect(s.row('pay.ts').locator('.git-dot.is-all')).toHaveCount(1, { timeout: 8000 });
    await expect(s.panel.locator('.git-check')).toHaveCount(0);
    // git done before quitting (quitting during a write asks first).
    await expect.poll(() => git(s.repo('plugins/payments'), 'diff', '--cached', '--name-only').trim(), { timeout: 8000 }).toBe('src/pay.ts');
  } finally {
    await s.stop();
  }
});

// On a Windows PC git add and the status read after it took seconds, the box unchanged meanwhile: it shows the click at
// once (renderer git/stage-intents.ts). Here git is held 3 s (a test-only delay) to see the box before git ran.
test('a checkbox shows its click at once while git still runs, the commit button with it; then git agrees', async () => {
  const p = gitWritesProject(['acme-store'], { 'src/cart.ts': 'cart 1\n', 'src/totals.ts': 'totals 1\n' });
  const s = await launchGitApp(p.root, undefined, e2eEnv({ ATELIER_CLAUDE_BIN: resolve('tests/e2e/fake-claude-edit.pl'), ATELIER_TEST_GIT_WRITE_DELAY_MS: '3000' }));
  const staged = () => git(p.repo('acme-store'), 'diff', '--cached', '--name-only').trim();
  try {
    write(join(p.repo('acme-store'), 'src/cart.ts'), 'cart 2\n');
    write(join(p.repo('acme-store'), 'src/totals.ts'), 'totals 2\n');
    await expect(s.panel.locator('.change-row')).toHaveCount(2, { timeout: 8000 });
    await s.command('git-commit');
    const box = s.panel.getByRole('checkbox', { name: 'Stage cart.ts' });
    await expect(box).toHaveAttribute('aria-checked', 'false');

    await box.click();
    await expect(box).toHaveAttribute('aria-checked', 'true', { timeout: 1000 });
    await expect(s.panel.locator('.git-commit-main')).toContainText('Commit 1 file');
    // git hasn't run yet: what shows is the click.
    expect(staged()).toBe('');
    await look(s.panel, 'test-results/git-staging-at-once.png');
    await expect.poll(staged, { timeout: 8000 }).toBe('src/cart.ts');
    await expect(box).toHaveAttribute('aria-checked', 'true');

    // Unstaging the same way.
    await box.click();
    await expect(box).toHaveAttribute('aria-checked', 'false', { timeout: 1000 });
    expect(staged()).toBe('src/cart.ts');
    await expect.poll(staged, { timeout: 8000 }).toBe('');
    await expect(box).toHaveAttribute('aria-checked', 'false');
  } finally {
    await s.stop();
  }
});
