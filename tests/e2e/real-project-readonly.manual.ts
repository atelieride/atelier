import { _electron as electron, expect, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { e2eEnv, writePrefs } from './env';

// READ-ONLY check on a real project of yours: ATELIER_READONLY_PROJECT names a folder of git repositories (a monorepo
// checkout, say); skipped without it. No terminal is created. Before and after: inode and mtime of every .git/index
// and of FETCH_HEAD, git status (with --no-optional-locks), the tmux sessions. During: no index.lock must ever appear.
// Auto-fetch off: Changes counts as viewing, and the packaged app ignores the e2e fetch isolation.
const PROJECT = process.env.ATELIER_READONLY_PROJECT ?? '';
const repos = PROJECT ? readdirSync(PROJECT).map((n) => join(PROJECT, n)).filter((p) => existsSync(join(p, '.git', 'index'))) : [];
const gitRead = (repo: string) => execFileSync('git', ['--no-optional-locks', '-C', repo, 'status', '--porcelain=v2', '-z', '--untracked-files=no'], { encoding: 'utf8', env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } });
const fetchedAt = (repo: string) => { try { return statSync(join(repo, '.git', 'FETCH_HEAD')).mtimeMs; } catch { return null; } };
const snapshot = () => repos.map((r) => { const s = statSync(join(r, '.git', 'index')); return { r, ino: s.ino, mtime: s.mtimeMs, fetched: fetchedAt(r), status: gitRead(r) }; });
const tmuxState = () => execFileSync('tmux', ['list-sessions', '-F', '#{session_name}:#{session_attached}:#{session_windows}'], { encoding: 'utf8' });

test('a real project: Changes, Files and Services visible, nothing is touched', async () => {
  test.skip(!PROJECT, 'set ATELIER_READONLY_PROJECT to a folder of git repositories');
  test.setTimeout(120000);
  const before = snapshot();
  const tmuxBefore = tmuxState();
  const locks: string[] = [];
  const watcher = setInterval(() => { for (const r of repos) if (existsSync(join(r, '.git', 'index.lock'))) locks.push(r); }, 50);
  const { env, home } = e2eEnv();
  writePrefs(home, { showServices: true, autoFetch: 'off' });
  const app = await electron.launch({ executablePath: resolve('release/mac-arm64/Atelier.app/Contents/MacOS/Atelier'), args: [`--project=${PROJECT}`], env });
  try {
    const win = await app.firstWindow();
    await expect(win.locator('.changes')).toBeVisible({ timeout: 20000 });
    await win.waitForTimeout(8000);
    await win.screenshot({ path: 'test-results/readonly-changes.png' });
    await win.getByRole('button', { name: 'Files (⌘⇧2)' }).click();
    await win.waitForTimeout(1000);
    await win.screenshot({ path: 'test-results/readonly-files.png' });
    await win.getByRole('button', { name: 'Services (⌘⇧3)' }).click();
    await expect(win.locator('.svc-row')).toHaveCount(4, { timeout: 15000 });
    await win.locator('.svc-row').first().click();
    await win.getByRole('button', { name: 'Back to grid' }).click();
    await win.waitForTimeout(4000);
    await win.screenshot({ path: 'test-results/readonly-services.png' });
  } finally {
    await app.close();
    clearInterval(watcher);
    try { process.kill((JSON.parse(readFileSync(join(home, 'atelierd.json'), 'utf8')) as { pid: number }).pid, 'SIGTERM'); } catch { /* fermo */ }
  }
  const after = snapshot();
  expect(locks).toEqual([]);
  for (let i = 0; i < before.length; i++) {
    expect({ r: after[i]!.r, ino: after[i]!.ino, mtime: after[i]!.mtime, fetched: after[i]!.fetched }).toEqual({ r: before[i]!.r, ino: before[i]!.ino, mtime: before[i]!.mtime, fetched: before[i]!.fetched });
  }
  expect(tmuxState()).toBe(tmuxBefore);
});
