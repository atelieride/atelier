// Worktrees in Changes.
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { RepoStatus } from '../../src/shared/git';
import { e2eEnv } from './env';
import { groupChanges, setChangesFolders } from './changes-filters';
import { look } from './shots';

// Test repos isolated from the user's git configuration (global hooks, commit signing, ...).
const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const git = (cwd: string, ...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd, env: gitEnv, encoding: 'utf8' });

/** A repo on main (src/layout.css, src/store.ts) with a linked worktree in `.claude/worktrees/<name>` on `worktree-<name>`. */
function project(name = 'vad'): { root: string; wt: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'atl-wtp-')));
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src', 'layout.css'), 'a\n');
  writeFileSync(join(root, 'src', 'store.ts'), 'a\n');
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'first');
  const wt = join(root, '.claude', 'worktrees', name);
  git(root, 'worktree', 'add', '-q', '-b', `worktree-${name}`, wt);
  return { root, wt };
}

async function launch(root: string, extra: Record<string, string> = {}): Promise<{ app: ElectronApplication; win: Page; home: string }> {
  const { env, home } = e2eEnv({ ATELIER_CLAUDE_BIN: resolve('tests/e2e/fake-claude-edit.pl'), ...extra });
  const app = await electron.launch({ args: ['out/main/index.js', `--project=${root}`], env });
  return { app, win: await app.firstWindow(), home };
}

async function close(app: ElectronApplication, home: string) {
  await app.close();
  try { process.kill((JSON.parse(readFileSync(join(home, 'atelierd.json'), 'utf8')) as { pid: number }).pid, 'SIGTERM'); } catch { /* already stopped */ }
}

const statuses = (win: Page) => win.evaluate(() => (window as unknown as { atelier: { git: { status(): Promise<RepoStatus[]> } } }).atelier.git.status());
const statusOf = async (win: Page, root: string) => (await statuses(win)).find((s) => s.root === root);

type Api = { terminals: { createSession(o: object): Promise<unknown> } };
const sessionIn = (win: Page, cwd: string, name: string) => win.evaluate(([c, n]) => (window as unknown as { atelier: Api }).atelier.terminals.createSession({ cols: 80, rows: 24, cwd: c, name: n }), [cwd, name]);

