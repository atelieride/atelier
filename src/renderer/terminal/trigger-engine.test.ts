import { beforeEach, expect, test } from 'vitest';
import { TriggerEngine, BATCH_MS, WATCHDOG_MS, type TriggerWorkerLike } from './trigger-engine';
import { triggerWorkerCore } from './triggers.worker-core';
import type { TerminalKind, TriggerRule } from '@shared/triggers';

// A fake clock and timers, and a worker that runs the real worker code in-process (answers on the next tick).
let clock = 0;
let timers: { at: number; fn: () => void; id: number }[] = [];
let nextId = 1;
const set = (fn: () => void, ms: number) => { const id = nextId++; timers.push({ at: clock + ms, fn, id }); return id; };
const clear = (h: unknown) => { timers = timers.filter((x) => x.id !== h); };
async function advance(ms: number) {
  const until = clock + ms;
  for (;;) {
    await Promise.resolve();
    const due = timers.filter((x) => x.at <= until).sort((a, b) => a.at - b.at)[0];
    if (!due) break;
    timers = timers.filter((x) => x !== due);
    clock = due.at;
    due.fn();
  }
  clock = until;
  await Promise.resolve(); await Promise.resolve();
}

interface Fake extends TriggerWorkerLike { posts: unknown[]; terminated: boolean; hang: string | null }
let workers: Fake[] = [];
function makeWorker(): Fake {
  const core = triggerWorkerCore((out) => {
    const msg = out as { rule?: string };
    // A rule that "never finishes": its start is reported, then nothing more.
    if (w.hang && msg.rule === w.hang) { w.hang = 'hung'; queueMicrotask(() => w.onmessage?.({ data: out } as MessageEvent)); return; }
    if (w.hang === 'hung') return;
    queueMicrotask(() => { if (!w.terminated) w.onmessage?.({ data: out } as MessageEvent); });
  }, () => clock);
  const w: Fake = {
    onmessage: null, posts: [], terminated: false, hang: null,
    postMessage(m) { w.posts.push(m); if (!w.terminated) core(m); },
    terminate() { w.terminated = true; }
  };
  workers.push(w);
  return w;
}

const rule = (over: Partial<TriggerRule> = {}): TriggerRule => ({ id: 'n', pattern: 'tests failed', action: 'notify', scope: 'all', enabled: true, ...over });
let notified: [string, string, string][] = [];
let highlighted: [string, string[]][] = [];
let slow: string[] = [];
let broken: string[] = [];
let kinds: Record<string, TerminalKind> = {};

function engine(make: () => TriggerWorkerLike = makeWorker) {
  return new TriggerEngine({
    makeWorker: make, kindOf: (id) => kinds[id] ?? null, now: () => clock, timers: { set, clear },
    onNotify: (id, r, line) => notified.push([id, r.pattern, line]),
    onHighlight: (id, texts) => highlighted.push([id, texts]),
    onSlow: (r) => slow.push(r.id),
    onBroken: (reason) => broken.push(reason)
  });
}

beforeEach(() => { clock = 0; timers = []; workers = []; notified = []; highlighted = []; slow = []; broken = []; kinds = { t1: 'terminal', t2: 'terminal', s1: 'session' }; });

test('notify: the same line again (a TUI redraw) is one entry for 10 minutes, even past the 30 s throttle', async () => {
  const e = engine();
  e.setRules([rule()]);
  e.data('s1', '  3 tests failed\n');
  await advance(BATCH_MS);
  await advance(31_000);
  e.data('s1', '3 tests   failed  \n');
  await advance(BATCH_MS);
  await advance(5 * 60_000);
  e.data('s1', '3 tests failed\n');
  await advance(BATCH_MS);
  expect(notified).toEqual([['s1', 'tests failed', '  3 tests failed']]);
  // Another line still notifies once the throttle allows; the same one again after 10 minutes too.
  e.data('s1', '4 tests failed\n');
  await advance(BATCH_MS);
  expect(notified).toHaveLength(2);
  await advance(10 * 60_000);
  e.data('s1', '3 tests failed\n');
  await advance(BATCH_MS);
  expect(notified).toHaveLength(3);
});

test('notify: lines written while the alternate screen is active (Claude full screen) never notify', async () => {
  const e = engine();
  e.setRules([rule(), rule({ id: 'h', pattern: 'ERR', action: 'highlight' })]);
  e.data('s1', '\x1b[?1049h\x1b[Htests failed\r\n');
  e.data('s1', 'still tests fa');
  e.data('s1', 'iled\n\x1b[?1049');
  e.data('s1', 'l');
  await advance(BATCH_MS);
  expect(notified).toEqual([]);
  e.data('s1', 'back: tests failed\n');
  await advance(BATCH_MS);
  expect(notified).toEqual([['s1', 'tests failed', 'back: tests failed']]);
  // The attach snapshot tells whether the screen is the alternate one, without being matched.
  e.data('t1', 'pending');
  e.snapshot('t1', '\x1b[?1049h\x1b[Htests failed\r\n');
  e.data('t1', 'x tests failed\n');
  await advance(BATCH_MS);
  expect(notified).toHaveLength(1);
});

