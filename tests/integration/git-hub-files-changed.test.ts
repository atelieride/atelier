// Find in Files hears from the project's watcher when files change on disk, to say its results may be out of date:
// any change to a file of the project, flagged when git ignores every file that changed (a build's output: only a
// search that includes ignored files covers those), and events the OS dropped (any file may have changed). Changes the
// watcher drops (node_modules) and changes inside .git alone (a commit, a fetch: no file of the project changed) say
// nothing.
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, vi } from 'vitest';

/** The project watchers GitHub starts, with their listeners: a test can report what the OS reports. */
const watchers = vi.hoisted(() => [] as { dir: string; fire: (ev: string, file: string | null) => void }[]);
vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>();
  const watch = (dir: string, o: object, cb: (ev: string, file: string | null) => void) => {
    watchers.push({ dir: String(dir), fire: cb });
    return fs.watch(dir, o, cb);
  };
  return { ...fs, watch };
});

import { IPC } from '../../src/shared/api';
import type { RepoStatus } from '../../src/shared/git';
import { posixTest } from '../support/platform';
import { GitHub } from '../../src/main/git-hub';
import { commit, git } from '../support/git-fixture';

const until = async (ok: () => boolean, ms = 8000) => {
  const end = Date.now() + ms;
  while (!ok()) { if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 50)); }
};

const closers: (() => void)[] = [];
afterEach(() => { for (const close of closers.splice(0)) close(); });

/** A repository whose build output (out/) git ignores, opened in a GitHub with one window. */
async function opened() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'atl-ghfc-')));
  git(root, 'init', '-q', '-b', 'main');
  mkdirSync(join(root, 'out'));
  writeFileSync(join(root, 'out', 'app.js'), 'built\n');
  commit(root, 'first', { 'a.ts': '1\n', '.gitignore': 'out/\n' });
  const h = new GitHub({ request: vi.fn(async () => ({})) } as never);
  const calls: [string, boolean][] = [];
  h.onFilesChanged = (r, ignoredOnly) => { calls.push([r, ignoredOnly]); };
  const sent: RepoStatus[][] = [];
  let close: (() => void) | null = null;
  const wc = { id: 1, isDestroyed: () => false, send: (ch: string, x: unknown) => { if (ch === IPC.evGit) sent.push(x as RepoStatus[]); }, once: (_e: string, cb: () => void) => { close = cb; } };
  h.open(root, wc as never);
  closers.push(() => close?.());
  await until(() => sent.length > 0);
  return { root, h, calls, sent };
}

// POSIX: POSIX path fixtures.
posixTest('a file changed: the project root, told whether only ignored files changed; dropped and git-only changes say nothing', async () => {
  const { root, h, calls, sent } = await opened();
  // What git ignores is listed after the first listing of the working trees: out/ is known as ignored from then on.
  await until(() => h['ignores'].ignored(root, 'out/app.js'));
  calls.length = 0;

  writeFileSync(join(root, 'a.ts'), '2\n');
  await until(() => calls.length > 0);
  expect(calls).toEqual([[root, false]]);

  calls.length = 0;
  writeFileSync(join(root, 'out', 'app.js'), 'built again\n');
  await until(() => calls.length > 0);
  expect(calls).toEqual([[root, true]]);

  calls.length = 0;
  mkdirSync(join(root, 'node_modules', 'x'), { recursive: true });
  writeFileSync(join(root, 'node_modules', 'x', 'index.js'), 'dep\n');
  git(root, 'add', 'a.ts');
  // The index change after node_modules' has been through the watcher once a status shows a.ts staged.
  const staged = (repos: RepoStatus[] | undefined) => !!repos?.some((r) => r.changes.some((c) => c.rel === 'a.ts' && c.stage === 'all'));
  await until(() => staged(sent.at(-1)));
  expect(calls).toEqual([]);
});

posixTest('the call says when the watcher heard the last change: after it was made, before the call (the watcher waits for quiet)', async () => {
  const { root, h } = await opened();
  const heard: { last: number; at: number }[] = [];
  h.onFilesChanged = (_r, _ignoredOnly, last) => { heard.push({ last, at: Date.now() }); };
  const made = Date.now();
  writeFileSync(join(root, 'a.ts'), '3\n');
  await until(() => heard.length > 0);
  expect(heard[0]!.last).toBeGreaterThanOrEqual(made);
  // The watcher's quiet wait (300 ms) lies between the change and the call.
  expect(heard[0]!.at - heard[0]!.last).toBeGreaterThanOrEqual(250);
});

posixTest('events the OS dropped (a change with no name): any file may have changed, ignored or not', async () => {
  const { root, calls } = await opened();
  calls.length = 0;
  const watcher = watchers.find((w) => w.dir === root);
  expect(watcher).toBeDefined();
  watcher!.fire('rename', null);
  await until(() => calls.length > 0);
  expect(calls).toEqual([[root, false]]);
});
