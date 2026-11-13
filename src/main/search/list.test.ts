import { existsSync, mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { useMachinePlatform } from '../../../tests/support/platform';
import { git } from '../../../tests/support/git-fixture';
import { validateGitArgs } from '../git/exec';
import { LS_ARGS, LS_IGNORED_FILES_ARGS, listSearchFiles } from './list';

useMachinePlatform();

const all = () => true;

function put(root: string, rel: string, body = 'x\n'): void {
  const p = join(root, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, body);
}

function tmp(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), 'atl-list-')));
}

/** root: a repo with tracked, untracked and ignored files; a nested repo; a plain folder; a deep file. */
function project(): { root: string; nested: string } {
  const root = join(tmp(), 'proj');
  mkdirSync(root);
  git(root, 'init', '-q', '-b', 'main');
  put(root, '.gitignore', 'secret.txt\nnode_modules/\n');
  put(root, 'src/tracked.ts');
  put(root, 'secret.txt');
  put(root, 'node_modules/x.js');
  git(root, 'add', '.gitignore', 'src/tracked.ts');
  git(root, 'commit', '-q', '-m', 'start');
  put(root, 'src/untracked.ts');
  const nested = join(root, 'packages', 'inner');
  mkdirSync(nested, { recursive: true });
  git(nested, 'init', '-q', '-b', 'main');
  put(nested, 'inner.ts');
  git(nested, 'add', '-A');
  git(nested, 'commit', '-q', '-m', 'inner');
  put(nested, 'inner-untracked.ts');
  return { root, nested };
}

const rels = (r: { files: { rel: string }[] }) => r.files.map((f) => f.rel);

