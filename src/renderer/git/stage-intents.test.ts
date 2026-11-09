import { expect, test } from 'vitest';
import type { FileChange, RepoStatus } from '@shared/git';
import { applyIntents, settleIntents, type StageIntent } from './stage-intents';

// A checkbox shows its click at once: git add and the status read after it took seconds on a
// Windows PC, the box unchanged meanwhile. The click is an intent laid over the statuses until a status read that
// started once git was done (`at`, main's clock) comes in; a failed op drops it, and the box is as git has it again.

const ch = (rel: string, stage: FileChange['stage'], o: Partial<FileChange> = {}): FileChange => ({ path: `/r/${rel}`, rel, kind: 'M', stage, added: 1, removed: 0, ...o });
const repo = (root: string, checkedAt: number, ...changes: FileChange[]): RepoStatus => ({
  root, name: root.slice(1), branch: 'main', detached: false, ahead: 0, behind: 0, changes, oid: 'a'.repeat(40), checkedAt, truncated: 0
});
const intent = (id: number, root: string, rels: StageIntent['rels'], to: StageIntent['to'], at: number | null = null): StageIntent => ({ id, root, rels, to, at });
const stages = (rs: RepoStatus[]) => Object.fromEntries(rs.flatMap((r) => r.changes.map((c) => [`${r.root}:${c.rel}`, c.stage])));

test('no intent: the very same statuses (nothing re-renders)', () => {
  const repos = [repo('/a', 1, ch('x.ts', 'none'))];
  expect(applyIntents(repos, [])).toBe(repos);
});

test('a stage shows its files fully staged, an unstage shows them unstaged; other repos and files untouched', () => {
  const b = repo('/b', 1, ch('y.ts', 'none'));
  const repos = [repo('/a', 1, ch('x.ts', 'none'), ch('p.ts', 'partial'), ch('s.ts', 'all'), ch('o.ts', 'none')), b];
  const out = applyIntents(repos, [intent(1, '/a', ['x.ts', 'p.ts'], 'all'), intent(2, '/a', ['s.ts'], 'none')]);
  expect(stages(out)).toEqual({ '/a:x.ts': 'all', '/a:p.ts': 'all', '/a:s.ts': 'none', '/a:o.ts': 'none', '/b:y.ts': 'none' });
  expect(out[1]).toBe(b);
  expect(repos[0]!.changes[0]!.stage).toBe('none');
});

test('the later click wins; a rename counts by either of its paths', () => {
  const repos = [repo('/a', 1, ch('x.ts', 'none'), ch('new.ts', 'none', { kind: 'R', origRel: 'old.ts' }))];
  const out = applyIntents(repos, [intent(1, '/a', ['x.ts'], 'all'), intent(2, '/a', ['x.ts'], 'none'), intent(3, '/a', ['old.ts'], 'all')]);
  expect(stages(out)).toEqual({ '/a:x.ts': 'none', '/a:new.ts': 'all' });
});

test('Stage All / Unstage All: every file that can be staged; never a conflict, a submodule or a nested repository', () => {
  const repos = [repo('/a', 1, ch('x.ts', 'none'), ch('u.ts', 'none', { kind: 'U' }), ch('sub', 'none', { submodule: true }), ch('nested/', 'none', { kind: '?' }), ch('n.ts', 'partial', { kind: '?' }))];
  expect(stages(applyIntents(repos, [intent(1, '/a', 'all', 'all')]))).toEqual({ '/a:x.ts': 'all', '/a:u.ts': 'none', '/a:sub': 'none', '/a:nested/': 'none', '/a:n.ts': 'all' });
  const staged = [repo('/a', 1, ch('x.ts', 'all'), ch('u.ts', 'all', { kind: 'U' }))];
  expect(stages(applyIntents(staged, [intent(1, '/a', 'all', 'none')]))).toEqual({ '/a:x.ts': 'none', '/a:u.ts': 'all' });
});

test('an intent stays while its op runs, and until a status read that started once git was done', () => {
  const running = intent(1, '/a', ['x.ts'], 'all');
  const done = intent(2, '/a', ['y.ts'], 'all', 500);
  const elsewhere = intent(3, '/b', ['z.ts'], 'all', 500);
  // A read that began before git was done (it may show the old index): kept.
  expect(settleIntents([running, done, elsewhere], [repo('/a', 499), repo('/b', 400)])).toEqual([running, done, elsewhere]);
  // The read that shows it: dropped, for its own repository only.
  expect(settleIntents([running, done, elsewhere], [repo('/a', 500), repo('/b', 400)])).toEqual([running, elsewhere]);
  expect(settleIntents([running, done, elsewhere], [repo('/a', 900), repo('/b', 900)])).toEqual([running]);
});

test('a repository no longer listed (its window moved on) takes its intents with it', () => {
  const list = [intent(1, '/a', ['x.ts'], 'all'), intent(2, '/b', ['y.ts'], 'all', 5)];
  expect(settleIntents(list, [repo('/c', 1)])).toEqual([]);
  expect(settleIntents([], [repo('/c', 1)])).toEqual([]);
});
