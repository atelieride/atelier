// What the sidebar, a workspace's card and its empty state show. Pure.
import type { Resumable, TerminalInfo } from '@shared/protocol';
import { dots, memberOf, workspaceOf, workspacesOf, type Dot, type WorkspacesState } from './workspaces';
import { t } from './i18n/en';
import { resumablesFor } from './selectors';
import { buildRows } from './changes';
import type { RepoStatus } from '@shared/git';
import type { Attribution } from '@shared/attribution';

/** A workspace's color as a theme token (theme.css `--ws-1…8`): components never hold the hex. */
export const wsColorVar = (color: number): string => `var(--ws-${color})`;

/** The Go menu's workspace list (activities aside) and the one its check marks: the workspace in front, whichever of its places is. */
export function workspacesMenu(ws: WorkspacesState): { names: string[]; active: number } {
  const wss = workspacesOf(ws);
  const here = workspaceOf(ws, ws.active);
  return { names: wss.map((w) => w.name), active: Math.max(0, wss.findIndex((w) => w.id === here)) };
}

/** A place's terminals, exactly that place's (one without a place belongs to the place in front). */
export function inWorkspace(ws: WorkspacesState, id: string, terminals: TerminalInfo[]): TerminalInfo[] {
  return terminals.filter((x) => memberOf(ws, x.id) === id);
}

/** Workspace `id`'s terminals in every place of it: its own and its activities'. */
export function inWorkspaceTree(ws: WorkspacesState, id: string, terminals: TerminalInfo[]): TerminalInfo[] {
  return terminals.filter((x) => workspaceOf(ws, memberOf(ws, x.id)) === id);
}

/** This project's sessions to resume that belong to place `id` (a gone or unknown place: the one in front). */
export function resumablesIn(ws: WorkspacesState, id: string, resumables: Resumable[], root: string): Resumable[] {
  return resumablesFor(resumables, root).filter((r) => memberOf(ws, r.id) === id);
}

/** Workspace `id`'s sessions to resume, in every place of it. */
function resumablesInTree(ws: WorkspacesState, id: string, resumables: Resumable[], root: string): Resumable[] {
  return resumablesFor(resumables, root).filter((r) => workspaceOf(ws, memberOf(ws, r.id)) === id);
}

export interface WsCard {
  dots: Dot[];
  sessions: number;
  terminals: number;
  files: number;
  /** Its other tabs still open: tables and files at a commit. */
  tabs: number;
  /** The folder's last segment (its chip), or null. */
  folder: string | null;
  empty: boolean;
  /** Its accessible name and tooltip: the name, then what the dots say. */
  label: string;
}

/**
 * What a click on a sidebar row does. `away`: the row is another workspace's; `detail`: the
 * click's count (0 from the keyboard). ⌥: open to the side. A row in front, or the keyboard: go at once. Another
 * workspace's row waits a double-click's time (a double-click renames it there); its second click does nothing.
 */
export function rowClickAction(away: boolean, detail: number, alt: boolean): 'side' | 'now' | 'wait' | 'none' {
  if (alt) return 'side';
  if (!away || detail === 0) return 'now';
  return detail === 1 ? 'wait' : 'none';
}

/** A folded head's one dot: the first state present, most urgent first, or null. */
export function headDot(dots: Dot[]): Dot | null {
  for (const kind of ['waiting', 'working', 'done', 'resume'] as const) {
    const d = dots.find((x) => x.kind === kind);
    if (d) return d;
  }
  return null;
}

const DOT_WORDS: Record<Dot['kind'], string> = { waiting: 'waiting', working: 'working', done: 'done', resume: 'to resume' };

/**
 * A card: state dots, what's inside (sessions, terminals, file tabs and other tabs still open), the folder chip.
 * `openTabs`: the keys of the files at a commit open in the window (a workspace holding only those is not empty) —
 * required, so no caller counts them as gone. Tables are Databases', never a workspace's.
 */
