// Tab pop-out windows: the pure part — which tabs, where windows go, what comes back
// after a relaunch, where a command typed in a pop-out goes. Main and renderer share it.
import type { MenuCommand } from './api';
import type { DbFilter } from './databases-filters';
import { isAbsPath } from './paths';
import type { SearchTarget } from './search';
import { isDbTabKey } from './tabs-state';
import type { ThemeId } from './themes';
import { isDockerTabKey, isRedisTabKey } from './view-keys';

export type PopoutKind = 'terminal' | 'file' | 'services' | 'review' | 'history' | 'background' | 'docker' | 'redis' | 'rev' | 'db';
export interface Bounds { x: number; y: number; width: number; height: number }
export interface Point { x: number; y: number }

export const POPOUT_MIN = { width: 480, height: 300 } as const;
/**
 * Where the pointer sits in a window placed under it: on the bar's grip — x its centre (layout.css: bar padding 14,
 * traffic lights 64, gap 8, grip margin 4, half the 22 px grip), y about the middle of the 46 px bar.
 */
export const HANDLE_OFFSET = { x: 101, y: 22 } as const;
/** The pop-out's bar (.popout-bar): what must stay on a display to grab the window. */
const BAR_HEIGHT = 46;
const GRAB = { width: 100, height: 40 } as const;
/** Pixels the pointer must travel before a handle press is a drag (a click never docks). */
export const DRAG_THRESHOLD = 4;
export const MAX_SAVED_PER_PROJECT = 16;
const CASCADE = 32;

/** What a tab needs besides its key to be shown again (plain JSON; files carry rel and mode). */
export type PopoutPayload =
  | { kind: 'file'; rel: string; mode: 'margin' | 'diff' }
  | { kind: 'review'; scope: string; againstMain?: boolean }
  | { kind: 'history'; repo: string; scope: unknown }
  | { kind: 'background'; terminalId: string; itemId: string | null }
  | { kind: 'docker'; target: unknown; view: 'logs' | 'inspect' }
  | { kind: 'redis'; view: unknown }
  | { kind: 'automations'; id: string | null; scope: 'project' | 'all' }
  | { kind: 'rev'; root: string; oid: string; rel: string }
  /**
   * A table tab: its connection, names (empty for the overview) and view; `rel`, the relation's
   * kind, keeps its icon where it lands. The key names the table: the receiving window reads the names from it. `open`:
   * an open asked in another window (not a tab moving): a preview or not, whether `view` was asked (else an open tab
   * keeps its own), a key's filters (its first row picked) and the inspector shown.
   */
  | {
    kind: 'db'; connId: string; schema: string; name: string; view: 'data' | 'structure' | 'relations'; rel?: 'table' | 'view' | 'matview';
    open?: { preview: boolean; view: boolean; filters?: readonly DbFilter[]; inspector?: boolean };
  }
  /** A session's Ask panel moves with its pane: open there when it was open here. */
  | { kind: 'terminal'; ask: boolean };

/** An editor moving between windows: CodeMirror's state JSON (doc, selection, history) and what saving needs. */
export interface EditorHandoff {
  path: string;
  state: { doc: string; selection: unknown; history?: unknown };
  saved: string | null;
  stamp: { mtimeMs: number; size: number; hash: string } | null;
  eol: 'lf' | 'crlf';
  scrollTop: number;
}

/** project()'s extra for a pop-out window: the tab it holds. */
export interface PopoutBoot { key: string; payload?: PopoutPayload }
export interface PopoutOpenRequest { key: string; payload?: PopoutPayload; handoff?: EditorHandoff; size: { width: number; height: number }; at: 'cursor' | 'cascade' }
/** moved / refused: released over another project's window, the tab moved there, or that window said no. */
export type PopoutOpenResult = { ok: true } | { ok: false; reason: 'inside' | 'failed' | 'moved' | 'refused' };
export interface DockRequest { payload?: PopoutPayload; handoff?: EditorHandoff }
/** To the main window: put this tab back (at: the client point it was dropped on, drag back only). */
export interface DockEvent { key: string; payload?: PopoutPayload; handoff?: EditorHandoff; at?: Point }
/**
 * To a pop-out: come forward for this (a line to go to, a newer payload for a singleton tab); `found`: a Find in Files
 * result at that line (one that keeps the keyboard where it is updates the window without bringing it forward).
 */
