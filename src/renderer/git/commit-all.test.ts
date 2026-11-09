import { describe, expect, test } from 'vitest';
import type { GitFacts, GitOpResult } from '@shared/git-write';
import {
  askSession, cardInfo, commitAllBar, commitBlock, createCommitAll, fixPrompt, logLines, nextRun, nextWrites, progress, pushEnded, pushPlan,
  pushStarted, pushTargets, queueWrites, retry, runEnded, runStarted, shouldAutoPush, startRun, stopAfterThisOne, summary, undoAllDone,
  undoTargets, writeChunk, writeDone, writeFailed, writeProgress, writesStopped, writeStarted, writeTargets, type CommitAllState
} from './commit-all';

// Commit all's pure model: cards in Changes' order, what blocks
// the commit, the sequential run with Stop After This One, results, Retry of one, pushes only once every included
// repository committed, ✦ Write All two at a time.

const ok = (sha: string): GitOpResult => ({ outcome: 'ok', sha, undo: { oid: sha } });
const hook: GitOpResult = { outcome: 'hook', hook: 'pre-commit', message: 'pre-commit failed', output: 'lint: 1 problem\n' };
const staged = (counts: Record<string, number> = {}) => (root: string) => counts[root] ?? 1;

function make(o: Partial<Parameters<typeof createCommitAll>[0]> = {}): CommitAllState {
  return createCommitAll({
    roots: ['/p/a', '/p/b', '/p/c'], order: ['/p/a', '/p/b', '/p/c'], drafts: {}, mode: 'per-repo', pushAfter: false, coAuthor: true, session: null, ...o
  });
}
const withMessages = (s: CommitAllState): CommitAllState => ({ ...s, cards: s.cards.map((c) => ({ ...c, message: `fix: ${c.root.slice(3)}` })) });
const run = (s: CommitAllState, results: Record<string, GitOpResult>): CommitAllState => {
  let x = s;
  for (let root = nextRun(x); root; root = nextRun(x)) x = runEnded(runStarted(x, root, 0), root, results[root] ?? ok(`${root.slice(3)}sha`));
  return x;
};

describe('cards', () => {
  test("in Changes' order whatever order they were asked in, drafts as messages, included, editing", () => {
    const s = make({ roots: ['/p/c', '/p/x', '/p/a'], order: ['/p/a', '/p/b', '/p/c'], drafts: { '/p/c': 'feat: c' } });
    expect(s.cards.map((c) => c.root)).toEqual(['/p/a', '/p/c', '/p/x']);
    expect(s.cards.map((c) => c.message)).toEqual(['', 'feat: c', '']);
    expect(s.cards.every((c) => c.include)).toBe(true);
    expect(s).toMatchObject({ open: true, phase: 'edit', stopAfter: false, mode: 'per-repo', coAuthor: true, pushAfter: false });
  });

  test('commit is blocked without an included repository with staged files, or a message (per repository or the one)', () => {
    let s = make();
    expect(commitBlock(s, staged())).toEqual({ kind: 'message', root: '/p/a' });
    s = withMessages(s);
    expect(commitBlock(s, staged())).toBeNull();
    s = { ...s, cards: s.cards.map((c) => (c.root === '/p/b' ? { ...c, message: '  ' } : c)) };
    expect(commitBlock(s, staged())).toEqual({ kind: 'message', root: '/p/b' });
    // Left out, or nothing staged there any more: its message doesn't matter.
    expect(commitBlock({ ...s, cards: s.cards.map((c) => (c.root === '/p/b' ? { ...c, include: false } : c)) }, staged())).toBeNull();
    expect(commitBlock(s, staged({ '/p/b': 0 }))).toBeNull();
    expect(commitBlock(s, staged({ '/p/a': 0, '/p/b': 0, '/p/c': 0 }))).toEqual({ kind: 'none' });
    // One message: only that one counts.
    expect(commitBlock({ ...make(), mode: 'one', message: '' }, staged())).toEqual({ kind: 'message', root: null });
    expect(commitBlock({ ...make(), mode: 'one', message: 'chore: bump' }, staged())).toBeNull();
  });
});

