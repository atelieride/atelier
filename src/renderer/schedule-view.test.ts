import { describe, expect, test } from 'vitest';
import {
  chipView, clockOf, composeAt, dayLabel, dayOf, paletteRows, parseClock, presetsFor, railFor, relTime, rowsFor, statusLine,
  stepClock, summaryOf, timeError, whenOf
} from './schedule-view';
import type { ScheduledPrompt } from '@shared/scheduled-prompts';
import type { Usage } from '@shared/session';

const MIN = 60_000;
// Sunday 25 Oct 2026, 12:48 local.
const NOW = new Date(2026, 9, 25, 12, 48, 20).getTime();
const at = (d: number, h: number, m: number) => new Date(2026, 9, 25 + d, h, m).getTime();
const p = (o: Partial<ScheduledPrompt> = {}): ScheduledPrompt => ({
  id: 'p1', terminalId: 't1', sessionId: 's1', projectRoot: '/w', title: 'api-refactor', text: 'run the tests', at: at(0, 14, 30),
  ifBusy: 'wait', createdAt: 0, status: 'pending', ...o
});

describe('times', () => {
  test('clock, day and relative labels', () => {
    expect(clockOf(at(0, 9, 5))).toBe('09:05');
    expect(dayLabel(at(0, 14, 30), NOW)).toBe('Today');
    expect(dayLabel(at(1, 9, 0), NOW)).toBe('Tomorrow');
    expect(dayLabel(at(2, 9, 0), NOW)).toBe('Tue 27 Oct');
    expect(relTime(at(0, 14, 30), NOW)).toBe('in 1 h 42 min');
    expect(relTime(at(0, 12, 52), NOW)).toBe('in 4 min');
    expect(relTime(at(0, 13, 48), NOW)).toBe('in 1 h');
    expect(relTime(at(0, 12, 45), NOW)).toBe('3 min ago');
    expect(relTime(at(0, 12, 48), NOW)).toBe('now');
    expect(relTime(at(2, 9, 0), NOW)).toBe('in 1 d 20 h');
  });
  test('parseClock, stepClock and composeAt', () => {
    expect(parseClock('14:30')).toEqual({ h: 14, m: 30 });
    expect(parseClock('9:05')).toEqual({ h: 9, m: 5 });
    expect(parseClock('1430')).toEqual({ h: 14, m: 30 });
    expect(parseClock('24:00')).toBeNull();
    expect(parseClock('ab')).toBeNull();
    expect(stepClock('14:30', 1)).toBe('14:35');
    expect(stepClock('14:32', 1)).toBe('14:35');
    expect(stepClock('14:32', -1)).toBe('14:30');
    expect(stepClock('23:58', 1)).toBe('00:00');
    expect(stepClock('', 1)).toBe('00:00');
    expect(composeAt(dayOf(NOW, 0), '14:30')).toBe(at(0, 14, 30));
    expect(composeAt(dayOf(NOW, 1), '09:00')).toBe(at(1, 9, 0));
    expect(composeAt(dayOf(NOW, 1), 'x')).toBeNull();
  });
});

describe('chipView', () => {
  test('the next live time, +N, and nothing for a session without prompts', () => {
    expect(chipView([], 't1', NOW)).toBeNull();
    const v = chipView([p({ id: 'b', at: at(1, 9, 0) }), p(), p({ id: 'x', terminalId: 't2' }), p({ id: 's', status: 'sent' })], 't1', NOW)!;
    expect(v).toMatchObject({ time: '14:30', more: 1, tone: 'next' });
    expect(chipView([p({ at: at(1, 9, 0) })], 't1', NOW)!.time).toBe('Mon 09:00');
  });
  test('missed wins, then due (waiting), then moved by a limit', () => {
    expect(chipView([p(), p({ id: 'm', status: 'missed', reason: 'asleep', at: at(0, 9, 0) })], 't1', NOW)).toMatchObject({ tone: 'missed', time: '09:00' });
    expect(chipView([p({ at: at(0, 12, 40), dueSince: at(0, 12, 40), reason: 'busy' })], 't1', NOW)).toMatchObject({ tone: 'due' });
    expect(chipView([p({ status: 'armed', armedUntil: NOW + 5000 })], 't1', NOW)).toMatchObject({ tone: 'due' });
    expect(chipView([p({ reason: 'limit', movedFrom: at(0, 12, 0), at: at(0, 16, 41) })], 't1', NOW)).toMatchObject({ tone: 'moved', time: '16:41' });
  });
});

