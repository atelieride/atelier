import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { TerminalInfo } from '@shared/protocol';
import type { SessionInfo } from '@shared/session';
import type { ScheduledPrompt } from '@shared/scheduled-prompts';
import { DEFAULT_SETTINGS } from '@shared/settings';
import { useApp } from '../store';

const initialDaemon = useApp.getState().daemon;

const close = vi.fn(async () => {});
const base = { projectRoot: '/p', cwd: '/p', name: null, color: '#4FC3D9', createdAt: 0 };
const session = (state: SessionInfo['state']): SessionInfo => ({ sessionId: 's', state, title: null, activity: null, contextPct: null, unread: false, updatedAt: 0 });
const shell: TerminalInfo = { ...base, id: 'sh', title: 'Terminal 3', foreground: 'zsh', session: null };
const dev: TerminalInfo = { ...base, id: 'dev', title: 'dev server', foreground: 'npm', session: null };
const billing: TerminalInfo = { ...base, id: 'b', title: 'billing-tests', foreground: '2.1.296', session: session('running') };

beforeEach(() => {
  (globalThis as unknown as { window: unknown }).window = { atelier: { terminals: { close } } };
  close.mockClear();
  useApp.setState({ terminals: [shell, dev, billing], closeAsk: null, closing: {}, settings: DEFAULT_SETTINGS, daemon: { ...initialDaemon, closeStopAvailable: true }, schedules: [] });
});
afterEach(() => { delete (globalThis as unknown as { window?: unknown }).window; });

test('a shell at its prompt closes at once: nothing asks', () => {
  useApp.getState().askClose('sh', 'row');
  expect(close).toHaveBeenCalledWith('sh');
  expect(useApp.getState().closeAsk).toBeNull();
});

test('a busy terminal asks where it was asked; Cancel closes nothing, Close closes it', () => {
  useApp.getState().askClose('b', 'row');
  expect(close).not.toHaveBeenCalled();
  expect(useApp.getState().closeAsk).toEqual({ id: 'b', at: 'row', stops: { kind: 'claude', doing: 'working' }, note: 'history' });
  useApp.getState().cancelClose();
  expect(useApp.getState().closeAsk).toBeNull();
  useApp.getState().askClose('dev', 'tab');
  expect(useApp.getState().closeAsk).toEqual({ id: 'dev', at: 'tab', stops: { kind: 'process', what: 'npm' }, note: 'history' });
  useApp.getState().confirmClose();
  expect(close).toHaveBeenCalledWith('dev');
  expect(useApp.getState().closeAsk).toBeNull();
});

test('asking another terminal replaces the open question; an unknown id asks nothing', () => {
  useApp.getState().askClose('b', 'row');
  useApp.getState().askClose('dev', 'row');
  expect(useApp.getState().closeAsk?.id).toBe('dev');
  useApp.getState().askClose('gone', 'row');
  expect(useApp.getState().closeAsk?.id).toBe('dev');
  expect(close).not.toHaveBeenCalled();
});

test('the terminal exits while asked: the question goes away', () => {
  useApp.getState().askClose('b', 'row');
  useApp.setState({ terminals: [shell, dev] });
  expect(useApp.getState().closeAsk).toBeNull();
});

test('a terminal already closing is never closed twice: no second kill, no second question', () => {
  useApp.getState().askClose('sh', 'row');
  useApp.getState().askClose('sh', 'row');
  expect(close).toHaveBeenCalledTimes(1);
  useApp.getState().askClose('b', 'row');
  useApp.getState().confirmClose();
  useApp.getState().askClose('b', 'row');
  expect(useApp.getState().closeAsk).toBeNull();
  expect(close).toHaveBeenCalledTimes(2);
  expect(useApp.getState().closing).toEqual({ sh: true, b: true });
});

test('a closing terminal stays closing until it leaves the list', () => {
  useApp.getState().askClose('sh', 'row');
  useApp.setState({ terminals: [shell, dev, billing] });
  expect(useApp.getState().closing).toEqual({ sh: true });
  useApp.setState({ terminals: [dev, billing] });
  expect(useApp.getState().closing).toEqual({});
});

test('a close atelierd never received can be tried again; one it got but answered late cannot', async () => {
  close.mockRejectedValueOnce(new Error("Error invoking remote method 'term:close': Error: atelierd not connected"));
  useApp.getState().askClose('sh', 'row');
  await vi.waitFor(() => expect(useApp.getState().closing).toEqual({}));
  close.mockRejectedValueOnce(new Error("Error invoking remote method 'term:close': Error: atelierd not responding"));
  useApp.getState().askClose('sh', 'row');
  await new Promise((r) => setTimeout(r, 0));
  expect(useApp.getState().closing).toEqual({ sh: true });
});

