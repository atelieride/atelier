import { expect, test } from 'vitest';
import type { FileChange, RepoStatus } from '@shared/git';
import type { GitFacts, GitOpEvent } from '@shared/git-write';
import type { ChangeBy } from '../changes';
import { AMEND_OFF, amendFollow, amendOffer, amendStart, barChoice, barView, commitBlock, coAuthorShown, drawerLog, drawerNotices, dragEnd, elapsed, liveHeight, logPreview, othersLine, subjectCount, DRAG_THRESHOLD, RESULT_MS } from './drawer';
import type { GitResultEntry, GitRunning } from './slice';

// The commit bar and drawer as data: the bar's states by precedence, the drawer's
// notices, the others line, Co-authored-by's visibility, the subject counter, when Commit is disabled, the handle.

const ch = (rel: string, stage: FileChange['stage'], root = '/p/acme-store'): FileChange => ({ path: `${root}/${rel}`, rel, kind: 'M', stage, added: 1, removed: 0 });
const repo = (name: string, ...stages: FileChange['stage'][]): Pick<RepoStatus, 'root' | 'name' | 'changes'> => {
  const root = `/p/${name}`;
  return { root, name, changes: stages.map((s, i) => ch(`f${i}.ts`, s, root)) };
};
const op = (o: Partial<GitRunning>): GitRunning => ({ id: 'op1', root: '/p/acme-store', op: 'commit', phase: 'running', startedAt: 100, output: '', ...o });
const facts = (o: Partial<GitFacts> = {}): GitFacts => ({
  root: '/p/acme-store', identity: true, state: null, detached: false, branch: 'main', head: 'a'.repeat(40), upstream: 'origin/main',
  headPushed: true, headIsMerge: false, headHasParent: true, headMessage: 'chore: start', hooks: { preCommit: false, commitMsg: false, prePush: false },
  gpgProgram: null, signs: false, gitVersion: [2, 50, 0], undo: null, remotes: ['origin'], ...o
});

const repos = [repo('acme-store', 'all', 'all', 'none'), repo('billing', 'all'), repo('payments', 'none'), repo('docs', 'partial', 'all')];
const base = { repos, ops: [] as GitRunning[], results: {} as Record<string, GitResultEntry>, drafts: {} as Record<string, string>, target: '/p/acme-store' };

test('the bar: nothing staged (dim), staged in one repository, staged in several (a count, never the names)', () => {
  expect(barView({ ...base, repos: [repo('acme-store', 'none'), repo('billing')] })).toEqual({ kind: 'nothing' });
  expect(barView({ ...base, repos: [repo('acme-store', 'all', 'partial', 'none'), repo('billing', 'none')] })).toEqual({ kind: 'staged', count: 2, repos: 1, name: 'acme-store' });
  expect(barView(base)).toEqual({ kind: 'staged', count: 5, repos: 3, name: 'acme-store' });
});

test("the bar: a saved draft for the target wins over the staged count, with the target's count and its first line", () => {
  const drafts = { '/p/acme-store': '\n  fix(cart): totals round half up  \n\nBody text', '/p/billing': 'other' };
  expect(barView({ ...base, drafts })).toEqual({ kind: 'draft', count: 2, text: 'fix(cart): totals round half up' });
  // A draft of another repository is not the target's.
  expect(barView({ ...base, drafts: { '/p/billing': 'other' } }).kind).toBe('staged');
  // A blank draft is none.
  expect(barView({ ...base, drafts: { '/p/acme-store': '  \n ' } }).kind).toBe('staged');
});

test('the bar: an unseen failure wins over drafts and counts; a seen one or one of another project does not', () => {
  const failed: GitResultEntry = { failed: { outcome: 'hook', hook: 'pre-commit' }, op: 'commit', at: 5, seen: false };
  expect(barView({ ...base, drafts: { '/p/acme-store': 'x' }, results: { '/p/acme-store': failed } })).toEqual({ kind: 'failed', root: '/p/acme-store', text: 'pre-commit failed · acme-store' });
  expect(barView({ ...base, results: { '/p/acme-store': { ...failed, seen: true } } }).kind).toBe('staged');
  expect(barView({ ...base, results: { '/elsewhere/x': failed } }).kind).toBe('staged');
  const push: GitResultEntry = { failed: { outcome: 'network' }, op: 'push', at: 9, seen: false };
  // The latest of two unseen failures.
  expect(barView({ ...base, results: { '/p/acme-store': failed, '/p/billing': push } })).toMatchObject({ text: 'Push failed · billing' });
  expect(barView({ ...base, results: { '/p/billing': { failed: { outcome: 'sign' }, op: 'commit', at: 1, seen: false } } })).toMatchObject({ text: 'Signing failed · billing' });
});