export interface PopoutReveal { line?: number; payload?: PopoutPayload; found?: SearchTarget }
/** From a pop-out: a tab other than its own to show in the project window (or in the pop-out that holds it). */
export interface ShowInMainRequest { key: string; payload?: PopoutPayload }
/** readOnly: a file the project held only read-only when main remembered it. */
export interface SavedPopout { root: string; key: string; bounds: Bounds; readOnly?: true }

// ── Moving a tab to another project's window ─────────────────────────────

/** An open project window another window may send a tab to: its root and its name (the folder's). */
export interface ProjectWindowInfo { root: string; name: string }
/** From a project window or a pop-out: this tab to `to`'s window (its buffer and view along; `at`: where it was dropped). */
export interface MoveRequest { to: string; key: string; payload?: PopoutPayload; handoff?: EditorHandoff; at?: Point }
/** refused: that window shows the file and the buffer has changes; session: a Claude session never moves (for now). */
export type MoveResult = { ok: true } | { ok: false; reason: 'refused' | 'failed' | 'session' };
/** To the target window: take this tab (answered with projectWindows.adopted), but never after `deadline` (epoch ms:
 *  past it the sender gave up and kept the tab). */
export interface AdoptRequest { id: number; key: string; payload?: PopoutPayload; handoff?: EditorHandoff; at?: Point; deadline: number }
/** open-there: it shows that file already and the buffer coming has unsaved changes. */
export interface AdoptAnswer { id: number; ok: boolean; reason?: 'open-there' }

/**
 * Tab tear-off: the glyph the ghost shows for the tab. 'session-tile': a session with avatars off, the
 * tile its tab shows.
 */
export type GhostIcon = 'session' | 'session-tile' | 'terminal' | 'file' | 'view';
/** What the ghost shows of the tab: its title, its glyph, a session's avatar colour (a CSS colour); reduced: no motion. */
/** theme: the one on screen, so the ghost matches the window it leaves. */
export interface GhostInfo { title: string; icon: GhostIcon; color?: string; reduced?: boolean; theme?: ThemeId }
/** A tab drag started in a project window (popout.tearStart). */
export interface TearStart extends GhostInfo {
  key: string;
  /** The pop-out's size (window pixels), as popout.open gets it. */
  size: { width: number; height: number };
  /** The tab's view on screen (client CSS pixels), for the ghost's snapshot; absent when it is not shown. */
  rect?: Bounds;
}

const SPECIAL: Record<string, PopoutKind> = { services: 'services', review: 'review', history: 'history', background: 'background' };

export function popoutKind(key: string): PopoutKind | null {
  if (key.startsWith('t:')) return key.length > 2 ? 'terminal' : null;
  if (key.startsWith('f:')) return key.length > 2 ? 'file' : null;
  if (key.startsWith('rev:')) return key.length > 4 ? 'rev' : null;
  if (key.startsWith('db:')) return isDbTabKey(key) ? 'db' : null;
  // A Docker tab: one per target, its key strictly shaped.
  if (key.startsWith('dk:')) return isDockerTabKey(key) ? 'docker' : null;
  // A Redis tab: one per view.
  if (key.startsWith('rd:')) return isRedisTabKey(key) ? 'redis' : null;
  return SPECIAL[key] ?? null;
}

/** What a relaunch brings back — terminals/sessions and files on disk, like the main window's own restore. */
export function restorable(key: string): boolean {
  const kind = popoutKind(key);
  if (kind === 'terminal') return true;
  return kind === 'file' && isAbsPath(key.slice(2));
}

// The session's Background (⌥⌘B) and its review: about the pop-out's session, shown in the project window (popped()).
// Ask (⌘I): the pop-out's own session, its panel inside the pop-out. Word wrap: a setting, switched where you are
// (sent to the project window, it would bring that window to the front).
const LOCAL = new Set<MenuCommand>(['save', 'save-all-and-close', 'comment-selection', 'next-change', 'prev-change', 'reveal-in-finder', 'md-toggle-preview', 'md-split', 'md-outline', 'session-panel', 'ask-session', 'send-review', 'show-background', 'review-session', 'toggle-word-wrap']);
const DOCK = new Set<MenuCommand>(['close-tab', 'move-tab-window', 'move-tab-back']);

