import { describe, expect, test } from 'vitest';
import {
  ARM_MS, GRACE_MS, MAX_ENTRIES, SEND_GAP_MS, TYPING_QUIET_MS, cleanPromptText, clashOf, decide, limitResetAt, minuteOf,
  nextFreeMinute, parseSchedules, promptPaste, pruneSchedules, type DecideCtx, type ScheduledPrompt
} from './scheduled-prompts';
import type { TerminalInfo } from './protocol';
import type { SessionInfo, Usage } from './session';

const MIN = 60_000;
const T0 = Date.UTC(2026, 9, 25, 12, 0);

const p = (o: Partial<ScheduledPrompt> = {}): ScheduledPrompt => ({
  id: 'p1', terminalId: 't1', sessionId: 's1', projectRoot: '/w/proj', title: 'api', text: 'run the tests', at: T0,
  ifBusy: 'wait', createdAt: T0 - 60 * MIN, status: 'pending', ...o
});
const session = (o: Partial<SessionInfo> = {}): SessionInfo => ({
  sessionId: 's1', state: 'idle', title: null, activity: null, contextPct: null, unread: false, updatedAt: 0, ...o
});
const term = (o: Partial<TerminalInfo> = {}, s: Partial<SessionInfo> | null = {}): TerminalInfo => ({
  id: 't1', projectRoot: '/w/proj', cwd: '/w/proj', title: 'api', name: null, color: '#fff', foreground: '2.1.300',
  createdAt: 0, session: s === null ? null : session(s), configDir: '/u/.claude', ...o
});
const ctx = (o: Partial<DecideCtx> = {}): DecideCtx => ({
  term: term(), usage: null, bracketed: true, draft: false, lastInputAt: 0, lastSentAt: 0, clients: true, ...o
});
const usage = (pct: number, resetsAtMs: number, week?: [number, number]): Usage => ({
  fiveHour: { pct, resetsAt: resetsAtMs / 1000 }, sevenDay: week ? { pct: week[0], resetsAt: week[1] / 1000 } : null, updatedAt: 0
});

describe('cleanPromptText', () => {
  test('keeps newlines and tabs, drops other control characters and ESC, normalizes CRLF, trims the end', () => {
    expect(cleanPromptText('a\r\nb\tc\x1b[31m\x07\x00 \n\n')).toBe('a\nb\tc[31m');
  });
  test('cuts at the cap without splitting a surrogate pair', () => {
    const s = 'x'.repeat(31_999) + '😀';
    expect(cleanPromptText(s).length).toBe(31_999);
  });
});

describe('minutes and clashes', () => {
  test('minuteOf floors to the minute', () => {
    expect(minuteOf(T0 + 59_999)).toBe(T0);
  });
  test('a clash is another live prompt of the same terminal in the same minute', () => {
    const list = [p({ id: 'a', at: T0 }), p({ id: 'b', at: T0 + 5 * MIN, status: 'sent' }), p({ id: 'c', at: T0 + 10 * MIN, terminalId: 't2' })];
    expect(clashOf(list, 't1', T0 + 30_000)?.id).toBe('a');
    expect(clashOf(list, 't1', T0 + 30_000, 'a')).toBeNull();
    expect(clashOf(list, 't1', T0 + 5 * MIN)).toBeNull();
    expect(clashOf(list, 't1', T0 + 10 * MIN)).toBeNull();
    expect(clashOf([p({ id: 'x', status: 'armed' })], 't1', T0)?.id).toBe('x');
  });
  test('nextFreeMinute steps until free', () => {
    const list = [p({ id: 'a', at: T0 }), p({ id: 'b', at: T0 + 5 * MIN })];
    expect(nextFreeMinute(list, 't1', T0)).toBe(T0 + 10 * MIN);
    expect(nextFreeMinute(list, 't1', T0 + 2 * MIN)).toBe(T0 + 2 * MIN);
    expect(nextFreeMinute(list, 't1', T0, MIN)).toBe(T0 + MIN);
  });
});

