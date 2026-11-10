import { expect, test } from 'vitest';
import type { ScmFetchState, ScmRef, ScmRefs, ScmRepoEntry, ScmRepoStatus } from '@shared/scm';
import { branchLine, branchTip, conventional, cursorIndex, fetchChip, isClaude, personColor, refPills, refSections, refsByOid, remoteLag, repoLabel, scopeTitle, shortRef, switcherGroups } from './view';
import { bestTime } from '../../../tests/support/timing';

const st = (o: Partial<ScmRepoStatus> = {}): ScmRepoStatus => ({ branch: 'main', detached: false, oid: 'a'.repeat(40), ahead: 0, behind: 0, upstream: 'origin/main', changes: 0, ...o });
const entry = (rel: string, o: Partial<ScmRepoEntry> = {}): ScmRepoEntry => ({ root: rel ? `/p/${rel}` : '/p', rel, name: rel ? rel.split('/').at(-1)! : 'p', worktreeOf: null, common: `/p/${rel}/.git`, status: st(), ...o });
const ref = (name: string, o: Partial<ScmRef> = {}): ScmRef => {
  const kind = name.startsWith('refs/heads/') ? 'head' : name.startsWith('refs/remotes/') ? 'remote' : 'tag';
  const short = shortRef(name);
  return { name, short, kind, ...(kind === 'remote' ? { remote: short.split('/')[0] } : {}), oid: 'a'.repeat(40), upstream: null, ahead: 0, behind: 0, gone: false, current: false, date: 0, ...o };
};
const refsOf = (list: ScmRef[], o: Partial<ScmRefs> = {}): ScmRefs => ({ root: '/p', head: { branch: 'main', oid: 'a'.repeat(40), detached: false }, refs: list, defaultBranch: { ref: 'main', base: 'main' }, shallow: false, fetchedAt: null, remotes: [...new Set(list.flatMap((r) => (r.remote ? [r.remote] : [])))], hasRemote: list.some((r) => r.kind === 'remote'), emptyTree: '', ...o });

test('repoLabel: folder and name; the root by its name; a hidden worktree as "owner › name" with a worktree note', () => {
  expect(repoLabel(entry('plugins/clickup'))).toEqual({ dir: 'plugins/', name: 'clickup', note: null });
  expect(repoLabel(entry(''))).toEqual({ dir: '', name: 'p', note: null });
  expect(repoLabel(entry('.worktrees/v2.2', { worktreeOf: '/p' }))).toEqual({ dir: 'p › ', name: 'v2.2', note: 'worktree' });
});

test('branchLine: short enough for the sidebar; branchTip says it in full', () => {
  expect(branchLine(st())).toBe('main · synced');
  expect(branchLine(st({ branch: 'feat/x', upstream: 'origin/feat/x', ahead: 4 }))).toBe('feat/x · ↑4');
  expect(branchLine(st({ behind: 2 }))).toBe('main · ↓2');
  expect(branchLine(st({ ahead: 2, behind: 1 }))).toBe('main · ↑2 ↓1');
  expect(branchLine(st({ upstream: null }))).toBe('main · local');
  expect(branchLine(st({ branch: null, detached: true, oid: 'f0d6c52'.padEnd(40, '0') }))).toBe('detached · f0d6c52');
  expect(branchLine(st({ oid: null, upstream: null }))).toBe('main · no commits');
  expect(branchLine(null)).toBe('');
  expect(branchTip(st())).toBe('main, in sync with origin/main');
  expect(branchTip(st({ ahead: 4, behind: 1 }))).toBe('main, 4 commits ahead and 1 behind origin/main');
  expect(branchTip(st({ upstream: null }))).toBe('main, no upstream branch (local only)');
  expect(branchTip(st({ branch: null, detached: true, oid: 'f0d6c52'.padEnd(40, '0') }))).toBe('Detached HEAD at f0d6c52');
  // The upstream's remote branch is gone (a merged PR's, deleted and pruned): never "synced".
  const gone = st({ branch: 'feat/x', upstream: 'origin/feat/x', upstreamGone: true });
  expect(branchLine(gone)).toBe('feat/x · upstream gone');
  expect(branchTip(gone)).toBe('feat/x, its upstream origin/feat/x is gone from the remote');
  // Tracking a branch of another name (made from origin/main): its counts are against main, not its own.
  const other = st({ branch: 'feat/x', upstream: 'origin/main', ahead: 3 });
  expect(branchLine(other)).toBe('feat/x · tracks origin/main');
  expect(branchTip(other)).toBe('feat/x tracks origin/main, a branch of another name: publish it as its own branch');
});

