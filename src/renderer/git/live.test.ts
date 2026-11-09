import { expect, test } from 'vitest';
import type { Attribution } from '@shared/attribution';
import type { SessionInfo } from '@shared/session';
import type { TerminalInfo } from '@shared/protocol';
import { liveFiles } from './live';

// Live files (spec git writes, Vocabulary): a file a session surely changed during its current turn.

const session = (o: Partial<SessionInfo>): SessionInfo => ({
  sessionId: 's1', state: 'running', title: null, activity: null, contextPct: null, unread: false, updatedAt: 0, lastMessageAt: 100, ...o
});
const term = (id: string, s: Partial<SessionInfo> | null, work?: TerminalInfo['work']): TerminalInfo => ({
  id, projectRoot: '/p', cwd: '/p', title: id, name: null, color: '#fff', foreground: 'claude', createdAt: 0,
  session: s ? session(s) : null, ...(work ? { work } : {})
});
const attr = (path: string, terminalId: string, at: number, o: Partial<Attribution> = {}): Attribution => ({
  path, terminalId, sessionId: 's1', color: '#c0ffee', title: `${terminalId}-title`, at, ...o
});
const work = (counting: boolean) => ({ counting } as unknown as NonNullable<TerminalInfo['work']>);
const paths = (m: Map<string, unknown>) => [...m.keys()].sort();

test('a running session: its files changed since its last message are live, older ones are not', () => {
  const live = liveFiles([term('t1', { state: 'running', lastMessageAt: 100 })], [attr('/p/new.ts', 't1', 150), attr('/p/same.ts', 't1', 100), attr('/p/old.ts', 't1', 50)]);
  expect(paths(live)).toEqual(['/p/new.ts', '/p/same.ts']);
  expect(live.get('/p/new.ts')).toEqual({ terminalId: 't1', title: 't1-title', color: '#c0ffee' });
});

test('waiting on a permission or a question is inside the turn; waiting for a new prompt is not', () => {
  const a = [attr('/p/x.ts', 't1', 150)];
  expect(paths(liveFiles([term('t1', { state: 'waiting', waitingFor: 'permission' })], a))).toEqual(['/p/x.ts']);
  expect(paths(liveFiles([term('t1', { state: 'waiting', waitingFor: 'question' })], a))).toEqual(['/p/x.ts']);
  // An atelierd without states2: plain waiting counts as inside the turn.
  expect(paths(liveFiles([term('t1', { state: 'waiting' })], a))).toEqual(['/p/x.ts']);
  expect(paths(liveFiles([term('t1', { state: 'waiting', waitingFor: 'input' })], a))).toEqual([]);
});

test('done is live only while background work still counts; idle, error and plain done never are', () => {
  const a = [attr('/p/x.ts', 't1', 150)];
  expect(paths(liveFiles([term('t1', { state: 'done' }, work(true))], a))).toEqual(['/p/x.ts']);
  expect(paths(liveFiles([term('t1', { state: 'done' }, work(false))], a))).toEqual([]);
  expect(paths(liveFiles([term('t1', { state: 'done' })], a))).toEqual([]);
  expect(paths(liveFiles([term('t1', { state: 'idle' })], a))).toEqual([]);
  expect(paths(liveFiles([term('t1', { state: 'error' })], a))).toEqual([]);
  expect(paths(liveFiles([term('t1', null)], a))).toEqual([]);
});

test('an older atelierd without lastMessageAt: any attribution of a live session counts', () => {
  const s = { state: 'running' as const, lastMessageAt: undefined };
  expect(paths(liveFiles([term('t1', s)], [attr('/p/x.ts', 't1', 1)]))).toEqual(['/p/x.ts']);
  expect(paths(liveFiles([term('t1', { state: 'running', lastMessageAt: null })], [attr('/p/x.ts', 't1', 1)]))).toEqual(['/p/x.ts']);
});

test('only sure attributions: unclear and maybe entries are never live', () => {
  const live = liveFiles([term('t1', { state: 'running' })], [
    attr('/p/u.ts', 't1', 150, { unclear: ['t1', 't2'] }), attr('/p/m.ts', 't1', 150, { maybe: true }), attr('/p/s.ts', 't1', 150, { via: 'bash' })
  ]);
  expect(paths(live)).toEqual(['/p/s.ts']);
});

test("another conversation's attributions in the same terminal are not this turn's", () => {
  const live = liveFiles([term('t1', { state: 'running', sessionId: 's2', lastMessageAt: undefined })], [attr('/p/a.ts', 't1', 150, { sessionId: 's1' }), attr('/p/b.ts', 't1', 150, { sessionId: 's2' })]);
  expect(paths(live)).toEqual(['/p/b.ts']);
});

test('attributions of terminals that are gone or not live are ignored; two live sessions on a file: the latest edit names it', () => {
  const live = liveFiles(
    [term('t1', { state: 'running' }), term('t2', { state: 'running' }), term('t3', { state: 'idle' })],
    [attr('/p/x.ts', 't1', 150), attr('/p/x.ts', 't2', 180), attr('/p/y.ts', 't3', 150), attr('/p/z.ts', 'gone', 150)]
  );
  expect(paths(live)).toEqual(['/p/x.ts']);
  expect(live.get('/p/x.ts')?.terminalId).toBe('t2');
});
