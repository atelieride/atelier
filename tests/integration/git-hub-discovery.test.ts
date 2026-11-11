// GitHub follows the disk while a project is open: repositories cloned, renamed or deleted from outside Atelier join
// and leave without reopening it, a lower search depth drops the deeper ones, and none of it reads again the
// repositories that stayed. Real folders, real git, the project's own watcher.
// POSIX only, as the other GitHub tests on real folders: on Windows the tests' forced macOS platform meets C:\ paths,
// and a folder git is reading can't be renamed (EPERM). The pieces they build on (discovery, needsRediscovery with
// Windows separators) run on Windows in their own tests.
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, vi } from 'vitest';
import { posixTest as test } from '../support/platform';
import { IPC } from '../../src/shared/api';
import type { RepoStatus } from '../../src/shared/git';
import { GitHub } from '../../src/main/git-hub';
import * as repos from '../../src/main/git/repos';
import * as service from '../../src/main/git/service';
import * as exec from '../../src/main/git/exec';
import { gitReadLimiter } from '../../src/main/git/read-limiter';
import { commit, git } from '../support/git-fixture';

function folder(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), 'atl-ghd-')));
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
function open(root: string, o: ConstructorParameters<typeof GitHub>[1] = {}) {
  const client = { request: vi.fn(async () => ({})) };
  const h = new GitHub(client as never, o);
  const w = window();
  h.open(root, w.wc);
  opened.push(w.close);
  return { h, w };
}
afterEach(() => { for (const close of opened.splice(0)) close(); vi.restoreAllMocks(); });

const until = async (ok: () => boolean, ms = 10_000) => {
  const end = Date.now() + ms;
  while (!ok()) { if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 50)); }
};
const shown = (h: GitHub, root: string, repo: string) => !!h.info(root)?.repos.includes(repo) && !!h.info(root)?.status.get(repo);
const gone = (h: GitHub, root: string, repo: string) => !h.info(root)?.repos.includes(repo) && !h.info(root)?.status.has(repo);

test('a repository cloned inside an open project joins, inside another repository too', async () => {
  const root = folder();
  const hub = repoAt(join(root, 'hub'));
  writeFileSync(join(hub, '.gitignore'), 'guides/\n');
  const { h } = open(root);
  await until(() => shown(h, root, hub));
  const guides = repoAt(join(hub, 'guides'));
  await until(() => shown(h, root, guides));
});

test('a repository folder renamed leaves and joins under its new name', async () => {
  const root = folder();
  const old = repoAt(join(root, 'old-tools'));
  const { h } = open(root);
  await until(() => shown(h, root, old));
  renameSync(old, join(root, 'new-tools'));
  await until(() => shown(h, root, join(root, 'new-tools')) && gone(h, root, old));
});

test('a repository folder deleted leaves, also while its status read waited for a slot', async () => {
  const root = folder();
  const a = repoAt(join(root, 'a'));
  const b = repoAt(join(root, 'b'));
  const { h } = open(root);
  await until(() => shown(h, root, a) && shown(h, root, b));
  // Every slot busy: b's next read waits in the queue while its folder goes.
  const release: (() => void)[] = [];
  for (let i = 0; i < 4; i++) void gitReadLimiter.run('live', () => new Promise<void>((r) => release.push(r)));
  writeFileSync(join(b, 'a.ts'), '2\n');
  await new Promise((r) => setTimeout(r, 600));
  rmSync(b, { recursive: true, force: true });
  await new Promise((r) => setTimeout(r, 600));
  for (const r of release) r();
  await until(() => gone(h, root, b));
  expect(h.info(root)?.repos).toEqual([a]);
});