/** A command from a pop-out — about its tab (local), moving it back (dock), Save All (every window), the rest (main). */
export function routeCommand(cmd: MenuCommand): 'local' | 'main' | 'dock' | 'everywhere' {
  if (DOCK.has(cmd)) return 'dock';
  if (LOCAL.has(cmd)) return 'local';
  if (cmd === 'save-all') return 'everywhere';
  return 'main';
}

const span = (a0: number, a1: number, b0: number, b1: number) => Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
const overlap = (a: Bounds, b: Bounds) => span(a.x, a.x + a.width, b.x, b.x + b.width) * span(a.y, a.y + a.height, b.y, b.y + b.height);

/** The window's bar shows on that display enough to grab it (100×40 px of it). */
function grabbable(b: Bounds, area: Bounds): boolean {
  const bar = Math.min(b.height, BAR_HEIGHT);
  return span(b.x, b.x + b.width, area.x, area.x + area.width) >= GRAB.width && span(b.y, b.y + bar, area.y, area.y + area.height) >= Math.min(GRAB.height, bar);
}

function clampInto(b: Bounds, area: Bounds): Bounds {
  const width = Math.min(Math.max(b.width, POPOUT_MIN.width), area.width);
  const height = Math.min(Math.max(b.height, POPOUT_MIN.height), area.height);
  const x = Math.min(Math.max(b.x, area.x), area.x + area.width - width);
  const y = Math.min(Math.max(b.y, area.y), area.y + area.height - height);
  return { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) };
}

export interface PlaceInput { cursor: Point | null; size: { width: number; height: number }; main: Bounds; areas: Bounds[]; cascade: number }

/** Under the cursor (drag out) or cascaded over the main window; always inside a display's work area. */
export function placeWindow(o: PlaceInput): Bounds {
  const want = o.cursor
    ? { x: o.cursor.x - HANDLE_OFFSET.x, y: o.cursor.y - HANDLE_OFFSET.y, width: o.size.width, height: o.size.height }
    : { x: o.main.x + (o.main.width - o.size.width) / 2 + CASCADE * o.cascade, y: o.main.y + (o.main.height - o.size.height) / 2 + CASCADE * o.cascade, width: o.size.width, height: o.size.height };
  const probe = o.cursor ? { ...o.cursor, width: 1, height: 1 } : want;
  const area = [...o.areas].sort((a, b) => overlap(b, probe) - overlap(a, probe))[0] ?? o.main;
  return clampInto(want, area);
}

/**
 * Saved bounds come back on the display where the window's bar can still be grabbed, clamped into it; when none shows
 * enough of it (a display gone, a sliver left), on the first one.
 */
export function restoreBounds(b: Bounds, areas: Bounds[]): Bounds {
  const area = areas.find((a) => grabbable(b, a)) ?? areas[0];
  return area ? clampInto(b, area) : b;
}

const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** ui-state.json's pop-outs: valid entries only, one per project and key (the last), at most 16 per project. */
export function normalizeSaved(raw: unknown): SavedPopout[] {
  if (!Array.isArray(raw)) return [];
  const ok: SavedPopout[] = [];
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue;
    const { root, key, bounds, readOnly } = r as Record<string, unknown>;
    const b = bounds as Record<string, unknown> | undefined;
    if (typeof root !== 'string' || !isAbsPath(root) || typeof key !== 'string' || !restorable(key)) continue;
    if (!b || !num(b.x) || !num(b.y) || !num(b.width) || !num(b.height) || b.width <= 0 || b.height <= 0) continue;
    const entry: SavedPopout = { root, key, bounds: { x: b.x, y: b.y, width: b.width, height: b.height }, ...(readOnly === true ? { readOnly: true as const } : {}) };
    const i = ok.findIndex((s) => s.root === root && s.key === key);
    if (i >= 0) ok.splice(i, 1);
    ok.push(entry);
  }
  const perRoot = new Map<string, number>();
  return ok.reverse().filter((s) => { const n = (perRoot.get(s.root) ?? 0) + 1; perRoot.set(s.root, n); return n <= MAX_SAVED_PER_PROJECT; }).reverse();
}

/** Drag back: the cursor over the main window's content, as a client point of its page (null: elsewhere). */
export function dockPoint(cursor: Point, content: Bounds, zoom: number): Point | null {
  const x = cursor.x - content.x;
  const y = cursor.y - content.y;
  if (x < 0 || y < 0 || x >= content.width || y >= content.height) return null;
  const z = zoom > 0 ? zoom : 1;
  return { x: Math.round(x / z), y: Math.round(y / z) };
}
