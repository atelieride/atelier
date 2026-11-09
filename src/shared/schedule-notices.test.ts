import { describe, expect, test } from 'vitest';
import { newlyArmed, scheduleNotices } from './schedule-notices';
import type { ScheduledPrompt } from './scheduled-prompts';

const T0 = Date.UTC(2026, 9, 25, 12, 0);
const p = (o: Partial<ScheduledPrompt> = {}): ScheduledPrompt => ({
  id: 'p1', terminalId: 't1', sessionId: 's1', projectRoot: '/w', title: 'api', text: 'x', at: T0, ifBusy: 'wait',
  createdAt: 0, status: 'pending', ...o
});

describe('scheduleNotices', () => {
  test('a prompt that turns sent, skipped or missed is news once', () => {
    expect(scheduleNotices([p()], [p({ status: 'sent' })])).toEqual([{ kind: 'sent', prompt: p({ status: 'sent' }) }]);
    expect(scheduleNotices([p({ status: 'armed' })], [p({ status: 'skipped', reason: 'busy' })])[0]!.kind).toBe('skipped');
    expect(scheduleNotices([p()], [p({ status: 'missed', reason: 'asleep' })])[0]!.kind).toBe('missed');
    expect(scheduleNotices([p({ status: 'sent' })], [p({ status: 'sent' })])).toEqual([]);
  });
  test('a limit move is news (from the limit or after Claude refused it)', () => {
    const moved = p({ at: T0 + 60_000, movedFrom: T0, reason: 'limit' });
    expect(scheduleNotices([p()], [moved])).toEqual([{ kind: 'moved', prompt: moved }]);
    const again = p({ at: T0 + 120_000, movedFrom: T0, reason: 'limit-hit', limitRetried: true });
    expect(scheduleNotices([p({ status: 'sent' })], [again])[0]!.kind).toBe('moved');
    // A time you changed yourself is no news.
    expect(scheduleNotices([p()], [p({ at: T0 + 60_000 })])).toEqual([]);
  });
  test('a new or removed prompt is no news', () => {
    expect(scheduleNotices([], [p({ status: 'sent' })])).toEqual([]);
    expect(scheduleNotices([p()], [])).toEqual([]);
  });
});

describe('newlyArmed', () => {
  test('prompts that just turned armed', () => {
    expect(newlyArmed([p()], [p({ status: 'armed' })]).map((x) => x.id)).toEqual(['p1']);
    expect(newlyArmed([p({ status: 'armed' })], [p({ status: 'armed' })])).toEqual([]);
    expect(newlyArmed([], [p({ status: 'armed' })]).map((x) => x.id)).toEqual(['p1']);
  });
});