test('opening a project: every status is read before the ignored-file listings (Changes fills first)', async () => {
  const root = folder();
  for (const n of ['a', 'b', 'c', 'd', 'e', 'f']) repoAt(join(root, n));
  const order: string[] = [];
  const real = exec.runGit;
  vi.spyOn(exec, 'runGit').mockImplementation((repo, args, ...rest) => { order.push(args[0]!); return real(repo, args, ...rest); });
  // Every slot busy while the project opens: what it asks for queues, in the order it asked.
  const release: (() => void)[] = [];
  for (let i = 0; i < 4; i++) void gitReadLimiter.run('live', () => new Promise<void>((r) => release.push(r)));
  const { h } = open(root);
  await until(() => (h.info(root)?.discovered.length ?? 0) === 6);
  await new Promise((r) => setTimeout(r, 200));
  for (const r of release) r();
  await until(() => (h.info(root)?.status.size ?? 0) === 6);
  const firstListing = order.indexOf('ls-files');
  expect(order.slice(0, firstListing).filter((s) => s === 'status')).toHaveLength(6);
});

test('a hidden worktree the first listing finds: the windows hear of it at once, and its status comes before what git ignores', async () => {
  const root = folder();
  repoAt(root);
  writeFileSync(join(root, '.gitignore'), '.worktrees/\n');
  for (const n of ['a', 'b', 'c', 'd', 'e', 'f']) repoAt(join(root, n));
  const wt = join(root, '.worktrees', 'v2');
  git(root, 'worktree', 'add', '-q', '-b', 'v2', wt);
  const order: string[] = [];
  const real = exec.runGit;
  vi.spyOn(exec, 'runGit').mockImplementation((repo, args, ...rest) => { order.push(`${args[0]}:${repo}`); return real(repo, args, ...rest); });
  const { h, w } = open(root);
  // Listed: the windows are told (Source Control reloads its entries) before the worktree has a status.
  await until(() => !!h.info(root)?.trees?.some((t) => t.root === wt));
  const sentAtListing = w.sent.length;
  await until(() => w.sent.length >= sentAtListing && shown(h, root, wt));
  expect(w.sent.length).toBeGreaterThan(0);
  const firstIgnored = order.findIndex((x) => x.startsWith('ls-files:'));
  const wtStatus = order.indexOf(`status:${wt}`);
  expect(wtStatus).toBeGreaterThan(-1);
  expect(firstIgnored === -1 || wtStatus < firstIgnored).toBe(true);
});

test('the first listing tells the windows when it changes the working trees, even with no new status yet', async () => {
  const root = folder();
  repoAt(root);
  writeFileSync(join(root, '.gitignore'), '.worktrees/\n');
  const wt = join(root, '.worktrees', 'v2');
  git(root, 'worktree', 'add', '-q', '-b', 'v2', wt);
  // The root's status comes at once, the worktree's never: only the listing can tell the windows about it.
  vi.spyOn(service, 'readRepoStatus').mockImplementation((repo) => (repo === wt ? new Promise(() => {}) : Promise.resolve({
    root: repo, name: 'r', branch: 'main', detached: false, ahead: 0, behind: 0, oid: null, changes: [], checkedAt: Date.now(), truncated: 0
  })));
  const { h, w } = open(root);
  await until(() => !!h.info(root)?.trees?.some((t) => t.root === wt));
  // The same snapshot sent again right after the listing: that send is the listing's (a send with nothing new is
  // otherwise never made).
  await until(() => w.sent.some((s, i) => i > 0 && JSON.stringify(s) === JSON.stringify(w.sent[i - 1])), 3000);
});

test('a file event during the first fill doesn\'t list what git ignores ahead of the statuses', async () => {
  const root = folder();
  for (const n of ['a', 'b', 'c']) repoAt(join(root, n));
  const order: string[] = [];
  const real = exec.runGit;
  vi.spyOn(exec, 'runGit').mockImplementation((repo, args, ...rest) => { order.push(args[0]!); return real(repo, args, ...rest); });
  const release: (() => void)[] = [];
  for (let i = 0; i < 4; i++) void gitReadLimiter.run('live', () => new Promise<void>((r) => release.push(r)));
  const { h } = open(root);
  await until(() => (h.info(root)?.discovered.length ?? 0) === 3);
  // A file written in a while the project opens (an editor saving, a build).
  const p = (h as unknown as { projects: Map<string, unknown> }).projects.get(root);
  (h as unknown as { onChanges(p: unknown, rels: Set<string>): void }).onChanges(p, new Set(['a/notes.txt']));
  for (const r of release) r();
  await until(() => (h.info(root)?.status.size ?? 0) === 3);
  const firstIgnored = order.indexOf('ls-files');
  expect(order.slice(0, firstIgnored === -1 ? order.length : firstIgnored).filter((s) => s === 'status').length).toBeGreaterThanOrEqual(3);
});

