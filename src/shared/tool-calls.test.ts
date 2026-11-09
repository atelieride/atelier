import { describe, expect, test } from 'vitest';
import type { SessionInfo } from './session';
import {
  CALL_CAP_MS, CALL_KEEP_MS, MAX_CALLS, applyToolCallHook, changedCalls, fitCalls, pruneToolCalls, syncToolCalls, upsertCalls, waitingForAnswer,
  type ToolCallWindow
} from './tool-calls';

const pre = (tool: string, id: string | null, input: object = {}, extra: object = {}) =>
  ({ hook_event_name: 'PreToolUse', session_id: 's1', tool_name: tool, ...(id ? { tool_use_id: id } : {}), tool_input: input, ...extra });
const post = (tool: string, id: string | null, response: object = {}, extra: object = {}, event = 'PostToolUse') =>
  ({ hook_event_name: event, session_id: 's1', tool_name: tool, ...(id ? { tool_use_id: id } : {}), tool_input: {}, tool_response: response, ...extra });
const ev = (name: string, extra: object = {}) => ({ hook_event_name: name, session_id: 's1', ...extra });
const session = (over: Partial<SessionInfo> = {}): SessionInfo => ({
  sessionId: 's1', state: 'running', title: null, activity: null, contextPct: null, unread: false, updatedAt: 0, ...over
});

