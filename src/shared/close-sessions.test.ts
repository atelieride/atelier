import { expect, test } from 'vitest';
import type { TerminalInfo } from './protocol';
import type { SessionInfo } from './session';
import type { ScheduledPrompt } from './scheduled-prompts';
import { closeSessionsAsk, effectiveCloseMode, projectBusy } from './close-sessions';

const term = (id: string, o: Partial<TerminalInfo> & { state?: SessionInfo['state'] } = {}): TerminalInfo => {
  const { state, ...rest } = o;
  return {
    id, projectRoot: '/p', cwd: '/p', title: id, name: null, color: '#60A5FA', foreground: 'zsh', createdAt: 0,
    session: state ? ({ sessionId: `s-${id}`, state } as SessionInfo) : null, ...rest
  };
};
const sched = (terminalId: string, status: ScheduledPrompt['status'] = 'pending') => ({ id: `q-${terminalId}`, terminalId, status, projectRoot: '/p' }) as ScheduledPrompt;

test('busy: working (background work that counts too), waiting, a foreground command, a scheduled prompt; the rest idle', () => {
  const list = [
    term('work', { state: 'running' }),
    term('bg', { state: 'done', work: { counting: true } as TerminalInfo['work'] }),
    term('wait', { state: 'waiting' }),
    term('done', { state: 'done' }),
    term('fail', { state: 'error' }),
    term('sched', { state: 'idle' }),
    term('dev'),
    term('shell'),
    term('other', { projectRoot: '/q', state: 'running' })
  ];
  const b = projectBusy('/p', list, [sched('sched'), sched('done', 'sent')], new Map([['dev', 'npm run dev'], ['work', 'claude']]));
  expect(b.busy.map((x) => [x.id, x.kind])).toEqual([['work', 'working'], ['bg', 'working'], ['wait', 'waiting'], ['sched', 'scheduled'], ['dev', 'running']]);
  expect(b.busy.find((x) => x.id === 'dev')).toMatchObject({ session: false, command: 'npm run dev' });
  // Its command line unreadable: the terminal's title instead.
  expect(projectBusy('/p', [term('dev')], [], new Map([['dev', '']])).busy[0]).toEqual({ id: 'dev', kind: 'running', title: 'dev', color: '#60A5FA', session: false });
  expect(b).toMatchObject({ root: '/p', name: 'p', idleSessions: 2, idleTerminals: 1, ids: ['work', 'bg', 'wait', 'done', 'fail', 'sched', 'dev', 'shell'] });
});

test('the ask: one group per project with something busy, six rows then "+N more", idle counts kept', () => {
  const many = Array.from({ length: 8 }, (_, i) => term(`w${i}`, { state: 'running' }));
  const p = projectBusy('/p', [...many, term('idle', { state: 'idle' }), term('sh')], [], new Map());
  const q = projectBusy('C:/work/q', [term('qi', { projectRoot: 'C:/work/q', state: 'idle' })], [], new Map());
  const ask = closeSessionsAsk('quit', [p, q]);
  expect(ask.kind).toBe('close-sessions');
  expect(ask.what).toBe('quit');
  expect(ask.windows).toBe(1);
  expect(ask.projects).toHaveLength(1);
  expect(ask.projects[0]).toMatchObject({ name: 'p', more: 2, idleSessions: 1, idleTerminals: 1 });
  expect(ask.projects[0]!.busy).toHaveLength(6);
  expect(ask.projects[0]!.busy[0]).toEqual({ title: 'w0', color: '#60A5FA', kind: 'working', session: true });
  expect(q.name).toBe('q');
});

test('the mode: the setting; "keep" without kill-resumable; a test override wins when given', () => {
  expect(effectiveCloseMode('ask', true)).toBe('ask');
  expect(effectiveCloseMode('stop', true)).toBe('stop');
  expect(effectiveCloseMode('stop', false)).toBe('keep');
  expect(effectiveCloseMode('ask', true, 'keep')).toBe('keep');
  expect(effectiveCloseMode('keep', true, 'stop')).toBe('stop');
  expect(effectiveCloseMode('ask', true, '')).toBe('ask');
  expect(effectiveCloseMode('ask', true, 'nonsense')).toBe('ask');
});

test('a session paused at a usage limit is busy with kind "paused" and the question lists it', () => {
  const paused = term('p', { state: 'error' });
  paused.session = { ...paused.session!, errorReason: 'rate_limit', limitPause: { since: 1, resetsAt: 9 } };
  const ended = term('e', { state: 'error' });
  ended.session = { ...ended.session!, errorReason: 'rate_limit', limitPause: { since: 1, resetsAt: 9, over: 'expired' } };
  const b = projectBusy('/p', [paused, ended], [], new Map());
  expect(b.busy.map((x) => [x.id, x.kind])).toEqual([['p', 'paused']]);
  expect(b.idleSessions).toBe(1);
  expect(closeSessionsAsk('close', [b]).projects[0]!.busy[0]!.kind).toBe('paused');
});
