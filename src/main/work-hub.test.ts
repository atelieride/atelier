import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { TerminalInfo } from '@shared/protocol';
import type { BackgroundItem, SessionInfo } from '@shared/session';
import { WORK_CAP_MS, type ProcArgs, type WorkScan } from '@shared/background';
import type { ListeningProc } from './procs/exec';
import { MAX_WORK_TIMER_MS, WorkHub, WorkTimer, attachWork, type WorkDeps } from './work-hub';

const shell = (id: string, command: string, since = 0, kind: BackgroundItem['kind'] = 'shell'): BackgroundItem => ({ id, kind, label: command, command, since });
const session = (state: SessionInfo['state'], items: BackgroundItem[] | null): SessionInfo => ({
  sessionId: 's', state, title: null, activity: null, contextPct: null, unread: true, updatedAt: 0,
  ...(items ? { background: { items, crons: [] } } : {})
});
const term = (id: string, pid: number | undefined, items: BackgroundItem[] | null, state: SessionInfo['state'] = 'done'): TerminalInfo => ({
  id, projectRoot: '/p', cwd: '/p', title: id, name: null, color: '#fff', foreground: 'claude', createdAt: 0,
  session: session(state, items), ...(pid ? { pid } : {})
});
const tree = (pairs: [number, number][]) => {
  const m = new Map<number, number[]>();
  for (const [pid, ppid] of pairs) m.set(ppid, [...(m.get(ppid) ?? []), pid]);
  return m;
};
/** How Claude Code runs a background command (spec "What Claude Code tells us"). */
const zsh = (pid: number, command: string): ProcArgs => ({ pid, ppid: 0, args: `/bin/zsh -c source /tmp/snapshot.sh && eval '${command.replace(/'/g, "'\\''")}' < /dev/null && pwd -P >| /tmp/cwd` });

