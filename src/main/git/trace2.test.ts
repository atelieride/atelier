import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { git } from '../../../tests/support/git-fixture';
import { Trace2Reader, type Trace2Signal, disposeTrace2Dir, listenTrace2, trace2Dir } from './trace2';
import { writeEnv } from './write-env';

// Real event lines from git 2.54 (`git commit` with GIT_TRACE2_EVENT=af_unix:stream:<socket>), temp paths as /TMP.
const fixture = (name: string) => readFileSync(join(__dirname, '__fixtures__', `trace2-${name}.jsonl`), 'utf8').split('\n').filter(Boolean);
const signals = (lines: string[], o?: { gpgProgram?: string | null }) => {
  const r = new Trace2Reader(o);
  return lines.map((l) => r.push(l)).filter((s): s is Trace2Signal => s !== null);
};

describe('Trace2Reader (phases)', () => {
  test('a hook that passes: the hook phase with its name, no failure', () => {
    expect(signals(fixture('hook-ok'))).toEqual([{ phase: 'hook', hook: 'pre-commit' }]);
  });

  test('a hook that fails: its child_exit with a non-zero code names it', () => {
    expect(signals(fixture('hook-fail'))).toEqual([{ phase: 'hook', hook: 'pre-commit' }, { hookFailed: 'pre-commit', code: 1 }]);
  });

  test('gpg after the hook: signing', () => {
    expect(signals(fixture('gpg'))).toEqual([{ phase: 'hook', hook: 'pre-commit' }, { phase: 'signing' }]);
  });

  test('ssh signing (gpg.format=ssh): ssh-keygen is signing', () => {
    expect(signals(fixture('ssh'))).toEqual([{ phase: 'signing' }]);
  });

  test('a configured gpg.program is signing, by its basename; unknown otherwise', () => {
    expect(signals(fixture('gpg-program'), { gpgProgram: '/opt/tools/my-signer' })).toEqual([{ phase: 'signing' }]);
    expect(signals(fixture('gpg-program'), { gpgProgram: 'my-signer' })).toEqual([{ phase: 'signing' }]);
    expect(signals(fixture('gpg-program'))).toEqual([]);
    expect(signals(fixture('gpg-program'), { gpgProgram: null })).toEqual([]);
  });

  test('git commands run by a hook (lint-staged, husky) are not the op: a failing child inside the hook is not a hook failure', () => {
    // The hook runs `git x` (an alias to `false`): that nested git's child 0 exits 1, its sid nests under the op's.
    const lines = fixture('hook-nested');
    expect(lines.some((l) => l.includes('"child_class":"shell_alias"') && l.includes('/'))).toBe(true);
    expect(signals(lines)).toEqual([{ phase: 'hook', hook: 'pre-commit' }]);
  });

  const ev = (sid: string, o: Record<string, unknown>) => JSON.stringify({ sid, thread: 'main', ...o });

  test('a hook of a nested git outside any hook is still the op\'s (pull runs rebase, which runs post-rewrite)', () => {
    const r = new Trace2Reader();
    expect(r.push(ev('A', { event: 'child_start', child_id: 0, child_class: 'git_command', argv: ['git', 'rebase'] }))).toBeNull();
    expect(r.push(ev('A/B', { event: 'child_start', child_id: 0, child_class: 'hook', hook_name: 'post-rewrite', argv: ['.git/hooks/post-rewrite'] }))).toEqual({ phase: 'hook', hook: 'post-rewrite' });
    expect(r.push(ev('A/B', { event: 'child_exit', child_id: 0, code: 2 }))).toEqual({ hookFailed: 'post-rewrite', code: 2 });
  });

  test('running(): the hook running now (a timeout is its, not the remote\'s), none once it exited', () => {
    const r = new Trace2Reader();
    expect(r.running()).toBeNull();
    r.push(ev('A', { event: 'child_start', child_id: 0, child_class: 'hook', hook_name: 'pre-push', argv: ['x'] }));
    expect(r.running()).toBe('pre-push');
    r.push(ev('A', { event: 'child_exit', child_id: 0, code: 0 }));
    expect(r.running()).toBeNull();
  });

  test('a nested git inside a running hook: neither its hooks nor its signing are phases', () => {
    const r = new Trace2Reader();
    expect(r.push(ev('A', { event: 'child_start', child_id: 0, child_class: 'hook', hook_name: 'pre-commit', argv: ['x'] }))).toEqual({ phase: 'hook', hook: 'pre-commit' });
    expect(r.push(ev('A/B', { event: 'child_start', child_id: 0, child_class: 'hook', hook_name: 'commit-msg', argv: ['y'] }))).toBeNull();
    expect(r.push(ev('A/B', { event: 'child_start', child_id: 1, child_class: '?', argv: ['gpg', '-bsau', 'K'] }))).toBeNull();
    expect(r.push(ev('A/B', { event: 'child_exit', child_id: 0, code: 1 }))).toBeNull();
    expect(r.push(ev('A', { event: 'child_exit', child_id: 0, code: 0 }))).toBeNull();
    // The hook is over: the op's own signing shows again.
    expect(r.push(ev('A', { event: 'child_start', child_id: 1, child_class: '?', argv: ['gpg2', '-bsau', 'K'] }))).toEqual({ phase: 'signing' });
  });

  test('gpgsm and a full path to gpg are signing; a child named like a signer elsewhere in argv is not', () => {
    const r = new Trace2Reader();
    expect(r.push(ev('A', { event: 'child_start', child_id: 0, argv: ['/opt/homebrew/bin/gpg', '--status-fd=2'] }))).toEqual({ phase: 'signing' });
    expect(r.push(ev('A', { event: 'child_start', child_id: 1, argv: ['gpgsm', '-bsau', 'K'] }))).toEqual({ phase: 'signing' });
    expect(r.push(ev('A', { event: 'child_start', child_id: 2, argv: ['git', 'gpg'] }))).toBeNull();
    expect(r.push(ev('A', { event: 'child_start', child_id: 3, argv: ['/usr/bin/gpg-agent'] }))).toBeNull();
  });

  test('malformed or foreign lines are ignored, never thrown on', () => {
    const r = new Trace2Reader();
    for (const l of ['', 'not json', '{"event":"child_start"', 'null', '[1,2]', '"x"', '{}', '{"event":"child_start","child_id":0}',
      ev('A', { event: 'child_start', child_id: 'x', child_class: 'hook', hook_name: 'pre-commit' }),
      ev('A', { event: 'child_start', child_id: 0, child_class: 'hook', hook_name: 7 }),
      ev('A', { event: 'child_start', child_id: 0, argv: 'gpg' }),
      ev('A', { event: 'child_start', child_id: 0, argv: [] }),
      ev('A', { event: 'child_exit', child_id: 9, code: 1 })]) {
      expect(r.push(l)).toBeNull();
    }
  });

  test('a hook\'s exit is matched by child_id: another child\'s failure is not the hook\'s', () => {
    const r = new Trace2Reader();
    r.push(ev('A', { event: 'child_start', child_id: 4, child_class: 'hook', hook_name: 'pre-push', argv: ['x'] }));
    expect(r.push(ev('A', { event: 'child_exit', child_id: 5, code: 1 }))).toBeNull();
    expect(r.push(ev('A', { event: 'child_exit', child_id: 4, code: 0 }))).toBeNull();
  });
});

