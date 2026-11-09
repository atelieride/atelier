import { describe, expect, test } from 'vitest';
import { clockSeconds, countdown, countLabel, countsAsWork, cronRing, filterLines, fireTime, formatTokens, orderSessions, outputState, scrollToReveal, shortModel, stickToEnd } from './background-output';

describe('output helpers', () => {
  test('filterLines keeps absolute numbers (dropped lines counted) and matches case-insensitively', () => {
    const lines = [{ text: 'PASS a', at: null }, { text: 'fail b', at: 5 }, { text: 'pass c', at: 6 }];
    expect(filterLines(lines, 'pass', 10).map((l) => [l.n, l.text])).toEqual([[11, 'PASS a'], [13, 'pass c']]);
    expect(filterLines(lines, '', 0).map((l) => l.n)).toEqual([1, 2, 3]);
    expect(filterLines(lines, '   ', 0)).toHaveLength(3);
    expect(filterLines(lines, 'fail', 0)[0]).toEqual({ text: 'fail b', at: 5, n: 2 });
  });
  test('stickToEnd: within 24 px of the end', () => {
    expect(stickToEnd({ scrollTop: 976, scrollHeight: 1200, clientHeight: 200 })).toBe(true);
    expect(stickToEnd({ scrollTop: 900, scrollHeight: 1200, clientHeight: 200 })).toBe(false);
    expect(stickToEnd({ scrollTop: 0, scrollHeight: 100, clientHeight: 200 })).toBe(true);
  });
  test('countLabel: lines or events, dropped lines counted in both forms', () => {
    expect(countLabel({ events: false, matching: null, total: 8000 })).toBe('8000 lines');
    expect(countLabel({ events: false, matching: 12, total: 8000 })).toBe('12 of 8000 lines');
    expect(countLabel({ events: false, matching: null, total: 1 })).toBe('1 line');
    expect(countLabel({ events: true, matching: null, total: 3 })).toBe('3 events');
    expect(countLabel({ events: true, matching: null, total: 1 })).toBe('1 event');
    expect(countLabel({ events: true, matching: 1, total: 3 })).toBe('1 of 3 events');
  });
  test('scrollToReveal: the scroll position that brings a child fully into view, unchanged when it already is', () => {
    expect(scrollToReveal({ top: 40, height: 26 }, { scrollTop: 0, clientHeight: 90 })).toBe(0);
    expect(scrollToReveal({ top: 96, height: 26 }, { scrollTop: 0, clientHeight: 90 })).toBe(32);
    expect(scrollToReveal({ top: 0, height: 26 }, { scrollTop: 32, clientHeight: 90 })).toBe(0);
  });
  test('clockSeconds: local HH:MM:SS', () => {
    expect(clockSeconds(new Date(2026, 9, 13, 9, 5, 7).getTime())).toBe('09:05:07');
  });
});

describe('state pill', () => {
  test('running, watching, server, exit codes, ended', () => {
    expect(outputState({ exit: null })).toEqual({ label: 'Running', tone: 'running' });
    expect(outputState({ exit: null, watcher: true })).toEqual({ label: 'Watching', tone: 'watching' });
    expect(outputState({ exit: null, server: true })).toEqual({ label: 'Server', tone: 'server' });
    expect(outputState({ exit: 0 })).toEqual({ label: 'Exited 0', tone: 'ok' });
    expect(outputState({ exit: 1, server: true })).toEqual({ label: 'Exited 1', tone: 'error' });
    expect(outputState({ exit: null, ended: true })).toEqual({ label: 'Ended', tone: 'ended' });
  });
});

describe('counts as work', () => {
  const NOW = 1_000_000;
  const base = { id: 's', kind: 'shell' as const, label: 's', since: 0 };
  test('yes with the time left, server, watcher, past the cap, ended', () => {
    expect(countsAsWork({ ...base, counted: true, capEndsAt: NOW + 12 * 60_000 }, NOW)).toBe('Yes · 12 min left');
    expect(countsAsWork({ ...base, counted: true }, NOW)).toBe('Yes');
    expect(countsAsWork({ ...base, counted: false, server: { ports: [3000] } }, NOW)).toBe('Server');
    expect(countsAsWork({ ...base, counted: false, watcher: true }, NOW)).toBe('No · watcher');
    expect(countsAsWork({ ...base, counted: false }, NOW)).toBe('No · past 30 min');
    expect(countsAsWork(null, NOW)).toBe('No');
  });
  test('an exit code known (the trailer arrived before the scan saw it go) counts no more', () => {
    expect(countsAsWork({ ...base, counted: true, capEndsAt: NOW + 12 * 60_000 }, NOW, 0)).toBe('No');
    expect(countsAsWork({ ...base, counted: true }, NOW, 1)).toBe('No');
    expect(countsAsWork({ ...base, counted: true }, NOW, null)).toBe('Yes');
  });
});

