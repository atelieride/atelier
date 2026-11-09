import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { Binding, CompanionEvent, Thread } from '../../shared/companion/types';
import { compileWorld } from '../compile/index';
import { ASK_PLAYER, type AskPlayer } from '../engine/ask';
import { createClock } from '../engine/clock';
import { ASK_SCRIPT } from '../world/ask';
import type { ScenarioName } from '../world/scenarios';
import { CHUNK_MS, LOAD_FAILED, chunks } from './companion';
import { createDemo } from './index';

// Ask in the live demo: an in-memory companion per demo session that plays the
// script with main's event contract — queued/started, trace, delta, the thread that closes the run, then exactly one
// `ended` — on the demo's clock.

const compiled = compileWorld();

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(compiled.t0 + 86_400_000); });
afterEach(() => { vi.useRealTimers(); });

function demo(o: { load?: () => Promise<AskPlayer> } = {}) {
  const clock = createClock();
  const d = createDemo(compiled, { version: '9.9.9', now: () => Date.now(), clock, askPlayer: o.load ?? (async () => ASK_PLAYER) });
  const events: CompanionEvent[] = [];
  d.api.on.companion((e) => events.push(e));
  const binding = (name: ScenarioName): Binding => {
    const t = d.context.state.terminals.find((x) => x.title === name)!;
    return { terminalId: t.id, sessionId: t.session!.sessionId, cwd: t.cwd, configDir: t.configDir ?? null, title: t.title };
  };
  const api = d.api.companion;
  /** The events of a run, by kind (thread events are the session's, not the run's). */
  const kinds = () => events.map((e) => (e.kind === 'thread' ? `thread:${e.thread.items.map((i) => i.kind).join(',')}` : e.kind));
  const last = (): Thread => (events.filter((e) => e.kind === 'thread').at(-1) as Extract<CompanionEvent, { kind: 'thread' }>).thread;
  const text = (runId: string) => events.filter((e): e is Extract<CompanionEvent, { kind: 'delta' }> => e.kind === 'delta' && e.runId === runId).map((e) => e.text);
  return { ...d, bridge: d.api, clock, events, binding, api, kinds, last, text };
}

type Demo = ReturnType<typeof demo>;
const ESC = '\u001b';

/** What a terminal prints, as the renderer receives it, styles dropped (the demo draws only for attached terminals). */
async function watchScreen(d: Demo, id: string): Promise<() => string> {
  let out = '';
  d.bridge.on.snapshot((tid, s) => { if (tid === id) out += s; });
  d.bridge.on.data((tid, s) => { if (tid === id) out += s; });
  d.bridge.terminals.resize(id, 100, 40);
  await d.bridge.terminals.attach(id);
  return () => out.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '');
}

/** The demo's clock on, a little at a time, until `cond` holds (the Esc lands at that moment). */
async function until(cond: () => boolean, maxMs = 30_000): Promise<void> {
  for (let t = 0; t <= maxMs; t += 20) {
    if (cond()) return;
    await vi.advanceTimersByTimeAsync(20);
  }
  throw new Error('the moment never came');
}

/** A Catch me up now, played to its end: its card. */
async function catchUpNow(d: Demo, name: ScenarioName) {
  await d.api.catchUp({ binding: d.binding(name), final: false });
  await vi.advanceTimersByTimeAsync(6000);
  const item = d.last().items.findLast((i) => i.kind === 'catchup');
  if (item?.kind !== 'catchup') throw new Error('a catch-up');
  return item.data;
}

/** A question now, played to its end: the answer's Markdown. */
async function askNow(d: Demo, name: ScenarioName, text: string): Promise<string> {
  await d.api.ask({ binding: d.binding(name), text });
  await vi.advanceTimersByTimeAsync(30_000);
  const item = d.last().items.at(-1);
  if (item?.kind !== 'answer') throw new Error('an answer');
  return item.markdown;
}

