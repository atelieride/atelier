import { describe, expect, test } from 'vitest';
import type { TerminalInfo } from '@shared/protocol';
import type { SessionInfo, UsageEntry } from '@shared/session';
import type { ClaudeAccounts } from '@shared/claude-accounts';
import type { Thread, ThreadItem } from '@shared/companion/types';
import { newThread } from '@shared/companion/thread';
import { initPlatform, resetPlatformForTests } from '@shared/platform';
import {
  ASK_AT_GRACE_MS, activeLimit, askAccount, askAtDelay, askHint, askMarked, helpDecideQuestion, limitBody, limitTitle, limitedBy, needsYou, otherAccount,
  livesElsewhere, resetClock, sessionEnded, shownIn, WAKE_STEP_MS, wakeIn
} from './attention';

const session = (o: Partial<SessionInfo> = {}): SessionInfo => ({
  sessionId: 's1', state: 'running', title: null, activity: null, contextPct: null, unread: false, updatedAt: 0, ...o
});
const term = (s: SessionInfo | null, o: Partial<TerminalInfo> = {}): TerminalInfo => ({
  id: 't1', projectRoot: '/p', cwd: '/p', title: 'auth-refactor', name: null, color: '#fff', foreground: 'claude', createdAt: 0, session: s, ...o
});
const UUID = '11111111-1111-4111-8111-111111111111';
const thread = (items: ThreadItem[]): Thread => ({ ...newThread('s1', UUID, 0), items });
const DEFAULT_DIR = '/Users/me/.claude';
const accounts = (...more: { id: string; name: string; dir: string }[]): ClaudeAccounts => ({
  list: [{ id: 'default', name: 'Personal', dir: '', color: 1 }, ...more.map((a, i) => ({ ...a, color: i + 2 }))], newSession: 'default', dismissed: []
});
const WORK = { id: 'work', name: 'Work', dir: '/Users/me/.claude-work' };
const CLIENT = { id: 'client', name: 'Client', dir: '/Users/me/.claude-client' };
const NOW_SEC = 1_800_000_000;
const usage = (dir: string | null, fivePct: number): UsageEntry => ({ configDir: dir, usage: { fiveHour: { pct: fivePct, resetsAt: NOW_SEC + 3600 }, sevenDay: null, updatedAt: NOW_SEC } });

describe('needsYou: the amber card while the bound session waits', () => {
  test('a question: "<title> is asking you", no line (Claude Code names no target for it)', () => {
    expect(needsYou(term(session({ state: 'waiting', waitingFor: 'question', activity: 'waiting: question' })), 's1'))
      .toEqual({ kind: 'question', title: 'auth-refactor is asking you', line: null });
  });
  test('a permission: "<title> needs permission" and what for, the session bar\'s line without "waiting:"', () => {
    expect(needsYou(term(session({ state: 'waiting', waitingFor: 'permission', activity: 'waiting: Bash npm test' })), 's1'))
      .toEqual({ kind: 'permission', title: 'auth-refactor needs permission', line: 'Bash npm test' });
  });
  test('an atelierd without states2 (waiting, kind unknown) reads as asking', () => {
    expect(needsYou(term(session({ state: 'waiting', activity: 'waiting for you' })), 's1')).toMatchObject({ kind: 'question', title: 'auth-refactor is asking you' });
  });
  test('nothing while it works, sits at its prompt (input), stopped on an error, or for another conversation; nothing once ended', () => {
    expect(needsYou(term(session()), 's1')).toBeNull();
    expect(needsYou(term(session({ state: 'idle', waitingFor: 'input' })), 's1')).toBeNull();
    expect(needsYou(term(session({ state: 'error' })), 's1')).toBeNull();
    expect(needsYou(term(session({ state: 'waiting', waitingFor: 'question' })), 'other')).toBeNull();
    expect(needsYou(term(null), 's1')).toBeNull();
    expect(needsYou(undefined, 's1')).toBeNull();
  });
  test('Help me decide asks about what it is asking now (the run finds it in the chat)', () => {
    expect(helpDecideQuestion('auth-refactor')).toBe('Help me decide how to answer what auth-refactor is asking now.');
  });
});

