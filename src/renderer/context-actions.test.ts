import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { TerminalInfo } from '@shared/protocol';
import type { SessionState } from '@shared/session';
import type { ContextReport } from '@shared/context-usage';
import { useApp } from './store';
import { setTerminalFocuser } from './terminal/focus';
import { forgetDraft, pruneDrafts } from './terminal/drafts';
import { settlePending } from './session-panel';
import { analyzeContext, contextReportOf, openContextSheet, openSelectedContextSheet, runContextCommand } from './context-actions';

const term = (id: string, state: SessionState | null, sessionId = `s-${id}`): TerminalInfo => ({
  id, projectRoot: '/p', cwd: '/p', title: id.toUpperCase(), name: null, color: '#fff', foreground: 'claude', createdAt: 0,
  session: state ? { sessionId, state, title: null, activity: null, contextPct: 12, unread: false, updatedAt: 0 } : null
});
const REPORT = { at: 1, total: 10 } as ContextReport;

const g = globalThis as { window?: unknown };
let input: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.useFakeTimers();
  input = vi.fn();
  g.window = { atelier: { terminals: { input, markSeen: () => Promise.resolve() } } };
  useApp.setState({ terminals: [term('a', 'idle'), term('b', 'done'), term('c', null)], selectedId: 'a', lastSession: null, toast: null, sessionPanel: null, contextSheet: null, contextReports: {} });
});
afterEach(() => {
  for (const id of ['a', 'b']) { forgetDraft(id); settlePending(id); }
  pruneDrafts(new Set());
  delete g.window;
  vi.useRealTimers();
  setTerminalFocuser(() => {});
  useApp.setState({ terminals: [], contextSheet: null, contextReports: {}, sessionPanel: null });
});

test('opening it shows the session first, closes the Session panel and the palette; a plain terminal has none', async () => {
  useApp.setState({ sessionPanel: 'a', paletteOpen: true });
  openContextSheet('b');
  expect(useApp.getState().selectedId).toBe('b');
  await vi.advanceTimersByTimeAsync(10);
  expect(useApp.getState()).toMatchObject({ contextSheet: 'b', sessionPanel: null, paletteOpen: false });
  useApp.setState({ contextSheet: null });
  openContextSheet('c');
  await vi.advanceTimersByTimeAsync(10);
  expect(useApp.getState().contextSheet).toBeNull();
});

test('from the menu bar: the selected session, else the last one; none: it says so', async () => {
  openSelectedContextSheet();
  await vi.advanceTimersByTimeAsync(10);
  expect(useApp.getState().contextSheet).toBe('a');
  useApp.setState({ contextSheet: null, selectedId: 'c', lastSession: 'b' });
  openSelectedContextSheet();
  await vi.advanceTimersByTimeAsync(10);
  expect(useApp.getState().contextSheet).toBe('b');
  useApp.setState({ contextSheet: null, selectedId: 'c', lastSession: null });
  openSelectedContextSheet();
  await vi.advanceTimersByTimeAsync(10);
  expect(useApp.getState().contextSheet).toBeNull();
  expect(useApp.getState().toast?.text).toBe('No Claude session to show');
});

test('the sheet goes with its session; a report stays only for the session it was made of', () => {
  useApp.getState().setContextReport('a', 's-a', REPORT);
  useApp.getState().setContextReport('b', 's-b', REPORT);
  useApp.setState({ contextSheet: 'a' });
  expect(contextReportOf(useApp.getState(), term('a', 'idle'))).toBe(REPORT);
  // a's Claude restarted as another session; b's terminal closed.
  useApp.getState().setTerminals([term('a', 'idle', 's-new')]);
  expect(contextReportOf(useApp.getState(), term('a', 'idle', 's-new'))).toBeNull();
  expect(useApp.getState().contextReports).toEqual({});
  expect(useApp.getState().contextSheet).toBe('a');
  useApp.getState().setTerminals([term('a', null)]);
  expect(useApp.getState().contextSheet).toBeNull();
});

test('Run /context types it into the session (at its prompt) and closes the sheet', () => {
  useApp.setState({ contextSheet: 'a' });
  expect(runContextCommand('a')).toBe(true);
  expect(input.mock.calls.map((c) => c[1])).toEqual(['/context']);
  expect(useApp.getState().contextSheet).toBeNull();
});

test('only the newest analysis of a terminal reports back: an older one, stopped by it, is dropped', async () => {
  const resolvers: ((r: unknown) => void)[] = [];
  (g.window as { atelier: Record<string, unknown> }).atelier.claude = { contextUsage: () => new Promise((r) => resolvers.push(r)) };
  const first = { done: vi.fn(), failed: vi.fn() };
  const second = { done: vi.fn(), failed: vi.fn() };
  analyzeContext('a', 's-a', first);
  analyzeContext('a', 's-a2', second);
  // The first comes back Stopped (main replaced it), after the second started.
  resolvers[0]!({ ok: false, kind: 'exit', message: 'Stopped' });
  resolvers[1]!({ ok: true, report: REPORT });
  await vi.waitFor(() => expect(second.done).toHaveBeenCalledWith(REPORT));
  expect(first.failed).not.toHaveBeenCalled();
  expect(first.done).not.toHaveBeenCalled();
  expect(useApp.getState().contextReports.a).toEqual({ sessionId: 's-a2', report: REPORT });
  // Another terminal's runs are its own.
  const other = { done: vi.fn(), failed: vi.fn() };
  analyzeContext('b', 's-b', other);
  resolvers[2]!({ ok: false, kind: 'timeout', message: 'late' });
  await vi.waitFor(() => expect(other.failed).toHaveBeenCalledWith('timeout', 'late'));
});
