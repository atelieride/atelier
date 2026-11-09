// Scheduled prompts as the UI shows them: the chip, the popover's rows, the composer's
// presets, rail and checks, the palette's list. Pure: times are local, `now` is given.
import { clashOf, limitResetAt, minuteOf, nextFreeMinute, type ScheduleReason, type ScheduledPrompt } from '@shared/scheduled-prompts';
import type { Usage } from '@shared/session';
import { t } from './i18n/en';

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const pad = (n: number) => String(n).padStart(2, '0');
const isLive = (p: ScheduledPrompt) => p.status === 'pending' || p.status === 'armed';

/** "14:30" (local). */
export function clockOf(ms: number): string {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Local midnight of `now`'s day + `offset` days. */
export function dayOf(now: number, offset: number): number {
  const d = new Date(now);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + offset).getTime();
}

const sameDay = (a: number, b: number) => dayOf(a, 0) === dayOf(b, 0);
const shortDate = (ms: number) => new Date(ms).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }).replace(',', '');

/** Today, Tomorrow, or "Tue 27 Oct". */
export function dayLabel(ms: number, now: number): string {
  if (sameDay(ms, now)) return t.sched.today;
  if (sameDay(ms, dayOf(now, 1))) return t.sched.tomorrow;
  return shortDate(ms);
}

/** "in 1 h 42 min", "in 4 min", "3 min ago", "now", "in 1 d 20 h". */
export function relTime(ms: number, now: number): string {
  const mins = Math.round((ms - now) / MIN);
  if (mins === 0) return t.sched.now;
  const a = Math.abs(mins);
  const d = Math.floor(a / (24 * 60));
  const h = Math.floor((a % (24 * 60)) / 60);
  const m = a % 60;
  const span = d > 0 ? `${d} d${h ? ` ${h} h` : ''}` : h > 0 ? `${h} h${m ? ` ${m} min` : ''}` : `${m} min`;
  return mins > 0 ? t.sched.inSpan(span) : t.sched.agoSpan(span);
}

/** `HH:MM`, `H:MM` or `HHMM`, a real time of day; null otherwise. */
export function parseClock(s: string): { h: number; m: number } | null {
  const x = /^\s*(\d{1,2}):?(\d{2})\s*$/.exec(s);
  if (!x) return null;
  const h = Number(x[1]);
  const m = Number(x[2]);
  return h < 24 && m < 60 ? { h, m } : null;
}

/** The time field's ↑/↓: to the next or previous 5 minutes, around midnight. */
export function stepClock(s: string, dir: 1 | -1): string {
  const c = parseClock(s) ?? { h: 0, m: 0 };
  let total = c.h * 60 + c.m;
  if (!parseClock(s)) total = dir === 1 ? -5 : 5;
  total = dir === 1 ? Math.floor(total / 5) * 5 + 5 : Math.ceil(total / 5) * 5 - 5;
  total = ((total % 1440) + 1440) % 1440;
  return `${pad(Math.floor(total / 60))}:${pad(total % 60)}`;
}

/** A day (local midnight) and a clock as epoch ms; null when the clock isn't one. */
export function composeAt(day: number, clock: string): number | null {
  const c = parseClock(clock);
  if (!c) return null;
  const d = new Date(day);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), c.h, c.m).getTime();
}

const byTime = (a: ScheduledPrompt, b: ScheduledPrompt) => a.at - b.at;
const mine = (list: readonly ScheduledPrompt[], terminalId: string) => list.filter((x) => x.terminalId === terminalId);
const isDue = (p: ScheduledPrompt) => p.status === 'armed' || (p.status === 'pending' && p.dueSince !== undefined);

export interface ChipView { time: string; more: number; tone: 'next' | 'due' | 'moved' | 'missed'; tip: string }

/** The session bar's chip (and the row's time): missed first, then the next live prompt. Null without either. */
export function chipView(list: readonly ScheduledPrompt[], terminalId: string, now: number): ChipView | null {
  const own = mine(list, terminalId);
  const live = own.filter(isLive).sort(byTime);
  const missed = own.filter((x) => x.status === 'missed').sort(byTime);
  const shown = missed[0] ?? live[0];
  if (!shown) return null;
  const time = sameDay(shown.at, now) ? clockOf(shown.at) : `${new Date(shown.at).toLocaleDateString('en-GB', { weekday: 'short' })} ${clockOf(shown.at)}`;
  const tone: ChipView['tone'] = shown.status === 'missed' ? 'missed' : isDue(shown) ? 'due' : shown.movedFrom !== undefined && (shown.reason === 'limit' || shown.reason === 'limit-hit') ? 'moved' : 'next';
  const count = live.length + missed.length;
  return { time, more: count - 1, tone, tip: t.sched.chipTip(count) };
}