test('a hidden linked worktree is a repo of Changes; By repo: it nests under its repo with its session, a committed one is one line, an idle one a chip; its menu; added and removed while open; Compare with main opens Review on it', async () => {
  const { root, wt } = project();
  git(root, 'worktree', 'add', '-q', '-b', 'old', join(root, '.worktrees', 'old'));
  const { app, win, home } = await launch(root, { ATELIER_FAKE_EDIT: 'src/store.ts' });
  try {
    const panel = win.locator('.changes');
    writeFileSync(join(wt, 'src', 'store.ts'), 'b\n');
    // A hidden linked worktree is a repo of Changes, with its changes.
    await expect.poll(async () => (await statusOf(win, wt))?.changes.map((c) => c.rel), { timeout: 10000 }).toEqual(['src/store.ts']);
    expect((await statusOf(win, wt))?.worktreeOf).toBe(root);
    expect((await statusOf(win, root))?.worktreeOf).toBeNull();
    await sessionIn(win, wt, 'Dictation VAD');
    const group = panel.locator(`.change-wt[data-root="${wt}"]`);
    await expect(group.locator('.change-row', { hasText: 'store.ts' }).locator('.dot:not(.unknown)')).toHaveCount(1, { timeout: 15000 });
    await expect(group.locator('.wt-head .avatar')).toHaveCount(1);
    // A click on an avatar goes to its session (the header still toggles everywhere else).
    await sessionIn(win, root, 'Other');
    await win.locator('.session-row', { hasText: 'Other' }).click();
    await expect(win.locator('.session-row.is-selected')).toContainText('Other');
    await group.locator('.wt-head .wt-avatar').click();
    await expect(win.locator('.session-row.is-selected')).toContainText('Dictation VAD');
    await expect(group.locator('.wt-head')).toHaveAttribute('aria-expanded', 'true');
    // Its fold chevron sits at the right end: on the left it would push the glyph in, as if nested under the worktree above.
    const glyphX = (await group.locator('.wt-head .wt-glyph').boundingBox())!.x;
    expect((await group.locator('.wt-head .change-group-chev').boundingBox())!.x).toBeGreaterThan((await group.locator('.wt-head .change-count').boundingBox())!.x);
    // The worktree's folder is its group, not an untracked row of the repo; the repo's header shows above it.
    await expect(panel.locator('.change-row')).toHaveCount(1);
    await expect(panel.locator('.change-group').first().locator('> .change-group-head')).toContainText(root.split('/').at(-1)!);
    await expect(panel.locator('.clean .chip-wt')).toHaveText('old');
    // Its tooltip sits under its header, inside the window, one line each: folder, branch (Changes is at the right edge).
    await group.locator('.wt-head .wt-name').hover();
    const tip = win.locator('.tooltip');
    await expect(tip.locator('.tooltip-line')).toHaveText(['.claude/worktrees/vad', 'worktree-vad']);
    const [t, h, vw] = await Promise.all([tip.boundingBox(), group.locator('.wt-head').boundingBox(), win.evaluate(() => window.innerWidth)]);
    expect(t!.x + t!.width).toBeGreaterThan(h!.x);
    expect(t!.x).toBeLessThan(h!.x + h!.width);
    expect(t!.x + t!.width).toBeLessThanOrEqual(vw);
    expect(t!.y).toBeGreaterThanOrEqual(h!.y + h!.height);
    await look(win, 'test-results/worktrees-tooltip.png', { clip: { x: Math.max(0, t!.x - 20), y: h!.y - 10, width: Math.min(vw - Math.max(0, t!.x - 20), t!.width + 40 + (h!.x + h!.width - t!.x - t!.width > 0 ? h!.x + h!.width - t!.x - t!.width : 0)), height: t!.y + t!.height - h!.y + 20 } });
    await win.mouse.move(5, 5);
    // Shown as a group (for its worktree), the repo isn't also listed as clean.
    await expect(panel.locator('.clean .chip-static:not(.chip-wt)')).toHaveCount(0);
    await look(panel, 'test-results/worktrees-by-repo.png');

    await group.locator('.wt-head').click({ button: 'right' });
    // Its own working tree: the repository's git items first.
    await expect(win.getByRole('menuitem')).toHaveText(['Stage All', 'Unstage All', 'Commit…', 'Discard All Changes…', 'Review Worktree', 'Compare with main',
      'Show History of worktree-vad', 'Open Terminal Here', 'Reveal in Finder']);
    await win.keyboard.press('Escape');

    // Committed: one quiet line with what it has to merge. A commit inside the worktree writes only the main repo's
    // .git: the worktree's status still follows.
    git(wt, 'commit', '-q', '-am', 'store');
    await expect(group.locator('.wt-line')).toContainText('↑1 to merge', { timeout: 10000 });
    await expect(group.locator('.change-row')).toHaveCount(0);
    // Its glyph keeps the place it had as a group: one lane, one column of glyphs.
    expect((await group.locator('.wt-line .wt-glyph').boundingBox())!.x).toBe(glyphX);
    await look(panel, 'test-results/worktrees-committed.png');
    await expect.poll(async () => { const s = await statusOf(win, wt); return [s?.changes.length, s?.merge?.commits, s?.merge?.files]; }, { timeout: 10000 })
      .toEqual([0, 1, ['src/store.ts']]);
    expect((await statusOf(win, root))?.merge ?? null).toBeNull();

    // A worktree added while the project is open joins; removed, it leaves.
    const extra = join(root, '.worktrees', 'new');
    git(root, 'worktree', 'add', '-q', '-b', 'new', extra);
    await expect.poll(async () => (await statusOf(win, extra))?.worktreeOf, { timeout: 10000 }).toBe(root);
    git(root, 'worktree', 'remove', '--force', extra);
    await expect.poll(async () => (await statusOf(win, extra)) === undefined, { timeout: 10000 }).toBe(true);

    // Compare with main opens Review on that worktree, Against main on, without changing the saved toggle; palette and
    // scope picker list it.
    writeFileSync(join(root, 'src', 'layout.css'), 'main\n');
    const line = panel.locator(`.change-wt[data-root="${wt}"] .wt-line`);
    await line.locator('.wt-compare').click();
    const review = win.locator('.review-view');
    await expect(review.locator('.rv-scope')).toHaveText('vad');
    await expect(review.locator('.rv-toggle')).toHaveAttribute('aria-pressed', 'true', { timeout: 10000 });
    await expect(review.locator('.rv-file-path')).toHaveText(['src/store.ts']);
    expect(await win.evaluate(() => localStorage.getItem('atelier.reviewAgainstMain'))).toBeNull();

    await review.locator('.rv-scope').click();
    await expect(win.getByRole('menuitem', { name: /vad/ })).toBeVisible();
    await win.keyboard.press('Escape');

    // From the palette too: back to all changes, then the worktree's command.
    await review.locator('.rv-scope').click();
    await win.getByRole('menuitem', { name: 'All changes' }).click();
    await expect(review.locator('.rv-scope')).not.toHaveText('vad');
    await win.keyboard.press('F1');
    await win.locator('.palette-input').fill('>review worktree vad');
    await expect(win.locator('.palette')).toContainText('Review worktree vad');
    await win.keyboard.press('Enter');
    await expect(review.locator('.rv-scope')).toHaveText('vad');
    // Like the worktree's menu: Review is the plain review, Compare is the one against main.
    await expect(review.locator('.rv-toggle')).toHaveAttribute('aria-pressed', 'false');
    await win.keyboard.press('F1');
    await win.locator('.palette-input').fill('>compare worktree vad');
    await expect(win.locator('.palette')).toContainText('Compare worktree vad with main');
    await win.keyboard.press('Enter');
    await expect(review.locator('.rv-toggle')).toHaveAttribute('aria-pressed', 'true');
  } finally {
    await close(app, home);
  }
});

