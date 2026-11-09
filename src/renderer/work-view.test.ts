import { describe, expect, test } from 'vitest';
import type { BackgroundWork } from '@shared/background';
import type { SessionInfo, SessionState } from '@shared/session';
import { clockTime, formatDuration, scheduledView, workChipView } from './work-view';

const NOW = new Date(2026, 9, 11, 12, 0, 0).getTime(); // Sun 11 Oct 2026 12:00 local
const work = (p: Partial<BackgroundWork>): BackgroundWork => ({ counting: true, agents: 0, shells: 0, monitors: 0, other: 0, idle: 0, items: [], crons: [], entries: [], nextChange: null, ...p });
const cron = (label: string, next: number | null): BackgroundWork['crons'][number] => ({ id: `c-${label}`, label, schedule: '* * * * *', recurring: true, next });
const sess = (state: SessionState, extra: Partial<SessionInfo> = {}): SessionInfo =>
  ({ sessionId: 's', state, title: null, activity: null, contextPct: null, unread: false, updatedAt: 0, ...extra });

describe('workChipView', () => {
  test('summary, compact parts, total; the tooltip heads with the summary and lists each item "kind · label"', () => {
    const w = work({
      agents: 1, shells: 2,
      items: [{ kind: 'agent', label: 'Running full unit test suite', counted: true }, { kind: 'shell', label: 'npm run e2e', counted: true }, { kind: 'shell', label: 'npm test', counted: true }]
    });
    const v = workChipView({ session: sess('done'), work: w }, NOW)!;
    expect(v).toMatchObject({ full: '1 agent · 2 shells', parts: [['agent', 1], ['shell', 2]], total: 3, counting: true, idle: false });
    expect(v.tip.split('\n')).toEqual(['1 agent · 2 shells', 'agent · Running full unit test suite', 'shell · npm run e2e', 'shell · npm test']);
  });
  test('tooltip: chip order (agents, shells, monitors, tasks), at most 8 lines, then "+N more"', () => {
    const items = [
      { kind: 'monitor' as const, label: 'watch log', counted: true },
      ...Array.from({ length: 9 }, (_, i) => ({ kind: 'shell' as const, label: `job ${i}`, counted: true })),
      { kind: 'other' as const, label: 'mcp task', counted: true },
      { kind: 'agent' as const, label: 'Explore', counted: true }
    ];
    const lines = workChipView({ session: sess('idle'), work: work({ agents: 1, shells: 9, monitors: 1, other: 1, items }) }, NOW)!.tip.split('\n');
    expect(lines[0]).toBe('1 agent · 9 shells · 1 monitor · 1 task');
    expect(lines.slice(1, 3)).toEqual(['agent · Explore', 'shell · job 0']);
    expect(lines).toHaveLength(1 + 8 + 1);
    expect(lines.at(-1)).toBe('+4 more');
  });
  test('idle items next to counted ones are marked as not counted', () => {
    const w = work({ agents: 1, idle: 1, idleSince: NOW - 2 * 3600_000, items: [{ kind: 'agent', label: 'Explore', counted: true }, { kind: 'shell', label: 'tail -f log', counted: false }] });
    const v = workChipView({ session: sess('done'), work: w }, NOW)!;
    expect(v).toMatchObject({ full: '1 agent', total: 2, idle: false });
    expect(v.tip.split('\n')).toEqual(['1 agent', 'agent · Explore', 'shell · tail -f log · not counted']);
  });
  test('only idle items: dimmed, never counting, the tooltip says for how long and that it is not work', () => {
    const w = work({ counting: false, idle: 1, idleSince: NOW - 2 * 3600_000, items: [{ kind: 'shell', label: 'npm run dev:watch', counted: false }] });
    const v = workChipView({ session: sess('done'), work: w }, NOW)!;
    expect(v).toMatchObject({ full: '1 shell', total: 1, counting: false, idle: true });
    expect(v.tip.split('\n')).toEqual(['1 shell', 'shell · npm run dev:watch', 'Running for 2 h · not counted as work']);
  });
  test('main agent running: the chip shows the work without counting', () => {
    const v = workChipView({ session: sess('running'), work: work({ counting: false, agents: 3, items: Array.from({ length: 3 }, () => ({ kind: 'agent' as const, label: 'Explore', counted: true })) }) }, NOW)!;
    expect(v).toMatchObject({ full: '3 agents', counting: false, idle: false });
  });
  test('long: three kinds or more (the summary would crowd a medium line on its own)', () => {
    const items = (kinds: ('agent' | 'shell' | 'monitor' | 'other')[]) => kinds.map((kind) => ({ kind, label: kind, counted: true }));
    expect(workChipView({ session: sess('done'), work: work({ items: items(['agent', 'shell', 'monitor']) }) }, NOW)!.long).toBe(true);
    expect(workChipView({ session: sess('done'), work: work({ items: items(['agent', 'shell', 'shell']) }) }, NOW)!.long).toBe(false);
    expect(workChipView({ session: sess('done', { subagents: 5 }) }, NOW)!.long).toBe(false);
  });
  test('nothing listed: no chip', () => {
    expect(workChipView({ session: sess('done'), work: work({ counting: false }) }, NOW)).toBeNull();
    expect(workChipView({ session: null }, NOW)).toBeNull();
  });
  test('an atelierd without background work: the subagent count the old way', () => {
    expect(workChipView({ session: sess('done', { subagents: 2 }) }, NOW)).toEqual({
      full: '2 agents', parts: [['agent', 2]], total: 2, counting: true, idle: false, long: false, tip: '2 subagents running in the background'
    });
    expect(workChipView({ session: sess('running', { subagents: 1 }) }, NOW)).toMatchObject({ full: '1 agent', counting: false, tip: '1 subagent running' });
    expect(workChipView({ session: sess('done') }, NOW)).toBeNull();
  });
});

