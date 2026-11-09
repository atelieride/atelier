import { describe, expect, test } from 'vitest';
import { parseNameStatus, parseNumstat, parseStatusV2 } from './parse';

const z = (...parts: string[]) => parts.map((p) => p + '\0').join('');

describe('parseStatusV2', () => {
  test('branch, ahead/behind and change kinds', () => {
    const out = z(
      '# branch.oid 1234567', '# branch.head dev', '# branch.upstream origin/dev', '# branch.ab +2 -1',
      '1 .M N... 100644 100644 100644 aaa bbb src/App.tsx',
      '1 A. N... 000000 100644 100644 000 ccc src/new file.ts',
      '1 D. N... 100644 000000 000000 ddd 000 old.ts',
      '2 R. N... 100644 100644 100644 eee eee R100 src/after.ts', 'src/before.ts',
      'u UU N... 100644 100644 100644 100644 a b c conflict.ts',
      '? folder/è-new.md'
    );
    const r = parseStatusV2(out, '/repo');
    expect(r).toMatchObject({ branch: 'dev', detached: false, ahead: 2, behind: 1, upstream: 'origin/dev', upstreamGone: false });
    expect(parseStatusV2(z('# branch.oid 1234567', '# branch.head dev'), '/repo')).toMatchObject({ upstream: null, upstreamGone: false });
    // The upstream's remote branch is gone (deleted, pruned): git names it but leaves out `# branch.ab`.
    expect(parseStatusV2(z('# branch.oid 1234567', '# branch.head dev', '# branch.upstream origin/dev'), '/repo'))
      .toMatchObject({ upstream: 'origin/dev', upstreamGone: true, ahead: 0, behind: 0 });
    expect(r.changes.map((c) => [c.rel, c.kind, c.stage])).toEqual([
      ['src/App.tsx', 'M', 'none'],
      ['src/new file.ts', 'A', 'all'],
      ['old.ts', 'D', 'all'],
      ['src/after.ts', 'R', 'all'],
      ['conflict.ts', 'U', 'none'],
      ['folder/è-new.md', '?', 'none']
    ]);
    expect(r.changes[3]).toMatchObject({ origRel: 'src/before.ts', path: '/repo/src/after.ts' });
    expect(r.changes.some((c) => 'submodule' in c)).toBe(false);
  });
  test('a new file changed again after git add (AM) is still new, not modified; AD is a deletion', () => {
    const r = parseStatusV2(z('1 AM N... 000000 100644 100644 000 ccc new.ts', '1 AD N... 000000 100644 000000 000 ccc gone.ts', '1 MM N... 100644 100644 100644 a b both.ts'), '/r');
    expect(r.changes.map((c) => [c.rel, c.kind, c.stage])).toEqual([['new.ts', 'A', 'partial'], ['gone.ts', 'D', 'partial'], ['both.ts', 'M', 'partial']]);
  });
  test('stage tri-state from XY: in the index only, in both, in the work tree only; a rename changed again is partial', () => {
    const r = parseStatusV2(z(
      '1 M. N... 100644 100644 100644 a b idx.ts',
      '1 .M N... 100644 100644 100644 a a wt.ts',
      '2 RM N... 100644 100644 100644 a b R100 moved.ts', 'was.ts',
      '2 .R N... 100644 100644 100644 a a R100 wtmove.ts', 'wtwas.ts'
    ), '/r');
    expect(r.changes.map((c) => [c.rel, c.kind, c.stage, c.origRel])).toEqual([
      ['idx.ts', 'M', 'all', undefined], ['wt.ts', 'M', 'none', undefined], ['moved.ts', 'R', 'partial', 'was.ts'], ['wtmove.ts', 'R', 'none', 'wtwas.ts']
    ]);
  });
  test('a copy (status.renames or diff.renames = copies) is a new file, never a rename of its source', () => {
    // Read as a rename, Discard, Unstage and Stage of the copy reached its source too (its staged edits went).
    const r = parseStatusV2(z(
      '1 MM N... 100644 100644 100644 a b a.txt',
      '2 C. N... 100644 100644 100644 a a C100 b.txt', 'a.txt',
      '2 CM N... 100644 100644 100644 a a C75 c d.txt', 'a.txt'
    ), '/r', { oids: true });
    expect(r.changes.map((c) => [c.rel, c.kind, c.stage, c.origRel ?? null])).toEqual([
      ['a.txt', 'M', 'partial', null], ['b.txt', 'A', 'all', null], ['c d.txt', 'A', 'partial', null]
    ]);
    expect(r.changes[1]).not.toHaveProperty('headOid');
  });
  test('a rename keeps its HEAD and index object names (discard tells a pure `git mv` from staged edits)', () => {
    const out = z('2 RM N... 100644 100644 100644 aaa1 bbb2 R90 moved.ts', 'was.ts', '1 M. N... 100644 100644 100644 a b idx.ts');
    const r = parseStatusV2(out, '/r', { oids: true });
    expect(r.changes[0]).toMatchObject({ rel: 'moved.ts', origRel: 'was.ts', headOid: 'aaa1', indexOid: 'bbb2' });
    expect(r.changes[1]).not.toHaveProperty('headOid');
    // Only main's own discard asks for them: the statuses the windows get stay as they were.
    expect(parseStatusV2(out, '/r').changes[0]).not.toHaveProperty('headOid');
  });
  test('submodule entries are kept as such (1, 2 and u records), whatever is staged', () => {
    const r = parseStatusV2(z(
      '1 .M SC.. 160000 160000 160000 a a vendor/lib',
      '1 M. S... 160000 160000 160000 a b vendor/two',
      '2 R. S..U 160000 160000 160000 a a R100 vendor/new', 'vendor/old',
      'u UU S... 160000 160000 160000 160000 a b c vendor/conf',
      '1 .M N... 100644 100644 100644 a a plain.ts'
    ), '/r');
    expect(r.changes.map((c) => [c.rel, c.stage, c.submodule])).toEqual([
      ['vendor/lib', 'none', true], ['vendor/two', 'all', true], ['vendor/new', 'all', true], ['vendor/conf', 'none', true], ['plain.ts', 'none', undefined]
    ]);
  });
  test('detached HEAD and repo with no commits', () => {
    expect(parseStatusV2(z('# branch.oid 1234', '# branch.head (detached)'), '/r')).toMatchObject({ branch: null, detached: true });
    expect(parseStatusV2(z('# branch.oid (initial)', '# branch.head main'), '/r')).toMatchObject({ branch: 'main', ahead: 0, behind: 0, changes: [] });
  });
  test('empty output', () => {
    expect(parseStatusV2('', '/r')).toEqual({ branch: null, detached: false, ahead: 0, behind: 0, oid: null, upstream: null, upstreamGone: false, changes: [] });
  });
});

