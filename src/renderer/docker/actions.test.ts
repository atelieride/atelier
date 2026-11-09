import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { DockerContainer } from '@shared/docker';
import type { TerminalInfo } from '@shared/protocol';
import { askInNewSession, FOREGROUND_LAG_MS, sendToSession } from './actions';
import { setBracketedProbe } from '../terminal/focus';
import { useApp } from '../store';
import { t } from '../i18n/en';
import { newSessionIn } from '../launch';
import { typeWhenReadyAs } from '../task-session';

// A new session is only asked for, and the prompt only handed over: the session's start is launch.ts's, its typing
// task-session.ts's (their own tests).
vi.mock('../launch', () => ({ newSessionIn: vi.fn(async () => ({ id: 'term-new' })) }));
vi.mock('../task-session', async (importOriginal) => ({ ...(await importOriginal<typeof import('../task-session')>()), typeWhenReadyAs: vi.fn() }));

const term = (foreground: string, updatedAt: number): TerminalInfo => ({
  id: 'c', projectRoot: '/p', cwd: '/p', title: 'debug', name: 'debug', color: '#fff', foreground, createdAt: 0,
  session: { sessionId: 's', state: 'done', title: null, activity: null, contextPct: null, unread: false, updatedAt, cwd: '/p' } as never
});

const g = globalThis as { window?: unknown };
let input: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(100_000);
  input = vi.fn();
  g.window = { atelier: { terminals: { input, markSeen: () => Promise.resolve() } } };
  setBracketedProbe(() => true);
  useApp.setState({ project: { root: '/p', name: 'p', realRoot: '/p' }, terminals: [], selectedId: null, toast: null });
});
afterEach(() => {
  delete g.window; vi.useRealTimers(); setBracketedProbe(() => false);
  useApp.setState({ project: null, terminals: [], toast: null });
});

// A session that just started (its SessionStart a moment ago) still shows the shell in front until atelierd's next
// foreground read (1 s): Send waits for it instead of saying busy.
test('a session that just reported, the shell still in front: Send waits for Claude to be seen in front, then types', async () => {
  useApp.getState().setTerminals([term('zsh', 99_800)]);
  const done = sendToSession('the key');
  await vi.advanceTimersByTimeAsync(600);
  expect(input).not.toHaveBeenCalled();
  useApp.getState().setTerminals([term('claude', 99_800)]);
  await done;
  expect(input).toHaveBeenCalled();
  expect(useApp.getState().toast).toBeNull();
});

test('still the shell once the wait is over: busy, nothing typed', async () => {
  useApp.getState().setTerminals([term('zsh', 99_800)]);
  const done = sendToSession('the key');
  await vi.advanceTimersByTimeAsync(FOREGROUND_LAG_MS);
  await done;
  expect(input).not.toHaveBeenCalled();
  expect(useApp.getState().toast?.text).toBe(t.remoteBusy);
});

test('a shell in front of a session that reported long ago: busy at once (Claude exited)', async () => {
  useApp.getState().setTerminals([term('zsh', 10_000)]);
  await sendToSession('the key');
  expect(input).not.toHaveBeenCalled();
  expect(useApp.getState().toast?.text).toBe(t.remoteBusy);
});

test('Claude in front: typed at once', async () => {
  useApp.getState().setTerminals([term('claude', 10_000)]);
  await sendToSession('the key');
  expect(input).toHaveBeenCalled();
});

// One "ask in a new session" for Docker, Redis and Databases (askInSession): Docker's name and toast through it.
test('Ask in a New Session: a session "docker <container>", the prompt typed in (not sent), Docker\'s toast', async () => {
  await askInNewSession({ name: 'web' } as DockerContainer, 'Why did it stop?');
  expect(newSessionIn).toHaveBeenCalledWith('docker web');
  expect(typeWhenReadyAs).toHaveBeenCalledWith('term-new', 'Why did it stop?', false, 'The web context is in the prompt. Review it and press Enter to send.');
});
