// Git repositories for Source Control tests, built in the run's private temp root (never the user's config: no global
// or system git config, so no hooks, signing or aliases of whoever runs the tests).
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const fixtureGitEnv: NodeJS.ProcessEnv = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };

let clock = 1_700_000_000;

export function git(cwd: string, ...a: string[]): string {
  return execFileSync('git', ['-c', 'user.name=Ada', '-c', 'user.email=ada@example.com', '-c', 'init.defaultBranch=main', ...a], { cwd, env: fixtureGitEnv, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

/** What stashList reads while the stash ref is being rewritten: never a real list, so a poll tries again. */
export const STASH_CHANGING = '(refs/stash changing)';

/**
 * `git stash list` as `<oid> <subject>` lines, '' without stashes. Git checks that refs/stash exists, then walks its
 * reflog: a pop or drop of the last stash in between (the app's, under an e2e's poll) fails the read with "bad revision
 * 'refs/stash'". That is the ref changing under the read, not an answer: STASH_CHANGING, which no poll accepts.
 */
export function stashList(cwd: string): string {
  try {
    return git(cwd, 'stash', 'list', '--format=%H %gs').trim();
  } catch (e) {
    if (String((e as Error).message).includes("bad revision 'refs/stash'")) return STASH_CHANGING;
    throw e;
  }
}

/** Writes (string/Buffer) or deletes (null) files, stages everything and commits at a fixed, increasing time. */
export function commit(cwd: string, msg: string, files: Record<string, string | Buffer | null>, at = clock++): string {
  for (const [rel, body] of Object.entries(files)) {
    const p = join(cwd, rel);
    if (body === null) rmSync(p, { force: true });
    else { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, body); }
  }
  git(cwd, 'add', '-A');
  const date = `${at} +0000`;
  execFileSync('git', ['-c', 'user.name=Ada', '-c', 'user.email=ada@example.com', 'commit', '-q', '--allow-empty', '-m', msg], { cwd, env: { ...fixtureGitEnv, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } });
  return git(cwd, 'rev-parse', 'HEAD').trim();
}

/**
 * A commit of `files` (written or replaced) on top of the current branch, made by fast-import straight into the object
 * store, in one process: no working tree, index or hooks, which stay as they were. For thousands of files — `commit`
 * writes and adds each one, which took up to a minute on GitHub's Windows runner.
 */
export function importCommit(cwd: string, msg: string, files: Record<string, string>, at = clock++): string {
  const branch = git(cwd, 'symbolic-ref', '--short', 'HEAD').trim();
  const parent = git(cwd, 'rev-parse', 'HEAD').trim();
  const data = (s: string) => `data ${Buffer.byteLength(s)}\n${s}\n`;
  const stream = [`commit refs/heads/${branch}\ncommitter Ada <ada@example.com> ${at} +0000\n${data(msg)}from ${parent}\n`];
  for (const [rel, body] of Object.entries(files)) stream.push(`M 644 inline ${rel}\n${data(body)}`);
  execFileSync('git', ['fast-import', '--quiet'], { cwd, env: fixtureGitEnv, input: `${stream.join('')}\n` });
  return git(cwd, 'rev-parse', branch).trim();
}

export const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 1, 2, 3]);

/**
 * main: c1 (files), c2 (a.ts); feat/x off c2: f1 (co-authored by Claude), f2; main: c3 (rename with a space and
 * unicode, mode change, binary change); merge of feat/x (no fast-forward); annotated tag v1 on the merge.
 */