describe('parseNameStatus', () => {
  test('kinds, renames and copies with their old path, type changes as modified', () => {
    const out = z('M', 'src/App.tsx', 'A', 'src/new file.ts', 'D', 'old.ts', 'R087', 'src/before.ts', 'src/after.ts', 'C075', 'a.ts', 'b.ts', 'T', 'link', 'U', 'conflict.ts');
    expect(parseNameStatus(out, '/repo').map((c) => [c.rel, c.kind, c.origRel ?? null])).toEqual([
      ['src/App.tsx', 'M', null], ['src/new file.ts', 'A', null], ['old.ts', 'D', null], ['src/after.ts', 'R', 'src/before.ts'],
      ['b.ts', 'A', null], ['link', 'M', null], ['conflict.ts', 'U', null]
    ]);
    expect(parseNameStatus(out, '/repo')[0]).toEqual({ path: '/repo/src/App.tsx', rel: 'src/App.tsx', kind: 'M', stage: 'none', added: null, removed: null });
  });
  test('empty or truncated output', () => {
    expect(parseNameStatus('', '/r')).toEqual([]);
    expect(parseNameStatus(z('M'), '/r')).toEqual([]);
  });
});

describe('parseNumstat', () => {
  test('normal lines, binaries and renames', () => {
    const out = '12\t3\tsrc/App.tsx\0' + '-\t-\timg.png\0' + '5\t1\t\0src/before.ts\0src/after.ts\0';
    const m = parseNumstat(out);
    expect(m.get('src/App.tsx')).toEqual({ added: 12, removed: 3 });
    expect(m.get('img.png')).toEqual({ added: null, removed: null });
    expect(m.get('src/after.ts')).toEqual({ added: 5, removed: 1 });
  });
});
