// Sync arrows in Changes: ↓ to pull and ↑ to push right after each working tree's
// name, following commits, pushes, fetches, pulls and branch switches; in group heads, Clean chips and "To sync" by
// session; a pushed worktree next to its "to merge"; nothing collides at the narrowest panel. Remotes are bare
// repositories in the run's temp root; every repository has its own identity (no user config).
import { expect, test, type Locator, type Page } from '@playwright/test';
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { git, gitWritesProject, launchGitApp, write } from './git-writes-fixture';
import { groupChanges, setChangesFolders } from './changes-filters';
import { layoutProblems, NO_PROBLEMS } from './layout';
import { look } from './shots';

const SHOTS = 'test-results';

/** Another clone of `remote`, with its own identity. */
function otherClone(remote: string): string {
  const dir = join(realpathSync(mkdtempSync(join(tmpdir(), 'atl-sync-other-'))), 'other');
  git(tmpdir(), 'clone', '-q', remote, dir);
  git(dir, 'config', 'user.name', 'Ada');
  git(dir, 'config', 'user.email', 'ada@example.com');
  return dir;
}

let n = 0;
/** One commit with one new file (only that file: other changes stay in the working tree). */
function commitIn(dir: string, msg: string): void {
  const rel = `c-${++n}.txt`;
  write(join(dir, rel), `${msg}\n`);
  git(dir, 'add', rel);
  git(dir, 'commit', '-q', '-m', msg);
}

const box = async (l: Locator) => (await l.boundingBox())!;
const repoRow = (panel: Locator, name: string) => panel.locator('.clean-row:not(.is-wt)').filter({ has: panel.page().locator('.clean-name', { hasText: new RegExp(`^${name}$`) }) });

test('the arrows follow commits, pushes, fetches, pulls and branch switches', async () => {
  const p = gitWritesProject(['app', 'lib'], undefined, { remote: true });
  const app = p.repo('app');
  const other = otherClone(p.remote('app'));
  const { win, panel, stop, command } = await launchGitApp(p.root);
  try {
    const row = repoRow(panel, 'app');
    const counts = row.locator('.sync-counts');
    await expect(repoRow(panel, 'lib')).toBeVisible({ timeout: 15000 });
    await expect(row).toBeVisible();
    await expect(counts).toHaveCount(0);

    // A commit: ↑1, in the push colour, its tooltip naming the upstream.
    commitIn(app, 'feat: one');
    await expect(counts).toHaveText('↑1', { timeout: 10000 });
    await expect(counts.locator('.git-sync-ahead')).toHaveCount(1);
    await expect(counts).toHaveAttribute('data-tip', '1 to push to origin/main');
    await look(panel, `${SHOTS}/changes-sync-clean.png`);

    // A push: gone.
    git(app, 'push', '-q');
    await expect(counts).toHaveCount(0, { timeout: 10000 });

    // Someone else (up to date with that push) pushes; Atelier's Fetch All brings it: ↓1 in the pull colour.
    git(other, 'pull', '-q', '--ff-only');
    commitIn(other, 'feat: from another clone');
    git(other, 'push', '-q');
    await command('fetch-all');
    await expect(counts).toHaveText('↓1', { timeout: 15000 });
    await expect(counts.locator('.git-sync-behind')).toHaveCount(1);
    await expect(counts).toHaveAttribute('data-tip', '1 to pull from origin/main');

    // A pull: gone.
    git(app, 'pull', '-q', '--ff-only');
    await expect(counts).toHaveCount(0, { timeout: 10000 });

    // A local-only branch has no upstream: the arrows go with the same read that shows its name (never a stale ↑).
    commitIn(app, 'feat: two');
    await expect(counts).toHaveText('↑1', { timeout: 10000 });
    git(app, 'switch', '-q', '-c', 'local-only');
    await expect(row.locator('.clean-branch')).toHaveText('local-only', { timeout: 10000 });
    expect(await counts.count()).toBe(0);
    git(app, 'switch', '-q', 'main');
    await expect(row.locator('.clean-branch')).toHaveText('main', { timeout: 10000 });
    await expect(counts).toHaveText('↑1');
    // lib never moved.
    await expect(repoRow(panel, 'lib').locator('.sync-counts')).toHaveCount(0);
    expect(await win.locator('.toast').count()).toBeLessThanOrEqual(1);
  } finally {
    await stop();
  }
});

