// One search over a list of files, as the search worker runs it. Files are read a few at a time while the matching
// stays on this one thread; results go out in the list's order, in batches at most every BATCH_MS, and a heartbeat
// keeps main's watchdog informed of which file is being matched.
import type { SearchEvent, SearchFile, SearchLine, SearchSpec, SkippedFile } from '@shared/search';
import { compileSearch } from '@shared/search-match';
import type { ListedFile } from './list';
import { scanFile, type ScanLimits, type ScanResult } from './scan';

export interface RunInput {
  searchId: number;
  spec: SearchSpec;
  /** The files to search, in the order their results are shown. */
  files: ListedFile[];
  /** The number of files listed when the listing stopped at its cap; null when it covers the whole project. */
  fileCap: number | null;
  limits: ScanLimits & { maxResults: number };
  /** The project's root with symlinks resolved: nothing outside it is read. */
  realRoot: string;
}

/** What the worker posts: a search's events, and heartbeats naming the file being matched (null before the first). */
export type WorkerMsg = SearchEvent | { kind: 'beat'; searchId: number; rel: string | null };

/** What the worker is told: start a search (which stops any other), or stop one. */
export type WorkerIn = { type: 'start'; input: RunInput } | { type: 'stop'; searchId: number };

/** Files read at the same time: their reads overlap, their matching does not. */
export const READ_AHEAD = 8;
/** Least time between two batches: the window is redrawn for a group of files, not for each one. */
export const BATCH_MS = 50;
/** Longest silence while a search works; main's watchdog waits much longer before it gives up on the worker. */
export const BEAT_MS = 200;
/** Lines matched between two looks at the clock. */
const LINES_PER_LOOK = 256;

/** The first `room` matches of a file's lines. */
function firstMatches(lines: SearchLine[], room: number): SearchLine[] {
  const out: SearchLine[] = [];
  for (const l of lines) {
    if (room <= 0) break;
    out.push(l.ranges.length <= room ? l : { ...l, ranges: l.ranges.slice(0, room) });
    room -= l.ranges.length;
  }
  return out;
}

/**
 * Searches `input.files` and posts what it finds: batches of files with matches (in the list's order, whatever order
 * the reads finish in), then one `done`. It stops at `limits.maxResults` matches, or when `cancelled()` says so; either
 * way the reads still running wind down before `done` is posted, so no work outlives the search.
 *
 * Beats: one at the start, one each time matching moves to another file, and one after any BEAT_MS of silence. A
 * regular expression stuck on a line stops every message, and the last beat then names the file it is stuck in.
 */
export async function runSearch(input: RunInput, post: (m: WorkerMsg) => void, cancelled: () => boolean, now: () => number = () => performance.now()): Promise<void> {
  const { searchId, files, limits } = input;
  const total = files.length;
  let lastPost = now();
  const send = (m: WorkerMsg): void => {
    post(m);
    lastPost = now();
  };
  let matching: string | null = null;
  const beat = (): void => send({ kind: 'beat', searchId, rel: matching });
  beat();

  const skipped: SkippedFile[] = [];
  let pending: SearchFile[] = [];
  let lastBatch = -Infinity;
  let searched = 0;
  let found = 0;
  const flush = (force: boolean): void => {
    if (pending.length === 0) return;
    const t = now();
    if (!force && t - lastBatch < BATCH_MS) return;
    const out = pending;
    pending = [];
    lastBatch = t;
    send({ kind: 'batch', searchId, files: out, searched, total });
  };
  const finish = (limitHit: boolean, stopped: boolean): void => {
    flush(true);
    send({ kind: 'done', searchId, searched, total, skipped, limitHit, fileCap: input.fileCap, stopped });
  };

  const compiled = compileSearch(input.spec);
  if (compiled.kind !== 'ok' || cancelled()) {
    finish(false, cancelled());
    return;
  }
  const { ranges } = compiled;
  const matcherFor = (rel: string): ((line: string) => [number, number][]) => {
    let lines = 0;
    return (line) => {
      if (matching !== rel) {
        matching = rel;
        beat();
      } else if (++lines % LINES_PER_LOOK === 0 && now() - lastPost >= BEAT_MS) {
        beat();
      }
      return ranges(line);
    };
  };

  let halted = false;
  const halt = (): boolean => halted || cancelled();
  const reads: Promise<ScanResult>[] = [];
  let next = 0;
  // Each read gets the matches still allowed when it starts; a later look at the cap trims what it found.
  const read = (): void => {
    const f = files[next++]!;
    reads.push(scanFile(f.path, matcherFor(f.rel), limits, limits.maxResults - found, halt, input.realRoot));
  };
  // Results waiting behind a slower file still go out on time, and waiting on reads is never silence.
  const tick = setInterval(() => {
    flush(false);
    if (now() - lastPost >= BEAT_MS) beat();
  }, BATCH_MS);

  let limitHit = false;
  let stopped = false;
  try {
    while (next < total && reads.length < READ_AHEAD) read();
    while (reads.length > 0) {
      const r = await reads.shift()!;
      if (cancelled()) {
        stopped = true;
        break;
      }
      const f = files[searched++]!;
      if (r.kind === 'skipped') {
        skipped.push({ path: f.path, rel: f.rel, size: r.size, reason: r.reason });
      } else if (r.kind === 'lines' && r.count > 0) {
        const room = limits.maxResults - found;
        pending.push({ path: f.path, rel: f.rel, size: r.size, lines: r.count > room ? firstMatches(r.lines, room) : r.lines });
        found += Math.min(r.count, room);
      }
      if (found >= limits.maxResults) {
        limitHit = true;
        break;
      }
      if (next < total) read();
      flush(false);
    }
  } finally {
    halted = true;
    clearInterval(tick);
    await Promise.allSettled(reads);
  }
  finish(limitHit, stopped);
}

/**
 * The worker's side of the messages: searches run one at a time, in the order asked. A start stops every search
 * before it (the new one begins once they have wound down); a stop for a search not begun yet makes it end at once.
 */
export function searchRunner(post: (m: WorkerMsg) => void): (m: WorkerIn) => void {
  const live = new Map<number, { stopped: boolean }>();
  let queue: Promise<void> = Promise.resolve();
  return (m) => {
    if (m.type === 'stop') {
      const run = live.get(m.searchId);
      if (run) run.stopped = true;
      return;
    }
    for (const run of live.values()) run.stopped = true;
    const { input } = m;
    const run = { stopped: false };
    live.set(input.searchId, run);
    queue = queue.then(async () => {
      try {
        await runSearch(input, post, () => run.stopped);
      } catch (e) {
        post({ kind: 'error', searchId: input.searchId, message: `The search stopped: ${e instanceof Error ? e.message : String(e)}`, rel: null });
      } finally {
        if (live.get(input.searchId) === run) live.delete(input.searchId);
      }
    });
  };
}
