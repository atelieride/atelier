import { describe, expect, test } from 'vitest';
import { posixTest } from '../../../tests/support/platform';
import { CO_AUTHOR_TRAILER, MESSAGE_MAX_BYTES } from '@shared/git-write';
import {
  LOCAL_TIMEOUT_MS, NETWORK_TIMEOUT_MS, build, isBuilt, runWrite, stripAnsi, validBranchName, validMessage, validOid, validRel,
  validRemote, validStashMessage, validWorktreePath
} from './write';

const OID = 'a'.repeat(40);
const OID256 = 'b'.repeat(64);
const PATHSPEC = ['--pathspec-from-file=-', '--pathspec-file-nul'];
const argv = (i: { args: readonly string[] }) => [...i.args];
const PUSH_MAIN = { to: { remote: 'origin', branch: 'main' } };

describe('validation helpers', () => {
  test('validRel: repo-relative, no `..` or `.` segment, no NUL, no leading slash, no empty segment, ≤ 4096 bytes', () => {
    for (const ok of ['a.txt', 'dir/x.ts', 'nuovo è.ts', 'with space/a b.md', '-x', ':(glob)*', '.env', 'a/.hidden', 'a..b', 'line\nbreak'])
      expect(validRel(ok), ok).toBe(true);
    for (const bad of ['', '/abs', '../x', 'a/../b', 'a/..', '..', '.', './a', 'a/./b', 'a\0b', 'a//b', 'dir/', 'x'.repeat(4097), 7, null, undefined])
      expect(validRel(bad as never), String(bad)).toBe(false);
    expect(validRel('é'.repeat(2048))).toBe(true);
    expect(validRel('é'.repeat(2049))).toBe(false);
  });

  test('validBranchName: git\'s refname rules, never a leading `-`, never HEAD', () => {
    for (const ok of ['main', 'feat/x', 'fix-1.2', 'release/v1', 'origin/main', 'a_b', 'ü-branch'])
      expect(validBranchName(ok), ok).toBe(true);
    for (const bad of ['', '-x', '--force', 'a b', ' ', 'a..b', 'a@{1}', '@', 'a~1', 'a^', 'a:b', 'a?', 'a*', 'a[', 'a\\b', 'a/', '/a',
      'a//b', 'a.', '.a', 'a/.b', 'x.lock', 'a/x.lock/b', 'HEAD', 'a\0b', 'a\tb', 'a\nb', 'a\x7fb', 'x'.repeat(256), 3, null])
      expect(validBranchName(bad as never), JSON.stringify(bad)).toBe(false);
  });

  test('validBranchName: never a refspec force (`+`), a full refname, a *HEAD name or an object id', () => {
    // `+main` as a push refspec forces main; `refs/heads/x` and `ORIG_HEAD` resolve to other refs than a branch's.
    for (const bad of ['+main', '+x', 'refs/heads/main', 'refs/x', 'HEAD', 'ORIG_HEAD', 'FETCH_HEAD', 'MERGE_HEAD', 'CHERRY_PICK_HEAD', 'feat/HEAD',
      'a'.repeat(40), '0123456789abcdef0123456789abcdef01234567', 'c'.repeat(64)])
      expect(validBranchName(bad), bad).toBe(false);
    for (const ok of ['heads', 'refs-x', 'x+', 'a+b', 'my-head', 'Header', 'a'.repeat(39), 'a'.repeat(41), 'feat/refs/x'])
      expect(validBranchName(ok), ok).toBe(true);
  });

  test('validOid: 40 or 64 lowercase hex', () => {
    expect(validOid(OID)).toBe(true);
    expect(validOid(OID256)).toBe(true);
    for (const bad of ['', 'a'.repeat(39), 'a'.repeat(41), 'A'.repeat(40), 'g'.repeat(40), `${'a'.repeat(39)}\0`, 'HEAD', `-${'a'.repeat(39)}`, 5])
      expect(validOid(bad as never)).toBe(false);
  });

  test('validRemote: a plain name, no `/`, never a leading `-`', () => {
    for (const ok of ['origin', 'upstream', 'my-fork', 'fork_2', 'a.b']) expect(validRemote(ok), ok).toBe(true);
    for (const bad of ['', '-x', '--upload-pack=x', 'a/b', 'a b', '.x', 'a..b', 'x.lock', 'a\0b', 'a:b', 'x'.repeat(101), null])
      expect(validRemote(bad as never), String(bad)).toBe(false);
  });

  test('validMessage: ≤ 64 KB in bytes, no NUL, not only whitespace (a trailer alone would become the message)', () => {
    expect(validMessage('feat: x\n\n#123 keeps')).toBe(true);
    expect(validMessage('x'.repeat(MESSAGE_MAX_BYTES))).toBe(true);
    expect(validMessage('x'.repeat(MESSAGE_MAX_BYTES + 1))).toBe(false);
    // Bytes, not characters: 'è' is two bytes.
    expect(validMessage('è'.repeat(MESSAGE_MAX_BYTES / 2))).toBe(true);
    expect(validMessage('è'.repeat(MESSAGE_MAX_BYTES / 2 + 1))).toBe(false);
    for (const bad of ['', '  \n\t\n', 'a\0b', 1]) expect(validMessage(bad as never), JSON.stringify(bad)).toBe(false);
  });

  test('validStashMessage: one line, ≤ 1 KB, no NUL, not empty', () => {
    expect(validStashMessage('Atelier: before pull')).toBe(true);
    expect(validStashMessage('x'.repeat(1024))).toBe(true);
    for (const bad of ['', '   ', 'a\nb', 'a\rb', 'a\0b', 'x'.repeat(1025), undefined]) expect(validStashMessage(bad as never)).toBe(false);
  });

  // POSIX: POSIX worktree path fixtures.
  posixTest('validWorktreePath: absolute, normalized, no NUL', () => {
    expect(validWorktreePath('/projects/acme/.worktrees/x')).toBe(true);
    for (const bad of ['', 'rel/x', '-x', '/a/../b', '/a/./b', '/a//b', '/a/', '/a\0b', '/']) expect(validWorktreePath(bad), bad).toBe(false);
  });
});