/** Main's contract: every run started or queued ends exactly once, after a thread event. */
function expectContract(events: CompanionEvent[]) {
  const runs = new Set(events.flatMap((e) => (e.kind === 'queued' || e.kind === 'started' ? [e.runId] : [])));
  for (const runId of runs) {
    const ended = events.map((e, i) => (e.kind === 'ended' && e.runId === runId ? i : -1)).filter((i) => i >= 0);
    expect(ended, runId).toHaveLength(1);
    const begun = events.findIndex((e) => (e.kind === 'queued' || e.kind === 'started') && e.runId === runId);
    expect(begun).toBeLessThan(ended[0]!);
    // The thread event that closes it comes right before its end (other runs New Thread dropped may end in between).
    let k = ended[0]! - 1;
    while (k > begun && events[k]!.kind === 'ended') k--;
    expect(events[k]!.kind, `${runId}: the thread that closes it comes right before its end`).toBe('thread');
    // Nothing of the run after its end.
    expect(events.slice(ended[0]! + 1).some((e) => 'runId' in e && e.runId === runId)).toBe(false);
  }
}

describe('Catch me up', () => {
  test('started at once, its trace on the clock, then the card in the thread (unseen) and its end', async () => {
    const d = demo();
    const b = d.binding('auth-refactor');
    expect(await d.api.thread(b.sessionId)).toBeNull();
    const r = await d.api.catchUp({ binding: b, final: false });
    expect(r).toEqual({ runId: expect.any(String) });
    // The event before the reply, as main sends it.
    expect(d.kinds()).toEqual(['started']);
    expect(d.events[0]).toMatchObject({ kind: 'started', sessionId: b.sessionId, questionId: null, runId: (r as { runId: string }).runId });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(d.kinds()).toEqual(['started', 'trace', 'trace', 'trace', 'trace', 'thread:catchup', 'ended']);
    expect(d.events.filter((e) => e.kind === 'trace').map((e) => (e as { line: string }).line)).toEqual(['Read the chat', 'Read the session facts', 'Read src/auth/session.ts', 'Read src/auth/tokens.ts']);
    const t = d.last();
    expect(t).toMatchObject({ sessionId: b.sessionId, unseen: true, model: null, items: [{ kind: 'catchup', model: 'sonnet', final: false, read: ['src/auth/session.ts', 'src/auth/tokens.ts'] }] });
    expect(t.lastCatchUpAt).toBe(t.items[0]!.at);
    expect(await d.api.thread(b.sessionId)).toEqual(t);
    expectContract(d.events);
  });

  test('a second request while one is on its way is the same run', async () => {
    const d = demo();
    const b = d.binding('docs');
    const a = await d.api.catchUp({ binding: b, final: false });
    const again = await d.api.catchUp({ binding: b, final: false });
    expect(again).toEqual(a);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(d.events.filter((e) => e.kind === 'ended')).toHaveLength(1);
    expect(d.last().items).toHaveLength(1);
  });

  test("the card's time is when it read the chat; its points' times are the session's", async () => {
    const d = demo();
    const b = d.binding('onboarding-copy');
    const asked = Date.now();
    await d.api.catchUp({ binding: b, final: false });
    await vi.advanceTimersByTimeAsync(10_000);
    const item = d.last().items[0]!;
    expect(item.at).toBe(asked);
  });
});

