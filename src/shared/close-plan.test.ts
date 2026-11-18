import { expect, test } from 'vitest';
import type { TerminalInfo } from '@shared/protocol';
import type { SessionInfo } from '@shared/session';
import { closeStops, keepsSession, keptOnClose } from './close-plan';

const base = { projectRoot: '/p', cwd: '/p', name: null, color: '#fff', createdAt: 0 };
const session = (state: SessionInfo['state']): SessionInfo => ({ sessionId: 's', state, title: null, activity: null, contextPct: null, unread: false, updatedAt: 0 });
const shell: TerminalInfo = { ...base, id: 'a', title: 'Terminal 1', foreground: '/bin/zsh', session: null };
const npm: TerminalInfo = { ...base, id: 'b', title: 'Terminal 2', foreground: '/usr/local/bin/npm', session: null };
const claude = (s: SessionInfo): TerminalInfo => ({ ...base, id: 'c', title: 'Refactor', foreground: '2.1.296', session: s });

test('a shell at its prompt closes at once; anything else says what stops', () => {
  expect(closeStops(shell)).toBeNull();
  expect(closeStops({ ...shell, foreground: '-zsh' })).toBeNull();
  expect(closeStops(npm)).toEqual({ kind: 'process', what: 'npm' });
  expect(closeStops({ ...npm, foreground: 'C:\\Program Files\\nodejs\\node.exe' })).toEqual({ kind: 'process', what: 'node' });
});

test('a Claude session: what it is doing, waiting first', () => {
  expect(closeStops(claude(session('running')))).toEqual({ kind: 'claude', doing: 'working' });
  expect(closeStops(claude(session('waiting')))).toEqual({ kind: 'claude', doing: 'waiting' });
  expect(closeStops(claude(session('done')))).toEqual({ kind: 'claude', doing: 'idle', quiet: true });
  expect(closeStops(claude(session('idle')))).toEqual({ kind: 'claude', doing: 'idle', quiet: true });
  expect(closeStops(claude(session('error')))).toEqual({ kind: 'claude', doing: 'idle', quiet: true });
  // Background work still counting keeps a finished turn working (effectiveState).
  expect(closeStops({ ...claude(session('done')), work: { ...noWork, counting: true } })).toEqual({ kind: 'claude', doing: 'working' });
});

const noWork: NonNullable<TerminalInfo['work']> = { counting: false, agents: 0, shells: 0, monitors: 0, other: 0, idle: 0, items: [], crons: [], entries: [], nextChange: null };

// Quiet: closing loses nothing, so the question says nothing about what stops.
test('an idle session is quiet only when it is known and nothing runs beside it', () => {
  const idle = claude(session('done'));
  expect(closeStops({ ...idle, work: noWork })).toEqual({ kind: 'claude', doing: 'idle', quiet: true });
  // Claude with no session detected yet: what it is doing is unknown.
  expect(closeStops({ ...shell, foreground: 'claude' })).toEqual({ kind: 'claude', doing: 'idle' });
  // Background shells, agents or monitors that don't count as work (the setting off, or past the cap): they stop too.
  const shellItem = { id: 'b1', kind: 'shell' as const, label: 'npm run dev', since: 1, counted: false };
  expect(closeStops({ ...idle, work: { ...noWork, idle: 1, items: [{ kind: 'shell', label: 'npm run dev', counted: false }], entries: [shellItem] } })).toEqual({ kind: 'claude', doing: 'idle' });
  // A server the session started (listed, never counted).
  expect(closeStops({ ...idle, work: { ...noWork, entries: [{ ...shellItem, server: { ports: [5173] } }] } })).toEqual({ kind: 'claude', doing: 'idle' });
  // Its crons and loops: closing ends them.
  expect(closeStops({ ...idle, work: { ...noWork, crons: [{ id: 'c1', label: 'check the deploy', schedule: '*/5 * * * *', recurring: true, next: 9 }] } })).toEqual({ kind: 'claude', doing: 'idle' });
});

// Closing it would stop Claude Code's continuation after the limit.
test('a session paused at its usage limit stops a continuation; an ended pause or none is idle as today', () => {
  const limited = (limitPause?: SessionInfo['limitPause']) => claude({ ...session('error'), errorReason: 'rate_limit', ...(limitPause ? { limitPause } : {}) });
  expect(closeStops(limited({ since: 1, resetsAt: 9 }))).toEqual({ kind: 'claude', doing: 'paused' });
  expect(closeStops(limited({ since: 1, resetsAt: null }))).toEqual({ kind: 'claude', doing: 'paused' });
  expect(closeStops(limited({ since: 1, resetsAt: 9, over: 'expired' }))).toEqual({ kind: 'claude', doing: 'idle', quiet: true });
  expect(closeStops(limited())).toEqual({ kind: 'claude', doing: 'idle', quiet: true });
});

test('Claude started by hand in a plain terminal (no session yet) is Claude too', () => {
  expect(closeStops({ ...shell, foreground: 'claude' })).toEqual({ kind: 'claude', doing: 'idle' });
  expect(closeStops({ ...shell, foreground: '2.1.42' })).toEqual({ kind: 'claude', doing: 'idle' });
});

// `keep` = the setting on and atelierd able to give the session back.
test('keptOnClose: only with keep; a session with no message yet is not kept, an unknown one is; no session yet: atelierd decides', () => {
  const at = (lastMessageAt: number | null | undefined) => claude({ ...session('done'), ...(lastMessageAt === undefined ? {} : { lastMessageAt }) });
  for (const t of [at(5), at(undefined), at(null), shell]) expect(keptOnClose(t, false)).toBe(false);
  expect(keptOnClose(at(5), true)).toBe(true);
  expect(keptOnClose(at(undefined), true)).toBe(true);
  expect(keptOnClose(at(null), true)).toBe(false);
  expect(keptOnClose(shell, true)).toBe(true);
});

test('keepsSession: kept and a Claude session to talk about', () => {
  const at = (lastMessageAt: number | null) => claude({ ...session('running'), lastMessageAt });
  expect(keepsSession(at(5), true)).toBe(true);
  expect(keepsSession(at(5), false)).toBe(false);
  expect(keepsSession(at(null), true)).toBe(false);
  expect(keepsSession(shell, true)).toBe(false);
  expect(keepsSession({ ...shell, foreground: 'claude' }, true)).toBe(false);
});
