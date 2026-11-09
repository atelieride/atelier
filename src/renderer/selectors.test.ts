import { describe, expect, test } from 'vitest';
import { counts, formatReset, meterUsage, sessionSubtitle, sessionTotals, shownState, shownStateLabel, splitTerminals, usageParts } from './selectors';
import { whenOf } from './schedule-view';
import type { TerminalInfo } from '@shared/protocol';
import type { BackgroundWork } from '@shared/background';
import type { SessionInfo, SessionState, Usage, UsageEntry } from '@shared/session';

const t = (id: string, state?: SessionState, createdAt = 0): TerminalInfo => ({
  id, projectRoot: '/p', cwd: '/p', title: id, name: null, color: '#fff', foreground: 'zsh', createdAt,
  session: state ? { sessionId: id, state, title: null, activity: null, contextPct: null, unread: false, updatedAt: 0 } : null
});

test('splitTerminals separates sessions and plain terminals keeping the order', () => {
  const r = splitTerminals([t('a', undefined, 1), t('b', 'running', 2), t('c', 'done', 3), t('d', undefined, 4)]);
  expect(r.sessions.map((x) => x.id)).toEqual(['b', 'c']);
  expect(r.shells.map((x) => x.id)).toEqual(['a', 'd']);
});
test('counts', () => {
  const list = [t('a', 'running'), t('b', 'waiting'), t('c', 'waiting'), t('d', 'done')];
  expect(counts(list)).toEqual({ waiting: 2, running: 1 });
});
const bg = (items: BackgroundWork['items'], counting = true): BackgroundWork => ({ counting, agents: 0, shells: 0, monitors: 0, other: 0, idle: 0, items, crons: [], entries: [], nextChange: null });
test('counts: a session working in the background is running', () => {
  const a = { ...t('a', 'done'), work: bg([{ kind: 'agent', label: 'x', counted: true }]) };
  expect(counts([a, t('b', 'running')])).toEqual({ waiting: 0, running: 2 });
  expect(counts([{ ...t('c', 'done'), work: bg([], false) }])).toEqual({ waiting: 0, running: 0 });
});
test('sessionSubtitle while background work counts', () => {
  const L = { idle: 'ready', running: 'working', waiting: 'waiting for you', done: 'done', error: 'error' };
  const sess = (state: SessionState, extra: Partial<SessionInfo> | null) => ({ ...t('a', state).session!, ...(extra ?? {}) });
  const done = sess('done', null);
  const w = bg([{ kind: 'shell', label: 'npm run e2e', counted: false }, { kind: 'agent', label: 'Full unit suite', counted: true }]);
  expect(sessionSubtitle(done, L, undefined, w)).toEqual({ text: 'In background · Full unit suite', tip: null });
  expect(sessionSubtitle(done, L, undefined, bg([{ kind: 'agent', label: '', counted: true }]))).toEqual({ text: 'In background', tip: null });
  // Not counting, or the main agent waiting: unchanged.
  expect(sessionSubtitle(done, L, undefined, bg([], false))).toBeNull();
  expect(sessionSubtitle(sess('waiting', { waitingFor: 'question', activity: 'x' }), L, undefined, bg([]))?.text).toBe('Has a question');
});
test('formatReset', () => {
  const now = 1_000_000;
  expect(formatReset(now + 45 * 60, now)).toBe('45m');
  expect(formatReset(now + 2 * 3600 + 14 * 60, now)).toBe('2h14m');
  expect(formatReset(now + 3 * 86400 + 4 * 3600, now)).toBe('3d4h');
  expect(formatReset(now - 10, now)).toBe('');
});

test('formatReset beyond 7 days (anomalous data) → empty', () => {
  expect(formatReset(1_000_000 + 30 * 86400, 1_000_000)).toBe('');
});

import { displayCommand } from './selectors';
test('displayCommand: Claude\'s native binary shows up as its version → "claude"', () => {
  expect(displayCommand(t('a'))).toBe('zsh');
  expect(displayCommand({ ...t('b'), foreground: '2.1.296' })).toBe('claude');
  expect(displayCommand({ ...t('c', 'running'), foreground: 'node' })).toBe('claude');
  expect(displayCommand({ ...t('d'), foreground: 'tmux' })).toBe('tmux');
});

import { resumablesFor } from './selectors';
test('resumablesFor: only the project\'s, most recent first', () => {
  const r = (id: string, projectRoot: string, endedAt: number) => ({ id, projectRoot, cwd: projectRoot, title: id, color: '#fff', sessionId: 's', endedAt });
  expect(resumablesFor([r('a', '/p', 1), r('b', '/altro', 5), r('c', '/p', 9)], '/p').map((x) => x.id)).toEqual(['c', 'a']);
});