export function historyRepo(dir: string): { c1: string; c2: string; c3: string; f1: string; f2: string; merge: string } {
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  const c1 = commit(dir, 'feat: first files', { 'a.ts': 'one\ntwo\nthree\n', 'dir/x.ts': 'x1\n', 'old name.ts': 'r1\nr2\nr3\nr4\n', 'logo.png': PNG, 'run.sh': 'echo hi\n' });
  const c2 = commit(dir, 'fix(a): second line', { 'a.ts': 'one\nTWO\nthree\n' });
  git(dir, 'checkout', '-q', '-b', 'feat/x');
  const f1 = commit(dir, 'feat(x): change x\n\nA body line.\n\nCo-authored-by: Claude <noreply@anthropic.com>', { 'dir/x.ts': 'x1\nx2\n' });
  const f2 = commit(dir, 'feat(x): add feat.ts', { 'feat.ts': 'export const f = 1;\n' });
  git(dir, 'checkout', '-q', 'main');
  chmodSync(join(dir, 'run.sh'), 0o755);
  rmSync(join(dir, 'old name.ts'));
  const c3 = commit(dir, 'refactor: rename and chmod', { 'nuovo è.ts': 'r1\nr2\nr3\nr4\n', 'logo.png': Buffer.concat([PNG, Buffer.from([9, 9])]) });
  const date = `${clock++} +0000`;
  execFileSync('git', ['-c', 'user.name=Ada', '-c', 'user.email=ada@example.com', 'merge', '-q', '--no-ff', '-m', "Merge branch 'feat/x'", 'feat/x'], { cwd: dir, env: { ...fixtureGitEnv, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } });
  const merge = git(dir, 'rev-parse', 'HEAD').trim();
  execFileSync('git', ['-c', 'user.name=Ada', '-c', 'user.email=ada@example.com', 'tag', '-a', 'v1', '-m', 'v1'], { cwd: dir, env: { ...fixtureGitEnv, GIT_COMMITTER_DATE: date } });
  return { c1, c2, c3, f1, f2, merge };
}

/** A repo with `n` linear commits (fast-import: thousands in well under a second), on main, every 20th touching a.txt. */
export function bigRepo(dir: string, n: number): void {
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  const parts: string[] = [];
  for (let i = 1; i <= n; i++) {
    const msg = `commit ${i}`;
    parts.push(`commit refs/heads/main\nmark :${i}\ncommitter Ada <ada@example.com> ${1_600_000_000 + i} +0000\ndata ${Buffer.byteLength(msg)}\n${msg}\n${i > 1 ? `from :${i - 1}\n` : ''}M 644 inline f${i % 50}.txt\ndata ${String(i).length + 1}\n${i}\n\n`);
  }
  execFileSync('git', ['fast-import', '--quiet'], { cwd: dir, env: fixtureGitEnv, input: parts.join('') });
  git(dir, 'reset', '-q', '--hard', 'main');
}

/**
 * A project shaped like a real monorepo: the root repo (historyRepo), 19 small repos under apps/, plugins/, tools/ (apps/api with
 * an uncommitted change, apps/long with `long` commits), and a linked worktree in .worktrees/v2.
 */
export function multiRepoProject(root: string, long = 1000): { root: string; ids: ReturnType<typeof historyRepo> } {
  const ids = historyRepo(root);
  const names = ['apps/api', 'apps/web', 'apps/admin', 'apps/long', 'plugins/clickup', 'plugins/slack', 'plugins/github', 'plugins/linear', 'plugins/notion',
    'tools/cli', 'tools/lint', 'tools/build', 'tools/release', 'docs', 'infra', 'mobile', 'design', 'website', 'sdk'];
  for (const n of names) {
    const dir = join(root, n);
    if (n === 'apps/long') { bigRepo(dir, long); continue; }
    mkdirSync(dir, { recursive: true });
    git(dir, 'init', '-q', '-b', 'main');
    commit(dir, `chore: start ${n}`, { 'README.md': `# ${n}\n` });
  }
  writeFileSync(join(root, 'apps/api', 'README.md'), '# changed\n');
  writeFileSync(join(root, '.gitignore'), '.worktrees/\napps/\nplugins/\ntools/\ndocs/\ninfra/\nmobile/\ndesign/\nwebsite/\nsdk/\n');
  commit(root, 'chore: ignore nested repos', {});
  // An unmerged topic branch (compare scope) off the current main.
  git(root, 'checkout', '-q', '-b', 'topic');
  commit(root, 'feat(topic): one', { 'topic.ts': 'one\n' });
  commit(root, 'feat(topic): two', { 'topic.ts': 'one\ntwo\n', 'a.ts': 'one\nTWO\nthree\nfour\n' });
  git(root, 'checkout', '-q', 'main');
  git(root, 'worktree', 'add', '-q', '-b', 'v2', join(root, '.worktrees', 'v2'));
  return { root, ids };
}
