import { describe, expect, test } from 'vitest';
import { callCulprit, changeTime, mayWrite, writingCallBetween } from './command-attribution';
import type { ToolCallWindow } from './tool-calls';

const call = (terminalId: string, start: number, end: number | null, over: Partial<ToolCallWindow> = {}): ToolCallWindow =>
  ({ id: `${terminalId}-${start}`, terminalId, sessionId: `s-${terminalId}`, agent: 'main', tool: 'Bash', command: 'python3 x.py', start, end, ...over });
const all = () => true;

describe('mayWrite', () => {
  test('a provably read-only Bash or Monitor command does not; any other call does', () => {
    expect(mayWrite(call('t1', 0, 1, { command: 'sed -n 1,5p a.ts' }))).toBe(false);
    expect(mayWrite(call('t1', 0, 1, { command: 'sed -i s/a/b/ a.ts' }))).toBe(true);
    expect(mayWrite(call('t1', 0, 1, { command: undefined }))).toBe(true);
    expect(mayWrite(call('t1', 0, 1, { tool: 'mcp__fs__write_file', command: undefined }))).toBe(true);
    expect(mayWrite(call('t1', 0, null, { tool: 'Monitor', command: 'tail -f log' }))).toBe(false);
    expect(mayWrite(call('t1', 0, null, { tool: 'Monitor', command: 'npm run dev > out.log' }))).toBe(true);
    expect(mayWrite(call('t1', 0, null, { tool: 'Monitor', command: undefined }))).toBe(true);
  });
});

