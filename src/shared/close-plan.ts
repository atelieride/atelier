import type { TerminalInfo } from '@shared/protocol';
import { isClaudeProcess, isShell } from '@shared/shells';
import { effectiveState } from '@shared/background';
import { isLimitPaused, isWaiting } from '@shared/session-view';

/**
 * What closing a terminal stops: null for a shell at its prompt, which closes at once.
 * 'paused': Claude Code's continuation after a usage limit, asked like a turn. `quiet`: an idle session with nothing
 * beside it that closing would end (no background shell, agent, monitor or server, no cron or loop), so no work is
 * lost. A Claude whose session isn't detected yet is never quiet: what it is doing is unknown.
 */
export type CloseStops = { kind: 'claude'; doing: 'waiting' | 'working' | 'paused' | 'idle'; quiet?: true } | { kind: 'process'; what: string };

/**
 * Whether closing this terminal leaves its Claude session under Resume. `keep`: the
 * setting on and atelierd able to give it back (kill-resumable). A session with no message yet is not kept (its resume
 * would exit at once); one whose atelierd doesn't say (no lastMessageAt) is. A terminal with no session yet may be a
 * resume whose Claude hasn't started: atelierd decides what comes back.
 */
export function keptOnClose(t: TerminalInfo, keep: boolean): boolean {
  return keep && t.session?.lastMessageAt !== null;
}

/** Kept, with a Claude session the close question can talk about. */
export function keepsSession(t: TerminalInfo, keep: boolean): boolean {
  return !!t.session && keptOnClose(t, keep);
}

export function closeStops(t: TerminalInfo): CloseStops | null {
  if (t.session) {
    if (isWaiting(t.session)) return { kind: 'claude', doing: 'waiting' };
    if (isLimitPaused(t.session)) return { kind: 'claude', doing: 'paused' };
    if (effectiveState(t) === 'running') return { kind: 'claude', doing: 'working' };
    // Listed work that doesn't count (the setting off, past the cap, a server) and crons still end with the session.
    const alone = !t.work || (t.work.entries.length === 0 && t.work.crons.length === 0);
    return alone ? { kind: 'claude', doing: 'idle', quiet: true } : { kind: 'claude', doing: 'idle' };
  }
  if (isShell(t.foreground)) return null;
  if (isClaudeProcess(t.foreground)) return { kind: 'claude', doing: 'idle' };
  // The program's name: no path (either separator), no login dash, no .exe.
  return { kind: 'process', what: t.foreground.replace(/^-/, '').split(/[\\/]/).at(-1)?.replace(/\.exe$/i, '') || t.foreground };
}
