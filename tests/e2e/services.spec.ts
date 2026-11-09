import { _electron as electron, expect, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { e2eEnv, writePrefs } from './env';
import { look } from './shots';

test('Services: test tmux pane, errors, JSON, port, new lines, paste into the session without Enter', async () => {
  // Test-ONLY tmux server: socket in the run's temp root (tests/support/temp-root.ts), dedicated name. Never the user's
  // server. Not one folder deeper: tmux resolves it to /private/var/…/atl-run-XXXXXX/tmux-<uid>/<server>, max 103 bytes.
  const tmuxDir = tmpdir();
  const server = `ae2e-${process.pid}`;
  const tmuxEnv = { ...process.env, TMUX_TMPDIR: tmuxDir };
  delete (tmuxEnv as Record<string, string | undefined>).TMUX;
  const tmux = (...a: string[]) => execFileSync('tmux', ['-L', server, ...a], { env: tmuxEnv });

  const project = realpathSync(mkdtempSync(join(tmpdir(), 'atl-prj-')));
  mkdirSync(join(project, 'api'));
  mkdirSync(join(project, 'web'));
  const apiLog = join(project, 'api', 'server.log');
  writeFileSync(apiLog, [
    '{"time":"2026-10-10T10:41:02.123Z","level":"info","method":"GET","path":"/api/reports","status":200,"ms":38}',
    'Error: errore vecchio, di prima che Atelier guardasse',
    'Server listening on port 3999'
  ].join('\n') + '\n');
  writeFileSync(join(project, 'web', 'out.log'), 'VITE v7.3.7  ready in 500 ms\n  ➜  Local:   http://localhost:8099/\n');

  tmux('new-session', '-d', '-s', 'prova', '-x', '160', '-y', '40', '-c', join(project, 'api'), `tail -n +1 -f '${apiLog}'`);
  tmux('select-pane', '-t', 'prova:0.0', '-T', 'api');
  tmux('split-window', '-t', 'prova:0', '-c', join(project, 'web'), `tail -n +1 -f '${join(project, 'web', 'out.log')}'`);
  tmux('select-pane', '-t', 'prova:0.1', '-T', 'web');

  // Minimal PATH like an app opened from the Finder: Homebrew's tmux must still be found.
  const { env, home } = e2eEnv({ TMUX_TMPDIR: tmuxDir, ATELIER_TMUX_SERVER: server, ATELIER_CLAUDE_BIN: resolve('tests/e2e/fake-claude.pl'), PATH: '/usr/bin:/bin:/usr/sbin:/sbin' });
  writePrefs(home, { showServices: true });
  delete env.TMUX;
  const app = await electron.launch({ args: ['out/main/index.js', `--project=${project}`], env });
  try {
    const win = await app.firstWindow();
    // A session to paste into.
    await win.locator('.btn-new').click();
    await win.getByRole('menuitem', { name: 'Claude Session' }).click();
    await win.getByPlaceholder('Session name (optional)').fill('Sessione');
    await win.keyboard.press('Enter');
    await expect(win.locator('.session-row', { hasText: 'Sessione' })).toBeVisible({ timeout: 15000 });

    await win.getByRole('button', { name: 'Services (⌘⇧3)' }).click();
    const api = win.locator('.svc-row', { hasText: 'api' });
    const web = win.locator('.svc-row', { hasText: 'web' });
    await expect(api).toContainText(':3999', { timeout: 15000 });
    // History from the first capture does not count: only new errors.
    await expect(api.locator('.svc-row-err')).toHaveCount(0);
    appendFileSync(apiLog, 'Error: connect ECONNREFUSED 127.0.0.1:5432\n');
    await expect(api.locator('.svc-row-err')).toHaveText('1', { timeout: 10000 });
    await expect(web).toContainText(':8099');
    await expect(win.locator('.footer')).toContainText('services 2/2 · 1 error');

    await api.click();
    const grid = win.locator('.services-grid');
    await expect(grid.locator('.log-line.lv-error', { hasText: 'ECONNREFUSED' })).toBeVisible({ timeout: 10000 });
    await expect(grid.locator('.kv-k', { hasText: 'method=' })).toBeVisible();
    await expect(grid.locator('.log-time').first()).toHaveText('10:41:02');

    // New lines in the pane (written by the test into the file followed by tail): they show up on their own.
    appendFileSync(apiLog, 'GET /api/health 200 3ms\n');
    await expect(grid).toContainText('/api/health', { timeout: 5000 });
    await look(win, 'test-results/services-services.png');

    // A line too long for the card: cut at first; a click shows it whole, a second one folds it.
    const tail = 'the whole stack trace ends here';
    appendFileSync(apiLog, `Error: [GET] /health >> StatusCode:: 401, ErrorCode:: AUTH_REQUIRED, ${'details '.repeat(40)}${tail}\n`);
    const long = grid.locator('.log-line', { hasText: tail });
    await expect(long).toBeVisible({ timeout: 10000 });
    const cut = () => long.locator('.log-text').evaluate((el) => el.scrollWidth > el.clientWidth + 1);
    expect(await cut()).toBe(true);
    // From the keyboard (review minor): focus entering the card measures its lines, so a cut line's chevron is there
    // to Tab to, without any hover.
    await win.mouse.move(5, 5);
    await expect(long.locator('.log-more')).toHaveCount(0);
    await grid.focus();
    await win.keyboard.press('Tab');
    await expect(long.locator('.log-more')).toHaveCount(1);
    await long.locator('.log-more').focus();
    await win.keyboard.press('Enter');
    await expect(long).toHaveClass(/\bis-expanded\b/);
    await win.keyboard.press('Escape');
    await expect(long).not.toHaveClass(/\bis-expanded\b/);
    await long.hover();
    await expect(long.locator('.log-more')).toBeVisible();
    await expect(long.locator('.log-more')).toHaveAttribute('aria-label', 'Show the whole line');
    // The paste button is compact, names the session in its accessible name and tooltip.
    const pasteBtn = long.getByRole('button', { name: 'Paste into Sessione' });
    await expect(pasteBtn).toHaveText('Paste');
    await expect(pasteBtn).toHaveAttribute('data-tip', 'Paste into Sessione');
    await long.locator('.log-text').click();
    await expect(long).toHaveClass(/\bis-expanded\b/);
    expect(await cut()).toBe(false);
    await expect(long.locator('.log-more')).toHaveAttribute('aria-label', 'Fold the line');
    await look(win, 'test-results/services-line-expanded.png');
    await long.locator('.log-text').click();
    await expect(long).not.toHaveClass(/\bis-expanded\b/);
    // Escape on its button folds it too.
    await long.locator('.log-more').click();
    await expect(long).toHaveClass(/\bis-expanded\b/);
    await long.locator('.log-more').press('Escape');
    await expect(long).not.toHaveClass(/\bis-expanded\b/);
    // Wrap lines: every line of the card wraps; from the header button or the card's context menu.
    // The api card alone is shown (maximized from the list).
    const card = grid.locator('.svc-card');
    await expect(card).toHaveCount(1);
    const wrapBtn = card.getByRole('button', { name: 'Wrap lines' });
    await wrapBtn.click();
    await expect(wrapBtn).toHaveAttribute('aria-pressed', 'true');
    await expect(card).toHaveClass(/\bis-wrap\b/);
    expect(await cut()).toBe(false);
    await look(win, 'test-results/services-wrap.png');
    await card.locator('.svc-head').click({ button: 'right' });
    await win.getByRole('menuitem', { name: "Don't Wrap Lines" }).click();
    await expect(card).not.toHaveClass(/\bis-wrap\b/);
    expect(await cut()).toBe(true);

    // Paste into the session: the text reaches the prompt but is not sent.
    await grid.locator('.log-line', { hasText: 'ECONNREFUSED' }).getByRole('button', { name: 'Paste into Sessione' }).click();
    await expect(win.locator('.paste-toast')).toBeVisible();
    await expect(win.locator('.xterm-rows')).toContainText('ECONNREFUSED', { timeout: 5000 });
    await win.waitForTimeout(1000);
    await expect(win.locator('.xterm-rows')).not.toContainText('FAKE-CLAUDE done');
    await look(win, 'test-results/services-paste.png');

    // Pane view: both services.
    await win.getByRole('button', { name: 'Services (⌘⇧3)' }).click();
    await win.locator('.tab', { hasText: 'Services' }).click();
    await win.getByRole('button', { name: 'Back to grid' }).click();
    await expect(win.locator('.svc-card')).toHaveCount(2);
    await look(win, 'test-results/services-grid.png');
  } finally {
    await app.close();
    try { tmux('kill-server'); } catch { /* already stopped */ }
    try { process.kill((JSON.parse(readFileSync(join(home, 'atelierd.json'), 'utf8')) as { pid: number }).pid, 'SIGTERM'); } catch { /* already stopped */ }
  }
});
