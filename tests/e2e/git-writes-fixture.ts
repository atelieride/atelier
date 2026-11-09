// A project for the git writes e2e: several repositories in the run's private
// temp root, each with its own repo-local identity (never the user's git config: no global or system config, so no
// hooks, signing or aliases of whoever runs the tests), one first commit on main.
import { _electron as electron, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fixtureGitEnv } from '../support/git-fixture';
import { execFileSync } from 'node:child_process';
import { e2eEnv } from './env';

export const gitEnv = fixtureGitEnv;

/** git in a fixture repository, with the isolated config (the repo's own identity applies). */
export function git(cwd: string, ...a: string[]): string {
  return execFileSync('git', a, { cwd, env: fixtureGitEnv, encoding: 'utf8' });
}

export function write(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

export type GitAppEnv = { env: Record<string, string>; home: string };

/**
 * The app on `root` through e2eEnv (its own ATELIER_HOME), with the fake Claude that "edits" `edit` when a session
 * starts. `stop` closes the app and its atelierd; `command` sends a menu command as the native menu does. `reuse`: the
 * environment of an earlier launch (its home, so its saved state), for a relaunch.
 */
export async function launchGitApp(root: string, edit?: string, reuse?: GitAppEnv): Promise<{ app: ElectronApplication; win: Page; panel: Locator; stop: () => Promise<void>; command: (cmd: string) => Promise<void>; appEnv: GitAppEnv }> {
  const { env, home } = reuse ?? e2eEnv({ ATELIER_CLAUDE_BIN: resolve('tests/e2e/fake-claude-edit.pl'), ...(edit ? { ATELIER_FAKE_EDIT: edit } : {}) });
  const app = await electron.launch({ args: ['out/main/index.js', `--project=${root}`], env });
  const win = await app.firstWindow();
  const stop = async () => {
    await app.close();
    try { process.kill((JSON.parse(readFileSync(join(home, 'atelierd.json'), 'utf8')) as { pid: number }).pid, 'SIGTERM'); } catch { /* already stopped */ }
  };
  const command = async (cmd: string) => { await app.evaluate(({ BrowserWindow }, c) => BrowserWindow.getAllWindows()[0]!.webContents.send('ev:command', c), cmd); };
  return { app, win, panel: win.locator('.changes'), stop, command, appEnv: { env, home } };
}

/**
 * A repo-local, husky-like pre-commit (in `.git/hooks`, never a global hooks path): it prints two lint lines and fails
 * while `.git/hook-fail` exists, and first waits (up to 30 s, in short sleeps) while `.git/hook-slow` exists, so a test
 * that removes the marker never leaves it running. Turned on and off with `hookMarker`.
 */
const PRE_COMMIT = `#!/bin/sh
i=0
while [ -f .git/hook-slow ] && [ $i -lt 150 ]; do sleep 0.2; i=$((i + 1)); done
if [ -f .git/hook-fail ]; then
  echo "lint: src/cart.ts:1 missing semicolon"
  echo "lint: 1 problem (1 error)" >&2
  exit 1
fi
exit 0
`;

export function hookMarker(dir: string, kind: 'fail' | 'slow', on: boolean): void {
  const p = join(dir, '.git', `hook-${kind}`);
  if (on) writeFileSync(p, '');
  else rmSync(p, { force: true });
}

/**
 * `names`: the repositories' paths in the project (a nested one like `plugins/payments` too); each gets `files`.
 * `hook`: the pre-commit above in each; `remote`: a bare remote per repository (outside the project, in the run's temp
 * root) as `origin`, main pushed and tracked.
 */
export function gitWritesProject(names: string[], files: Record<string, string> = { 'src/app.ts': 'export const app = 1;\n', 'README.md': '# repo\n' }, o: { hook?: boolean; remote?: boolean } = {}): { root: string; repo: (name: string) => string; remote: (name: string) => string } {
  const root = mkdtempSync(join(tmpdir(), 'atl-gw-'));
  const remotes = o.remote ? mkdtempSync(join(tmpdir(), 'atl-gw-remote-')) : '';
  const remote = (name: string) => join(remotes, `${name.replace(/\//g, '-')}.git`);
  for (const name of names) {
    const dir = join(root, name);
    mkdirSync(dir, { recursive: true });
    git(dir, 'init', '-q', '-b', 'main');
    git(dir, 'config', 'user.name', 'Ada');
    git(dir, 'config', 'user.email', 'ada@example.com');
    git(dir, 'config', 'commit.gpgsign', 'false');
    for (const [rel, text] of Object.entries(files)) write(join(dir, rel), text);
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', `chore: start ${name}`);
    if (o.remote) {
      git(remotes, 'init', '-q', '--bare', '-b', 'main', remote(name));
      git(dir, 'remote', 'add', 'origin', remote(name));
      git(dir, 'push', '-q', '-u', 'origin', 'main');
    }
    if (o.hook) {
      const hook = join(dir, '.git', 'hooks', 'pre-commit');
      write(hook, PRE_COMMIT);
      chmodSync(hook, 0o755);
    }
  }
  return { root, repo: (name) => join(root, name), remote };
}
