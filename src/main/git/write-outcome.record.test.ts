import { chmodSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir, hostname, tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { git } from '../../../tests/support/git-fixture';
import { type Invocation, build, runWrite } from './write';
import { writeEnv } from './write-env';

const PUSH_MAIN = { to: { remote: 'origin', branch: 'main' } };

/**
 * Records the real output of failing write ops into __fixtures__/write-*.txt, for write-outcome.test.ts: real git in
 * the run's temp root, isolated config, temp paths scrubbed to /TMP. Skipped unless asked:
 *   ATELIER_RECORD_WRITE_FIXTURES=1 npx vitest run src/main/git/write-outcome.record.test.ts
 */
const RECORD = process.env.ATELIER_RECORD_WRITE_FIXTURES === '1';
const FIXTURES = join(__dirname, '__fixtures__');

const env = (): NodeJS.ProcessEnv => {
  const e = writeEnv(process.env, { isolated: true });
  delete e.EMAIL;
  return e;
};

function scrub(s: string): string {
  const roots = new Set<string>();
  for (const t of [tmpdir(), realpathSync(tmpdir())]) { roots.add(t); roots.add(t.replace(/^\/private/, '')); }
  let out = s;
  for (const r of [...roots].sort((a, b) => b.length - a.length)) out = out.split(r).join('/TMP');
  return out;
}

function save(name: string, output: string): void {
  const out = scrub(output);
  for (const bad of [homedir(), userInfo().username, hostname()]) expect(out.includes(bad), `${name} contains ${bad}`).toBe(false);
  writeFileSync(join(FIXTURES, `write-${name}.txt`), out);
}

async function record(name: string, root: string, inv: Invocation, e = env()): Promise<void> {
  const r = await runWrite(root, inv, { env: e, timeoutMs: 30_000 });
  save(name, r.output);
}

function repo(name: string, files: Record<string, string> = { 'a.txt': 'one\ntwo\nthree\n' }): string {
  const dir = join(realpathSync(mkdtempSync(join(tmpdir(), 'atl-rec-'))), name);
  mkdirSync(dir);
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.name', 'Ada');
  git(dir, 'config', 'user.email', 'ada@example.com');
  for (const [rel, body] of Object.entries(files)) writeFileSync(join(dir, rel), body);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'start');
  return dir;
}

/** A bare remote with `main` pushed from `a`, and a clone `b` of it (identity in its own config). */
function remotePair(): { bare: string; a: string; b: string } {
  const a = repo('a');
  const bare = join(a, '..', 'remote.git');
  git(a, 'init', '-q', '--bare', '-b', 'main', bare);
  git(a, 'remote', 'add', 'origin', bare);
  git(a, 'push', '-q', '-u', 'origin', 'main');
  const b = join(a, '..', 'b');
  git(a, 'clone', '-q', bare, b);
  git(b, 'config', 'user.name', 'Ada');
  git(b, 'config', 'user.email', 'ada@example.com');
  return { bare, a, b };
}

function hook(dir: string, name: string, body: string): void {
  const p = join(dir, name);
  writeFileSync(p, `#!/bin/sh\n${body}\n`);
  chmodSync(p, 0o755);
}

const msg = { message: 'feat: x', amend: false, noVerify: false, coAuthor: false };

