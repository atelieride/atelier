import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { e2eEnv } from './env';
import { commit, fixtureGitEnv, git, multiRepoProject } from '../support/git-fixture';
import { execFileSync } from 'node:child_process';
import { look } from './shots';

const SHOTS = 'test-results';

async function stop(app: ElectronApplication, home: string) {
  await app.close();
  try { process.kill((JSON.parse(readFileSync(join(home, 'atelierd.json'), 'utf8')) as { pid: number }).pid, 'SIGTERM'); } catch { /* already stopped */ }
}

/** App menu shortcuts are clicked through the menu (synthetic key events never reach NSMenu). */
async function menu(app: ElectronApplication, label: string) {
  await app.evaluate(({ Menu, BrowserWindow }, l) => {
    const walk = (items: Electron.MenuItem[]): Electron.MenuItem | undefined => {
      for (const it of items) { if (it.label === l) return it; const sub = it.submenu ? walk(it.submenu.items) : undefined; if (sub) return sub; }
      return undefined;
    };
    walk(Menu.getApplicationMenu()!.items)?.click(undefined, BrowserWindow.getAllWindows()[0]);
  }, label);
}

async function launch(project: string, extra: Record<string, string> = {}) {
  const { env, home } = e2eEnv(extra);
  const app = await electron.launch({ args: ['out/main/index.js', `--project=${project}`], env });
  const win = await app.firstWindow();
  return { app, win, home };
}

const openScm = async (app: ElectronApplication, win: Page) => {
  await expect(win.locator('.activity-bar')).toBeVisible({ timeout: 15000 });
  await menu(app, 'Source Control');
  await expect(win.locator('.scm-sidebar')).toBeVisible();
};

test('sidebar: the repository switcher lists 20 repos, filters, picks; the branches of the selected one', async () => {
  const project = realpathSync(mkdtempSync(join(tmpdir(), 'atl-scm-')));
  multiRepoProject(project, 50);
  const { app, win, home } = await launch(project);
  try {
    await openScm(app, win);
    const card = win.locator('.sw-card');
    await expect(card).toContainText(project.split('/').at(-1)!);
    await expect(card.locator('.sw-pos')).toHaveText('1 / 21');
    await expect(card).toContainText('main · local');
    await expect(card.locator('.sw-branch')).toHaveAttribute('data-tip', 'main, no upstream branch (local only)');
    await expect(win.locator('.scm-section[data-key="branches"] .ref-row', { hasText: 'main' }).locator('.ref-head-pill')).toHaveText('HEAD');
    await expect(win.locator('.scm-section[data-key="tags"] .ref-row')).toHaveText([/v1/]);

    await card.click();
    const drop = win.locator('.scm-drop');
    await expect(drop).toBeVisible();
    await expect(card).toHaveAttribute('aria-expanded', 'true');
    await expect(drop.locator('.sw-row')).toHaveCount(21);
    // apps/api has an uncommitted change: Active, with its chip.
    await expect(drop.locator('.sw-group[data-group="active"] .sw-row', { hasText: 'api' }).locator('.sw-chip')).toHaveText('1 change');
    // A hidden worktree reads as its owner › its name, with a worktree pill (never its long path).
    const wt = drop.locator('.sw-row', { hasText: 'v2' });
    await expect(wt.locator('.sw-label')).toHaveText(`${project.split('/').at(-1)} › v2`);
    await expect(wt.locator('.sw-wt')).toHaveText('worktree');
    await look(win, `${SHOTS}/scm-switcher-open.png`, { settle: 500 });
    await win.keyboard.type('plug');
    await expect(drop.locator('.sw-row')).toHaveCount(5);
    await win.keyboard.press('ArrowDown');
    await win.keyboard.press('Enter');
    await expect(drop).toHaveCount(0);
    await expect(card).toContainText('plugins/');
    await expect(card).toHaveAttribute('aria-expanded', 'false');
    await expect(win.locator('.scm-section[data-key="branches"] .ref-row')).toHaveCount(1);
    // Esc closes and gives the focus back to the card.
    await card.click();
    await expect(drop).toBeVisible();
    await win.keyboard.press('Escape');
    await expect(drop).toHaveCount(0);
    await expect(card).toBeFocused();
    // The dim layer closes it too.
    await card.click();
    await win.locator('.scm-dim').click({ position: { x: 3, y: 200 } });
    await expect(drop).toHaveCount(0);
    await look(win, `${SHOTS}/scm-sidebar.png`);
  } finally {
    await stop(app, home);
  }
});

