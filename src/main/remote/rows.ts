// A session's row as a phone draws it, by the sidebar's own rules: the section grouping by state puts it in, the
// second line under its name, what a permission request is for, and a key for the wait it is in now. Pure, English,
// local time: the phone shows these words as they are.
import { createHash } from 'node:crypto';
import { effectiveState } from '@shared/background';
import { reasonLabel } from '@shared/notifications';
import type { TerminalInfo } from '@shared/protocol';
import type { SessionInfo } from '@shared/session';
import { isLimitPaused, isWaiting, needsYou, waitKind, waitTarget } from '@shared/session-view';

export type RowSection = 'needs' | 'review' | 'working' | 'idle';

/** At most this many characters of a row's second line, and of a permission's target. */
export const MAX_DETAIL = 120;
export const MAX_PERMISSION = 60;

/** The words the sidebar's rows use, in English. */
const WORDS = {
  starting: 'Starting…',
  compacting: 'Compacting…',
  permission: 'Needs permission',
  question: 'Has a question',
  inBackground: 'In background',
  limitChecking: 'Usage limit',
  limitStale: 'Limit reset · press Enter to continue',
  /** The state in words when nothing else says more (the sidebar's state labels). */
  state: { running: 'working', waiting: 'waiting for you', error: 'error' } as Record<string, string>
};

/**
 * The section the sidebar groups a row in: Needs you (a permission, a question, an error that isn't a usage-limit
 * pause), Ready for review (finished, not seen), Working (running, background work counting, or paused at a usage
 * limit), Idle (the rest, plain terminals and starting sessions included).
 */
export function sectionOf(t: Pick<TerminalInfo, 'session' | 'work'>): RowSection {
  const s = t.session;
  if (!s) return 'idle';
  if (needsYou(s)) return 'needs';
  if (isLimitPaused(s)) return 'working';
  const state = effectiveState(t);
  if (state === 'done' && s.unread) return 'review';
  if (state === 'running') return 'working';
  return 'idle';
}

const pad = (n: number) => String(n).padStart(2, '0');
/** "14:30", local. */
const clockOf = (ms: number) => { const d = new Date(ms); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
/** Local midnight of `ms`'s day plus `offset` days. */
const dayOf = (ms: number, offset: number) => { const d = new Date(ms); return new Date(d.getFullYear(), d.getMonth(), d.getDate() + offset).getTime(); };
const sameDay = (a: number, b: number) => dayOf(a, 0) === dayOf(b, 0);
/** "Tue 27 Oct". */
const shortDate = (ms: number) => new Date(ms).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }).replace(',', '');
/** "today at 14:30", "tomorrow at 01:30", "Tue 27 Oct at 09:00". */
const whenOf = (at: number, now: number) => `${sameDay(at, now) ? 'today' : sameDay(at, dayOf(now, 1)) ? 'tomorrow' : shortDate(at)} at ${clockOf(at)}`;

/** Claude Code's usage-limit pause in words ("Usage limit · continues at 15:45"); null when it isn't paused. */
function limitText(s: SessionInfo, now: number): string | null {
  const p = s.limitPause;
  if (p && isLimitPaused(s)) {
    if (p.resetsAt === null) return WORDS.limitChecking;
    const at = p.resetsAt;
    // A reset already past keeps its clock, never yesterday's date.
    const clockOnly = at <= now || dayOf(at, 0) === dayOf(now, 0);
    return `Usage limit · continues ${clockOnly ? `at ${clockOf(at)}` : whenOf(at, now)}`;
  }
  if (s.state === 'error' && p?.over === 'stale') return WORDS.limitStale;
  return null;
}

const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

/**
 * The line under a session's name: "Starting…" before Claude starts, "Compacting…", what a wait asks for, the usage
 * limit, an error in words, "In background · <what>" while background work counts, what it is doing, else its state;
 * nothing when it is done or idle (the phone shows when the last message was instead) or for a plain terminal.
 */
export function detailOf(t: Pick<TerminalInfo, 'session' | 'work'>, o: { starting: boolean; now: number }): string | null {
  const s = t.session;
  if (!s) return o.starting ? WORDS.starting : null;
  return subtitleText(s, t.work, o.now);
}

function subtitleText(s: SessionInfo, work: TerminalInfo['work'], now: number): string | null {
  if (s.compacting) return WORDS.compacting;
  const wait = waitKind(s);
  if (wait === 'permission') { const target = waitTarget(s.activity); return clip(target ? `${WORDS.permission}: ${target}` : WORDS.permission, MAX_DETAIL); }
  if (wait === 'question') return WORDS.question;
  const limit = limitText(s, now);
  if (limit) return limit;
  if (s.state === 'error' && s.errorReason) return clip(reasonLabel(s.errorReason), MAX_DETAIL);
  if (work?.counting) {
    const label = work.items.find((i) => i.counted && i.label)?.label;
    return clip(label ? `${WORDS.inBackground} · ${label}` : WORDS.inBackground, MAX_DETAIL);
  }
  if (s.activity) return clip(s.activity, MAX_DETAIL);
  return s.state === 'done' || s.state === 'idle' ? null : WORDS.state[s.state] ?? null;
}

/** What a session waiting for a permission asks for ("Bash npm test"), when Claude Code says. */
export function permissionOf(s: SessionInfo | null): string | null {
  if (!s || isLimitPaused(s) || waitKind(s) !== 'permission') return null;
  const target = waitTarget(s.activity);
  return target ? clip(target, MAX_PERMISSION) : null;
}

/** A plan waiting for approval: its dialog asks something else than a tool's permission. */
export const isPlanApproval = (s: SessionInfo | null): boolean => waitKind(s) === 'permission' && waitTarget(s?.activity) === 'plan approval';

/**
 * A key of the wait a session is in now: its terminal, state, wait kind, activity and last update, hashed. A newer
 * request (another tool, another update) gets another key, so an answer meant for an earlier one is refused. Null
 * while the session isn't waiting.
 */
export function waitKeyOf(t: Pick<TerminalInfo, 'id' | 'session'>): string | null {
  const s = t.session;
  if (!s || isLimitPaused(s) || !isWaiting(s)) return null;
  const parts = [t.id, s.state, waitKind(s), s.activity ?? null, s.updatedAt];
  return createHash('sha256').update(JSON.stringify(parts), 'utf8').digest('base64url').slice(0, 22);
}
