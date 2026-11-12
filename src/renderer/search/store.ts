// Find in Files: the state of the window's search and the actions that drive it. Not imported by anything on the
// first-paint path: only the lazily loaded view and its opener use it.
import { create } from 'zustand';
import { SEARCH_LIMITS, type SearchEvent, type SearchFile, type SearchSpec, type SkippedFile } from '@shared/search';
import { compileSearch, lineResult } from '@shared/search-match';
import { compilePathFilter } from '@shared/search-filter';
import { dirtyPaths, handoffOf } from '../editor/savers';
import { useApp } from '../store';
import { fileKey } from './model';
import { pushRecent } from './recent';

export type SearchPhase = 'idle' | 'running' | 'done' | 'stopped' | 'error';

export const TYPE_DEBOUNCE_MS = 250;
/** Once this many matches are listed, files that arrive after them start collapsed. */
export const AUTO_COLLAPSE_AFTER = 1_000;

export interface SearchState {
  spec: SearchSpec;
  include: string;
  exclude: string;
  includeIgnored: boolean;
  filtersOpen: boolean;
  /** The search whose events count (0: none). */
  searchId: number;
  phase: SearchPhase;
  files: SearchFile[];
  progress: { searched: number; total: number };
  skipped: SkippedFile[];
  limitHit: boolean;
  fileCap: number | null;
  stale: boolean;
  error: { message: string; rel: string | null } | null;
  collapsed: Set<string>;
  dismissed: Set<string>;
  selected: string | null;
  focusNonce: number;
  setQuery(q: string): void;
  setSpec(p: Partial<SearchSpec>): void;
  setFilters(p: { include?: string; exclude?: string; includeIgnored?: boolean }): void;
  toggleFilters(): void;
  run(): void;
  stop(): void;
  clear(): void;
  toggleCollapsed(key: string): void;
  setAllCollapsed(v: boolean): void;
  dismiss(key: string): void;
  select(key: string | null): void;
  onEvent(e: SearchEvent): void;
  focusField(seed?: SearchSpec): void;
}

// Ids start at a random point of each page load, so a reloaded page never reuses an id an earlier page gave a search
// whose events may still be on their way.
let lastId = Math.floor(Math.random() * 2 ** 40) + 1;
let timer: ReturnType<typeof setTimeout> | null = null;
let subscribed = false;
/** The unsaved buffers' results of the running search, in path order, not yet placed in the list. */
let pendingUnsaved: SearchFile[] = [];
let dirtySet: Set<string> = new Set();

const noResults = {
  files: [] as SearchFile[],
  progress: { searched: 0, total: 0 },
  skipped: [] as SkippedFile[],
  limitHit: false,
  fileCap: null as number | null,
  stale: false,
  error: null as { message: string; rel: string | null } | null,
  collapsed: new Set<string>(),
  dismissed: new Set<string>(),
  selected: null as string | null
};

function clearTimer(): void {
  if (timer) clearTimeout(timer);
  timer = null;
}

function matchCount(files: SearchFile[]): number {
  let n = 0;
  for (const f of files) for (const l of f.lines) n += l.ranges.length;
  return n;
}

/** The results of the open files with unsaved changes, as their buffers show them. */
function unsavedResults(root: string, spec: SearchSpec, include: string, exclude: string): { files: SearchFile[]; dirty: Set<string> } {
  const dirty = new Set<string>();
  const files: SearchFile[] = [];
  const compiled = compileSearch(spec);
  const allowed = compilePathFilter(include, exclude);
  for (const path of dirtyPaths()) {
    const rel = relativeTo(root, path);
    if (rel === null || !allowed(rel)) continue;
    const doc = handoffOf(path)?.state.doc;
    if (typeof doc !== 'string') continue;
    dirty.add(path);
    if (compiled.kind !== 'ok') continue;
    const lines = [];
    const text = doc.split('\n');
    for (let i = 0; i < text.length; i++) {
      const raw = text[i]!;
      const t = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
      const ranges = compiled.ranges(t);
      if (ranges.length) lines.push(lineResult(i + 1, t, ranges, SEARCH_LIMITS.keptLineChars));
    }
    if (lines.length) files.push({ path, rel, size: doc.length, lines });
  }
  files.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  return { files, dirty };
}

function relativeTo(root: string, path: string): string | null {
  for (const sep of ['/', '\\']) {
    const prefix = root.endsWith(sep) ? root : root + sep;
    if (path.startsWith(prefix)) return path.slice(prefix.length).replaceAll('\\', '/');
  }
  return null;
}