/** The popover's rows: live and missed by time, then the finished ones of today. */
export function rowsFor(list: readonly ScheduledPrompt[], terminalId: string, now: number): { live: ScheduledPrompt[]; done: ScheduledPrompt[] } {
  const own = mine(list, terminalId);
  return {
    live: own.filter((x) => isLive(x) || x.status === 'missed').sort(byTime),
    done: own.filter((x) => (x.status === 'sent' || x.status === 'skipped') && sameDay(x.doneAt ?? x.at, now)).sort((a, b) => (b.doneAt ?? 0) - (a.doneAt ?? 0))
  };
}

const WAITS: Partial<Record<ScheduleReason, string>> = {
  busy: t.sched.waits.busy, waiting: t.sched.waits.waiting, draft: t.sched.waits.draft, typing: t.sched.waits.typing,
  'not-claude': t.sched.waits.notClaude, closed: t.sched.waits.closed
};

/** What a row says about its prompt now. */
export function statusLine(p: ScheduledPrompt, now: number): string {
  if (p.status === 'sent') return t.sched.sentAt(clockOf(p.doneAt ?? p.at));
  if (p.status === 'skipped') return t.sched.skipped(reasonText(p.reason));
  if (p.status === 'missed') return t.sched.notSent(reasonText(p.reason));
  if (p.status === 'armed') {
    const s = Math.ceil(((p.armedUntil ?? now) - now) / 1000);
    return s > 0 ? t.sched.sendingIn(s) : t.sched.sending;
  }
  if ((p.reason === 'limit' || p.reason === 'limit-hit') && p.movedFrom !== undefined) return t.sched.moved(clockOf(p.movedFrom));
  if (p.dueSince !== undefined && p.at <= now) return `${t.sched.due(relTime(p.at, now))}${p.reason && WAITS[p.reason] ? ` · ${WAITS[p.reason]}` : ''}`;
  return `${relTime(p.at, now)}${p.ifBusy === 'skip' ? ` · ${t.sched.skipIfBusy}` : ''}`;
}

/** Why it was skipped or missed, in words. */
export function reasonText(r: ScheduleReason | undefined): string {
  return r ? t.sched.reasons[r] : '';
}

/** `day`: the weekday when the preset's time falls on another day than today (Tomorrow says it itself). */
export interface Preset { key: '30m' | '1h' | '3h' | 'tomorrow' | 'reset'; label: string; at: number; taken: boolean; day: string | null }

/** The composer's presets: each at its time, or the next free minute when its own is taken. */
export function presetsFor(list: readonly ScheduledPrompt[], terminalId: string, now: number, usage: Usage | null, exceptId?: string): Preset[] {
  const base = minuteOf(now);
  const out: { key: Preset['key']; label: string; at: number }[] = [
    { key: '30m', label: t.sched.presets.in30, at: base + 30 * MIN },
    { key: '1h', label: t.sched.presets.in1h, at: base + 60 * MIN },
    { key: '3h', label: t.sched.presets.in3h, at: base + 180 * MIN },
    { key: 'tomorrow', label: t.sched.presets.tomorrow, at: composeAt(dayOf(now, 1), '09:00')! }
  ];
  const reset = resetAtFor(usage, now);
  if (reset !== null) out.push({ key: 'reset', label: t.sched.presets.reset, at: minuteOf(reset) + MIN });
  return out.map((x) => {
    const taken = clashOf(list, terminalId, x.at, exceptId) !== null;
    const at = taken ? nextFreeMinute(list, terminalId, x.at, 5 * MIN, exceptId) : x.at;
    const day = x.key === 'tomorrow' || sameDay(at, now) ? null : new Date(at).toLocaleDateString('en-GB', { weekday: 'short' });
    return { ...x, taken, at, day };
  });
}

/** The account's usage reset ahead: a window at its limit first, else the 5-hour window's next reset. */
export function resetAtFor(usage: Usage | null, now: number): number | null {
  const limited = limitResetAt(usage, now);
  if (limited !== null) return limited;
  const five = usage?.fiveHour ? usage.fiveHour.resetsAt * 1000 : null;
  return five !== null && five > now ? five : null;
}

