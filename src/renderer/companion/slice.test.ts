import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { TerminalInfo } from '@shared/protocol';
import type { SessionInfo } from '@shared/session';
import type { Thread } from '@shared/companion/types';
import { newThread } from '@shared/companion/thread';
import { DEFAULT_SETTINGS } from '@shared/settings';
import { initPlatform, resetPlatformForTests } from '@shared/platform';
import { useApp } from '../store';
import { askSelected, catchUpFor, openAskFor, toggleAskFor } from './actions';
import { firstEntrance, keepScroll, keptScroll } from './view';

// The store's Ask slice: what it asks main for and what it keeps.

const UUID = '11111111-1111-4111-8111-111111111111';
const NOW = 1_800_000_000_000;
const session = (o: Partial<SessionInfo> = {}): SessionInfo => ({ sessionId: 's1', state: 'idle', title: null, activity: null, contextPct: null, unread: false, updatedAt: 0, ...o });
const term = (s: SessionInfo | null, id = 't1'): TerminalInfo => ({ id, projectRoot: '/p', cwd: '/p', title: 'Fix', name: null, color: '#fff', foreground: 'claude', createdAt: 0, session: s });
const thread = (o: Partial<Thread> = {}): Thread => ({ ...newThread('s1', UUID, 0), ...o });
const flush = () => new Promise((r) => setTimeout(r, 0));
// Catch me up when opened, on: what these tests check (it is off by default, a Settings › Ask choice).
const ON = { ...DEFAULT_SETTINGS, askCatchUpOnOpen: true };

const api = {
  thread: vi.fn(), ask: vi.fn(), catchUp: vi.fn(), stop: vi.fn(), newThread: vi.fn(), seen: vi.fn()
};
const g = globalThis as unknown as { window?: unknown; document?: unknown };

function reset(over: Partial<ReturnType<typeof useApp.getState>> = {}) {
  useApp.setState({
    terminals: [term(session({ lastMessageAt: NOW - 3_600_000 }))], selectedId: 't1', activeTab: 'term', settingsOpen: null, paletteOpen: false,
    settings: { ...ON }, attributions: [], askOpen: {}, askThreads: {}, askRuns: {}, askTexts: {}, askNotice: {},
    askDock: {}, askPick: {}, askDrafts: {}, askWanted: null, poppedOut: [], popout: null, ...over
  });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  for (const f of Object.values(api)) f.mockReset();
  api.thread.mockResolvedValue(null);
  api.catchUp.mockResolvedValue({ runId: 'c1' });
  api.ask.mockResolvedValue({ runId: 'r1' });
  api.seen.mockResolvedValue(undefined);
  g.window = { atelier: { companion: api } };
  g.document = { hasFocus: () => true };
  reset();
});
afterEach(() => { vi.useRealTimers(); delete g.window; delete g.document; });

