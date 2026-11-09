import type { Resumable, TerminalInfo } from '@shared/protocol';
import type { SessionCost, SessionInfo, SessionState, Usage, UsageEntry } from '@shared/session';
import { isLimitPaused, isWaiting, waitKind, waitTarget } from '@shared/session-view';
import { reasonLabel } from '@shared/notifications';
import { effectiveState, type BackgroundWork } from '@shared/background';
import { t } from './i18n/en';
import { isStarting, type Starting } from './starting';
import { clockOf, dayOf, whenOf } from './schedule-view';

/** Sessions (a terminal launched as one and still starting counts) and plain terminals, each by age. */
export function splitTerminals(list: TerminalInfo[], starting: Starting = {}): { sessions: TerminalInfo[]; shells: TerminalInfo[] } {
  const byAge = [...list].sort((a, b) => a.createdAt - b.createdAt);
  const session = (x: TerminalInfo) => !!x.session || isStarting(x, starting);
  return { sessions: byAge.filter(session), shells: byAge.filter((x) => !session(x)) };
}

export function counts(list: TerminalInfo[]): { waiting: number; running: number } {
  let waiting = 0; let running = 0;
  for (const x of list) {
    if (isWaiting(x.session)) waiting++;
    else if (effectiveState(x) === 'running') running++;
  }
  return { waiting, running };
}

/**
 * The state a session's badges draw (avatar ring, state chip, frame): effectiveState, except a session paused at its
 * usage limit draws idle, muted — Claude Code goes on by itself.
 */
export function shownState(term: Pick<TerminalInfo, 'session' | 'work'>): SessionState | null {
  return isLimitPaused(term.session) ? 'idle' : effectiveState(term);
}

/** The state in words beside a session's badge: "Usage limit" while paused, never "error"; null without a session. */
export function shownStateLabel(term: Pick<TerminalInfo, 'session' | 'work'>): string | null {
  if (isLimitPaused(term.session)) return t.limit.label;
  const state = effectiveState(term);
  return state ? t.stateLabel[state] : null;
}

/** Time to reset in a compact two-unit form, as a status line shows it. */
export function formatReset(resetsAt: number, now = Date.now() / 1000): string {
  const s = Math.floor(resetsAt - now);
  // Usage windows last at most 7 days: beyond that, the data isn't credible.
  if (s <= 0 || s > 7 * 86400) return '';
  const d = Math.floor(s / 86400); const h = Math.floor((s % 86400) / 3600); const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d${h}h`;
  if (h > 0) return `${h}h${m}m`;
  return `${m}m`;
}

/** Process name to show: Claude Code's native binary appears as its version number. */
export function displayCommand(term: TerminalInfo): string {
  const fg = typeof term.foreground === 'string' ? term.foreground : '';
  const name = fg.replace(/^-/, '').split('/').at(-1) || fg;
  if (term.session || /^\d+(\.\d+)+$/.test(name)) return 'claude';
  return name;
}

/** Resumable sessions of this project, most recent first. */
export function resumablesFor(list: Resumable[], projectRoot: string): Resumable[] {
  return list.filter((r) => r.projectRoot === projectRoot).sort((a, b) => b.endedAt - a.endedAt);
}

/** `tip`: the tooltip as shown. */
export interface Subtitle { text: string; tip: string | null }

/**
 * Claude Code's usage-limit pause in words: "Usage limit · continues at 15:45"
 * (the day too when the reset isn't today), "Usage limit" while atelierd checks, "Limit reset · press Enter to continue"
 * once Claude Code waits for Enter. null otherwise: any other end of the pause reads as today's error.
 */
export function limitLine(s: SessionInfo, now: number): { text: string; tip: string } | null {
  const p = s.limitPause;
  if (p && isLimitPaused(s)) {
    if (p.resetsAt === null) return { text: t.limit.checking, tip: t.limit.pausedTip };
    const at = p.resetsAt;
    // A reset already past (Claude Code continues shortly after it) keeps its clock, never yesterday's date.
    const clockOnly = at <= now || dayOf(at, 0) === dayOf(now, 0);
    return { text: t.limit.continuesAt(clockOnly ? t.limit.atClock(clockOf(at)) : whenOf(at, now)), tip: t.limit.pausedTip };
  }
  if (s.state === 'error' && p?.over === 'stale') return { text: t.limit.stale, tip: t.limit.staleTip };
  return null;
}

/**
 * Under the session name: what it is doing, otherwise its state; nothing when the session is done (the green icon is
 * enough). With states2: "Compacting…", what a waiting session asks for
 * ("Needs permission: Bash npm test", "Has a question"), an error in words with the raw code in its tooltip; a usage-limit
 * pause as limitLine says it (`now`: its reset's day). While background work counts: "In
 * background · <first counted item>".
 */
export function sessionSubtitle(s: SessionInfo, labels: Record<SessionState, string>, words: Pick<typeof t.wait, 'permission' | 'question' | 'compacting'> = t.wait, work?: BackgroundWork, now = Date.now()): Subtitle | null {
  if (s.compacting) return { text: words.compacting, tip: null };
  const wait = waitKind(s);
  if (wait === 'permission') { const target = waitTarget(s.activity); return { text: target ? `${words.permission}: ${target}` : words.permission, tip: null }; }
  if (wait === 'question') return { text: words.question, tip: null };
  const limit = limitLine(s, now);
  if (limit) return limit;
  if (s.state === 'error' && s.errorReason) return { text: reasonLabel(s.errorReason), tip: t.wait.errorTip(s.errorReason) };
  if (work?.counting) {
    const label = work.items.find((i) => i.counted && i.label)?.label;
    return { text: label ? `${t.inBackground} · ${label}` : t.inBackground, tip: null };
  }
  if (s.activity) return { text: s.activity, tip: null };
  // Done or idle: nothing here; the row shows when the last message was instead (last-message.ts).
  return s.state === 'done' || s.state === 'idle' ? null : { text: labels[s.state], tip: null };
}

const kilo = (n: number) => (n < 1000 ? String(n) : n < 10000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k` : `${Math.round(n / 1000)}k`);