test('displayCommand shows the program name, not the path', () => {
  const base = { id: 'x', projectRoot: '/p', cwd: '/p', title: 'T', name: null, color: '#fff', createdAt: 0, session: null };
  expect(displayCommand({ ...base, foreground: '/bin/zsh' })).toBe('zsh');
  expect(displayCommand({ ...base, foreground: '-zsh' })).toBe('zsh');
  expect(displayCommand({ ...base, foreground: 'npm' })).toBe('npm');
});

test('Claude launched with the binary\'s full path stays "claude"', () => {
  const base = { id: 'x', projectRoot: '/p', cwd: '/p', title: 'T', name: null, color: '#fff', createdAt: 0, session: null };
  expect(displayCommand({ ...base, foreground: '/Users/me/.local/share/claude/versions/2.1.296' })).toBe('claude');
});

test('under the session name: the activity; nothing when the session is done, the green icon is enough', () => {
  const L = { idle: 'ready', running: 'working', waiting: 'waiting for you', done: 'done', error: 'error' };
  const sess = (state: SessionState, activity: string | null) => ({ ...t('a', state).session!, activity });
  expect(sessionSubtitle(sess('done', null), L)).toBeNull();
  expect(sessionSubtitle(sess('running', 'Bash: npm test'), L)).toEqual({ text: 'Bash: npm test', tip: null });
  // An atelierd without states2: the error's activity as it is, a waiting session's activity as before.
  expect(sessionSubtitle(sess('error', 'rate limit'), L)).toEqual({ text: 'rate limit', tip: null });
  expect(sessionSubtitle(sess('waiting', 'waiting: Bash npm test'), L)?.text).toBe('waiting: Bash npm test');
  // No more "ready": an idle session's row shows when its last message was (lastMessageLine).
  expect(sessionSubtitle(sess('idle', null), L)).toBeNull();
});

test('states2 subtitles: what Claude waits for, compacting, error labels with the raw code as tooltip', () => {
  const L = { idle: 'ready', running: 'working', waiting: 'waiting for you', done: 'done', error: 'error' };
  const sess = (state: SessionState, extra: Partial<SessionInfo>) => ({ ...t('a', state).session!, ...extra });
  expect(sessionSubtitle(sess('waiting', { waitingFor: 'permission', activity: 'waiting: Bash npm test' }), L)).toEqual({ text: 'Needs permission: Bash npm test', tip: null });
  expect(sessionSubtitle(sess('waiting', { waitingFor: 'permission', activity: 'waiting for you' }), L)?.text).toBe('Needs permission');
  expect(sessionSubtitle(sess('waiting', { waitingFor: 'question', activity: 'waiting: question' }), L)?.text).toBe('Has a question');
  expect(sessionSubtitle(sess('running', { compacting: true, activity: 'Bash: npm test' }), L)).toEqual({ text: 'Compacting…', tip: null });
  expect(sessionSubtitle(sess('idle', { compacting: true }), L)).toEqual({ text: 'Compacting…', tip: null });
  expect(sessionSubtitle(sess('error', { errorReason: 'rate_limit', activity: 'rate_limit' }), L)).toEqual({ text: 'Rate limit', tip: 'Claude Code error: rate_limit' });
  expect(sessionSubtitle(sess('error', { errorReason: 'overloaded', activity: 'overloaded' }), L)?.text).toBe('Overloaded');
  // The idle notice: the prompt is free, nothing to say (the row shows the last message time).
  expect(sessionSubtitle(sess('idle', { waitingFor: 'input' }), L)).toBeNull();
  expect(sessionSubtitle(sess('done', { waitingFor: 'input', unread: true }), L)).toBeNull();
});

