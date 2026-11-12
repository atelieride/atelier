// Sync All and its ▾ in the All Repositories view: one run at a time (in the store, so it
// survives a switch of view). Pull All and Push All go a few repositories at a time, a repository's worktrees one after
// another (they share its object store, which main writes one op at a time), and end with one toast. Nothing stops the
// run: what needs you (a failure, a live session working on files the pull changes, a branch that diverged) is
// counted, and the toast's Show lists it, as Sync All's does.
import { type SyncAllRow, trackedCounts } from '@shared/git-write';
import { BULK_GIT_PARALLEL, inLanes } from '@shared/lanes';
import { t } from '../i18n/en';
import { useApp } from '../store';
import { pullForAll, pushForAll, syncAll } from '../git/actions';
import { allRows } from './all-view';

const st = () => useApp.getState();
type Bulk = 'sync' | 'pull' | 'push';

async function run(kind: Bulk, fn: () => Promise<unknown>): Promise<void> {
  if (st().scmBulk) return;
  st().setScmBulk(kind);
  try { await fn(); } finally { st().setScmBulk(null); }
}

interface Said {
  /** Nothing needs you but the diverged ones left out from the start (today's one-line answer). */
  done: (n: number, diverged: number) => string;
  /** Some need you: Show lists every repository of the run. */
  some: (n: number, needs: number) => string;
}

/**
 * The repositories `ready` keeps (only behind, or only ahead), in the view's order; a diverged one is counted and left
 * to its own Sync (which asks to rebase). A pull or push cancelled (its block's ▾, or the live demo, which makes none)
 * says nothing more: every one cancelled, no toast at all.
 */
async function each(op: 'pull' | 'push', ready: (c: { ahead: number; behind: number }) => boolean, act: (root: string) => Promise<SyncAllRow>, said: Said): Promise<void> {
  if (st().settings.gitActions !== 'on') return;
  const entries = st().scmRepos;
  const rows = allRows(st().repos, entries).filter((r) => !r.status.error)
    .map((r) => ({ root: r.root, common: entries?.find((e) => e.root === r.root)?.common ?? r.root, c: trackedCounts(r.status) }));
  const diverged = new Set(rows.filter((r) => r.c.ahead > 0 && r.c.behind > 0).map((r) => r.root));
  const todo = rows.filter((r) => ready(r.c));
  const results = new Map<string, SyncAllRow>();
  await inLanes(todo, (r) => r.common, BULK_GIT_PARALLEL, async (r) => { results.set(r.root, await act(r.root)); });
  const cancelled = (x: SyncAllRow) => x.result?.outcome === 'cancelled';
  if (results.size && [...results.values()].every(cancelled)) return;
  const list = rows.flatMap((r): SyncAllRow[] => (diverged.has(r.root) ? [{ root: r.root, result: null, needsYou: 'diverged' }] : results.has(r.root) ? [results.get(r.root)!] : []))
    .filter((x) => !cancelled(x));
  const ok = list.filter((x) => !x.needsYou && x.result?.outcome === 'ok').length;
  if (list.every((x) => diverged.has(x.root) || (!x.needsYou && x.result?.outcome === 'ok'))) {
    st().showToast(said.done(ok, diverged.size), undefined, 'info');
    return;
  }
  st().showToast(said.some(ok, list.length - ok), { label: t.git.show, run: () => st().setGitSheet({ kind: 'syncAll', run: op, rows: list }) }, 'info');
}

const a = t.scm.all;
export const pullAll = (): Promise<void> => run('pull', () => each('pull', (c) => c.behind > 0 && c.ahead === 0, pullForAll, { done: a.pulledAll, some: a.pulledSome }));
export const pushAll = (): Promise<void> => run('push', () => each('push', (c) => c.ahead > 0 && c.behind === 0, pushForAll, { done: a.pushedAll, some: a.pushedSome }));
export const syncAllRun = (): Promise<void> => run('sync', () => syncAll());