describe('a question', () => {
  test('the question joins the thread, then it starts, reads, streams at word boundaries and lands as an answer', async () => {
    const d = demo();
    const b = d.binding('auth-refactor');
    const r = await d.api.ask({ binding: b, text: 'How does readSession work?' }) as { runId: string };
    expect(d.kinds()).toEqual(['thread:question', 'started']);
    const q = d.last().items[0]!;
    expect(q).toMatchObject({ kind: 'question', text: 'How does readSession work?' });
    expect(d.events[1]).toMatchObject({ kind: 'started', runId: r.runId, questionId: q.id });
    await vi.advanceTimersByTimeAsync(30_000);
    const chunks = d.text(r.runId);
    const answer = d.last().items[1]!;
    expect(answer).toMatchObject({ kind: 'answer', questionId: q.id, model: 'sonnet', read: ['src/auth/session.ts'], costUsd: 0.008 });
    if (answer.kind !== 'answer') throw new Error('an answer');
    expect(chunks.join('')).toBe(answer.markdown);
    expect(chunks.length).toBeGreaterThan(3);
    // Word boundaries: every chunk but the last ends after a space (or a line break).
    for (const c of chunks.slice(0, -1)) expect(c, JSON.stringify(c)).toMatch(/\s$/);
    expect(d.last()).toMatchObject({ unseen: true, costUsd: 0.008 });
    const order = d.kinds();
    expect(order.slice(0, 2)).toEqual(['thread:question', 'started']);
    expect(order.slice(-2)).toEqual(['thread:question,answer', 'ended']);
    expect(order.indexOf('delta')).toBeGreaterThan(order.lastIndexOf('trace'));
    expectContract(d.events);
  });

  test('the chunks come about CHUNK_MS apart, on the demo clock: a paused demo pauses the answer', async () => {
    const d = demo();
    const r = await d.api.ask({ binding: d.binding('docs'), text: "What's left?" }) as { runId: string };
    await vi.advanceTimersByTimeAsync(2500);
    const before = d.text(r.runId).length;
    expect(before).toBeGreaterThan(0);
    await vi.advanceTimersByTimeAsync(CHUNK_MS);
    expect(d.text(r.runId).length).toBe(before + 1);
    d.clock.pause();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(d.text(r.runId).length).toBe(before + 1);
    d.clock.resume();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(d.events.at(-1)).toMatchObject({ kind: 'ended', runId: r.runId });
  });

  test("the model is the panel's pick, kept by the thread for its next questions; Settings › Ask's otherwise", async () => {
    const d = demo();
    const b = d.binding('docs');
    await d.api.ask({ binding: b, text: "What's left?", model: 'haiku' });
    await vi.advanceTimersByTimeAsync(30_000);
    await d.api.ask({ binding: b, text: 'What is it doing?' });
    await vi.advanceTimersByTimeAsync(30_000);
    const answers = d.last().items.filter((i) => i.kind === 'answer');
    expect(answers.map((a) => a.kind === 'answer' && a.model)).toEqual(['haiku', 'haiku']);
    expect(d.last()).toMatchObject({ model: 'haiku', costUsd: 0.004 });
    const e = demo();
    e.context.state.settings = { ...e.context.state.settings, askModel: 'opus' };
    await e.api.ask({ binding: e.binding('docs'), text: "What's left?" });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(e.last().items[1]).toMatchObject({ kind: 'answer', model: 'opus' });
  });

  test('an empty question is refused, as main refuses it', async () => {
    const d = demo();
    expect(await d.api.ask({ binding: d.binding('docs'), text: '   ' })).toEqual({ error: 'Empty question' });
    expect(d.events).toEqual([]);
  });

  test('one run per session: a question asked during a Catch me up waits (queued), joins the thread when its turn comes', async () => {
    const d = demo();
    const b = d.binding('billing-tests');
    const c = await d.api.catchUp({ binding: b, final: false }) as { runId: string };
    const q = await d.api.ask({ binding: b, text: "What's left?" }) as { runId: string };
    expect(d.events.at(-1)).toMatchObject({ kind: 'queued', runId: q.runId, questionId: expect.any(String) });
    // Held: not in the thread yet.
    expect((await d.api.thread(b.sessionId))?.items.some((i) => i.kind === 'question') ?? false).toBe(false);
    await vi.advanceTimersByTimeAsync(60_000);
    const kinds = d.kinds();
    const endC = d.events.findIndex((e) => e.kind === 'ended' && e.runId === c.runId);
    const startQ = d.events.findIndex((e) => e.kind === 'started' && e.runId === q.runId);
    expect(endC).toBeLessThan(startQ);
    expect(kinds[endC + 1]).toBe('thread:catchup,question');
    expect(d.last().items.map((i) => i.kind)).toEqual(['catchup', 'question', 'answer']);
    // Another session runs at the same time as this one.
    expectContract(d.events);
  });

  test("another session's run goes on at the same time", async () => {
    const d = demo();
    await d.api.ask({ binding: d.binding('docs'), text: "What's left?" });
    await d.api.ask({ binding: d.binding('auth-refactor'), text: "What's left?" });
    expect(d.events.filter((e) => e.kind === 'started')).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(30_000);
    expectContract(d.events);
  });
});

