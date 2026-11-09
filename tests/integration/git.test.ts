import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, renameSync, statSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { posixTest } from '../support/platform';
import { toCanonical } from '../../src/shared/paths';
import { setTestDefaultPlatform } from '../../src/shared/platform';
import { discoverRepos } from '../../src/main/git/repos';
import { StatusScheduler, buildFileIndex, readHeadContent, readRepoStatus } from '../../src/main/git/service';

const git = (cwd: string, ...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd });

function repoWithCommit(dir: string) {
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  writeFileSync(join(dir, 'a.ts'), 'one\ntwo\nthree\n');
  writeFileSync(join(dir, 'old.ts'), 'x\n');
  writeFileSync(join(dir, 'to-rename.ts'), 'r1\nr2\nr3\nr4\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'first');
}

test('repo discovery: non-repo root with repos inside, node_modules and hidden folders excluded', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'atl-proj-')));
  repoWithCommit(join(root, 'app-ui'));
  repoWithCommit(join(root, 'group', 'worker'));
  repoWithCommit(join(root, 'node_modules', 'pkg'));
  repoWithCommit(join(root, '.hidden', 'x'));
  repoWithCommit(join(root, 'a', 'b', 'too-deep'));
  expect(discoverRepos(root)).toEqual([join(root, 'app-ui'), join(root, 'group', 'worker')]);
});

test('the root itself is a repo: it comes first', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'atl-proj-')));
  repoWithCommit(root);
  repoWithCommit(join(root, 'sub'));
  expect(discoverRepos(root)).toEqual([root, join(root, 'sub')]);
});

test('repo discovery: a symlinked repo folder yields its real path (like attributions), once', () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'atl-symrepo-')));
  const root = join(base, 'project');
  mkdirSync(root);
  repoWithCommit(join(base, 'elsewhere', 'api'));
  symlinkSync(join(base, 'elsewhere', 'api'), join(root, 'api'));
  expect(discoverRepos(root)).toEqual([realpathSync(join(root, 'api'))]);
  // Two links to the same repo: one root.
  repoWithCommit(join(root, 'web'));
  symlinkSync(join(root, 'web'), join(root, 'web-link'));
  expect(discoverRepos(root)).toEqual([realpathSync(join(root, 'api')), join(root, 'web')]);
});

test('status: modified, added, deleted, renamed, untracked in a new folder, counts', async () => {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), 'atl-repo-')));
  repoWithCommit(repo);
  writeFileSync(join(repo, 'a.ts'), 'one\nTWO\nthree\nfour\n');
  unlinkSync(join(repo, 'old.ts'));
  renameSync(join(repo, 'to-rename.ts'), join(repo, 'renamed.ts'));
  git(repo, 'add', '-A', 'to-rename.ts', 'renamed.ts');
  mkdirSync(join(repo, 'newdir'));
  writeFileSync(join(repo, 'newdir', 'è file.md'), 'a\nb\n');
  writeFileSync(join(repo, 'newdir', 'no-eol.txt'), 'à\nè\nì');
  writeFileSync(join(repo, 'newdir', 'empty.txt'), '');
  const st = await readRepoStatus(repo);
  expect(st).toMatchObject({ branch: 'main', detached: false });
  expect(st.error).toBeUndefined();
  const by = Object.fromEntries(st.changes.map((c) => [c.rel, c]));
  expect(by['a.ts']).toMatchObject({ kind: 'M', added: 2, removed: 1 });
  expect(by['old.ts']).toMatchObject({ kind: 'D' });
  expect(by['renamed.ts']).toMatchObject({ kind: 'R', origRel: 'to-rename.ts' });
  expect(by['newdir/è file.md']).toMatchObject({ kind: '?', added: 2 });
  expect(by['newdir/no-eol.txt']).toMatchObject({ kind: '?', added: 3 });
  expect(by['newdir/empty.txt']).toMatchObject({ kind: '?', added: 0 });
  expect(existsSync(join(repo, '.git', 'index.lock'))).toBe(false);
});

