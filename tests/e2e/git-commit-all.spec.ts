import { expect, test } from '@playwright/test';
import { chmodSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { e2eEnv } from './env';
import { groupChanges } from './changes-filters';
import { git, gitWritesProject, hookMarker, launchGitApp, write } from './git-writes-fixture';
import { look } from './shots';

// Commit all: "Commit <session>'s Work…" across three repositories opens the sheet
// with ✦ Write All started (at most two at a time, a fake claude streaming), the commits run one at a time, a
// pre-commit hook failing in one leaves "2 of 3 committed" with its log, Retry after fixing it commits the third, and
// Push after committing then pushes all three to their bare remotes (one branch without an upstream is published).

const NAMES = ['acme-store', 'billing', 'plugins/payments'];
const FILES = { 'src/cart.ts': 'cart 1\n', 'src/invoice.ts': 'invoice 1\n', 'src/pay.ts': 'pay 1\n', 'src/notes.ts': 'notes 1\n' };
/** The fixture's pre-commit, held while .git/hold exists (a commit caught running). */
const HELD_HOOK = `#!/bin/sh
while [ -f .git/hold ]; do sleep 0.1; done
if [ -f .git/hook-fail ]; then
  echo "lint: src/cart.ts:1 missing semicolon"
  echo "lint: 1 problem (1 error)" >&2
  exit 1
fi
exit 0
`;

test('Commit <session>\'s Work… across three repositories: ✦ Write All, a failing hook, Retry, Push after committing', async () => {
  const p = gitWritesProject(NAMES, FILES, { hook: true, remote: true });
  // plugins/payments works on a branch never pushed: Push publishes it to its only remote.
  git(p.repo('plugins/payments'), 'switch', '-q', '-c', 'feature/pay');
  const edits = [join(p.repo('acme-store'), 'src/cart.ts'), join(p.repo('billing'), 'src/invoice.ts'), join(p.repo('plugins/payments'), 'src/pay.ts')];
  const messageLog = join(mkdtempSync(join(tmpdir(), 'atl-msg-')), 'inputs.log');
  const appEnv = e2eEnv({
    ATELIER_CLAUDE_BIN: resolve('tests/e2e/fake-claude-edit.pl'), ATELIER_FAKE_EDIT: edits.join(':'),
    ATELIER_TEST_MESSAGE_CLAUDE: resolve('tests/e2e/fake-claude-message.mjs'), ATELIER_TEST_MESSAGE_LOG: messageLog
  });
  const s = await launchGitApp(p.root, undefined, appEnv);
  const hold = join(p.repo('billing'), '.git', 'hold');
  try {
    await expect(s.panel).toContainText('All clean · 3 repos', { timeout: 10000 });
    for (const f of edits) write(f, `${f.split('/').pop()} 2\n`);
    // Not the session's: it stays out of its commit.
    write(join(p.repo('billing'), 'src/notes.ts'), 'notes 2\n');
    await expect(s.panel.locator('.change-row')).toHaveCount(4, { timeout: 8000 });
    await s.win.locator('.btn-new').click();
    await s.win.getByRole('menuitem', { name: 'Claude Session' }).click();
    await s.win.getByPlaceholder('Session name (optional)').fill('auth-refactor');
    await s.win.keyboard.press('Enter');
    await expect(s.panel.locator('.change-row', { hasText: 'pay.ts' }).locator('.dot:not(.unknown)')).toHaveCount(1, { timeout: 15000 });
    // billing's pre-commit waits while .git/hold exists, then fails until the fail marker goes.
    write(join(p.repo('billing'), '.git', 'hooks', 'pre-commit'), HELD_HOOK);
    chmodSync(join(p.repo('billing'), '.git', 'hooks', 'pre-commit'), 0o755);
    hookMarker(p.repo('billing'), 'fail', true);

    // How many cards ✦ writes at once and what its line says, sampled while it runs (it is over within a second).
    await s.win.evaluate(() => {
      const w = window as unknown as { maxWriting: number; written: string[] };
      w.maxWriting = 0;
      w.written = [];
      setInterval(() => {
        w.maxWriting = Math.max(w.maxWriting, document.querySelectorAll('.commit-all-card.is-writing').length);
        const line = document.querySelector('.commit-all-written')?.textContent;
        if (line && !w.written.includes(line)) w.written.push(line);
      }, 10);
    });

    // By session, the header's menu: Commit auth-refactor's Work….
    await groupChanges(s.panel, 'session');
    await s.panel.locator('.change-group-head', { hasText: 'auth-refactor' }).click({ button: 'right' });
    await s.win.getByRole('menuitem', { name: "Commit auth-refactor's Work…" }).click();

    const sheet = s.win.getByRole('dialog', { name: 'Commit 3 repositories' });
    await expect(sheet).toBeVisible();
    const cards = sheet.locator('.commit-all-card');
    await expect(cards).toHaveCount(3);
    // In Changes' order, each with its branch and counts.
    await expect(cards.locator('.commit-all-path')).toHaveText(['acme-store', 'billing', 'plugins/payments']);
    await expect(cards.nth(2).locator('.commit-all-branch')).toHaveText('feature/pay');
    await expect(cards.nth(0).locator('.commit-all-counts')).toHaveText('1 file · +1 −1');
    await expect(sheet.locator('.commit-all-sub .avatar')).toBeVisible();
    await expect(sheet.locator('.commit-all-sub > span:last-child')).toHaveText("auth-refactor's work · 3 files");
    // billing's notes.ts was not the session's: it stayed unstaged.
    expect(git(p.repo('billing'), 'diff', '--cached', '--name-only').trim()).toBe('src/invoice.ts');

    // ✦ Write All started by itself: "N of 3 written" while it ran, then the messages are in.
    const field = (i: number) => cards.nth(i).locator('textarea');
    await expect(field(0)).toHaveValue(/^feat\(cart\): update cart/, { timeout: 15000 });
    await expect(field(1)).toHaveValue(/^feat\(invoice\): update invoice/, { timeout: 15000 });
    await expect(field(2)).toHaveValue(/^feat\(pay\): update pay/, { timeout: 15000 });
    await expect(sheet.locator('.commit-all-written')).toHaveCount(0);
    const sampled = await s.win.evaluate(() => { const w = window as unknown as { maxWriting: number; written: string[] }; return { max: w.maxWriting, written: w.written }; });
    // Two finishing together can leave "1 of 3" on screen for a few milliseconds only: not always sampled.
    expect(sampled.written[0]).toBe('0 of 3 written');
    expect(sampled.written.every((x, i) => /^[0-2] of 3 written$/.test(x) && (i === 0 || x > sampled.written[i - 1]!))).toBe(true);
    expect(sampled.written.at(-1)).toBe('2 of 3 written');
    expect(sampled.max).toBe(2);
    // Each repository's own staged diff went to ✦, never another's, never the unstaged notes.ts.
    const inputs = readFileSync(messageLog, 'utf8').split('----- end of input -----').filter((x) => x.trim());
    expect(inputs).toHaveLength(3);
    expect(inputs.filter((x) => x.includes('src/invoice.ts'))).toHaveLength(1);
    expect(inputs.join('')).not.toContain('notes.ts');

    // Tab moves between the messages.
    await field(0).focus();
    await s.win.keyboard.press('Tab');
    await expect(field(1)).toBeFocused();

    // The footer's toggles: Push after committing on (remembered); the button names the count.
    const pushAfter = sheet.getByRole('button', { name: 'Push after committing' });
    await expect(pushAfter).toHaveAttribute('aria-pressed', 'false');
    await pushAfter.click();
    await expect(pushAfter).toHaveAttribute('aria-pressed', 'true');
    await expect(sheet.getByRole('button', { name: 'Co-authored-by Claude' })).toHaveAttribute('aria-pressed', 'true');
    await expect(sheet.locator('.commit-all-go')).toContainText('Commit 3 Repositories');
    await expect(sheet).toContainText('Each repository commits on its own: if one fails, the others keep their commit.');
    await s.win.mouse.move(5, 5);
    await look(s.win, 'test-results/git-commit-all.png');

    // ⌘↵ commits, one repository at a time: acme-store, then billing's hook runs (held).
    write(hold, '');
    await s.win.keyboard.press('Meta+Enter');
    await expect(sheet.locator('.commit-all-progress')).toBeVisible();
    const rows = sheet.locator('.commit-all-row');
    await expect(rows.nth(0)).toHaveClass(/is-committed/, { timeout: 10000 });
    await expect(rows.nth(1)).toHaveClass(/is-running/);
    await expect(rows.nth(1).locator('.commit-all-row-text')).toHaveText('Running pre-commit', { timeout: 10000 });
    await expect(rows.nth(2)).toHaveClass(/is-waiting/);
    await expect(sheet.locator('.commit-all-count')).toHaveText('1 of 3');
    // Closing keeps it running: the commit bar says so and reopens it.
    await s.win.keyboard.press('Escape');
    await expect(sheet).toHaveCount(0);
    await expect(s.panel.locator('.git-bar')).toHaveText('Committing 2 of 3…');
    await s.panel.locator('.git-bar-main').click();
    await expect(sheet).toBeVisible();
    // billing's hook fails; the others keep their commit.
    rmSync(hold);
    await expect(sheet.locator('.commit-all-summary')).toHaveText('2 of 3 committed', { timeout: 20000 });
    await expect(rows.nth(0)).toHaveClass(/is-committed/);
    await expect(rows.nth(1)).toHaveClass(/is-failed/);
    await expect(rows.nth(2)).toHaveClass(/is-committed/);
    expect(git(p.repo('acme-store'), 'log', '-1', '--format=%s').trim()).toBe('feat(cart): update cart');
    expect(git(p.repo('acme-store'), 'log', '-1', '--format=%B')).toContain('Co-Authored-By: Claude <noreply@anthropic.com>');
    expect(git(p.repo('billing'), 'log', '-1', '--format=%s').trim()).toBe('chore: start billing');
    // The failed row is open: the hook's first lines, Full log, Ask auth-refactor to Fix, Commit Without Hooks, Retry.
    const failed = rows.nth(1);
    await expect(failed.locator('.commit-all-log')).toContainText('lint: src/cart.ts:1 missing semicolon');
    await expect(failed.getByRole('button', { name: 'Full log' })).toBeVisible();
    await expect(failed.getByRole('button', { name: 'Ask auth-refactor to Fix' })).toBeVisible();
    await expect(failed.getByRole('button', { name: 'Commit Without Hooks' })).toBeVisible();
    // Not every repository committed: nothing was pushed, the push waits for you.
    await expect(sheet.getByRole('button', { name: 'Push 2 Repositories' })).toBeVisible();
    await expect(sheet.getByRole('button', { name: 'Undo All 2' })).toBeVisible();
    expect(git(p.remote('acme-store'), 'log', '-1', '--format=%s', 'main').trim()).toBe('chore: start acme-store');
    await s.win.mouse.move(5, 5);
    await look(s.win, 'test-results/git-commit-all-results.png');

    // Fixed: Retry commits billing alone with the same message; every repository committed, so they push.
    hookMarker(p.repo('billing'), 'fail', false);
    await failed.getByRole('button', { name: 'Retry' }).click();
    await expect(sheet.locator('.commit-all-summary')).toHaveText('3 of 3 committed', { timeout: 20000 });
    expect(git(p.repo('billing'), 'log', '-1', '--format=%s').trim()).toBe('feat(invoice): update invoice');
    await expect(rows.locator('.commit-all-pushed')).toHaveCount(3, { timeout: 20000 });
    await expect(rows.nth(2).locator('.commit-all-pushed')).toHaveText('Published to origin/feature/pay');
    for (const [name, branch, subject] of [['acme-store', 'main', 'feat(cart): update cart'], ['billing', 'main', 'feat(invoice): update invoice'], ['plugins/payments', 'feature/pay', 'feat(pay): update pay']] as const) {
      expect(git(p.remote(name), 'log', '-1', '--format=%s', branch).trim()).toBe(subject);
    }
    expect(git(p.repo('plugins/payments'), 'rev-parse', '--abbrev-ref', '@{u}').trim()).toBe('origin/feature/pay');

    // Done: closing forgets it; Push after committing is remembered for next time.
    await sheet.getByRole('button', { name: 'Done' }).click();
    await expect(sheet).toHaveCount(0);
    await expect.poll(() => s.win.evaluate(() => JSON.parse(localStorage.getItem('atelier.gitPrefs') ?? '{}').pushAfter)).toBe(true);
  } finally {
    // A failure mid-run never leaves the hook waiting: quitting with a commit running asks first, and that would block.
    rmSync(hold, { force: true });
    await s.win.waitForFunction(() => !document.querySelector('.git-bar.is-running, .commit-all-row.is-running'), null, { timeout: 15000 }).catch(() => {});
    await s.stop();
  }
});
