// Sync All and its ▾ in the All Repositories view: one run at a time (in the
// store, so it survives a switch of view), one repository after the other, one toast at the end. A failure or a
// question (a sheet) stops the run there and speaks for itself, as the single action would.
import type { GitOpResult } from '@shared/git-write';
import { trackedCounts } from '@shared/git-write';
import { t } from '../i18n/en';
import { useApp } from '../store';
import { push, syncAll } from '../git/actions';
import { guardedPull } from '../git/sync';
import { allRows } from './all-view';

const st = () => useApp.getState();
type Bulk = 'sync' | 'pull' | 'push';

async function run(kind: Bulk, fn: () => Promise<unknown>): Promise<void> {
  if (st().scmBulk) return;
  st().setScmBulk(kind);
  try { await fn(); } finally { st().setScmBulk(null); }
}

/**
 * The repositories `ready` keeps (only behind, or only ahead), in the view's order; a diverged one is counted and left
 * to its own Sync (which asks to rebase).
 */
async function each(ready: (c: { ahead: number; behind: number }) => boolean, act: (root: string) => Promise<GitOpResult | null>, said: (n: number, diverged: number) => string): Promise<void> {
  const rows = allRows(st().repos, st().scmRepos).filter((r) => !r.status.error).map((r) => ({ root: r.root, c: trackedCounts(r.status) }));
  const diverged = rows.filter((r) => r.c.ahead > 0 && r.c.behind > 0).length;
  let done = 0;
  for (const r of rows.filter((x) => ready(x.c))) {
    const res = await act(r.root);
    if (res?.outcome !== 'ok' || st().gitSheet) return;
    done++;
  }
  st().showToast(said(done, diverged), undefined, 'info');
}

export const pullAll = (): Promise<void> => run('pull', () => each((c) => c.behind > 0 && c.ahead === 0, (root) => guardedPull(root, { rebase: false, sync: false, quiet: true }), t.scm.all.pulledAll));
export const pushAll = (): Promise<void> => run('push', () => each((c) => c.ahead > 0 && c.behind === 0, (root) => push(root, { quiet: true }), t.scm.all.pushedAll));
export const syncAllRun = (): Promise<void> => run('sync', () => syncAll());
