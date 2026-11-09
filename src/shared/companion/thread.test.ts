import { describe, expect, it } from 'vitest';
import { RETENTION_MS, THREAD_CAP, appendItems, expired, newThread, parseThread, quitError, settleOrphans, shouldCatchUp } from './thread';
import type { ThreadItem } from './types';

const UUID = '123e4567-e89b-42d3-a456-426614174000';
const q = (id: string, at = 1): ThreadItem => ({ kind: 'question', id, at, text: 'why?' });
const MIN = 60_000;

describe('thread items', () => {
  it('starts empty', () => {
    const t = newThread('s1', UUID, 5);
    expect(t).toMatchObject({ v: 1, sessionId: 's1', claudeUuid: UUID, started: false, convDir: null, items: [], lastUsedAt: 5, costUsd: 0, lastCatchUpAt: null });
  });
  it('keeps the last 200 items and updates lastUsedAt', () => {
    const items = Array.from({ length: 205 }, (_, i) => q(`q${i}`));
    const t = appendItems(newThread('s1', UUID, 0), items, 99);
    expect(t.items).toHaveLength(THREAD_CAP);
    expect(t.items[0]!.id).toBe('q5');
    expect(t.items.at(-1)!.id).toBe('q204');
    expect(t.lastUsedAt).toBe(99);
  });
});

describe('parseThread', () => {
  const full = () => {
    let t = newThread('s1', UUID, 10);
    t = appendItems(t, [
      q('a'),
      { kind: 'answer', id: 'b', at: 2, questionId: 'a', markdown: 'hi', read: ['x.ts'], model: 'haiku', costUsd: 0.01 },
      { kind: 'catchup', id: 'c', at: 3, data: { points: [], where: 'w', choices: [], leftOpen: null }, read: [], model: 'sonnet', final: false },
      { kind: 'error', id: 'd', at: 4, questionId: null, reason: 'limit', message: 'm', resetsAt: 9, window: 'weekly', account: 'work' },
    ], 10);
    return { ...t, started: true, convDir: '/accounts/work', model: 'haiku' as const, account: null, lastCatchUpAt: 3, unseen: true, costUsd: 0.01 };
  };
  it('round-trips a valid thread', () => {
    const t = full();
    expect(parseThread(JSON.parse(JSON.stringify(t)), 's1')).toEqual(t);
    expect(parseThread(JSON.parse(JSON.stringify({ ...t, convDir: null })), 's1')).toEqual({ ...t, convDir: null });
  });
  it("a thread saved before convDir existed: where its conversation lives is unknown, so the next run starts a fresh one", () => {
    const { convDir: _, ...old } = JSON.parse(JSON.stringify(full()));
    expect(parseThread(old, 's1')).toEqual({ ...full(), started: false, convDir: null });
  });
  it('rejects a convDir that is neither a string nor null', () => {
    for (const convDir of [1, {}, ['x']]) expect(parseThread({ ...JSON.parse(JSON.stringify(full())), convDir }, 's1')).toBeNull();
  });
  it('rejects wrong session, version, uuid, unknown kind, bad fields, non-objects', () => {
    const t = JSON.parse(JSON.stringify(full()));
    expect(parseThread(t, 'other')).toBeNull();
    expect(parseThread({ ...t, v: 2 }, 's1')).toBeNull();
    expect(parseThread({ ...t, claudeUuid: '--model' }, 's1')).toBeNull();
    expect(parseThread({ ...t, items: [...t.items, { kind: 'weird', id: 'z', at: 1 }] }, 's1')).toBeNull();
    expect(parseThread({ ...t, items: [{ ...t.items[0], at: 'x' }] }, 's1')).toBeNull();
    expect(parseThread({ ...t, items: [{ ...t.items[0], id: 'x'.repeat(65) }] }, 's1')).toBeNull();
    expect(parseThread({ ...t, items: [{ ...t.items[2], data: { nope: 1 } }] }, 's1')).toBeNull();
    expect(parseThread({ ...t, model: 'gpt' }, 's1')).toBeNull();
    expect(parseThread({ ...t, costUsd: 'x' }, 's1')).toBeNull();
    expect(parseThread({ ...t, items: [{ ...t.items[3], window: 'daily' }] }, 's1')).toBeNull();
    for (const account of ['', 'Work', '--x', 7, 'x'.repeat(40)]) expect(parseThread({ ...t, items: [{ ...t.items[3], account }] }, 's1'), String(account)).toBeNull();
    // 'session' (the session's own account) is one; an item saved before it existed loads without.
    expect(parseThread({ ...t, items: [{ ...t.items[3], account: 'session' }] }, 's1')?.items[0]).toMatchObject({ account: 'session' });
    const { account: _a, ...old } = t.items[3];
    expect(parseThread({ ...t, items: [old] }, 's1')?.items[0]).not.toHaveProperty('account');
    for (const v of [null, 1, 'x', []]) expect(parseThread(v, 's1')).toBeNull();
  });
  it("the thread's account is checked like an item's: 'session', an account id or null", () => {
    const t = JSON.parse(JSON.stringify(full()));
    for (const account of ['', 'Work', '--x', 7, 'x'.repeat(40)]) expect(parseThread({ ...t, account }, 's1'), String(account)).toBeNull();
    for (const account of ['session', 'work', 'default', null]) expect(parseThread({ ...t, account }, 's1')?.account, String(account)).toBe(account);
  });
});

