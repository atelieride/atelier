import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import { LOOP_LAST, loopDetail, loopRun, matchWakeup, oldestStamp, parseWakeups, type Wakeup } from './loop-transcript';

const capture = readFileSync(resolve(__dirname, '../../tests/fixtures/transcripts/loop-wakeup.jsonl'), 'utf8');
const PROMPT = '/loop check whether a file named done.txt exists in this folder; stop when it does';
/** The 5-field schedule Claude Code reports for a wake-up at `ms` (local time, no date). */
const scheduleAt = (ms: number) => { const d = new Date(ms); return `${d.getMinutes()} ${d.getHours()} * * *`; };
const wake = (n: number, over: Partial<Wakeup> = {}): Wakeup => ({ toolUseId: `t${n}`, at: n * 1000, delaySeconds: 270, reason: `r${n}`, prompt: PROMPT, scheduledFor: n * 1000 + 270_000, ...over });

describe('loop transcript', () => {
  test('the capture: two wake-ups with their reason and exact time, then the stop; other lines skipped', () => {
    const r = parseWakeups(capture);
    expect(r.unrecognized).toBe(false);
    expect(r.wakeups).toEqual([
      { toolUseId: 'toolu_01VZ4Zyfmg3o7WxXZLtCXh2V', at: Date.parse('2026-10-17T08:24:14.444Z'), delaySeconds: 270, reason: "File appearance can't be pushed to me; poll periodically for done.txt.", prompt: PROMPT, scheduledFor: 1792225680000 },
      { toolUseId: 'toolu_01FQcQkihgj3btaHgw6evqwP', at: Date.parse('2026-10-17T08:28:04.635Z'), delaySeconds: 270, reason: "File appearance can't be pushed to me; keep polling for done.txt.", prompt: PROMPT, scheduledFor: 1792225920000 },
      { toolUseId: 'toolu_01UYu3AWbW2y21GqMYf1Mubb', at: Date.parse('2026-10-17T08:32:03.373Z'), delaySeconds: null, reason: null, prompt: null, scheduledFor: null, stop: true }
    ]);
  });
  test('a tail read: the cut first line is skipped; a result never seen leaves scheduledFor null', () => {
    const lines = capture.split('\n');
    const tail = lines[0]!.slice(40) + '\n' + lines.slice(4, 5).join('\n');
    const r = parseWakeups(tail);
    expect(r.unrecognized).toBe(false);
    expect(r.wakeups).toEqual([expect.objectContaining({ toolUseId: 'toolu_01FQcQkihgj3btaHgw6evqwP', scheduledFor: null })]);
  });
  test('reason one line, capped and redacted; prompt capped; huge lines skipped', () => {
    const token = 'sk-ant-api03-' + 'a'.repeat(40);
    const line = (input: unknown, id = 'x1') => JSON.stringify({ type: 'assistant', timestamp: '2026-10-17T08:00:00Z', message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'ScheduleWakeup', input }] } });
    const r = parseWakeups([line({ delaySeconds: 60, reason: `poll\nagain ${token} ${'z'.repeat(400)}`, prompt: '/loop ' + 'p'.repeat(5000) }), 'x'.repeat(1_100_000)].join('\n'));
    const w = r.wakeups[0]!;
    expect(w.reason).not.toContain('\n');
    expect(w.reason).not.toContain(token);
    expect(Array.from(w.reason!).length).toBeLessThanOrEqual(200);
    expect(Array.from(w.prompt!).length).toBeLessThanOrEqual(2000);
    expect(r.wakeups).toHaveLength(1);
  });
  test('the oldest timestamp a text holds (a cut first line skipped), or null', () => {
    expect(oldestStamp(capture)).toBe(Date.parse('2026-10-17T08:24:14.444Z'));
    expect(oldestStamp(capture.slice(40))).toBe(Date.parse('2026-10-17T08:24:14.786Z'));
    expect(oldestStamp('not json\n{"type":"x"}')).toBeNull();
  });
  test('mostly unparsable is unrecognized; a few bad lines are not', () => {
    expect(parseWakeups(Array.from({ length: 30 }, () => 'not json').join('\n')).unrecognized).toBe(true);
    expect(parseWakeups(capture + '\nnot json\nnot json').unrecognized).toBe(false);
    expect(parseWakeups('').unrecognized).toBe(false);
  });
  test('the wake-up of a cron: the one scheduled in its minute, within an hour of now (never yesterday\'s)', () => {
    const ws = parseWakeups(capture).wakeups;
    const now = 1792225680000 - 3 * 60_000;
    expect(matchWakeup(ws, scheduleAt(1792225920000), now)?.toolUseId).toBe('toolu_01FQcQkihgj3btaHgw6evqwP');
    expect(matchWakeup(ws, scheduleAt(1792225680000), now)?.toolUseId).toBe('toolu_01VZ4Zyfmg3o7WxXZLtCXh2V');
    // Fired a moment ago: still its wake-up while Claude checks.
    expect(matchWakeup(ws, scheduleAt(1792225680000), 1792225680000 + 5 * 60_000)?.toolUseId).toBe('toolu_01VZ4Zyfmg3o7WxXZLtCXh2V');
    expect(matchWakeup(ws, scheduleAt(1792225680000 + 120_000), now)).toBeNull();
    expect(matchWakeup(ws, 'bad', now)).toBeNull();
    // The same time a day later: an earlier loop's wake-up at 10:28 is not this one.
    expect(matchWakeup(ws, scheduleAt(1792225680000), now + 86_400_000)).toBeNull();
  });
  test('the delay Claude Code scheduled (clamped), not the one asked for', () => {
    const lines = capture.split('\n').map((l) => l.replace('"clampedDelaySeconds":270', '"clampedDelaySeconds":240'));
    expect(parseWakeups(lines.join('\n')).wakeups[0]!.delaySeconds).toBe(240);
  });
  test('the run: wake-ups with the same prompt back to the last stop or another prompt; the newest few; complete or cut by the window', () => {
    const ws = [wake(1, { prompt: '/loop other' }), wake(2), { ...wake(3), stop: true as const, prompt: null, scheduledFor: null }, ...Array.from({ length: 7 }, (_, i) => wake(10 + i))];
    const run = loopRun(ws, PROMPT);
    expect(run.startedAt).toBe(10_000);
    expect(run.checks).toBe(7);
    expect(run.complete).toBe(true);
    expect(run.last.map((w) => w.toolUseId)).toEqual(['t16', 't15', 't14', 't13', 't12'].slice(0, LOOP_LAST));
    expect(loopRun([wake(1, { prompt: '/loop other' }), wake(2)], PROMPT)).toMatchObject({ startedAt: 2000, checks: 1, complete: true });
    // Back to the window's first wake-up without a stop or another prompt: it may have started earlier.
    expect(loopRun([wake(5), wake(6)], PROMPT)).toMatchObject({ startedAt: 5000, checks: 2, complete: false });
    expect(loopRun([], PROMPT)).toEqual({ startedAt: null, checks: 0, last: [], complete: false });
  });
  test('the detail of a cron: its wake-up, the run up to it', () => {
    const now = 1792225920000 - 3 * 60_000;
    const d = loopDetail(capture, scheduleAt(1792225920000), now);
    expect(d).toEqual({
      ok: true,
      detail: {
        prompt: PROMPT, reason: "File appearance can't be pushed to me; keep polling for done.txt.", scheduledFor: 1792225920000, delaySeconds: 270,
        startedAt: Date.parse('2026-10-17T08:24:14.444Z'), checks: 2, complete: false,
        last: [
          { at: Date.parse('2026-10-17T08:28:04.635Z'), delaySeconds: 270, reason: "File appearance can't be pushed to me; keep polling for done.txt." },
          { at: Date.parse('2026-10-17T08:24:14.444Z'), delaySeconds: 270, reason: "File appearance can't be pushed to me; poll periodically for done.txt." }
        ]
      }
    });
    // Read from the file's start: nothing came before, the run is whole.
    expect(loopDetail(capture, scheduleAt(1792225920000), now, true)).toMatchObject({ ok: true, detail: { checks: 2, complete: true } });
    expect(loopDetail(capture, scheduleAt(1792225680000 + 120_000), now)).toEqual({ ok: false, reason: 'missing' });
    expect(loopDetail(Array.from({ length: 30 }, () => 'not json').join('\n'), '0 0 * * *', now)).toEqual({ ok: false, reason: 'format' });
  });
});
