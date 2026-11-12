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
  createService?: (deps: SearchServiceDeps) => SearchServiceLike;
}

/** What a window's last search needs for its stale notice. */
interface LastSearch { searchId: number; includeIgnored: boolean; told: boolean }

interface Entry { wc: WebContents; project: SearchProject; service: SearchServiceLike; last: LastSearch | null }

/** An entry's service until its own is made. */
const NO_SERVICE: SearchServiceLike = { start: () => {}, stop: () => {}, dispose: () => {} };

export function installSearchIpc(deps: SearchIpcDeps): { filesChanged(root: string, ignoredOnly?: boolean): void } {
  const create = deps.createService ?? ((d: SearchServiceDeps) => new SearchService({ ...d, spawn: () => new Worker(deps.workerPath) }));
  const entries = new Map<number, Entry>();
  /** Windows whose `destroyed` and navigations are listened to already (once each, whatever their services). */
  const watched = new Set<number>();

  // Listings running, by project and filters: while the user types, each search with the same filters takes the one
  // already running instead of listing the project again. A finished listing is never reused (files come and go).
  const running = new Map<string, { root: string; listing: Promise<SearchListing> }>();
  const listing = (p: SearchProject, req: SearchRequest): Promise<SearchListing> => {
    const key = JSON.stringify([p.root, p.discovered, req.include, req.exclude, req.includeIgnored]);
    const held = running.get(key);
    if (held) return held.listing;
    const filter = compilePathFilter(req.include, req.exclude);
    const listed = (async (): Promise<SearchListing> => {
      const realRoot = await realOutAsync(p.root);
      const { files, capped } = await listSearchFiles(p.root, p.discovered, { includeIgnored: req.includeIgnored, cap: SEARCH_LIMITS.maxFiles, filter });
      return { files, capped, realRoot };
    })();
    const entry = { root: p.root, listing: listed };
    running.set(key, entry);
    const forget = (): void => { if (running.get(key) === entry) running.delete(key); };
    listed.then(forget, forget);
    return listed;
  };

  const drop = (id: number): void => {
    const en = entries.get(id);
    if (!en) return;
    entries.delete(id);
    en.service.dispose();
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
    // The project as it is when a search lists it (a later start may have brought new repositories).
    en.service = create({ list: (req) => listing(en.project, req) });
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
    en.last = { searchId: req.searchId, includeIgnored: req.includeIgnored, told: false };
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
     * that includes ignored files covers.
     */
    filesChanged(root, ignoredOnly = false) {
      // A listing running now may have read the folder before the change: the next search lists again.
      for (const [key, r] of running) if (r.root === root) running.delete(key);
      for (const en of entries.values()) {
        const last = en.last;
        if (en.project.root !== root || !last || last.told) continue;
        if (ignoredOnly && !last.includeIgnored) continue;
        if (en.wc.isDestroyed()) continue;
        last.told = true;
        en.wc.send(IPC.evSearch, { kind: 'stale', searchId: last.searchId } satisfies SearchEvent);
      }
    }
  };
}
