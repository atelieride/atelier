// One search over a list of files, as the search worker runs it. Files are read a few at a time while the matching
// stays on this one thread; results go out in the list's order, in batches at most every BATCH_MS, and a heartbeat
// tells main's watchdog the worker is alive.
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
  /**
   * Memory shared with main (`sharedSlots()`): the search writes the 1-based index of the file it is matching at
   * SHARED_FILE, main writes 1 at SHARED_STOP to stop it. Main can read the file while the worker is stuck, and the
   * search sees the stop between two lines, where no message can reach it. Left out (tests), neither is shared.
   */
  shared?: Int32Array;
}

export const SHARED_FILE = 0;
export const SHARED_STOP = 1;

/** A fresh shared slot for one search. */
export function sharedSlots(): Int32Array {
  return new Int32Array(new SharedArrayBuffer(2 * Int32Array.BYTES_PER_ELEMENT));
}

/** What the worker posts: a search's events, and heartbeats. */
export type WorkerMsg = SearchEvent | { kind: 'beat'; searchId: number };

/** What the worker is told: start a search (which stops any other), or stop one. */
export type WorkerIn = { type: 'start'; input: RunInput } | { type: 'stop'; searchId: number };

/** Files read at the same time: their reads overlap, their matching does not. */
export const READ_AHEAD = 8;
/** Least time between two batches: the window is redrawn for a group of files, not for each one. */
export const BATCH_MS = 50;
/** Longest silence while a search works; main's watchdog waits much longer before it gives up on the worker. */
export const BEAT_MS = 200;
/** Lines, or characters, matched between two looks at the clock: a few long lines can take as long as many short ones. */
const LINES_PER_LOOK = 256;
const CHARS_PER_LOOK = 16_384;

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
 * the reads finish in) or of progress alone, then one `done`. It stops once the result cap cuts a match, or when
 * stopped; reads still running are told to end and post nothing more.
 *
 * Beats: one at the start, then one after any BEAT_MS without a message, whether the thread is waiting on reads or
 * matching a long file. Which file is being matched is written in the shared slot, not posted: a message per file
 * would be up to 100,000 of them through main.
 */
export async function runSearch(input: RunInput, post: (m: WorkerMsg) => void, cancelled: () => boolean, now: () => number = () => performance.now()): Promise<void> {
  const { searchId, files, limits } = input;
  const total = files.length;
  const shared = input.shared ?? sharedSlots();
  // A stop comes as a message (`cancelled`) and in the shared slot. Matching a file read whole is one synchronous run
  // that no message can interrupt, but the scan looks at the slot every 1,024 lines (and at each chunk of a streamed
  // file). A single line is never interrupted: main's watchdog covers a regular expression stuck on one.
  const stopAsked = (): boolean => cancelled() || Atomics.load(shared, SHARED_STOP) !== 0;

  let over = false;
  let lastPost = now();
  const send = (m: WorkerMsg): void => {
    if (over) return;
    post(m);
    lastPost = now();
  };
  const beat = (): void => send({ kind: 'beat', searchId });
  beat();

  const skipped: SkippedFile[] = [];
  let pending: SearchFile[] = [];
  let lastBatch = -Infinity;
  let searched = 0;
  /** `searched` as the last batch said it. */
  let reported = 0;
  let found = 0;
  // A batch carries the files with matches found since the last one, or progress alone when there are none.
  const flush = (force: boolean): void => {
    if (pending.length === 0 && (force || searched === reported)) return;
    const t = now();
    if (!force && t - lastBatch < BATCH_MS) return;
    const out = pending;
    pending = [];
    lastBatch = t;
    reported = searched;
    send({ kind: 'batch', searchId, files: out, searched, total });
  };
  const finish = (limitHit: boolean, stopped: boolean): void => {
    flush(true);
    send({ kind: 'done', searchId, searched, total, skipped, limitHit, fileCap: input.fileCap, stopped });
    over = true;
  };

  const compiled = compileSearch(input.spec);
  if (compiled.kind !== 'ok' || stopAsked()) {
    finish(false, stopAsked());
    return;
  }
  const { ranges } = compiled;
  let matching = 0;
  let lines = 0;
  let chars = 0;
  const matcherFor = (index: number): ((line: string) => [number, number][]) => (line) => {
    // A read that ends after `done` (it was not waited for) may still bring its text: the query never runs on it, so
    // nothing of this search competes with the next one, or gets stuck in its name.
    if (halted) return [];
    if (matching !== index + 1) {
      matching = index + 1;
      Atomics.store(shared, SHARED_FILE, matching);
    }
    lines++;
    chars += line.length;
    if (lines >= LINES_PER_LOOK || chars >= CHARS_PER_LOOK) {
      lines = 0;
      chars = 0;
      if (now() - lastPost >= BEAT_MS) beat();
    }
    return ranges(line);
  };

  let halted = false;
  const halt = (): boolean => halted || stopAsked();
  const reads: Promise<ScanResult>[] = [];
  let next = 0;
  // Each read gets the matches still allowed when it starts; a later look at the cap trims what it found.
  const read = (): void => {
    const index = next++;
    reads.push(scanFile(files[index]!.path, matcherFor(index), limits, limits.maxResults - found, halt, input.realRoot));
  };
  // A stop ends the wait for a read, which may never finish (a file that cannot be downloaded).
  let wake: () => void = () => undefined;
  const woken = new Promise<null>((res) => { wake = () => res(null); });
  // Results waiting behind a slower file still go out on time, and waiting on reads is never silence.
  const tick = setInterval(() => {
    if (stopAsked()) wake();
    flush(false);
    if (now() - lastPost >= BEAT_MS) beat();
  }, BATCH_MS);

  let limitHit = false;
  let stopped = false;
  try {
    while (next < total && reads.length < READ_AHEAD) read();
    while (reads.length > 0) {
      const r = await Promise.race([reads.shift()!, woken]);
      if (r === null || stopAsked()) {
        stopped = true;
        break;
      }
      const f = files[searched++]!;
      if (r.kind === 'skipped') {
        skipped.push({ path: f.path, rel: f.rel, size: r.size, reason: r.reason });
      } else if (r.kind === 'lines') {
        const room = limits.maxResults - found;
        const kept = Math.min(r.count, room);
        if (kept > 0) {
          pending.push({ path: f.path, rel: f.rel, size: r.size, lines: r.count > room ? firstMatches(r.lines, room) : r.lines });
          found += kept;
        }
        // The cap cut a match: this file had more than its read allowed, or more than the room left now.
        if (r.truncated || r.count > room) {
          limitHit = true;
          break;
        }
      }
      if (next < total) read();
      flush(false);
    }
  } finally {
    halted = true;
    clearInterval(tick);
    for (const p of reads) p.catch(() => undefined);
  }
  finish(limitHit, stopped);
}

/**
 * The worker's side of the messages: searches run one at a time, in the order asked. A start stops every search
 * before it (the new one begins once they have ended); a stop for a search not begun yet makes it end at once.
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