test('a worker that fails to load: "Triggers are paused" once, no recreate loop, a retry after a back-off', async () => {
  let failing = true;
  const make = (): TriggerWorkerLike => {
    if (!failing) return makeWorker();
    const w: TriggerWorkerLike & { onerror?: ((e: { message?: string }) => void) | null } = {
      onmessage: null, onerror: null,
      postMessage() { queueMicrotask(() => w.onerror?.({ message: 'Failed to load module script' })); },
      terminate() { /* nothing */ }
    };
    workers.push(w as Fake);
    return w;
  };
  const e = engine(make);
  e.setRules([rule()]);
  for (let i = 0; i < 10; i++) { e.data('t1', `${i} tests failed\n`); await advance(BATCH_MS + 10); }
  expect(broken).toHaveLength(1);
  expect(broken[0]).toContain('Failed to load module script');
  expect(workers).toHaveLength(1);
  failing = false;
  await advance(5 * 60_000);
  e.data('t1', 'later tests failed\n');
  await advance(BATCH_MS);
  expect(workers).toHaveLength(2);
  expect(notified).toEqual([['t1', 'tests failed', 'later tests failed']]);
});

test('a worker that cannot even be constructed: paused once, no loop', async () => {
  let calls = 0;
  const e = engine(() => { calls++; throw new Error('SecurityError'); });
  e.setRules([rule()]);
  for (let i = 0; i < 10; i++) { e.data('t1', `${i} tests failed\n`); await advance(BATCH_MS + 10); }
  expect(calls).toBe(1);
  expect(broken).toEqual([expect.stringContaining('SecurityError')]);
});

test('notify: once per rule per terminal every 30 s, however often it matches', async () => {
  const e = engine();
  e.setRules([rule()]);
  e.data('t1', '1 tests failed\r\n2 tests failed\r\n');
  await advance(BATCH_MS);
  e.data('t1', '3 tests failed\n');
  e.data('t2', '\x1b[31mtests failed\x1b[0m\n');
  await advance(BATCH_MS);
  expect(notified).toEqual([['t1', 'tests failed', '1 tests failed'], ['t2', 'tests failed', 'tests failed']]);
  await advance(30_000);
  e.data('t1', '4 tests failed\n');
  await advance(BATCH_MS);
  expect(notified.at(-1)).toEqual(['t1', 'tests failed', '4 tests failed']);
});

test('output is batched: many chunks within the batch window are one message to the worker', async () => {
  const e = engine();
  e.setRules([rule()]);
  for (let i = 0; i < 20; i++) e.data('t1', `line ${i}\n`);
  await advance(BATCH_MS);
  expect(workers).toHaveLength(1);
  expect(workers[0]!.posts.filter((m) => (m as { batch?: unknown }).batch)).toHaveLength(1);
});

test('the attach snapshot is never matched: a partial line before it is dropped', async () => {
  const e = engine();
  e.setRules([rule()]);
  e.data('t1', 'tests fai');
  e.snapshot('t1');
  e.data('t1', 'led\n');
  await advance(BATCH_MS);
  expect(notified).toEqual([]);
});

test('disabled rules, or none: no worker, nothing matched', async () => {
  const e = engine();
  e.setRules([rule({ enabled: false })]);
  e.data('t1', 'tests failed\n');
  await advance(BATCH_MS);
  expect(workers).toHaveLength(0);
  expect(notified).toEqual([]);
});

test('scope and highlight: sessions-only rules skip plain terminals; highlight hands over the matched texts', async () => {
  const e = engine();
  e.setRules([rule({ id: 's', scope: 'sessions' }), rule({ id: 'h', pattern: '/ERR\\w*/', action: 'highlight' })]);
  e.data('t1', 'tests failed ERROR\n');
  e.data('s1', 'tests failed\n');
  e.data('gone', 'tests failed\n');
  await advance(BATCH_MS);
  expect(notified).toEqual([['s1', 'tests failed', 'tests failed']]);
  expect(highlighted).toEqual([['t1', ['ERROR']]]);
});

test('watchdog: a rule that hangs the worker is paused, the worker replaced, the others go on', async () => {
  const e = engine();
  e.setRules([rule({ id: 'slow', pattern: '/x/' }), rule()]);
  e.data('t1', 'warm up\n');
  await advance(BATCH_MS);
  workers[0]!.hang = 'slow';
  e.data('t1', 'x tests failed\n');
  await advance(BATCH_MS + WATCHDOG_MS);
  expect(workers[0]!.terminated).toBe(true);
  expect(slow).toEqual(['slow']);
  e.data('t1', 'x tests failed\n');
  await advance(BATCH_MS);
  expect(workers).toHaveLength(2);
  expect(notified).toEqual([['t1', 'tests failed', 'x tests failed']]);
  // Paused for this run of the app: the new worker never gets it.
  const rulesSent = workers[1]!.posts.find((m) => (m as { rules?: unknown }).rules) as { rules: TriggerRule[] };
  expect(rulesSent.rules.map((r) => r.id)).toEqual(['n']);
});

test('a flood keeps only the newest lines of each terminal per batch', async () => {
  const e = engine();
  e.setRules([rule()]);
  e.data('t1', 'tests failed first\n' + 'filler\n'.repeat(5000) + 'tests failed last\n');
  await advance(BATCH_MS);
  expect(notified).toEqual([['t1', 'tests failed', 'tests failed last']]);
});
