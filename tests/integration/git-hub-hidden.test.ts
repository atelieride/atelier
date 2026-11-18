// Repositories the user hid from a project: GitHub drops them (and the repositories inside them) at once, never reads
// their status, and their own git activity — a service fetching into its clone — neither scans the folders again nor
// reaches Source Control. Files changed in there still reach open editors. Shown again, they come back.
// Real folders, real git, the project's own watcher. POSIX only, as the other GitHub tests on real folders.
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, vi } from 'vitest';
import { posixTest as test } from '../support/platform';
import { IPC } from '../../src/shared/api';
import type { RepoStatus } from '../../src/shared/git';
import { GitHub } from '../../src/main/git-hub';
import * as repos from '../../src/main/git/repos';
import * as exec from '../../src/main/git/exec';
import { commit, git } from '../support/git-fixture';
import { isInside } from '../../src/shared/paths';

function folder(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), 'atl-ghh-')));
}

function repoAt(dir: string): string {
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  commit(dir, 'first', { 'a.ts': '1\n' });
  return dir;
}

function window() {
  const sent: RepoStatus[][] = [];
  const files: string[][] = [];
  let destroyed: (() => void) | null = null;
  const wc = {
    id: Math.random(), isDestroyed: () => false,
    send: (ch: string, payload: unknown) => {
      if (ch === IPC.evGit) sent.push(payload as RepoStatus[]);
      if (ch === IPC.evFsChanged) files.push(payload as string[]);
    },
    once: (_ev: string, cb: () => void) => { destroyed = cb; }
  };
  return { wc: wc as never, sent, files, close: () => destroyed?.() };
}

const opened: (() => void)[] = [];
/** A project open in one window, its hidden list the test's own (as the store would answer). */
function open(root: string, hidden: string[] = []) {
  const client = { request: vi.fn(async () => ({})) };
  const h = new GitHub(client as never, { depth: () => 4, hidden: () => hidden });
  const w = window();
  h.open(root, w.wc);
  opened.push(w.close);
  return { h, w, hidden, client };
}
afterEach(() => { for (const close of opened.splice(0)) close(); vi.restoreAllMocks(); });

const until = async (ok: () => boolean, ms = 10_000) => {
  const end = Date.now() + ms;
  while (!ok()) { if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 50)); }
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * The project's git reads from now on; `settle` waits until none is running and none has started for a while (what
 * opening the project reads, and the events of the folders the test just made, are over), then forgets them. A read
 * is several git commands in a row (a status, then its HEAD and its diff): one still running counts.
 */
function gitReads(root: string) {
  const reads: string[] = [];
  let last = Date.now();
  let running = 0;
  const real = exec.runGit;
  vi.spyOn(exec, 'runGit').mockImplementation((repo, args, ...rest) => {
    if (!isInside(root, repo)) return real(repo, args, ...rest);
    reads.push(`${repo} ${args[0]}`);
    running++;
    last = Date.now();
    return real(repo, args, ...rest).finally(() => { running--; last = Date.now(); });
  });
  const settle = async () => { await until(() => running === 0 && Date.now() - last > 1000, 15_000); reads.splice(0); };
  return { reads, settle };
}

const shown = (h: GitHub, root: string, repo: string) => !!h.info(root)?.repos.includes(repo) && !!h.info(root)?.status.get(repo);
const gone = (h: GitHub, root: string, repo: string) => !h.info(root)?.repos.includes(repo) && !h.info(root)?.status.has(repo)
  && !h.info(root)?.discovered.includes(repo);
const lastSent = (w: ReturnType<typeof window>) => (w.sent.at(-1) ?? []).map((s) => s.root);

/** A clone a service keeps inside another repository (`agent`, which ignores it), with a repository of its own inside. */
function nestedClone() {
  const root = folder();
  const ka = repoAt(join(root, 'agent'));
  writeFileSync(join(ka, '.gitignore'), 'data/\n');
  const clone = repoAt(join(ka, 'data', 'repo'));
  const inner = repoAt(join(clone, 'inner'));
  const tools = repoAt(join(root, 'tools'));
  return { root, ka, clone, inner, tools };
}

test('a project opened with a hidden repository never shows it, nor the repositories inside it', async () => {
  const { root, ka, clone, inner, tools } = nestedClone();
  const { h, w } = open(root, ['agent/data/repo']);
  await until(() => shown(h, root, ka) && shown(h, root, tools));
  await sleep(300);
  expect(gone(h, root, clone) && gone(h, root, inner)).toBe(true);
  expect(lastSent(w)).not.toContain(clone);
});

test('hiding a repository of an open project: it and the repositories inside it leave the windows, the others stay', async () => {
  const { root, ka, clone, inner, tools } = nestedClone();
  const { h, w, hidden } = open(root);
  await until(() => shown(h, root, clone) && shown(h, root, inner) && shown(h, root, ka) && shown(h, root, tools));
  hidden.push('agent/data/repo');
  const scans = vi.spyOn(repos, 'discoverRepos');
  h.hiddenChanged(root);
  // Gone from what GitHub knows before any scan answers: the windows don't wait for the folders to be read.
  expect(h.info(root)?.discovered).not.toContain(clone);
  await until(() => gone(h, root, clone) && gone(h, root, inner) && !lastSent(w).includes(clone) && !lastSent(w).includes(inner));
  expect(lastSent(w)).toEqual(expect.arrayContaining([ka, tools]));
  expect(scans).toHaveBeenCalled();
});

test('shown again: the repository and the ones inside it come back', async () => {
  const { root, clone, inner, tools } = nestedClone();
  const { h, hidden } = open(root, ['agent/data/repo']);
  await until(() => shown(h, root, tools));
  hidden.splice(0);
  h.hiddenChanged(root);
  await until(() => shown(h, root, clone) && shown(h, root, inner));
});

