import { describe, expect, test } from 'vitest';
import { applySync, settleSync, syncIntentOf, type SyncIntent } from './sync-intents';

// After a pull, push or sync the Sync button shows what the op left at once, never the counts of a status read before
// it (a Windows PC took seconds to read the next one).

const st = (o: Partial<{ ahead: number; behind: number; checkedAt: number; upstream: string | null; branch: string | null }> = {}) =>
  ({ branch: 'dev', ahead: 1, behind: 2, upstream: 'origin/dev', upstreamGone: false, checkedAt: 5, ...o });

describe('syncIntentOf', () => {
  test("what main says the op left, from when git was done", () => {
    expect(syncIntentOf('/p/a', { outcome: 'ok', at: 10, left: { behind: 0 } })).toEqual({ root: '/p/a', at: 10, behind: 0 });
    expect(syncIntentOf('/p/a', { outcome: 'ok', at: 10, left: { ahead: 0, behind: 0, published: 'origin' } })).toEqual({ root: '/p/a', at: 10, ahead: 0, behind: 0, published: 'origin' });
  });

  test('nothing for a failure, without its time, or when main knows nothing it left (a push to a fork)', () => {
    expect(syncIntentOf('/p/a', { outcome: 'network', at: 10, left: { behind: 0 } })).toBeNull();
    expect(syncIntentOf('/p/a', { outcome: 'ok', left: { behind: 0 } })).toBeNull();
    expect(syncIntentOf('/p/a', { outcome: 'ok', at: 10 })).toBeNull();
    expect(syncIntentOf('/p/a', { outcome: 'ok', at: 10, left: {} })).toBeNull();
    expect(syncIntentOf('/p/a', undefined)).toBeNull();
  });
});

describe('applySync', () => {
  const pulled: SyncIntent = { root: '/p/a', at: 10, behind: 0 };

  test('a status read before the op shows what the op left; one read since is left as git has it', () => {
    expect(applySync('/p/a', st({ checkedAt: 5 }), [pulled])).toMatchObject({ ahead: 1, behind: 0 });
    const fresh = st({ checkedAt: 10, behind: 3 });
    expect(applySync('/p/a', fresh, [pulled])).toBe(fresh);
  });

  test('a status without its read time counts as read before', () => {
    const { checkedAt: _c, ...old } = st();
    expect(applySync('/p/a', old, [pulled])).toMatchObject({ behind: 0 });
  });

  test('other repositories, and statuses the op already shows, are the same objects', () => {
    const other = st();
    expect(applySync('/p/b', other, [pulled])).toBe(other);
    const shown = st({ behind: 0 });
    expect(applySync('/p/a', shown, [pulled])).toBe(shown);
  });

  test('a branch just published tracks its remote branch, nothing to pull or push', () => {
    const published: SyncIntent = { root: '/p/a', at: 10, ahead: 0, behind: 0, published: 'origin' };
    expect(applySync('/p/a', st({ upstream: null, ahead: 0, behind: 0, branch: 'feat/x' }), [published])).toMatchObject({ upstream: 'origin/feat/x', upstreamGone: false, ahead: 0, behind: 0 });
  });
});

describe('settleSync', () => {
  test('an intent goes once a status of its repository read since the op comes in, and only then', () => {
    const a: SyncIntent = { root: '/p/a', at: 10, behind: 0 };
    const b: SyncIntent = { root: '/p/b', at: 10, ahead: 0 };
    const list = [a, b];
    expect(settleSync(list, [{ root: '/p/a', checkedAt: 9 }, { root: '/p/b', checkedAt: 4 }])).toBe(list);
    expect(settleSync(list, [{ root: '/p/a', checkedAt: 10 }, { root: '/p/b', checkedAt: 4 }])).toEqual([b]);
    // The list holds every working tree of the project: one it no longer holds is gone, and so is its intent.
    expect(settleSync(list, [{ root: '/p/b', checkedAt: 4 }])).toEqual([b]);
  });
});
