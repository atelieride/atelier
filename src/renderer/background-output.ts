// Pure helpers of the Background tab: the output log, the state pill and meta cards,
// the agent header, the schedule's countdown ring and the session picker's order.
import type { InspectorEntry } from '@shared/background';
import { t } from './i18n/en';
import { formatElapsed } from './background-view';
import { formatDuration } from './work-view';

export interface NumberedLine { text: string; at: number | null; n: number }

/** The lines matching `needle` (case-insensitive; blank: all), each with its absolute number (dropped lines counted). */
export function filterLines(lines: { text: string; at: number | null }[], needle: string, dropped: number): NumberedLine[] {
  const q = needle.trim().toLowerCase();
  const out: NumberedLine[] = [];
  lines.forEach((l, i) => { if (!q || l.text.toLowerCase().includes(q)) out.push({ text: l.text, at: l.at, n: dropped + i + 1 }); });
  return out;
}

/** The log follows its end while scrolled within 24 px of it. */
export const stickToEnd = (el: { scrollTop: number; scrollHeight: number; clientHeight: number }): boolean => el.scrollHeight - el.scrollTop - el.clientHeight <= 24;

const pad = (n: number) => String(n).padStart(2, '0');
/** Local 24-hour "HH:MM:SS". */
export function clockSeconds(ms: number): string {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export type StateTone = 'running' | 'watching' | 'server' | 'ok' | 'error' | 'ended';
/** The detail's state pill: an exit code wins (the trailer is the truth), then ended, server, watcher, running. */
export function outputState(s: { exit: number | null; ended?: boolean; server?: boolean; watcher?: boolean }): { label: string; tone: StateTone } {
  if (s.exit !== null) return { label: t.bg.exited(s.exit), tone: s.exit === 0 ? 'ok' : 'error' };
  if (s.ended) return { label: t.bg.ended, tone: 'ended' };
  if (s.server) return { label: t.bg.serverState, tone: 'server' };
  if (s.watcher) return { label: t.bg.watching, tone: 'watching' };
  return { label: t.bg.running, tone: 'running' };
}

/**
 * The "Counts as work" card: null is an item that ended, and so is one whose exit code is known (the trailer arrives
 * before the work scan sees the shell gone): it counts no more.
 */
export function countsAsWork(e: Pick<InspectorEntry, 'counted' | 'server' | 'watcher' | 'capEndsAt'> | null, now: number, exit: number | null = null): string {
  if (!e || exit !== null) return t.bg.countsNo;
  if (e.server) return t.bg.serverState;
  if (e.counted) return e.capEndsAt !== undefined ? t.bg.countsYes(formatElapsed(e.capEndsAt - now)) : t.bg.countsYesPlain;
  return e.watcher ? t.bg.countsNoWatcher : t.bg.countsNoCapped;
}

/** "claude-haiku-5-5" → "haiku": the family when known, else the name without "claude-" and the context suffix. */
export function shortModel(model: string): string {
  const fam = /(opus|sonnet|haiku|fable)/i.exec(model);
  if (fam) return fam[1]!.toLowerCase();
  return model.replace(/\[[^\]]*\]$/, '').replace(/^claude-/, '');
}

/** "950", "48.2k", "12k", "1.2M". */
export function formatTokens(n: number): string {
  const one = (v: number) => (Math.round(v * 10) / 10).toFixed(1).replace(/\.0$/, '');
  if (n < 1000) return String(Math.max(0, Math.round(n)));
  if (n < 999_950) return `${one(n / 1000)}k`;
  return `${one(n / 1_000_000)}M`;
}

/**
 * Time to the next fire: "6:05" under an hour, "1 h 20 min" above, "now" when due. With reduced motion (the ring moves
 * once a minute) whole minutes, rounded up: what is left is never shown as less than it is.
 */
export function countdown(ms: number, reduced: boolean): string {
  if (ms <= 0) return t.bg.dueNow;
  if (reduced) {
    const min = Math.ceil(ms / 60_000);
    return min < 60 ? `${min} min` : formatDuration(min * 60_000);
  }
  if (ms >= 3600_000) return formatDuration(ms);
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${pad(s % 60)}`;
}

/** The log's count: every line received (dropped ones too), or how many of them match the filter; events for a monitor. */
export function countLabel(c: { events: boolean; matching: number | null; total: number }): string {
  if (c.matching === null) return c.events ? t.bg.eventsCount(c.total) : t.bg.lines(c.total);
  return c.events ? t.bg.eventsOf(c.matching, c.total) : t.bg.linesOf(c.matching, c.total);
}

/** The scrollTop that shows a child (offsets relative to its scroller) whole, the nearest way; unchanged when it is. */
export function scrollToReveal(child: { top: number; height: number }, view: { scrollTop: number; clientHeight: number }): number {
  if (child.top < view.scrollTop) return child.top;
  if (child.top + child.height > view.scrollTop + view.clientHeight) return child.top + child.height - view.clientHeight;
  return view.scrollTop;
}

const dayStart = (ms: number) => { const d = new Date(ms); return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(); };
/** A fire time in the upcoming list: "23:30" today, "Wed 09:00" within the week, else "20 Oct 09:00". */
export function fireTime(ms: number, now: number): string {
  const d = new Date(ms);
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const days = Math.round((dayStart(ms) - dayStart(now)) / 86_400_000);
  if (days === 0) return time;
  if (days > 0 && days < 7) return `${t.bg.weekdays[d.getDay()]} ${time}`;
  return `${d.getDate()} ${t.bg.months[d.getMonth()]} ${time}`;
}

const HOUR = 3600_000;
/**
 * How much of the current period has gone by (0…1): the period is the gap to the fire after `next`; a one-shot has
 * none, so only its last hour fills the ring.
 */
export function cronRing(next: number, after: number | null, now: number): number {
  const left = Math.max(0, next - now);
  const period = after !== null && after > next ? after - next : Math.max(left, HOUR);
  return Math.min(1, Math.max(0, 1 - left / period));
}

type PickerTerm = { id: string; session: unknown; work?: { entries: unknown[]; crons: unknown[] }; recent?: unknown[] };
/** The session picker: terminals with a Claude session, those with background work or recent items first. */
export function orderSessions<T extends PickerTerm>(terms: T[]): T[] {
  const withClaude = terms.filter((x) => !!x.session);
  const busy = (x: T) => (x.work?.entries.length ?? 0) + (x.work?.crons.length ?? 0) + (x.recent?.length ?? 0) > 0;
  return [...withClaude.filter(busy), ...withClaude.filter((x) => !busy(x))];
}
