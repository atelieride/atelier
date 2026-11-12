import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, test } from 'vitest';
import { isWin, posixTest } from '../support/platform';
import { bestTimeAsync } from '../support/timing';
import { EMPTY_TREE, type ScmCommit, type ScmRefs, type ScmScope } from '../../src/shared/scm';
import { aheadBehind, locateCommit, readBlob, readCommit, readLog, readRefs, readStashes, readWorktrees, resolveCommit, scopeArgs } from '../../src/main/git/history';
import { bigRepo, commit, git, historyRepo, importCommit } from '../support/git-fixture';

const tmp = (p: string) => realpathSync(mkdtempSync(join(tmpdir(), p)));
const ALL: ScmScope = { kind: 'refs', refs: 'all', firstParent: false };
const page = (repo: string, scope: ScmScope, refs: ScmRefs, skip = 0, count = 400, filter?: string) => readLog(repo, scope, refs, { skip, count, ...(filter ? { filter } : {}) });

/** Every commit comes after all its children. */
function topoOk(list: ScmCommit[]) {
  const at = new Map(list.map((c, i) => [c.oid, i]));
  for (const [i, c] of list.entries()) for (const p of c.parents) if (at.has(p)) expect(at.get(p)!).toBeGreaterThan(i);
}

describe('history repo', () => {
  let repo = '';
  let ids: ReturnType<typeof historyRepo>;
  let refs: ScmRefs;
  beforeAll(async () => {
    repo = tmp('atl-scm-');
    ids = historyRepo(repo);
    refs = await readRefs(repo);
  });

  test('readRefs: branches, current, peeled tag, default branch, no remote, sha1 empty tree', () => {
    expect(refs.error).toBeUndefined();
    expect(refs.head).toEqual({ branch: 'main', oid: ids.merge, detached: false });
    expect(refs.refs.filter((r) => r.kind === 'head').map((r) => [r.short, r.current])).toEqual(expect.arrayContaining([['main', true], ['feat/x', false]]));
    expect(refs.refs.find((r) => r.kind === 'tag')).toMatchObject({ short: 'v1', oid: ids.merge });
    expect(refs.defaultBranch).toEqual({ ref: 'main', base: 'main' });
    expect(refs).toMatchObject({ shallow: false, fetchedAt: null, hasRemote: false, remotes: [], emptyTree: EMPTY_TREE.sha1 });
  });

  test('readRefs: a configured remote never fetched still counts as a remote', async () => {
    const r = tmp('atl-scm-nofetch-');
    historyRepo(r);
    git(r, 'remote', 'add', 'upstream', '/nowhere/x.git');
    git(r, 'remote', 'add', 'origin', '/nowhere/y.git');
    const got = await readRefs(r);
    expect(got.remotes).toEqual(['origin', 'upstream']);
    expect(got).toMatchObject({ hasRemote: true, fetchedAt: null });
    expect(got.refs.some((x) => x.kind === 'remote')).toBe(false);
  });

  test('readRefs: a remote branch and FETCH_HEAD', async () => {
    const r = tmp('atl-scm-remote-');
    historyRepo(r);
    git(r, 'update-ref', 'refs/remotes/origin/main', 'HEAD~1');
    writeFileSync(join(r, '.git', 'FETCH_HEAD'), '');
    const got = await readRefs(r);
    expect(got.hasRemote).toBe(true);
    expect(got.refs.find((x) => x.kind === 'remote')).toMatchObject({ short: 'origin/main', remote: 'origin' });
    expect(Math.abs((got.fetchedAt ?? 0) - Date.now())).toBeLessThan(10_000);
  });

  test('readLog all: every commit once, children before parents, co-authors, paging', async () => {
    const all = await page(repo, ALL, refs);
    expect(all.error).toBeUndefined();
    expect(all.commits.map((c) => c.oid).sort()).toEqual(Object.values(ids).sort());
    expect(all.commits[0]!.oid).toBe(ids.merge);
    topoOk(all.commits);
    expect(all.commits.find((c) => c.oid === ids.f1)!.coAuthors).toEqual([{ name: 'Claude', email: 'noreply@anthropic.com' }]);
    expect(all.done).toBe(true);
    const p2 = await page(repo, ALL, refs, 2, 2);
    expect(p2.commits.map((c) => c.oid)).toEqual(all.commits.slice(2, 4).map((c) => c.oid));
    expect(p2.done).toBe(false);
    expect((await page(repo, ALL, refs, 4, 3)).done).toBe(true);
  });

  test('readLog ref: only what the branch reaches; first parent; an unknown ref is refused', async () => {
    const feat = await page(repo, { kind: 'refs', refs: 'refs/heads/feat/x', firstParent: false }, refs);
    expect(feat.commits.map((c) => c.oid)).toEqual([ids.f2, ids.f1, ids.c2, ids.c1]);
    const fp = await page(repo, { kind: 'refs', refs: 'refs/heads/main', firstParent: true }, refs);
    expect(fp.commits.map((c) => c.oid)).toEqual([ids.merge, ids.c3, ids.c2, ids.c1]);
    const bad = await page(repo, { kind: 'refs', refs: 'refs/heads/nope', firstParent: false }, refs);
    expect(bad).toMatchObject({ commits: [], error: 'unknown ref' });
    expect(scopeArgs({ kind: 'refs', refs: '--all', firstParent: false }, refs)).toBeNull();
  });

  test('readLog filter: words, author, path, a hex word that is not a commit', async () => {
    const oids = async (f: string) => (await page(repo, ALL, refs, 0, 400, f)).commits.map((c) => c.oid);
    expect(await oids('RENAME')).toEqual([ids.c3]);
    expect(await oids('feat x')).toEqual(expect.arrayContaining([ids.f1, ids.f2]));
    expect((await oids('@Ada')).length).toBe(6);
    expect(await oids('@nobody')).toEqual([]);
    expect(await oids('path:dir')).toEqual([ids.f1, ids.c1]);
    expect(await oids('beef')).toEqual([]);
    // A prefix of a real commit is not a filter: the renderer jumps to it, the list stays whole.
    expect((await oids(ids.c2.slice(0, 7))).length).toBe(6);
  });

  test('compare: base..head and the merge base', async () => {
    const before = await page(repo, { kind: 'compare', base: ids.c3, head: 'refs/heads/feat/x' }, refs);
    expect(before.commits.map((c) => c.oid)).toEqual([ids.f2, ids.f1]);
    expect(before.mergeBase).toBe(ids.c2);
    const after = await page(repo, { kind: 'compare', base: 'refs/heads/main', head: 'refs/heads/feat/x' }, refs);
    expect(after.commits).toEqual([]);
  });

  test('resolveCommit and locateCommit', async () => {
    expect(await resolveCommit(repo, ids.c2.slice(0, 8))).toBe(ids.c2);
    expect(await resolveCommit(repo, 'beef')).toBeNull();
    const all = await page(repo, ALL, refs);
    expect(await locateCommit(repo, ALL, refs, ids.c2)).toBe(all.commits.findIndex((c) => c.oid === ids.c2));
    expect(await locateCommit(repo, { kind: 'refs', refs: 'refs/heads/feat/x', firstParent: false }, refs, ids.c3)).toBeNull();
  });

  // POSIX: the executable bit; git prints C:/ worktree paths on Windows.
  posixTest('readCommit: root against the empty tree, merge against each parent, rename, mode change, binary', async () => {
    const root = await readCommit(repo, ids.c1, null, refs.emptyTree);
    expect(root.base).toBe(EMPTY_TREE.sha1);
    expect(root.files.every((f) => f.kind === 'A')).toBe(true);
    expect(root.message).toBe('feat: first files');
    const m1 = await readCommit(repo, ids.merge, null, refs.emptyTree);
    expect(m1.base).toBe(ids.c3);
    expect(m1.files.map((f) => f.rel).sort()).toEqual(['dir/x.ts', 'feat.ts']);
    const m2 = await readCommit(repo, ids.merge, ids.f2, refs.emptyTree);
    expect(m2.files.map((f) => f.rel).sort()).toEqual(['logo.png', 'nuovo è.ts', 'run.sh']);
    const c3 = await readCommit(repo, ids.c3, null, refs.emptyTree);
    const by = Object.fromEntries(c3.files.map((f) => [f.rel, f]));
    expect(by['nuovo è.ts']).toMatchObject({ kind: 'R', origRel: 'old name.ts' });
    expect(by['run.sh']).toMatchObject({ kind: 'M', oldMode: '100644', newMode: '100755', added: 0, removed: 0 });
    expect(by['logo.png']).toMatchObject({ added: null, removed: null });
    // Full object ids, never git's short ones (core.abbrev): they name blobs.
    expect(c3.files.every((f) => /^[0-9a-f]{40}$/.test(f.oldOid) && /^[0-9a-f]{40}$/.test(f.newOid))).toBe(true);
    const f1 = await readCommit(repo, ids.f1, null, refs.emptyTree);
    expect(f1.message).toContain('Co-authored-by: Claude');
    await expect(readCommit(repo, 'nope', null, refs.emptyTree)).resolves.toMatchObject({ files: [], error: 'bad commit' });
  });

  test('readBlob: text, at the parent by its old name, binary, missing, refused paths, too large, not UTF-8', async () => {
    expect(await readBlob(repo, ids.c2, 'a.ts')).toEqual({ kind: 'text', text: 'one\nTWO\nthree\n', notUtf8: false });
    expect(await readBlob(repo, ids.c2, 'old name.ts')).toMatchObject({ kind: 'text', text: 'r1\nr2\nr3\nr4\n' });
    expect(await readBlob(repo, ids.c3, 'logo.png')).toMatchObject({ kind: 'binary' });
    expect(await readBlob(repo, ids.c1, 'feat.ts')).toEqual({ kind: 'missing' });
    expect(await readBlob(repo, ids.c1, '../x')).toEqual({ kind: 'missing' });
    expect(await readBlob(repo, ids.c1, '/etc/passwd')).toEqual({ kind: 'missing' });
    const r = tmp('atl-scm-blob-');
    git(r, 'init', '-q');
    const big = commit(r, 'big', { 'big.txt': 'x'.repeat(2 * 1024 * 1024 + 10), 'latin.txt': Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]) });
    expect(await readBlob(r, big, 'big.txt')).toEqual({ kind: 'tooLarge', size: 2 * 1024 * 1024 + 10 });
    expect(await readBlob(r, big, 'latin.txt')).toMatchObject({ kind: 'text', notUtf8: true });
  });

  test('aheadBehind', async () => {
    expect(await aheadBehind(repo, 'refs/heads/main', 'refs/heads/feat/x')).toEqual({ ahead: 0, behind: 2 });
    expect(await aheadBehind(repo, ids.c3, 'refs/heads/feat/x')).toEqual({ ahead: 2, behind: 1 });
    expect(await aheadBehind(repo, '--all', 'refs/heads/main')).toBeNull();
  });
});

