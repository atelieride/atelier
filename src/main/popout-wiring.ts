// Tab pop-out windows among the app's windows: which window is "the project's", which roots stay open,
// where a menu command goes. Pure: index.ts passes its maps (wcId → project root, wcId → kind).
import type { MenuCommand } from '@shared/api';
import { routeCommand } from '@shared/popout';

export type WindowKind = 'project' | 'popout';
export interface WindowsView {
  /** Every window's project (null: the welcome window), pop-outs included. */
  projects: ReadonlyMap<number, string | null>;
  kinds: ReadonlyMap<number, WindowKind>;
}

/**
 * A pop-out's page itself loads anew (did-start-navigation): its main frame, a new document. An iframe loading inside it
 * (a preview, a docs view) or a same-page navigation isn't one, and never ends a drag.
 */
export const pageReloading = (d: { isMainFrame: boolean; isSameDocument: boolean }): boolean => d.isMainFrame && !d.isSameDocument;

export const isPopoutWindow = (v: WindowsView, wcId: number): boolean => v.kinds.get(wcId) === 'popout';

/** The project's main window (one per folder); a pop-out never is. */
export function projectWindowId(v: WindowsView, root: string): number | null {
  for (const [id, r] of v.projects) if (r === root && !isPopoutWindow(v, id)) return id;
  return null;
}

/** The projects to reopen on the next launch: those with a project window, once each. */
export function openProjectRoots(v: WindowsView): string[] {
  return [...new Set(mainWindows(v).map(([, r]) => r).filter((r): r is string => !!r))];
}

/** Project and welcome windows: what opening a file or folder from macOS may target. */
export function mainWindows(v: WindowsView): [number, string | null][] {
  return [...v.projects].filter(([id]) => !isPopoutWindow(v, id));
}

/** A window the app could come forward with: `usedAt` is when it last had the focus or was brought forward (0: never). */
export interface FrontCandidate { id: number; popout: boolean; usedAt: number }

/**
 * The window the app comes forward with (a second launch, Open Atelier): the one in use, as macOS brings an app forward,
 * pop-outs included; never simply the first, which undid a banner click's session window when macOS launched a newer
 * copy of the bundle (a staged update, a local build) and it handed over. None used yet: the first project or welcome
 * window, else the first window. Null: no window.
 */
export function windowToFront(wins: readonly FrontCandidate[]): number | null {
  const used = wins.filter((w) => w.usedAt > 0).sort((a, b) => b.usedAt - a.usedAt)[0];
  return (used ?? wins.find((w) => !w.popout) ?? wins[0])?.id ?? null;
}

/**
 * Forwarded commands whose project window comes forward only if their outcome shows there: F4 / ⇧F4 walk the project
 * window's search results, and one in the pop-out's own file is shown in the pop-out, which stays in front (the project
 * window asks to come forward itself when the result opens in it).
 */
const QUIET_FORWARD = new Set<MenuCommand>(['next-search-result', 'prev-search-result']);

/** A menu command a pop-out forwards: run in its project window (none: nothing), as given there, which comes forward. */
export function forwardCommand<W>(cmd: MenuCommand, win: W | null, d: { send(win: W, cmd: MenuCommand, from: 'popout'): void; reveal(win: W): void }): void {
  if (win === null) return;
  d.send(win, cmd, 'popout');
  if (!QUIET_FORWARD.has(cmd)) d.reveal(win);
}

/**
 * How a window learns where a command was given: 'popout' when a pop-out (`source`) sends it on to another window,
 * whose page then knows the keyboard and the selection the user means are not its own.
 */
export function commandFrom(source: number, receiver: number, v: WindowsView): 'popout' | undefined {
  return receiver !== source && isPopoutWindow(v, source) ? 'popout' : undefined;
}

/** Where a menu command aimed at a window goes: windows that get it, one to bring forward, a pop-out to move back. */
export interface CommandPlan { send: number[]; reveal: number | null; close: number | null }

/** Rule 9: a pop-out keeps its tab's commands, docks on Close Tab/Move Back, sends the rest to its project window. */
export function commandPlan(cmd: MenuCommand, wcId: number, v: WindowsView): CommandPlan {
  const none: CommandPlan = { send: [], reveal: null, close: null };
  const root = v.projects.get(wcId);
  /** The project window first, then its pop-outs. */
  const everywhere = (r: string) => {
    const main = projectWindowId(v, r);
    const popouts = [...v.projects].filter(([id, x]) => x === r && isPopoutWindow(v, id)).map(([id]) => id);
    return { ...none, send: [...(main === null ? [] : [main]), ...popouts.sort((a, b) => a - b)] };
  };
  if (!isPopoutWindow(v, wcId) || !root) {
    // Save All from the project window saves its pop-outs' files too.
    return root && routeCommand(cmd) === 'everywhere' ? everywhere(root) : { ...none, send: [wcId] };
  }
  switch (routeCommand(cmd)) {
    case 'local': return { ...none, send: [wcId] };
    case 'dock': return { ...none, close: wcId };
    case 'everywhere': return everywhere(root);
    case 'main': {
      const main = projectWindowId(v, root);
      return main === null ? none : { ...none, send: [main], reveal: main };
    }
  }
}
