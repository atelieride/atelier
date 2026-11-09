// Source Control in main: the scm:* IPC and the ev:scm events. Read-only (but for fetch,
// through git/fetch.ts and the FetchScheduler): every other git call goes
// through the readers in git/history.ts. The renderer only names roots this hub listed for its project, full commit
// ids and refnames from the last refs read for that root.
import { realpathSync } from 'node:fs';
import { ipcMain, type IpcMainInvokeEvent, type WebContents } from 'electron';
import { IPC } from '@shared/api';
import { OID_RE, scmStatusOf, type ScmEvent, type ScmFetchAnswer, type ScmFetchState, type ScmLogPage, type ScmRefs, type ScmRepoEntry, type ScmScope } from '@shared/scm';
import type { AutoFetch } from '@shared/settings';
import { runGit } from './git/exec';
import { autoFetchAllowed, runFetch, stopAllFetches, type FetchResult } from './git/fetch';
import { FetchScheduler } from './fetch-scheduler';
import { WriteQueue } from './git/write-queue';
import { aheadBehind, lastFetchAt, locateCommit, readBlob, readCommit, readLog, readRefs, readStashes, readWorktrees, resolveCommit } from './git/history';
import { listScmRepos, scmEntries } from './git/scm-repos';
import { ScmEvents } from './scm-watch';
import { scmAheadBehindSchema, scmCommitSchema, scmFetchSchema, scmFileSchema, scmLocateSchema, scmLogSchema, scmResolveSchema, scmRootSchema } from './ipc-schemas';
import type { GitHub } from './git-hub';
import { toOut } from './cpath';

/** The root must be one of the entries main listed for the window's project. */
export function checkRoot(entries: { root: string }[], root: string): boolean {
  return entries.some((e) => e.root === root);
}

/** Every revision is a listed refname, HEAD (with commits) or a full commit id. */
export function knownRevs(refs: ScmRefs, revs: string[]): boolean {
  return revs.every((r) => OID_RE.test(r) || (r === 'HEAD' && !!refs.head.oid) || refs.refs.some((x) => x.name === r));
}

const scopeRevs = (s: ScmScope): string[] => (s.kind === 'compare' ? [s.base, s.head] : s.refs === 'all' ? [] : [s.refs]);

/**
 * History calls of one window: at most `max` git processes at a time; a newer call for the same view (the list, the
 * detail) aborts the older one, running or still waiting.
 */
export class CallQueue {
  private running = 0;
  private waiting: { start: () => void }[] = [];
  private byView = new Map<string, AbortController>();
  constructor(private readonly max = 2) {}
  run<T>(view: string | undefined, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const ac = new AbortController();
    if (view) { this.byView.get(view)?.abort(); this.byView.set(view, ac); }
    return new Promise<T>((resolve, reject) => {
      const start = () => {
        if (ac.signal.aborted) { reject(new Error('aborted')); this.next(); return; }
        this.running++;
        fn(ac.signal).then(resolve, reject).finally(() => {
          this.running--;
          if (view && this.byView.get(view) === ac) this.byView.delete(view);
          this.next();
        });
      };
      const item = { start };
      // A waiting call that is superseded fails now, without ever starting.
      ac.signal.addEventListener('abort', () => {
        const i = this.waiting.indexOf(item);
        if (i >= 0) { this.waiting.splice(i, 1); reject(new Error('aborted')); }
      });
      if (this.running < this.max) start(); else this.waiting.push(item);
    });
  }
  private next(): void {
    while (this.running < this.max && this.waiting.length) this.waiting.shift()!.start();
  }
}

interface Project {
  entries: Promise<ScmRepoEntry[]> | null;
  refs: Map<string, ScmRefs>;
  /** Bumped whenever the cached refs are dropped (a read started before must not put its answer back). */
  gen: number;
  events: ScmEvents;
}

/** What fetching needs from the app; `run` and `hasRemote` are git's unless a test replaces them. */
export interface ScmFetchDeps {
  setting(): AutoFetch;
  online(): boolean;
  /** The projects with an open window. */
  projects(): string[];
  run?(root: string): Promise<FetchResult>;
  hasRemote?(root: string): Promise<boolean>;
  autoAllowed?(root: string): Promise<boolean>;
}

const OFF: ScmFetchDeps = { setting: () => 'off', online: () => false, projects: () => [] };