test('grouped by repository and by session: the head, the Clean chip, the "To sync" strip right above Clean; the heads stay put', async () => {
  const p = gitWritesProject(['app', 'lib'], undefined, { remote: true });
  const [app, lib] = [p.repo('app'), p.repo('lib')];
  const libOther = otherClone(p.remote('lib'));
  commitIn(libOther, 'feat: lib upstream');
  git(libOther, 'push', '-q');
  git(lib, 'fetch', '-q');
  commitIn(app, 'feat: one');
  write(join(app, 'src', 'app.ts'), 'export const app = 2;\n');
  const { panel, stop } = await launchGitApp(p.root);
  try {
    // By repository: app's head is title · arrows · branch pill; lib, clean, has its ↓1 in its chip.
    const head = panel.locator('.change-group-head', { hasText: 'app' });
    await expect(head.locator('.sync-counts')).toHaveText('↑1', { timeout: 15000 });
    const [title, arrows, branch] = [await box(head.locator('.change-group-title')), await box(head.locator('.sync-counts')), await box(head.locator('.branch'))];
    expect(arrows.x).toBeGreaterThanOrEqual(title.x + title.width - 0.5);
    expect(branch.x).toBeGreaterThanOrEqual(arrows.x + arrows.width - 0.5);
    await expect(panel.locator('.clean .chip-static')).toHaveText(['lib↓1']);
    await expect(panel.locator('.to-sync')).toHaveCount(0);
    await look(panel, `${SHOTS}/changes-sync-by-repo.png`);

    // By session: app's arrows go to "To sync" (its rows sit under their session), right above Clean.
    await groupChanges(panel, 'session');
    await expect(panel.locator('.to-sync .chip-static')).toHaveText(['app↑1']);
    await expect(panel.locator('.clean:not(.to-sync) .chip-static')).toHaveText(['lib↓1']);
    await expect(panel.locator('.sync-counts')).toHaveCount(2);
    const strip = (await panel.locator('.to-sync').boundingBox())!;
    expect((await panel.locator('.clean:not(.to-sync)').boundingBox())!.y).toBeGreaterThanOrEqual(strip.y + strip.height - 0.5);

    // Another commit while the file stays changed: only the chip changes, nothing above it moves.
    const heads = () => panel.locator('.change-group-head').evaluateAll((els) => els.map((e) => { const r = e.getBoundingClientRect(); return [r.x, r.y, r.width, r.height]; }));
    const before = await heads();
    commitIn(app, 'docs: notes');
    await expect(panel.locator('.to-sync .chip-static')).toHaveText(['app↑2'], { timeout: 10000 });
    expect(await heads()).toEqual(before);
    await look(panel, `${SHOTS}/changes-sync-by-session.png`);
  } finally {
    await stop();
  }
});

test('a pushed worktree: its arrows right after its name, then "to merge"; one tracking another name shows none; collapsing hides them', async () => {
  const p = gitWritesProject(['app'], undefined, { remote: true });
  const app = realpathSync(p.repo('app'));
  const feat = join(app, '.claude', 'worktrees', 'feat');
  git(app, 'worktree', 'add', '-q', '-b', 'feat', feat);
  commitIn(feat, 'feat: first on feat');
  git(feat, 'push', '-q', '-u', 'origin', 'feat');
  commitIn(feat, 'feat: second on feat');
  // From origin/main, as a worktree made from the remote branch: it tracks origin/main, another name.
  const spike = join(app, '.claude', 'worktrees', 'spike');
  git(app, 'worktree', 'add', '-q', '-b', 'spike', spike, 'origin/main');
  commitIn(spike, 'feat: spike');
  expect(git(spike, 'rev-parse', '--abbrev-ref', '@{upstream}').trim()).toBe('origin/main');
  const { panel, stop } = await launchGitApp(p.root);
  try {
    const line = panel.locator(`.change-wt[data-root="${feat}"]`);
    await expect(line.locator('.sync-counts')).toHaveText('↑1', { timeout: 15000 });
    await expect(line.locator('.sync-counts')).toHaveAttribute('data-tip', '1 to push to origin/feat');
    await expect(line.locator('.wt-ahead')).toContainText('↑2');
    const [name, arrows, merge] = [await box(line.locator('.wt-name')), await box(line.locator('.sync-counts')), await box(line.locator('.wt-ahead'))];
    expect(arrows.x).toBeGreaterThanOrEqual(name.x + name.width - 0.5);
    expect(merge.x).toBeGreaterThanOrEqual(arrows.x + arrows.width - 0.5);
    const spikeLine = panel.locator(`.change-wt[data-root="${spike}"]`);
    await expect(spikeLine.locator('.wt-ahead')).toContainText('↑1');
    await expect(spikeLine.locator('.sync-counts')).toHaveCount(0);
    await look(panel, `${SHOTS}/changes-sync-worktree.png`);

    // Collapsing app hides its worktrees, and their arrows with them (they go with their row).
    await panel.locator('.change-group-head', { hasText: 'app' }).first().click();
    await expect(panel.locator('.change-wt')).toHaveCount(0);
    await expect(panel.locator('.sync-counts')).toHaveCount(0);
  } finally {
    await stop();
  }
});

