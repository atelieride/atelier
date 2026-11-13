// Find in Files' channels: a trusted app page of a project window only, its input parsed strictly. Each window has
// its own search service (one search at a time, its own worker); the events of a search go back to the window that
// asked, never to another, and never to a window that is gone. A window that closes, whose page loads anew (a reload:
// its ids start over) or whose project changes takes its service and worker with it. A change on disk after a
// window's last search started tells that window once that its results may be out of date: nothing runs again by
// itself.
import { Worker } from 'node:worker_threads';
import { ipcMain, type IpcMainInvokeEvent, type WebContents } from 'electron';
import { IPC } from '@shared/api';
import { SEARCH_LIMITS, type SearchEvent, type SearchRequest } from '@shared/search';
import { compilePathFilter } from '@shared/search-filter';
import { realOutAsync } from '../cpath';
import { devEnv } from '../dev-env';
import { searchIdSchema, searchStartSchema } from '../ipc-schemas';
import { pageReloading } from '../popout-wiring';
import { listSearchFiles } from './list';
import { SearchService, type SearchListing, type SearchServiceDeps } from './service';

/** A window's project as a search lists it: its root (real path) and the repositories found in it. */
export interface SearchProject { root: string; discovered: string[] }

export type SearchServiceLike = Pick<SearchService, 'start' | 'stop' | 'dispose'>;

export interface SearchIpcDeps {
  projectOf(e: IpcMainInvokeEvent): SearchProject | null;
  isTrusted(e: IpcMainInvokeEvent): boolean;
  /** The search worker's script (out/main/search-worker.js). */
  workerPath: string;
  /** A window's service (tests give a fake); by default a SearchService on a worker from `workerPath`. */
  createService?: (deps: WindowServiceDeps) => SearchServiceLike;
}

/** What the IPC gives a window's service: its listing and limits; the worker is the service's own business. */
export type WindowServiceDeps = Omit<SearchServiceDeps, 'spawn'>;

/**
 * What a window's last search needs for its stale notice. `since` (Date.now()): a change heard from then on is news to
 * it: when it started, or when the listing it took was made, if earlier.
 */
interface LastSearch { searchId: number; includeIgnored: boolean; since: number; told: boolean }

/** How long a project's last listing serves the searches that follow once it is done, when no change is heard meanwhile. */
const LISTING_KEEP_MS = 10_000;

interface Entry { wc: WebContents; project: SearchProject; service: SearchServiceLike; last: LastSearch | null }

/** An entry's service until its own is made. */
const NO_SERVICE: SearchServiceLike = { start: () => {}, stop: () => {}, dispose: () => {} };

/** A positive number from a test-only variable (none in the packaged app), else undefined. */
const testNumber = (name: Parameters<typeof devEnv>[0]): number | undefined => {
  const n = Number(devEnv(name));
  return n > 0 ? n : undefined;
};

/**
 * Tests only (none in the packaged app), so a test shows each limit with a handful of small files: a lower size past
 * which a file is listed as not searched (a 2 KB file rather than one over 50 MB), fewer matches per search, a shorter
 * watchdog (a stuck regular expression reported in a second or two).
 */
function testServiceDeps(): Pick<WindowServiceDeps, 'limits' | 'watchdogMs'> {
  const maxBytes = testNumber('ATELIER_TEST_SEARCH_MAX_BYTES');
  const maxResults = testNumber('ATELIER_TEST_SEARCH_MAX_RESULTS');
  const watchdogMs = testNumber('ATELIER_TEST_SEARCH_WATCHDOG_MS');
  const limits = { ...(maxBytes ? { maxBytes } : {}), ...(maxResults ? { maxResults } : {}) };
  return { ...(Object.keys(limits).length ? { limits } : {}), ...(watchdogMs ? { watchdogMs } : {}) };
}