test('the bar: an op running in the project wins over everything, named by its phase; staging is too quick to show', () => {
  const failed: GitResultEntry = { failed: { outcome: 'hook', hook: 'pre-commit' }, op: 'commit', at: 5, seen: false };
  const run = (o: Partial<GitOpEvent>) => barView({ ...base, results: { '/p/acme-store': failed }, ops: [op(o)] });
  expect(run({ phase: 'hook', hook: 'pre-commit' })).toEqual({ kind: 'running', id: 'op1', text: 'Running pre-commit · acme-store', startedAt: 100 });
  expect(run({ phase: 'signing' })).toMatchObject({ text: 'Waiting for your signature…' });
  expect(run({ op: 'push', root: '/p/billing' })).toMatchObject({ text: 'Pushing billing…' });
  expect(run({ op: 'commit', phase: 'queued' })).toMatchObject({ text: 'Committing acme-store…' });
  expect(run({ op: 'stage' }).kind).toBe('failed');
  expect(run({ root: '/elsewhere/x' }).kind).toBe('failed');
  // Two at once: the one that started first.
  expect(barView({ ...base, ops: [op({ id: 'b', op: 'push', startedAt: 200 }), op({ id: 'a', startedAt: 50 })] })).toMatchObject({ id: 'a' });
});

test('elapsed time: seconds, then minutes', () => {
  expect(elapsed(0)).toBe('0s');
  expect(elapsed(4_900)).toBe('4s');
  expect(elapsed(59_999)).toBe('59s');
  expect(elapsed(61_000)).toBe('1:01');
  expect(elapsed(-5)).toBe('0s');
});

const live = (entries: [string, string][]) => new Map(entries.map(([path, title]) => [path, { terminalId: title, title, color: '#60A5FA' }]));
const notices = (o: Partial<Parameters<typeof drawerNotices>[0]> = {}) => drawerNotices({ target: '/p/acme-store', repos, facts: facts(), allFacts: {}, live: new Map(), results: {}, actedAt: 0, now: 1000, ...o });

test('notices: live names who is still editing a staged file of the target (never blocking); unstaged or other repos say nothing', () => {
  expect(notices({ live: live([['/p/acme-store/f0.ts', 'auth-refactor']]) })).toEqual([{ kind: 'live', text: 'auth-refactor is still editing f0.ts', color: '#60A5FA' }]);
  expect(notices({ live: live([['/p/acme-store/f0.ts', 'auth-refactor'], ['/p/acme-store/f1.ts', 'auth-refactor']]) })).toMatchObject([{ text: 'auth-refactor is still editing 2 of these files' }]);
  expect(notices({ live: live([['/p/acme-store/f0.ts', 'auth-refactor'], ['/p/acme-store/f1.ts', 'billing-tests']]) })).toMatchObject([{ text: 'auth-refactor and billing-tests are still editing 2 of these files' }]);
  expect(notices({ live: live([['/p/acme-store/f2.ts', 'auth-refactor'], ['/p/billing/f0.ts', 'x']]) })).toEqual([]);
});

test('notices: mid-operation and no identity block (with Open in Terminal); detached HEAD is allowed', () => {
  expect(notices({ facts: facts({ state: 'rebase' }) })).toEqual([{ kind: 'state', text: 'acme-store is in the middle of a rebase: finish it in the terminal', blocks: true }]);
  expect(notices({ facts: facts({ state: 'cherry-pick' }) })[0]).toMatchObject({ text: 'acme-store is in the middle of a cherry-pick: finish it in the terminal' });
  expect(notices({ facts: facts({ identity: false }) })).toEqual([{ kind: 'state', text: "Git doesn't know who you are: set user.name and user.email", blocks: true, terminal: '/p/acme-store' }]);
  expect(notices({ facts: facts({ detached: true, branch: null }) })).toEqual([{ kind: 'state', text: "Not on a branch: this commit won't belong to one", blocks: false }]);
  // Facts not read yet: nothing to say.
  expect(notices({ facts: undefined })).toEqual([]);
});