test('cursorIndex: the highlighted repository stays highlighted when the list reorders under it; else the first row', () => {
  const rows = (...rels: string[]) => rels.map((rel) => ({ entry: entry(rel), match: [], sessions: [] }));
  expect(cursorIndex(rows('a', 'b', 'c'), '/p/b')).toBe(1);
  // A session got busy in c: Active reordered, b moved, the cursor with it.
  expect(cursorIndex(rows('c', 'a', 'b'), '/p/b')).toBe(2);
  expect(cursorIndex(rows('a', 'c'), '/p/b')).toBe(0);
  expect(cursorIndex(rows(), '/p/b')).toBe(0);
});

test('switcherGroups: selected first, then dirty or busy by latest session activity then name, the rest by path', () => {
  const list = [entry(''), entry('apps/web'), entry('apps/api', { status: st({ changes: 3 }) }), entry('plugins/clickup'), entry('plugins/a'), entry('tools/z')];
  const sessions = [{ id: 's1', title: 'Alfa', color: '#fff', cwd: '/p/plugins/clickup/src', at: 50 }, { id: 's2', title: 'Beta', color: '#000', cwd: '/p/tools/z', at: 90 }, { id: 's3', title: 'Root', color: '#111', cwd: '/p/docs', at: 10 }];
  const g = switcherGroups(list, '/p/apps/web', sessions, '');
  expect(g.active.map((r) => r.entry.rel)).toEqual(['apps/web', 'tools/z', 'plugins/clickup', '', 'apps/api']);
  expect(g.all.map((r) => r.entry.rel)).toEqual(['plugins/a']);
  expect(g.active.find((r) => r.entry.rel === 'plugins/clickup')!.sessions.map((s) => s.id)).toEqual(['s1']);
  // The deepest repo takes a session: /p/docs belongs to the root, not to anything nested.
  expect(g.active.find((r) => r.entry.rel === '')!.sessions.map((s) => s.id)).toEqual(['s3']);
  expect(g.total).toBe(6);
});

test('switcherGroups: a worktree is found by the name shown or by its path', () => {
  const list = [entry(''), entry('.worktrees/scm-minors', { worktreeOf: '/p' })];
  expect(switcherGroups(list, '/p', [], 'p › scm').all.map((r) => [r.entry.rel, r.match])).toEqual([['.worktrees/scm-minors', [[0, 7]]]]);
  expect(switcherGroups(list, '/p', [], 'worktrees/scm').all.map((r) => [r.entry.rel, r.match])).toEqual([['.worktrees/scm-minors', []]]);
});

test('switcherGroups: the filter matches the path, case-insensitive, with the matched range', () => {
  const list = [entry(''), entry('apps/web'), entry('plugins/WebKit'), entry('tools/z')];
  const g = switcherGroups(list, '/p', [], 'WEB');
  expect([...g.active, ...g.all].map((r) => [r.entry.rel, r.match])).toEqual([['apps/web', [[5, 8]]], ['plugins/WebKit', [[8, 11]]]]);
  expect(switcherGroups(list, '/p', [], 'zzz').all).toEqual([]);
});

test('switcherGroups: 50 repositories group in well under a frame', () => {
  const list = Array.from({ length: 50 }, (_, i) => entry(`group${i % 5}/repo${i}`, { status: st({ changes: i % 7 === 0 ? 2 : 0 }) }));
  const ms = bestTime(() => { for (let i = 0; i < 10; i++) switcherGroups(list, list[3]!.root, [], i % 2 ? 'repo1' : ''); });
  expect(ms / 10).toBeLessThan(4);
});

