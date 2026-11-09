import { describe, expect, test } from 'vitest';
import { clockSeconds, cronDrift, cronEvery as every, cronHint, cronUpcoming, loopBusy, loopDelay, loopShown, loopStarted, loopTitle } from './cron-view';

const cronEvery = (schedule: string, recurring = true) => every(schedule, recurring);

describe('cron hint', () => {
  test('a recurring task expires after 7 days; a one-shot only learns that closing the session cancels it', () => {
    expect(cronHint(true)).toBe('Recurring tasks expire after 7 days. Closing the session cancels them.');
    expect(cronHint(false)).toBe('Closing the session cancels it.');
  });
});

describe('self-paced loop view', () => {
  test('a delay in half minutes under an hour, else tenths of an hour', () => {
    expect(loopDelay(60)).toBe('1 min');
    expect(loopDelay(270)).toBe('4.5 min');
    expect(loopDelay(290)).toBe('5 min');
    expect(loopDelay(3600)).toBe('1 h');
    expect(loopDelay(5400)).toBe('1.5 h');
  });
  test('a wake-up time to the second', () => {
    expect(clockSeconds(new Date(2026, 9, 17, 9, 5, 7).getTime())).toBe('09:05:07');
  });
  test("the transcript's detail counts only for the cron it was read for (a new turn shows the cron's own time meanwhile)", () => {
    const at = (h: number, m: number, s = 0) => new Date(2026, 9, 17, h, m, s).getTime();
    const detail = { prompt: '/loop x', reason: 'r', scheduledFor: at(10, 28), delaySeconds: 240, startedAt: at(10, 20), checks: 2, complete: true, last: [{ at: at(10, 24, 10), delaySeconds: 240, reason: 'r' }] };
    const tagged = { terminalId: 't1', cronId: 'w1', result: { ok: true as const, detail } };
    expect(loopShown({ id: 'w1', next: at(10, 28) }, tagged, 't1')).toEqual({ detail, fresh: true, next: at(10, 28), period: at(10, 28) - at(10, 24, 10), why: null });
    // Turn 2 (w2 at 10:32) while w1's answer is still the last one: its time is not w2's; the ring's turn is the last
    // delay meanwhile (never a one-hour guess that shows a 4-minute wait as almost due).
    expect(loopShown({ id: 'w2', next: at(10, 32) }, tagged, 't1')).toEqual({ detail, fresh: false, next: at(10, 32), period: 240_000, why: null });
    // Fired: no next; the detail is still this cron's.
    expect(loopShown({ id: 'w1', next: null }, tagged, 't1')).toMatchObject({ fresh: true, next: null });
    // Another terminal (same label, same card): nothing from this one.
    expect(loopShown({ id: 'w1', next: at(10, 28) }, tagged, 't2')).toEqual({ detail: null, fresh: false, next: at(10, 28), period: null, why: null });
    // An answer that could not read: why, for this cron only; a missing one says nothing.
    expect(loopShown({ id: 'w1', next: at(10, 28) }, { terminalId: 't1', cronId: 'w1', result: { ok: false, reason: 'format' } }, 't1').why).toBe('Transcript format not recognized.');
    expect(loopShown({ id: 'w1', next: at(10, 28) }, { terminalId: 't1', cronId: 'w1', result: { ok: false, reason: 'missing' } }, 't1').why).toBeNull();
    expect(loopShown({ id: 'w1', next: at(10, 28) }, null, 't1')).toEqual({ detail: null, fresh: false, next: at(10, 28), period: null, why: null });
  });
  test('the run: started when whole, "since" and a plus when it began before what was read', () => {
    expect(loopStarted('10:24', 2, true)).toBe('Started 10:24 · 2 checks');
    expect(loopStarted('10:24', 1, true)).toBe('Started 10:24 · 1 check');
    expect(loopStarted('13:40', 9, false)).toBe('Since 13:40 · 9+ checks');
  });
  test('Claude is on a fired wake-up while it works or waits on the user; the idle notice is not a wait', () => {
    const s = (state: string, waitingFor: string | null = null) => ({ state, waitingFor }) as never;
    expect(loopBusy(s('running'))).toBe(true);
    expect(loopBusy(s('waiting', 'permission'))).toBe(true);
    expect(loopBusy(s('waiting', 'question'))).toBe(true);
    expect(loopBusy(s('waiting', 'input'))).toBe(false);
    expect(loopBusy(s('done'))).toBe(false);
    expect(loopBusy(null)).toBe(false);
  });
  test('title: the task, or "Autonomous loop"', () => {
    expect(loopTitle({ task: 'check the deploy', autonomous: false })).toBe('check the deploy');
    expect(loopTitle({ task: '', autonomous: true })).toBe('Autonomous loop');
  });
});

