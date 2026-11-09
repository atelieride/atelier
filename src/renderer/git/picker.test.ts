import { expect, test } from 'vitest';
import type { FileChange, RepoStatus } from '@shared/git';
import { FILTER_FROM, pickerGroups, pickerRows, type PickerRepo } from './picker';
import type { GitResultEntry } from './slice';

// The repository picker as data: its groups (Staged with the count, Changed, Committed just
// now with the short sha, then the rest), each row's path with the folder apart, branch line and draft dot, the filter.

const ch = (root: string, stage: FileChange['stage']): FileChange => ({ path: `${root}/f.ts`, rel: 'f.ts', kind: 'M', stage, added: 1, removed: 0 });
const repo = (rel: string, stages: FileChange['stage'][] = [], o: Partial<RepoStatus> = {}): PickerRepo => {
  const root = `/p/${rel}`;
  return { root, name: rel.split('/').pop()!, changes: stages.map((s) => ch(root, s)), branch: 'main', detached: false, oid: 'a'.repeat(40), ahead: 0, ...o };
};
const SHA = 'f0d6c52aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const repos = [repo('acme-store', ['all', 'none']), repo('billing', ['none']), repo('plugins/payments', ['partial', 'all']), repo('docs'), repo('infra'), repo('web')];
const base = { repos, project: ['/p'], drafts: {} as Record<string, string>, results: {} as Record<string, GitResultEntry>, query: '' };
const names = (rows: { name: string }[]) => rows.map((r) => r.name);

test('groups: Staged (with the count), Changed, Committed just now, then the clean ones; each in Changes order', () => {
  const results: Record<string, GitResultEntry> = { '/p/docs': { sha: SHA, at: 1, undo: null } };
  const g = pickerGroups({ ...base, results });
  expect(names(g.staged)).toEqual(['acme-store', 'payments']);
  expect(g.staged.map((r) => r.staged)).toEqual([1, 2]);
  expect(names(g.changed)).toEqual(['billing']);
  expect(names(g.committed)).toEqual(['docs']);
  expect(g.committed[0]!.committed).toBe('f0d6c52');
  expect(names(g.clean)).toEqual(['infra', 'web']);
  // The arrows go through them in that order.
  expect(names(pickerRows(g))).toEqual(['acme-store', 'payments', 'billing', 'docs', 'infra', 'web']);
});

test('a repository committed just now that has staged files again is in Staged, its sha still shown', () => {
  const g = pickerGroups({ ...base, results: { '/p/acme-store': { sha: SHA, at: 1, undo: null } } });
  expect(names(g.staged)).toEqual(['acme-store', 'payments']);
  expect(g.staged[0]!.committed).toBe('f0d6c52');
  expect(g.committed).toEqual([]);
  // A failure is not a commit.
  const failed = pickerGroups({ ...base, results: { '/p/docs': { failed: { outcome: 'hook' }, op: 'commit', at: 1, seen: false } } });
  expect(names(failed.clean)).toContain('docs');
});

test('a row: the path inside the project with its folder apart, the branch line, the draft dot', () => {
  const g = pickerGroups({ ...base, drafts: { '/p/plugins/payments': 'feat: pay', '/p/billing': '  \n' } });
  const pay = g.staged.find((r) => r.name === 'payments')!;
  expect(pay).toMatchObject({ root: '/p/plugins/payments', dir: 'plugins/', name: 'payments', branch: 'main', draft: true });
  // A blank draft is none.
  expect(g.changed[0]!.draft).toBe(false);
  // Ahead of its upstream; detached.
  const other = pickerGroups({ ...base, repos: [repo('a', ['all'], { ahead: 2, upstream: 'origin/main' }), repo('b', ['all'], { detached: true, branch: null })] });
  expect(other.staged.map((r) => r.branch)).toEqual(['main ↑2', 'detached aaaaaaa']);
  // Counted against a branch of another name (feat/x made from origin/main), it is nothing to push: no arrow.
  const elsewhere = pickerGroups({ ...base, repos: [repo('a', ['all'], { branch: 'feat/x', ahead: 209, upstream: 'origin/main' })] });
  expect(elsewhere.staged.map((r) => r.branch)).toEqual(['feat/x']);
  // Repositories under the project's resolved root (a /var → /private/var link): their path all the same.
  expect(pickerGroups({ ...base, project: ['/var/p', '/p'] }).staged[1]).toMatchObject({ dir: 'plugins/', name: 'payments' });
  // The project's own repository: its name.
  expect(pickerGroups({ ...base, repos: [{ ...repo('x', ['all']), root: '/p', name: 'p' }] }).staged[0]).toMatchObject({ dir: '', name: 'p' });
});

test('the filter: shown from 6 repositories; typing keeps the paths that contain it, case aside, with the match', () => {
  expect(FILTER_FROM).toBe(6);
  expect(pickerGroups(base)).toMatchObject({ total: 6, filter: true });
  expect(pickerGroups({ ...base, repos: repos.slice(0, 5) }).filter).toBe(false);
  const g = pickerGroups({ ...base, query: 'PLUG' });
  expect(names(pickerRows(g))).toEqual(['payments']);
  expect(g.staged[0]!.match).toEqual([0, 4]);
  expect(names(pickerRows(pickerGroups({ ...base, query: 'ments' })))).toEqual(['payments']);
  expect(pickerGroups({ ...base, query: 'ments' }).staged[0]!.match).toEqual([11, 16]);
  expect(pickerRows(pickerGroups({ ...base, query: 'nothing like it' }))).toEqual([]);
  // The total stays the project's.
  expect(pickerGroups({ ...base, query: 'web' }).total).toBe(6);
});
