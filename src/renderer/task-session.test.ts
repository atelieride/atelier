import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { TerminalInfo } from '@shared/protocol';
import type { SessionState } from '@shared/session';
import type { TaskDetail, TaskGetResult, TaskSummary } from '@shared/tasks';
import { ENTER_CAP_MS, ENTER_FLOOR_MS, ENTER_QUIET_MS, READY_TIMEOUT_MS, startSessionFromTask } from './task-session';
import { setBracketedProbe, setOutputProbe, setTerminalFocuser } from './terminal/focus';
import { useApp } from './store';

const summary: TaskSummary = { id: '86fk0002b', displayId: '86fk0002b', title: 'Document the CSV import format', status: { name: 'to do', color: '#87909e' }, url: 'https://app.clickup.com/t/86fk0002b' };
const detail: TaskDetail = { ...summary, body: 'Rows:\n```csv\na,b\n```' };
const term = (id: string, state: SessionState | null, foreground = 'claude'): TerminalInfo => ({
  id, projectRoot: '/p', cwd: '/p', title: 'T', name: null, color: '#fff', foreground, createdAt: 0,
  session: state ? { sessionId: 's', state, title: null, activity: null, contextPct: null, unread: false, updatedAt: 0, cwd: '/p' } as never : null
});

const g = globalThis as { window?: unknown };
let input: ReturnType<typeof vi.fn>;
let createSession: ReturnType<typeof vi.fn>;
let refresh: ReturnType<typeof vi.fn>;
let write: ReturnType<typeof vi.fn>;
let reply: TaskGetResult;
beforeEach(() => {
  vi.useFakeTimers();
  input = vi.fn();
  createSession = vi.fn(() => Promise.resolve(term('new', null, 'zsh')));
  refresh = vi.fn(() => Promise.resolve({}));
  write = vi.fn(() => Promise.resolve(true));
  reply = { ok: true, task: detail };
  g.window = { atelier: {
    tasks: { get: vi.fn(() => Promise.resolve(reply)) },
    terminals: { input, createSession, markSeen: () => Promise.resolve() },
    connectors: { refresh },
    clipboard: { write }
  } };
  setBracketedProbe(() => true);
  useApp.setState({ project: { root: '/p', name: 'p', realRoot: '/p' }, terminals: [], selectedId: null, toast: null, taskLinks: {}, starting: {}, size: { cols: 100, rows: 30 } });
});
afterEach(() => {
  delete g.window; vi.useRealTimers(); setBracketedProbe(() => false); setTerminalFocuser(() => {}); setOutputProbe(() => 0);
  useApp.setState({ project: null, terminals: [], taskLinks: {}, toast: null });
});

/** Claude's SessionStart arrived and its prompt is free. */
const ready = (state: SessionState = 'idle') => useApp.getState().setTerminals([term('new', state)]);

test('a gone task: the message, and no session', async () => {
  reply = { ok: false, reason: 'gone' };
  await startSessionFromTask('clickup', summary, { send: false, side: false });
  expect(useApp.getState().toast?.text).toBe('This task is no longer available in ClickUp.');
  expect(createSession).not.toHaveBeenCalled();
  // Its row leaves the list: the tasks are fetched again.
  expect(refresh).toHaveBeenCalledWith('clickup');
});

test.each([
  ['reconnect', 'ClickUp signed you out. Reconnect to see your tasks.'],
  ['not-connected', "ClickUp isn't connected."],
  ['offline', "Can't reach ClickUp — try again when you're back online."],
  ['failed', "Couldn't get the task from ClickUp. Try again."]
] as const)('no detail (%s): a message, and no session', async (reason, text) => {
  reply = { ok: false, reason };
  await startSessionFromTask('clickup', summary, { send: false, side: false });
  expect(useApp.getState().toast?.text).toBe(text);
  expect(createSession).not.toHaveBeenCalled();
});