test('sidebar: a project without git repositories says so', async () => {
  const project = realpathSync(mkdtempSync(join(tmpdir(), 'atl-scm-none-')));
  const { app, win, home } = await launch(project);
  try {
    await openScm(app, win);
    await expect(win.locator('.scm-sidebar')).toContainText('No git repositories in this project');
  } finally {
    await stop(app, home);
  }
});

async function pickRepo(win: Page, query: string) {
  await win.locator('.sw-card').click();
  // Reopened, the switcher starts with an empty filter (it once kept the last one).
  await expect(win.locator('.scm-drop input')).toHaveValue('');
  await win.keyboard.type(query);
  await win.keyboard.press('Enter');
  await expect(win.locator('.scm-drop')).toHaveCount(0);
}

const historyTab = (win: Page) => win.locator('.history-view');
const row = (win: Page, subject: string) => historyTab(win).locator('.hv-row', { hasText: subject });

test('history: graph, ref pills, a virtualized list that pages, keyboard selection; live: a commit made meanwhile appears, scrolled down a pill says so and the selection stays', async () => {
  const project = realpathSync(mkdtempSync(join(tmpdir(), 'atl-scm-')));
  multiRepoProject(project, 1000);
  const { app, win, home } = await launch(project);
  try {
    await openScm(app, win);
    await win.getByRole('button', { name: 'Show History' }).click();
    await expect(win.locator('.tab.is-active')).toContainText(`History · ${project.split('/').at(-1)}`);
    await expect(row(win, 'chore: ignore nested repos').locator('.hv-pill.is-head')).toHaveText('main');
    await expect(row(win, "Merge branch 'feat/x'").locator('.hv-pill.is-tag')).toHaveText('v1');
    await expect(row(win, 'feat(x): change x').locator('.hv-prefix')).toHaveText('feat(x):');
    await expect(row(win, 'feat(x): change x').locator('.hv-claude')).toHaveCount(1);
    await expect(historyTab(win).locator('.hv-graph .hv-node')).not.toHaveCount(0);
    // The topic branch and the feature have their own lane: more than one lane drawn.
    const xs = await historyTab(win).locator('.hv-graph .hv-node circle:not(.hv-halo)').evaluateAll((els) => new Set(els.map((e) => e.getAttribute('cx'))).size);
    expect(xs).toBeGreaterThan(1);
    await look(win, `${SHOTS}/scm-history.png`);

    // Another repository: the tab follows the switcher.
    await pickRepo(win, 'long');
    await expect(win.locator('.tab.is-active')).toContainText('History · long');
    await expect(row(win, 'commit 1000')).toHaveCount(1);
    const scroller = historyTab(win).locator('.hv-scroll');
    await scroller.evaluate((el) => { el.scrollTop = 28 * 380; });
    await expect(row(win, 'commit 600')).toHaveCount(1);
    expect(await historyTab(win).locator('.hv-row').count()).toBeLessThanOrEqual(80);
    // Paging: near the end of what is loaded the next page arrives, until all of it is there.
    await expect(historyTab(win).locator('.hv-total')).toHaveText('800 commits+');
    await expect.poll(async () => { await scroller.evaluate((el) => { el.scrollTop = el.scrollHeight; }); return historyTab(win).locator('.hv-total').textContent(); }, { timeout: 10000, intervals: [200] }).toBe('1,000 commits');
    await expect(historyTab(win).locator('.hv-subject').filter({ hasText: /^commit 1$/ })).toHaveCount(1);
    await scroller.evaluate((el) => { el.scrollTop = 0; });
    await row(win, 'commit 1000').click();
    await expect(row(win, 'commit 1000')).toHaveAttribute('aria-selected', 'true');
    await win.keyboard.press('ArrowDown');
    await win.keyboard.press('j');
    await expect(row(win, 'commit 998')).toHaveAttribute('aria-selected', 'true');
    await win.keyboard.press('Meta+c');
    await expect(win.locator('.toast')).toContainText('Copied');

    // Live: a commit made meanwhile appears; scrolled down, a pill says so and the selection stays.
    await scroller.evaluate((el) => { el.scrollTop = 28 * 200; });
    await row(win, 'commit 795').click();
    await expect(row(win, 'commit 795')).toHaveAttribute('aria-selected', 'true');
    commit(join(project, 'apps', 'long'), 'feat: live one', { 'live.txt': '1\n' });
    await expect(historyTab(win).locator('.hv-new-pill')).toHaveText('↑ 1 new commit', { timeout: 10000 });
    await expect(row(win, 'commit 795')).toHaveAttribute('aria-selected', 'true');
    // The rows on screen didn't move: the anchor was kept.
    expect(await scroller.evaluate((el) => el.scrollTop)).toBe(28 * 201);
    await look(win, `${SHOTS}/scm-live.png`);
    await historyTab(win).locator('.hv-new-pill').click();
    await expect(row(win, 'feat: live one')).toBeVisible();
    await expect(historyTab(win).locator('.hv-new-pill')).toHaveCount(0);
    await expect.poll(() => scroller.evaluate((el) => el.scrollTop)).toBe(0);
    // At the top a new commit just shows, no pill.
    commit(join(project, 'apps', 'long'), 'feat: live two', { 'live.txt': '2\n' });
    await expect(row(win, 'feat: live two')).toBeVisible({ timeout: 10000 });
    await expect(historyTab(win).locator('.hv-new-pill')).toHaveCount(0);
  } finally {
    await stop(app, home);
  }
});