// With the setting on, a session that will wait under Resume.
describe('Keep closed sessions under Resume', () => {
  const talked = (id: string, state: SessionInfo['state'], lastMessageAt: number | null = 1): TerminalInfo => ({ ...base, id, title: id, foreground: '2.1.296', session: { ...session(state), sessionId: id, lastMessageAt } });
  const keepOn = () => useApp.setState({ settings: { ...DEFAULT_SETTINGS, keepClosedSessions: true } });
  const prompt = (terminalId: string, status: ScheduledPrompt['status']) => ({ id: `p-${terminalId}`, terminalId, sessionId: terminalId, projectRoot: '/p', title: terminalId, text: 'go on', at: 0, ifBusy: 'wait', createdAt: 0, status }) as ScheduledPrompt;

  test('an idle, finished or failed session closes at once: nothing is lost', () => {
    keepOn();
    useApp.setState({ terminals: [talked('i', 'idle'), talked('d', 'done'), talked('x', 'error')] });
    for (const id of ['i', 'd', 'x']) useApp.getState().askClose(id, 'row');
    expect(close.mock.calls).toEqual([['i'], ['d'], ['x']]);
    expect(useApp.getState().closeAsk).toBeNull();
  });

  test('working or waiting still asks, and says it waits under Resume — from a row, a tab or a pop-out', () => {
    keepOn();
    useApp.setState({ terminals: [talked('w', 'running'), talked('q', 'waiting')] });
    useApp.getState().askClose('w', 'row');
    expect(useApp.getState().closeAsk).toEqual({ id: 'w', at: 'row', stops: { kind: 'claude', doing: 'working' }, note: 'resume' });
    useApp.getState().askClose('q', 'popout');
    expect(useApp.getState().closeAsk).toEqual({ id: 'q', at: 'popout', stops: { kind: 'claude', doing: 'waiting' }, note: 'resume' });
    expect(close).not.toHaveBeenCalled();
  });

  // Under Resume the continuation is lost all the same.
  test('a session paused at its usage limit still asks; once the pause ended, or with an older atelierd, it closes at once', () => {
    keepOn();
    const limited = (id: string, limitPause?: SessionInfo['limitPause']): TerminalInfo => {
      const x = talked(id, 'error');
      return { ...x, session: { ...x.session!, errorReason: 'rate_limit', ...(limitPause ? { limitPause } : {}) } };
    };
    useApp.setState({ terminals: [limited('p', { since: 1, resetsAt: 9 }), limited('e', { since: 1, resetsAt: 9, over: 'expired' }), limited('o')] });
    useApp.getState().askClose('p', 'row');
    expect(useApp.getState().closeAsk).toEqual({ id: 'p', at: 'row', stops: { kind: 'claude', doing: 'paused' }, note: 'resume' });
    expect(close).not.toHaveBeenCalled();
    useApp.getState().cancelClose();
    for (const id of ['e', 'o']) useApp.getState().askClose(id, 'row');
    expect(close.mock.calls).toEqual([['e'], ['o']]);
  });

  test('a scheduled prompt still to send asks, with the time of the first one (sent only if resumed in time); one already sent does not', () => {
    keepOn();
    const later = { ...prompt('a', 'pending'), id: 'p-a2', at: 9_000 };
    useApp.setState({ terminals: [talked('a', 'done'), talked('b', 'done'), talked('c', 'done')], schedules: [later, { ...prompt('a', 'pending'), at: 5_000 }, prompt('b', 'armed'), prompt('c', 'sent')] });
    useApp.getState().askClose('a', 'tab');
    expect(useApp.getState().closeAsk).toEqual({ id: 'a', at: 'tab', stops: { kind: 'claude', doing: 'idle' }, note: 'resume-scheduled', promptAt: 5_000 });
    useApp.getState().askClose('b', 'tab');
    expect(useApp.getState().closeAsk?.note).toBe('resume-scheduled');
    useApp.getState().askClose('c', 'tab');
    expect(close).toHaveBeenCalledWith('c');
  });

  test('a session with no message yet is not kept: asked as today', () => {
    keepOn();
    useApp.setState({ terminals: [talked('n', 'idle', null)] });
    useApp.getState().askClose('n', 'row');
    expect(useApp.getState().closeAsk).toEqual({ id: 'n', at: 'row', stops: { kind: 'claude', doing: 'idle' }, note: 'history' });
  });

  test('setting off, or an atelierd that can\'t give it back: asked as today', () => {
    useApp.setState({ terminals: [talked('d', 'done')] });
    useApp.getState().askClose('d', 'row');
    expect(useApp.getState().closeAsk?.note).toBe('history');
    useApp.getState().cancelClose();
    keepOn();
    for (const closeStopAvailable of [false, undefined]) {
      useApp.setState({ daemon: { ...initialDaemon, closeStopAvailable } });
      useApp.getState().askClose('d', 'row');
      expect(useApp.getState().closeAsk?.note).toBe('history');
      useApp.getState().cancelClose();
    }
    expect(close).not.toHaveBeenCalled();
  });

  test('a shell at its prompt still closes at once; a command still asks as today', () => {
    keepOn();
    useApp.getState().askClose('dev', 'row');
    expect(useApp.getState().closeAsk?.note).toBe('history');
    useApp.getState().askClose('sh', 'row');
    expect(close).toHaveBeenCalledWith('sh');
  });
});