/** Session totals for the bar: lines added/removed (if any) and cost (if not zero). */
export function sessionTotals(c: SessionCost | null | undefined): { lines: { added: string; removed: string } | null; usd: string | null } | null {
  if (!c) return null;
  const lines = c.linesAdded || c.linesRemoved ? { added: `+${kilo(c.linesAdded)}`, removed: `−${kilo(c.linesRemoved)}` } : null;
  const usd = c.usd <= 0 ? null : c.usd < 0.01 ? '<$0.01' : c.usd >= 100 ? `$${Math.round(c.usd)}` : `$${c.usd.toFixed(2)}`;
  return { lines, usd };
}

/** Which limits the meter shows: a config dir's (null when unknown), and its label when more than one has data. */
export interface MeterPick { usage: Usage | null; configDir: string | null; label: string | null }

/**
 * The meter follows the selected session's Claude config dir: its limits, or none yet
 * (never another account's). A terminal with no dir (plain shell, no selection) keeps the dir shown last
 * (`lastShown`, undefined when nothing was shown in this window); with none, the latest update among this window's
 * dirs, else among all. Expired windows count as no data.
 */
export function meterUsage(list: UsageEntry[], selectedDir: string | undefined, windowDirs: readonly (string | undefined)[], lastShown: string | null | undefined, now = Date.now() / 1000): MeterPick {
  const live = list.filter((e) => (e.usage.fiveHour?.resetsAt ?? 0) > now || (e.usage.sevenDay?.resetsAt ?? 0) > now);
  const named = live.filter((e) => e.configDir !== null).length;
  const pick = (e: UsageEntry | undefined): MeterPick => ({
    usage: e?.usage ?? null, configDir: e?.configDir ?? null,
    label: e?.configDir && named > 1 ? (e.configDir.split('/').filter(Boolean).at(-1) ?? null) : null
  });
  const of = (dir: string | null) => live.find((e) => e.configDir === dir);
  if (selectedDir) return of(selectedDir) ? pick(of(selectedDir)) : { usage: null, configDir: selectedDir, label: null };
  if (lastShown !== undefined && of(lastShown)) return pick(of(lastShown));
  const here = new Set(windowDirs.filter(Boolean));
  const latest = (xs: UsageEntry[]) => xs.reduce<UsageEntry | undefined>((a, e) => (!a || e.usage.updatedAt > a.usage.updatedAt ? e : a), undefined);
  return pick(latest(live.filter((e) => e.configDir !== null && here.has(e.configDir))) ?? latest(live));
}

/** Limits for the top-right meter: 5h and 7d, each with its time to reset; already expired windows are left out. */
export function usageParts(usage: Usage | null, now = Date.now() / 1000): { key: '5h' | '7d'; pct: number; reset: string }[] {
  if (!usage) return [];
  const out: { key: '5h' | '7d'; pct: number; reset: string }[] = [];
  if (usage.fiveHour && usage.fiveHour.resetsAt > now) out.push({ key: '5h', pct: usage.fiveHour.pct, reset: formatReset(usage.fiveHour.resetsAt, now) });
  if (usage.sevenDay && usage.sevenDay.resetsAt > now) out.push({ key: '7d', pct: usage.sevenDay.pct, reset: formatReset(usage.sevenDay.resetsAt, now) });
  return out;
}