test('git at work in a hidden repository (a service fetching, committing) scans no folder again and reads no status', async () => {
  const { root, ka, clone, tools } = nestedClone();
  const { reads, settle } = gitReads(root);
  const { h } = open(root, ['agent/data/repo']);
  await until(() => shown(h, root, ka) && shown(h, root, tools));
  await settle();
  const scans = vi.spyOn(repos, 'discoverRepos');
  for (let i = 0; i < 3; i++) {
    commit(clone, `sync ${i}`, { [`f${i}.txt`]: 'x\n' });
    git(clone, 'update-ref', `refs/remotes/origin/main`, 'HEAD');
    await sleep(400);
  }
  await sleep(600);
  expect(scans).not.toHaveBeenCalled();
  expect(reads).toEqual([]);
});

test('a file changed in a hidden repository still reaches open editors, and asks no status of the repository around it', async () => {
  const { root, ka, clone, tools } = nestedClone();
  const { reads, settle } = gitReads(root);
  const { h, w } = open(root, ['agent/data/repo']);
  await until(() => shown(h, root, ka) && shown(h, root, tools));
  await settle();
  const file = join(clone, 'notes.md');
  writeFileSync(file, 'hello\n');
  await until(() => w.files.some((f) => f.includes(file)));
  // A Claude session editing a file in there (hook): no status of agent either.
  h.touched(file);
  await sleep(600);
  expect(reads).toEqual([]);
});

test('git at work in a hidden submodule, whose git dir lives in its parent\'s .git: Source Control hears nothing of it, the parent\'s status is not read', async () => {
  const root = folder();
  const lib = repoAt(join(folder(), 'lib'));
  const app = repoAt(join(root, 'app'));
  git(app, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', lib, 'vendor/lib');
  git(app, 'commit', '-q', '-m', 'lib');
  const sub = join(app, 'vendor', 'lib');
  const { reads, settle } = gitReads(root);
  const { h } = open(root, ['app/vendor/lib']);
  const heard: string[] = [];
  h.onScm = (_p, e) => heard.push(e.common);
  await until(() => shown(h, root, app));
  await settle();
  expect(h.info(root)?.repos).not.toContain(sub);
  // A service fetching into its clone (FETCH_HEAD, remote refs in app/.git/modules), then committing there.
  commit(lib, 'upstream', { 'c.ts': '3\n' });
  git(sub, 'fetch', '-q', 'origin');
  commit(sub, 'local', { 'b.ts': '2\n' });
  await sleep(1200);
  expect(heard.filter((c) => c.includes(join('modules', 'vendor')))).toEqual([]);
  expect(reads).toEqual([]);
});

test('a hidden repository inside a shown one keeps its attributions: the shown one\'s prune leaves its folder alone', async () => {
  const { root, ka, clone, tools } = nestedClone();
  const { h, client } = open(root, ['agent/data/repo']);
  const nested: string[][] = [];
  h.onStatus = (st, o) => { if (st.root === ka && o.prune) nested.push(o.exclude); };
  await until(() => shown(h, root, ka) && shown(h, root, tools));
  await sleep(500);
  // A commit in agent moves its HEAD: its next status prunes the attributions of its clean files.
  commit(ka, 'next', { 'b.ts': '2\n' });
  const prunes = () => (client.request.mock.calls as unknown as [{ t: string; root: string; exclude?: string[] }][]).map(([r]) => r).filter((r) => r.t === 'attrPrune' && r.root === ka);
  await until(() => prunes().length > 0);
  for (const r of prunes()) expect(r.exclude).toContain(clone);
  await until(() => nested.length > 0);
  expect(nested.at(-1)).toContain(clone);
});

test('hidden while a scan runs: what that scan found of the hidden store (a linked worktree elsewhere) is never read', async () => {
  const { root, ka, clone, tools } = nestedClone();
  const side = join(root, 'side');
  git(clone, 'worktree', 'add', '-q', '-b', 'side', side);
  const { reads, settle } = gitReads(root);
  const { h, hidden } = open(root);
  await until(() => shown(h, root, ka) && shown(h, root, tools) && shown(h, root, side));
  // What opening the project reads is over: a status or a listing that began before the hide may still end after it.
  await settle();
  // A scan that started before the hide: it answers as if nothing were hidden, once let go.
  const real = repos.discoverRepos;
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => { release = r; });
  vi.spyOn(repos, 'discoverRepos').mockImplementationOnce(async (r, o) => { await gate; return real(r, { ...o, hidden: [] }); });
  h.settingsChanged();
  hidden.push('agent/data/repo');
  h.hiddenChanged(root);
  await until(() => gone(h, root, side) && gone(h, root, clone));
  release();
  await sleep(1500);
  expect(reads.filter((r) => [clone, side].some((dir) => r.startsWith(`${dir} `) || r.startsWith(`${dir}/`)))).toEqual([]);
  expect(gone(h, root, side)).toBe(true);
});

test('a hidden repository its parent doesn\'t ignore: a file changed in it still asks no status of the parent', async () => {
  const { root, ka, clone, tools } = nestedClone();
  // agent no longer ignores data/: for git, the clone is an untracked folder of agent.
  writeFileSync(join(ka, '.gitignore'), '');
  const { reads, settle } = gitReads(root);
  const { h, w } = open(root, ['agent/data/repo']);
  await until(() => shown(h, root, ka) && shown(h, root, tools));
  await settle();
  const file = join(clone, 'notes.md');
  writeFileSync(file, 'hello\n');
  await until(() => w.files.some((f) => f.includes(file)));
  await sleep(600);
  expect(reads).toEqual([]);
});