test('repo with no commits and detached HEAD', async () => {
  const empty = realpathSync(mkdtempSync(join(tmpdir(), 'atl-empty-')));
  git(empty, 'init', '-q', '-b', 'main');
  writeFileSync(join(empty, 'x.ts'), '1\n');
  const st = await readRepoStatus(empty);
  expect(st).toMatchObject({ branch: 'main' });
  expect(st.error).toBeUndefined();
  expect(st.changes[0]).toMatchObject({ rel: 'x.ts', kind: '?' });
  expect(await readHeadContent(empty, 'x.ts')).toBeNull();

  const repo = realpathSync(mkdtempSync(join(tmpdir(), 'atl-det-')));
  repoWithCommit(repo);
  git(repo, 'checkout', '-q', '--detach');
  expect(await readRepoStatus(repo)).toMatchObject({ branch: null, detached: true });
});

test('content at HEAD, suspicious paths rejected without launching git', async () => {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), 'atl-head-')));
  repoWithCommit(repo);
  expect(await readHeadContent(repo, 'a.ts')).toBe('one\ntwo\nthree\n');
  expect(await readHeadContent(repo, 'does-not-exist.ts')).toBeNull();
  expect(await readHeadContent(repo, '../outside.ts')).toBeNull();
  expect(await readHeadContent(repo, '/etc/passwd')).toBeNull();
});

test('line counts that can\'t be read (numstat fails) never wipe the status: the changes stay, without counts', async () => {
  const dir = join(realpathSync(mkdtempSync(join(tmpdir(), 'atl-numstat-'))), 'r');
  repoWithCommit(dir);
  // HEAD's blob of a.ts gone (a partial clone, a damaged store): status still works, `diff --numstat HEAD` can't.
  const blob = execFileSync('git', ['rev-parse', 'HEAD:a.ts'], { cwd: dir }).toString().trim();
  unlinkSync(join(dir, '.git', 'objects', blob.slice(0, 2), blob.slice(2)));
  writeFileSync(join(dir, 'a.ts'), 'one\ntwo\nthree\nfour\n');
  const s = await readRepoStatus(dir);
  expect(s.error).toBeUndefined();
  expect(s.branch).toBe('main');
  expect(s.changes.map((c) => [c.rel, c.kind, c.added])).toEqual([['a.ts', 'M', null]]);
});

test('folder that is no longer a repo → status with error, no exception', async () => {
  const st = await readRepoStatus(mkdtempSync(join(tmpdir(), 'atl-nogit-')));
  expect(st.error).toBeTruthy();
  expect(st.changes).toEqual([]);
});

test('scheduler: requests during a refresh merge into a single one', async () => {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), 'atl-sch-')));
  repoWithCommit(repo);
  let runs = 0;
  const s = new StatusScheduler(async (r) => { runs++; await new Promise((x) => setTimeout(x, 100)); return readRepoStatus(r); }, 0);
  const results: unknown[] = [];
  s.onResult((st) => results.push(st));
  for (let i = 0; i < 10; i++) s.request(repo);
  await new Promise((x) => setTimeout(x, 600));
  expect(runs).toBe(2); // the one in progress + a single queued one
  expect(results.length).toBe(2);
});

test('readRepoStatus never rewrites .git/index (file with changed mtime and same content)', async () => {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), 'atl-idx-')));
  repoWithCommit(repo);
  const later = new Date(Date.now() + 5000);
  utimesSync(join(repo, 'a.ts'), later, later); // stat-dirty, identical content
  const before = statSync(join(repo, '.git', 'index'));
  await readRepoStatus(repo);
  await readRepoStatus(repo);
  const after = statSync(join(repo, '.git', 'index'));
  expect(after.ino).toBe(before.ino);
  expect(after.mtimeMs).toBe(before.mtimeMs);
});

