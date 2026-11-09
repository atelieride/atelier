import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { useApp } from './store';
import type { Resumable, TerminalInfo } from '@shared/protocol';
import type { SessionInfo } from '@shared/session';

// Resume all / Resume pinned: one at a time, pinned first, each once the previous one's
// Claude has started; Stop leaves the rest under Resume; the tab in front stays in front.

const g = globalThis as { localStorage?: unknown; window?: unknown };
const res = (id: string, endedAt = 0): Resumable => ({ id, projectRoot: '/p', cwd: '/p', title: id, color: '#fff', sessionId: `s-${id}`, endedAt });
const term = (id: string, session = false): TerminalInfo => ({ id, projectRoot: '/p', cwd: '/p', title: id, name: null, color: '#fff', foreground: 'zsh', createdAt: 0, session: session ? ({ sessionId: `s-${id}`, state: 'idle' } as SessionInfo) : null });
let calls: string[];
let replies: Map<string, (info: TerminalInfo | null) => void>;

beforeEach(() => {
  const saved = new Map([['atelier.pins', JSON.stringify({ '/p': ['c'] })]]);
  g.localStorage = { getItem: (k: string) => saved.get(k) ?? null, setItem: (k: string, v: string) => void saved.set(k, v), removeItem: () => {} };
  calls = [];
  replies = new Map();
  g.window = { atelier: { terminals: {
    resume: vi.fn((id: string) => {
      calls.push(id);
      return new Promise<TerminalInfo>((ok, no) => { replies.set(id, (info) => (info ? ok(info) : no(new Error('failed')))); });
    }),
    list: vi.fn(async () => useApp.getState().terminals)
  } } };
  useApp.setState({ terminals: [], pins: [], resumables: [], resumablesKnown: true, project: null, layoutRestored: true, bulkResume: null, toast: null });
  useApp.getState().setProject({ root: '/p', name: 'p', realRoot: '/p' });
  // Most recent first in the section: b, a; c pinned goes first.
  useApp.getState().setResumables([res('a', 1), res('b', 2), res('c', 0)]);
});
afterEach(() => { delete g.localStorage; delete g.window; useApp.setState({ project: null, pins: [], resumables: [], bulkResume: null }); });

const tick = () => new Promise((r) => setTimeout(r, 0));
/** atelierd answers the resume of `id` with terminal `nid`, then (optionally) Claude starts in it. */
async function reply(id: string, nid: string, start = true) {
  replies.get(id)!(term(nid));
  await tick();
  useApp.getState().setResumables(useApp.getState().resumables.filter((r) => r.id !== id));
  if (start) useApp.getState().setTerminals(useApp.getState().terminals.map((t) => (t.id === nid ? term(nid, true) : t)));
  await tick();
}

test('all: pinned first, then the section’s order; the next waits for the previous Claude to start', async () => {
  const done = useApp.getState().resumeAll('all');
  await tick();
  expect(calls).toEqual(['c']);
  expect(useApp.getState().bulkResume).toMatchObject({ total: 3, done: 1, queue: ['b', 'a'] });
  replies.get('c')!(term('c2'));
  await tick();
  // Its Claude has not started yet: nothing else is resumed.
  expect(calls).toEqual(['c']);
  useApp.getState().setTerminals(useApp.getState().terminals.map((t) => (t.id === 'c2' ? term('c2', true) : t)));
  await tick();
  expect(calls).toEqual(['c', 'b']);
  await reply('b', 'b2');
  await reply('a', 'a2');
  await done;
  expect(calls).toEqual(['c', 'b', 'a']);
  expect(useApp.getState().bulkResume).toBeNull();
});

test('pinned: only the pinned ones', async () => {
  const done = useApp.getState().resumeAll('pinned');
  await tick();
  await reply('c', 'c2');
  await done;
  expect(calls).toEqual(['c']);
});

test('Stop: the one starting finishes, the rest stay under Resume', async () => {
  const done = useApp.getState().resumeAll('all');
  await tick();
  useApp.getState().stopResumeAll();
  await reply('c', 'c2');
  await done;
  expect(calls).toEqual(['c']);
  expect(useApp.getState().resumables.map((r) => r.id).sort()).toEqual(['a', 'b']);
  expect(useApp.getState().bulkResume).toBeNull();
});

test('a resume that fails is skipped; the toast counts them at the end; a second Resume All while one runs does nothing', async () => {
  const done = useApp.getState().resumeAll('all');
  await useApp.getState().resumeAll('all');
  await tick();
  replies.get('c')!(null);
  await tick();
  await tick();
  expect(calls).toEqual(['c', 'b']);
  await reply('b', 'b2');
  await reply('a', 'a2');
  await done;
  expect(useApp.getState().toast?.text).toBe('Couldn’t resume 1 session');
});

// A session closed before its first message has no conversation: `claude --resume` prints an error and exits at once.
test('a Claude that exits without starting (an empty conversation) ends the wait: the next one goes, the last one ends the run', async () => {
  const fg = (id: string, foreground: string) => useApp.getState().setTerminals(useApp.getState().terminals.map((t) => (t.id === id ? { ...t, foreground } : t)));
  const done = useApp.getState().resumeAll('all');
  await tick();
  replies.get('c')!(term('c2'));
  await tick();
  fg('c2', 'claude');
  await tick();
  expect(calls).toEqual(['c']);
  fg('c2', 'zsh');
  await tick();
  expect(calls).toEqual(['c', 'b']);
  await reply('b', 'b2');
  replies.get('a')!(term('a2'));
  await tick();
  fg('a2', 'claude');
  fg('a2', 'zsh');
  await done;
  expect(useApp.getState().bulkResume).toBeNull();
});

test('the tab in front stays in front while sessions come back', async () => {
  useApp.getState().setTerminals([term('x', true)]);
  useApp.getState().select('x');
  const done = useApp.getState().resumeAll('pinned');
  await tick();
  await reply('c', 'c2');
  await done;
  expect(useApp.getState().activeKey()).toBe('t:x');
  expect(useApp.getState().tabOrder).toContain('t:c2');
});

test('Dismiss All… asks in the Resume head; Dismiss drops every session waiting in this project, Cancel none', async () => {
  const dismiss = vi.fn(async () => {});
  (g.window as { atelier: { terminals: Record<string, unknown> } }).atelier.terminals.dismiss = dismiss;
  useApp.getState().askDismissAll();
  expect(useApp.getState().dismissAllAsk).toBe(true);
  useApp.getState().cancelDismissAll();
  expect(useApp.getState().dismissAllAsk).toBe(false);
  expect(dismiss).not.toHaveBeenCalled();
  useApp.getState().askDismissAll();
  await useApp.getState().confirmDismissAll();
  expect(dismiss.mock.calls.map((c) => (c as unknown[])[0]).sort()).toEqual(['a', 'b', 'c']);
  expect(useApp.getState().dismissAllAsk).toBe(false);
});

// The question never comes back stale once nothing waits any more (resumed or dismissed by another route).
test('Dismiss All… asked, then the section empties another way: the question goes', () => {
  useApp.getState().askDismissAll();
  useApp.getState().setResumables([]);
  expect(useApp.getState().dismissAllAsk).toBe(false);
});