describe('scheduledView', () => {
  const at = (h: number, m: number, day = 11) => new Date(2026, 9, day, h, m).getTime();
  test('the soonest next time (local HH:MM) and its label; singular', () => {
    expect(scheduledView(work({ crons: [cron('check the deploy', at(12, 30))] }), NOW)).toEqual({
      time: '12:30', tip: '1 scheduled wake-up · next at 12:30 · check the deploy'
    });
  });
  test('plural; the soonest wins whatever the order', () => {
    const v = scheduledView(work({ crons: [cron('later', at(18, 5)), cron('sooner', at(9, 7, 12)), cron('soonest', at(12, 45))] }), NOW);
    expect(v).toEqual({ time: '12:45', tip: '3 scheduled wake-ups · next at 12:45 · soonest' });
  });
  test('not today: the tooltip says the day too', () => {
    expect(scheduledView(work({ crons: [cron('x', at(9, 5, 12))] }), NOW)!.tip).toBe('1 scheduled wake-up · next at 09:05 tomorrow · x');
    expect(scheduledView(work({ crons: [cron('x', at(9, 5, 14))] }), NOW)!.tip).toBe('1 scheduled wake-up · next at 09:05 on Wed 14 Oct · x');
  });
  test('no parsable time: icon only, the tooltip without a time', () => {
    expect(scheduledView(work({ crons: [cron('odd', null)] }), NOW)).toEqual({ time: null, tip: '1 scheduled wake-up · odd' });
  });
  test('a self-paced loop first: flagged, its tooltip names the loop; fired: icon only, "checking now"', () => {
    const loop = (next: number | null, label = '/loop check the deploy'): BackgroundWork['crons'][number] => ({ id: 'w1', label, schedule: '30 12 * * *', recurring: false, next });
    expect(scheduledView(work({ crons: [loop(at(12, 30)), cron('later', at(18, 5))] }), NOW)).toEqual({
      time: '12:30', loop: true, tip: 'Self-paced loop · next check at 12:30 · check the deploy'
    });
    expect(scheduledView(work({ crons: [loop(null)] }), NOW, sess('running'))).toEqual({ time: null, loop: true, tip: 'Self-paced loop · checking now · check the deploy' });
    // As the list says: an idle session after a fired wake-up (an interrupted turn, the idle notice) is not checking.
    expect(scheduledView(work({ crons: [loop(null)] }), NOW, sess('done'))).toEqual({ time: null, loop: true, tip: 'Self-paced loop · wake-up passed · check the deploy' });
    expect(scheduledView(work({ crons: [loop(null)] }), NOW, sess('waiting', { waitingFor: 'input' }))!.tip).toBe('Self-paced loop · wake-up passed · check the deploy');
    expect(scheduledView(work({ crons: [loop(at(12, 30), '<<autonomous-loop-dynamic>>')] }), NOW)!.tip).toBe('Autonomous loop · next check at 12:30');
    // An ordinary cron sooner than the loop: the chip is about it, as before.
    expect(scheduledView(work({ crons: [loop(at(12, 50)), cron('sooner', at(12, 10))] }), NOW)).toEqual({ time: '12:10', tip: '2 scheduled wake-ups · next at 12:10 · sooner' });
  });
  test('none, or no work: no chip', () => {
    expect(scheduledView(work({}), NOW)).toBeNull();
    expect(scheduledView(undefined, NOW)).toBeNull();
  });
});

test('formatDuration and clockTime', () => {
  expect(formatDuration(45 * 60_000)).toBe('45 min');
  expect(formatDuration(30_000)).toBe('1 min');
  expect(formatDuration(2 * 3600_000)).toBe('2 h');
  expect(formatDuration(3600_000 + 20 * 60_000)).toBe('1 h 20 min');
  expect(formatDuration(26 * 3600_000 + 5 * 60_000)).toBe('26 h');
  expect(clockTime(new Date(2026, 0, 2, 7, 4).getTime())).toBe('07:04');
});
