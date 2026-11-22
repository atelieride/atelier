// What a paired phone sees of this computer: its projects (by opaque ids, never paths) and the terminals in them,
// each with the state Atelier shows. Pure: the remote hub feeds it the terminals, the open windows, the recent
// projects and the color settings, and sends the result whenever it changes.
import { createHash } from 'node:crypto';
import { effectiveState } from '@shared/background';
import { projectColorOf, type ProjectColors } from '@shared/project-color';
import type { TerminalInfo } from '@shared/protocol';
import { isLimitPaused, waitKind } from '@shared/session-view';
import { isShell } from '@shared/shells';
import type { RemoteProject, RemoteSession } from './messages';

/** b64url(SHA-256(root)), its first 16 characters: stable for a project, and nothing of its path. */
export const projectIdOf = (root: string): string => createHash('sha256').update(root, 'utf8').digest('base64url').slice(0, 16);

const nameOf = (root: string): string => root.split('/').filter(Boolean).at(-1) ?? root;

/**
 * The state a session's badge shows: background work counts as running, a session paused at its usage limit is idle.
 * A plain terminal is running while a command is in front of its shell.
 */
function shownState(t: TerminalInfo): RemoteSession['state'] {
  if (!t.session) return isShell(t.foreground) ? 'idle' : 'running';
  if (isLimitPaused(t.session)) return 'idle';
  return effectiveState(t) ?? 'idle';
}

export interface StateInput {
  terminals: readonly TerminalInfo[];
  /** The roots of the open project windows, in order. */
  open: readonly string[];
  recent: readonly string[];
  colors: { projectTint: boolean; projectColors: ProjectColors };
}

export interface RemoteState {
  projects: RemoteProject[];
  sessions: RemoteSession[];
  /** Project id → root: what a phone's `create` resolves against (only listed projects). */
  roots: Map<string, string>;
}

export function remoteState(i: StateInput): RemoteState {
  const byAge = [...i.terminals].sort((a, b) => a.createdAt - b.createdAt);
  const order: string[] = [];
  const add = (root: string) => { if (!order.includes(root)) order.push(root); };
  i.open.forEach(add);
  byAge.forEach((t) => add(t.projectRoot));
  i.recent.forEach(add);
  const open = new Set(i.open);
  const roots = new Map(order.map((root) => [projectIdOf(root), root]));
  const projects = order.map((root) => ({ id: projectIdOf(root), name: nameOf(root), color: projectColorOf(i.colors, root), open: open.has(root) }));
  const sessions = byAge.map((t): RemoteSession => {
    const state = shownState(t);
    // What it waits for, by the shared definition (a usage-limit pause is no wait).
    const wait = isLimitPaused(t.session) ? null : waitKind(t.session);
    return {
      id: t.id, project: projectIdOf(t.projectRoot), title: t.title, claude: t.session !== null, state,
      ...(wait === 'permission' || wait === 'question' ? { waitingFor: wait } : {}),
      createdAt: t.createdAt
    };
  });
  return { projects, sessions, roots };
}