test('notices: the last commit of the project for 30 s, until the next op; at most two lines, the blocking ones kept', () => {
  const done: GitResultEntry = { sha: 'f0d6c52aa', at: 1000, undo: { oid: 'f0d6c52aa' } };
  const result = { kind: 'result', root: '/p/billing', sha: 'f0d6c52', text: 'f0d6c52 in billing', undo: { oid: 'f0d6c52aa' } };
  const offered = { '/p/billing': facts({ root: '/p/billing', undo: { oid: 'f0d6c52aa', files: [] } }) };
  expect(notices({ results: { '/p/billing': done }, allFacts: offered, now: 1000 + RESULT_MS - 1 })).toEqual([result]);
  expect(notices({ results: { '/p/billing': done }, now: 1000 + RESULT_MS })).toEqual([]);
  expect(notices({ results: { '/p/billing': done }, actedAt: 1001 })).toEqual([]);
  expect(notices({ results: { '/p/billing': { ...done, undo: null } } })).toMatchObject([{ undo: null }]);
  // The latest of two commits.
  expect(notices({ results: { '/p/billing': done, '/p/docs': { sha: 'bbbbbbbbb', at: 1001, undo: null } }, now: 1002 })).toMatchObject([{ root: '/p/docs' }]);
  // A failure of the target stays in the drawer as a line (its log is Task 13's).
  const failed: GitResultEntry = { failed: { outcome: 'hook', hook: 'pre-commit' }, op: 'commit', at: 5, seen: true };
  expect(notices({ results: { '/p/acme-store': failed } })).toEqual([{ kind: 'failed', root: '/p/acme-store', text: 'pre-commit failed · acme-store' }]);
  // Three candidates: live, a block and the result; the result gives way, the order stays live, state.
  const three = notices({ facts: facts({ state: 'merge' }), live: live([['/p/acme-store/f0.ts', 'a']]), results: { '/p/billing': done } });
  expect(three.map((n) => n.kind)).toEqual(['live', 'state']);
  // Two blocks and a live file: the blocks.
  expect(notices({ facts: facts({ state: 'merge', identity: false }), live: live([['/p/acme-store/f0.ts', 'a']]) }).map((n) => 'blocks' in n && n.blocks)).toEqual([true, true]);
});

test('the others line: files staged outside the target and in how many repositories', () => {
  expect(othersLine(repos, '/p/acme-store')).toEqual({ files: 3, repos: 2 });
  expect(othersLine(repos, '/p/docs')).toEqual({ files: 3, repos: 2 });
  expect(othersLine([repo('acme-store', 'all')], '/p/acme-store')).toBeNull();
});

test('Co-authored-by shows when a staged file of the target is surely by a Claude session (not unsure, not unstaged)', () => {
  const by = (o: Partial<ChangeBy> = {}): ChangeBy => ({ terminalId: 't1', color: '#fff', title: 'auth', ...o });
  expect(coAuthorShown([{ stage: 'all', by: [by()] }])).toBe(true);
  expect(coAuthorShown([{ stage: 'partial', by: [by()] }])).toBe(true);
  expect(coAuthorShown([{ stage: 'none', by: [by()] }, { stage: 'all', by: [] }])).toBe(false);
  expect(coAuthorShown([{ stage: 'all', by: [by({ maybe: true }), by({ unclear: ['t2'] })] }])).toBe(false);
});

test('the subject counter: the first line in characters, amber past 72 (never blocking)', () => {
  expect(subjectCount('')).toEqual({ n: 0, over: false });
  expect(subjectCount('fix: x\n\nbody that is very long')).toEqual({ n: 6, over: false });
  expect(subjectCount('é'.repeat(72))).toEqual({ n: 72, over: false });
  expect(subjectCount('🙂'.repeat(73))).toEqual({ n: 73, over: true });
});

test('Commit is disabled with a reason: no target, an op running, a blocking notice, nothing staged, an empty message', () => {
  const ok = { target: '/p/acme-store', name: 'acme-store', staged: 2, message: 'fix: x', running: false, notices: [] };
  expect(commitBlock(ok)).toBeNull();
  expect(commitBlock({ ...ok, target: null })).toBe('Nothing to commit');
  expect(commitBlock({ ...ok, running: true })).toBe('Git is working in acme-store');
  expect(commitBlock({ ...ok, notices: [{ kind: 'state', text: 'mid rebase', blocks: true }] })).toBe('mid rebase');
  expect(commitBlock({ ...ok, notices: [{ kind: 'state', text: 'detached', blocks: false }] })).toBeNull();
  expect(commitBlock({ ...ok, staged: 0 })).toBe('Nothing staged in acme-store');
  expect(commitBlock({ ...ok, message: ' \n ' })).toBe('Write a message first');
});