describe('rows and status lines', () => {
  test('live and missed by time, then today\'s finished ones apart', () => {
    const list = [p({ id: 'b', at: at(1, 9, 0) }), p(), p({ id: 'm', status: 'missed', reason: 'closed', at: at(0, 9, 0) }), p({ id: 's', status: 'sent', at: at(0, 11, 0), doneAt: at(0, 11, 0) })];
    const r = rowsFor(list, 't1', NOW);
    expect(r.live.map((x) => x.id)).toEqual(['m', 'p1', 'b']);
    expect(r.done.map((x) => x.id)).toEqual(['s']);
  });
  test('each state says what happens', () => {
    expect(statusLine(p(), NOW)).toBe('in 1 h 42 min');
    expect(statusLine(p({ ifBusy: 'skip' }), NOW)).toBe('in 1 h 42 min · skipped if Claude is busy');
    expect(statusLine(p({ at: at(0, 12, 45), dueSince: at(0, 12, 45), reason: 'busy' }), NOW)).toBe('Due 3 min ago · waits for Claude to finish');
    expect(statusLine(p({ at: at(0, 12, 45), dueSince: at(0, 12, 45), reason: 'draft' }), NOW)).toBe('Due 3 min ago · waits for the text in its prompt (Send Now goes anyway)');
    expect(statusLine(p({ status: 'armed', armedUntil: NOW + 6000 }), NOW)).toBe('Sending in 6 s');
    expect(statusLine(p({ reason: 'limit', movedFrom: at(0, 12, 0), at: at(0, 16, 41) }), NOW)).toBe('Moved from 12:00: usage limit');
    expect(statusLine(p({ status: 'missed', reason: 'asleep', at: at(0, 9, 0) }), NOW)).toBe('Not sent: the Mac was asleep');
    expect(statusLine(p({ status: 'sent', doneAt: at(0, 14, 36) }), NOW)).toBe('Sent at 14:36');
    expect(statusLine(p({ status: 'skipped', reason: 'busy', doneAt: at(0, 14, 30) }), NOW)).toBe('Skipped: Claude was working');
  });
});

describe('presets', () => {
  const usage = (resetMin: number): Usage => ({ fiveHour: { pct: 62, resetsAt: (NOW + resetMin * MIN) / 1000 }, sevenDay: null, updatedAt: 0 });
  test('in 30 min, 1 hour, 3 hours, tomorrow 09:00, and the usage reset + 1 min when known', () => {
    const ps = presetsFor([], 't1', NOW, usage(232));
    expect(ps.map((x) => [x.key, clockOf(x.at), x.taken])).toEqual([
      ['30m', '13:18', false], ['1h', '13:48', false], ['3h', '15:48', false], ['tomorrow', '09:00', false], ['reset', '16:41', false]
    ]);
    expect(presetsFor([], 't1', NOW, null).map((x) => x.key)).toEqual(['30m', '1h', '3h', 'tomorrow']);
  });
  test('a taken preset says so and points to the next free minute', () => {
    const ps = presetsFor([p({ at: at(1, 9, 0) })], 't1', NOW, null);
    const tomorrow = ps.find((x) => x.key === 'tomorrow')!;
    expect(tomorrow).toMatchObject({ taken: true });
    expect(clockOf(tomorrow.at)).toBe('09:05');
  });
});