// POSIX: the executable bit; git prints C:/ worktree paths on Windows.
posixTest('worktrees and stashes', async () => {
  const repo = tmp('atl-scm-wt-');
  historyRepo(repo);
  expect(await readStashes(repo)).toEqual([]);
  git(repo, 'worktree', 'add', '-q', '-b', 'v2', join(repo, '.worktrees', 'v2'));
  const out = tmp('atl-scm-wt-out-');
  git(repo, 'worktree', 'add', '-q', '--detach', join(out, 'x'), 'HEAD~1');
  const wts = await readWorktrees(repo);
  // The main worktree first; git lists the linked ones by their internal names.
  expect(wts[0]!.path).toBe(repo);
  expect(wts.map((w) => [w.path, w.branch, w.detached])).toEqual(expect.arrayContaining([[repo, 'main', false], [join(repo, '.worktrees', 'v2'), 'v2', false], [join(out, 'x'), null, true]]));
  expect(wts).toHaveLength(3);
  writeFileSync(join(repo, 'a.ts'), 'stash me\n');
  git(repo, 'stash', 'push', '-q', '-m', 'first');
  writeFileSync(join(repo, 'a.ts'), 'stash me too\n');
  git(repo, 'stash', 'push', '-q', '-m', 'second');
  const st = await readStashes(repo);
  expect(st.map((s) => [s.index, s.message])).toEqual([[0, 'On main: second'], [1, 'On main: first']]);
});

