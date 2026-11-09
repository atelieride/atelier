// git.* and scm.* in the demo: Changes reads the working tree against HEAD; Source
// Control's history, commits and blobs come from the compiled commits (engine/scm.ts). One repository on main, tracking
// origin/main at the same commit; fetches "succeed" after 600 ms with the events main's FetchScheduler sends, and the
// view fetch keeps main's 10-minute gate. No network, ever.
import type { AtelierApi } from '@shared/api';
import { EMPTY_TREE, type FetchOutcome, type ScmFetchAnswer, type ScmFetchState, type ScmRefs, type ScmRepoEntry } from '@shared/scm';
import { repoStatus } from '../engine/repo';
import { createHistory } from '../engine/scm';
import { relOf, resolved, type DemoContext } from './context';
import { createGitWrites } from './git-write';

const UPSTREAM = 'origin/main';
/** How long a fetch "takes". */
export const FETCH_MS = 600;
/** main's VIEW_GATE_MS: a view fetch only after ten minutes without one. */
const VIEW_GATE_MS = 10 * 60_000;

export function statusOf(ctx: DemoContext) {
  const { root, name } = ctx.world.project;
  return { ...repoStatus({ root, name, head: ctx.world.head, files: ctx.state.files, index: ctx.state.index, oid: ctx.world.headOid, now: ctx.now() }), upstream: UPSTREAM };
}

export function createGit(ctx: DemoContext): AtelierApi['git'] {
  const { root } = ctx.world.project;
  const { scm } = ctx.world;
  const at = (rev: string, path: string) => {
    const rel = relOf(root, path);
    const blob = rel ? scm.trees[rev === 'HEAD' ? ctx.world.headOid : rev]?.[rel] : undefined;
    return resolved({ original: blob === undefined ? null : scm.blobs[blob]! });
  };
  return {
    ...createGitWrites(ctx, () => statusOf(ctx)),
    status: () => resolved([statusOf(ctx)]),
    head: (path) => at('HEAD', path),
    base: (path, rev) => at(rev, path),
    // Review "Against main": the demo is on main.
    compare: () => resolved([{ root, ok: false, reason: 'on-default' }])
  };
}

export function createScm(ctx: DemoContext): AtelierApi['scm'] {
  const { root, name } = ctx.world.project;
  const common = `${root}/.git`;
  const head = ctx.world.headOid;
  const date = ctx.world.scm.commits[0]?.committerAt ?? Math.floor(ctx.now() / 1000);
  const history = createHistory(ctx.world.scm, { head, refs: { 'refs/heads/main': head, 'refs/remotes/origin/main': head } });
  // The demo's clone was last fetched before the visit: the first view fetch runs it — Changes', shown at load —
  // and History then says when ("origin fetched just now").
  let fetchedAt = ctx.now() - 25 * 60_000;
  let state: ScmFetchState = { common, running: false, last: null };
  let job: Promise<ScmFetchAnswer> | null = null;
  const publish = (next: ScmFetchState) => { state = next; ctx.events.emit('scmFetch', state); };

  const entry = (): ScmRepoEntry => ({
    root, rel: '', name, worktreeOf: null, common,
    status: { branch: 'main', detached: false, oid: head, ahead: 0, behind: 0, upstream: UPSTREAM, changes: statusOf(ctx).changes.length }
  });
  const refs = (): ScmRefs => ({
    root, head: { branch: 'main', oid: head, detached: false },
    refs: [
      { name: 'refs/heads/main', short: 'main', kind: 'head', oid: head, upstream: 'refs/remotes/origin/main', ahead: 0, behind: 0, gone: false, current: true, date },
      { name: 'refs/remotes/origin/main', short: 'origin/main', kind: 'remote', remote: 'origin', oid: head, upstream: null, ahead: 0, behind: 0, gone: false, current: false, date }
    ],
    defaultBranch: { ref: 'refs/heads/main', base: 'main' }, shallow: false, fetchedAt, remotes: ['origin'], hasRemote: true, emptyTree: EMPTY_TREE.sha1
  });
  /** One fetch at a time, as main's scheduler: running now, ok 600 ms later, then FETCH_HEAD's event. */
  const run = (): Promise<ScmFetchAnswer> => {
    job ??= new Promise<ScmFetchAnswer>((done) => {
      publish({ common, running: true, last: state.last });
      ctx.clock.after(FETCH_MS, () => {
        fetchedAt = ctx.now();
        publish({ common, running: false, last: { outcome: 'ok', at: fetchedAt } });
        ctx.events.emit('scm', { common, what: 'fetch' });
        job = null;
        done({ state, outcome: 'ok' });
      });
    });
    return job;
  };

  return {
    repos: () => resolved([entry()]),
    refs: () => resolved(refs()),
    log: (_root, scope, skip, count, filter) => resolved(history.log(scope, skip, count, filter)),
    locate: (_root, scope, oid) => resolved(history.locate(scope, oid)),
    resolve: (_root, prefix) => resolved(history.resolve(prefix)),
    commit: (_root, oid, against) => resolved(history.commit(oid, against ?? null)),
    file: (_root, oid, rel) => resolved(history.file(oid, rel)),
    // Every ref is at HEAD.
    aheadBehind: () => resolved({ ahead: 0, behind: 0 }),
    worktrees: () => resolved([{ path: root, head, branch: 'main', detached: false, bare: false, locked: false, prunable: false }]),
    stashes: () => resolved([]),
    status: () => resolved(statusOf(ctx)),
    fetchRepo(_root, reason) {
      if (job) return reason === 'manual' ? job : resolved({ state, outcome: null });
      if (reason === 'view' && ctx.now() - fetchedAt < VIEW_GATE_MS) return resolved({ state, outcome: null });
      return run();
    },
    fetchAll: async (): Promise<FetchOutcome[]> => { const a = await run(); return a.outcome ? [a.outcome] : []; },
    fetchStates: () => resolved([state])
  };
}
