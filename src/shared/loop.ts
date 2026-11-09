/**
 * Self-paced /loop wake-ups. Claude Code reports each ScheduleWakeup as a dateless
 * one-shot cron whose prompt is the /loop input verbatim, with a new id every turn. Pure: main's backgroundWork and
 * the renderer both use it.
 */

/** ScheduleWakeup clamps its delay to [60, 3600] s: a wake-up is never further ahead than this. */
export const LOOP_MAX_AHEAD_MS = 60 * 60_000;
const PREFIX = '/loop ';
const AUTONOMOUS = '<<autonomous-loop-dynamic>>';

export interface SelfPacedLoop { task: string; autonomous: boolean }

/** The loop a cron stands for, or null for an ordinary cron. */
export function selfPacedLoop(label: string, recurring: boolean): SelfPacedLoop | null {
  if (recurring) return null;
  if (label === AUTONOMOUS) return { task: '', autonomous: true };
  if (!label.startsWith(PREFIX)) return null;
  const task = label.slice(PREFIX.length).trim();
  return task ? { task, autonomous: false } : null;
}

/** FNV-1a (32-bit) over UTF-16 code units, as 8 hex digits. */
function fnv(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** A loop's row: keyed by its label, the same every turn, so a selection survives the new cron id. */
export function loopRowId(label: string): string {
  return `cron:loop-${fnv(label)}`;
}

/** The inspector's row id of a cron. */
export function cronRowId(c: { id: string; label: string; recurring: boolean }): string {
  return selfPacedLoop(c.label, c.recurring) ? loopRowId(c.label) : `cron:${c.id}`;
}

/** A loop's wake-up already fired: its schedule's next match is further than a wake-up can be (or there is none). */
export function loopFired(c: { label: string; recurring: boolean; next: number | null }, now: number): boolean {
  if (!selfPacedLoop(c.label, c.recurring)) return false;
  return c.next === null || c.next - now > LOOP_MAX_AHEAD_MS;
}
