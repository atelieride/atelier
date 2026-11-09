// Workspaces per project root: saved in localStorage with the same rules as the pins
// and the split layout, so a window has them synchronously, before its first terminal list is placed. What an entry
// holds is checked when it is read (parseWorkspaces).
import { parseWorkspaces, type WorkspacesState } from './workspaces';

export const WS_KEY = 'atelier.workspaces';
/** Projects come and go: the least recently saved ones are forgotten past this many. */
export const MAX_WS_PROJECTS = 50;

function entries(): [string, unknown][] {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(WS_KEY) ?? '{}');
    return v && typeof v === 'object' && !Array.isArray(v) ? Object.entries(v as Record<string, unknown>) : [];
  } catch { return []; }
}

/** This project's workspaces, or null (none saved, or nothing usable). */
export function loadWorkspaces(root: string): WorkspacesState | null {
  const hit = entries().find(([r]) => r === root);
  return hit ? parseWorkspaces(hit[1]) : null;
}

/** Saves this project's workspaces (it becomes the most recent project); null removes them. */
export function saveWorkspaces(root: string, state: WorkspacesState | null): void {
  try {
    const rest = entries().filter(([r]) => r !== root);
    if (state) rest.push([root, state]);
    localStorage.setItem(WS_KEY, JSON.stringify(Object.fromEntries(rest.slice(-MAX_WS_PROJECTS))));
  } catch { /* not saved: stays for this session */ }
}
