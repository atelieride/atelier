// Restart Session and the new MCP servers it loads: the store's slice and the loop that
// follows a restart through the terminal — `/exit` at Claude's free prompt, the shell back, `claude --resume <id>`
// typed into it, the session back in the same terminal.
import type { TerminalInfo } from '@shared/protocol';
import type { McpAdded } from '@shared/claude-config';
import { workTotal } from '@shared/background';
import { isShell } from '@shared/shells';
import { pathStyle } from '@shared/platform';
import { markStarting, type Starting } from './starting';
import { restartChoice, stepRestart, type RestartOutcome, type RestartPhase } from '@shared/session-restart';
import type { AppState } from './store';
import { t } from './i18n/en';
import { panelAvailability, typeCommand } from './session-panel';
import { shellReady, typeInto } from './send-selection';
import { isBracketed, lastOutputAt } from './terminal/focus';
import { copyText } from './clipboard';

/** Armed: restarts once Claude is done. Running: past the `/exit`, with the command main built. */
export type Restart = { armed: true } | { armed: false; sessionId: string; command: string; phase: RestartPhase };

/** Where Restart was asked when it needs a question: the sidebar row, or the Session panel. */
export type RestartAt = 'row' | 'panel';

export interface RestartSlice {
  restarts: Readonly<Record<string, Restart>>;
  restartAsk: { id: string; at: RestartAt } | null;
  /** This project's sessions with MCP servers added since they started (main's). */
  mcpAdded: McpAdded;
  setMcpAdded(m: McpAdded): void;
  /** Restart Session: now, asked first (background work would stop), or armed until Claude is done. */
  restartSession(id: string, at?: RestartAt): void;
  /** Don't Restart: an armed restart goes (one already past its `/exit` runs to its end). */
  cancelRestart(id: string): void;
  /** The question's answers: restart now, when done, or not. */
  answerRestart(a: 'now' | 'later' | 'cancel'): void;
  /** The palette's Restart Sessions with New MCP Servers: the free ones now, the others when done. */
  restartWithNewMcp(): void;
}

/** Background items that a restart stops (agents, shells, monitors, tasks): asked about first. */
export function workOf(term: TerminalInfo): number {
  return term.work ? workTotal(term.work) : 0;
}

/**
 * The work an armed restart waits for: what still counts as work (a dev server Claude left running stops counting after
 * its cap, and crons never end), so "when done" always comes.
 */
export function busyWorkOf(term: TerminalInfo): number {
  return term.work ? term.work.items.filter((i) => i.counted).length : 0;
}

/** Terminals asking main for their command (between Restart and the `/exit`): never started twice. */
const preparing = new Set<string>();
let loop: ReturnType<typeof setInterval> | null = null;
const LOOP_MS = 100;

/** Tests: the loop stops with nothing left to follow. */
export function stopRestartLoop(): void {
  if (loop) clearInterval(loop);
  loop = null;
  preparing.clear();
}

/** A running restart's terminal whose session went: still a (starting) session, never a plain terminal for a moment. */
export function restartStarting(restarts: Readonly<Record<string, Restart>>, starting: Starting, terminals: readonly TerminalInfo[], now: number): Starting {
  let next = starting;
  for (const x of terminals) {
    const r = restarts[x.id];
    if (r && !r.armed && !x.session && next[x.id] === undefined) next = markStarting(next, x.id, now);
  }
  return next;
}

/** A shell whose output this window doesn't see (no tab shows it) gets the command after this long in front. */
export const UNSEEN_SHELL_MS = 1_500;

/**
 * The shell can take the resume command: the rule of Run in New Terminal (prompt drawn and quiet) when this window sees
 * the terminal's output; else the shell in front for UNSEEN_SHELL_MS (the tty keeps what is typed until zsh reads it).
 */
export function restartShellReady(foreground: string, bracketed: boolean, lastOutput: number, since: number, now: number): boolean {
  // Windows: atelierd names PowerShell as soon as the session clears, while claude.exe may still be quitting and
  // PSReadLine not drawn yet: never before the floor.
  if (pathStyle() === 'win32' && now - since < UNSEEN_SHELL_MS) return false;
  if (lastOutput > 0) return shellReady({ listed: true, foreground, bracketed, lastOutput, started: since, now });
  return isShell(foreground) && now - since >= UNSEEN_SHELL_MS;
}

