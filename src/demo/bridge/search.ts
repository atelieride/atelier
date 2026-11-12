// search.* in the demo: Find in Files over the in-memory working tree. Its engine (bridge/search-run.ts: the app's own
// matcher and path filter) is a chunk of its own, loaded on the first search; until then nothing has been searched,
// so nothing can be out of date either. Calls made meanwhile run in order once it is there.
import type { AtelierApi } from '@shared/api';
import type { SearchEvent } from '@shared/search';
import type { DemoContext } from './context';
import type { DemoSearchLimits, SearchEngine } from './search-run';

export function createSearch(ctx: DemoContext, limits: Partial<DemoSearchLimits> = {}): AtelierApi['search'] {
  const listeners = new Set<(e: SearchEvent) => void>();
  // As the bridge's emitter does: a copy (a listener may unsubscribe while it runs), one throwing never stops the rest.
  const tell = (e: SearchEvent): void => {
    for (const fn of [...listeners]) {
      try { fn(e); } catch (err) { console.error(err); }
    }
  };
  let engine: Promise<SearchEngine> | null = null;
  // A chunk that did not load (the visitor went offline) is asked for again by the next search.
  const load = (): Promise<SearchEngine> =>
    (engine ??= import('./search-run').then((m) => m.createSearchEngine(ctx, limits, tell), (err: unknown) => { engine = null; throw err; }));
  return {
    start: (req) => load().then((s) => s.start(req), (err: unknown) => {
      console.error(err);
      tell({ kind: 'error', searchId: req.searchId, message: 'The search stopped: it could not be started.', rel: null });
    }),
    stop: (searchId) => load().then((s) => s.stop(searchId), () => {}),
    onEvent(cb) {
      listeners.add(cb);
      return () => { listeners.delete(cb); };
    }
  };
}
