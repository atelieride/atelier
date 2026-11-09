import { expect, test } from 'vitest';
import type { CloseMode, CloseSessionsAsk, ProjectBusy } from '@shared/close-sessions';
import { CloseGuard } from './close-guard';

// A project window closing, or Atelier quitting: what is asked, what is decided,
// and that the terminals stop only once the window is gone.

const busyP = (root: string, n: number): ProjectBusy => ({
  root, name: root.slice(1), ids: ['a', 'b'], idleSessions: 1, idleTerminals: 0,
  busy: Array.from({ length: n }, (_, i) => ({ id: `w${i}`, kind: 'working' as const, title: `w${i}`, color: '#fff', session: true }))
});

function setup(o: { mode?: CloseMode; busy?: Record<string, number>; answer?: 'cancel' | 'keep' | 'stop' } = {}) {
  const asked: CloseSessionsAsk[] = [];
  const stopped: string[] = [];
  let answerNow: ((a: 'cancel' | 'keep' | 'stop') => void) | null = null;
  const guard = new CloseGuard<string>({
    mode: () => o.mode ?? 'ask',
    busy: async (roots) => roots.map((r) => busyP(r, o.busy?.[r] ?? 0)),
    ask: (_win, req) => {
      asked.push(req);
      return o.answer ? Promise.resolve(o.answer) : new Promise((res) => { answerNow = res; });
    },
    stop: async (root) => { stopped.push(root); }
  });
  return { guard, asked, stopped, answer: (a: 'cancel' | 'keep' | 'stop') => answerNow?.(a) };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

test('nothing busy: held a moment, then closes with no question; its terminals stop once the window is gone', async () => {
  const { guard, asked, stopped } = setup();
  let reclosed = 0;
  expect(guard.onClose('/p', 'win', () => { reclosed += 1; })).toBe(false);
  await tick();
  expect(reclosed).toBe(1);
  expect(asked).toEqual([]);
  expect(stopped).toEqual([]);
  expect(guard.onClose('/p', 'win', () => { reclosed += 1; })).toBe(true);
  guard.onClosed('/p');
  expect(stopped).toEqual(['/p']);
});

test('something busy: asked; Keep in Background closes and stops nothing; Stop and Close stops on closed', async () => {
  for (const [answer, stops] of [['keep', []], ['stop', ['/p']]] as const) {
    const { guard, asked, stopped } = setup({ busy: { '/p': 2 }, answer });
    let reclosed = 0;
    expect(guard.onClose('/p', 'win', () => { reclosed += 1; })).toBe(false);
    await tick();
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({ kind: 'close-sessions', what: 'close', windows: 1 });
    expect(reclosed).toBe(1);
    expect(guard.onClose('/p', 'win', () => {})).toBe(true);
    guard.onClosed('/p');
    expect(stopped).toEqual(stops);
  }
});

test('Cancel keeps the window and forgets: the next close asks again; a close while asking stays held', async () => {
  const { guard, asked, answer } = setup({ busy: { '/p': 1 } });
  let reclosed = 0;
  expect(guard.onClose('/p', 'win', () => { reclosed += 1; })).toBe(false);
  await tick();
  expect(guard.onClose('/p', 'win', () => { reclosed += 1; })).toBe(false);
  answer('cancel');
  await tick();
  expect(reclosed).toBe(0);
  expect(asked).toHaveLength(1);
  guard.onClose('/p', 'win', () => {});
  await tick();
  expect(asked).toHaveLength(2);
});

test('a later step calls the close off (unsaved files, a pop-out): the answer is forgotten, nothing stops', async () => {
  const { guard, stopped } = setup({ busy: { '/p': 1 }, answer: 'stop' });
  guard.onClose('/p', 'win', () => {});
  await tick();
  expect(guard.onClose('/p', 'win', () => {})).toBe(true);
  guard.forget('/p');
  guard.onClosed('/p');
  expect(stopped).toEqual([]);
});

test('modes: keep never asks nor stops; stop never asks and stops', async () => {
  const keep = setup({ mode: 'keep', busy: { '/p': 3 } });
  expect(keep.guard.onClose('/p', 'w', () => {})).toBe(true);
  keep.guard.onClosed('/p');
  expect([keep.asked, keep.stopped]).toEqual([[], []]);
  const stop = setup({ mode: 'stop', busy: { '/p': 3 } });
  expect(stop.guard.onClose('/p', 'w', () => {})).toBe(true);
  stop.guard.onClosed('/p');
  expect([stop.asked, stop.stopped]).toEqual([[], ['/p']]);
});

test('quit: one question for every project window, only the busy ones listed; the answer holds for all', async () => {
  const { guard, asked, stopped } = setup({ busy: { '/q': 2 }, answer: 'stop' });
  expect(await guard.decideQuit(['/p', '/q'], null)).toBe(true);
  expect(asked).toHaveLength(1);
  expect(asked[0]).toMatchObject({ what: 'quit', windows: 1, projects: [{ name: 'q' }] });
  guard.onClosed('/p');
  guard.onClosed('/q');
  expect(stopped).toEqual(['/p', '/q']);
});

test('quit: nothing busy stops all without asking; Cancel calls the quit off; keep for an update restart', async () => {
  const idle = setup();
  expect(await idle.guard.decideQuit(['/p'], null)).toBe(true);
  idle.guard.onClosed('/p');
  expect([idle.asked, idle.stopped]).toEqual([[], ['/p']]);
  const cancel = setup({ busy: { '/p': 1 }, answer: 'cancel' });
  expect(await cancel.guard.decideQuit(['/p'], null)).toBe(false);
  cancel.guard.onClosed('/p');
  expect(cancel.stopped).toEqual([]);
  const update = setup({ busy: { '/p': 1 } });
  update.guard.keepAll(['/p']);
  update.guard.onClosed('/p');
  expect([update.asked, update.stopped]).toEqual([[], []]);
});

test('the quit waits for stop requests still on their way, never longer than its cap', async () => {
  let release: () => void = () => {};
  const guard = new CloseGuard<string>({ mode: () => 'stop', busy: async () => [], ask: async () => 'keep', stop: () => new Promise<void>((r) => { release = r; }) });
  guard.onClose('/p', 'w', () => {});
  guard.onClosed('/p');
  expect(guard.hasPending()).toBe(true);
  let done = false;
  const settled = guard.settle(1000).then(() => { done = true; });
  await tick();
  expect(done).toBe(false);
  release();
  await settled;
  expect(guard.hasPending()).toBe(false);
  const stuck = new CloseGuard<string>({ mode: () => 'stop', busy: async () => [], ask: async () => 'keep', stop: () => new Promise<void>(() => {}) });
  stuck.onClose('/p', 'w', () => {});
  stuck.onClosed('/p');
  const t0 = Date.now();
  await stuck.settle(30);
  expect(Date.now() - t0).toBeLessThan(500);
});

test('a busy read that fails: nothing is known busy, so nothing is risked — kept running, not stopped', async () => {
  const guard = new CloseGuard<string>({ mode: () => 'ask', busy: async () => { throw new Error('ps'); }, ask: async () => 'stop', stop: async () => { throw new Error('never'); } });
  let reclosed = 0;
  guard.onClose('/p', 'w', () => { reclosed += 1; });
  await tick();
  expect(reclosed).toBe(1);
  expect(guard.onClose('/p', 'w', () => {})).toBe(true);
  expect(() => guard.onClosed('/p')).not.toThrow();
  expect(guard.hasPending()).toBe(false);
});

// An update's restart (or an OS shutdown) keeps everything, even when unsaved files make it go through the
// windows closing one by one or through a resumed quit, for as long as the restart may take.
test('keepFor: every close and quit keeps (no question, nothing stopped) until it runs out', async () => {
  let now = 1000;
  const asked: CloseSessionsAsk[] = [];
  const stopped: string[] = [];
  const guard = new CloseGuard<string>({ mode: () => 'ask', now: () => now, busy: async (roots) => roots.map((r) => busyP(r, 1)), ask: async (_w, r) => { asked.push(r); return 'stop'; }, stop: async (r) => { stopped.push(r); } });
  guard.keepFor(120_000);
  expect(guard.onClose('/p', 'w', () => {})).toBe(true);
  guard.onClosed('/p');
  expect(await guard.decideQuit(['/q'], null)).toBe(true);
  guard.onClosed('/q');
  expect([asked, stopped]).toEqual([[], []]);
  now += 120_001;
  guard.onClose('/p', 'w', () => {});
  await tick();
  expect(asked).toHaveLength(1);
});

// A window gone while its question was being prepared (⌘W during the ps read, then ⌘Q) leaves no answer
// behind for the project's next window.
test('a decision that lands after its window is gone is dropped', async () => {
  let release: (v: ProjectBusy[]) => void = () => {};
  const guard = new CloseGuard<string>({ mode: () => 'ask', busy: () => new Promise((r) => { release = r; }), ask: async () => 'stop', stop: async () => {} });
  let reclosed = 0;
  expect(guard.onClose('/p', 'w', () => { reclosed += 1; })).toBe(false);
  guard.onClosed('/p');
  release([busyP('/p', 0)]);
  await tick();
  expect(reclosed).toBe(0);
  // The project's next window asks afresh (nothing decided).
  expect(guard.onClose('/p', 'w2', () => {})).toBe(false);
});

// ⌘Q twice before the first question is answered asks once.
test('a second quit while the first one asks waits for that same answer', async () => {
  const { guard, asked, answer } = setup({ busy: { '/p': 1 } });
  const a = guard.decideQuit(['/p'], null);
  const b = guard.decideQuit(['/p'], null);
  await tick();
  answer('keep');
  expect([await a, await b]).toEqual([true, true]);
  expect(asked).toHaveLength(1);
});