export function cardOf(ws: WorkspacesState, id: string, terminals: TerminalInfo[], resumables: Resumable[], root: string, openFiles: string[], openTabs: readonly string[]): WsCard {
  const w = ws.list.find((x) => x.id === id);
  // Every place of it: its own tabs and its activities'.
  const mine = inWorkspaceTree(ws, id, terminals);
  const toResume = resumablesInTree(ws, id, resumables, root).length;
  const keys = [...new Set(ws.list.filter((x) => x.id === id || x.parent === id).flatMap((x) => x.order))];
  const { files, tabs } = openCounts(keys, openFiles, openTabs);
  const d = dots(mine, toResume);
  const sessions = mine.filter((x) => !!x.session).length;
  const empty = mine.length === 0 && files === 0 && tabs === 0 && toResume === 0;
  const said = d.map((x) => `${x.n} ${DOT_WORDS[x.kind]}`).join(', ');
  return {
    dots: d, sessions, terminals: mine.length - sessions, files, tabs,
    folder: w?.folder ? w.folder.split(/[\\/]/).filter(Boolean).at(-1) ?? null : null,
    empty, label: `${w?.name ?? ''} · ${empty ? 'empty' : said || 'idle'}`
  };
}

/** How many of `keys` are files open in the window, and files at a commit open. */
function openCounts(keys: readonly string[], openFiles: string[], openTabs: readonly string[]): { files: number; tabs: number } {
  const open = new Set(openFiles);
  const others = new Set(openTabs);
  return {
    files: keys.filter((k) => k.startsWith('f:') && open.has(k.slice(2))).length,
    tabs: keys.filter((k) => k.startsWith('rev:') && others.has(k)).length
  };
}

export interface WsActivityCard {
  dots: Dot[];
  empty: boolean;
  /** Its accessible name and tooltip: the name, then what is inside ("SSO · 1 needs you · 1 terminal"), or "empty". */
  label: string;
}

/** An activity's head: its state dots (folded, one shows) and what is inside, for its tooltip. */
export function wsActivityCard(ws: WorkspacesState, id: string, terminals: TerminalInfo[], resumables: Resumable[], root: string, openFiles: string[], openTabs: readonly string[]): WsActivityCard {
  const a = ws.list.find((x) => x.id === id);
  const mine = inWorkspace(ws, id, terminals);
  const toResume = resumablesIn(ws, id, resumables, root).length;
  const { files, tabs } = openCounts(a?.order ?? [], openFiles, openTabs);
  const d = dots(mine, toResume);
  const n = (kind: Dot['kind']) => d.find((x) => x.kind === kind)?.n ?? 0;
  const sessions = mine.filter((x) => !!x.session).length;
  const summary = t.wsAct.summary({
    waiting: n('waiting'), working: n('working'), done: n('done'), idle: sessions - n('waiting') - n('working') - n('done'),
    terminals: mine.length - sessions, files: files + tabs, resume: toResume
  });
  return { dots: d, empty: mine.length === 0 && files === 0 && tabs === 0 && toResume === 0, label: `${a?.name ?? ''} · ${summary}` };
}

/**
 * Changes' "This workspace": every row but the ones
 * only other workspaces' sessions touched — sure, unclear (every candidate) or maybe. Changes nobody's session made
 * (by hand, an editor, a script) show in every workspace: Changes is about the working tree, not only Claude's edits
 *. A session counts for another workspace while it keeps one (running, or waiting to be resumed); one that
 * ended without, or a new running one not placed yet, is no other workspace's. An unclear entry's candidates are its
 * `ids` (terminal ids; `unclear` holds their titles, for the tooltip).
 */
export function changesInWorkspace<R extends { by: { terminalId: string; ids?: string[] }[] }>(ws: WorkspacesState, rows: R[]): R[] {
  const known = new Set(ws.list.map((w) => w.id));
  // Places of one workspace are one scope: an activity's sessions count for its workspace.
  const here = workspaceOf(ws, ws.active);
  const elsewhere = (id: string) => id in ws.members && known.has(ws.members[id]!) && workspaceOf(ws, ws.members[id]!) !== here;
  const othersOnly = (r: R) => r.by.length > 0 && r.by.every((b) => (b.ids ?? [b.terminalId]).every(elsewhere));
  return rows.filter((r) => !othersOnly(r));
}

let counted: { ws: WorkspacesState; repos: RepoStatus[]; attributions: Attribution[]; n: number } | null = null;
/**
 * The strip's Changes count under This workspace. A store selector runs on every update: the
 * count is computed again only when what it reads changed.
 */
export function wsChangeCount(ws: WorkspacesState, repos: RepoStatus[], attributions: Attribution[]): number {
  const c = counted;
  if (c && c.ws === ws && c.repos === repos && c.attributions === attributions) return c.n;
  const n = changesInWorkspace(ws, buildRows(repos, attributions)).length;
  counted = { ws, repos, attributions, n };
  return n;
}