export type TimeError = { kind: 'past'; fix: number } | { kind: 'taken'; fix: number; by: ScheduledPrompt };

/** What's wrong with the time picked (before the current minute, or taken in this session), with its fix. */
export function timeError(list: readonly ScheduledPrompt[], terminalId: string, at: number, now: number, exceptId?: string): TimeError | null {
  if (minuteOf(at) < minuteOf(now)) return { kind: 'past', fix: composeAt(dayOf(now, 1), clockOf(at))! };
  const by = clashOf(list, terminalId, at, exceptId);
  return by ? { kind: 'taken', fix: nextFreeMinute(list, terminalId, at, 5 * MIN, exceptId), by } : null;
}

/** "today at 14:30", "tomorrow at 09:00", "Tue 27 Oct at 09:00". */
export function whenOf(at: number, now: number): string {
  const day = sameDay(at, now) ? t.sched.today.toLowerCase() : sameDay(at, dayOf(now, 1)) ? t.sched.tomorrow.toLowerCase() : shortDate(at);
  return t.sched.whenAt(day, clockOf(at));
}

/** "Sends today at 14:30 · in 1 h 42 min". */
export function summaryOf(at: number, now: number): string {
  const day = sameDay(at, now) ? t.sched.today.toLowerCase() : sameDay(at, dayOf(now, 1)) ? t.sched.tomorrow.toLowerCase() : shortDate(at);
  return t.sched.summary(day, clockOf(at), relTime(at, now));
}

export interface Rail { ticks: { label: string; left: number }[]; dots: { left: number; kind: 'other' | 'this'; clash: boolean; tip: string }[]; reset: number | null }

/** The composer's rail: the next 24 h of this session, its prompts, the usage reset, the time picked. */
export function railFor(list: readonly ScheduledPrompt[], terminalId: string, now: number, o: { at: number | null; clash: boolean; resetAt: number | null; exceptId?: string }): Rail {
  const pos = (ms: number) => ((ms - now) / DAY) * 100;
  const within = (ms: number) => ms >= now - MIN && ms <= now + DAY;
  const ticks: Rail['ticks'] = [{ label: t.sched.now, left: 0 }];
  // Whole local hours (composed, never added: a day with a clock change has 23 or 25 hours).
  for (const d of [0, 1]) {
    for (const h of ['00:00', '06:00', '12:00', '18:00']) {
      const x = composeAt(dayOf(now, d), h)!;
      if (x > now + 2 * 60 * MIN && x < now + DAY - 60 * MIN) ticks.push({ label: clockOf(x), left: pos(x) });
    }
  }
  ticks.sort((a, b) => a.left - b.left);
  const dots: Rail['dots'] = mine(list, terminalId).filter((x) => isLive(x) && x.id !== o.exceptId && within(x.at))
    .map((x) => ({ left: Math.max(0, pos(x.at)), kind: 'other' as const, clash: false, tip: `${clockOf(x.at)} · ${x.text.slice(0, 60)}` }));
  if (o.at !== null && within(o.at)) dots.push({ left: Math.max(0, pos(o.at)), kind: 'this', clash: o.clash, tip: clockOf(o.at) });
  return { ticks, dots, reset: o.resetAt !== null && within(o.resetAt) ? pos(o.resetAt) : null };
}

export interface PaletteRow { prompt: ScheduledPrompt; group: string; other: boolean }

/** The palette's Scheduled Prompts: every project's, missed first, then by day; other projects' dimmed. */
export function paletteRows(list: readonly ScheduledPrompt[], project: string, now: number): PaletteRow[] {
  const missed = list.filter((x) => x.status === 'missed').sort(byTime);
  const live = list.filter(isLive).sort(byTime);
  const group = (p: ScheduledPrompt) => {
    if (p.status === 'missed') return t.sched.needsDecision;
    if (sameDay(p.at, now) || p.at < now) return t.sched.today;
    if (sameDay(p.at, dayOf(now, 1))) return `${t.sched.tomorrow} · ${shortDate(p.at)}`;
    return shortDate(p.at);
  };
  return [...missed, ...live].map((p) => ({ prompt: p, group: group(p), other: p.projectRoot !== project }));
}