describe('build: golden argv per op', () => {
  test('stage: add --all with paths on stdin, NUL-separated; all → "."', () => {
    const i = build.stage(['a.txt', 'dir/b c.ts', '-x', ':(glob)*']);
    expect(argv(i)).toEqual(['add', '--all', ...PATHSPEC]);
    expect(i.stdin).toBe('a.txt\0dir/b c.ts\0-x\0:(glob)*');
    expect(i).toMatchObject({ op: 'stage', network: false });
    expect(build.stage('all').stdin).toBe('.');
  });

  test('unstage: restore --staged, or rm --cached -r --quiet without HEAD', () => {
    expect(argv(build.unstage(['a'], true))).toEqual(['restore', '--staged', ...PATHSPEC]);
    expect(argv(build.unstage(['a'], false))).toEqual(['reset', '-q', ...PATHSPEC]);
    expect(build.unstage('all', true).stdin).toBe('.');
    expect(build.unstage(['a', 'b'], false)).toMatchObject({ op: 'unstage', stdin: 'a\0b', network: false });
  });

  test('commit: message on stdin, whitespace cleanup; amend, no-verify and the trailer only when asked', () => {
    const base = { message: 'feat: x', amend: false, noVerify: false, coAuthor: false };
    expect(argv(build.commit(base))).toEqual(['commit', '--cleanup=whitespace', '-F', '-']);
    expect(build.commit(base)).toMatchObject({ op: 'commit', stdin: 'feat: x', network: false });
    expect(argv(build.commit({ ...base, amend: true, noVerify: true, coAuthor: true })))
      .toEqual(['commit', '--cleanup=whitespace', '-F', '-', '--amend', '--no-verify', '--trailer', CO_AUTHOR_TRAILER]);
  });

  test('commit: the trailer is never added twice', () => {
    const message = 'feat: x\n\nCo-authored-by: Claude <noreply@anthropic.com>';
    expect(argv(build.commit({ message, amend: false, noVerify: false, coAuthor: true }))).not.toContain('--trailer');
  });

  test('undoCommit: reset --soft <oid>~1', () => {
    expect(argv(build.undoCommit(OID))).toEqual(['reset', '--soft', `${OID}~1`]);
    expect(build.undoCommit(OID256).op).toBe('undoCommit');
  });

  test('push: to its own name, publish, or a lease on the oid seen plus --force-if-includes; never tags (push.followTags)', () => {
    // Explicit refspecs: push.default (matching, upstream) and remote.<name>.push can't widen or redirect any push.
    expect(build.push({ to: { remote: 'origin', branch: 'feat/x' } })).toMatchObject({ op: 'push', network: true });
    expect(argv(build.push({ to: { remote: 'origin', branch: 'feat/x' } }))).toEqual(['push', '--no-follow-tags', 'origin', 'refs/heads/feat/x:refs/heads/feat/x']);
    expect(() => build.push({})).toThrow(/push/);
    expect(() => build.push({ ...PUSH_MAIN, publish: { remote: 'origin', branch: 'main' } })).toThrow(/push/);
    expect(() => build.push({ to: { remote: '--mirror', branch: 'main' } })).toThrow(/remote/);
    expect(() => build.push({ to: { remote: 'origin', branch: '+main' } })).toThrow(/branch/);
    expect(argv(build.push({ publish: { remote: 'origin', branch: 'feat/x' } })))
      .toEqual(['push', '--no-follow-tags', '--set-upstream', 'origin', 'refs/heads/feat/x:refs/heads/feat/x']);
    expect(argv(build.push({ lease: { remote: 'origin', branch: 'main', ref: 'refs/heads/main', oid: OID } })))
      .toEqual(['push', '--no-follow-tags', `--force-with-lease=refs/heads/main:${OID}`, '--force-if-includes', 'origin', 'refs/heads/main:refs/heads/main']);
    expect(argv(build.push({ lease: { remote: 'fork', branch: 'feat/x', ref: 'refs/heads/x', oid: OID } })))
      .toEqual(['push', '--no-follow-tags', `--force-with-lease=refs/heads/x:${OID}`, '--force-if-includes', 'fork', 'refs/heads/feat/x:refs/heads/x']);
  });

  test('pull: ff-only without rebase, or rebase without autostash; rebase --abort', () => {
    expect(argv(build.pull(false))).toEqual(['pull', '--ff-only', '--no-rebase']);
    expect(argv(build.pull(true))).toEqual(['pull', '--rebase', '--no-autostash']);
    expect(build.pull(true)).toMatchObject({ op: 'pull', network: true });
    expect(argv(build.rebaseAbort())).toEqual(['rebase', '--abort']);
    expect(build.rebaseAbort()).toMatchObject({ op: 'pull', network: false });
  });

  test('switchTo: a branch, or --track refs/remotes/<remote>/<branch> (a local ref named origin/x never shadows it)', () => {
    expect(argv(build.switchTo({ branch: 'feat/x' }))).toEqual(['switch', 'feat/x']);
    expect(argv(build.switchTo({ track: { remote: 'origin', branch: 'feat/x' } }))).toEqual(['switch', '--track', 'refs/remotes/origin/feat/x']);
    expect(build.switchTo({ branch: 'main' }).op).toBe('switch');
  });

  test('branchCreate: branch --no-track <n> [<from>] or switch --no-track --create (long option) <n> [<from>]', () => {
    // A new branch tracks nothing (branch.autoSetupMerge makes one made from origin/main track it: Push and Sync would
    // aim at main), unless it is the same-named remote branch's local copy.
    expect(argv(build.branchCreate({ name: 'feat/y', switch: false }))).toEqual(['branch', '--no-track', 'feat/y']);
    expect(argv(build.branchCreate({ name: 'feat/y', from: 'refs/remotes/origin/main', switch: false }))).toEqual(['branch', '--no-track', 'feat/y', 'refs/remotes/origin/main']);
    expect(argv(build.branchCreate({ name: 'feat/y', switch: true }))).toEqual(['switch', '--no-track', '--create', 'feat/y']);
    expect(argv(build.branchCreate({ name: 'feat/y', from: OID, switch: true }))).toEqual(['switch', '--no-track', '--create', 'feat/y', OID]);
    expect(argv(build.branchCreate({ name: 'feat/y', from: 'refs/remotes/origin/feat/y', switch: true, track: true })))
      .toEqual(['switch', '--track', '--create', 'feat/y', 'refs/remotes/origin/feat/y']);
    expect(() => build.branchCreate({ name: 'feat/y', switch: true, track: true })).toThrow(/track/);
  });

  test('branchRename, branchDelete, branchRestore', () => {
    expect(argv(build.branchRename('old', 'new/name'))).toEqual(['branch', '-m', 'old', 'new/name']);
    expect(argv(build.branchDelete('feat/x', false))).toEqual(['branch', '-d', 'feat/x']);
    expect(argv(build.branchDelete('feat/x', true))).toEqual(['branch', '-D', 'feat/x']);
    expect(argv(build.branchRestore('feat/x', OID))).toEqual(['branch', 'feat/x', OID]);
    expect(build.branchRestore('feat/x', OID).op).toBe('branchRestore');
    // Undo of a delete puts its upstream back (branch -d drops branch.<name>.remote/merge).
    expect(argv(build.branchSetUpstream('feat/x', 'refs/remotes/origin/feat/x'))).toEqual(['branch', '--set-upstream-to=refs/remotes/origin/feat/x', 'feat/x']);
    expect(argv(build.branchSetUpstream('feat/x', 'refs/heads/main'))).toEqual(['branch', '--set-upstream-to=refs/heads/main', 'feat/x']);
    expect(build.branchSetUpstream('feat/x', 'refs/heads/main').op).toBe('branchRestore');
  });

  // POSIX: POSIX worktree path fixtures.
  posixTest('worktreeAdd: [-b <new>] <path> [<branch>]', () => {
    expect(argv(build.worktreeAdd({ path: '/p/wt', branch: 'feat/x' }))).toEqual(['worktree', 'add', '/p/wt', 'feat/x']);
    expect(argv(build.worktreeAdd({ path: '/p/wt', newName: 'feat/y' }))).toEqual(['worktree', 'add', '--no-track', '-b', 'feat/y', '/p/wt']);
    expect(argv(build.worktreeAdd({ path: '/p/wt', newName: 'feat/y', branch: 'main' }))).toEqual(['worktree', 'add', '--no-track', '-b', 'feat/y', '/p/wt', 'main']);
    // A new branch tracks nothing: from origin/main it would push there, and `git pull` would move it.
    expect(argv(build.worktreeAdd({ path: '/p/wt', newName: 'auto/y', branch: 'refs/remotes/origin/main' })))
      .toEqual(['worktree', 'add', '--no-track', '-b', 'auto/y', '/p/wt', 'refs/remotes/origin/main']);
    // The same-named remote branch's local copy tracks it.
    expect(argv(build.worktreeAdd({ path: '/p/wt', newName: 'feat/y', branch: 'refs/remotes/origin/feat/y', track: true })))
      .toEqual(['worktree', 'add', '--track', '-b', 'feat/y', '/p/wt', 'refs/remotes/origin/feat/y']);
    expect(() => build.worktreeAdd({ path: '/p/wt', branch: 'feat/x', track: true })).toThrow(/track/);
  });

  // POSIX: POSIX worktree path fixtures.
  posixTest('worktreeRemove: remove <path>, never --force (git keeps a dirty or locked worktree)', () => {
    expect(argv(build.worktreeRemove('/p/.claude/worktrees/auto-x'))).toEqual(['worktree', 'remove', '/p/.claude/worktrees/auto-x']);
    expect(build.worktreeRemove('/p/wt').op).toBe('worktreeRemove');
  });

  test('stash: push [-u] [--staged] -m, apply|pop --index stash@{n}, drop, store -m <msg> <oid>', () => {
    expect(argv(build.stashPush({ message: 'Atelier: before pull', untracked: true, staged: false }))).toEqual(['stash', 'push', '-u', '-m', 'Atelier: before pull']);
    expect(argv(build.stashPush({ message: 'm', untracked: false, staged: true }))).toEqual(['stash', 'push', '--staged', '-m', 'm']);
    expect(argv(build.stashPush({ message: 'm', untracked: false, staged: false }))).toEqual(['stash', 'push', '-m', 'm']);
    expect(argv(build.stashApply(OID))).toEqual(['stash', 'apply', '--index', OID]);
    expect(argv(build.stashApply(OID, { index: false }))).toEqual(['stash', 'apply', OID]);
    expect(() => build.stashApply('stash@{0}')).toThrow(/stash id/);
    expect(argv(build.stashDrop(3))).toEqual(['stash', 'drop', 'stash@{3}']);
    expect(argv(build.stashStore(OID, 'On main: wip'))).toEqual(['stash', 'store', '-m', 'On main: wip', OID]);
    expect(build.stashStore(OID, 'x').op).toBe('stashRestore');
  });

  test('literal pathspecs only for the ops that read paths from stdin (never in a hook\'s environment)', () => {
    for (const inv of [build.stage(['a']), build.stage('all'), build.unstage(['a'], true), build.unstage(['a'], false), build.restore(['a'])]) {
      expect(inv.literalPathspecs, inv.args.join(' ')).toBe(true);
    }
    for (const inv of [build.stashPush({ message: 'm', untracked: true, staged: false }), build.stashApply(OID), build.pull(true), build.push(PUSH_MAIN),
      build.commit({ message: 'm', amend: false, noVerify: false, coAuthor: false }), build.switchTo({ branch: 'x' })]) {
      expect(inv.literalPathspecs, inv.args.join(' ')).toBeUndefined();
    }
  });

  test('restore (discard): from HEAD, index and work tree, paths on stdin', () => {
    const i = build.restore(['a.txt', 'b c']);
    expect(argv(i)).toEqual(['restore', '--source=HEAD', '--staged', '--worktree', ...PATHSPEC]);
    expect(i).toMatchObject({ op: 'discard', stdin: 'a.txt\0b c', network: false });
  });

  test('invocations are frozen and recognized as built', () => {
    const i = build.stage(['a']);
    expect(Object.isFrozen(i)).toBe(true);
    expect(Object.isFrozen(i.args)).toBe(true);
    expect(isBuilt(i)).toBe(true);
    expect(isBuilt({ ...i })).toBe(false);
    expect(isBuilt({ op: 'commit', args: ['commit'], network: false } as never)).toBe(false);
  });
});

