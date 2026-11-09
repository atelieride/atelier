// GitHub on real repositories whose git dirs the project's own watcher can't read as plain `.git` folders: a project
// that is a linked worktree of a repository elsewhere (its common dir outside the project), and a submodule (its git
// dir in the superproject's .git/modules). Statuses, merge summaries and the worktree list follow them all the same.
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { posixTest } from '../support/platform';
import type { RepoStatus } from '../../src/shared/git';
import type { ScmEvent } from '../../src/shared/scm';
import { IPC } from '../../src/shared/api';
import { GitHub } from '../../src/main/git-hub';
import { commit, git } from '../support/git-fixture';

const tmp = (p: string) => realpathSync(mkdtempSync(join(tmpdir(), p)));

function window() {
  const sent: RepoStatus[][] = [];
  let destroyed: (() => void) | null = null;
  const wc = {
    id: Math.random(), isDestroyed: () => false,
    send: (ch: string, payload: unknown) => { if (ch === IPC.evGit) sent.push(payload as RepoStatus[]); },
    once: (_ev: string, cb: () => void) => { destroyed = cb; }
  };
  return { wc: wc as never, sent, close: () => destroyed?.() };
}

const opened: (() => void)[] = [];
function hub() {
  const h = new GitHub({ request: vi.fn(async () => ({})) } as never);
  const scm: ScmEvent[] = [];
  h.onScm = (_k, e) => { scm.push(e); };
  return { h, scm };
}
afterEach(() => { for (const close of opened.splice(0)) close(); });

const until = async (ok: () => boolean, ms = 8000) => {
  const end = Date.now() + ms;
  while (!ok()) { if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 50)); }
};

/** A repository with a bare remote, and the project: a linked worktree of it in another folder, on feat. */
function outsideProject() {
  const base = tmp('atl-gho-');
  const bare = join(base, 'up.git');
  git(base, 'init', '-q', '--bare', '-b', 'main', bare);
  const main = join(base, 'main');
  git(base, 'clone', '-q', bare, main);
  commit(main, 'first', { 'a.ts': '1\n', '.gitignore': '.claude/\n' });
  git(main, 'push', '-q', '-u', 'origin', 'main');
  const elsewhere = tmp('atl-gho-wt-');
  const project = join(elsewhere, 'omni');
  git(main, 'worktree', 'add', '-q', '-b', 'feat', project);
  commit(project, 'feat', { 'f.ts': 'f\n' });
  git(project, 'push', '-q', '-u', 'origin', 'feat');
  return { main, project, bare };
}

// POSIX: git prints C:/ worktree paths on Windows.
posixTest('a project that is a linked worktree of a repo elsewhere: a push from a terminal reads its status again', async () => {
  const { project } = outsideProject();
  const { h, scm } = hub();
  const w = window();
  opened.push(w.close);
  h.open(project, w.wc);
  const st = () => h.info(project)?.status.get(project);
  await until(() => st()?.upstream === 'origin/feat' && st()?.ahead === 0);
  // Committed and pushed in a terminal: the commit moves HEAD's ref, the push the remote-tracking one; both live in the
  // common dir outside the project, and no file of the project changes.
  git(project, 'commit', '-q', '--allow-empty', '-m', 'more');
  await until(() => st()?.ahead === 1);
  git(project, 'push', '-q');
  await until(() => st()?.ahead === 0);
  // Source Control hears of it too (History moves), never having been opened.
  expect(scm.some((e) => e.what === 'refs')).toBe(true);
});

posixTest('its own linked worktrees inside it (a Claude worktree) are listed, and follow a commit made in them', async () => {
  const { project } = outsideProject();
  const claude = join(project, '.claude', 'worktrees', 'agent');
  git(project, 'worktree', 'add', '-q', '-b', 'agent', claude);
  const { h } = hub();
  const w = window();
  opened.push(w.close);
  h.open(project, w.wc);
  await until(() => !!h.info(project)?.status.get(claude));
  expect(w.sent.at(-1)?.find((s) => s.root === claude)?.worktreeOf).toBe(project);
  // A worktree made after the project opened (its admin folder is outside the project too).
  const later = join(project, '.claude', 'worktrees', 'later');
  git(project, 'worktree', 'add', '-q', '-b', 'later', later);
  await until(() => !!h.info(project)?.status.get(later));
});