describe('the usage limit item', () => {
  test('its title names the account and the window, when Claude said which', () => {
    expect(limitTitle('Personal', 'five-hour')).toBe('Personal hit its 5-hour limit');
    expect(limitTitle('Work', 'weekly')).toBe('Work hit its weekly limit');
    expect(limitTitle('Personal', undefined)).toBe('Personal hit its usage limit');
  });
  test('the reset time: the clock today, the weekday too on another day', () => {
    const now = new Date(2026, 9, 31, 13, 22).getTime();
    expect(resetClock(new Date(2026, 9, 31, 14, 10).getTime(), now)).toBe('14:10');
    expect(resetClock(new Date(2026, 10, 3, 9, 5).getTime(), now)).toBe('Tue 09:05');
  });
  test('its line: when it resets, then that only Ask is paused', () => {
    const now = new Date(2026, 9, 31, 13, 22).getTime();
    const at = new Date(2026, 9, 31, 14, 10).getTime();
    expect(limitBody({ resetMs: at, title: 'auth-refactor', now })).toBe('It resets at 14:10. auth-refactor keeps working; only Ask is paused.');
    expect(limitBody({ resetMs: now - 60_000, title: 'auth-refactor', now })).toBe('It reset at 13:21. auth-refactor keeps working; only Ask is paused.');
    expect(limitBody({ resetMs: null, title: 'auth-refactor', now })).toBe('auth-refactor keeps working; only Ask is paused.');
  });
  test('Ask at HH:MM: a timer to the reset (seconds → ms) and a few seconds more; none when unknown, past or too far for a timer', () => {
    const now = NOW_SEC * 1000;
    expect(askAtDelay(NOW_SEC + 600, now)).toBe(600_000 + ASK_AT_GRACE_MS);
    expect(ASK_AT_GRACE_MS).toBeGreaterThan(0);
    expect(ASK_AT_GRACE_MS).toBeLessThanOrEqual(10_000);
    expect(askAtDelay(undefined, now)).toBeNull();
    expect(askAtDelay(NOW_SEC, now)).toBeNull();
    expect(askAtDelay(NOW_SEC - 5, now)).toBeNull();
    expect(askAtDelay(NOW_SEC + 30 * 86400, now)).toBeNull();
    expect(askAtDelay(NOW_SEC + 7 * 86400, now)).toBe(7 * 86400_000 + ASK_AT_GRACE_MS);
  });
  test('waiting for a reset is checked at least once a minute (a sleeping Mac\'s long timers come late); nothing once due', () => {
    const now = NOW_SEC * 1000;
    expect(WAKE_STEP_MS).toBeLessThanOrEqual(60_000);
    expect(wakeIn(now + 600_000, now)).toBe(WAKE_STEP_MS);
    expect(wakeIn(now + 20_000, now)).toBe(20_000);
    expect(wakeIn(now, now)).toBeNull();
    expect(wakeIn(now - 1, now)).toBeNull();
  });
  test('who answered: the thread\'s account, or the session\'s own (by its config dir; unknown yet: the default)', () => {
    const a = accounts(WORK);
    expect(askAccount('work', null, a, DEFAULT_DIR)).toEqual({ account: a.list[1], name: 'Work' });
    expect(askAccount('session', WORK.dir, a, DEFAULT_DIR)).toEqual({ account: a.list[1], name: 'Work' });
    expect(askAccount('session', DEFAULT_DIR, a, DEFAULT_DIR)).toEqual({ account: a.list[0], name: 'Personal' });
    expect(askAccount('session', null, a, DEFAULT_DIR)).toEqual({ account: a.list[0], name: 'Personal' });
    // A dir no account has: its folder's name, as the session's account chip says.
    expect(askAccount('session', '/Users/me/.claude-old', a, DEFAULT_DIR)).toEqual({ account: null, name: '.claude-old' });
    // A removed account: its id, never a crash.
    expect(askAccount('gone', null, a, DEFAULT_DIR)).toEqual({ account: null, name: 'gone' });
  });
  test('Windows: a dir no account has is named by its folder, either separator', () => {
    const a = accounts(WORK);
    try {
      initPlatform('win32');
      expect(askAccount('session', 'C:\\Users\\me\\.claude-old', a, 'C:/Users/me/.claude')).toEqual({ account: null, name: '.claude-old' });
      expect(askAccount('session', 'C:/Users/me/.claude-old/', a, 'C:/Users/me/.claude')).toEqual({ account: null, name: '.claude-old' });
    } finally { resetPlatformForTests(); }
  });
  test('the item names the account its run used, not the thread\'s account now (an item saved before that: the current one)', () => {
    const a = accounts(WORK);
    const lim = (account?: string): Extract<ThreadItem, { kind: 'error' }> => ({ kind: 'error', id: 'e', at: 1, questionId: 'q', reason: 'limit', message: 'm', ...(account ? { account } : {}) });
    // After Ask with Work the thread's account is Work; the first limit was Personal's (the session's).
    expect(limitedBy(lim('session'), 'work', null, a, DEFAULT_DIR)).toEqual({ account: a.list[0], name: 'Personal' });
    expect(limitedBy(lim('work'), 'session', null, a, DEFAULT_DIR)).toEqual({ account: a.list[1], name: 'Work' });
    expect(limitedBy(lim(), 'work', null, a, DEFAULT_DIR)).toEqual({ account: a.list[1], name: 'Work' });
  });
  test('Ask with <other account>: the first other configured account that is not at its limit itself', () => {
    const a = accounts(WORK, CLIENT);
    const personal = a.list[0]!;
    expect(otherAccount(a, [], personal, DEFAULT_DIR, NOW_SEC)?.id).toBe('work');
    expect(otherAccount(a, [usage(WORK.dir, 100)], personal, DEFAULT_DIR, NOW_SEC)?.id).toBe('client');
    expect(otherAccount(a, [usage(WORK.dir, 100), usage(CLIENT.dir, 100)], personal, DEFAULT_DIR, NOW_SEC)).toBeNull();
    // Nearly at it still answers.
    expect(otherAccount(a, [usage(WORK.dir, 97)], personal, DEFAULT_DIR, NOW_SEC)?.id).toBe('work');
    // From Work: the default account (by the default dir's usage).
    expect(otherAccount(a, [], a.list[1]!, DEFAULT_DIR, NOW_SEC)?.id).toBe('default');
    expect(otherAccount(a, [usage(DEFAULT_DIR, 100)], a.list[1]!, DEFAULT_DIR, NOW_SEC)?.id).toBe('client');
  });
  test('no other account with a single one', () => {
    const a = accounts();
    expect(otherAccount(a, [], a.list[0]!, DEFAULT_DIR, NOW_SEC)).toBeNull();
    expect(otherAccount(a, [], null, DEFAULT_DIR, NOW_SEC)).toBeNull();
  });
  test('activeLimit: the thread\'s latest outcome is a limit that hasn\'t reset (the composer shows its account at 100%)', () => {
    const now = NOW_SEC * 1000;
    const q: ThreadItem = { kind: 'question', id: 'q', at: 1, text: 'x' };
    const lim = (resetsAt?: number): ThreadItem => ({ kind: 'error', id: 'e', at: 2, questionId: 'q', reason: 'limit', message: 'Usage limit reached', ...(resetsAt ? { resetsAt } : {}) });
    expect(activeLimit(thread([q, lim(NOW_SEC + 60)]), now)?.id).toBe('e');
    expect(activeLimit(thread([q, lim()]), now)?.id).toBe('e');
    // A question asked after it (waiting for its answer) doesn't lift it; an answer after it does.
    expect(activeLimit(thread([q, lim(NOW_SEC + 60), { ...q, id: 'q2' }]), now)?.id).toBe('e');
    expect(activeLimit(thread([q, lim(NOW_SEC + 60), { kind: 'answer', id: 'a', at: 3, questionId: 'q', markdown: 'ok', read: [], model: 'sonnet', costUsd: null }]), now)).toBeNull();
    expect(activeLimit(thread([q, lim(NOW_SEC - 1)]), now)).toBeNull();
    expect(activeLimit(thread([q, { kind: 'error', id: 'e', at: 2, questionId: 'q', reason: 'timeout', message: 't' }]), now)).toBeNull();
    expect(activeLimit(null, now)).toBeNull();
  });
});