describe('applyToolCallHook', () => {
  test('a Bash call opens at PreToolUse with its command and closes at its PostToolUse', () => {
    let l = applyToolCallHook([], 't1', pre('Bash', 'b1', { command: 'sed -i s/a/b/ x' }), 100);
    expect(l).toEqual([{ id: 'b1', terminalId: 't1', sessionId: 's1', agent: 'main', tool: 'Bash', command: 'sed -i s/a/b/ x', start: 100, end: null }]);
    l = applyToolCallHook(l, 't1', post('Bash', 'b1'), 350);
    expect(l[0]!.end).toBe(350);
  });
  test('the call keeps the folder Claude ran it from (the hook\'s cwd): absolute and bounded, else none', () => {
    const at = (cwd: unknown) => applyToolCallHook([], 't1', pre('Bash', 'b1', { command: 'npm test' }, { cwd }), 1)[0]!.cwd;
    expect(at('/p/.claude/worktrees/website')).toBe('/p/.claude/worktrees/website');
    expect(at('rel/dir')).toBeUndefined();
    expect(at('/' + 'x'.repeat(5000))).toBeUndefined();
    expect(at(42)).toBeUndefined();
    expect(at('/p/a\u0007b')).toBeUndefined();
    expect(at('/p/a‮b')).toBeUndefined();
    expect(at('/p/a b')).toBeUndefined();
  });
  test('PostToolUseFailure closes too', () => {
    const l = applyToolCallHook(applyToolCallHook([], 't1', pre('Bash', 'b1', { command: 'false' }), 1), 't1', post('Bash', 'b1', {}, {}, 'PostToolUseFailure'), 2);
    expect(l[0]!.end).toBe(2);
  });
  test('Edit/Write and read-only tools open nothing; MCP and unknown tools do', () => {
    let l: ToolCallWindow[] = [];
    for (const t of ['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Read', 'Grep', 'Glob', 'Agent', 'TodoWrite', 'WebFetch']) l = applyToolCallHook(l, 't1', pre(t, `x-${t}`), 1);
    expect(l).toEqual([]);
    l = applyToolCallHook(l, 't1', pre('mcp__fs__write_file', 'm1'), 1);
    l = applyToolCallHook(l, 't1', pre('SomethingNew', 'n1'), 1);
    expect(l.map((c) => c.tool)).toEqual(['mcp__fs__write_file', 'SomethingNew']);
    expect(l[0]!.command).toBeUndefined();
  });
  test('a subagent call carries its agent key and is closed by its own SubagentStop only', () => {
    let l = applyToolCallHook([], 't1', pre('Bash', 'b1', { command: 'x' }, { agent_id: 'a7' }), 1);
    l = applyToolCallHook(l, 't1', pre('Bash', 'b2', { command: 'y' }), 2);
    expect(l[0]!.agent).toBe('agent:a7');
    l = applyToolCallHook(l, 't1', ev('Stop'), 3);
    expect(l.map((c) => c.end)).toEqual([null, 3]);
    l = applyToolCallHook(l, 't1', ev('SubagentStop', { agent_id: 'a7' }), 4);
    expect(l.map((c) => c.end)).toEqual([4, 3]);
  });
  test('the main agent\'s open calls close at Stop, StopFailure and the idle notice', () => {
    for (const end of [ev('Stop'), ev('StopFailure'), ev('Notification', { notification_type: 'idle_prompt' })]) {
      const l = applyToolCallHook(applyToolCallHook([], 't1', pre('Bash', 'b1', { command: 'x' }), 1), 't1', end, 9);
      expect(l[0]!.end).toBe(9);
    }
    const other = applyToolCallHook(applyToolCallHook([], 't1', pre('Bash', 'b1', { command: 'x' }), 1), 't1', ev('Notification', { notification_type: 'permission_prompt' }), 9);
    expect(other[0]!.end).toBeNull();
  });
  test('a prompt queued while a call runs (UserPromptSubmit) leaves the call open', () => {
    const open = applyToolCallHook([], 't1', pre('Bash', 'b1', { command: 'npm test' }), 1);
    const l = applyToolCallHook(open, 't1', ev('UserPromptSubmit', { prompt: 'also check the docs' }), 9);
    expect(l[0]!.end).toBeNull();
    expect(applyToolCallHook(l, 't1', post('Bash', 'b1'), 12)[0]!.end).toBe(12);
  });
  test('a SubagentStop without agent_id closes nothing (not the main agent\'s calls)', () => {
    const open = applyToolCallHook([], 't1', pre('Bash', 'b1', { command: 'x' }), 1);
    expect(applyToolCallHook(open, 't1', ev('SubagentStop'), 9)).toBe(open);
  });
  test('the session id is clipped to 128 chars; the call stays open while that session lives', () => {
    const long = 's'.repeat(300);
    const l = applyToolCallHook([], 't1', pre('Bash', 'b1', { command: 'x' }, { session_id: long }), 1);
    expect(l[0]!.sessionId).toBe(long.slice(0, 128));
    expect(syncToolCalls(l, [{ id: 't1', session: session({ sessionId: long }) }], 9)).toBe(l);
    expect(syncToolCalls(l, [{ id: 't1', session: session({ sessionId: 's2' }) }], 9)[0]!.end).toBe(9);
  });
  test('SessionStart (not compact) and SessionEnd close every open call of the terminal', () => {
    const open = applyToolCallHook([], 't1', pre('Bash', 'b1', { command: 'x', run_in_background: true }), 1);
    expect(applyToolCallHook(open, 't1', ev('SessionStart', { source: 'compact' }), 5)[0]!.end).toBeNull();
    expect(applyToolCallHook(open, 't1', ev('SessionStart', { source: 'startup' }), 5)[0]!.end).toBe(5);
    expect(applyToolCallHook(open, 't1', ev('SessionEnd'), 6)[0]!.end).toBe(6);
    expect(applyToolCallHook(open, 't2', ev('SessionEnd'), 6)[0]!.end).toBeNull();
  });
  test('a background Bash stays open after its PostToolUse, tied to its shell; without a task id it closes', () => {
    let l = applyToolCallHook([], 't1', pre('Bash', 'b1', { command: 'npm run e2e', run_in_background: true }), 1);
    expect(l[0]!.background).toBe(true);
    l = applyToolCallHook(l, 't1', post('Bash', 'b1', { backgroundTaskId: 'bg9' }), 2);
    expect(l[0]).toMatchObject({ end: null, taskId: 'bg9' });
    l = applyToolCallHook(l, 't1', ev('Stop'), 3);
    expect(l[0]!.end).toBeNull();
    const lost = applyToolCallHook(applyToolCallHook([], 't1', pre('Bash', 'b2', { command: 'x', run_in_background: true }), 1), 't1', post('Bash', 'b2', {}), 2);
    expect(lost[0]!.end).toBe(2);
  });
  test('a Monitor is background, tied to tool_response.taskId', () => {
    const l = applyToolCallHook(applyToolCallHook([], 't1', pre('Monitor', 'm1', { command: 'tail -f log' }), 1), 't1', post('Monitor', 'm1', { taskId: 'mon1' }), 2);
    expect(l[0]).toMatchObject({ background: true, taskId: 'mon1', end: null });
    expect(l[0]!.command).toBe('tail -f log');
  });
  test('without tool_use_id: a local id, closed by the next id-less PostToolUse of the same agent and tool', () => {
    let l = applyToolCallHook([], 't1', pre('Bash', null, { command: 'x' }), 1);
    l = applyToolCallHook(l, 't1', pre('Bash', null, { command: 'y' }), 2);
    expect(l.map((c) => c.id.startsWith('anon:'))).toEqual([true, true]);
    l = applyToolCallHook(l, 't1', post('Bash', null), 3);
    expect(l.map((c) => c.end)).toEqual([3, null]);
  });
  test('two id-less calls in the same millisecond both open; one id-less Post closes the oldest only', () => {
    let l = applyToolCallHook([], 't1', pre('Bash', null, { command: 'x' }), 5);
    l = applyToolCallHook(l, 't1', pre('Bash', null, { command: 'y' }), 5);
    expect(l).toHaveLength(2);
    expect(new Set(l.map((c) => c.id)).size).toBe(2);
    l = applyToolCallHook(l, 't1', post('Bash', null), 6);
    expect(l.map((c) => c.end)).toEqual([6, null]);
  });
  test('a very long tool name is clipped once, and its id-less Post still matches', () => {
    const name = 'mcp__' + 'z'.repeat(300);
    let l = applyToolCallHook([], 't1', pre(name, null), 1);
    expect(l[0]!.tool).toHaveLength(128);
    l = applyToolCallHook(l, 't1', post(name, null), 2);
    expect(l[0]!.end).toBe(2);
  });
  test('a long command is not kept (treated as a writer later); a repeated PreToolUse changes nothing; junk is ignored', () => {
    const l = applyToolCallHook([], 't1', pre('Bash', 'b1', { command: 'x'.repeat(3000) }), 1);
    expect(l[0]!.command).toBeUndefined();
    expect(applyToolCallHook(l, 't1', pre('Bash', 'b1', { command: 'y' }), 2)).toBe(l);
    expect(applyToolCallHook(l, 't1', null, 2)).toBe(l);
    expect(applyToolCallHook(l, 't1', { hook_event_name: 'PreToolUse', tool_name: 'Bash' }, 2)).toBe(l);
  });
});

