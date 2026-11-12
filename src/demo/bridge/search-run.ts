// The demo's Find in Files engine, a chunk of its own loaded on the first search (the first paint stays as it was):
// searches over the in-memory working tree with the app's own matcher and path filter (shared/search-match.ts,
// shared/search-filter.ts), so the demo finds what the app would find in the same files. No worker: the fictional
// project is a handful of files, searched in one go on the demo's clock. The events come as main sends them: a batch of
// the files with matches, in path order, then done; a search stopped before it ran ends as stopped, one replaced by a
// newer search is not heard from again; a file changed after a search tells it, once, that its results may be out of
// date.
import { SEARCH_LIMITS, type SearchEvent, type SearchFile, type SearchLine, type SearchRequest, type SkippedFile } from '@shared/search';
import { compilePathFilter } from '@shared/search-filter';
import { compileSearch, lineResult } from '@shared/search-match';
import type { Cancel } from '../engine/clock';
import type { DemoContext } from './context';
import { HIDDEN } from './files';

/** The app's limits (tests make them small). */
export interface DemoSearchLimits { maxResults: number; maxFiles: number; maxBytes: number; keptLineChars: number }

const LIMITS: DemoSearchLimits = {
  maxResults: SEARCH_LIMITS.maxResults, maxFiles: SEARCH_LIMITS.maxFiles, maxBytes: SEARCH_LIMITS.maxBytes, keptLineChars: SEARCH_LIMITS.keptLineChars
};

export interface SearchEngine { start(req: SearchRequest): void; stop(searchId: number): void }

/** The engine of one demo: its searches' events go to `tell`. */
export function createSearchEngine(ctx: DemoContext, limits: Partial<DemoSearchLimits>, tell: (e: SearchEvent) => void): SearchEngine {
  const lim: DemoSearchLimits = { ...LIMITS, ...limits };
  /** The search asked for, waiting for its turn on the clock. */
  let pending: { searchId: number; cancel: Cancel } | null = null;
  /** The last search that ran, and whether a change since was told to it. */
  let last: { searchId: number; told: boolean } | null = null;

  // Every change to the working tree comes through the worktree, which says so on fsChanged.
  ctx.events.on.fsChanged(() => {
    if (!last || last.told) return;
    last.told = true;
    tell({ kind: 'stale', searchId: last.searchId });
  });

  return {
    start(req) {
      // The search before is replaced: nothing more is heard from it.
      pending?.cancel();
      last = null;
      const { searchId } = req;
      const cancel = ctx.clock.after(0, () => {
        pending = null;
        last = { searchId, told: false };
        for (const e of runSearch(ctx.world.project.root, ctx.state.files, req, lim)) tell(e);
      });
      pending = { searchId, cancel };
    },
    stop(searchId) {
      // Only a search still waiting can be stopped: one that ran has ended already.
      if (pending?.searchId !== searchId) return;
      pending.cancel();
      pending = null;
      tell({ kind: 'done', searchId, searched: 0, total: 0, skipped: [], limitHit: false, fileCap: null, stopped: true });
    }
  };
}

const utf8 = new TextEncoder();
const byRel = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * The files a request covers, in main's order: the others sorted by path, then (when asked for) the ignored ones,
 * those in the tree's hidden folders, the same way; at most `cap`.
 */
function listFiles(files: Record<string, string>, req: SearchRequest, cap: number): { rels: string[]; capped: boolean } {
  const filter = compilePathFilter(req.include, req.exclude);
  const plain: string[] = [];
  const ignored: string[] = [];
  for (const rel of Object.keys(files)) {
    if (!filter(rel)) continue;
    if (!rel.split('/').some((part) => HIDDEN.has(part))) plain.push(rel);
    else if (req.includeIgnored) ignored.push(rel);
  }
  const all = [...plain.sort(byRel), ...ignored.sort(byRel)];
  return all.length > cap ? { rels: all.slice(0, cap), capped: true } : { rels: all, capped: false };
}

/**
 * One file's matches as main's scan collects them: lines split on `\n` (a trailing `\r` dropped, no line after a final
 * `\n`), at most `budget` matches, `truncated` once the budget cut one.
 */
function scanText(text: string, ranges: (line: string) => [number, number][], budget: number, keptLineChars: number): { lines: SearchLine[]; count: number; truncated: boolean } {
  const parts = text.split('\n');
  if (parts.at(-1) === '') parts.pop();
  const lines: SearchLine[] = [];
  let count = 0;
  for (let i = 0; i < parts.length; i++) {
    const raw = parts[i]!;
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    let found = ranges(line);
    if (found.length === 0) continue;
    const room = budget - count;
    const truncated = found.length > room;
    if (truncated) found = found.slice(0, room);
    if (found.length > 0) {
      count += found.length;
      lines.push(lineResult(i + 1, line, found, keptLineChars));
    }
    if (truncated) return { lines, count, truncated: true };
  }
  return { lines, count, truncated: false };
}

/** A whole search over `files` (rel → text) under `root` as they are now: its events, in order. */
function runSearch(root: string, files: Record<string, string>, req: SearchRequest, limits: DemoSearchLimits): SearchEvent[] {
  const { searchId } = req;
  const { rels, capped } = listFiles(files, req, limits.maxFiles);
  const total = rels.length;
  const skipped: SkippedFile[] = [];
  const done = (searched: number, limitHit: boolean): SearchEvent => ({ kind: 'done', searchId, searched, total, skipped, limitHit, fileCap: capped ? total : null, stopped: false });
  // An empty query, an invalid regular expression or one across lines: the page says why; nothing is searched.
  const compiled = compileSearch(req);
  if (compiled.kind !== 'ok') return [done(0, false)];
  const found: SearchFile[] = [];
  let searched = 0;
  let count = 0;
  let limitHit = false;
  for (const rel of rels) {
    const text = files[rel]!;
    const path = `${root}/${rel}`;
    const size = utf8.encode(text).length;
    searched++;
    if (size > limits.maxBytes) { skipped.push({ path, rel, size, reason: 'too-large' }); continue; }
    const r = scanText(text, compiled.ranges, limits.maxResults - count, limits.keptLineChars);
    if (r.count > 0) { found.push({ path, rel, size, lines: r.lines }); count += r.count; }
    if (r.truncated) { limitHit = true; break; }
  }
  const out: SearchEvent[] = [];
  if (searched > 0) out.push({ kind: 'batch', searchId, files: found, searched, total });
  out.push(done(searched, limitHit));
  return out;
}
