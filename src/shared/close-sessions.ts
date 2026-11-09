// A project window closing (or Atelier quitting) stops the window's terminals:
// what counts as busy, the question built from it and the mode in force.
import { effectiveState } from './background';
import { isLimitPaused, isWaiting } from './session-view';
import type { TerminalInfo } from './protocol';
import { pendingPrompt, type ScheduledPrompt } from './scheduled-prompts';

export type CloseMode = 'ask' | 'stop' | 'keep';
export const CLOSE_MODES: readonly CloseMode[] = ['ask', 'stop', 'keep'];

export type BusyKind = 'working' | 'waiting' | 'running' | 'scheduled' | 'paused';
export interface BusyItem { id: string; kind: BusyKind; title: string; color: string; session: boolean; command?: string }

/** One project's terminals as a close sees them: what is busy (in list order), how many idle ones go with it. */
export interface ProjectBusy { root: string; name: string; ids: string[]; busy: BusyItem[]; idleSessions: number; idleTerminals: number }

/** At most this many busy rows per project in the question; the rest are "+N more". */
export const BUSY_ROWS = 6;

const nameOf = (root: string) => root.split(/[\\/]/).filter(Boolean).at(-1) ?? root;

/**
 * The project's terminals, judged for a close. `foreground`: the shells running a command (terminal id → its text),
 * read by main; a Claude session is judged by its state, never by it.
 */
export function projectBusy(root: string, terminals: readonly TerminalInfo[], schedules: readonly ScheduledPrompt[], foreground: ReadonlyMap<string, string>): ProjectBusy {
  const mine = terminals.filter((t) => t.projectRoot === root);
  const scheduled = new Set(schedules.filter(pendingPrompt).map((p) => p.terminalId));
  const busy: BusyItem[] = [];
  let idleSessions = 0;
  let idleTerminals = 0;
  for (const t of mine) {
    const base = { id: t.id, title: t.title, color: t.color };
    if (t.session) {
      const state = effectiveState(t);
      // Paused at a usage limit: Claude Code continues by itself at the reset, so closing would cut that.
      const kind: BusyKind | null = state === 'running' ? 'working' : isWaiting(t.session) ? 'waiting' : isLimitPaused(t.session) ? 'paused' : scheduled.has(t.id) ? 'scheduled' : null;
      if (kind) busy.push({ ...base, kind, session: true }); else idleSessions += 1;
      continue;
    }
    // A command whose line could not be read ('') shows the terminal's title.
    const command = foreground.get(t.id);
    if (command !== undefined) busy.push({ ...base, kind: 'running', session: false, ...(command ? { command } : {}) });
    else idleTerminals += 1;
  }
  return { root, name: nameOf(root), ids: mine.map((t) => t.id), busy, idleSessions, idleTerminals };
}

export interface CloseSessionsProject {
  name: string;
  busy: Omit<BusyItem, 'id'>[];
  /** Busy items past BUSY_ROWS. */
  more: number;
  idleSessions: number;
  idleTerminals: number;
}

/** The question: only the projects with something busy; `windows` = how many of them. */
export interface CloseSessionsAsk { kind: 'close-sessions'; what: 'close' | 'quit'; windows: number; projects: CloseSessionsProject[] }

export function closeSessionsAsk(what: 'close' | 'quit', list: readonly ProjectBusy[]): CloseSessionsAsk {
  const projects = list.filter((p) => p.busy.length > 0).map((p) => ({
    name: p.name,
    busy: p.busy.slice(0, BUSY_ROWS).map(({ id: _id, ...rest }) => rest),
    more: Math.max(0, p.busy.length - BUSY_ROWS),
    idleSessions: p.idleSessions,
    idleTerminals: p.idleTerminals
  }));
  return { kind: 'close-sessions', what, windows: projects.length, projects };
}

/**
 * The mode in force: the setting, or `keep` when atelierd can't give stopped sessions back under Resume; a test
 * override (ATELIER_TEST_CLOSE_SESSIONS through devEnv) wins when it names a mode.
 */
export function effectiveCloseMode(setting: CloseMode, capable: boolean, override?: string): CloseMode {
  if (override && (CLOSE_MODES as readonly string[]).includes(override)) return override as CloseMode;
  return capable ? setting : 'keep';
}
