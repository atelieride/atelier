import { _electron as electron, expect, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Test with real Claude Code: haiku model, temporary folder. Consumes some usage.
// Deliberately uses the real configuration (zsh, status line, user hooks) and leaves in ~/.claude.json
// the trust for the temporary folder, as a hand-launched claude would. Real data only, never fake.
// Terminals and sessions use the "zsh (your config)" profile (set below): `claude` is found exactly as in your own
// terminals. (atelierd still captures your shell environment for the Atelier profile, in memory only.)
test('real Claude Code inside Atelier: states, permission, status line and limits', async () => {
  const home = mkdtempSync(join(tmpdir(), 'atl-real-'));
  const project = mkdtempSync(join(tmpdir(), 'atl-real-prj-'));
  // The test folder is a git repo (isolated from the user's git configuration): so attribution is visible.
  const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: project, env: gitEnv });
  writeFileSync(join(project, 'README.md'), 'prova\n');
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'add', '.'], { cwd: project, env: gitEnv });
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'primo'], { cwd: project, env: gitEnv });
  writeFileSync(join(home, 'ui-state.json'), JSON.stringify({ openProjects: [], recent: [], quitInfoShown: true }));
  // Real sessions would put real dots in the menu bar: off (trayIcons: false).
  writeFileSync(join(home, 'preferences.json'), JSON.stringify({ terminalProfile: 'user', trayIcons: false }));
  const env = { ...process.env, ATELIER_HOME: home } as Record<string, string>;
  delete env.ATELIER_CLAUDE_BIN;
  // The real zsh configuration stays intact: oh-my-zsh does not ask to update and does not write its cache.
  env.DISABLE_AUTO_UPDATE = 'true';
  const app = await electron.launch({ args: ['out/main/index.js', `--project=${project}`], env });
  const shot = (n: string) => win.screenshot({ path: `test-results/real-${n}.png` });
  const win = await app.firstWindow();
  try {
    await win.getByRole('button', { name: 'Open a terminal' }).click();
    await win.waitForTimeout(2500);
    await win.locator('.xterm-helper-textarea').focus();
    await win.waitForTimeout(500);
    await win.keyboard.type('claude --model haiku -n prova-reale\n');
    const rows = win.locator('.xterm-rows');
    // New folder: Claude asks whether to trust it. Accept (Enter on the first option).
    await win.waitForTimeout(6000);
    await shot('1-avvio');
    if (/trust/i.test((await rows.textContent()) ?? '')) { await win.keyboard.press('ArrowDown'); await win.keyboard.press('Enter'); await win.waitForTimeout(4000); }
    const row = win.locator('.session-row').first();
    await expect(row).toContainText('prova-reale', { timeout: 30000 });
    await shot('2-pronta');
    await win.keyboard.type('crea il file prova.txt con scritto ciao, senza fare altro');
    await win.keyboard.press('Enter');
    await expect(row).toHaveClass(/state-(running|waiting)/, { timeout: 30000 });
    // With autoMode or permissions already granted the request does not appear: handle it only if it arrives.
    await expect(row).toHaveClass(/state-(waiting|done)/, { timeout: 90000 });
    if (/state-waiting/.test((await row.getAttribute('class')) ?? '')) {
      await shot('3-ti-aspetta');
      await win.keyboard.press('Enter'); // "1. Yes"
    }
    await expect(row).toHaveClass(/state-done/, { timeout: 90000 });
    await shot('4-finita');
    await expect(win.locator('.usage')).toBeVisible({ timeout: 30000 });
    await shot('5-limiti');

    // The file written by Claude shows up in Changes with its session's dot.
    const changeRow = win.locator('.changes .change-row', { hasText: 'prova.txt' });
    await expect(changeRow).toBeVisible({ timeout: 15000 });
    await expect(changeRow.locator('.dot:not(.unknown)')).toHaveCount(1, { timeout: 15000 });
    await shot('6-attribuzione');

    // The service stops (like a restart): the session becomes resumable and is resumed with --resume.
    const info = JSON.parse(readFileSync(join(home, 'atelierd.json'), 'utf8')) as { pid: number };
    process.kill(info.pid, 'SIGTERM');
    const resumeRow = win.locator('.resume-row', { hasText: 'prova-reale' });
    await expect(resumeRow).toBeVisible({ timeout: 30000 });
    await shot('7-da-riprendere');
    await resumeRow.getByRole('button', { name: 'Resume' }).click();
    await expect(win.locator('.session-row', { hasText: 'prova-reale' })).toBeVisible({ timeout: 60000 });
    await shot('8-ripresa');
    console.log('TERMINAL TEXT >>>', ((await rows.textContent()) ?? '').slice(-1500));
  } finally {
    await app.close();
    try {
      const info = JSON.parse(readFileSync(join(home, 'atelierd.json'), 'utf8')) as { pid: number };
      process.kill(info.pid, 'SIGTERM');
    } catch { /* already stopped */ }
  }
});