describe('WorkHub', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  // Terminal shell 100 → claude 110 → background shells 120 (npm run dev → node 121 listening on 5173) and 130 (sleep 90).
  const setup = (extra: Partial<WorkDeps> = {}) => {
    const state = {
      tree: tree([[110, 100], [120, 110], [121, 120], [130, 110], [131, 130]]),
      procs: [{ pid: 110, ppid: 0, args: 'claude' }, zsh(120, 'npm run dev'), { pid: 121, ppid: 0, args: 'node vite' }, zsh(130, 'sleep 90'), { pid: 131, ppid: 0, args: 'sleep 90' }] as ProcArgs[],
      listening: new Map<number, ListeningProc>([[121, { name: 'node', ports: [5173, 58000] }]]),
      fail: false,
      now: 1000
    };
    const calls = { tree: 0, args: [] as number[][], lsof: [] as number[][] };
    const deps: WorkDeps = {
      readTree: async () => { calls.tree++; if (state.fail) throw new Error('ps failed'); return state.tree; },
      readArgs: async (pids) => { calls.args.push([...pids]); return state.procs.filter((p) => pids.includes(p.pid)); },
      readListening: async (pids) => { calls.lsof.push([...pids]); return new Map([...state.listening].filter(([pid]) => pids.includes(pid))); },
      now: () => state.now,
      ...extra
    };
    const hub = new WorkHub(deps);
    const emitted: Record<string, WorkScan>[] = [];
    hub.onChange = (s) => emitted.push(s);
    return { hub, state, calls, emitted };
  };
  const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

  /** Scans every 3 s until `until` (ms of the fake clock), the clock following the timers. */
  const scanUntil = async (state: { now: number }, until: number) => {
    while (state.now < until) { state.now += 3000; await vi.advanceTimersByTimeAsync(3000); }
  };

  test('a dev-server shell (a descendant listens on 5173) is a server once its listener has been seen for 15 s; a shell without ports never is', async () => {
    const { hub, state, calls, emitted } = setup();
    hub.update([term('a', 100, [shell('dev', 'npm run dev'), shell('slp', 'sleep 90')])]);
    await flush();
    // The terminal's descendants (not its own shell), then lsof on the matched shells' trees only.
    expect(calls.args).toEqual([[110, 120, 130, 121, 131]]);
    expect(calls.lsof.map((l) => [...l].sort((x, y) => x - y))).toEqual([[120, 121, 130, 131]]);
    // Listening for 0 s: not a server yet (a test run opens ports too), it still counts.
    expect(emitted.at(-1)).toEqual({ a: { at: 1000, matched: { dev: 120, slp: 130 }, servers: [], gone: [] } });
    await scanUntil(state, 13_000);
    expect(hub.scans().a!.servers).toEqual([]);
    // Still a candidate under the threshold: no ports in the scan.
    expect(hub.scans().a).not.toHaveProperty('ports');
    await scanUntil(state, 16_000);
    // The server's listening ports (the ephemeral 58000 left out), for the inspector's port chips.
    expect(hub.scans().a).toEqual({ at: 16_000, matched: { dev: 120, slp: 130 }, servers: ['dev'], gone: [], ports: { dev: [5173] } });
    expect(hub.scans()).toEqual(emitted.at(-1));
    hub.dispose();
  });

  // The e2e see a server sooner (ATELIER_TEST_SERVER_LISTEN_MS); the app keeps 15 s.
  test('the server threshold can be shorter (a test timing)', async () => {
    const { hub, state } = setup({ serverListenMs: 3000 });
    hub.update([term('a', 100, [shell('dev', 'npm run dev')])]);
    await flush();
    expect(hub.scans().a!.servers).toEqual([]);
    await scanUntil(state, 4000);
    expect(hub.scans().a!.servers).toEqual(['dev']);
    hub.dispose();
  });

  test('a server stays one through a brief listen gap, and lsof skips its tree from then on; its process gone ends it', async () => {
    const { hub, state, calls } = setup();
    hub.update([term('a', 100, [shell('dev', 'npm run dev'), shell('slp', 'sleep 90')])]);
    await flush();
    await scanUntil(state, 16_000);
    expect(hub.scans().a!.servers).toEqual(['dev']);
    // The dev server restarts (no listener for a scan): still a server.
    state.listening = new Map();
    await scanUntil(state, 19_000);
    expect(hub.scans().a!.servers).toEqual(['dev']);
    // Its tree (120, 121) is no longer asked about.
    expect(calls.lsof.at(-1)!.sort((x, y) => x - y)).toEqual([130, 131]);
    // Its shell gone: no longer a server (gone instead); back with a new process, it starts over.
    state.tree = tree([[110, 100], [130, 110], [131, 130]]);
    await scanUntil(state, 22_000);
    expect(hub.scans().a).toMatchObject({ servers: [], gone: ['dev'] });
    state.tree = tree([[110, 100], [125, 110], [126, 125], [130, 110], [131, 130]]);
    state.procs = [...state.procs, zsh(125, 'npm run dev')];
    state.listening = new Map([[126, { name: 'node', ports: [5173] }]]);
    await scanUntil(state, 25_000);
    expect(hub.scans().a).toMatchObject({ matched: { dev: 125 }, servers: [] });
    hub.dispose();
  });

  test('a listener seen for less than 15 s with a gap never adds up to a server', async () => {
    const { hub, state } = setup();
    hub.update([term('a', 100, [shell('dev', 'npm run dev')])]);
    await flush();
    await scanUntil(state, 13_000);
    const was = state.listening;
    state.listening = new Map();
    await scanUntil(state, 16_000);
    state.listening = was;
    // Seen again from 19 s: 12 s + 12 s of listening in all, never 15 s in a row.
    await scanUntil(state, 31_000);
    expect(hub.scans().a!.servers).toEqual([]);
    await scanUntil(state, 34_000);
    expect(hub.scans().a!.servers).toEqual(['dev']);
    hub.dispose();
  });

  test('a test run listening on a non-ephemeral port for minutes is never a server (it keeps counting)', async () => {
    const { hub, state } = setup();
    state.tree = tree([[110, 100], [140, 110], [141, 140]]);
    state.procs = [zsh(140, 'npx playwright test'), { pid: 141, ppid: 0, args: 'node webserver' }];
    state.listening = new Map([[141, { name: 'node', ports: [3000] }]]);
    hub.update([term('a', 100, [shell('e2e', 'npx playwright test')])]);
    await flush();
    await scanUntil(state, 300_000);
    expect(hub.scans().a).toMatchObject({ matched: { e2e: 140 }, servers: [] });
    hub.dispose();
  });

  test('a process gone after a matched scan is in gone while the item stays; a never-matched item is neither', async () => {
    const { hub, state, emitted } = setup();
    const items = [shell('slp', 'sleep 90'), shell('never', 'npm test')];
    hub.update([term('a', 100, items)]);
    await flush();
    expect(emitted.at(-1)!.a).toMatchObject({ matched: { slp: 130 }, gone: [] });
    state.procs = state.procs.filter((p) => p.pid !== 130 && p.pid !== 131);
    state.tree = tree([[110, 100], [120, 110], [121, 120]]);
    state.now = 4000;
    await vi.advanceTimersByTimeAsync(3000);
    expect(emitted.at(-1)!.a).toEqual({ at: 4000, matched: {}, servers: [], gone: ['slp'] });
    // Still gone on the next scan, as long as atelierd lists it.
    await vi.advanceTimersByTimeAsync(3000);
    expect(hub.scans().a!.gone).toEqual(['slp']);
    // Gone from the session: forgotten (a new item with the same id later starts fresh).
    hub.update([term('a', 100, [shell('never', 'npm test')])]);
    await flush();
    expect(hub.scans().a!.gone).toEqual([]);
    hub.update([term('a', 100, [shell('never', 'npm test'), shell('slp', 'sleep 90')])]);
    await flush();
    expect(hub.scans().a!.gone).toEqual([]);
    hub.dispose();
  });

  test('identical commands swapping pids: an id still matched to any pid is not gone', async () => {
    const { hub, state } = setup();
    state.tree = tree([[110, 100], [140, 110], [150, 110]]);
    state.procs = [zsh(140, 'npm test'), zsh(150, 'npm test')];
    hub.update([term('a', 100, [shell('x', 'npm test', 1), shell('y', 'npm test', 2)])]);
    await flush();
    expect(hub.scans().a!.matched).toEqual({ x: 140, y: 150 });
    state.tree = tree([[110, 100], [150, 110]]);
    state.procs = [zsh(150, 'npm test')];
    await vi.advanceTimersByTimeAsync(3000);
    expect(hub.scans().a!.matched).toEqual({ x: 150 });
    expect(hub.scans().a!.gone).toEqual(['y']);
    hub.dispose();
  });

  test('a failure keeps the last scans', async () => {
    const { hub, state, emitted } = setup();
    hub.update([term('a', 100, [shell('slp', 'sleep 90')])]);
    await flush();
    const before = hub.scans();
    state.fail = true;
    await vi.advanceTimersByTimeAsync(9000);
    expect(hub.scans()).toEqual(before);
    expect(emitted.length).toBe(1);
    hub.dispose();
  });

  test('no shell or monitor items (or no pid): no ps or lsof at all; items gone → scanning stops and scans clear', async () => {
    const { hub, calls, emitted } = setup();
    hub.update([term('a', 100, null), term('b', 100, [{ id: 'ag', kind: 'agent', label: 'Explore', since: 0 }]), term('c', undefined, [shell('slp', 'sleep 90')])]);
    await flush();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(calls).toEqual({ tree: 0, args: [], lsof: [] });
    hub.update([term('a', 100, [shell('slp', 'sleep 90', 0, 'monitor')])]);
    await flush();
    expect(calls.tree).toBe(1);
    expect(hub.scans().a!.matched).toEqual({ slp: 130 });
    hub.update([term('a', 100, [])]);
    await flush();
    expect(emitted.at(-1)).toEqual({});
    await vi.advanceTimersByTimeAsync(30_000);
    expect(calls.tree).toBe(1);
    hub.dispose();
  });

  test('scans every 3 s with no window focus involved, at once when items change, only emitting on change', async () => {
    const { hub, calls, emitted, state } = setup();
    hub.update([term('a', 100, [shell('slp', 'sleep 90')])]);
    await flush();
    expect(calls.tree).toBe(1);
    // Same items again (a state change): no extra scan.
    hub.update([term('a', 100, [shell('slp', 'sleep 90')], 'running')]);
    await flush();
    expect(calls.tree).toBe(1);
    state.now = 9000;
    await vi.advanceTimersByTimeAsync(3000);
    expect(calls.tree).toBe(2);
    await vi.advanceTimersByTimeAsync(3000);
    expect(calls.tree).toBe(3);
    // Nothing changed but the time: nothing emitted.
    expect(emitted.length).toBe(1);
    hub.update([term('a', 100, [shell('slp', 'sleep 90'), shell('dev', 'npm run dev')])]);
    await flush();
    expect(calls.tree).toBe(4);
    expect(emitted.length).toBe(2);
    expect(emitted.at(-1)!.a).toMatchObject({ at: 9000, matched: { slp: 130, dev: 120 } });
    hub.dispose();
  });

  test('more than 512 descendants: ps gets the first 512', async () => {
    const { hub, state, calls } = setup();
    state.tree = tree(Array.from({ length: 600 }, (_, i): [number, number] => [1000 + i, 100]));
    hub.update([term('a', 100, [shell('slp', 'sleep 90')])]);
    await flush();
    expect(calls.args[0]!.length).toBe(512);
    hub.dispose();
  });

  test('a terminal whose descendants were cut at 512 reports nothing gone in that scan (a matched shell past the cap)', async () => {
    const { hub, state, calls } = setup();
    hub.update([term('a', 100, [shell('slp', 'sleep 90')])]);
    await flush();
    expect(hub.scans().a!.matched).toEqual({ slp: 130 });
    // 600 other children of claude come before the shell: it falls past the cap.
    const filler = Array.from({ length: 600 }, (_, i): [number, number] => [1000 + i, 110]);
    state.tree = tree([[110, 100], ...filler, [130, 110], [131, 130]]);
    await vi.advanceTimersByTimeAsync(3000);
    expect(calls.args.at(-1)!.length).toBe(512);
    expect(calls.args.at(-1)).not.toContain(130);
    expect(hub.scans().a!.gone).toEqual([]);
    // Back under the cap and the process really gone: gone (what it matched before is still remembered).
    state.tree = tree([[110, 100]]);
    await vi.advanceTimersByTimeAsync(3000);
    expect(hub.scans().a!.gone).toEqual(['slp']);
    hub.dispose();
  });

  test('a terminal cut at 512 keeps the shells it had found gone (counting never flickers back)', async () => {
    const { hub, state } = setup();
    hub.update([term('a', 100, [shell('slp', 'sleep 90'), shell('dev', 'npm run dev')])]);
    await flush();
    state.tree = tree([[110, 100], [120, 110], [121, 120]]);
    await vi.advanceTimersByTimeAsync(3000);
    expect(hub.scans().a!.gone).toEqual(['slp']);
    // Then the tree grows past the cap: what was gone stays gone (and only what is still listed).
    const filler = Array.from({ length: 600 }, (_, i): [number, number] => [1000 + i, 110]);
    state.tree = tree([[110, 100], ...filler, [120, 110], [121, 120]]);
    await vi.advanceTimersByTimeAsync(3000);
    expect(hub.scans().a!.gone).toEqual(['slp']);
    hub.update([term('a', 100, [shell('dev', 'npm run dev')])]);
    await flush();
    expect(hub.scans().a!.gone).toEqual([]);
    hub.dispose();
  });

  test('a terminal cut at 512 keeps the servers it had found servers (a still-listed sticky server never counts again)', async () => {
    const { hub, state } = setup();
    hub.update([term('a', 100, [shell('dev', 'npm run dev'), shell('slp', 'sleep 90')])]);
    await flush();
    await scanUntil(state, 16_000);
    expect(hub.scans().a!.servers).toEqual(['dev']);
    // 600 other children of claude come before the shells: both fall past the cap and are unread.
    const filler = Array.from({ length: 600 }, (_, i): [number, number] => [1000 + i, 110]);
    state.tree = tree([[110, 100], ...filler, [120, 110], [121, 120], [130, 110], [131, 130]]);
    await scanUntil(state, 19_000);
    expect(hub.scans().a).toMatchObject({ matched: {}, servers: ['dev'], gone: [] });
    // Back under the cap: the same process, still a server.
    state.tree = tree([[110, 100], [120, 110], [121, 120], [130, 110], [131, 130]]);
    await scanUntil(state, 22_000);
    expect(hub.scans().a).toMatchObject({ matched: { dev: 120, slp: 130 }, servers: ['dev'] });
    // Cut again, then the item leaves the session: no longer reported.
    state.tree = tree([[110, 100], ...filler, [120, 110], [121, 120], [130, 110], [131, 130]]);
    await scanUntil(state, 25_000);
    expect(hub.scans().a!.servers).toEqual(['dev']);
    hub.update([term('a', 100, [shell('slp', 'sleep 90')])]);
    await flush();
    expect(hub.scans().a!.servers).toEqual([]);
    hub.dispose();
  });

  test('only servers, capped or gone items left: scans every 15 s instead of 3 s; an item change still scans at once', async () => {
    const { hub, state, calls } = setup();
    hub.update([term('a', 100, [shell('dev', 'npm run dev')])]);
    await flush();
    // A listener younger than 15 s: the item counts, the scan goes on every 3 s.
    await scanUntil(state, 16_000);
    expect(calls.tree).toBe(6);
    expect(hub.scans().a!.servers).toEqual(['dev']);
    // Only a server left: nothing counted depends on the scan.
    const before = calls.tree;
    await scanUntil(state, 28_000);
    expect(calls.tree).toBe(before);
    await scanUntil(state, 31_000);
    expect(calls.tree).toBe(before + 1);
    // A new item: at once, then every 3 s again.
    hub.update([term('a', 100, [shell('dev', 'npm run dev'), shell('slp', 'sleep 90')])]);
    await flush();
    expect(calls.tree).toBe(before + 2);
    await scanUntil(state, 34_000);
    expect(calls.tree).toBe(before + 3);
    hub.dispose();
  });

  test('items past the 30-minute cap no longer need the 3 s scan', async () => {
    const { hub, state, calls } = setup();
    state.now = WORK_CAP_MS + 10_000;
    hub.update([term('a', 100, [shell('slp', 'sleep 90', 0)])]);
    await flush();
    expect(calls.tree).toBe(1);
    await scanUntil(state, state.now + 12_000);
    expect(calls.tree).toBe(1);
    await scanUntil(state, state.now + 3000);
    expect(calls.tree).toBe(2);
    hub.dispose();
  });

  test('the 512 slots are shared fairly: a terminal with a huge tree never starves another one', async () => {
    const { hub, state, calls } = setup();
    const big = Array.from({ length: 700 }, (_, i): [number, number] => [1000 + i, 210]);
    state.tree = tree([[210, 200], ...big, [110, 100], [120, 110], [121, 120], [130, 110], [131, 130]]);
    hub.update([term('big', 200, [shell('x', 'npm test')]), term('a', 100, [shell('dev', 'npm run dev'), shell('slp', 'sleep 90')])]);
    await flush();
    expect(calls.args[0]!.length).toBe(512);
    expect(calls.args[0]).toEqual(expect.arrayContaining([110, 120, 130, 121, 131]));
    expect(hub.scans().a).toMatchObject({ matched: { dev: 120, slp: 130 }, gone: [] });
    hub.dispose();
  });
});

