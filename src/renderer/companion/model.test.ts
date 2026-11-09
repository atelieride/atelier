import { describe, expect, test, vi } from 'vitest';
import type { TerminalInfo } from '@shared/protocol';
import type { SessionInfo } from '@shared/session';
import { parseInline, type Inline } from '@shared/companion/answer';
import { initPlatform, resetPlatformForTests } from '@shared/platform';
import type { Thread, ThreadItem } from '@shared/companion/types';
import { newThread } from '@shared/companion/thread';
import {
  ASK_WIDTH, TERM_MIN, bindingOf, chipLookups, dockMode, lastActivityOf, pruneThreads, reduceEvent, resolveChip, stripIpcError, askPromptReason,
  type AskModelState
} from './model';

const session = (o: Partial<SessionInfo> = {}): SessionInfo => ({
  sessionId: 's1', state: 'idle', title: null, activity: null, contextPct: null, unread: false, updatedAt: 0, ...o
});
const term = (s: SessionInfo | null, o: Partial<TerminalInfo> = {}): TerminalInfo => ({
  id: 't1', projectRoot: '/p', cwd: '/p/sub', title: 'Fix login', name: null, color: '#fff', foreground: 'claude', createdAt: 0, session: s, ...o
});
const UUID = '11111111-1111-4111-8111-111111111111';
const thread = (items: ThreadItem[], o: Partial<Thread> = {}): Thread => ({ ...newThread('s1', UUID, 0), items, ...o });
const empty = (): AskModelState => ({ askThreads: {}, askRuns: {}, askTexts: {} });

describe('bindingOf', () => {
  test('a plain terminal has none', () => expect(bindingOf(term(null))).toBeNull());
  test('a session: ids, its cwd, config dir and title', () => {
    expect(bindingOf(term(session({ cwd: '/p/deep' }), { configDir: '/c/work' }))).toEqual({ terminalId: 't1', sessionId: 's1', cwd: '/p/deep', configDir: '/c/work', title: 'Fix login' });
  });
  test('cwd falls back to the terminal, configDir to null', () => {
    expect(bindingOf(term(session()))).toEqual({ terminalId: 't1', sessionId: 's1', cwd: '/p/sub', configDir: null, title: 'Fix login' });
  });
});

