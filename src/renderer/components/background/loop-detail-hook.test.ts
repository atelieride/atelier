import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { LoopResult } from '@shared/background-feed';
import type { LoopTagged } from '../../cron-view';
import { followLoopDetail } from './loop-detail-hook';

const good: LoopResult = { ok: true, detail: { prompt: '/loop x', reason: 'r', scheduledFor: 1, delaySeconds: 60, startedAt: 0, checks: 1, complete: true, last: [] } };
const missing: LoopResult = { ok: false, reason: 'missing' };

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

/** Runs one follow with answers in order; returns what the card would hold after each set. */
function follow(answers: LoopResult[], prev: LoopTagged | null = null) {
  const ask = vi.fn(async () => answers.shift() ?? missing);
  let held = prev;
  const stop = followLoopDetail(ask, 't1', 'w2', (update) => { held = update(held); });
  return { ask, stop, held: () => held };
}

describe('followLoopDetail', () => {
  test('a good answer is held, tagged with what it was asked for', async () => {
    const f = follow([good]);
    await vi.runAllTimersAsync();
    expect(f.held()).toEqual({ terminalId: 't1', cronId: 'w2', result: good });
    expect(f.ask).toHaveBeenCalledTimes(1);
  });
  test('"missing" is asked again, 3 times 1.5 s apart, until it lands', async () => {
    const f = follow([missing, missing, good]);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.ask).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1500);
    expect(f.ask).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1500);
    expect(f.held()?.result).toEqual(good);
    expect(f.ask).toHaveBeenCalledTimes(3);
  });
  test('a final "missing" keeps the last good answer (another cron\'s: loopShown decides what still counts)', async () => {
    const prev: LoopTagged = { terminalId: 't1', cronId: 'w1', result: good };
    const f = follow([missing, missing, missing, missing], prev);
    await vi.runAllTimersAsync();
    expect(f.ask).toHaveBeenCalledTimes(4);
    expect(f.held()).toBe(prev);
    // Without one, the "missing" itself is held.
    const g = follow([missing, missing, missing, missing]);
    await vi.runAllTimersAsync();
    expect(g.held()).toEqual({ terminalId: 't1', cronId: 'w2', result: missing });
  });
  test('stopped (a new turn, the card closed): no late answer, no more retries', async () => {
    const f = follow([missing, good]);
    await vi.advanceTimersByTimeAsync(0);
    f.stop();
    await vi.runAllTimersAsync();
    expect(f.ask).toHaveBeenCalledTimes(1);
    expect(f.held()).toBeNull();
    const g = follow([good]);
    g.stop();
    await vi.runAllTimersAsync();
    expect(g.held()).toBeNull();
  });
  test('a failed call says unreadable unless something is already held', async () => {
    const ask = vi.fn(async () => { throw new Error('gone'); });
    let held: LoopTagged | null = null;
    followLoopDetail(ask, 't1', 'w2', (u) => { held = u(held); });
    await vi.runAllTimersAsync();
    expect(held).toEqual({ terminalId: 't1', cronId: 'w2', result: { ok: false, reason: 'unreadable' } });
  });
});