/** Every .sync-counts drawn whole: inside its row, head or chip, and inside the panel. */
const arrowsOutside = (panel: Locator) => panel.evaluate((root) => {
  const own = root.getBoundingClientRect();
  return [...root.querySelectorAll('.sync-counts')].flatMap((el) => {
    const r = el.getBoundingClientRect();
    const box = el.parentElement!.closest('.clean-row, .change-group-head, .chip-static, .wt-line-main') ?? el.parentElement!;
    const b = box.getBoundingClientRect();
    const whole = r.width > 0 && el.scrollWidth <= el.clientWidth + 0.5;
    const inside = r.left >= b.left - 0.5 && r.right <= b.right + 0.5 && r.top >= b.top - 0.5 && r.bottom <= b.bottom + 0.5 && r.right <= own.right + 0.5;
    return whole && inside ? [] : [`${el.textContent} in ${box.className}`];
  });
});
/** Chips that run past the panel or break onto a second line. */
const chipsOff = (panel: Locator) => panel.evaluate((root) => {
  const body = root.querySelector('.changes-body')!.getBoundingClientRect();
  return [...root.querySelectorAll('.chip-static')].flatMap((el) => {
    const r = el.getBoundingClientRect();
    return r.right <= body.right + 0.5 && r.height <= 24 ? [] : [`${el.textContent} ${Math.round(r.right)}>${Math.round(body.right)} h${Math.round(r.height)}`];
  });
});

async function changesTo240(win: Page): Promise<void> {
  const edge = win.getByRole('separator', { name: 'Resize Changes' });
  await edge.focus();
  for (let i = 0; i < 8 && (await edge.getAttribute('aria-valuenow')) !== '240'; i++) await win.keyboard.press('ArrowRight');
  await expect(edge).toHaveAttribute('aria-valuenow', '240');
}

const PARTS = ['.clean-row', '.change-group-head', '.sync-counts', '.chip-static', '.branch', '.clean-branch', '.clean-name'];

/** What a group head draws outside itself: each of its children's box must lie within the head's. */
const headsSpill = (panel: Locator) => panel.evaluate((root) => [...root.querySelectorAll('.change-group-head')].flatMap((head) => {
  const h = head.getBoundingClientRect();
  return [...head.children].filter((c) => { const r = c.getBoundingClientRect(); return r.width > 0 && (r.left < h.left - 0.5 || r.right > h.right + 0.5); })
    .map((c) => `${(head.textContent ?? '').trim().slice(0, 24)}: ${c.className}`);
}));

test('a pushed worktree with files at the narrowest panel: its head keeps every part inside — session, arrows, to merge, staged count, chevron', async () => {
  const p = gitWritesProject(['app'], undefined, { remote: true });
  const app = realpathSync(p.repo('app'));
  const wt = join(app, '.claude', 'worktrees', 'checkout-redesign');
  git(app, 'worktree', 'add', '-q', '-b', 'checkout-redesign', wt);
  commitIn(wt, 'feat: first');
  git(wt, 'push', '-q', '-u', 'origin', 'checkout-redesign');
  for (let i = 0; i < 3; i++) commitIn(wt, `feat: more ${i}`);
  // Two changed files, one staged: "1 staged · 2".
  write(join(wt, 'src', 'app.ts'), 'export const app = 2;\n');
  write(join(wt, 'README.md'), '# changed\n');
  git(wt, 'add', 'README.md');
  const { win, panel, stop } = await launchGitApp(p.root);
  try {
    await win.evaluate((cwd) => (window as unknown as { atelier: { terminals: { createSession(o: object): Promise<unknown> } } }).atelier.terminals.createSession({ cols: 80, rows: 24, cwd, name: 'Checkout' }), wt);
    const head = panel.locator(`.change-wt[data-root="${wt}"] .wt-head`);
    await expect(head.locator('.sync-counts')).toHaveText('↑3', { timeout: 15000 });
    await expect(head.locator('.wt-ahead')).toHaveText('↑4');
    await expect(head.locator('.avatar')).toHaveCount(1, { timeout: 15000 });
    await expect(head.locator('.change-count')).toContainText('staged');
    await changesTo240(win);
    for (const folders of [true, false]) {
      await setChangesFolders(panel, folders);
      expect(await headsSpill(panel)).toEqual([]);
      expect(await layoutProblems(panel, ['.change-group-head', '.wt-name', '.sync-counts', '.wt-avatars', '.wt-ahead', '.change-count', '.change-group-chev'])).toEqual(NO_PROBLEMS);
      expect(await arrowsOutside(panel)).toEqual([]);
      await look(panel, `${SHOTS}/changes-sync-240-worktree-${folders ? 'folders' : 'compact'}.png`);
    }
  } finally {
    await stop();
  }
});

