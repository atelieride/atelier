import { expect, test } from 'vitest';
import type { TerminalInfo } from '@shared/protocol';
import { sendBlocked, sendRows, shellReady } from './send-selection';

const term = (id: string, extra: Partial<TerminalInfo> = {}) => ({ id, title: id, color: '#fff', foreground: 'zsh', session: undefined, ...extra }) as unknown as TerminalInfo;

test('destinations: plain terminals first (their program as the hint), then sessions, busy ones greyed with why', () => {
  const list = [term('claude-a', { session: {} as never, foreground: '2.1.42' }), term('shell', { foreground: '-zsh' }), term('repl', { foreground: '/usr/bin/python3' }), term('claude-b', { session: {} as never })];
  const rows = sendRows(list, {}, (id) => (id === 'claude-b' ? 'Claude is working' : null));
  expect(rows.map((r) => [r.id, r.kind, r.hint, r.off])).toEqual([
    ['shell', 'terminal', 'zsh', false],
    ['repl', 'terminal', 'python3', false],
    ['claude-a', 'session', '', false],
    ['claude-b', 'session', 'Claude is working', true]
  ]);
});

test('a session still starting counts as a session', () => {
  expect(sendRows([term('s')], { s: Date.now() }, () => null)[0]!.kind).toBe('session');
});

test('why the text can\'t go now: gone, a session not waiting for input, lines a terminal would run one by one', () => {
  expect(sendBlocked({ term: undefined, bracketed: true, sessionReason: null }, 'ls', false)).toBe('That terminal has closed.');
  expect(sendBlocked({ term: term('c', { session: {} as never }), bracketed: true, sessionReason: 'Claude is working' }, 'ls', false)).toBe('Claude is working');
  // Without bracketed paste every newline is an Enter: typing several lines would run them.
  expect(sendBlocked({ term: term('t'), bracketed: false, sessionReason: null }, 'a\nb', false)).toMatch(/run each line/);
  expect(sendBlocked({ term: term('t'), bracketed: false, sessionReason: null }, 'a\nb', true)).toBeNull();
  expect(sendBlocked({ term: term('t'), bracketed: false, sessionReason: null }, 'ls', false)).toBeNull();
  expect(sendBlocked({ term: term('t'), bracketed: true, sessionReason: null }, 'a\nb', false)).toBeNull();
});

test('a new terminal is ready for the text once its shell printed and went quiet, bracketed paste on (or after a while without)', () => {
  const base = { listed: true, foreground: 'zsh', bracketed: true, lastOutput: 1000, started: 0, now: 1300 };
  expect(shellReady(base)).toBe(true);
  expect(shellReady({ ...base, listed: false })).toBe(false);
  expect(shellReady({ ...base, lastOutput: 0 })).toBe(false);
  expect(shellReady({ ...base, now: 1100 })).toBe(false);
  // The shell config still runs something (a version manager…): wait.
  expect(shellReady({ ...base, foreground: 'node' })).toBe(false);
  expect(shellReady({ ...base, bracketed: false })).toBe(false);
  expect(shellReady({ ...base, bracketed: false, now: 2600 })).toBe(true);
});
