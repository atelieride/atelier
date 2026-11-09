import { _electron as electron, expect, test } from '@playwright/test';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { e2eEnv } from './env';
import { look } from './shots';

test('editor: mixed line endings declared, files inside .git read-only, word wrap on an already open file; the tree\'s "Show hidden files" toggle', async () => {
  const project = mkdtempSync(join(tmpdir(), 'atl-prj-'));
  writeFileSync(join(project, 'misto.txt'), 'uno\r\ndue\ntre\r\n');
  writeFileSync(join(project, 'lungo.txt'), `${'parola '.repeat(80)}\n`);
  mkdirSync(join(project, '.git'));
  mkdirSync(join(project, 'node_modules', 'pkg'), { recursive: true });
  writeFileSync(join(project, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  const { env, home } = e2eEnv({ ATELIER_CLAUDE_BIN: resolve('tests/e2e/fake-claude.pl') });
  const app = await electron.launch({ args: ['out/main/index.js', `--project=${project}`], env });
  try {
    const win = await app.firstWindow();
    await win.getByRole('button', { name: /Files/ }).click();
    await win.locator('.tree-row', { hasText: 'misto.txt' }).click();
    await expect(win.locator('.file-view:visible .file-info-band')).toContainText('Mixed line endings');

    await win.locator('.tree-row', { hasText: 'lungo.txt' }).click();
    const view = win.locator('.file-view:visible');
    await expect(view.locator('.cm-content')).toBeVisible();
    await expect(view.locator('.cm-lineWrapping')).toHaveCount(0);
    await win.evaluate(() => (window as unknown as { atelier: { settings: { set(p: object): Promise<unknown> } } }).atelier.settings.set({ wordWrap: true }));
    await expect(view.locator('.cm-lineWrapping')).toHaveCount(1);

    // .git is hidden in the tree: open it from the palette with the path.
    await win.evaluate(() => (window as unknown as { atelier: { settings: { set(p: object): Promise<unknown> } } }).atelier.settings.set({ wordWrap: false }));
    // "Show hidden files": an icon toggle with a tooltip and aria-pressed.
    const toggle = win.getByRole('button', { name: 'Show hidden files' });
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await expect(toggle).toHaveClass(/icon-btn/);
    await expect(toggle.locator('svg')).toHaveCount(1);
    await expect(toggle).toHaveText('');
    await expect(toggle).toHaveAttribute('data-tip', 'Show hidden files');
    await expect(win.locator('.tree-row', { hasText: 'node_modules' })).toHaveCount(0);
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
    await expect(toggle).toHaveAttribute('data-tip', 'Hide hidden files');
    await expect(win.locator('.tree-row', { hasText: 'node_modules' })).toBeVisible();
    await look(win.locator('.sidebar-head'), 'test-results/hidden-toggle.png');
    await win.locator('.tree-row', { hasText: '.git' }).click();
    await win.locator('.tree-row', { hasText: 'HEAD' }).click();
    const git = win.locator('.file-view:visible');
    await expect(git.locator('.file-info-band')).toContainText('Inside .git: read-only');
    await expect(git.locator('.cm-content')).toHaveAttribute('contenteditable', 'false');
    await expect(git.locator('.file-foot')).not.toContainText('vs HEAD');
  } finally {
    await app.close();
    try { process.kill((JSON.parse(readFileSync(join(home, 'atelierd.json'), 'utf8')) as { pid: number }).pid, 'SIGTERM'); } catch { /* already stopped */ }
  }
});

test('text over 5 MB: Open Anyway, plain and read-only, following the disk; over 50 MB only Reveal', async () => {
  const project = mkdtempSync(join(tmpdir(), 'atl-prj-'));
  const line = (n: number) => `${String(n).padStart(8, '0')} INFO request served in 12ms\n`;
  const lines = Math.ceil((6 * 1024 * 1024) / line(0).length);
  writeFileSync(join(project, 'big.log'), Array.from({ length: lines }, (_, i) => line(i + 1)).join(''));
  writeFileSync(join(project, 'big.json'), `{"rows":[${'"x",'.repeat(1_400_000)}"y"]}\n`);
  writeFileSync(join(project, 'latin.log'), Buffer.from('caffè servito\n'.repeat(Math.ceil((6 * 1024 * 1024) / 14)), 'latin1'));
  writeFileSync(join(project, 'huge.log'), Buffer.alloc(50 * 1024 * 1024 + 1, 97));
  const { env, home } = e2eEnv({ ATELIER_CLAUDE_BIN: resolve('tests/e2e/fake-claude.pl') });
  const app = await electron.launch({ args: ['out/main/index.js', `--project=${project}`], env });
  try {
    const win = await app.firstWindow();
    await win.getByRole('button', { name: /Files/ }).click();
    await win.locator('.tree-row', { hasText: 'big.log' }).click();
    const view = win.locator('.file-view:visible');
    await expect(view.locator('.file-empty')).toContainText('File larger than 5 MB.');
    await win.mouse.move(5, 300);
    await look(view, 'test-results/large-open-anyway.png');
    await view.getByRole('button', { name: 'Open Anyway' }).click();
    await expect(view.locator('.cm-content')).toContainText('00000001 INFO request served', { timeout: 15000 });
    await expect(view.locator('.cm-content')).toHaveAttribute('contenteditable', 'false');
    await expect(view.locator('.file-foot')).toContainText('Read-only · large file');
    // Changed on disk: read again as a large file, still open.
    writeFileSync(join(project, 'big.log'), `FIRST LINE CHANGED\n${Array.from({ length: lines }, (_, i) => line(i + 1)).join('')}`);
    await expect(view.locator('.cm-content')).toContainText('FIRST LINE CHANGED', { timeout: 15000 });
    await expect(view.locator('.file-empty')).toHaveCount(0);

    // A Latin-1 log past 5 MB (read-only already, not UTF-8): large too, by its size.
    await win.locator('.tree-row', { hasText: 'latin.log' }).click();
    const latin = win.locator('.file-view:visible');
    await latin.getByRole('button', { name: 'Open Anyway' }).click();
    await expect(latin.locator('.cm-content')).toContainText('caffè servito', { timeout: 15000 });
    await expect(latin.locator('.file-foot')).toContainText('Read-only · large file');

    // Plain: a large JSON gets no Tree/Preview switch.
    await win.locator('.tree-row', { hasText: 'big.json' }).click();
    const json = win.locator('.file-view:visible');
    await json.getByRole('button', { name: 'Open Anyway' }).click();
    await expect(json.locator('.cm-content')).toContainText('{"rows":["x"', { timeout: 15000 });
    await expect(json.locator('.md-switch')).toHaveCount(0);

    // Over 50 MB: not shown, Reveal in Finder only (not clicked: it would open Finder).
    await win.locator('.tree-row', { hasText: 'huge.log' }).click();
    const huge = win.locator('.file-view:visible');
    await expect(huge.locator('.file-empty')).toContainText('File larger than 50 MB: not shown.');
    await expect(huge.getByRole('button', { name: 'Reveal in Finder' })).toBeVisible();
    await expect(huge.getByRole('button', { name: 'Open Anyway' })).toHaveCount(0);
  } finally {
    await app.close();
    try { process.kill((JSON.parse(readFileSync(join(home, 'atelierd.json'), 'utf8')) as { pid: number }).pid, 'SIGTERM'); } catch { /* already stopped */ }
  }
});

test('opening Files with a project file in front: its folders open, its row is scrolled into view and marked active', async () => {
  const project = mkdtempSync(join(tmpdir(), 'atl-prj-'));
  // The file sits at the bottom of a long folder: the tree has to scroll to show it.
  mkdirSync(join(project, 'zz', 'deep'), { recursive: true });
  for (let i = 0; i < 60; i++) writeFileSync(join(project, 'zz', 'deep', `a${String(i).padStart(2, '0')}.txt`), '');
  writeFileSync(join(project, 'zz', 'deep', 'target.ts'), 'export {};\n');
  const { env, home } = e2eEnv({ ATELIER_CLAUDE_BIN: resolve('tests/e2e/fake-claude.pl') });
  const app = await electron.launch({ args: ['out/main/index.js', `--project=${project}`], env });
  try {
    const win = await app.firstWindow();
    const files = win.getByRole('button', { name: /^Files/ });
    await files.click();
    await win.locator('.tree-row', { hasText: 'zz' }).click();
    await win.locator('.tree-row', { hasText: 'deep' }).click();
    await win.locator('.tree-row', { hasText: 'target.ts' }).dblclick();
    await expect(win.locator('.file-view:visible .cm-content')).toContainText('export');
    // Folders closed and the tree left: coming back to it finds the file again.
    await win.getByRole('button', { name: 'Collapse folders' }).click();
    await expect(win.locator('.tree-row', { hasText: 'target.ts' })).toHaveCount(0);
    await win.getByRole('button', { name: /^Sessions/ }).click();
    await files.click();
    const row = win.locator('.tree-row', { hasText: 'target.ts' });
    await expect(row).toHaveClass(/is-active/);
    await expect(row).toBeInViewport();
    await expect(row).not.toHaveClass(/is-flash/);
    await look(win.locator('.sidebar'), 'test-results/files-reveal-active.png');
  } finally {
    await app.close();
    try { process.kill((JSON.parse(readFileSync(join(home, 'atelierd.json'), 'utf8')) as { pid: number }).pid, 'SIGTERM'); } catch { /* already stopped */ }
  }
});
