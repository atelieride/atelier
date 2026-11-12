import { readFileSync, readdirSync } from 'node:fs';
import { homedir, hostname, userInfo } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { linearBudget } from '../../../tests/support/platform';
import { bestTime } from '../../../tests/support/timing';
import { type Invocation, type RawRun, build } from './write';
import { classifyWrite } from './write-outcome';

const PUSH_MAIN = { to: { remote: 'origin', branch: 'main' } };

// Real output of git 2.54 (write-outcome.record.test.ts), stdout and stderr merged as runWrite does, temp paths as /TMP.
const FIXTURES = join(__dirname, '__fixtures__');
const sample = (name: string) => readFileSync(join(FIXTURES, `write-${name}.txt`), 'utf8');
const run = (output: string, o: Partial<RawRun> = {}): RawRun => ({ code: 1, output, truncated: false, cancelled: false, timedOut: false, traced: true, ...o });
const commit = build.commit({ message: 'feat: x', amend: false, noVerify: false, coAuthor: false });
const classify = (inv: Invocation, name: string, o: Partial<RawRun> = {}, hooksExist = false) => classifyWrite(inv, run(sample(name), o), { hooksExist });

describe('classifyWrite on real git output', () => {
  test('the fixtures carry no home path, user name or host name', () => {
    for (const f of readdirSync(FIXTURES).filter((n) => n.startsWith('write-'))) {
      const s = readFileSync(join(FIXTURES, f), 'utf8');
      for (const bad of [homedir(), `/${userInfo().username}/`, hostname()]) expect(s.includes(bad), `${f}: ${bad}`).toBe(false);
    }
  });

  test('a failing hook named by trace2 → hook, its last line as the message, its output kept', () => {
    const r = classify(commit, 'hook-failure', { hookFailed: 'pre-commit', lastHook: 'pre-commit' });
    expect(r).toMatchObject({ outcome: 'hook', hook: 'pre-commit', message: 'src/a.ts:3 no-unused-vars' });
    expect(r.output).toContain('lint: 2 problems');
  });

  test('no trace2: a failure with no git error line is a hook when the op has hooks, an error otherwise', () => {
    expect(classify(commit, 'hook-failure', { traced: false }, true)).toMatchObject({ outcome: 'hook' });
    expect(classify(commit, 'hook-failure', { traced: false }, false).outcome).toBe('error');
    // trace2 worked and named no failing hook: not a hook.
    expect(classify(commit, 'hook-failure', { traced: true }, true).outcome).toBe('error');
  });

  test('a server-side hook (a local bare remote\'s pre-receive) is never our hook outcome', () => {
    const r = classify(build.push(PUSH_MAIN), 'push-remote-rejected', { hookFailed: 'pre-receive' });
    expect(r.outcome).toBe('error');
    expect(r.message).toBe('rejecting: main is a protected branch');
  });

  test('push rejected: non-fast-forward and fetch first → rejected; a lease on a moved remote → stale', () => {
    expect(classify(build.push(PUSH_MAIN), 'push-non-ff')).toMatchObject({ outcome: 'rejected', message: '! [rejected] main -> main (non-fast-forward)' });
    expect(classify(build.push(PUSH_MAIN), 'push-fetch-first').outcome).toBe('rejected');
    expect(classify(build.push({ lease: { remote: 'origin', branch: 'main', ref: 'refs/heads/main', oid: 'a'.repeat(40) } }), 'push-stale').outcome).toBe('stale');
  });

  test('protected branch / remote hook rejection → error with the remote\'s words; no upstream → error', () => {
    expect(classify(build.push(PUSH_MAIN), 'push-remote-rejected')).toMatchObject({ outcome: 'error', message: 'rejecting: main is a protected branch' });
    expect(classify(build.push(PUSH_MAIN), 'push-no-upstream')).toMatchObject({ outcome: 'error', message: 'The current branch feat/x has no upstream branch.' });
  });

  test('pinentry needing a tty → sign', () => {
    expect(classify(commit, 'sign-tty')).toMatchObject({ outcome: 'sign', message: 'gpg failed to sign the data:' });
  });

  test('identity missing → identity', () => {
    expect(classify(commit, 'identity')).toMatchObject({ outcome: 'identity', message: 'no email was given and auto-detection is disabled' });
  });

  test('a branch name clashing with another (feat and feat/x) → error naming both, never busy (no retry)', () => {
    const create = build.branchCreate({ name: 'feat/n', switch: true });
    expect(classifyWrite(create, run("fatal: cannot lock ref 'refs/heads/feat/n': 'refs/heads/feat' exists; cannot create 'refs/heads/feat/n'\n"), { hooksExist: false }))
      .toMatchObject({ outcome: 'error', message: "A branch named feat exists, so feat/n can't be made: pick another name" });
    expect(classifyWrite(build.branchRename('a', 'feat/x/y'), run("error: 'refs/heads/feat/x' exists; cannot create 'refs/heads/feat/x/y'\nfatal: branch rename failed\n"), { hooksExist: false }))
      .toMatchObject({ outcome: 'error', message: "A branch named feat/x exists, so feat/x/y can't be made: pick another name" });
    // A pull: a remote branch deleted upstream but never pruned here stands in the way of a new one in its folder.
    expect(classifyWrite(build.pull(false), run("error: cannot lock ref 'refs/remotes/origin/feat/x': 'refs/remotes/origin/feat' exists; cannot create 'refs/remotes/origin/feat/x'\n"), { hooksExist: false }))
      .toMatchObject({ outcome: 'error', message: 'origin/feat, gone from the remote, is still here and stands in the way of origin/feat/x: run git remote prune origin, then try again' });
  });

  test('index.lock held → busy (never deleted: the message names it)', () => {
    const r = classify(commit, 'lock');
    expect(r.outcome).toBe('busy');
    expect(r.message).toMatch(/^Unable to create '\/TMP\/.*\/\.git\/index\.lock': File exists\.$/);
    expect(classify(build.stage(['a']), 'lock').outcome).toBe('busy');
  });

  test('dirty overwrite (pull, switch, stash apply, untracked) → conflict + dirty + the files', () => {
    expect(classify(build.pull(false), 'pull-dirty')).toMatchObject({ outcome: 'conflict', dirty: true, files: ['a.txt'] });
    expect(classify(build.switchTo({ branch: 'other' }), 'switch-dirty')).toMatchObject({ outcome: 'conflict', dirty: true, files: ['a.txt'] });
    expect(classify(build.switchTo({ branch: 'other' }), 'switch-untracked')).toMatchObject({ outcome: 'conflict', dirty: true, files: ['new.txt'] });
    expect(classify(build.stashApply('a'.repeat(40)), 'stash-apply-dirty')).toMatchObject({ outcome: 'conflict', dirty: true, files: ['a.txt'] });
    expect(classify(build.pull(true), 'pull-rebase-unstaged')).toMatchObject({ outcome: 'conflict', dirty: true, message: 'cannot pull with rebase: You have unstaged changes.' });
  });

  test('rebase and stash pop conflicts → conflict with the files that have markers, not dirty', () => {
    const r = classify(build.pull(true), 'rebase-conflict');
    expect(r).toMatchObject({ outcome: 'conflict', files: ['a.txt'] });
    expect(r.message).toMatch(/^could not apply [0-9a-f]+\.\.\. local change$/);
    expect(r.dirty).toBeUndefined();
    expect(classify(build.stashApply('a'.repeat(40)), 'stash-pop-conflict')).toMatchObject({ outcome: 'conflict', files: ['a.txt'], message: 'CONFLICT (content): Merge conflict in a.txt' });
  });

  test('branch -d of an unmerged branch → conflict (GitOps offers -D)', () => {
    expect(classify(build.branchDelete('feat/x', false), 'branch-not-merged')).toMatchObject({ outcome: 'conflict', message: "the branch 'feat/x' is not fully merged" });
  });

  test('commit in the middle of a merge → state', () => {
    expect(classify(commit, 'merge-unmerged')).toMatchObject({ outcome: 'state', message: 'Committing is not possible because you have unmerged files.' });
  });

  test('nothing to commit → nothing; only for commit (stash output prints the same status lines)', () => {
    expect(classify(commit, 'nothing')).toMatchObject({ outcome: 'nothing', message: 'nothing to commit, working tree clean' });
    expect(classify(commit, 'nothing-untracked').outcome).toBe('nothing');
    expect(classify(build.stashApply('a'.repeat(40)), 'nothing').outcome).toBe('error');
  });

  test('stash push with nothing to save exits 0: nothing, never ok (no stash was made)', () => {
    const push = build.stashPush({ message: 'Atelier: before pull', untracked: true, staged: false });
    expect(classify(push, 'stash-nothing', { code: 0 }).outcome).toBe('nothing');
    expect(classifyWrite(push, run('Saved working directory and index state On main: Atelier: before pull\n', { code: 0 }), { hooksExist: false }).outcome).toBe('ok');
  });

  test('anything else → error with git\'s first meaningful line', () => {
    expect(classify(build.branchCreate({ name: 'feat/x', switch: false }), 'branch-exists')).toMatchObject({ outcome: 'error', message: "a branch named 'feat/x' already exists" });
  });
});

