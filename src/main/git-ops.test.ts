// GitOps with fakes: every refusal happens in main before any git process, and the
// ops that pass run only builder-made invocations. Real git is in tests/integration/git-ops.test.ts.
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, toOut } from './cpath';
import { describe, expect, test, vi } from 'vitest';
import { IPC } from '@shared/api';
import type { Attribution } from '@shared/attribution';
import type { FileChange, RepoStatus } from '@shared/git';
import type { GitOpEvent, GitOpResult, RepoFacts } from '@shared/git-write';
import type { TerminalInfo } from '@shared/protocol';
import type { ScmRef, ScmRefs, ScmRepoEntry, ScmStash } from '@shared/scm';
import { GitOps, type GitOpsDeps, type GitOpsSettings, type GitReads, READ_ONLY_MESSAGE, quitAnyway, quitPrompt } from './git-ops';
import type { Invocation, RawRun } from './git/write';
import { WriteQueue } from './git/write-queue';
import { useMachinePlatform, posixTest } from '../../tests/support/platform';

// Real files with native paths: the app's platform switch reads the machine's (win32 on Windows).
useMachinePlatform();

const O1 = '1'.repeat(40); const O2 = '2'.repeat(40); const O3 = '3'.repeat(40);

const facts = (o: Partial<RepoFacts> = {}): RepoFacts => ({
  identity: true, state: null, detached: false, branch: 'main', head: O1, upstream: 'origin/main', headPushed: false, headIsMerge: false,
  headHasParent: true, headMessage: 'feat: x', hooks: { preCommit: false, commitMsg: false, prePush: false }, gpgProgram: null, signs: false,
  gitVersion: [2, 54, 0], ...o
});