describe('toggleAsk', () => {
  test('a plain terminal never opens', () => {
    reset({ terminals: [term(null)] });
    useApp.getState().toggleAsk('t1');
    expect(useApp.getState().askOpen).toEqual({});
  });

  test('opens bound to the session, loads the thread and catches up with no thread yet', async () => {
    useApp.getState().toggleAsk('t1');
    expect(useApp.getState().askOpen.t1).toMatchObject({ sessionId: 's1', terminalId: 't1' });
    await flush();
    expect(api.thread).toHaveBeenCalledWith('s1');
    expect(api.catchUp).toHaveBeenCalledWith({ binding: expect.objectContaining({ sessionId: 's1' }), final: false });
  });

  test('seen() on open when the thread has an unseen outcome and the terminal is on screen', async () => {
    api.thread.mockResolvedValue(thread({ unseen: true, lastCatchUpAt: NOW }));
    useApp.getState().toggleAsk('t1');
    await flush();
    expect(api.seen).toHaveBeenCalledWith('s1');
    expect(useApp.getState().askThreads.s1?.unseen).toBe(true);
    expect(api.catchUp).not.toHaveBeenCalled();
  });

  test('no seen() on open when the terminal is not on screen', async () => {
    reset({ selectedId: null });
    useApp.setState({ terminals: [term(session())] });
    api.thread.mockResolvedValue(thread({ unseen: true, lastCatchUpAt: NOW }));
    useApp.getState().toggleAsk('t1');
    await flush();
    expect(api.seen).not.toHaveBeenCalled();
  });

  test('catch-up inputs: setting off, a fresh one, an old one with newer activity, an attribution that is only a maybe', async () => {
    const run = async (t: Thread | null, settings = {}, attributions: ReturnType<typeof useApp.getState>['attributions'] = []) => {
      reset({ settings: { ...ON, ...settings }, attributions });
      api.catchUp.mockClear();
      api.thread.mockResolvedValue(t);
      useApp.getState().toggleAsk('t1');
      await flush();
      return api.catchUp.mock.calls.length;
    };
    expect(await run(null, { askCatchUpOnOpen: false })).toBe(0);
    expect(await run(thread({ lastCatchUpAt: NOW - 60_000 }))).toBe(0);
    expect(await run(thread({ lastCatchUpAt: NOW - 20 * 60_000 }), {}, [{ path: '/a', terminalId: 't1', sessionId: 's1', color: '', title: '', at: NOW - 60_000 }])).toBe(1);
    expect(await run(thread({ lastCatchUpAt: NOW - 20 * 60_000 }), {}, [{ path: '/a', terminalId: 't1', sessionId: 's1', color: '', title: '', at: NOW - 60_000, maybe: true }])).toBe(0);
  });

  test('the binding survives the session ending; the catch-up is final; closing drops it, the thread stays', async () => {
    api.thread.mockResolvedValue(thread({ lastCatchUpAt: null }));
    useApp.getState().toggleAsk('t1');
    await flush();
    useApp.setState({ terminals: [term(null)] });
    expect(useApp.getState().askOpen.t1?.sessionId).toBe('s1');
    api.catchUp.mockClear();
    useApp.getState().askCatchUp('t1');
    expect(api.catchUp).toHaveBeenCalledWith({ binding: expect.anything(), final: true });
    useApp.getState().toggleAsk('t1');
    expect(useApp.getState().askOpen).toEqual({});
    expect(useApp.getState().askThreads.s1).toBeDefined();
  });

  test('after /clear the bound session counts as ended', async () => {
    reset({ terminals: [term(session({ sessionId: 'new' }))] });
    useApp.setState({ askOpen: { t1: { terminalId: 't1', sessionId: 's1', cwd: '/p', configDir: null, title: 'Fix' } } });
    useApp.getState().askCatchUp('t1');
    expect(api.catchUp).toHaveBeenCalledWith({ binding: expect.anything(), final: true });
  });

  test('by default it opens on its empty state: the thread loads, no Catch me up runs until asked', async () => {
    reset({ settings: { ...DEFAULT_SETTINGS } });
    useApp.getState().toggleAsk('t1');
    await flush();
    expect(api.thread).toHaveBeenCalledTimes(1);
    expect(api.catchUp).not.toHaveBeenCalled();
    useApp.getState().askCatchUp('t1');
    expect(api.catchUp).toHaveBeenCalledWith({ binding: expect.objectContaining({ sessionId: 's1' }), final: false });
  });

  test('a close and reopen before the thread loads finishes once', async () => {
    let first!: (t: Thread | null) => void;
    api.thread.mockReturnValueOnce(new Promise((r) => { first = r; })).mockResolvedValue(null);
    useApp.getState().toggleAsk('t1');
    useApp.getState().toggleAsk('t1');
    useApp.getState().toggleAsk('t1');
    first(null);
    await flush();
    expect(api.catchUp).toHaveBeenCalledTimes(1);
  });

  test('main refusing becomes the terminal notice, stripped', async () => {
    api.thread.mockRejectedValue(new Error("Error invoking remote method 'companion:thread': Error: Bad binding"));
    useApp.getState().toggleAsk('t1');
    await flush();
    expect(useApp.getState().askNotice.t1).toBe('Bad binding');
  });
});