describe('cron view', () => {
  test('common schedules in words; others null', () => {
    expect(cronEvery('* * * * *')).toBe('Every minute');
    expect(cronEvery('*/10 * * * *')).toBe('Every 10 minutes');
    expect(cronEvery('5 * * * *')).toBe('Every hour at :05');
    expect(cronEvery('0 */2 * * *')).toBe('Every 2 hours');
    expect(cronEvery('30 9 * * *')).toBe('Every day at 09:30');
    expect(cronEvery('30 9 * * 1-5')).toBe('Weekdays at 09:30');
    expect(cronEvery('10 12 11 10 *', false)).toBe('Once on 11 Oct at 12:10');
    expect(cronEvery('1,2 3 * 4 5')).toBeNull();
  });
  test('edge forms: singular hour, minute offset, one-shot vs yearly', () => {
    expect(cronEvery('0 */1 * * *')).toBe('Every hour');
    expect(cronEvery('30 */2 * * *')).toBe('Every 2 hours at :30');
    expect(cronEvery('10 12 11 10 *', false)).toBe('Once on 11 Oct at 12:10');
    expect(cronEvery('0 9 1 1 *', true)).toBe('Every year on 1 Jan at 09:00');
  });
  test('a one-shot never reads as repeating: a self-paced /loop wake-up has no date (captured from Claude Code 2.1.302)', () => {
    expect(cronEvery('28 10 * * *', false)).toBe('Once at 10:28');
    expect(cronEvery('30 9 * * 1-5', false)).toBe('Once at 09:30');
    for (const s of ['* * * * *', '*/10 * * * *', '5 * * * *', '0 */2 * * *']) expect(cronEvery(s, false), s).toBeNull();
  });
  test('out-of-range, uneven steps and never-firing schedules give null', () => {
    for (const s of ['*/0 * * * *', '99 * * * *', '5 25 * * *', '*/7 * * * *', '*/99 * * * *', '0 */5 * * *', '0 0 32 10 *', '0 0 0 10 *', '0 0 31 2 *', '30 9 * * 7', '* */2 * * *', '* * * * * *', '']) expect(cronEvery(s), s).toBeNull();
  });
  test('drift on an invalid schedule is null', () => {
    const from = new Date(2026, 9, 12, 23, 34);
    expect(cronDrift('99 * * * *', true, from)).toBeNull();
    expect(cronDrift('nonsense', false, from)).toBeNull();
  });
  test('upcoming fires', () => {
    const from = new Date(2026, 9, 12, 23, 34);
    expect(cronUpcoming('*/10 * * * *', from, 3).map((t) => new Date(t).getMinutes())).toEqual([40, 50, 0]);
  });
  test('drift: recurring half the period up to 30 min; one-shot on :00/:30 up to 90 s early', () => {
    const from = new Date(2026, 9, 12, 23, 34);
    expect(cronDrift('*/10 * * * *', true, from)).toEqual({ late: 5 * 60_000 });
    expect(cronDrift('0 */4 * * *', true, from)).toEqual({ late: 30 * 60_000 });
    expect(cronDrift('30 9 13 10 *', false, from)).toEqual({ early: 90_000 });
    expect(cronDrift('17 9 13 10 *', false, from)).toBeNull();
  });
});