posixTest('a merge summary follows the default branch moving in the common dir outside the project', async () => {
  const { main, project } = outsideProject();
  const claude = join(project, '.claude', 'worktrees', 'agent');
  git(project, 'worktree', 'add', '-q', '-b', 'agent', claude);
  const { h } = hub();
  const w = window();
  opened.push(w.close);
  h.open(project, w.wc);
  const mine = () => w.sent.at(-1)?.find((s) => s.root === project)?.merge;
  await until(() => mine()?.commits === 1);
  // feat merged into main (fast-forward) in the main checkout, elsewhere: nothing left to merge.
  git(main, 'merge', '-q', '--ff-only', 'feat');
  git(main, 'push', '-q');
  await until(() => mine()?.commits === 0 || mine()?.merged === true);
});

test('a submodule: git add inside it (only its index, in the superproject’s .git/modules) reads its status again', async () => {
  const base = tmp('atl-ghs-');
  const lib = join(base, 'lib-src');
  mkdirSync(lib);
  git(lib, 'init', '-q', '-b', 'main');
  commit(lib, 'lib', { 'l.ts': 'l\n' });
  const sup = join(base, 'super');
  mkdirSync(sup);
  git(sup, 'init', '-q', '-b', 'main');
  commit(sup, 'super', { 's.ts': 's\n' });
  git(sup, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', lib, 'lib');
  git(sup, 'commit', '-q', '-m', 'add lib');
  const sub = join(sup, 'lib');
  expect(existsSync(join(sup, '.git', 'modules', 'lib', 'index'))).toBe(true);
  const { h } = hub();
  const w = window();
  opened.push(w.close);
  h.open(sup, w.wc);
  const subStatus = () => h.info(sup)?.status.get(sub);
  writeFileSync(join(sub, 'n.ts'), 'n\n');
  await until(() => subStatus()?.changes.some((c) => c.rel === 'n.ts' && c.stage === 'none') === true);
  git(sub, 'add', 'n.ts');
  await until(() => subStatus()?.changes.some((c) => c.rel === 'n.ts' && c.stage === 'all') === true);
});

test('events the OS dropped (a change with no file name: Windows\' buffer overflowed) read every repository again', async () => {
  const base = tmp('atl-gho-ovf-');
  const repo = join(base, 'r');
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  commit(repo, 'first', { 'a.ts': '1\n' });
  const { h } = hub();
  const w = window();
  opened.push(w.close);
  h.open(repo, w.wc);
  const st = () => h.info(repo)?.status.get(repo);
  // Every read the opening asked for has run.
  const sch = (h as unknown as { scheduler: { running: Set<string>; queued: Set<string>; waiting: Map<string, unknown> } }).scheduler;
  const idle = () => sch.running.size === 0 && sch.queued.size === 0 && sch.waiting.size === 0;
  await until(() => !!st() && !!h.info(repo)?.trees && idle());
  await new Promise((r) => setTimeout(r, 400));
  await until(idle);
  // The watcher hears nothing of this change (as when its buffer overflowed)…
  const watcher = (h as unknown as { projects: Map<string, { watcher: import('node:fs').FSWatcher }> }).projects.get(repo)!.watcher;
  const heard = watcher.listeners('change')[0] as (ev: string, file: string | null) => void;
  watcher.removeAllListeners('change');
  writeFileSync(join(repo, 'a.ts'), '2\n');
  await new Promise((r) => setTimeout(r, 1500));
  expect(st()?.changes).toEqual([]);
  // …then only a nameless event comes.
  heard('rename', null);
  await until(() => st()?.changes.some((c) => c.rel === 'a.ts') === true);
});