describe('questions and runs', () => {
  const open = async () => { useApp.getState().toggleAsk('t1'); await flush(); api.catchUp.mockClear(); };

  test('the question text waits under its runId while the run is live', async () => {
    await open();
    useApp.getState().applyCompanionEvent({ sessionId: 's1', kind: 'queued', runId: 'r1', questionId: 'q1' });
    useApp.getState().askQuestion('t1', '  why?  ');
    await flush();
    expect(useApp.getState().askTexts).toEqual({ r1: 'why?' });
  });

  test('a run that ended before ask() replied leaves no text behind', async () => {
    await open();
    useApp.getState().askQuestion('t1', 'why?');
    await flush();
    expect(useApp.getState().askTexts).toEqual({});
  });

  test('an {error} result is the notice', async () => {
    await open();
    api.ask.mockResolvedValue({ error: 'Atelier is quitting' });
    useApp.getState().askQuestion('t1', 'why?');
    await flush();
    expect(useApp.getState().askNotice.t1).toBe('Atelier is quitting');
  });

  test('askQuestion says whether a run started (the composer keeps the text otherwise)', async () => {
    await open();
    await expect(useApp.getState().askQuestion('t1', 'why?')).resolves.toBe(true);
    api.ask.mockResolvedValue({ error: 'Atelier is quitting' });
    await expect(useApp.getState().askQuestion('t1', 'why?')).resolves.toBe(false);
    api.ask.mockRejectedValue(new Error('boom'));
    await expect(useApp.getState().askQuestion('t1', 'why?')).resolves.toBe(false);
    await expect(useApp.getState().askQuestion('t1', '   ')).resolves.toBe(false);
    await expect(useApp.getState().askQuestion('nope', 'why?')).resolves.toBe(false);
  });

  test("the thread's pickers go with its questions", async () => {
    await open();
    useApp.getState().setAskPick('s1', { model: 'opus' });
    useApp.getState().setAskPick('s1', { account: 'work' });
    await useApp.getState().askQuestion('t1', 'why?');
    expect(api.ask).toHaveBeenLastCalledWith({ binding: expect.objectContaining({ sessionId: 's1' }), text: 'why?', model: 'opus', account: 'work' });
    expect(useApp.getState().askPick).toEqual({ s1: { model: 'opus', account: 'work' } });
  });

  test("the thread's pickers go with its Catch me up too: the button's and the one on open", async () => {
    await open();
    useApp.getState().setAskPick('s1', { model: 'haiku', account: 'work' });
    useApp.getState().askCatchUp('t1');
    expect(api.catchUp).toHaveBeenLastCalledWith({ binding: expect.objectContaining({ sessionId: 's1' }), final: false, model: 'haiku', account: 'work' });
    useApp.getState().toggleAsk('t1');
    api.catchUp.mockClear();
    useApp.getState().toggleAsk('t1');
    await flush();
    expect(api.catchUp).toHaveBeenCalledWith({ binding: expect.objectContaining({ sessionId: 's1' }), final: false, model: 'haiku', account: 'work' });
  });

  test('seen() on a thread event only while the panel is on screen', async () => {
    await open();
    const ev = { sessionId: 's1', kind: 'thread', thread: thread({ unseen: true }) } as const;
    useApp.getState().applyCompanionEvent(ev);
    expect(api.seen).toHaveBeenCalledTimes(1);
    useApp.setState({ paletteOpen: true });
    useApp.getState().applyCompanionEvent(ev);
    expect(api.seen).toHaveBeenCalledTimes(1);
    useApp.getState().applyCompanionEvent({ ...ev, thread: thread({ unseen: false }) });
    expect(api.seen).toHaveBeenCalledTimes(1);
  });

  test('markAskSeen when the panel comes on screen', async () => {
    await open();
    useApp.getState().applyCompanionEvent({ sessionId: 's1', kind: 'thread', thread: thread({ unseen: true }) });
    api.seen.mockClear();
    useApp.setState({ paletteOpen: true });
    useApp.getState().markAskSeen('t1');
    expect(api.seen).not.toHaveBeenCalled();
    useApp.setState({ paletteOpen: false });
    useApp.getState().markAskSeen('t1');
    expect(api.seen).toHaveBeenCalledWith('s1');
  });

  test('New Thread shows the empty thread; run views end only with main\'s ended events', async () => {
    await open();
    const e = useApp.getState().applyCompanionEvent;
    e({ sessionId: 's1', kind: 'started', runId: 'a', questionId: 'q' });
    api.newThread.mockResolvedValue(thread());
    useApp.getState().newAskThread('t1');
    await flush();
    expect(useApp.getState().askThreads.s1?.items).toEqual([]);
    expect(Object.keys(useApp.getState().askRuns)).toEqual(['a']);
    e({ sessionId: 's1', kind: 'ended', runId: 'a' });
    expect(useApp.getState().askRuns).toEqual({});
  });

  test('ended from another window clears the view', async () => {
    await open();
    useApp.getState().applyCompanionEvent({ sessionId: 's1', kind: 'started', runId: 'a', questionId: 'q' });
    useApp.getState().applyCompanionEvent({ sessionId: 's1', kind: 'ended', runId: 'a' });
    expect(useApp.getState().askRuns).toEqual({});
  });
});

