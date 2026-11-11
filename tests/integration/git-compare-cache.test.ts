// Review compares every repository against its default branch after each status. Statuses now arrive one repository
// at a time: a compare is worked out again only for the repositories whose status changed since the last one.
// POSIX only, as the other GitHub tests on real folders: on Windows the tests' forced macOS platform meets C:\ paths.
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, vi } from 'vitest';
import { posixTest as test } from '../support/platform';
import { GitHub } from '../../src/main/git-hub';
import * as compare from '../../src/main/git/compare';
import { commit, git } from '../support/git-fixture';

function repoAt(dir: string): string {
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  commit(dir, 'first', { 'a.ts': '1\n' });
  return dir;
}

const closes: (() => void)[] = [];
afterEach(() => { for (const c of closes.splice(0)) c(); vi.restoreAllMocks(); });

const until = async (ok: () => boolean, ms = 10_000) => {
  const end = Date.now() + ms;
  while (!ok()) { if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 50)); }
};

test('a compare is read again only for the repositories whose status changed', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'atl-cmp-')));
  const a = repoAt(join(root, 'a'));
  const b = repoAt(join(root, 'b'));
  const h = new GitHub({ request: vi.fn(async () => ({})) } as never);
  let destroyed: (() => void) | null = null;
  h.open(root, { id: 1, isDestroyed: () => false, send: () => {}, once: (_e: string, cb: () => void) => { destroyed = cb; } } as never);
  closes.push(() => destroyed?.());
  await until(() => !!h.info(root)?.status.get(a) && !!h.info(root)?.status.get(b));
  await new Promise((r) => setTimeout(r, 1200));
  const reads = vi.spyOn(compare, 'readCompare');
  const first = await h.compare(root);
  expect(first.map((c) => c.root).sort()).toEqual([a, b]);
  await h.compare(root);
  expect(reads.mock.calls.map((c) => c[0]).sort()).toEqual([a, b]);
  const before = h.info(root)?.status.get(a);
  writeFileSync(join(a, 'a.ts'), '2\n');
  await until(() => h.info(root)?.status.get(a) !== before);
  reads.mockClear();
  await h.compare(root);
  expect(reads.mock.calls.map((c) => c[0])).toEqual([a]);
});

test('a status read again with nothing changed (dropped events) reads no compare again; refs that moved do', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'atl-cmp2-')));
  const a = repoAt(join(root, 'a'));
  const h = new GitHub({ request: vi.fn(async () => ({})) } as never);
  let destroyed: (() => void) | null = null;
  h.open(root, { id: 1, isDestroyed: () => false, send: () => {}, once: (_e: string, cb: () => void) => { destroyed = cb; } } as never);
  closes.push(() => destroyed?.());
  await until(() => !!h.info(root)?.status.get(a));
  await new Promise((r) => setTimeout(r, 1200));
  const reads = vi.spyOn(compare, 'readCompare');
  await h.compare(root);
  const before = h.info(root)?.status.get(a);
  // The same status read again (a new object, the same content).
  h.requestStatus(a);
  await until(() => h.info(root)?.status.get(a) !== before);
  await h.compare(root);
  expect(reads.mock.calls).toHaveLength(1);
  // A branch moved (a fetch, a commit elsewhere): the default branch may have moved too.
  git(a, 'branch', 'other');
  await until(() => reads.mock.calls.length === 1 && h.info(root)?.status.get(a) !== before, 5000).catch(() => {});
  await new Promise((r) => setTimeout(r, 1500));
  await h.compare(root);
  expect(reads.mock.calls).toHaveLength(2);
});