describe('composer checks', () => {
  test('timeError: past, taken (with the fix), fine', () => {
    expect(timeError([], 't1', at(0, 12, 0), NOW)).toEqual({ kind: 'past', fix: at(1, 12, 0) });
    // A past date picked with Date…: the fix is tomorrow at that time, not the day after the date.
    expect(timeError([], 't1', at(-5, 10, 0), NOW)).toEqual({ kind: 'past', fix: at(1, 10, 0) });
    expect(timeError([p()], 't1', at(0, 14, 30), NOW)).toEqual({ kind: 'taken', fix: at(0, 14, 35), by: p() });
    expect(timeError([p()], 't1', at(0, 14, 30), NOW, 'p1')).toBeNull();
    expect(timeError([], 't1', at(0, 12, 48), NOW)).toBeNull();
  });
  test('whenOf: the day in words and the clock, as the summary says it', () => {
    expect(whenOf(at(0, 14, 30), NOW)).toBe('today at 14:30');
    expect(whenOf(at(1, 9, 0), NOW)).toBe('tomorrow at 09:00');
    expect(whenOf(at(2, 9, 0), NOW)).toBe('Tue 27 Oct at 09:00');
  });
  test('summaryOf', () => {
    expect(summaryOf(at(0, 14, 30), NOW)).toBe('Sends today at 14:30 · in 1 h 42 min');
    expect(summaryOf(at(1, 9, 0), NOW)).toBe('Sends tomorrow at 09:00 · in 20 h 12 min');
    expect(summaryOf(at(2, 9, 0), NOW)).toBe('Sends Tue 27 Oct at 09:00 · in 1 d 20 h');
  });
  test('the rail: the next 24 h, this session\'s prompts, the reset, this one', () => {
    const r = railFor([p(), p({ id: 'o', terminalId: 't2' })], 't1', NOW, { at: at(0, 14, 30), clash: true, resetAt: at(0, 16, 40) });
    expect(r.dots.map((d) => d.kind)).toEqual(['other', 'this']);
    expect(r.dots[1]!.clash).toBe(true);
    expect(r.dots[0]!.left).toBeCloseTo(((at(0, 14, 30) - NOW) / (24 * 60 * MIN)) * 100, 3);
    expect(r.reset).not.toBeNull();
    expect(r.ticks[0]!.label).toBe('now');
  });
});

describe('local days with a clock change (25 Oct 2026: the clocks go back in most of Europe)', () => {
  test('the rail\'s ticks are whole local hours, the past-time fix keeps its clock, presets name another day', () => {
    const late = new Date(2026, 9, 24, 22, 41).getTime();
    const r = railFor([], 't1', late, { at: null, clash: false, resetAt: null });
    for (const k of r.ticks.slice(1)) expect(k.label).toMatch(/^(00|06|12|18):00$/);
    const err = timeError([], 't1', new Date(2026, 9, 24, 20, 0).getTime(), late);
    expect(err && clockOf(err.fix)).toBe('20:00');
    const ps = presetsFor([], 't1', late, null);
    expect(ps.find((x) => x.key === '3h')!.day).toBe('Sun');
    expect(ps.find((x) => x.key === '30m')!.day).toBeNull();
    expect(ps.find((x) => x.key === 'tomorrow')!.day).toBeNull();
  });
});

describe('paletteRows', () => {
  test('missed first, then by time; other projects dimmed; finished left out', () => {
    const list = [p({ id: 'b', at: at(1, 9, 0) }), p({ id: 'o', projectRoot: '/x', at: at(0, 13, 0) }), p({ id: 'm', status: 'missed', reason: 'asleep', at: at(0, 9, 0) }), p({ id: 's', status: 'sent' })];
    const rows = paletteRows(list, '/w', NOW);
    expect(rows.map((r) => [r.prompt.id, r.group, r.other])).toEqual([['m', 'Needs a decision', false], ['o', 'Today', true], ['b', 'Tomorrow · Mon 26 Oct', false]]);
  });
});
