import { _electron as electron, expect, test, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { startFake } from './fake-clickup-cli';

// Automations on a real Windows with real Claude: run by hand on the test PC, never in
// `npm run e2e`. The app from this checkout (npm run build), a temporary ATELIER_HOME, a fake ClickUp, and the PC's own
// Claude Code on its normal account. The project's root (AUTOMATIONS_WIN_PROJECT, default C:/dev/aw-e2e/acme) is made
// fresh each time; Claude Code must trust it (once, by hand: open Claude there and accept), as a user would. The task asks
// Claude to try the guard from its own Bash tool (Git Bash) and to write what it
// saw into results.txt, committed on its branch; the test then checks the checkout, the remote and the user's stash.
//
//   npx playwright test --config playwright.manual.config.ts tests/e2e/automations-win.manual.ts

const ROOT = process.env.AUTOMATIONS_WIN_PROJECT ?? 'C:/dev/aw-e2e/acme';
const SHOTS = resolve('test-results', 'automations-win');
const gitEnv = { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.test', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.test' };
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env: gitEnv, encoding: 'utf8' }).trim();
const slash = (p: string) => p.replace(/\\/g, '/');

// Commands Claude has no reason to decline (the first run, 2026-10-19: it declined `git stash` and a command on the
// checkout by itself, from the system prompt's rules — the first layer). They show what its Bash tool runs: the guard's
// function as `git`, which passes a command through to git; the guard's hooks folder in force. The refusals themselves
// are guard.win32.test.ts's, with real git from every shell.
const TASK = [
  'Do exactly these steps, in order, with your Bash tool, one command per call:',
  '1. Run `type -t git` and keep its output.',
  '2. Run `git rev-parse --abbrev-ref HEAD` and keep its output.',
  '3. Run `git config --get core.hooksPath` and keep its output.',
  '4. Write a file results.txt in the current folder with, for each step, the command, its exit code and its output.',
  '5. `git add results.txt` and `git commit -m "results"`.'
].join('\n');