describe('the run', () => {
  test('sequential in the cards order, only the included ones with staged files, then results', () => {
    let s = startRun({ ...withMessages(make()), cards: withMessages(make()).cards.map((c) => (c.root === '/p/b' ? { ...c, include: false } : c)) }, staged());
    expect(s.phase).toBe('running');
    expect(s.cards.map((c) => c.run?.kind)).toEqual(['waiting', undefined, 'waiting']);
    // What it set out to commit, for the header once the commits have emptied the index.
    expect(startRun(withMessages(make()), staged({ '/p/a': 2, '/p/b': 3, '/p/c': 0 })).files).toBe(5);
    expect(nextRun(s)).toBe('/p/a');
    s = runStarted(s, '/p/a', 100);
    expect(nextRun(s)).toBeNull();
    expect(progress(s)).toEqual({ done: 0, total: 2, current: 1 });
    s = runEnded(s, '/p/a', ok('aaa'));
    expect(s.phase).toBe('running');
    expect(nextRun(s)).toBe('/p/c');
    s = runEnded(runStarted(s, '/p/c', 200), '/p/c', ok('ccc'));
    expect(s.phase).toBe('results');
    expect(summary(s)).toEqual({ committed: 2, total: 2 });
    expect(startRun(withMessages(make()), staged({ '/p/b': 0 })).cards.map((c) => c.run?.kind)).toEqual(['waiting', undefined, 'waiting']);
  });

  test('Stop After This One lets the running repository finish and skips the rest', () => {
    let s = startRun(withMessages(make()), staged());
    s = runStarted(s, '/p/a', 0);
    s = stopAfterThisOne(s);
    expect(nextRun(s)).toBeNull();
    s = runEnded(s, '/p/a', ok('aaa'));
    expect(s.phase).toBe('results');
    expect(s.cards.map((c) => c.run?.kind)).toEqual(['committed', 'skipped', 'skipped']);
    expect(summary(s)).toEqual({ committed: 1, total: 3 });
    // Only while running.
    expect(stopAfterThisOne(withMessages(make()))).toEqual(withMessages(make()));
  });

  test('a failure keeps the others going; the one message is the same for every repository', () => {
    const s = run(startRun(withMessages(make()), staged()), { '/p/b': hook });
    expect(s.cards.map((c) => c.run?.kind)).toEqual(['committed', 'failed', 'committed']);
    expect(s.cards[1]!.run).toEqual({ kind: 'failed', result: hook });
    expect(summary(s)).toEqual({ committed: 2, total: 3 });
    const one = { ...make(), mode: 'one' as const, message: 'chore: bump' };
    expect(startRun(one, staged()).cards.map((c) => c.message)).toEqual(['chore: bump', 'chore: bump', 'chore: bump']);
  });

  test('Retry reruns that repository alone (with or without hooks), the others keep their results', () => {
    let s = run(startRun(withMessages(make()), staged()), { '/p/b': hook });
    s = retry(s, '/p/b', true);
    expect(s.phase).toBe('running');
    expect(s.cards.map((c) => c.run?.kind)).toEqual(['committed', 'waiting', 'committed']);
    expect(s.cards[1]!.noVerify).toBe(true);
    expect(nextRun(s)).toBe('/p/b');
    s = runEnded(runStarted(s, '/p/b', 0), '/p/b', ok('bbb'));
    expect(s.phase).toBe('results');
    expect(summary(s)).toEqual({ committed: 3, total: 3 });
    // A committed one is never retried.
    expect(retry(s, '/p/a', false)).toBe(s);
  });

  test('"nothing to commit" and a missing sha are failures, never a commit', () => {
    let s = startRun(withMessages(make({ roots: ['/p/a'] })), staged());
    s = runEnded(runStarted(s, '/p/a', 0), '/p/a', { outcome: 'nothing' });
    expect(s.cards[0]!.run?.kind).toBe('failed');
    let t = startRun(withMessages(make({ roots: ['/p/a'] })), staged());
    t = runEnded(runStarted(t, '/p/a', 0), '/p/a', { outcome: 'ok' });
    expect(t.cards[0]!.run?.kind).toBe('failed');
  });

  test('the bar while the sheet is closed: "Committing 2 of 3…", or results with a failure left to retry; else nothing', () => {
    let s = startRun(withMessages(make()), staged());
    s = runEnded(runStarted(s, '/p/a', 0), '/p/a', ok('aaa'));
    s = runStarted(s, '/p/b', 0);
    expect(commitAllBar(s)).toBeNull();
    expect(commitAllBar({ ...s, open: false })).toEqual({ kind: 'running', done: 1, total: 3, current: 2 });
    expect(commitAllBar({ ...make(), open: false })).toBeNull();
    expect(commitAllBar(null)).toBeNull();
    expect(commitAllBar({ ...run(runEnded(s, '/p/b', ok('bbb')), {}), open: false })).toBeNull();
    expect(commitAllBar({ ...run(runEnded(s, '/p/b', hook), {}), open: false })).toEqual({ kind: 'results', committed: 2, total: 3 });
  });
});

