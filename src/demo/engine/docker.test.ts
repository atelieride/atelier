import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { DockerLogLine } from '@shared/docker-logs';
import { compileWorld } from '../compile/index';
import { createDemo } from '../bridge/index';
import { createClock } from './clock';
import { CRASH_AFTER_MS, LOG_RING, STATS_MS } from './docker';

// Docker's live part in the demo: log lines generated only while a view
// watches (a bounded ring, seq numbers as main's), stats as a random walk while watched, and the worker's crash.

const compiled = compileWorld();
let now = compiled.t0;
const make = () => {
  const clock = createClock();
  const d = createDemo(compiled, { version: '0.0.0-test', now: () => now, clock });
  return { ...d, clock };
};
const idOf = (name: string) => compiled.docker.snapshot.containers.find((c) => c.name === name && c.project === 'acme-store')!.id;
/** Moves the demo's clock and the timers together. */
const advance = async (ms: number) => { for (let t = 0; t < ms; t += 100) { now += 100; await vi.advanceTimersByTimeAsync(100); } };

beforeEach(() => { vi.useFakeTimers(); now = compiled.t0; });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('logs', () => {
  test("a container's lines so far, rebased, seq from 1; nothing is generated while nobody watches", async () => {
    const { api, events } = make();
    const pushed = vi.fn();
    events.on.dockerLogs(pushed);
    const { lines, ended } = await api.docker.logs(idOf('api'));
    expect(ended).toBe(false);
    expect(lines.map((l) => l.seq)).toEqual(lines.map((_, i) => i + 1));
    expect(lines.at(-1)!.at).toBeLessThan(now);
    await advance(10_000);
    expect(pushed).not.toHaveBeenCalled();
  });

  test('watched: the gap is filled up to now, then about a line a second, in seq order; unwatched: it stops', async () => {
    const { api, events } = make();
    const got: DockerLogLine[] = [];
    let pushes = 0;
    events.on.dockerLogs((e) => { if (e.id === idOf('api')) { pushes++; got.push(...e.lines); } });
    await advance(30_000);
    const before = (await api.docker.logs(idOf('api'))).lines.length;
    api.docker.watchLogs([idOf('api')]);
    const after = (await api.docker.logs(idOf('api'))).lines;
    expect(after.length).toBeGreaterThan(before + 10);
    expect(after.at(-1)!.at).toBeLessThanOrEqual(now);
    await advance(10_000);
    // The pace is per write (a gap of 0.6–1.5 s), not per line: one write can be the checkout's five-line stack trace
    // (1.5% of them; counting lines failed the nightly run of 2026-10-23 with 18).
    expect(pushes).toBeGreaterThanOrEqual(6);
    expect(pushes).toBeLessThanOrEqual(16);
    expect(got.length).toBeGreaterThanOrEqual(pushes);
    const seqs = got.map((l) => l.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(seqs[0]).toBe(after.at(-1)!.seq + 1);
    expect(got.some((l) => /^(GET|POST|PATCH|DELETE|PUT) \/\S* \d{3} /.test(l.text))).toBe(true);
    api.docker.watchLogs([]);
    const n = got.length;
    await advance(10_000);
    expect(got.length).toBe(n);
  });

  test(`the ring keeps the last ${LOG_RING} lines`, async () => {
    const { api } = make();
    api.docker.watchLogs([idOf('api')]);
    await advance(400_000);
    const { lines } = await api.docker.logs(idOf('api'));
    expect(lines).toHaveLength(LOG_RING);
    expect(lines.at(-1)!.seq).toBeGreaterThan(LOG_RING);
  });

  test('tail: the last n lines, numbered from 1 as main reads them once', async () => {
    const { api } = make();
    const all = (await api.docker.logs(idOf('api'))).lines;
    const t = await api.docker.tail(idOf('api'), 5);
    expect(t.map((l) => l.text)).toEqual(all.slice(-5).map((l) => l.text));
    expect(t.map((l) => l.seq)).toEqual([1, 2, 3, 4, 5]);
  });
});

describe('stats', () => {
  test('watched running containers get a sample every tick (a backfilled history first); stopped ones none', async () => {
    const { api, events } = make();
    const got = vi.fn();
    events.on.dockerStats(got);
    const billing = compiled.docker.snapshot.containers.find((c) => c.state === 'exited')!.id;
    api.docker.watchStats([idOf('api'), billing]);
    const first = await api.docker.stats([idOf('api'), billing]);
    expect(Object.keys(first)).toEqual([idOf('api')]);
    expect(first[idOf('api')]!.length).toBeGreaterThan(10);
    await advance(STATS_MS * 3);
    expect(got.mock.calls.filter(([e]) => e.id === idOf('api'))).toHaveLength(3);
    const s = got.mock.calls.at(-1)![0].sample;
    expect(s).toMatchObject({ at: now, memLimit: compiled.docker.snapshot.engine.state === 'running' ? compiled.docker.snapshot.engine.memory : 0 });
    expect(s.cpu).toBeGreaterThanOrEqual(0);
    expect(s.mem).toBeGreaterThan(0);
    api.docker.watchStats([]);
    got.mockClear();
    await advance(STATS_MS * 3);
    expect(got).not.toHaveBeenCalled();
  });
});

describe('the worker crash', () => {
  test(`${CRASH_AFTER_MS / 1000} s in: it crash-loops (events), ends exited 1 with its stack in the last lines, one note`, async () => {
    const { api, events } = make();
    const snaps = vi.fn(), evs = vi.fn(), notes = vi.fn();
    events.on.docker(snaps);
    events.on.dockerEvent(evs);
    events.on.dockerNote(notes);
    const id = idOf('worker');
    expect((await api.docker.snapshot()).containers.find((c) => c.id === id)!.state).toBe('running');
    await advance(CRASH_AFTER_MS + 9000);
    const worker = (await api.docker.snapshot()).containers.find((c) => c.id === id)!;
    expect(worker).toMatchObject({ state: 'exited', exitCode: 1, restarts: 3 });
    expect(worker.finishedAt).toBeGreaterThan(compiled.t0 + CRASH_AFTER_MS);
    expect(snaps.mock.calls.at(-1)![0].containers.find((c: { id: string }) => c.id === id).state).toBe('exited');
    expect(evs.mock.calls.map(([e]) => e.action)).toEqual(['die', 'restart', 'start', 'die', 'restart', 'start', 'die', 'restart', 'start', 'die']);
    expect((await api.docker.events())[0]).toMatchObject({ action: 'die', detail: 'exit 1', id });
    expect(notes).toHaveBeenCalledTimes(1);
    expect(notes.mock.calls[0]![0]).toMatchObject({ container: { id, name: 'worker', project: 'acme-store' }, reason: 'crash', exitCode: 1, line: 'Error: connect ECONNREFUSED 127.0.0.1:6379' });
    const { lines, ended } = await api.docker.logs(id);
    expect(ended).toBe(true);
    expect(lines.at(-1)!.text).toBe('info: exiting with code 1 · restart limit reached');
    expect(lines.some((l) => l.err && l.text.includes('TCPConnectWrap'))).toBe(true);
    expect(await api.docker.inspect(id)).toMatchObject({ container: { state: 'exited' }, detail: { env: expect.arrayContaining([{ key: 'REDIS_URL', value: 'redis://127.0.0.1:6379' }]) } });
    await advance(60_000);
    expect(notes).toHaveBeenCalledTimes(1);
  });

  test('while it crash-loops and after, the worker writes only its crash lines (no healthy job lines in between)', async () => {
    // Its healthy lines every 8.5 s: one would land 5.5 s into the crash, between the last restart and the last die.
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const { api, events } = make();
    const id = idOf('worker');
    const got: DockerLogLine[] = [];
    events.on.dockerLogs((e) => { if (e.id === id) got.push(...e.lines); });
    api.docker.watchLogs([id]);
    await advance(CRASH_AFTER_MS);
    got.length = 0;
    await advance(30_000);
    expect(got.map((l) => l.text)).toEqual(compiled.docker.crash.lines.map((l) => l.text));
  });

  test('a page in the background holds the crash back (the clock is paused)', async () => {
    const { api, clock } = make();
    clock.pause();
    await advance(CRASH_AFTER_MS + 9000);
    expect((await api.docker.snapshot()).containers.find((c) => c.id === idOf('worker'))!.state).toBe('running');
  });

  test('"Things to try" can bring it forward (beats.crashWorker): it plays once, now, and never again at 20 s', async () => {
    const { api, events, beats } = make();
    const evs = vi.fn(), notes = vi.fn();
    events.on.dockerEvent(evs);
    events.on.dockerNote(notes);
    const id = idOf('worker');
    await advance(2000);
    beats.crashWorker();
    beats.crashWorker();
    await advance(9000);
    expect((await api.docker.snapshot()).containers.find((c) => c.id === id)).toMatchObject({ state: 'exited', exitCode: 1, restarts: 3 });
    expect(evs.mock.calls.map(([e]) => e.action)).toEqual(['die', 'restart', 'start', 'die', 'restart', 'start', 'die', 'restart', 'start', 'die']);
    expect(notes).toHaveBeenCalledTimes(1);
    // Past the time it would have crashed by itself: nothing plays twice.
    await advance(CRASH_AFTER_MS + 9000);
    expect(evs).toHaveBeenCalledTimes(10);
    expect(notes).toHaveBeenCalledTimes(1);
    // Once it is playing (or played), bringing it forward does nothing.
    beats.crashWorker();
    await advance(9000);
    expect(evs).toHaveBeenCalledTimes(10);
  });

  test('notifications off in Settings: the crash still happens, no note', async () => {
    const { api, events } = make();
    await api.settings.set({ dockerNotify: false });
    const notes = vi.fn();
    events.on.dockerNote(notes);
    await advance(CRASH_AFTER_MS + 9000);
    expect(notes).not.toHaveBeenCalled();
  });
});

test('df and the overview events come from the compiled world', async () => {
  const { api } = make();
  expect(await api.docker.df()).toEqual(compiled.docker.df);
  const evs = await api.docker.events();
  expect(evs.length).toBe(compiled.docker.events.length);
  expect(evs[0]!.at).toBeLessThan(now);
});