test('a real run on Windows: worktree, the guard from Claude\'s own tools, commit on its branch, Close Run', async () => {
  test.skip(process.platform !== 'win32', 'Windows only');
  test.setTimeout(600_000);
  mkdirSync(SHOTS, { recursive: true });
  // The project: a fresh repository at the trusted root, a bare remote next to it, main pushed, a stash of the user's.
  const root = slash(ROOT);
  const base = join(root, '..');
  rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  mkdirSync(base, { recursive: true });
  git(base, 'init', '-q', '--bare', '-b', 'main', join(base, 'remote.git'));
  git(base, 'init', '-q', '-b', 'main', root);
  writeFileSync(join(root, 'README.md'), '# acme\n');
  writeFileSync(join(root, '.gitignore'), '.claude/worktrees/\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'base');
  git(root, 'remote', 'add', 'origin', join(base, 'remote.git'));
  git(root, 'push', '-q', '-u', 'origin', 'main');
  writeFileSync(join(root, 'README.md'), "# acme\nthe user's work\n");
  git(root, 'stash', '-q');
  const mainOid = git(root, 'rev-parse', 'main');
  const stashOid = git(root, 'rev-parse', 'refs/stash');

  const home = mkdtempSync(join(tmpdir(), 'atl-aw-home-'));
  const fake = await startFake();
  await fake.scenario('compact');
  const app = await electron.launch({
    args: ['out/main/index.js', `--project=${root}`],
    env: { ...process.env, ATELIER_HOME: home, ATELIER_TEST_CLICKUP_URL: fake.url, ATELIER_TEST_FOLLOW_AUTH: '1' } as Record<string, string>
  });
  let win: Page | null = null;
  try {
    win = await app.firstWindow();
    await expect(win.locator('.footer')).toBeVisible({ timeout: 30000 });
    await win.evaluate('window.atelier.connectors.connect("clickup")');
    await expect.poll(() => win!.evaluate('window.atelier.connectors.list().then((r) => r.connectors[0] && r.connectors[0].status)'), { timeout: 30000 }).toBe('connected');
    const automation = {
      id: 'win-e2e', name: 'Windows check', enabled: false, createdAt: Date.now(), project: root, folder: '',
      source: { connector: 'clickup', scopes: ['901500000301'] }, conditions: [{ field: 'status', values: ['to do'] }],
      claude: { account: 'default', model: 'haiku', mode: 'auto', decideAlone: true, useSourceMcp: false },
      isolation: { worktree: true, base: 'default' }, instructions: 'Follow the task to the letter.',
      limits: { concurrent: 1, perDay: 5, checkEveryMin: 1, usagePause: null }, rerunWhenMatchesAgain: false
    };
    await win.evaluate((a) => (window as unknown as { atelier: { automations: { save(a: unknown): Promise<unknown> } } }).atelier.automations.save(a), automation);
    await win.evaluate('window.atelier.automations.turnOn("win-e2e", false)');
    await fake.addTask({ id: '86fkwin01', customId: 'ENG-900', name: 'Check the session guard', status: 'to do', listId: '901500000301', markdown: TASK });
    await win.evaluate('window.atelier.automations.checkNow("win-e2e")');

    type View = { automations: { automation: { id: string }; runs: { id: string; state: string; branch?: string; worktree?: string; reason?: string; terminalId?: string }[] }[] };
    const run = async () => ((await win!.evaluate('window.atelier.automations.list()')) as View).automations.find((v) => v.automation.id === 'win-e2e')?.runs[0];
    await expect.poll(async () => (await run())?.state, { timeout: 60000 }).toMatch(/starting|working|review/);
    const started = (await run())!;
    expect(started.reason ?? '').not.toMatch(/Couldn't|isn't/);
    expect(started.branch).toMatch(/^auto\/eng-900/);
    // The worktree folder is the short Windows one.
    expect(slash(started.worktree!).toLowerCase()).toBe(`${root}/.claude/worktrees/auto-eng-900-check-the`.toLowerCase());
    await win.locator('.activity-bar button[aria-label^="Sessions"]').click();
    await win.locator('.session-row', { hasText: 'ENG-900' }).click();
    await expect(win.locator('.au-strip')).toContainText('Windows check', { timeout: 30000 });
    await win.screenshot({ path: join(SHOTS, 'working.png') });
    await expect.poll(async () => (await run())?.state, { timeout: 480000, intervals: [5000] }).toBe('review');
    await win.screenshot({ path: join(SHOTS, 'review.png') });

    // What Claude saw from its own Bash tool, committed on its branch.
    const branch = started.branch!;
    const results = git(root, 'show', `${branch}:results.txt`);
    console.log(`--- results.txt\n${results}\n---`);
    expect(results).toMatch(/\bfunction\b/);
    expect(results).toContain(branch);
    expect(slash(results)).toMatch(/automations\/guard/);
    // Nothing reached the checkout, main, the remote or the user's stash.
    expect(git(root, 'rev-parse', 'main')).toBe(mainOid);
    expect(git(root, 'rev-parse', 'refs/stash')).toBe(stashOid);
    expect(git(root, 'status', '--porcelain', '--untracked-files=no')).toBe('');
    expect(() => git(join(base, 'remote.git'), 'rev-parse', '--verify', '-q', `refs/heads/${branch}`)).toThrow();
    // Its branch tracks nothing (--no-track): a plain push could never reach main.
    expect(() => git(root, 'rev-parse', '--abbrev-ref', `${branch}@{u}`)).toThrow();

    // Close Run removes the clean worktree; the branch stays.
    const closed = await win.evaluate((id) => (window as unknown as { atelier: { automations: { closeRun(id: string, rm: boolean): Promise<{ outcome: string; message?: string }> } } }).atelier.automations.closeRun(id, true), started.id);
    console.log(`close: ${JSON.stringify({ outcome: closed.outcome, message: closed.message })}`);
    expect(closed.outcome).toBe('ok');
    expect(existsSync(started.worktree!)).toBe(false);
    expect(git(root, 'branch', '--list', branch)).toContain(branch);
    await win.screenshot({ path: join(SHOTS, 'closed.png') });
    // The launch files went when the run ended.
    expect(existsSync(join(home, 'automations', 'runs', started.id, 'prompt.md'))).toBe(false);
  } finally {
    if (win) await win.screenshot({ path: join(SHOTS, 'last.png') }).catch(() => {});
    // A close that hangs (a session's terminal still open) must not hold the test: the app's tree goes.
    const closed = await Promise.race([app.close().then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), 15000))]);
    if (!closed) try { execFileSync('taskkill', ['/T', '/F', '/PID', String(app.process().pid)]); } catch { /* gone */ }
    // atelierd with its whole tree: a session left open (a failed check) holds the worktree's folder otherwise.
    try { execFileSync('taskkill', ['/T', '/F', '/PID', String((JSON.parse(readFileSync(join(home, 'atelierd.json'), 'utf8')) as { pid: number }).pid)]); } catch { /* already stopped */ }
    fake.close();
    try { rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }); } catch (e) { console.log(`left ${base}: ${(e as Error).message}`); }
  }
});
