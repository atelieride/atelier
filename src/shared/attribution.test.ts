import { describe, expect, test } from 'vitest';
import { addAttribution, attributionFromHook, pruneAttributions, shouldPrune, type Attribution } from './attribution';
import type { RepoStatus } from './git';

const term = { id: 't1', color: '#B794F6', title: 'Interlocutori' };
const post = (tool: string, input: object) => ({ hook_event_name: 'PostToolUse', session_id: 's1', tool_name: tool, tool_input: input });

describe('attributionFromHook', () => {
  test.each(['Edit', 'Write', 'MultiEdit'])('%s with absolute file_path', (tool) => {
    expect(attributionFromHook(post(tool, { file_path: '/p/a.ts' }), term, 5)).toEqual({ path: '/p/a.ts', terminalId: 't1', sessionId: 's1', color: '#B794F6', title: 'Interlocutori', at: 5 });
  });
  test('NotebookEdit uses notebook_path', () => {
    expect(attributionFromHook(post('NotebookEdit', { notebook_path: '/p/n.ipynb' }), term, 5)?.path).toBe('/p/n.ipynb');
  });
  test('does not attribute: PreToolUse, Read, Bash, relative path, broken payload', () => {
    expect(attributionFromHook({ ...post('Edit', { file_path: '/p/a.ts' }), hook_event_name: 'PreToolUse' }, term, 5)).toBeNull();
    expect(attributionFromHook(post('Read', { file_path: '/p/a.ts' }), term, 5)).toBeNull();
    expect(attributionFromHook(post('Bash', { command: 'sed -i x a.ts' }), term, 5)).toBeNull();
    expect(attributionFromHook(post('Edit', { file_path: 'rel.ts' }), term, 5)).toBeNull();
    expect(attributionFromHook(null, term, 5)).toBeNull();
  });
  test('normalized paths (no /./ or ../)', () => {
    expect(attributionFromHook(post('Edit', { file_path: '/p/src/../a.ts' }), term, 5)?.path).toBe('/p/a.ts');
  });
});

test('addAttribution: one entry per file and terminal, updated', () => {
  let l: Attribution[] = [];
  const a = { path: '/p/a.ts', terminalId: 't1', sessionId: 's', color: 'c', title: 'T', at: 1 };
  l = addAttribution(l, a);
  l = addAttribution(l, { ...a, at: 9 });
  l = addAttribution(l, { ...a, terminalId: 't2', at: 3 });
  expect(l).toHaveLength(2);
  expect(l.find((x) => x.terminalId === 't1')?.at).toBe(9);
});

test('pruneAttributions: removes clean files under the root, leaves other projects alone', () => {
  const l: Attribution[] = [
    { path: '/p/a.ts', terminalId: 't1', sessionId: 's', color: 'c', title: 'T', at: 1 },
    { path: '/p/b.ts', terminalId: 't1', sessionId: 's', color: 'c', title: 'T', at: 1 },
    { path: '/other/c.ts', terminalId: 't1', sessionId: 's', color: 'c', title: 'T', at: 1 }
  ];
  expect(pruneAttributions(l, '/p', new Set(['/p/a.ts'])).map((x) => x.path)).toEqual(['/p/a.ts', '/other/c.ts']);
  expect(pruneAttributions(l, '/p', new Set()).map((x) => x.path)).toEqual(['/other/c.ts']);
});

test('pruneAttributions: nested repos are excluded, attributions newer than the state stay', () => {
  const mk = (path: string, at: number): Attribution => ({ path, terminalId: 't1', sessionId: 's', color: 'c', title: 'T', at });
  const l = [mk('/p/a.ts', 1), mk('/p/sub/b.ts', 1), mk('/p/c.ts', 50)];
  // Root /p state started at t=10: it does not list the nested repo's /p/sub files, and c.ts was written afterwards.
  expect(pruneAttributions(l, '/p', new Set(), { exclude: ['/p/sub'], before: 10 }).map((x) => x.path)).toEqual(['/p/sub/b.ts', '/p/c.ts']);
});

describe('shouldPrune: attributions go only when HEAD moved (commit, checkout), not on a brief clean state', () => {
  const st = (over: Partial<RepoStatus> = {}): RepoStatus => ({ root: '/p', name: 'p', branch: 'main', detached: false, ahead: 0, behind: 0, changes: [], oid: 'aaa', checkedAt: 1, truncated: 0, ...over });
  test('first status seen for the repo: no prune', () => expect(shouldPrune(undefined, st())).toBe(false));
  test('same HEAD and no dirty files (stash, stash pop, reset): no prune', () => expect(shouldPrune('aaa', st())).toBe(false));
  test('HEAD changed: prune', () => expect(shouldPrune('aaa', st({ oid: 'bbb' }))).toBe(true));
  test('first commit of a repo without commits: prune', () => expect(shouldPrune(null, st({ oid: 'aaa' }))).toBe(true));
  test('incomplete status (error, truncated list): no prune even if HEAD changed', () => {
    expect(shouldPrune('aaa', st({ oid: 'bbb', error: 'boom' }))).toBe(false);
    expect(shouldPrune('aaa', st({ oid: 'bbb', truncated: 3 }))).toBe(false);
  });
});