test('offline (a greyed row, or any failure while the connector is offline): says why, and Retry starts it once ClickUp answers', async () => {
  const card = (status: 'offline' | 'connected') => ({ id: 'clickup' as const, name: 'ClickUp', status, loading: false, tasksVersion: 1, options: { show: 'assigned' as const, includeClosed: false } });
  useApp.setState({ connectors: [card('offline')] });
  try {
    reply = { ok: false, reason: 'failed' };
    await startSessionFromTask('clickup', summary, { send: true, side: false });
    const toast = useApp.getState().toast!;
    expect(toast.text).toBe("Can't reach ClickUp — try again when you're back online.");
    expect(toast.action?.label).toBe('Retry');
    expect(createSession).not.toHaveBeenCalled();
    // Back online: Retry fetches the task again and starts the session as asked (⌘Enter kept).
    useApp.setState({ connectors: [card('connected')] });
    reply = { ok: true, task: detail };
    toast.action!.run();
    await vi.advanceTimersByTimeAsync(0);
    expect(createSession).toHaveBeenCalledTimes(1);
    ready('idle');
    await vi.advanceTimersByTimeAsync(400 + ENTER_FLOOR_MS);
    expect(input.mock.calls.at(-1)![1]).toBe('\r');
    // A task ClickUp says is gone stays gone, offline or not.
    useApp.setState({ connectors: [card('offline')] });
    useApp.getState().showToast(null);
    reply = { ok: false, reason: 'gone' };
    await startSessionFromTask('clickup', { ...summary, id: '86fk0003c' }, { send: false, side: false });
    expect(useApp.getState().toast?.text).toBe('This task is no longer available in ClickUp.');
  } finally { useApp.setState({ connectors: [] }); }
});