describe('Stop', () => {
  test('mid-answer: what arrived stays, marked stopped; nothing more comes', async () => {
    const d = demo();
    const b = d.binding('auth-refactor');
    const r = await d.api.ask({ binding: b, text: 'How does readSession work?' }) as { runId: string };
    await vi.advanceTimersByTimeAsync(2600);
    const sofar = d.text(r.runId).join('');
    expect(sofar.length).toBeGreaterThan(0);
    await d.api.stop(b.sessionId);
    const n = d.events.length;
    expect(d.kinds().slice(-2)).toEqual(['thread:question,answer', 'ended']);
    expect(d.last().items[1]).toMatchObject({ kind: 'answer', markdown: sofar, stopped: true, costUsd: null, read: [] });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(d.events).toHaveLength(n);
    expectContract(d.events);
  });

  test('before any text: a Stopped item for the question; a Catch me up stopped is one with no question', async () => {
    const d = demo();
    const b = d.binding('docs');
    await d.api.ask({ binding: b, text: "What's left?" });
    await vi.advanceTimersByTimeAsync(300);
    await d.api.stop(b.sessionId);
    const q = d.last().items[0]!;
    expect(d.last().items[1]).toMatchObject({ kind: 'error', reason: 'stopped', message: 'Stopped', questionId: q.id });
    await d.api.catchUp({ binding: b, final: false });
    await d.api.stop(b.sessionId);
    expect(d.last().items[2]).toMatchObject({ kind: 'error', reason: 'stopped', questionId: null });
    expectContract(d.events);
  });

  test("stops the session's current run only: the one waiting goes next", async () => {
    const d = demo();
    const b = d.binding('docs');
    await d.api.catchUp({ binding: b, final: false });
    const q = await d.api.ask({ binding: b, text: "What's left?" }) as { runId: string };
    await d.api.stop(b.sessionId);
    expect(d.events.at(-1)).toMatchObject({ kind: 'started', runId: q.runId });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(d.last().items.map((i) => i.kind)).toEqual(['error', 'question', 'answer']);
    expectContract(d.events);
  });

  test('nothing to stop: nothing happens', async () => {
    const d = demo();
    await d.api.stop(d.binding('docs').sessionId);
    expect(d.events).toEqual([]);
  });
});