test('amend: nothing staged is a reword, allowed; a message is still needed', () => {
  const ok = { target: '/p/acme-store', name: 'acme-store', staged: 0, message: 'fix: x', running: false, notices: [], amend: true };
  expect(commitBlock(ok)).toBeNull();
  expect(commitBlock({ ...ok, message: '' })).toBe('Write a message first');
  expect(commitBlock({ ...ok, amend: false })).toBe('Nothing staged in acme-store');
});

test('notices: "Nothing staged · N changes" with Stage All, last of all, the first to give way', () => {
  expect(notices({ unstaged: 12 })).toEqual([{ kind: 'unstaged', text: 'Nothing staged · 12 changes', count: 12 }]);
  expect(notices({ unstaged: 1 })).toMatchObject([{ text: 'Nothing staged · 1 change' }]);
  expect(notices({ unstaged: 0 })).toEqual([]);
  // A block and a detached HEAD come first: the line gives way.
  expect(notices({ unstaged: 3, facts: facts({ state: 'merge', detached: true, branch: null }) }).map((n) => n.kind)).toEqual(['state', 'state']);
  // With the last commit's notice: both, the line after it.
  const done: GitResultEntry = { sha: 'f0d6c52aa', at: 1000, undo: null };
  expect(notices({ unstaged: 3, results: { '/p/billing': done } }).map((n) => n.kind)).toEqual(['result', 'unstaged']);
});

test('nothing staged with Stage All offered: Commit enabled in ask and stage-all, blocked in never', () => {
  const ok = { target: '/p/acme-store', name: 'acme-store', staged: 0, message: 'fix: x', running: false, notices: [] };
  const offered = (mode: 'ask' | 'stage-all' | 'never') => ({ ...ok, nothingStaged: { mode, offered: true, conflicts: false } });
  expect(commitBlock(offered('ask'))).toBeNull();
  expect(commitBlock(offered('stage-all'))).toBeNull();
  expect(commitBlock(offered('never'))).toBe('Nothing staged in acme-store');
  // Still a message first, and still nothing while an op runs.
  expect(commitBlock({ ...offered('ask'), message: '' })).toBe('Write a message first');
  expect(commitBlock({ ...offered('ask'), running: true })).toBe('Git is working in acme-store');
  // Not offered (nothing stageable): as before.
  expect(commitBlock({ ...ok, nothingStaged: { mode: 'ask', offered: false, conflicts: false } })).toBe('Nothing staged in acme-store');
});

test('nothing staged with an unmerged file: "Resolve the conflicts first"', () => {
  const ok = { target: '/p/acme-store', name: 'acme-store', staged: 0, message: 'fix: x', running: false, notices: [] };
  expect(commitBlock({ ...ok, nothingStaged: { mode: 'ask', offered: false, conflicts: true } })).toBe('Resolve the conflicts first');
  // Amend with nothing staged is a reword: no question, no block.
  expect(commitBlock({ ...ok, amend: true, nothingStaged: { mode: 'ask', offered: false, conflicts: true } })).toBeNull();
});

test('amend is offered only when HEAD exists, is not a merge and is not on its upstream; otherwise why not', () => {
  expect(amendOffer(facts({ headPushed: false }))).toEqual({ ok: true, sha: 'aaaaaaa' });
  expect(amendOffer(facts({ headPushed: true }))).toEqual({ ok: false, tip: 'Already pushed: amending would rewrite shared history' });
  expect(amendOffer(facts({ headPushed: false, headIsMerge: true }))).toEqual({ ok: false, tip: "A merge commit can't be amended here" });
  expect(amendOffer(facts({ headPushed: false, head: null }))).toEqual({ ok: false, tip: 'There is no commit to amend yet' });
  // Facts not read yet: not offered until they are.
  expect(amendOffer(undefined)).toEqual({ ok: false, tip: 'Reading the last commit…' });
});