describe('push after committing', () => {
  test('automatic only when every included repository committed and Push after committing is on', () => {
    const all = run(startRun({ ...withMessages(make()), pushAfter: true }, staged()), {});
    expect(shouldAutoPush(all)).toBe(true);
    expect(pushTargets(all)).toEqual(['/p/a', '/p/b', '/p/c']);
    expect(shouldAutoPush({ ...all, pushAfter: false })).toBe(false);
    const some = run(startRun({ ...withMessages(make()), pushAfter: true }, staged()), { '/p/b': hook });
    expect(shouldAutoPush(some)).toBe(false);
    // The button waits with the committed ones.
    expect(pushTargets(some)).toEqual(['/p/a', '/p/c']);
    // Retry made it whole: now they push.
    const fixed = runEnded(runStarted(retry(some, '/p/b', false), '/p/b', 0), '/p/b', ok('bbb'));
    expect(shouldAutoPush(fixed)).toBe(true);
    // Stopped after one: the skipped ones count as not committed.
    let stopped = runStarted(startRun({ ...withMessages(make()), pushAfter: true }, staged()), '/p/a', 0);
    stopped = runEnded(stopAfterThisOne(stopped), '/p/a', ok('aaa'));
    expect(shouldAutoPush(stopped)).toBe(false);
    // Never while still running.
    expect(shouldAutoPush(runStarted(startRun({ ...withMessages(make()), pushAfter: true }, staged()), '/p/a', 0))).toBe(false);
  });

  test('pushed and running ones are not pushed again; a failed push can be retried from the button, never automatically', () => {
    let s = run(startRun({ ...withMessages(make()), pushAfter: true }, staged()), {});
    s = pushStarted(s, '/p/a');
    expect(pushTargets(s)).toEqual(['/p/b', '/p/c']);
    s = pushEnded(s, '/p/a', { outcome: 'ok' }, 'origin/main', false);
    s = pushEnded(pushStarted(s, '/p/b'), '/p/b', { outcome: 'network', message: 'offline' }, 'origin/main', false);
    expect(s.cards.map((c) => c.push?.kind)).toEqual(['pushed', 'failed', undefined]);
    expect(s.cards[0]!.push).toEqual({ kind: 'pushed', to: 'origin/main', published: false });
    expect(pushTargets(s)).toEqual(['/p/b', '/p/c']);
    expect(shouldAutoPush(s)).toBe(true);
    expect(pushTargets(s, { auto: true })).toEqual(['/p/c']);
  });

  test('a branch without an upstream publishes to its only remote, asks with several, and has nowhere to go without one', () => {
    const f = (o: Partial<GitFacts>) => ({ branch: 'feat', upstream: null, remotes: ['origin'], detached: false, ...o });
    expect(pushPlan(f({ upstream: 'origin/feat' }))).toEqual({ kind: 'push' });
    expect(pushPlan(f({}))).toEqual({ kind: 'publish', remote: 'origin' });
    // Tracking a branch of another name (made from origin/main): published as its own, never pushed to main.
    expect(pushPlan(f({ upstream: 'origin/main' }))).toEqual({ kind: 'publish', remote: 'origin' });
    expect(pushPlan(f({ remotes: ['origin', 'fork'] }))).toEqual({ kind: 'ask', remotes: ['origin', 'fork'] });
    expect(pushPlan(f({ remotes: [] }))).toEqual({ kind: 'none' });
    // Detached: git answers (a plain push that explains itself).
    expect(pushPlan(f({ branch: null, detached: true }))).toEqual({ kind: 'push' });
    expect(pushPlan(undefined)).toEqual({ kind: 'push' });
  });
});

