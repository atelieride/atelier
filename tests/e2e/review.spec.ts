import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { e2eEnv } from './env';
import { look } from './shots';

// Test repos isolated from the user's git configuration (global hooks, commit signing, ...).
const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const git = (cwd: string, ...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd, env: gitEnv });
const SHOTS = 'test-results';

const lines = (n: number, tag: string) => Array.from({ length: n }, (_, i) => `const ${tag}${i + 1} = ${i + 1};`).join('\n') + '\n';

function repo(dir: string, branch: string, files: Record<string, string>) {
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', branch);
  for (const [rel, text] of Object.entries(files)) { mkdirSync(join(dir, rel, '..'), { recursive: true }); writeFileSync(join(dir, rel), text); }
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'first');
}

async function stop(app: ElectronApplication, home: string) {
  await app.close();
  try { process.kill((JSON.parse(readFileSync(join(home, 'atelierd.json'), 'utf8')) as { pid: number }).pid, 'SIGTERM'); } catch { /* already stopped */ }
}

async function newSession(win: Page, name: string) {
  await win.locator('.btn-new').click();
  await win.getByRole('menuitem', { name: 'Claude Session' }).click();
  await win.getByPlaceholder('Session name (optional)').fill(name);
  await win.keyboard.press('Enter');
  await expect(win.locator('.session-row', { hasText: name })).toBeVisible({ timeout: 15000 });
}

test('Review Session lists only its files; Review All shows dots and the two-session warning; keyboard and collapse', async () => {
  const project = mkdtempSync(join(tmpdir(), 'atl-prj-'));
  const ui = join(project, 'app-ui');
  repo(ui, 'dev', { 'src/App.tsx': lines(40, 'a'), 'src/Button.tsx': lines(12, 'b') });
  const appPath = join(ui, 'src', 'App.tsx');
  const { env, home } = e2eEnv({ ATELIER_CLAUDE_BIN: resolve('tests/e2e/fake-claude-edit.pl'), ATELIER_FAKE_EDIT: appPath });
  const app = await electron.launch({ args: ['out/main/index.js', `--project=${project}`], env });
  try {
    const win = await app.firstWindow();
    const panel = win.locator('.changes');
    await expect(panel).toContainText('Working tree clean', { timeout: 10000 });
    // Two far changes in App.tsx (two hunks), one in Button.tsx.
    writeFileSync(appPath, lines(40, 'a').replace('const a3 = 3;', 'const a3 = 33;').replace('const a30 = 30;', 'const a30 = 30;\nconst added = true;'));
    writeFileSync(join(ui, 'src', 'Button.tsx'), lines(12, 'b').replace('const b6 = 6;', 'const b6 = 66;'));
    await expect(panel.locator('.change-row')).toHaveCount(2, { timeout: 8000 });

    await newSession(win, 'Alfa');
    await expect(panel.locator('.change-row', { hasText: 'App.tsx' }).locator('.dot:not(.unknown)')).toHaveCount(1, { timeout: 10000 });

    // From the session row's menu: a review tab for Alfa, with only its file.
    await win.locator('.session-row', { hasText: 'Alfa' }).click({ button: 'right' });
    await win.getByRole('menuitem', { name: 'Review Session' }).click();
    const view = win.locator('.review-view');
    await expect(view).toBeVisible();
    await expect(win.locator('.tab.is-active')).toContainText('Review · Alfa');
    await expect(view.locator('.rv-file')).toHaveCount(1);
    await expect(view.locator('.rv-file')).toHaveAttribute('aria-label', 'src/App.tsx');
    await expect(view.locator('.rv-hunk-head')).toHaveCount(2, { timeout: 8000 });
    await expect(view.locator('.rv-hunk-head').first()).toHaveText('@@ -1,6 +1,6 @@');
    await expect(view.locator('.cm-diff-del')).toHaveCount(1);
    await expect(view.locator('.cm-diff-add')).toHaveCount(2);
    await expect(view.locator('.rv-file .cm-content')).not.toContainText('const a15 = 15;');
    // Line numbers stay level with their lines below the hunk headers.
    const top = (l: ReturnType<Page['locator']>) => l.evaluate((el) => el.getBoundingClientRect().top);
    const numberTop = await top(view.locator('.cm-diff-numbers .cm-gutterElement', { hasText: /^29$/ }));
    const lineTop = await top(view.locator('.cm-line', { hasText: 'const a29 = 29;' }));
    expect(Math.abs(numberTop - lineTop)).toBeLessThan(2);
    await look(win, `${SHOTS}/review-session.png`);

    // A second session touches the same file: Review All (Changes header) shows both dots and the warning.
    await newSession(win, 'Beta');
    await expect(panel.locator('.change-row', { hasText: 'App.tsx' }).locator('.dot:not(.unknown)')).toHaveCount(2, { timeout: 10000 });
    await panel.getByRole('button', { name: 'Review All Changes' }).click();
    await expect(win.locator('.tab.is-active')).toContainText('Review · All changes');
    await expect(view.locator('.rv-file')).toHaveCount(2);
    const appFile = view.locator('.rv-file[aria-label="src/App.tsx"]');
    await expect(appFile.locator('.rv-file-head .dot')).toHaveCount(2);
    await expect(appFile.locator('.rv-clash')).toHaveText('Two sessions on the same file');
    await expect(view.locator('.rv-file[aria-label="src/Button.tsx"] .rv-clash')).toHaveCount(0);
    await expect(view.locator('.rv-hunk-head')).toHaveCount(3, { timeout: 8000 });
    // Still one review tab.
    await expect(win.locator('.tab', { hasText: 'Review ·' })).toHaveCount(1);

    // Keyboard: ↓/j through hunks, n to the next file, Enter opens the file at the change.
    await view.locator('.rv-scroll').focus();
    await win.keyboard.press('j');
    await expect(view.locator('.rv-hunk-head.is-current')).toHaveText('@@ -1,6 +1,6 @@');
    await win.keyboard.press('ArrowDown');
    await expect(view.locator('.rv-hunk-head.is-current')).toHaveText('@@ -28,6 +28,7 @@');
    await win.keyboard.press('k');
    await expect(view.locator('.rv-hunk-head.is-current')).toHaveText('@@ -1,6 +1,6 @@');
    await win.keyboard.press('n');
    await expect(view.locator('.rv-file.is-current')).toHaveAttribute('aria-label', 'src/Button.tsx');
    await look(win, `${SHOTS}/review-all.png`);
    await win.keyboard.press('Enter');
    await expect(win.locator('.tab.is-active')).toContainText('Button.tsx');
    await expect(win.locator('.file-view:visible .cm-target-line')).toContainText('const b6 = 66;');

    // Back to the review: ⌥-click on a file header collapses every file, again expands them.
    await win.locator('.tab', { hasText: 'Review ·' }).click();
    await appFile.locator('.rv-file-toggle').click({ modifiers: ['Alt'] });
    await expect(view.locator('.rv-file-toggle[aria-expanded="false"]')).toHaveCount(2);
    await expect(view.locator('.rv-hunk-head')).toHaveCount(0);
    await appFile.locator('.rv-file-toggle').click({ modifiers: ['Alt'] });
    await expect(view.locator('.rv-file-toggle[aria-expanded="true"]')).toHaveCount(2);

    // From the palette, and closing it like any tab.
    await win.keyboard.press('F1');
    await win.locator('.palette-input').fill('>review: alfa');
    await win.keyboard.press('Enter');
    await expect(win.locator('.tab.is-active')).toContainText('Review · Alfa');
    await win.locator('.tab.is-active .tab-close').click();
    await expect(view).toHaveCount(0);
  } finally {
    await stop(app, home);
  }
});