describe('syncToolCalls', () => {
  const open = (over: Partial<ToolCallWindow> = {}): ToolCallWindow => ({ id: 'b1', terminalId: 't1', sessionId: 's1', agent: 'main', tool: 'Bash', start: 1, end: null, ...over });
  test('closes the calls of a terminal gone, of a session gone or replaced', () => {
    expect(syncToolCalls([open()], [], 9)[0]!.end).toBe(9);
    expect(syncToolCalls([open()], [{ id: 't1', session: null }], 9)[0]!.end).toBe(9);
    expect(syncToolCalls([open()], [{ id: 't1', session: session({ sessionId: 's2' }) }], 9)[0]!.end).toBe(9);
  });
  test('a background call closes when its shell leaves the session\'s background items', () => {
    const bg = open({ background: true, taskId: 'bg9' });
    const withShell = session({ background: { items: [{ id: 'bg9', kind: 'shell', label: 'e2e', since: 1 }], crons: [] } });
    const same = [bg];
    expect(syncToolCalls(same, [{ id: 't1', session: withShell }], 9)).toBe(same);
    expect(syncToolCalls([bg], [{ id: 't1', session: session() }], 9)[0]!.end).toBe(9);
  });
});

describe('pruneToolCalls', () => {
  const call = (over: Partial<ToolCallWindow>): ToolCallWindow => ({ id: 'x', terminalId: 't1', sessionId: 's1', agent: 'main', tool: 'Bash', start: 0, end: null, ...over });
  test('caps a foreground call at 2 hours, never a background one with its shell', () => {
    expect(CALL_CAP_MS).toBe(2 * 60 * 60_000);
    const now = CALL_CAP_MS + 10;
    expect(pruneToolCalls([call({ id: 'a' })], now - 20)[0]!.end).toBeNull();
    const l = pruneToolCalls([call({ id: 'a' }), call({ id: 'b', background: true, taskId: 'bg' })], now);
    expect(l.map((c) => c.end)).toEqual([now, null]);
  });
  test('a spared call (its session waits for a permission answer) is never capped; the others still are', () => {
    const now = 3 * 60 * 60_000;
    const l = [call({ id: 'asked', terminalId: 't1' }), call({ id: 'lost', terminalId: 't2' })];
    const out = pruneToolCalls(l, now, CALL_CAP_MS, CALL_KEEP_MS, MAX_CALLS, (c) => c.terminalId === 't1');
    expect(out.map((c) => c.end)).toEqual([null, now]);
    const spared = [call({ id: 'asked', terminalId: 't1' })];
    expect(pruneToolCalls(spared, now, CALL_CAP_MS, CALL_KEEP_MS, MAX_CALLS, () => true)).toBe(spared);
  });
  test('drops calls closed more than 10 minutes ago and keeps at most `max` (oldest closed first)', () => {
    const now = CALL_KEEP_MS + 1000;
    expect(pruneToolCalls([call({ id: 'old', end: 500 }), call({ id: 'new', end: 1500 })], now).map((c) => c.id)).toEqual(['new']);
    const many = Array.from({ length: 5 }, (_, i) => call({ id: `c${i}`, start: now - 10, end: now - 5 + i }));
    expect(pruneToolCalls(many, now, CALL_CAP_MS, CALL_KEEP_MS, 3).map((c) => c.id)).toEqual(['c2', 'c3', 'c4']);
  });
  test('over `max` with nothing closed to drop: the same array', () => {
    const l = [call({ id: 'a', start: 100 }), call({ id: 'b', start: 100 })];
    expect(pruneToolCalls(l, 200, CALL_CAP_MS, CALL_KEEP_MS, 1)).toBe(l);
  });
  test('the same array when nothing changes', () => {
    const l = [call({ start: 100 })];
    expect(pruneToolCalls(l, 200)).toBe(l);
  });
});

