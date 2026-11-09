import { _electron as electron, expect, test, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { e2eEnv, writePrefs } from './env';
import { READ_TOOLS, startFake } from './fake-clickup-cli';
import { look } from './shots';

// Automations: created in the editor, turned on through the consent sheet, a task added to
// the fake ClickUp starts a run in a worktree of its own, the session shows it, and the git guard refuses a merge into
// the project's checkout and a push — from inside the real launch. Fake Claude: tests/e2e/fake-claude-auto.pl.

/** Looked at by hand (git-ignored). */
const SHOTS = resolve('e2e-shots/automations');
const still = (win: Page) => win.addStyleTag({ content: '*, *::before, *::after { animation: none !important; transition: none !important; } .xterm-cursor-layer { display: none !important; }' });

const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.test', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.test' };
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env: gitEnv, encoding: 'utf8' }).trim();

/** A project with a bare remote and one commit on main. */
function project(): string {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'atl-auto-')));
  const root = join(base, 'acme');
  git(base, 'init', '-q', '--bare', '-b', 'main', join(base, 'remote.git'));
  git(base, 'init', '-q', '-b', 'main', root);
  writeFileSync(join(root, 'README.md'), '# acme\n');
  mkdirSync(join(root, 'packages', 'api'), { recursive: true });
  writeFileSync(join(root, 'packages', 'api', 'index.ts'), 'export {};\n');
  writeFileSync(join(root, '.gitignore'), '.claude/worktrees/\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'base');
  git(root, 'remote', 'add', 'origin', join(base, 'remote.git'));
  git(root, 'push', '-q', '-u', 'origin', 'main');
  return root;
}

const logLines = (file: string) => (existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean) : []);