describe('dock mode', () => {
  test('the host says how it shows; null when it goes', () => {
    useApp.getState().setAskDock('t1', 'dock');
    useApp.getState().setAskDock('t2', 'sheet');
    expect(useApp.getState().askDock).toEqual({ t1: 'dock', t2: 'sheet' });
    const before = useApp.getState().askDock;
    useApp.getState().setAskDock('t1', 'dock');
    expect(useApp.getState().askDock).toBe(before);
    useApp.getState().setAskDock('t1', null);
    expect(useApp.getState().askDock).toEqual({ t2: 'sheet' });
  });

  test('kept while the panel is open (its terminal comes back at the docked size); closing or the terminal going clears it', async () => {
    useApp.getState().toggleAsk('t1');
    await flush();
    useApp.getState().setAskDock('t1', 'dock');
    useApp.getState().closeAskPanel('t1');
    expect(useApp.getState().askDock).toEqual({});
    useApp.getState().toggleAsk('t1');
    useApp.getState().setAskDock('t1', 'sheet');
    useApp.getState().applyTerminals([]);
    expect(useApp.getState().askDock).toEqual({});
  });
});

describe('drafts', () => {
  test("a half-typed question waits per session; empty clears it; it goes with its session", () => {
    useApp.getState().setAskDraft('s1', 'why');
    useApp.getState().setAskDraft('s9', 'gone');
    expect(useApp.getState().askDrafts).toEqual({ s1: 'why', s9: 'gone' });
    useApp.getState().setAskPick('s9', { model: 'haiku' });
    useApp.getState().applyTerminals([term(session())]);
    expect(useApp.getState().askDrafts).toEqual({ s1: 'why' });
    expect(useApp.getState().askPick).toEqual({});
    useApp.getState().setAskDraft('s1', '');
    expect(useApp.getState().askDrafts).toEqual({});
  });
});

describe('entrance (a panel shown again never replays it)', () => {
  test('the first time an open Ask is on screen it enters; shown again (a tab back, a split) it doesn\'t; closed, the next open enters again', () => {
    useApp.getState().toggleAsk('t1');
    expect(firstEntrance('t1')).toBe(true);
    expect(firstEntrance('t1')).toBe(false);
    expect(firstEntrance('t1')).toBe(false);
    useApp.getState().toggleAsk('t1');
    expect(useApp.getState().askOpen.t1).toBeUndefined();
    useApp.getState().toggleAsk('t1');
    expect(firstEntrance('t1')).toBe(true);
    useApp.getState().closeAskPanel('t1');
  });

  test('a thread scrolled up keeps its place while open; closed, it opens at the bottom', () => {
    useApp.getState().toggleAsk('t1');
    expect(keptScroll('t1')).toBe(null);
    keepScroll('t1', 120);
    expect(keptScroll('t1')).toBe(120);
    keepScroll('t1', null);
    expect(keptScroll('t1')).toBe(null);
    keepScroll('t1', 80);
    useApp.getState().closeAskPanel('t1');
    expect(keptScroll('t1')).toBe(null);
  });
});

