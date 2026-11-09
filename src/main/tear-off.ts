// Tab tear-off: while a tab is dragged in a project window, a ghost window
// follows the pointer outside it, showing where the pop-out will open; released there, the pop-out takes the ghost's
// place. At most one ghost, only during a drag. No Electron here: windows, cursor, displays and timers come in as deps.
import { placeWindow, type Bounds, type GhostInfo, type Point, type TearStart } from '@shared/popout';

export type { GhostInfo, TearStart };

export interface GhostWin {
  setBounds(b: Bounds): void;
  setOpacity(o: number): void;
  destroy(): void;
  isDestroyed(): boolean;
  fill(info: GhostInfo): void;
  snapshot(url: string): void;
}

type Timer = { clear(): void };

export interface TearDeps {
  cursor(): Point;
  /** The displays' work areas. */
  displays(): Bounds[];
  /** The project window's bounds, null once it is gone (closed, its page reloading). */
  projectBounds(root: string): Bounds | null;
  /** A new ghost at these bounds, transparent (opacity 0) until shown; null when it can't be made. */
  createGhost(bounds: Bounds): GhostWin | null;
  /** An image of the project window's rect (client CSS pixels) as a data URL, null when it can't be taken. */
  snapshot(root: string, rect: Bounds): Promise<string | null>;
  /** Runs fn once the window with this webContents id is ready to show (at once if it is gone). */
  onceReady(winId: number, fn: () => void): void;
  setInterval(fn: () => void, ms: number): Timer;
  setTimer(fn: () => void, ms: number): Timer;
  /**
   * Another project's window in front under the pointer that can take the tab:
   * its root, the pointer as a client point of its page, and its drop hint (null clears it); null elsewhere.
   */
  across?(root: string, key: string, cursor: Point): Across | null;
}

export interface Across { root: string; point: Point; hover(p: Point | null): void }

/** The ghost handed over to the pop-out opening at its place. */
export interface Handover {
  bounds: Bounds;
  /** The pop-out's window (its webContents id), or null when the open failed: the ghost goes once it shows. */
  done(winId: number | null): void;
}

interface Tear {
  root: string;
  start: TearStart;
  timer: Timer;
  ghost: GhostWin | null;
  /** The pointer is outside the project window (the ghost shows, or fades in). */
  out: boolean;
  bounds: Bounds | null;
  opacity: number;
  /** createGhost failed once: not tried again for this drag. */
  failed: boolean;
  /** Ends a drag the renderer never ended. */
  life: Timer;
  snap: Timer | null;
  /** Over another project's window that takes the tab: no ghost, its hint shows there (the last point sent). */
  over: { root: string; hover(p: Point | null): void; point: Point } | null;
}

const TICK_MS = 16;
/** Opacity change per tick: about 60 ms from hidden to shown. */
const FADE_STEP = 0.25;
/** A pop-out that never says it is ready: the ghost goes anyway. */
const HANDOVER_GRACE_MS = 2000;
/** A drag the renderer never ended (a lost message): it stops by itself. */
const MAX_DRAG_MS = 600_000;
/** The snapshot waits a moment after the ghost: making both on one tick would stall the drag as the pointer leaves. */
const SNAPSHOT_DELAY_MS = 48;

export class TearOff {
  private tear: Tear | null = null;

  constructor(private readonly deps: TearDeps) {}

  /** A tab drag started in the project window of `root` (a previous drag, anywhere, ends). */
  start(root: string, start: TearStart): void {
    this.stop();
    const none = { clear() {} };
    const t: Tear = { root, start, timer: none, ghost: null, out: false, bounds: null, opacity: 0, failed: false, life: none, snap: null, over: null };
    t.timer = this.deps.setInterval(() => this.tick(t), TICK_MS);
    t.life = this.deps.setTimer(() => { if (this.tear === t) this.stop(); }, MAX_DRAG_MS);
    this.tear = t;
  }

  /** The drag ended without a pop-out (released inside, Esc, a lost pointer): the ghost goes. */
  end(root: string): void {
    if (this.tear?.root === root) this.stop();
  }

