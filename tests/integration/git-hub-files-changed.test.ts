// Find in Files hears from the project's watcher when files change on disk, to say its results may be out of date:
// any change to a file of the project, flagged when git ignores every file that changed (a build's output: only a
// search that includes ignored files covers those). Changes the watcher drops (node_modules) and changes inside .git
// alone (a commit, a fetch: no file of the project changed) say nothing.
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, vi } from 'vitest';
import { IPC } from '../../src/shared/api';
import { posixTest } from '../support/platform';
import { GitHub } from '../../src/main/git-hub';
import { commit, git } from '../support/git-fixture';

const until = async (ok: () => boolean, ms = 8000) => {
  const end = Date.now() + ms;
  while (!ok()) { if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 50)); }
};
const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

const closers: (() => void)[] = [];
afterEach(() => { for (const close of closers.splice(0)) close(); });

// POSIX: POSIX path fixtures.
posixTest('a file changed: the project root, told whether only ignored files changed; dropped and git-only changes say nothing', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'atl-ghfc-')));
  git(root, 'init', '-q', '-b', 'main');
  mkdirSync(join(root, 'out'));
  writeFileSync(join(root, 'out', 'app.js'), 'built\n');
  commit(root, 'first', { 'a.ts': '1\n', '.gitignore': 'out/\n' });
  const h = new GitHub({ request: vi.fn(async () => ({})) } as never);
  const calls: [string, boolean][] = [];
  h.onFilesChanged = (r, ignoredOnly) => { calls.push([r, ignoredOnly]); };
  const sent: unknown[] = [];
  let close: (() => void) | null = null;
  const wc = { id: 1, isDestroyed: () => false, send: (ch: string, x: unknown) => { if (ch === IPC.evGit) sent.push(x); }, once: (_e: string, cb: () => void) => { close = cb; } };
  h.open(root, wc as never);
  closers.push(() => close?.());
  // The first status, then the listing of what git ignores (it follows the first listing of the working trees).
  await until(() => sent.length > 0);
  await settle(1500);
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
  await settle(1500);
  expect(calls).toEqual([]);
});
