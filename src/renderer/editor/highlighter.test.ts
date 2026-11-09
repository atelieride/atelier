import { expect, test } from 'vitest';
import { createHighlighter, type WorkerLike } from './highlighter';

const spans = { spans: [0, 1, 0], colors: ['#fff'] };

function fakeWorkers() {
  const made: { sent: { id: number; code: string }[]; terminated: boolean; reply(i?: number): void }[] = [];
  const factory = (): WorkerLike => {
    const w = {
      sent: [] as { id: number; code: string }[], terminated: false,
      onmessage: null as ((e: MessageEvent) => void) | null,
      postMessage(m: { id: number; code: string }) { this.sent.push(m); },
      terminate() { this.terminated = true; },
      // The worker answers its i-th request.
      reply(i = 0) { this.onmessage?.({ data: { id: this.sent[i]!.id, result: spans } } as MessageEvent); }
    };
    made.push(w);
    return w;
  };
  return { made, factory };
}

test('one request at a time in the worker, in order', async () => {
  const { made, factory } = fakeWorkers();
  const h = createHighlighter(factory, () => 0);
  const a = h.highlight('a', 'ts', 'x');
  const b = h.highlight('b', 'ts', 'y');
  expect(made[0]!.sent.map((m) => m.code)).toEqual(['a']);
  made[0]!.reply(0);
  expect(await a).toEqual(spans);
  expect(made[0]!.sent.map((m) => m.code)).toEqual(['a', 'b']);
  made[0]!.reply(1);
  expect(await b).toEqual(spans);
});

test('a newer request for the same editor drops the waiting one, which never reaches the worker', async () => {
  const { made, factory } = fakeWorkers();
  const h = createHighlighter(factory, () => 0);
  void h.highlight('busy', 'ts', 'other');
  const old = h.highlight('v1', 'ts', 'file');
  const fresh = h.highlight('v2', 'ts', 'file');
  // 'dropped', not null: null means "this language can't be highlighted" (the editor then says "Plain text").
  expect(await old).toBe('dropped');
  made[0]!.reply(0);
  expect(made[0]!.sent.map((m) => m.code)).toEqual(['busy', 'v2']);
  made[0]!.reply(1);
  expect(await fresh).toEqual(spans);
});

test('cancel (an editor closed): its waiting request is dropped', async () => {
  const { made, factory } = fakeWorkers();
  const h = createHighlighter(factory, () => 0);
  void h.highlight('busy', 'ts', 'other');
  const p = h.highlight('x', 'ts', 'gone');
  h.cancel('gone');
  expect(await p).toBe('dropped');
  made[0]!.reply(0);
  expect(made[0]!.sent.map((m) => m.code)).toEqual(['busy']);
});

test('a slow highlight that is no longer wanted stops: the worker is replaced and the queue goes on', async () => {
  const { made, factory } = fakeWorkers();
  let now = 0;
  const h = createHighlighter(factory, () => now);
  const slow = h.highlight('huge', 'ts', 'file');
  const other = h.highlight('small', 'ts', 'other');
  now = 1000;
  const next = h.highlight('huge v2', 'ts', 'file');
  expect(await slow).toBe('dropped');
  expect(made[0]!.terminated).toBe(true);
  // A fresh worker takes the rest, in order.
  expect(made[1]!.sent.map((m) => m.code)).toEqual(['small']);
  made[1]!.reply(0);
  expect(await other).toEqual(spans);
  expect(made[1]!.sent.map((m) => m.code)).toEqual(['small', 'huge v2']);
  made[1]!.reply(1);
  expect(await next).toEqual(spans);
});

function timers() {
  const pending: { at: number; fn: () => void }[] = [];
  return {
    schedule: (fn: () => void, ms: number, from: number) => { pending.push({ at: from + ms, fn }); },
    /** Runs the timers due by `t`. */
    run(t: number) { for (const x of pending.splice(0).filter((p) => { if (p.at <= t) return true; pending.push(p); return false; })) x.fn(); }
  };
}

test('a quick one that answers before the stop deadline is not worth a new worker: its result is dropped', async () => {
  const { made, factory } = fakeWorkers();
  let now = 0;
  const tm = timers();
  const h = createHighlighter(factory, () => now, (fn, ms) => tm.schedule(fn, ms, now));
  const first = h.highlight('v1', 'ts', 'file');
  now = 50;
  const second = h.highlight('v2', 'ts', 'file');
  expect(made[0]!.terminated).toBe(false);
  made[0]!.reply(0);
  expect(await first).toBe('dropped');
  now = 400;
  tm.run(400);
  // The stop deadline passed while v2 runs: v2 is wanted, so nothing is stopped.
  expect(made[0]!.terminated).toBe(false);
  made[0]!.reply(1);
  expect(await second).toEqual(spans);
  expect(made).toHaveLength(1);
});

test('cancelled quickly but then running long: stopped at 300 ms, the queue does not wait for it', async () => {
  const { made, factory } = fakeWorkers();
  let now = 0;
  const tm = timers();
  const h = createHighlighter(factory, () => now, (fn, ms) => tm.schedule(fn, ms, now));
  const stale = h.highlight('huge', 'ts', 'file');
  now = 20;
  h.cancel('file');
  const other = h.highlight('small', 'ts', 'other');
  expect(made[0]!.terminated).toBe(false);
  now = 300;
  tm.run(300);
  expect(made[0]!.terminated).toBe(true);
  expect(await stale).toBe('dropped');
  expect(made[1]!.sent.map((m) => m.code)).toEqual(['small']);
  made[1]!.reply(0);
  expect(await other).toEqual(spans);
});