describe('build: refusals (every builder throws on invalid input)', () => {
  const t = (f: () => unknown) => expect(f).toThrow();

  test('paths', () => {
    for (const bad of ['../x', '/abs', 'a\0b', '', 'a/../b']) {
      t(() => build.stage([bad])); t(() => build.unstage([bad], true)); t(() => build.restore([bad]));
    }
    t(() => build.stage([])); t(() => build.unstage([], false)); t(() => build.restore([]));
    t(() => build.restore('all' as never)); t(() => build.stage('everything' as never)); t(() => build.stage('a' as never));
    t(() => build.stage(Array.from({ length: 100_001 }, (_, i) => `f${i}`)));
  });

  test('messages', () => {
    const base = { amend: false, noVerify: false, coAuthor: true };
    t(() => build.commit({ ...base, message: '' }));
    t(() => build.commit({ ...base, message: '\n  \n' }));
    t(() => build.commit({ ...base, message: 'a\0b' }));
    t(() => build.commit({ ...base, message: 'x'.repeat(65 * 1024) }));
    t(() => build.commit({ message: 'x', amend: 'yes', noVerify: false, coAuthor: false } as never));
    t(() => build.stashPush({ message: 'a\nb', untracked: false, staged: false }));
    t(() => build.stashPush({ message: '', untracked: false, staged: false }));
    t(() => build.stashPush({ message: 'm', untracked: true, staged: true }));
    t(() => build.stashStore(OID, 'x'.repeat(1025)));
  });

  test('refs and oids', () => {
    t(() => build.undoCommit('HEAD')); t(() => build.undoCommit('a'.repeat(39))); t(() => build.undoCommit(`${OID}~1`));
    t(() => build.switchTo({ branch: '-x' })); t(() => build.switchTo({ branch: '--force' })); t(() => build.switchTo({ branch: 'a b' }));
    t(() => build.switchTo({ track: 'origin/main' } as never)); t(() => build.switchTo({ track: { remote: '-o', branch: 'main' } }));
    t(() => build.switchTo({ track: { remote: 'origin', branch: '-x' } })); t(() => build.switchTo({ track: { remote: 'origin', branch: '' } }));
    t(() => build.switchTo({ track: { remote: 'a/b', branch: 'x' } })); t(() => build.switchTo({ track: { remote: 'origin', branch: '+x' } }));
    t(() => build.switchTo({} as never)); t(() => build.switchTo({ branch: 'a', track: { remote: 'o', branch: 'a' } } as never));
    t(() => build.switchTo({ branch: '+main' })); t(() => build.switchTo({ branch: 'refs/heads/main' }));
    t(() => build.branchSetUpstream('x', 'origin/x')); t(() => build.branchSetUpstream('x', '+refs/heads/x')); t(() => build.branchSetUpstream('x', '-x'));
    t(() => build.branchSetUpstream('x', 'refs/tags/v1')); t(() => build.branchSetUpstream('x', 'refs/remotes/o/a..b')); t(() => build.branchSetUpstream('-x', 'refs/heads/main'));
    t(() => build.branchCreate({ name: '-x', switch: false })); t(() => build.branchCreate({ name: 'x', from: '-y', switch: true }));
    t(() => build.branchCreate({ name: 'x', from: 'a..b', switch: false }));
    t(() => build.branchRename('a', '-b')); t(() => build.branchRename('-a', 'b'));
    t(() => build.branchDelete('-d', false)); t(() => build.branchDelete('x', 'yes' as never));
    t(() => build.branchRestore('x', 'nothex')); t(() => build.branchRestore('-x', OID));
    t(() => build.stashStore('nothex', 'm'));
  });

  test('push', () => {
    t(() => build.push({ publish: { remote: '-o', branch: 'x' } }));
    t(() => build.push({ publish: { remote: 'a/b', branch: 'x' } }));
    t(() => build.push({ publish: { remote: 'origin', branch: '--all' } }));
    t(() => build.push({ publish: { remote: 'origin', branch: '+main' } }));
    t(() => build.push({ publish: { remote: 'origin', branch: 'refs/heads/main' } }));
    const lease = { remote: 'origin', branch: 'main', ref: 'refs/heads/main', oid: OID };
    t(() => build.push({ lease: { ...lease, oid: 'abc' } }));
    t(() => build.push({ lease: { ...lease, ref: 'main' } }));
    t(() => build.push({ lease: { ...lease, ref: '-main' } }));
    t(() => build.push({ lease: { ...lease, ref: '+refs/heads/main' } }));
    t(() => build.push({ lease: { ...lease, ref: 'refs/remotes/origin/main' } }));
    t(() => build.push({ lease: { ...lease, remote: '-o' } }));
    t(() => build.push({ lease: { ...lease, branch: '+main' } }));
    t(() => build.push({ lease, publish: { remote: 'origin', branch: 'main' } }));
    t(() => build.push(null as never));
  });

  test('worktree and stash indexes', () => {
    t(() => build.worktreeAdd({ path: 'rel', branch: 'x' }));
    t(() => build.worktreeAdd({ path: '/a/../b', branch: 'x' }));
    t(() => build.worktreeAdd({ path: '/p\0', branch: 'x' }));
    t(() => build.worktreeAdd({ path: '/p' }));
    t(() => build.worktreeAdd({ path: '/p', newName: '-b' }));
    t(() => build.worktreeAdd({ path: '/p', branch: '-x' }));
    for (const p of ['rel', '/a/../b', '/p\0', '/p/', '/', '-x', '', 1 as never]) t(() => build.worktreeRemove(p));
    for (const n of [-1, 1000, 1.5, NaN, '0' as never]) { t(() => build.stashDrop(n)); }
    t(() => build.stashApply('HEAD')); t(() => build.stashApply('-x'));
  });
});