test('Against main: the branch\'s committed changes join the review; hidden on the default branch', async () => {
  const project = mkdtempSync(join(tmpdir(), 'atl-prj-'));
  const up = join(project, '.upstream');
  repo(up, 'main', { 'a.ts': lines(10, 'x'), 'b.ts': lines(5, 'y') });
  git(project, 'clone', '-q', up, 'app');
  const wk = join(project, 'app');
  git(wk, 'checkout', '-q', '-b', 'feat');
  writeFileSync(join(wk, 'a.ts'), lines(10, 'x').replace('const x4 = 4;', 'const x4 = 44;'));
  git(wk, 'commit', '-q', '-am', 'feature');
  // Plus an uncommitted change.
  writeFileSync(join(wk, 'b.ts'), lines(5, 'y').replace('const y2 = 2;', 'const y2 = 22;'));
  const { env, home } = e2eEnv({ ATELIER_CLAUDE_BIN: resolve('tests/e2e/fake-claude.pl') });
  const app = await electron.launch({ args: ['out/main/index.js', `--project=${project}`], env });
  try {
    const win = await app.firstWindow();
    await expect(win.locator('.changes .change-row')).toHaveCount(1, { timeout: 10000 });
    await win.keyboard.press('F1');
    await win.locator('.palette-input').fill('>review all');
    await win.keyboard.press('Enter');
    const view = win.locator('.review-view');
    const toggle = view.getByRole('button', { name: 'Against main' });
    await expect(toggle).toBeVisible({ timeout: 8000 });
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await expect(view.locator('.rv-file')).toHaveCount(1);
    await expect(view.locator('.rv-file')).toHaveAttribute('aria-label', 'b.ts');

    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
    await expect(view.locator('.rv-file')).toHaveCount(2);
    const a = view.locator('.rv-file[aria-label="a.ts"]');
    await expect(a.locator('.cm-content')).toContainText('const x4 = 44;', { timeout: 8000 });
    await expect(a.locator('.cm-diff-del')).toContainText('const x4 = 4;');
    await look(win, `${SHOTS}/review-against-main.png`);

    // Remembered across reloads of the view.
    await win.locator('.tab.is-active .tab-close').click();
    await win.keyboard.press('F1');
    await win.locator('.palette-input').fill('>review all');
    await win.keyboard.press('Enter');
    await expect(view.getByRole('button', { name: 'Against main' })).toHaveAttribute('aria-pressed', 'true', { timeout: 8000 });
    await expect(view.locator('.rv-file')).toHaveCount(2);

    // Back on the default branch: nothing to compare against, the toggle goes away.
    git(wk, 'stash', '-q');
    git(wk, 'checkout', '-q', 'main');
    await expect(view.getByRole('button', { name: 'Against main' })).toHaveCount(0, { timeout: 10000 });
  } finally {
    await stop(app, home);
  }
});
