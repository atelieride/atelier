// GitHub with linked worktrees, on real repositories: what it prunes on a reopen, what a
// failed worktree listing keeps, and merge summaries once a repo's last worktree is gone.
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { posixTest } from '../support/platform';
import type { RepoStatus } from '../../src/shared/git';
import { IPC } from '../../src/shared/api';
import { GitHub } from '../../src/main/git-hub';
import * as repos from '../../src/main/git/repos';
import { commit, git } from '../support/git-fixture';

function project(): { root: string; wt: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'atl-ghw-')));
  git(root, 'init', '-q', '-b', 'main');
  commit(root, 'first', { 'a.ts': '1\n', '.gitignore': '.claude/\n' });
  const wt = join(root, '.claude', 'worktrees', 'vad');
  git(root, 'worktree', 'add', '-q', '-b', 'worktree-vad', wt);
  return { root, wt };
}

/** A window for GitHub: what it was sent, and a way to close it. */
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

const hubs: GitHub[] = [];
function hub() {
  const prunes: { root: string; exclude: string[] }[] = [];
  const client = { request: vi.fn(async (m: { t: string; root: string; exclude: string[] }) => { if (m.t === 'attrPrune') prunes.push({ root: m.root, exclude: m.exclude }); return {}; }) };
  const h = new GitHub(client as never);
  hubs.push(h);
  return { h, prunes };
}
afterEach(() => { hubs.length = 0; });

const until = async (ok: () => boolean, ms = 8000) => {
  const end = Date.now() + ms;
  while (!ok()) { if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 50)); }
};

// POSIX: git prints C:/ worktree paths on Windows.
posixTest('reopened after main moved: the first prune of the repo already leaves its worktrees\' attributions alone', async () => {
  const { root, wt } = project();
  const { h, prunes } = hub();
  const w1 = window();
  h.open(root, w1.wc);
  await until(() => !!h.info(root)?.status.get(wt) && !!h.info(root)?.status.get(root));
  w1.close();
  commit(root, 'moved', { 'a.ts': '2\n' });
  // The worktrees are listed after the repo's first status this time (a slow `git worktree list`).
  const real = repos.listWorkingTrees;
  const slow = vi.spyOn(repos, 'listWorkingTrees').mockImplementation(async (...a) => { await new Promise((r) => setTimeout(r, 1500)); return real(...a); });
  const w2 = window();
  h.open(root, w2.wc);
  await until(() => prunes.some((x) => x.root === root));
  await new Promise((r) => setTimeout(r, 2000));
  expect(prunes.filter((x) => x.root === root).every((x) => x.exclude.includes(wt))).toBe(true);
  slow.mockRestore();
  w2.close();
});

// POSIX: git prints C:/ worktree paths on Windows.
posixTest('the last worktree removed: the main checkout\'s merge summary goes with it', async () => {
  const { root, wt } = project();
  // Main on a feature branch: it has its own summary while the repo has a linked worktree.
  git(root, 'checkout', '-q', '-b', 'feat');
  commit(root, 'feat', { 'b.ts': '1\n' });
  const { h } = hub();
  const w = window();
  h.open(root, w.wc);
  const last = () => w.sent.at(-1) ?? [];
  await until(() => last().find((s) => s.root === root)?.merge?.commits === 1);
  git(root, 'worktree', 'remove', '--force', wt);
  await until(() => !last().some((s) => s.root === wt));
  await until(() => last().find((s) => s.root === root)?.merge === null);
  w.close();
});

/** The project's watcher stops, as when macOS drops events under a flood of writes. */
const deafen = (h: GitHub, root: string) => (h as unknown as { projects: Map<string, { watcher: { close(): void } | null }> }).projects.get(root)?.watcher?.close();

// POSIX: git prints C:/ worktree paths on Windows.
posixTest('a worktree removed while its events were lost: a failing status of it lists the worktrees again', async () => {
  const { root, wt } = project();
  const { h } = hub();
  const w = window();
  h.open(root, w.wc);
  await until(() => !!h.info(root)?.status.get(wt));
  deafen(h, root);
  git(root, 'worktree', 'remove', '--force', wt);
  // A hook reports a file of it (or anything else asks for its status): the status fails, its folder is gone.
  h.touched(join(wt, 'a.ts'));
  await until(() => !h.info(root)?.repos.includes(wt) && !h.info(root)?.status.has(wt));
  w.close();
});

// POSIX: git prints C:/ worktree paths on Windows.
posixTest('a worktree removed while its events were lost: the next refs change lists the worktrees again', async () => {
  const { root, wt } = project();
  const { h } = hub();
  const w = window();
  h.open(root, w.wc);
  await until(() => !!h.info(root)?.status.get(wt));
  deafen(h, root);
  git(root, 'worktree', 'remove', '--force', wt);
  commit(root, 'later', { 'a.ts': '3\n' });
  const p = (h as unknown as { projects: Map<string, unknown> }).projects.get(root);
  (h as unknown as { onChanges(p: unknown, rels: Set<string>): void }).onChanges(p, new Set(['.git/refs/heads/main']));
  await until(() => !h.info(root)?.repos.includes(wt));
  w.close();
});