describe('waitingForAnswer', () => {
  const call = (over: Partial<ToolCallWindow>): ToolCallWindow => ({ id: 'x', terminalId: 't1', sessionId: 's1', agent: 'main', tool: 'Bash', start: 0, end: null, ...over });
  test('the calls of a terminal whose session (the same one) waits for a permission or an answer, whatever their agent', () => {
    const spare = waitingForAnswer([
      { id: 't1', session: session({ state: 'waiting', waitingFor: 'permission' }) },
      { id: 't2', session: session({ state: 'waiting', waitingFor: 'question' }) },
      { id: 't3', session: session({ state: 'running' }) },
      { id: 't4', session: null },
      { id: 't5', session: session({ state: 'idle', waitingFor: 'input' }) }
    ]);
    expect(spare(call({}))).toBe(true);
    expect(spare(call({ agent: 'agent:a7' }))).toBe(true);
    // An MCP elicitation comes in the middle of its tool call.
    expect(spare(call({ terminalId: 't2', tool: 'mcp__db__migrate' }))).toBe(true);
    expect(spare(call({ sessionId: 's0' }))).toBe(false);
    for (const t of ['t3', 't4', 't5', 't9']) expect(spare(call({ terminalId: t }))).toBe(false);
  });
  test('wired into the prune: a call asked 3 h ago is still open, capped once the session stops waiting', () => {
    const now = 3 * 60 * 60_000;
    const l = [call({})];
    const waiting = [{ id: 't1', session: session({ state: 'waiting', waitingFor: 'permission' }) }];
    expect(pruneToolCalls(l, now, CALL_CAP_MS, CALL_KEEP_MS, MAX_CALLS, waitingForAnswer(waiting))).toBe(l);
    const running = [{ id: 't1', session: session({ state: 'running' }) }];
    expect(pruneToolCalls(l, now, CALL_CAP_MS, CALL_KEEP_MS, MAX_CALLS, waitingForAnswer(running))[0]!.end).toBe(now);
  });
});

