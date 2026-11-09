import { afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest';
import type { ContextProgress, ContextResult } from '@shared/context-usage';
import { compileWorld } from '../compile/index';
import { createClock } from '../engine/clock';
import { contextTokens } from '../world/context';
import { createDemo } from './index';
import { notInDemo } from './not-in-demo';

vi.mock('./not-in-demo', () => ({ notInDemo: vi.fn(), NOT_IN_DEMO_EVENT: 'atelier-demo:not-in-demo' }));

// Context usage in the live demo: the sheet opens on fictional numbers — the
// world's setup and a conversation as large as the session's status line — after a short analysis on the demo's
// clock; the files it lists live on the Mac.
const compiled = compileWorld();
// The bridge loads the analysis as a chunk of its own: loaded once here, so the first test's fake clock counts the
// analysis, not the module's load.
beforeAll(async () => { await import('./context-usage'); });
beforeEach(() => { vi.useFakeTimers(); vi.mocked(notInDemo).mockClear(); });
afterEach(() => { vi.useRealTimers(); });

function demo() {
  const clock = createClock();
  return { ...createDemo(compiled, { version: '9.9.9', now: () => compiled.t0, clock }), clock };
}

test('analysing a session: progress on the demo\'s clock, then a report as large as its status line', async () => {
  const { api } = demo();
  const t = (await api.terminals.list()).find((x) => x.session?.contextPct)!;
  const seen: ContextProgress[] = [];
  api.on.contextProgress((p) => seen.push(p));
  let result: ContextResult | undefined;
  void api.claude.contextUsage(t.id).then((r) => { result = r; });
  await vi.advanceTimersByTimeAsync(300);
  expect(result).toBeUndefined();
  expect(seen[0]).toEqual({ terminalId: t.id, phase: 'start' });
  await vi.advanceTimersByTimeAsync(3000);
  expect(seen.map((p) => p.phase)).toEqual(['start', 'mcp', 'mcp', 'mcp', 'count']);
  expect(seen.filter((p) => p.phase === 'mcp').map((p) => [p.connected, p.total])).toEqual([[1, 4], [3, 4], [4, 4]]);
  expect(seen.every((p) => p.terminalId === t.id)).toBe(true);
  if (!result?.ok) throw new Error(`no report: ${JSON.stringify(result)}`);
  const r = result.report;
  expect(r.total).toBe(contextTokens(t.session!.contextPct!));
  expect(r.model).toBe('claude-opus-5-5');
  expect(r.at).toBe(compiled.t0);
  expect(r.memory[0]!.path.startsWith(t.configDir!)).toBe(true);
  expect(r.servers.map((s) => s.name)).toContain('acme-docs');
  // Nothing about the Mac: it works here.
  expect(notInDemo).not.toHaveBeenCalled();
  // Live, the conversation is where the analysis left it.
  expect(await api.claude.contextLive(t.id)).toBe(r.apiTotal);
});

// As main stops the earlier copy, a new analysis of the same terminal (the sheet closed and opened again
// within the count) stops the one before: its steps end, its answer says Stopped (the renderer drops it).
test('a second analysis of the same terminal stops the first: only its steps go on; the first comes back Stopped', async () => {
  const { api } = demo();
  const t = (await api.terminals.list()).find((x) => x.session?.contextPct)!;
  const seen: ContextProgress[] = [];
  api.on.contextProgress((p) => seen.push(p));
  const first = api.claude.contextUsage(t.id);
  await vi.advanceTimersByTimeAsync(700);
  const second = api.claude.contextUsage(t.id);
  await vi.advanceTimersByTimeAsync(3000);
  expect(await first).toEqual({ ok: false, kind: 'exit', message: 'Stopped' });
  expect((await second).ok).toBe(true);
  const step = (p: ContextProgress) => (p.phase === 'mcp' ? `mcp ${p.connected}` : p.phase);
  expect(seen.map(step)).toEqual(['start', 'mcp 1', 'mcp 3', 'start', 'mcp 1', 'mcp 3', 'mcp 4', 'count']);
  // Another terminal's analysis runs beside it, untouched.
  const other = (await api.terminals.list()).find((x) => x.session && x.id !== t.id)!;
  const a = api.claude.contextUsage(t.id);
  const b = api.claude.contextUsage(other.id);
  await vi.advanceTimersByTimeAsync(3000);
  expect((await a).ok).toBe(true);
  expect((await b).ok).toBe(true);
});

test('the conversation counts live: the session\'s context grows, so does the live count', async () => {
  const { api, context } = demo();
  const t = (await api.terminals.list()).find((x) => x.session?.contextPct)!;
  const before = await api.claude.contextLive(t.id);
  expect(before).toBe(contextTokens(t.session!.contextPct!));
  context.state.terminals = context.state.terminals.map((x) => (x.id === t.id ? { ...x, session: { ...x.session!, contextPct: x.session!.contextPct! + 3 } } : x));
  expect(await api.claude.contextLive(t.id)).toBe(contextTokens(t.session!.contextPct! + 3));
});

test('every scripted session can be analysed', async () => {
  const { api } = demo();
  const sessions = (await api.terminals.list()).filter((x) => x.session);
  expect(sessions.length).toBe(5);
  const results = sessions.map((t) => api.claude.contextUsage(t.id));
  await vi.advanceTimersByTimeAsync(3000);
  for (const r of await Promise.all(results)) expect(r.ok).toBe(true);
});

test('the analysis waits while the demo is paused (hidden), as every beat does', async () => {
  const { api, clock } = demo();
  const t = (await api.terminals.list()).find((x) => x.session)!;
  clock.pause();
  let done = false;
  void api.claude.contextUsage(t.id).then(() => { done = true; });
  await vi.advanceTimersByTimeAsync(10_000);
  expect(done).toBe(false);
  clock.resume();
  await vi.advanceTimersByTimeAsync(3000);
  expect(done).toBe(true);
});

test('a terminal without a Claude session has nothing to analyse; the live count is nothing', async () => {
  const { api, context } = demo();
  const t = (await api.terminals.list())[0]!;
  context.state.terminals = context.state.terminals.map((x) => (x.id === t.id ? { ...x, session: null } : x));
  const r = api.claude.contextUsage(t.id);
  await vi.advanceTimersByTimeAsync(3000);
  expect(await r).toEqual({ ok: false, kind: 'no-session', message: 'No Claude session in this terminal' });
  expect(await api.claude.contextLive(t.id)).toBeNull();
  expect(await api.claude.contextLive('nope')).toBeNull();
});

test('the files the report lists live on the Mac: opening one says so, and nothing opens', async () => {
  const { api } = demo();
  const t = (await api.terminals.list()).find((x) => x.session)!;
  await expect(api.claude.contextOpen(t.id, `${t.configDir}/CLAUDE.md`)).rejects.toThrow('not in the demo');
  expect(notInDemo).toHaveBeenCalledWith('Files outside the project');
});
