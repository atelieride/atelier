import { mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import { UUID } from '@shared/companion/types';
import { CATCHUP_SCHEMA } from '@shared/companion/catchup';
import type { LiveFacts } from '@shared/companion/live';
import { newThread, RETENTION_MS, THREADS_KEPT } from '@shared/companion/thread';
import type { Binding, CompanionEvent, Thread, ThreadItem } from '@shared/companion/types';
import { DEFAULT_SETTINGS, type Settings } from '@shared/settings';
import { transcriptFile } from '../claude-history';
import { COMPANION_TIMEOUT_MS, type RunOutcome, type runCompanion } from './run';
import { CompanionService, MAX_RUNS, type CompanionDeps } from './service';
import { CompanionStore } from './store';
import { initPlatform, resetPlatformForTests } from '@shared/platform';
import { posixTest } from '../../../tests/support/platform';

// The service with a fake runner (no process), fake deps and a store under the run's temp root. Bindings always carry
// a config dir inside that root: a null one would point the transcript at the user's own ~/.claude.

type RunArgs = Parameters<typeof runCompanion>[0];
interface Call { o: RunArgs; end(r: RunOutcome): void }

const NOW = Date.parse('2026-10-31T12:00:00Z');
const SID = (k: number) => `0000000${k}-1111-4222-8333-944455556666`;
const OTHER_UUID = '99999999-2222-4333-8444-555555555555';
const FACTS = {
  facts: { state: 'working', since: null, work: null, files: 0, added: 3, removed: 1 } as LiveFacts,
  waiting: null, files: [], costUsd: null, branch: 'main', model: 'claude-opus-4'
};
const P = (text: string) => JSON.stringify({ type: 'user', timestamp: '2026-10-31T11:00:00.000Z', message: { role: 'user', content: text } });
const ok = (text: string, extra: Partial<Extract<RunOutcome, { ok: true }>> = {}): RunOutcome => ({ ok: true, text, structured: undefined, costUsd: 0.01, read: ['src/a.ts'], ...extra });
const GOOD_CATCHUP = { points: [{ n: 1, text: 'Fix the login', status: 'done', at: '11:30', note: null }], where: 'Tests pass.', choices: ['Kept the old cookie'], leftOpen: null };

function fakeRunner() {
  const calls: Call[] = [];
  const run = ((o: RunArgs) => new Promise<RunOutcome>((resolve) => {
    if (o.signal?.aborted) { resolve({ ok: false, kind: 'stopped', message: 'Stopped' }); return; }
    o.signal?.addEventListener('abort', () => resolve({ ok: false, kind: 'stopped', message: 'Stopped' }), { once: true });
    calls.push({ o, end: resolve });
  })) as typeof runCompanion;
  return { run, calls };
}

function uuids() {
  let i = 0;
  return () => `00000000-0000-4000-8000-${String(++i).padStart(12, '0')}`;
}

function world(over: Partial<CompanionDeps> = {}, at?: string) {
  const base = at ?? mkdtempSync(join(tmpdir(), 'atl-csvc-'));
  const project = join(base, 'project');
  mkdirSync(project);
  const configDir = join(base, 'claude');
  const store = new CompanionStore(join(base, 'companion'));
  const { run, calls } = fakeRunner();
  const events: CompanionEvent[] = [];
  const settings: Settings = { ...DEFAULT_SETTINGS };
  const clock = { now: NOW };
  const binding = (k = 1): Binding => ({ terminalId: `t${k}`, sessionId: SID(k), cwd: project, configDir, title: `Session ${k}` });
  const writeChat = (k: number, prompts: string[]) => {
    const f = transcriptFile(binding(k))!;
    mkdirSync(dirname(f), { recursive: true });
    writeFileSync(f, prompts.map((p) => P(p) + '\n').join(''));
  };
  const deps: CompanionDeps = {
    store, claudeBin: () => '/fake/claude', settings: () => settings,
    accountDir: (choice, sessionDir) => (choice === 'work' ? '/accounts/work' : sessionDir),
    projectRoot: () => project, facts: () => FACTS, live: () => new Set<string>(), open: () => new Set<string>(),
    run, now: () => clock.now, uuid: uuids(),
    ...over
  };
  const svc = new CompanionService(deps, (e) => events.push(e));
  const saved = (k = 1): Thread => store.load(SID(k))!;
  const items = (k = 1): ThreadItem[] => saved(k)?.items ?? [];
  const runEvents = () => events.filter((e): e is Extract<CompanionEvent, { kind: 'queued' | 'started' }> => e.kind === 'queued' || e.kind === 'started');
  /** Session k's latest run: runs of several sessions reach the runner in the order their chat reads finish. */
  const call = (k: number): Call => calls.findLast((c) => c.o.cwd === store.dirOf(SID(k)))!;
  return { base, project, configDir, store, calls, call, events, settings, clock, binding, writeChat, deps, svc, saved, items, runEvents };
}

const after = (args: string[], flag: string): string | undefined => { const i = args.indexOf(flag); return i < 0 ? undefined : args[i + 1]; };
const until = (cond: () => boolean) => vi.waitFor(() => { if (!cond()) throw new Error('not yet'); }, { timeout: 2000, interval: 5 });
const settle = () => new Promise((r) => setTimeout(r, 30));
const label = (i: ThreadItem) => i.kind === 'question' ? `Q:${i.text}` : i.kind === 'answer' ? `A:${i.markdown}` : i.kind === 'error' ? `E:${i.reason}` : 'C';
const questionId = (w: ReturnType<typeof world>, text: string, k = 1) => w.items(k).find((i): i is Extract<ThreadItem, { kind: 'question' }> => i.kind === 'question' && i.text === text)!.id;

test('MAX_RUNS is three', () => {
  expect(MAX_RUNS).toBe(3);
});

describe('what an outcome carries', () => {
  test('an answer and a catch-up are dated when the chat was read, so files edited during the run mark them stale', async () => {
    const w = world();
    w.writeChat(1, ['Fix the login']);
    w.svc.ask(w.binding(), { text: 'Is it done?' });
    await until(() => w.calls.length === 1);
    const readAt = w.clock.now;
    w.clock.now += 90_000;
    w.call(1).end(ok('Yes.'));
    await until(() => w.items().some((i) => i.kind === 'answer'));
    expect(w.items().find((i) => i.kind === 'answer')!.at).toBe(readAt);

    w.svc.catchUp(w.binding(), { final: false });
    await until(() => w.calls.length === 2);
    const readAt2 = w.clock.now;
    w.clock.now += 120_000;
    w.call(1).end(ok('', { structured: GOOD_CATCHUP }));
    await until(() => w.items().some((i) => i.kind === 'catchup'));
    expect(w.items().find((i) => i.kind === 'catchup')!.at).toBe(readAt2);
    // As of that chat: activity during the run counts as "moved since" for the next open's Catch me up.
    expect(w.saved().lastCatchUpAt).toBe(readAt2);
    // The thread itself was used when the outcome landed.
    expect(w.saved().lastUsedAt).toBe(w.clock.now);
  });

  test('an answer\'s Markdown is capped at 256 KB (a stopped one too)', async () => {
    const w = world();
    w.writeChat(1, ['Fix the login']);
    w.svc.ask(w.binding(), { text: 'q1' });
    await until(() => w.calls.length === 1);
    w.call(1).end(ok('x'.repeat(400 * 1024)));
    await until(() => w.items().some((i) => i.kind === 'answer'));
    const md = (w.items().find((i) => i.kind === 'answer') as Extract<ThreadItem, { kind: 'answer' }>).markdown;
    expect(md.length).toBeLessThanOrEqual(256 * 1024);
    expect(md.length).toBeGreaterThan(255 * 1024);
    // A stopped one keeps what streamed, capped the same.
    w.svc.ask(w.binding(), { text: 'q2' });
    await until(() => w.calls.length === 2);
    w.call(1).o.onItem({ t: 'delta', text: '😀'.repeat(200 * 1024) });
    w.svc.stop(SID(1));
    await until(() => w.items().filter((i) => i.kind === 'answer').length === 2);
    const stopped = w.items().filter((i): i is Extract<ThreadItem, { kind: 'answer' }> => i.kind === 'answer')[1]!;
    expect(stopped.stopped).toBe(true);
    expect(stopped.markdown.length).toBeLessThanOrEqual(256 * 1024);
    // Never half a character.
    expect(stopped.markdown.endsWith('😀') || stopped.markdown.endsWith('…')).toBe(true);
  });
});

describe('a question', () => {
  test('runs with the inputs written, the question on stdin and the defaults from Settings', async () => {
    const w = world();
    w.writeChat(1, ['Fix the login']);
    const r = w.svc.ask(w.binding(), { text: 'Is it done?' });
    expect(r).toEqual({ runId: expect.any(String) });
    await until(() => w.calls.length === 1);
    const { o } = w.calls[0]!;
    const dir = w.store.dirOf(SID(1));
    expect(o.input).toBe('Is it done?');
    expect(o.cwd).toBe(dir);
    expect(o.projectRoot).toBe(w.project);
    expect(o.claudeBin).toBe('/fake/claude');
    expect(o.configDir).toBe(w.configDir);
    expect(o.timeoutMs).toBe(COMPANION_TIMEOUT_MS.question.sonnet);
    expect(after(o.args, '--model')).toBe('sonnet');
    expect(after(o.args, '--add-dir')).toBe(w.project);
    expect(o.args).not.toContain('--json-schema');
    const rules = readFileSync(join(dir, 'rules.md'), 'utf8');
    expect(rules).toContain('"Session 1", which runs on claude-opus-4,');
    expect(rules).toContain(w.project);
    expect(readFileSync(join(dir, 'chat.md'), 'utf8')).toContain('YOU: Fix the login');
    expect(readFileSync(join(dir, 'facts.md'), 'utf8')).toContain('- Branch: main');
    expect(w.items().map(label)).toEqual(['Q:Is it done?']);
  });

  test('the first run starts the conversation with --session-id, later ones --resume it; New Thread starts another', async () => {
    const w = world();
    w.writeChat(1, ['Fix the login']);
    w.svc.ask(w.binding(), { text: 'q1' });
    await until(() => w.calls.length === 1);
    const uuid = after(w.calls[0]!.o.args, '--session-id')!;
    expect(uuid).toMatch(UUID);
    expect(w.calls[0]!.o.args).not.toContain('--resume');
    w.calls[0]!.end(ok('a1'));
    await until(() => w.items().length === 2);
    expect(w.saved().started).toBe(true);
    w.svc.ask(w.binding(), { text: 'q2' });
    await until(() => w.calls.length === 2);
    expect(after(w.calls[1]!.o.args, '--resume')).toBe(uuid);
    expect(w.calls[1]!.o.args).not.toContain('--session-id');
    w.calls[1]!.end(ok('a2'));
    await until(() => w.items().length === 4);
    const fresh = w.svc.newThread(SID(1));
    expect(fresh.items).toEqual([]);
    expect(fresh.started).toBe(false);
    expect(fresh.costUsd).toBe(0);
    expect(fresh.claudeUuid).toMatch(UUID);
    expect(fresh.claudeUuid).not.toBe(uuid);
    expect(w.saved()).toEqual(fresh);
    w.svc.ask(w.binding(), { text: 'q3' });
    await until(() => w.calls.length === 3);
    expect(after(w.calls[2]!.o.args, '--session-id')).toBe(fresh.claudeUuid);
  });

  test('a run that failed before Claude started keeps --session-id for the next one', async () => {
    const w = world();
    w.writeChat(1, ['Fix the login']);
    w.svc.ask(w.binding(), { text: 'q1' });
    await until(() => w.calls.length === 1);
    w.calls[0]!.end({ ok: false, kind: 'not-found', message: 'Claude Code was not found' });
    await until(() => w.items().length === 2);
    expect(w.saved().started).toBe(false);
    w.svc.ask(w.binding(), { text: 'q2' });
    await until(() => w.calls.length === 2);
    expect(after(w.calls[1]!.o.args, '--session-id')).toBe(w.saved().claudeUuid);
  });

  test('a run where Claude started (init) but then failed resumes next time', async () => {
    const w = world();
    w.writeChat(1, ['Fix the login']);
    w.svc.ask(w.binding(), { text: 'q1' });
    await until(() => w.calls.length === 1);
    const uuid = after(w.calls[0]!.o.args, '--session-id')!;
    w.calls[0]!.o.onItem({ t: 'init', sessionId: uuid });
    w.calls[0]!.end({ ok: false, kind: 'timeout', message: "Claude didn't answer in time" });
    await until(() => w.items().length === 2);
    expect(w.saved().started).toBe(true);
    w.svc.ask(w.binding(), { text: 'q2' });
    await until(() => w.calls.length === 2);
    expect(after(w.calls[1]!.o.args, '--resume')).toBe(uuid);
  });

  test('the answer lands under its question with what it read, its model and cost; unseen, lastUsedAt and the cost add up', async () => {
    const w = world();
    w.writeChat(1, ['Fix the login']);
    w.svc.ask(w.binding(), { text: 'q1' });
    await until(() => w.calls.length === 1);
    w.clock.now = NOW + 5000;
    w.calls[0]!.end(ok('a1', { costUsd: 0.25, read: ['src/a.ts', 'src/b.ts'] }));
    await until(() => w.items().length === 2);
    const t = w.saved();
    // Dated when the chat was read (the stale rule's start), the thread used when it landed.
    expect(t.items[1]).toEqual({ kind: 'answer', id: expect.any(String), at: NOW, questionId: t.items[0]!.id, markdown: 'a1', read: ['src/a.ts', 'src/b.ts'], model: 'sonnet', costUsd: 0.25 });
    expect(t.unseen).toBe(true);
    expect(t.lastUsedAt).toBe(NOW + 5000);
    expect(t.costUsd).toBe(0.25);
    expect(w.events.findLast((e) => e.kind === 'thread')).toEqual({ sessionId: SID(1), kind: 'thread', thread: t });
    w.svc.ask(w.binding(), { text: 'q2' });
    await until(() => w.calls.length === 2);
    w.calls[1]!.end(ok('a2', { costUsd: 0.5 }));
    await until(() => w.items().length === 4);
    expect(w.saved().costUsd).toBe(0.75);
    w.svc.seen(SID(1));
    expect(w.saved().unseen).toBe(false);
    expect(w.events.findLast((e) => e.kind === 'thread')).toEqual({ sessionId: SID(1), kind: 'thread', thread: w.saved() });
  });

  test('while it runs: trace lines for what it reads (only those with a line) and the streamed text', async () => {
    const w = world();
    w.writeChat(1, ['Fix the login']);
    const r = w.svc.ask(w.binding(), { text: 'q1' }) as { runId: string };
    await until(() => w.calls.length === 1);
    const { o } = w.calls[0]!;
    o.onItem({ t: 'tool', id: 'x1', name: 'Read', input: { file_path: join(w.project, 'src/a.ts') } });
    o.onItem({ t: 'tool', id: 'x2', name: 'Read', input: { file_path: '/etc/hosts' } });
    o.onItem({ t: 'tool', id: 'x3', name: 'Read', input: { file_path: join(w.store.dirOf(SID(1)), 'chat.md') } });
    o.onItem({ t: 'delta', text: 'Half ' });
    o.onItem({ t: 'delta', text: 'done' });
    const live = w.events.filter((e) => e.kind === 'trace' || e.kind === 'delta');
    expect(live).toEqual([
      { sessionId: SID(1), kind: 'trace', runId: r.runId, line: 'Read src/a.ts' },
      { sessionId: SID(1), kind: 'trace', runId: r.runId, line: 'Read the chat' },
      { sessionId: SID(1), kind: 'delta', runId: r.runId, text: 'Half ' },
      { sessionId: SID(1), kind: 'delta', runId: r.runId, text: 'done' }
    ]);
  });

  posixTest('trace lines know the thread folder and the project by their real paths too (a symlinked home: /var is /private/var)', async () => {
    const real = mkdtempSync(join(tmpdir(), 'atl-csvc-'));
    mkdirSync(join(real, 'target'));
    symlinkSync(join(real, 'target'), join(real, 'link'));
    const w = world({}, join(real, 'link'));
    w.writeChat(1, ['Fix the login']);
    w.svc.ask(w.binding(), { text: 'q1' });
    await until(() => w.calls.length === 1);
    const { o } = w.calls[0]!;
    const dir = realpathSync(w.store.dirOf(SID(1)));
    expect(dir).not.toBe(w.store.dirOf(SID(1)));
    // Claude reports its cwd (the thread folder) by its real path; the project as it was given, or by its real path.
    o.onItem({ t: 'tool', id: 'x1', name: 'Read', input: { file_path: join(dir, 'chat.md') } });
    o.onItem({ t: 'tool', id: 'x2', name: 'Grep', input: { pattern: 'skew', path: dir } });
    o.onItem({ t: 'tool', id: 'x3', name: 'Read', input: { file_path: join(realpathSync(w.project), 'src/a.ts') } });
    o.onItem({ t: 'tool', id: 'x4', name: 'Read', input: { file_path: join(w.project, 'src/b.ts') } });
    o.onItem({ t: 'tool', id: 'x5', name: 'Read', input: { file_path: join(dir, 'rules.md') } });
    o.onItem({ t: 'tool', id: 'x6', name: 'Read', input: { file_path: join(w.store.dirOf(SID(1)), 'facts.md') } });
    expect(w.events.flatMap((e) => (e.kind === 'trace' ? [e.line] : []))).toEqual([
      'Read the chat', "Searched the chat for 'skew'", 'Read src/a.ts', 'Read src/b.ts', 'Read the session facts'
    ]);
  });

  test('Windows: Claude gets the project root native, rules.md names it so, and the trace reads the paths the model writes there', async () => {
    // Main's project root on Windows is canonical (C:/…); the model's tool inputs are native (as
    // observed on Windows). The thread folder stays this machine's: only its files are read here.
    const ROOT = 'C:\\dev\\spike-ask\\proj [v2] (1)';
    const w = world({ projectRoot: () => 'C:/dev/spike-ask/proj [v2] (1)' });
    w.writeChat(1, ['Fix the login']);
    try {
      initPlatform('win32');
      const r = w.svc.ask(w.binding(), { text: 'Is it done?' }) as { runId: string };
      await until(() => w.calls.length === 1 || w.items().length > 1);
      expect(w.items().map(label)).toEqual(['Q:Is it done?']);
      const { o } = w.calls[0]!;
      expect(after(o.args, '--add-dir')).toBe(ROOT);
      const dir = w.store.dirOf(SID(1));
      expect(readFileSync(join(dir, 'rules.md'), 'utf8')).toContain(`working in the project at \`${ROOT}\``);
      o.onItem({ t: 'tool', id: 'x1', name: 'Read', input: { file_path: `${ROOT}\\src\\auth\\session.ts` } });
      o.onItem({ t: 'tool', id: 'x2', name: 'Grep', input: { pattern: 'zebra', path: ROOT } });
      o.onItem({ t: 'tool', id: 'x3', name: 'Glob', input: { pattern: '**/*', path: ROOT } });
      o.onItem({ t: 'tool', id: 'x4', name: 'Read', input: { file_path: 'c:\\DEV\\spike-ask\\proj [v2] (1)\\src\\a.ts' } });
      o.onItem({ t: 'tool', id: 'x5', name: 'Read', input: { file_path: join(dir, 'chat.md') } });
      o.onItem({ t: 'tool', id: 'x6', name: 'Read', input: { file_path: 'C:\\dev\\spike-ask\\other\\x.ts' } });
      expect(w.events.flatMap((e) => (e.kind === 'trace' && e.runId === r.runId ? [e.line] : []))).toEqual([
        'Read src/auth/session.ts', "Searched the code for 'zebra'", 'Listed **/*', 'Read src/a.ts', 'Read the chat'
      ]);
    } finally { resetPlatformForTests(); }
  });

  test('an empty question or a bad session id is refused without a run', async () => {
    const w = world();
    expect(w.svc.ask(w.binding(), { text: '  \n' })).toEqual({ error: expect.any(String) });
    expect(w.svc.ask({ ...w.binding(), sessionId: '../x' }, { text: 'q' })).toEqual({ error: expect.any(String) });
    await settle();
    expect(w.calls).toHaveLength(0);
    expect(w.store.list()).toEqual([]);
  });
});

describe('queueing', () => {
  test('two asks on one session: one started, one queued; the second starts after the first ends; thread.json reads q1, a1, q2, a2', async () => {
    const w = world();
    w.writeChat(1, ['Fix the login']);
    const r1 = w.svc.ask(w.binding(), { text: 'q1' }) as { runId: string };
    const r2 = w.svc.ask(w.binding(), { text: 'q2' }) as { runId: string };
    expect(w.runEvents().map((e) => [e.kind, e.runId])).toEqual([['started', r1.runId], ['queued', r2.runId]]);
    await until(() => w.calls.length === 1);
    await settle();
    expect(w.calls).toHaveLength(1);
    // The queued question waits outside the thread: nothing lands between q1 and its answer.
    expect(w.items().map(label)).toEqual(['Q:q1']);
    w.calls[0]!.end(ok('a1'));
    await until(() => w.calls.length === 2);
    expect(w.calls[1]!.o.input).toBe('q2');
    expect(w.runEvents().map((e) => [e.kind, e.runId])).toEqual([['started', r1.runId], ['queued', r2.runId], ['started', r2.runId]]);
    w.calls[1]!.end(ok('a2'));
    await until(() => w.items().length === 4);
    const items = w.saved().items;
    expect(items.map(label)).toEqual(['Q:q1', 'A:a1', 'Q:q2', 'A:a2']);
    expect((items[1] as Extract<ThreadItem, { kind: 'answer' }>).questionId).toBe(items[0]!.id);
    expect((items[3] as Extract<ThreadItem, { kind: 'answer' }>).questionId).toBe(items[2]!.id);
  });

  test(`a fourth session's ask while ${MAX_RUNS} run is queued until one of them ends`, async () => {
    const w = world();
    for (const k of [1, 2, 3, 4]) w.writeChat(k, ['Do it']);
    for (const k of [1, 2, 3]) w.svc.ask(w.binding(k), { text: `q${k}` });
    const r4 = w.svc.ask(w.binding(4), { text: 'q4' }) as { runId: string };
    expect(w.runEvents().at(-1)).toEqual({ sessionId: SID(4), kind: 'queued', runId: r4.runId, questionId: questionId(w, 'q4', 4) });
    // Its question is in its own thread already: nothing else is waiting there.
    expect(w.items(4).map(label)).toEqual(['Q:q4']);
    await until(() => w.calls.length === 3);
    await settle();
    expect(w.calls).toHaveLength(3);
    w.calls[1]!.end(ok('a2'));
    await until(() => w.calls.length === 4);
    expect(w.calls[3]!.o.cwd).toBe(w.store.dirOf(SID(4)));
    expect(w.runEvents().at(-1)).toEqual({ sessionId: SID(4), kind: 'started', runId: r4.runId, questionId: questionId(w, 'q4', 4) });
  });

  test('a second Catch me up on a session that already has one waiting or running gives back the same run', async () => {
    const w = world();
    w.writeChat(1, ['Fix the login']);
    const a = w.svc.catchUp(w.binding(), { final: false });
    const b = w.svc.catchUp(w.binding(), { final: false });
    expect(b).toEqual(a);
    await until(() => w.calls.length === 1);
    await settle();
    expect(w.calls).toHaveLength(1);
  });
});

describe('Catch me up, final', () => {
  test('a final request upgrades a pending one that is not final instead of being swallowed by it', async () => {
    const w = world();
    w.writeChat(1, ['Fix the login']);
    w.svc.ask(w.binding(), { text: 'q1' });
    const pending = w.svc.catchUp(w.binding(), { final: false });
    expect(w.svc.catchUp(w.binding(), { final: true })).toEqual(pending);
    await until(() => w.calls.length === 1);
    w.calls[0]!.end(ok('a1'));
    await until(() => w.calls.length === 2);
    expect(w.calls[1]!.o.input).toMatch(/ended/);
    w.calls[1]!.end(ok('', { structured: GOOD_CATCHUP }));
    await until(() => w.items().length === 3);
    expect(w.items()[2]).toMatchObject({ kind: 'catchup', final: true });
  });

  test('a final request while a non-final one runs gets a run of its own after it', async () => {
    const w = world();
    w.writeChat(1, ['Fix the login']);
    const running = w.svc.catchUp(w.binding(), { final: false });
    await until(() => w.calls.length === 1);
    const final = w.svc.catchUp(w.binding(), { final: true });
    expect(final).not.toEqual(running);
    expect(w.svc.catchUp(w.binding(), { final: false })).toEqual(final);
    w.calls[0]!.end(ok('', { structured: GOOD_CATCHUP }));
    await until(() => w.calls.length === 2);
    expect(w.calls[1]!.o.input).toMatch(/ended/);
  });
});

describe('Catch me up', () => {
  test('runs with the schema and a catch-up-only instruction; a valid result becomes a card and sets lastCatchUpAt', async () => {
    const w = world();
    w.writeChat(1, ['Fix the login']);
    w.svc.catchUp(w.binding(), { final: false });
    await until(() => w.calls.length === 1);
    const { o } = w.calls[0]!;
    expect(after(o.args, '--json-schema')).toBe(JSON.stringify(CATCHUP_SCHEMA));
    expect(o.timeoutMs).toBe(COMPANION_TIMEOUT_MS.catchup.sonnet);
    expect(o.input).toMatch(/catch me up/i);
    expect(o.input).toMatch(/leftOpen: null/);
    w.clock.now = NOW + 1000;
    w.calls[0]!.end(ok('', { structured: GOOD_CATCHUP, read: ['src/a.ts'] }));
    await until(() => w.items().length === 1);
    const t = w.saved();
    expect(t.items[0]).toEqual({ kind: 'catchup', id: expect.any(String), at: NOW, data: GOOD_CATCHUP, read: ['src/a.ts'], model: 'sonnet', final: false });
    expect(t.lastCatchUpAt).toBe(NOW);
    expect(t.lastUsedAt).toBe(NOW + 1000);
    expect(t.started).toBe(true);
  });

  test('a first Catch me up on a session with no thread yet: the next question resumes the conversation it started', async () => {
    const w = world();
    w.writeChat(1, ['Fix the login']);
    w.svc.catchUp(w.binding(), { final: false });
    await until(() => w.calls.length === 1);
    const uuid = after(w.calls[0]!.o.args, '--session-id')!;
    w.calls[0]!.end(ok('', { structured: GOOD_CATCHUP }));
    await until(() => w.items().length === 1);
    expect(w.saved().claudeUuid).toBe(uuid);
    w.svc.ask(w.binding(), { text: 'q1' });
    await until(() => w.calls.length === 2);
    expect(after(w.calls[1]!.o.args, '--resume')).toBe(uuid);
  });

  test('a final one asks for what was left open and is marked final', async () => {
    const w = world();
    w.writeChat(1, ['Fix the login']);
    w.svc.catchUp(w.binding(), { final: true });
    await until(() => w.calls.length === 1);
    expect(w.calls[0]!.o.input).toMatch(/ended/);
    expect(w.calls[0]!.o.input).not.toMatch(/leftOpen: null/);
    w.calls[0]!.end(ok('', { structured: { ...GOOD_CATCHUP, leftOpen: 'Docs' } }));
    await until(() => w.items().length === 1);
    expect(w.items()[0]).toMatchObject({ kind: 'catchup', final: true, data: { leftOpen: 'Docs' } });
  });

  test('a bad structured payload becomes an invalid-catchup error', async () => {
    const w = world();
    w.writeChat(1, ['Fix the login']);
    w.svc.catchUp(w.binding(), { final: false });
    await until(() => w.calls.length === 1);
    w.calls[0]!.end(ok('', { structured: { points: 'nope' }, costUsd: 0.02 }));
    await until(() => w.items().length === 1);
    expect(w.items()[0]).toEqual({ kind: 'error', id: expect.any(String), at: NOW, questionId: null, reason: 'invalid-catchup', message: "Couldn't put the summary together" });
    expect(w.saved().lastCatchUpAt).toBeNull();
    expect(w.saved().costUsd).toBe(0.02);
  });

  test('with no prompt in the chat yet: a card with no points, "Nothing asked yet", and no run', async () => {
    const w = world();
    w.writeChat(1, []);
    w.svc.catchUp(w.binding(), { final: false });
    await until(() => w.items().length === 1);
    expect(w.items()[0]).toEqual({ kind: 'catchup', id: expect.any(String), at: NOW, data: { points: [], where: 'Nothing asked yet', choices: [], leftOpen: null }, read: [], model: 'sonnet', final: false });
    await settle();
    expect(w.calls).toHaveLength(0);
  });
});

describe('outcomes and errors', () => {
  test('a limit becomes an error item with its reset time', async () => {
    const w = world();
    w.writeChat(1, ['Fix the login']);
    w.svc.ask(w.binding(), { text: 'q1' });
    await until(() => w.calls.length === 1);
    w.calls[0]!.end({ ok: false, kind: 'limit', message: 'Usage limit reached', resetsAt: 1793455200 });
    await until(() => w.items().length === 2);
    expect(w.items()[1]).toEqual({ kind: 'error', id: expect.any(String), at: NOW, questionId: questionId(w, 'q1'), reason: 'limit', message: 'Usage limit reached', resetsAt: 1793455200, account: 'session' });
    expect(w.saved().unseen).toBe(true);
  });

  test('a limit keeps which window it hit (the item says "its 5-hour limit")', async () => {
    const w = world();
    w.writeChat(1, ['Fix the login']);
    w.svc.ask(w.binding(), { text: 'q1' });
    await until(() => w.calls.length === 1);
    w.calls[0]!.end({ ok: false, kind: 'limit', message: 'Usage limit reached', resetsAt: 1793455200, window: 'five-hour' });
    await until(() => w.items().length === 2);
    expect(w.items()[1]).toMatchObject({ reason: 'limit', resetsAt: 1793455200, window: 'five-hour' });
  });

  test('a limit keeps the account the run used (the item names it after the thread moves to another account)', async () => {
    const w = world();
    w.writeChat(1, ['Fix the login']);
    w.svc.ask(w.binding(), { text: 'q1' });
    await until(() => w.calls.length === 1);
    w.calls[0]!.end({ ok: false, kind: 'limit', message: 'Usage limit reached', resetsAt: 1793455200, window: 'five-hour' });
    await until(() => w.items().length === 2);
    expect(w.items()[1]).toMatchObject({ reason: 'limit', account: 'session' });
    w.svc.ask(w.binding(), { text: 'q2', account: 'work' });
    await until(() => w.calls.length === 2);
    w.calls[1]!.end({ ok: false, kind: 'limit', message: 'Usage limit reached' });
    await until(() => w.items().length === 4);
    expect(w.items()[3]).toMatchObject({ reason: 'limit', account: 'work' });
    // The earlier one still names its own.
    expect(w.items()[1]).toMatchObject({ account: 'session' });
    // Other errors carry no account.
    w.svc.ask(w.binding(), { text: 'q3' });
    await until(() => w.calls.length === 3);
    w.calls[2]!.end({ ok: false, kind: 'timeout', message: "Claude didn't answer in time" });
    await until(() => w.items().length === 6);
    expect(w.items()[5]).not.toHaveProperty('account');
  });

  test('no Claude binary: a not-found error item and no run', async () => {
    const w = world({ claudeBin: () => null });
    w.writeChat(1, ['Fix the login']);
    w.svc.ask(w.binding(), { text: 'q1' });
    await until(() => w.items().length === 2);
    expect(w.items()[1]).toEqual({ kind: 'error', id: expect.any(String), at: NOW, questionId: questionId(w, 'q1'), reason: 'not-found', message: 'Claude Code was not found' });
    expect(w.calls).toHaveLength(0);
  });

  test("the session's project isn't open: an exit error item and no run", async () => {
    const w = world({ projectRoot: () => null });
    w.writeChat(1, ['Fix the login']);
    w.svc.ask(w.binding(), { text: 'q1' });
    await until(() => w.items().length === 2);
    expect(w.items()[1]).toMatchObject({ kind: 'error', reason: 'exit', message: "This session's project isn't open" });
    expect(w.calls).toHaveLength(0);
  });

  test('Stop after some text: the partial answer stays, marked stopped', async () => {
    const w = world();
    w.writeChat(1, ['Fix the login']);
    w.svc.ask(w.binding(), { text: 'q1' });
    await until(() => w.calls.length === 1);
    w.calls[0]!.o.onItem({ t: 'delta', text: 'Half ' });
    w.calls[0]!.o.onItem({ t: 'delta', text: 'an answer' });
    w.svc.stop(SID(1));
    expect(w.calls[0]!.o.signal?.aborted).toBe(true);
    await until(() => w.items().length === 2);
    expect(w.items()[1]).toEqual({ kind: 'answer', id: expect.any(String), at: NOW, questionId: questionId(w, 'q1'), markdown: 'Half an answer', read: [], model: 'sonnet', costUsd: null, stopped: true });
  });

  test('Stop before any text: a stopped error item', async () => {
    const w = world();
    w.writeChat(1, ['Fix the login']);
    w.svc.ask(w.binding(), { text: 'q1' });
    await until(() => w.calls.length === 1);
    w.svc.stop(SID(1));
    await until(() => w.items().length === 2);
    expect(w.items()[1]).toEqual({ kind: 'error', id: expect.any(String), at: NOW, questionId: questionId(w, 'q1'), reason: 'stopped', message: 'Stopped' });
  });

  const throwing: [string, (w: ReturnType<typeof world>) => void, string][] = [
    ['companionArgs refuses the project root', (w) => { w.deps.projectRoot = (t) => (t === 't1' ? '/' : w.project); }, "Ask can't read this project's folder"],
    ['writing the inputs fails', (w) => {
      const write = w.store.writeInputs.bind(w.store);
      w.store.writeInputs = (id, f) => { if (id === SID(1)) throw new Error('disk full'); write(id, f); };
    }, "Couldn't write Ask's files"],
    ['the facts throw', (w) => { w.deps.facts = (b) => { if (b.sessionId === SID(1)) throw new Error('boom\n  at x'); return FACTS; }; }, 'boom']
  ];
  test.each(throwing)('%s: an exit item, the slot is freed and the next queued run starts', async (_, breakIt, message) => {
    const w = world();
    for (const k of [1, 2, 3, 4]) w.writeChat(k, ['Do it']);
    breakIt(w);
    for (const k of [2, 3, 1, 4]) w.svc.ask(w.binding(k), { text: `q${k}` });
    expect(w.runEvents().at(-1)).toMatchObject({ sessionId: SID(4), kind: 'queued' });
    await until(() => w.items(1).length === 2);
    expect(w.items(1)[1]).toMatchObject({ kind: 'error', reason: 'exit', message });
    await until(() => w.calls.length === 3);
    expect(w.calls.map((c) => c.o.cwd).sort()).toEqual([2, 3, 4].map((k) => w.store.dirOf(SID(k))).sort());
  });

  test('an emit that throws (a window gone) never breaks a save or the queue', async () => {
    const w = world();
    w.writeChat(1, ['Fix the login']);
    const svc = new CompanionService(w.deps, () => { throw new Error('window gone'); });
    expect(svc.ask(w.binding(), { text: 'q1' })).toEqual({ runId: expect.any(String) });
    await until(() => w.calls.length === 1);
    w.calls[0]!.o.onItem({ t: 'delta', text: 'x' });
    w.calls[0]!.end(ok('a1'));
    await until(() => w.items().length === 2);
    expect(svc.ask(w.binding(), { text: 'q2' })).toEqual({ runId: expect.any(String) });
    await until(() => w.calls.length === 2);
  });

  test('Stop after New Thread acts on the question asked since, not on the dropped run', async () => {
    const w = world();
    w.writeChat(1, ['Fix the login']);
    w.svc.ask(w.binding(), { text: 'q1' });
    await until(() => w.calls.length === 1);
    w.svc.newThread(SID(1));
    w.svc.ask(w.binding(), { text: 'q2' });
    w.svc.stop(SID(1));
    expect(w.items().map(label)).toEqual(['Q:q2', 'E:stopped']);
    await settle();
    expect(w.calls).toHaveLength(1);
  });

  test('Stop on a question waiting for a free slot ends it without a run', async () => {
    const w = world();
    for (const k of [1, 2, 3, 4]) w.writeChat(k, ['Do it']);
    for (const k of [1, 2, 3, 4]) w.svc.ask(w.binding(k), { text: `q${k}` });
    await until(() => w.calls.length === 3);
    w.svc.stop(SID(4));
    expect(w.items(4).map(label)).toEqual(['Q:q4', 'E:stopped']);
    w.call(1).end(ok('a1'));
    await until(() => w.items(1).length === 2);
    await settle();
    expect(w.calls).toHaveLength(3);
  });
});

describe('model, account and the chat', () => {
  test('ask with a model and an account runs with them and keeps them on the thread for later asks', async () => {
    const w = world();
    w.writeChat(1, ['Fix the login']);
    w.svc.ask(w.binding(), { text: 'q1', model: 'opus', account: 'work' });
    await until(() => w.calls.length === 1);
    expect(after(w.calls[0]!.o.args, '--model')).toBe('opus');
    expect(w.calls[0]!.o.configDir).toBe('/accounts/work');
    expect(w.calls[0]!.o.timeoutMs).toBe(COMPANION_TIMEOUT_MS.question.opus);
    expect(w.saved()).toMatchObject({ model: 'opus', account: 'work' });
    w.calls[0]!.end(ok('a1'));
    await until(() => w.items().length === 2);
    expect(w.items()[1]).toMatchObject({ kind: 'answer', model: 'opus' });
    w.svc.ask(w.binding(), { text: 'q2' });
    await until(() => w.calls.length === 2);
    expect(after(w.calls[1]!.o.args, '--model')).toBe('opus');
    expect(w.calls[1]!.o.configDir).toBe('/accounts/work');
  });

  test("a Catch me up with the thread's picked model and account runs with them and keeps them on the thread, as a question does", async () => {
    const w = world();
    w.writeChat(1, ['Fix the login']);
    w.svc.catchUp(w.binding(), { final: false, model: 'haiku', account: 'work' });
    expect(w.saved()).toMatchObject({ model: 'haiku', account: 'work', items: [] });
    await until(() => w.calls.length === 1);
    expect(after(w.calls[0]!.o.args, '--model')).toBe('haiku');
    expect(w.calls[0]!.o.configDir).toBe('/accounts/work');
    expect(w.calls[0]!.o.timeoutMs).toBe(COMPANION_TIMEOUT_MS.catchup.haiku);
    w.calls[0]!.end(ok('', { structured: GOOD_CATCHUP }));
    await until(() => w.items().length === 1);
    expect(w.items()[0]).toMatchObject({ kind: 'catchup', model: 'haiku' });
    expect(w.saved()).toMatchObject({ model: 'haiku', account: 'work' });
    // Later runs keep the pick; without one, a catch-up saves nothing up front.
    w.svc.ask(w.binding(), { text: 'q1' });
    await until(() => w.calls.length === 2);
    expect(after(w.calls[1]!.o.args, '--model')).toBe('haiku');
    expect(w.calls[1]!.o.configDir).toBe('/accounts/work');
    const w2 = world();
    w2.writeChat(1, ['Fix the login']);
    w2.svc.catchUp(w2.binding(), { final: false });
    expect(w2.store.load(SID(1))).toBeNull();
  });

  test("Settings' account is the default; a thread whose account is gone runs on the session's own", async () => {
    const w = world();
    w.writeChat(1, ['Fix the login']);
    w.settings.askAccount = 'work';
    w.settings.askModel = 'haiku';
    w.svc.ask(w.binding(), { text: 'q1' });
    await until(() => w.calls.length === 1);
    expect(w.calls[0]!.o.configDir).toBe('/accounts/work');
    expect(after(w.calls[0]!.o.args, '--model')).toBe('haiku');
    expect(w.saved()).toMatchObject({ model: null, account: null });

    w.store.save({ ...newThread(SID(2), OTHER_UUID, NOW), account: 'gone' });
    w.writeChat(2, ['Other']);
    w.svc.ask(w.binding(2), { text: 'q2' });
    await until(() => w.calls.length === 2);
    expect(w.calls[1]!.o.configDir).toBe(w.configDir);
  });

  test("a started thread asked with another account starts a fresh conversation there; the items stay, later asks resume it", async () => {
    const w = world();
    w.writeChat(1, ['Fix the login']);
    w.svc.ask(w.binding(), { text: 'q1' });
    await until(() => w.calls.length === 1);
    const first = after(w.calls[0]!.o.args, '--session-id')!;
    w.calls[0]!.end(ok('a1'));
    await until(() => w.items().length === 2);
    expect(w.saved()).toMatchObject({ started: true, convDir: w.configDir });
    w.svc.ask(w.binding(), { text: 'q2', account: 'work' });
    await until(() => w.calls.length === 2);
    expect(w.calls[1]!.o.args).not.toContain('--resume');
    const second = after(w.calls[1]!.o.args, '--session-id')!;
    expect(second).toMatch(UUID);
    expect(second).not.toBe(first);
    w.calls[1]!.end(ok('a2'));
    await until(() => w.items().length === 4);
    expect(w.saved()).toMatchObject({ claudeUuid: second, started: true, convDir: '/accounts/work' });
    expect(w.items().map(label)).toEqual(['Q:q1', 'A:a1', 'Q:q2', 'A:a2']);
    w.svc.ask(w.binding(), { text: 'q3' });
    await until(() => w.calls.length === 3);
    expect(after(w.calls[2]!.o.args, '--resume')).toBe(second);
  });

  test('a resume Claude Code no longer has (fails before init) is retried once as a fresh conversation, invisibly', async () => {
    const w = world();
    w.writeChat(1, ['Fix the login']);
    w.store.save({ ...newThread(SID(1), OTHER_UUID, NOW), started: true, convDir: w.configDir });
    w.svc.ask(w.binding(), { text: 'q1' });
    await until(() => w.calls.length === 1);
    expect(after(w.calls[0]!.o.args, '--resume')).toBe(OTHER_UUID);
    w.calls[0]!.end({ ok: false, kind: 'exit', message: 'No conversation found with session ID' });
    await until(() => w.calls.length === 2);
    const fresh = after(w.calls[1]!.o.args, '--session-id')!;
    expect(fresh).toMatch(UUID);
    expect(fresh).not.toBe(OTHER_UUID);
    expect(w.calls[1]!.o.input).toBe('q1');
    w.calls[1]!.end(ok('a1'));
    await until(() => w.items().length === 2);
    expect(w.items().map(label)).toEqual(['Q:q1', 'A:a1']);
    expect(w.saved()).toMatchObject({ claudeUuid: fresh, started: true, convDir: w.configDir });
  });

  test('a second failure before init surfaces the error; no third try', async () => {
    const w = world();
    w.writeChat(1, ['Fix the login']);
    w.store.save({ ...newThread(SID(1), OTHER_UUID, NOW), started: true, convDir: w.configDir });
    w.svc.ask(w.binding(), { text: 'q1' });
    await until(() => w.calls.length === 1);
    w.calls[0]!.end({ ok: false, kind: 'exit', message: 'No conversation found with session ID' });
    await until(() => w.calls.length === 2);
    w.calls[1]!.end({ ok: false, kind: 'exit', message: 'Not logged in' });
    await until(() => w.items().length === 2);
    expect(w.items()[1]).toMatchObject({ kind: 'error', reason: 'exit', message: 'Not logged in' });
    await settle();
    expect(w.calls).toHaveLength(2);
  });

  test('a failure after init, a limit or a stop is never retried', async () => {
    const w = world();
    for (const k of [1, 2, 3]) {
      w.writeChat(k, ['Do it']);
      w.store.save({ ...newThread(SID(k), OTHER_UUID, NOW), started: true, convDir: w.configDir });
      w.svc.ask(w.binding(k), { text: `q${k}` });
    }
    await until(() => w.calls.length === 3);
    w.call(1).o.onItem({ t: 'init', sessionId: OTHER_UUID });
    w.call(1).end({ ok: false, kind: 'exit', message: 'API error' });
    w.call(2).end({ ok: false, kind: 'limit', message: 'Usage limit reached', resetsAt: 1 });
    w.svc.stop(SID(3));
    await until(() => [1, 2, 3].every((k) => w.items(k).length === 2));
    await settle();
    expect(w.calls).toHaveLength(3);
  });

  test('an account with no dir of its own runs without a config dir', async () => {
    const w = world({ accountDir: () => null });
    w.writeChat(1, ['Fix the login']);
    w.svc.ask(w.binding(), { text: 'q1' });
    await until(() => w.calls.length === 1);
    expect(w.calls[0]!.o).not.toHaveProperty('configDir');
  });

  test("an unreadable transcript (a folder in its place): one chat-unreadable item, not repeated on the next ask, and the run still happens", async () => {
    const w = world();
    mkdirSync(transcriptFile(w.binding())!, { recursive: true });
    w.svc.ask(w.binding(), { text: 'q1' });
    await until(() => w.calls.length === 1);
    expect(w.items().map(label)).toEqual(['Q:q1', 'E:chat-unreadable']);
    expect(w.items()[1]).toEqual({ kind: 'error', id: expect.any(String), at: NOW, questionId: null, reason: 'chat-unreadable', message: "Couldn't read this session's chat: answers come from the code only" });
    expect(readFileSync(join(w.store.dirOf(SID(1)), 'chat.md'), 'utf8')).toMatch(/couldn't be read/);
    w.calls[0]!.end(ok('a1'));
    await until(() => w.items().length === 3);
    w.svc.ask(w.binding(), { text: 'q2' });
    await until(() => w.calls.length === 2);
    w.calls[1]!.end(ok('a2'));
    await until(() => w.items().length === 5);
    expect(w.items().map(label)).toEqual(['Q:q1', 'E:chat-unreadable', 'A:a1', 'Q:q2', 'A:a2']);
  });

  test('no transcript yet means no conversation yet: an empty chat, no chat-unreadable item, and the run happens', async () => {
    const w = world();
    w.svc.ask(w.binding(), { text: 'q1' });
    await until(() => w.calls.length === 1);
    expect(w.items().map(label)).toEqual(['Q:q1']);
    expect(readFileSync(join(w.store.dirOf(SID(1)), 'chat.md'), 'utf8')).not.toMatch(/couldn't be read/);
  });

  test('a session that entered a worktree: its transcript moved there is read, not "Nothing asked yet"', async () => {
    const w = world();
    // Claude Code moves the session's file under the worktree's folder; the hooks' cwd stays the start folder.
    const wt = join(w.project, '.claude', 'worktrees', 'workspaces');
    const f = transcriptFile({ ...w.binding(), cwd: wt })!;
    mkdirSync(dirname(f), { recursive: true });
    writeFileSync(f, [P('Plan the workspaces'), P('Now build it')].map((l) => l + '\n').join(''));
    w.svc.catchUp(w.binding(), { final: false });
    await until(() => w.calls.length === 1);
    expect(readFileSync(join(w.store.dirOf(SID(1)), 'chat.md'), 'utf8')).toMatch(/Plan the workspaces[\s\S]*Now build it/);
    expect(w.items().some((i) => i.kind === 'catchup')).toBe(false);
  });

  test('no transcript yet: Catch me up says "Nothing asked yet" without a run', async () => {
    const w = world();
    w.svc.catchUp(w.binding(), { final: false });
    await until(() => w.items().length === 1);
    expect(w.items()[0]).toMatchObject({ kind: 'catchup', data: { points: [], where: 'Nothing asked yet' } });
    await settle();
    expect(w.calls).toHaveLength(0);
  });

  test('the chat is read incrementally: a prompt typed between two asks reaches chat.md', async () => {
    const w = world();
    w.writeChat(1, ['First']);
    w.svc.ask(w.binding(), { text: 'q1' });
    await until(() => w.calls.length === 1);
    w.calls[0]!.end(ok('a1'));
    await until(() => w.items().length === 2);
    writeFileSync(transcriptFile(w.binding())!, P('First') + '\n' + P('Second') + '\n');
    w.svc.ask(w.binding(), { text: 'q2' });
    await until(() => w.calls.length === 2);
    const chat = readFileSync(join(w.store.dirOf(SID(1)), 'chat.md'), 'utf8');
    expect(chat).toContain('[#1');
    expect(chat).toContain('YOU: Second');
  });
});

describe('threads, quit and retention', () => {
  test('thread() settles a question left without an answer by an earlier run of the app, once, but never a running one', async () => {
    const w = world();
    const q0: ThreadItem = { kind: 'question', id: 'q0', at: NOW - 1000, text: 'old' };
    w.store.save({ ...newThread(SID(1), OTHER_UUID, NOW - 1000), items: [q0] });
    const t = w.svc.thread(SID(1))!;
    expect(t.items.map(label)).toEqual(['Q:old', 'E:quit']);
    expect(w.svc.thread(SID(1))).toEqual(t);
    expect(w.saved()).toEqual(t);
    w.writeChat(1, ['Fix the login']);
    w.svc.ask(w.binding(), { text: 'q1' });
    await until(() => w.calls.length === 1);
    expect(w.svc.thread(SID(1))!.items.map(label)).toEqual(['Q:old', 'E:quit', 'Q:q1']);
    expect(w.svc.thread(SID(2))).toBeNull();
  });

  test('stopAll stops every run; a new service on the same store shows each question with one quit error and resumes a conversation that had started', async () => {
    const w = world();
    for (const k of [1, 2]) w.writeChat(k, ['Do it']);
    w.svc.ask(w.binding(1), { text: 'q1' });
    w.svc.ask(w.binding(1), { text: 'q1b' });
    w.svc.ask(w.binding(2), { text: 'q2' });
    await until(() => w.calls.length === 2);
    const uuid = after(w.call(1).o.args, '--session-id')!;
    // Claude started the conversation: that is saved at once, before any outcome (a quit or a crash comes first).
    w.call(1).o.onItem({ t: 'init', sessionId: uuid });
    expect(w.saved(1)).toMatchObject({ claudeUuid: uuid, started: true, convDir: w.configDir });
    w.svc.stopAll();
    expect(w.calls.every((c) => c.o.signal?.aborted)).toBe(true);
    // Saved before the runs end: a quit that doesn't wait for them still leaves the threads right.
    expect(w.items(1).map(label)).toEqual(['Q:q1', 'E:quit', 'Q:q1b', 'E:quit']);
    expect(w.items(2).map(label)).toEqual(['Q:q2', 'E:quit']);
    w.calls[0]!.end(ok('late'));
    await settle();
    expect(w.svc.ask(w.binding(1), { text: 'q3' })).toEqual({ error: expect.any(String) });
    const again = new CompanionService({ ...w.deps }, () => {});
    const t1 = again.thread(SID(1))!;
    expect(t1.items.map(label)).toEqual(['Q:q1', 'E:quit', 'Q:q1b', 'E:quit']);
    expect(t1.items[1]).toMatchObject({ questionId: t1.items[0]!.id, message: 'Stopped when Atelier quit' });
    expect(t1.items[3]).toMatchObject({ questionId: t1.items[2]!.id, message: 'Stopped when Atelier quit' });
    expect(again.thread(SID(2))!.items.map(label)).toEqual(['Q:q2', 'E:quit']);
    expect(w.calls).toHaveLength(2);
    again.ask(w.binding(1), { text: 'q3' });
    await until(() => w.calls.length === 3);
    expect(after(w.calls[2]!.o.args, '--resume')).toBe(uuid);
  });

  test("New Thread while a run is going: the run stops and its outcome never reaches the new thread", async () => {
    const w = world();
    w.writeChat(1, ['Fix the login']);
    w.svc.ask(w.binding(), { text: 'q1', model: 'opus' });
    await until(() => w.calls.length === 1);
    const fresh = w.svc.newThread(SID(1));
    expect(w.calls[0]!.o.signal?.aborted).toBe(true);
    expect(fresh.model).toBe('opus');
    await settle();
    expect(w.saved()).toEqual(fresh);
    w.svc.ask(w.binding(), { text: 'q2' });
    await until(() => w.calls.length === 2);
    expect(after(w.calls[1]!.o.args, '--session-id')).toBe(fresh.claudeUuid);
  });

  test('sweep removes expired threads that are not live, and unreadable ones only when their folder is over 30 days old', async () => {
    const live = new Set([SID(2)]);
    const w = world({ live: () => live });
    const old = NOW - RETENTION_MS - 1;
    w.store.save(newThread(SID(1), OTHER_UUID, old));
    w.store.save(newThread(SID(2), OTHER_UUID, old));
    w.store.save(newThread(SID(3), OTHER_UUID, NOW - 1000));
    for (const k of [4, 5]) {
      w.store.save(newThread(SID(k), OTHER_UUID, old));
      writeFileSync(join(w.store.dirOf(SID(k)), 'thread.json'), '{not json');
    }
    utimesSync(w.store.dirOf(SID(4)), old / 1000, old / 1000);
    utimesSync(w.store.dirOf(SID(5)), (NOW - 1000) / 1000, (NOW - 1000) / 1000);
    w.svc.sweep();
    expect(w.store.list().sort()).toEqual([SID(2), SID(3), SID(5)]);
  });

  // Any number of sessions (SID only spells 1–9).
  const sid = (k: number) => `${String(k).padStart(8, '0')}-1111-4222-8333-944455556666`;

  test(`over ${THREADS_KEPT} threads the least recently used go — under Resume too — never one open in a terminal`, () => {
    // 1 is the oldest and open in a terminal; 2 only waits under Resume (live, not open): the 30-day rule spares it.
    const open = new Set([sid(1)]);
    const live = new Set([sid(1), sid(2)]);
    const w = world({ live: () => live, open: () => open });
    for (let k = 1; k <= THREADS_KEPT + 3; k++) w.store.save(newThread(sid(k), OTHER_UUID, NOW - (1000 - k) * 60_000));
    // Unreadable, its folder untouched since long before the others: least recently used too.
    writeFileSync(join(w.store.dirOf(sid(THREADS_KEPT + 3)), 'thread.json'), '{not json');
    const old = (NOW - 2000 * 60_000) / 1000;
    utimesSync(w.store.dirOf(sid(THREADS_KEPT + 3)), old, old);
    w.svc.sweep();
    const left = new Set(w.store.list());
    expect(left.size).toBe(THREADS_KEPT);
    expect(left.has(sid(1))).toBe(true);
    for (const k of [2, 3, THREADS_KEPT + 3]) expect(left.has(sid(k))).toBe(false);
    expect(left.has(sid(4))).toBe(true);
  });

  test('a sweep reads each thread once (it runs on the main thread)', () => {
    const w = world();
    for (let k = 1; k <= THREADS_KEPT + 2; k++) w.store.save(newThread(sid(k), OTHER_UUID, NOW - (1000 - k) * 60_000));
    const load = vi.spyOn(w.store, 'load');
    w.svc.sweep();
    expect(load).toHaveBeenCalledTimes(THREADS_KEPT + 2);
  });

  test(`the ${THREADS_KEPT}-thread cap never takes one with a run going or waiting`, async () => {
    const w = world();
    w.writeChat(1, ['Do it']);
    // Asked long ago and still running: its thread is the least recently used.
    w.clock.now = NOW - 500 * 60_000;
    w.svc.ask(w.binding(1), { text: 'q' });
    await until(() => w.calls.length === 1);
    w.clock.now = NOW;
    for (let k = 2; k <= THREADS_KEPT + 1; k++) w.store.save(newThread(sid(k), OTHER_UUID, NOW - (400 - k) * 60_000));
    w.svc.sweep();
    const left = new Set(w.store.list());
    expect(left.size).toBe(THREADS_KEPT);
    expect(left.has(sid(1))).toBe(true);
    expect(left.has(sid(2))).toBe(false);
  });

  test('sweep never touches a session with a run going or waiting', async () => {
    const w = world();
    for (const k of [1, 2, 3, 4]) w.writeChat(k, ['Do it']);
    for (const k of [1, 2, 3, 4]) w.svc.ask(w.binding(k), { text: `q${k}` });
    await until(() => w.calls.length === 3);
    w.clock.now = NOW + RETENTION_MS + 60_000;
    w.svc.sweep();
    expect(w.store.list().sort()).toEqual([SID(1), SID(2), SID(3), SID(4)]);
  });
});

describe('explicit run end', () => {
  const endedOf = (w: ReturnType<typeof world>) => w.events.filter((e) => e.kind === 'ended').map((e) => (e as { runId: string }).runId);
  const seenOf = (w: ReturnType<typeof world>) => w.runEvents().map((e) => e.runId);

  test('a finished run ends once, after the thread event that closes it', async () => {
    const w = world();
    w.writeChat(1, ['Fix the login']);
    const r = w.svc.ask(w.binding(), { text: 'q1' }) as { runId: string };
    await until(() => w.calls.length === 1);
    w.calls[0]!.end(ok('a1'));
    await until(() => endedOf(w).length === 1);
    expect(endedOf(w)).toEqual([r.runId]);
    const last = w.events.length - 1;
    expect(w.events[last]).toMatchObject({ kind: 'ended', runId: r.runId });
    expect(w.events.findLast((e) => e.kind === 'thread')).toMatchObject({ thread: { items: [{ kind: 'question' }, { kind: 'answer' }] } });
  });

  test('a failed and a stopped run end; so does one that was waiting', async () => {
    const w = world();
    w.writeChat(1, ['Do it']);
    w.svc.ask(w.binding(), { text: 'q1' });
    w.svc.ask(w.binding(), { text: 'q2' });
    await until(() => w.calls.length === 1);
    w.svc.stop(SID(1));
    w.calls[0]!.end(ok('late'));
    await until(() => w.calls.length === 2);
    w.calls[1]!.end({ ok: false, reason: 'exit', message: 'boom' } as unknown as RunOutcome);
    await until(() => endedOf(w).length === 2);
    expect([...new Set(seenOf(w))].sort()).toEqual([...endedOf(w)].sort());
  });

  test('New Thread ends the held and the running runs, each once', async () => {
    const w = world();
    w.writeChat(1, ['Do it']);
    w.svc.ask(w.binding(), { text: 'q1' });
    w.svc.ask(w.binding(), { text: 'q2' });
    await until(() => w.calls.length === 1);
    w.svc.newThread(SID(1));
    expect(endedOf(w)).toHaveLength(1);
    w.calls[0]!.end(ok('late'));
    await until(() => endedOf(w).length === 2);
    await settle();
    expect(endedOf(w).sort()).toEqual([...new Set(seenOf(w))].sort());
  });

  test('stopAll ends every run that was queued or started', async () => {
    const w = world();
    for (const k of [1, 2]) w.writeChat(k, ['Do it']);
    w.svc.ask(w.binding(1), { text: 'q1' });
    w.svc.ask(w.binding(1), { text: 'q1b' });
    w.svc.ask(w.binding(2), { text: 'q2' });
    await until(() => w.calls.length === 2);
    w.svc.stopAll();
    for (const c of w.calls) c.end(ok('late'));
    await settle();
    expect(endedOf(w).sort()).toEqual([...new Set(seenOf(w))].sort());
    expect(endedOf(w)).toHaveLength(3);
  });

  test('a Catch me up two requests shared ends once', async () => {
    const w = world();
    w.writeChat(1, ['Fix the login']);
    w.svc.ask(w.binding(), { text: 'q1' });
    const a = w.svc.catchUp(w.binding(), { final: false }) as { runId: string };
    const b = w.svc.catchUp(w.binding(), { final: false }) as { runId: string };
    expect(b.runId).toBe(a.runId);
    await until(() => w.calls.length === 1);
    w.calls[0]!.end(ok('a1'));
    await until(() => w.calls.length === 2);
    w.calls[1]!.end(ok(JSON.stringify(GOOD_CATCHUP), { structured: GOOD_CATCHUP }));
    await until(() => endedOf(w).length === 2);
    await settle();
    expect(endedOf(w).filter((id) => id === a.runId)).toHaveLength(1);
  });

  test('New Thread whose save throws still ends the runs that never ran', async () => {
    const w = world();
    w.writeChat(1, ['Do it']);
    w.svc.ask(w.binding(), { text: 'q1' });
    const held = w.svc.ask(w.binding(), { text: 'q2' }) as { runId: string };
    await until(() => w.calls.length === 1);
    vi.spyOn(w.store, 'save').mockImplementation(() => { throw new Error('disk full'); });
    expect(() => w.svc.newThread(SID(1))).toThrow('disk full');
    expect(w.events.filter((e) => e.kind === 'ended').map((e) => (e as { runId: string }).runId)).toEqual([held.runId]);
  });
});
