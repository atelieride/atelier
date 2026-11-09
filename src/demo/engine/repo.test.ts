import { describe, expect, test } from 'vitest';
import { compileWorld } from '../compile/index';
import { repoStatus } from './repo';

// Changes in the demo: the working tree against HEAD, as git status + numstat report it.

describe('repoStatus', () => {
  const world = compileWorld();
  const st = repoStatus({ root: world.project.root, name: world.project.name, head: world.head, files: world.files, oid: world.headOid, now: 1 });

  test("the overview's four modified files with git's line counts", () => {
    expect(st.changes.map((c) => [c.rel, c.kind, c.added, c.removed])).toEqual([
      ['README.md', 'M', 5, 0],
      ['src/auth/session.ts', 'M', 7, 2],
      ['src/pages/welcome.tsx', 'M', 3, 2],
      ['tests/billing.test.ts', 'M', 4, 0]
    ]);
    expect(st.changes[0]).toMatchObject({ path: `${world.project.root}/README.md`, stage: 'none' });
  });

  test('on main, no upstream, HEAD at the last commit', () => {
    expect(st).toMatchObject({ root: world.project.root, name: 'acme-store', branch: 'main', detached: false, ahead: 0, behind: 0, upstream: null, oid: world.headOid, checkedAt: 1, truncated: 0 });
  });

  test('the index: staged as it is now → all; changed again since → partial; a deletion staged → all', () => {
    const head = { 'a.ts': 'a\n', 'b.ts': 'b\n', 'd.ts': 'd\n' };
    const files = { 'a.ts': 'a2\n', 'b.ts': 'b3\n', 'c.ts': 'c\n' };
    const index = { 'a.ts': 'a2\n', 'b.ts': 'b2\n', 'd.ts': null, 'e.ts': 'gone\n' };
    const s = repoStatus({ root: '/r', name: 'r', head, files, index, oid: 'x', now: 0 });
    expect(s.changes.map((c) => [c.rel, c.stage])).toEqual([['a.ts', 'all'], ['b.ts', 'partial'], ['c.ts', 'none'], ['d.ts', 'all']]);
    // No index: nothing staged.
    expect(repoStatus({ root: '/r', name: 'r', head, files, oid: 'x', now: 0 }).changes.every((c) => c.stage === 'none')).toBe(true);
  });

  test('a new file is untracked, a removed one deleted, an unchanged one absent', () => {
    const s = repoStatus({ root: '/r', name: 'r', head: { 'a.ts': 'a\n', 'b.ts': 'b\n' }, files: { 'a.ts': 'a\n', 'c.ts': 'c\n' }, oid: 'x', now: 0 });
    expect(s.changes.map((c) => [c.rel, c.kind])).toEqual([['b.ts', 'D'], ['c.ts', '?']]);
  });
});