export function installSearchIpc(deps: SearchIpcDeps): { filesChanged(root: string, ignoredOnly?: boolean, last?: number): void } {
  const create = deps.createService ?? ((d: WindowServiceDeps) => new SearchService({ ...d, spawn: () => new Worker(deps.workerPath) }));
  const entries = new Map<number, Entry>();
  /** Windows whose `destroyed` and navigations are listened to already (once each, whatever their services). */
  const watched = new Set<number>();

  // Each project's last listing, by root, running or done: the searches that follow with the same filters (each pause
  // in typing, Refresh) take it rather than list the project again, which costs a 100,000-file project ~170 ms of
  // this thread. It goes when a file of the project changes, LISTING_KEEP_MS after it was done (a folder no watcher
  // sees), when a search asks for other filters, and with the project's last window. A search that takes it hears of
  // every change since it was made (`since`).
  // `at`: when it started (Date.now(), the watcher's clock, for `since`); `done`: when it ended (performance.now(), so
  // a jump of the wall clock neither keeps nor drops it), null while it runs: a running listing is always shared, so
  // a slow drive never has two at once.
  const lists = new Map<string, { key: string; at: number; done: number | null; listing: Promise<SearchListing> }>();
  const listing = (p: SearchProject, req: SearchRequest): { at: number; listing: Promise<SearchListing> } => {
    const key = JSON.stringify([p.discovered, req.include, req.exclude, req.includeIgnored]);
    const held = lists.get(p.root);
    if (held && held.key === key && (held.done === null || performance.now() - held.done < LISTING_KEEP_MS)) return held;
    const filter = compilePathFilter(req.include, req.exclude);
    const listed = (async (): Promise<SearchListing> => {
      const realRoot = await realOutAsync(p.root);
      // Tests only: fewer files per search (a handful shows the file cap).
      const cap = testNumber('ATELIER_TEST_SEARCH_MAX_FILES') ?? SEARCH_LIMITS.maxFiles;
      const { files, capped } = await listSearchFiles(p.root, p.discovered, { includeIgnored: req.includeIgnored, cap, filter });
      return { files, capped, realRoot };
    })();
    const entry: { key: string; at: number; done: number | null; listing: Promise<SearchListing> } = { key, at: Date.now(), done: null, listing: listed };
    lists.set(p.root, entry);
    // One that failed is not kept: the next search tries again.
    listed.then(() => { entry.done = performance.now(); }, () => { if (lists.get(p.root) === entry) lists.delete(p.root); });
    return entry;
  };

  const drop = (id: number): void => {
    const en = entries.get(id);
    if (!en) return;
    entries.delete(id);
    en.service.dispose();
    // The project's last window gone: its listing with it.
    const root = en.project.root;
    if (![...entries.values()].some((x) => x.project.root === root)) lists.delete(root);
  };

  // The sender first: an untrusted page's input is never even parsed.
  const projectOf = (e: IpcMainInvokeEvent): SearchProject => {
    const p = deps.isTrusted(e) ? deps.projectOf(e) : null;
    if (!p) throw new Error('unauthorized sender');
    return p;
  };

  /** The window's entry for its project now: a project changed since gets a fresh service. */
  const entryOf = (wc: WebContents, project: SearchProject): Entry => {
    const had = entries.get(wc.id);
    if (had && had.project.root === project.root) {
      // The repositories found in it may have changed since (the folder scan ended, a clone).
      had.project = project;
      return had;
    }
    if (had) drop(wc.id);
    const en: Entry = { wc, project, service: NO_SERVICE, last: null };
    // The project as it is when a search lists it (a later start may have brought new repositories). A search that
    // takes a listing made before it began hears of the changes since that listing.
    en.service = create({
      list: (req) => {
        const l = listing(en.project, req);
        if (en.last?.searchId === req.searchId) en.last.since = Math.min(en.last.since, l.at);
        return l.listing;
      },
      ...testServiceDeps()
    });
    entries.set(wc.id, en);
    if (!watched.has(wc.id)) {
      watched.add(wc.id);
      wc.once('destroyed', () => { watched.delete(wc.id); drop(wc.id); });
      // A reload: the new page counts its searches from the start again, so nothing of the old page's may reach it.
      // An iframe loading or a same-document navigation leaves the page as it is.
      wc.on('did-start-navigation', (d) => { if (pageReloading(d)) drop(wc.id); });
    }
    return en;
  };

  ipcMain.handle(IPC.searchStart, (e, arg) => {
    const project = projectOf(e);
    const req: SearchRequest = searchStartSchema.parse(arg);
    const wc = e.sender;
    // Closing: its `destroyed` may not have come yet, and would never come again for a new service.
    if (wc.isDestroyed()) { drop(wc.id); return; }
    const en = entryOf(wc, project);
    en.last = { searchId: req.searchId, includeIgnored: req.includeIgnored, since: Date.now(), told: false };
    en.service.start(req, (ev: SearchEvent) => {
      if (entries.get(wc.id) === en && !wc.isDestroyed()) wc.send(IPC.evSearch, ev);
    });
  });

  ipcMain.handle(IPC.searchStop, (e, arg) => {
    const project = projectOf(e);
    const searchId = searchIdSchema.parse(arg);
    const en = entries.get(e.sender.id);
    if (!en) return;
    // The search it names was the old project's: it ends with its service.
    if (en.project.root !== project.root) { drop(e.sender.id); return; }
    en.service.stop(searchId);
  });

  return {
    /**
     * Files of `root` changed on disk: each window's last search there (running or finished) is told once that its
     * results may be out of date. `ignoredOnly`: every file that changed is one git ignores, which only a search
     * that includes ignored files covers. `last`: when the last of these changes was heard (Date.now()); changes that
     * all came before a search started (and before the listing it took) are in what it read, however late the watcher
     * passes them on.
     */
    filesChanged(root, ignoredOnly = false, last = Date.now()) {
      // The project's listing, even one running now (it may have read the folder before the change): the next search
      // lists again.
      lists.delete(root);
      for (const en of entries.values()) {
        const search = en.last;
        if (en.project.root !== root || !search || search.told) continue;
        if (ignoredOnly && !search.includeIgnored) continue;
        if (last < search.since) continue;
        if (en.wc.isDestroyed()) continue;
        search.told = true;
        en.wc.send(IPC.evSearch, { kind: 'stale', searchId: search.searchId } satisfies SearchEvent);
      }
    }
  };
}