test('commit detail: merge against first parent and parent 2, renames, binary, a diff; open at this commit: a read-only tab, closing it never asks; Open Current Version', async () => {
  const project = realpathSync(mkdtempSync(join(tmpdir(), 'atl-scm-')));
  const { ids } = multiRepoProject(project, 20);
  const { app, win, home } = await launch(project);
  try {
    await openScm(app, win);
    await win.getByRole('button', { name: 'Show History' }).click();
    await row(win, "Merge branch 'feat/x'").click();
    const cd = historyTab(win).locator('.cd');
    await expect(cd.locator('.cd-subject')).toHaveText("Merge branch 'feat/x'");
    await expect(cd.locator('.cd-against')).toContainText('Changes against first parent');
    await expect(cd.locator('.cd-file')).toHaveCount(2);
    await cd.locator('.cd-file', { hasText: 'x.ts' }).click();
    await expect(cd.locator('.cm-diff-add')).toHaveCount(1);
    await cd.getByRole('button', { name: 'Compare with parent 2' }).click();
    await expect(cd.locator('.cd-against')).toContainText('Changes against parent 2');
    await expect(cd.locator('.cd-file', { hasText: 'old name.ts → nuovo è.ts' })).toHaveCount(1);
    await cd.locator('.cd-file', { hasText: 'logo.png' }).click();
    await expect(cd.locator('.cd-note')).toHaveText('Binary file changed');
    await row(win, 'feat(x): change x').click();
    await expect(cd.locator('.cd-meta')).toContainText('Claude');
    await expect(cd.locator('.cd-body-text')).toHaveText('A body line.');
    const ms = await win.evaluate(() => performance.getEntriesByName('scm:detail').map((e) => e.duration));
    expect(ms.length).toBeGreaterThan(0);
    expect(Math.max(...ms)).toBeLessThan(400);
    await look(win, `${SHOTS}/scm-detail.png`);

    // Open at this commit: a read-only tab, closing it never asks; Open Current Version.
    await row(win, 'fix(a): second line').dblclick();
    const tab = win.locator('.tab.is-active');
    await expect(tab).toContainText(`a.ts @ ${ids.c2.slice(0, 7)}`);
    const rev = win.locator('.rev-view:visible');
    await expect(rev.locator('.cm-content')).toContainText('TWO');
    await expect(rev.locator('.cm-content')).toHaveAttribute('contenteditable', 'false');
    await rev.locator('.cm-content').click();
    await win.keyboard.type('zzz');
    await expect(rev.locator('.cm-content')).not.toContainText('zzz');
    await rev.getByRole('button', { name: 'Open Current Version' }).click();
    await expect(win.locator('.tab.is-active')).toContainText('a.ts');
    await expect(win.locator('.tab.is-active')).not.toContainText('@');
    await win.locator('.tab', { hasText: '@' }).locator('.tab-close').click();
    await expect(win.locator('.tab', { hasText: '@' })).toHaveCount(0);
  } finally {
    await stop(app, home);
  }
});

