import { expect, test } from 'vitest';
import type { SessionInfo, SessionState } from '@shared/session';
import { lastMessageLine } from './last-message';

// Under an idle or finished session, when its last message was.
const now = new Date(2026, 9, 14, 15, 0).getTime();
const sess = (state: SessionState, lastMessageAt: number | null | undefined, extra: Partial<SessionInfo> = {}): SessionInfo =>
  ({ sessionId: 's', state, title: null, activity: null, contextPct: null, unread: false, updatedAt: 0, lastMessageAt, ...extra });

test('done and idle sessions: how long ago, and the full date and time in the tooltip', () => {
  const at = new Date(2026, 9, 14, 14, 32).getTime();
  expect(lastMessageLine(sess('done', at), now)).toEqual({ text: '28m ago', tip: 'Last message Oct 14, 14:32' });
  expect(lastMessageLine(sess('idle', at), now)?.text).toBe('28m ago');
  expect(lastMessageLine(sess('done', now - 10_000), now)?.text).toBe('just now');
});

test('long ago: the date; another year: with the year', () => {
  expect(lastMessageLine(sess('done', new Date(2026, 7, 3, 9, 5).getTime()), now)).toEqual({ text: 'Aug 3', tip: 'Last message Aug 3, 09:05' });
  expect(lastMessageLine(sess('idle', new Date(2025, 11, 30, 23, 59).getTime()), now)).toEqual({ text: 'Dec 30, 2025', tip: 'Last message Dec 30, 2025, 23:59' });
});

test('nothing to show: no time (a new session, an older atelierd), or a session that is busy or stuck', () => {
  expect(lastMessageLine(sess('idle', null), now)).toBeNull();
  expect(lastMessageLine(sess('done', undefined), now)).toBeNull();
  for (const st of ['running', 'waiting', 'error'] as const) expect(lastMessageLine(sess(st, now - 60_000), now)).toBeNull();
  // Waiting for a permission or an answer, even with the state not saying so.
  expect(lastMessageLine(sess('idle', now - 60_000, { waitingFor: 'permission' }), now)).toBeNull();
  expect(lastMessageLine(sess('idle', now - 60_000, { compacting: true }), now)).toBeNull();
});