test('refSections: current first then newest, remotes grouped without HEAD, tags newest first, limits with counts', () => {
  const refs = refsOf([
    ref('refs/heads/old', { date: 1 }), ref('refs/heads/main', { current: true, date: 5 }), ref('refs/heads/new', { date: 9 }),
    ref('refs/remotes/origin/main', { date: 5 }), ref('refs/remotes/origin/x', { date: 7 }), ref('refs/remotes/fork/y', { date: 3 }),
    ...Array.from({ length: 7 }, (_, i) => ref(`refs/tags/v${i}`, { date: i }))
  ]);
  const s = refSections(refs, { local: 2, remote: 30, tags: 5 });
  expect(s.local.map((r) => r.short)).toEqual(['main', 'new']);
  expect(s.more.local).toBe(1);
  expect(s.remotes.map((g) => [g.name, g.refs.map((r) => r.short)])).toEqual([['origin', ['origin/x', 'origin/main']], ['fork', ['fork/y']]]);
  expect(s.tags.map((r) => r.short)).toEqual(['v6', 'v5', 'v4', 'v3', 'v2']);
  expect(s.more.tags).toBe(2);
  expect(s.counts).toEqual({ local: 3, remote: 3, tags: 7 });
});

test('remoteLag: a remote branch the local one tracks shows how far behind the local it is', () => {
  const refs = refsOf([ref('refs/heads/main', { upstream: 'refs/remotes/origin/main', ahead: 2 }), ref('refs/remotes/origin/main'), ref('refs/remotes/origin/x')]);
  expect(remoteLag(refs.refs[1]!, refs)).toBe(2);
  expect(remoteLag(refs.refs[2]!, refs)).toBeNull();
});

test('refPills: HEAD branch first, then local, remote, tags; a detached HEAD gets its own pill', () => {
  const O = 'a'.repeat(40);
  const refs = refsOf([ref('refs/tags/v1', { oid: O }), ref('refs/remotes/origin/main', { oid: O }), ref('refs/heads/dev', { oid: O }), ref('refs/heads/main', { oid: O, current: true })]);
  expect(refPills(O, refsByOid(refs.refs), refs.head)).toEqual([
    { label: 'main', kind: 'head' }, { label: 'dev', kind: 'local' }, { label: 'origin/main', kind: 'remote' }, { label: 'v1', kind: 'tag' }]);
  expect(refPills(O, refsByOid([]), { branch: null, oid: O, detached: true })).toEqual([{ label: 'HEAD', kind: 'head' }]);
  expect(refPills('b'.repeat(40), refsByOid(refs.refs), refs.head)).toEqual([]);
});

test('conventional: a commit type prefix, or none', () => {
  expect(conventional('feat(scope): add x')).toEqual({ prefix: 'feat(scope):', rest: 'add x' });
  expect(conventional('fix!: break y')).toEqual({ prefix: 'fix!:', rest: 'break y' });
  expect(conventional("Merge branch 'feat/x'")).toEqual({ prefix: null, rest: "Merge branch 'feat/x'" });
  expect(conventional('Note: something')).toEqual({ prefix: null, rest: 'Note: something' });
});

test('isClaude and personColor', () => {
  expect(isClaude({ name: 'Claude', email: 'noreply@anthropic.com' })).toBe(true);
  expect(isClaude({ name: 'Claude Opus 5.5', email: 'x@y' })).toBe(true);
  expect(isClaude({ name: 'Ada', email: 'f@x.test' })).toBe(false);
  expect(personColor('f@x.test')).toMatch(/^var\(--person-[1-8]\)$/);
  expect(personColor('F@X.TEST')).toBe(personColor('f@x.test'));
});

