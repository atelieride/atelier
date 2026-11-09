import { readFileSync } from 'node:fs';
import { normalizeSaved, restoreBounds, type Bounds, type SavedPopout } from '@shared/popout';
import { ensureDir, writeFileAtomic } from '../daemon/fsutil';
import { dirname } from './cpath';
import { isAbsPath, toCanonical } from '@shared/paths';
import { normalizeHomes } from './terminal-homes';

/** A project window's place: its normal bounds (out of full screen), and whether it was maximized (zoomed on macOS). */
export type SavedWindow = Bounds & { maximized?: true };

/**
 * popouts: the pop-out windows a relaunch or a project reopen brings back; absent when none.
 * windows: where each project's window was and how big, by project root.
 * homes: terminals moved to another project's window, id → that root.
 */
export interface UiState { openProjects: string[]; recent: string[]; quitInfoShown?: boolean; /** Windows: the "still running in the notification area" notice was shown once. */ trayInfoShown?: boolean; popouts?: SavedPopout[]; windows?: Record<string, SavedWindow>; homes?: Record<string, string> }

const isStrArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string');
/** Folders as the app knows them (canonical; an older Windows build saved some as C:\…), each once. */
const roots = (v: unknown): string[] => (isStrArray(v) ? [...new Set(v.map((r) => toCanonical(r)))] : []);
const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function normalizeWindows(raw: unknown): Record<string, SavedWindow> {
  const out: Record<string, SavedWindow> = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [root, v] of Object.entries(raw as Record<string, unknown>)) {
    const b = v as Record<string, unknown> | null;
    if (!isAbsPath(root) || !b || typeof b !== 'object' || !num(b.x) || !num(b.y) || !num(b.width) || !num(b.height) || b.width <= 0 || b.height <= 0) continue;
    out[root] = { x: b.x, y: b.y, width: b.width, height: b.height, ...(b.maximized === true ? { maximized: true as const } : {}) };
  }
  return out;
}

export function loadUiState(file: string): UiState {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<Record<keyof UiState, unknown>>;
    const popouts = normalizeSaved(raw.popouts);
    const windows = normalizeWindows(raw.windows);
    const homes = normalizeHomes(raw.homes);
    return {
      openProjects: roots(raw.openProjects),
      recent: roots(raw.recent),
      ...(raw.quitInfoShown === true ? { quitInfoShown: true } : {}),
      ...(raw.trayInfoShown === true ? { trayInfoShown: true } : {}),
      ...(popouts.length ? { popouts } : {}),
      ...(Object.keys(windows).length ? { windows } : {}),
      ...(Object.keys(homes).length ? { homes } : {})
    };
  } catch {
    return { openProjects: [], recent: [] };
  }
}

export function saveUiState(file: string, state: UiState): void {
  const { popouts, windows, homes, ...rest } = state;
  const out = { ...rest, ...(popouts?.length ? { popouts } : {}), ...(windows && Object.keys(windows).length ? { windows } : {}), ...(homes && Object.keys(homes).length ? { homes } : {}) };
  writeFileAtomic(file, JSON.stringify(out, null, 2), 0o600);
}

/**
 * The UI state saved, never throwing: it is saved from window close handlers, where a throw would stop the close midway
 * (and show Electron's main-process error box). False, and logged, when it couldn't be written.
 */
export function saveUiStateLogged(file: string, state: UiState, log: (m: string) => void): boolean {
  try {
    ensureDir(dirname(file), 0o700);
    saveUiState(file, state);
    return true;
  } catch (e) {
    log(`${file} not saved: ${(e as Error).message}`);
    return false;
  }
}

interface PlacedWindow { isDestroyed(): boolean; isMinimized(): boolean; isFullScreen(): boolean; isMaximized(): boolean; getNormalBounds(): Bounds }

/**
 * Where a window is, to reopen it there: its normal bounds (a maximized window's own overhang the screen, by 8 px on
 * Windows) and whether it is maximized. Null in full screen: the screen's frame is no place to reopen at.
 */
export function placeOfWindow(win: PlacedWindow): SavedWindow | null {
  if (win.isDestroyed() || win.isFullScreen()) return null;
  const { x, y, width, height } = win.getNormalBounds();
  return { x, y, width, height, ...(win.isMaximized() ? { maximized: true as const } : {}) };
}

/**
 * Where a project window opens: in the place of the welcome window it replaces (unless minimized or in full screen),
 * else where it was last time (on a display still there), else centered (undefined).
 */
export function windowPlace(replacing: PlacedWindow | null | undefined, saved: SavedWindow | undefined, areas: Bounds[]): SavedWindow | undefined {
  const from = replacing && !replacing.isMinimized() ? placeOfWindow(replacing) : null;
  if (from) return from;
  if (!saved) return undefined;
  return { ...restoreBounds(saved, areas), ...(saved.maximized ? { maximized: true as const } : {}) };
}

/** A project window's place, kept for the next time it opens; projects neither open nor recent are forgotten. */
export function rememberWindow(state: UiState, root: string, bounds: SavedWindow): UiState {
  const keep = new Set([...state.openProjects, ...state.recent, root]);
  const windows = Object.fromEntries(Object.entries({ ...state.windows, [root]: bounds }).filter(([r]) => keep.has(r)));
  return { ...state, windows };
}

export function addRecent(state: UiState, root: string): UiState {
  return { ...state, recent: [root, ...state.recent.filter((r) => r !== root)].slice(0, 10) };
}

/** A recent folder forgotten (the welcome window's ×): the others keep their order; the folder itself is untouched. */
export function forgetRecent(state: UiState, root: string): UiState {
  return state.recent.includes(root) ? { ...state, recent: state.recent.filter((r) => r !== root) } : state;
}

/** Recents to offer in the welcome window: only folders that still exist. */
export function recentForWelcome(state: UiState, exists: (p: string) => boolean): string[] {
  return state.recent.filter(exists).slice(0, 6);
}
