import { expect, test } from 'vitest';
import { filterArgs, isFilterEmpty, parseHistoryFilter, parseLog, parseRawDiff, parseRefs, parseStashes, parseTrack, parseWorktrees } from './git-history';

const R = (f: string[]) => f.join('\0');

test('parseRefs: local with upstream and track, remote, peeled annotated tag, origin/HEAD hidden', () => {
  const out = [
    R(['refs/heads/main', 'a'.repeat(40), '', 'refs/remotes/origin/main', 'ahead 2, behind 1', '*', '1700000000', '1700000000']),
    R(['refs/heads/old', 'b'.repeat(40), '', 'refs/remotes/origin/old', 'gone', ' ', '1600000000', '1600000000']),
    R(['refs/remotes/origin/HEAD', 'a'.repeat(40), '', '', '', ' ', '1700000000', '1700000000']),
    R(['refs/remotes/origin/main', 'c'.repeat(40), '', '', '', ' ', '1700000100', '1700000100']),
    R(['refs/tags/v1.0', 'd'.repeat(40), 'e'.repeat(40), '', '', ' ', '0', '1650000000'])
  ].join('\n') + '\n';
  const refs = parseRefs(out);
  expect(refs.map((r) => r.short)).toEqual(['main', 'old', 'origin/main', 'v1.0']);
  expect(refs[0]).toMatchObject({ name: 'refs/heads/main', kind: 'head', current: true, ahead: 2, behind: 1, gone: false, upstream: 'refs/remotes/origin/main', date: 1700000000 });
  expect(refs[1]).toMatchObject({ gone: true, current: false });
  expect(refs[2]).toMatchObject({ kind: 'remote', remote: 'origin', oid: 'c'.repeat(40), upstream: null });
  expect(refs[3]).toMatchObject({ kind: 'tag', oid: 'e'.repeat(40), date: 1650000000 });
});

test('parseRefs: a remote whose name holds a slash is told apart by the configured remotes; its HEAD is hidden', () => {
  const out = [
    R(['refs/remotes/team/fork/main', 'a'.repeat(40), '', '', '', ' ', '1', '1']),
    R(['refs/remotes/team/fork/HEAD', 'a'.repeat(40), '', '', '', ' ', '1', '1']),
    R(['refs/remotes/origin/feat/x', 'b'.repeat(40), '', '', '', ' ', '1', '1'])
  ].join('\n');
  expect(parseRefs(out, ['origin', 'team/fork']).map((r) => [r.short, r.remote])).toEqual([['team/fork/main', 'team/fork'], ['origin/feat/x', 'origin']]);
  // Without the list (older callers): the first segment.
  expect(parseRefs(out).map((r) => r.remote)).toEqual(['team', 'team', 'origin']);
});

test('parseRefs: a branch name with slashes and unicode, a lightweight tag', () => {
  const out = [R(['refs/heads/feat/è-x', 'a'.repeat(40), '', '', '', ' ', '1', '1']), R(['refs/tags/v2', 'b'.repeat(40), '', '', '', ' ', '5', '5'])].join('\n');
  expect(parseRefs(out).map((r) => [r.short, r.kind, r.oid])).toEqual([['feat/è-x', 'head', 'a'.repeat(40)], ['v2', 'tag', 'b'.repeat(40)]]);
});

test('parseTrack', () => {
  expect(parseTrack('')).toEqual({ ahead: 0, behind: 0, gone: false });
  expect(parseTrack('behind 3')).toEqual({ ahead: 0, behind: 3, gone: false });
  expect(parseTrack('ahead 4')).toEqual({ ahead: 4, behind: 0, gone: false });
  expect(parseTrack('gone')).toEqual({ ahead: 0, behind: 0, gone: true });
});

test('parseLog: merge, root, unicode, empty subject, co-authors, a trailing newline', () => {
  const rec = (oid: string, parents: string, subject: string, co = '') => '\x1e' + R([oid, parents, 'Ada Lövelace', 'f@x.test', '1700000000', 'GitHub', 'noreply@github.com', '1700000001', subject, co]) + '\n';
  const out = rec('a'.repeat(40), `${'b'.repeat(40)} ${'c'.repeat(40)}`, 'Merge feat/x', '') + rec('b'.repeat(40), '', '', 'Claude <noreply@anthropic.com>\x01Ana <a@b.c>');
  const [m, root] = parseLog(out);
  expect(m).toMatchObject({ oid: 'a'.repeat(40), parents: ['b'.repeat(40), 'c'.repeat(40)], subject: 'Merge feat/x', author: { name: 'Ada Lövelace', email: 'f@x.test' }, authorAt: 1700000000, committer: { name: 'GitHub', email: 'noreply@github.com' }, committerAt: 1700000001, coAuthors: [] });
  expect(root).toMatchObject({ parents: [], subject: '', coAuthors: [{ name: 'Claude', email: 'noreply@anthropic.com' }, { name: 'Ana', email: 'a@b.c' }] });
  expect(parseLog('\x1enot-an-oid\0x\n')).toEqual([]);
  expect(parseLog('')).toEqual([]);
});

test('parseLog: a co-author without an email keeps the name', () => {
  const out = '\x1e' + R(['a'.repeat(40), '', 'A', 'a@a', '1', 'A', 'a@a', '1', 's', 'Someone']) + '\n';
  expect(parseLog(out)[0]!.coAuthors).toEqual([{ name: 'Someone', email: '' }]);
});

