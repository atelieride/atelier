// Scheduled wake-ups in words for the Background inspector: common 5-field forms,
// the next fires, and Claude Code's documented jitter. Pure.
import { cronNext } from '@shared/background';
import type { LoopDetail, LoopResult } from '@shared/background-feed';
import type { SelfPacedLoop } from '@shared/loop';
import type { SessionInfo } from '@shared/session';
import { isWaiting } from '@shared/session-view';
import { t } from './i18n/en';

/** A self-paced loop's title: its task, or "Autonomous loop" for /loop without a prompt. */
export function loopTitle(loop: SelfPacedLoop): string {
  return loop.autonomous ? t.bg.loop.autonomous : loop.task;
}

/** A wake-up's delay: half minutes under an hour ("4.5 min"), tenths of an hour above ("1.5 h"). */
export function loopDelay(seconds: number): string {
  if (seconds < 3600) return `${Math.max(1, Math.round(seconds / 30) / 2)} min`;
  return `${Math.round(seconds / 360) / 10} h`;
}

/** Local 24-hour "HH:MM:SS": when Claude asked for a wake-up (a check's time in the list). */
export function clockSeconds(ms: number): string {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** Claude is on a fired wake-up: working on it, or waiting on the user in the middle of it (the idle notice is no wait). */
export function loopBusy(s: SessionInfo | null | undefined): boolean {
  return s?.state === 'running' || isWaiting(s);
}

/** The run's start and count: "Started 10:24 · 2 checks", or "Since 13:40 · 9+ checks" when it began before what was read. */
export function loopStarted(time: string, checks: number, complete: boolean): string {
  return complete ? t.bg.loop.started(time, checks) : t.bg.loop.since(time, checks);
}

/** A loop answer from main, with the terminal and cron it was asked for. */
export interface LoopTagged { terminalId: string; cronId: string; result: LoopResult }

/**
 * What an open loop card shows: the last answer is kept across turns, but its wake-up time
 * counts only for the cron it was read for and while it is the cron's own minute; the card shows the cron's minute
 * meanwhile. `period`: the ring's full turn, the wait Claude Code scheduled (from the request to the wake-up).
 */
export function loopShown(c: { id: string; next: number | null }, tagged: LoopTagged | null, terminalId: string): {
  detail: LoopDetail | null; fresh: boolean; next: number | null; period: number | null; why: string | null;
} {
  const mine = tagged?.terminalId === terminalId ? tagged : null;
  const detail = mine?.result.ok ? mine.result.detail : null;
  const minute = (ms: number) => Math.floor(ms / 60_000) * 60_000;
  const fresh = !!detail && mine!.cronId === c.id && (c.next === null || (detail.scheduledFor !== null && minute(detail.scheduledFor) === c.next));
  const exact = fresh && c.next !== null ? detail!.scheduledFor : null;
  const asked = fresh ? detail!.last[0]?.at ?? null : null;
  // Stale: the last delay, close enough until this turn's answer lands; none known: no turn at all (an empty ring).
  const period = exact !== null && asked !== null && exact > asked ? exact - asked : detail?.delaySeconds ? detail.delaySeconds * 1000 : null;
  const why = mine && !mine.result.ok && mine.cronId === c.id && mine.result.reason !== 'missing' ? t.bg.why[mine.result.reason] ?? null : null;
  return { detail, fresh, next: c.next === null ? null : exact ?? c.next, period, why };
}

const pad = (n: number) => String(n).padStart(2, '0');
/** A plain number within [lo, hi], else null. */
const num = (s: string, lo: number, hi: number) => { const n = /^\d+$/.test(s) ? Number(s) : NaN; return n >= lo && n <= hi ? n : null; };
/** A step field (star, slash, n) with n dividing `period` evenly (1 ≤ n < period), else null. */
const step = (s: string, period: number) => { const m = /^\*\/(\d+)$/.exec(s); const n = m ? Number(m[1]) : NaN; return n >= 1 && n < period && period % n === 0 ? n : null; };
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** A common schedule in words, or null (unusual, invalid or never-firing forms). `recurring` tells a yearly date from a one-shot. */
export function cronEvery(schedule: string, recurring: boolean): string | null {
  const f = schedule.trim().split(/\s+/);
  if (f.length !== 5 || cronNext(schedule, new Date()) === null) return null;
  const [mi, h, dom, mon, dow] = f as [string, string, string, string, string];
  const anyDay = dom === '*' && mon === '*' && dow === '*';
  const m = num(mi, 0, 59), hh = num(h, 0, 23), minStep = step(mi, 60), hourStep = step(h, 24);
  if (!recurring) return oneShot(m, hh, dom, mon, dow);
  if (mi === '*' && h === '*' && anyDay) return t.bg.cron.everyMinute;
  if (minStep !== null && h === '*' && anyDay) return minStep === 1 ? t.bg.cron.everyMinute : t.bg.cron.everyMinutes(minStep);
  if (m !== null && h === '*' && anyDay) return t.bg.cron.hourlyAt(pad(m));
  if (m !== null && hourStep !== null && anyDay) {
    if (hourStep === 1) return m === 0 ? t.bg.cron.everyHour : t.bg.cron.hourlyAt(pad(m));
    return m === 0 ? t.bg.cron.everyHours(hourStep) : t.bg.cron.everyHoursAt(hourStep, pad(m));
  }
  if (m === null || hh === null) return null;
  const time = `${pad(hh)}:${pad(m)}`;
  if (anyDay) return t.bg.cron.dailyAt(time);
  if (dom === '*' && mon === '*' && dow === '1-5') return t.bg.cron.weekdaysAt(time);
  const d = num(dom, 1, 31), mo = num(mon, 1, 12);
  if (d !== null && mo !== null && dow === '*') return t.bg.cron.yearlyOn(`${d} ${MONTHS[mo - 1]}`, time);
  return null;
}

/**
 * A one-shot fires at its schedule's first match, then is gone: a date when it pins one, else only the time (a
 * self-paced /loop's ScheduleWakeup arrives as "28 10 * * *"). Forms without a fixed time read as repeating: null.
 */
function oneShot(m: number | null, hh: number | null, dom: string, mon: string, dow: string): string | null {
  if (m === null || hh === null) return null;
  const time = `${pad(hh)}:${pad(m)}`;
  const d = num(dom, 1, 31), mo = num(mon, 1, 12);
  if (d !== null && mo !== null && dow === '*') return t.bg.cron.onceOn(`${d} ${MONTHS[mo - 1]}`, time);
  return t.bg.cron.onceAt(time);
}

/** The schedule card's footnote: the 7-day expiry is a recurring task's; any task ends with its session. */
export function cronHint(recurring: boolean): string {
  return recurring ? t.bg.cronHint : t.bg.cronHintOnce;
}

export function cronUpcoming(schedule: string, from: Date, n: number): number[] {
  const out: number[] = [];
  let at = from;
  for (let i = 0; i < n; i++) { const next = cronNext(schedule, at); if (!next) break; out.push(next.getTime()); at = next; }
  return out;
}

const MAX_LATE = 30 * 60_000;
const EARLY = 90_000;
/** Claude Code's documented jitter: recurring tasks up to half their period late (≤ 30 min); one-shots on :00/:30 up to 90 s early. */
export function cronDrift(schedule: string, recurring: boolean, from: Date): { late: number } | { early: number } | null {
  const [a, b] = cronUpcoming(schedule, from, 2);
  if (a === undefined) return null;
  if (recurring) return b === undefined ? null : { late: Math.min((b - a) / 2, MAX_LATE) };
  const minute = new Date(a).getMinutes();
  return minute === 0 || minute === 30 ? { early: EARLY } : null;
}