describe('reduceEvent', () => {
  test('started creates a run, deltas and trace lines append to their run', () => {
    let s = reduceEvent(empty(), { sessionId: 's1', kind: 'started', runId: 'r1', questionId: 'q1' }, 100);
    s = reduceEvent(s, { sessionId: 's1', kind: 'trace', runId: 'r1', line: 'Read a.ts' }, 101);
    s = reduceEvent(s, { sessionId: 's1', kind: 'delta', runId: 'r1', text: 'Hel' }, 102);
    s = reduceEvent(s, { sessionId: 's1', kind: 'delta', runId: 'r1', text: 'lo' }, 103);
    expect(s.askRuns.r1).toEqual({ runId: 'r1', sessionId: 's1', queued: false, trace: ['Read a.ts'], traceAt: 0, text: 'Hello', questionId: 'q1', startedAt: 100 });
  });
  test('a trace line notes how much text had arrived (later text means it finished reading it)', () => {
    let s = reduceEvent(empty(), { sessionId: 's1', kind: 'started', runId: 'r1', questionId: 'q1' }, 100);
    s = reduceEvent(s, { sessionId: 's1', kind: 'delta', runId: 'r1', text: 'Half ' }, 101);
    s = reduceEvent(s, { sessionId: 's1', kind: 'trace', runId: 'r1', line: 'Read b.ts' }, 102);
    expect(s.askRuns.r1).toMatchObject({ trace: ['Read b.ts'], traceAt: 5 });
    // A run that waited its turn keeps what it had when it starts.
    s = reduceEvent(s, { sessionId: 's1', kind: 'started', runId: 'r1', questionId: 'q1' }, 103);
    expect(s.askRuns.r1).toMatchObject({ trace: ['Read b.ts'], traceAt: 5, text: 'Half ' });
  });
  test('queued then started: the same run leaves the queue', () => {
    let s = reduceEvent(empty(), { sessionId: 's1', kind: 'queued', runId: 'r2', questionId: 'q2' }, 5);
    expect(s.askRuns.r2?.queued).toBe(true);
    s = reduceEvent(s, { sessionId: 's1', kind: 'started', runId: 'r2', questionId: 'q2' }, 9);
    expect(s.askRuns.r2).toMatchObject({ queued: false, startedAt: 9 });
  });
  test('several runs of one session coexist', () => {
    let s = reduceEvent(empty(), { sessionId: 's1', kind: 'started', runId: 'a', questionId: 'qa' }, 1);
    s = reduceEvent(s, { sessionId: 's1', kind: 'queued', runId: 'b', questionId: 'qb' }, 2);
    expect(Object.keys(s.askRuns).sort()).toEqual(['a', 'b']);
  });
  test('a trace or delta for an unknown run is ignored', () => {
    expect(reduceEvent(empty(), { sessionId: 's1', kind: 'delta', runId: 'zz', text: 'x' }, 1).askRuns).toEqual({});
  });
  test('a thread replaces the thread and keeps a run whose question is not answered', () => {
    let s = reduceEvent(empty(), { sessionId: 's1', kind: 'started', runId: 'r1', questionId: 'q1' }, 100);
    s = reduceEvent(s, { sessionId: 's1', kind: 'thread', thread: thread([{ kind: 'question', id: 'q1', at: 100, text: 'why?' }]) }, 101);
    expect(s.askThreads.s1?.items).toHaveLength(1);
    expect(s.askRuns.r1).toBeDefined();
  });
  test('an answer, an error or a catch-up in the thread never clear a run: only ended does', () => {
    const data = { points: [], where: '', choices: [], leftOpen: null };
    let s = reduceEvent({ ...empty(), askTexts: { r1: 'why?', other: 'x' } }, { sessionId: 's1', kind: 'started', runId: 'r1', questionId: 'q1' }, 100);
    s = reduceEvent(s, { sessionId: 's1', kind: 'started', runId: 'r2', questionId: null }, 100);
    const items: ThreadItem[] = [
      { kind: 'answer', id: 'a1', at: 120, questionId: 'q1', markdown: 'because', read: [], model: 'sonnet', costUsd: null },
      { kind: 'error', id: 'e', at: 150, questionId: null, reason: 'chat-unreadable', message: 'm' },
      { kind: 'catchup', id: 'c', at: 150, data, read: [], model: 'haiku', final: false }
    ];
    s = reduceEvent(s, { sessionId: 's1', kind: 'thread', thread: thread(items) }, 121);
    expect(Object.keys(s.askRuns).sort()).toEqual(['r1', 'r2']);
    s = reduceEvent(s, { sessionId: 's1', kind: 'ended', runId: 'r1' }, 122);
    expect(Object.keys(s.askRuns)).toEqual(['r2']);
    expect(s.askTexts).toEqual({ other: 'x' });
    expect(reduceEvent(s, { sessionId: 's1', kind: 'ended', runId: 'nope' }, 123)).toBe(s);
  });
  test("another session's runs are untouched by a thread", () => {
    let s = reduceEvent(empty(), { sessionId: 's2', kind: 'started', runId: 'r9', questionId: null }, 1);
    s = reduceEvent(s, { sessionId: 's1', kind: 'thread', thread: thread([]) }, 2);
    expect(s.askRuns.r9).toBeDefined();
  });
});

describe('dockMode', () => {
  test('docks when the terminal keeps its minimum', () => {
    expect(dockMode(1126)).toBe('dock');
    expect(dockMode(ASK_WIDTH + TERM_MIN)).toBe('dock');
    expect(dockMode(ASK_WIDTH + TERM_MIN - 1)).toBe('sheet');
    expect(dockMode(563)).toBe('sheet');
  });
});

describe('stripIpcError', () => {
  test('removes the Electron invoke prefix', () => {
    expect(stripIpcError(new Error("Error invoking remote method 'companion:ask': Error: Question too long"))).toBe('Question too long');
    expect(stripIpcError("Error invoking remote method 'companion:thread': Bad binding")).toBe('Bad binding');
  });
  test('leaves other messages alone', () => {
    expect(stripIpcError(new Error('boom'))).toBe('boom');
    expect(stripIpcError(42)).toBe('42');
  });
});

describe('lastActivityOf', () => {
  test('the later of the last message and the latest attribution of the session', () => {
    const t = term(session({ lastMessageAt: 100 }));
    expect(lastActivityOf(t, 's1', [{ sessionId: 's1', at: 300 }, { sessionId: 'x', at: 900 }, { sessionId: 's1', at: 999, maybe: true }])).toBe(300);
    expect(lastActivityOf(t, 's1', [])).toBe(100);
    expect(lastActivityOf(term(session()), 's1', [])).toBeNull();
    // After /clear the terminal's session is another one: its message time is not the bound session's.
    expect(lastActivityOf(t, 'old', [])).toBeNull();
  });
});