test('parseRawDiff: modify, add, delete, rename with spaces and unicode, mode change, submodule, binary counts', () => {
  const z = (...f: string[]) => f.join('\0') + '\0';
  const O = '0'.repeat(40); const A = '1'.repeat(40); const B = '2'.repeat(40);
  const raw = z(`:100644 100644 ${A} ${B} M`, 'src/a.ts', `:000000 100644 ${O} ${B} A`, 'new.ts', `:100644 000000 ${A} ${O} D`, 'gone.ts',
    `:100644 100644 ${A} ${B} R092`, 'old name.ts', 'nuovo è.ts', `:100644 100755 ${A} ${A} M`, 'run.sh', `:160000 160000 ${A} ${B} M`, 'vendor/lib', `:100644 100644 ${A} ${B} M`, 'logo.png',
    `:100644 120000 ${A} ${B} T`, 'link', `:100644 100644 ${A} ${B} C075`, 'src/a.ts', 'src/copy.ts');
  const num = z('3\t1\tsrc/a.ts', '5\t0\tnew.ts', '0\t2\tgone.ts', '1\t1\t', 'old name.ts', 'nuovo è.ts', '0\t0\trun.sh', '1\t1\tvendor/lib', '-\t-\tlogo.png', '1\t1\tlink', '9\t0\t', 'src/a.ts', 'src/copy.ts');
  const files = parseRawDiff(raw, num);
  expect(files.map((f) => [f.kind, f.rel, f.origRel ?? null, f.added, f.removed])).toEqual([
    ['M', 'src/a.ts', null, 3, 1], ['A', 'new.ts', null, 5, 0], ['D', 'gone.ts', null, 0, 2], ['R', 'nuovo è.ts', 'old name.ts', 1, 1],
    ['M', 'run.sh', null, 0, 0], ['M', 'vendor/lib', null, 1, 1], ['M', 'logo.png', null, null, null], ['T', 'link', null, 1, 1], ['A', 'src/copy.ts', null, 9, 0]]);
  expect(files[4]).toMatchObject({ oldMode: '100644', newMode: '100755', oldOid: A, newOid: A });
  expect(files[5]).toMatchObject({ newMode: '160000', newOid: B });
  expect(parseRawDiff('', '')).toEqual([]);
});

test('parseWorktrees: main, linked on a branch, detached, locked, prunable', () => {
  const out = ['worktree /p/app', 'HEAD ' + 'a'.repeat(40), 'branch refs/heads/main', '', 'worktree /p/app/.worktrees/v2.2', 'HEAD ' + 'b'.repeat(40), 'branch refs/heads/v2.2-integrate', 'locked', '',
    'worktree /tmp/x', 'HEAD ' + 'c'.repeat(40), 'detached', 'prunable gitdir file points to non-existent location', '', ''].join('\0');
  expect(parseWorktrees(out)).toEqual([
    { path: '/p/app', head: 'a'.repeat(40), branch: 'main', detached: false, bare: false, locked: false, prunable: false },
    { path: '/p/app/.worktrees/v2.2', head: 'b'.repeat(40), branch: 'v2.2-integrate', detached: false, bare: false, locked: true, prunable: false },
    { path: '/tmp/x', head: 'c'.repeat(40), branch: null, detached: true, bare: false, locked: false, prunable: true }]);
  expect(parseWorktrees(['worktree /p/bare.git', 'bare', '', ''].join('\0'))).toEqual([{ path: '/p/bare.git', head: null, branch: null, detached: false, bare: true, locked: false, prunable: false }]);
});

test('parseStashes', () => {
  expect(parseStashes(`\x1e${R(['stash@{0}', 'a'.repeat(40), 'WIP on main: abc fix', '1700000000'])}\n\x1e${R(['stash@{1}', 'b'.repeat(40), 'On feat: try', '1600000000'])}\n`))
    .toEqual([{ index: 0, oid: 'a'.repeat(40), message: 'WIP on main: abc fix', at: 1700000000 }, { index: 1, oid: 'b'.repeat(40), message: 'On feat: try', at: 1600000000 }]);
  expect(parseStashes('')).toEqual([]);
});

test('parseHistoryFilter and filterArgs', () => {
  const f = parseHistoryFilter('fix  @ada path:src/main F0D6C52 path:../x path: tail');
  expect(f).toEqual({ words: ['fix', 'path:', 'tail'], authors: ['ada'], paths: ['src/main'], sha: 'f0d6c52' });
  expect(filterArgs(f, false)).toEqual({ args: ['--grep=fix', '--grep=path:', '--grep=tail', '--all-match', '-F', '-i', '--author=ada'], paths: [':(literal)src/main'] });
  expect(filterArgs(parseHistoryFilter('abcd'), true).args).toEqual(['--grep=abcd', '--all-match', '-F', '-i']);
  expect(filterArgs(parseHistoryFilter('@Ada'), false).args).toEqual(['-F', '-i', '--author=Ada']);
  expect(filterArgs(parseHistoryFilter('abcd'), false).args).toEqual([]);
  expect(parseHistoryFilter('a'.repeat(300)).words[0]!.length).toBe(200);
  expect(parseHistoryFilter('x\0y').words).toEqual(['xy']);
  expect(parseHistoryFilter('path:./src/').paths).toEqual(['src/']);
  expect(isFilterEmpty(parseHistoryFilter('   '))).toBe(true);
  expect(isFilterEmpty(parseHistoryFilter('@a'))).toBe(false);
});