  /**
   * Released outside: the ghost on screen hands over to the pop-out (its bounds; it stays until that window is ready).
   * Null, and the drag ends, when no ghost is on screen.
   */
  takeOver(root: string): Handover | null {
    const t = this.tear;
    if (!t || t.root !== root) return null;
    const ghost = t.ghost;
    if (!ghost || ghost.isDestroyed() || !t.out || !t.bounds) { this.stop(); return null; }
    this.leave(t);
    this.clearTimers(t);
    this.tear = null;
    ghost.setOpacity(1);
    let grace: Timer | null = null;
    const drop = () => { grace?.clear(); if (!ghost.isDestroyed()) ghost.destroy(); };
    return {
      bounds: { ...t.bounds },
      done: (winId) => {
        if (winId === null) { drop(); return; }
        grace = this.deps.setTimer(drop, HANDOVER_GRACE_MS);
        this.deps.onceReady(winId, drop);
      }
    };
  }

  private stop(): void {
    const t = this.tear;
    if (!t) return;
    this.tear = null;
    this.leave(t);
    this.clearTimers(t);
    if (t.ghost && !t.ghost.isDestroyed()) t.ghost.destroy();
  }

  private clearTimers(t: Tear): void {
    t.timer.clear();
    t.life.clear();
    t.snap?.clear();
  }

  /** Away from another project's window: its hint goes. */
  private leave(t: Tear): void {
    t.over?.hover(null);
    t.over = null;
  }

  private tick(t: Tear): void {
    if (this.tear !== t) return;
    const main = this.deps.projectBounds(t.root);
    if (!main) { this.stop(); return; }
    const c = this.deps.cursor();
    t.out = !(c.x >= main.x && c.x < main.x + main.width && c.y >= main.y && c.y < main.y + main.height);
    // Over another project's window that takes it: that window's hint instead of the ghost.
    const across = t.out ? this.deps.across?.(t.root, t.start.key, c) ?? null : null;
    if (t.over && (!across || across.root !== t.over.root)) this.leave(t);
    if (across && (!t.over || t.over.point.x !== across.point.x || t.over.point.y !== across.point.y)) {
      across.hover(across.point);
      t.over = { root: across.root, hover: (p) => across.hover(p), point: across.point };
    }
    if (t.out) {
      const was = t.bounds;
      t.bounds = placeWindow({ cursor: c, size: t.start.size, main, areas: this.deps.displays(), cascade: 0 });
      if (!t.ghost) { if (!t.failed) this.make(t, t.bounds); }
      else if (!was || was.x !== t.bounds.x || was.y !== t.bounds.y || was.width !== t.bounds.width || was.height !== t.bounds.height) t.ghost.setBounds(t.bounds);
    }
    if (!t.ghost) return;
    const goal = t.out && !t.over ? 1 : 0;
    if (t.opacity === goal) return;
    const step = t.start.reduced ? 1 : FADE_STEP;
    t.opacity = goal > t.opacity ? Math.min(goal, t.opacity + step) : Math.max(goal, t.opacity - step);
    t.ghost.setOpacity(t.opacity);
  }

  /** The first time the pointer leaves: the ghost, filled with the tab, and its snapshot asked once. */
  private make(t: Tear, bounds: Bounds): void {
    const ghost = this.deps.createGhost(bounds);
    if (!ghost) { t.failed = true; return; }
    t.ghost = ghost;
    const { title, icon, color, reduced, theme } = t.start;
    ghost.fill({ title, icon, ...(color ? { color } : {}), ...(reduced ? { reduced } : {}), ...(theme ? { theme } : {}) });
    const rect = t.start.rect;
    if (!rect) return;
    t.snap = this.deps.setTimer(() => {
      t.snap = null;
      if (this.tear !== t) return;
      void this.deps.snapshot(t.root, rect).then((url) => {
        if (url && !ghost.isDestroyed()) ghost.snapshot(url);
      }).catch(() => {});
    }, SNAPSHOT_DELAY_MS);
  }
}
