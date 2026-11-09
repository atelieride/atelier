// GitOps on real git: repositories and bare remotes in the run's
// private temp root, isolated git config (ATELIER_TEST_GIT_ISOLATED, tests/setup-env.ts), the test Trash
// (ATELIER_TEST_TRASH_DIR), no claude. Every op goes through GitOps exactly as the IPC would call it.
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, relative, toOut } from '../../src/main/cpath';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { posixTest } from '../support/platform';
import type { RepoStatus } from '../../src/shared/git';
import type { GitOpEvent } from '../../src/shared/git-write';
import type { ScmRepoEntry } from '../../src/shared/scm';
import { GitOps, type GitOpsDeps, type GitOpsSettings } from '../../src/main/git-ops';
import { moveToTrash } from '../../src/main/fs/write';
import { runFetch } from '../../src/main/git/fetch';
import { readRefs } from '../../src/main/git/history';
import { KeepSet } from '../../src/main/git/keep-set';
import { readRepoStatus } from '../../src/main/git/service';
import { disposeTrace2Dir } from '../../src/main/git/trace2';
import { type Invocation, type RawRun, runWrite } from '../../src/main/git/write';
import { WriteQueue } from '../../src/main/git/write-queue';
import { commit, git } from '../support/git-fixture';

const tmp = (p: string) => toOut(realpathSync(mkdtempSync(join(tmpdir(), p))));
let trash = '';
const savedTrash = process.env.ATELIER_TEST_TRASH_DIR;
beforeAll(() => { trash = tmp('atl-ops-trash-'); process.env.ATELIER_TEST_TRASH_DIR = trash; });
afterAll(() => {
  if (savedTrash === undefined) delete process.env.ATELIER_TEST_TRASH_DIR; else process.env.ATELIER_TEST_TRASH_DIR = savedTrash;
  disposeTrace2Dir();
});

/** A repo with its own identity (GitOps' commits never see a global config), one commit. */
function repo(files: Record<string, string> = { 'a.ts': 'a\n', 'keep.ts': 'k\n' }): string {
  const dir = join(tmp('atl-ops-'), 'acme-store');
  mkdirSync(dir);
  git(dir, 'init', '-q', '-b', 'main');
  identity(dir);
  commit(dir, 'chore: start', files);
  return dir;
}

function identity(dir: string): void {
  git(dir, 'config', 'user.name', 'Ada');
  git(dir, 'config', 'user.email', 'ada@example.com');
}

/** A bare remote and two clones on main with the first commit pushed. */
function remotePair(): { bare: string; a: string; b: string } {
  const base = tmp('atl-ops-remote-');
  const bare = join(base, 'up.git');
  git(base, 'init', '-q', '--bare', '-b', 'main', bare);
  const a = join(base, 'a');
  git(base, 'clone', '-q', bare, a);
  identity(a);
  commit(a, 'chore: start', { 'x.ts': 'one\ntwo\nthree\n', 'keep.ts': 'k\n' });
  git(a, 'push', '-q', '-u', 'origin', 'main');
  const b = join(base, 'b');
  git(base, 'clone', '-q', bare, b);
  identity(b);
  return { bare, a, b };
}

const commonOf = (root: string) => toOut(realpathSync(git(root, 'rev-parse', '--path-format=absolute', '--git-common-dir').trim()));

function harness(roots: string[], o: { settings?: Partial<GitOpsSettings>; run?: GitOpsDeps['run']; retryDelaysMs?: number[] } = {}) {
  const project = roots[0]!;
  const settings: GitOpsSettings = { gitActions: 'on', commitMessages: 'off', commitUsePrompts: false, commitLanguage: 'commits', ...o.settings };
  const statuses = new Map<string, RepoStatus>();
  const keep = new KeepSet();
  const queue = new WriteQueue();
  const events: GitOpEvent[] = [];
  const entries = (): ScmRepoEntry[] => roots.map((r) => ({ root: r, rel: relative(project, r), name: basename(r), worktreeOf: null, common: commonOf(r), status: null }));
  const deps: GitOpsDeps = {
    settings: () => settings,
    git: { info: () => ({ root: project, status: statuses }), keep: (r, p) => keep.hold(r, p), requestStatus: () => {} },
    scm: {
      entryFor: async (_k, r) => entries().find((e) => e.root === r) ?? null,
      entries: async () => entries(),
      refs: (_k, r) => readRefs(r),
      refsMoved: () => {},
      fetchNow: (r, common) => queue.run(common, () => runFetch(r, { isolated: true }), 'fetch').then((x) => ({ state: null, outcome: x.outcome }))
    },
    queue,
    sessions: () => ({ attributions: [], terminals: [] }),
    accountDir: () => undefined,
    trash: (r, p) => moveToTrash(r, p),
    userEnv: async () => { const env = { ...process.env }; delete env.EMAIL; return { env, captured: true }; },
    claude: () => null,
    emit: (_r, e) => { events.push(e); },
    retryDelaysMs: o.retryDelaysMs ?? [20, 20, 20],
    ...(o.run ? { run: o.run } : {})
  };
  const ops = new GitOps(deps);
  /** What GitHub would do: a fresh status of each root, seen by GitOps (undo records, keep-set releases). */
  const refresh = async () => {
    for (const r of roots) { const st = await readRepoStatus(r); statuses.set(r, st); ops.statusChanged(st); }
  };
  return { ops, refresh, keep, events, settings, K: 'project' };
}

const staged = (dir: string) => git(dir, 'diff', '--cached', '--name-only', '--no-renames', '-z').split('\0').filter(Boolean).sort();
const head = (dir: string) => git(dir, 'rev-parse', 'HEAD').trim();

/**
 * The working tree's files and, under .git, HEAD, local refs, packed-refs (and `gitOnly`'s files): their bytes, hashed.
 * The index by its entries (mode, oid, stage, path): a file git rewrote and put back has the same bytes but a new
 * inode and mtime, which only the index's stat cache records.
 */
function snapshot(dir: string, o: { gitOnly?: string[] } = {}): Record<string, string> {
  const out: Record<string, string> = {};
  const add = (p: string) => { out[relative(dir, p)] = createHash('sha256').update(readFileSync(p)).digest('hex'); };
  out['index entries'] = createHash('sha256').update(git(dir, 'ls-files', '--stage', '-z')).digest('hex');
  const walk = (d: string, skip: (p: string) => boolean) => {
    for (const n of readdirSync(d).sort()) {
      const p = join(d, n);
      if (skip(p)) continue;
      if (statSync(p).isDirectory()) walk(p, skip); else add(p);
    }
  };
  walk(dir, (p) => p === join(dir, '.git'));
  for (const f of o.gitOnly ?? ['HEAD', 'packed-refs']) if (existsSync(join(dir, '.git', f))) add(join(dir, '.git', f));
  walk(join(dir, '.git', 'refs', 'heads'), () => false);
  return out;
}