describe('stripAnsi', () => {
  test('removes colors, cursor moves and OSC, keeps text, tabs and newlines', () => {
    expect(stripAnsi('\x1b[31merror\x1b[0m: x\n\tb\x1b[2K\x1b]8;;http://x\x07link\x1b]8;;\x07\x07')).toBe('error: x\n\tblink');
  });
});

describe('runWrite refusals (no process started)', () => {
  const env = { PATH: process.env.PATH, GIT_EDITOR: ':', GIT_SEQUENCE_EDITOR: ':', GIT_TERMINAL_PROMPT: '0' };

  test('a root that is not absolute or has a NUL', async () => {
    for (const root of ['rel', '', '/a\0b']) {
      const r = await runWrite(root, build.stage(['a']), { env, timeoutMs: 1000 });
      expect(r).toMatchObject({ code: null, cancelled: false, timedOut: false, traced: false });
      expect(r.output).toMatch(/refused/);
    }
  });

  test('an invocation no builder made', async () => {
    const forged = { op: 'stage', args: ['reset', '--soft', 'HEAD~1'], network: false } as never;
    const r = await runWrite('/x', forged, { env, timeoutMs: 1000 });
    expect(r.code).toBeNull();
    expect(r.output).toMatch(/refused/);
  });

  test('an environment without the write rules (no editor, no prompt)', async () => {
    for (const k of Object.keys(env).filter((k) => k !== 'PATH')) {
      const r = await runWrite('/x', build.stage(['a']), { env: { ...env, [k]: undefined }, timeoutMs: 1000 });
      expect(r.output, k).toMatch(/refused/);
    }
  });

  test('an environment with any other GIT_* variable (not writeEnv\'s)', async () => {
    for (const k of ['GIT_DIR', 'GIT_INDEX_FILE', 'GIT_WORK_TREE', 'GIT_CONFIG_PARAMETERS', 'GIT_SSH_COMMAND', 'GIT_EXEC_PATH']) {
      const r = await runWrite('/x', build.stage(['a']), { env: { ...env, [k]: '/elsewhere' }, timeoutMs: 1000 });
      expect(r.output, k).toMatch(/refused.*environment with/);
    }
  });

  test('a signal aborted already: cancelled, nothing run', async () => {
    const c = new AbortController(); c.abort();
    const r = await runWrite('/x', build.stage(['a']), { env, timeoutMs: 1000, signal: c.signal });
    expect(r).toMatchObject({ cancelled: true, code: null });
  });

  test('timeouts', () => {
    expect(LOCAL_TIMEOUT_MS).toBe(15 * 60_000);
    expect(NETWORK_TIMEOUT_MS).toBe(5 * 60_000);
  });
});