describe('listing', () => {
  test('the git arguments are allowed read-only ones', () => {
    expect(() => validateGitArgs(LS_ARGS)).not.toThrow();
    expect(() => validateGitArgs(LS_IGNORED_FILES_ARGS)).not.toThrow();
  });

  test('repo: tracked and untracked files, not ignored ones; a nested repo lists its own files once', async () => {
    const { root, nested } = project();
    const r = await listSearchFiles(root, [root, nested], { includeIgnored: false, cap: 1000, filter: all });
    expect(r.capped).toBe(false);
    expect(rels(r)).toEqual([
      '.gitignore',
      'packages/inner/inner-untracked.ts',
      'packages/inner/inner.ts',
      'src/tracked.ts',
      'src/untracked.ts',
    ]);
    expect(r.files.every((f) => !f.ignored && f.path === join(root, f.rel))).toBe(true);
    expect(rels(r).some((x) => x.startsWith('.git/') || x.includes('/.git/'))).toBe(false);
  });

  test('ignored mode: ignored files come after every other file, marked, sorted', async () => {
    const { root, nested } = project();
    const r = await listSearchFiles(root, [root, nested], { includeIgnored: true, cap: 1000, filter: all });
    const tail = r.files.slice(-2);
    expect(tail.map((f) => [f.rel, f.ignored])).toEqual([['node_modules/x.js', true], ['secret.txt', true]]);
    expect(r.files.slice(0, -2).every((f) => !f.ignored)).toBe(true);
    expect(rels(r).some((x) => x.includes('.git/'))).toBe(false);
  });

  test('a folder outside any repo: dot folders listed, build folders not, deep files listed', async () => {
    const root = tmp();
    put(root, '.github/w.yml');
    put(root, 'dist/a.js');
    put(root, 'a/b/c/d/e/f/g/h/i/deep.txt');
    put(root, 'top.txt');
    put(root, '.git/config');
    const r = await listSearchFiles(root, [], { includeIgnored: false, cap: 1000, filter: all });
    expect(rels(r)).toEqual(['.github/w.yml', 'a/b/c/d/e/f/g/h/i/deep.txt', 'top.txt']);
    const withIgnored = await listSearchFiles(root, [], { includeIgnored: true, cap: 1000, filter: all });
    expect(withIgnored.files.map((f) => [f.rel, f.ignored])).toEqual([
      ['.github/w.yml', false], ['a/b/c/d/e/f/g/h/i/deep.txt', false], ['top.txt', false], ['dist/a.js', true],
    ]);
  });

  test('a repo git will not read is walked', async () => {
    const root = tmp();
    mkdirSync(join(root, 'broken', '.git'), { recursive: true });
    put(root, 'broken/f.txt');
    const r = await listSearchFiles(root, [join(root, 'broken')], { includeIgnored: false, cap: 1000, filter: all });
    expect(rels(r)).toEqual(['broken/f.txt']);
  });

  test('cap: never cuts a non-ignored file while an ignored one is listed', async () => {
    const { root, nested } = project();
    const r = await listSearchFiles(root, [root, nested], { includeIgnored: true, cap: 3, filter: all });
    expect(r.capped).toBe(true);
    expect(r.files).toHaveLength(3);
    expect(r.files.every((f) => !f.ignored)).toBe(true);
    const r2 = await listSearchFiles(root, [root, nested], { includeIgnored: true, cap: 6, filter: all });
    expect(r2.capped).toBe(true);
    expect(r2.files.map((f) => f.ignored)).toEqual([false, false, false, false, false, true]);
    const r3 = await listSearchFiles(root, [root, nested], { includeIgnored: true, cap: 7, filter: all });
    expect(r3.capped).toBe(false);
    expect(r3.files).toHaveLength(7);
  });

  test('the filter applies before the cap', async () => {
    const { root, nested } = project();
    const r = await listSearchFiles(root, [root, nested], { includeIgnored: false, cap: 1, filter: (rel) => rel === 'src/untracked.ts' });
    expect(rels(r)).toEqual(['src/untracked.ts']);
    expect(r.capped).toBe(false);
  });

  test.skipIf(process.platform === 'win32')('symlink loops and links out of the project are not followed', async () => {
    const base = tmp();
    const root = join(base, 'proj');
    const outside = join(base, 'outside');
    mkdirSync(root);
    put(outside, 'secret.txt');
    put(root, 'real/a.txt');
    symlinkSync(root, join(root, 'real', 'loop'));
    symlinkSync(outside, join(root, 'out'));
    const r = await listSearchFiles(root, [], { includeIgnored: true, cap: 1000, filter: all });
    expect(rels(r)).toEqual(['real/a.txt']);
  });

  test('the cap never cuts a plain file of a plain folder while ignored ones are listed', async () => {
    const root = tmp();
    for (const f of ['build/1.js', 'build/2.js', 'build/3.js','node_modules/x.js', 'z.txt']) put(root, f);
    const r = await listSearchFiles(root, [], { includeIgnored: true, cap: 2, filter: all });
    expect(r.capped).toBe(true);
    expect(r.files).toHaveLength(2);
    expect(r.files[0]).toMatchObject({ rel: 'z.txt', ignored: false });
    expect(r.files[1]!.ignored).toBe(true);
  });

  test('a nested repo with many ignored files does not push out the plain files around it', async () => {
    const root = tmp();
    const repo = join(root, 'inner');
    mkdirSync(repo);
    git(repo, 'init', '-q', '-b', 'main');
    put(repo, '.gitignore', 'junk/\n');
    for (const n of [1, 2, 3, 4]) put(repo, `junk/${n}.js`);
    put(root, 'z.txt');
    put(root, 'sub/y.txt');
    const r = await listSearchFiles(root, [repo], { includeIgnored: true, cap: 3, filter: all });
    expect(r.capped).toBe(true);
    expect(rels(r)).toEqual(['inner/.gitignore', 'sub/y.txt', 'z.txt']);
  });

  test('an ignored listing too large for git stops there: capped, and the plain listing is still git\'s', async () => {
    const { root, nested } = project();
    const r = await listSearchFiles(root, [root, nested], { includeIgnored: true, cap: 1000, filter: all, ignoredMaxBytes: 5 });
    expect(r.capped).toBe(true);
    // Walked instead, secret.txt (ignored by .gitignore) would show up as a plain file.
    expect(rels(r)).toEqual(['.gitignore', 'packages/inner/inner-untracked.ts', 'packages/inner/inner.ts', 'src/tracked.ts', 'src/untracked.ts']);
  });

  test('a repo inside a plain folder is listed by git, the plain files around it by the walk', async () => {
    const root = tmp();
    const repo = join(root, 'tools', 'repo');
    mkdirSync(repo, { recursive: true });
    git(repo, 'init', '-q', '-b', 'main');
    put(repo, 'r.txt');
    put(repo, '.gitignore', 'ig.txt\n');
    put(repo, 'ig.txt');
    put(root, 'tools/p.txt');
    put(root, 'top.txt');
    const r = await listSearchFiles(root, [repo], { includeIgnored: false, cap: 100, filter: all });
    expect(rels(r)).toEqual(['tools/p.txt', 'tools/repo/.gitignore', 'tools/repo/r.txt', 'top.txt']);
  });

  test.skipIf(process.platform === 'win32')('a symlinked file and the project root are resolved by one rule: a root reached by another spelling still holds the file', async () => {
    const base = tmp();
    const root = join(base, 'Proj');
    put(root, 'a.txt');
    symlinkSync(join(root, 'a.txt'), join(root, 'b.txt'));
    // The project reached by another spelling of its folder, as a file system that ignores case (macOS's) allows; on
    // one that tells case apart there is no such spelling to try.
    const spelled = join(base, 'PROJ');
    if (!existsSync(spelled)) return;
    const r = await listSearchFiles(spelled, [], { includeIgnored: false, cap: 100, filter: all });
    expect(rels(r)).toEqual(['a.txt', 'b.txt']);
  });

  test.skipIf(process.platform === 'win32')('a link to a folder inside the project is not followed: the folder is listed under its own name', async () => {
    const root = tmp();
    put(root, 'real/a.txt');
    symlinkSync(join(root, 'real'), join(root, 'alink'));
    const r = await listSearchFiles(root, [], { includeIgnored: false, cap: 100, filter: all });
    expect(rels(r)).toEqual(['real/a.txt']);
  });
});