describe('classifyWrite: how the run ended', () => {
  test('code 0 → ok, output kept, the last hook named', () => {
    expect(classifyWrite(commit, run('[main abc] feat: x\n', { code: 0, lastHook: 'post-commit' }), { hooksExist: true }))
      .toEqual({ outcome: 'ok', output: '[main abc] feat: x\n', hook: 'post-commit' });
    // post-commit's exit status doesn't change git's: still ok.
    expect(classifyWrite(commit, run('', { code: 0, hookFailed: 'post-commit' }), { hooksExist: true }).outcome).toBe('ok');
  });

  test('cancelled wins over everything', () => {
    expect(classifyWrite(commit, run(sample('lock'), { cancelled: true, code: null }), { hooksExist: false })).toMatchObject({ outcome: 'cancelled' });
  });

  test('timed out: network for network ops, error for local ones', () => {
    expect(classifyWrite(build.push(PUSH_MAIN), run('', { timedOut: true, code: null }), { hooksExist: false })).toMatchObject({ outcome: 'network', message: 'The remote did not answer in time.' });
    expect(classifyWrite(commit, run('', { timedOut: true, code: null }), { hooksExist: false })).toMatchObject({ outcome: 'error', message: 'Git did not finish in time.' });
  });

  test('timed out while a hook ran: the hook is named, never the remote', () => {
    expect(classifyWrite(build.push(PUSH_MAIN), run('', { timedOut: true, code: null, hookRunning: 'pre-push' }), { hooksExist: true }))
      .toMatchObject({ outcome: 'error', hook: 'pre-push', message: 'The pre-push hook did not finish in time.' });
    expect(classifyWrite(commit, run('', { timedOut: true, code: null, hookRunning: 'pre-commit' }), { hooksExist: true }))
      .toMatchObject({ outcome: 'error', message: 'The pre-commit hook did not finish in time.' });
  });

  test('output past the cap (dropped, never killed for it): classified by the exit code', () => {
    expect(classifyWrite(commit, run('x'.repeat(10), { truncated: true, code: 0 }), { hooksExist: false })).toMatchObject({ outcome: 'ok' });
    expect(classifyWrite(commit, run('error: pathspec \'x\' did not match\n', { truncated: true, code: 1 }), { hooksExist: false })).toMatchObject({ outcome: 'error' });
  });

  test('a megabyte on one line (no newline, no space) is classified at once: the credential scrub is linear', () => {
    for (const line of ['x'.repeat(1_000_000), 'npm-run-build.v1.2.3-'.repeat(50_000), 'a://'.repeat(250_000)]) {
      const r = classifyWrite(build.push(PUSH_MAIN), run(`${line}\n`), { hooksExist: false });
      expect(r.message!.length).toBeLessThanOrEqual(200);
      expect(bestTime(() => classifyWrite(build.push(PUSH_MAIN), run(`${line}\n`), { hooksExist: false }), 3)).toBeLessThan(linearBudget(200));
    }
  });

  test('credentials are scrubbed as before: user:token@, token@, ssh user@; a scheme glued to a word is no scheme', () => {
    const out = [
      "remote: https://user:tok@host.example/o/r", "fatal: unable to access 'https://tok@host.example/x/'", 'git+ssh://u:p@h.example/x',
      'ssh://git@github.com/acme/store.git'
    ].join('\n');
    const r = classifyWrite(build.push(PUSH_MAIN), run(out), { hooksExist: false });
    for (const secret of ['user:tok', 'tok@', 'u:p@', 'git@']) expect(r.output).not.toContain(secret);
    expect(r.output).toContain('https://host.example/o/r');
    expect(r.output).toContain('ssh://github.com/acme/store.git');
  });

  test('network ops share fetch\'s auth and network rules; local ops never get them', () => {
    const auth = 'fatal: could not read Username for \'https://github.com\': terminal prompts disabled\n';
    expect(classifyWrite(build.push(PUSH_MAIN), run(auth), { hooksExist: false }).outcome).toBe('auth');
    expect(classifyWrite(build.pull(false), run('ssh: Could not resolve hostname github.com: nodename nor servname provided\nfatal: Could not read from remote repository.\n'), { hooksExist: false }))
      .toMatchObject({ outcome: 'network', message: 'ssh: Could not resolve hostname github.com: nodename nor servname provided' });
    expect(classifyWrite(commit, run(auth), { hooksExist: false }).outcome).toBe('error');
  });

  test('credentials never reach the message or the output', () => {
    const out = "To https://ada:ghp_secret@github.com/acme/store.git\n ! [remote rejected] main -> main (protected)\nerror: failed to push some refs to 'https://ada:ghp_secret@github.com/acme/store.git'\n";
    const r = classifyWrite(build.push(PUSH_MAIN), run(out), { hooksExist: false });
    expect(JSON.stringify(r)).not.toContain('ghp_secret');
    expect(r.output).toContain('https://github.com/acme/store.git');
  });

  test('messages are at most 200 characters', () => {
    const r = classifyWrite(commit, run(`fatal: ${'x'.repeat(500)}\n`), { hooksExist: false });
    expect(r.message!.length).toBeLessThanOrEqual(200);
  });

  test('a stash reference that no longer exists → stale', () => {
    expect(classifyWrite(build.stashDrop(4), run('error: stash@{4} is not a valid reference\n'), { hooksExist: false }).outcome).toBe('stale');
    expect(classifyWrite(build.stashApply('a'.repeat(40)), run('No stash entries found.\n'), { hooksExist: false }).outcome).toBe('stale');
  });
});