describe.skipIf(!RECORD)('record write outcome fixtures (real git)', () => {
  test('hook failure', async () => {
    const r = repo('r');
    hook(join(r, '.git/hooks'), 'pre-commit', 'echo "lint: 2 problems (1 error, 1 warning)" >&2\necho "  src/a.ts:3  no-unused-vars"\nexit 1');
    writeFileSync(join(r, 'a.txt'), 'changed\n');
    git(r, 'add', 'a.txt');
    await record('hook-failure', r, build.commit(msg));
  });

  // push-no-upstream.txt stays as recorded: a plain `git push` without an upstream, which Atelier no longer runs (every
  // push names its remote and refspec) but a classifier test still reads.
  test('push: non-fast-forward, fetch first, remote rejection, stale lease', async () => {
    const { bare, a, b } = remotePair();
    git(a, 'commit', '-q', '--allow-empty', '-m', 'remote moved');
    git(a, 'push', '-q');
    git(b, 'commit', '-q', '--allow-empty', '-m', 'local');
    await record('push-fetch-first', b, build.push(PUSH_MAIN));
    git(b, 'fetch', '-q');
    await record('push-non-ff', b, build.push(PUSH_MAIN));
    // The lease names the oid the user saw before the remote moved: `start`, HEAD~1 here.
    const seen = git(b, 'rev-parse', 'HEAD~1').trim();
    await record('push-stale', b, build.push({ lease: { remote: 'origin', branch: 'main', ref: 'refs/heads/main', oid: seen } }));
    git(b, 'pull', '-q', '--rebase');
    hook(join(bare, 'hooks'), 'pre-receive', 'echo "rejecting: main is a protected branch" >&2\nexit 1');
    await record('push-remote-rejected', b, build.push(PUSH_MAIN));
  });

  test('signing needs a tty (pinentry)', async () => {
    const r = repo('r');
    const gpg = join(r, '..', 'fake-gpg');
    writeFileSync(gpg, '#!/bin/sh\necho "gpg: signing failed: Inappropriate ioctl for device" >&2\necho "gpg: [stdin]: clear-sign failed: Inappropriate ioctl for device" >&2\nexit 2\n');
    chmodSync(gpg, 0o755);
    git(r, 'config', 'commit.gpgsign', 'true');
    git(r, 'config', 'gpg.program', gpg);
    writeFileSync(join(r, 'a.txt'), 'signed\n');
    git(r, 'add', 'a.txt');
    await record('sign-tty', r, build.commit(msg));
  });

  test('identity missing', async () => {
    const r = repo('r');
    git(r, 'config', '--unset', 'user.name');
    git(r, 'config', '--unset', 'user.email');
    git(r, 'config', 'user.useConfigOnly', 'true');
    writeFileSync(join(r, 'a.txt'), 'who\n');
    git(r, 'add', 'a.txt');
    await record('identity', r, build.commit(msg));
  });

  test('index.lock held', async () => {
    const r = repo('r');
    writeFileSync(join(r, 'a.txt'), 'locked\n');
    git(r, 'add', 'a.txt');
    writeFileSync(join(r, '.git/index.lock'), '');
    await record('lock', r, build.commit(msg));
  });

  test('dirty overwrite: pull, switch, stash apply, untracked on switch', async () => {
    const { a, b } = remotePair();
    writeFileSync(join(a, 'a.txt'), 'one\nTWO\nthree\n');
    git(a, 'commit', '-q', '-am', 'remote change');
    git(a, 'push', '-q');
    writeFileSync(join(b, 'a.txt'), 'one\nmine\nthree\n');
    await record('pull-dirty', b, build.pull(false));
    await record('pull-rebase-unstaged', b, build.pull(true));

    const r = repo('r');
    git(r, 'switch', '-q', '-c', 'other');
    writeFileSync(join(r, 'a.txt'), 'other\n');
    writeFileSync(join(r, 'new.txt'), 'tracked on other\n');
    git(r, 'add', '-A');
    git(r, 'commit', '-q', '-m', 'other');
    git(r, 'switch', '-q', 'main');
    writeFileSync(join(r, 'a.txt'), 'local\n');
    await record('switch-dirty', r, build.switchTo({ branch: 'other' }));
    git(r, 'restore', 'a.txt');
    writeFileSync(join(r, 'new.txt'), 'untracked here\n');
    await record('switch-untracked', r, build.switchTo({ branch: 'other' }));

    const s = repo('s');
    writeFileSync(join(s, 'a.txt'), 'stashed\n');
    git(s, 'stash', 'push', '-q', '-m', 'wip');
    writeFileSync(join(s, 'a.txt'), 'dirty now\n');
    await record('stash-apply-dirty', s, build.stashApply(git(s, 'rev-parse', 'stash@{0}').trim()));
  });

  test('conflicts: rebase, stash pop', async () => {
    const { a, b } = remotePair();
    writeFileSync(join(a, 'a.txt'), 'one\nREMOTE\nthree\n');
    git(a, 'commit', '-q', '-am', 'remote change');
    git(a, 'push', '-q');
    writeFileSync(join(b, 'a.txt'), 'one\nLOCAL\nthree\n');
    git(b, 'commit', '-q', '-am', 'local change');
    await record('rebase-conflict', b, build.pull(true));

    const s = repo('s');
    writeFileSync(join(s, 'a.txt'), 'one\nSTASH\nthree\n');
    git(s, 'stash', 'push', '-q', '-m', 'wip');
    writeFileSync(join(s, 'a.txt'), 'one\nCOMMITTED\nthree\n');
    git(s, 'commit', '-q', '-am', 'moved on');
    await record('stash-pop-conflict', s, build.stashApply(git(s, 'rev-parse', 'stash@{0}').trim()));
  });

  test('state: commit and pull in the middle of a merge', async () => {
    const r = repo('r');
    git(r, 'switch', '-q', '-c', 'side');
    writeFileSync(join(r, 'a.txt'), 'one\nSIDE\nthree\n');
    git(r, 'commit', '-q', '-am', 'side');
    git(r, 'switch', '-q', 'main');
    writeFileSync(join(r, 'a.txt'), 'one\nMAIN\nthree\n');
    git(r, 'commit', '-q', '-am', 'main');
    try { git(r, 'merge', '-q', 'side'); } catch { /* conflicts: the point */ }
    await record('merge-unmerged', r, build.commit(msg));
  });

  test('nothing to commit, nothing to stash, branch not merged, branch exists', async () => {
    const r = repo('r');
    await record('nothing', r, build.commit(msg));
    writeFileSync(join(r, 'untracked.txt'), 'x\n');
    await record('nothing-untracked', r, build.commit(msg));
    const s = repo('s');
    await record('stash-nothing', s, build.stashPush({ message: 'Atelier: before pull', untracked: true, staged: false }));
    git(s, 'switch', '-q', '-c', 'feat/x');
    git(s, 'commit', '-q', '--allow-empty', '-m', 'unmerged');
    git(s, 'switch', '-q', 'main');
    await record('branch-not-merged', s, build.branchDelete('feat/x', false));
    await record('branch-exists', s, build.branchCreate({ name: 'feat/x', switch: false }));
  });
});