describe('limitResetAt', () => {
  test('a window at 100 % with its reset ahead gives the latest such reset', () => {
    expect(limitResetAt(usage(100, T0 + 30 * MIN), T0)).toBe(T0 + 30 * MIN);
    expect(limitResetAt(usage(100, T0 + 30 * MIN, [100, T0 + 3000 * MIN]), T0)).toBe(T0 + 3000 * MIN);
  });
  test('under 100 %, a reset already past, or no usage: null', () => {
    expect(limitResetAt(usage(99, T0 + 30 * MIN), T0)).toBeNull();
    expect(limitResetAt(usage(100, T0 - MIN), T0)).toBeNull();
    expect(limitResetAt(null, T0)).toBeNull();
  });
});

describe('decide', () => {
  test('not yet due: nothing', () => {
    expect(decide(p(), ctx(), T0 - 1)).toEqual({ kind: 'none' });
  });
  test('free at its time with an app connected: arm; with no app: send', () => {
    expect(decide(p(), ctx(), T0)).toEqual({ kind: 'arm' });
    expect(decide(p(), ctx({ clients: false }), T0)).toEqual({ kind: 'send' });
  });
  test('armed: sends at armedUntil, stays armed before it', () => {
    const armed = p({ status: 'armed', armedUntil: T0 + ARM_MS, dueSince: T0 });
    expect(decide(armed, ctx(), T0 + 1000)).toEqual({ kind: 'none' });
    expect(decide(armed, ctx(), T0 + ARM_MS)).toEqual({ kind: 'send' });
  });
  test('a fired prompt sends as soon as it is free, without arming', () => {
    expect(decide(p({ fired: true, at: T0 + 30 * MIN }), ctx(), T0)).toEqual({ kind: 'send' });
  });
  test('never seen due and past the grace: missed asleep', () => {
    expect(decide(p(), ctx(), T0 + GRACE_MS + 1)).toEqual({ kind: 'missed', reason: 'asleep' });
    expect(decide(p({ dueSince: T0 }), ctx({ term: term({}, { state: 'running' }) }), T0 + GRACE_MS + 1)).toEqual({ kind: 'wait', reason: 'busy' });
  });
  test('no terminal: waits for a resume, then missed closed', () => {
    expect(decide(p(), ctx({ term: null }), T0)).toEqual({ kind: 'wait', reason: 'closed' });
    expect(decide(p({ dueSince: T0 }), ctx({ term: null }), T0 + GRACE_MS + 1)).toEqual({ kind: 'missed', reason: 'closed' });
  });
  test('usage at its limit moves the prompt (wait) or skips it (skip); force once sends', () => {
    const u = usage(100, T0 + 40 * MIN);
    expect(decide(p(), ctx({ usage: u }), T0)).toEqual({ kind: 'move', to: T0 + 41 * MIN });
    expect(decide(p({ ifBusy: 'skip' }), ctx({ usage: u }), T0)).toEqual({ kind: 'skip', reason: 'limit' });
    expect(decide(p({ forceUsage: true }), ctx({ usage: u }), T0)).toEqual({ kind: 'arm' });
  });
  test('Claude not in front: waits, then missed not-claude', () => {
    const shell = ctx({ term: term({ foreground: 'zsh' }) });
    expect(decide(p(), shell, T0)).toEqual({ kind: 'wait', reason: 'not-claude' });
    expect(decide(p({ dueSince: T0 }), shell, T0 + GRACE_MS + 1)).toEqual({ kind: 'missed', reason: 'not-claude' });
    expect(decide(p(), ctx({ term: term({}, null) }), T0)).toEqual({ kind: 'wait', reason: 'not-claude' });
    expect(decide(p(), ctx({ term: term({ foreground: 'vim' }) }), T0)).toEqual({ kind: 'wait', reason: 'not-claude' });
  });
  test('busy gates in order: waiting, busy, draft, typing, paste off, a send just made', () => {
    expect(decide(p(), ctx({ term: term({}, { state: 'waiting', waitingFor: 'permission' }) }), T0)).toEqual({ kind: 'wait', reason: 'waiting' });
    expect(decide(p(), ctx({ term: term({}, { state: 'running' }) }), T0)).toEqual({ kind: 'wait', reason: 'busy' });
    expect(decide(p(), ctx({ draft: true }), T0)).toEqual({ kind: 'wait', reason: 'draft' });
    expect(decide(p(), ctx({ lastInputAt: T0 - 1000 }), T0)).toEqual({ kind: 'wait', reason: 'typing' });
    expect(decide(p(), ctx({ lastInputAt: T0 - TYPING_QUIET_MS }), T0)).toEqual({ kind: 'arm' });
    expect(decide(p(), ctx({ bracketed: false }), T0)).toEqual({ kind: 'wait', reason: 'busy' });
    expect(decide(p(), ctx({ lastSentAt: T0 - 1000 }), T0)).toEqual({ kind: 'wait', reason: 'busy' });
    expect(decide(p(), ctx({ lastSentAt: T0 - SEND_GAP_MS }), T0)).toEqual({ kind: 'arm' });
  });
  test('done, idle with input notice and error states are free', () => {
    expect(decide(p(), ctx({ term: term({}, { state: 'done' }) }), T0)).toEqual({ kind: 'arm' });
    expect(decide(p(), ctx({ term: term({}, { state: 'waiting', waitingFor: 'input' }) }), T0)).toEqual({ kind: 'arm' });
    expect(decide(p(), ctx({ term: term({}, { state: 'error' }) }), T0)).toEqual({ kind: 'arm' });
  });
  test('skip: a busy gate skips it at once, but typing only waits', () => {
    const skip = p({ ifBusy: 'skip' });
    expect(decide(skip, ctx({ term: term({}, { state: 'running' }) }), T0)).toEqual({ kind: 'skip', reason: 'busy' });
    expect(decide(skip, ctx({ draft: true }), T0)).toEqual({ kind: 'skip', reason: 'draft' });
    expect(decide(skip, ctx({ lastInputAt: T0 - 1000 }), T0)).toEqual({ kind: 'wait', reason: 'typing' });
    expect(decide(skip, ctx({ lastSentAt: T0 - 1000 }), T0)).toEqual({ kind: 'wait', reason: 'busy' });
  });
  test('a paused session (usage limit, Claude Code continues itself) is busy; an ended pause is free', () => {
    const paused = term({}, { state: 'error', errorReason: 'rate_limit', limitPause: { since: T0 - 1000, resetsAt: T0 + 40 * MIN } });
    expect(decide(p(), ctx({ term: paused }), T0)).toEqual({ kind: 'wait', reason: 'busy' });
    expect(decide(p({ ifBusy: 'skip' }), ctx({ term: paused }), T0)).toEqual({ kind: 'skip', reason: 'busy' });
    const over = term({}, { state: 'error', errorReason: 'rate_limit', limitPause: { since: T0 - 1000, resetsAt: null, over: 'expired' } });
    expect(decide(p(), ctx({ term: over }), T0)).toEqual({ kind: 'arm' });
  });
  test('an armed prompt whose gate closes goes back to waiting', () => {
    expect(decide(p({ status: 'armed', armedUntil: T0 + ARM_MS, dueSince: T0 }), ctx({ lastInputAt: T0 + 500 }), T0 + 1000)).toEqual({ kind: 'wait', reason: 'typing' });
  });
  test('#3 a fired prompt is never skipped: it waits for Claude like a "wait" one', () => {
    const fired = p({ ifBusy: 'skip', fired: true, at: T0 + 60 * MIN, dueSince: T0 });
    expect(decide(fired, ctx({ term: term({}, { state: 'running' }) }), T0)).toEqual({ kind: 'wait', reason: 'busy' });
    expect(decide(fired, ctx({ usage: usage(100, T0 + 40 * MIN) }), T0)).toEqual({ kind: 'move', to: T0 + 41 * MIN });
  });
  test('#9 Send Now goes past a draft guess (you asked for it), not past someone typing', () => {
    const fired = p({ fired: true, dueSince: T0 });
    expect(decide(fired, ctx({ draft: true }), T0)).toEqual({ kind: 'send' });
    expect(decide(fired, ctx({ lastInputAt: T0 - 1000 }), T0)).toEqual({ kind: 'wait', reason: 'typing' });
  });
  test('a fired prompt with no terminal is missed GRACE after it was fired', () => {
    const fired = p({ fired: true, at: T0 + 60 * MIN, dueSince: T0 });
    expect(decide(fired, ctx({ term: null }), T0 + GRACE_MS - 1)).toEqual({ kind: 'wait', reason: 'closed' });
    expect(decide(fired, ctx({ term: null }), T0 + GRACE_MS + 1)).toEqual({ kind: 'missed', reason: 'closed' });
  });
  test('finished prompts never act', () => {
    for (const status of ['sent', 'skipped', 'missed'] as const) expect(decide(p({ status }), ctx(), T0)).toEqual({ kind: 'none' });
  });
});