describe('New Thread, seen, the script', () => {
  test("New Thread drops the session's runs (each still ends once), empties the thread under a new id, keeps its model", async () => {
    const d = demo();
    const b = d.binding('docs');
    await d.api.ask({ binding: b, text: "What's left?", model: 'opus' });
    await vi.advanceTimersByTimeAsync(30_000);
    const before = d.last();
    await d.api.ask({ binding: b, text: 'What is it doing?' });
    await d.api.catchUp({ binding: b, final: false });
    await vi.advanceTimersByTimeAsync(1500);
    const t = await d.api.newThread(b.sessionId);
    expect(t).toMatchObject({ sessionId: b.sessionId, items: [], model: 'opus', unseen: false, started: false });
    expect(t.claudeUuid).not.toBe(before.claudeUuid);
    expect(d.kinds().slice(-3)).toEqual(['thread:', 'ended', 'ended']);
    const n = d.events.length;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(d.events).toHaveLength(n);
    expect(await d.api.thread(b.sessionId)).toEqual(t);
    expectContract(d.events);
  });

  test('seen clears the unseen mark (a thread event, as main saves it); nothing to clear, nothing sent', async () => {
    const d = demo();
    const b = d.binding('docs');
    await d.api.seen(b.sessionId);
    expect(d.events).toEqual([]);
    await d.api.catchUp({ binding: b, final: false });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(d.last().unseen).toBe(true);
    await d.api.seen(b.sessionId);
    expect(d.last().unseen).toBe(false);
    expect((await d.api.thread(b.sessionId))!.unseen).toBe(false);
  });

  test('the script loads once, on first use; a load that fails lands an error item and the run still ends', async () => {
    const load = vi.fn(async () => ASK_PLAYER);
    const d = demo({ load });
    expect(load).not.toHaveBeenCalled();
    await d.api.catchUp({ binding: d.binding('docs'), final: false });
    await d.api.ask({ binding: d.binding('auth-refactor'), text: "What's left?" });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(load).toHaveBeenCalledTimes(1);
    const broken = demo({ load: () => Promise.reject(new Error('chunk failed')) });
    await broken.api.ask({ binding: broken.binding('docs'), text: "What's left?" });
    await vi.advanceTimersByTimeAsync(1000);
    expect(broken.last().items[1]).toMatchObject({ kind: 'error', reason: 'exit', message: LOAD_FAILED });
    expectContract(broken.events);
  });

  // A run stopped or dropped while the script's chunk is still on its way plays nothing once it arrives.
  test.each(['stop', 'new thread'] as const)('%s while the script is still loading: one ended, nothing of the run after it', async (how) => {
    let arrive: (p: AskPlayer) => void = () => {};
    const d = demo({ load: () => new Promise<AskPlayer>((r) => { arrive = r; }) });
    const b = d.binding('docs');
    const r = await d.api.ask({ binding: b, text: "What's left?" }) as { runId: string };
    await d.api.catchUp({ binding: b, final: false });
    await vi.advanceTimersByTimeAsync(2000);
    expect(d.kinds()).toEqual(['thread:question', 'started', 'queued']);
    if (how === 'stop') await d.api.stop(b.sessionId);
    else await d.api.newThread(b.sessionId);
    const n = d.events.length;
    arrive(ASK_PLAYER);
    await vi.advanceTimersByTimeAsync(30_000);
    const after = d.events.slice(n);
    expect(after.some((e) => 'runId' in e && e.runId === r.runId), JSON.stringify(after)).toBe(false);
    expect(d.events.filter((e) => e.kind === 'ended' && e.runId === r.runId)).toHaveLength(1);
    // Stop: the catch-up waiting behind it goes next, and plays; New Thread dropped it too.
    expect(after.some((e) => e.kind === 'trace')).toBe(how === 'stop');
    expectContract(d.events);
  });

  // No text means no chunk; the run must still land and end.
  test('an answer with no text still lands (empty) and ends; the chunker gives no piece for no text', async () => {
    expect(chunks('')).toEqual([]);
    expect(chunks('   ')).toEqual(['   ']);
    const silent: AskPlayer = { ...ASK_PLAYER, answerFor: () => ({ md: '', read: [], search: [], trace: ['Read the chat'] }) };
    const d = demo({ load: async () => silent });
    const b = d.binding('docs');
    await d.api.ask({ binding: b, text: "What's left?" });
    await vi.advanceTimersByTimeAsync(5000);
    expect(d.kinds().slice(-2)).toEqual(['thread:question,answer', 'ended']);
    expect(d.last().items[1]).toMatchObject({ kind: 'answer', markdown: '' });
    expectContract(d.events);
  });

  test('Help me decide on db-migration: its question, answered from the script', async () => {
    const d = demo();
    const b = d.binding('db-migration');
    await d.api.ask({ binding: b, text: 'Help me decide how to answer what db-migration is asking now.' });
    await vi.advanceTimersByTimeAsync(30_000);
    const a = d.last().items[1]!;
    expect(a).toMatchObject({ kind: 'answer' });
    if (a.kind === 'answer') expect(a.markdown).toBe(ASK_SCRIPT.sessions['db-migration'].phases.find((p) => p.id === 'waiting')!.decide!.md);
  });

  // Esc is a documented interaction of the demo; Ask follows what it did to the session. (billing-tests has
  // no interrupt: its agents run on, so Esc there changes nothing to follow.)
  test('Esc on docs ~10 s in: its Catch me up and "What\'s left?" say it stopped, never that it reads or is done', async () => {
    const d = demo();
    const term = d.context.state.terminals.find((x) => x.title === 'docs')!;
    await vi.advanceTimersByTimeAsync(10_000);
    d.bridge.terminals.input(term.id, ESC);
    await vi.advanceTimersByTimeAsync(100);
    expect(d.context.state.terminals.find((x) => x.id === term.id)!.session!.state).toBe('idle');
    const card = await catchUpNow(d, 'docs');
    expect(card.where).toMatch(/^You interrupted it/);
    expect(card.points.map((p) => p.status)).toEqual(['unclear']);
    expect(await askNow(d, 'docs', "What's left?")).not.toMatch(/^Verdict: (done|in-progress)/);
  });

  // Re-review: every Esc window the probes timed, played through the real engine, then Catch me up and a status answer.
  describe('Esc at each point of a turn: Ask says what the terminal shows', () => {
    test("on the visitor's own prompt, mid-way: Stopped, never done", async () => {
      const d = demo();
      const ob = d.context.state.terminals.find((x) => x.title === 'onboarding-copy')!.id;
      d.bridge.terminals.input(ob, 'tidy up the footer\r');
      await vi.advanceTimersByTimeAsync(800);
      d.bridge.terminals.input(ob, ESC);
      await vi.advanceTimersByTimeAsync(100);
      expect(d.context.state.prompts.get(ob)).toEqual([{ text: 'tidy up the footer', at: expect.any(Number), outcome: 'interrupted' }]);
      const card = await catchUpNow(d, 'onboarding-copy');
      expect(card.points.at(-1)).toMatchObject({ text: 'tidy up the footer', status: 'unclear', note: 'Stopped: you interrupted it' });
      expect(card.where).toMatch(/^Stopped: /);
      expect(await askNow(d, 'onboarding-copy', "What's left?")).toMatch(/^Verdict: unclear — Stopped/);
    });

    test('auth-refactor: Esc during the first run, after its failure, before and after "7 passed"', async () => {
      const at = async (marker: (d: Demo, screen: () => string) => boolean) => {
        const d = demo();
        const id = d.context.state.terminals.find((x) => x.title === 'auth-refactor')!.id;
        const screen = await watchScreen(d, id);
        d.bridge.terminals.input(id, '1');
        await until(() => marker(d, screen));
        d.bridge.terminals.input(id, ESC);
        await vi.advanceTimersByTimeAsync(100);
        expect(screen()).toContain('Interrupted by user');
        return { d, id, screen, card: await catchUpNow(d, 'auth-refactor') };
      };
      const status = (c: { points: { status: string }[] }) => c.points.map((p) => p.status);
      // While the first run prints: no run has finished.
      const cut = await at((_d, s) => s().includes('Bash(npm test -- auth)'));
      expect(cut.screen()).not.toContain('6 passed (7)');
      expect(status(cut.card)).toEqual(['done', 'unclear']);
      expect(cut.card.where).toMatch(/before it reported/);
      // After the first run's failure, before the fix.
      const first = await at((d, s) => s().includes('6 passed (7)') && !d.context.state.files['src/auth/session.ts']!.includes('+ SKEW_MS'));
      expect(status(first.card)).toEqual(['done', 'unclear']);
      expect(first.card.where).toMatch(/1 of 7/);
      // The fix written, the second run not reported yet.
      const fixed = await at((d, s) => d.context.state.files['src/auth/session.ts']!.includes('+ SKEW_MS') && !s().includes('7 passed (7)'));
      expect(fixed.screen()).not.toContain('7 passed (7)');
      expect(status(fixed.card)).toEqual(['done', 'unclear']);
      expect(fixed.card.where).toMatch(/the fix to the skew is in/);
      // "7 passed" on screen, its last words not yet: the run passed.
      const passed = await at((_d, s) => s().includes('7 passed (7)'));
      expect(passed.screen()).not.toContain('all 7 auth tests pass');
      expect(status(passed.card)).toEqual(['done', 'done']);
      // Then prompted: the scripted points stay as the interrupt left them.
      fixed.d.bridge.terminals.input(fixed.id, 'go on\r');
      await vi.advanceTimersByTimeAsync(300);
      expect(status(await catchUpNow(fixed.d, 'auth-refactor'))).toEqual(['done', 'unclear', 'in_progress']);
      // /clear starts the conversation over: nothing asked yet (Esc on its edit menu says no, its turn ends).
      fixed.d.bridge.terminals.input(fixed.id, ESC);
      await vi.advanceTimersByTimeAsync(3000);
      fixed.d.bridge.terminals.input(fixed.id, '/clear\r');
      expect(await catchUpNow(fixed.d, 'auth-refactor')).toEqual({ points: [], where: 'Nothing asked yet', choices: [], leftOpen: null });
    });

    test('db-migration: answered 1 then Esc, Esc before and after "in sync", then prompted', async () => {
      const at = async (marker: (d: Demo, screen: () => string) => boolean) => {
        const d = demo();
        const id = d.context.state.terminals.find((x) => x.title === 'db-migration')!.id;
        const screen = await watchScreen(d, id);
        d.bridge.terminals.input(id, '1');
        await until(() => marker(d, screen));
        d.bridge.terminals.input(id, ESC);
        await vi.advanceTimersByTimeAsync(100);
        expect(screen()).toContain('Interrupted by user');
        return { d, id, card: await catchUpNow(d, 'db-migration') };
      };
      const schema = (d: Demo) => d.context.state.files['prisma/schema.prisma']!;
      // Answered, nothing changed yet.
      const answered = await at((d) => !schema(d).includes('OrderStatus'));
      expect(answered.card.points.map((p) => p.status)).toEqual(['unclear']);
      expect(answered.card.where).toMatch(/answered its question/);
      expect(JSON.stringify(answered.card)).not.toMatch(/unanswered|skipped/i);
      // The schema changed, the migration not reported.
      const before = await at((d, s) => schema(d).includes('OrderStatus') && !s().includes('now in sync'));
      expect(before.card.points.map((p) => p.status)).toEqual(['unclear']);
      expect(before.card.where).toMatch(/migrate status/);
      // "in sync" on screen: applied.
      const after = await at((_d, s) => s().includes('now in sync'));
      expect(after.card.points.map((p) => p.status)).toEqual(['done']);
      // Interrupted, then prompted: still as the interrupt left it.
      before.d.bridge.terminals.input(before.id, 'go on\r');
      await vi.advanceTimersByTimeAsync(300);
      expect((await catchUpNow(before.d, 'db-migration')).points.map((p) => p.status)).toEqual(['unclear', 'in_progress']);
    });
  });

  test('the visitor\'s prompt, typed in onboarding-copy, is in its Catch me up', async () => {
    const d = demo();
    const ob = d.context.state.terminals.find((x) => x.title === 'onboarding-copy')!;
    d.bridge.terminals.input(ob.id, 'add dark mode\r');
    expect(d.context.state.prompts.get(ob.id)).toEqual([{ text: 'add dark mode', at: Date.now() }]);
    await d.api.catchUp({ binding: d.binding('onboarding-copy'), final: false });
    await vi.advanceTimersByTimeAsync(10_000);
    const item = d.last().items[0]!;
    if (item.kind !== 'catchup') throw new Error('a catch-up');
    expect(item.data.points.map((p) => [p.text, p.status])).toEqual([['Make the welcome page friendlier', 'done'], ['add dark mode', 'in_progress']]);
  });
});
