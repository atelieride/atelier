import { expect, test } from 'vitest';
import { nextAttention, seenNow } from './attention-nav';
import type { TerminalInfo } from '@shared/protocol';
import type { SessionInfo, SessionState } from '@shared/session';

const t = (id: string, state?: SessionState, unread = false, createdAt = 0): TerminalInfo => ({
  id, projectRoot: '/p', cwd: '/p', title: id, name: null, color: '#fff', foreground: 'zsh', createdAt,
  session: state ? { sessionId: id, state, title: null, activity: null, contextPct: null, unread, updatedAt: 0 } : null
});
const counting = (x: TerminalInfo): TerminalInfo => ({ ...x, work: { counting: true, agents: 1, shells: 0, monitors: 0, other: 0, idle: 0, items: [], crons: [], entries: [], nextChange: null } });
const order = (...ids: string[]) => ids.map((id) => `t:${id}` as const);

test('a finished unread session still working in the background is not attention yet', () => {
  expect(nextAttention([t('a', 'running'), counting(t('b', 'done', true))], order('a', 'b'), 'a')).toBeNull();
  expect(nextAttention([t('a', 'running'), t('b', 'done', true)], order('a', 'b'), 'a')).toBe('b');
});

// A paused session goes on by itself; it needs you only once the pause ended.
test('an unread session paused at its usage limit is skipped by ⌘J; an ended pause, or one from an older atelierd, is not', () => {
  const limited = (id: string, limitPause?: SessionInfo['limitPause']): TerminalInfo => {
    const x = t(id, 'error', true);
    return { ...x, session: { ...x.session!, errorReason: 'rate_limit', ...(limitPause ? { limitPause } : {}) } };
  };
  expect(nextAttention([t('a', 'running'), limited('p', { since: 1, resetsAt: 9 }), limited('c', { since: 1, resetsAt: null })], order('a', 'p', 'c'), 'a')).toBeNull();
  expect(nextAttention([t('a', 'running'), limited('p', { since: 1, resetsAt: 9 })], order('a', 'p'), 'p')).toBeNull();
  expect(nextAttention([t('a', 'running'), limited('e', { since: 1, resetsAt: 9, over: 'expired' })], order('a', 'e'), 'a')).toBe('e');
  expect(nextAttention([t('a', 'running'), limited('o')], order('a', 'o'), 'a')).toBe('o');
});

test('nobody asks for attention: null', () => {
  expect(nextAttention([t('a', 'running'), t('b')], order('a', 'b'), 'a')).toBeNull();
});

test('waiting sessions first, starting from the tab after the current one, wrapping around', () => {
  const list = [t('a', 'waiting'), t('b', 'running'), t('c', 'waiting'), t('d', 'waiting')];
  expect(nextAttention(list, order('a', 'b', 'c', 'd'), 'a')).toBe('c');
  expect(nextAttention(list, order('a', 'b', 'c', 'd'), 'c')).toBe('d');
  expect(nextAttention(list, order('a', 'b', 'c', 'd'), 'd')).toBe('a');
  // follows the tab order, not the list order
  expect(nextAttention(list, order('d', 'c', 'b', 'a'), 'b')).toBe('a');
});

test('if nobody is waiting: finished unread sessions', () => {
  const list = [t('a', 'done', true), t('b', 'running'), t('c', 'done', false), t('d', 'waiting')];
  expect(nextAttention(list, order('a', 'b', 'c', 'd'), 'b')).toBe('d');
  const noWait = [t('a', 'done', true), t('b', 'running'), t('c', 'done', false)];
  expect(nextAttention(noWait, order('a', 'b', 'c'), 'b')).toBe('a');
});

test('the only waiting session is the current one: stay there', () => {
  expect(nextAttention([t('a', 'waiting'), t('b')], order('a', 'b'), 'a')).toBe('a');
});

test('terminals whose tab is closed (still in the sidebar) still count, after those in the tabs', () => {
  const list = [t('a', 'running'), t('b', 'waiting'), t('c', 'waiting')];
  expect(nextAttention(list, order('a', 'c'), 'a')).toBe('c');
  expect(nextAttention(list, order('a', 'c'), 'c')).toBe('b');
  expect(nextAttention([t('a', 'running'), t('b', 'done', true)], order('a'), 'a')).toBe('b');
});

test('with no selection or a tab not in the list, start from the beginning', () => {
  const list = [t('a', 'running'), t('b', 'waiting')];
  expect(nextAttention(list, order('a', 'b'), null)).toBe('b');
  expect(nextAttention(list, order('a', 'b'), 'zzz')).toBe('b');
});

test('session finished while you watch it: seen immediately, but only with the window in front and its tab active', () => {
  const list = [t('a', 'done', true), t('b', 'done', false)];
  expect(seenNow(list, 'a', 'term', true)).toBe('a');
  expect(seenNow(list, 'a', 'term', false)).toBeNull();
  expect(seenNow(list, 'a', '/r/file.ts', true)).toBeNull();
  expect(seenNow(list, 'b', 'term', true)).toBeNull();
  expect(seenNow(list, null, 'term', true)).toBeNull();
});

test('a session stopped by an error and unseen asks for attention like a finished one', () => {
  const list = [t('a', 'running'), t('b', 'error', true), t('c', 'error', false)];
  expect(nextAttention(list, order('a', 'b', 'c'), 'a')).toBe('b');
});

test('on the only waiting session ⌘J moves to finished unseen ones, if any', () => {
  const list = [t('a', 'waiting'), t('b', 'done', true)];
  expect(nextAttention(list, order('a', 'b'), 'a')).toBe('b');
});

test('with a sheet open on top (Settings, palette) the session is not seen', () => {
  expect(seenNow([t('a', 'done', true)], 'a', 'term', true, true)).toBeNull();
});

test('states2: ⌘J goes to a permission request first, then questions, then finished unread; never to the idle notice', () => {
  const w = (id: string, state: SessionState, waitingFor: 'permission' | 'question' | 'input', unread = false): TerminalInfo => ({ ...t(id, state, unread), session: { ...t(id, state, unread).session!, waitingFor } });
  const list = [w('q', 'waiting', 'question'), t('d', 'done', true), w('p', 'waiting', 'permission'), w('i', 'idle', 'input')];
  expect(nextAttention(list, order('q', 'd', 'p', 'i'), null)).toBe('p');
  expect(nextAttention(list.filter((x) => x.id !== 'p'), order('q', 'd', 'i'), null)).toBe('q');
  expect(nextAttention([t('d', 'done', true), w('i', 'idle', 'input')], order('d', 'i'), 'd')).toBe('d');
  expect(nextAttention([w('i', 'waiting', 'input')], order('i'), null)).toBeNull();
});