test('ref picker: a branch scope with its banner; compare with the default branch; swap; "N ahead of main" and Enter follow commits made while it is open', async () => {
  const project = realpathSync(mkdtempSync(join(tmpdir(), 'atl-scm-')));
  multiRepoProject(project, 20);
  git(project, 'branch', 'other', 'main');
  const { app, win, home } = await launch(project);
  try {
    await openScm(app, win);
    await win.getByRole('button', { name: 'Show History' }).click();
    // Enter picks the highlighted branch even when a commit elsewhere reorders the list meanwhile (first: no Recent group).
    const picker = win.locator('.ref-picker');
    await historyTab(win).locator('.hv-scope').click();
    const active = picker.locator('.rp-item.is-active');
    await expect(picker.locator('.rp-item', { hasText: 'topic' })).toHaveCount(1);
    for (let i = 0; i < 15 && !((await active.textContent({ timeout: 2000 })) ?? '').includes('topic'); i++) await win.keyboard.press('ArrowDown');
    await expect(active).toContainText('topic');
    const labels = () => picker.locator('.rp-item .palette-label').allTextContents().then((l) => l.join(','));
    const before = await labels();
    // A session commits on another branch: the newest, it moves to the top of Local while the picker is open.
    const tip = git(project, 'rev-parse', 'other').trim();
    const env = { ...fixtureGitEnv, GIT_AUTHOR_NAME: 'S', GIT_AUTHOR_EMAIL: 's@example.com', GIT_COMMITTER_NAME: 'S', GIT_COMMITTER_EMAIL: 's@example.com', GIT_AUTHOR_DATE: '2099-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2099-01-01T00:00:00Z' };
    const next = execFileSync('git', ['commit-tree', `${tip}^{tree}`, '-p', tip, '-m', 'wip'], { cwd: project, env, encoding: 'utf8' }).trim();
    git(project, 'update-ref', 'refs/heads/other', next);
    await expect.poll(labels, { timeout: 10000 }).not.toBe(before);
    await expect(active).toContainText('topic');
    await win.keyboard.press('Enter');
    await expect(picker).toHaveCount(0);
    await expect(historyTab(win).locator('.hv-scope')).toContainText('topic');
    // Back to all branches.
    await historyTab(win).getByRole('button', { name: 'Show all branches' }).click();
    await expect(historyTab(win).locator('.hv-banner')).toHaveCount(0);

    await historyTab(win).locator('.hv-scope').click();
    await expect(picker).toBeVisible();
    await expect(picker).toContainText('Shows history only: your working tree stays on main');
    await win.keyboard.type('topic');
    await look(win, `${SHOTS}/scm-picker.png`);
    await win.keyboard.press('Enter');
    await expect(picker).toHaveCount(0);
    await expect(historyTab(win).locator('.hv-scope')).toContainText('topic');
    await expect(historyTab(win).locator('.hv-banner')).toContainText('Viewing topic — your working tree stays on main');
    await expect(row(win, 'feat(topic): two')).toHaveCount(1);
    await expect(row(win, 'chore: ignore nested repos')).toHaveCount(1);
    await historyTab(win).getByRole('button', { name: 'Show all branches' }).click();
    await expect(historyTab(win).locator('.hv-banner')).toHaveCount(0);

    // ⌥Enter: compare with main.
    await historyTab(win).locator('.hv-scope').click();
    await win.keyboard.type('topic');
    await win.keyboard.press('Alt+Enter');
    await expect(historyTab(win).locator('.hv-scope')).toContainText('topic vs main · 2 commits');
    await expect(historyTab(win).locator('.hv-row').first()).toContainText('All changes since main');
    await expect(historyTab(win).locator('.hv-row:not(.is-pseudo):not(.is-footer)')).toHaveCount(2);
    await historyTab(win).locator('.hv-row').first().click();
    await expect(historyTab(win).locator('.cd-file')).toHaveCount(2);
    await historyTab(win).getByRole('button', { name: 'Swap sides' }).click();
    await expect(historyTab(win).locator('.hv-scope')).toContainText('main vs topic');

    // "N ahead of main" follows a commit made while it is open.
    await historyTab(win).locator('.hv-scope').click();
    await win.keyboard.type('topic');
    const item = picker.locator('.rp-item', { hasText: 'topic' });
    await expect(item).toContainText('2 ahead of main');
    const topicTip = git(project, 'rev-parse', 'topic').trim();
    const three = git(project, 'commit-tree', `${topicTip}^{tree}`, '-p', topicTip, '-m', 'feat(topic): three').trim();
    git(project, 'update-ref', 'refs/heads/topic', three);
    await expect(item).toContainText('3 ahead of main', { timeout: 10000 });
    await win.keyboard.press('Escape');
    await expect(picker).toHaveCount(0);
  } finally {
    await stop(app, home);
  }
});