describe('callCulprit', () => {
  test('the 2026-10-11 incident: the explorer\'s sed ended, the writer\'s call contains the mtime', () => {
    const calls = [
      call('brainstorm', 6_000, 6_500, { command: 'sed -n 1,40p src/main/update-net.ts' }),
      call('implementer', 9_800, 10_400, { agent: 'agent:a1', command: "python3 - <<'EOF'\n…\nEOF" })
    ];
    expect(callCulprit({ path: '/p/session-view.ts', mtime: 10_150 }, 5_000, 12_000, calls, all)).toEqual({ kind: 'one', call: calls[1] });
  });
  test('two writing calls containing the change: unclear, one call per terminal, sorted by terminal id', () => {
    const calls = [call('tB', 900, 1200), call('tA', 1000, null), call('tA', 950, 1100)];
    const k = callCulprit({ path: '/p/a', mtime: 1050 }, 0, 2000, calls, all);
    expect(k).toEqual({ kind: 'unclear', calls: [calls[1], calls[0]] });
  });
  test('read-only calls are never candidates', () => {
    const calls = [call('tA', 900, 1200, { command: 'grep -rn x src' }), call('tB', 1000, 1100)];
    expect(callCulprit({ path: '/p/a', mtime: 1050 }, 0, 2000, calls, all)).toEqual({ kind: 'one', call: calls[1] });
  });
  test('foreground calls beat background shells; a background shell alone is only a maybe, several are unclear', () => {
    const bg = call('tA', 0, null, { background: true, taskId: 'bg1', command: 'npm run dev' });
    const fg = call('tB', 1000, 1100);
    expect(callCulprit({ path: '/p/a', mtime: 1050 }, 0, 2000, [bg, fg], all)).toEqual({ kind: 'one', call: fg });
    expect(callCulprit({ path: '/p/a', mtime: 1500 }, 0, 2000, [bg, fg], all)).toEqual({ kind: 'maybe', call: bg });
    // Two shells of the same terminal: still that one terminal's maybe (its latest call).
    const bg2 = call('tA', 500, null, { background: true, taskId: 'bg2', command: 'npm run watch' });
    expect(callCulprit({ path: '/p/a', mtime: 1500 }, 0, 2000, [bg, bg2], all)).toEqual({ kind: 'maybe', call: bg2 });
    const other = call('tC', 200, null, { background: true, taskId: 'bg3', command: 'npm run watch' });
    expect(callCulprit({ path: '/p/a', mtime: 1500 }, 0, 2000, [bg, fg, other], all)).toEqual({ kind: 'unclear', calls: [bg, other] });
  });
  test('300 ms of slack around a window, not more', () => {
    const c = call('tA', 1000, 1100);
    expect(callCulprit({ path: '/p/a', mtime: 1390 }, 0, 2000, [c], all)?.kind).toBe('one');
    expect(callCulprit({ path: '/p/a', mtime: 1410 }, 0, 2000, [c], all)).toBeNull();
    expect(callCulprit({ path: '/p/a', mtime: 710 }, 0, 2000, [c], all)?.kind).toBe('one');
    expect(callCulprit({ path: '/p/a', mtime: 690 }, 0, 2000, [c], all)).toBeNull();
  });
  test('no mtime, or an mtime outside the interval (cp -p, mv): the last 10 s before the status', () => {
    const early = call('tA', 1000, 2000);
    const late = call('tB', 25_000, 26_000);
    expect(callCulprit({ path: '/p/a', mtime: null }, 0, 30_000, [early, late], all)).toEqual({ kind: 'one', call: late });
    expect(callCulprit({ path: '/p/a', mtime: -5_000_000 }, 0, 30_000, [early, late], all)).toEqual({ kind: 'one', call: late });
  });
  test('an mtime up to 1 s before the interval still counts as the change time (unknown snapshots)', () => {
    const early = call('tA', 4_400, 4_600);
    const late = call('tB', 8_000, 8_500);
    expect(callCulprit({ path: '/p/a', mtime: 4_500 }, 5_000, 9_000, [late], all)).toBeNull();
    expect(callCulprit({ path: '/p/a', mtime: 4_500 }, 5_000, 9_000, [early, late], all)).toEqual({ kind: 'one', call: early });
  });
  test('a writing call of a terminal nobody knows overlapping the change: no culprit, never a guess', () => {
    const calls = [call('tA', 1000, 1100), call('tGone', 1000, 1100)];
    expect(callCulprit({ path: '/p/a', mtime: 1050 }, 0, 2000, calls, (id) => id === 'tA', undefined, undefined, (id) => id === 'tA')).toBeNull();
    expect(callCulprit({ path: '/p/a', mtime: 1050 }, 0, 2000, [calls[0]!, call('tGone', 1000, 1100, { command: 'ls' })], (id) => id === 'tA', undefined, undefined, (id) => id === 'tA')).toEqual({ kind: 'one', call: calls[0] });
  });
  test('terminals of other projects do not count', () => {
    const calls = [call('tA', 1000, 1100), call('tX', 1000, 1100)];
    expect(callCulprit({ path: '/p/a', mtime: 1050 }, 0, 2000, calls, (id) => id !== 'tX')).toEqual({ kind: 'one', call: calls[0] });
  });
});

describe('writingCallBetween', () => {
  test('only writing, eligible calls overlapping the interval', () => {
    const calls = [call('tA', 100, 200, { command: 'cat a' }), call('tB', 5000, 6000)];
    expect(writingCallBetween(calls, 0, 1000, all)).toBe(false);
    expect(writingCallBetween(calls, 0, 5500, all)).toBe(true);
    expect(writingCallBetween(calls, 0, 5500, (id) => id !== 'tB')).toBe(false);
  });
});

describe('changeTime', () => {
  test('the mtime when it falls in the status interval (with the slack), else null', () => {
    expect(changeTime({ path: '/p/a', mtime: 1500 }, 1000, 2000)).toBe(1500);
    expect(changeTime({ path: '/p/a', mtime: 2200 }, 1000, 2000)).toBe(2200);
    expect(changeTime({ path: '/p/a', mtime: 3000 }, 1000, 2000)).toBeNull();
    expect(changeTime({ path: '/p/a', mtime: 10 }, 5000, 9000)).toBeNull();
    expect(changeTime({ path: '/p/a', mtime: null }, 1000, 2000)).toBeNull();
  });
});
