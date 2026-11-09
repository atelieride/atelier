import { afterEach, expect, test, vi } from 'vitest';
import type { TerminalInfo } from '@shared/protocol';
import type { SessionInfo, SessionState } from '@shared/session';
import { continueOnPhone, remoteAvailability, remoteCommand, remoteReason } from './remote';
import { setTerminalFocuser } from './terminal/focus';
import { useApp } from './store';

test('the command: /remote-control with the session title as its name', () => {
  expect(remoteCommand('Fix login bug')).toBe('/remote-control Fix login bug');
  // Printable characters only: no escape sequence or line break can reach Claude's prompt as a keystroke.
  expect(remoteCommand('Fix\x1b[2J\r\nlogin\x07 bug\x9b')).toBe('/remote-control Fix[2J login bug');
  expect(remoteCommand('  spaced\t\tout  ')).toBe('/remote-control spaced out');
  // At most 60 characters, never half an emoji.
  const long = 'x'.repeat(59) + '😀' + 'tail';
  expect(remoteCommand(long)).toBe(`/remote-control ${'x'.repeat(59)}😀`);
  expect(remoteCommand('a'.repeat(80))).toBe(`/remote-control ${'a'.repeat(60)}`);
  // Nothing left: no name argument (Claude Code picks one).
  expect(remoteCommand('\x1b\x07  ')).toBe('/remote-control');
  expect(remoteCommand('')).toBe('/remote-control');
});

const term = (state: SessionState | null, foreground = 'claude'): TerminalInfo => ({
  id: 'a', projectRoot: '/p', cwd: '/p', title: 'A', name: null, color: '#fff', foreground, createdAt: 0,
  session: state ? { sessionId: 's', state, title: null, activity: null, contextPct: null, unread: false, updatedAt: 0 } : null
});

test('available only when Claude\'s prompt is free: idle, done or error, with Claude in front; plain terminals never', () => {
  for (const s of ['idle', 'done', 'error'] as const) expect(remoteAvailability(term(s))).toBe('ok');
  // Waiting = a permission or question dialog is open: typed text and Enter would answer it.
  expect(remoteAvailability(term('waiting'))).toBe('waiting');
  expect(remoteAvailability(term('running'))).toBe('busy');
  // Something else in front (Ctrl+G opened an editor, a pager, the shell after Claude exited): not Claude's prompt.
  for (const fg of ['vim', '/usr/bin/less', 'zsh', '-zsh']) expect(remoteAvailability(term('idle', fg))).toBe('busy');
  expect(remoteAvailability(term(null))).toBe('not-claude');
  expect(remoteAvailability(undefined)).toBe('not-claude');
});

test('the reason shown when it is not available', () => {
  expect(remoteReason('waiting')).toBe('Answer Claude first');
  expect(remoteReason('busy')).toBe('Available when Claude\'s prompt is free');
  expect(remoteReason('paused')).toBe('Paused for the usage limit: Claude Code continues it by itself');
  expect(remoteReason('ok')).toBeNull();
});

// Anything typed during the wait would replace Claude Code's continuation.
test('a session paused at its usage limit takes nothing Atelier would type; once the pause ends, its prompt is free again', () => {
  const limited = (limitPause?: SessionInfo['limitPause']): TerminalInfo => {
    const x = term('error');
    return { ...x, session: { ...x.session!, errorReason: 'rate_limit', ...(limitPause ? { limitPause } : {}) } };
  };
  expect(remoteAvailability(limited({ since: 1, resetsAt: 9 }))).toBe('paused');
  expect(remoteAvailability(limited({ since: 1, resetsAt: null }))).toBe('paused');
  expect(remoteAvailability(limited({ since: 1, resetsAt: 9, over: 'cancelled' }))).toBe('ok');
  // An older atelierd never sends the pause: as today.
  expect(remoteAvailability(limited())).toBe('ok');
});

const g = globalThis as { window?: unknown };
afterEach(() => { delete g.window; vi.useRealTimers(); setTerminalFocuser(() => {}); });

function fakeApi(list: TerminalInfo[]) {
  const input = vi.fn();
  g.window = { atelier: { terminals: { input, markSeen: () => Promise.resolve() } } };
  useApp.setState({ terminals: list, selectedId: null, toast: null });
  return input;
}

test('types the command without Enter, focuses the terminal and says to press Enter', () => {
  vi.useFakeTimers();
  const input = fakeApi([term('done')]);
  const focused: string[] = [];
  setTerminalFocuser((id) => focused.push(id));
  continueOnPhone('a');
  // No Enter: a draft already in the prompt would be submitted, or run as a shell command in "!" mode.
  expect(input.mock.calls).toEqual([['a', '/remote-control A']]);
  expect(input.mock.calls.some(([, d]) => String(d).includes('\r') || String(d).includes('\n'))).toBe(false);
  expect(useApp.getState().selectedId).toBe('a');
  expect(useApp.getState().toast?.text).toBe('Press Enter to connect');
  vi.runAllTimers();
  expect(focused).toEqual(['a']);
});

test('while Claude waits for an answer or works, nothing is typed: the reason as a toast', () => {
  const input = fakeApi([term('waiting')]);
  continueOnPhone('a');
  expect(input).not.toHaveBeenCalled();
  expect(useApp.getState().toast?.text).toBe('Answer Claude first');
  useApp.setState({ terminals: [term('running')] });
  continueOnPhone('a');
  expect(input).not.toHaveBeenCalled();
  expect(useApp.getState().toast?.text).toBe('Available when Claude\'s prompt is free');
});

test('states2: disabled while Claude waits for a permission or an answer, available at the idle notice', () => {
  const with2 = (state: SessionState, waitingFor: 'permission' | 'question' | 'input') => ({ ...term(state), session: { ...term(state).session!, waitingFor } });
  expect(remoteAvailability(with2('waiting', 'permission'))).toBe('waiting');
  expect(remoteAvailability(with2('waiting', 'question'))).toBe('waiting');
  // The gating reads waitingFor itself, not only the state.
  expect(remoteAvailability(with2('running', 'question'))).toBe('waiting');
  expect(remoteAvailability(with2('idle', 'input'))).toBe('ok');
  expect(remoteAvailability(with2('done', 'input'))).toBe('ok');
});

test('a session whose only work runs in the background has a free prompt: available', () => {
  const work = { counting: true, agents: 1, shells: 0, monitors: 0, other: 0, idle: 0, items: [], crons: [], entries: [], nextChange: null };
  expect(remoteAvailability({ ...term('done'), work })).toBe('ok');
  expect(remoteAvailability({ ...term('idle'), work })).toBe('ok');
  expect(remoteAvailability({ ...term('done'), work: { ...work, counting: false } })).toBe('ok');
  // The main agent itself working stays busy.
  expect(remoteAvailability({ ...term('running'), work })).toBe('busy');
});