test('a worktree file\'s tab carries the worktree glyph; a session working in a worktree shows its name in the sidebar', async () => {
  const { root, wt } = project();
  const { app, win, home } = await launch(root, { ATELIER_FAKE_EDIT: 'src/store.ts' });
  try {
    const panel = win.locator('.changes');
    writeFileSync(join(wt, 'src', 'store.ts'), 'wt\n');
    writeFileSync(join(root, 'src', 'store.ts'), 'main\n');
    await sessionIn(win, wt, 'Dictation VAD');
    await expect(win.locator('.session-row', { hasText: 'Dictation VAD' }).locator('.cwd-chip.is-wt')).toHaveText('vad', { timeout: 15000 });

    await panel.locator(`.change-wt[data-root="${wt}"] .change-row`, { hasText: 'store.ts' }).dblclick();
    const tab = win.locator('.tab.is-active');
    await expect(tab.locator('.tab-name')).toHaveText('store.ts');
    await expect(tab.locator('.tab-wt')).toHaveCount(1);
    await expect(tab).toHaveAttribute('data-tip', 'vad/src/store.ts');

    await panel.locator('.change-group', { has: win.locator('> .change-group-head', { hasText: root.split('/').at(-1)! }) }).locator('> .change-row', { hasText: 'store.ts' }).dblclick();
    await expect(win.locator('.tab.is-active .tab-wt')).toHaveCount(0);
    await expect(win.locator('.tab.is-active')).toHaveAttribute('data-tip', 'src/store.ts');
  } finally {
    await close(app, home);
  }
});

/**
 * Headers and rows of Changes that are taller than one line or whose content spills out. Rows with their
 * folder (the default) have two lines by design: only compact rows must keep to one.
 */