describe('fitCalls', () => {
  const call = (i: number, over: Partial<ToolCallWindow> = {}): ToolCallWindow =>
    ({ id: `c${i}`, terminalId: 't1', sessionId: 's1', agent: 'main', tool: 'Bash', command: `${i}`.padEnd(2000, '"'), start: i, end: i + 1, ...over });
  const size = (l: ToolCallWindow[]) => JSON.stringify(l).length;
  test('a list that fits is the same array', () => {
    const l = [call(1), call(2, { end: null })];
    expect(fitCalls(l, 1_000_000)).toBe(l);
  });
  test('too big: commands go from the oldest closed windows first, then the open ones, until it fits', () => {
    // Quotes escape to two chars: each window is ~4 KB of JSON, 1000 of them ~4 MB, over a 2 MB budget.
    const l = [call(5000, { end: null }), ...Array.from({ length: 1000 }, (_, i) => call(1000 - i))];
    expect(size(l)).toBeGreaterThan(4_000_000);
    const out = fitCalls(l, 2_000_000);
    expect(size(out)).toBeLessThanOrEqual(2_000_000);
    expect(out.map((c) => c.id)).toEqual(l.map((c) => c.id));
    const kept = out.filter((c) => c.command !== undefined).map((c) => c.end);
    const dropped = out.filter((c) => c.command === undefined).map((c) => c.end!);
    // Every window that lost its command ended before every closed window that kept it; the open one kept it.
    expect(Math.max(...dropped)).toBeLessThan(Math.min(...kept.filter((e): e is number => e !== null)));
    expect(out[0]!.command).toBeDefined();
    expect(out.find((c) => c.id === 'c1')!.command).toBeUndefined();
    // Nothing else changes.
    expect({ ...out.find((c) => c.id === 'c1'), command: 'x' }).toEqual({ ...l.find((c) => c.id === 'c1'), command: 'x' });
  });
  test('the folder is only a hint: folders go first (oldest closed first), commands only if that is not enough', () => {
    // 500 windows, ~4 KB of command and ~3 KB of folder each: without the folders they fit in 2.2 MB.
    const l = Array.from({ length: 500 }, (_, i) => call(500 - i, { cwd: '/'.padEnd(3000, 'd') }));
    const out = fitCalls(l, 2_200_000);
    expect(size(out)).toBeLessThanOrEqual(2_200_000);
    expect(out.every((c) => c.command !== undefined)).toBe(true);
    const keptCwd = out.filter((c) => c.cwd !== undefined).map((c) => c.end!);
    const lostCwd = out.filter((c) => c.cwd === undefined).map((c) => c.end!);
    expect(lostCwd.length).toBeGreaterThan(0);
    if (keptCwd.length) expect(Math.max(...lostCwd)).toBeLessThan(Math.min(...keptCwd));
    // Tighter: every folder goes, then commands.
    const tight = fitCalls(l, 1_000_000);
    expect(size(tight)).toBeLessThanOrEqual(1_000_000);
    expect(tight.every((c) => c.cwd === undefined)).toBe(true);
    expect(tight.some((c) => c.command === undefined)).toBe(true);
  });
  test('closed windows alone are not enough: open ones lose their command too (oldest first)', () => {
    const l = [call(1), call(2, { end: null }), call(3, { end: null })];
    const out = fitCalls(l, size([{ ...l[0]!, command: undefined }, { ...l[1]!, command: undefined }, l[2]!]) + 10);
    expect(out.map((c) => c.command === undefined)).toEqual([true, true, false]);
  });
});

describe('changedCalls / upsertCalls', () => {
  test('changed = the new or replaced windows; upsert merges by terminal and id', () => {
    const a: ToolCallWindow = { id: 'a', terminalId: 't1', sessionId: 's1', agent: 'main', tool: 'Bash', start: 1, end: null };
    const b: ToolCallWindow = { ...a, id: 'b' };
    const a2 = { ...a, end: 5 };
    expect(changedCalls([a, b], [a2, b])).toEqual([a2]);
    expect(upsertCalls([a], [{ ...b, end: 1 }, { ...b, end: 2 }])).toEqual([a, { ...b, end: 2 }]);
    expect(upsertCalls([a, b], [a2, { ...a, terminalId: 't2' }])).toEqual([a2, b, { ...a, terminalId: 't2' }]);
  });
});