// Claude Code waits at a usage limit and goes on by itself when it resets.
describe('a session paused at its usage limit', () => {
  const L = { idle: 'ready', running: 'working', waiting: 'waiting for you', done: 'done', error: 'error' };
  const now = new Date(2026, 9, 31, 13, 0).getTime();
  const at1545 = new Date(2026, 9, 31, 15, 45).getTime();
  const tomorrow = new Date(2026, 10, 1, 1, 30).getTime();
  const limited = (limitPause?: SessionInfo['limitPause']): TerminalInfo => {
    const x = t('a', 'error');
    return { ...x, session: { ...x.session!, errorReason: 'rate_limit', activity: 'rate_limit', ...(limitPause ? { limitPause } : {}) } };
  };
  const sub = (x: TerminalInfo) => sessionSubtitle(x.session!, L, undefined, undefined, now);
  const pausedTip = 'Claude Code continues this task by itself when your usage limit resets. Esc in the session cancels.';

  test('shownState: paused (checking included) draws idle; an ended pause or none stays an error; the rest as effectiveState', () => {
    expect(shownState(limited({ since: 1, resetsAt: at1545 }))).toBe('idle');
    expect(shownState(limited({ since: 1, resetsAt: null }))).toBe('idle');
    expect(shownState(limited({ since: 1, resetsAt: at1545, over: 'expired' }))).toBe('error');
    expect(shownState(t('b', 'running'))).toBe('running');
    expect(shownState({ ...t('c', 'done'), work: bg([{ kind: 'agent', label: 'x', counted: true }]) })).toBe('running');
    expect(shownState(t('d'))).toBeNull();
  });

  test('the subtitle says when it continues, with the day when that is not today; "Usage limit" while atelierd checks', () => {
    expect(sub(limited({ since: 1, resetsAt: at1545 }))).toEqual({ text: 'Usage limit · continues at 15:45', tip: pausedTip });
    expect(sub(limited({ since: 1, resetsAt: tomorrow }))).toEqual({ text: 'Usage limit · continues tomorrow at 01:30', tip: pausedTip });
    const tuesday = new Date(2026, 10, 3, 9, 0).getTime();
    expect(sub(limited({ since: 1, resetsAt: tuesday }))?.text).toBe(`Usage limit · continues ${whenOf(tuesday, now)}`);
    expect(sub(limited({ since: 1, resetsAt: tuesday }))?.text).toBe('Usage limit · continues Tue 3 Nov at 09:00');
    expect(sub(limited({ since: 1, resetsAt: null }))).toEqual({ text: 'Usage limit', tip: pausedTip });
  });

  test('a reset already past (Claude Code continues shortly after it), just after midnight: the clock only, never yesterday\'s date', () => {
    const late = new Date(2026, 9, 31, 23, 58).getTime();
    const after = sessionSubtitle(limited({ since: 1, resetsAt: late }).session!, L, undefined, undefined, new Date(2026, 10, 1, 0, 3).getTime());
    expect(after?.text).toBe('Usage limit · continues at 23:58');
  });

  test('the state in words beside a badge: "Usage limit" while paused (never "error"); otherwise the effective state\'s label', () => {
    expect(shownStateLabel(limited({ since: 1, resetsAt: at1545 }))).toBe('Usage limit');
    expect(shownStateLabel(limited({ since: 1, resetsAt: null }))).toBe('Usage limit');
    expect(shownStateLabel(limited({ since: 1, resetsAt: at1545, over: 'expired' }))).toBe('error');
    expect(shownStateLabel(limited())).toBe('error');
    expect(shownStateLabel({ ...t('c', 'done'), work: bg([{ kind: 'agent', label: 'x', counted: true }]) })).toBe('working');
    expect(shownStateLabel(t('d'))).toBeNull();
  });

  test('an ended pause: stale asks for Enter; any other end is today\'s "Rate limit"', () => {
    expect(sub(limited({ since: 1, resetsAt: at1545, over: 'stale' }))).toEqual({
      text: 'Limit reset · press Enter to continue', tip: 'Your usage limit reset while the computer slept: Claude Code waits for Enter in the session.'
    });
    expect(sub(limited({ since: 1, resetsAt: at1545, over: 'expired' }))).toEqual({ text: 'Rate limit', tip: 'Claude Code error: rate_limit' });
  });

  test('an older atelierd (no pause on the session): today\'s error everywhere', () => {
    expect(shownState(limited())).toBe('error');
    expect(sub(limited())).toEqual({ text: 'Rate limit', tip: 'Claude Code error: rate_limit' });
  });
});

test('waiting count ignores the idle notice', () => {
  const w = (id: string, state: SessionState, waitingFor: 'permission' | 'question' | 'input') => ({ ...t(id, state), session: { ...t(id, state).session!, waitingFor } });
  expect(counts([w('a', 'waiting', 'question'), w('b', 'waiting', 'input'), w('c', 'idle', 'input'), t('d', 'running')])).toEqual({ waiting: 1, running: 1 });
});

test('session totals: readable +/− lines and cost', () => {
  expect(sessionTotals({ usd: 4.126, linesAdded: 120, linesRemoved: 30 })).toEqual({ lines: { added: '+120', removed: '−30' }, usd: '$4.13' });
  expect(sessionTotals({ usd: 0.004, linesAdded: 0, linesRemoved: 0 })).toEqual({ lines: null, usd: '<$0.01' });
  expect(sessionTotals({ usd: 0, linesAdded: 1200, linesRemoved: 0 })).toEqual({ lines: { added: '+1.2k', removed: '−0' }, usd: null });
  expect(sessionTotals({ usd: 312.7, linesAdded: 5, linesRemoved: 15400 })).toEqual({ lines: { added: '+5', removed: '−15k' }, usd: '$313' });
  expect(sessionTotals(null)).toBeNull();
  expect(sessionTotals(undefined)).toBeNull();
});

