import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { TerminalInfo } from '@shared/protocol';
import type { SessionInfo } from '@shared/session';
import type { BackgroundWork } from '@shared/background';
import { EXIT_MS } from '@shared/session-restart';
import { useApp } from './store';
import { UNSEEN_SHELL_MS, restartShellReady, stopRestartLoop } from './session-restart';
import { settlePending } from './session-panel';
import { forgetDraft, sendInput } from './terminal/drafts';
import { restartFromMenu } from './restart-actions';
import { initPlatform, resetPlatformForTests } from '@shared/platform';

// Restart Session in the store: now, asked first, or armed; then the steps in the terminal.

const SID = '0b5c8f0e-1111-4222-8333-944455556666';
const input = vi.fn();
const restartCommand = vi.fn(async () => `claude --resume '${SID}'`);
const base = { projectRoot: '/p', cwd: '/p', name: null, color: '#4FC3D9', createdAt: 0 };
const session = (state: SessionInfo['state'], over: Partial<SessionInfo> = {}): SessionInfo => ({ sessionId: SID, state, title: null, activity: null, contextPct: null, unread: false, updatedAt: 0, ...over });
const term = (s: SessionInfo | null, over: Partial<TerminalInfo> = {}): TerminalInfo => ({ ...base, id: 'a', title: 'auth', foreground: s ? '2.1.302' : 'zsh', session: s, ...over });
const work = (n: number): BackgroundWork => ({ counting: false, agents: n, shells: 0, monitors: 0, other: 0, idle: 0, items: Array.from({ length: n }, () => ({ kind: 'agent' as const, label: 'x', counted: true })), crons: [], entries: [], nextChange: null });
const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
  (globalThis as unknown as { window: unknown }).window = { atelier: { terminals: { input }, claude: { restartCommand } } };
  input.mockClear();
  restartCommand.mockClear();
  // An earlier test's `/exit` whose Enter never went (fake timers) would keep the prompt busy.
  settlePending('a');
  // A terminal listed by an earlier test counts as holding an unseen draft (drafts.ts adoptTerminals).
  forgetDraft('a');
  useApp.setState({ terminals: [term(session('idle'))], restarts: {}, restartAsk: null, starting: {}, toast: null });
});
afterEach(() => {
  stopRestartLoop();
  vi.useRealTimers();
  delete (globalThis as unknown as { window?: unknown }).window;
});

test('Claude free: asks main for the command, then types /exit (its Enter follows once the terminal settles)', async () => {
  useApp.getState().restartSession('a');
  await flush();
  expect(restartCommand).toHaveBeenCalledWith('a', SID);
  expect(input).toHaveBeenCalledWith('a', '/exit');
  expect(useApp.getState().restarts.a).toMatchObject({ armed: false, sessionId: SID, phase: { kind: 'exiting' } });
});

test('Claude working: armed, nothing typed; it starts once the turn is over', async () => {
  useApp.setState({ terminals: [term(session('running'))] });
  useApp.getState().restartSession('a');
  await flush();
  expect(useApp.getState().restarts.a).toEqual({ armed: true });
  expect(input).not.toHaveBeenCalled();
  useApp.setState({ terminals: [term(session('done'))] });
  vi.advanceTimersByTime(200);
  await flush();
  expect(input).toHaveBeenCalledWith('a', '/exit');
});

test('Don\'t Restart: the armed restart goes; Claude quitting meanwhile drops it too', async () => {
  useApp.setState({ terminals: [term(session('running'))] });
  useApp.getState().restartSession('a');
  useApp.getState().cancelRestart('a');
  expect(useApp.getState().restarts.a).toBeUndefined();
  useApp.getState().restartSession('a');
  useApp.setState({ terminals: [term(null)] });
  vi.advanceTimersByTime(200);
  expect(useApp.getState().restarts.a).toBeUndefined();
});

