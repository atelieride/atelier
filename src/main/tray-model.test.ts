import { expect, test } from 'vitest';
import { trayAggregate, trayModel, TRAY_MAX } from './tray-model';
import type { TerminalInfo } from '@shared/protocol';
import type { SessionInfo, SessionState } from '@shared/session';
import type { BackgroundWork } from '@shared/background';

const t = (id: string, state: SessionState | null, opts: { unread?: boolean; project?: string; title?: string; updatedAt?: number; session?: Partial<SessionInfo> } = {}): TerminalInfo => ({
  id, projectRoot: opts.project ?? '/p/alpha', cwd: '/p', title: opts.title ?? id, name: null, color: '#fff', foreground: 'claude', createdAt: 0,
  session: state ? { sessionId: id, state, title: null, activity: null, contextPct: null, unread: opts.unread ?? false, updatedAt: opts.updatedAt ?? 0, ...opts.session } : null
});

test('one icon per session that needs you, in the Dock menu order; working and idle ones have none', () => {
  const m = trayModel([t('run', 'running'), t('d', 'done', { unread: true }), t('w', 'waiting'), t('seen', 'done'), t('e', 'error', { unread: true }), t('shell', null)]);
  expect(m.icons.map((i) => [i.id, i.kind])).toEqual([['w', 'waiting'], ['e', 'error'], ['d', 'done']]);
  expect(m.overflow).toBeNull();
});

test('the idle notice is not waiting, and a done session whose background work counts is not finished', () => {
  const idle = t('i', 'waiting', { session: { waitingFor: 'input' } });
  const work: BackgroundWork = { counting: true, agents: 0, shells: 1, monitors: 0, other: 0, idle: 0, items: [{ kind: 'shell', label: 'npm test', counted: true }], crons: [], entries: [], nextChange: null };
  const busy = { ...t('busy', 'done', { unread: true }), work };
  expect(trayModel([idle, busy]).icons).toEqual([]);
});

test(`up to ${TRAY_MAX} icons; beyond, ${TRAY_MAX - 1} icons and a "+N" item with the hidden sessions`, () => {
  const five = Array.from({ length: TRAY_MAX }, (_, i) => t(`w${i}`, 'waiting', { updatedAt: i }));
  expect(trayModel(five).icons).toHaveLength(TRAY_MAX);
  expect(trayModel(five).overflow).toBeNull();
  const seven = [...five, t('e', 'error', { unread: true }), t('d', 'done', { unread: true })];
  const m = trayModel(seven);
  expect(m.icons.map((i) => i.id)).toEqual(['w0', 'w1', 'w2', 'w3']);
  expect(m.overflow!.count).toBe(3);
  // The most urgent of the hidden ones colours the item.
  expect(m.overflow!.kind).toBe('waiting');
  expect(m.overflow!.entries.map((e) => [e.id, e.kind])).toEqual([['w4', 'waiting'], ['e', 'error'], ['d', 'done']]);
});

test('tooltip: the session and its project, then what it is, in the banners\' words', () => {
  const perm = t('p', 'waiting', { title: 'api-refactor', project: '/Users/x/atelier', session: { waitingFor: 'permission', activity: 'waiting: Bash npm test' } });
  const ask = t('q', 'waiting', { title: 'docs', session: { waitingFor: 'question' } });
  const err = t('e', 'error', { unread: true, title: 'fix', session: { activity: 'rate_limit' } });
  const done = t('d', 'done', { unread: true, title: 'sync' });
  const tips = trayModel([perm, ask, err, done]).icons.map((i) => i.tooltip);
  expect(tips[0]).toBe('api-refactor · atelier\nNeeds permission · Bash npm test');
  expect(tips[1]).toBe('docs · alpha\nHas a question');
  expect(tips[2]!.startsWith('fix · alpha\nStopped with an error · ')).toBe(true);
  expect(tips[3]).toBe('sync · alpha\nFinished');
});

test('tooltip: no control or format characters, the title cut by characters', () => {
  const m = trayModel([t('a', 'waiting', { title: 'ab‮cd\u0007' + '😀'.repeat(60) })]);
  const tip = m.icons[0]!.tooltip;
  expect(tip).not.toMatch(/[‮\u0007]/);
  expect(tip).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
});

test('Windows aggregate: nobody needs you → neutral "Atelier"', () => {
  const a = trayAggregate([t('r', 'running'), t('d', 'done')]);
  expect(a.kind).toBe('none');
  expect(a.tooltip).toBe('Atelier');
  expect(a.entries).toEqual([]);
});

test('Windows aggregate: the most urgent kind colours it, the tooltip counts each kind', () => {
  expect(trayAggregate([t('d', 'done', { unread: true }), t('e', 'error', { unread: true })]).kind).toBe('error');
  const a = trayAggregate([t('d', 'done', { unread: true }), t('w1', 'waiting'), t('w2', 'waiting')]);
  expect(a.kind).toBe('waiting');
  expect(a.tooltip).toBe('Atelier — 2 waiting for you, 1 finished');
  expect(trayAggregate([t('e', 'error', { unread: true })]).tooltip).toBe('Atelier — 1 stopped');
});

test('Windows aggregate: the menu lists at most 8 sessions, the rest counted', () => {
  const a = trayAggregate(Array.from({ length: 11 }, (_, i) => t(`w${i}`, 'waiting', { updatedAt: i, title: `Task ${i}`, project: '/Users/x/acme' })));
  expect(a.entries).toHaveLength(8);
  expect(a.entries[0]!.label).toBe('Task 0 · acme');
  expect(a.more).toBe(3);
});

test('Windows aggregate tooltip stays within the 127 characters the notification area shows', () => {
  expect(trayAggregate(Array.from({ length: 3 }, (_, i) => t(`w${i}`, 'waiting'))).tooltip.length).toBeLessThanOrEqual(127);
});

test('tooltip: what the session asks is cleaned and cut too (a file name may come from the repo)', () => {
  const m = trayModel([t('p', 'waiting', { project: '/p/ev\u202Eil', session: { waitingFor: 'permission', activity: 'waiting: Edit a\u202Etxt.exe' + 'x'.repeat(300) } })]);
  const [first, second] = m.icons[0]!.tooltip.split('\n');
  expect(first).toBe('p · evil');
  expect(second).not.toMatch(/\u202E/);
  expect(Array.from(second!).length).toBeLessThanOrEqual(80);
});

test('the tray ignores a session paused at a usage limit', () => {
  const p = t('p', 'error', { unread: true, session: { errorReason: 'rate_limit', limitPause: { since: 1, resetsAt: 9 } } });
  expect(trayModel([p])).toEqual(trayModel([]));
  expect(trayAggregate([p])).toEqual(trayAggregate([]));
});
