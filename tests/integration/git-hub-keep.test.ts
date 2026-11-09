// The attribution keep set on a real repository: while held, the kept files join the `dirty`
// list of the daemon's prune and the app-side Bash prune hears of them; once released, they don't.
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, vi } from 'vitest';
import { posixTest } from '../support/platform';
import { GitHub } from '../../src/main/git-hub';
import { commit, git } from '../support/git-fixture';

const until = async (ok: () => boolean, ms = 8000) => {
  const end = Date.now() + ms;
  while (!ok()) { if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 50)); }
};

// POSIX: POSIX path fixtures.
posixTest('kept paths join attrPrune\'s dirty list and the Bash prune while held, not after release', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'atl-ghk-')));
  git(root, 'init', '-q', '-b', 'main');
  commit(root, 'first', { 'a.ts': '1\n', 'b.ts': '1\n' });
  const prunes: { root: string; dirty: string[] }[] = [];
  const client = { request: vi.fn(async (m: { t: string; root: string; dirty: string[] }) => { if (m.t === 'attrPrune') prunes.push({ root: m.root, dirty: m.dirty }); return {}; }) };
  const h = new GitHub(client as never);
  const statuses: { prune: boolean; keep?: string[] }[] = [];
  h.onStatus = (_st, o) => { statuses.push(o); };
  const wc = { id: 1, isDestroyed: () => false, send: () => {}, once: () => {} };
  h.open(root, wc as never);
  await until(() => !!h.info(root)?.status.get(root));
  await new Promise((r) => setTimeout(r, 300));

  // Committed by Atelier, Undo offered: a.ts is held.
  const release = h.keep(root, [join(root, 'a.ts')]);
  commit(root, 'second', { 'a.ts': '2\n', 'b.ts': '2\n' });
  h.touched(join(root, 'a.ts'));
  await until(() => prunes.length > 0);
  expect(prunes.at(-1)).toEqual({ root, dirty: [join(root, 'a.ts')] });
  await until(() => statuses.some((s) => s.prune));
  expect(statuses.filter((s) => s.prune).at(-1)?.keep).toEqual([join(root, 'a.ts')]);

  release();
  release();
  const before = prunes.length;
  commit(root, 'third', { 'a.ts': '3\n' });
  h.touched(join(root, 'a.ts'));
  await until(() => prunes.length > before);
  expect(prunes.at(-1)).toEqual({ root, dirty: [] });
  expect(statuses.filter((s) => s.prune).at(-1)?.keep).toEqual([]);
});