export const useSearch = create<SearchState>((set, get) => {
  function ensureSubscribed(): void {
    if (subscribed) return;
    subscribed = true;
    window.atelier.search.onEvent((e) => get().onEvent(e));
  }

  function schedule(): void {
    clearTimer();
    timer = setTimeout(() => { timer = null; get().run(); }, TYPE_DEBOUNCE_MS);
  }

  /** Stops the search in flight, if any, and makes its events count for nothing. */
  function abandon(): void {
    const { searchId, phase } = get();
    if (searchId && phase === 'running') void window.atelier.search.stop(searchId).catch(() => {});
  }

  return {
    spec: { query: '', matchCase: false, wholeWord: false, regex: false },
    include: '',
    exclude: '',
    includeIgnored: false,
    filtersOpen: false,
    searchId: 0,
    phase: 'idle',
    ...noResults,
    focusNonce: 0,

    setQuery(q) {
      set({ spec: { ...get().spec, query: q } });
      if (q === '') get().clear();
      else schedule();
    },
    setSpec(p) {
      if (p.query !== undefined && Object.keys(p).length === 1) { get().setQuery(p.query); return; }
      set({ spec: { ...get().spec, ...p } });
      if (get().spec.query === '') return;
      clearTimer();
      get().run();
    },
    setFilters(p) {
      set({ ...(p.include !== undefined ? { include: p.include } : {}), ...(p.exclude !== undefined ? { exclude: p.exclude } : {}), ...(p.includeIgnored !== undefined ? { includeIgnored: p.includeIgnored } : {}) });
      if (get().spec.query !== '') schedule();
    },
    toggleFilters() {
      set({ filtersOpen: !get().filtersOpen });
    },

    run() {
      clearTimer();
      const s = get();
      if (s.spec.query === '') { s.clear(); return; }
      ensureSubscribed();
      abandon();
      const searchId = ++lastId;
      const root = useApp.getState().project?.root ?? '';
      const spec = { ...s.spec, query: s.spec.query.slice(0, SEARCH_LIMITS.queryMax) };
      const include = s.include.slice(0, SEARCH_LIMITS.globMax);
      const exclude = s.exclude.slice(0, SEARCH_LIMITS.globMax);
      const unsaved = root ? unsavedResults(root, spec, include, exclude) : { files: [], dirty: new Set<string>() };
      pendingUnsaved = unsaved.files;
      dirtySet = unsaved.dirty;
      // The id is current before the request leaves: an event may arrive before `start` settles.
      set({ ...noResults, collapsed: new Set(), dismissed: new Set(), searchId, phase: 'running' });
      window.atelier.search.start({ ...spec, searchId, include, exclude, includeIgnored: s.includeIgnored }).catch((err: unknown) => {
        if (get().searchId !== searchId) return;
        set({ phase: 'error', error: { message: err instanceof Error ? err.message : String(err), rel: null } });
      });
    },

    stop() {
      const { searchId, phase } = get();
      if (phase !== 'running') return;
      void window.atelier.search.stop(searchId).catch(() => {});
      // What the search found stays; the unsaved buffers' results not yet placed come after it.
      const files = [...get().files, ...pendingUnsaved];
      pendingUnsaved = [];
      set({ phase: 'stopped', files });
    },

    clear() {
      clearTimer();
      abandon();
      pendingUnsaved = [];
      dirtySet = new Set();
      set({ ...noResults, collapsed: new Set(), dismissed: new Set(), searchId: 0, phase: 'idle' });
    },

    toggleCollapsed(key) {
      const next = new Set(get().collapsed);
      if (!next.delete(key)) next.add(key);
      set({ collapsed: next });
    },
    setAllCollapsed(v) {
      set({ collapsed: v ? new Set(get().files.map((f) => fileKey(f.path))) : new Set() });
    },
    dismiss(key) {
      const dismissed = new Set(get().dismissed);
      dismissed.add(key);
      set({ dismissed, selected: get().selected === key ? null : get().selected });
    },
    select(key) {
      set({ selected: key });
    },

    onEvent(e) {
      const s = get();
      // Only the search this page started last counts: not an older one, not one a reloaded page started.
      if (s.searchId === 0 || e.searchId !== s.searchId) return;
      switch (e.kind) {
        case 'batch': {
          if (s.phase !== 'running') return;
          let files = s.files;
          const collapsed = new Set(s.collapsed);
          let total = matchCount(files);
          const add = (f: SearchFile): void => {
            if (total >= AUTO_COLLAPSE_AFTER) collapsed.add(fileKey(f.path));
            files = [...files, f];
            total += matchCount([f]);
          };
          for (const f of e.files) {
            if (dirtySet.has(f.path)) continue;
            while (pendingUnsaved.length && pendingUnsaved[0]!.rel < f.rel) add(pendingUnsaved.shift()!);
            add(f);
          }
          set({ files, collapsed, progress: { searched: e.searched, total: e.total } });
          return;
        }
        case 'done': {
          // Every disk file has arrived: what is left of the unsaved results sorts after all of them.
          const files = pendingUnsaved.length ? [...s.files, ...pendingUnsaved] : s.files;
          pendingUnsaved = [];
          set({
            files, phase: e.stopped ? 'stopped' : 'done', progress: { searched: e.searched, total: e.total },
            skipped: e.skipped, limitHit: e.limitHit, fileCap: e.fileCap
          });
          if (!e.stopped && files.length > 0) {
            const root = useApp.getState().project?.root;
            if (root) pushRecent(root, s.spec);
          }
          return;
        }
        case 'error':
          set({ phase: 'error', error: { message: e.message, rel: e.rel } });
          return;
        case 'stale':
          set({ stale: true });
          return;
      }
    },

    focusField(seed) {
      set({ focusNonce: get().focusNonce + 1 });
      if (!seed) return;
      set({ spec: { ...seed } });
      if (seed.query !== '') { clearTimer(); get().run(); }
    }
  };
});
