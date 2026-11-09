// What a new scheduled prompts list means for the user: main turns these into
// toasts and banners, and answers the countdown of prompts that just armed.
import type { ScheduledPrompt } from './scheduled-prompts';

export type ScheduleNotice = { kind: 'sent' | 'skipped' | 'missed' | 'moved'; prompt: ScheduledPrompt };

const FINISHED = new Set(['sent', 'skipped', 'missed']);

/** Prompts that were sent, skipped, missed or moved by a usage limit between two lists (new or removed ones: none). */
export function scheduleNotices(prev: readonly ScheduledPrompt[], next: readonly ScheduledPrompt[]): ScheduleNotice[] {
  const before = new Map(prev.map((x) => [x.id, x]));
  const out: ScheduleNotice[] = [];
  for (const p of next) {
    const b = before.get(p.id);
    if (!b) continue;
    if (FINISHED.has(p.status) && p.status !== b.status) out.push({ kind: p.status as 'sent' | 'skipped' | 'missed', prompt: p });
    else if ((p.reason === 'limit' || p.reason === 'limit-hit') && p.at !== b.at && p.movedFrom !== undefined) out.push({ kind: 'moved', prompt: p });
  }
  return out;
}

/** Prompts armed in `next` that weren't in `prev`: their countdown starts now. */
export function newlyArmed(prev: readonly ScheduledPrompt[], next: readonly ScheduledPrompt[]): ScheduledPrompt[] {
  const armed = new Set(prev.filter((x) => x.status === 'armed').map((x) => x.id));
  return next.filter((x) => x.status === 'armed' && !armed.has(x.id));
}
