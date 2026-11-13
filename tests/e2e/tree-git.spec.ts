import { _electron as electron, expect, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { e2eEnv } from './env';
import { look } from './shots';

// Test repos isolated from the user's git configuration (global hooks, commit signing, ...).
const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const git = (cwd: string, ...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd, env: gitEnv });

const AMBER = 'rgb(251, 191, 36)';
const GREEN = 'rgb(52, 211, 153)';
const SKY = 'rgb(96, 165, 250)';

test('file tree: names colored by their git change, letter at the right, folders with the strongest child dot', async () => {
  // In tmpdir (/var → /private/var): the tree and git must agree on real paths.
  const project = mkdtempSync(join(tmpdir(), 'atl-prj-'));
  git(project, 'init', '-q', '-b', 'main');
  mkdirSync(join(project, 'src', 'deep'), { recursive: true });
  mkdirSync(join(project, 'docs'));
  for (const [rel, text] of Object.entries({ 'clean.ts': '1\n', 'mod.ts': '1\n', 'src/deep/edit.ts': '1\n', 'docs/old.md': 'a\nb\nc\n' })) writeFileSync(join(project, rel), text);
  git(project, 'add', '.');
  git(project, 'commit', '-q', '-m', 'first');

  const { env, home } = e2eEnv({ ATELIER_CLAUDE_BIN: resolve('tests/e2e/fake-claude.pl') });
  const app = await electron.launch({ args: ['out/main/index.js', `--project=${project}`], env });
  try {
    const win = await app.firstWindow();
    await expect(win.locator('.changes')).toContainText('Working tree clean', { timeout: 10000 });
    writeFileSync(join(project, 'mod.ts'), '2\n');
    writeFileSync(join(project, 'src', 'deep', 'edit.ts'), '2\n');
    writeFileSync(join(project, 'new.ts'), 'x\n');
    git(project, 'mv', 'docs/old.md', 'docs/moved.md');
    await expect(win.locator('.changes .change-row')).toHaveCount(4, { timeout: 8000 });

    await win.getByRole('button', { name: /^Files/ }).click();
    const row = (name: string) => win.locator('.tree-row', { has: win.locator('.tree-name', { hasText: new RegExp(`^${name.replace('.', '\\.')}$`) }) });
    await row('src').click();
    await row('deep').click();
    await row('docs').click();

    // Files: name in the kind's color, letter right-aligned in mono.
    await expect(row('mod.ts')).toHaveAttribute('data-git', 'modified');
    await expect(row('mod.ts').locator('.tree-name')).toHaveCSS('color', AMBER);
    await expect(row('mod.ts').locator('.tree-badge')).toHaveText('M');
    await expect(row('mod.ts').locator('.tree-badge')).toHaveCSS('color', AMBER);
    await expect(row('new.ts')).toHaveAttribute('data-git', 'untracked');
    await expect(row('new.ts').locator('.tree-name')).toHaveCSS('color', GREEN);
    await expect(row('new.ts').locator('.tree-badge')).toHaveText('U');
    await expect(row('moved.md')).toHaveAttribute('data-git', 'renamed');
    await expect(row('moved.md').locator('.tree-name')).toHaveCSS('color', SKY);
    await expect(row('moved.md').locator('.tree-badge')).toHaveText('R');
    await expect(row('edit.ts').locator('.tree-badge')).toHaveText('M');
    const badge = (await row('mod.ts').locator('.tree-badge').boundingBox())!;
    const box = (await row('mod.ts').boundingBox())!;
    expect(box.x + box.width - (badge.x + badge.width)).toBeLessThanOrEqual(12);
    expect(await row('mod.ts').locator('.tree-badge').evaluate((el) => getComputedStyle(el).fontFamily)).toMatch(/JetBrains Mono/);

    // A clean file: no color, no letter.
    await expect(row('clean.ts')).not.toHaveAttribute('data-git', /.*/);
    await expect(row('clean.ts').locator('.tree-badge')).toHaveCount(0);

    // Folders: a dot in the strongest child color, no letter.
    await expect(row('src').locator('.tree-git-dot')).toHaveCSS('background-color', AMBER);
    await expect(row('deep').locator('.tree-git-dot')).toHaveCSS('background-color', AMBER);
    await expect(row('docs').locator('.tree-git-dot')).toHaveCSS('background-color', SKY);
    await expect(row('src').locator('.tree-badge')).toHaveCount(0);
    await look(win.locator('.tree'), 'test-results/tree-git.png');

    // Back to clean: the colors go away.
    git(project, 'add', '-A');
    git(project, 'commit', '-q', '-m', 'second');
    await expect(win.locator('.changes')).toContainText('Working tree clean', { timeout: 8000 });
    await expect(win.locator('.tree-row[data-git]')).toHaveCount(0);
    await expect(win.locator('.tree-git-dot')).toHaveCount(0);
  } finally {
    await app.close();
    try { process.kill((JSON.parse(readFileSync(join(home, 'atelierd.json'), 'utf8')) as { pid: number }).pid, 'SIGTERM'); } catch { /* already stopped */ }
  }
});