describe('stage and unstage', () => {
  test('modified, renamed (both paths), deleted, untracked; partial after a later edit; unstage all', async () => {
    const dir = repo({ 'a.ts': 'a\n', 'old.ts': 'o1\no2\no3\n', 'del.ts': 'd\n' });
    writeFileSync(join(dir, 'a.ts'), 'a2\n');
    renameSync(join(dir, 'old.ts'), join(dir, 'new.ts'));
    rmSync(join(dir, 'del.ts'));
    writeFileSync(join(dir, 'u.ts'), 'u\n');
    const h = harness([dir]);
    await h.refresh();
    expect(await h.ops.stage(h.K, { root: dir, rels: ['a.ts', 'old.ts', 'new.ts', 'del.ts', 'u.ts'] })).toMatchObject({ outcome: 'ok' });
    expect(staged(dir)).toEqual(['a.ts', 'del.ts', 'new.ts', 'old.ts', 'u.ts']);
    writeFileSync(join(dir, 'a.ts'), 'a3\n');
    await h.refresh();
    const st = (await readRepoStatus(dir)).changes;
    expect(st.find((c) => c.rel === 'a.ts')?.stage).toBe('partial');
    expect(st.find((c) => c.rel === 'new.ts')).toMatchObject({ kind: 'R', origRel: 'old.ts', stage: 'all' });
    expect(await h.ops.unstage(h.K, { root: dir, rels: ['new.ts', 'old.ts'] })).toMatchObject({ outcome: 'ok' });
    expect(staged(dir)).toEqual(['a.ts', 'del.ts', 'u.ts']);
    expect(await h.ops.unstage(h.K, { root: dir, rels: 'all' })).toMatchObject({ outcome: 'ok' });
    expect(staged(dir)).toEqual([]);
    expect(readFileSync(join(dir, 'a.ts'), 'utf8')).toBe('a3\n');
  });

  test('a conflicted file is never staged (it would mark the conflict resolved): neither listed nor through Stage All', async () => {
    const dir = repo({ 'c.ts': 'base\n' });
    git(dir, 'switch', '-q', '-c', 'side');
    commit(dir, 'side', { 'c.ts': 'side\n' });
    git(dir, 'switch', '-q', 'main');
    commit(dir, 'main', { 'c.ts': 'main\n' });
    try { git(dir, 'merge', '-q', 'side'); } catch { /* the conflict is the point */ }
    writeFileSync(join(dir, 'other.ts'), 'o\n');
    const h = harness([dir]);
    await h.refresh();
    expect(await h.ops.stage(h.K, { root: dir, rels: ['c.ts'] })).toMatchObject({ outcome: 'state', files: ['c.ts'] });
    expect(await h.ops.stage(h.K, { root: dir, rels: 'all' })).toMatchObject({ outcome: 'state', files: ['c.ts'] });
    expect(git(dir, 'ls-files', '--unmerged')).toContain('c.ts');
    expect(await h.ops.stage(h.K, { root: dir, rels: ['other.ts'] })).toMatchObject({ outcome: 'ok' });
  });

  test('Stage All stages the plain files only: no gitlink for an untracked nested repo, no submodule’s new commit', async () => {
    const lib = repo({ 'l.ts': 'l\n' });
    const dir = repo({ 'a.ts': 'a\n' });
    git(dir, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', lib, 'sub');
    commit(dir, 'chore: sub', {});
    const subOid = git(dir, 'rev-parse', 'HEAD:sub').trim();
    identity(join(dir, 'sub'));
    commit(join(dir, 'sub'), 'feat: new in sub', { 'l.ts': 'l2\n' });
    const nested = join(dir, 'nested');
    mkdirSync(nested);
    git(nested, 'init', '-q', '-b', 'main');
    writeFileSync(join(nested, 'n.ts'), 'n\n');
    writeFileSync(join(dir, 'a.ts'), 'a2\n');
    writeFileSync(join(dir, 'u.ts'), 'u\n');
    const h = harness([dir]);
    await h.refresh();
    expect(await h.ops.stage(h.K, { root: dir, rels: 'all' })).toMatchObject({ outcome: 'ok' });
    expect(staged(dir)).toEqual(['a.ts', 'u.ts']);
    const gitlinks = git(dir, 'ls-files', '--stage').split('\n').filter((l) => l.startsWith('160000'));
    expect(gitlinks).toEqual([`160000 ${subOid} 0\tsub`]);
  });

  test('index.lock held by someone else: busy after 3 retries, and the lock is never removed', async () => {
    const dir = repo();
    writeFileSync(join(dir, 'a.ts'), 'a2\n');
    const h = harness([dir]);
    await h.refresh();
    writeFileSync(join(dir, '.git', 'index.lock'), '');
    const runs: string[] = [];
    const counted = harness([dir], { run: (r, inv, o) => { runs.push(inv.op); return runWrite(r, inv, o); } });
    await counted.refresh();
    expect(await counted.ops.stage(counted.K, { root: dir, rels: ['a.ts'] })).toMatchObject({ outcome: 'busy', message: 'Git is busy in acme-store: a session is committing. Try again.' });
    expect(runs).toHaveLength(4);
    expect(existsSync(join(dir, '.git', 'index.lock'))).toBe(true);
    rmSync(join(dir, '.git', 'index.lock'));
  });
});

describe('commit, hooks, amend, undo', () => {
  test('message through stdin (a #123 line kept), the trailer once, an Undo offered', async () => {
    const dir = repo();
    writeFileSync(join(dir, 'a.ts'), 'a2\n');
    const h = harness([dir]);
    await h.refresh();
    await h.ops.stage(h.K, { root: dir, rels: ['a.ts'] });
    const r = await h.ops.commit(h.K, { root: dir, message: 'feat: change a\n\n#123 is the issue', amend: false, coAuthor: true, noVerify: false });
    expect(r).toMatchObject({ outcome: 'ok', sha: head(dir), undo: { oid: head(dir) } });
    const body = git(dir, 'log', '-1', '--format=%B');
    expect(body).toContain('#123 is the issue');
    expect(body.match(/Co-Authored-By: Claude <noreply@anthropic.com>/g)).toHaveLength(1);
    expect(h.events.filter((e) => e.op === 'commit').map((e) => e.phase)).toEqual(expect.arrayContaining(['queued', 'running', 'done']));
  });

  // POSIX: sh hooks; git prints C:/ worktree paths on Windows.
  posixTest('a failing pre-commit: outcome hook naming it, its output streamed; Commit Without Hooks commits; a passing hook streams too', async () => {
    const dir = repo();
    const hook = join(dir, '.git', 'hooks', 'pre-commit');
    writeFileSync(hook, '#!/bin/sh\necho "lint: 2 problems in a.ts"\nexit 1\n', { mode: 0o755 });
    writeFileSync(join(dir, 'a.ts'), 'a2\n');
    const h = harness([dir]);
    await h.refresh();
    await h.ops.stage(h.K, { root: dir, rels: ['a.ts'] });
    const before = head(dir);
    const failed = await h.ops.commit(h.K, { root: dir, message: 'feat: x', amend: false, coAuthor: false, noVerify: false });
    expect(failed).toMatchObject({ outcome: 'hook', hook: 'pre-commit' });
    expect(head(dir)).toBe(before);
    expect(h.events.some((e) => e.phase === 'hook' && e.hook === 'pre-commit')).toBe(true);
    expect(h.events.map((e) => e.chunk ?? '').join('')).toContain('lint: 2 problems in a.ts');
    expect(await h.ops.commit(h.K, { root: dir, message: 'feat: x', amend: false, coAuthor: false, noVerify: true })).toMatchObject({ outcome: 'ok' });
    expect(head(dir)).not.toBe(before);
    writeFileSync(hook, '#!/bin/sh\necho "checks passed"\n', { mode: 0o755 });
    writeFileSync(join(dir, 'a.ts'), 'a3\n');
    await h.refresh();
    await h.ops.stage(h.K, { root: dir, rels: ['a.ts'] });
    h.events.length = 0;
    expect(await h.ops.commit(h.K, { root: dir, message: 'feat: y', amend: false, coAuthor: false, noVerify: false })).toMatchObject({ outcome: 'ok' });
    expect(h.events.map((e) => e.chunk ?? '').join('')).toContain('checks passed');
  });

  test('undo restores the staged files and answers the message; the keep set holds the files while Undo is offered', async () => {
    const dir = repo();
    writeFileSync(join(dir, 'a.ts'), 'a2\n');
    writeFileSync(join(dir, 'n.ts'), 'n\n');
    const h = harness([dir]);
    await h.refresh();
    await h.ops.stage(h.K, { root: dir, rels: ['a.ts', 'n.ts'] });
    const before = head(dir);
    const stagedBefore = staged(dir);
    const r = await h.ops.commit(h.K, { root: dir, message: 'feat: two files', amend: false, coAuthor: false, noVerify: false });
    expect(h.keep.paths(dir).sort()).toEqual([join(dir, 'a.ts'), join(dir, 'n.ts')]);
    await h.refresh();
    expect(h.keep.paths(dir)).toHaveLength(2);
    expect((await h.ops.facts(h.K, { root: dir }))?.undo).toEqual({ oid: r.sha, files: ['a.ts', 'n.ts'] });
    expect(await h.ops.undoCommit(h.K, { root: dir, oid: r.sha! })).toMatchObject({ outcome: 'ok', message: 'feat: two files' });
    expect(head(dir)).toBe(before);
    expect(staged(dir)).toEqual(stagedBefore);
    // Still held until a status read after the reset came in (the prune it decides must see them), then released.
    expect(h.keep.paths(dir)).toHaveLength(2);
    await new Promise((res) => setTimeout(res, 5));
    await h.refresh();
    expect(h.keep.paths(dir)).toEqual([]);
    expect(await h.ops.undoCommit(h.K, { root: dir, oid: r.sha! })).toMatchObject({ outcome: 'stale' });
  });

  test('amend refused once pushed; undo refused once pushed', async () => {
    const { a } = remotePair();
    writeFileSync(join(a, 'x.ts'), 'changed\n');
    const h = harness([a]);
    await h.refresh();
    await h.ops.stage(h.K, { root: a, rels: ['x.ts'] });
    const c = await h.ops.commit(h.K, { root: a, message: 'feat: x', amend: false, coAuthor: false, noVerify: false });
    expect(await h.ops.push(h.K, { root: a })).toMatchObject({ outcome: 'ok' });
    expect(await h.ops.commit(h.K, { root: a, message: 'feat: x2', amend: true, coAuthor: false, noVerify: false })).toMatchObject({ outcome: 'stale', message: 'Already pushed: amending would rewrite shared history' });
    expect(await h.ops.undoCommit(h.K, { root: a, oid: c.sha! })).toMatchObject({ outcome: 'stale' });
    expect(head(a)).toBe(c.sha);
  });
});

describe('push, publish, rejected, lease', () => {
  test('publish a new branch to the remote, with its upstream', async () => {
    const { a, bare } = remotePair();
    git(a, 'switch', '-q', '-c', 'feat/pub');
    commit(a, 'feat: pub', { 'p.ts': 'p\n' });
    const h = harness([a]);
    expect(await h.ops.push(h.K, { root: a, publish: { remote: 'origin' } })).toMatchObject({ outcome: 'ok' });
    expect(git(bare, 'rev-parse', 'refs/heads/feat/pub').trim()).toBe(head(a));
    expect(git(a, 'rev-parse', '--abbrev-ref', '@{u}').trim()).toBe('origin/feat/pub');
  });

  test('push.default can’t widen or redirect a push: matching sends only the branch, upstream never sends it to main', async () => {
    const { a, b, bare } = remotePair();
    // Another local branch the remote has too, behind on the remote: matching would push it along.
    git(b, 'switch', '-q', '-c', 'side');
    commit(b, 'feat: side', { 's.ts': 's\n' });
    git(b, 'push', '-q', '-u', 'origin', 'side');
    git(a, 'fetch', '-q');
    git(a, 'switch', '-q', 'side');
    const sideLocal = commit(a, 'feat: side local', { 's2.ts': 's2\n' });
    git(a, 'switch', '-q', 'main');
    git(a, 'config', 'push.default', 'matching');
    const mainLocal = commit(a, 'feat: main', { 'm.ts': 'm\n' });
    const h = harness([a]);
    expect(await h.ops.push(h.K, { root: a })).toMatchObject({ outcome: 'ok' });
    expect(git(bare, 'rev-parse', 'refs/heads/main').trim()).toBe(mainLocal);
    expect(git(bare, 'rev-parse', 'refs/heads/side').trim()).not.toBe(sideLocal);
    // A branch made (in a terminal) from origin/main tracks it: with push.default=upstream git would push it to main.
    git(a, 'config', 'push.default', 'upstream');
    git(a, 'switch', '-q', '--track', '-c', 'feat/t', 'origin/main');
    commit(a, 'feat: t', { 't.ts': 't\n' });
    expect(await h.ops.push(h.K, { root: a })).toMatchObject({ outcome: 'state', message: 'feat/t tracks origin/main, a branch of another name: publish it as its own branch' });
    expect(await h.ops.sync(h.K, { root: a, rebase: true })).toMatchObject({ outcome: 'state' });
    expect(git(bare, 'rev-parse', 'refs/heads/main').trim()).toBe(mainLocal);
    // Publish gives it its own branch and upstream.
    expect(await h.ops.push(h.K, { root: a, publish: { remote: 'origin' } })).toMatchObject({ outcome: 'ok' });
    expect(git(a, 'rev-parse', '--abbrev-ref', '@{u}').trim()).toBe('origin/feat/t');
  });

  test('a new name clashing with a branch’s folder is refused with both names, never "busy"', async () => {
    const dir = repo();
    git(dir, 'branch', 'feat');
    const h = harness([dir]);
    expect(await h.ops.branchCreate(h.K, { root: dir, name: 'feat/n', switch: true })).toMatchObject({ outcome: 'error', message: "A branch named feat exists, so feat/n can't be made: pick another name" });
    expect(await h.ops.checkBranchName(h.K, { root: dir, name: 'feat/n' })).toBe(false);
    expect(git(dir, 'branch', '--show-current').trim()).toBe('main');
    // Renaming feat into its own folder is fine: git drops the old name first.
    expect(await h.ops.checkBranchName(h.K, { root: dir, name: 'feat/n', same: 'feat' })).toBe(true);
    expect(await h.ops.branchRename(h.K, { root: dir, ref: 'refs/heads/feat', name: 'feat/n' })).toMatchObject({ outcome: 'ok' });
    expect(git(dir, 'branch', '--list', 'feat/n').trim()).toBe('feat/n');
  });

  test('a new branch made in Atelier from origin/main tracks nothing; from origin/<same name> it tracks that', async () => {
    const { a, b } = remotePair();
    git(b, 'switch', '-q', '-c', 'feat/r');
    commit(b, 'feat: r', { 'r.ts': 'r\n' });
    git(b, 'push', '-q', '-u', 'origin', 'feat/r');
    git(a, 'fetch', '-q');
    const h = harness([a]);
    expect(await h.ops.branchCreate(h.K, { root: a, name: 'feat/n', from: 'refs/remotes/origin/main', switch: true })).toMatchObject({ outcome: 'ok' });
    expect(git(a, 'for-each-ref', '--format=%(upstream)', 'refs/heads/feat/n').trim()).toBe('');
    expect(await h.ops.branchCreate(h.K, { root: a, name: 'feat/r', from: 'refs/remotes/origin/feat/r', switch: false })).toMatchObject({ outcome: 'ok' });
    expect(git(a, 'for-each-ref', '--format=%(upstream)', 'refs/heads/feat/r').trim()).toBe('refs/remotes/origin/feat/r');
  });

  test('never pushes tags, even with push.followTags', async () => {
    const { a, bare } = remotePair();
    git(a, 'config', 'push.followTags', 'true');
    commit(a, 'feat: t', { 't.ts': 't\n' });
    git(a, 'tag', '-a', 'v9', '-m', 'v9');
    const h = harness([a]);
    expect(await h.ops.push(h.K, { root: a })).toMatchObject({ outcome: 'ok' });
    expect(git(bare, 'tag', '--list')).toBe('');
  });

  test('rejected; the remote commits shown; a lease on that oid refused when the remote moved again; then forced on the new one', async () => {
    const { a, b, bare } = remotePair();
    const c1 = commit(b, 'feat: from b', { 'b.ts': 'b\n' });
    git(b, 'push', '-q');
    const local = commit(a, 'feat: from a', { 'a.ts': 'a\n' });
    const h = harness([a]);
    expect(await h.ops.push(h.K, { root: a })).toMatchObject({ outcome: 'rejected' });
    const seen = await h.ops.remoteCommits(h.K, { root: a, n: 3 });
    expect(seen).toEqual({ commits: [{ oid: c1, subject: 'feat: from b', author: 'Ada' }], remoteOid: c1, total: 1 });
    // Someone pushes again after the sheet was built.
    const c3 = commit(b, 'feat: again', { 'b2.ts': 'b2\n' });
    git(b, 'push', '-q');
    expect(await h.ops.push(h.K, { root: a, lease: { oid: c1 } })).toMatchObject({ outcome: 'stale' });
    expect(git(bare, 'rev-parse', 'main').trim()).toBe(c3);
    // A lease on an oid main never showed is refused before git.
    expect(await h.ops.push(h.K, { root: a, lease: { oid: c3 } })).toMatchObject({ outcome: 'stale', message: 'The remote moved since you looked: look again before forcing' });
    expect((await h.ops.remoteCommits(h.K, { root: a, n: 3 })).remoteOid).toBe(c3);
    expect(await h.ops.push(h.K, { root: a, lease: { oid: c3 } })).toMatchObject({ outcome: 'ok' });
    expect(git(bare, 'rev-parse', 'main').trim()).toBe(local);
  });
});

describe('pull', () => {
  test('ff-only brings the remote commits', async () => {
    const { a, b } = remotePair();
    const c = commit(b, 'feat: b', { 'x.ts': 'one\ntwo\nthree\nfour\n' });
    git(b, 'push', '-q');
    const h = harness([a]);
    expect(await h.ops.pull(h.K, { root: a, rebase: false })).toMatchObject({ outcome: 'ok' });
    expect(head(a)).toBe(c);
  });

  test('refused when local changes would be overwritten: dirty with the files, nothing moved', async () => {
    const { a, b } = remotePair();
    commit(b, 'feat: b', { 'x.ts': 'remote\n' });
    git(b, 'push', '-q');
    writeFileSync(join(a, 'x.ts'), 'local edit\n');
    const before = head(a);
    const h = harness([a]);
    expect(await h.ops.pull(h.K, { root: a, rebase: false })).toMatchObject({ outcome: 'conflict', dirty: true, files: ['x.ts'], message: 'Your changes to 1 file would be overwritten: commit or stash them first' });
    expect(head(a)).toBe(before);
    expect(readFileSync(join(a, 'x.ts'), 'utf8')).toBe('local edit\n');
  });

  test('a rebase that conflicts is aborted: HEAD, index, local refs and the working tree byte-identical', async () => {
    const { a, b } = remotePair();
    commit(b, 'feat: b side', { 'x.ts': 'one\nB\nthree\n' });
    git(b, 'push', '-q');
    commit(a, 'feat: a side', { 'x.ts': 'one\nA\nthree\n' });
    writeFileSync(join(a, 'untracked.txt'), 'stays\n');
    git(a, 'fetch', '-q');
    const before = snapshot(a);
    const h = harness([a]);
    const r = await h.ops.pull(h.K, { root: a, rebase: true });
    expect(r).toMatchObject({ outcome: 'conflict', message: "Couldn't rebase cleanly: your commits and origin/main change the same lines. Finish it in the terminal." });
    expect(existsSync(join(a, '.git', 'rebase-merge'))).toBe(false);
    expect(existsSync(join(a, '.git', 'rebase-apply'))).toBe(false);
    expect(snapshot(a)).toEqual(before);
  });

  test('Stash and Pull: stash, pull, pop that exact stash; the stashed files held in the keep set until after the pop', async () => {
    const { a, b } = remotePair();
    const c = commit(b, 'feat: b', { 'x.ts': 'one\ntwo\nthree\nremote\n' });
    git(b, 'push', '-q');
    writeFileSync(join(a, 'keep.ts'), 'local edit\n');
    writeFileSync(join(a, 'new.ts'), 'new\n');
    const held: Record<string, string[]> = {};
    let h!: ReturnType<typeof harness>;
    h = harness([a], { run: (r, inv: Invocation, o) => { held[inv.args.slice(0, 2).join(' ')] = h.keep.paths(a).sort(); return runWrite(r, inv, o); } });
    expect(await h.ops.pull(h.K, { root: a, rebase: false, stash: true })).toMatchObject({ outcome: 'ok' });
    expect(head(a)).toBe(c);
    expect(readFileSync(join(a, 'keep.ts'), 'utf8')).toBe('local edit\n');
    expect(readFileSync(join(a, 'new.ts'), 'utf8')).toBe('new\n');
    expect(git(a, 'stash', 'list')).toBe('');
    const files = [join(a, 'keep.ts'), join(a, 'new.ts')];
    expect(held['pull --ff-only']).toEqual(files);
    expect(held['stash apply']).toEqual(files);
    expect(held['stash drop']).toEqual(files);
    expect(h.keep.paths(a).sort()).toEqual(files);
    await new Promise((res) => setTimeout(res, 5));
    await h.refresh();
    expect(h.keep.paths(a)).toEqual([]);
  });
});

describe('switch', () => {
  function branched(): string {
    const dir = repo();
    git(dir, 'branch', 'feat');
    writeFileSync(join(dir, 'a.ts'), 'dirty\n');
    return dir;
  }

  test('none refuses a dirty tree; bring carries the changes; stash leaves them named in the stash list', async () => {
    const dir = branched();
    const h = harness([dir]);
    expect(await h.ops.switchTo(h.K, { root: dir, ref: 'refs/heads/feat', carry: 'none' })).toMatchObject({ outcome: 'conflict', dirty: true, files: ['a.ts'] });
    expect(git(dir, 'branch', '--show-current').trim()).toBe('main');
    expect(await h.ops.switchTo(h.K, { root: dir, ref: 'refs/heads/feat', carry: 'bring' })).toMatchObject({ outcome: 'ok' });
    expect(git(dir, 'branch', '--show-current').trim()).toBe('feat');
    expect(readFileSync(join(dir, 'a.ts'), 'utf8')).toBe('dirty\n');
    const r = await h.ops.switchTo(h.K, { root: dir, ref: 'refs/heads/main', carry: 'stash' });
    expect(r).toMatchObject({ outcome: 'ok', stash: { message: 'On feat: Atelier: changes on feat' } });
    expect(git(dir, 'branch', '--show-current').trim()).toBe('main');
    expect(readFileSync(join(dir, 'a.ts'), 'utf8')).toBe('a\n');
    expect(git(dir, 'stash', 'list')).toContain('Atelier: changes on feat');
  });

  posixTest('a failing post-checkout hook (git answers its status): switched, the stash kept, never popped onto the new branch', async () => {
    const dir = branched();
    const p = join(dir, '.git', 'hooks', 'post-checkout');
    writeFileSync(p, '#!/bin/sh\necho "git-lfs was not found on your path" >&2\nexit 2\n');
    chmodSync(p, 0o755);
    const h = harness([dir]);
    const r = await h.ops.switchTo(h.K, { root: dir, ref: 'refs/heads/feat', carry: 'stash' });
    expect(r).toMatchObject({ outcome: 'ok', stash: { message: 'On main: Atelier: changes on main' } });
    expect(r.warning).toContain('post-checkout');
    expect(git(dir, 'branch', '--show-current').trim()).toBe('feat');
    expect(readFileSync(join(dir, 'a.ts'), 'utf8')).toBe('a\n');
    expect(git(dir, 'stash', 'list')).toContain('Atelier: changes on main');
    // A new branch made with it, and a new worktree: done, with the warning.
    const made = await h.ops.branchCreate(h.K, { root: dir, name: 'topic/n', switch: true });
    expect(made).toMatchObject({ outcome: 'ok' });
    expect(git(dir, 'branch', '--show-current').trim()).toBe('topic/n');
    const wt = join(dir, '.claude', 'worktrees', 'w');
    expect(await h.ops.worktreeAdd(h.K, { root: dir, path: wt, newName: 'topic/w' })).toMatchObject({ outcome: 'ok' });
    expect(existsSync(join(wt, 'a.ts'))).toBe(true);
  });

  test('a remote branch with no local one is tracked', async () => {
    const { a, b } = remotePair();
    git(b, 'switch', '-q', '-c', 'feat/r');
    commit(b, 'feat: r', { 'r.ts': 'r\n' });
    git(b, 'push', '-q', '-u', 'origin', 'feat/r');
    git(a, 'fetch', '-q');
    const h = harness([a]);
    expect(await h.ops.switchTo(h.K, { root: a, ref: 'refs/remotes/origin/feat/r', carry: 'none' })).toMatchObject({ outcome: 'ok' });
    expect(git(a, 'rev-parse', '--abbrev-ref', '@{u}').trim()).toBe('origin/feat/r');
  });
});

describe('branches', () => {
  test('create, rename, delete (unmerged refused, then forced), restore', async () => {
    const dir = repo();
    const h = harness([dir]);
    expect(await h.ops.checkBranchName(h.K, { root: dir, name: 'feat/ok' })).toBe(true);
    expect(await h.ops.checkBranchName(h.K, { root: dir, name: 'bad..name' })).toBe(false);
    expect(await h.ops.branchCreate(h.K, { root: dir, name: 'topic', from: 'refs/heads/main', switch: false })).toMatchObject({ outcome: 'ok' });
    expect(await h.ops.branchRename(h.K, { root: dir, ref: 'refs/heads/topic', name: 'topic2' })).toMatchObject({ outcome: 'ok' });
    expect(git(dir, 'branch', '--list', 'topic2').trim()).toBe('topic2');
    expect(await h.ops.branchCreate(h.K, { root: dir, name: 'wip', switch: true })).toMatchObject({ outcome: 'ok' });
    const wip = commit(dir, 'feat: wip', { 'w.ts': 'w\n' });
    git(dir, 'switch', '-q', 'main');
    expect(await h.ops.branchDelete(h.K, { root: dir, ref: 'refs/heads/main', force: true })).toMatchObject({ outcome: 'state' });
    expect(await h.ops.branchDelete(h.K, { root: dir, ref: 'refs/heads/wip', force: false })).toMatchObject({ outcome: 'conflict', message: "wip has 1 commit that isn't merged anywhere" });
    const del = await h.ops.branchDelete(h.K, { root: dir, ref: 'refs/heads/wip', force: true });
    expect(del).toMatchObject({ outcome: 'ok', branch: { name: 'wip', oid: wip } });
    expect(git(dir, 'branch', '--list', 'wip')).toBe('');
    expect(await h.ops.branchRestore(h.K, { root: dir, name: 'wip', oid: wip })).toMatchObject({ outcome: 'ok' });
    expect(git(dir, 'rev-parse', 'refs/heads/wip').trim()).toBe(wip);
  });

  // POSIX: sh hooks; git prints C:/ worktree paths on Windows.
  posixTest('worktree add inside the project, a new branch; refused outside it', async () => {
    const dir = repo();
    const h = harness([dir]);
    const path = join(dir, '.claude', 'worktrees', 'w');
    expect(await h.ops.worktreeCheck(h.K, { root: dir, path })).toEqual({ inside: true, exists: false, ignored: false });
    expect(await h.ops.worktreeAdd(h.K, { root: dir, path, newName: 'w' })).toMatchObject({ outcome: 'ok' });
    expect(git(dir, 'worktree', 'list', '--porcelain')).toContain(`worktree ${path}`);
    expect(git(path, 'branch', '--show-current').trim()).toBe('w');
    const outside = join(tmp('atl-ops-out-'), 'w');
    expect(await h.ops.worktreeAdd(h.K, { root: dir, path: outside, newName: 'w2' })).toMatchObject({ outcome: 'error' });
    expect(existsSync(outside)).toBe(false);
  });

  // POSIX: as above.
  posixTest('a run\'s worktree (automations): created without a window; removed when clean, kept with changes; the branch stays', async () => {
    const dir = repo();
    const h = harness([dir]);
    const path = join(dir, '.claude', 'worktrees', 'auto-cu-1-x');
    expect(await h.ops.worktreeAddForRun({ project: dir, root: dir, path, start: 'refs/heads/main', newName: 'auto/cu-1-x' })).toMatchObject({ outcome: 'ok' });
    writeFileSync(join(path, 'a.ts'), 'changed\n');
    expect(await h.ops.worktreeRemoveForRun({ project: dir, root: dir, path })).toMatchObject({ outcome: 'conflict' });
    expect(existsSync(join(path, 'a.ts'))).toBe(true);
    git(path, 'checkout', '--', 'a.ts');
    expect(await h.ops.worktreeRemoveForRun({ project: dir, root: dir, path })).toMatchObject({ outcome: 'ok' });
    expect(existsSync(path)).toBe(false);
    expect(git(dir, 'worktree', 'list', '--porcelain')).not.toContain(path);
    expect(git(dir, 'branch', '--list', 'auto/cu-1-x').trim()).toBe('auto/cu-1-x');
  });

  // POSIX: as above.
  posixTest('a run\'s branch from origin/main tracks nothing (a plain push or pull never reaches main)', async () => {
    const { a } = remotePair();
    const h = harness([a]);
    const path = join(a, '.claude', 'worktrees', 'auto-cu-2-y');
    expect(await h.ops.worktreeAddForRun({ project: a, root: a, path, start: 'refs/remotes/origin/main', newName: 'auto/cu-2-y' })).toMatchObject({ outcome: 'ok' });
    expect(git(a, 'config', '--list')).not.toContain('branch.auto/cu-2-y.');
  });
});

describe('stashes', () => {
  test('push, apply, drop and store (Undo), pop; a moved list is stale; dirty files refused upfront', async () => {
    const dir = repo();
    writeFileSync(join(dir, 'a.ts'), 'stashed\n');
    writeFileSync(join(dir, 'n.ts'), 'new\n');
    const h = harness([dir]);
    const pushed = await h.ops.stashPush(h.K, { root: dir, message: 'wip one', untracked: true, staged: false });
    expect(pushed).toMatchObject({ outcome: 'ok', stash: { message: 'On main: wip one' } });
    const oid = pushed.stash!.oid;
    expect(readFileSync(join(dir, 'a.ts'), 'utf8')).toBe('a\n');
    expect(existsSync(join(dir, 'n.ts'))).toBe(false);
    writeFileSync(join(dir, 'a.ts'), 'other edit\n');
    expect(await h.ops.stashApply(h.K, { root: dir, index: 0, oid, pop: true })).toMatchObject({ outcome: 'conflict', dirty: true, files: ['a.ts'] });
    git(dir, 'checkout', '--', 'a.ts');
    expect(await h.ops.stashApply(h.K, { root: dir, index: 0, oid: 'f'.repeat(40), pop: false })).toMatchObject({ outcome: 'stale' });
    expect(await h.ops.stashApply(h.K, { root: dir, index: 0, oid, pop: false })).toMatchObject({ outcome: 'ok' });
    expect(readFileSync(join(dir, 'a.ts'), 'utf8')).toBe('stashed\n');
    git(dir, 'checkout', '--', 'a.ts');
    rmSync(join(dir, 'n.ts'));
    const dropped = await h.ops.stashDrop(h.K, { root: dir, index: 0, oid });
    expect(dropped).toMatchObject({ outcome: 'ok', stash: { oid, message: 'On main: wip one' } });
    expect(git(dir, 'stash', 'list')).toBe('');
    expect(await h.ops.stashRestore(h.K, { root: dir, oid, message: 'On main: wip one' })).toMatchObject({ outcome: 'ok' });
    expect(git(dir, 'stash', 'list')).toContain('wip one');
    expect(await h.ops.stashApply(h.K, { root: dir, index: 0, oid, pop: true })).toMatchObject({ outcome: 'ok' });
    expect(git(dir, 'stash', 'list')).toBe('');
    expect(readFileSync(join(dir, 'n.ts'), 'utf8')).toBe('new\n');
  });
});

describe('discard', () => {
  test('modified, untracked, staged new, deleted and renamed files: their current versions in the Trash, the repo back at HEAD', async () => {
    const dir = repo({ 'a.ts': 'a\n', 'old.ts': 'o1\no2\no3\n', 'del.ts': 'd\n' });
    writeFileSync(join(dir, 'a.ts'), 'mine\n');
    writeFileSync(join(dir, 'u.ts'), 'untracked\n');
    writeFileSync(join(dir, 'n.ts'), 'staged new\n');
    git(dir, 'add', 'n.ts');
    rmSync(join(dir, 'del.ts'));
    git(dir, 'mv', 'old.ts', 'renamed.ts');
    const h = harness([dir]);
    await h.refresh();
    const before = new Set(readdirSync(trash));
    const r = await h.ops.discard(h.K, { root: dir, rels: ['a.ts', 'u.ts', 'n.ts', 'del.ts', 'renamed.ts'] });
    expect(r).toMatchObject({ outcome: 'ok', message: '4 files moved to the Trash' });
    expect(git(dir, 'status', '--porcelain', '--untracked-files=all')).toBe('');
    expect(readFileSync(join(dir, 'a.ts'), 'utf8')).toBe('a\n');
    expect(readFileSync(join(dir, 'old.ts'), 'utf8')).toBe('o1\no2\no3\n');
    expect(readFileSync(join(dir, 'del.ts'), 'utf8')).toBe('d\n');
    const added = readdirSync(trash).filter((n) => !before.has(n));
    const content = Object.fromEntries(added.map((n) => [n.replace(/^\d+-/, ''), readFileSync(join(trash, n), 'utf8')]));
    expect(content).toEqual({ 'a.ts': 'mine\n', 'u.ts': 'untracked\n', 'n.ts': 'staged new\n', 'renamed.ts': 'o1\no2\no3\n' });
  });

  test('all: past the status cap too, untracked included; nested repositories left alone', async () => {
    const dir = repo();
    for (let i = 0; i < 2100; i++) writeFileSync(join(dir, `f${i}.txt`), 'x\n');
    const nested = join(dir, 'nested');
    mkdirSync(nested);
    git(nested, 'init', '-q', '-b', 'main');
    writeFileSync(join(nested, 'n.txt'), 'nested\n');
    const h = harness([dir]);
    await h.refresh();
    expect((await readRepoStatus(dir)).truncated).toBeGreaterThan(0);
    const r = await h.ops.discard(h.K, { root: dir, rels: 'all' });
    expect(r).toMatchObject({ outcome: 'ok', message: '2100 files moved to the Trash · 1 file left alone (conflicts, submodules, folders)' });
    expect(readFileSync(join(nested, 'n.txt'), 'utf8')).toBe('nested\n');
    expect(git(dir, 'status', '--porcelain')).toBe('?? nested/\n');
  }, 60_000);
});

// ── security review fixes ────────────────────────────────────────────────────────────────────────────────────────────

const rawRun = (o: Partial<RawRun> = {}): RawRun => ({ code: null, output: '', truncated: false, cancelled: false, timedOut: false, traced: false, ...o });
const LOCK_LEFT = 'A git lock file was left behind in acme-store (.git/index.lock). If no git command is running, remove it from the terminal.';

describe('stopped ops: lock files and cleanup (review 1)', () => {
  test('a cancelled or timed-out op that left .git/index.lock says so (never deletes it); without a lock it is just cancelled', async () => {
    const dir = repo();
    writeFileSync(join(dir, 'a.ts'), 'a2\n');
    const lock = join(dir, '.git', 'index.lock');
    for (const stop of [{ cancelled: true }, { timedOut: true }]) {
      const h = harness([dir], { run: async () => { writeFileSync(lock, ''); return rawRun(stop); } });
      await h.refresh();
      expect(await h.ops.stage(h.K, { root: dir, rels: ['a.ts'] })).toMatchObject({ outcome: 'error', message: LOCK_LEFT });
      expect(existsSync(lock)).toBe(true);
      rmSync(lock);
    }
    const h = harness([dir], { run: async () => rawRun({ cancelled: true }) });
    await h.refresh();
    expect(await h.ops.stage(h.K, { root: dir, rels: ['a.ts'] })).toMatchObject({ outcome: 'cancelled' });
  });

  test('busy on a lock over a minute old: the message says it may be left behind', async () => {
    const dir = repo();
    writeFileSync(join(dir, 'a.ts'), 'a2\n');
    const lock = join(dir, '.git', 'index.lock');
    writeFileSync(lock, '');
    const old = (Date.now() - 5 * 60_000) / 1000;
    utimesSync(lock, old, old);
    const h = harness([dir]);
    await h.refresh();
    const r = await h.ops.stage(h.K, { root: dir, rels: ['a.ts'] });
    expect(r.outcome).toBe('busy');
    expect(r.message).toBe('Git is busy in acme-store: a session is committing. Try again. Its lock file (.git/index.lock) is over a minute old: if no git command is running, remove it from the terminal.');
    expect(existsSync(lock)).toBe(true);
  });

  /** A run that lets git run, then cancels the op as if the user pressed Cancel during it (the signal is aborted). */
  const cancelling = (h: () => ReturnType<typeof harness>, when: (inv: Invocation) => boolean, real = true): GitOpsDeps['run'] => async (r, inv, o) => {
    if (!when(inv)) return runWrite(r, inv, o);
    const out = real ? await runWrite(r, inv, o) : rawRun();
    h().ops.cancelAll();
    return { ...out, cancelled: true };
  };

  test('a cancelled pull --rebase is still aborted (cleanup with a fresh signal): the repo exactly as before', async () => {
    const { a, b } = remotePair();
    commit(b, 'feat: b side', { 'x.ts': 'one\nB\nthree\n' });
    git(b, 'push', '-q');
    commit(a, 'feat: a side', { 'x.ts': 'one\nA\nthree\n' });
    git(a, 'fetch', '-q');
    const before = snapshot(a);
    let h!: ReturnType<typeof harness>;
    h = harness([a], { run: cancelling(() => h, (inv) => inv.args[0] === 'pull') });
    const r = await h.ops.pull(h.K, { root: a, rebase: true });
    expect(r.outcome).toBe('cancelled');
    expect(existsSync(join(a, '.git', 'rebase-merge'))).toBe(false);
    expect(snapshot(a)).toEqual(before);
  });

  test('Stash and Pull cancelled during the pull: the stash is popped back', async () => {
    const { a, b } = remotePair();
    commit(b, 'feat: b', { 'x.ts': 'one\ntwo\nthree\nremote\n' });
    git(b, 'push', '-q');
    writeFileSync(join(a, 'keep.ts'), 'local edit\n');
    let h!: ReturnType<typeof harness>;
    h = harness([a], { run: cancelling(() => h, (inv) => inv.args[0] === 'pull', false) });
    expect(await h.ops.pull(h.K, { root: a, rebase: false, stash: true })).toMatchObject({ outcome: 'cancelled' });
    expect(git(a, 'stash', 'list')).toBe('');
    expect(readFileSync(join(a, 'keep.ts'), 'utf8')).toBe('local edit\n');
  });

  test('stash-and-switch cancelled during the switch: the stash is popped back', async () => {
    const dir = repo();
    git(dir, 'branch', 'feat');
    writeFileSync(join(dir, 'a.ts'), 'dirty\n');
    let h!: ReturnType<typeof harness>;
    h = harness([dir], { run: cancelling(() => h, (inv) => inv.args[0] === 'switch', false) });
    expect(await h.ops.switchTo(h.K, { root: dir, ref: 'refs/heads/feat', carry: 'stash' })).toMatchObject({ outcome: 'cancelled' });
    expect(git(dir, 'branch', '--show-current').trim()).toBe('main');
    expect(git(dir, 'stash', 'list')).toBe('');
    expect(readFileSync(join(dir, 'a.ts'), 'utf8')).toBe('dirty\n');
  });
});

describe('branch names that are refspecs or other refs (review 2, 13)', () => {
  test('"+main" is never a new name; publishing a branch so named (made in a terminal) is refused and the remote main is untouched', async () => {
    const { a, b, bare } = remotePair();
    commit(b, 'feat: their work', { 'y.ts': 'theirs\n' });
    git(b, 'push', '-q');
    const theirs = git(bare, 'rev-parse', 'refs/heads/main').trim();
    commit(a, 'feat: mine', { 'x.ts': 'mine\n' });
    const h = harness([a]);
    expect(await h.ops.checkBranchName(h.K, { root: a, name: '+main' })).toBe(false);
    expect(await h.ops.branchCreate(h.K, { root: a, name: '+main', switch: true })).toMatchObject({ outcome: 'error' });
    git(a, 'switch', '-q', '-c', '+main');
    const r = await h.ops.push(h.K, { root: a, publish: { remote: 'origin' } });
    expect(r.outcome).not.toBe('ok');
    expect(git(bare, 'rev-parse', 'refs/heads/main').trim()).toBe(theirs);
  });

  test('a remote branch is tracked by its full refname: a local branch named origin/feat/r never shadows it', async () => {
    const { a, b } = remotePair();
    git(b, 'switch', '-q', '-c', 'feat/r');
    const remote = commit(b, 'feat: r', { 'r.ts': 'r\n' });
    git(b, 'push', '-q', '-u', 'origin', 'feat/r');
    git(a, 'fetch', '-q');
    git(a, 'branch', 'origin/feat/r', 'main');
    const h = harness([a]);
    expect(await h.ops.switchTo(h.K, { root: a, ref: 'refs/remotes/origin/feat/r', carry: 'none' })).toMatchObject({ outcome: 'ok' });
    expect(git(a, 'branch', '--show-current').trim()).toBe('feat/r');
    expect(head(a)).toBe(remote);
    expect(git(a, 'rev-parse', '--symbolic-full-name', '@{u}').trim()).toBe('refs/remotes/origin/feat/r');
  });
});

describe('unstage never touches a merge (review 3)', () => {
  test('an unmerged file is refused; Unstage All is refused while a conflict or a merge is in progress', async () => {
    const dir = repo({ 'c.ts': 'base\n', 'o.ts': 'o\n' });
    git(dir, 'switch', '-q', '-c', 'side');
    commit(dir, 'side', { 'c.ts': 'side\n', 'o.ts': 'o side\n' });
    git(dir, 'switch', '-q', 'main');
    commit(dir, 'main', { 'c.ts': 'main\n' });
    try { git(dir, 'merge', '-q', 'side'); } catch { /* the conflict is the point */ }
    const h = harness([dir]);
    await h.refresh();
    const index = git(dir, 'ls-files', '--stage');
    expect(await h.ops.unstage(h.K, { root: dir, rels: ['c.ts'] })).toMatchObject({ outcome: 'state', files: ['c.ts'] });
    expect(await h.ops.unstage(h.K, { root: dir, rels: 'all' })).toMatchObject({ outcome: 'state' });
    expect(git(dir, 'ls-files', '--stage')).toBe(index);
    // Resolved, the merge still in progress: Unstage All would drop the merged-in changes from the merge's index.
    writeFileSync(join(dir, 'c.ts'), 'resolved\n');
    git(dir, 'add', 'c.ts');
    await h.refresh();
    const merged = git(dir, 'ls-files', '--stage');
    expect(await h.ops.unstage(h.K, { root: dir, rels: 'all' })).toMatchObject({ outcome: 'state', message: 'acme-store is in the middle of a merge: finish it in the terminal' });
    expect(git(dir, 'ls-files', '--stage')).toBe(merged);
    expect(staged(dir)).toEqual(['c.ts', 'o.ts']);
  });
});

describe('discard never loses work outside the Trash (review 4, 15)', () => {
  const newInTrash = (before: Set<string>) => readdirSync(trash).filter((n) => !before.has(n)).map((n) => readFileSync(join(trash, n), 'utf8')).sort();

  test('a rename a → b with a new untracked a: discarding b trashes both before HEAD\'s a comes back', async () => {
    const dir = repo({ 'a.ts': 'head a\n' });
    git(dir, 'mv', 'a.ts', 'b.ts');
    writeFileSync(join(dir, 'a.ts'), 'PRECIOUS new work\n');
    const h = harness([dir]);
    await h.refresh();
    const before = new Set(readdirSync(trash));
    const r = await h.ops.discard(h.K, { root: dir, rels: ['b.ts'] });
    expect(r).toMatchObject({ outcome: 'ok', message: '2 files moved to the Trash' });
    expect(readFileSync(join(dir, 'a.ts'), 'utf8')).toBe('head a\n');
    expect(existsSync(join(dir, 'b.ts'))).toBe(false);
    expect(newInTrash(before)).toEqual(['PRECIOUS new work\n', 'head a\n']);
    expect(git(dir, 'status', '--porcelain', '--untracked-files=all')).toBe('');
  });

  test('staged, then deleted (MD, AD) or changed again (MM, AM): kept, the index untouched; the others are discarded', async () => {
    const dir = repo({ 'm.ts': 'head m\n', 'p.ts': 'head p\n', 'plain.ts': 'head plain\n' });
    writeFileSync(join(dir, 'm.ts'), 'STAGED M work\n'); git(dir, 'add', 'm.ts'); rmSync(join(dir, 'm.ts'));
    writeFileSync(join(dir, 'n.ts'), 'STAGED NEW work\n'); git(dir, 'add', 'n.ts'); rmSync(join(dir, 'n.ts'));
    writeFileSync(join(dir, 'p.ts'), 'head p\nSTAGED-ONLY line\n'); git(dir, 'add', 'p.ts'); writeFileSync(join(dir, 'p.ts'), 'head p\nworktree line\n');
    writeFileSync(join(dir, 'q.ts'), 'STAGED Q\n'); git(dir, 'add', 'q.ts'); writeFileSync(join(dir, 'q.ts'), 'worktree q\n');
    writeFileSync(join(dir, 'plain.ts'), 'mine\n');
    const h = harness([dir]);
    await h.refresh();
    const index = git(dir, 'ls-files', '--stage', 'm.ts', 'n.ts', 'p.ts', 'q.ts');
    const before = new Set(readdirSync(trash));
    const r = await h.ops.discard(h.K, { root: dir, rels: ['m.ts', 'n.ts', 'p.ts', 'q.ts', 'plain.ts'] });
    expect(r).toMatchObject({ outcome: 'ok', files: ['m.ts', 'n.ts', 'p.ts', 'q.ts'] });
    expect(r.message).toBe("1 file moved to the Trash · 4 files kept: they have staged changes that aren't in your working copy — unstage or commit them first");
    expect(git(dir, 'ls-files', '--stage', 'm.ts', 'n.ts', 'p.ts', 'q.ts')).toBe(index);
    expect(readFileSync(join(dir, 'p.ts'), 'utf8')).toBe('head p\nworktree line\n');
    expect(readFileSync(join(dir, 'plain.ts'), 'utf8')).toBe('head plain\n');
    expect(newInTrash(before)).toEqual(['mine\n']);
    // Only kept ones: nothing was discarded at all.
    const only = await h.ops.discard(h.K, { root: dir, rels: ['m.ts'] });
    expect(only).toMatchObject({ outcome: 'state', files: ['m.ts'], message: "1 file kept: it has staged changes that aren't in your working copy — unstage or commit them first" });
  });

  test('no commit yet: a staged new file is trashed and unstaged, an untracked one trashed, a staged-then-deleted one kept', async () => {
    const dir = join(tmp('atl-ops-'), 'acme-store');
    mkdirSync(dir);
    git(dir, 'init', '-q', '-b', 'main');
    identity(dir);
    writeFileSync(join(dir, 'a.ts'), 'new a\n'); git(dir, 'add', 'a.ts');
    writeFileSync(join(dir, 'gone.ts'), 'STAGED gone\n'); git(dir, 'add', 'gone.ts'); rmSync(join(dir, 'gone.ts'));
    writeFileSync(join(dir, 'u.ts'), 'untracked\n');
    const h = harness([dir]);
    await h.refresh();
    const before = new Set(readdirSync(trash));
    const r = await h.ops.discard(h.K, { root: dir, rels: 'all' });
    expect(r).toMatchObject({ outcome: 'ok', files: ['gone.ts'] });
    expect(r.message).toMatch(/^2 files moved to the Trash · 1 file kept/);
    expect(git(dir, 'ls-files')).toBe('gone.ts\n');
    expect(existsSync(join(dir, 'a.ts'))).toBe(false);
    expect(newInTrash(before)).toEqual(['new a\n', 'untracked\n']);
  });
});

describe('hooks see git as a terminal runs it (review 5)', () => {
  // POSIX: sh hooks; git prints C:/ worktree paths on Windows.
  posixTest('a pre-commit that checks staged *.js files with a glob pathspec blocks the commit through GitOps too', async () => {
    const dir = repo();
    const hook = join(dir, '.git', 'hooks', 'pre-commit');
    writeFileSync(hook, '#!/bin/sh\nfiles=$(git diff --cached --name-only -- "*.js")\nif [ -n "$files" ]; then echo "blocked: $files"; exit 1; fi\nexit 0\n', { mode: 0o755 });
    writeFileSync(join(dir, 'bad.js'), 'x\n');
    const h = harness([dir]);
    await h.refresh();
    expect(await h.ops.stage(h.K, { root: dir, rels: ['bad.js'] })).toMatchObject({ outcome: 'ok' });
    const before = head(dir);
    expect(await h.ops.commit(h.K, { root: dir, message: 'feat: sneaky', amend: false, coAuthor: false, noVerify: false }))
      .toMatchObject({ outcome: 'hook', hook: 'pre-commit', message: 'blocked: bad.js' });
    expect(head(dir)).toBe(before);
  });
});

describe('Undo only for the commit Atelier made (review 8)', () => {
  test('a session that commits right after ours: no Undo (it would reset the session\'s commit)', async () => {
    const dir = repo();
    writeFileSync(join(dir, 'a.ts'), 'a2\n');
    const h = harness([dir], {
      run: async (r, inv, o) => {
        const out = await runWrite(r, inv, o);
        if (inv.op === 'commit') commit(dir, 'session: its own work', { 's.ts': 's\n' });
        return out;
      }
    });
    await h.refresh();
    await h.ops.stage(h.K, { root: dir, rels: ['a.ts'] });
    const r = await h.ops.commit(h.K, { root: dir, message: 'feat: mine', amend: false, coAuthor: false, noVerify: false });
    expect(r.outcome).toBe('ok');
    expect(r.undo).toBeUndefined();
    expect((await h.ops.facts(h.K, { root: dir }))?.undo).toBeNull();
  });

  test('a session that amends ours with its own message: no Undo; our own commit (trailer and cleanup aside): Undo', async () => {
    const dir = repo();
    writeFileSync(join(dir, 'a.ts'), 'a2\n');
    let amend = true;
    const h = harness([dir], {
      run: async (r, inv, o) => {
        const out = await runWrite(r, inv, o);
        if (inv.op === 'commit' && amend) git(dir, 'commit', '-q', '--amend', '-m', 'session: reworded');
        return out;
      }
    });
    await h.refresh();
    await h.ops.stage(h.K, { root: dir, rels: ['a.ts'] });
    expect((await h.ops.commit(h.K, { root: dir, message: 'feat: mine', amend: false, coAuthor: false, noVerify: false })).undo).toBeUndefined();
    amend = false;
    writeFileSync(join(dir, 'a.ts'), 'a3\n');
    await h.refresh();
    await h.ops.stage(h.K, { root: dir, rels: ['a.ts'] });
    const r = await h.ops.commit(h.K, { root: dir, message: '\n  feat: mine again  \n\n\nbody   \n', amend: false, coAuthor: true, noVerify: false });
    expect(r).toMatchObject({ outcome: 'ok', undo: { oid: head(dir) } });
  });
});

describe('Undo of a branch delete brings its upstream back (review 14)', () => {
  test('delete a tracking branch, restore it: same oid, same upstream', async () => {
    const { a } = remotePair();
    git(a, 'switch', '-q', '-c', 'feat/u');
    const oid = commit(a, 'feat: u', { 'u.ts': 'u\n' });
    git(a, 'push', '-q', '-u', 'origin', 'feat/u');
    git(a, 'switch', '-q', 'main');
    const h = harness([a]);
    expect(await h.ops.branchDelete(h.K, { root: a, ref: 'refs/heads/feat/u', force: true })).toMatchObject({ outcome: 'ok', branch: { name: 'feat/u', oid } });
    expect(await h.ops.branchRestore(h.K, { root: a, name: 'feat/u', oid })).toMatchObject({ outcome: 'ok' });
    expect(git(a, 'rev-parse', 'refs/heads/feat/u').trim()).toBe(oid);
    expect(git(a, 'rev-parse', '--symbolic-full-name', 'feat/u@{u}').trim()).toBe('refs/remotes/origin/feat/u');
  });
});

describe('facts: a GitHub compare base per remote, never a remote URL', () => {
  test('github.com remotes give https://github.com/<owner>/<repo>; credentials and other hosts never reach the renderer', async () => {
    const dir = repo();
    git(dir, 'remote', 'add', 'origin', 'https://ada:ghp_SECRET123@github.com/acme/store.git');
    git(dir, 'remote', 'add', 'fork', 'git@github.com:ada/store.git');
    git(dir, 'remote', 'add', 'gl', 'https://user:glpat-SECRET@gitlab.com/acme/store.git');
    git(dir, 'remote', 'add', 'local', join(dir, '..', 'elsewhere.git'));
    const h = harness([dir]);
    const f = await h.ops.facts(h.K, { root: dir });
    expect(f?.githubRepos).toEqual({ origin: 'https://github.com/acme/store', fork: 'https://github.com/ada/store' });
    const all = JSON.stringify(f);
    for (const leak of ['SECRET', 'gitlab', 'elsewhere', 'git@', 'ada:']) expect(all).not.toContain(leak);
  });
});

describe('Read-only', () => {
  test('every op is refused and the repository is byte-identical', async () => {
    const { a } = remotePair();
    git(a, 'branch', 'feat');
    writeFileSync(join(a, 'x.ts'), 'dirty\n');
    git(a, 'stash', 'push', '-q', '-m', 's');
    writeFileSync(join(a, 'x.ts'), 'dirty again\n');
    const h = harness([a], { settings: { gitActions: 'read-only' } });
    await h.refresh();
    const before = snapshot(a, { gitOnly: ['HEAD', 'index', 'packed-refs', 'config', 'logs/refs/stash'] });
    const stashOid = git(a, 'rev-parse', 'refs/stash').trim();
    const all = await Promise.all([
      h.ops.stage(h.K, { root: a, rels: 'all' }), h.ops.unstage(h.K, { root: a, rels: 'all' }), h.ops.discard(h.K, { root: a, rels: 'all' }),
      h.ops.commit(h.K, { root: a, message: 'm', amend: true, coAuthor: false, noVerify: true }), h.ops.undoCommit(h.K, { root: a, oid: head(a) }),
      h.ops.push(h.K, { root: a }), h.ops.pull(h.K, { root: a, rebase: true, stash: true }), h.ops.sync(h.K, { root: a, rebase: true }),
      h.ops.switchTo(h.K, { root: a, ref: 'refs/heads/feat', carry: 'stash' }), h.ops.branchCreate(h.K, { root: a, name: 'n', switch: true }),
      h.ops.branchRename(h.K, { root: a, ref: 'refs/heads/feat', name: 'g' }), h.ops.branchDelete(h.K, { root: a, ref: 'refs/heads/feat', force: true }),
      h.ops.worktreeAdd(h.K, { root: a, path: join(a, 'wt'), newName: 'wt' }),
      h.ops.stashPush(h.K, { root: a, message: 'm', untracked: true, staged: false }), h.ops.stashApply(h.K, { root: a, index: 0, oid: stashOid, pop: true }),
      h.ops.stashDrop(h.K, { root: a, index: 0, oid: stashOid }),
      h.ops.branchRestore(h.K, { root: a, name: 'gone', oid: head(a) }), h.ops.stashRestore(h.K, { root: a, oid: stashOid, message: 's' })
    ]);
    for (const r of all) expect(r).toEqual({ outcome: 'error', message: 'Git actions are read-only' });
    expect(await h.ops.syncAll(h.K, { skip: [] })).toEqual([]);
    expect(await h.ops.message(h.K, { root: a }, () => {})).toEqual({ error: 'Git actions are read-only' });
    expect(snapshot(a, { gitOnly: ['HEAD', 'index', 'packed-refs', 'config', 'logs/refs/stash'] })).toEqual(before);
    expect(h.events).toEqual([]);
  });
});

// ── more write guards ───────────────────────────────────────────────────────────────────────────────────────────────

const FOREIGN = "A rebase is in progress that Atelier didn't start: finish it in the terminal";

describe('a pull never aborts a rebase it did not start', () => {
  /** main has a local commit; `side` (off main~1) conflicts with it: the rebase a session runs. */
  const twoSides = () => {
    const { a } = remotePair();
    commit(a, 'feat: local', { 'x.ts': 'LOCAL\ntwo\nthree\n' });
    git(a, 'branch', 'side', 'HEAD~1');
    git(a, 'checkout', '-q', 'side');
    commit(a, 'feat: side', { 'x.ts': 'SIDE\ntwo\nthree\n' });
    git(a, 'checkout', '-q', 'main');
    return a;
  };
  /** While our pull runs, a session rebases main onto side, stops on the conflict and resolves x.ts by hand. */
  const sessionRebase = (a: string, before?: () => void) => {
    try { before?.(); git(a, 'rebase', 'side'); } catch { /* stops on the conflict */ }
    writeFileSync(join(a, 'x.ts'), 'RESOLVED BY THE SESSION\ntwo\nthree\n');
  };

  test('a session\'s rebase started during the pull (git then refuses the pull): its resolution and its rebase are left alone', async () => {
    const a = twoSides();
    let fired = false;
    const run: GitOpsDeps['run'] = async (root, inv, o) => {
      if (!fired && inv.args[0] === 'pull') { fired = true; sessionRebase(a); }
      return runWrite(root, inv, o);
    };
    const h = harness([a], { run });
    expect(await h.ops.pull(h.K, { root: a, rebase: true })).toMatchObject({ outcome: 'state', message: FOREIGN });
    expect(readFileSync(join(a, 'x.ts'), 'utf8')).toBe('RESOLVED BY THE SESSION\ntwo\nthree\n');
    expect(existsSync(join(a, '.git', 'rebase-merge'))).toBe(true);
    git(a, 'rebase', '--abort');
  });

  test('a rebase started from another HEAD (a session committed first) while the pull failed otherwise: left alone', async () => {
    const a = twoSides();
    const run: GitOpsDeps['run'] = async (_root, inv) => {
      if (inv.args[0] !== 'pull') throw new Error(`unexpected ${inv.args.join(' ')}`);
      sessionRebase(a, () => commit(a, 'feat: the session\'s', { 'keep.ts': 'session\n' }));
      return rawRun({ code: 128, output: "fatal: unable to access 'https://h.example/x/': Could not resolve host: h.example\n" });
    };
    const h = harness([a], { run });
    expect(await h.ops.pull(h.K, { root: a, rebase: true })).toMatchObject({ outcome: 'state', message: FOREIGN });
    expect(readFileSync(join(a, 'x.ts'), 'utf8')).toBe('RESOLVED BY THE SESSION\ntwo\nthree\n');
    expect(existsSync(join(a, '.git', 'rebase-merge'))).toBe(true);
    git(a, 'rebase', '--abort');
  });
});

describe('discard of a pure `git mv` edited afterwards', () => {
  test('RM with the index holding HEAD\'s blob: discarded (the edit in the Trash, the old path back, the new one gone)', async () => {
    const dir = repo({ 'a.ts': 'a\n', 'old.ts': 'o1\no2\no3\n' });
    git(dir, 'mv', 'old.ts', 'new.ts');
    writeFileSync(join(dir, 'new.ts'), 'o1\no2\no3\nedited\n');
    const h = harness([dir]);
    await h.refresh();
    const before = new Set(readdirSync(trash));
    expect(await h.ops.discard(h.K, { root: dir, rels: ['new.ts'] })).toMatchObject({ outcome: 'ok', message: '1 file moved to the Trash' });
    expect(readdirSync(trash).filter((n) => !before.has(n)).map((n) => readFileSync(join(trash, n), 'utf8'))).toEqual(['o1\no2\no3\nedited\n']);
    expect(readFileSync(join(dir, 'old.ts'), 'utf8')).toBe('o1\no2\no3\n');
    expect(existsSync(join(dir, 'new.ts'))).toBe(false);
    expect(git(dir, 'status', '--porcelain', '--untracked-files=all')).toBe('');
  });

  test('a rename with staged edits, then edited again: kept, the index untouched', async () => {
    const dir = repo({ 'a.ts': 'a\n', 'old.ts': 'o1\no2\no3\n' });
    git(dir, 'mv', 'old.ts', 'new.ts');
    writeFileSync(join(dir, 'new.ts'), 'o1\no2\no3\nSTAGED\n');
    git(dir, 'add', 'new.ts');
    writeFileSync(join(dir, 'new.ts'), 'o1\no2\no3\nSTAGED\nmore\n');
    const index = git(dir, 'ls-files', '--stage');
    const h = harness([dir]);
    await h.refresh();
    expect(await h.ops.discard(h.K, { root: dir, rels: ['new.ts'] })).toMatchObject({ outcome: 'state', files: ['new.ts'] });
    expect(git(dir, 'ls-files', '--stage')).toBe(index);
    expect(readFileSync(join(dir, 'new.ts'), 'utf8')).toBe('o1\no2\no3\nSTAGED\nmore\n');
  });
});

describe('more write guards on real git', () => {
  test('a post-commit printing 1.3 MB: ok with its sha', async () => {
    const dir = repo();
    const p = join(dir, '.git', 'hooks', 'post-commit');
    writeFileSync(p, '#!/bin/sh\nyes "post-commit output line" | head -c 1300000\necho\n');
    chmodSync(p, 0o755);
    writeFileSync(join(dir, 'a.ts'), 'a2\n');
    git(dir, 'add', 'a.ts');
    const h = harness([dir]);
    const r = await h.ops.commit(h.K, { root: dir, message: 'feat: x', amend: false, coAuthor: false, noVerify: false });
    expect(r).toMatchObject({ outcome: 'ok', sha: head(dir) });
    expect(r.output).toContain('… output past 1 MB dropped');
  });

  test('drop: a session\'s stash pushed in between is never lost: git dropped it, Atelier stores it back at once, stale', async () => {
    const dir = repo();
    writeFileSync(join(dir, 'a.ts'), 'mine\n');
    git(dir, 'stash', 'push', '-q', '-m', 'mine');
    const mine = git(dir, 'rev-parse', 'refs/stash').trim();
    const run: GitOpsDeps['run'] = async (root, inv, o) => {
      if (inv.args[0] === 'stash' && inv.args[1] === 'drop') { writeFileSync(join(dir, 'keep.ts'), 'session\n'); git(dir, 'stash', 'push', '-q', '-m', 'session'); }
      return runWrite(root, inv, o);
    };
    const h = harness([dir], { run });
    expect(await h.ops.stashDrop(h.K, { root: dir, index: 0, oid: mine })).toMatchObject({ outcome: 'stale' });
    expect(git(dir, 'stash', 'list', '--format=%gs').trim().split('\n').sort()).toEqual(['On main: mine', 'On main: session']);
  });

  test('remoteCommits: the total the upstream has that HEAD lacks, past the listed ones', async () => {
    const { a, b } = remotePair();
    for (let i = 0; i < 25; i++) commit(b, `feat: remote ${i}`, { 'x.ts': `v${i}\n` });
    git(b, 'push', '-q');
    commit(a, 'feat: local', { 'keep.ts': 'local\n' });
    const h = harness([a]);
    const r = await h.ops.remoteCommits(h.K, { root: a, n: 3 });
    expect(r.commits).toHaveLength(3);
    expect(r.total).toBe(25);
    expect(r.remoteOid).toBe(git(b, 'rev-parse', 'HEAD').trim());
  });
});