test('automations: create, turn on, a new task starts a guarded run in its own worktree', async () => {
  test.setTimeout(150_000);
  mkdirSync(SHOTS, { recursive: true });
  const fake = await startFake();
  await fake.scenario('compact');
  const root = project();
  const base = realpathSync(join(root, '..'));
  const claudeHome = join(base, 'claude-home');
  mkdirSync(claudeHome, { recursive: true });
  // Claude Code trusts the project (its trust dialog was accepted once): the worktree inherits it. ClickUp is connected
  // from claude.ai for this account.
  writeFileSync(join(claudeHome, '.claude.json'), JSON.stringify({ projects: { [root]: { hasTrustDialogAccepted: true } }, claudeAiMcpEverConnected: ['claude.ai ClickUp'] }));
  const autoLog = join(base, 'auto.log');
  const { env, home } = e2eEnv({
    ATELIER_CLAUDE_BIN: resolve('tests/e2e/fake-claude-auto.pl'), ATELIER_TEST_CLICKUP_URL: fake.url, ATELIER_TEST_FOLLOW_AUTH: '1',
    ATELIER_TEST_CLAUDE_HOME: claudeHome, ATELIER_TEST_AUTO_LOG: autoLog, ATELIER_TEST_GIT_ISOLATED: '1'
  });
  writePrefs(home, { automationsEnabled: true });
  const app = await electron.launch({ args: ['out/main/index.js', `--project=${root}`], env });
  try {
    const win = await app.firstWindow();
    await expect(win.locator('.footer')).toBeVisible({ timeout: 15000 });
    await still(win);
    await win.evaluate('window.atelier.connectors.connect("clickup")');
    await expect.poll(() => win.evaluate('window.atelier.connectors.list().then((r) => r.connectors[0] && r.connectors[0].status)'), { timeout: 15000 }).toBe('connected');

    // The view: empty for this project, with New Automation.
    await win.locator('.activity-bar button[aria-label^="Automations"]').click();
    const side = win.locator('.au-side');
    await expect(side.getByText('No automations in this project yet.')).toBeVisible();
    await side.getByRole('button', { name: 'New Automation' }).first().click();

    // The editor: a list, a condition, the live preview.
    const sheet = win.getByRole('dialog', { name: 'New automation' });
    await expect(sheet).toBeVisible();
    await sheet.locator('input.ae-input.is-wide').fill('Fix to-do tasks');
    // Where to watch: a searchable popover of the workspace's lists. Esc closes it only.
    await sheet.getByRole('button', { name: 'Add List…' }).click();
    const lists = win.locator('.ae-pop');
    await lists.getByRole('combobox', { name: 'Search lists' }).press('Escape');
    await expect(lists).toHaveCount(0);
    await expect(sheet).toBeVisible();
    await expect(sheet.getByRole('button', { name: 'Add List…' })).toBeFocused();
    await sheet.getByRole('button', { name: 'Add List…' }).click();
    await lists.getByRole('combobox', { name: 'Search lists' }).fill('sprint');
    await expect(lists.getByRole('option')).toHaveText(['Engineering › Platform › Sprint 42']);
    await lists.getByRole('combobox', { name: 'Search lists' }).press('Enter');
    await expect(sheet.locator('.ae-scope')).toHaveText(['Engineering › Platform › Sprint 42']);
    await expect(sheet.getByRole('button', { name: 'Add List…' })).toBeFocused();
    await sheet.getByRole('button', { name: 'Add Condition' }).click();
    // Status as chips: the source's statuses suggested, one typed by hand too.
    const status = sheet.locator('.ae-cond').nth(0);
    const values = status.locator('.ae-vchips-input');
    await values.click();
    const pop = win.locator('.ae-pop');
    await expect(pop.getByRole('option', { name: /^review/ })).toBeVisible({ timeout: 10000 });
    await values.fill('to');
    await expect(pop.getByRole('option')).toHaveText([/^to do/, 'Add “to”']);
    await look(win, join(SHOTS, 'editor-chips.png'));
    await values.press('Enter');
    await values.fill('Ready for QA');
    await values.press(',');
    await expect(status.locator('.ae-vchip')).toHaveText(['to do', 'Ready for QA']);
    // Esc closes the popover only; a second Esc would close the sheet.
    await values.press('Escape');
    await expect(pop).toHaveCount(0);
    await expect(sheet).toBeVisible();
    await expect(sheet.locator('.ae-match').first()).toContainText('ENG-104', { timeout: 10000 });
    // People by name: Me to start with, Grace from the tasks ClickUp gave.
    await sheet.getByRole('button', { name: 'Add Condition' }).click();
    const people = sheet.locator('.ae-cond').nth(1);
    await people.locator('select').selectOption({ label: 'Assigned to' });
    await expect(people.locator('.ae-vchip')).toHaveText(['Me']);
    await people.locator('.ae-vchips-input').fill('gra');
    await expect(pop.getByRole('option')).toHaveText([/^Grace Fake/]);
    await people.locator('.ae-vchips-input').press('Enter');
    await expect(people.locator('.ae-vchip')).toHaveText(['Me', 'Grace Fake']);
    await people.locator('.ae-vchips-input').fill('zed');
    await expect(pop).toContainText('No one with that name in these tasks');
    await people.locator('.ae-vchips-input').fill('');
    await people.locator('.ae-vchips-input').press('Escape');
    // The folder from a popover of the project's folders; a typed path is offered as it is; Esc keeps the sheet.
    const folder = sheet.getByRole('button', { name: /^Folder: / });
    await expect(folder).toHaveText(/acme\//);
    await folder.click();
    const search = pop.getByRole('combobox', { name: 'Search folders' });
    await expect(search).toBeFocused();
    await expect(pop.getByRole('option')).toHaveText([/^acme/, /^packages\/$/, /^packages\/api\/$/]);
    await search.fill('api');
    await expect(pop.getByRole('option')).toHaveText([/^packages\/api\//, 'Use “api/”']);
    await search.fill('packages/web');
    await expect(pop.getByRole('option')).toHaveText(['Use “packages/web/”']);
    await look(win, join(SHOTS, 'editor-folder.png'));
    await search.press('Escape');
    await expect(pop).toHaveCount(0);
    await expect(sheet).toBeVisible();
    await expect(folder).toBeFocused();
    await expect(folder).toHaveText(/acme\/$/);
    // Picked from the list (the project's root again afterwards: the run starts there).
    await folder.press('ArrowDown');
    await search.fill('api');
    await search.press('Enter');
    await expect(folder).toHaveText(/acme\/packages\/api$/);
    await folder.click();
    await search.fill('./');
    await search.press('Enter');
    await expect(folder).toHaveText(/acme\/$/);
    // Tab closes it and moves on to the next field of the sheet (the popover sits at the end of the page).
    await folder.click();
    await search.press('Tab');
    await expect(pop).toHaveCount(0);
    expect(await win.evaluate(() => {
      const el = document.activeElement;
      return !!el?.closest('[role="dialog"]') && !el.classList.contains('ae-folder');
    })).toBe(true);
    await expect(sheet.locator('.ae-code')).toContainText('# Atelier makes the worktree from the default branch');
    await expect(sheet.locator('.ae-mcp')).toContainText('claude.ai ClickUp in Claude Code');
    await sheet.locator('.ae-mcp').scrollIntoViewIfNeeded();
    await look(win, join(SHOTS, 'editor-safety.png'));
    await sheet.locator('input.ae-input.is-wide').scrollIntoViewIfNeeded();
    await look(win, join(SHOTS, 'editor.png'));
    await sheet.getByRole('button', { name: 'Save and Turn On…' }).click();

    // Turn On: what it will do; the task matching now is not started.
    const consent = win.getByRole('dialog', { name: 'Turn on automation' });
    await expect(consent).toContainText('Let “Fix to-do tasks” start Claude by itself?');
    await expect(consent).toContainText('Anyone who can add tasks there can start Claude on your Mac');
    await expect(consent.getByText('Also start the 1 task that match right now')).toBeVisible();
    await look(win, join(SHOTS, 'consent.png'));
    await consent.getByRole('button', { name: 'Turn On' }).click();
    await expect(win.locator('.au-card')).toContainText('Fix to-do tasks');
    await expect(win.locator('.au-card')).toContainText('status to do or Ready for QA · assigned to you or Grace Fake');
    await expect(win.locator('.au-card .switch')).toHaveAttribute('aria-checked', 'true');

    // A new task: Check Now starts its run.
    await fake.addTask({ id: '86fk0200z', customId: 'ENG-200', name: 'Fix rounding in totals', status: 'to do', listId: '901500000301', markdown: 'Totals are off by a cent.' });
    await win.locator('.au-view').getByRole('button', { name: 'Check Now' }).click();
    const row = win.locator('.au-run', { hasText: 'ENG-200' });
    await expect(row).toBeVisible({ timeout: 15000 });
    await expect(row.locator('.au-wt')).toHaveText('auto/eng-200-fix-rounding-in-totals', { timeout: 15000 });
    // The table's columns line up: each heading starts where its cells do, whatever buttons a row has.
    await expect.poll(async () => {
      const head = await win.locator('.au-run.is-head > *').evaluateAll((els) => els.slice(0, 5).map((e) => Math.round(e.getBoundingClientRect().left)));
      const cells = await row.locator(':scope > *').evaluateAll((els) => els.slice(0, 5).map((e) => Math.round(e.getBoundingClientRect().left)));
      return JSON.stringify(head) === JSON.stringify(cells);
    }, { timeout: 10000 }).toBe(true);
    // A long branch stays inside its column, cut with an ellipsis, its pill whole.
    const fit = await row.evaluate((r) => {
      const chip = r.querySelector('.au-wt')!.getBoundingClientRect();
      const cell = r.querySelector('.au-run-wt')!.getBoundingClientRect();
      const s = getComputedStyle(r.querySelector('.au-wt')!);
      return { inside: chip.right <= cell.right + 0.5, ellipsis: s.textOverflow === 'ellipsis' && s.display !== 'inline-flex' };
    });
    expect(fit).toEqual({ inside: true, ellipsis: true });
    // A narrow view (a smaller window; Changes, Sessions' own) keeps task,
    // state and worktree: time and cost go.
    const size = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.getContentSize());
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(1000, 800));
    await expect(win.locator('.au-run.is-head').getByText('Time', { exact: true })).toBeHidden();
    await expect(row.locator('.au-num').first()).toBeHidden();
    await expect.poll(() => row.locator('.au-wt').evaluate((e) => Math.round(e.getBoundingClientRect().width))).toBeGreaterThan(90);
    await app.evaluate(({ BrowserWindow }, s) => BrowserWindow.getAllWindows()[0]!.setContentSize(s[0]!, s[1]!), size);
    await expect(win.locator('.au-run.is-head').getByText('Time', { exact: true })).toBeVisible();

    // The fake Claude ran in the worktree, guarded: the merge into the checkout and the push were refused.
    await expect.poll(() => logLines(autoLog).some((l) => l.startsWith('PUSH ')), { timeout: 30000 }).toBe(true);
    const log = logLines(autoLog);
    const wt = join(root, '.claude', 'worktrees', 'auto-eng-200-fix-rounding-in-totals');
    expect(log).toContain(`CWD ${wt}`);
    expect(log).toContain('BRANCH auto/eng-200-fix-rounding-in-totals');
    expect(log).toContain('RUNBRANCH auto/eng-200-fix-rounding-in-totals');
    expect(log.find((l) => l.startsWith('COMMIT '))).toMatch(/^COMMIT 0 /);
    const merge = log.find((l) => l.startsWith('MERGE '))!;
    expect(merge).not.toMatch(/^MERGE 0 /);
    expect(merge).toContain('Atelier: an automated session works only in its own worktree');
    // Refused before git touched anything: the project's checkout has nothing staged or changed.
    expect(git(root, 'status', '--porcelain', '--untracked-files=no')).toBe('');
    expect(log.find((l) => l.startsWith('PUSH '))).not.toMatch(/^PUSH 0 /);
    const args = log.find((l) => l.startsWith('ARGS '))!.slice(5).split('\x1f');
    expect(args).toContain('--disallowedTools');
    expect(args).toContain('Bash(git merge *)');
    expect(args).toContain('mcp__claude_ai_ClickUp');
    expect(args.at(-1)).toContain('ClickUp task ENG-200: Fix rounding in totals');
    expect(args.at(-1)).toContain('Totals are off by a cent.');
    expect(git(root, 'rev-parse', 'main')).toBe(git(root, 'rev-parse', 'origin/main'));
    expect(git(join(base, 'remote.git'), 'branch', '--list', 'auto/*')).toBe('');
    // The launch files are gone once Claude started.
    await expect.poll(() => (existsSync(join(home, 'automations', 'runs')) ? readdirSync(join(home, 'automations', 'runs')).length : 0), { timeout: 70000 }).toBe(0);

    // The run reaches review; its session shows the strip.
    await expect(row.locator('.au-chip')).toHaveText('Ready for review', { timeout: 15000 });
    await look(win, join(SHOTS, 'view.png'));
    await row.getByRole('button', { name: 'Review' }).click();
    await expect(win.locator('.au-strip.is-done')).toBeVisible();
    await expect(win.locator('.session-row.is-selected .av-auto')).toBeVisible();
    await look(win, join(SHOTS, 'session.png'));

    // Close Run: the session closes, the clean worktree goes, the branch stays.
    await win.locator('.au-strip').getByRole('button', { name: 'Close Run…' }).click();
    const closing = win.getByRole('dialog', { name: 'Close run' });
    await expect(closing).toContainText('Close ENG-200?');
    await expect(closing.getByRole('checkbox')).toBeChecked();
    await look(win, join(SHOTS, 'close-run.png'));
    await closing.getByRole('button', { name: 'Close Run' }).click();
    await expect(win.getByText('Run closed · worktree removed')).toBeVisible({ timeout: 15000 });
    expect(existsSync(wt)).toBe(false);
    expect(git(root, 'branch', '--list', 'auto/eng-200-fix-rounding-in-totals')).toContain('auto/eng-200-fix-rounding-in-totals');
    await expect(win.locator('.session-row .av-auto')).toHaveCount(0);
    await win.locator('.activity-bar button[aria-label^="Automations"]').click();
    await expect(row.locator('.au-chip')).toHaveText('Closed');
    await expect(row.getByRole('button', { name: 'Close Run…' })).toHaveCount(0);

    // Delete asks in the automation's header, never the browser's confirm(): Esc keeps it.
    let browserConfirm = false;
    win.on('dialog', (d) => { browserConfirm = true; void d.dismiss(); });
    await win.locator('.au-delete').click();
    const asking = win.locator('.au-head.is-confirming');
    await expect(asking).toContainText(/Delete “.+”\?/);
    await expect(asking).toContainText('Its runs stay as sessions; the history goes.');
    await expect(asking.getByRole('button', { name: /^Cancel/ })).toBeFocused();
    await look(win, join(SHOTS, 'delete-confirm.png'), { settle: 300 });
    await win.keyboard.press('Escape');
    await expect(asking).toHaveCount(0);
    await expect(win.locator('.au-delete')).toHaveCount(1);
    await win.locator('.au-delete').click();
    await asking.getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(win.locator('.au-delete')).toHaveCount(0, { timeout: 10000 });
    expect(browserConfirm).toBe(false);

    // Read-only: never another tool.
    expect((await fake.calls()).filter((n) => !READ_TOOLS.includes(n))).toEqual([]);
  } finally {
    await app.close();
    try { process.kill((JSON.parse(readFileSync(join(home, 'atelierd.json'), 'utf8')) as { pid: number }).pid, 'SIGTERM'); } catch { /* already stopped */ }
    fake.close();
  }
});