test("the drawer's op log: the target's op running (its label, Cancel), else its failure (Commit Without Hooks on a hook)", () => {
  const results: Record<string, GitResultEntry> = { '/p/acme-store': { failed: { outcome: 'hook', hook: 'pre-commit', output: 'lint: x\n', noShellEnv: true }, op: 'commit', at: 5, seen: true } };
  // Running wins (a Retry in flight), with what it printed so far; quiet ops and other roots never show.
  const running = op({ id: 'r1', phase: 'hook', hook: 'pre-commit', output: 'linting…\n' });
  expect(drawerLog({ target: '/p/acme-store', name: 'acme-store', ops: [running], results })).toEqual({ kind: 'running', id: 'r1', text: 'Running pre-commit · acme-store', startedAt: 100, output: 'linting…\n' });
  expect(drawerLog({ target: '/p/acme-store', name: 'acme-store', ops: [op({ phase: 'signing' })], results })).toMatchObject({ kind: 'running', text: 'Waiting for your signature…' });
  expect(drawerLog({ target: '/p/acme-store', name: 'acme-store', ops: [op({ op: 'stage' }), op({ root: '/p/billing' })], results })!.kind).toBe('failed');
  expect(drawerLog({ target: '/p/acme-store', name: 'acme-store', ops: [], results })).toEqual({
    kind: 'failed', op: 'commit', text: 'pre-commit failed · acme-store', output: 'lint: x\n', withoutHooks: true, noShellEnv: true
  });
  // A failure other than a hook's: no Commit Without Hooks; a push's failure: no Retry of a commit either.
  const sign: Record<string, GitResultEntry> = { '/p/acme-store': { failed: { outcome: 'sign', message: 'gpg failed' }, op: 'commit', at: 5, seen: true } };
  expect(drawerLog({ target: '/p/acme-store', name: 'acme-store', ops: [], results: sign })).toMatchObject({ withoutHooks: false, noShellEnv: false, output: 'gpg failed' });
  const push: Record<string, GitResultEntry> = { '/p/acme-store': { failed: { outcome: 'hook', hook: 'pre-push', output: 'no' }, op: 'push', at: 5, seen: true } };
  expect(drawerLog({ target: '/p/acme-store', name: 'acme-store', ops: [], results: push })).toMatchObject({ op: 'push', withoutHooks: false });
  // Nothing: a commit, no result, no target.
  expect(drawerLog({ target: '/p/acme-store', name: 'acme-store', ops: [], results: { '/p/acme-store': { sha: 'f'.repeat(40), at: 1, undo: null } } })).toBeNull();
  expect(drawerLog({ target: null, name: '', ops: [running], results })).toBeNull();
});

test('the log preview: the first lines with words (trailing blanks dropped), how many more', () => {
  expect(logPreview('\n\nlint: a\nlint: b\n\n', 6)).toEqual({ lines: ['lint: a', 'lint: b'], more: 0 });
  expect(logPreview('1\n2\n3\n4\n5\n', 3)).toEqual({ lines: ['1', '2', '3'], more: 2 });
  expect(logPreview('a\r\nb\rc', 6)).toEqual({ lines: ['a', 'b', 'c'], more: 0 });
  expect(logPreview('', 6)).toEqual({ lines: [], more: 0 });
});

test('the result notice offers Undo only while main offers it for that very commit', () => {
  const done: GitResultEntry = { sha: 'f0d6c52aa', at: 1000, undo: { oid: 'f0d6c52aa' } };
  const undo = (allFacts: Parameters<typeof drawerNotices>[0]['allFacts']) => notices({ results: { '/p/billing': done }, allFacts })[0];
  // Main's facts not read, or no Undo offered any more (pushed, HEAD moved), or one for another commit: no Undo.
  expect(undo({})).toMatchObject({ kind: 'result', undo: null });
  expect(undo({ '/p/billing': facts({ undo: null }) })).toMatchObject({ undo: null });
  expect(undo({ '/p/billing': facts({ undo: { oid: 'bbbbbbbbb', files: [] } }) })).toMatchObject({ undo: null });
  expect(undo({ '/p/billing': facts({ undo: { oid: 'f0d6c52aa', files: [] } }) })).toMatchObject({ undo: { oid: 'f0d6c52aa' } });
});

test('amend follows HEAD: on, it remembers the commit it shows; HEAD moving turns it off and says so', () => {
  const f = facts({ headPushed: false, head: 'h1', headMessage: 'feat: one\n\n' });
  expect(amendStart(f)).toEqual({ on: true, text: 'feat: one', head: 'h1' });
  expect(amendStart(facts())).toBeNull();
  expect(amendStart(undefined)).toBeNull();
  const on = amendStart(f)!;
  expect(amendFollow(on, f)).toEqual({ amend: on, moved: false });
  // Facts being read again: nothing changes yet.
  expect(amendFollow(on, undefined)).toEqual({ amend: on, moved: false });
  // Another commit (a terminal, a session): off, with the notice.
  expect(amendFollow(on, facts({ headPushed: false, head: 'h2' }))).toEqual({ amend: AMEND_OFF, moved: true });
  // Pushed meanwhile: off (the toggle's tooltip says why).
  expect(amendFollow(on, facts({ head: 'h1' }))).toEqual({ amend: AMEND_OFF, moved: false });
  expect(amendFollow(AMEND_OFF, facts({ headPushed: false, head: 'h2' }))).toEqual({ amend: AMEND_OFF, moved: false });
  // The notice: one line, never blocking.
  expect(notices({ amendMoved: true })).toEqual([{ kind: 'state', text: 'HEAD moved: amend turned off', blocks: false }]);
});

