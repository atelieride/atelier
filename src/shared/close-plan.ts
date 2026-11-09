import type { TerminalInfo } from '@shared/protocol';
import { isClaudeProcess, isShell } from '@shared/shells';
import { effectiveState } from '@shared/background';
import { isLimitPaused, isWaiting } from '@shared/session-view';

/**
 * What closing a terminal stops: null for a shell at its prompt, which closes at once.
 * 'paused': Claude Code's continuation after a usage limit, asked like a turn.
 */
export type CloseStops = { kind: 'claude'; doing: 'waiting' | 'working' | 'paused' | 'idle' } | { kind: 'process'; what: string };

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
    return { kind: 'claude', doing: effectiveState(t) === 'running' ? 'working' : 'idle' };
  }
  if (isShell(t.foreground)) return null;
  if (isClaudeProcess(t.foreground)) return { kind: 'claude', doing: 'idle' };
  // The program's name: no path (either separator), no login dash, no .exe.
  return { kind: 'process', what: t.foreground.replace(/^-/, '').split(/[\\/]/).at(-1)?.replace(/\.exe$/i, '') || t.foreground };
}
