import { describe, expect, test } from 'vitest';
import { compileWorld } from '../compile/index';
import { rebase, TIME_MS_KEYS, TIME_S_KEYS } from './time';

// The world is compiled around the build's clock; the demo moves it to the visitor's once, so a
// session that finished "just now" at build time still did when the page opens days later.

describe('rebase', () => {
  test('moves ms times by the delta and second times by delta / 1000, nothing else', () => {
    const v = { updatedAt: 1000, title: 'x', n: 5, usage: { fiveHour: { pct: 34, resetsAt: 100 } }, list: [{ at: 2000, seq: 3 }], lastMessageAt: null };
    expect(rebase(v, 60_000)).toEqual({ updatedAt: 61_000, title: 'x', n: 5, usage: { fiveHour: { pct: 34, resetsAt: 160 } }, list: [{ at: 62_000, seq: 3 }], lastMessageAt: null });
  });

  test('a copy: the compiled world is never changed in place', () => {
    const v = { at: 1 };
    rebase(v, 10);
    expect(v.at).toBe(1);
  });

  // Guard: a time field the list does not know would stay at the build's clock (a session "3 days ago"). Every number
  // that looks like a time around t0 must sit under a known key.
  test("every time in the compiled world is under a key rebase knows (mutation: drop 'since' and this fails)", () => {
    const world = compileWorld();
    const unknown: string[] = [];
    const DAYS = 30 * 86_400_000;
    const walk = (v: unknown, path: string, key: string) => {
      if (typeof v === 'number') {
        if (Math.abs(v - world.t0) < DAYS && !TIME_MS_KEYS.has(key)) unknown.push(`${path} (ms)`);
        if (Math.abs(v - world.t0 / 1000) < DAYS / 1000 && !TIME_S_KEYS.has(key)) unknown.push(`${path} (s)`);
      } else if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${path}[${i}]`, key));
      else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, `${path}.${k}`, k);
    };
    walk({ ...world, t0: 0 }, 'world', '');
    expect(unknown).toEqual([]);
  });

  test('the guard sees real times (it would not pass on an empty walk)', () => {
    const json = JSON.stringify(compileWorld());
    for (const k of ['updatedAt', 'since', 'resetsAt', 'startedAt']) expect(json).toContain(`"${k}":`);
  });
});