describe('a pop-out that brings Ask along', () => {
  test('opens it once its terminal is listed with a live session', async () => {
    useApp.setState({ terminals: [], popout: { key: 't:t1' }, tabOrder: ['t:t1'] });
    useApp.getState().openAskWhenListed('t1');
    expect(useApp.getState().askOpen).toEqual({});
    useApp.getState().applyTerminals([term(null)]);
    expect(useApp.getState().askOpen).toEqual({});
    useApp.getState().applyTerminals([term(session())]);
    expect(useApp.getState().askOpen.t1).toMatchObject({ sessionId: 's1' });
    expect(useApp.getState().askWanted).toBeNull();
    useApp.setState({ popout: null });
  });
  test('opens at once when the terminal is already here; never closes an open one', async () => {
    useApp.getState().openAskWhenListed('t1');
    expect(useApp.getState().askOpen.t1).toBeDefined();
    useApp.getState().openAskWhenListed('t1');
    expect(useApp.getState().askOpen.t1).toBeDefined();
  });

  test('Move to New Window takes an open Ask along and closes it here; moving back opens it here again', async () => {
    const open = vi.fn(async () => ({ ok: true }));
    (g.window as { atelier: Record<string, unknown> }).atelier.popout = { open };
    useApp.setState({ tabOrder: ['t:t1'], poppedOut: [] });
    useApp.getState().toggleAsk('t1');
    await flush();
    await useApp.getState().popOut('t:t1', 'cascade');
    expect(open).toHaveBeenCalledWith(expect.objectContaining({ key: 't:t1', payload: { kind: 'terminal', ask: true } }));
    expect(useApp.getState().askOpen).toEqual({});
    useApp.getState().applyDock({ key: 't:t1', payload: { kind: 'terminal', ask: true } }, null);
    expect(useApp.getState().askOpen.t1).toMatchObject({ sessionId: 's1' });
    // Closed in the pop-out: it comes back closed.
    useApp.getState().closeAskPanel('t1');
    useApp.setState({ poppedOut: ['t:t1'] });
    useApp.getState().applyDock({ key: 't:t1', payload: { kind: 'terminal', ask: false } }, null);
    expect(useApp.getState().askOpen).toEqual({});
  });
});

describe('a session whose tab lives in another window, or isn\'t on screen', () => {
  test('popped out: Ask never opens in this window (no thread load, no Catch me up); openAskFor brings that window forward', async () => {
    const focus = vi.fn(async () => {});
    (g.window as { atelier: Record<string, unknown> }).atelier.popout = { focus };
    reset({ poppedOut: ['t:t1'], tabOrder: [] });
    useApp.getState().toggleAsk('t1');
    await flush();
    expect(useApp.getState().askOpen).toEqual({});
    expect(api.thread).not.toHaveBeenCalled();
    expect(api.catchUp).not.toHaveBeenCalled();
    openAskFor('t1');
    await flush();
    expect(focus).toHaveBeenCalledWith('t:t1');
    expect(useApp.getState().askOpen).toEqual({});
    expect(api.catchUp).not.toHaveBeenCalled();
  });

  test('opened while its tab isn\'t on screen (another tab in front): it opens, but never catches up by itself', async () => {
    reset({ activeTab: 'file' });
    useApp.getState().toggleAsk('t1');
    await flush();
    expect(useApp.getState().askOpen.t1).toBeDefined();
    expect(api.thread).toHaveBeenCalledWith('s1');
    expect(api.catchUp).not.toHaveBeenCalled();
  });
});