test('a rescan reads no repository that stayed', async () => {
  const root = folder();
  const a = repoAt(join(root, 'a'));
  const b = repoAt(join(root, 'b'));
  const read = vi.spyOn(service, 'readRepoStatus');
  const { h } = open(root);
  await until(() => shown(h, root, a) && shown(h, root, b));
  await new Promise((r) => setTimeout(r, 1500));
  read.mockClear();
  const c = repoAt(join(root, 'c'));
  await until(() => shown(h, root, c));
  await new Promise((r) => setTimeout(r, 1500));
  expect(read.mock.calls.map((x) => x[0]).filter((r) => r !== c)).toEqual([]);
});

test('a lower search depth drops the deeper repositories and keeps the others as they were', async () => {
  const root = folder();
  const a = repoAt(join(root, 'a'));
  const deep = repoAt(join(root, 'g', 's', 'p'));
  let depth = 3;
  const { h } = open(root, { depth: () => depth });
  await until(() => shown(h, root, a) && shown(h, root, deep));
  const before = h.info(root)?.status.get(a);
  depth = 2;
  h.settingsChanged();
  await until(() => gone(h, root, deep));
  expect(h.info(root)?.status.get(a)).toBe(before);
  depth = 3;
  h.settingsChanged();
  await until(() => shown(h, root, deep));
});

test('changes during a scan run one more scan after it, not one each', async () => {
  const root = folder();
  repoAt(join(root, 'a'));
  const real = repos.discoverRepos;
  const scans = vi.spyOn(repos, 'discoverRepos').mockImplementation(async (...args) => {
    await new Promise((r) => setTimeout(r, 800));
    return real(...args);
  });
  const { h } = open(root);
  await until(() => shown(h, root, join(root, 'a')));
  const first = scans.mock.calls.length;
  for (const n of ['x', 'y', 'z']) {
    repoAt(join(root, n));
    await new Promise((r) => setTimeout(r, 400));
  }
  await until(() => ['x', 'y', 'z'].every((n) => shown(h, root, join(root, n))));
  expect(scans.mock.calls.length - first).toBeLessThanOrEqual(2);
});

test('a window coming to the front looks again when no event said a repository came, once the last look is old', async () => {
  const root = folder();
  const a = repoAt(join(root, 'a'));
  const { h } = open(root);
  await until(() => shown(h, root, a));
  const p = (h as unknown as { projects: Map<string, { watcher: { close(): void } | null; discoveredAt: number }> }).projects.get(root)!;
  // Events lost (a network drive, a dropped watcher).
  p.watcher?.close();
  const b = repoAt(join(root, 'b'));
  // A recent look: nothing yet.
  h.focused(root);
  await new Promise((r) => setTimeout(r, 800));
  expect(h.info(root)?.repos).toEqual([a]);
  p.discoveredAt = Date.now() - 61_000;
  h.focused(root);
  await until(() => shown(h, root, b));
});

test('events the OS dropped: the windows hear the root changed (Files lists every open folder again)', async () => {
  const root = folder();
  const a = repoAt(join(root, 'a'));
  const { h, w } = open(root);
  await until(() => shown(h, root, a));
  const p = (h as unknown as { projects: Map<string, unknown> }).projects.get(root);
  (h as unknown as { onChanges(p: unknown, rels: Set<string>): void }).onChanges(p, new Set(['\0rescan']));
  expect(w.files).toContainEqual([root]);
});

test('repositories sharing a folder name reach the windows with the path that tells them apart', async () => {
  const root = folder();
  const qa = repoAt(join(root, 'team-a', 'tools', 'ci'));
  const spa = repoAt(join(root, 'team-b', 'tools', 'ci'));
  const api = repoAt(join(root, 'api'));
  const { h, w } = open(root);
  const names = () => Object.fromEntries((w.sent.at(-1) ?? []).map((s) => [s.root, s.name]));
  await until(() => Object.keys(names()).length === 3);
  expect(names()).toEqual({ [qa]: 'team-a/tools/ci', [spa]: 'team-b/tools/ci', [api]: 'api' });
  void h;
});