test('odd refs: a branch named like an option, a tag named like a tracked file; a commit with many files', async () => {
  const repo = tmp('atl-scm-odd-');
  const ids = historyRepo(repo);
  git(repo, 'update-ref', 'refs/heads/-n', ids.c1);
  const files: Record<string, string> = { 'README.md': 'x\n' };
  for (let i = 0; i < 2500; i++) files[`many/f${i}.txt`] = `${i}\n`;
  // Through fast-import: written and added one by one, they took 31–64 s on GitHub's Windows runner (60 s timeout).
  const many = importCommit(repo, 'many files', files);
  git(repo, 'tag', 'README.md', ids.c2);
  const refs = await readRefs(repo);
  const dash = await readLog(repo, { kind: 'refs', refs: 'refs/heads/-n', firstParent: false }, refs, { skip: 0, count: 10 });
  expect(dash.commits.map((c) => c.oid)).toEqual([ids.c1]);
  const tag = await readLog(repo, { kind: 'refs', refs: 'refs/tags/README.md', firstParent: false }, refs, { skip: 0, count: 10 });
  expect(tag.commits.map((c) => c.oid)).toEqual([ids.c2, ids.c1]);
  const d = await readCommit(repo, many, null, refs.emptyTree);
  expect(d.files).toHaveLength(2000);
  expect(d.more).toBe(501);
});