describe('a usage limit: Ask at the reset, Ask with another account', () => {
  const RESET = NOW / 1000 + 600;
  const limited = (questionId: string | null) => thread({
    items: [
      { kind: 'question', id: 'q1', at: NOW - 1000, text: 'What is left?' },
      { kind: 'error', id: 'e1', at: NOW - 500, questionId, reason: 'limit', message: 'Usage limit reached', resetsAt: RESET, window: 'five-hour' }
    ]
  });
  const open = async (t: Thread) => {
    // Fake timers move the clock too: each case starts before the reset again.
    vi.setSystemTime(NOW);
    reset({ askThreads: { s1: t } });
    api.thread.mockResolvedValue(t);
    useApp.getState().toggleAsk('t1');
    // Timers are fake here: the thread's promise settles on the microtask queue.
    await vi.advanceTimersByTimeAsync(0);
    api.ask.mockClear();
    api.catchUp.mockClear();
  };
  beforeEach(() => { vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] }); vi.setSystemTime(NOW); });

  test('Ask at: the failed question again a few seconds after the reset, once; the item knows it is waiting', async () => {
    await open(limited('q1'));
    useApp.getState().askAtReset('t1', 'e1');
    expect(useApp.getState().askAt.s1).toEqual({ itemId: 'e1', at: RESET * 1000 });
    await vi.advanceTimersByTimeAsync(600_000);
    expect(api.ask).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(3000);
    expect(api.ask).toHaveBeenCalledTimes(1);
    expect(api.ask).toHaveBeenCalledWith({ binding: expect.objectContaining({ sessionId: 's1' }), text: 'What is left?' });
    expect(useApp.getState().askAt.s1).toBeUndefined();
  });

  test('a Mac asleep past the reset: it asks at the next check (within a minute), not a whole delay after waking', async () => {
    await open(limited('q1'));
    useApp.getState().askAtReset('t1', 'e1');
    // Asleep: the clock moved on, the timers didn't run.
    vi.setSystemTime(NOW + 700_000);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(api.ask).toHaveBeenCalledTimes(1);
    expect(useApp.getState().askAt.s1).toBeUndefined();
  });

  test('coming back to the window (focus, visible again) checks at once', async () => {
    const on: Record<string, () => void> = {};
    const target = { addEventListener: (type: string, f: () => void) => { on[type] = f; } };
    Object.assign(g.window as object, target);
    Object.assign(g.document as object, target);
    for (const event of ['focus', 'visibilitychange'] as const) {
      await open(limited('q1'));
      useApp.getState().askAtReset('t1', 'e1');
      vi.setSystemTime(NOW + 700_000);
      on[event]!();
      expect(api.ask, event).toHaveBeenCalledTimes(1);
      // Woken before the reset: nothing yet.
      await open(limited('q1'));
      useApp.getState().askAtReset('t1', 'e1');
      on[event]!();
      expect(api.ask, event).not.toHaveBeenCalled();
      useApp.getState().cancelAskAt('s1');
    }
  });

  test('Ask at for a Catch me up that hit the limit catches up again', async () => {
    await open(limited(null));
    useApp.getState().askAtReset('t1', 'e1');
    await vi.advanceTimersByTimeAsync(603_000);
    expect(api.catchUp).toHaveBeenCalledTimes(1);
    expect(api.ask).not.toHaveBeenCalled();
  });

  test('one timer per thread: a new ask, Catch me up, New Thread, Cancel or closing the panel each cancel it', async () => {
    const cancelled = async (how: () => void) => {
      await open(limited('q1'));
      useApp.getState().askAtReset('t1', 'e1');
      how();
      expect(useApp.getState().askAt.s1).toBeUndefined();
      api.ask.mockClear();
      await vi.advanceTimersByTimeAsync(700_000);
      expect(api.ask).not.toHaveBeenCalled();
    };
    api.newThread.mockResolvedValue(thread());
    await cancelled(() => void useApp.getState().askQuestion('t1', 'Something else'));
    await cancelled(() => useApp.getState().askCatchUp('t1'));
    await cancelled(() => useApp.getState().newAskThread('t1'));
    await cancelled(() => useApp.getState().cancelAskAt('s1'));
    await cancelled(() => useApp.getState().closeAskPanel('t1'));
    // Twice on the same thread: still one timer.
    await open(limited('q1'));
    useApp.getState().askAtReset('t1', 'e1');
    useApp.getState().askAtReset('t1', 'e1');
    await vi.advanceTimersByTimeAsync(603_000);
    expect(api.ask).toHaveBeenCalledTimes(1);
  });

  test('a reset already past or unknown: no timer', async () => {
    await open(thread({ items: [{ kind: 'question', id: 'q1', at: 1, text: 'x' }, { kind: 'error', id: 'e1', at: 2, questionId: 'q1', reason: 'limit', message: 'm' }] }));
    useApp.getState().askAtReset('t1', 'e1');
    expect(useApp.getState().askAt.s1).toBeUndefined();
  });

  test('a terminal closed while it waits: the timer goes with it', async () => {
    await open(limited('q1'));
    useApp.getState().askAtReset('t1', 'e1');
    useApp.getState().applyTerminals([]);
    expect(useApp.getState().askAt.s1).toBeUndefined();
    await vi.advanceTimersByTimeAsync(700_000);
    expect(api.ask).not.toHaveBeenCalled();
  });

  test('Ask with <account>: the thread\'s account picker on it, the failed question asked again now with it', async () => {
    await open(limited('q1'));
    useApp.getState().askAtReset('t1', 'e1');
    useApp.getState().askWith('t1', 'e1', 'work');
    expect(useApp.getState().askPick.s1).toEqual({ account: 'work' });
    expect(api.ask).toHaveBeenCalledWith({ binding: expect.objectContaining({ sessionId: 's1' }), text: 'What is left?', account: 'work' });
    expect(useApp.getState().askAt.s1).toBeUndefined();
    await open(limited(null));
    useApp.getState().askWith('t1', 'e1', 'work');
    expect(api.catchUp).toHaveBeenCalledWith({ binding: expect.objectContaining({ sessionId: 's1' }), final: false, account: 'work' });
  });
});

