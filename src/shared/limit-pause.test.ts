import { describe, expect, test } from 'vitest';
import type { SessionInfo, Usage } from './session';
import {
  CHECK_MS, EXPIRE_AFTER_RESET_MS, MAX_WAIT_MS, claudeVersion, compareVersions, confirmLimitPause, endLimitPause, isLimitPaused, limitEvidence,
  openLimitPause, sweepLimitPause, waitsAtLimit
} from './limit-pause';

const now = Date.UTC(2026, 9, 31, 12);
const H = 3_600_000;
const sec = (ms: number) => Math.round(ms / 1000);

const usage = (p5: number | null, r5Sec: number, p7: number | null = null, r7Sec = 0): Usage => ({
  fiveHour: p5 === null ? null : { pct: p5, resetsAt: r5Sec },
  sevenDay: p7 === null ? null : { pct: p7, resetsAt: r7Sec },
  updatedAt: now
});

const session = (extra: Partial<SessionInfo> = {}): SessionInfo => ({
  sessionId: 'x', state: 'error', errorReason: 'rate_limit', title: null, activity: null, contextPct: null, unread: false,
  updatedAt: now - 1000, ...extra
});

const opts = (over: Partial<Parameters<typeof openLimitPause>[1]> = {}) => ({
  usages: [] as (Usage | null)[], message: null as unknown, version: '2.1.316' as string | null, autoContinue: true, ...over
});

describe('claudeVersion', () => {
  test('reads the version from the foreground process name', () => {
    expect(claudeVersion('2.1.316')).toBe('2.1.316');
    expect(claudeVersion('/opt/x/2.1.316')).toBe('2.1.316');
    expect(claudeVersion('-2.1.316')).toBe('2.1.316');
  });
  test('anything else is not a version', () => {
    for (const v of ['-zsh', 'claude', 'node', '', undefined, null]) expect(claudeVersion(v)).toBeNull();
  });
});

describe('waitsAtLimit', () => {
  test('Claude Code waits at the limit from 2.1.234; unknown counts as waiting', () => {
    expect(waitsAtLimit(null)).toBe(true);
    expect(waitsAtLimit('2.1.234')).toBe(true);
    expect(waitsAtLimit('2.1.233')).toBe(false);
    expect(waitsAtLimit('2.1.99')).toBe(false);
    expect(waitsAtLimit('2.2.0')).toBe(true);
    expect(waitsAtLimit('3.0')).toBe(true);
  });
});

describe('compareVersions', () => {
  test('numeric part by part; a missing part is 0', () => {
    expect(compareVersions('2.1.4', '2.1.320')).toBeLessThan(0);
    expect(compareVersions('2.2', '2.1.320')).toBeGreaterThan(0);
    expect(compareVersions('2.1', '2.1.0')).toBe(0);
    expect(compareVersions('2.1.320', '2.1.320')).toBe(0);
  });
});

describe('limitEvidence', () => {
  test('a window at 100 % with a reset ahead', () => {
    expect(limitEvidence([usage(100, sec(now + 2 * H))], null, now)).toBe(sec(now + 2 * H) * 1000);
  });
  test('both windows at 100 %: the later reset', () => {
    expect(limitEvidence([usage(100, sec(now + 2 * H), 100, sec(now + 50 * H))], null, now)).toBe(sec(now + 50 * H) * 1000);
  });
  test('looks at every usage given', () => {
    expect(limitEvidence([usage(10, sec(now + H)), usage(100, sec(now + 3 * H))], null, now)).toBe(sec(now + 3 * H) * 1000);
  });
  test('99 % or a reset in the past is no evidence', () => {
    expect(limitEvidence([usage(99, sec(now + 2 * H))], null, now)).toBeNull();
    expect(limitEvidence([usage(100, sec(now - H))], null, now)).toBeNull();
  });
  test('the message names the window when no usage is at 100 %', () => {
    const u = usage(40, sec(now + 2 * H), 20, sec(now + 50 * H));
    expect(limitEvidence([u], "You've hit your session limit · resets 3:45pm", now)).toBe(sec(now + 2 * H) * 1000);
    expect(limitEvidence([u], "You've hit your weekly limit · resets Mon 12:00am", now)).toBe(sec(now + 50 * H) * 1000);
  });
  test('an API rate-limit error is not a usage limit', () => {
    expect(limitEvidence([usage(40, sec(now + 2 * H))], 'API Error: Rate limit reached', now)).toBeNull();
  });
  test('the session wording with no five-hour window is no evidence', () => {
    expect(limitEvidence([usage(null, 0, 20, sec(now + 50 * H))], "You've hit your session limit", now)).toBeNull();
    expect(limitEvidence([], "You've hit your session limit", now)).toBeNull();
  });
});