export class ScmHub {
  private projects = new Map<string, Project>();
  private queues = new Map<number, CallQueue>();
  private readonly fetcher: FetchScheduler;

  /**
   * @param writes the queue of git writes, shared with GitOps: a fetch waits behind a write on
   *   the same object store.
   */
  constructor(private readonly git: GitHub, fetchDeps: ScmFetchDeps = OFF, readonly writes: WriteQueue = new WriteQueue()) {
    git.onScm = (key, e, worktree) => this.event(key, e, worktree);
    git.onProjectClosed = (key) => { const p = this.projects.get(key); if (p) this.disposeProject(key, p); };
    this.fetcher = new FetchScheduler({
      now: () => Date.now(),
      run: (root, common) => writes.run(common, () => (fetchDeps.run ?? runFetch)(root), 'fetch').then((res) => {
        if (res.outcome === 'ok') this.readAfterFetch(common, fetchDeps);
        return res;
      }),
      fetchedAt: (common) => lastFetchAt(common),
      hasRemote: (root) => (fetchDeps.hasRemote ? fetchDeps.hasRemote(root) : runGit(root, ['remote']).then((s) => s.trim() !== '', () => false)),
      autoAllowed: (root) => (fetchDeps.autoAllowed ?? autoFetchAllowed)(root),
      setting: () => fetchDeps.setting(),
      online: () => fetchDeps.online(),
      repos: async () => (await Promise.all(fetchDeps.projects().map((k) => this.entriesOf(k)))).flat().map((x) => ({ root: x.root, common: x.common })),
      emit: (st) => { this.sendFetch(st).catch(() => { /* a window gone mid-send */ }); },
      writes
    });
  }

  /**
   * A fetch moved the remote-tracking refs: every working tree of that store reads its counts now, not when the
   * watcher's spacing allows (the Sync button's ↓N lagged seconds behind on a Windows PC). Never fails the fetch.
   */
  private readAfterFetch(common: string, deps: ScmFetchDeps): void {
    try {
      void Promise.all(deps.projects().map((k) => this.entriesOf(k))).then((lists) => {
        for (const e of lists.flat()) if (e.common === common) this.git.requestStatus(e.root);
      }).catch(() => { /* a project closed meanwhile */ });
    } catch { /* a project closing */ }
  }

  /** Periodic fetches: the tick runs whatever the setting and does nothing unless it asks for them. */
  startFetching(): void { this.fetcher.start(); }
  fetchSettingsChanged(): void { this.fetcher.settingsChanged(); void this.fetcher.tick(); }
  /** The app quits: no more periodic fetches, and the running ones (detached processes) are stopped. */
  dispose(): void { this.fetcher.dispose(); stopAllFetches(); }

  /** A fetch state goes to the windows of the projects that list that repository. */
  private async sendFetch(st: ScmFetchState): Promise<void> {
    for (const [key, p] of this.projects) {
      const trees = this.git.info(key)?.trees;
      const commons = trees ? trees.map((t) => t.common) : p.entries ? (await p.entries).map((e) => e.common) : [];
      if (!commons.includes(st.common)) continue;
      for (const wc of this.git.info(key)?.windows ?? []) if (!wc.isDestroyed()) wc.send(IPC.evScmFetch, st);
    }
  }

  private project(key: string): Project {
    let p = this.projects.get(key);
    if (!p) {
      // Statuses, hidden worktrees' included, are GitHub's (worktrees in Changes): the renderer reloads the entries on each.
      p = { entries: null, refs: new Map(), gen: 0, events: new ScmEvents(300, (e) => this.send(key, e)) };
      this.projects.set(key, p);
    }
    return p;
  }

  private event(key: string, e: ScmEvent, worktree = false): void {
    const p = this.project(key);
    // Refs read before are only a check list for the renderer's refnames: dropped, read again on the next call.
    p.refs.clear();
    p.gen++;
    // A linked worktree added or removed: the entries are listed again, but only once a window asks for them.
    if (worktree) p.entries = null;
    p.events.add(e);
  }

  private send(key: string, e: ScmEvent): void {
    for (const wc of this.git.info(key)?.windows ?? []) if (!wc.isDestroyed()) wc.send(IPC.evScm, e);
  }

