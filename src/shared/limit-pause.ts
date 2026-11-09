// Claude Code's usage-limit pause: the pure decisions atelierd takes about a
// session stopped by a usage limit. Types only from session.ts: session.ts imports these functions at runtime.
import type { LimitPauseEnd, SessionInfo, Usage } from './session';

/** The first Claude Code that waits at the limit and continues by itself when it resets. */
export const MIN_WAIT_VERSION = '2.1.234';
/** How long atelierd looks for proof that a rate_limit error is a usage limit. */
export const CHECK_MS = 5_000;
/** A pause whose reset passed this long ago without a continuation is over. */
export const EXPIRE_AFTER_RESET_MS = 600_000;
/** A reset further away than this is not waited for. */
export const MAX_WAIT_MS = 86_400_000;

/** The latest reset of a usage window at ≥ 100 % that is still ahead, in ms; null when the account isn't limited. */
export function limitResetAt(usage: Usage | null | undefined, now: number): number | null {
  let out: number | null = null;
  for (const w of [usage?.fiveHour, usage?.sevenDay]) {
    if (!w || w.pct < 100) continue;
    const at = w.resetsAt * 1000;
    if (at > now && (out === null || at > out)) out = at;
  }
  return out;
}

/** Paused = a usage-limit error whose wait has not ended (checking included). */
export function isLimitPaused(s: SessionInfo | null | undefined): boolean {
  return s?.state === 'error' && s.errorReason === 'rate_limit' && !!s.limitPause && !s.limitPause.over;
}

/** The version in a foreground process name (Claude Code's binary is named after its version), else null. */
export function claudeVersion(foreground: string | null | undefined): string | null {
  if (!foreground) return null;
  const base = foreground.split('/').pop() ?? '';
  const name = base.startsWith('-') ? base.slice(1) : base;
  return /^\d+(\.\d+){1,3}$/.test(name) ? name : null;
}

/** Two dotted versions compared numerically part by part (a missing or non-numeric part is 0): < 0, 0 or > 0. */
export function compareVersions(a: string, b: string): number {
  const x = a.split('.').map(Number);
  const y = b.split('.').map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] || 0) - (y[i] || 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** Claude Code at `version` waits at the limit; an unknown version counts as waiting. */
export function waitsAtLimit(version: string | null): boolean {
  return version === null || compareVersions(version, MIN_WAIT_VERSION) >= 0;
}

function latestAhead(windows: readonly (Usage['fiveHour'] | undefined)[], now: number, minPct: number): number | null {
  let out: number | null = null;
  for (const w of windows) {
    if (!w || w.pct < minPct) continue;
    const at = w.resetsAt * 1000;
    if (at > now && (out === null || at > out)) out = at;
  }
  return out;
}

/**
 * When the limit resets (ms), or null without proof. A: a window at ≥ 100 % with a reset ahead, over every usage given.
 * B: the error message names the window ("hit your session limit" / "weekly limit") and that window's reset is known.
 */
export function limitEvidence(usages: readonly (Usage | null | undefined)[], message: unknown, now: number): number | null {
  const all = usages.flatMap((u) => (u ? [u.fiveHour, u.sevenDay] : []));
  const a = latestAhead(all, now, 100);
  if (a !== null) return a;
  const text = typeof message === 'string' ? message : '';
  if (/hit your session limit/i.test(text)) return latestAhead(usages.map((u) => u?.fiveHour), now, 0);
  if (/hit your weekly limit/i.test(text)) return latestAhead(usages.map((u) => u?.sevenDay), now, 0);
  return null;
}

/** The pause is over without a continuation: `over` set, the session unread so it shows as needing you. */
export function endLimitPause(s: SessionInfo, over: LimitPauseEnd): SessionInfo {
  const p = s.limitPause ?? { since: s.updatedAt, resetsAt: null };
  return { ...s, limitPause: { since: p.since, resetsAt: p.resetsAt, over }, unread: true };
}

/** What the evidence says for a pause that started at `now`: armed with its reset, or ended as unconfirmed. */
function armed(s: SessionInfo, reset: number, since: number, now: number): SessionInfo {
  if (reset - now > MAX_WAIT_MS) return endLimitPause({ ...s, limitPause: { since, resetsAt: null } }, 'unconfirmed');
  return { ...s, limitPause: { since, resetsAt: reset } };
}

/** A session just stopped by an error: start a pause (paused or checking) when it is a usage limit we may wait for. */
export function openLimitPause(
  s: SessionInfo,
  o: { usages: readonly (Usage | null | undefined)[]; message: unknown; version: string | null; autoContinue: boolean },
  now: number
): SessionInfo {
  if (s.state !== 'error' || s.errorReason !== 'rate_limit' || s.limitPause) return s;
  if (!waitsAtLimit(o.version) || !o.autoContinue) return s;
  // A pause opens quiet: it needs nothing while Claude Code waits; every end (endLimitPause) marks it unread again.
  const quiet: SessionInfo = { ...s, unread: false };
  const reset = limitEvidence(o.usages, o.message, now);
  if (reset === null) return { ...quiet, limitPause: { since: now, resetsAt: null } };
  return armed(quiet, reset, now, now);
}

/** A status line arrived while checking: only inside CHECK_MS and only with evidence A, so a late one never arms. */
export function confirmLimitPause(s: SessionInfo | null, usages: readonly (Usage | null | undefined)[], now: number): SessionInfo | null {
  if (!s || !isLimitPaused(s)) return s;
  const p = s.limitPause!;
  if (p.resetsAt !== null || now - p.since > CHECK_MS) return s;
  const reset = limitEvidence(usages, null, now);
  if (reset === null) return s;
  return armed(s, reset, p.since, now);
}

/** Time passing: a check that found nothing is unconfirmed; a reset long past with no continuation is expired. */
export function sweepLimitPause(s: SessionInfo, now: number): SessionInfo {
  if (!isLimitPaused(s)) return s;
  const p = s.limitPause!;
  if (p.resetsAt === null) return now - p.since > CHECK_MS ? endLimitPause(s, 'unconfirmed') : s;
  return now > p.resetsAt + EXPIRE_AFTER_RESET_MS ? endLimitPause(s, 'expired') : s;
}
