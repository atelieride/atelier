import { expect, test } from 'vitest';
import { AskBroker } from './ask';
import type { AskMessage, CloseSessionsAsk } from '@shared/asks';

const CS: CloseSessionsAsk = { kind: 'close-sessions', what: 'quit', windows: 0, projects: [] };

const setup = () => {
  const sent: { wcId: number; m: AskMessage }[] = [];
  const broker = new AskBroker((wcId, m) => { sent.push({ wcId, m }); return true; });
  return { broker, sent };
};

test('a page that never said it listens is not asked: null, and main falls back to its native dialog', async () => {
  const { broker, sent } = setup();
  expect(await broker.ask(1, CS)).toBeNull();
  expect(sent).toEqual([]);
});

test('asked once ready; only that page, with a valid answer for that question, answers it', async () => {
  const { broker, sent } = setup();
  broker.ready(1);
  broker.ready(2);
  const asked = broker.ask(1, { kind: 'restart-daemon', sessions: [], sessionCount: 2, working: 1, terminals: 1, projects: 1 });
  expect(sent).toHaveLength(1);
  const { id } = sent[0]!.m;
  expect(sent[0]!.wcId).toBe(1);
  expect(broker.answer(2, id, 'restart')).toBe(false);
  expect(broker.answer(1, id, 'quit')).toBe(false);
  expect(broker.answer(1, 'nope', 'restart')).toBe(false);
  expect(broker.answer(1, id, 'restart')).toBe(true);
  expect(await asked).toBe('restart');
  // Answered once.
  expect(broker.answer(1, id, 'cancel')).toBe(false);
});

test('a page gone while asked (closed, crashed, reloading) answers the safe choice; it is asked again only once ready again', async () => {
  const { broker, sent } = setup();
  broker.ready(1);
  const git = broker.ask(1, { kind: 'quit-git', title: 'A push is running', detail: '', ops: [] });
  const unsaved = broker.ask(1, { kind: 'unsaved-close', what: 'close' });
  broker.gone(1);
  expect(await git).toBe('wait');
  expect(await unsaved).toBe('cancel');
  expect(await broker.ask(1, CS)).toBeNull();
  expect(sent).toHaveLength(2);
  broker.ready(1);
  expect(broker.isReady(1)).toBe(true);
});

test('Restart atelierd asks with what closes: four avatars at most, sessions and how many work, terminals, projects', async () => {
  const { restartAsk } = await import('./ask');
  const base = { cwd: '/p', name: null, createdAt: 0, foreground: 'zsh' };
  const s = (id: string, root: string, state: 'running' | 'idle' | 'waiting') => ({ ...base, id, projectRoot: root, title: id, color: `#${id}`, session: { sessionId: id, state, title: null, activity: null, contextPct: null, unread: false, updatedAt: 0 } });
  const list = [s('a', '/p', 'running'), s('b', '/p', 'idle'), { ...base, id: 't', projectRoot: '/q', title: 'Terminal 1', color: '#fff', session: null }, s('c', '/q', 'running'), s('d', '/q', 'waiting'), s('e', '/p', 'idle')];
  expect(restartAsk(list)).toEqual({
    kind: 'restart-daemon',
    sessions: [{ title: 'a', color: '#a' }, { title: 'b', color: '#b' }, { title: 'c', color: '#c' }, { title: 'd', color: '#d' }],
    sessionCount: 5, working: 2, terminals: 1, projects: 2
  });
});

test('a send that fails (the page went meanwhile) is not an ask: null', async () => {
  const broker = new AskBroker(() => false);
  broker.ready(1);
  expect(await broker.ask(1, CS)).toBeNull();
});

