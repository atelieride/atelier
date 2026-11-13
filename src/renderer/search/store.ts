// Find in Files: the state of the window's search and the actions that drive it. Not imported by anything on the
// first-paint path: only the lazily loaded view and its opener use it.
import { create } from 'zustand';
import { MAX_FILE_BYTES } from '@shared/files';
import { pathStyle } from '@shared/platform';
import { SEARCH_LIMITS, type SearchEvent, type SearchFile, type SearchLine, type SearchSpec, type SkippedFile } from '@shared/search';
import { compileSearch, lineResult } from '@shared/search-match';
import { dirtyPaths, handoffOf } from '../editor/savers';
import { useApp } from '../store';
import { anyResult, buildRows, fileKey, stepResult } from './model';
import { searchLoaded } from './open';
import { pushRecent } from './recent';

export type SearchPhase = 'idle' | 'running' | 'done' | 'stopped' | 'error';

export const TYPE_DEBOUNCE_MS = 250;
/** Once this many matches are listed, files that arrive after them start collapsed. */
export const AUTO_COLLAPSE_AFTER = 1_000;

export interface SearchState {
  spec: SearchSpec;
  /** The spec the listed results were searched with (the field may already hold a newer query, not run yet). */
  ranSpec: SearchSpec;
  /** The paths those results were narrowed to, likewise. */
  ranFilters: { include: string; exclude: string };
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
  /**
   * F4 / ⇧F4 and the palette's Next / Previous Search Result: the match after (before) the selected row in the list's
   * order, across files and wrapping, selected and opened in the preview tab; the keyboard stays where it is with
   * `keepFocus`, else it goes to the editor. The file it opened, or null for none.
   */
  step(dir: 1 | -1, keepFocus: boolean): string | null;
  onEvent(e: SearchEvent): void;
  focusField(seed?: SearchSpec): void;
}

// Ids start at a random point of each page load, so a reloaded page never reuses an id an earlier page gave a search
// whose events may still be on their way.
let lastId = Math.floor(Math.random() * 2 ** 40) + 1;
let timer: ReturnType<typeof setTimeout> | null = null;
let subscribed = false;
/**
 * The results of the open files with unsaved changes, by path: main keeps each one's place in its order with a
 * placeholder, and the buffer's result goes there (no entry: the buffer has no match, the placeholder is dropped).
 */
let buffers = new Map<string, SearchFile>();
/** Matches the current search has listed so far, for the auto-collapse threshold and the result cap. */
let listedMatches = 0;
/** The result cap cut a file of the current search here (an unsaved buffer counts toward it): nothing more is listed. */
let capReached = false;
/**
 * The search running whose rows are not shown yet: the list keeps the previous search's rows (with the spec and
 * filters they were found with) until this one has rows of its own or ends, then they are all replaced at once; from
 * there the list only grows. Typing never empties the list in between.
 */
let incoming: { spec: SearchSpec; filters: { include: string; exclude: string } } | null = null;
const foldPath = (p: string): string => (pathStyle() === 'win32' ? p.toLowerCase() : p);
const NO_SPEC: SearchSpec = { query: '', matchCase: false, wholeWord: false, regex: false };
const NO_FILTERS = { include: '', exclude: '' };
const NONE: ReadonlySet<string> = new Set();

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

function matchCount(f: SearchFile): number {
  let n = 0;
  for (const l of f.lines) n += l.ranges.length;
  return n;
}

/** The file with its first `room` matches only. */
function firstMatches(f: SearchFile, room: number): SearchFile {
  const lines: SearchLine[] = [];
  for (const l of f.lines) {
    if (room <= 0) break;
    lines.push(l.ranges.length <= room ? l : { ...l, ranges: l.ranges.slice(0, room) });
    room -= l.ranges.length;
  }
  return { ...f, lines };
}

/**
 * The open files with unsaved changes, searched as their buffers show them: the paths to tell main (it decides which
 * of them the search covers and where they sit; a request names at most `unsavedMax`, the rest are searched from disk)
 * and the results by path. An editable buffer is at most 5 MB (larger files open read-only, never dirty); one over
 * that is left to the disk search rather than scanned on this thread. A buffer is matched up to the result cap and one
 * more (enough to know the cap cuts it), never further.
 */