test('working tree row (a hidden-folder worktree\'s too, against its own HEAD), the palette, reduce motion', async () => {
  const project = realpathSync(mkdtempSync(join(tmpdir(), 'atl-scm-')));
  multiRepoProject(project, 20);
  writeFileSync(join(project, '.worktrees', 'v2', 'a.ts'), 'one\nTWO\nthree\nwt\n');
  const { app, win, home } = await launch(project);
  try {
    await openScm(app, win);
    // apps/api has an uncommitted README change: the first row shows it, its detail the diff.
    await pickRepo(win, 'api');
    await win.getByRole('button', { name: 'Show History' }).click();
    const first = historyTab(win).locator('.hv-row').first();
    await expect(first).toContainText('Uncommitted changes');
    await expect(first.locator('.hv-wt-chip')).toContainText('1 file');
    await first.click();
    await expect(historyTab(win).locator('.cd-file')).toHaveText([/README\.md/]);
    await expect(historyTab(win).locator('.cm-diff-add')).toHaveCount(1);
    // A hidden-folder worktree with uncommitted changes: its History starts with them, diffed against its own HEAD.
    await pickRepo(win, 'worktrees/v2');
    await expect(win.locator('.sw-card')).toContainText('v2', { timeout: 10000 });
    await expect(win.locator('.sw-card')).toContainText('1 change', { timeout: 10000 });
    // The detail shows api's README until v2's History replaces the list: gone first, then v2's first row.
    await expect(historyTab(win).locator('.cd-file')).not.toHaveText([/README\.md/], { timeout: 10000 });
    await expect(first).toContainText('Uncommitted changes', { timeout: 10000 });
    await first.click();
    await expect(historyTab(win).locator('.cd-file')).toHaveText([/a\.ts/]);
    await expect(historyTab(win).locator('.cm-diff-add')).toHaveCount(1);
    await expect(historyTab(win).locator('.cm-diff-add')).toHaveText('wt');
    // The palette: Switch Repository… opens the switcher.
    await win.keyboard.press('F1');
    await win.locator('.palette-input').fill('>switch repository');
    await win.keyboard.press('Enter');
    await expect(win.locator('.scm-drop')).toBeVisible();
    await win.keyboard.press('Escape');
    await expect(win.locator('.scm-drop')).toHaveCount(0);
    // Reduce motion: the dropdown appears without its drop animation.
    await win.evaluate(() => (window as unknown as { atelier: { settings: { set(p: object): Promise<unknown> } } }).atelier.settings.set({ motion: 'reduced' }));
    await expect(win.locator('html')).toHaveAttribute('data-motion', 'reduced');
    await win.locator('.sw-card').click();
    const anim = await win.locator('.scm-drop').evaluate((el) => getComputedStyle(el).animationName);
    expect(anim).toBe('none');
  } finally {
    await stop(app, home);
  }
});

test('history opened from elsewhere (View menu, Changes) without the sidebar: it opens and follows new commits', async () => {
  const project = realpathSync(mkdtempSync(join(tmpdir(), 'atl-scm-')));
  multiRepoProject(project, 20);
  const { app, win, home } = await launch(project);
  try {
    await expect(win.locator('.activity-bar')).toBeVisible({ timeout: 15000 });
    await expect(win.locator('.changes .change-group-head').first()).toBeVisible({ timeout: 10000 });
    await menu(app, 'Show History');
    await expect(win.locator('.tab.is-active')).toContainText('History ·', { timeout: 10000 });
    await win.locator('.tab.is-active .tab-close').click();
    // The Changes panel's repo header: Show History, then a commit made in a terminal shows up.
    await win.locator('.changes .change-group-head', { hasText: 'api' }).click({ button: 'right' });
    await win.getByRole('menuitem', { name: 'Show History' }).click();
    await expect(win.locator('.tab.is-active')).toContainText('History · api');
    await expect(win.locator('.scm-sidebar')).toHaveCount(0);
    commit(join(project, 'apps', 'api'), 'feat: from a terminal', { 'b.txt': 'b\n' });
    await expect(row(win, 'feat: from a terminal')).toBeVisible({ timeout: 10000 });
  } finally {
    await stop(app, home);
  }
});