  /**
   * The project's switcher entries with their current statuses: the working trees Changes listed (GitHub's, listed
   * again on every worktree change and kept through a git timeout); before its first listing, listed here once. Common
   * dirs outside the project are GitHub's to watch too: its events reach this hub through onScm.
   */
  private entriesOf(key: string): Promise<ScmRepoEntry[]> {
    const info = this.git.info(key);
    if (!info) return Promise.resolve([]);
    const withStatus = (list: ScmRepoEntry[]) => list.map((e) => ({ ...e, status: scmStatusOf(info.status.get(e.root)) }));
    if (info.trees) return Promise.resolve(withStatus(scmEntries(info.root, info.trees)));
    const p = this.project(key);
    p.entries ??= listScmRepos(info.root, info.discovered).catch(() => []);
    return p.entries.then(withStatus);
  }

  /**
   * The project's entry for a root the renderer named (spelled as given or by its real path), or null when it isn't
   * one this hub listed for that project. Git writes (GitOps) check every root with it, like the readers here.
   */
  async entryFor(key: string, root: string): Promise<ScmRepoEntry | null> {
    const entries = await this.entriesOf(key);
    let r = root;
    try { r = toOut(realpathSync(root)); } catch { /* compared as given */ }
    return checkRoot(entries, r) ? entries.find((e) => e.root === r)! : null;
  }

  /** The project's entries (GitOps: Sync All, the other worktrees of a common dir). */
  entries(key: string): Promise<ScmRepoEntry[]> {
    return this.entriesOf(key);
  }

  /** A root's refs; `fresh` reads them again (git writes check refnames against what is there now). */
  refs(key: string, root: string, fresh = false): Promise<ScmRefs> {
    return this.refsOf(key, root, fresh);
  }

  /** A write moved refs: the cached reads are dropped (the watcher would say so too, a little later). */
  refsMoved(key: string): void {
    const p = this.projects.get(key);
    if (p) { p.refs.clear(); p.gen++; }
  }

  /** A manual fetch through the scheduler (the rejected push sheet); waits behind writes. */
  fetchNow(root: string, common: string): Promise<ScmFetchAnswer> {
    return this.fetcher.request({ root, common }, 'manual');
  }

  private async refsOf(key: string, root: string, fresh = false): Promise<ScmRefs> {
    const p = this.project(key);
    const cached = p.refs.get(root);
    if (cached && !fresh) return cached;
    const gen = p.gen;
    const r = await readRefs(root);
    // Read before an event that dropped the cache: answered, never cached (they may be stale already).
    if (p.gen === gen) p.refs.set(root, r);
    return r;
  }

  /** Refs that know every revision asked for (read again once when one is missing: it may be new). */
  private async refsFor(key: string, root: string, revs: string[]): Promise<ScmRefs | null> {
    let r = await this.refsOf(key, root);
    if (knownRevs(r, revs)) return r;
    r = await this.refsOf(key, root, true);
    return knownRevs(r, revs) ? r : null;
  }

  private queue(wc: WebContents): CallQueue {
    let q = this.queues.get(wc.id);
    if (!q) {
      q = new CallQueue(2);
      this.queues.set(wc.id, q);
      const id = wc.id;
      wc.once('destroyed', () => { this.queues.delete(id); });
    }
    return q;
  }

  private disposeProject(key: string, p: Project): void {
    p.events.dispose();
    this.projects.delete(key);
  }

