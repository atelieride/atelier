import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { SearchEvent, SearchRequest } from '@shared/search';
import { useMachinePlatform } from '../../../tests/support/platform';
import type { ListedFile } from './list';
import { searchRunner, type WorkerIn, type WorkerMsg } from './run';
import { SearchService, type SearchListing, type WorkerLike } from './service';

useMachinePlatform();

type Handler = (x: unknown) => void;

/** The parts of a worker every fake shares: what it was sent, its listeners, whether it was terminated. */
class FakeBase implements WorkerLike {
  readonly sent: WorkerIn[] = [];
  terminated = false;
  private readonly handlers = new Map<string, Handler[]>();
  postMessage(m: unknown): void {
    this.sent.push(m as WorkerIn);
  }
  on(ev: 'message' | 'error' | 'exit', cb: Handler): void {
    this.handlers.set(ev, [...(this.handlers.get(ev) ?? []), cb]);
  }
  terminate(): Promise<number> {
    this.terminated = true;
    // A terminated worker exits as a real one does.
    this.fire('exit', 1);
    return Promise.resolve(1);
  }
  fire(ev: string, x: unknown): void {
    for (const h of this.handlers.get(ev) ?? []) h(x);
  }
  /** The run id the service gave the last search it started here. */
  lastRunId(): number {
    const starts = this.sent.filter((m) => m.type === 'start');
    return (starts.at(-1) as Extract<WorkerIn, { type: 'start' }>).input.searchId;
  }
}

/** Runs the worker's own message handling in this thread, asynchronously as a real worker would. */
class InProcess extends FakeBase {
  /** Every message the worker posted, late ones included. */
  readonly posted: WorkerMsg[] = [];
  private readonly handle = searchRunner((m) => {
    this.posted.push(m);
    setImmediate(() => { if (!this.terminated) this.fire('message', m); });
  });
  override postMessage(m: unknown): void {
    super.postMessage(m);
    setImmediate(() => { if (!this.terminated) this.handle(m as WorkerIn); });
  }
  override terminate(): Promise<number> {
    // What it was running winds down without being heard.
    for (const m of this.sent) if (m.type === 'start') this.handle({ type: 'stop', searchId: m.input.searchId });
    return super.terminate();
  }
}

/** A worker that never answers unless the test says so. */
class Silent extends FakeBase {
  reply(m: WorkerMsg): void {
    this.fire('message', m);
  }
}

function req(searchId: number, query = 'token', over: Partial<SearchRequest> = {}): SearchRequest {
  return { searchId, query, matchCase: true, wholeWord: false, regex: false, include: '', exclude: '', includeIgnored: false, ...over };
}

/** A project of `n` files, each with one match; the listing a search gets for it. */
function project(n: number): SearchListing {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'atl-search-svc-')));
  const files: ListedFile[] = [];
  for (let i = 0; i < n; i++) {
    const rel = `f${String(i).padStart(4, '0')}.txt`;
    writeFileSync(join(root, rel), `line one\na token in ${rel}\n`);
    files.push({ path: join(root, rel), rel, ignored: false });
  }
  return { files, capped: false, realRoot: root };
}

/** Events of one search, with a promise for its end (done or error). */
function recorder() {
  const events: SearchEvent[] = [];
  let end!: (e: SearchEvent) => void;
  const ended = new Promise<SearchEvent>((r) => { end = r; });
  let firstBatch!: () => void;
  const batched = new Promise<void>((r) => { firstBatch = r; });
  const emit = (e: SearchEvent) => {
    events.push(e);
    if (e.kind === 'batch') firstBatch();
    if (e.kind === 'done' || e.kind === 'error') end(e);
  };
  return { events, emit, ended, batched };
}

/** Lets resolved promises (the listing) run: microtasks are never faked. */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

afterEach(() => {
  vi.useRealTimers();
});

