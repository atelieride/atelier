import { describe, expect, test } from 'vitest';
import { EMPTY_TREE } from '@shared/scm';
import { compileWorld } from '../compile/index';
import { createHistory } from './scm';

// Source Control's history in the demo: git's answers over the compiled commits.

const world = compileWorld();
const [first, second, third] = world.commits;
const refs = ['refs/heads/main', 'refs/remotes/origin/main'];
const h = createHistory(world.scm, { head: world.headOid, refs: Object.fromEntries(refs.map((r) => [r, world.headOid])) });
const all = { kind: 'refs', refs: 'all', firstParent: false } as const;

describe('log', () => {
  test('newest first, paged with skip/count, done on the last page', () => {
    expect(h.log(all, 0, 400).commits.map((c) => c.oid)).toEqual([third!.oid, second!.oid, first!.oid]);
    expect(h.log(all, 0, 2)).toMatchObject({ done: false, capped: false });
    expect(h.log(all, 2, 2).commits.map((c) => c.oid)).toEqual([first!.oid]);
    expect(h.log(all, 2, 2).done).toBe(true);
  });

  test('one ref, HEAD or an id: its history; an unknown ref is an error as in main', () => {
    expect(h.log({ kind: 'refs', refs: 'refs/heads/main', firstParent: true }, 0, 10).commits).toHaveLength(3);
    expect(h.log({ kind: 'refs', refs: second!.oid, firstParent: false }, 0, 10).commits.map((c) => c.oid)).toEqual([second!.oid, first!.oid]);
    expect(h.log({ kind: 'refs', refs: 'refs/heads/nope', firstParent: false }, 0, 10)).toEqual({ commits: [], done: true, capped: false, error: 'unknown ref' });
  });

  test('compare base..head: what head has that base lacks, with the merge base on the first page', () => {
    const page = h.log({ kind: 'compare', base: first!.oid, head: 'refs/heads/main' }, 0, 10);
    expect(page.commits.map((c) => c.oid)).toEqual([third!.oid, second!.oid]);
    expect(page.mergeBase).toBe(first!.oid);
    expect(h.log({ kind: 'compare', base: 'refs/heads/main', head: 'refs/remotes/origin/main' }, 0, 10)).toMatchObject({ commits: [], mergeBase: world.headOid });
  });

  test('the filter: words in the message (all, any case), @author, path:, and an id prefix that resolves is not a word', () => {
    const subjects = (f: string) => h.log(all, 0, 10, f).commits.map((c) => c.subject);
    expect(subjects('invoice')).toEqual(['Test invoice totals', 'Add sessions, invoices and the welcome page']);
    expect(subjects('INVOICE totals')).toEqual(['Test invoice totals']);
    expect(subjects('@ada')).toHaveLength(3);
    expect(subjects('@grace')).toEqual([]);
    expect(subjects('path:src/auth')).toEqual(['Add sessions, invoices and the welcome page']);
    expect(subjects('path:compose.yml')).toEqual(['Start the Acme store']);
    expect(subjects(`${third!.oid.slice(0, 7)} test`)).toEqual(['Test invoice totals']);
  });
});

test('locate: where a commit sits in the unfiltered scope, null when it is not in it', () => {
  expect(h.locate(all, first!.oid)).toBe(2);
  expect(h.locate({ kind: 'refs', refs: second!.oid, firstParent: false }, third!.oid)).toBeNull();
});

test('resolve: a 4–40 hex prefix of one commit; too short, ambiguous or unknown is null', () => {
  expect(h.resolve(second!.oid.slice(0, 6))).toBe(second!.oid);
  expect(h.resolve(second!.oid)).toBe(second!.oid);
  expect(h.resolve(second!.oid.slice(0, 3))).toBeNull();
  expect(h.resolve('0000000')).toBeNull();
  expect(h.resolve('zzzz')).toBeNull();
});

describe('commit', () => {
  test('against its first parent: the files it changed with line counts, blob ids and modes, the full message', () => {
    const d = h.commit(third!.oid, null);
    expect(d).toMatchObject({ oid: third!.oid, message: 'Test invoice totals', base: second!.oid, more: 0 });
    expect(d.files).toEqual([{ rel: 'tests/billing.test.ts', kind: 'A', added: 6, removed: 0, oldMode: '000000', newMode: '100644', oldOid: '0'.repeat(40), newOid: world.scm.trees[third!.oid]!['tests/billing.test.ts'] }]);
  });

  test('a root commit against the empty tree; against another commit, the difference between their trees', () => {
    expect(h.commit(first!.oid, null)).toMatchObject({ base: EMPTY_TREE.sha1 });
    expect(h.commit(first!.oid, null).files.map((f) => f.rel)).toEqual(['README.md', 'compose.yml', 'package.json']);
    const d = h.commit(first!.oid, third!.oid);
    expect(d.base).toBe(third!.oid);
    expect(d.files.every((f) => f.kind === 'D' && f.added === 0 && f.newOid === '0'.repeat(40))).toBe(true);
    expect(d.files).toHaveLength(6);
  });

  test('an unknown id answers as main does: an error, nothing listed', () => {
    expect(h.commit('f'.repeat(40), null)).toMatchObject({ files: [], error: 'bad commit' });
  });
});

test('file: a file at a commit (by commit or by its tree), missing where it is not', () => {
  expect(h.file(third!.oid, 'tests/billing.test.ts')).toEqual({ kind: 'text', text: world.head['tests/billing.test.ts'], notUtf8: false });
  expect(h.file(first!.oid, 'tests/billing.test.ts')).toEqual({ kind: 'missing' });
  expect(h.file(EMPTY_TREE.sha1, 'README.md')).toEqual({ kind: 'missing' });
});