// An interrupted turn: Enter, then Esc while Claude is still thinking. Claude Code puts the prompt back and
// sends no hook; the session must read ready again. Runs in this repo (already trusted: nothing written to
// ~/.claude.json), the window hidden, the default model (its thinking leaves time for the Esc). Consumes very little.
test('real Claude Code: Esc before it wrote anything puts the prompt back, and the session is ready again', async () => {
  const home = mkdtempSync(join(tmpdir(), 'atl-real-'));
  writeFileSync(join(home, 'ui-state.json'), JSON.stringify({ openProjects: [], recent: [], quitInfoShown: true }));
  writeFileSync(join(home, 'preferences.json'), JSON.stringify({ terminalProfile: 'user', trayIcons: false }));
  const env = { ...process.env, ATELIER_HOME: home, ATELIER_TEST_BACKGROUND: '1', DISABLE_AUTO_UPDATE: 'true' } as Record<string, string>;
  delete env.ATELIER_CLAUDE_BIN;
  const app = await electron.launch({ args: ['out/main/index.js', `--project=${process.cwd()}`], env });
  const win = await app.firstWindow();
  const type = (text: string) => win.evaluate(async (t) => {
    const api = (window as unknown as { atelier: { terminals: { list(): Promise<{ id: string }[]>; input(id: string, d: string): void } } }).atelier;
    api.terminals.input((await api.terminals.list())[0]!.id, t);
  }, text);
  try {
    await win.getByRole('button', { name: 'Open a terminal' }).click();
    await win.waitForTimeout(2500);
    // The default model with high effort: a fast answer would end the turn (state-done) before the Esc, a red here.
    await type('claude -n esc-before-reply\r');
    const row = win.locator('.session-row', { hasText: 'esc-before-reply' });
    await expect(row).toBeVisible({ timeout: 30000 });
    await win.waitForTimeout(3000);
    await type('Think step by step at great length about whether 7919 is prime, check every divisor, then answer yes or no.');
    await win.waitForTimeout(500);
    await type('\r');
    await expect(row).toHaveClass(/state-running/, { timeout: 15000 });
    await win.waitForTimeout(2500);
    await type('\x1b');
    await expect(row).toHaveClass(/state-idle/, { timeout: 6000 });
    const text = (await win.locator('.xterm-rows').textContent()) ?? '';
    expect(text).toContain('7919');
    expect(text).not.toContain('Interrupted');
    await win.screenshot({ path: 'test-results/real-esc-take-back.png' });
    await type('\x03');
    await type('\x03');
  } finally {
    await app.close();
    try {
      const info = JSON.parse(readFileSync(join(home, 'atelierd.json'), 'utf8')) as { pid: number };
      process.kill(info.pid, 'SIGTERM');
    } catch { /* already stopped */ }
  }
});