// A page that hangs (a hung renderer can't answer): main's own questions fall back to the native
// dialog (null) when the page doesn't say it got the question in time, or stops responding meanwhile.
const timed = () => {
  const sent: { wcId: number; m: AskMessage }[] = [];
  const timers: { fn: () => void; ms: number; cleared: boolean }[] = [];
  const withdrawn: { wcId: number; id: string }[] = [];
  const broker = new AskBroker((wcId, m) => { sent.push({ wcId, m }); return true; }, (fn, ms) => {
    const t = { fn, ms, cleared: false };
    timers.push(t);
    return { clear: () => { t.cleared = true; } };
  }, (wcId, id) => { withdrawn.push({ wcId, id }); });
  return { broker, sent, timers, withdrawn, fire: () => timers.filter((t) => !t.cleared).forEach((t) => t.fn()) };
};

test('a question the page never says it got within the time given: null (the native dialog), its late answer ignored', async () => {
  const { broker, sent, timers, fire } = timed();
  broker.ready(1);
  const asked = broker.ask(1, { kind: 'quit-git', title: 'A push is running', detail: '', ops: [] }, { shownMs: 2000 });
  expect(timers.map((t) => t.ms)).toEqual([2000]);
  fire();
  expect(await asked).toBeNull();
  expect(broker.answer(1, sent[0]!.m.id, 'quit')).toBe(false);
});

test('a question the page got in time waits for its answer, however long', async () => {
  const { broker, sent, fire } = timed();
  broker.ready(1);
  const asked = broker.ask(1, CS, { shownMs: 2000 });
  expect(broker.shown(2, sent[0]!.m.id)).toBe(false);
  expect(broker.shown(1, sent[0]!.m.id)).toBe(true);
  fire();
  expect(broker.answer(1, sent[0]!.m.id, 'stop')).toBe(true);
  expect(await asked).toBe('stop');
});

test('a page that stops responding: its questions that can fall back do (null); the others keep waiting', async () => {
  const { broker, sent } = timed();
  broker.ready(1);
  broker.ready(2);
  const git = broker.ask(1, { kind: 'quit-git', title: 'A push is running', detail: '', ops: [] }, { shownMs: 2000 });
  broker.shown(1, sent[0]!.m.id);
  const unsaved = broker.ask(1, { kind: 'unsaved-close', what: 'close' });
  const other = broker.ask(2, CS, { shownMs: 2000 });
  broker.unresponsive(1);
  expect(await git).toBeNull();
  expect(broker.answer(1, sent[1]!.m.id, 'go')).toBe(true);
  expect(await unsaved).toBe('go');
  expect(broker.answer(2, sent[2]!.m.id, 'keep')).toBe(true);
  expect(await other).toBe('keep');
});

test('a question main gave up on (the native dialog asks instead) is withdrawn from its page; an answered one is not', async () => {
  const { broker, sent, withdrawn, fire } = timed();
  broker.ready(1);
  const late = broker.ask(1, CS, { shownMs: 2000 });
  fire();
  expect(await late).toBeNull();
  expect(withdrawn).toEqual([{ wcId: 1, id: sent[0]!.m.id }]);
  const hung = broker.ask(1, { kind: 'quit-git', title: 'A push is running', detail: '', ops: [] }, { shownMs: 2000 });
  broker.shown(1, sent[1]!.m.id);
  broker.unresponsive(1);
  expect(await hung).toBeNull();
  expect(withdrawn.map((w) => w.id)).toEqual([sent[0]!.m.id, sent[1]!.m.id]);
  const answered = broker.ask(1, CS, { shownMs: 2000 });
  broker.shown(1, sent[2]!.m.id);
  broker.answer(1, sent[2]!.m.id, 'stop');
  expect(await answered).toBe('stop');
  broker.gone(1);
  expect(withdrawn).toHaveLength(2);
});

test('closing with busy sessions: a window gone while asked keeps everything (cancel); keep and stop are its answers', async () => {
  const { broker, sent } = setup();
  broker.ready(1);
  const asked = broker.ask(1, { ...CS, what: 'close' });
  expect(broker.answer(1, sent[0]!.m.id, 'quit')).toBe(false);
  broker.gone(1);
  expect(await asked).toBe('cancel');
});