test('the windows hear when the first scan ends, repositories or not (Changes and Source Control stop saying they look)', async () => {
  const root = folder();
  mkdirSync(join(root, 'docs'));
  const { h, w } = open(root);
  expect(h.info(root)?.searching).toBe(true);
  await until(() => w.sent.length > 0);
  expect(w.sent.at(-1)).toEqual([]);
  expect(h.info(root)?.searching).toBe(false);
});

test('a scan that newly stops at the cap tells the windows, even with the same repositories', async () => {
  const root = folder();
  for (const n of ['a', 'b', 'c']) mkdirSync(join(root, n, 'inner'), { recursive: true });
  let max = 100;
  const { h, w } = open(root, { maxFolders: () => max });
  await until(() => w.sent.length > 0 && h.info(root)?.searching === false);
  const before = w.sent.length;
  max = 1;
  h.settingsChanged();
  await until(() => h.info(root)?.capped === true);
  await until(() => w.sent.length > before);
});

test('a folder holding repositories moved into the open project: they join, no focus needed', async () => {
  const root = folder();
  const a = repoAt(join(root, 'a'));
  const elsewhere = folder();
  repoAt(join(elsewhere, 'group', 'api'));
  const { h } = open(root);
  await until(() => shown(h, root, a));
  renameSync(join(elsewhere, 'group'), join(root, 'group'));
  await until(() => shown(h, root, join(root, 'group', 'api')));
});

test('a repository whose .git is removed, its folder kept, leaves', async () => {
  const root = folder();
  const a = repoAt(join(root, 'a'));
  const b = repoAt(join(root, 'b'));
  const { h } = open(root);
  await until(() => shown(h, root, a) && shown(h, root, b));
  rmSync(join(b, '.git'), { recursive: true, force: true });
  await until(() => gone(h, root, b));
});

test('a scan stopped at its cap: git at work in a repository it never reached doesn\'t scan the folders again each time', async () => {
  const root = folder();
  for (const n of ['a', 'b', 'c', 'd']) mkdirSync(join(root, n, 'inner'), { recursive: true });
  const far = repoAt(join(root, 'd', 'inner', 'far'));
  const scans = vi.spyOn(repos, 'discoverRepos');
  const { h } = open(root, { maxFolders: () => 2 });
  await until(() => h.info(root)?.capped === true && h.info(root)?.searching === false);
  const first = scans.mock.calls.length;
  for (let i = 0; i < 4; i++) {
    writeFileSync(join(far, `f${i}.txt`), 'x\n');
    git(far, 'add', '.');
    await new Promise((r) => setTimeout(r, 400));
  }
  expect(scans.mock.calls.length - first).toBe(0);
});

test('repositories a depth change, the focus check or dropped events add are read as bulk, behind live work', async () => {
  const root = folder();
  const a = repoAt(join(root, 'a'));
  const deep = repoAt(join(root, 'x', 'y', 'z', 'deep'));
  let depth = 3;
  const { h } = open(root, { depth: () => depth });
  await until(() => shown(h, root, a));
  const asked = vi.spyOn(service.StatusScheduler.prototype, 'request');
  depth = 4;
  h.settingsChanged();
  await until(() => shown(h, root, deep));
  expect(asked.mock.calls.filter((c) => c[0] === deep).every((c) => c[1]?.bulk === true)).toBe(true);
  expect(asked.mock.calls.some((c) => c[0] === deep)).toBe(true);
});

test('the folder cap shows in the project info', async () => {
  const root = folder();
  for (const n of ['a', 'b', 'c']) mkdirSync(join(root, n, 'inner'), { recursive: true });
  const { h } = open(root, { maxFolders: () => 1 });
  await until(() => h.info(root)?.capped === true);
  expect(h.info(root)?.searching).toBe(false);
});