test('fetchChip: never fetched, fresh, stale; nothing without a remote', () => {
  const now = Date.UTC(2026, 9, 11, 12);
  const remote = [ref('refs/remotes/origin/main')];
  expect(fetchChip(refsOf([]), undefined, now)).toBeNull();
  expect(fetchChip(refsOf(remote), undefined, now)).toMatchObject({ text: 'never fetched', tone: 'stale' });
  expect(fetchChip(refsOf(remote, { fetchedAt: now - 12 * 60_000 }), undefined, now)).toMatchObject({ text: 'origin fetched 12m ago', tone: 'fresh', tip: expect.stringContaining('Fetch now') });
  expect(fetchChip(refsOf(remote, { fetchedAt: now - 3 * 3600_000 }), undefined, now)).toMatchObject({ text: 'origin fetched 3h ago', tone: 'stale' });
  // A remote configured but never fetched has no remote branch yet: the chip is there, origin preferred.
  expect(fetchChip(refsOf([], { remotes: ['upstream', 'origin'], hasRemote: true }), undefined, now)).toMatchObject({ text: 'never fetched' });
  expect(fetchChip(refsOf([], { remotes: ['upstream'], hasRemote: true, fetchedAt: now - 60_000 }), undefined, now)).toMatchObject({ text: 'upstream fetched 1m ago' });
});

test('fetchChip: running, needs sign-in, failed; a later fetch (a terminal\'s) wins over an old failure', () => {
  const now = Date.UTC(2026, 9, 11, 12);
  const refs = refsOf([ref('refs/remotes/origin/main')], { fetchedAt: now - 20 * 60_000 });
  const state = (o: Partial<ScmFetchState>): ScmFetchState => ({ common: '/p/.git', running: false, last: null, ...o });
  expect(fetchChip(refs, state({ running: true }), now)).toMatchObject({ text: 'Fetching…', tone: 'running', tip: 'Fetching from your remotes…' });
  const auth = state({ last: { outcome: 'auth', at: now - 5 * 60_000, message: "Authentication failed for 'https://github.com/a/b.git/'" } });
  expect(fetchChip(refs, auth, now)).toEqual({ text: 'Fetch needs sign-in', tone: 'failed', tip: "Authentication failed for 'https://github.com/a/b.git/' · Click to try again" });
  const err = state({ last: { outcome: 'error', at: now - 3 * 60_000, message: 'boom' } });
  expect(fetchChip(refs, err, now)).toMatchObject({ text: 'Fetch failed · 3m ago', tone: 'failed', tip: 'boom · Click to try again' });
  expect(fetchChip(refs, state({ last: { outcome: 'error', at: now - 3 * 60_000 } }), now)?.tip).toBe('Click to try again');
  // Fetched in a terminal after the failure: the age again.
  expect(fetchChip({ ...refs, fetchedAt: now - 60_000 }, err, now)).toMatchObject({ text: 'origin fetched 1m ago', tone: 'fresh' });
  // Atelier's own fetch a minute ago wins over an older FETCH_HEAD the refs were read with.
  expect(fetchChip(refs, state({ last: { outcome: 'ok', at: now - 60_000 } }), now)).toMatchObject({ text: 'origin fetched 1m ago', tone: 'fresh' });
  expect(fetchChip({ ...refs, fetchedAt: now - 30_000 }, state({ last: { outcome: 'ok', at: now - 25 * 60_000 } }), now)).toMatchObject({ text: 'origin fetched just now' });
});

test('scopeTitle', () => {
  const refs = refsOf([ref('refs/heads/main'), ref('refs/tags/v0.2.0-beta.6')]);
  expect(scopeTitle({ kind: 'refs', refs: 'all', firstParent: false })).toBe('All branches');
  expect(scopeTitle({ kind: 'refs', refs: 'refs/tags/v0.2.0-beta.6', firstParent: false })).toBe('v0.2.0-beta.6');
  expect(scopeTitle({ kind: 'compare', base: 'refs/heads/main', head: 'refs/heads/feat/x' })).toBe('feat/x vs main');
  expect(scopeTitle({ kind: 'compare', base: 'f0d6c52'.padEnd(40, '1'), head: 'refs/heads/feat/x' })).toBe('feat/x vs f0d6c52');
  expect(refs.refs.length).toBe(2);
});