describe('Windows (the gate is lifted)', () => {
  test('Ask opens as on macOS: the toggle, Ctrl+Shift+I, the menus\' and palette\'s open, a pop-out\'s carry; a restart loads the threads', async () => {
    const toast = vi.fn();
    const open = () => useApp.getState().askOpen.t1;
    const close = () => { useApp.getState().closeAskPanel('t1'); expect(open()).toBeUndefined(); };
    try {
      initPlatform('win32');
      reset({ showToast: toast } as Partial<ReturnType<typeof useApp.getState>>);
      useApp.getState().toggleAsk('t1');
      expect(open()).toMatchObject({ sessionId: 's1', terminalId: 't1' });
      await flush();
      expect(api.thread).toHaveBeenCalledWith('s1');
      close();
      askSelected();
      expect(open()).toBeDefined();
      close();
      openAskFor('t1');
      expect(open()).toBeDefined();
      close();
      toggleAskFor('t1');
      expect(open()).toBeDefined();
      close();
      // A pop-out's carry: Ask opens once its terminal is listed.
      useApp.getState().openAskWhenListed('t1');
      expect(open()).toBeDefined();
      // An app restart: each listed session's thread is asked for (the row mark and the pill dot).
      useApp.getState().applyTerminals([term(session()), term(session({ sessionId: 'sw' }), 'tw')]);
      await flush();
      expect(api.thread).toHaveBeenCalledWith('sw');
      expect(toast).not.toHaveBeenCalled();
    } finally { resetPlatformForTests(); }
  });
});

describe('unseen answers after an app restart', () => {
  test('each listed Claude session\'s thread is asked for once (the row mark and the pill dot come back); cached ones and plain terminals are not', async () => {
    api.thread.mockImplementation(async (sid: string) => (sid === 's7' ? thread({ sessionId: 's7', unseen: true }) : null));
    reset({ askThreads: { s1: thread() } });
    const list = [term(session()), term(session({ sessionId: 's7' }), 't7'), term(session({ sessionId: 's8' }), 't8'), term(null, 't9')];
    useApp.getState().applyTerminals(list);
    await flush();
    expect(api.thread.mock.calls.map((c) => c[0]).sort()).toEqual(['s7', 's8']);
    expect(useApp.getState().askThreads.s7?.unseen).toBe(true);
    expect(useApp.getState().askThreads.s8).toBeUndefined();
    // The next lists ask nothing again.
    useApp.getState().applyTerminals([...list]);
    await flush();
    expect(api.thread).toHaveBeenCalledTimes(2);
  });

  test('a newer thread from an event while the load was on its way is kept', async () => {
    let answer: (t: Thread | null) => void = () => {};
    api.thread.mockImplementation(() => new Promise((r) => { answer = r; }));
    reset();
    useApp.getState().applyTerminals([term(session({ sessionId: 's6' }), 't6')]);
    useApp.getState().applyCompanionEvent({ sessionId: 's6', kind: 'thread', thread: thread({ sessionId: 's6', unseen: false, costUsd: 2 }) });
    answer(thread({ sessionId: 's6', unseen: true }));
    await flush();
    expect(useApp.getState().askThreads.s6).toMatchObject({ unseen: false, costUsd: 2 });
  });
});

describe('terminals list', () => {
  test("a closed terminal's Ask goes, threads of unknown sessions are pruned", async () => {
    useApp.getState().toggleAsk('t1');
    await flush();
    useApp.setState({ askThreads: { s1: thread(), zz: thread({ sessionId: 'zz' }) } });
    useApp.getState().applyTerminals([term(session())]);
    expect(Object.keys(useApp.getState().askThreads)).toEqual(['s1']);
    useApp.getState().applyTerminals([]);
    expect(useApp.getState().askOpen).toEqual({});
  });
});