export function createRestartSlice(set: (p: Partial<AppState>) => void, get: () => AppState): RestartSlice {
  const put = (id: string, r: Restart | null) => {
    const { [id]: _, ...rest } = get().restarts;
    set({ restarts: r ? { ...rest, [id]: r } : rest });
    if (Object.keys(get().restarts).length > 0) ensureLoop(); else if (loop) { clearInterval(loop); loop = null; }
  };
  const termOf = (id: string) => get().terminals.find((x) => x.id === id);

  const finish = (id: string, outcome: RestartOutcome, command: string) => {
    put(id, null);
    // Not back: no "Starting…" row left over, the terminal is the plain shell it is.
    if (outcome !== 'ok' && get().starting[id] !== undefined) {
      const { [id]: _, ...rest } = get().starting;
      set({ starting: rest });
    }
    const copy = { label: t.restart.copyCommand, run: () => void copyText(command) };
    if (outcome === 'noExit') get().showToast(t.restart.noExit);
    else if (outcome === 'notShell') get().showToast(t.restart.notShell, copy);
    else if (outcome === 'noReturn') get().showToast(t.restart.noReturn, copy);
  };

  /**
   * Main builds the command while the session is live; then `/exit`, if Claude's prompt still takes it and no work
   * started meanwhile. `wait`: the work that holds it back — all of it (a plain Restart), the work that counts (an
   * armed one), none (Restart now, after the question).
   */
  const start = async (id: string, wait: 'all' | 'busy' | 'none' = 'all') => {
    const term = termOf(id);
    if (!term?.session || preparing.has(id)) return;
    const sessionId = term.session.sessionId;
    preparing.add(id);
    let command: string;
    try {
      command = await window.atelier.claude.restartCommand(id, sessionId);
    } catch {
      preparing.delete(id);
      put(id, null);
      get().showToast(t.restart.failed);
      return;
    }
    preparing.delete(id);
    const now = termOf(id);
    if (now?.session?.sessionId !== sessionId) { put(id, null); return; }
    // Busy meanwhile (Claude took a prompt, an agent started): it waits armed instead.
    const work = wait === 'all' ? workOf(now) : wait === 'busy' ? busyWorkOf(now) : 0;
    if (restartChoice(panelAvailability(now), work) !== 'now') { put(id, { armed: true }); return; }
    if (!typeCommand(id, '/exit')) { put(id, null); return; }
    put(id, { armed: false, sessionId, command, phase: { kind: 'exiting', since: Date.now() } });
  };

  const tick = () => {
    const now = Date.now();
    for (const [id, r] of Object.entries(get().restarts)) {
      const term = termOf(id);
      if (r.armed) {
        if (!term?.session) { put(id, null); continue; }
        if (restartChoice(panelAvailability(term), busyWorkOf(term)) === 'now') void start(id, 'busy');
        continue;
      }
      const step = stepRestart(r.phase, r.sessionId, {
        now,
        listed: !!term,
        sessionId: term?.session?.sessionId ?? null,
        foreground: term?.foreground ?? '',
        shellReady: !!term && restartShellReady(term.foreground, isBracketed(id), lastOutputAt(id), r.phase.since, now)
      });
      if ('done' in step) { finish(id, step.done, r.command); continue; }
      // The resume as one paste, then its Enter once the shell has settled (the rule of Run in New Terminal).
      if (step.type) typeInto(id, r.command, true);
      if (step.phase !== r.phase) put(id, { ...r, phase: step.phase });
    }
  };

  function ensureLoop() {
    if (!loop) loop = setInterval(tick, LOOP_MS);
  }

  return {
    restarts: {},
    restartAsk: null,
    mcpAdded: {},
    setMcpAdded: (m) => set({ mcpAdded: m }),
    restartSession: (id, at = 'row') => {
      const term = termOf(id);
      const cur = get().restarts[id];
      if (!term?.session || (cur && !cur.armed) || preparing.has(id)) return;
      const choice = restartChoice(panelAvailability(term), workOf(term));
      if (choice === 'now') { void start(id); return; }
      if (choice === 'confirm') { set({ restartAsk: { id, at } }); return; }
      if (choice === 'arm' && !cur) put(id, { armed: true });
    },
    cancelRestart: (id) => {
      if (get().restarts[id]?.armed) put(id, null);
    },
    answerRestart: (a) => {
      const ask = get().restartAsk;
      set({ restartAsk: null });
      if (!ask || a === 'cancel') return;
      if (a === 'later') put(ask.id, { armed: true });
      else void start(ask.id, 'none');
    },
    restartWithNewMcp: () => {
      for (const id of Object.keys(get().mcpAdded)) {
        const term = termOf(id);
        if (!term?.session || get().restarts[id]) continue;
        // One question can't ask for several: a session with work running waits for it instead.
        if (restartChoice(panelAvailability(term), workOf(term)) === 'now') void start(id);
        else put(id, { armed: true });
      }
    }
  };
}