describe('Undo All', () => {
  test('every committed repository with an Undo, not the pushed ones; all undone goes back to editing with the messages', () => {
    let s = run(startRun(withMessages(make()), staged()), { '/p/b': hook });
    expect(undoTargets(s)).toEqual([{ root: '/p/a', oid: 'asha' }, { root: '/p/c', oid: 'csha' }]);
    expect(undoTargets(pushEnded(s, '/p/a', { outcome: 'ok' }, 'origin/main', false))).toEqual([{ root: '/p/c', oid: 'csha' }]);
    s = undoAllDone(s, ['/p/a', '/p/c']);
    expect(s.phase).toBe('edit');
    expect(s.cards.map((c) => [c.run, c.push])).toEqual([[undefined, undefined], [undefined, undefined], [undefined, undefined]]);
    expect(s.cards.map((c) => c.message)).toEqual(['fix: a', 'fix: b', 'fix: c']);
  });

  test('some could not be undone: results stay, the undone ones say so', () => {
    let s = run(startRun(withMessages(make()), staged()), {});
    s = undoAllDone(s, ['/p/a']);
    expect(s.phase).toBe('results');
    expect(s.cards.map((c) => c.run?.kind)).toEqual(['undone', 'committed', 'committed']);
    expect(summary(s)).toEqual({ committed: 2, total: 3 });
  });
});

describe('✦ Write All', () => {
  test('writes every empty message of the included cards, at most two at a time, "N of M written"', () => {
    let s = make({ drafts: { '/p/b': 'feat: b' }, roots: ['/p/a', '/p/b', '/p/c', '/p/d'], order: ['/p/a', '/p/b', '/p/c', '/p/d'] });
    s = { ...s, cards: s.cards.map((c) => (c.root === '/p/d' ? { ...c, include: false } : c)) };
    expect(writeTargets(s)).toEqual(['/p/a', '/p/c']);
    s = make({ roots: ['/p/a', '/p/b', '/p/c', '/p/d'], order: ['/p/a', '/p/b', '/p/c', '/p/d'] });
    s = queueWrites(s, writeTargets(s));
    expect(writeProgress(s)).toEqual({ done: 0, total: 4 });
    expect(nextWrites(s)).toEqual(['/p/a', '/p/b']);
    s = writeStarted(writeStarted(s, '/p/a'), '/p/b');
    expect(nextWrites(s)).toEqual([]);
    s = writeChunk(s, '/p/a', 'feat: ');
    s = writeChunk(s, '/p/a', 'a');
    expect(s.cards[0]!.message).toBe('feat: a');
    s = writeDone(s, '/p/a', 'feat(a): the whole message');
    expect(s.cards[0]).toMatchObject({ message: 'feat(a): the whole message', write: 'written' });
    expect(writeProgress(s)).toEqual({ done: 1, total: 4 });
    expect(nextWrites(s)).toEqual(['/p/c']);
    s = writeStarted(s, '/p/c');
    s = writeChunk(s, '/p/b', 'half');
    s = writeFailed(s, '/p/b');
    // A failure leaves the field as it was before ✦.
    expect(s.cards[1]).toMatchObject({ message: '', write: 'failed' });
    expect(nextWrites(s)).toEqual(['/p/d']);
    s = writeDone(writeStarted(s, '/p/d'), '/p/d', 'feat: d');
    s = writeDone(s, '/p/c', 'feat: c');
    expect(writeProgress(s)).toBeNull();
    // Nothing more to write: Write All again would only take the failed one.
    expect(writeTargets(s)).toEqual(['/p/b']);
  });

  test('never in one-message mode; never a card already being written; a new Write All forgets the last one', () => {
    expect(writeTargets({ ...make(), mode: 'one' })).toEqual([]);
    let s = queueWrites(make(), ['/p/a']);
    s = writeStarted(s, '/p/a');
    expect(writeTargets(s)).toEqual(['/p/b', '/p/c']);
    s = queueWrites(writeDone(s, '/p/a', ''), ['/p/b']);
    expect(s.cards.map((c) => c.write)).toEqual([undefined, 'queued', undefined]);
    expect(nextWrites(s, 2)).toEqual(['/p/b']);
  });

  test('Stop: the queued and half-written ones go back to empty, the written ones stay', () => {
    let s = queueWrites(make(), ['/p/a', '/p/b', '/p/c']);
    s = writeDone(writeStarted(s, '/p/a'), '/p/a', 'feat: a');
    s = writeChunk(writeStarted(s, '/p/b'), '/p/b', 'feat: h');
    s = writesStopped(s);
    expect(s.cards.map((c) => [c.write, c.message])).toEqual([['written', 'feat: a'], ['failed', ''], ['failed', '']]);
    expect(writeProgress(s)).toBeNull();
    expect(nextWrites(s)).toEqual([]);
  });
});