describe('Catch me up any time', () => {
  const run = (questionId: string | null) => ({ runId: 'x', sessionId: 's1', queued: false, trace: [], traceAt: 0, text: '', questionId, startedAt: 0 });
  const asked = thread({ items: [{ kind: 'question', id: 'q1', at: NOW - 60_000, text: 'Why?' }, { kind: 'answer', id: 'a1', at: NOW - 30_000, questionId: 'q1', markdown: 'Because.', read: [], model: 'sonnet', costUsd: null }] });
  afterEach(() => vi.unstubAllGlobals());

  test('after questions, with no Catch me up in the thread, it still runs on demand', async () => {
    reset({ settings: { ...DEFAULT_SETTINGS } });
    api.thread.mockResolvedValue(asked);
    useApp.getState().toggleAsk('t1');
    await flush();
    expect(api.catchUp).not.toHaveBeenCalled();
    useApp.getState().askCatchUp('t1');
    expect(api.catchUp).toHaveBeenCalledWith({ binding: expect.objectContaining({ sessionId: 's1' }), final: false });
  });

  test('never while a run of the thread is on (one at a time): a question or a Catch me up', async () => {
    reset({ settings: { ...DEFAULT_SETTINGS } });
    useApp.getState().toggleAsk('t1');
    await flush();
    for (const q of ['q1', null]) {
      useApp.setState({ askRuns: { x: run(q) } });
      useApp.getState().askCatchUp('t1');
      expect(api.catchUp).not.toHaveBeenCalled();
    }
    useApp.setState({ askRuns: {} });
    useApp.getState().askCatchUp('t1');
    expect(api.catchUp).toHaveBeenCalledTimes(1);
  });

  test('the palette, Ask closed: it opens and catches up once the thread has loaded, once even with "when opened" on', async () => {
    for (const settings of [{ ...DEFAULT_SETTINGS }, { ...ON }]) {
      reset({ settings });
      api.catchUp.mockClear();
      let loaded!: (t: Thread | null) => void;
      api.thread.mockReturnValueOnce(new Promise((r) => { loaded = r; }));
      catchUpFor('t1');
      expect(useApp.getState().askOpen.t1).toBeDefined();
      expect(api.catchUp).not.toHaveBeenCalled();
      loaded(asked);
      await flush();
      expect(api.catchUp).toHaveBeenCalledTimes(1);
      expect(api.catchUp).toHaveBeenCalledWith({ binding: expect.objectContaining({ sessionId: 's1' }), final: false });
    }
  });

  test('the palette, Ask closed with a run of the thread still on: it only opens', async () => {
    reset({ settings: { ...DEFAULT_SETTINGS }, askRuns: { x: run('q1') } });
    api.thread.mockResolvedValue(asked);
    catchUpFor('t1');
    await flush();
    expect(useApp.getState().askOpen.t1).toBeDefined();
    expect(api.catchUp).not.toHaveBeenCalled();
  });

  test('the palette, Ask already open: a Catch me up now; its tab not in front is shown first', async () => {
    vi.stubGlobal('requestAnimationFrame', () => 0);
    reset({ settings: { ...DEFAULT_SETTINGS } });
    api.thread.mockResolvedValue(asked);
    useApp.getState().toggleAsk('t1');
    await flush();
    catchUpFor('t1');
    expect(api.catchUp).toHaveBeenCalledTimes(1);
    useApp.setState({ activeTab: 'file' });
    api.catchUp.mockClear();
    catchUpFor('t1');
    expect(useApp.getState().activeTab).toBe('term');
    expect(api.catchUp).toHaveBeenCalledTimes(1);
  });

  test('the palette on a session whose tab lives in another window: that window comes forward, nothing runs here', async () => {
    const focus = vi.fn(async () => {});
    (g.window as { atelier: Record<string, unknown> }).atelier.popout = { focus };
    reset({ poppedOut: ['t:t1'], tabOrder: [] });
    catchUpFor('t1');
    await flush();
    expect(focus).toHaveBeenCalledWith('t:t1');
    expect(useApp.getState().askOpen).toEqual({});
    expect(api.catchUp).not.toHaveBeenCalled();
  });
});