test('limits at the top right: percentage and time to reset for 5h and also 7d; expired windows excluded', () => {
  const now = 1_000_000;
  const u = { fiveHour: { pct: 42, resetsAt: now + 2 * 3600 + 5 * 60 }, sevenDay: { pct: 18, resetsAt: now + 3 * 86400 + 4 * 3600 }, updatedAt: 0 };
  expect(usageParts(u, now)).toEqual([
    { key: '5h', pct: 42, reset: '2h5m' },
    { key: '7d', pct: 18, reset: '3d4h' }
  ]);
  expect(usageParts({ ...u, fiveHour: { pct: 90, resetsAt: now - 1 } }, now).map((p) => p.key)).toEqual(['7d']);
  expect(usageParts(null, now)).toEqual([]);
});

describe('meterUsage: the meter follows the selected session\'s config dir', () => {
  const now = 1000;
  const u = (pct: number, resetsAt: number, updatedAt = 0): Usage => ({ fiveHour: { pct, resetsAt }, sevenDay: null, updatedAt });
  const main = { configDir: '/Users/me/.claude', usage: u(0, now + 17100, 5) };
  const ops = { configDir: '/Users/me/.claude_ops', usage: u(22, now + 13500, 3) };
  const term = (id: string, configDir?: string): TerminalInfo => ({ ...t(id, configDir ? 'idle' : undefined), ...(configDir ? { configDir } : {}) });
  const terms = [term('a', main.configDir), term('b', ops.configDir), term('sh')];
  /** As the meter calls it: the selected terminal's dir and this window's dirs. */
  const meter = (list: UsageEntry[], ts: TerminalInfo[], selectedId: string | null, lastShown: string | null | undefined) =>
    meterUsage(list, ts.find((x) => x.id === selectedId)?.configDir, ts.map((x) => x.configDir), lastShown, now);

  test('the selected session\'s dir wins, even if another account resets later; a label tells them apart', () => {
    expect(meter([main, ops], terms, 'b', undefined)).toEqual({ usage: ops.usage, configDir: ops.configDir, label: '.claude_ops' });
    expect(meter([main, ops], terms, 'a', ops.configDir)).toEqual({ usage: main.usage, configDir: main.configDir, label: '.claude' });
  });
  test('a selected session whose dir has no data yet hides the meter rather than show another account', () => {
    expect(meter([main], [...terms, term('c', '/Users/me/.claude_work')], 'c', main.configDir)).toEqual({ usage: null, configDir: '/Users/me/.claude_work', label: null });
  });
  test('a plain terminal keeps the dir shown last', () => {
    expect(meter([main, ops], terms, 'sh', ops.configDir).configDir).toBe(ops.configDir);
    expect(meter([main, ops], terms, null, ops.configDir).configDir).toBe(ops.configDir);
  });
  test('nothing shown yet: the latest update among this window\'s dirs, else among all', () => {
    expect(meter([main, ops], terms, 'sh', undefined).configDir).toBe(main.configDir);
    expect(meter([main, ops], [term('b', ops.configDir), term('sh')], 'sh', undefined).configDir).toBe(ops.configDir);
    expect(meter([main, ops], [term('sh')], 'sh', undefined).configDir).toBe(main.configDir);
  });
  test('an older atelierd (one entry, dir unknown): shown as today, no label', () => {
    const all = { configDir: null, usage: main.usage };
    expect(meter([all], [term('sh'), t('x', 'idle')], 'x', undefined)).toEqual({ usage: main.usage, configDir: null, label: null });
    // One named dir next to an unknown one: still a single config dir, no label.
    expect(meter([all, ops], terms, 'b', undefined).label).toBeNull();
  });
  test('expired windows count as no data; one live dir needs no label', () => {
    const old = { configDir: ops.configDir, usage: u(50, now - 1) };
    expect(meter([main, old], terms, 'sh', ops.configDir)).toEqual({ usage: main.usage, configDir: main.configDir, label: null });
    expect(meter([], terms, 'a', undefined).usage).toBeNull();
  });
});

test('displayCommand with no foreground name (a pipeline whose leader exited): empty, no throw', () => {
  const base = { id: 'x', projectRoot: '/p', cwd: '/p', title: 'T', name: null, color: '#fff', createdAt: 0, session: null };
  expect(displayCommand({ ...base, foreground: undefined as unknown as string })).toBe('');
  expect(displayCommand({ ...base, foreground: '' })).toBe('');
});