test('GIT_* environment variables do not hijack git to another repo', async () => {
  const a = realpathSync(mkdtempSync(join(tmpdir(), 'atl-a-')));
  const b = realpathSync(mkdtempSync(join(tmpdir(), 'atl-b-')));
  repoWithCommit(a);
  repoWithCommit(b);
  writeFileSync(join(b, 'only-in-b.ts'), 'x');
  const saved = { dir: process.env.GIT_DIR, wt: process.env.GIT_WORK_TREE };
  process.env.GIT_DIR = join(b, '.git');
  process.env.GIT_WORK_TREE = b;
  try {
    const st = await readRepoStatus(a);
    expect(st.changes.map((c) => c.rel)).not.toContain('only-in-b.ts');
  } finally {
    if (saved.dir === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = saved.dir;
    if (saved.wt === undefined) delete process.env.GIT_WORK_TREE; else process.env.GIT_WORK_TREE = saved.wt;
  }
});

test('core.fsmonitor configured in the repo is not executed', async () => {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), 'atl-fsm-')));
  repoWithCommit(repo);
  const marker = join(repo, 'EXECUTED');
  const script = join(repo, 'fsmon.sh');
  writeFileSync(script, `#!/bin/sh\ntouch '${marker}'\n`);
  chmodSync(script, 0o755);
  git(repo, 'config', 'core.fsmonitor', script);
  await readRepoStatus(repo);
  expect(existsSync(marker)).toBe(false);
});

test('scheduler: minimum interval per repo between two reads', async () => {
  let runs: number[] = [];
  const s = new StatusScheduler(async (r) => { runs.push(Date.now()); return { root: r, name: 'x', branch: null, detached: false, ahead: 0, behind: 0, oid: null, changes: [], checkedAt: Date.now(), truncated: 0 }; }, 400);
  s.request('/r');
  await new Promise((x) => setTimeout(x, 50));
  s.request('/r');
  await new Promise((x) => setTimeout(x, 700));
  expect(runs).toHaveLength(2);
  expect(runs[1]! - runs[0]!).toBeGreaterThanOrEqual(380);
  runs = [];
});

// After an Atelier git write (a checkbox, Stage All) the read that shows it starts at once: the spacing is for bursts
// of file events, not for the user waiting on a click. One read at a time all the same.
test('scheduler: a read asked "soon" (after a git write) skips the spacing, one at a time all the same', async () => {
  const runs: number[] = [];
  let release: (() => void) | null = null;
  const s = new StatusScheduler(async (r) => {
    runs.push(Date.now());
    if (runs.length === 3) await new Promise<void>((x) => { release = x; });
    return { root: r, name: 'x', branch: null, detached: false, ahead: 0, behind: 0, oid: null, changes: [], checkedAt: Date.now(), truncated: 0 };
  }, 1000);
  const t0 = Date.now();
  s.request('/r');
  await new Promise((x) => setTimeout(x, 30));
  s.request('/r');
  s.request('/r', { soon: true });
  await new Promise((x) => setTimeout(x, 30));
  expect(runs).toHaveLength(2);
  expect(runs[1]! - t0).toBeLessThan(500);
  // Another soon one starts at once too; one asked while that runs follows it at once (not a second later). The plain
  // one that was waiting was folded in: no read of its own later.
  s.request('/r', { soon: true });
  await new Promise((x) => setTimeout(x, 30));
  expect(runs).toHaveLength(3);
  s.request('/r', { soon: true });
  const before = Date.now();
  release!();
  await new Promise((x) => setTimeout(x, 30));
  expect(runs).toHaveLength(4);
  expect(runs[3]! - before).toBeLessThan(500);
  await new Promise((x) => setTimeout(x, 1100));
  expect(runs).toHaveLength(4);
});