test('sha256 repository: the empty tree id is the sha256 one and a root commit lists its files', async () => {
  const repo = tmp('atl-scm-256-');
  git(repo, 'init', '-q', '--object-format=sha256');
  const c = commit(repo, 'root', { 'a.txt': 'a\n' });
  const refs = await readRefs(repo);
  expect(refs.emptyTree).toBe(EMPTY_TREE.sha256);
  expect(c).toHaveLength(64);
  const d = await readCommit(repo, c, null, refs.emptyTree);
  expect(d.files.map((f) => [f.kind, f.rel])).toEqual([['A', 'a.txt']]);
});

test('a repository with no commits and one with a detached HEAD', async () => {
  const empty = tmp('atl-scm-empty-');
  git(empty, 'init', '-q', '-b', 'trunk');
  const r = await readRefs(empty);
  expect(r).toMatchObject({ head: { branch: 'trunk', oid: null, detached: false }, refs: [] });
  expect((await readLog(empty, ALL, r, { skip: 0, count: 10 })).commits).toEqual([]);
  const det = tmp('atl-scm-det-');
  const ids = historyRepo(det);
  git(det, 'checkout', '-q', '--detach', ids.c2);
  expect((await readRefs(det)).head).toEqual({ branch: null, oid: ids.c2, detached: true });
  expect((await readRefs(join(det, 'nope'))).error).toBeTruthy();
});

test('a branch named like a tag is still named as itself; a reftable repo with no commits names its branch', async () => {
  const repo = tmp('atl-scm-amb-');
  const ids = historyRepo(repo);
  git(repo, 'switch', '-q', '-c', 'release/1.0');
  git(repo, 'tag', 'release/1.0', ids.c2);
  expect((await readRefs(repo)).head).toMatchObject({ branch: 'release/1.0', detached: false });
  // git 3's default ref storage: HEAD's file is a stub (refs/heads/.invalid), the branch lives in reftable.
  const table = tmp('atl-scm-reftable-');
  git(table, 'init', '-q', '-b', 'fresh', '--ref-format=reftable');
  expect((await readRefs(table)).head).toEqual({ branch: 'fresh', oid: null, detached: false });
});

test('a hex filter word that is a branch or tag name searches the text, never jumps to that ref', async () => {
  const repo = tmp('atl-scm-hexref-');
  const ids = historyRepo(repo);
  git(repo, 'tag', 'feed', ids.c2);
  git(repo, 'branch', 'cafe', ids.c1);
  expect(await resolveCommit(repo, 'feed')).toBeNull();
  expect(await resolveCommit(repo, 'cafe')).toBeNull();
  expect(await resolveCommit(repo, ids.c2.slice(0, 8))).toBe(ids.c2);
  const refs = await readRefs(repo);
  // Searched as text: no commit says "feed", so none is listed (a jump would have kept the whole list).
  expect((await readLog(repo, ALL, refs, { skip: 0, count: 400, filter: 'feed' })).commits).toEqual([]);
});