describe('chipLookups (an answer view\'s file chips)', () => {
  const deferred = () => {
    let done: (v: string | null) => void = () => {};
    const p = new Promise<string | null>((r) => { done = r; });
    return { p, done };
  };
  test('a lookup still on its way lands when a newer path arrives meanwhile (the streamed text grows)', async () => {
    const a = deferred();
    const b = deferred();
    const land = vi.fn();
    const lookup = vi.fn((path: string) => (path === 'a.ts' ? a.p : b.p));
    const chips = chipLookups(lookup, land);
    chips.ask(['a.ts']);
    chips.ask(['a.ts', 'b.ts']);
    a.done('/p/a.ts');
    b.done(null);
    await Promise.resolve(); await Promise.resolve();
    expect(land.mock.calls).toEqual([['a.ts', '/p/a.ts'], ['b.ts', null]]);
    // Each path asked once.
    chips.ask(['a.ts', 'b.ts']);
    expect(lookup).toHaveBeenCalledTimes(2);
  });
  test('paths already known are never asked; nothing lands once the view is gone; a failed lookup lands nothing', async () => {
    const a = deferred();
    const land = vi.fn();
    const lookup = vi.fn((path: string) => (path === 'bad.ts' ? Promise.reject(new Error('no')) : a.p));
    const chips = chipLookups(lookup, land, ['known.ts']);
    chips.ask(['known.ts', 'a.ts', 'bad.ts']);
    expect(lookup.mock.calls.map((c) => c[0])).toEqual(['a.ts', 'bad.ts']);
    chips.dispose();
    a.done('/p/a.ts');
    await Promise.resolve(); await Promise.resolve();
    expect(land).not.toHaveBeenCalled();
  });
});

describe('resolveChip (Review Focus 5: only a project file opens)', () => {
  const file = (path: string, from: number | null = null, to: number | null = null): Inline => ({ t: 'file', path, from, to, raw: path });
  const found = (rel: string) => ({ path: `/p/${rel}`, rel });
  test('a project file: what openFile takes, at the reference first line', async () => {
    const resolve = vi.fn(async () => found('src/app.ts'));
    expect(await resolveChip(file('src/app.ts', 2), '/p/sub', resolve)).toEqual({ path: '/p/src/app.ts', rel: 'src/app.ts', line: 2 });
    expect(resolve).toHaveBeenCalledWith('src/app.ts', '/p/sub');
    expect(await resolveChip(file('src/app.ts', 41, 77), '/p', resolve)).toEqual({ path: '/p/src/app.ts', rel: 'src/app.ts', line: 41 });
    expect(await resolveChip(file('src/app.ts'), '/p', resolve)).toEqual({ path: '/p/src/app.ts', rel: 'src/app.ts', line: null });
  });
  test('`..`, absolute and home paths never reach main', async () => {
    const resolve = vi.fn(async () => found('x.ts'));
    for (const p of ['../x.ts', 'src/../../x.ts', '/etc/hosts', '~/x.ts', 'src//x.ts']) expect(await resolveChip(file(p), '/p', resolve)).toBeNull();
    expect(resolve).not.toHaveBeenCalled();
  });
  test('a folder, a missing file or one outside the project (main says null) stays code', async () => {
    expect(await resolveChip(file('src'), '/p', async () => null)).toBeNull();
    expect(await resolveChip(file('src/gone.ts'), '/p', async () => null)).toBeNull();
    // Whatever main answered, a result outside the project or not absolute never opens.
    expect(await resolveChip(file('src/x.ts'), '/p', async () => ({ path: '/elsewhere/x.ts', rel: '../elsewhere/x.ts' }))).toBeNull();
    expect(await resolveChip(file('src/x.ts'), '/p', async () => ({ path: 'x.ts', rel: 'x.ts' }))).toBeNull();
  });
  test('a refused lookup stays code; plain code is never looked up', async () => {
    expect(await resolveChip(file('src/x.ts'), '/p', () => Promise.reject(new Error('no')))).toBeNull();
    const resolve = vi.fn(async () => found('x.ts'));
    expect(await resolveChip({ t: 'code', s: 'x.ts' }, '/p', resolve)).toBeNull();
    expect(resolve).not.toHaveBeenCalled();
  });
  test('a drive or an NTFS stream (a colon) never reaches main', async () => {
    const resolve = vi.fn(async () => found('x.ts'));
    for (const p of ['C:x.ts', 'src/a.ts:Zone.Identifier', 'c:/x.ts']) expect(await resolveChip(file(p), '/p', resolve)).toBeNull();
    expect(resolve).not.toHaveBeenCalled();
  });
  test('Windows: a reference written with backslashes asks main with forward slashes and opens its C:/… file inside the project', async () => {
    const ROOT = 'C:/dev/proj [v2] (1)';
    try {
      initPlatform('win32');
      const ref = parseInline('`src\\auth\\session.ts:12`')[0]!;
      const resolve = vi.fn(async () => ({ path: `${ROOT}/src/auth/session.ts`, rel: 'src/auth/session.ts' }));
      expect(await resolveChip(ref, ROOT, resolve)).toEqual({ path: `${ROOT}/src/auth/session.ts`, rel: 'src/auth/session.ts', line: 12 });
      expect(resolve).toHaveBeenCalledWith('src/auth/session.ts', ROOT);
      // Whatever main answered, it opens only a Windows absolute path, with a relative part inside the project.
      for (const r of [{ path: '/p/x.ts', rel: 'x.ts' }, { path: 'C:/x.ts', rel: 'C:/x.ts' }, { path: 'C:/x.ts', rel: '..\\x.ts' }])
        expect(await resolveChip(ref, ROOT, async () => r), JSON.stringify(r)).toBeNull();
    } finally { resetPlatformForTests(); }
  });
});

