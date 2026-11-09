import { expect, test } from 'vitest';
import type { TerminalInfo } from '@shared/protocol';
import { tabPropsEqual } from './tab-props';

const term = (over: Partial<TerminalInfo> = {}, ctx = 10): TerminalInfo => ({
  id: 'a', projectRoot: '/p', cwd: '/p', title: 'T', name: null, color: '#fff', foreground: 'claude', createdAt: 0,
  session: { sessionId: 's', state: 'running', title: null, activity: 'Edit x', contextPct: ctx, unread: false, updatedAt: 1 }, ...over
});
const base = { k: 't:a' as const, active: false, drop: false };

test('a status line tick (context, activity, updatedAt) does not re-render the tab', () => {
  const a = { ...base, term: term() };
  const b = { ...base, term: { ...term({}, 55), session: { ...term().session!, activity: 'Read y', updatedAt: 99, contextPct: 55 } } };
  expect(tabPropsEqual(a, b)).toBe(true);
});

test('title, color, state, active and drop do', () => {
  expect(tabPropsEqual({ ...base, term: term() }, { ...base, term: term({ title: 'U' }) })).toBe(false);
  expect(tabPropsEqual({ ...base, term: term() }, { ...base, term: term({ color: '#000' }) })).toBe(false);
  expect(tabPropsEqual({ ...base, term: term() }, { ...base, term: { ...term(), session: { ...term().session!, state: 'waiting' } } })).toBe(false);
  expect(tabPropsEqual({ ...base, term: term() }, { ...base, active: true, term: term() })).toBe(false);
  expect(tabPropsEqual({ ...base, term: term() }, { ...base, drop: true, term: term() })).toBe(false);
});

test('the tab\'s tip and name follow the name sync and the session\'s folder (the session bar above shows neither)', () => {
  expect(tabPropsEqual({ ...base, term: term() }, { ...base, term: term({ nameSync: 'pending' }) })).toBe(false);
  expect(tabPropsEqual({ ...base, term: term({ nameSync: 'pending' }) }, { ...base, term: term({ nameSync: 'kept' }) })).toBe(false);
  expect(tabPropsEqual({ ...base, term: term() }, { ...base, term: { ...term(), session: { ...term().session!, cwd: '/p/wt' } } })).toBe(false);
});

test('a session that stops starting (Claude never came) re-renders its tab: avatar back to the terminal glyph', () => {
  const plain = term({ session: null });
  expect(tabPropsEqual({ ...base, term: plain, starting: true }, { ...base, term: plain, starting: false })).toBe(false);
  expect(tabPropsEqual({ ...base, term: plain, starting: true }, { ...base, term: plain, starting: true })).toBe(true);
});

test('service errors matter only for the Services tab', () => {
  expect(tabPropsEqual({ ...base, term: term(), svcErrors: 0 }, { ...base, term: term(), svcErrors: 3 })).toBe(true);
  expect(tabPropsEqual({ k: 'services', active: false, drop: false, svcErrors: 0 }, { k: 'services', active: false, drop: false, svcErrors: 3 })).toBe(false);
});

test('a tab’s count (Redis Queues’ failed jobs) re-renders it when it changes', () => {
  const q = { k: 'rd:queues' as const, active: false, drop: false };
  expect(tabPropsEqual({ ...q, badge: 2 }, { ...q, badge: 3 })).toBe(false);
  expect(tabPropsEqual({ ...q, badge: 0 }, q)).toBe(true);
});

test('a table tab re-renders when its kind, its connection\'s environment or its tooltip change, never on a new but equal object', () => {
  const k = 'db:c0123456789ab/public/orders' as const;
  const db = { kind: 'table', env: 'is-local', tip: 'acme · public.orders' };
  const tab = { k, active: false, drop: false, title: 'orders', db };
  expect(tabPropsEqual(tab, { ...tab, db: { ...db } })).toBe(true);
  for (const change of [{ kind: 'view' }, { env: 'is-prod' }, { env: null }, { tip: 'acme · sales.orders' }]) expect(tabPropsEqual(tab, { ...tab, db: { ...db, ...change } }), JSON.stringify(change)).toBe(false);
});

test('split view: a tab becoming (or no longer) the front of an unfocused pane re-renders', () => {
  expect(tabPropsEqual({ ...base, front: false }, { ...base, front: true })).toBe(false);
  expect(tabPropsEqual({ ...base, front: true }, { ...base, front: true })).toBe(true);
  expect(tabPropsEqual({ ...base, front: false }, { ...base })).toBe(true);
});