test('background work running: asked first; Restart When Done arms, Restart now starts, Cancel drops', async () => {
  useApp.setState({ terminals: [term(session('idle'), { work: work(2) })] });
  useApp.getState().restartSession('a', 'panel');
  expect(useApp.getState().restartAsk).toEqual({ id: 'a', at: 'panel' });
  useApp.getState().answerRestart('cancel');
  expect(useApp.getState().restartAsk).toBeNull();
  expect(useApp.getState().restarts.a).toBeUndefined();
  useApp.getState().restartSession('a');
  useApp.getState().answerRestart('later');
  expect(useApp.getState().restarts.a).toEqual({ armed: true });
  useApp.getState().cancelRestart('a');
  useApp.getState().restartSession('a');
  useApp.getState().answerRestart('now');
  await flush();
  expect(input).toHaveBeenCalledWith('a', '/exit');
});

test('Claude quit: the terminal stays a (starting) session row, the shell then gets the resume command', async () => {
  useApp.getState().restartSession('a');
  await flush();
  useApp.getState().applyTerminals([term(null)]);
  useApp.setState({ terminals: [term(null)] });
  expect(useApp.getState().starting.a).toBeDefined();
  vi.advanceTimersByTime(200);
  expect(useApp.getState().restarts.a).toMatchObject({ phase: { kind: 'shell' } });
});

test('the shell at its prompt: the resume command is typed into it, then the session back ends the restart', async () => {
  useApp.getState().restartSession('a');
  await flush();
  useApp.setState({ terminals: [term(null)] });
  vi.advanceTimersByTime(200);
  // shellReady: output quiet, bracketed paste on or long enough (send-selection.ts); 2.5 s covers it without output.
  vi.advanceTimersByTime(3_000);
  expect(input.mock.calls.flat().join('')).toContain(`claude --resume '${SID}'`);
  expect(useApp.getState().restarts.a).toMatchObject({ phase: { kind: 'relaunching' } });
  useApp.setState({ terminals: [term(session('idle'))] });
  vi.advanceTimersByTime(200);
  expect(useApp.getState().restarts.a).toBeUndefined();
});