test('a commit whose subject holds a record separator never ends the list early', async () => {
  const repo = tmp('atl-scm-rs-');
  git(repo, 'init', '-q', '-b', 'main');
  for (let i = 0; i < 5; i++) commit(repo, i === 2 ? 'odd \x1e subject' : `c${i}`, { 'a.ts': `${i}\n` });
  const refs = await readRefs(repo);
  const first = await readLog(repo, ALL, refs, { skip: 0, count: 3 });
  // A full page (the odd record included or not) is never the last one.
  expect(first.done).toBe(false);
  const rest = await readLog(repo, ALL, refs, { skip: 3, count: 3 });
  expect([...first.commits, ...rest.commits].map((c) => c.subject)).toEqual(expect.arrayContaining(['c4', 'c3', 'c1', 'c0']));
  expect(rest.done).toBe(true);
});

describe('50 000 commits', () => {
  // The budgets are macOS's. A Windows runner (process start, NTFS, Defender scanning git's reads) took 559 ms for the
  // first page in the 2026-10-26 nightly: the same read, so twice the budget there.
  const budget = (ms: number) => (isWin ? 2 * ms : ms);
  let repo = '';
  let refs: ScmRefs;
  beforeAll(async () => {
    repo = tmp('atl-scm-big-');
    bigRepo(repo, 50_000);
    refs = await readRefs(repo);
  }, 60_000);

  test('first page within budget; a page deep in the list too', async () => {
    const p = await readLog(repo, ALL, refs, { skip: 0, count: 400 });
    expect(p.commits).toHaveLength(400);
    expect(await bestTimeAsync(() => readLog(repo, ALL, refs, { skip: 0, count: 400 }), 3)).toBeLessThan(budget(400));
    const deep = await readLog(repo, ALL, refs, { skip: 19_600, count: 400 });
    expect(await bestTimeAsync(() => readLog(repo, ALL, refs, { skip: 19_600, count: 400 }), 3)).toBeLessThan(budget(600));
    expect(deep.commits).toHaveLength(400);
    expect(deep.capped).toBe(true);
    expect((await readLog(repo, ALL, refs, { skip: 20_000, count: 400 })).commits).toEqual([]);
  });

  test('an aborted read rejects', async () => {
    const ac = new AbortController();
    const p = readLog(repo, ALL, refs, { skip: 0, count: 4000, signal: ac.signal });
    ac.abort();
    await expect(p).rejects.toThrow(/abort/);
  });
});

test('a tracked file named like a ref (HEAD, a branch path) never makes the history ambiguous', async () => {
  const repo = tmp('atl-scm-amb-');
  const ids = historyRepo(repo);
  commit(repo, 'track a HEAD file', { HEAD: 'not a ref\n', 'refs/heads/main': 'nor this\n' });
  const refs = await readRefs(repo);
  const all = await readLog(repo, ALL, refs, { skip: 0, count: 50 });
  expect(all.error).toBeUndefined();
  expect(all.commits.length).toBe(7);
  const main = await readLog(repo, { kind: 'refs', refs: 'refs/heads/main', firstParent: false }, refs, { skip: 0, count: 50 });
  expect(main.error).toBeUndefined();
  expect(main.commits).toHaveLength(7);
  expect(await locateCommit(repo, ALL, refs, ids.c2)).not.toBeNull();
  // A path filter still works next to the separator.
  expect((await readLog(repo, ALL, refs, { skip: 0, count: 50, filter: 'path:dir' })).commits.map((c) => c.oid)).toEqual([ids.f1, ids.c1]);
});

test('the author filter ignores case and takes the name literally', async () => {
  const repo = tmp('atl-scm-auth-');
  historyRepo(repo);
  const refs = await readRefs(repo);
  expect((await readLog(repo, ALL, refs, { skip: 0, count: 50, filter: '@ada' })).commits).toHaveLength(6);
  const odd = await readLog(repo, ALL, refs, { skip: 0, count: 50, filter: '@ada[' });
  expect(odd.error).toBeUndefined();
  expect(odd.commits).toEqual([]);
});

test('a file too large to show still says how large it is', async () => {
  const repo = tmp('atl-scm-size-');
  git(repo, 'init', '-q');
  const c = commit(repo, 'big', { 'big.txt': 'x'.repeat(3 * 1024 * 1024) });
  expect(await readBlob(repo, c, 'big.txt')).toEqual({ kind: 'tooLarge', size: 3 * 1024 * 1024 });
});