describe('the palette\'s "Ask about" hints: one, by priority', () => {
  test('a new answer first, then a question or permission, then working; nothing at rest', () => {
    expect(askHint({ unseen: true, wait: 'question', working: true })).toEqual({ text: 'New answer', tone: 'ask' });
    expect(askHint({ unseen: false, wait: 'question', working: false })).toEqual({ text: 'has a question', tone: 'waiting' });
    expect(askHint({ unseen: false, wait: 'permission', working: false })).toEqual({ text: 'needs permission', tone: 'waiting' });
    expect(askHint({ unseen: false, wait: 'waiting', working: false })).toEqual({ text: 'needs you', tone: 'waiting' });
    expect(askHint({ unseen: false, wait: null, working: true })).toEqual({ text: 'working', tone: null });
    expect(askHint({ unseen: false, wait: null, working: false })).toBeNull();
  });
});

describe('the sidebar mark', () => {
  test('an answer not seen, unless its panel is open on screen', () => {
    expect(askMarked({ unseen: true, open: false, shown: false })).toBe(true);
    expect(askMarked({ unseen: true, open: false, shown: true })).toBe(true);
    expect(askMarked({ unseen: true, open: true, shown: false })).toBe(true);
    expect(askMarked({ unseen: true, open: true, shown: true })).toBe(false);
    expect(askMarked({ unseen: false, open: false, shown: false })).toBe(false);
  });
});