describe('openLimitPause', () => {
  test('preconditions: otherwise the same object comes back', () => {
    const e = opts({ usages: [usage(100, sec(now + 2 * H))] });
    const cases: SessionInfo[] = [
      session({ state: 'running' }),
      session({ errorReason: 'overloaded' }),
      session({ limitPause: { since: now - 5, resetsAt: null } })
    ];
    for (const s of cases) expect(openLimitPause(s, e, now)).toBe(s);
    const s = session();
    expect(openLimitPause(s, { ...e, version: '2.1.200' }, now)).toBe(s);
    expect(openLimitPause(s, { ...e, autoContinue: false }, now)).toBe(s);
  });
  test('evidence two hours away: paused until then', () => {
    const r = sec(now + 2 * H) * 1000;
    const out = openLimitPause(session(), opts({ usages: [usage(100, sec(now + 2 * H))] }), now);
    expect(out.limitPause).toEqual({ since: now, resetsAt: r });
  });
  test('a pause opens quiet: paused or checking, the row is not unread (it needs nothing yet)', () => {
    const e = opts({ usages: [usage(100, sec(now + 2 * H))] });
    expect(openLimitPause(session({ unread: true }), e, now).unread).toBe(false);
    const checking = openLimitPause(session({ unread: true }), opts(), now);
    expect(checking.unread).toBe(false);
    // Ending without a continuation brings it back: unconfirmed, expired.
    expect(sweepLimitPause(checking, now + CHECK_MS + 1).unread).toBe(true);
    const paused = openLimitPause(session({ unread: true }), e, now);
    expect(sweepLimitPause(paused, paused.limitPause!.resetsAt! + EXPIRE_AFTER_RESET_MS + 1).unread).toBe(true);
  });
  test('evidence further than MAX_WAIT_MS: ends as unconfirmed and shows as unread', () => {
    const out = openLimitPause(session(), opts({ usages: [usage(100, sec(now + 30 * H))] }), now);
    expect(MAX_WAIT_MS).toBeLessThan(30 * H);
    expect(out.limitPause).toEqual({ since: now, resetsAt: null, over: 'unconfirmed' });
    expect(out.unread).toBe(true);
  });
  test('no evidence yet: checking', () => {
    const out = openLimitPause(session(), opts(), now);
    expect(out.limitPause).toEqual({ since: now, resetsAt: null });
    expect(isLimitPaused(out)).toBe(true);
  });
});

describe('confirmLimitPause', () => {
  const checking = () => session({ limitPause: { since: now, resetsAt: null } });
  test('a status line inside the check window arms the pause', () => {
    const out = confirmLimitPause(checking(), [usage(100, sec(now + 4_000 + 2 * H))], now + 4_000);
    expect(out?.limitPause?.resetsAt).toBe(sec(now + 4_000 + 2 * H) * 1000);
    expect(out?.limitPause?.over).toBeUndefined();
  });
  test('a late status line never arms', () => {
    const s = checking();
    expect(confirmLimitPause(s, [usage(100, sec(now + 6_000 + 2 * H))], now + 6_000)).toBe(s);
  });
  test('only while checking', () => {
    const s = session({ limitPause: { since: now, resetsAt: now + H } });
    expect(confirmLimitPause(s, [usage(100, sec(now + 2 * H))], now + 1000)).toBe(s);
    const none = session();
    expect(confirmLimitPause(none, [usage(100, sec(now + 2 * H))], now + 1000)).toBe(none);
    expect(confirmLimitPause(null, [], now)).toBeNull();
  });
  test('a reset further than MAX_WAIT_MS ends as unconfirmed', () => {
    const out = confirmLimitPause(checking(), [usage(100, sec(now + 1000 + 30 * H))], now + 1000);
    expect(out?.limitPause?.over).toBe('unconfirmed');
    expect(out?.unread).toBe(true);
  });
  test('no evidence leaves it checking', () => {
    const s = checking();
    expect(confirmLimitPause(s, [usage(50, sec(now + 2 * H))], now + 1000)).toBe(s);
  });
});

describe('sweepLimitPause', () => {
  test('checking past CHECK_MS becomes unconfirmed', () => {
    const s = session({ limitPause: { since: now, resetsAt: null } });
    expect(sweepLimitPause(s, now + CHECK_MS)).toBe(s);
    const out = sweepLimitPause(s, now + CHECK_MS + 1);
    expect(out.limitPause?.over).toBe('unconfirmed');
    expect(out.unread).toBe(true);
  });
  test('paused past the reset plus the grace expires', () => {
    const resetsAt = now + H;
    const s = session({ limitPause: { since: now, resetsAt } });
    expect(sweepLimitPause(s, resetsAt + EXPIRE_AFTER_RESET_MS)).toBe(s);
    const out = sweepLimitPause(s, resetsAt + EXPIRE_AFTER_RESET_MS + 1);
    expect(out.limitPause).toEqual({ since: now, resetsAt, over: 'expired' });
    expect(out.unread).toBe(true);
  });
  test('an ended pause and a session without one stay as they are', () => {
    const ended = session({ limitPause: { since: now, resetsAt: now + H, over: 'cancelled' } });
    expect(sweepLimitPause(ended, now + 100 * H)).toBe(ended);
    const none = session();
    expect(sweepLimitPause(none, now + 100 * H)).toBe(none);
  });
});

describe('endLimitPause', () => {
  test('keeps since and resetsAt; a session without a pause gets one from updatedAt', () => {
    const s = session({ limitPause: { since: now, resetsAt: now + H } });
    expect(endLimitPause(s, 'stale').limitPause).toEqual({ since: now, resetsAt: now + H, over: 'stale' });
    expect(s.limitPause?.over).toBeUndefined();
    const out = endLimitPause(session(), 'disabled');
    expect(out.limitPause).toEqual({ since: now - 1000, resetsAt: null, over: 'disabled' });
    expect(out.unread).toBe(true);
  });
});

describe('isLimitPaused', () => {
  test('checking and paused count; ended, other errors and null do not', () => {
    expect(isLimitPaused(session({ limitPause: { since: now, resetsAt: null } }))).toBe(true);
    expect(isLimitPaused(session({ limitPause: { since: now, resetsAt: now + H } }))).toBe(true);
    expect(isLimitPaused(session({ limitPause: { since: now, resetsAt: now + H, over: 'expired' } }))).toBe(false);
    expect(isLimitPaused(session({ errorReason: 'overloaded', limitPause: { since: now, resetsAt: null } }))).toBe(false);
    expect(isLimitPaused(session())).toBe(false);
    expect(isLimitPaused(null)).toBe(false);
  });
});