test('live reload deep in a long history (past 4 000 rows) keeps the depth and the selection', async () => {
  const project = realpathSync(mkdtempSync(join(tmpdir(), 'atl-scm-')));
  multiRepoProject(project, 5000);
  const { app, win, home } = await launch(project);
  try {
    await openScm(app, win);
    await pickRepo(win, 'long');
    await win.getByRole('button', { name: 'Show History' }).click();
    await expect(row(win, 'commit 5000')).toHaveCount(1);
    const scroller = historyTab(win).locator('.hv-scroll');
    await expect.poll(async () => { await scroller.evaluate((el) => { el.scrollTop = el.scrollHeight; }); return historyTab(win).locator('.hv-total').textContent(); }, { timeout: 20000, intervals: [200] }).toBe('5,000 commits');
    await scroller.evaluate((el) => { el.scrollTop = 28 * 4500; });
    await row(win, 'commit 495').click();
    commit(join(project, 'apps', 'long'), 'feat: deep live', { 'deep.txt': '1\n' });
    await expect(historyTab(win).locator('.hv-new-pill')).toHaveText('↑ 1 new commit', { timeout: 10000 });
    await expect(historyTab(win).locator('.hv-total')).toHaveText('5,001 commits');
    await expect(row(win, 'commit 495')).toHaveAttribute('aria-selected', 'true');
    await expect(historyTab(win).locator('.cd-subject')).toHaveText('commit 495');
  } finally {
    await stop(app, home);
  }
});

test('details: new commits fade in, a viewed branch deleted elsewhere falls back, a too-large file says its size, unrelated histories say so', async () => {
  const project = realpathSync(mkdtempSync(join(tmpdir(), 'atl-scm-')));
  multiRepoProject(project, 20);
  // A branch with no history in common with main (made without touching the working tree).
  const lonely = git(project, 'commit-tree', '4b825dc642cb6eb9a060e54bf8d69288fbee4904', '-m', 'lonely root').trim();
  git(project, 'update-ref', 'refs/heads/lonely', lonely);
  const { app, win, home } = await launch(project);
  try {
    await openScm(app, win);
    await win.getByRole('button', { name: 'Show History' }).click();
    await expect(row(win, 'chore: ignore nested repos')).toHaveCount(1);
    commit(project, 'feat: a big file', { 'big.bin.txt': 'x'.repeat(3 * 1024 * 1024) });
    await expect(row(win, 'feat: a big file')).toHaveClass(/\bis-new\b/, { timeout: 10000 });
    await row(win, 'feat: a big file').click();
    await expect(historyTab(win).locator('.cd-note')).toHaveText('This diff is too large to show (3.0 MB)Open at this commit');
    // View topic, then delete it from a terminal: back to all branches, said once.
    await historyTab(win).locator('.hv-scope').click();
    await win.keyboard.type('topic');
    await win.keyboard.press('Enter');
    await expect(historyTab(win).locator('.hv-banner')).toContainText('Viewing topic');
    git(project, 'branch', '-D', 'topic');
    await expect(win.locator('.toast')).toContainText('That branch or tag is gone.', { timeout: 10000 });
    await expect(historyTab(win).locator('.hv-scope')).toContainText('All branches');
    // Compare main with a branch that shares no history: the "All changes" row says so instead of loading forever.
    await historyTab(win).locator('.hv-scope').click();
    await win.keyboard.type('lonely');
    await win.keyboard.press('Alt+Enter');
    await expect(historyTab(win).locator('.hv-scope')).toContainText('lonely vs main');
    await expect(historyTab(win).locator('.hv-row').first()).toContainText('All changes since main');
    await historyTab(win).locator('.hv-row').first().click();
    await expect(historyTab(win).locator('.cd-files')).toContainText('No history in common with main');
  } finally {
    await stop(app, home);
  }
});