describe('where a terminal is (Ask is hosted by its pane)', () => {
  test('livesElsewhere: a tab popped out (seen from the main window), or not this pop-out\'s own tab (seen from a pop-out)', () => {
    expect(livesElsewhere({ poppedOut: ['t:a'], popout: null }, 'a')).toBe(true);
    expect(livesElsewhere({ poppedOut: ['t:b'], popout: null }, 'a')).toBe(false);
    expect(livesElsewhere({ poppedOut: [], popout: { key: 't:a' } }, 'a')).toBe(false);
    expect(livesElsewhere({ poppedOut: [], popout: { key: 't:b' } }, 'a')).toBe(true);
  });
  test('shownIn: the terminal in front, or every pane of a split; none behind another tab', () => {
    const one = { split: { panes: [{ tabs: [], front: null }], focus: 0, fractions: [1] }, activeTab: 'term', selectedId: 'a', activeKey: () => 't:a' };
    expect([...shownIn(one as unknown as Parameters<typeof shownIn>[0])]).toEqual(['a']);
    expect([...shownIn({ ...one, activeTab: 'file', activeKey: () => 'f:/x' } as unknown as Parameters<typeof shownIn>[0])]).toEqual([]);
    // Every pane's tab in front; a terminal behind another tab of its pane is not shown.
    const two = { split: { panes: [{ tabs: ['t:a', 't:c'], front: 't:a' }, { tabs: ['t:b'], front: 't:b' }], focus: 1, fractions: [0.5, 0.5] }, activeTab: 'term', selectedId: 'b', activeKey: () => 't:b' };
    expect([...shownIn(two as unknown as Parameters<typeof shownIn>[0])].sort()).toEqual(['a', 'b']);
  });
});

describe('sessionEnded: the panel stays bound to a conversation that is over', () => {
  test('Claude exited (no session), another conversation now (after /clear), or the terminal is gone', () => {
    expect(sessionEnded(term(session()), 's1')).toBe(false);
    expect(sessionEnded(term(null), 's1')).toBe(true);
    expect(sessionEnded(term(session({ sessionId: 's2' })), 's1')).toBe(true);
    expect(sessionEnded(undefined, 's1')).toBe(true);
  });
});