describe('askPromptReason (Review’s Send to session rule)', () => {
  const at = (s: Partial<SessionInfo> | null, o: Partial<TerminalInfo> = {}) => term(s === null ? null : session(s), o);
  test("Claude at its prompt with bracketed paste on: available, whatever is typed there", () => {
    for (const state of ['idle', 'done', 'error'] as const) expect(askPromptReason(at({ state }), true, 'Fix it')).toBeNull();
  });
  test('busy: working, bracketed paste off, an editor or the shell in front', () => {
    const busy = "Available when Claude's prompt is free";
    expect(askPromptReason(at({ state: 'running' }), true, 'Fix it')).toBe(busy);
    expect(askPromptReason(at({ state: 'idle' }), false, 'Fix it')).toBe(busy);
    expect(askPromptReason(at({ state: 'idle' }, { foreground: 'vim' }), true, 'Fix it')).toBe(busy);
    expect(askPromptReason(at({ state: 'idle' }, { foreground: 'zsh' }), true, 'Fix it')).toBe(busy);
  });
  test('a question or permission open: answer it first', () => {
    expect(askPromptReason(at({ state: 'waiting', waitingFor: 'question' }), true, 'Fix it')).toBe('Answer Claude first');
  });
  test("Claude exited (the panel stays bound) or the terminal is gone: nothing to paste into", () => {
    expect(askPromptReason(at(null), true, 'Fix it')).toBe("Claude isn't running in this terminal");
    expect(askPromptReason(undefined, true, 'Fix it')).toBe("Claude isn't running in this terminal");
  });
  test('a verdict-only answer: nothing to put in the prompt, whatever the session does', () => {
    const only = 'This answer is only its verdict: nothing to use';
    expect(askPromptReason(at({ state: 'idle' }), true, '')).toBe(only);
    expect(askPromptReason(at({ state: 'running' }), true, '')).toBe(only);
  });
  test('paused at a usage limit (Claude Code continues by itself): never typed into', () => {
    const paused = at({ state: 'error', errorReason: 'rate_limit', limitPause: { since: 1, resetsAt: null } });
    expect(askPromptReason(paused, true, 'Fix it')).toBe('Paused for the usage limit: Claude Code continues it by itself');
  });
});

describe('pruneThreads', () => {
  test("keeps this window's sessions and open bindings; the same object when nothing goes", () => {
    const all = { s1: thread([]), s2: thread([]), s3: thread([]) };
    const open = { tx: { terminalId: 'tx', sessionId: 's3', cwd: '/p', configDir: null, title: 't' } };
    expect(pruneThreads(all, [term(session())], open)).toEqual({ s1: all.s1, s3: all.s3 });
    const kept = { s1: all.s1 };
    expect(pruneThreads(kept, [term(session())], {})).toBe(kept);
  });
});
