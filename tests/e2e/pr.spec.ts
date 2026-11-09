import { _electron as electron, expect, test, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { e2eEnv } from './env';
import { look } from './shots';

// Pull request and CI chip: a Claude session works in a test repo on `feature/x`; main asks a fake gh
// (tests/e2e/fake-gh.mjs, never the real one) for that branch's PR. The chip `#7` shows the CI as a dot that follows the
// fake's answers (passing → failing → pending), opens the PR / its checks through main (logged, never a browser),
// copies the link (logged, never the clipboard), and disappears when gh is not logged in or the setting is off — after
// which gh is not run anymore.

const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const git = (cwd: string, ...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd, env: gitEnv });

const FIELDS = 'number,title,url,state,isDraft,reviewDecision,statusCheckRollup';
const URL = 'https://github.com/acme/widgets/pull/7';
const run = (name: string, status: string, conclusion = '') => ({ __typename: 'CheckRun', name, status, conclusion, workflowName: 'CI' });
const prJson = (checks: unknown[]) => ({
  number: 7, title: 'Speed up the widget pipeline', url: URL, state: 'OPEN', isDraft: false, reviewDecision: 'REVIEW_REQUIRED', statusCheckRollup: checks
});
const PASSING = [run('build', 'COMPLETED', 'SUCCESS'), run('lint', 'COMPLETED', 'SUCCESS'), run('e2e', 'COMPLETED', 'SUCCESS')];
const FAILING = [run('build', 'COMPLETED', 'FAILURE'), run('lint', 'COMPLETED', 'SUCCESS'), run('e2e', 'COMPLETED', 'SUCCESS')];
const PENDING = [run('build', 'IN_PROGRESS'), run('lint', 'COMPLETED', 'SUCCESS'), run('e2e', 'COMPLETED', 'SUCCESS')];

type Api = { prs: { open(root: string, branch: string, checks: boolean): Promise<boolean> } };

/** Animations off for screenshots that are looked at. */
const still = (win: Page) => win.addStyleTag({ content: '*, *::before, *::after { animation: none !important; transition: none !important; }' });