test('thousands of untracked files (node_modules not yet ignored): list limited, quickly', async () => {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), 'atl-flood-')));
  repoWithCommit(repo);
  writeFileSync(join(repo, 'a.ts'), 'modified\n');
  mkdirSync(join(repo, 'node_modules', 'pkg'), { recursive: true });
  for (let i = 0; i < 3000; i++) writeFileSync(join(repo, 'node_modules', 'pkg', `f${i}.js`), 'x\n');
  const t0 = Date.now();
  const st = await readRepoStatus(repo);
  expect(Date.now() - t0).toBeLessThan(5000);
  expect(st.changes.length).toBeLessThanOrEqual(2000);
  expect(st.truncated).toBe(3001 - st.changes.length);
  // Modified tracked files always come first.
  expect(st.changes[0]).toMatchObject({ rel: 'a.ts', kind: 'M' });
});

// As the machine, with the paths main gets there (canonical C:/… on Windows, where this was found): with the darwin
// default, a native C:\ path is not "inside" the project and the nested repo was dropped (nightly run of 2026-10-23).
test('file index: a repository git refuses to read (safe.directory, a broken .git) is walked like a folder: ⌘K still finds its files', async () => {
  setTestDefaultPlatform(null);
  try {
    const root = toCanonical(realpathSync.native(mkdtempSync(join(tmpdir(), 'atl-idxr-'))));
    repoWithCommit(root);
    repoWithCommit(join(root, 'svc'));
    // git stops at a HEAD it can't read, as it does at another user's folder: every read of that repo fails.
    writeFileSync(join(root, '.git', 'HEAD'), 'garbage\n');
    writeFileSync(join(root, 'svc', '.git', 'HEAD'), 'garbage\n');
    writeFileSync(join(root, 'notes.md'), 'x');
    const files = (await buildFileIndex(root, [root, `${root}/svc`])).map((f) => f.rel).sort();
    expect(files).toEqual(['a.ts', 'notes.md', 'old.ts', 'svc/a.ts', 'svc/old.ts', 'svc/to-rename.ts', 'to-rename.ts']);
  } finally {
    setTestDefaultPlatform('darwin');
  }
});

// POSIX: the executable bit and symlinks.
posixTest('file index for ⌘K: tracked and untracked non-ignored, in all repos, plus files outside the repos', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'atl-idxf-')));
  repoWithCommit(join(root, 'app'));
  writeFileSync(join(root, 'app', '.gitignore'), 'dist/\n');
  mkdirSync(join(root, 'app', 'dist'));
  writeFileSync(join(root, 'app', 'dist', 'bundle.js'), 'x');
  writeFileSync(join(root, 'app', 'new.ts'), 'x');
  writeFileSync(join(root, 'dev.sh'), 'x');
  mkdirSync(join(root, 'node_modules', 'p'), { recursive: true });
  writeFileSync(join(root, 'node_modules', 'p', 'i.js'), 'x');
  const files = (await buildFileIndex(root, discoverRepos(root))).map((f) => f.rel).sort();
  expect(files).toEqual(['app/.gitignore', 'app/a.ts', 'app/new.ts', 'app/old.ts', 'app/to-rename.ts', 'dev.sh']);
});

test('file index: a repo reached through a symlink to outside the project adds no files (they cannot be opened)', async () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'atl-idxs-')));
  const root = join(base, 'project');
  mkdirSync(root);
  repoWithCommit(join(base, 'elsewhere', 'api'));
  symlinkSync(join(base, 'elsewhere', 'api'), join(root, 'api'));
  writeFileSync(join(root, 'dev.sh'), 'x');
  const files = await buildFileIndex(root, discoverRepos(root));
  expect(files).toEqual([{ path: join(root, 'dev.sh'), rel: 'dev.sh' }]);
});

// POSIX: the executable bit and symlinks.
posixTest('headTarget: a symlink inside the project points to the real file of the repo', async () => {
  const { headTarget } = await import('../../src/main/git-head');
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'atl-ht-')));
  repoWithCommit(join(root, 'app'));
  symlinkSync(join(root, 'app', 'a.ts'), join(root, 'link.ts'));
  expect(headTarget(root, [join(root, 'app')], join(root, 'link.ts'))).toEqual({ repo: join(root, 'app'), rel: 'a.ts' });
  expect(headTarget(root, [join(root, 'app')], '/etc/passwd')).toBeNull();
});