  installIpc(projectOf: (wcId: number) => string | null, isTrusted: (e: IpcMainInvokeEvent) => boolean,
    handle: (channel: string, fn: (e: IpcMainInvokeEvent, arg: unknown) => unknown) => void = (channel, fn) => ipcMain.handle(channel, fn)): void {
    const keyOf = (e: IpcMainInvokeEvent) => {
      const k = projectOf(e.sender.id);
      if (!k || !isTrusted(e)) throw new Error('unauthorized sender');
      this.queue(e.sender);
      return k;
    };
    const rooted = async (e: IpcMainInvokeEvent, root: string) => {
      const key = keyOf(e);
      const entry = await this.entryFor(key, root);
      if (!entry) throw new Error('unknown repository');
      return { key, root: entry.root };
    };
    const aborted = (err: unknown) => (err as Error)?.message?.includes('aborted');
    handle(IPC.scmRepos, (e) => this.entriesOf(keyOf(e)));
    handle(IPC.scmRefs, async (e, arg) => {
      const { key, root } = await rooted(e, scmRootSchema.parse(arg).root);
      return this.queue(e.sender).run(undefined, () => this.refsOf(key, root, true));
    });
    handle(IPC.scmLog, async (e, arg): Promise<ScmLogPage> => {
      const a = scmLogSchema.parse(arg);
      const { key, root } = await rooted(e, a.root);
      const refs = await this.refsFor(key, root, scopeRevs(a.scope));
      if (!refs) return { commits: [], done: true, capped: false, error: 'unknown ref' };
      try {
        return await this.queue(e.sender).run(a.view && `log:${a.view}`, (signal) => readLog(root, a.scope, refs, { skip: a.skip, count: a.count, ...(a.filter ? { filter: a.filter } : {}), signal }));
      } catch (err) {
        if (aborted(err)) return { commits: [], done: false, capped: false, error: 'aborted' };
        throw err;
      }
    });
    handle(IPC.scmLocate, async (e, arg) => {
      const a = scmLocateSchema.parse(arg);
      const { key, root } = await rooted(e, a.root);
      const refs = await this.refsFor(key, root, scopeRevs(a.scope));
      if (!refs) return null;
      return this.queue(e.sender).run(a.view && `locate:${a.view}`, (signal) => locateCommit(root, a.scope, refs, a.oid, signal)).catch(() => null);
    });
    handle(IPC.scmResolve, async (e, arg) => {
      const a = scmResolveSchema.parse(arg);
      const { root } = await rooted(e, a.root);
      return this.queue(e.sender).run(undefined, () => resolveCommit(root, a.prefix));
    });
    handle(IPC.scmCommit, async (e, arg) => {
      const a = scmCommitSchema.parse(arg);
      const { key, root } = await rooted(e, a.root);
      const refs = await this.refsOf(key, root);
      try {
        return await this.queue(e.sender).run(a.view && `commit:${a.view}`, (signal) => readCommit(root, a.oid, a.against ?? null, refs.emptyTree, signal));
      } catch (err) {
        if (aborted(err)) return { oid: a.oid, message: '', base: '', files: [], more: 0, error: 'aborted' };
        throw err;
      }
    });
    handle(IPC.scmFile, async (e, arg) => {
      const a = scmFileSchema.parse(arg);
      const { root } = await rooted(e, a.root);
      return this.queue(e.sender).run(undefined, () => readBlob(root, a.oid, a.rel));
    });
    handle(IPC.scmAheadBehind, async (e, arg) => {
      const a = scmAheadBehindSchema.parse(arg);
      const { key, root } = await rooted(e, a.root);
      if (!(await this.refsFor(key, root, [a.a, a.b]))) return null;
      return this.queue(e.sender).run(undefined, () => aheadBehind(root, a.a, a.b));
    });
    handle(IPC.scmWorktrees, async (e, arg) => {
      const { root } = await rooted(e, scmRootSchema.parse(arg).root);
      return this.queue(e.sender).run(undefined, () => readWorktrees(root));
    });
    handle(IPC.scmStashes, async (e, arg) => {
      const { root } = await rooted(e, scmRootSchema.parse(arg).root);
      return this.queue(e.sender).run(undefined, () => readStashes(root));
    });
    handle(IPC.scmStatus, async (e, arg) => {
      const { key, root } = await rooted(e, scmRootSchema.parse(arg).root);
      return this.git.info(key)?.status.get(root) ?? null;
    });
    // Fetch: the one call that writes (remote-tracking refs) and uses the network. Outside the window's
    // read queue: it never holds a slot of the History's reads for up to a minute.
    handle(IPC.scmFetch, async (e, arg): Promise<ScmFetchAnswer> => {
      const a = scmFetchSchema.parse(arg);
      const { key, root } = await rooted(e, a.root);
      const entry = (await this.entriesOf(key)).find((x) => x.root === root)!;
      return this.fetcher.request({ root, common: entry.common }, a.reason);
    });
    handle(IPC.scmFetchAll, async (e) => {
      const entries = await this.entriesOf(keyOf(e));
      return this.fetcher.fetchAll(entries.map((x) => ({ root: x.root, common: x.common })));
    });
    handle(IPC.scmFetchStates, async (e) => {
      const commons = new Set((await this.entriesOf(keyOf(e))).map((x) => x.common));
      return [...commons].map((c) => this.fetcher.state(c));
    });
  }
}