describe('listenTrace2', () => {
  afterEach(() => { delete process.env.ATELIER_TEST_TRACE2_DIR; disposeTrace2Dir(); });

  const run = (repo: string, args: string[], env: NodeJS.ProcessEnv, input: string) => new Promise<number>((resolve) => {
    const ch = spawn('git', ['-C', repo, ...args], { env, stdio: ['pipe', 'ignore', 'ignore'] });
    ch.stdin.end(input);
    ch.on('close', (code) => resolve(code ?? -1));
  });

  test('receives the events of a real `git commit` with a hook; the socket is gone after close()', async () => {
    const repo = realpathSync(mkdtempSync(join(tmpdir(), 'atl-tr2-')));
    git(repo, 'init', '-q', '-b', 'main');
    // The hook runs git itself (as lint-staged does): those events come on their own connection.
    writeFileSync(join(repo, '.git/hooks/pre-commit'), '#!/bin/sh\ngit rev-parse HEAD >/dev/null 2>&1\nexit 0\n');
    chmodSync(join(repo, '.git/hooks/pre-commit'), 0o755);
    writeFileSync(join(repo, 'a.txt'), 'a\n');
    git(repo, 'add', 'a.txt');

    const lines: string[] = [];
    const t = await listenTrace2((l) => lines.push(l));
    expect(t.path).toMatch(/\.sock$/);
    expect(Buffer.byteLength(t.path)).toBeLessThanOrEqual(103);
    expect(existsSync(t.path)).toBe(true);
    expect(statSync(trace2Dir()).mode & 0o777).toBe(0o700);

    const env = { ...writeEnv(process.env, { isolated: true, trace2: t.path }), GIT_AUTHOR_NAME: 'Ada', GIT_AUTHOR_EMAIL: 'ada@example.com', GIT_COMMITTER_NAME: 'Ada', GIT_COMMITTER_EMAIL: 'ada@example.com' };
    expect(await run(repo, ['commit', '-q', '-F', '-'], env, 'msg\n')).toBe(0);
    await t.close();

    expect(existsSync(t.path)).toBe(false);
    // Whole lines only, never two connections interleaved inside one.
    for (const l of lines) expect(() => JSON.parse(l)).not.toThrow();
    expect(lines.some((l) => l.includes('"sid":') && /"sid":"[^"]+\/[^"]+"/.test(l))).toBe(true);
    expect(signals(lines)).toEqual([{ phase: 'hook', hook: 'pre-commit' }]);
    // close() twice is fine.
    await t.close();
  });

  test('macOS: GIT_TRACE2_EVENT is the socket, af_unix', async () => {
    const t = await listenTrace2(() => {});
    expect(t.event).toBe(`af_unix:stream:${t.path}`);
    await t.close();
  });

  test('one socket per op: two listeners at once get different paths', async () => {
    const a = await listenTrace2(() => {});
    const b = await listenTrace2(() => {});
    expect(a.path).not.toBe('');
    expect(a.path).not.toBe(b.path);
    await a.close();
    expect(existsSync(b.path)).toBe(true);
    await b.close();
  });

  test('the private folder is created once, 0700', () => {
    const d = trace2Dir();
    chmodSync(d, 0o755);
    expect(trace2Dir()).toBe(d);
    // Not recreated nor re-checked on every op: created lazily once.
    expect(statSync(d).mode & 0o777).toBe(0o755);
    disposeTrace2Dir();
    expect(existsSync(d)).toBe(false);
    expect(statSync(trace2Dir()).mode & 0o777).toBe(0o700);
  });

  test('ATELIER_TEST_TRACE2_DIR sets the folder (tests)', async () => {
    const d = join(realpathSync(mkdtempSync(join(tmpdir(), 'atl-tr2d-'))), 't');
    process.env.ATELIER_TEST_TRACE2_DIR = d;
    const t = await listenTrace2(() => {});
    expect(t.path.startsWith(`${d}/`)).toBe(true);
    expect(statSync(d).mode & 0o777).toBe(0o700);
    await t.close();
  });

  test('a folder already there (an earlier process with this pid) is made private again', async () => {
    const d = realpathSync(mkdtempSync(join(tmpdir(), 'atl-tr2m-')));
    chmodSync(d, 0o755);
    process.env.ATELIER_TEST_TRACE2_DIR = d;
    const t = await listenTrace2(() => {});
    expect(t.path).not.toBe('');
    expect(statSync(d).mode & 0o777).toBe(0o700);
    await t.close();
  });

  test('disposeTrace2Dir removes the sockets left open, and the folder only when nothing else is in it', async () => {
    const d = realpathSync(mkdtempSync(join(tmpdir(), 'atl-tr2q-')));
    process.env.ATELIER_TEST_TRACE2_DIR = d;
    const t = await listenTrace2(() => {});
    writeFileSync(join(d, 'not-ours'), 'x');
    disposeTrace2Dir();
    expect(existsSync(t.path)).toBe(false);
    expect(existsSync(join(d, 'not-ours'))).toBe(true);
    await t.close();
  });

  test('a socket path over 103 bytes: no trace2 (path \'\'), no throw', async () => {
    const d = join(realpathSync(mkdtempSync(join(tmpdir(), 'atl-tr2l-'))), 'x'.repeat(100));
    process.env.ATELIER_TEST_TRACE2_DIR = d;
    const t = await listenTrace2(() => {});
    expect(t.path).toBe('');
    await t.close();
  });

  test('a folder that cannot be made: no trace2, no throw', async () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'atl-tr2f-')));
    writeFileSync(join(base, 'file'), '');
    process.env.ATELIER_TEST_TRACE2_DIR = join(base, 'file', 'sub');
    const t = await listenTrace2(() => {});
    expect(t.path).toBe('');
    await t.close();
  });

  test('a folder that is not a real directory (a symlink to one): no trace2', async () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'atl-tr2s-')));
    mkdirSync(join(base, 'real'));
    symlinkSync(join(base, 'real'), join(base, 'link'));
    process.env.ATELIER_TEST_TRACE2_DIR = join(base, 'link');
    expect((await listenTrace2(() => {})).path).toBe('');
  });

  test('a listener that throws does not break the socket', async () => {
    const repo = realpathSync(mkdtempSync(join(tmpdir(), 'atl-tr2t-')));
    mkdirSync(repo, { recursive: true });
    git(repo, 'init', '-q', '-b', 'main');
    let n = 0;
    const t = await listenTrace2(() => { n++; throw new Error('boom'); });
    expect(await run(repo, ['rev-parse', 'HEAD'], writeEnv(process.env, { isolated: true, trace2: t.path }), '')).not.toBe(-1);
    await t.close();
    expect(n).toBeGreaterThan(1);
  });
});