test('the bar: Commit all running shows and reopens; a drawer op running wins over its kept failure, with Cancel', () => {
  const running = barView({ ...base, ops: [op({ id: 'op7' })] });
  const failed = barView({ ...base, results: { '/p/billing': { failed: { outcome: 'error' }, op: 'push', at: 5, seen: false } } });
  const staged = barView(base);
  const allRunning = { kind: 'running' as const, done: 1, total: 3, current: 2 };
  const allFailed = { kind: 'results' as const, committed: 2, total: 3 };
  expect(barChoice(staged, null)).toEqual({ show: 'view', click: { kind: 'open' }, cancel: null });
  // A failure: the click opens the drawer on the repository that failed.
  expect(barChoice(failed, null)).toEqual({ show: 'view', click: { kind: 'open', root: '/p/billing' }, cancel: null });
  expect(barChoice(running, null)).toEqual({ show: 'view', click: { kind: 'open' }, cancel: 'op7' });
  expect(barChoice(staged, allRunning)).toEqual({ show: 'all', click: { kind: 'reopenAll' }, cancel: null });
  expect(barChoice(running, allRunning)).toEqual({ show: 'all', click: { kind: 'reopenAll' }, cancel: null });
  expect(barChoice(failed, allFailed)).toEqual({ show: 'all', click: { kind: 'reopenAll' }, cancel: null });
  expect(barChoice(running, allFailed)).toEqual({ show: 'view', click: { kind: 'open' }, cancel: 'op7' });
});

test('the handle: dragging up opens, down closes, in between sets a height up to the max (natural again near it)', () => {
  const d = { natural: 200, max: 400 };
  // Closed: a press that doesn't travel is a click, which opens.
  expect(dragEnd({ ...d, open: false, start: 44, dy: 0 })).toEqual({ kind: 'open' });
  expect(dragEnd({ ...d, open: false, start: 44, dy: 2 })).toEqual({ kind: 'open' });
  expect(dragEnd({ ...d, open: false, start: 44, dy: 8 })).toEqual({ kind: 'none' });
  expect(dragEnd({ ...d, open: false, start: 44, dy: -DRAG_THRESHOLD })).toEqual({ kind: 'open' });
  expect(dragEnd({ ...d, open: false, start: 44, dy: -(DRAG_THRESHOLD - 1) })).toEqual({ kind: 'none' });
  expect(dragEnd({ ...d, open: false, start: 44, dy: 60 })).toEqual({ kind: 'none' });
  expect(dragEnd({ ...d, open: true, start: 200, dy: DRAG_THRESHOLD + 1 })).toEqual({ kind: 'close' });
  expect(dragEnd({ ...d, open: true, start: 300, dy: 100 + DRAG_THRESHOLD + 1 })).toEqual({ kind: 'close' });
  expect(dragEnd({ ...d, open: true, start: 200, dy: -80 })).toEqual({ kind: 'height', height: 280 });
  expect(dragEnd({ ...d, open: true, start: 200, dy: -900 })).toEqual({ kind: 'height', height: 400 });
  expect(dragEnd({ ...d, open: true, start: 300, dy: 98 })).toEqual({ kind: 'height', height: null });
  expect(dragEnd({ ...d, open: true, start: 200, dy: 2 })).toEqual({ kind: 'none' });
  // A little down from the natural height: it stays open, at its natural height.
  expect(dragEnd({ ...d, open: true, start: 200, dy: DRAG_THRESHOLD - 1 })).toEqual({ kind: 'height', height: null });
  // While dragging: never under the natural height, never past the max.
  expect(liveHeight({ ...d, start: 200, dy: 50 })).toBe(200);
  expect(liveHeight({ ...d, start: 200, dy: -50 })).toBe(250);
  expect(liveHeight({ ...d, start: 200, dy: -500 })).toBe(400);
  // A panel too short for its natural height: the natural height wins.
  expect(liveHeight({ natural: 300, max: 250, start: 300, dy: -50 })).toBe(300);
});