describe('cards and failures', () => {
  const by = (terminalId: string, title: string, o: { maybe?: true } = {}) => ({ terminalId, title, color: '#fff', ...o });
  const row = (rel: string, stage: 'none' | 'all' | 'partial', b: ReturnType<typeof by>[] = [], added = 2, removed = 1) =>
    ({ path: `/p/a/${rel}`, rel, stage, added, removed, by: b });

  test('counts of the staged files, overlaps "also changed by", files staged that are not the session\'s, live edits', () => {
    const rows = [
      row('src/a.ts', 'all', [by('t1', 'auth-refactor')]),
      row('src/b.ts', 'partial', [by('t1', 'auth-refactor'), by('t2', 'billing-tests')], 30, 6),
      row('src/c.ts', 'all', [by('t3', 'other', { maybe: true })]),
      row('src/d.ts', 'none', [by('t1', 'auth-refactor')]),
      row('img.png', 'all', [], null as unknown as number, null as unknown as number)
    ];
    const live = new Map([['/p/a/src/b.ts', { terminalId: 't2', title: 'billing-tests', color: '#fff' }]]);
    const info = cardInfo({ rows, session: 't1', live });
    expect(info.files.map((f) => f.rel)).toEqual(['src/a.ts', 'src/b.ts', 'src/c.ts', 'img.png']);
    expect([info.added, info.removed]).toEqual([34, 8]);
    expect(info.files.map((f) => f.also)).toEqual([[], ['billing-tests'], [], []]);
    expect(info.alsoStaged).toBe(2);
    expect(info.live).toEqual({ title: 'billing-tests', n: 1, rel: 'src/b.ts' });
    // Without a session: no overlap marks, nothing "also staged".
    const plain = cardInfo({ rows, session: null, live: new Map() });
    expect(plain.files.every((f) => f.also.length === 0)).toBe(true);
    expect(plain.alsoStaged).toBe(0);
    expect(plain.live).toBeNull();
  });

  test('who is asked to fix: the sheet\'s session, else the one that surely changed most of the staged files', () => {
    const rows = [row('a', 'all', [by('t2', 'x')]), row('b', 'all', [by('t3', 'y')]), row('c', 'all', [by('t3', 'y')]), row('d', 'none', [by('t2', 'x'), by('t9', 'z')]), row('e', 'all', [by('t9', 'z', { maybe: true })])];
    expect(askSession(rows, 't1')).toBe('t1');
    expect(askSession(rows, null)).toBe('t3');
    expect(askSession([row('a', 'all')], null)).toBeNull();
  });

  test('the log\'s first lines, and the prompt typed into the session', () => {
    expect(logLines('\n\nlint: one\nlint: two\nthree\n\n', 2)).toEqual({ lines: ['lint: one', 'lint: two'], more: 1 });
    const p = fixPrompt({ path: 'plugins/payments', result: { ...hook, output: 'lint: src/a.ts:1 missing semicolon\nlint: 1 problem\n' } });
    expect(p).toContain('pre-commit hook failed in plugins/payments');
    expect(p).toContain('lint: src/a.ts:1 missing semicolon\nlint: 1 problem');
    expect(p).toMatch(/don't commit/i);
    expect(fixPrompt({ path: 'billing', result: { outcome: 'error', message: 'fatal: bad object' } })).toContain('fatal: bad object');
    // Long output: the first 30 lines only.
    const long = fixPrompt({ path: 'x', result: { ...hook, output: Array.from({ length: 50 }, (_, i) => `line ${i}`).join('\n') } });
    expect(long).toContain('line 29');
    expect(long).not.toContain('line 30');
  });
});
