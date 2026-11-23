// A session's row as a phone draws it, by the sidebar's own rules: the section grouping by state puts it in, the
// second line under its name, what a permission request is for, and a key for the wait it is in now. Pure, English,
// local time: the phone shows these words as they are.
import { createHash } from 'node:crypto';
import { effectiveState } from '@shared/background';
import { reasonLabel } from '@shared/notifications';
import type { TerminalInfo } from '@shared/protocol';
import type { SessionInfo } from '@shared/session';
import { isLimitPaused, needsYou, waitKind, waitTarget } from '@shared/session-view';

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
 * What an answerable wait is about (its kind and target), or null when the row can't answer it: an answer goes only to
 * the request the dialog on screen shows, so one that names none (only "Needs permission") is answered in the session.
 */
function answerable(s: SessionInfo | null): string | null {
  if (!s || isLimitPaused(s) || waitKind(s) !== 'permission' || isPlanApproval(s)) return null;
  const target = waitTarget(s.activity);
  return target === null ? null : `permission\u0000${target}`;
}

/**
 * Keys of the waits sessions are in, one per wait: a permission the row can answer (not a plan, not a question), by
 * its terminal, kind, target and when it began. Later events of the same wait (a subagent's tool call) leave its key
 * alone; a wait that ends and comes again is a new one. `update` follows every terminal list, so an end is seen.
 */
export class WaitBook {
  private waits = new Map<string, { what: string; since: number }>();

  update(list: readonly Pick<TerminalInfo, 'id' | 'session'>[]): void {
    const next = new Map<string, { what: string; since: number }>();
    for (const t of list) {
      const w = this.see(t);
      if (w) next.set(t.id, w);
    }
    this.waits = next;
  }

  keyOf(t: Pick<TerminalInfo, 'id' | 'session'>): string | null {
    const w = this.see(t);
    if (!w) return null;
    this.waits.set(t.id, w);
    return createHash('sha256').update(JSON.stringify([t.id, w.what, w.since]), 'utf8').digest('base64url').slice(0, 22);
  }

  /** The wait a terminal is in, as first seen (a new one when what it waits for changed). */
  private see(t: Pick<TerminalInfo, 'id' | 'session'>): { what: string; since: number } | null {
    const what = answerable(t.session);
    if (what === null) return null;
    const known = this.waits.get(t.id);
    return known?.what === what ? known : { what, since: t.session!.updatedAt };
  }
}