test('pr: #7 chip with the CI dot for a session on feature/x; follows gh; opens and copies through main; hidden on auth and with the setting off', async () => {
  const project = mkdtempSync(join(tmpdir(), 'atl-prj-'));
  git(project, 'init', '-q', '-b', 'main');
  writeFileSync(join(project, 'README.md'), 'x\n');
  git(project, 'add', '.');
  git(project, 'commit', '-q', '-m', 'first');
  git(project, 'checkout', '-q', '-b', 'feature/x');

  const dir = mkdtempSync(join(tmpdir(), 'atl-gh-'));
  const data = join(dir, 'prs.json');
  const ghLog = join(dir, 'gh.log');
  const urlLog = join(dir, 'urls.txt');
  const setAnswer = (answer: unknown) => writeFileSync(data, JSON.stringify({ 'feature/x': answer }));
  setAnswer(prJson(PASSING));
  // The fake runs with this test's node (an absolute path: the app's PATH need not have node).
  const fakeGh = join(dir, 'gh');
  writeFileSync(fakeGh, `#!/bin/sh\nexec '${process.execPath}' '${resolve('tests/e2e/fake-gh.mjs')}' "$@"\n`);
  chmodSync(fakeGh, 0o755);
  const calls = () => (existsSync(ghLog) ? readFileSync(ghLog, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as { argv: string[]; cwd: string; prompt: string | null; color: string | null }) : []);

  const { env, home } = e2eEnv({
    ATELIER_CLAUDE_BIN: resolve('tests/e2e/fake-claude.pl'), ATELIER_TEST_URL_LOG: urlLog,
    ATELIER_TEST_GH: fakeGh, ATELIER_FAKE_GH_DATA: data, ATELIER_FAKE_GH_LOG: ghLog,
    // Every PR interval at 250 ms (devEnv-gated): the rewritten answers show up without minute-long waits.
    ATELIER_TEST_PR_INTERVAL_MS: '250'
  });
  const app = await electron.launch({ args: ['out/main/index.js', `--project=${project}`], env });
  try {
    const win = await app.firstWindow();
    await win.locator('.btn-new').click();
    await win.getByRole('menuitem', { name: 'Claude Session' }).click();
    await win.getByPlaceholder('Session name (optional)').fill('Widgets');
    await win.keyboard.press('Enter');
    const row = win.locator('.session-row').filter({ has: win.locator('.session-title', { hasText: /^Widgets$/ }) });
    await expect(row).toHaveClass(/state-waiting/, { timeout: 20000 });
    await row.click();

    // The chip: #7, open-PR glyph, green dot; gh was asked exactly `pr view feature/x --json <fields>` in the repo root.
    const chip = win.locator('.session-bar .pr-chip');
    await expect(chip).toHaveText('#7', { timeout: 15000 });
    await expect(chip).toHaveClass(/pr-prOpen/);
    await expect(chip).toHaveClass(/ci-passing/);
    await expect(chip.locator('.pr-ci')).toHaveCSS('background-color', 'rgb(52, 211, 153)');
    const first = calls()[0]!;
    expect(first.argv).toEqual(['pr', 'view', 'feature/x', '--json', FIELDS]);
    expect(first.cwd).toBe(realpathSync(project));
    expect(first.prompt).toBe('1');
    expect(first.color).toBe('1');
    expect(calls().every((c) => c.argv[2] === 'feature/x')).toBe(true);
    await expect(chip).toHaveAttribute('data-tip', '#7 · Speed up the widget pipeline\nOpen · Review required\nChecks: 3 passed');
    await still(win);
    await look(win.locator('.session-bar'), 'test-results/pr-bar-passing.png');

    // gh now reports a failing build: the dot turns rose and the tooltip names it.
    setAnswer(prJson(FAILING));
    await expect(chip).toHaveClass(/ci-failing/, { timeout: 10000 });
    await expect(chip.locator('.pr-ci')).toHaveCSS('background-color', 'rgb(251, 113, 133)');
    await expect(chip).toHaveAttribute('data-tip', /Checks: 2 passed, 1 failed \(build\)$/);
    await chip.hover();
    await expect(win.locator('.tooltip .tooltip-line')).toHaveCount(3, { timeout: 3000 });
    await look(win, 'test-results/pr-tooltip.png');
    await win.mouse.move(0, 400);

    // Then pending: amber dot.
    setAnswer(prJson(PENDING));
    await expect(chip).toHaveClass(/ci-pending/, { timeout: 10000 });
    await expect(chip.locator('.pr-ci')).toHaveCSS('background-color', 'rgb(251, 191, 36)');
    await look(win.locator('.session-bar'), 'test-results/pr-bar-pending.png');

    // Click: the PR; ⌥-click: its checks — opened by main from gh's URL (logged by the test seam, no browser).
    const urls = () => (existsSync(urlLog) ? readFileSync(urlLog, 'utf8') : '');
    await chip.click();
    await expect.poll(urls, { timeout: 5000 }).toContain(`${URL}\n`);
    await chip.click({ modifiers: ['Alt'] });
    await expect.poll(urls, { timeout: 5000 }).toContain(`${URL}/checks\n`);
    // The context menu: Open Pull Request / Open Checks / Copy Link (copied through main, logged, never the clipboard).
    await chip.click({ button: 'right' });
    await expect(win.getByRole('menuitem', { name: 'Open Pull Request' })).toBeVisible();
    await expect(win.getByRole('menuitem', { name: 'Open Checks' })).toBeVisible();
    await win.getByRole('menuitem', { name: 'Copy Link' }).click();
    await expect.poll(() => (existsSync(join(home, 'test-clipboard.log')) ? readFileSync(join(home, 'test-clipboard.log'), 'utf8') : ''), { timeout: 5000 }).toContain(URL);
    // From the keyboard too: the palette's "Open pull request #7" / "Open checks of #7" for the selected session.
    for (const [query, label, opened] of [['>open pull', 'Open pull request #7', `${URL}\n`], ['>open checks', 'Open checks of #7', `${URL}/checks\n`]] as const) {
      const before = urls().length;
      await win.keyboard.press('F1');
      await win.locator('.palette-input').fill(query);
      await expect(win.locator('.palette-item.is-active')).toContainText(label);
      await win.keyboard.press('Enter');
      await expect.poll(() => urls().slice(before), { timeout: 5000 }).toBe(opened);
    }
    // The renderer cannot open a repo+branch main has no PR for.
    const refused = await win.evaluate(async (root) => {
      const api = (window as unknown as { atelier: Api }).atelier;
      return [await api.prs.open(root, 'feature/other', false), await api.prs.open('/elsewhere', 'feature/x', true)];
    }, realpathSync(project));
    expect(refused).toEqual([false, false]);

    // The narrowest window (asked 900 px, clamped to the 960 px minimum) with the Changes panel closed: the bar keeps
    // everything on one line, nothing overflows, the chip stays whole. (With the panel open too, the bar is ~340 px and
    // already overflowed before the chip: the split view's container queries adapt it.)
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(900, 640));
    await expect.poll(() => win.evaluate(() => window.innerWidth)).toBeLessThanOrEqual(960);
    if (await win.locator('aside.changes').isVisible()) await win.locator('.changes-toggle').click();
    await expect(win.locator('aside.changes')).toHaveCount(0);
    const fit = await win.evaluate(() => {
      const bar = document.querySelector('.session-bar')!;
      const c = document.querySelector('.session-bar .pr-chip')!.getBoundingClientRect();
      const b = bar.getBoundingClientRect();
      return { overflow: bar.scrollWidth > bar.clientWidth + 1, inside: c.left >= b.left && c.right <= b.right, chipW: c.width };
    });
    expect(fit.overflow).toBe(false);
    // The session chip stays, whatever the width: the context is the one number always
    // there; only the model's name gives way.
    await expect(win.locator('.session-bar .sb-model')).toBeVisible();
    expect(fit.inside).toBe(true);
    expect(fit.chipW).toBeGreaterThan(30);
    await look(win.locator('.session-bar'), 'test-results/pr-bar-narrow.png');
    await look(win.locator('.session-bar .pr-chip'), 'test-results/pr-chip.png');

    // gh not logged in: the chip goes away and Settings › Claude says how to fix it.
    setAnswer('auth');
    await expect(chip).toHaveCount(0, { timeout: 10000 });
    await win.getByRole('button', { name: 'Settings' }).click();
    const dialog = win.getByRole('dialog', { name: 'Settings' });
    await dialog.getByRole('button', { name: 'Claude' }).click();
    await expect(dialog.getByText('Run gh auth login in a terminal to see pull requests.')).toBeVisible();
    const toggle = dialog.getByRole('switch', { name: 'Pull request and CI status' });
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
    await look(dialog, 'test-results/pr-settings-auth.png');

    // Logged in again, then the setting off: the chip goes and gh is not run anymore.
    setAnswer(prJson(PASSING));
    await expect(dialog.getByText('Run gh auth login in a terminal to see pull requests.')).toHaveCount(0, { timeout: 10000 });
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', 'false');
    await win.keyboard.press('Escape');
    await expect(win.locator('.pr-chip')).toHaveCount(0);
    // A gh the last tick started may still be logging: counted once the log has been still for a moment.
    let before = -1;
    for (let now = calls().length; now !== before; ) { before = now; await win.waitForTimeout(300); now = calls().length; }
    // Four intervals: gh would have run by now.
    await win.waitForTimeout(1000);
    expect(calls().length).toBe(before);
  } finally {
    await app.close();
    try { process.kill((JSON.parse(readFileSync(join(home, 'atelierd.json'), 'utf8')) as { pid: number }).pid, 'SIGTERM'); } catch { /* already stopped */ }
  }
});