function unsavedResults(root: string, spec: SearchSpec): { paths: string[]; results: Map<string, SearchFile> } {
  const paths: string[] = [];
  const results = new Map<string, SearchFile>();
  const compiled = compileSearch(spec);
  const budget = SEARCH_LIMITS.maxResults + 1;
  for (const path of dirtyPaths()) {
    if (paths.length >= SEARCH_LIMITS.unsavedMax) break;
    const rel = relativeTo(root, path);
    if (rel === null) continue;
    const doc = handoffOf(path)?.state.doc;
    if (typeof doc !== 'string' || doc.length > MAX_FILE_BYTES) continue;
    paths.push(path);
    if (compiled.kind !== 'ok') continue;
    const lines = [];
    const text = doc.split('\n');
    let count = 0;
    for (let i = 0; i < text.length && count < budget; i++) {
      const raw = text[i]!;
      const t = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
      const ranges = compiled.ranges(t, budget - count);
      if (ranges.length === 0) continue;
      lines.push(lineResult(i + 1, t, ranges, SEARCH_LIMITS.keptLineChars));
      count += ranges.length;
    }
    if (lines.length) results.set(foldPath(path), { path, rel, size: doc.length, lines });
  }
  return { paths, results };
}

const sameSpec = (a: SearchSpec, b: SearchSpec): boolean =>
  a.query === b.query && a.matchCase === b.matchCase && a.wholeWord === b.wholeWord && a.regex === b.regex;

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

  /**
   * The running search's rows take the list's place, once: the previous search's rows, its notices and dismissed rows
   * go. A Refresh (the same query and filters) keeps the selection and the collapsed files.
   */
  function swapIn(): void {
    const next = incoming;
    if (!next) return;
    incoming = null;
    const s = get();
    const again = sameSpec(s.ranSpec, next.spec) && s.ranFilters.include === next.filters.include && s.ranFilters.exclude === next.filters.exclude;
    set({
      files: [], skipped: [], limitHit: false, fileCap: null, error: null, dismissed: new Set(),
      collapsed: again ? s.collapsed : new Set(), selected: again ? s.selected : null, ranSpec: next.spec, ranFilters: next.filters
    });
  }

  return {
    spec: { ...NO_SPEC },
    ranSpec: NO_SPEC,
    ranFilters: NO_FILTERS,
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
      clearTimer();
      if (get().spec.query === '') get().clear();
      else get().run();
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
      // Nothing to look for, or nothing that can match (an invalid regular expression, a line break: the view says
      // why): no search, and the one before it stops.
      if (s.spec.query === '' || compileSearch(s.spec).kind !== 'ok') { s.clear(); return; }
      ensureSubscribed();
      abandon();
      const searchId = ++lastId;
      const root = useApp.getState().project?.root ?? '';
      const spec = { ...s.spec, query: s.spec.query.slice(0, SEARCH_LIMITS.queryMax) };
      const include = s.include.slice(0, SEARCH_LIMITS.globMax);
      const exclude = s.exclude.slice(0, SEARCH_LIMITS.globMax);
      const unsaved = root ? unsavedResults(root, spec) : { paths: [], results: new Map<string, SearchFile>() };
      buffers = unsaved.results;
      listedMatches = 0;
      capReached = false;
      incoming = { spec, filters: { include, exclude } };
      // The id is current before the request leaves: an event may arrive before `start` settles. A change on disk
      // noticed before this search counts no more.
      set({ searchId, phase: 'running', progress: { searched: 0, total: 0 }, stale: false });
      // Nothing on screen to keep: the list is this search's from the start.
      if (s.files.length === 0) swapIn();
      window.atelier.search.start({ ...spec, searchId, include, exclude, includeIgnored: s.includeIgnored, unsaved: unsaved.paths }).catch((err: unknown) => {
        if (get().searchId !== searchId) return;
        swapIn();
        set({ phase: 'error', error: { message: err instanceof Error ? err.message : String(err), rel: null } });
      });
    },

    stop() {
      const { searchId, phase } = get();
      if (phase !== 'running') return;
      void window.atelier.search.stop(searchId).catch(() => {});
      swapIn();
      set({ phase: 'stopped' });
    },

    clear() {
      clearTimer();
      abandon();
      buffers = new Map();
      listedMatches = 0;
      capReached = false;
      incoming = null;
      set({ ...noResults, collapsed: new Set(), dismissed: new Set(), searchId: 0, ranSpec: NO_SPEC, ranFilters: NO_FILTERS, phase: 'idle' });
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
    step(dir, keepFocus) {
      const s = get();
      // Every match counts, those of collapsed files too; dismissed ones are passed over.
      const rows = buildRows(s.files, NONE, s.dismissed);
      const key = stepResult(rows, s.selected, dir);
      const row = key === null ? undefined : rows.find((r) => r.key === key);
      if (row?.kind !== 'match') return null;
      // A collapsed file opens, so the list shows the row.
      const fk = fileKey(row.file.path);
      if (s.collapsed.has(fk)) s.toggleCollapsed(fk);
      s.select(row.key);
      useApp.getState().openSearchResult(row.file, row.line, row.index, { side: false, keepFocus, spec: s.ranSpec });
      return row.file.path;
    },

    onEvent(e) {
      const s = get();
      // Only the search this page started last counts: not an older one, not one a reloaded page started.
      if (s.searchId === 0 || e.searchId !== s.searchId) return;
      switch (e.kind) {
        case 'batch': {
          if (s.phase !== 'running') return;
          const progress = { searched: e.searched, total: e.total };
          const added: SearchFile[] = [];
          // The cap counts every match listed, an unsaved buffer's too (main counts only what it read): the file that
          // passes it is cut there, and nothing after it is listed.
          let count = listedMatches;
          for (const disk of e.files) {
            if (capReached) break;
            // A placeholder stands for a file the page searched itself: its buffer's result, or nothing.
            let f = disk.unsaved ? buffers.get(foldPath(disk.path)) : disk;
            if (!f) continue;
            const room = SEARCH_LIMITS.maxResults - count;
            let n = matchCount(f);
            if (n > room) {
              capReached = true;
              if (room <= 0) break;
              f = firstMatches(f, room);
              n = room;
            }
            added.push(f);
            count += n;
          }
          const cut = capReached ? { limitHit: true } : {};
          if (added.length === 0) { set({ progress, ...cut }); return; }
          swapIn();
          const now = get();
          // The same set unless a file arrives collapsed: the list rebuilds its rows only when what it shows changed.
          let collapsed = now.collapsed;
          for (const f of added) {
            if (listedMatches >= AUTO_COLLAPSE_AFTER) {
              if (collapsed === now.collapsed) collapsed = new Set(now.collapsed);
              collapsed.add(fileKey(f.path));
            }
            listedMatches += matchCount(f);
          }
          set({ files: [...now.files, ...added], collapsed, progress, ...cut });
          return;
        }
        case 'done': {
          swapIn();
          const now = get();
          set({
            phase: e.stopped ? 'stopped' : 'done', progress: { searched: e.searched, total: e.total },
            skipped: e.skipped, limitHit: e.limitHit || capReached, fileCap: e.fileCap
          });
          if (!e.stopped && now.files.length > 0) {
            const root = useApp.getState().project?.root;
            // What was searched, not what may have been typed since.
            if (root) pushRecent(root, now.ranSpec);
          }
          return;
        }
        case 'error':
          swapIn();
          set({ phase: 'error', error: { message: e.message, rel: e.rel } });
          return;
        case 'stale':
          set({ stale: true });
          return;
      }
    },

    focusField(seed) {
      // One update: the field takes its new text and the request together, so the whole text is what gets selected.
      set({ focusNonce: get().focusNonce + 1, ...(seed ? { spec: { ...seed } } : {}) });
      if (seed && seed.query !== '') { clearTimer(); get().run(); }
    }
  };
});

// What the first paint's opener reaches without importing this module: results to walk (and walking them), the options a
// seed is escaped for.
searchLoaded({
  hasResults: () => { const s = useSearch.getState(); return anyResult(s.files, s.dismissed); },
  spec: () => useSearch.getState().spec,
  step: (dir, keepFocus) => useSearch.getState().step(dir, keepFocus)
});