describe('settleOrphans', () => {
  const base = () => appendItems(newThread('s1', UUID, 0), [q('a')], 1);
  it('turns an unanswered question with no active run into a quit error, once', () => {
    const once = settleOrphans(base(), new Set(), 50);
    expect(once.items).toHaveLength(2);
    expect(once.items[1]).toMatchObject({ kind: 'error', reason: 'quit', message: 'Stopped when Atelier quit', questionId: 'a' });
    expect(settleOrphans(once, new Set(), 60).items).toHaveLength(2);
  });
  it('leaves a question whose run is active', () => {
    const t = base();
    expect(settleOrphans(t, new Set(['a']), 50)).toEqual(t);
  });
  it('leaves answered questions', () => {
    const t = appendItems(base(), [{ kind: 'answer', id: 'b', at: 2, questionId: 'a', markdown: '', read: [], model: 'haiku', costUsd: null }], 2);
    expect(settleOrphans(t, new Set(), 50)).toEqual(t);
  });
  it('builds its item with quitError, the one source of the quit item', () => {
    expect(quitError('a', 50)).toEqual({ kind: 'error', id: 'quit-a', at: 50, questionId: 'a', reason: 'quit', message: 'Stopped when Atelier quit' });
    expect(settleOrphans(base(), new Set(), 50).items[1]).toEqual(quitError('a', 50));
  });
});

describe('expired', () => {
  const t = newThread('s1', UUID, 0);
  it('never while live', () => expect(expired(t, true, 1000 * RETENTION_MS)).toBe(false));
  it('after 30 days when not live', () => {
    expect(expired(t, false, 31 * 86_400_000)).toBe(true);
    expect(expired(t, false, 29 * 86_400_000)).toBe(false);
  });
});

describe('shouldCatchUp', () => {
  const now = 100 * MIN;
  const t = (last: number | null) => ({ ...newThread('s1', UUID, 0), lastCatchUpAt: last });
  it('first time on open', () => expect(shouldCatchUp(null, { onOpen: true, lastActivityAt: null, now })).toBe(true));
  it('thread without a catch-up on open', () => expect(shouldCatchUp(t(null), { onOpen: true, lastActivityAt: null, now })).toBe(true));
  it('not when not on open', () => expect(shouldCatchUp(null, { onOpen: false, lastActivityAt: null, now })).toBe(false));
  it('not when the last one is recent', () => expect(shouldCatchUp(t(now - 5 * MIN), { onOpen: true, lastActivityAt: now, now })).toBe(false));
  it('when old and the session moved since', () => expect(shouldCatchUp(t(now - 11 * MIN), { onOpen: true, lastActivityAt: now - MIN, now })).toBe(true));
  it('not when old but nothing happened since', () => {
    expect(shouldCatchUp(t(now - 11 * MIN), { onOpen: true, lastActivityAt: now - 20 * MIN, now })).toBe(false);
    expect(shouldCatchUp(t(now - 11 * MIN), { onOpen: true, lastActivityAt: null, now })).toBe(false);
  });
});