test('Claude never quits: after EXIT_MS the restart stops with its reason; nothing else is typed', async () => {
  useApp.getState().restartSession('a');
  await flush();
  input.mockClear();
  vi.advanceTimersByTime(EXIT_MS + 300);
  expect(useApp.getState().restarts.a).toBeUndefined();
  expect(useApp.getState().toast?.text).toMatch(/didn't quit/);
  // (The `/exit`'s own Enter may still go: the resume command never does.)
  expect(input.mock.calls.flat().join('')).not.toContain('--resume');
});

test('restartShellReady: the prompt drawn and quiet when output is seen; else the shell in front long enough', () => {
  expect(restartShellReady('zsh', true, 1000, 0, 1300)).toBe(true);
  expect(restartShellReady('zsh', true, 1000, 0, 1100)).toBe(false);
  expect(restartShellReady('tmux', true, 1000, 0, 5000)).toBe(false);
  expect(restartShellReady('zsh', false, 0, 0, UNSEEN_SHELL_MS - 1)).toBe(false);
  expect(restartShellReady('zsh', false, 0, 0, UNSEEN_SHELL_MS)).toBe(true);
  expect(restartShellReady('2.1.302', false, 0, 0, 9000)).toBe(false);
});

test('armed: a shell Claude left running (no longer counted as work) never keeps it waiting (review 1)', async () => {
  const idleShell: BackgroundWork = { ...work(0), shells: 1, items: [{ kind: 'shell', label: 'npm run dev', counted: false }] };
  useApp.setState({ terminals: [term(session('running'), { work: idleShell })] });
  useApp.getState().restartSession('a');
  expect(useApp.getState().restarts.a).toEqual({ armed: true });
  useApp.setState({ terminals: [term(session('done'), { work: idleShell })] });
  vi.advanceTimersByTime(200);
  await flush();
  expect(input).toHaveBeenCalledWith('a', '/exit');
});

test('armed: a draft in Claude\'s prompt keeps it waiting, nothing typed (review 14)', async () => {
  useApp.setState({ terminals: [term(session('running'))] });
  useApp.getState().restartSession('a');
  useApp.setState({ terminals: [term(session('done'))] });
  sendInput('a', 'half a thought');
  vi.advanceTimersByTime(500);
  await flush();
  expect(input).not.toHaveBeenCalledWith('a', '/exit');
  expect(useApp.getState().restarts.a).toEqual({ armed: true });
});

test('work starting while main builds the command: armed, no /exit (review 5)', async () => {
  restartCommand.mockImplementationOnce(async () => {
    useApp.setState({ terminals: [term(session('idle'), { work: work(1) })] });
    return `claude --resume '${SID}'`;
  });
  useApp.getState().restartSession('a');
  await flush();
  expect(input).not.toHaveBeenCalled();
  expect(useApp.getState().restarts.a).toEqual({ armed: true });
});

test('a failed restart leaves no "starting" row behind (review 3)', async () => {
  useApp.getState().restartSession('a');
  await flush();
  useApp.getState().applyTerminals([term(null, { foreground: 'tmux' })]);
  useApp.setState({ terminals: [term(null, { foreground: 'tmux' })] });
  expect(useApp.getState().starting.a).toBeDefined();
  vi.advanceTimersByTime(3_000);
  expect(useApp.getState().restarts.a).toBeUndefined();
  expect(useApp.getState().toast?.text).toMatch(/isn't in front/);
  expect(useApp.getState().starting.a).toBeUndefined();
});

test('the question goes when its session ends, and the panel\'s when the panel closes (review 6)', () => {
  useApp.setState({ terminals: [term(session('idle'), { work: work(2) })], sessionPanel: 'a' });
  useApp.getState().restartSession('a', 'panel');
  expect(useApp.getState().restartAsk).not.toBeNull();
  useApp.getState().setSessionPanel(null);
  expect(useApp.getState().restartAsk).toBeNull();
  useApp.getState().restartSession('a', 'row');
  useApp.getState().applyTerminals([term(null)]);
  expect(useApp.getState().restartAsk).toBeNull();
});

test('restartWithNewMcp: the free sessions now, a busy one armed (review 14)', async () => {
  const b = term(session('running', { sessionId: '1b5c8f0e-1111-4222-8333-944455556666' }), { id: 'b', title: 'b' });
  useApp.setState({ terminals: [term(session('idle')), b], mcpAdded: { a: ['posthog'], b: ['posthog'] } });
  settlePending('b'); forgetDraft('b');
  useApp.getState().restartWithNewMcp();
  await flush();
  expect(input).toHaveBeenCalledWith('a', '/exit');
  expect(useApp.getState().restarts.b).toEqual({ armed: true });
});

test('from a menu with a draft in the prompt: the toast says what it waits for (review 9)', () => {
  sendInput('a', 'half a thought');
  restartFromMenu('a');
  expect(useApp.getState().restarts.a).toEqual({ armed: true });
  expect(useApp.getState().toast?.text).toMatch(/draft/);
});

test('restartShellReady on Windows: the shell in front at least UNSEEN_SHELL_MS (PSReadLine draws its prompt late) (review 11)', () => {
  initPlatform('win32');
  try {
    expect(restartShellReady('pwsh', true, 1000, 900, 1300)).toBe(false);
    expect(restartShellReady('pwsh', true, 1000, 0, UNSEEN_SHELL_MS)).toBe(true);
  } finally { resetPlatformForTests(); }
});

test('no session: nothing happens', async () => {
  useApp.setState({ terminals: [term(null)] });
  useApp.getState().restartSession('a');
  await flush();
  expect(useApp.getState().restarts).toEqual({});
  expect(restartCommand).not.toHaveBeenCalled();
});
