import { isClaudeProcess, isShell } from './shells';

// Restart Session: `/exit` at Claude's free prompt, then `claude --resume <id>` typed into the
// same shell. Pure: what a request does, and one step of a running restart from what the terminal shows.

/** Claude quits within this long of the `/exit` (its Enter's settle wait and MCP teardown included), or nothing more is typed. */
export const EXIT_MS = 8_000;
/** Something other than the shell in front this long after Claude quit (tmux, a wrapper script): stop. */
export const OTHER_MS = 2_000;
/** The shell shows its prompt within this long. */
export const SHELL_MS = 10_000;
/** The resumed session reports itself within this long (the "starting" window). */
export const RETURN_MS = 30_000;

/**
 * Whether the session's prompt takes a command now (the Session panel's rule), or why not. 'paused': Claude Code waits
 * to continue after a usage limit, busy like a working session.
 */
export type PromptAvailability = 'ok' | 'busy' | 'waiting' | 'paused' | 'draft' | 'not-claude';

export type RestartChoice = 'now' | 'confirm' | 'arm' | 'none';

/**
 * What Restart does: `work` = background items that would stop (agents, shells, monitors, tasks). Free and idle: now;
 * free with work running: asked first; otherwise armed, to run once Claude is done.
 */
export function restartChoice(a: PromptAvailability, work: number): RestartChoice {
  if (a === 'not-claude') return 'none';
  if (a === 'ok') return work > 0 ? 'confirm' : 'now';
  return 'arm';
}

/** After the `/exit` (since: when it went), the shell (otherSince: when another program came in front), the resume. */
export type RestartPhase =
  | { kind: 'exiting'; since: number }
  | { kind: 'shell'; since: number; otherSince: number | null }
  | { kind: 'relaunching'; since: number };

/** What the terminal shows now: in the list, its session's id (null: none), what is in front, the shell's prompt ready. */
export interface RestartObs { now: number; listed: boolean; sessionId: string | null; foreground: string; shellReady: boolean }

export type RestartOutcome = 'ok' | 'noExit' | 'notShell' | 'noReturn' | 'gone';

/** One step: the next phase (`type`: type the resume command now), or the end. */
export type RestartStep = { phase: RestartPhase; type?: true } | { done: RestartOutcome };

export function stepRestart(p: RestartPhase, sessionId: string, o: RestartObs): RestartStep {
  if (!o.listed) return { done: 'gone' };
  switch (p.kind) {
    case 'exiting':
      if (o.sessionId === null) return { phase: { kind: 'shell', since: o.now, otherSince: null } };
      return o.now - p.since > EXIT_MS ? { done: 'noExit' } : { phase: p };
    case 'shell': {
      if (o.sessionId !== null) return { done: 'ok' };
      if (o.shellReady) return { phase: { kind: 'relaunching', since: o.now }, type: true };
      // Claude's own process winding down (its SessionEnd comes first) is no other program.
      if (!isShell(o.foreground) && !isClaudeProcess(o.foreground)) {
        const otherSince = p.otherSince ?? o.now;
        return o.now - otherSince > OTHER_MS ? { done: 'notShell' } : { phase: otherSince === p.otherSince ? p : { ...p, otherSince } };
      }
      if (o.now - p.since > SHELL_MS) return { done: 'notShell' };
      return { phase: p.otherSince === null ? p : { ...p, otherSince: null } };
    }
    case 'relaunching':
      // Any session back in that terminal: the same id as a rule, a new one when a launch flag forks it.
      if (o.sessionId !== null) return { done: 'ok' };
      return o.now - p.since > RETURN_MS ? { done: 'noReturn' } : { phase: p };
  }
}
