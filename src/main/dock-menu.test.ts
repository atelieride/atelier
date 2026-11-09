import { expect, test } from 'vitest';
import { dockEntries, dockOverflow } from './dock-menu';
import type { TerminalInfo } from '@shared/protocol';
import type { SessionState } from '@shared/session';
import type { BackgroundWork } from '@shared/background';

const t = (id: string, state: SessionState | null, opts: { unread?: boolean; project?: string; title?: string; updatedAt?: number } = {}): TerminalInfo => ({
  id, projectRoot: opts.project ?? '/p/alpha', cwd: '/p', title: opts.title ?? id, name: null, color: '#fff', foreground: 'claude', createdAt: 0,
  session: state ? { sessionId: id, state, title: null, activity: null, contextPct: null, unread: opts.unread ?? false, updatedAt: opts.updatedAt ?? 0 } : null
});

test('only sessions that are waiting or finished unseen, waiting first', () => {
  const e = dockEntries([t('a', 'running'), t('b', 'done', { unread: true }), t('c', 'waiting'), t('d', null), t('e', 'done')]);
  expect(e.map((x) => [x.id, x.kind])).toEqual([['c', 'waiting'], ['b', 'done']]);
});

test('"waiting" means what the shared helper says: a permission or a question, never the idle notice', () => {
  const idle = t('i', 'waiting');
  idle.session!.waitingFor = 'input';
  const asked = t('q', 'waiting');
  asked.session!.waitingFor = 'question';
  expect(dockEntries([idle, asked]).map((x) => [x.id, x.kind])).toEqual([['q', 'waiting']]);
});

test('label with title and project, at most 8 entries', () => {
  const list = Array.from({ length: 12 }, (_, i) => t(`s${i}`, 'waiting', { title: `Task ${i}`, project: '/Users/x/acme' }));
  const e = dockEntries(list);
  expect(e).toHaveLength(8);
  expect(e[0]!.label).toBe('Task 0 · acme');
  expect(e[0]!.projectRoot).toBe('/Users/x/acme');
});

test('long titles shortened, control characters removed', () => {
  const e = dockEntries([t('a', 'waiting', { title: 'x'.repeat(80) + '\u0007' })]);
  expect(e[0]!.label.startsWith('x'.repeat(47) + '…')).toBe(true);
  expect(e[0]!.label.includes('\u0007')).toBe(false);
});

test('sessions stopped by an error and unseen show up, after the waiting ones', () => {
  const e = dockEntries([t('a', 'error', { unread: true }), t('b', 'waiting'), t('c', 'error')]);
  expect(e.map((x) => [x.id, x.kind])).toEqual([['b', 'waiting'], ['a', 'error']]);
});

test('labels: no format (bidi) characters and cut by character, not in the middle of an emoji', () => {
  const e = dockEntries([t('a', 'waiting', { title: 'ab\u202Ecd\u2028' + '😀'.repeat(60) })]);
  expect(e[0]!.label).not.toMatch(/[\u202E\u2028]/);
  expect(e[0]!.label).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
});

test('order: the longest-waiting first; among finished ones the most recent first', () => {
  const e = dockEntries([
    t('w-new', 'waiting', { updatedAt: 30 }), t('w-old', 'waiting', { updatedAt: 10 }),
    t('d-old', 'done', { unread: true, updatedAt: 5 }), t('d-new', 'done', { unread: true, updatedAt: 50 })
  ]);
  expect(e.map((x) => x.id)).toEqual(['w-old', 'w-new', 'd-new', 'd-old']);
});

test('finished means the effective state: a done session whose background work counts is not in the menu', () => {
  const work = (counting: boolean): BackgroundWork => ({ counting, agents: 0, shells: 1, monitors: 0, other: 0, idle: 0, items: [{ kind: 'shell', label: 'npm test', counted: true }], crons: [], entries: [], nextChange: null });
  const busy = { ...t('busy', 'done', { unread: true }), work: work(true) };
  const over = { ...t('over', 'done', { unread: true }), work: work(false) };
  expect(dockEntries([busy, over]).map((x) => [x.id, x.kind])).toEqual([['over', 'done']]);
  expect(dockOverflow([busy])).toBe(0);
});

test('over 8 entries: how many are left out, for the "+N more"', () => {
  const list = Array.from({ length: 11 }, (_, i) => t(`s${i}`, 'waiting'));
  expect(dockOverflow(list)).toBe(3);
  expect(dockOverflow(list.slice(0, 8))).toBe(0);
});

test('a session paused at a usage limit is not picked; an ended pause is, as an error', () => {
  const pause = { since: 1, resetsAt: 9 };
  const lim = (id: string, limitPause: { since: number; resetsAt: number | null; over?: 'expired' }) => {
    const x = t(id, 'error', { unread: true });
    x.session = { ...x.session!, errorReason: 'rate_limit', limitPause };
    return x;
  };
  const e = dockEntries([lim('p', pause), lim('o', { ...pause, over: 'expired' })]);
  expect(e.map((x) => [x.id, x.kind])).toEqual([['o', 'error']]);
});