describe('pruneSchedules', () => {
  test('drops sent and skipped after 24 h, missed after 7 days, never live ones', () => {
    const now = T0 + 8 * 24 * 60 * MIN;
    const list = [
      p({ id: 'live', at: T0 }), p({ id: 'sent-old', status: 'sent', doneAt: now - 25 * 60 * MIN }), p({ id: 'sent-new', status: 'sent', doneAt: now - 60 * MIN }),
      p({ id: 'missed-old', status: 'missed', doneAt: now - 8 * 24 * 60 * MIN }), p({ id: 'missed-new', status: 'missed', doneAt: now - 24 * 60 * MIN })
    ];
    expect(pruneSchedules(list, now).map((x) => x.id)).toEqual(['live', 'sent-new', 'missed-new']);
  });
  test('over the cap, the oldest finished go first', () => {
    const list = [p({ id: 'live' }), ...Array.from({ length: MAX_ENTRIES }, (_, i) => p({ id: `s${i}`, status: 'sent', doneAt: T0 + i }))];
    const out = pruneSchedules(list, T0 + MAX_ENTRIES);
    expect(out).toHaveLength(MAX_ENTRIES);
    expect(out.some((x) => x.id === 'live')).toBe(true);
    expect(out.some((x) => x.id === 's0')).toBe(false);
  });
});

describe('promptPaste', () => {
  test('one bracketed paste, newlines as \\r', () => {
    expect(promptPaste('a\nb')).toEqual(['\x1b[200~', 'a\rb', '\x1b[201~']);
  });
});

describe('parseSchedules', () => {
  test('keeps well-formed entries, drops the rest', () => {
    const raw = { v: 1, list: [p(), { ...p({ id: 'bad' }), at: 'soon' }, { nope: true }, p({ id: 'p2', text: '' })] };
    expect(parseSchedules(raw).map((x) => x.id)).toEqual(['p1']);
    expect(parseSchedules(null)).toEqual([]);
    expect(parseSchedules({ v: 2, list: [p()] })).toEqual([]);
  });
  test('a row saved by an older atelierd with reason limit-hit still parses and fires at its time', () => {
    const old = p({ reason: 'limit-hit', limitRetried: true, movedFrom: T0 - 90 * MIN });
    const [row] = parseSchedules({ v: 1, list: [old] });
    expect(row).toMatchObject({ reason: 'limit-hit', limitRetried: true });
    expect(decide(row!, ctx(), T0)).toEqual({ kind: 'arm' });
  });
});