describe('SearchService', () => {
  test('a search runs in the worker and its events reach emit with the request id', async () => {
    const listing = project(30);
    const workers: InProcess[] = [];
    const svc = new SearchService({ spawn: () => { const w = new InProcess(); workers.push(w); return w; }, list: async () => listing });
    const r = recorder();
    svc.start(req(7), r.emit);
    const end = await r.ended;
    expect(end).toMatchObject({ kind: 'done', searchId: 7, searched: 30, total: 30, stopped: false, limitHit: false, fileCap: null });
    expect(r.events.every((e) => e.searchId === 7)).toBe(true);
    expect(r.events.some((e) => (e as { kind: string }).kind === 'beat')).toBe(false);
    const files = r.events.flatMap((e) => (e.kind === 'batch' ? e.files : []));
    expect(files.map((f) => f.rel)).toEqual(listing.files.map((f) => f.rel));
    expect(files[0]!.lines).toEqual([expect.objectContaining({ line: 2 })]);
    // One worker, spawned for the first search and kept.
    svc.start(req(8), recorder().emit);
    await vi.waitFor(() => expect(workers[0]!.sent.filter((m) => m.type === 'start')).toHaveLength(2));
    expect(workers).toHaveLength(1);
    svc.dispose();
  });

  test('the service passes its limits and the listing on to the worker', async () => {
    const listing = { ...project(3), capped: true };
    const w = new Silent();
    const svc = new SearchService({ spawn: () => w, list: async () => listing, limits: { maxResults: 9 } });
    svc.start(req(1, 'needle', { matchCase: false, wholeWord: true, regex: true }), recorder().emit);
    await vi.waitFor(() => expect(w.sent).toHaveLength(1));
    const start = w.sent[0] as Extract<WorkerIn, { type: 'start' }>;
    expect(start.input).toMatchObject({
      spec: { query: 'needle', matchCase: false, wholeWord: true, regex: true },
      files: listing.files,
      fileCap: 3,
      realRoot: listing.realRoot,
      limits: { maxResults: 9, wholeReadBytes: 5 * 1024 * 1024, maxBytes: 50 * 1024 * 1024, keptLineChars: 2000 },
    });
    svc.dispose();
  });

  test('a new search stops the one running, and the old one\'s late messages are dropped', async () => {
    const listing = project(1000);
    const w = new InProcess();
    const svc = new SearchService({ spawn: () => w, list: async () => listing });
    const first = recorder();
    svc.start(req(1), first.emit);
    await first.batched;
    const heard = first.events.length;
    const oldRun = w.lastRunId();
    const second = recorder();
    svc.start(req(2), second.emit);
    expect(await second.ended).toMatchObject({ kind: 'done', searchId: 2, searched: 1000, stopped: false });
    // The first was told to stop, and kept talking for a while: none of it reached anyone.
    expect(w.sent.find((m) => m.type === 'stop')).toEqual({ type: 'stop', searchId: oldRun });
    expect(w.posted.filter((m) => m.searchId === oldRun && m.kind === 'done')).toEqual([expect.objectContaining({ stopped: true })]);
    expect(first.events).toHaveLength(heard);
    expect(second.events.every((e) => e.searchId === 2)).toBe(true);
    svc.dispose();
  });

  test('the same search id twice: the second search never hears the first', async () => {
    const listing = project(200);
    const w = new InProcess();
    const svc = new SearchService({ spawn: () => w, list: async () => listing });
    const first = recorder();
    svc.start(req(5), first.emit);
    await first.batched;
    const second = recorder();
    svc.start(req(5, 'line one'), second.emit);
    await second.ended;
    // Every file the second search lists matched its own query, never the first's.
    const texts = second.events.flatMap((e) => (e.kind === 'batch' ? e.files.flatMap((f) => f.lines.map((l) => l.text)) : []));
    expect(texts.length).toBe(200);
    expect(texts.every((t) => t === 'line one')).toBe(true);
    svc.dispose();
  });

  test('stop ends the search with stopped: true and what it found so far', async () => {
    const listing = project(1000);
    const svc = new SearchService({ spawn: () => new InProcess(), list: async () => listing });
    const r = recorder();
    svc.start(req(3), r.emit);
    await r.batched;
    svc.stop(3);
    const end = await r.ended;
    expect(end).toMatchObject({ kind: 'done', searchId: 3, stopped: true });
    expect((end as Extract<SearchEvent, { kind: 'done' }>).searched).toBeLessThan(1000);
    svc.dispose();
  });

  test('stop while the files are being listed ends the search at once, and no worker is started', async () => {
    let listed: ((l: SearchListing) => void) | null = null;
    const spawn = vi.fn(() => new Silent());
    const svc = new SearchService({ spawn, list: () => new Promise<SearchListing>((r) => { listed = r; }) });
    const r = recorder();
    svc.start(req(4), r.emit);
    await vi.waitFor(() => expect(listed).not.toBeNull());
    svc.stop(4);
    expect(r.events).toEqual([{ kind: 'done', searchId: 4, searched: 0, total: 0, skipped: [], limitHit: false, fileCap: null, stopped: true }]);
    listed!(project(2));
    await new Promise((res) => setImmediate(res));
    expect(r.events).toHaveLength(1);
    expect(spawn).not.toHaveBeenCalled();
    svc.dispose();
  });

  test('stop for another search id does nothing', async () => {
    const w = new Silent();
    const svc = new SearchService({ spawn: () => w, list: async () => project(1) });
    svc.start(req(4), recorder().emit);
    await vi.waitFor(() => expect(w.sent).toHaveLength(1));
    svc.stop(99);
    expect(w.sent).toHaveLength(1);
    svc.dispose();
  });

  test('a listing that fails reports an error', async () => {
    const svc = new SearchService({ spawn: () => new Silent(), list: async () => { throw new Error('gone'); } });
    const r = recorder();
    svc.start(req(6), r.emit);
    expect(await r.ended).toEqual({ kind: 'error', searchId: 6, message: 'The search stopped: the project\'s files could not be listed.', rel: null });
  });

  describe('watchdog', () => {
    test('a worker silent for watchdogMs is terminated; the error names the last beat\'s file; the next search gets a fresh worker', async () => {
      vi.useFakeTimers();
      const workers: Silent[] = [];
      const svc = new SearchService({ spawn: () => { const w = new Silent(); workers.push(w); return w; }, list: async () => project(1), watchdogMs: 1000 });
      const r = recorder();
      svc.start(req(9, '(a+)+$', { regex: true }), r.emit);
      await settle();
      const w = workers[0]!;
      const id = w.lastRunId();
      w.reply({ kind: 'beat', searchId: id, rel: null });
      await vi.advanceTimersByTimeAsync(400);
      w.reply({ kind: 'beat', searchId: id, rel: 'src/slow.ts' });
      await vi.advanceTimersByTimeAsync(999);
      expect(w.terminated).toBe(false);
      expect(r.events).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      expect(w.terminated).toBe(true);
      expect(r.events).toEqual([{ kind: 'error', searchId: 9, message: 'The search stopped: a regular expression took too long on src/slow.ts.', rel: 'src/slow.ts' }]);
      // A late word from the terminated worker reaches no one.
      w.reply({ kind: 'done', searchId: id, searched: 1, total: 1, skipped: [], limitHit: false, fileCap: null, stopped: false });
      expect(r.events).toHaveLength(1);

      svc.start(req(10), recorder().emit);
      await settle();
      expect(workers).toHaveLength(2);
      expect(workers[1]!.sent.map((m) => m.type)).toEqual(['start']);
      svc.dispose();
    });

    test('without a beat naming a file, or for a plain query, the error says so in other words', async () => {
      vi.useFakeTimers();
      const workers: Silent[] = [];
      const svc = new SearchService({ spawn: () => { const w = new Silent(); workers.push(w); return w; }, list: async () => project(1), watchdogMs: 1000 });
      const a = recorder();
      svc.start(req(1, 'x', { regex: true }), a.emit);
      await settle();
      workers[0]!.reply({ kind: 'beat', searchId: workers[0]!.lastRunId(), rel: null });
      await vi.advanceTimersByTimeAsync(1000);
      expect(a.events).toEqual([{ kind: 'error', searchId: 1, message: 'The search stopped: it took too long.', rel: null }]);

      const b = recorder();
      svc.start(req(2, 'x'), b.emit);
      await settle();
      workers[1]!.reply({ kind: 'beat', searchId: workers[1]!.lastRunId(), rel: 'big.log' });
      await vi.advanceTimersByTimeAsync(1000);
      expect(b.events).toEqual([{ kind: 'error', searchId: 2, message: 'The search stopped: searching big.log took too long.', rel: 'big.log' }]);
      svc.dispose();
    });

    test('every message resets the watchdog, and an idle worker is never terminated', async () => {
      vi.useFakeTimers();
      const w = new Silent();
      const svc = new SearchService({ spawn: () => w, list: async () => project(1), watchdogMs: 1000 });
      const r = recorder();
      svc.start(req(1), r.emit);
      await settle();
      const id = w.lastRunId();
      for (let k = 0; k < 10; k++) {
        await vi.advanceTimersByTimeAsync(900);
        w.reply({ kind: 'beat', searchId: id, rel: `f${k}` });
      }
      expect(w.terminated).toBe(false);
      w.reply({ kind: 'done', searchId: id, searched: 1, total: 1, skipped: [], limitHit: false, fileCap: null, stopped: false });
      await vi.advanceTimersByTimeAsync(60_000);
      expect(w.terminated).toBe(false);
      expect(r.events.map((e) => e.kind)).toEqual(['done']);
      expect(vi.getTimerCount()).toBe(0);
      svc.dispose();
    });

    test('stuck in a search already replaced: the current one starts again on a fresh worker, with no error', async () => {
      vi.useFakeTimers();
      const workers: Silent[] = [];
      const svc = new SearchService({ spawn: () => { const w = new Silent(); workers.push(w); return w; }, list: async () => project(1), watchdogMs: 1000 });
      svc.start(req(1, '(a+)+$', { regex: true }), recorder().emit);
      await settle();
      workers[0]!.reply({ kind: 'beat', searchId: workers[0]!.lastRunId(), rel: 'src/slow.ts' });
      await vi.advanceTimersByTimeAsync(300);
      const r = recorder();
      svc.start(req(2, 'fixed'), r.emit);
      await settle();
      expect(workers[0]!.sent.map((m) => m.type)).toEqual(['start', 'stop', 'start']);
      // The new search was only queued behind the stuck one: the watchdog still counts from the last message.
      await vi.advanceTimersByTimeAsync(699);
      expect(workers[0]!.terminated).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(workers[0]!.terminated).toBe(true);
      expect(r.events).toEqual([]);
      expect(workers).toHaveLength(2);
      const again = workers[1]!.sent as Extract<WorkerIn, { type: 'start' }>[];
      expect(again.map((m) => [m.type, m.input.spec.query])).toEqual([['start', 'fixed']]);
      // The fresh worker answers: its events reach the new search.
      workers[1]!.reply({ kind: 'done', searchId: again[0]!.input.searchId, searched: 1, total: 1, skipped: [], limitHit: false, fileCap: null, stopped: false });
      expect(r.events).toEqual([expect.objectContaining({ kind: 'done', searchId: 2 })]);
      svc.dispose();
    });

    test('stuck in a replaced search when the current one was stopped too: it ends stopped, with no new worker', async () => {
      vi.useFakeTimers();
      const workers: Silent[] = [];
      const listing = project(3);
      const svc = new SearchService({ spawn: () => { const w = new Silent(); workers.push(w); return w; }, list: async () => listing, watchdogMs: 1000 });
      svc.start(req(1, '(a+)+$', { regex: true }), recorder().emit);
      await settle();
      workers[0]!.reply({ kind: 'beat', searchId: workers[0]!.lastRunId(), rel: 'src/slow.ts' });
      const r = recorder();
      svc.start(req(2, 'fixed'), r.emit);
      await settle();
      svc.stop(2);
      await vi.advanceTimersByTimeAsync(1000);
      expect(workers[0]!.terminated).toBe(true);
      expect(workers).toHaveLength(1);
      expect(r.events).toEqual([{ kind: 'done', searchId: 2, searched: 0, total: 3, skipped: [], limitHit: false, fileCap: null, stopped: true }]);
      svc.dispose();
    });
  });

  test('a real worker thread stuck in a regular expression is terminated, and the error names its file', async () => {
    // A worker speaking the same messages: it names its file in a beat, then backtracks for ever.
    const code = `
      const { parentPort } = require('node:worker_threads');
      parentPort.on('message', (m) => {
        if (m.type !== 'start') return;
        parentPort.postMessage({ kind: 'beat', searchId: m.input.searchId, rel: 'src/stuck.txt' });
        /(a+)+$/u.test('a'.repeat(40) + 'b');
      });`;
    let exited: Promise<number> | null = null;
    const spawn = () => {
      const w = new Worker(code, { eval: true });
      exited = new Promise<number>((res) => w.once('exit', res));
      return w;
    };
    const svc = new SearchService({ spawn, list: async () => project(1), watchdogMs: 300 });
    const r = recorder();
    svc.start(req(1, '(a+)+$', { regex: true }), r.emit);
    expect(await r.ended).toEqual({ kind: 'error', searchId: 1, message: 'The search stopped: a regular expression took too long on src/stuck.txt.', rel: 'src/stuck.txt' });
    // The thread is really gone, not just forgotten.
    expect(await exited).toBe(1);
    svc.dispose();
  });

  test('a worker that dies reports an error, and the next search gets a fresh one', async () => {
    const workers: Silent[] = [];
    const svc = new SearchService({ spawn: () => { const w = new Silent(); workers.push(w); return w; }, list: async () => project(1) });
    const r = recorder();
    svc.start(req(1), r.emit);
    await vi.waitFor(() => expect(workers[0]?.sent).toHaveLength(1));
    workers[0]!.reply({ kind: 'beat', searchId: workers[0]!.lastRunId(), rel: null });
    workers[0]!.fire('error', new Error('out of memory'));
    workers[0]!.fire('exit', 1);
    expect(r.events).toEqual([{ kind: 'error', searchId: 1, message: 'The search stopped: its worker quit unexpectedly.', rel: null }]);
    svc.start(req(2), recorder().emit);
    await vi.waitFor(() => expect(workers).toHaveLength(2));
    svc.dispose();
  });

  test('a worker that dies before doing anything, every time: one more try, then an error (never a loop)', async () => {
    const workers: FakeBase[] = [];
    const spawn = () => {
      const w = new FakeBase();
      workers.push(w);
      // It quits as soon as it is given work, as a worker whose file fails to load would.
      w.postMessage = (m) => { FakeBase.prototype.postMessage.call(w, m); queueMicrotask(() => w.fire('exit', 1)); };
      return w;
    };
    const svc = new SearchService({ spawn, list: async () => project(1) });
    const r = recorder();
    svc.start(req(1), r.emit);
    expect(await r.ended).toEqual({ kind: 'error', searchId: 1, message: 'The search stopped: its worker quit unexpectedly.', rel: null });
    await new Promise((res) => setImmediate(res));
    expect(workers).toHaveLength(2);
    svc.dispose();
  });

  test('dispose terminates the worker; nothing is emitted afterwards, and later searches do nothing', async () => {
    vi.useFakeTimers();
    const workers: Silent[] = [];
    const svc = new SearchService({ spawn: () => { const w = new Silent(); workers.push(w); return w; }, list: async () => project(1), watchdogMs: 1000 });
    const r = recorder();
    svc.start(req(1), r.emit);
    await settle();
    const w = workers[0]!;
    const id = w.lastRunId();
    w.reply({ kind: 'beat', searchId: id, rel: null });
    svc.dispose();
    expect(w.terminated).toBe(true);
    w.reply({ kind: 'done', searchId: id, searched: 1, total: 1, skipped: [], limitHit: false, fileCap: null, stopped: false });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(r.events).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
    svc.start(req(2), r.emit);
    await settle();
    expect(workers).toHaveLength(1);
    expect(r.events).toEqual([]);
  });

  test('dispose while the files are being listed: the listing is dropped', async () => {
    let listed: ((l: SearchListing) => void) | null = null;
    const spawn = vi.fn(() => new Silent());
    const svc = new SearchService({ spawn, list: () => new Promise<SearchListing>((res) => { listed = res; }) });
    const r = recorder();
    svc.start(req(1), r.emit);
    await vi.waitFor(() => expect(listed).not.toBeNull());
    svc.dispose();
    listed!(project(1));
    await new Promise((res) => setImmediate(res));
    expect(spawn).not.toHaveBeenCalled();
    expect(r.events).toEqual([]);
  });
});
