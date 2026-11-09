import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, test } from 'vitest';
import { CO_AUTHOR_TRAILER } from '@shared/git-write';
import { git } from '../../../tests/support/git-fixture';
import { type Trace2Signal, disposeTrace2Dir, trace2Dir } from './trace2';
import { type Invocation, type RawRun, WRITE_MAX_BYTES, build, killAllWrites, runWrite, stopAllWrites } from './write';
import { writeEnv } from './write-env';
import { classifyWrite } from './write-outcome';

const PUSH_MAIN = { to: { remote: 'origin', branch: 'main' } };

// Real git in the run's private temp root, isolated config (no global/system file, no credential helper), identity in
// each repo's own config.

afterAll(() => disposeTrace2Dir());

const env = (): NodeJS.ProcessEnv => {
  const e = writeEnv(process.env, { isolated: true });
  delete e.EMAIL;
  return e;
};

function repo(files: Record<string, string> = { 'a.txt': 'one\n' }, o: { commit?: boolean } = {}): string {
  const dir = join(realpathSync(mkdtempSync(join(tmpdir(), 'atl-wr-'))), 'repo');
  mkdirSync(dir);
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.name', 'Ada');
  git(dir, 'config', 'user.email', 'ada@example.com');
  for (const [rel, body] of Object.entries(files)) writeFileSync(join(dir, rel), body);
  if (o.commit !== false) { git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', 'start'); }
  return dir;
}

function hook(dir: string, name: string, body: string): void {
  const p = join(dir, '.git', 'hooks', name);
  writeFileSync(p, `#!/bin/sh\n${body}\n`);
  chmodSync(p, 0o755);
}

interface Seen { chunks: string[]; phases: Trace2Signal[] }
async function run(dir: string, inv: Invocation, o: { timeoutMs?: number; signal?: AbortSignal; gpgProgram?: string; e?: NodeJS.ProcessEnv; cleanup?: boolean } = {}): Promise<RawRun & Seen> {
  const seen: Seen = { chunks: [], phases: [] };
  const r = await runWrite(dir, inv, {
    env: o.e ?? env(), timeoutMs: o.timeoutMs ?? 30_000, signal: o.signal, gpgProgram: o.gpgProgram, ...(o.cleanup ? { cleanup: true } : {}),
    onChunk: (s) => seen.chunks.push(s), onPhase: (p) => seen.phases.push(p)
  });
  return { ...r, ...seen };
}

/** Paths staged (index vs HEAD, or vs the empty tree without HEAD), NUL-safe. */
function staged(dir: string): string[] {
  let hasHead = true;
  try { git(dir, 'rev-parse', '-q', '--verify', 'HEAD'); } catch { hasHead = false; }
  const out = hasHead ? git(dir, 'diff', '--cached', '--name-only', '--no-renames', '-z') : git(dir, 'ls-files', '-z');
  return out.split('\0').filter(Boolean).sort();
}

const msg = (message: string, o: Partial<{ amend: boolean; noVerify: boolean; coAuthor: boolean }> = {}) =>
  build.commit({ message, amend: false, noVerify: false, coAuthor: false, ...o });

async function waitFor(f: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!f()) {
    if (Date.now() > end) throw new Error('waitFor: timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
}

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

describe('stage and unstage (paths literal, through stdin)', () => {
  test('modified, renamed (both paths), deleted, untracked, spaces and unicode, `-x` and `:(glob)*` taken literally', async () => {
    const dir = repo({ 'a.txt': 'one\n', 'old name.txt': 'r\n', 'del.txt': 'd\n', 'keep.txt': 'k\n' });
    writeFileSync(join(dir, 'a.txt'), 'two\n');
    renameSync(join(dir, 'old name.txt'), join(dir, 'nuovo è.txt'));
    rmSync(join(dir, 'del.txt'));
    writeFileSync(join(dir, 'with space ü.txt'), 'u\n');
    writeFileSync(join(dir, '-x'), 'dash\n');
    writeFileSync(join(dir, ':(glob)*'), 'magic\n');
    // Decoys: a glob would match these; a literal pathspec never does.
    writeFileSync(join(dir, 'b.txt'), 'b\n');
    writeFileSync(join(dir, 'keep.txt'), 'k2\n');
    const rels = ['a.txt', 'old name.txt', 'nuovo è.txt', 'del.txt', 'with space ü.txt', '-x', ':(glob)*'];

    const r = await run(dir, build.stage(rels));
    expect(r.code, r.output).toBe(0);
    expect(classifyWrite(build.stage(rels), r, { hooksExist: false }).outcome).toBe('ok');
    expect(staged(dir)).toEqual([...rels].sort());

    const u = await run(dir, build.unstage(rels, true));
    expect(u.code, u.output).toBe(0);
    expect(staged(dir)).toEqual([]);
    // The work tree is untouched by unstage.
    expect(readFileSync(join(dir, 'a.txt'), 'utf8')).toBe('two\n');
    expect(existsSync(join(dir, 'del.txt'))).toBe(false);

    expect((await run(dir, build.stage('all'))).code).toBe(0);
    expect(staged(dir)).toEqual([...rels, 'b.txt', 'keep.txt'].sort());
    expect((await run(dir, build.unstage('all', true))).code).toBe(0);
    expect(staged(dir)).toEqual([]);
  });

  test('no HEAD yet: unstage is rm --cached, the files stay on disk', async () => {
    const dir = repo({ 'a.txt': 'a\n', 'b c.txt': 'b\n' }, { commit: false });
    expect((await run(dir, build.stage(['a.txt', 'b c.txt']))).code).toBe(0);
    expect(staged(dir)).toEqual(['a.txt', 'b c.txt']);
    const u = await run(dir, build.unstage(['b c.txt'], false));
    expect(u.code, u.output).toBe(0);
    expect(staged(dir)).toEqual(['a.txt']);
    expect(readFileSync(join(dir, 'b c.txt'), 'utf8')).toBe('b\n');
  });

  test('no HEAD yet: a staged file changed again (AM) still unstages, and its newer content stays on disk', async () => {
    const dir = repo({ 'a.txt': 'a\n', 'b.txt': 'b\n' }, { commit: false });
    expect((await run(dir, build.stage('all'))).code).toBe(0);
    writeFileSync(join(dir, 'a.txt'), 'a, changed\n');
    const u = await run(dir, build.unstage('all', false));
    expect(u.code, u.output).toBe(0);
    expect(staged(dir)).toEqual([]);
    expect(readFileSync(join(dir, 'a.txt'), 'utf8')).toBe('a, changed\n');
  });

  test('restore (discard) brings back HEAD\'s content in the index and the work tree', async () => {
    const dir = repo({ 'a.txt': 'one\n' });
    writeFileSync(join(dir, 'a.txt'), 'changed\n');
    git(dir, 'add', 'a.txt');
    const r = await run(dir, build.restore(['a.txt']));
    expect(r.code, r.output).toBe(0);
    expect(readFileSync(join(dir, 'a.txt'), 'utf8')).toBe('one\n');
    expect(staged(dir)).toEqual([]);
  });
});

describe('commit', () => {
  test('the message goes through stdin: a `#123` line survives; the trailer is added once', async () => {
    const dir = repo();
    writeFileSync(join(dir, 'a.txt'), 'two\n');
    git(dir, 'add', 'a.txt');
    const r = await run(dir, msg('fix: the bug\n\n#123 was the issue\n  \n', { coAuthor: true }));
    expect(r.code, r.output).toBe(0);
    const body = git(dir, 'log', '-1', '--format=%B');
    expect(body).toContain('#123 was the issue');
    expect(body.split(CO_AUTHOR_TRAILER).length - 1).toBe(1);

    writeFileSync(join(dir, 'a.txt'), 'three\n');
    git(dir, 'add', 'a.txt');
    // Not byte-identical to ours (git itself skips an identical neighbor): only our check keeps it to one.
    const twice = await run(dir, msg('feat: y\n\nCo-authored-by: Claude Opus <noreply@anthropic.com>', { coAuthor: true }));
    expect(twice.code, twice.output).toBe(0);
    expect(git(dir, 'log', '-1', '--format=%B').match(/^co-authored-by: claude/gim)).toHaveLength(1);
  });

  test('amend rewords HEAD', async () => {
    const dir = repo();
    const r = await run(dir, msg('start, reworded', { amend: true }));
    expect(r.code, r.output).toBe(0);
    expect(git(dir, 'log', '--format=%s')).toBe('start, reworded\n');
  });

  test('undoCommit: reset --soft keeps the changes staged', async () => {
    const dir = repo();
    writeFileSync(join(dir, 'a.txt'), 'two\n');
    git(dir, 'add', 'a.txt');
    git(dir, 'commit', '-q', '-m', 'second');
    const head = git(dir, 'rev-parse', 'HEAD').trim();
    const r = await run(dir, build.undoCommit(head));
    expect(r.code, r.output).toBe(0);
    expect(git(dir, 'log', '--format=%s')).toBe('start\n');
    expect(staged(dir)).toEqual(['a.txt']);
  });

  test('a failing pre-commit → hook naming it, its output streamed (ANSI stripped)', async () => {
    const dir = repo();
    hook(dir, 'pre-commit', 'printf "\\033[31mlint failed\\033[0m: 2 problems\\n" >&2\nexit 1');
    writeFileSync(join(dir, 'a.txt'), 'two\n');
    git(dir, 'add', 'a.txt');
    const r = await run(dir, msg('feat: x'));
    expect(r.code).toBe(1);
    expect(r.traced).toBe(true);
    expect(r.hookFailed).toBe('pre-commit');
    expect(r.phases).toContainEqual({ phase: 'hook', hook: 'pre-commit' });
    expect(r.chunks.join('')).toContain('lint failed: 2 problems');
    expect(r.output).not.toContain('\x1b');
    expect(classifyWrite(msg('feat: x'), r, { hooksExist: true })).toMatchObject({ outcome: 'hook', hook: 'pre-commit', message: 'lint failed: 2 problems' });
    expect(git(dir, 'log', '--format=%s')).toBe('start\n');
  });

  test('a passing hook\'s output is streamed; --no-verify skips a failing one', async () => {
    const dir = repo();
    hook(dir, 'pre-commit', 'echo "checks ok"');
    writeFileSync(join(dir, 'a.txt'), 'two\n');
    git(dir, 'add', 'a.txt');
    const ok = await run(dir, msg('feat: x'));
    expect(ok.code, ok.output).toBe(0);
    expect(ok.chunks.join('')).toContain('checks ok');
    expect(classifyWrite(msg('feat: x'), ok, { hooksExist: true })).toMatchObject({ outcome: 'ok', hook: 'pre-commit' });

    hook(dir, 'pre-commit', 'echo "would fail"\nexit 1');
    writeFileSync(join(dir, 'a.txt'), 'three\n');
    git(dir, 'add', 'a.txt');
    const skipped = await run(dir, msg('feat: y', { noVerify: true }));
    expect(skipped.code, skipped.output).toBe(0);
    expect(skipped.output).not.toContain('would fail');
    expect(git(dir, 'log', '-1', '--format=%s')).toBe('feat: y\n');
  });

  test('a held index.lock → busy, and the lock is left alone', async () => {
    const dir = repo();
    writeFileSync(join(dir, 'a.txt'), 'two\n');
    writeFileSync(join(dir, '.git', 'index.lock'), '');
    const r = await run(dir, build.stage(['a.txt']));
    expect(classifyWrite(build.stage(['a.txt']), r, { hooksExist: false }).outcome).toBe('busy');
    const c = await run(dir, msg('feat: x'));
    expect(classifyWrite(msg('feat: x'), c, { hooksExist: false }).outcome).toBe('busy');
    expect(existsSync(join(dir, '.git', 'index.lock'))).toBe(true);
  });

  test('signing with a gpg program that needs a tty fails fast as sign (no controlling terminal), seen as signing', async () => {
    const dir = repo();
    const gpg = join(dir, '..', 'fake-gpg');
    // Like pinentry-curses: with a terminal it would wait for an answer; without one it fails at once.
    writeFileSync(gpg, '#!/bin/sh\nif (exec 3</dev/tty) 2>/dev/null; then read -r answer </dev/tty; fi\necho "gpg: signing failed: Inappropriate ioctl for device" >&2\nexit 2\n');
    chmodSync(gpg, 0o755);
    git(dir, 'config', 'commit.gpgsign', 'true');
    git(dir, 'config', 'gpg.program', gpg);
    writeFileSync(join(dir, 'a.txt'), 'two\n');
    git(dir, 'add', 'a.txt');
    const t0 = Date.now();
    const r = await run(dir, msg('feat: signed'), { gpgProgram: gpg, timeoutMs: 10_000 });
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(r.phases).toContainEqual({ phase: 'signing' });
    expect(classifyWrite(msg('feat: signed'), r, { hooksExist: false }).outcome).toBe('sign');
  });
});

describe('the process: cancel, timeout, quit, output cap, trace2 socket', () => {
  /** Pid files of hooks that loop or sleep: whatever a failed test left running is killed. */
  const leftovers: string[] = [];
  afterEach(() => {
    for (const f of leftovers.splice(0)) {
      const pid = existsSync(f) ? Number(readFileSync(f, 'utf8').trim()) : 0;
      if (pid > 0) try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
    }
  });

  /** A repo whose pre-commit records its pid and a child's, then sleeps 60 s. */
  function sleepy(): { dir: string; pids: () => number[] } {
    const dir = repo();
    const hookPid = join(dir, '..', 'hook.pid');
    const childPid = join(dir, '..', 'child.pid');
    hook(dir, 'pre-commit', `echo $$ > '${hookPid}'\nsleep 60 &\necho $! > '${childPid}'\nwait`);
    writeFileSync(join(dir, 'a.txt'), 'two\n');
    git(dir, 'add', 'a.txt');
    const read = (p: string) => Number(readFileSync(p, 'utf8').trim());
    return { dir, pids: () => (existsSync(hookPid) && existsSync(childPid) && readFileSync(childPid, 'utf8').trim() ? [read(hookPid), read(childPid)] : []) };
  }

  test('cancel during a 60 s hook answers within 2 s and leaves no process of the group', async () => {
    const { dir, pids } = sleepy();
    const c = new AbortController();
    const p = run(dir, msg('feat: x'), { signal: c.signal });
    await waitFor(() => pids().length === 2);
    const t0 = Date.now();
    c.abort();
    const r = await p;
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(r.cancelled).toBe(true);
    expect(classifyWrite(msg('feat: x'), r, { hooksExist: true }).outcome).toBe('cancelled');
    // Killed (SIGKILL to the group), then reaped: kill(pid, 0) throws for both.
    for (const pid of pids()) await waitFor(() => !alive(pid), 2000);
    expect(git(dir, 'log', '--format=%s')).toBe('start\n');
  });

  test('cancel while git holds index.lock: SIGTERM first, so git removes its lock (a SIGKILL would leave it behind)', async () => {
    const dir = repo();
    // A slow clean filter: `git add` holds index.lock while it runs (git 2.54 holds none during pre-commit).
    git(dir, 'config', 'filter.slow.clean', 'sleep 30; cat');
    writeFileSync(join(dir, '.gitattributes'), '*.txt filter=slow\n');
    writeFileSync(join(dir, 'a.txt'), 'two\n');
    const c = new AbortController();
    const p = run(dir, build.stage(['a.txt']), { signal: c.signal });
    await waitFor(() => existsSync(join(dir, '.git', 'index.lock')));
    c.abort();
    expect((await p).cancelled).toBe(true);
    expect(existsSync(join(dir, '.git', 'index.lock'))).toBe(false);
    // The next write works.
    git(dir, 'config', 'filter.slow.clean', 'cat');
    expect((await run(dir, build.stage(['a.txt']))).code).toBe(0);
  });

  test('a hook that ignores SIGTERM: git ends on it, the rest of the group is killed at once', async () => {
    const dir = repo();
    const pidFile = join(dir, '..', 'stubborn.pid');
    leftovers.push(pidFile);
    hook(dir, 'pre-commit', `trap '' TERM\necho $$ > '${pidFile}'\nwhile :; do sleep 1; done`);
    writeFileSync(join(dir, 'a.txt'), 'two\n');
    git(dir, 'add', 'a.txt');
    const c = new AbortController();
    const p = run(dir, msg('feat: x'), { signal: c.signal });
    await waitFor(() => existsSync(pidFile) && readFileSync(pidFile, 'utf8').trim() !== '');
    const pid = Number(readFileSync(pidFile, 'utf8').trim());
    const t0 = Date.now();
    c.abort();
    expect((await p).cancelled).toBe(true);
    expect(Date.now() - t0).toBeLessThan(2000);
    await waitFor(() => !alive(pid), 2000);
    expect(existsSync(join(dir, '.git', 'index.lock'))).toBe(false);
  });

  test('a git that ignores SIGTERM is killed (SIGKILL) about 2 s later', async () => {
    const dir = repo();
    const bin = join(dir, '..', 'fake-bin');
    mkdirSync(bin);
    const pidFile = join(dir, '..', 'fake-git.pid');
    leftovers.push(pidFile);
    writeFileSync(join(bin, 'git'), `#!/bin/sh\ntrap '' TERM\necho $$ > '${pidFile}'\nwhile :; do sleep 1; done\n`);
    chmodSync(join(bin, 'git'), 0o755);
    const c = new AbortController();
    const p = run(dir, build.stage(['a.txt']), { signal: c.signal, e: { ...env(), PATH: `${bin}:${process.env.PATH ?? ''}` } });
    await waitFor(() => existsSync(pidFile) && readFileSync(pidFile, 'utf8').trim() !== '');
    const pid = Number(readFileSync(pidFile, 'utf8').trim());
    const t0 = Date.now();
    c.abort();
    const r = await p;
    const ms = Date.now() - t0;
    expect(r.cancelled).toBe(true);
    expect(ms).toBeGreaterThanOrEqual(1500);
    expect(ms).toBeLessThan(4000);
    await waitFor(() => !alive(pid), 2000);
  });

  test('a timeout kills the group too', async () => {
    const { dir, pids } = sleepy();
    const t0 = Date.now();
    const r = await run(dir, msg('feat: x'), { timeoutMs: 700 });
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(r.timedOut).toBe(true);
    // The hook was what ran out of time.
    expect(classifyWrite(msg('feat: x'), r, { hooksExist: true })).toMatchObject({ outcome: 'error', message: 'The pre-commit hook did not finish in time.' });
    for (const pid of pids()) await waitFor(() => !alive(pid), 2000);
  });

  test('stopAllWrites (Quit Anyway) cancels what runs', async () => {
    const { dir, pids } = sleepy();
    const p = run(dir, msg('feat: x'));
    await waitFor(() => pids().length === 2);
    stopAllWrites();
    expect((await p).cancelled).toBe(true);
  });

  test('output past 1 MB is drained and dropped, never a reason to stop git: a pre-commit printing 1.3 MB then passing commits', async () => {
    const dir = repo();
    hook(dir, 'pre-commit', 'yes "pre-commit output line" | head -c 1300000\necho\nexit 0');
    writeFileSync(join(dir, 'a.txt'), 'two\n');
    git(dir, 'add', 'a.txt');
    const r = await run(dir, msg('feat: x'));
    expect(r.code).toBe(0);
    expect(r.truncated).toBe(true);
    expect(r.output.endsWith('\n… output past 1 MB dropped\n')).toBe(true);
    expect(Buffer.byteLength(r.output)).toBeLessThanOrEqual(WRITE_MAX_BYTES + 64);
    expect(r.chunks.join('')).toBe(r.output);
    expect(classifyWrite(msg('feat: x'), r, { hooksExist: true })).toMatchObject({ outcome: 'ok' });
    expect(git(dir, 'log', '-1', '--format=%s')).toBe('feat: x\n');
  });

  test('a post-commit printing 1.3 MB: the commit it follows is ok', async () => {
    const dir = repo();
    hook(dir, 'post-commit', 'yes "post-commit output line" | head -c 1300000\necho');
    writeFileSync(join(dir, 'a.txt'), 'two\n');
    git(dir, 'add', 'a.txt');
    const r = await run(dir, msg('feat: x'));
    expect(classifyWrite(msg('feat: x'), r, { hooksExist: false })).toMatchObject({ outcome: 'ok' });
    expect(git(dir, 'log', '-1', '--format=%s')).toBe('feat: x\n');
  });

  test('a hook printing forever is still bounded by the timeout', async () => {
    const dir = repo();
    const pidFile = join(dir, '..', 'chatty.pid');
    hook(dir, 'pre-commit', `echo $$ > '${pidFile}'\nwhile :; do echo "0123456789abcdef0123456789abcdef"; done`);
    writeFileSync(join(dir, 'a.txt'), 'two\n');
    git(dir, 'add', 'a.txt');
    leftovers.push(pidFile);
    const r = await run(dir, msg('feat: x'), { timeoutMs: 1500 });
    expect(r.timedOut).toBe(true);
    expect(r.truncated).toBe(true);
    await waitFor(() => !alive(Number(readFileSync(pidFile, 'utf8').trim())), 3000);
    expect(git(dir, 'log', '--format=%s')).toBe('start\n');
  });

  test('stopAllWrites spares a cleanup run (rebase --abort, a stash pop back); killAllWrites kills it at once', async () => {
    const { dir, pids } = sleepy();
    leftovers.push(join(dir, '..', 'hook.pid'), join(dir, '..', 'child.pid'));
    let settled = false;
    const p = run(dir, msg('feat: x'), { cleanup: true }).finally(() => { settled = true; });
    await waitFor(() => pids().length === 2);
    stopAllWrites();
    await new Promise((r) => setTimeout(r, 400));
    expect(settled).toBe(false);
    expect(pids().every(alive)).toBe(true);
    const t0 = Date.now();
    killAllWrites();
    // SIGKILL went out synchronously: nothing of the group outlives the call by more than the reaping.
    const r = await p;
    expect(Date.now() - t0).toBeLessThan(1500);
    expect(r.cancelled).toBe(true);
    for (const pid of pids()) await waitFor(() => !alive(pid), 2000);
  });

  test('git exited but a hook\'s background job holds the pipes: the answer comes anyway, soon', async () => {
    const dir = repo();
    hook(dir, 'post-commit', 'sleep 4 &');
    writeFileSync(join(dir, 'a.txt'), 'two\n');
    git(dir, 'add', 'a.txt');
    const t0 = Date.now();
    const r = await run(dir, msg('feat: x'));
    expect(Date.now() - t0).toBeLessThan(2500);
    expect(r.code, r.output).toBe(0);
    expect(git(dir, 'log', '-1', '--format=%s')).toBe('feat: x\n');
  });

  test('trace2 sockets are removed when each run ends', async () => {
    const dir = repo();
    writeFileSync(join(dir, 'a.txt'), 'two\n');
    const r = await run(dir, build.stage(['a.txt']));
    expect(r.code).toBe(0);
    expect(readdirSync(trace2Dir()).filter((n) => n.endsWith('.sock'))).toEqual([]);
  });

  test('an op with no input still gets its stdin closed (nothing waits on it)', async () => {
    const dir = repo();
    hook(dir, 'post-checkout', 'cat >/dev/null');
    const r = await run(dir, build.branchCreate({ name: 'feat/x', switch: true }), { timeoutMs: 10_000 });
    expect(r.code, r.output).toBe(0);
    expect(git(dir, 'branch', '--show-current')).toBe('feat/x\n');
  });
});

describe('stash', () => {
  // git's own clean step of `stash push -u` names the whole tree as ':/': with literal pathspecs it matches nothing,
  // and the new files stay behind although they are in the stash (git 2.54).
  test('push -u takes the new files out of the work tree (literal pathspecs off for this pathspec-free op); pop brings them back', async () => {
    const dir = repo();
    writeFileSync(join(dir, 'a.txt'), 'changed\n');
    writeFileSync(join(dir, 'n.txt'), 'new\n');
    const r = await run(dir, build.stashPush({ message: 'wip', untracked: true, staged: false }));
    expect(r.code, r.output).toBe(0);
    expect(git(dir, 'status', '--porcelain', '--untracked-files=all')).toBe('');
    expect((await run(dir, build.stashApply(git(dir, 'rev-parse', 'stash@{0}').trim()))).code).toBe(0);
    expect(git(dir, 'status', '--porcelain', '--untracked-files=all')).toBe(' M a.txt\n?? n.txt\n');
  });

  // GitOps' fallback (applyStash) rests on git's exact words and on nothing being applied by the refused --index.
  test('a staged change whose context moved: --index is refused ("Try without --index"), nothing applied; without it the change comes back', async () => {
    const lines = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`);
    const dir = repo({ 'a.txt': `${lines.join('\n')}\n` });
    writeFileSync(join(dir, 'a.txt'), `${lines.map((l, i) => (i === 1 ? 'two, staged' : l)).join('\n')}\n`);
    git(dir, 'add', 'a.txt');
    expect((await run(dir, build.stashPush({ message: 'wip', untracked: false, staged: false }))).code).toBe(0);
    const oid = git(dir, 'rev-parse', 'stash@{0}').trim();
    writeFileSync(join(dir, 'a.txt'), `${lines.map((l, i) => (i === 4 ? 'five, upstream' : l)).join('\n')}\n`);
    git(dir, 'commit', '-q', '-am', 'upstream');
    const refused = await run(dir, build.stashApply(oid));
    expect(refused.code).not.toBe(0);
    expect(refused.output).toMatch(/conflicts in index\. Try without --index/i);
    expect(git(dir, 'status', '--porcelain')).toBe('');
    const r = await run(dir, build.stashApply(oid, { index: false }));
    expect(r.code, r.output).toBe(0);
    expect(readFileSync(join(dir, 'a.txt'), 'utf8')).toContain('two, staged');
    expect(readFileSync(join(dir, 'a.txt'), 'utf8')).toContain('five, upstream');
  });
});

describe('push to a local bare remote', () => {
  function pair(): { bare: string; a: string; b: string } {
    const a = repo();
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

  test('rejected, then a lease on the oid seen with --force-if-includes; a remote that moved again → stale', async () => {
    const { bare, a, b } = pair();
    git(a, 'commit', '-q', '--allow-empty', '-m', 'remote 1');
    git(a, 'push', '-q');
    git(b, 'commit', '-q', '--allow-empty', '-m', 'local');
    git(b, 'fetch', '-q');
    const rejected = await run(b, build.push(PUSH_MAIN));
    expect(classifyWrite(build.push(PUSH_MAIN), rejected, { hooksExist: false }).outcome).toBe('rejected');

    const seen = git(b, 'rev-parse', 'origin/main').trim();
    git(a, 'commit', '-q', '--allow-empty', '-m', 'remote 2');
    git(a, 'push', '-q');
    const lease = build.push({ lease: { remote: 'origin', branch: 'main', ref: 'refs/heads/main', oid: seen } });
    const stale = await run(b, lease);
    expect(classifyWrite(lease, stale, { hooksExist: false }).outcome).toBe('stale');
    expect(git(bare, 'log', '-1', '--format=%s', 'main')).toBe('remote 2\n');
  });

  test('a forced push moves only its own branch: a remote\'s `+refs/heads/*` push refspec and push.default=matching never widen it', async () => {
    const { bare, a, b } = pair();
    git(a, 'branch', 'other');
    git(a, 'push', '-q', 'origin', 'other');
    git(a, 'commit', '-q', '--allow-empty', '-m', 'remote main');
    git(a, 'push', '-q', 'origin', 'main');
    git(a, 'switch', '-q', 'other');
    git(a, 'commit', '-q', '--allow-empty', '-m', 'remote other');
    git(a, 'push', '-q', 'origin', 'other');
    const remoteOther = git(bare, 'rev-parse', 'refs/heads/other').trim();
    // b: main and other both behind and diverged; its config would force every branch on a bare `git push`.
    git(b, 'fetch', '-q');
    git(b, 'branch', 'other', 'origin/other~1');
    git(b, 'switch', '-q', 'other');
    git(b, 'commit', '-q', '--allow-empty', '-m', 'local other');
    git(b, 'switch', '-q', 'main');
    const mine = (git(b, 'commit', '-q', '--allow-empty', '-m', 'local main'), git(b, 'rev-parse', 'HEAD').trim());
    git(b, 'config', 'remote.origin.push', '+refs/heads/*:refs/heads/*');
    git(b, 'config', 'push.default', 'matching');
    const seen = git(b, 'rev-parse', 'origin/main').trim();
    const lease = build.push({ lease: { remote: 'origin', branch: 'main', ref: 'refs/heads/main', oid: seen } });
    const r = await run(b, lease);
    expect(classifyWrite(lease, r, { hooksExist: false }).outcome, r.output).toBe('ok');
    expect(git(bare, 'rev-parse', 'refs/heads/main').trim()).toBe(mine);
    expect(git(bare, 'rev-parse', 'refs/heads/other').trim()).toBe(remoteOther);
  });

  test('publish of a branch named like a forced refspec is refused before git; publish pushes exactly refs/heads/<b>', async () => {
    const { bare, b } = pair();
    expect(() => build.push({ publish: { remote: 'origin', branch: '+main' } })).toThrow();
    git(b, 'switch', '-q', '-c', 'feat/p');
    git(b, 'commit', '-q', '--allow-empty', '-m', 'p');
    git(b, 'config', 'remote.origin.push', '+refs/heads/*:refs/heads/*');
    git(b, 'switch', '-q', 'main');
    git(b, 'commit', '-q', '--allow-empty', '-m', 'local main, not to push');
    git(b, 'switch', '-q', 'feat/p');
    const before = git(bare, 'rev-parse', 'refs/heads/main').trim();
    const r = await run(b, build.push({ publish: { remote: 'origin', branch: 'feat/p' } }));
    expect(r.code, r.output).toBe(0);
    expect(git(bare, 'rev-parse', 'refs/heads/feat/p').trim()).toBe(git(b, 'rev-parse', 'HEAD').trim());
    expect(git(bare, 'rev-parse', 'refs/heads/main').trim()).toBe(before);
    expect(git(b, 'rev-parse', '--abbrev-ref', '@{u}').trim()).toBe('origin/feat/p');
  });

  test('a remote pre-receive rejection is an error with its words, not our hook outcome', async () => {
    const { bare, b } = pair();
    const p = join(bare, 'hooks', 'pre-receive');
    writeFileSync(p, '#!/bin/sh\necho "protected branch" >&2\nexit 1\n');
    chmodSync(p, 0o755);
    git(b, 'commit', '-q', '--allow-empty', '-m', 'local');
    const r = await run(b, build.push(PUSH_MAIN));
    expect(r.hookFailed).toBeUndefined();
    expect(r.phases.some((s) => 'hook' in s && s.hook === 'pre-receive')).toBe(false);
    expect(classifyWrite(build.push(PUSH_MAIN), r, { hooksExist: false })).toMatchObject({ outcome: 'error', message: 'protected branch' });
  });
});
