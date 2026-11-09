import { describe, expect, test } from 'vitest';
import { LOOP_MAX_AHEAD_MS, cronRowId, loopFired, loopRowId, selfPacedLoop } from './loop';

describe('self-paced loops', () => {
  test('a one-shot whose label is the /loop input, or the autonomous sentinel', () => {
    expect(selfPacedLoop('/loop check the deploy', false)).toEqual({ task: 'check the deploy', autonomous: false });
    expect(selfPacedLoop('/loop   check the deploy  ', false)).toEqual({ task: 'check the deploy', autonomous: false });
    expect(selfPacedLoop('<<autonomous-loop-dynamic>>', false)).toEqual({ task: '', autonomous: true });
  });
  test('anything else is an ordinary cron', () => {
    for (const [label, recurring] of [['/loop x', true], ['/loopx', false], ['check', false], ['/Loop x', false], ['/loop ', false], ['<<autonomous-loop>>', false]] as const) {
      expect(selfPacedLoop(label, recurring), label).toBeNull();
    }
  });
  test("a loop's row id comes from its label (the same every turn), an ordinary cron's from its id", () => {
    const a = loopRowId('/loop check the deploy');
    expect(a).toMatch(/^cron:loop-[0-9a-f]{8}$/);
    expect(loopRowId('/loop check the deploy')).toBe(a);
    expect(loopRowId('/loop check the tests')).not.toBe(a);
    expect(cronRowId({ id: 'c1', label: '/loop check the deploy', recurring: false })).toBe(a);
    expect(cronRowId({ id: 'c1', label: 'check the deploy', recurring: false })).toBe('cron:c1');
    expect(cronRowId({ id: 'c1', label: '/loop check the deploy', recurring: true })).toBe('cron:c1');
  });
  test('a wake-up is never more than an hour ahead: past that (or without a time) it has fired', () => {
    const now = new Date(2026, 9, 17, 10, 29).getTime();
    const loop = { label: '/loop check', recurring: false };
    expect(loopFired({ ...loop, next: now + 4 * 60_000 }, now)).toBe(false);
    expect(loopFired({ ...loop, next: now + LOOP_MAX_AHEAD_MS }, now)).toBe(false);
    expect(loopFired({ ...loop, next: now + LOOP_MAX_AHEAD_MS + 60_000 }, now)).toBe(true);
    expect(loopFired({ ...loop, next: null }, now)).toBe(true);
    expect(loopFired({ label: 'check', recurring: false, next: null }, now)).toBe(false);
    expect(loopFired({ label: 'check', recurring: false, next: now + 86_000_000 }, now)).toBe(false);
  });
});