describe('WorkTimer', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  test('a far-future change (a cron 300 days ahead) waits at most 24 h, and firing re-arms instead of looping', async () => {
    const DAY = 24 * 60 * 60 * 1000;
    const target = Date.now() + 300 * DAY;
    let fired = 0;
    const timer = new WorkTimer(() => { fired++; timer.arm(target, Date.now()); });
    timer.arm(target, Date.now());
    expect(MAX_WORK_TIMER_MS).toBe(DAY);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(fired).toBe(0);
    await vi.advanceTimersByTimeAsync(DAY - 1000);
    expect(fired).toBe(1);
    // Re-armed for another day: no tight loop.
    await vi.advanceTimersByTimeAsync(1000);
    expect(fired).toBe(1);
    expect(vi.getTimerCount()).toBe(1);
    timer.clear();
    expect(vi.getTimerCount()).toBe(0);
  });

  test('a near change fires at its time; arming again replaces the timer; null arms nothing', async () => {
    let fired = 0;
    const timer = new WorkTimer(() => { fired++; });
    timer.arm(Date.now() + 5000, Date.now());
    timer.arm(Date.now() + 2000, Date.now());
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(2000);
    expect(fired).toBe(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fired).toBe(1);
    timer.arm(Date.now() - 50, Date.now());
    await vi.advanceTimersByTimeAsync(0);
    expect(fired).toBe(2);
    timer.arm(null, Date.now());
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('attachWork', () => {
  test('work only on terminals whose session has a background field; the earliest cap expiry for the timer', () => {
    const list = [term('a', 100, [shell('slp', 'sleep 90', 500)]), term('b', 200, null), { ...term('c', 300, null), session: null }, term('d', 400, [shell('t', 'npm test', 100)])];
    const { list: out, nextChange } = attachWork(list, {}, 1000, true);
    expect(out[0]!.work).toMatchObject({ counting: true, shells: 1 });
    expect('work' in out[1]!).toBe(false);
    expect('work' in out[2]!).toBe(false);
    expect(nextChange).toBe(100 + WORK_CAP_MS + 1);
    // The setting off: listed, not counting.
    expect(attachWork(list, {}, 1000, false).list[0]!.work).toMatchObject({ counting: false, shells: 1 });
    // A scan that proves a server: not work.
    const scan: WorkScan = { at: 2000, matched: { slp: 130 }, servers: ['slp'], gone: [] };
    expect(attachWork(list, { a: scan }, 2500, true).list[0]!.work).toMatchObject({ counting: false, shells: 0 });
    expect(attachWork([term('b', 200, null)], {}, 0, true).nextChange).toBeNull();
  });

  test('the raw commands never leave main: the items sent on carry no command (the work is computed with them first)', () => {
    const list = [term('a', 100, [shell('slp', 'sleep 90', 500), { id: 'ag', kind: 'agent', label: 'Explore', since: 0 }])];
    const out = attachWork(list, {}, 1000, true).list[0]!;
    expect(out.session!.background!.items).toEqual([{ id: 'slp', kind: 'shell', label: 'sleep 90', since: 500 }, { id: 'ag', kind: 'agent', label: 'Explore', since: 0 }]);
    expect(out.work).toMatchObject({ shells: 1, agents: 1 });
    // The input list is left as it was (WorkHub matches on it).
    expect(list[0]!.session!.background!.items[0]!.command).toBe('sleep 90');
  });
});
