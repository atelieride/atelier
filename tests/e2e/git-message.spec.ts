import { expect, test } from '@playwright/test';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { e2eEnv } from './env';
import { git, gitWritesProject, launchGitApp, write } from './git-writes-fixture';
import { look } from './shots';

// ✦ in the commit drawer: with a fake claude streaming slowly, the text streams into
// the field a chunk at a time, Esc stops it (the drawer stays, the partial text is kept), the sparkle writes again,
// ↻ rewrites, a tweak rewrites once, ⌘Z brings back the text before ✦ in one step, staging meanwhile offers Rewrite,
// the next repository's empty field glows; what ✦ was given holds the staged diff and the session's prompts and never
// a .env file's content; Messages with Claude Off hides the sparkle.

const SESSION = '5e551011-aaaa-4bbb-8ccc-0123456789ab';
const SECRET = 'sk-live-FAKE-0123456789abcdef';
const BODY = "\n\nKeep src/cart.ts in step with the session's work.";

test('✦ streams into the field, stops, rewrites, tweaks; ⌘Z is one step; its input; Off hides it', async () => {
  const p = gitWritesProject(['acme-store', 'billing'], { 'src/cart.ts': 'cart 1\n', 'src/totals.ts': 'totals 1\n', 'src/invoice.ts': 'invoice 1\n' });
  const cart = join(p.repo('acme-store'), 'src/cart.ts');
  const tmp = mkdtempSync(join(tmpdir(), 'atl-msg-'));
  const messageLog = join(tmp, 'inputs.log');
  // The session's transcript, where main reads what it was asked (its cwd encoded as Claude Code does).
  const projects = join(tmp, 'claude-projects');
  const line = (o: object) => JSON.stringify(o) + '\n';
  for (const cwd of new Set([p.root, realpathSync(p.root)])) {
    const dir = join(projects, cwd.replace(/[^a-zA-Z0-9]/g, '-'));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${SESSION}.jsonl`),
      line({ type: 'user', sessionId: SESSION, cwd, message: { role: 'user', content: 'Make the cart total round half up' } })
      + line({ type: 'assistant', sessionId: SESSION, cwd, message: { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] } })
      + line({ type: 'user', sessionId: SESSION, cwd, message: { role: 'user', content: 'Also show the rounding in the cart summary' } }));
  }
  const appEnv = e2eEnv({
    ATELIER_CLAUDE_BIN: resolve('tests/e2e/fake-claude-edit.pl'), ATELIER_FAKE_EDIT: cart, ATELIER_FAKE_SESSION_ID: SESSION,
    ATELIER_TEST_CLAUDE_PROJECTS: projects,
    ATELIER_TEST_MESSAGE_CLAUDE: resolve('tests/e2e/fake-claude-message.mjs'), ATELIER_TEST_MESSAGE_LOG: messageLog,
    // Slow only where it matters: take 1 is stopped midway, takes 2 and 4 are seen streaming, take 7 is staged against
    // while it writes.
    ATELIER_TEST_MESSAGE_DELAY: '700', ATELIER_TEST_MESSAGE_SLOW_TAKES: '1,2,4,7', ATELIER_TEST_MESSAGE_TAKES: '1'
  });
  const s = await launchGitApp(p.root, undefined, appEnv);
  const drawer = s.panel.locator('.git-drawer');
  const field = s.panel.getByRole('textbox', { name: 'Commit message' });
  const sparkle = drawer.locator('.git-sparkle');
  const stream = drawer.locator('.git-msg-stream');
  const meta = drawer.locator('.git-write-meta');
  try {
    await expect(s.panel).toContainText('All clean · 2 repos', { timeout: 10000 });
    write(cart, 'cart 2\n');
    write(join(p.repo('acme-store'), '.env'), `API_KEY=${SECRET}\n`);
    write(join(p.repo('billing'), 'src/invoice.ts'), 'invoice 2\n');
    await expect(s.panel.locator('.change-row')).toHaveCount(3, { timeout: 8000 });
    await s.win.locator('.btn-new').click();
    await s.win.getByRole('menuitem', { name: 'Claude Session' }).click();
    await s.win.getByPlaceholder('Session name (optional)').fill('auth-refactor');
    await s.win.keyboard.press('Enter');
    await expect(s.panel.locator('.change-row', { hasText: 'cart.ts' }).locator('.dot:not(.unknown)')).toHaveCount(1, { timeout: 15000 });
    git(p.repo('acme-store'), 'add', 'src/cart.ts', '.env');
    git(p.repo('billing'), 'add', 'src/invoice.ts');
    await expect(s.panel.locator('.git-bar')).toHaveText('Commit3in 2 repositories', { timeout: 8000 });

    // The drawer on acme-store (the most staged): the field empty, the sparkle glows.
    await s.command('git-commit');
    await expect(drawer.locator('.git-chip')).toHaveText(/acme-store/);
    await expect(sparkle).toHaveAttribute('aria-label', 'Write with Claude');
    await expect(sparkle).toHaveClass(/is-glow/);
    await look(drawer, 'test-results/git-message-glow.png');

    // ⌥⌘M (Git › Write Commit Message with Claude): the text streams in a chunk at a time; Stop.
    await s.command('git-write-message');
    await expect(stream).toHaveText('feat(cart): ', { timeout: 5000 });
    await expect(stream).toHaveClass(/is-writing/);
    await expect(meta).toHaveText('✦ writing · Esc to stop');
    await expect(sparkle).toHaveAttribute('aria-label', 'Stop');
    await expect(field).toHaveValue('');
    await look(s.panel, 'test-results/git-message-writing.png');
    // Esc stops (the drawer stays open) and keeps what was streamed.
    await field.press('Escape');
    await expect(drawer).toBeVisible();
    await expect(stream).toHaveCount(0);
    await expect(field).toHaveValue('feat(cart): ');
    await expect(meta).toHaveCount(0);
    await expect(sparkle).toHaveAttribute('aria-label', 'Write with Claude');
    await expect(sparkle).not.toHaveClass(/is-glow/);
    // Nothing more lands after the Stop (the next chunk was 700 ms away).
    await s.win.waitForTimeout(800);
    await expect(field).toHaveValue('feat(cart): ');

    // My own words, then ✦ again: ready, with the model and time, the note about the .env, the tweak pills.
    await field.fill('wip: my own words');
    await sparkle.click();
    await expect(stream).toBeVisible();
    await expect(field).toHaveValue(`feat(cart): update cart (take 2)${BODY}`, { timeout: 8000 });
    await expect(meta).toHaveText(/^✦ Haiku · \d+\.\d s$/);
    await expect(drawer.locator('.git-write-note')).toHaveText('1 file left out of ✦ (looks like a secret)');
    await expect(drawer.locator('.git-write-tweaks button')).toHaveText(['Shorter', 'More detail', 'Subject only']);
    await expect(sparkle).toHaveAttribute('aria-label', 'Write again');
    await expect(field).toBeFocused();
    await look(s.panel, 'test-results/git-message-ready.png');

    // ⌘Z: the text before ✦, in one step; the pills go with the edit.
    await s.win.keyboard.press('Meta+z');
    await expect(field).toHaveValue('wip: my own words');
    await expect(drawer.locator('.git-write-tweaks')).toHaveCount(0);
    await expect(meta).toHaveCount(0);

    // ✦, then ↻ rewrites; ⌘Z goes back to the first ✦ text, one step.
    await sparkle.click();
    await expect(field).toHaveValue(`feat(cart): update cart (take 3)${BODY}`, { timeout: 8000 });
    await sparkle.click();
    await expect(stream).toBeVisible();
    await expect(field).toHaveValue(`feat(cart): update cart (take 4)${BODY}`, { timeout: 8000 });
    await s.win.keyboard.press('Meta+z');
    await expect(field).toHaveValue(`feat(cart): update cart (take 3)${BODY}`);

    // ✦ again, then Subject only: one rewrite with the tweak, and that pill is spent.
    await sparkle.click();
    await expect(field).toHaveValue(`feat(cart): update cart (take 5)${BODY}`, { timeout: 8000 });
    await drawer.getByRole('button', { name: 'Subject only' }).click();
    await expect(field).toHaveValue('feat(cart): update cart (take 6)', { timeout: 8000 });
    await expect(drawer.locator('.git-write-tweaks button')).toHaveText(['Shorter', 'More detail']);

    // Staging while ✦ writes: "Staged files changed · Rewrite".
    await sparkle.click();
    await expect(stream).toBeVisible();
    write(join(p.repo('acme-store'), 'src/totals.ts'), 'totals 2\n');
    git(p.repo('acme-store'), 'add', 'src/totals.ts');
    const stale = drawer.locator('.git-write-stale');
    await expect(stale).toContainText('Staged files changed', { timeout: 8000 });
    await stale.getByRole('button', { name: 'Rewrite' }).click();
    await expect(field).toHaveValue(/^feat\(cart\): update cart \(take 8\)/, { timeout: 10000 });
    await expect(stale).toHaveCount(0);

    // What ✦ was given: the staged diff, the session's prompts, the .env's path and never its content.
    const inputs = readFileSync(messageLog, 'utf8');
    expect(inputs).toContain('+cart 2');
    expect(inputs).toContain('Make the cart total round half up');
    expect(inputs).toContain('Also show the rounding in the cart summary');
    expect(inputs).toContain('.env');
    expect(inputs).not.toContain(SECRET);
    expect(inputs).toContain('<tweak kind="subject">');

    // Commit: the drawer moves to billing, its empty field with the ✦ glow.
    await field.press('Meta+Enter');
    await expect(drawer.locator('.git-chip')).toHaveText(/billing/, { timeout: 8000 });
    await expect(field).toHaveValue('');
    await expect(sparkle).toHaveClass(/is-glow/);
    expect(git(p.repo('acme-store'), 'log', '-1', '--format=%s').trim()).toBe('feat(cart): update cart (take 8)');

    // Messages with Claude Off: no sparkle, and ⌥⌘M does nothing.
    await s.win.evaluate(() => (window as unknown as { atelier: { settings: { set(p: object): Promise<unknown> } } }).atelier.settings.set({ commitMessages: 'off' }));
    await expect(sparkle).toHaveCount(0);
    await s.command('git-write-message');
    await s.win.waitForTimeout(500);
    await expect(stream).toHaveCount(0);
    expect(readFileSync(messageLog, 'utf8').split('----- end of input -----')).toHaveLength(9);
  } finally {
    await s.stop();
  }
});