describe('agent header', () => {
  test('shortModel keeps the family', () => {
    expect(shortModel('claude-haiku-5-5')).toBe('haiku');
    expect(shortModel('claude-opus-4-1-20250805')).toBe('opus');
    expect(shortModel('claude-sonnet-4-5[1m]')).toBe('sonnet');
    expect(shortModel('claude-fable-1')).toBe('fable');
    expect(shortModel('gpt-x')).toBe('gpt-x');
    expect(shortModel('claude-mystery-9')).toBe('mystery-9');
  });
  test('formatTokens: 48.2k, 1.2M, plain under a thousand', () => {
    expect(formatTokens(0)).toBe('0');
    expect(formatTokens(950)).toBe('950');
    expect(formatTokens(48_210)).toBe('48.2k');
    expect(formatTokens(12_000)).toBe('12k');
    expect(formatTokens(1_234_567)).toBe('1.2M');
    expect(formatTokens(999_999)).toBe('1M');
  });
});

describe('schedule', () => {
  test('countdown: m:ss under an hour, then hours; "now" when due', () => {
    expect(countdown(6 * 60_000 + 5_000, false)).toBe('6:05');
    expect(countdown(999, false)).toBe('0:00');
    expect(countdown(0, false)).toBe('now');
    expect(countdown(-5_000, false)).toBe('now');
    expect(countdown(80 * 60_000, false)).toBe('1 h 20 min');
  });
  test('countdown with reduced motion: whole minutes rounded up (never "0 min" while something is left)', () => {
    expect(countdown(6 * 60_000 + 5_000, true)).toBe('7 min');
    expect(countdown(6 * 60_000, true)).toBe('6 min');
    expect(countdown(30_000, true)).toBe('1 min');
    expect(countdown(0, true)).toBe('now');
    expect(countdown(80 * 60_000 + 1_000, true)).toBe('1 h 21 min');
  });
  test('fireTime: the time today, the weekday within a week, else the date', () => {
    const now = new Date(2026, 9, 13, 10, 0).getTime(); // Tuesday
    expect(fireTime(new Date(2026, 9, 13, 23, 30).getTime(), now)).toBe('23:30');
    expect(fireTime(new Date(2026, 9, 14, 9, 0).getTime(), now)).toBe('Wed 09:00');
    expect(fireTime(new Date(2026, 9, 19, 9, 0).getTime(), now)).toBe('Mon 09:00');
    expect(fireTime(new Date(2026, 9, 20, 9, 0).getTime(), now)).toBe('20 Oct 09:00');
  });
  test('cronRing: the elapsed fraction of the current period', () => {
    const next = 1_000_000;
    expect(cronRing(next, next + 600_000, next - 150_000)).toBeCloseTo(0.75);
    expect(cronRing(next, next + 600_000, next)).toBe(1);
    expect(cronRing(next, next + 600_000, next - 900_000)).toBe(0);
    // A one-shot: only its last hour fills the ring.
    expect(cronRing(next, null, next - 30 * 60_000)).toBeCloseTo(0.5);
    expect(cronRing(next, null, next - 5 * 3600_000)).toBe(0);
  });
});

describe('session picker order', () => {
  test('sessions with background work or recent items first, then the others; terminals without Claude left out', () => {
    const term = (id: string, over: object = {}) => ({ id, session: { sessionId: id }, ...over }) as never;
    const list = [
      term('a'),
      term('b', { work: { entries: [{ id: 'x' }], crons: [] } }),
      term('c', { session: null, work: { entries: [{ id: 'y' }], crons: [] } }),
      term('d', { recent: [{ id: 'r' }] }),
      term('e', { work: { entries: [], crons: [{ id: 'k' }] } }),
      term('f', { work: { entries: [], crons: [] }, recent: [] })
    ];
    expect(orderSessions(list).map((x: { id: string }) => x.id)).toEqual(['b', 'd', 'e', 'a', 'f']);
  });
});
