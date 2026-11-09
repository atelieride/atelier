import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { AUTHOR, COMMITS, FILES, PROJECT_NAME } from '../../../src/demo/world/project';

// The website's fictional project lives in the demo's world; this writes it to disk.
const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const git = (cwd: string, ...a: string[]) => execFileSync('git', ['-c', `user.name=${AUTHOR.name}`, '-c', `user.email=${AUTHOR.email}`, ...a], { cwd, env: gitEnv });

/** Creates <home>/code/acme-store with the world's three-commit history and returns its path. */
export function makeDemoProject(home: string): string {
  const root = join(home, 'code', PROJECT_NAME);
  for (const [rel, text] of Object.entries(FILES)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
  git(root, 'init', '-q', '-b', 'main');
  for (const c of COMMITS) {
    git(root, 'add', '--', ...c.files);
    git(root, 'commit', '-q', '-m', c.message);
  }
  return root;
}
