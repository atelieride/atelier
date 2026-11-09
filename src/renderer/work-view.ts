// What the work chip and the scheduled chip say: pure, from the work main attached to a terminal.
import { workCounts, workSummary, workTotal, type BackgroundWork } from '@shared/background';
import type { BackgroundKind, SessionInfo } from '@shared/session';
import { agentsInBackground, agentsLabel } from '@shared/session-view';
import { selfPacedLoop } from '@shared/loop';
import { t } from './i18n/en';
import { loopBusy } from './cron-view';

/** At most this many items in the work chip's tooltip, then "+N more". */
const TIP_ITEMS = 8;
const CHIP_ORDER: BackgroundKind[] = ['agent', 'shell', 'monitor', 'other'];

export interface WorkChipView {
  /** "1 agent · 2 shells" (wide rows, the session bar). */
  full: string;
  /** Per-kind counts in chip order, for the compact chip (a glyph and a number each). */
  parts: [BackgroundKind, number][];
  /** Everything listed (the narrowest chip). */
  total: number;
  /** The work keeps the session working (the session reads as working). */
  counting: boolean;
  /** Only capped items remain: the chip is dimmed. */
  idle: boolean;
  /** Three kinds or more: the summary alone crowds a medium line, so the row compacts it. */
  long: boolean;
  /** The heading (the summary), one line per item, and why idle items don't count. */
  tip: string;
}

/**
 * The work chip of a terminal, or null when nothing runs in the background. Without `work` (an atelierd without the
 * 'background' capability) it falls back to the v2.0 subagent count, so nothing regresses.
 */
export function workChipView(term: { session: SessionInfo | null; work?: BackgroundWork }, now: number): WorkChipView | null {
  const s = term.session;
  if (!s) return null;
  const w = term.work;
  if (!w) {
    const label = agentsLabel(s.subagents);
    if (!label) return null;
    const n = s.subagents ?? 0;
    const background = agentsInBackground(s);
    return { full: label, parts: [['agent', n]], total: n, counting: background, idle: false, long: false, tip: t.wait.agentsTip(n, background) };
  }
  const full = workSummary(w);
  if (!full) return null;
  const idle = !w.items.some((i) => i.counted);
  const sorted = CHIP_ORDER.flatMap((k) => w.items.filter((i) => i.kind === k));
  const lines = sorted.slice(0, TIP_ITEMS).map((i) => t.work.line(t.work.kind[i.kind], i.label, i.counted || idle));
  if (sorted.length > TIP_ITEMS) lines.push(t.work.more(sorted.length - TIP_ITEMS));
  if (idle && w.idleSince !== undefined) lines.push(t.work.idleFor(formatDuration(now - w.idleSince)));
  const parts = workCounts(w);
  return { full, parts, total: workTotal(w), counting: w.counting, idle, long: parts.length >= 3, tip: [full, ...lines].join('\n') };
}

export interface ScheduledView {
  /** Local "HH:MM" of the soonest wake-up; null when none has a computable time (icon only). */
  time: string | null;
  tip: string;
  /** The soonest wake-up is a self-paced loop's: the chip shows a loop icon. */
  loop?: true;
}

/** The scheduled chip: the soonest wake-up of the session's crons, or null without crons. */
export function scheduledView(work: BackgroundWork | undefined, now: number, session?: SessionInfo | null): ScheduledView | null {
  const crons = work?.crons ?? [];
  if (crons.length === 0) return null;
  const timed = crons.filter((c): c is typeof c & { next: number } => c.next !== null).sort((a, b) => a.next - b.next);
  // A loop whose wake-up fired (main nulls its next) is happening now: sooner than any time.
  const fired = crons.find((c) => c.next === null && selfPacedLoop(c.label, c.recurring));
  const first = fired ?? timed[0];
  const loop = first ? selfPacedLoop(first.label, first.recurring) : null;
  if (first && loop) {
    // Fired: the same words as the Background list (Claude on it, or the turn ended without the next Stop).
    const next = first.next !== null ? t.bg.loop.nextCheckAt(when(first.next, now)) : loopBusy(session) ? t.bg.loop.checkingNow : t.bg.loop.passed;
    const head = loop.autonomous ? t.bg.loop.autonomous : t.bg.loop.selfPaced;
    return { time: first.next !== null ? clockTime(first.next) : null, loop: true, tip: [head, next, loop.task].filter(Boolean).join(' · ') };
  }
  const soonest = timed[0];
  const head = t.work.scheduled(crons.length);
  if (!soonest) return { time: null, tip: `${head} · ${crons[0]!.label}` };
  const time = clockTime(soonest.next);
  return { time, tip: `${head} · ${t.work.nextAt(when(soonest.next, now))} · ${soonest.label}` };
}

/** "12:30" today, "12:30 tomorrow", else "12:30 on Wed 14 Oct". */
function when(at: number, now: number): string {
  const time = clockTime(at);
  const day = (ms: number) => { const d = new Date(ms); return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(); };
  const days = Math.round((day(at) - day(now)) / 86_400_000);
  if (days <= 0) return time;
  if (days === 1) return t.work.tomorrow(time);
  return t.work.onDay(time, new Date(at).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }));
}

/** Local 24-hour "HH:MM". */
export function clockTime(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** "45 min", "1 h 20 min", "2 h"; at least a minute, whole hours from 10 h on. */
export function formatDuration(ms: number): string {
  const min = Math.max(1, Math.round(ms / 60_000));
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m === 0 || h >= 10 ? `${h} h` : `${h} h ${m} min`;
}
