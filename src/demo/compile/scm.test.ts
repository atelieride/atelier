import { describe, expect, test } from 'vitest';
import { AUTHOR, COMMITS, FILES } from '../world/project';
import { COMPOSE } from '../world/docker';
import { blobOid, compileScm, commitOids } from './scm';
import { T0 } from './sessions';

describe('compileScm', () => {
  const commits = commitOids(COMMITS);
  const scm = compileScm(commits, T0);

  test("blob ids are git's own (sha1 of 'blob <size>\\0<content>'), so a copied id means the same as in a clone", () => {
    expect(blobOid('hello\n')).toBe('ce013625030ba8dba906f756967f9e9ca394464a');
  });

  test('the log: newest first, each the child of the next, by Ada Lovelace, times in seconds before t0', () => {
    expect(scm.commits.map((c) => c.subject)).toEqual([...COMMITS].reverse().map((c) => c.message));
    expect(scm.commits.map((c) => c.oid)).toEqual([...commits].reverse().map((c) => c.oid));
    scm.commits.forEach((c, i) => expect(c.parents).toEqual(i + 1 < scm.commits.length ? [scm.commits[i + 1]!.oid] : []));
    for (const c of scm.commits) {
      expect(c.author).toEqual(AUTHOR);
      expect(c.committer).toEqual(AUTHOR);
      expect(c.authorAt).toBeLessThan(T0 / 1000);
    }
    const at = scm.commits.map((c) => c.committerAt);
    expect([...at].sort((a, b) => b - a)).toEqual(at);
  });

  test("trees: each commit's files on top of its parent's; HEAD's tree is the project's HEAD (with compose.yml)", () => {
    const head = scm.trees[commits.at(-1)!.oid]!;
    const text = (tree: Record<string, string>) => Object.fromEntries(Object.entries(tree).map(([rel, oid]) => [rel, scm.blobs[oid]]));
    expect(text(head)).toEqual({ ...FILES, 'compose.yml': COMPOSE });
    expect(Object.keys(scm.trees[commits[0]!.oid]!).sort()).toEqual(['README.md', 'compose.yml', 'package.json']);
    expect(Object.keys(scm.trees[commits[1]!.oid]!)).toHaveLength(8);
  });
});
