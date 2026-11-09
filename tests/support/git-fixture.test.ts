// The fixture's stash reader while something else pops the last stash, as the app does under an e2e's poll.
import { spawn } from 'node:child_process';
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect } from 'vitest';
import { STASH_CHANGING, commit, fixtureGitEnv, git, stashList } from './git-fixture';
import { posixTest } from './platform';

// A stash pushed and popped again and again: each pop drops the last stash, the moment `git stash list` can fail on.
const WRITER = `
const { execFileSync } = require('node:child_process');
const { writeFileSync } = require('node:fs');
const { join } = require('node:path');
const [dir, rounds] = process.argv.slice(1);
const git = (...a) => execFileSync('git', ['-c', 'user.name=Ada', '-c', 'user.email=ada@example.com', ...a], { cwd: dir, stdio: 'ignore' });
for (let i = 0; i < Number(rounds); i++) {
  writeFileSync(join(dir, 'f.txt'), 'round ' + i + '\\n');
  git('stash', 'push', '-q');
  git('stash', 'pop', '-q');
}
`;

// macOS and Linux only: the race is git's own, the e2e it guards runs on macOS, and on Windows the loop cost 37 s of
// the CI runner's unit run.
posixTest('stashList never throws while the last stash is popped: it reads as changing, so a poll tries again', async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'atl-stash-race-')));
  git(dir, 'init', '-q', '-b', 'main');
  commit(dir, 'feat: first', { 'f.txt': 'base\n' });
  const writer = spawn(process.execPath, ['-e', WRITER, dir, '120'], { env: fixtureGitEnv, stdio: 'ignore' });
  const ended = new Promise<number | null>((done) => writer.on('exit', done));
  let running = true;
  void ended.then(() => { running = false; });
  const seen = new Set<string>();
  try {
    while (running) {
      const read = stashList(dir);
      seen.add(read === STASH_CHANGING ? 'changing' : read === '' ? 'empty' : 'listed');
      if (read !== STASH_CHANGING && read !== '') expect(read).toMatch(/^[0-9a-f]{40} WIP on main: /);
      await new Promise((tick) => setImmediate(tick));
    }
  } finally {
    writer.kill();
  }
  expect(await ended).toBe(0);
  expect(seen.has('listed')).toBe(true);
  expect(stashList(dir)).toBe('');
}, 90_000);