test('the narrowest panel: ↓120 ↑3 next to a long name, many chips — nothing overlaps, wraps or clips, by repository, by session, compact and all clean', async () => {
  const LONG = 'a-repository-with-a-long-name';
  const names = [LONG, 'billing-service-api', 'checkout-frontend', 'docs', 'infra-terraform-modules', 'payments-gateway-sdk'];
  const p = gitWritesProject(names, undefined, { remote: true });
  const long = p.repo(LONG);
  const other = otherClone(p.remote(LONG));
  for (let i = 0; i < 120; i++) git(other, 'commit', '-q', '--allow-empty', '-m', `chore: ${i}`);
  git(other, 'push', '-q');
  git(long, 'fetch', '-q');
  for (let i = 0; i < 3; i++) commitIn(long, `feat: local ${i}`);
  commitIn(p.repo('billing-service-api'), 'feat: billing');
  commitIn(p.repo('docs'), 'docs: one');
  for (let i = 0; i < 4; i++) commitIn(p.repo('infra-terraform-modules'), `chore: infra ${i}`);
  for (let i = 0; i < 2; i++) commitIn(p.repo('payments-gateway-sdk'), `feat: pay ${i}`);
  // Dirty: the long one, billing, payments (their arrows: heads by repository, "To sync" by session).
  for (const name of [LONG, 'billing-service-api', 'payments-gateway-sdk']) write(join(p.repo(name), 'src', 'app.ts'), 'export const app = 2;\n');
  const { win, panel, stop } = await launchGitApp(p.root);
  try {
    await expect(panel.locator('.change-group-head', { hasText: LONG }).locator('.sync-counts')).toHaveText('↓120↑3', { timeout: 15000 });
    await changesTo240(win);
    const check = async (shot: string) => {
      expect(await layoutProblems(panel, PARTS)).toEqual(NO_PROBLEMS);
      expect(await arrowsOutside(panel)).toEqual([]);
      expect(await chipsOff(panel)).toEqual([]);
      await look(panel, `${SHOTS}/changes-sync-240-${shot}.png`);
    };
    await expect(panel.locator('.clean .chip-static')).toHaveCount(3);
    await check('repo');
    await groupChanges(panel, 'session');
    await expect(panel.locator('.to-sync .chip-static')).toHaveCount(3);
    await expect(panel.locator('.to-sync .chip-static', { hasText: LONG }).locator('.sync-counts')).toHaveText('↓120↑3');
    await check('session');
    await setChangesFolders(panel, false);
    await check('session-compact');
    await groupChanges(panel, 'repo');
    await check('repo-compact');
    await setChangesFolders(panel, true);
    // All clean: the rows.
    for (const name of [LONG, 'billing-service-api', 'payments-gateway-sdk']) { git(p.repo(name), 'add', '-A'); git(p.repo(name), 'commit', '-q', '-m', 'feat: done'); }
    await expect(panel.locator('.clean-state')).toBeVisible({ timeout: 10000 });
    await expect(repoRow(panel, LONG).locator('.sync-counts')).toHaveText('↓120↑4');
    await check('clean');
    // The long name gives way, never the short branch beside it: "main" stays whole.
    const cut = await panel.locator('.clean-row:not(.is-wt) .clean-branch-text').evaluateAll((els) => els.filter((e) => e.scrollWidth > e.clientWidth).map((e) => e.textContent));
    expect(cut).toEqual([]);
  } finally {
    await stop();
  }
});
