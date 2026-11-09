import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }));
import type { TerminalInfo } from '@shared/protocol';
import type { ListeningProc } from './procs/exec';
import { PortsHub, terminalPorts, type PortsDeps, type PortsWindow } from './ports-hub';

const term = (id: string, pid: number | undefined, projectRoot = '/p'): TerminalInfo => ({
  id, projectRoot, cwd: projectRoot, title: id, name: null, color: '#fff', foreground: 'zsh', createdAt: 0, session: null, ...(pid ? { pid } : {})
});
const tree = (pairs: [number, number][]) => {
  const m = new Map<number, number[]>();
  for (const [pid, ppid] of pairs) m.set(ppid, [...(m.get(ppid) ?? []), pid]);
  return m;
};
const listening = (o: Record<number, ListeningProc>) => new Map(Object.entries(o).map(([k, v]) => [Number(k), v]));

describe('terminalPorts', () => {
  test('each terminal gets the ports of its shell and every descendant, sorted, once, named by their process', () => {
    const t = tree([[110, 100], [120, 110], [210, 200]]);
    const l = listening({ 100: { ports: [9000] }, 110: { name: 'node', ports: [5173, 3000] }, 120: { name: 'esbuild', ports: [3000, 24678] }, 210: { name: 'python3', ports: [8000] }, 999: { name: 'other', ports: [1234] } });
    expect(terminalPorts([term('a', 100), term('b', 200), term('c', 300)], t, l)).toEqual({
      a: [{ port: 3000, name: 'node' }, { port: 5173, name: 'node' }, { port: 9000 }, { port: 24678, name: 'esbuild' }],
      b: [{ port: 8000, name: 'python3' }]
    });
  });

  test('terminals without pid (an older atelierd) get nothing; at most 8 ports each', () => {
    const l = listening({ 100: { name: 'node', ports: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] } });
    const r = terminalPorts([term('a', 100), term('old', undefined)], tree([]), l);
    expect(r.a!.map((p) => p.port)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(r.old).toBeUndefined();
  });
});