test('Enter: a session named after the task, linked; once Claude is ready the prompt is typed as one paste, not sent', async () => {
  await startSessionFromTask('clickup', summary, { send: false, side: false });
  expect(createSession).toHaveBeenCalledWith({ cols: 100, rows: 30, name: '86fk0002b Document the CSV import format' });
  expect(useApp.getState().taskLinks.new).toEqual({ source: 'clickup', taskId: '86fk0002b', displayId: '86fk0002b', title: 'Document the CSV import format', url: 'https://app.clickup.com/t/86fk0002b' });
  expect(useApp.getState().selectedId).toBe('new');
  // Claude hasn't started: nothing typed.
  await vi.advanceTimersByTimeAsync(2000);
  expect(input).not.toHaveBeenCalled();
  // Started but still busy: still nothing.
  ready('running');
  await vi.advanceTimersByTimeAsync(2000);
  expect(input).not.toHaveBeenCalled();
  ready('idle');
  await vi.advanceTimersByTimeAsync(1000);
  const sent = input.mock.calls.map((c) => c[1] as string).join('');
  expect(input.mock.calls.every((c) => c[0] === 'new')).toBe(true);
  expect(sent.startsWith('\x1b[200~If a ClickUp MCP server is available, use it to read the whole task (description, comments, subtasks, attachments) before you start.\r\rClickUp task 86fk0002b: Document the CSV import format\r')).toBe(true);
  expect(sent).toContain('\r````markdown\rRows:\r```csv\ra,b\r```\r````');
  // One paste, nothing after it: you read it and press Enter.
  expect(sent.endsWith('\x1b[201~')).toBe(true);
  expect(sent.match(/\x1b\[200~/g)).toHaveLength(1);
  expect(useApp.getState().toast?.text).toBe('86fk0002b is in the prompt · press Enter to send');
  // A notice, not an error: it never shows in the error color.
  expect(useApp.getState().toast?.tone).toBe('info');
  // Typed once.
  await vi.advanceTimersByTimeAsync(5000);
  expect(input.mock.calls.map((c) => c[1] as string).join('')).toBe(sent);
});

test('an account picked in the task\'s account step: the session starts with it', async () => {
  await startSessionFromTask('clickup', summary, { send: false, side: false, account: 'ops' });
  expect(createSession).toHaveBeenCalledWith({ cols: 100, rows: 30, name: '86fk0002b Document the CSV import format', account: 'ops' });
});

/** Every write to the terminal with when it happened (fake time). */
const writes = () => input.mock.calls.map((c, i) => ({ data: c[1] as string, at: input.mock.results[i]!.value as number }));
const timedInput = () => input.mockImplementation(() => Date.now());

test('⌘Enter: typed and sent — the Enter is its own write, at least ENTER_FLOOR_MS after the paste', async () => {
  timedInput();
  await startSessionFromTask('clickup', summary, { send: true, side: false });
  ready('done');
  await vi.advanceTimersByTimeAsync(400);
  const pasteEnd = writes().find((w) => w.data.endsWith('\x1b[201~'));
  expect(pasteEnd).toBeDefined();
  // Claude Code handles a long paste asynchronously: an Enter in the same read could be lost.
  expect(writes().some((w) => w.data.includes('\r') && w.data !== '\r' && w.data.includes('\x1b[201~'))).toBe(false);
  expect(writes().filter((w) => w.data === '\r')).toEqual([]);
  await vi.advanceTimersByTimeAsync(ENTER_FLOOR_MS);
  const enter = writes().filter((w) => w.data === '\r');
  expect(enter).toHaveLength(1);
  expect(enter[0]!.at - pasteEnd!.at).toBeGreaterThanOrEqual(ENTER_FLOOR_MS);
  expect(writes().at(-1)!.data).toBe('\r');
});

test('⌘Enter: while Claude is still drawing the paste the Enter waits for the output to settle, up to a cap', async () => {
  timedInput();
  let lastOutput = 0;
  setOutputProbe(() => lastOutput);
  await startSessionFromTask('clickup', summary, { send: true, side: false });
  ready('done');
  await vi.advanceTimersByTimeAsync(400);
  const pasteAt = writes().find((w) => w.data.endsWith('\x1b[201~'))!.at;
  // Output keeps coming for a second: no Enter yet.
  for (let i = 0; i < 10; i++) { lastOutput = Date.now(); await vi.advanceTimersByTimeAsync(100); }
  expect(writes().filter((w) => w.data === '\r')).toEqual([]);
  // Quiet: the Enter follows.
  await vi.advanceTimersByTimeAsync(ENTER_QUIET_MS + 100);
  expect(writes().filter((w) => w.data === '\r')).toHaveLength(1);

  // Output that never stops: sent at the cap anyway.
  input.mockClear();
  useApp.setState({ terminals: [], starting: {} });
  createSession.mockImplementation(() => Promise.resolve(term('new2', null, 'zsh')));
  await startSessionFromTask('clickup', { ...summary, id: '86fk0003c' }, { send: true, side: false });
  useApp.getState().setTerminals([term('new2', 'idle')]);
  await vi.advanceTimersByTimeAsync(400);
  const second = writes().find((w) => w.data.endsWith('\x1b[201~'))!.at;
  const stop = setInterval(() => { lastOutput = Date.now(); }, 20);
  await vi.advanceTimersByTimeAsync(ENTER_CAP_MS + 200);
  clearInterval(stop);
  const enter = writes().filter((w) => w.data === '\r');
  expect(enter).toHaveLength(1);
  expect(enter[0]!.at - second).toBeLessThanOrEqual(ENTER_CAP_MS + 60);
  expect(pasteAt).toBeGreaterThan(0);
});

test('never typed into a program without bracketed paste (every newline would submit), nor while Claude waits on a dialog', async () => {
  setBracketedProbe(() => false);
  await startSessionFromTask('clickup', summary, { send: false, side: false });
  ready('idle');
  await vi.advanceTimersByTimeAsync(3000);
  expect(input).not.toHaveBeenCalled();
  setBracketedProbe(() => true);
  useApp.getState().setTerminals([{ ...term('new', 'waiting'), session: { ...term('new', 'waiting').session!, waitingFor: 'permission' } as never }]);
  await vi.advanceTimersByTimeAsync(3000);
  expect(input).not.toHaveBeenCalled();
  ready('idle');
  await vi.advanceTimersByTimeAsync(1000);
  expect(input).toHaveBeenCalled();
});

test('Claude never gets ready: nothing typed, a notice that offers the prompt to copy', async () => {
  await startSessionFromTask('clickup', summary, { send: false, side: false });
  await vi.advanceTimersByTimeAsync(READY_TIMEOUT_MS + 1000);
  expect(input).not.toHaveBeenCalled();
  const toast = useApp.getState().toast!;
  expect(toast.text).toBe("Claude didn't get ready in time, so the task wasn't typed.");
  expect(toast.action?.label).toBe('Copy Prompt');
  toast.action!.run();
  expect((write.mock.calls[0]![0] as string)).toContain('\n\nClickUp task 86fk0002b: ');
  // Ready later: still nothing typed (the notice said so).
  ready('idle');
  await vi.advanceTimersByTimeAsync(2000);
  expect(input).not.toHaveBeenCalled();
});

test('the session closed before Claude was ready: the wait ends quietly', async () => {
  await startSessionFromTask('clickup', summary, { send: false, side: false });
  ready('running');
  await vi.advanceTimersByTimeAsync(500);
  useApp.getState().setTerminals([term('other', null, 'zsh')]);
  await vi.advanceTimersByTimeAsync(READY_TIMEOUT_MS + 1000);
  expect(input).not.toHaveBeenCalled();
  expect(useApp.getState().toast).toBeNull();
});

test('a second Enter on the same task while it is being fetched starts one session', async () => {
  await Promise.all([
    startSessionFromTask('clickup', summary, { send: false, side: false }),
    startSessionFromTask('clickup', summary, { send: false, side: false })
  ]);
  expect(createSession).toHaveBeenCalledTimes(1);
});
