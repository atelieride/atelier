import { afterEach, beforeEach, expect, test } from 'vitest';
import type { ScheduledPrompt } from '@shared/scheduled-prompts';
import type { TerminalInfo } from '@shared/protocol';
import { useApp } from './store';
import { deleteSchedule, installScheduleRouting, openScheduleSheet, scheduleBlock, terminalShown, usageOf } from './schedules';
import { single, type Split } from './split';

const p = (o: Partial<ScheduledPrompt> = {}): ScheduledPrompt => ({
  id: 'p1', terminalId: 't1', sessionId: 's1', projectRoot: '/w', title: 'api', text: 'x', at: 0, ifBusy: 'wait', createdAt: 0,
  status: 'pending', ...o
});
const term = (o: Partial<TerminalInfo> = {}): TerminalInfo => ({
  id: 't1', projectRoot: '/w', cwd: '/w', title: 'api', name: null, color: '#fff', foreground: 'claude', createdAt: 0,
  session: { sessionId: 's1', state: 'idle', title: null, activity: null, contextPct: null, unread: false, updatedAt: 0 }, ...o
});

const g = globalThis as { window?: unknown };
let calls: unknown[][] = [];
const ok = () => Promise.resolve({ ok: true });
beforeEach(() => {
  calls = [];
  g.window = { atelier: { schedules: {
    fire: (...a: unknown[]) => { calls.push(['fire', ...a]); return ok(); },
    remove: (...a: unknown[]) => { calls.push(['remove', ...a]); return ok(); },
    restore: (...a: unknown[]) => { calls.push(['restore', ...a]); return ok(); }
  } } };
  useApp.setState({
    schedules: [], scheduleSheet: null, toast: null, terminals: [term()], selectedId: 't1', activeTab: 'term',
    project: { root: '/w', name: 'w', realRoot: '/w' }, popout: null,
    daemon: { ...useApp.getState().daemon, schedulesAvailable: true }
  } as never);
});
afterEach(() => { delete g.window; });

test('terminalShown: the selected terminal tab, or a split pane', () => {
  const s = { activeTab: 'term', selectedId: 't1', split: single() };
  const two = (b: Split['panes'][number]): Split => ({ panes: [{ tabs: ['f:/w/a.ts'], front: 'f:/w/a.ts' }, b], focus: 0, fractions: [0.5, 0.5] });
  expect(terminalShown(s, 't1')).toBe(true);
  expect(terminalShown({ ...s, activeTab: '/w/a.ts' }, 't1')).toBe(false);
  expect(terminalShown({ ...s, split: two({ tabs: ['t:t1'], front: 't:t1' }) }, 't1')).toBe(true);
  expect(terminalShown({ ...s, split: two({ tabs: ['t:t2'], front: 't:t2' }) }, 't1')).toBe(false);
  // Behind another tab of its pane: not shown.
  expect(terminalShown({ ...s, split: two({ tabs: ['t:t1', 't:t2'], front: 't:t2' }) }, 't1')).toBe(false);
});

test('routing: a prompt that arms counts down here only when focused and shown; otherwise it is sent at once', () => {
  let focused = true;
  const off = installScheduleRouting(() => focused);
  const armed = (id: string, terminalId = 't1') => p({ id, terminalId, status: 'armed', armedUntil: Date.now() + 9000 });
  useApp.setState({ schedules: [armed('a')] });
  expect(calls).toEqual([]);
  // An unfocused window leaves it alone: another window of the project may be counting down (main fires when none is
  // focused).
  focused = false;
  useApp.setState({ schedules: [armed('a'), armed('b'), armed('b2', 't2')] });
  expect(calls).toEqual([]);
  focused = true;
  useApp.setState({ schedules: [armed('a'), armed('b'), armed('b2', 't2'), armed('c', 't2')] });
  expect(calls).toEqual([['fire', 'c', undefined]]);
  // Another project's prompt, a pasted one (armed until now) and a fired one: not this window's call.
  const before = calls.length;
  useApp.setState({ schedules: [armed('a'), p({ id: 'd', projectRoot: '/x', status: 'armed', armedUntil: Date.now() + 9000 }), p({ id: 'e', status: 'armed', armedUntil: Date.now() }), p({ id: 'f', status: 'armed', fired: true, armedUntil: Date.now() + 9000 })] });
  expect(calls.length).toBe(before);
  off();
});

test('scheduleBlock and openScheduleSheet: unavailable atelierd, a plain terminal', () => {
  expect(scheduleBlock(term())).toBeNull();
  expect(scheduleBlock(term({ session: null }))).toMatch(/Claude sessions/);
  useApp.setState({ daemon: { ...useApp.getState().daemon, schedulesAvailable: false } } as never);
  expect(scheduleBlock(term())).toMatch(/Restart atelierd/);
  openScheduleSheet('t1');
  expect(useApp.getState().scheduleSheet).toBeNull();
  useApp.setState({ daemon: { ...useApp.getState().daemon, schedulesAvailable: true } } as never);
  openScheduleSheet('t1', 'selected text');
  expect(useApp.getState().scheduleSheet).toEqual({ terminalId: 't1', text: 'selected text' });
});

test('delete: removed, and the toast\'s Undo puts it back', async () => {
  await deleteSchedule(p());
  expect(calls).toEqual([['remove', 'p1']]);
  const toast = useApp.getState().toast as unknown as { action?: { label: string; run: () => void } };
  expect(toast.action?.label).toBe('Undo');
  toast.action!.run();
  expect(calls.at(-1)).toEqual(['restore', p()]);
});

test('usageOf: the terminal\'s account, else an older atelierd\'s single entry', () => {
  const u = (pct: number) => ({ fiveHour: { pct, resetsAt: 1 }, sevenDay: null, updatedAt: 0 });
  expect(usageOf(term({ configDir: '/a' }), [{ configDir: '/b', usage: u(1) }, { configDir: '/a', usage: u(2) }])?.fiveHour?.pct).toBe(2);
  expect(usageOf(term({ configDir: '/a' }), [{ configDir: null, usage: u(3) }])?.fiveHour?.pct).toBe(3);
  expect(usageOf(term({ configDir: '/a' }), [{ configDir: '/b', usage: u(1) }])).toBeNull();
});