const overflowing = (win: Page) => win.evaluate(() => {
  const bad: string[] = [];
  const compact = !!document.querySelector('.changes.is-compact');
  for (const el of document.querySelectorAll<HTMLElement>('.changes .change-group-head, .changes .wt-line, .changes .change-row, .changes .meet-title, .changes .changes-head')) {
    const box = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    const inner = box.height - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
    if (inner > (compact || !el.classList.contains('change-row') ? 30 : 40)) bad.push(`${el.className}: ${Math.round(inner)}px tall`);
    if (el.scrollWidth > el.clientWidth + 1) bad.push(`${el.className}: content ${el.scrollWidth} > ${el.clientWidth}`);
    for (const c of el.querySelectorAll<HTMLElement>('*')) {
      const r = c.getBoundingClientRect();
      if (r.width && (r.right > box.right + 1 || r.left < box.left - 1)) { bad.push(`${el.className} > ${c.className || c.tagName}: outside`); break; }
    }
  }
  return bad;
});
const shown = (win: Page, sel: string) => win.evaluate((s) => [...document.querySelectorAll<HTMLElement>(s)].filter((e) => e.offsetParent && getComputedStyle(e).display !== 'none' && e.getBoundingClientRect().width > 0).length, sel);

test('two sessions on two branches: By session says where each works, the same file on both gets the violet card; nothing wraps or overlaps from 240 to 304 px; narrow, the deltas go and pills keep only their glyph', async () => {
  const { root, wt } = project('dictation-voice-activity-detection');
  const { app, win, home } = await launch(root, { ATELIER_FAKE_EDIT: 'src/layout.css' });
  try {
    const panel = win.locator('.changes');
    writeFileSync(join(root, 'src', 'layout.css'), 'main\n');
    writeFileSync(join(wt, 'src', 'layout.css'), 'wt\n');
    writeFileSync(join(wt, 'src', 'store.ts'), 'wt\n');
    git(wt, 'commit', '-q', '-m', 'store', '--', 'src/store.ts');
    await sessionIn(win, root, 'Changes panel polish with a rather long session name');
    await sessionIn(win, wt, 'Dictation voice activity detection and its long name');
    await expect(panel.locator('.change-row .dot:not(.unknown)')).toHaveCount(2, { timeout: 15000 });
    await expect(panel.locator('.wt-ahead')).toHaveCount(1, { timeout: 10000 });

    // The same file changed on both branches: the violet card, never a clash.
    const card = panel.locator('.meet');
    await expect(card).toHaveCount(1);
    await expect(card.locator('.meet-title')).toHaveText('Same file on two branches');
    await expect(card.locator('.meet-body')).toHaveText('Changes panel polish with a rather long session name on main and Dictation voice activity detection and its long name on worktree-dictation-voice-activity-detection both changed src/layout.css. They’ll meet when you merge.');
    await expect(panel.locator('.clash')).toHaveCount(0);
    // By session says where each works.
    await groupChanges(panel, 'session');
    const pill = (name: string) => panel.locator('.change-group-head', { hasText: name }).locator('.loc-pill');
    await expect(pill('Changes panel polish')).toHaveText('main');
    await expect(pill('Dictation voice activity')).toHaveText('dictation-voice-activity-detection');
    await expect(pill('Dictation voice activity')).toHaveClass(/is-wt/);
    await look(panel, 'test-results/worktrees-by-session.png');
    const widths = async (group: 'repo' | 'session') => {
      await groupChanges(panel, group);
      for (const w of [304, 270, 240]) {
        await win.evaluate((px) => (document.querySelector('.body') as HTMLElement).style.setProperty('--changes-w', `${px}px`), w);
        await win.waitForTimeout(50);
        expect(await overflowing(win), `${group} at ${w}px`).toEqual([]);
        if (w === 304) {
          expect(await shown(win, '.changes .change-delta'), `deltas at ${w}`).toBeGreaterThan(0);
          await look(panel, `test-results/worktrees-${group}-304.png`);
        }
        if (w === 240) {
          expect(await shown(win, '.changes .change-delta'), 'deltas at 240').toBe(0);
          expect(await shown(win, '.changes .pill-text'), 'pill texts at 240').toBe(0);
          await look(panel, `test-results/worktrees-${group}-240.png`);
        }
      }
    };
    await widths('repo');
    await widths('session');
    // Compact rows too: one line each.
    await setChangesFolders(panel, false);
    await expect(panel).toHaveClass(/is-compact/);
    await widths('repo');
    await widths('session');
  } finally {
    await close(app, home);
  }
});
