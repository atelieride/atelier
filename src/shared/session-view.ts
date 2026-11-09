// How the app reads a session's richer state. Every v2.0 field is optional: an atelierd without the
// 'states2' capability sends none of them, and the session then reads exactly as before (missing = null/0/false).
import type { SessionInfo } from './session';
import { isLimitPaused } from './limit-pause';

// One shared helper for "waiting at a usage limit": nobody tests the field by hand.
export { isLimitPaused };

/** What a session waits for: a permission, an answer, or (atelierd without states2) something unspecified. */
export type WaitKind = 'permission' | 'question' | 'waiting';

/**
 * A permission or an answer only you can give. 'input' (the idle notice: the turn is over and the prompt is free) is
 * not waiting: that session goes to Ready for review or Idle like any finished one.
 */
export function waitKind(s: SessionInfo | null | undefined): WaitKind | null {
  if (!s) return null;
  if (s.waitingFor === 'permission' || s.waitingFor === 'question') return s.waitingFor;
  if (s.state === 'waiting' && s.waitingFor !== 'input') return 'waiting';
  return null;
}

export const isWaiting = (s: SessionInfo | null | undefined): boolean => waitKind(s) !== null;

/** The inbox's "Needs you": waiting for a permission or an answer, or stopped by an error. */
export const needsYou = (s: SessionInfo | null | undefined): boolean => isWaiting(s) || (s?.state === 'error' && !isLimitPaused(s));

/** "waiting: Bash npm test" (atelierd's activity while waiting) → "Bash npm test"; nothing when it names no target. */
export function waitTarget(activity: string | null | undefined): string | null {
  const m = /^waiting:\s*(.+)$/.exec(activity ?? '');
  const what = m?.[1]?.trim();
  return what && what !== 'question' && what !== 'permission' ? what : null;
}

const MODES: Record<string, string> = {
  default: 'Default', plan: 'Plan', acceptEdits: 'Accept edits', auto: 'Auto', dontAsk: "Don't ask", bypassPermissions: 'Bypass permissions'
};

/** The badge a session's mode earns next to its name: Plan, or Bypass when it skips permissions. */
export function modeBadge(mode: string | null | undefined): 'plan' | 'bypass' | null {
  return mode === 'plan' ? 'plan' : mode === 'bypassPermissions' ? 'bypass' : null;
}

/** Claude Code's permission mode in words (a mode Atelier doesn't know yet as it is). */
export function permissionModeLabel(mode: string): string {
  return MODES[mode] ?? mode;
}

/** "3 agents" while subagents run; nothing otherwise. */
export function agentsLabel(n: number | undefined): string | null {
  if (!n || n < 1) return null;
  return n === 1 ? '1 agent' : `${n} agents`;
}

/**
 * Subagents still working while the main agent is idle or done (background agents outlive the main turn): the row
 * shows that work (its chip) but the session's place in the inbox stays the main agent's.
 */
export function agentsInBackground(s: SessionInfo | null | undefined): boolean {
  return !!s && (s.subagents ?? 0) > 0 && (s.state === 'idle' || s.state === 'done');
}

const V2_FIELDS = ['waitingFor', 'compacting', 'subagents', 'errorReason', 'permissionMode', 'autoTitle'] as const;

/**
 * Without the 'states2' capability the app trusts none of the v2.0 fields (whatever an atelierd might send): sessions
 * read exactly as with an atelierd from before v2.0. Terminals with nothing to drop are returned as they are.
 */
export function withoutStates2<T extends { session: SessionInfo | null }>(list: T[]): T[] {
  return list.map((x) => {
    const s = x.session;
    if (!s || !V2_FIELDS.some((k) => k in s)) return x;
    const rest: Record<string, unknown> = { ...s };
    for (const k of V2_FIELDS) delete rest[k];
    return { ...x, session: rest as unknown as SessionInfo };
  });
}

/**
 * Without the 'background' capability the app trusts no `background` field: sessions read exactly
 * as before it. Terminals with nothing to drop are returned as they are.
 */
export function withoutBackground<T extends { session: SessionInfo | null }>(list: T[]): T[] {
  return list.map((x) => {
    if (!x.session || !('background' in x.session)) return x;
    const { background: _dropped, ...rest } = x.session;
    return { ...x, session: rest };
  });
}
