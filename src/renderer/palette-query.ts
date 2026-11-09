import { CONNECTOR_IDS, type ConnectorId } from '@shared/tasks';
import type { Starting } from './starting';

export type PaletteMode = 'all' | 'commands' | 'sessions' | 'line' | 'resume' | 'tasks' | 'scheduled' | 'workspaces';

export interface PaletteQuery {
  mode: PaletteMode;
  text: string;
  line?: number;
  /** `clickup:` / `notion:`: one connector's tasks only. */
  source?: ConnectorId;
}

/**
 * Palette prefixes: ">" commands, "@" sessions, ":n" line of the active file, "resume:" sessions to resume, "task:"
 * every connector's tasks, "clickup:" / "notion:" one connector's (case-sensitive, like the others), "scheduled:" every
 * scheduled prompt, "#" workspaces while the project uses them (otherwise # is searched as typed).
 */
export function parseQuery(raw: string, opts: { workspaces?: boolean } = {}): PaletteQuery {
  const q = raw.trimStart();
  if (q.startsWith('>')) return { mode: 'commands', text: q.slice(1).trim() };
  if (q.startsWith('@')) return { mode: 'sessions', text: q.slice(1).trim() };
  if (opts.workspaces && q.startsWith('#')) return { mode: 'workspaces', text: q.slice(1).trim() };
  if (q.startsWith('resume:')) return { mode: 'resume', text: q.slice(7).trim() };
  if (q.startsWith('task:')) return { mode: 'tasks', text: q.slice(5).trim() };
  if (q.startsWith('scheduled:')) return { mode: 'scheduled', text: q.slice(10).trim() };
  const source = CONNECTOR_IDS.find((id) => q.startsWith(`${id}:`));
  if (source) return { mode: 'tasks', source, text: q.slice(source.length + 1).trim() };
  if (q.startsWith(':')) {
    const text = q.slice(1).trim();
    const n = /^\d+$/.test(text) ? Number(text) : NaN;
    return n >= 1 ? { mode: 'line', text, line: n } : { mode: 'line', text };
  }
  return { mode: 'all', text: q.trim() };
}

/** The palette's two groups, as in the sidebar: Claude sessions (starting ones too) and plain terminals. */
export function splitTerminals<T extends { id: string; session: unknown }>(terminals: T[], starting: Starting): { sessions: T[]; plain: T[] } {
  const sessions: T[] = [];
  const plain: T[] = [];
  for (const x of terminals) (x.session || starting[x.id] !== undefined ? sessions : plain).push(x);
  return { sessions, plain };
}

/** Palette arrows: one step through `length` items, wrapping around both ends (0 for an empty list). */
export function stepActive(active: number, delta: 1 | -1, length: number): number {
  if (length <= 0) return 0;
  const from = Math.min(Math.max(active, 0), length - 1);
  return (from + delta + length) % length;
}