describe('PortsHub', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const setup = (o: Partial<PortsDeps> = {}) => {
    const state = { enabled: true, focused: true, tree: tree([[110, 100]]), listening: listening({ 110: { name: 'node', ports: [3000] } }) as Map<number, ListeningProc>, fail: false, ephemeral: false };
    const calls = { tree: 0, lsof: [] as number[][] };
    const deps: PortsDeps = {
      readTree: async () => { calls.tree += 1; if (state.fail) throw new Error('ps failed'); return state.tree; },
      readListening: async (pids) => { calls.lsof.push([...pids]); if (state.fail) throw new Error('lsof failed'); return state.listening; },
      enabled: () => state.enabled,
      focused: () => state.focused,
      showEphemeral: () => state.ephemeral,
      ...o
    };
    const hub = new PortsHub(deps);
    const win = (id: number, project: string) => {
      const sent: unknown[] = [];
      const w: PortsWindow = { id, send: (_c, payload) => { sent.push(payload); }, isDestroyed: () => false, once: () => {} };
      hub.open(project, w);
      return sent;
    };
    return { hub, state, calls, win };
  };
  const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };

  // The e2e scan faster (ATELIER_TEST_PORTS_POLL_MS); the app keeps 4 s.
  test('the poll pace can be shorter (a test timing)', async () => {
    const { hub, calls } = setup({ pollMs: 500 });
    hub.setTerminals([term('a', 100, '/p')]);
    await flush();
    const first = calls.tree;
    await vi.advanceTimersByTimeAsync(1000);
    expect(calls.tree).toBe(first + 2);
    hub.dispose();
  });

  test('lsof every 4 s for 30 s after the processes change (a server that binds late still shows within 4 s), then every 30 s; ps keeps its 4 s', async () => {
    const { hub, calls, state } = setup();
    hub.setTerminals([term('a', 100, '/p')]);
    await flush();
    expect(calls.lsof).toHaveLength(1);
    // The 30 s window: ticks at 4 … 28 s.
    await vi.advanceTimersByTimeAsync(28000);
    expect(calls.lsof).toHaveLength(8);
    // Then resting: ps every 4 s, lsof again 30 s after the last one (28 s → the 60 s tick).
    await vi.advanceTimersByTimeAsync(28000);
    expect(calls.tree).toBe(15);
    expect(calls.lsof).toHaveLength(8);
    await vi.advanceTimersByTimeAsync(4000);
    expect(calls.lsof).toHaveLength(9);
    // A new process under the shell: lsof at once.
    state.tree = tree([[110, 100], [120, 110]]);
    await vi.advanceTimersByTimeAsync(4000);
    expect(calls.lsof).toHaveLength(10);
    // Focus asks for a full scan.
    hub.refresh();
    await flush();
    expect(calls.lsof).toHaveLength(11);
    hub.dispose();
  });

  test('a failed lsof is retried on the next tick, even while resting', async () => {
    const st = { fail: false, lsof: 0 };
    const { hub } = setup({
      readListening: async () => { st.lsof += 1; if (st.fail) throw new Error('lsof timed out'); return listening({ 110: { name: 'node', ports: [3000] } }); }
    });
    hub.setTerminals([term('a', 100, '/p')]);
    // Past the 30 s window and one resting lsof (at 60 s).
    await vi.advanceTimersByTimeAsync(60000);
    const before = st.lsof;
    // The next resting lsof fails: it is tried again 4 s later, not 30 s later.
    st.fail = true;
    // Ticks fall every 4 s: the first one 30 s after the last lsof (60 s) is at 92 s.
    await vi.advanceTimersByTimeAsync(32000);
    expect(st.lsof).toBe(before + 1);
    st.fail = false;
    await vi.advanceTimersByTimeAsync(4000);
    expect(st.lsof).toBe(before + 2);
    hub.dispose();
  });

  test('turning the setting back on reads the ports at once, even with the same processes', async () => {
    const { hub, calls, state, win } = setup();
    const p = win(1, '/p');
    hub.setTerminals([term('a', 100, '/p')]);
    await vi.advanceTimersByTimeAsync(4000 * 4);
    state.enabled = false;
    hub.settingsChanged();
    state.enabled = true;
    const before = calls.lsof.length;
    hub.settingsChanged();
    await flush();
    expect(calls.lsof.length).toBe(before + 1);
    expect(p.at(-1)).toEqual({ a: [{ port: 3000, name: 'node' }] });
    hub.dispose();
  });

  test('a terminal list change scans at once; each window gets only its project, only when it changes', async () => {
    const { hub, win, calls } = setup();
    const p = win(1, '/p');
    const q = win(2, '/q');
    hub.setTerminals([term('a', 100, '/p'), term('b', 200, '/q')]);
    await flush();
    expect(calls.tree).toBe(1);
    // Shells first, then their descendants.
    expect(calls.lsof).toEqual([[100, 200, 110]]);
    expect(p.at(-1)).toEqual({ a: [{ port: 3000, name: 'node' }] });
    expect(q).toEqual([]);
    expect(hub.portsOf('/p')).toEqual({ a: [{ port: 3000, name: 'node' }] });
    expect(hub.portsOf('/q')).toEqual({});
    // Same result on the next tick: nothing sent again.
    const before = p.length;
    await vi.advanceTimersByTimeAsync(4000);
    expect(calls.tree).toBe(2);
    expect(p.length).toBe(before);
    hub.dispose();
  });

  test('polls every 4 s only while a window is focused and the setting is on', async () => {
    const { hub, state, calls } = setup();
    hub.setTerminals([term('a', 100)]);
    await flush();
    expect(calls.tree).toBe(1);
    state.focused = false;
    await vi.advanceTimersByTimeAsync(12000);
    expect(calls.tree).toBe(1);
    state.focused = true;
    hub.refresh();
    await flush();
    expect(calls.tree).toBe(2);
    await vi.advanceTimersByTimeAsync(4000);
    expect(calls.tree).toBe(3);
    state.enabled = false;
    await vi.advanceTimersByTimeAsync(12000);
    hub.refresh();
    hub.setTerminals([term('a', 100), term('b', 200)]);
    await flush();
    expect(calls.tree).toBe(3);
    hub.dispose();
  });

  test('turning the setting off clears the chips at once; on again scans', async () => {
    const { hub, state, win, calls } = setup();
    const p = win(1, '/p');
    hub.setTerminals([term('a', 100)]);
    await flush();
    expect(p.at(-1)).toEqual({ a: [{ port: 3000, name: 'node' }] });
    state.enabled = false;
    hub.settingsChanged();
    expect(p.at(-1)).toEqual({});
    state.enabled = true;
    hub.settingsChanged();
    await flush();
    expect(calls.tree).toBe(2);
    expect(p.at(-1)).toEqual({ a: [{ port: 3000, name: 'node' }] });
    hub.dispose();
  });

  test('a failure keeps the last result; a closed terminal loses its ports without waiting for a scan', async () => {
    const { hub, state, win } = setup();
    const p = win(1, '/p');
    hub.setTerminals([term('a', 100)]);
    await flush();
    state.fail = true;
    await vi.advanceTimersByTimeAsync(4000);
    expect(hub.portsOf('/p')).toEqual({ a: [{ port: 3000, name: 'node' }] });
    state.focused = false;
    hub.setTerminals([]);
    await flush();
    expect(p.at(-1)).toEqual({});
    hub.dispose();
  });

  test('a port that stops listening disappears on the next tick', async () => {
    const { hub, state, win } = setup();
    const p = win(1, '/p');
    hub.setTerminals([term('a', 100)]);
    await flush();
    state.listening = new Map();
    await vi.advanceTimersByTimeAsync(4000);
    expect(p.at(-1)).toEqual({});
    hub.dispose();
  });

  test('without any terminal pid, ps and lsof never run', async () => {
    const { hub, calls } = setup();
    hub.setTerminals([term('old', undefined)]);
    await flush();
    await vi.advanceTimersByTimeAsync(8000);
    expect(calls.tree).toBe(0);
    expect(calls.lsof).toEqual([]);
    hub.dispose();
  });

  test('the same terminals again (a state change) do not trigger an extra scan; scans never overlap', async () => {
    let release: () => void = () => {};
    const { hub, calls, state } = setup({});
    hub.setTerminals([term('a', 100)]);
    await flush();
    expect(calls.tree).toBe(1);
    hub.setTerminals([{ ...term('a', 100), title: 'renamed' }]);
    await flush();
    expect(calls.tree).toBe(1);
    // A slow scan: refreshes meanwhile collapse into one follow-up scan.
    const slow = new PortsHub({
      readTree: () => new Promise((r) => { calls.tree += 1; release = () => r(state.tree); }),
      readListening: async () => state.listening, enabled: () => true, focused: () => true
    });
    calls.tree = 0;
    slow.setTerminals([term('a', 100)]);
    slow.refresh();
    slow.refresh();
    await flush();
    expect(calls.tree).toBe(1);
    release();
    await flush();
    expect(calls.tree).toBe(2);
    release();
    await flush();
    expect(calls.tree).toBe(2);
    slow.dispose();
    hub.dispose();
  });

  test('more than 512 processes: lsof gets the first 512 (shells first)', async () => {
    const big: [number, number][] = Array.from({ length: 600 }, (_, i) => [1000 + i, 100]);
    const { hub, state, calls } = setup();
    state.tree = tree(big);
    hub.setTerminals([term('a', 100)]);
    await flush();
    expect(calls.lsof[0]!.length).toBe(512);
    expect(calls.lsof[0]![0]).toBe(100);
    hub.dispose();
  });

  test('ephemeral ports (49152+) are hidden by default, shown with the setting, and the change is sent at once', async () => {
    const { hub, state, win } = setup();
    state.listening = listening({ 110: { name: 'node', ports: [3000, 49152, 64570] }, 100: { ports: [49151] } });
    const p = win(1, '/p');
    hub.setTerminals([term('a', 100)]);
    await flush();
    expect(p.at(-1)).toEqual({ a: [{ port: 3000, name: 'node' }, { port: 49151 }] });
    expect(hub.openTarget('/p', 'a', 64570)).toBeNull();
    state.ephemeral = true;
    hub.settingsChanged();
    expect(p.at(-1)).toEqual({ a: [{ port: 3000, name: 'node' }, { port: 49151 }, { port: 49152, name: 'node' }, { port: 64570, name: 'node' }] });
    expect(hub.openTarget('/p', 'a', 64570)).toBe('http://localhost:64570/');
    state.ephemeral = false;
    hub.settingsChanged();
    expect(p.at(-1)).toEqual({ a: [{ port: 3000, name: 'node' }, { port: 49151 }] });
    // A terminal with ephemeral ports only has no chips at all.
    state.listening = listening({ 110: { name: 'node', ports: [58358] } });
    await vi.advanceTimersByTimeAsync(4000);
    expect(p.at(-1)).toEqual({});
    expect(hub.portsOf('/p')).toEqual({});
    hub.dispose();
  });

  test('openable: only a port listed now for a terminal of that project', async () => {
    const { hub } = setup();
    hub.setTerminals([term('a', 100, '/p'), term('b', 200, '/q')]);
    await flush();
    expect(hub.openTarget('/p', 'a', 3000)).toBe('http://localhost:3000/');
    expect(hub.openTarget('/p', 'a', 3001)).toBeNull();
    expect(hub.openTarget('/q', 'a', 3000)).toBeNull();
    expect(hub.openTarget('/p', 'zz', 3000)).toBeNull();
    hub.dispose();
  });
});