const ref = (name: string, o: Partial<ScmRef> = {}): ScmRef => {
  const kind = name.startsWith('refs/heads/') ? 'head' : name.startsWith('refs/remotes/') ? 'remote' : 'tag';
  const short = name.replace(/^refs\/(?:heads|remotes|tags)\//, '');
  return { name, short, kind, oid: O2, upstream: null, ahead: 0, behind: 0, gone: false, current: false, date: 0, ...(kind === 'remote' ? { remote: short.split('/')[0] } : {}), ...o };
};

const change = (rel: string, o: Partial<FileChange> = {}): FileChange => ({ path: `/p/${rel}`, rel, kind: 'M', stage: 'none', added: 1, removed: 0, ...o });

const raw = (o: Partial<RawRun> = {}): RawRun => ({ code: 0, output: '', truncated: false, cancelled: false, timedOut: false, traced: true, ...o });

interface World {
  ops: GitOps; runs: string[][]; stdins: (string | undefined)[]; events: GitOpEvent[]; statusAsked: string[]; kept: { root: string; paths: string[]; released: boolean }[];
  trashed: string[]; deps: GitOpsDeps; settings: GitOpsSettings; entryFor: ReturnType<typeof vi.fn>;
}

function world(o: {
  root?: string; project?: string; changes?: FileChange[]; refs?: ScmRef[]; head?: Partial<ScmRefs['head']>; remotes?: string[];
  reads?: Partial<GitReads>; run?: (inv: Invocation) => RawRun | Promise<RawRun>; trash?: (p: string) => { ok: true } | { error: string };
  sessions?: { attributions: Attribution[]; terminals: TerminalInfo[] };
} = {}): World {
  const root = o.root ?? '/p';
  const project = o.project ?? '/p';
  const settings: GitOpsSettings = { gitActions: 'on', commitMessages: 'haiku', commitUsePrompts: true, commitLanguage: 'commits' };
  const status: RepoStatus = { root, name: 'acme-store', branch: 'main', detached: false, ahead: 0, behind: 0, changes: o.changes ?? [], oid: O1, checkedAt: 1, truncated: 0 };
  const entry: ScmRepoEntry = { root, rel: '', name: 'acme-store', worktreeOf: null, nestedIn: null, common: `${root}/.git`, status: null };
  const runs: string[][] = []; const stdins: (string | undefined)[] = []; const events: GitOpEvent[] = []; const statusAsked: string[] = []; const trashed: string[] = [];
  const kept: World['kept'] = [];
  const entryFor = vi.fn(async (_key: string, r: string) => (r === root ? entry : null));
  const refs: ScmRefs = {
    root, head: { branch: 'main', oid: O1, detached: false, ...o.head }, refs: o.refs ?? [ref('refs/heads/main', { current: true, oid: O1 })], defaultBranch: null,
    shallow: false, fetchedAt: null, remotes: o.remotes ?? ['origin'], hasRemote: true, emptyTree: ''
  };
  const deps: GitOpsDeps = {
    settings: () => settings,
    git: {
      info: (key) => (key === 'key' ? { root: project, status: new Map([[root, status]]) } : null),
      keep: (r, paths) => { const k = { root: r, paths, released: false }; kept.push(k); return () => { k.released = true; }; },
      requestStatus: (r) => { statusAsked.push(r); }
    },
    scm: {
      entryFor, entries: async () => [entry], refs: async () => refs, refsMoved: () => {}, fetchNow: async () => ({ state: null, outcome: 'ok' })
    },
    queue: new WriteQueue(),
    sessions: () => o.sessions ?? { attributions: [], terminals: [] },
    accountDir: () => undefined,
    trash: async (_r, p) => { const res = o.trash?.(p) ?? { ok: true as const }; if ('ok' in res) trashed.push(p); return res; },
    userEnv: async () => ({ env: { PATH: '/usr/bin:/bin' }, captured: true }),
    claude: () => '/fake/claude',
    emit: (_r, e) => { events.push(e); },
    retryDelaysMs: [1, 1, 1],
    reads: {
      facts: async () => facts(), head: async () => O1, status: async () => o.changes ?? [], stashes: async () => [], stashFiles: async () => [],
      worktrees: async () => [{ path: root, head: O1, branch: 'main', detached: false, bare: false, locked: false, prunable: false }],
      upstream: async () => ({ remote: 'origin', ref: 'refs/heads/main', oid: O3 }), refName: async () => true, ignored: async () => false,
      pushTarget: async () => ({ remote: 'origin', ref: '', upstreamRemote: 'origin', upstreamRef: 'refs/heads/main' }),
      branchNames: async () => refs.refs.filter((r) => r.kind === 'head').map((r) => r.short),
      commitFiles: async () => ({ parents: 1, files: ['a.ts'] }), aheadBehind: async () => ({ ahead: 0, behind: 0 }), unmerged: async () => 3,
      incoming: async () => [], remoteCommits: async () => [], remoteCount: async () => 0, indexLock: async () => null, githubRepo: async () => null,
      // A rebase in progress is the pull's own: started on facts' HEAD, on main.
      rebaseInfo: async () => ({ origHead: O1, headName: 'refs/heads/main' }),
      // HEAD after a commit: on O1 (facts' head before it), with the message the tests send.
      commitMeta: async () => ({ parents: [O1], message: 'feat: x\n\nCo-Authored-By: Claude <noreply@anthropic.com>\n' }), ...o.reads
    },
    run: async (_r, inv) => { runs.push([...inv.args]); stdins.push(inv.stdin); return o.run ? o.run(inv) : raw(); }
  };
  return { ops: new GitOps(deps), runs, stdins, events, statusAsked, kept, trashed, deps, settings, entryFor };
}

const K = 'key';

describe('Read-only refuses every op in main, before anything else', () => {
  test('each write answers "Git actions are read-only" without looking up the root or running git', async () => {
    const w = world({ changes: [change('a.ts')] });
    w.settings.gitActions = 'read-only';
    const results = await Promise.all([
      w.ops.stage(K, { root: '/p', rels: ['a.ts'] }), w.ops.unstage(K, { root: '/p', rels: 'all' }), w.ops.discard(K, { root: '/p', rels: ['a.ts'] }),
      w.ops.commit(K, { root: '/p', message: 'm', amend: false, coAuthor: false, noVerify: false }), w.ops.undoCommit(K, { root: '/p', oid: O1 }),
      w.ops.push(K, { root: '/p' }), w.ops.pull(K, { root: '/p', rebase: false }), w.ops.sync(K, { root: '/p', rebase: false }),
      w.ops.switchTo(K, { root: '/p', ref: 'refs/heads/main', carry: 'none' }), w.ops.branchCreate(K, { root: '/p', name: 'x', switch: true }),
      w.ops.branchRename(K, { root: '/p', ref: 'refs/heads/main', name: 'y' }), w.ops.branchDelete(K, { root: '/p', ref: 'refs/heads/x', force: true }),
      w.ops.branchRestore(K, { root: '/p', name: 'x', oid: O1 }), w.ops.worktreeAdd(K, { root: '/p', path: '/p/w', newName: 'w' }),
      w.ops.stashPush(K, { root: '/p', message: 'm', untracked: true, staged: false }), w.ops.stashApply(K, { root: '/p', index: 0, oid: O1, pop: true }),
      w.ops.stashDrop(K, { root: '/p', index: 0, oid: O1 }), w.ops.stashRestore(K, { root: '/p', oid: O1, message: 'm' })
    ]);
    for (const r of results) expect(r).toEqual({ outcome: 'error', message: READ_ONLY_MESSAGE });
    expect(await w.ops.syncAll(K)).toEqual([]);
    expect(await w.ops.checkBranchName(K, { root: '/p', name: 'x' })).toBe(false);
    expect(await w.ops.facts(K, { root: '/p' })).toBeNull();
    expect(await w.ops.remoteCommits(K, { root: '/p', n: 3 })).toEqual({ commits: [], remoteOid: null, total: 0 });
    expect(await w.ops.syncAll(K, { skip: ['/p'] })).toEqual([]);
    expect(await w.ops.message(K, { root: '/p' }, () => {})).toEqual({ error: READ_ONLY_MESSAGE });
    expect(w.entryFor).not.toHaveBeenCalled();
    expect(w.runs).toEqual([]);
    expect(w.events).toEqual([]);
  });
});

describe('roots, paths and refs come from main’s own reads', () => {
  test('a root the project did not list (or a relative one) is refused', async () => {
    const w = world();
    expect(await w.ops.stage(K, { root: '/elsewhere', rels: 'all' })).toMatchObject({ outcome: 'error', message: 'Unknown repository' });
    expect(await w.ops.stage(K, { root: 'p', rels: 'all' })).toMatchObject({ outcome: 'error' });
    expect(await w.ops.commit('other-project', { root: '/x', message: 'm', amend: false, coAuthor: false, noVerify: false })).toMatchObject({ outcome: 'error' });
    expect(w.runs).toEqual([]);
  });

  test('a path not in the root’s last status is refused (stale); listed ones and both sides of a rename run', async () => {
    const w = world({ changes: [change('a.ts'), change('new.ts', { kind: 'R', origRel: 'old.ts' })] });
    expect(await w.ops.stage(K, { root: '/p', rels: ['a.ts', 'b.ts'] })).toMatchObject({ outcome: 'stale' });
    expect(await w.ops.discard(K, { root: '/p', rels: ['../etc/passwd'] })).toMatchObject({ outcome: 'stale' });
    expect(w.runs).toEqual([]);
    expect(await w.ops.stage(K, { root: '/p', rels: ['a.ts', 'old.ts', 'new.ts'] })).toMatchObject({ outcome: 'ok' });
    expect(w.runs).toEqual([['add', '--all', '--pathspec-from-file=-', '--pathspec-file-nul']]);
    expect(w.statusAsked).toContain('/p');
  });

  test('unmerged files and submodules are never staged: listed ones refused, "all" refused while a conflict exists', async () => {
    const changes = [change('a.ts'), change('c.ts', { kind: 'U' }), change('sub', { submodule: true })];
    const w = world({ changes });
    expect(await w.ops.stage(K, { root: '/p', rels: ['a.ts', 'c.ts'] })).toMatchObject({ outcome: 'state', message: 'Resolve the conflict first' });
    expect(await w.ops.stage(K, { root: '/p', rels: ['sub'] })).toMatchObject({ outcome: 'state' });
    // 'all' reads the status now (the last one may be truncated or old): an unmerged entry anywhere refuses it.
    const fresh = world({ changes: [change('a.ts')], reads: { status: async () => [change('a.ts'), change('far/away.ts', { kind: 'U' })] } });
    expect(await fresh.ops.stage(K, { root: '/p', rels: 'all' })).toMatchObject({ outcome: 'state', message: 'Resolve the conflicts first' });
    expect(w.runs).toEqual([]);
    expect(fresh.runs).toEqual([]);
    expect(await w.ops.stage(K, { root: '/p', rels: ['a.ts'] })).toMatchObject({ outcome: 'ok' });
    const clean = world({ changes: [change('a.ts')] });
    expect(await clean.ops.stage(K, { root: '/p', rels: 'all' })).toMatchObject({ outcome: 'ok' });
  });

  test('Stage All stages explicit paths from a fresh uncapped status: never `.`, nested repos or submodules; capped at 100 000', async () => {
    const all = [change('a.ts'), change('new.ts', { kind: 'R', origRel: 'old.ts' }), change('u.ts', { kind: '?' }), change('sub', { submodule: true }),
      change('nested/', { kind: '?' }), change('plugins/pay/x.ts', { kind: '?' }), change('d.ts', { kind: 'D' })];
    const w = world({ changes: [change('a.ts')], reads: { status: async () => all } });
    w.deps.git.info = () => ({ root: '/p', repos: ['/p', '/p/plugins/pay'], status: new Map([['/p', { root: '/p', name: 'n', branch: 'main', detached: false, ahead: 0, behind: 0, changes: [], oid: O1, checkedAt: 1, truncated: 5000 }]]) });
    expect(await w.ops.stage(K, { root: '/p', rels: 'all' })).toMatchObject({ outcome: 'ok' });
    expect(w.runs).toEqual([['add', '--all', '--pathspec-from-file=-', '--pathspec-file-nul']]);
    expect(w.stdins).toEqual(['a.ts\0old.ts\0new.ts\0u.ts\0d.ts']);
    const nothing = world({ reads: { status: async () => [change('sub', { submodule: true }), change('nested/', { kind: '?' })] } });
    expect(await nothing.ops.stage(K, { root: '/p', rels: 'all' })).toMatchObject({ outcome: 'nothing' });
    expect(nothing.runs).toEqual([]);
    const many = Array.from({ length: 100_001 }, (_, i) => change(`f${i}`, { kind: '?' }));
    const big = world({ reads: { status: async () => many } });
    expect(await big.ops.stage(K, { root: '/p', rels: 'all' })).toMatchObject({ outcome: 'error', message: 'Too many changes to stage at once (100001): stage them in smaller groups' });
    expect(big.runs).toEqual([]);
  });

  test('switching away from a detached HEAD with commits on no branch: done, and the warning names the commit to keep', async () => {
    const left = 'Warning: you are leaving 2 commits behind, not connected to\nany of your branches:\n\n  1a2b3c4 more\n  9f8e7d6 wip\n\n'
      + 'If you want to keep them by creating a new branch, this may be a good time\nto do so with:\n\n git branch <new-branch-name> 1a2b3c4\n\nSwitched to branch \'main\'\n';
    const w = world({ head: { branch: null, detached: true, oid: O2 }, refs: [ref('refs/heads/main', { oid: O1 })], run: () => raw({ output: left }) });
    const r = await w.ops.switchTo(K, { root: '/p', ref: 'refs/heads/main', carry: 'none' });
    expect(r).toMatchObject({ outcome: 'ok', warning: '2 commits were left on no branch (1a2b3c4): make a branch from it in a terminal to keep them' });
  });

  test('pull: done all the same when only a hook after it failed or ran out of time (HEAD moved, nothing in progress)', async () => {
    let pulled = false;
    const w = world({
      reads: { facts: async () => facts(pulled ? { head: O2 } : {}) },
      run: (inv) => {
        if (inv.args[0] !== 'pull') return raw();
        pulled = true;
        return raw({ code: null, timedOut: true, hookRunning: 'post-merge' });
      }
    });
    const r = await w.ops.pull(K, { root: '/p', rebase: false });
    expect(r).toMatchObject({ outcome: 'ok', warning: 'The post-merge hook did not finish in time.' });
    // HEAD where it was: the pull's own failure.
    const nothing = world({ run: (inv) => (inv.args[0] === 'pull' ? raw({ code: null, timedOut: true }) : raw()) });
    expect(await nothing.ops.pull(K, { root: '/p', rebase: false })).toMatchObject({ outcome: 'network' });
    // HEAD moved by a session's commit meanwhile, the pull failing on its own (network, diverged): never "done".
    let moved = false;
    const session = world({
      reads: { facts: async () => facts(moved ? { head: O2 } : {}) },
      run: (inv) => { if (inv.args[0] !== 'pull') return raw(); moved = true; return raw({ code: 128, output: 'fatal: Not possible to fast-forward, aborting.\n' }); }
    });
    expect(await session.ops.pull(K, { root: '/p', rebase: false })).toMatchObject({ outcome: 'error' });
  });

  test('stage: a listed file gone before the op (git refuses the whole list) — the rest is staged; all gone: nothing', async () => {
    let first = true;
    const w = world({
      changes: [change('a.ts'), change('tmp.mjs', { kind: '?' })],
      reads: { status: async () => [change('a.ts')] },
      run: (inv) => {
        if (inv.op === 'stage' && first) { first = false; return raw({ code: 128, output: "fatal: pathspec 'tmp.mjs' did not match any files\n" }); }
        return raw();
      }
    });
    expect(await w.ops.stage(K, { root: '/p', rels: ['a.ts', 'tmp.mjs'] })).toMatchObject({ outcome: 'ok' });
    expect(w.stdins.at(-1)).toBe('a.ts');
    first = true;
    expect(await w.ops.stage(K, { root: '/p', rels: ['tmp.mjs'] })).toMatchObject({ outcome: 'nothing', message: 'Those files are gone: nothing to stage' });
  });

  // A checkbox shows its click at once (renderer stage-intents.ts) until a status read that started once git was done:
  // `at` is that moment, taken before the fresh status is asked for, so the read that follows always counts.
  test('stage and unstage answer when git was done, before the status that shows it is asked for', async () => {
    const w = world({ changes: [change('a.ts')] });
    let clock = 100;
    w.deps.now = () => clock;
    const asked: number[] = [];
    w.deps.git.requestStatus = () => { asked.push(clock); clock += 50; };
    w.deps.run = async () => { clock = 200; return raw(); };
    expect(await w.ops.stage(K, { root: '/p', rels: ['a.ts'] })).toEqual({ outcome: 'ok', at: 200 });
    expect(asked).toEqual([200]);
    w.deps.run = async () => { clock = 400; return raw(); };
    expect(await w.ops.unstage(K, { root: '/p', rels: ['a.ts'] })).toMatchObject({ outcome: 'ok', at: 400 });
    // The other ops answer as before.
    w.deps.run = async () => raw();
    expect(await w.ops.discard(K, { root: '/p', rels: ['a.ts'] })).not.toHaveProperty('at');
  });

  // The Sync button shows a pull, push or sync at once (renderer git/sync-intents.ts) until a status read from after
  // it: the same `at`, so an older read never brings the old counts back.
  test('pull, push and sync answer when git was done, before the status that shows it is asked for', async () => {
    for (const run of [
      (w: ReturnType<typeof world>) => w.ops.pull(K, { root: '/p', rebase: false }),
      (w: ReturnType<typeof world>) => w.ops.push(K, { root: '/p' }),
      (w: ReturnType<typeof world>) => w.ops.sync(K, { root: '/p', rebase: false })
    ]) {
      // One commit to pull: sync runs git too (in sync, it answers without running anything).
      const w = world({ reads: { aheadBehind: async () => ({ ahead: 0, behind: 1 }) } });
      let clock = 100;
      w.deps.now = () => clock;
      const asked: number[] = [];
      w.deps.git.requestStatus = () => { asked.push(clock); clock += 50; };
      w.deps.run = async () => { clock = 300; return raw(); };
      const r = await run(w);
      expect(r).toMatchObject({ outcome: 'ok', at: 300 });
      expect(asked[0]).toBe(300);
    }
  });

  // What the Sync button shows from the op's answer, in every window: only what git now has for sure.
  test('pull, push and sync say what they left: nothing to pull, nothing to push to the upstream, the published upstream', async () => {
    const left = async (w: ReturnType<typeof world>, run: (w: ReturnType<typeof world>) => Promise<GitOpResult>) => (await run(w)).left;
    expect(await left(world(), (w) => w.ops.pull(K, { root: '/p', rebase: false }))).toEqual({ behind: 0 });
    expect(await left(world(), (w) => w.ops.push(K, { root: '/p' }))).toEqual({ ahead: 0 });
    // Pushed to a fork while the upstream is origin's: what is ahead of the upstream is still ahead.
    const fork = world({ remotes: ['origin', 'fork'], reads: { pushTarget: async () => ({ remote: 'fork', ref: '', upstreamRemote: 'origin', upstreamRef: 'refs/heads/main' }) } });
    expect(await left(fork, (w) => w.ops.push(K, { root: '/p' }))).toBeUndefined();
    expect(await left(world(), (w) => w.ops.push(K, { root: '/p', publish: { remote: 'origin' } }))).toEqual({ ahead: 0, behind: 0, published: 'origin' });
    const behind = world({ reads: { aheadBehind: async () => ({ ahead: 0, behind: 1 }) } });
    expect(await left(behind, (w) => w.ops.sync(K, { root: '/p', rebase: false }))).toEqual({ ahead: 0, behind: 0 });
    expect(await left(world(), (w) => w.ops.sync(K, { root: '/p', rebase: false }))).toEqual({ ahead: 0, behind: 0 });
    // A failure leaves nothing known.
    const down = world();
    down.deps.run = async () => raw({ code: 128, output: 'fatal: unable to access: Could not resolve host' });
    expect(await left(down, (w) => w.ops.pull(K, { root: '/p', rebase: false }))).toBeUndefined();
  });

  test('an unknown or vanished ref is refused (switch, rename, delete, create from)', async () => {
    const w = world();
    expect(await w.ops.switchTo(K, { root: '/p', ref: 'refs/heads/gone', carry: 'none' })).toMatchObject({ outcome: 'stale' });
    expect(await w.ops.branchRename(K, { root: '/p', ref: 'refs/heads/gone', name: 'x' })).toMatchObject({ outcome: 'stale' });
    expect(await w.ops.branchDelete(K, { root: '/p', ref: 'refs/heads/gone', force: true })).toMatchObject({ outcome: 'stale' });
    expect(await w.ops.branchCreate(K, { root: '/p', name: 'x', from: 'refs/heads/gone', switch: false })).toMatchObject({ outcome: 'stale' });
    expect(w.runs).toEqual([]);
  });

  test('new names pass git’s rules and check-ref-format, never a leading dash', async () => {
    const refName = vi.fn(async () => false);
    const w = world({ reads: { refName } });
    expect(await w.ops.branchCreate(K, { root: '/p', name: 'ok-name', switch: true })).toMatchObject({ outcome: 'error', message: 'Not a valid branch name' });
    expect(refName).toHaveBeenCalledWith('/p', 'ok-name');
    const w2 = world();
    for (const name of ['-D', '--force', 'a..b', 'x.lock', 'HEAD', 'a b']) {
      expect(await w2.ops.branchCreate(K, { root: '/p', name, switch: true })).toMatchObject({ outcome: 'error' });
      expect(await w2.ops.checkBranchName(K, { root: '/p', name })).toBe(false);
    }
    expect(w.runs).toEqual([]);
    expect(w2.runs).toEqual([]);
  });
});

describe('branches', () => {
  const refs = [ref('refs/heads/main', { current: true, oid: O1 }), ref('refs/heads/feat/x', { oid: O2 }), ref('refs/heads/other', { oid: O3 }),
    ref('refs/remotes/origin/main', { oid: O1 }), ref('refs/remotes/origin/new', { oid: O2 }), ref('refs/tags/v1')];
  const worktrees = async () => [
    { path: '/p', head: O1, branch: 'main', detached: false, bare: false, locked: false, prunable: false },
    { path: '/p/.claude/worktrees/o', head: O3, branch: 'other', detached: false, bare: false, locked: false, prunable: false }
  ];

  test('delete never the current branch nor one checked out in a worktree; -d refused → unmerged count', async () => {
    const w = world({ refs, reads: { worktrees }, run: (inv) => (inv.args.includes('-d') ? raw({ code: 1, output: "error: the branch 'feat/x' is not fully merged.\n" }) : raw()) });
    expect(await w.ops.branchDelete(K, { root: '/p', ref: 'refs/heads/main', force: true })).toMatchObject({ outcome: 'state' });
    expect(await w.ops.branchDelete(K, { root: '/p', ref: 'refs/heads/other', force: true })).toMatchObject({ outcome: 'state' });
    expect(await w.ops.branchDelete(K, { root: '/p', ref: 'refs/tags/v1', force: true })).toMatchObject({ outcome: 'stale' });
    expect(w.runs).toEqual([]);
    expect(await w.ops.branchDelete(K, { root: '/p', ref: 'refs/heads/feat/x', force: false })).toMatchObject({ outcome: 'conflict', message: "feat/x has 3 commits that aren't merged anywhere" });
    expect(await w.ops.branchDelete(K, { root: '/p', ref: 'refs/heads/feat/x', force: true })).toMatchObject({ outcome: 'ok', branch: { name: 'feat/x', oid: O2 } });
    expect(w.runs).toEqual([['branch', '-d', 'feat/x'], ['branch', '-D', 'feat/x']]);
    // The current branch, even when the worktree list doesn't say so.
    const bare = world({ refs, reads: { worktrees: async () => [] } });
    expect(await bare.ops.branchDelete(K, { root: '/p', ref: 'refs/heads/main', force: true })).toMatchObject({ outcome: 'state' });
    expect(bare.runs).toEqual([]);
    // One commit reads in the singular.
    const one = world({ refs, reads: { worktrees, unmerged: async () => 1 }, run: (inv) => (inv.args.includes('-d') ? raw({ code: 1, output: "error: the branch 'feat/x' is not fully merged.\n" }) : raw()) });
    expect(await one.ops.branchDelete(K, { root: '/p', ref: 'refs/heads/feat/x', force: false })).toMatchObject({ outcome: 'conflict', message: "feat/x has 1 commit that isn't merged anywhere" });
    // Merged into another branch only (develop, on main): none are unmerged anywhere, but -d still refuses.
    const elsewhere = world({ refs, reads: { worktrees, unmerged: async () => 0 }, run: (inv) => (inv.args.includes('-d') ? raw({ code: 1, output: "error: the branch 'feat/x' is not fully merged.\n" }) : raw()) });
    expect(await elsewhere.ops.branchDelete(K, { root: '/p', ref: 'refs/heads/feat/x', force: false })).toMatchObject({ outcome: 'conflict', message: "feat/x isn't merged into main" });
    // With an upstream, -d checks that instead.
    const tracked = world({ refs: refs.map((r) => (r.short === 'feat/x' ? { ...r, upstream: 'refs/remotes/origin/feat/x' } : r)), reads: { worktrees, unmerged: async () => 0 },
      run: (inv) => (inv.args.includes('-d') ? raw({ code: 1, output: "error: the branch 'feat/x' is not fully merged.\n" }) : raw()) });
    expect(await tracked.ops.branchDelete(K, { root: '/p', ref: 'refs/heads/feat/x', force: false })).toMatchObject({ message: "feat/x isn't merged into origin/feat/x" });
  });

  test('a new branch tracks nothing, unless it is the local copy of the same-named remote branch', async () => {
    const remoteRefs = [...refs, ref('refs/remotes/origin/feat/y', { oid: O2 })];
    const w = world({ refs: remoteRefs, reads: { worktrees } });
    expect(await w.ops.branchCreate(K, { root: '/p', name: 'feat/y', from: 'refs/remotes/origin/main', switch: true })).toMatchObject({ outcome: 'ok' });
    expect(await w.ops.branchCreate(K, { root: '/p', name: 'feat/y', from: 'refs/remotes/origin/feat/y', switch: false })).toMatchObject({ outcome: 'ok' });
    expect(await w.ops.branchCreate(K, { root: '/p', name: 'feat/z', from: 'refs/heads/main', switch: false })).toMatchObject({ outcome: 'ok' });
    expect(w.runs).toEqual([
      ['switch', '--no-track', '--create', 'feat/y', 'refs/remotes/origin/main'],
      ['branch', '--track', 'feat/y', 'refs/remotes/origin/feat/y'],
      ['branch', '--no-track', 'feat/z', 'refs/heads/main']
    ]);
  });

  test('a branch of a remote named with a slash (team/fork) is never tracked from here: the terminal', async () => {
    const w = world({ refs: [...refs, ref('refs/remotes/team/fork/main', { remote: 'team/fork' })], reads: { worktrees } });
    expect(await w.ops.switchTo(K, { root: '/p', ref: 'refs/remotes/team/fork/main', carry: 'none' })).toMatchObject({ outcome: 'state', message: "Atelier can't track a branch of the remote team/fork: switch to it from the terminal" });
    expect(w.runs).toEqual([]);
  });

  test('a new name clashing with a branch’s folder (feat and feat/x) is refused before git, both ways', async () => {
    const w = world({ refs, reads: { worktrees } });
    expect(await w.ops.branchCreate(K, { root: '/p', name: 'feat/x/y', switch: true })).toMatchObject({ outcome: 'error', message: "A branch named feat/x exists, so feat/x/y can't be made: pick another name" });
    expect(await w.ops.branchCreate(K, { root: '/p', name: 'feat', switch: true })).toMatchObject({ outcome: 'error', message: "A branch named feat/x exists, so feat can't be made: pick another name" });
    expect(await w.ops.branchRename(K, { root: '/p', ref: 'refs/heads/feat/x', name: 'main/x' })).toMatchObject({ outcome: 'error', message: "A branch named main exists, so main/x can't be made: pick another name" });
    expect(await w.ops.checkBranchName(K, { root: '/p', name: 'feat/x/y' })).toBe(false);
    expect(await w.ops.checkBranchName(K, { root: '/p', name: 'feature' })).toBe(true);
    // A name taken already (a session made it a moment ago): refused before git, never read as done by a failing hook.
    expect(await w.ops.branchCreate(K, { root: '/p', name: 'other', switch: true })).toMatchObject({ outcome: 'error', message: 'A branch named other already exists' });
    expect(await w.ops.checkBranchName(K, { root: '/p', name: 'other' })).toBe(false);
    // A rename into its own folder (feat/x → feat/x/y): the old name goes first, so it is fine, as the op says too.
    expect(await w.ops.checkBranchName(K, { root: '/p', name: 'feat/x/y', same: 'feat/x' })).toBe(true);
    expect(w.runs).toEqual([]);
    expect(await w.ops.branchRename(K, { root: '/p', ref: 'refs/heads/feat/x', name: 'feat/x/y' })).toMatchObject({ outcome: 'ok' });
  });

  test('restore only a branch deleted here, with the oid it had', async () => {
    // The local branches once feat/x is deleted (the fake refs stay as listed).
    const w = world({ refs, reads: { worktrees, branchNames: async () => ['main', 'other'] } });
    expect(await w.ops.branchRestore(K, { root: '/p', name: 'feat/x', oid: O2 })).toMatchObject({ outcome: 'stale' });
    await w.ops.branchDelete(K, { root: '/p', ref: 'refs/heads/feat/x', force: true });
    expect(await w.ops.branchRestore(K, { root: '/p', name: 'feat/x', oid: O1 })).toMatchObject({ outcome: 'stale' });
    expect(await w.ops.branchRestore(K, { root: '/p', name: 'feat/x', oid: O2 })).toMatchObject({ outcome: 'ok' });
    expect(w.runs.at(-1)).toEqual(['branch', 'feat/x', O2]);
    expect(await w.ops.branchRestore(K, { root: '/p', name: 'feat/x', oid: O2 })).toMatchObject({ outcome: 'stale' });
  });

  test('rename never a branch checked out in another worktree; the current one here is fine', async () => {
    const w = world({ refs, reads: { worktrees } });
    expect(await w.ops.branchRename(K, { root: '/p', ref: 'refs/heads/other', name: 'x' })).toMatchObject({ outcome: 'state' });
    expect(w.runs).toEqual([]);
    expect(await w.ops.branchRename(K, { root: '/p', ref: 'refs/heads/main', name: 'trunk' })).toMatchObject({ outcome: 'ok' });
    expect(w.runs).toEqual([['branch', '-m', 'main', 'trunk']]);
  });

  test('switch: a remote branch tracks unless a local one has its name; carry none refuses tracked changes; tags never', async () => {
    const w = world({ refs, changes: [change('a.ts')] });
    expect(await w.ops.switchTo(K, { root: '/p', ref: 'refs/heads/feat/x', carry: 'none' })).toMatchObject({ outcome: 'conflict', dirty: true, files: ['a.ts'] });
    expect(await w.ops.switchTo(K, { root: '/p', ref: 'refs/tags/v1', carry: 'bring' })).toMatchObject({ outcome: 'stale' });
    expect(w.runs).toEqual([]);
    await w.ops.switchTo(K, { root: '/p', ref: 'refs/remotes/origin/new', carry: 'bring' });
    await w.ops.switchTo(K, { root: '/p', ref: 'refs/heads/feat/x', carry: 'bring' });
    expect(w.runs).toEqual([['switch', '--track', 'refs/remotes/origin/new'], ['switch', 'feat/x']]);
    const clean = world({ refs: [...refs, ref('refs/heads/new')], changes: [change('n.ts', { kind: '?' })] });
    expect(await clean.ops.switchTo(K, { root: '/p', ref: 'refs/remotes/origin/new', carry: 'none' })).toMatchObject({ outcome: 'ok' });
    expect(clean.runs).toEqual([['switch', 'new']]);
  });
});

describe('commit, amend, undo', () => {
  const msg = { root: '/p', message: 'feat: x', amend: false, coAuthor: true, noVerify: false };

  test('refused upfront: no identity, mid-rebase, amend of a pushed or merge commit or without HEAD', async () => {
    for (const [f, outcome] of [[{ identity: false }, 'identity'], [{ state: 'rebase' as const }, 'state']] as const) {
      const w = world({ reads: { facts: async () => facts(f) } });
      expect(await w.ops.commit(K, msg)).toMatchObject({ outcome });
      expect(w.runs).toEqual([]);
    }
    for (const f of [{ headPushed: true }, { headIsMerge: true }, { head: null }]) {
      const w = world({ reads: { facts: async () => facts(f) } });
      expect(await w.ops.commit(K, { ...msg, amend: true })).toMatchObject({ outcome: 'stale' });
      expect(w.runs).toEqual([]);
    }
    const ok = world();
    expect(await ok.ops.commit(K, { ...msg, amend: true })).toMatchObject({ outcome: 'ok', sha: O1 });
    expect(ok.runs).toEqual([['commit', '--cleanup=whitespace', '-F', '-', '--amend', '--trailer', 'Co-Authored-By: Claude <noreply@anthropic.com>']]);
  });

  /** A repo on O1 whose commit makes O2 (facts and HEAD follow); `more` patches the facts read after. */
  const committing = () => {
    const s = { head: O1, more: {} as Partial<RepoFacts> };
    const w = world({
      reads: { head: async () => s.head, facts: async () => facts({ head: s.head, ...s.more }) },
      run: (inv) => { if (inv.args[0] === 'commit') s.head = O2; return raw(); }
    });
    return { w, s };
  };

  test('a commit records Undo and holds its files in the keep set until HEAD moves away', async () => {
    const { w, s } = committing();
    expect(await w.ops.commit(K, msg)).toMatchObject({ outcome: 'ok', sha: O2, undo: { oid: O2 } });
    expect(w.kept).toEqual([{ root: '/p', paths: ['a.ts'], released: false }]);
    expect((await w.ops.facts(K, { root: '/p' }))?.undo).toEqual({ oid: O2, files: ['a.ts'] });
    // A status with the same HEAD keeps it; one where HEAD moved ends it.
    const st = (oid: string, o: Partial<RepoStatus> = {}): RepoStatus => ({ root: '/p', name: 'acme-store', branch: 'main', detached: false, ahead: 1, behind: 0, upstream: 'origin/main', changes: [], oid, checkedAt: Date.now() + 1, truncated: 0, ...o });
    w.ops.statusChanged(st(O2));
    expect(w.kept[0]!.released).toBe(false);
    s.head = O3;
    w.ops.statusChanged(st(O3));
    expect(w.kept[0]!.released).toBe(true);
    expect((await w.ops.facts(K, { root: '/p' }))?.undo).toBeNull();
  });

  test('pushed (ahead 0 on its upstream) ends Undo too; so do 15 minutes', async () => {
    vi.useFakeTimers();
    try {
      const { w } = committing();
      await w.ops.commit(K, msg);
      w.ops.statusChanged({ root: '/p', name: 'n', branch: 'main', detached: false, ahead: 0, behind: 0, upstream: 'origin/main', changes: [], oid: O2, checkedAt: Date.now() + 1, truncated: 0 });
      expect(w.kept[0]!.released).toBe(true);
      const { w: w2 } = committing();
      await w2.ops.commit(K, msg);
      vi.advanceTimersByTime(15 * 60_000);
      expect(w2.kept[0]!.released).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  test('undo: only Atelier’s own last commit, still HEAD, not pushed, one parent; answers its message', async () => {
    const none = world({ reads: { facts: async () => facts({ head: O2 }) } });
    expect(await none.ops.undoCommit(K, { root: '/p', oid: O2 })).toMatchObject({ outcome: 'stale' });
    expect(none.runs).toEqual([]);
    const { w, s } = committing();
    await w.ops.commit(K, msg);
    expect(await w.ops.undoCommit(K, { root: '/p', oid: O3 })).toMatchObject({ outcome: 'stale' });
    s.more = { headPushed: true };
    expect(await w.ops.undoCommit(K, { root: '/p', oid: O2 })).toMatchObject({ outcome: 'stale' });
    const { w: w2 } = committing();
    await w2.ops.commit(K, msg);
    expect(await w2.ops.undoCommit(K, { root: '/p', oid: O2 })).toMatchObject({ outcome: 'ok', message: 'feat: x' });
    expect(w2.runs.at(-1)).toEqual(['reset', '--soft', `${O2}~1`]);
    // Released once a status read after the reset arrived.
    expect(w2.kept[0]!.released).toBe(false);
    w2.ops.statusChanged({ root: '/p', name: 'n', branch: 'main', detached: false, ahead: 0, behind: 0, changes: [], oid: O1, checkedAt: Date.now() + 1, truncated: 0 });
    expect(w2.kept[0]!.released).toBe(true);
  });
});

describe('push', () => {
  test('publish only to a listed remote, from the current branch', async () => {
    const w = world({ remotes: ['origin'] });
    expect(await w.ops.push(K, { root: '/p', publish: { remote: 'evil' } })).toMatchObject({ outcome: 'stale' });
    expect(await w.ops.push(K, { root: '/p', publish: { remote: '--mirror' } })).toMatchObject({ outcome: 'stale' });
    expect(w.runs).toEqual([]);
    expect(await w.ops.push(K, { root: '/p', publish: { remote: 'origin' } })).toMatchObject({ outcome: 'ok' });
    expect(w.runs).toEqual([['push', '--no-follow-tags', '--set-upstream', 'origin', 'refs/heads/main:refs/heads/main']]);
  });

  test('a lease names only the upstream oid main showed (remoteCommits), on the upstream’s ref', async () => {
    const w = world();
    expect(await w.ops.push(K, { root: '/p', lease: { oid: O3 } })).toMatchObject({ outcome: 'stale' });
    expect(w.runs).toEqual([]);
    expect(await w.ops.remoteCommits(K, { root: '/p', n: 3 })).toEqual({ commits: [], remoteOid: O3, total: 0 });
    expect(await w.ops.push(K, { root: '/p', lease: { oid: O2 } })).toMatchObject({ outcome: 'stale' });
    expect(await w.ops.push(K, { root: '/p', lease: { oid: O3 } })).toMatchObject({ outcome: 'ok' });
    expect(w.runs).toEqual([['push', '--no-follow-tags', `--force-with-lease=refs/heads/main:${O3}`, '--force-if-includes', 'origin', 'refs/heads/main:refs/heads/main']]);
    // Used once: a second force needs a fresh look.
    expect(await w.ops.push(K, { root: '/p', lease: { oid: O3 } })).toMatchObject({ outcome: 'stale' });
  });

  test('a plain push sends the branch to its own name on its push remote, never what push.default would pick', async () => {
    const w = world();
    expect(await w.ops.push(K, { root: '/p' })).toMatchObject({ outcome: 'ok' });
    expect(w.runs).toEqual([['push', '--no-follow-tags', 'origin', 'refs/heads/main:refs/heads/main']]);
    // A triangular setup (pushRemote, remote.pushDefault): to the push remote, under the branch's own name.
    const fork = world({ remotes: ['origin', 'fork'], reads: { pushTarget: async () => ({ remote: 'fork', ref: '', upstreamRemote: 'origin', upstreamRef: 'refs/heads/main' }) } });
    expect(await fork.ops.push(K, { root: '/p' })).toMatchObject({ outcome: 'ok' });
    expect(fork.runs).toEqual([['push', '--no-follow-tags', 'fork', 'refs/heads/main:refs/heads/main']]);
  });

  test('a branch tracking another name (feat/x on origin/main) is never pushed there: Publish instead', async () => {
    const feat = (o: Partial<GitReads> = {}) => world({ reads: { facts: async () => facts({ branch: 'feat/x', upstream: 'origin/main' }), aheadBehind: async () => ({ ahead: 2, behind: 1 }), ...o } });
    const w = feat();
    expect(await w.ops.push(K, { root: '/p' })).toMatchObject({ outcome: 'state', message: 'feat/x tracks origin/main, a branch of another name: publish it as its own branch' });
    expect(await w.ops.push(K, { root: '/p', lease: { oid: O3 } })).toMatchObject({ outcome: 'stale' });
    await w.ops.remoteCommits(K, { root: '/p', n: 3 });
    expect(await w.ops.push(K, { root: '/p', lease: { oid: O3 } })).toMatchObject({ outcome: 'state' });
    // Sync refuses before pulling main into it.
    expect(await w.ops.sync(K, { root: '/p', rebase: true })).toMatchObject({ outcome: 'state', message: 'feat/x tracks origin/main, a branch of another name: publish it as its own branch' });
    expect(w.runs).toEqual([]);
    // A remote's push refspec that sends it elsewhere (Gerrit's refs/for/*): from the terminal.
    const gerrit = feat({ facts: async () => facts(), pushTarget: async () => ({ remote: 'origin', ref: 'refs/for/main', upstreamRemote: 'origin', upstreamRef: 'refs/heads/main' }) });
    expect(await gerrit.ops.push(K, { root: '/p' })).toMatchObject({ outcome: 'state', message: 'origin pushes main to refs/for/main: push it from the terminal' });
    // No push remote at all, or one that isn't configured.
    const none = world({ reads: { pushTarget: async () => null } });
    expect(await none.ops.push(K, { root: '/p' })).toMatchObject({ outcome: 'state', message: 'main has no upstream: publish it first' });
    const odd = world({ reads: { pushTarget: async () => ({ remote: '.', ref: '', upstreamRemote: '.', upstreamRef: 'refs/heads/main' }) } });
    expect(await odd.ops.push(K, { root: '/p' })).toMatchObject({ outcome: 'state' });
    expect([...gerrit.runs, ...none.runs, ...odd.runs]).toEqual([]);
  });

  test('detached HEAD has nothing to push; auth failures name the sign-in', async () => {
    const d = world({ reads: { facts: async () => facts({ branch: null, detached: true }) } });
    expect(await d.ops.push(K, { root: '/p' })).toMatchObject({ outcome: 'state' });
    const a = world({ run: () => raw({ code: 128, output: "fatal: could not read Username for 'https://github.com': terminal prompts disabled\n" }) });
    expect(await a.ops.push(K, { root: '/p' })).toMatchObject({ outcome: 'auth', message: "Push needs sign-in: git asked for a password Atelier can't type" });
  });
});

describe('stashes', () => {
  const list: ScmStash[] = [{ index: 0, oid: O1, message: 'On main: wip', at: 1 }, { index: 1, oid: O2, message: 'On main: old', at: 0 }];

  test('apply, pop and drop only the stash seen at that index (stale otherwise)', async () => {
    const w = world({ reads: { stashes: async () => list } });
    expect(await w.ops.stashApply(K, { root: '/p', index: 0, oid: O2, pop: false })).toMatchObject({ outcome: 'stale' });
    expect(await w.ops.stashDrop(K, { root: '/p', index: 1, oid: O1 })).toMatchObject({ outcome: 'stale' });
    expect(await w.ops.stashApply(K, { root: '/p', index: 5, oid: O1, pop: true })).toMatchObject({ outcome: 'stale' });
    expect(w.runs).toEqual([]);
    expect(await w.ops.stashDrop(K, { root: '/p', index: 1, oid: O2 })).toMatchObject({ outcome: 'ok', stash: { oid: O2, message: 'On main: old' } });
    expect(w.runs).toEqual([['stash', 'drop', 'stash@{1}']]);
  });

  test('pop takes the stash by its id: a session’s git stash moving the list meanwhile never pops another one', async () => {
    const mine: ScmStash = { index: 0, oid: O1, message: 'On main: mine', at: 1 };
    const theirs: ScmStash = { index: 0, oid: O3, message: 'On main: theirs', at: 2 };
    let moved = false;
    const w = world({
      // A session stashes while Atelier reads the status.
      reads: { stashes: async () => (moved ? [theirs, { ...mine, index: 1 }] : [mine]), status: async () => { moved = true; return []; } },
      run: (inv) => (inv.args[1] === 'drop' ? raw({ output: `Dropped stash@{1} (${O1})\n` }) : raw())
    });
    expect(await w.ops.stashApply(K, { root: '/p', index: 0, oid: O1, pop: true })).toMatchObject({ outcome: 'ok' });
    expect(w.runs).toEqual([['stash', 'apply', '--index', O1], ['stash', 'drop', 'stash@{1}']]);
    // Apply only: by its id too, nothing dropped.
    moved = false;
    expect(await w.ops.stashApply(K, { root: '/p', index: 0, oid: O1, pop: false })).toMatchObject({ outcome: 'ok' });
    expect(w.runs.at(-1)).toEqual(['stash', 'apply', '--index', O1]);
  });

  test('apply refused upfront when the stash touches files changed now', async () => {
    const w = world({ changes: [change('a.ts'), change('b.ts')], reads: { stashes: async () => list, stashFiles: async () => ['b.ts', 'c.ts'] } });
    expect(await w.ops.stashApply(K, { root: '/p', index: 0, oid: O1, pop: true })).toMatchObject({ outcome: 'conflict', dirty: true, files: ['b.ts'], message: 'Commit or stash that file first' });
    expect(w.runs).toEqual([]);
    const two = world({ changes: [change('a.ts'), change('b.ts')], reads: { stashes: async () => list, stashFiles: async () => ['a.ts', 'b.ts'] } });
    expect(await two.ops.stashApply(K, { root: '/p', index: 0, oid: O1, pop: true })).toMatchObject({ message: 'Commit or stash those 2 files first' });
  });

  test('restore (Undo of a drop) only a stash dropped here, with its own message', async () => {
    const w = world({ reads: { stashes: async () => list } });
    expect(await w.ops.stashRestore(K, { root: '/p', oid: O2, message: 'On main: old' })).toMatchObject({ outcome: 'stale' });
    await w.ops.stashDrop(K, { root: '/p', index: 1, oid: O2 });
    expect(await w.ops.stashRestore(K, { root: '/p', oid: O2, message: 'whatever the renderer says' })).toMatchObject({ outcome: 'ok' });
    expect(w.runs.at(-1)).toEqual(['stash', 'store', '-m', 'On main: old', O2]);
  });

  test('--staged needs git 2.35', async () => {
    const w = world({ reads: { facts: async () => facts({ gitVersion: [2, 34, 1] }) } });
    expect(await w.ops.stashPush(K, { root: '/p', message: 'm', untracked: false, staged: true })).toMatchObject({ outcome: 'error' });
    expect(w.runs).toEqual([]);
  });
});

describe('worktrees', () => {
  const tmp = () => toOut(realpathSync(mkdtempSync(join(tmpdir(), 'atl-ops-wt-'))));

  test('the folder must be inside the project’s real root, outside .git, and not exist yet', async () => {
    const project = tmp();
    mkdirSync(join(project, '.git'));
    mkdirSync(join(project, 'taken'));
    const outside = tmp();
    const { symlinkSync } = await import('node:fs');
    symlinkSync(outside, join(project, 'escape'));
    const w = world({ root: project, project });
    for (const path of [join(outside, 'w'), join(project, '.git', 'w'), join(project, 'escape', 'w'), join(project, 'a', '..', '..', 'w'), project]) {
      expect(await w.ops.worktreeAdd(K, { root: project, path, newName: 'w' })).toMatchObject({ outcome: 'error' });
      expect((await w.ops.worktreeCheck(K, { root: project, path })).inside).toBe(false);
    }
    // APFS is case-insensitive: .GIT is the .git folder (NTFS too).
    expect((await w.ops.worktreeCheck(K, { root: project, path: join(project, '.GIT', 'w') })).inside).toBe(false);
    expect(await w.ops.worktreeAdd(K, { root: project, path: join(project, 'taken'), newName: 'w' })).toMatchObject({ outcome: 'error', message: 'That folder already exists' });
    expect(await w.ops.worktreeCheck(K, { root: project, path: join(project, 'taken') })).toEqual({ inside: true, exists: true, ignored: false });
    expect(w.runs).toEqual([]);
    expect(await w.ops.worktreeAdd(K, { root: project, path: join(project, '.claude', 'worktrees', 'w'), newName: 'w' })).toMatchObject({ outcome: 'ok' });
    expect(w.runs).toEqual([['worktree', 'add', '--no-track', '-b', 'w', join(project, '.claude', 'worktrees', 'w')]]);
  });

  test('a new branch in a new worktree tracks nothing, unless it is the same-named remote branch’s local copy', async () => {
    const project = tmp();
    mkdirSync(join(project, '.git'));
    const w = world({ root: project, project, refs: [ref('refs/heads/main', { current: true, oid: O1 }), ref('refs/remotes/origin/main', { oid: O1 }), ref('refs/remotes/origin/feat/y', { oid: O2 })] });
    const at = (n: string) => join(project, '.claude', 'worktrees', n);
    expect(await w.ops.worktreeAdd(K, { root: project, path: at('a'), ref: 'refs/remotes/origin/main', newName: 'feat/a' })).toMatchObject({ outcome: 'ok' });
    expect(await w.ops.worktreeAdd(K, { root: project, path: at('b'), ref: 'refs/remotes/origin/feat/y', newName: 'feat/y' })).toMatchObject({ outcome: 'ok' });
    // Made, but its post-checkout hook failed: ok with a warning (git lists it); not made: the failure.
    const hookFailed = raw({ code: 1, hookFailed: 'post-checkout', output: 'nope\n' });
    const listed = world({ root: project, project, run: () => hookFailed, reads: { worktrees: async () => [{ path: at('c'), head: O1, branch: 'feat/c', detached: false, bare: false, locked: false, prunable: false }] } });
    expect(await listed.ops.worktreeAdd(K, { root: project, path: at('c'), newName: 'feat/c' })).toMatchObject({ outcome: 'ok', warning: 'The post-checkout hook failed: nope' });
    const missing = world({ root: project, project, run: () => hookFailed });
    expect(await missing.ops.worktreeAdd(K, { root: project, path: at('d'), newName: 'feat/d' })).toMatchObject({ outcome: 'hook' });
    expect(w.runs).toEqual([
      ['worktree', 'add', '--no-track', '-b', 'feat/a', at('a'), 'refs/remotes/origin/main'],
      ['worktree', 'add', '--track', '-b', 'feat/y', at('b'), 'refs/remotes/origin/feat/y']
    ]);
  });

  describe('worktreeAddForRun: no window, the same rules', () => {
    const forRun = (project: string, o: Partial<GitReads> = {}) => world({ root: project, project, reads: { repoRoot: async (d) => (d === project ? { root: project, common: join(project, '.git') } : null), ...o } });
    const args = (project: string, o: Record<string, string> = {}) => ({ project, root: project, path: join(project, '.claude', 'worktrees', 'auto-cu-1-x'), start: 'refs/remotes/origin/main', newName: 'auto/cu-1-x', ...o });

    test('a new branch from the start ref, in a folder of the project, queued like any write; the windows hear of it', async () => {
      const project = tmp();
      const w = forRun(project);
      expect(await w.ops.worktreeAddForRun(args(project))).toMatchObject({ outcome: 'ok' });
      expect(w.runs).toEqual([['worktree', 'add', '--no-track', '-b', 'auto/cu-1-x', join(project, '.claude', 'worktrees', 'auto-cu-1-x'), 'refs/remotes/origin/main']]);
      expect(w.events.map((e) => e.phase)).toEqual(['queued', 'running', 'done']);
      expect(w.statusAsked).toContain(project);
      expect(w.entryFor).not.toHaveBeenCalled();
    });

    test('Read-only refuses; a root that isn\'t the repository\'s top level, a folder outside the project or there already, a bad start or name: errors, nothing runs', async () => {
      const project = tmp();
      mkdirSync(join(project, 'taken'));
      const ro = forRun(project);
      ro.settings.gitActions = 'read-only';
      expect(await ro.ops.worktreeAddForRun(args(project))).toEqual({ outcome: 'error', message: READ_ONLY_MESSAGE });
      const w = forRun(project);
      const outside = tmp();
      for (const bad of <Record<string, string>[]>[{ root: outside }, { path: join(outside, 'w') }, { path: join(project, 'taken') }, { path: join(project, '.git', 'w') },
        { start: '--upload-pack=x' }, { start: 'refs/notes/x' }, { newName: '-x' }, { newName: 'a..b' }]) {
        expect(await w.ops.worktreeAddForRun(args(project, bad)), JSON.stringify(bad)).toMatchObject({ outcome: 'error' });
      }
      expect(w.runs).toEqual([]);
    });
  });

  describe('worktreeRemoveForRun: a run\'s clean worktree, never forced', () => {
    const wt = (project: string) => join(project, '.claude', 'worktrees', 'auto-cu-1-x');
    const linked = (path: string, o: Record<string, unknown> = {}) => ({ path, head: O1, branch: 'auto/cu-1-x', detached: false, bare: false, locked: false, prunable: false, ...o });
    const forRun = (project: string, o: Partial<GitReads> = {}) => world({
      root: project, project,
      reads: {
        repoRoot: async (d) => (d === project ? { root: project, common: join(project, '.git') } : null),
        worktrees: async () => [linked(project, { branch: 'main' }), linked(wt(project))],
        ...o
      }
    });
    const args = (project: string, o: Record<string, string> = {}) => ({ project, root: project, path: wt(project), ...o });

    test('a clean linked worktree of the project: worktree remove, queued like any write', async () => {
      const project = tmp();
      mkdirSync(wt(project), { recursive: true });
      const w = forRun(project);
      expect(await w.ops.worktreeRemoveForRun(args(project))).toMatchObject({ outcome: 'ok' });
      expect(w.runs).toEqual([['worktree', 'remove', wt(project)]]);
      expect(w.events.map((e) => e.phase)).toEqual(['queued', 'running', 'done']);
    });

    test('a worktree something still holds open (Windows: a dev server, an editor): said in plain words, not git\'s', async () => {
      const project = tmp();
      mkdirSync(wt(project), { recursive: true });
      for (const output of ["error: failed to delete 'C:/p/.claude/worktrees/auto-cu-1-x': Permission denied\n", 'fatal: unable to remove x: Device or resource busy\n',
        'error: The process cannot access the file because it is being used by another process.\n']) {
        const w = world({ root: project, project, reads: { repoRoot: async (d) => (d === project ? { root: project, common: join(project, '.git') } : null), worktrees: async () => [linked(project, { branch: 'main' }), linked(wt(project))] },
          run: () => raw({ code: 255, output }) });
        // Windows only: on macOS the same words mean something else (a read-only folder), git's text stays.
        const plain = { outcome: 'error', message: 'Something still has files open in that worktree (a dev server, an editor): close it, then Close Run again' };
        const r = await w.ops.worktreeRemoveForRun(args(project));
        if (process.platform === 'win32') expect(r, output).toMatchObject(plain);
        else expect(r.message, output).not.toBe(plain.message);
      }
    });

    test('changes not committed: kept, says why; nothing runs', async () => {
      const project = tmp();
      mkdirSync(wt(project), { recursive: true });
      const asked: string[] = [];
      const w = forRun(project, { status: async (r) => { asked.push(r); return [{ path: 'a.ts', status: 'modified', staged: false } as never]; } });
      expect(await w.ops.worktreeRemoveForRun(args(project))).toEqual({ outcome: 'conflict', message: "The worktree has changes that aren't committed, so it stays" });
      expect(asked).toEqual([wt(project)]);
      expect(w.runs).toEqual([]);
    });

    test('Read-only, the main worktree, one git doesn\'t list, a locked one, outside the project or inside .git: errors, nothing runs', async () => {
      const project = tmp();
      mkdirSync(wt(project), { recursive: true });
      const ro = forRun(project);
      ro.settings.gitActions = 'read-only';
      expect(await ro.ops.worktreeRemoveForRun(args(project))).toEqual({ outcome: 'error', message: READ_ONLY_MESSAGE });
      const outside = tmp();
      const other = join(project, '.claude', 'worktrees', 'other');
      mkdirSync(other, { recursive: true });
      for (const [bad, reads] of <[Record<string, string>, Partial<GitReads>][]>[
        [{ path: project }, {}], [{ path: other }, {}], [{ root: outside }, {}], [{ path: join(outside, 'w') }, {}], [{ path: join(project, '.git', 'w') }, {}],
        [{}, { worktrees: async () => [linked(project, { branch: 'main' }), linked(wt(project), { locked: true })] }]
      ]) {
        const w = forRun(project, reads);
        expect(await w.ops.worktreeRemoveForRun(args(project, bad)), JSON.stringify(bad)).toMatchObject({ outcome: 'error' });
        expect(w.runs).toEqual([]);
      }
    });
  });
});

describe('discard', () => {
  // POSIX: POSIX path fixtures.
  posixTest('every file goes to the Trash first; a failure stops before git runs for it; untracked: Trash only', async () => {
    const root = toOut(realpathSync(mkdtempSync(join(tmpdir(), 'atl-ops-discard-'))));
    for (const f of ['a.ts', 'b.ts', 'c.ts', 'u.ts', 'n.ts']) writeFileSync(join(root, f), 'x\n');
    const changes = [change('a.ts'), change('u.ts', { kind: '?' }), change('n.ts', { kind: 'A' }), change('d.ts', { kind: 'D' }), change('b.ts'), change('c.ts')];
    const w = world({ root, project: root, changes, trash: (p) => (p.endsWith('/b.ts') ? { error: 'denied' } : { ok: true }) });
    const r = await w.ops.discard(K, { root, rels: ['a.ts', 'u.ts', 'n.ts', 'd.ts', 'b.ts', 'c.ts'] });
    expect(r).toMatchObject({ outcome: 'error', files: ['b.ts'] });
    expect(w.trashed).toEqual(['a.ts', 'u.ts', 'n.ts'].map((f) => join(root, f)));
    // a.ts and the deletion are restored from HEAD, n.ts unstaged; b.ts and c.ts never reach git.
    expect(w.runs).toEqual([['restore', '--source=HEAD', '--staged', '--worktree', '--pathspec-from-file=-', '--pathspec-file-nul'], ['restore', '--staged', '--pathspec-from-file=-', '--pathspec-file-nul']]);
    expect(w.stdins).toEqual(['a.ts\0d.ts', 'n.ts']);
  });

  test('a rename restores both of its paths', async () => {
    const root = toOut(realpathSync(mkdtempSync(join(tmpdir(), 'atl-ops-discard-'))));
    writeFileSync(join(root, 'new.ts'), 'x\n');
    const w = world({ root, project: root, changes: [change('new.ts', { kind: 'R', origRel: 'old.ts' })] });
    expect(await w.ops.discard(K, { root, rels: ['new.ts'] })).toMatchObject({ outcome: 'ok' });
    expect(w.trashed).toEqual([join(root, 'new.ts')]);
    expect(w.stdins).toEqual(['old.ts\0new.ts']);
  });

  test('conflicts, submodules and nested repositories are left alone; all: refused past 10 000 files', async () => {
    const root = toOut(realpathSync(mkdtempSync(join(tmpdir(), 'atl-ops-discard-'))));
    const w = world({ root, project: root, changes: [change('u.ts', { kind: 'U' }), change('sub', { submodule: true }), change('nested/', { kind: '?' })] });
    expect(await w.ops.discard(K, { root, rels: 'all' })).toMatchObject({ outcome: 'ok', files: ['u.ts', 'sub', 'nested/'] });
    expect(w.trashed).toEqual([]);
    expect(w.runs).toEqual([]);
    const many = Array.from({ length: 10_001 }, (_, i) => change(`f${i}`, { kind: '?' }));
    const big = world({ root, project: root, reads: { status: async () => many } });
    expect(await big.ops.discard(K, { root, rels: 'all' })).toMatchObject({ outcome: 'error' });
    expect(big.trashed).toEqual([]);
  });
});

describe('the queue, busy retries, cancel, events', () => {
  test('busy (index.lock held) is retried 3 times, then answered with who to wait for', async () => {
    const lock = raw({ code: 128, output: "fatal: Unable to create '/p/.git/index.lock': File exists.\n" });
    const w = world({ changes: [change('a.ts')], run: () => lock });
    expect(await w.ops.stage(K, { root: '/p', rels: ['a.ts'] })).toMatchObject({ outcome: 'busy', message: 'Git is busy in acme-store: a session is committing. Try again.' });
    expect(w.runs).toHaveLength(4);
    let n = 0;
    const w2 = world({ changes: [change('a.ts')], run: () => (n++ < 2 ? lock : raw()) });
    expect(await w2.ops.stage(K, { root: '/p', rels: ['a.ts'] })).toMatchObject({ outcome: 'ok' });
    expect(w2.runs).toHaveLength(3);
  });

  test('events: queued, running, hook phases, chunks, done; a queued op cancelled never runs', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const w = world({ changes: [change('a.ts')], run: async () => { await gate; return raw(); } });
    const first = w.ops.stage(K, { root: '/p', rels: ['a.ts'] });
    const second = w.ops.unstage(K, { root: '/p', rels: ['a.ts'] });
    await new Promise((r) => setTimeout(r, 10));
    const queued = w.ops.runningOps().find((e) => e.op === 'unstage')!;
    expect(queued.phase).toBe('queued');
    expect((await w.ops.running(K)).map((e) => e.op).sort()).toEqual(['stage', 'unstage']);
    w.ops.cancel(queued.id);
    release();
    expect(await first).toMatchObject({ outcome: 'ok' });
    expect(await second).toMatchObject({ outcome: 'cancelled' });
    expect(w.runs).toHaveLength(1);
    expect(w.events.filter((e) => e.op === 'stage').map((e) => e.phase)).toEqual(['queued', 'running', 'done']);
    expect(w.ops.runningOps()).toEqual([]);
  });

  test('an op queued before Git actions turned Read-only never runs', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const w = world({ changes: [change('a.ts')], run: async () => { await gate; return raw(); } });
    const first = w.ops.stage(K, { root: '/p', rels: ['a.ts'] });
    const second = w.ops.discard(K, { root: '/p', rels: ['a.ts'] });
    await new Promise((r) => setTimeout(r, 10));
    w.settings.gitActions = 'read-only';
    release();
    expect(await first).toMatchObject({ outcome: 'ok' });
    expect(await second).toEqual({ outcome: 'error', message: READ_ONLY_MESSAGE });
    expect(w.runs).toHaveLength(1);
    expect(w.trashed).toEqual([]);
  });

  test('without the user’s shell environment the result says so', async () => {
    const w = world({ changes: [change('a.ts')] });
    w.deps.userEnv = async () => ({ env: {}, captured: false });
    expect(await w.ops.stage(K, { root: '/p', rels: ['a.ts'] })).toMatchObject({ outcome: 'ok', noShellEnv: true });
  });
});

describe('✦ (scm:message)', () => {
  test('off or no claude: refused; on: streams chunks and the accepted text, as the account with most staged lines', async () => {
    const off = world();
    off.settings.commitMessages = 'off';
    expect(await off.ops.message(K, { root: '/p' }, () => {})).toEqual({ error: 'Messages with Claude are off' });
    const none = world();
    none.deps.claude = () => null;
    expect(await none.ops.message(K, { root: '/p' }, () => {})).toEqual({ error: 'Claude Code was not found' });
  });
});

describe('the quit prompt', () => {
  const ev = (op: GitOpEvent['op'], root: string): GitOpEvent => ({ id: root + op, root, op, phase: 'running', startedAt: 0 });
  test('names the op and the repository; several say how many; none: no prompt', () => {
    expect(quitPrompt([])).toBeNull();
    expect(quitPrompt([ev('commit', '/p/acme-store')])).toEqual({ message: 'A commit is running in acme-store', detail: expect.stringContaining('Quit Anyway stops it'), ops: [{ noun: 'commit', repo: 'acme-store' }] });
    expect(quitPrompt([ev('push', '/p/api')])?.message).toBe('A push is running in api');
    expect(quitPrompt([ev('stashPush', '/p/api')])?.message).toBe('A stash is running in api');
    expect(quitPrompt([ev('commit', '/p/a'), ev('push', '/p/b')])).toEqual({ message: '2 git actions are running', detail: expect.stringContaining('a, b'), ops: [{ noun: 'commit', repo: 'a' }, { noun: 'push', repo: 'b' }] });
  });
});

describe('IPC', () => {
  test('an untrusted sender or a window without a project gets an error; bad payloads never reach an op', async () => {
    const w = world({ changes: [change('a.ts')] });
    const handlers = new Map<string, (e: unknown, arg: unknown) => unknown>();
    w.ops.installIpc((id) => (id === 1 ? K : null), (e) => (e as unknown as { trusted: boolean }).trusted, (ch, fn) => handlers.set(ch, fn as never));
    const stage = handlers.get(IPC.gitStage)!;
    const ev = (id: number, trusted: boolean) => ({ sender: { id }, trusted });
    expect(() => stage(ev(1, false), { root: '/p', rels: ['a.ts'] })).toThrow('unauthorized sender');
    expect(() => stage(ev(2, true), { root: '/p', rels: ['a.ts'] })).toThrow('unauthorized sender');
    expect(() => stage(ev(1, true), { root: '/p', rels: ['../x'] })).toThrow();
    expect(() => handlers.get(IPC.gitCommit)!(ev(1, true), { root: '/p', message: 'm', amend: false, coAuthor: false, noVerify: false, args: ['-f'] })).toThrow();
    expect(await stage(ev(1, true), { root: '/p', rels: ['a.ts'] })).toMatchObject({ outcome: 'ok' });
    for (const ch of [IPC.gitStage, IPC.gitUnstage, IPC.gitCommit, IPC.gitUndoCommit, IPC.gitPush, IPC.gitPull, IPC.gitSync, IPC.gitSyncAll, IPC.gitSwitch,
      IPC.gitCheckBranchName, IPC.gitBranchCreate, IPC.gitBranchRename, IPC.gitBranchDelete, IPC.gitBranchRestore, IPC.gitWorktreeCheck, IPC.gitWorktreeAdd,
      IPC.gitStashPush, IPC.gitStashApply, IPC.gitStashDrop, IPC.gitStashRestore, IPC.gitDiscard, IPC.gitCancel, IPC.gitFacts, IPC.gitIncoming,
      IPC.gitRemoteCommits, IPC.gitRunning, IPC.scmMessage, IPC.scmMessageCancel]) expect(handlers.has(ch)).toBe(true);
  });
});

describe('sessions for ✦', () => {
  // POSIX: POSIX path fixtures.
  posixTest('sure attributions on staged files only; the account of the session with the most staged lines', async () => {
    const w = world();
    const term = (id: string, sessionId: string): TerminalInfo => ({ id, projectRoot: K, cwd: '/p', title: id, session: { sessionId, cwd: '/p' } } as unknown as TerminalInfo);
    const at = (path: string, terminalId: string, o: Partial<Attribution> = {}): Attribution => ({ path, terminalId, sessionId: '', color: '', title: '', at: 1, ...o });
    w.deps.sessions = () => ({
      attributions: [at('/p/a.ts', 't1'), at('/p/b.ts', 't2'), at('/p/c.ts', 't3', { maybe: true }), at('/p/unstaged.ts', 't4')],
      terminals: [term('t1', 'aaaaaaaa-0000-0000-0000-000000000001'), term('t2', 'aaaaaaaa-0000-0000-0000-000000000002'), term('t3', 'x'), term('t4', 'y')]
    });
    w.deps.accountDir = (_k, id) => (id === 't2' ? '/Users/x/.claude-work' : undefined);
    const priv = w.ops as unknown as { messageSessions(t: object, files: string[], numstat: { rel: string; added: number; removed: number }[]): { sessions: { title: string; configDir: string | null }[]; account: string | undefined } };
    const r = priv.messageSessions({ key: K, root: '/p', common: '/p/.git', name: 'n' }, ['a.ts', 'b.ts', 'c.ts'], [{ rel: 'a.ts', added: 1, removed: 0 }, { rel: 'b.ts', added: 40, removed: 2 }]);
    expect(r.sessions.map((s) => [s.title, s.configDir])).toEqual([['t1', null], ['t2', '/Users/x/.claude-work']]);
    expect(r.account).toBe('/Users/x/.claude-work');
  });
});

const until = async (f: () => boolean, ms = 2000) => {
  const end = Date.now() + ms;
  while (!f()) {
    if (Date.now() > end) throw new Error('until: timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
};

const FOREIGN = "A rebase is in progress that Atelier didn't start: finish it in the terminal";

describe('a pull aborts only the rebase it started', () => {
  const conflict = raw({ code: 1, output: 'CONFLICT (content): Merge conflict in x.ts\nerror: could not apply 3acf482... feat: local\n' });
  const network = raw({ code: 128, output: "fatal: unable to access 'https://h.example/x/': Could not resolve host: h.example\n" });
  const unmerged = raw({ code: 128, output: 'error: Pulling is not possible because you have unmerged files.\n' });
  /** facts: clean before the pull, mid-rebase after it; the rebase's state files say `info`. */
  const rebasing = (pull: RawRun, info: { origHead: string | null; headName: string | null } | null) => {
    let n = 0;
    return world({
      reads: { facts: async () => facts(n++ === 0 ? {} : { state: 'rebase' }), rebaseInfo: async () => info },
      run: (inv) => (inv.args[0] === 'pull' ? pull : raw())
    });
  };

  test('ours (started on the HEAD read before the pull, on this branch): aborted', async () => {
    const w = rebasing(conflict, { origHead: O1, headName: 'refs/heads/main' });
    expect(await w.ops.pull(K, { root: '/p', rebase: true })).toMatchObject({ outcome: 'conflict' });
    expect(w.runs).toEqual([['pull', '--rebase', '--no-autostash'], ['rebase', '--abort']]);
  });

  test('the pull refused for a state (a rebase was there before it): never aborted', async () => {
    const w = rebasing(unmerged, { origHead: O1, headName: 'refs/heads/main' });
    expect(await w.ops.pull(K, { root: '/p', rebase: true })).toMatchObject({ outcome: 'state', message: FOREIGN });
    expect(w.runs).toEqual([['pull', '--rebase', '--no-autostash']]);
  });

  test('started on another HEAD, on another branch, or state files unreadable: never aborted', async () => {
    for (const info of [{ origHead: O2, headName: 'refs/heads/main' }, { origHead: O1, headName: 'refs/heads/side' }, { origHead: O1, headName: 'detached HEAD' }, { origHead: null, headName: 'refs/heads/main' }, null]) {
      const w = rebasing(network, info);
      expect(await w.ops.pull(K, { root: '/p', rebase: true })).toMatchObject({ outcome: 'state', message: FOREIGN });
      expect(w.runs).toEqual([['pull', '--rebase', '--no-autostash']]);
    }
  });

  test('Stash and Pull with someone else\'s rebase in progress: the stash stays in the list, never popped into it', async () => {
    let made = false;
    const top: ScmStash = { index: 0, oid: O3, message: 'On main: Atelier: before pull', at: 1 };
    let n = 0;
    const w = world({
      reads: { facts: async () => facts(n++ === 0 ? {} : { state: 'rebase' }), rebaseInfo: async () => ({ origHead: O2, headName: 'refs/heads/main' }), stashes: async () => (made ? [top] : []) },
      run: (inv) => { if (inv.args[1] === 'push') made = true; return inv.args[0] === 'pull' ? network : raw(); }
    });
    const r = await w.ops.pull(K, { root: '/p', rebase: true, stash: true });
    expect(r).toMatchObject({ outcome: 'state', stash: { oid: O3 } });
    expect(r.message).toContain(FOREIGN);
    expect(r.message).toContain('stash list');
    expect(w.runs.map((a) => a.slice(0, 2))).toEqual([['stash', 'push'], ['pull', '--rebase']]);
  });
});

describe('Quit Anyway waits for the cleanups', () => {
  test('quitAnyway: the ops stopped and new ones refused, the other writes stopped, then quit once the ops ended', async () => {
    const calls: string[] = [];
    let end!: (v: boolean) => void;
    const p = quitAnyway({
      ops: { stopAll: (ms) => { calls.push(`stopAll ${ms}`); return new Promise<boolean>((r) => { end = r; }); } },
      stopWrites: () => { calls.push('stopWrites'); }, quit: () => { calls.push('quit'); }
    }, 60_000);
    await new Promise((r) => setTimeout(r, 10));
    expect(calls).toEqual(['stopAll 60000', 'stopWrites']);
    end(true);
    await p;
    expect(calls).toEqual(['stopAll 60000', 'stopWrites', 'quit']);
  });

  /** A pull --rebase that runs until cancelled, then stops mid-rebase; its abort ends when `finish` is called. */
  const stoppable = (abortEnds: Promise<void>) => {
    let n = 0;
    const w = world({ reads: { facts: async () => facts(n++ === 0 ? {} : { state: 'rebase' }) } });
    w.deps.run = async (_r, inv, o) => {
      // Marked as a cleanup: stopAllWrites (Quit Anyway) lets it finish.
      w.runs.push([...inv.args, ...(o.cleanup ? ['(cleanup)'] : [])]);
      if (inv.args[0] === 'pull') {
        await new Promise<void>((res) => o.signal?.addEventListener('abort', () => res(), { once: true }));
        return raw({ code: null, cancelled: true });
      }
      if (inv.args[1] === '--abort') await abortEnds;
      return raw();
    };
    return w;
  };

  test('stopAll cancels a running pull --rebase and resolves only once its rebase --abort ended; new ops never start', async () => {
    let finish!: () => void;
    const w = stoppable(new Promise<void>((r) => { finish = r; }));
    const pull = w.ops.pull(K, { root: '/p', rebase: true });
    await until(() => w.runs.length === 1);
    let done = false;
    const stopped = w.ops.stopAll(5000).then((v) => { done = true; return v; });
    await until(() => w.runs.length === 2);
    expect(w.runs[1]).toEqual(['rebase', '--abort', '(cleanup)']);
    await new Promise((r) => setTimeout(r, 30));
    expect(done).toBe(false);
    finish();
    expect(await stopped).toBe(true);
    expect(await pull).toMatchObject({ outcome: 'cancelled' });
    expect(await w.ops.stage(K, { root: '/p', rels: 'all' })).toMatchObject({ outcome: 'cancelled' });
    expect(w.runs).toHaveLength(2);
  });

  test('a quit called off after Quit Anyway (a page kept, Cancel): resume lets ops run again, never "Atelier is quitting" for good', async () => {
    const w = world({ changes: [change('a.ts')] });
    expect(await w.ops.stopAll(100)).toBe(true);
    expect(await w.ops.stage(K, { root: '/p', rels: ['a.ts'] })).toMatchObject({ outcome: 'cancelled', message: 'Atelier is quitting.' });
    w.ops.resume();
    expect(await w.ops.stage(K, { root: '/p', rels: ['a.ts'] })).toMatchObject({ outcome: 'ok' });
  });

  test('bounded: a cleanup that never ends lets the quit go on', async () => {
    const w = stoppable(new Promise<void>(() => {}));
    void w.ops.pull(K, { root: '/p', rebase: true });
    await until(() => w.runs.length === 1);
    const t0 = Date.now();
    expect(await w.ops.stopAll(60)).toBe(false);
    expect(Date.now() - t0).toBeLessThan(1000);
  });
});

describe('keep-set holds', () => {
  const st = (oid: string, checkedAt: number): RepoStatus => ({ root: '/p', name: 'acme-store', branch: 'main', detached: false, ahead: 1, behind: 0, upstream: 'origin/main', changes: [], oid, checkedAt, truncated: 0 });

  test('a commit holds the staged paths before git runs, then hands them to Undo', async () => {
    const s = { head: O1 };
    let during: { paths: string[]; released: boolean }[] = [];
    const staged = [change('a.ts', { stage: 'all' }), change('n.ts', { kind: 'R', origRel: 'o.ts', stage: 'partial' }), change('w.ts'), change('u.ts', { kind: '?' })];
    const w: World = world({
      reads: { head: async () => s.head, facts: async () => facts({ head: s.head }), status: async () => staged },
      run: (inv) => {
        if (inv.args[0] === 'commit') { during = w.kept.map((k) => ({ paths: [...k.paths].sort(), released: k.released })); s.head = O2; }
        return raw();
      }
    });
    expect(await w.ops.commit(K, { root: '/p', message: 'feat: x', amend: false, coAuthor: true, noVerify: false })).toMatchObject({ outcome: 'ok', undo: { oid: O2 } });
    expect(during).toEqual([{ paths: ['a.ts', 'n.ts', 'o.ts'], released: false }]);
    // Undo's own hold (the commit's files) is taken before the first one is let go.
    expect(w.kept.map((k) => ({ paths: [...k.paths].sort(), released: k.released }))).toEqual([{ paths: ['a.ts', 'n.ts', 'o.ts'], released: true }, { paths: ['a.ts'], released: false }]);
  });

  test('no Undo (amend): the hold is let go once the commit ended', async () => {
    const w = world({ reads: { status: async () => [change('a.ts', { stage: 'all' })] } });
    expect(await w.ops.commit(K, { root: '/p', message: 'feat: x', amend: true, coAuthor: true, noVerify: false })).toMatchObject({ outcome: 'ok' });
    expect(w.kept).toEqual([{ root: '/p', paths: ['a.ts'], released: true }]);
  });

  test('stash and switch holds the stashed files until a status read after the sequence', async () => {
    let made = false;
    const top: ScmStash = { index: 0, oid: O3, message: 'On main: Atelier: changes on main', at: 1 };
    let during: boolean | null = null;
    const w: World = world({
      refs: [ref('refs/heads/main', { current: true, oid: O1 }), ref('refs/heads/feat')], changes: [change('a.ts')],
      reads: { stashes: async () => (made ? [top] : []), stashFiles: async () => ['a.ts'] },
      run: (inv) => {
        if (inv.args[1] === 'push') made = true;
        if (inv.args[0] === 'switch') during = w.kept.some((k) => k.paths.includes('a.ts') && !k.released);
        return raw();
      }
    });
    expect(await w.ops.switchTo(K, { root: '/p', ref: 'refs/heads/feat', carry: 'stash' })).toMatchObject({ outcome: 'ok', stash: { oid: O3 } });
    expect(during).toBe(true);
    expect(w.kept).toEqual([{ root: '/p', paths: ['a.ts'], released: false }]);
    w.ops.statusChanged({ ...st(O2, Date.now() + 1), ahead: 0 });
    expect(w.kept[0]!.released).toBe(true);
  });

  test('switched, but a post-checkout hook failed (git answers its status): ok with a warning, the stash never popped onto it', async () => {
    let made = false;
    let on = 'main';
    const top: ScmStash = { index: 0, oid: O3, message: 'On main: Atelier: changes on main', at: 1 };
    const hookFailed = raw({ code: 2, hookFailed: 'post-checkout', output: 'This repository is configured for Git LFS but git-lfs was not found on your path.\n' });
    const w = world({
      refs: [ref('refs/heads/main', { current: true, oid: O1 }), ref('refs/heads/feat')], changes: [change('a.ts')],
      reads: { stashes: async () => (made ? [top] : []), stashFiles: async () => ['a.ts'], facts: async () => facts({ branch: on }) },
      run: (inv) => {
        if (inv.args[1] === 'push') made = true;
        if (inv.args[0] === 'switch') { on = 'feat'; return hookFailed; }
        return raw();
      }
    });
    const r = await w.ops.switchTo(K, { root: '/p', ref: 'refs/heads/feat', carry: 'stash' });
    expect(r).toMatchObject({ outcome: 'ok', stash: { oid: O3 }, warning: 'The post-checkout hook failed: This repository is configured for Git LFS but git-lfs was not found on your path.' });
    expect(w.runs.map((a) => a.slice(0, 2))).toEqual([['stash', 'push'], ['switch', 'feat']]);
    // Not switched at all (the same failure, HEAD still on main): the changes come back.
    made = false; on = 'main';
    const stayed = world({
      refs: [ref('refs/heads/main', { current: true, oid: O1 }), ref('refs/heads/feat')], changes: [change('a.ts')],
      reads: { stashes: async () => (made ? [top] : []), stashFiles: async () => ['a.ts'], facts: async () => facts({ branch: 'main' }) },
      run: (inv) => { if (inv.args[1] === 'push') made = true; return inv.args[0] === 'switch' ? hookFailed : raw(); }
    });
    expect(await stayed.ops.switchTo(K, { root: '/p', ref: 'refs/heads/feat', carry: 'stash' })).toMatchObject({ outcome: 'hook' });
    expect(stayed.runs.map((a) => a.slice(0, 2))).toEqual([['stash', 'push'], ['switch', 'feat'], ['stash', 'apply'], ['stash', 'drop']]);
  });

  test('a new branch or worktree made, but a post-checkout hook failed: ok with a warning', async () => {
    const hookFailed = raw({ code: 1, hookFailed: 'post-checkout', output: 'hook: nope\n' });
    const made = world({ reads: { facts: async () => facts({ branch: 'feat/n' }), refName: async () => true }, run: () => hookFailed });
    expect(await made.ops.branchCreate(K, { root: '/p', name: 'feat/n', switch: true })).toMatchObject({ outcome: 'ok', warning: 'The post-checkout hook failed: hook: nope' });
    const notMade = world({ reads: { facts: async () => facts({ branch: 'main' }) }, run: () => hookFailed });
    expect(await notMade.ops.branchCreate(K, { root: '/p', name: 'feat/n', switch: true })).toMatchObject({ outcome: 'hook' });
  });

  test('a status read before the commit (HEAD still the old one there) never ends its Undo', async () => {
    const s = { head: O1 };
    const w = world({ reads: { head: async () => s.head, facts: async () => facts({ head: s.head }) }, run: (inv) => { if (inv.args[0] === 'commit') s.head = O2; return raw(); } });
    w.deps.now = () => 1000;
    await w.ops.commit(K, { root: '/p', message: 'feat: x', amend: false, coAuthor: true, noVerify: false });
    w.ops.statusChanged(st(O1, 999));
    w.ops.statusChanged(st(O1, 1000));
    expect((await w.ops.facts(K, { root: '/p' }))?.undo).toEqual({ oid: O2, files: ['a.ts'] });
    w.ops.statusChanged(st(O3, 1001));
    expect((await w.ops.facts(K, { root: '/p' }))?.undo).toBeNull();
  });
});

describe('stashes Atelier makes or drops', () => {
  const list: ScmStash[] = [{ index: 0, oid: O1, message: 'On main: wip', at: 1 }, { index: 1, oid: O2, message: 'On main: old', at: 0 }];

  test('drop: git names the stash it dropped; another one is stored back at once and the answer is stale', async () => {
    const w = world({ reads: { stashes: async () => list, commitMeta: async () => null }, run: (inv) => (inv.args[1] === 'drop' ? raw({ output: `Dropped stash@{1} (${O3})\n` }) : raw()) });
    expect(await w.ops.stashDrop(K, { root: '/p', index: 1, oid: O2 })).toMatchObject({ outcome: 'stale' });
    expect(w.runs).toEqual([['stash', 'drop', 'stash@{1}'], ['stash', 'store', '-m', 'Restored stash', O3]]);
    // Undo restores only what was really dropped (and was kept): O2 was never dropped.
    expect(await w.ops.stashRestore(K, { root: '/p', oid: O2, message: 'm' })).toMatchObject({ outcome: 'stale' });
  });

  test('drop: the oid git names is the one Undo restores', async () => {
    const w = world({ reads: { stashes: async () => list }, run: (inv) => (inv.args[1] === 'drop' ? raw({ output: `Dropped refs/stash@{1} (${O2})\n` }) : raw()) });
    expect(await w.ops.stashDrop(K, { root: '/p', index: 1, oid: O2 })).toMatchObject({ outcome: 'ok', stash: { oid: O2, message: 'On main: old' } });
    expect(await w.ops.stashRestore(K, { root: '/p', oid: O2, message: 'm' })).toMatchObject({ outcome: 'ok' });
  });

  /** A stash push stopped (cancel, timeout) after git made the stash; `pop` answers the apply back (then the drop). */
  const stoppedPush = (pop: RawRun = raw(), message = 'On main: Atelier: before pull') => {
    let made = false;
    const top: ScmStash = { index: 0, oid: O3, message, at: 1 };
    return world({
      refs: [ref('refs/heads/main', { current: true, oid: O1 }), ref('refs/heads/feat')], changes: [change('a.ts')],
      reads: { stashes: async () => (made ? [top] : []) },
      run: (inv) => {
        if (inv.args[1] === 'push') { made = true; return raw({ code: null, cancelled: true }); }
        if (inv.args[1] === 'apply') return pop;
        if (inv.args[1] === 'drop') { made = false; return raw({ output: `Dropped stash@{0} (${O3})\n` }); }
        return raw();
      }
    });
  };

  test('Stash and Pull: a stash its stopped push made is popped back; nothing is pulled', async () => {
    const w = stoppedPush();
    expect(await w.ops.pull(K, { root: '/p', rebase: false, stash: true })).toMatchObject({ outcome: 'cancelled' });
    expect(w.runs).toEqual([['stash', 'push', '-u', '-m', 'Atelier: before pull'], ['stash', 'apply', '--index', O3], ['stash', 'drop', 'stash@{0}']]);
  });

  test('Stash and Pull: applied back but the stash could not be dropped: pulled, with the warning; the switch says so too', async () => {
    let made = false;
    const top: ScmStash = { index: 0, oid: O3, message: 'On main: Atelier: before pull', at: 1 };
    const w = world({
      refs: [ref('refs/heads/main', { current: true, oid: O1 }), ref('refs/heads/feat')], changes: [change('a.ts')],
      reads: { stashes: async () => (made ? [top] : []) },
      run: (inv) => {
        if (inv.args[1] === 'push') made = true;
        return inv.args[1] === 'drop' ? raw({ code: 1, output: 'error: could not drop\n' }) : raw();
      }
    });
    const r = await w.ops.pull(K, { root: '/p', rebase: false, stash: true });
    expect(r).toMatchObject({ outcome: 'ok' });
    expect(r.warning).toMatch(/^The stash stays in the list/);
    // A switch that failed, its changes applied back but the stash kept: never just "Your changes are back".
    made = false;
    const s = world({
      refs: [ref('refs/heads/main', { current: true, oid: O1 }), ref('refs/heads/feat')], changes: [change('a.ts')],
      reads: { stashes: async () => (made ? [{ ...top, message: 'On main: Atelier: changes on main' }] : []) },
      run: (inv) => {
        if (inv.args[1] === 'push') made = true;
        if (inv.args[0] === 'switch') return raw({ code: 1, output: 'error: nope\n' });
        return inv.args[1] === 'drop' ? raw({ code: 1, output: 'error: could not drop\n' }) : raw();
      }
    });
    expect((await s.ops.switchTo(K, { root: '/p', ref: 'refs/heads/feat', carry: 'stash' })).message).toContain('Your changes are back, and still in the stash list.');
  });

  test('Stash and Pull: pulled, but a stashed untracked file clashes with one the pull added: never "would be overwritten", the stash named', async () => {
    let made = false;
    const top: ScmStash = { index: 0, oid: O3, message: 'On main: Atelier: before pull', at: 1 };
    const w = world({
      changes: [change('a.ts')],
      reads: { stashes: async () => (made ? [top] : []) },
      run: (inv) => {
        if (inv.args[1] === 'push') made = true;
        return inv.args[1] === 'apply' ? raw({ code: 1, output: 'new.txt already exists, no checkout\nerror: could not restore untracked files from stash\n' }) : raw();
      }
    });
    const r = await w.ops.pull(K, { root: '/p', rebase: false, stash: true });
    expect(r).toMatchObject({ outcome: 'conflict', stash: { oid: O3 } });
    expect(r.dirty).toBeUndefined();
    expect(r.message).toBe('Pulled, but your stashed new.txt couldn\'t come back: a file of that name is there now. The stash is kept.');
    expect(w.runs.some((a) => a[1] === 'drop')).toBe(false);
    // A tracked file a session changed between the stash and the pop: nothing applied, said so.
    made = false;
    const edited = world({
      changes: [change('a.ts')],
      reads: { stashes: async () => (made ? [top] : []) },
      run: (inv) => {
        if (inv.args[1] === 'push') made = true;
        return inv.args[1] === 'apply' ? raw({ code: 1, output: 'error: Your local changes to the following files would be overwritten by merge:\n\ta.ts\nAborting\n' }) : raw();
      }
    });
    const e = await edited.ops.pull(K, { root: '/p', rebase: false, stash: true });
    expect(e.dirty).toBeUndefined();
    expect(e.message).toBe('Pulled, but your stashed changes couldn\'t come back: 1 file changed meanwhile. The stash is kept.');
  });

  test('Stash and Pull: a stash list that can\'t be read after the pull is an answer naming the stash; the files are let go', async () => {
    let made = false;
    let pulled = false;
    const top: ScmStash = { index: 0, oid: O3, message: 'On main: Atelier: before pull', at: 1 };
    const w = world({
      changes: [change('a.ts')],
      reads: { stashes: async () => { if (pulled) throw new Error('git timed out'); return made ? [top] : []; } },
      run: (inv) => { if (inv.args[1] === 'push') made = true; if (inv.args[0] === 'pull') pulled = true; return raw(); }
    });
    const r = await w.ops.pull(K, { root: '/p', rebase: false, stash: true });
    expect(r).toMatchObject({ outcome: 'error', stash: { oid: O3 } });
    expect(r.message).toContain('Pulled, but');
    // The stashed files' hold goes with the next status read, as after any sequence.
    expect((w.ops as unknown as { releases: unknown[] }).releases).toHaveLength(1);
  });

  test('a stash whose staged part no longer applies on its own (git: "Try without --index"): applied without it, said so', async () => {
    const w = world({
      reads: { stashes: async () => [{ index: 0, oid: O1, message: 'On main: wip', at: 1 }] },
      run: (inv) => (inv.args.includes('--index') ? raw({ code: 1, output: 'error: patch failed: a.ts:1\nerror: a.ts: patch does not apply\nerror: conflicts in index. Try without --index.\n' }) : raw())
    });
    const r = await w.ops.stashApply(K, { root: '/p', index: 0, oid: O1, pop: false });
    expect(r).toMatchObject({ outcome: 'ok', warning: 'Applied, but what was staged in it is now unstaged' });
    expect(w.runs).toEqual([['stash', 'apply', '--index', O1], ['stash', 'apply', O1]]);
  });

  test('a pop back that fails says the changes are in the stash list', async () => {
    const w = stoppedPush(raw({ code: 1, output: 'error: Your local changes to the following files would be overwritten by merge:\n\ta.ts\n' }));
    const r = await w.ops.pull(K, { root: '/p', rebase: false, stash: true });
    expect(r).toMatchObject({ outcome: 'cancelled', stash: { oid: O3 } });
    expect(r.message).toContain('stash list');
  });

  test('stash and switch: the same', async () => {
    const w = stoppedPush(raw(), 'On main: Atelier: changes on main');
    expect(await w.ops.switchTo(K, { root: '/p', ref: 'refs/heads/feat', carry: 'stash' })).toMatchObject({ outcome: 'cancelled' });
    expect(w.runs.map((a) => a.slice(0, 2))).toEqual([['stash', 'push'], ['stash', 'apply'], ['stash', 'drop']]);
  });

  test('nothing stashed by the stopped push: nothing popped', async () => {
    const w = world({ run: (inv) => (inv.args[1] === 'push' ? raw({ code: null, cancelled: true }) : raw()) });
    expect(await w.ops.pull(K, { root: '/p', rebase: false, stash: true })).toMatchObject({ outcome: 'cancelled' });
    expect(w.runs).toEqual([['stash', 'push', '-u', '-m', 'Atelier: before pull']]);
  });
});

describe('more write guards (main)', () => {
  test('discard checks index.lock before trashing anything: busy, no file touched', async () => {
    const root = toOut(realpathSync(mkdtempSync(join(tmpdir(), 'atl-ops-discard-'))));
    writeFileSync(join(root, 'a.ts'), 'x\n');
    const w = world({ root, project: root, changes: [change('a.ts')], reads: { indexLock: async () => ({ path: join(root, '.git', 'index.lock'), mtimeMs: Date.now() }) } });
    expect(await w.ops.discard(K, { root, rels: ['a.ts'] })).toMatchObject({ outcome: 'busy', message: 'Git is busy in acme-store: a session is committing. Try again.' });
    expect(w.trashed).toEqual([]);
    expect(w.runs).toEqual([]);
  });

  test('cancel of a queued op answers at once; it never starts', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const w = world({ changes: [change('a.ts')], run: async () => { await gate; return raw(); } });
    const first = w.ops.stage(K, { root: '/p', rels: ['a.ts'] });
    const second = w.ops.unstage(K, { root: '/p', rels: ['a.ts'] });
    await until(() => w.ops.runningOps().length === 2);
    w.ops.cancel(w.ops.runningOps().find((e) => e.op === 'unstage')!.id);
    const answer = await Promise.race([second, new Promise((r) => setTimeout(() => r('still waiting'), 200))]);
    expect(answer).toMatchObject({ outcome: 'cancelled' });
    expect(w.ops.runningOps().map((e) => e.op)).toEqual(['stage']);
    release();
    await first;
    await new Promise((r) => setTimeout(r, 10));
    expect(w.runs).toHaveLength(1);
  });

  test('remoteCommits answers how many commits the upstream has that HEAD lacks, past the ones listed', async () => {
    const commits = [{ oid: O2, subject: 's', author: 'a' }];
    const w = world({ reads: { remoteCommits: async () => commits, remoteCount: async () => 7 } });
    expect(await w.ops.remoteCommits(K, { root: '/p', n: 1 })).toEqual({ commits, remoteOid: O3, total: 7 });
  });

  test('expectHead: refused (stale) when HEAD is no longer the commit the drawer showed', async () => {
    const msg = { root: '/p', message: 'feat: x', coAuthor: false, noVerify: false };
    const w = world();
    expect(await w.ops.commit(K, { ...msg, amend: true, expectHead: O2 })).toEqual({ outcome: 'stale', message: 'HEAD moved: 1111111 is not the commit you were amending' });
    expect(await w.ops.commit(K, { ...msg, amend: false, expectHead: O2 })).toMatchObject({ outcome: 'stale' });
    expect(w.runs).toEqual([]);
    expect(await w.ops.commit(K, { ...msg, amend: true, expectHead: O1 })).toMatchObject({ outcome: 'ok' });
  });

  test('syncAll({ skip }): a listed root skipped answers needsYou live without pulling; unknown roots in skip change nothing', async () => {
    const status: ScmRepoEntry['status'] = { branch: 'main', detached: false, oid: O1, ahead: 0, behind: 2, upstream: 'origin/main', changes: 0 };
    const w = world({ reads: { aheadBehind: async () => ({ ahead: 0, behind: 2 }) } });
    w.deps.scm.entries = async () => [{ root: '/p', rel: '', name: 'acme-store', worktreeOf: null, nestedIn: null, common: '/p/.git', status }];
    expect(await w.ops.syncAll(K, { skip: ['/p'] })).toEqual([{ root: '/p', result: null, needsYou: 'live' }]);
    expect(w.runs).toEqual([]);
    expect(await w.ops.syncAll(K, { skip: ['/elsewhere'] })).toEqual([{ root: '/p', result: { outcome: 'ok', at: expect.any(Number), left: { ahead: 0, behind: 0 } } }]);
    expect(w.runs).toEqual([['pull', '--ff-only', '--no-rebase']]);
  });

  test('syncAll: a branch tracking another name needs publishing (never synced with main); a gone upstream is left alone', async () => {
    const w = world();
    const other: ScmRepoEntry['status'] = { branch: 'feat/x', detached: false, oid: O1, ahead: 3, behind: 1, upstream: 'origin/main', changes: 0 };
    const gone: ScmRepoEntry['status'] = { branch: 'feat/y', detached: false, oid: O1, ahead: 0, behind: 0, upstream: 'origin/feat/y', upstreamGone: true, changes: 0 };
    w.deps.scm.entries = async () => [
      { root: '/p', rel: '', name: 'acme-store', worktreeOf: null, nestedIn: null, common: '/p/.git', status: other },
      { root: '/p/b', rel: 'b', name: 'b', worktreeOf: null, nestedIn: null, common: '/p/b/.git', status: gone }
    ];
    expect(await w.ops.syncAll(K)).toEqual([{ root: '/p', result: null, needsYou: 'no-upstream' }]);
    expect(w.runs).toEqual([]);
  });
});
