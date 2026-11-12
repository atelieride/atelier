// Tab pop-out windows: the main-process core. Which pop-out windows exist and for which
// tab, where they go, how a tab comes back (dock, close, drag back), what a project close or a relaunch does with
// them, and what ui-state.json remembers. No Electron here: windows, cursor, displays and timers come in as deps.
import { basename } from 'node:path';
import { IPC } from '@shared/api';
import {
  DRAG_THRESHOLD, dockPoint, placeWindow, restorable, restoreBounds,
  type Bounds, type DockEvent, type DockRequest, type EditorHandoff, type MoveResult, type Point, type PopoutOpenRequest,
  type PopoutOpenResult, type PopoutPayload, type PopoutReveal, type SavedPopout
} from '@shared/popout';
import type { Handover } from './tear-off';
import { isBelow, trimOneSep } from '@shared/paths';

/** A pop-out BrowserWindow as the manager sees it (id: its webContents id). */
export interface PopoutWin {
  id: number;
  getBounds(): Bounds; setPosition(x: number, y: number): void; setOpacity(o: number): void;
  isFullScreen(): boolean; isMinimized(): boolean;
  close(): void; destroy(): void; isDestroyed(): boolean;
  send(channel: string, payload?: unknown): void;
  /** Window events, and its page's: 'page-gone' (render-process-gone), 'page-loading' (its main frame navigating anew: pageReloading). */
  on(event: 'close' | 'closed' | 'moved' | 'resized' | 'resize' | 'page-gone' | 'page-loading', fn: (e: { preventDefault(): void }) => void): void;
}
/** A project's main window (id: its webContents id). */
export interface ProjectWin { id: number; getContentBounds(): Bounds; getBounds(): Bounds; zoom(): number; send(channel: string, payload?: unknown): void; reveal(): void }
export interface PopoutDeps {
  /**
   * createPopoutWindow + register the hubs. onUnloadCancel: the user picked Cancel in its unsaved-files dialog;
   * onUnloadKept: the dialog kept the page (Save All or Cancel).
   */
  create(root: string, bounds: Bounds, title: string, onUnloadCancel: () => void, onUnloadKept: () => void): PopoutWin;
  projectWindow(root: string): ProjectWin | null;
  reveal(win: PopoutWin): void;
  cursor(): Point;
  /** The displays' work areas. */
  displays(): Bounds[];
  /**
   * A file pop-out may be remembered (popoutFileRules): main reads it now, so it may grant it again on restore. The path
   * to save it under (an outside file: the real path it is granted by), or null.
   */
  remember(root: string, path: string): string | null;
  /**
   * The project holds that remembered outside file only read-only now: remembered so.
   * Absent: never.
   */
  readOnly?(root: string, path: string): boolean;
  /**
   * A remembered file can come back (on disk; outside the project: granted again, before its window loads), read-only
   * when it was remembered so.
   */
  restoreFile(root: string, path: string, readOnly?: boolean): boolean;
  loadSaved(): SavedPopout[]; save(saved: SavedPopout[]): void;
  setTimer(fn: () => void, ms: number): { clear(): void };
  setInterval(fn: () => void, ms: number): { clear(): void };
  /**
   * A tab torn off: the ghost on screen for the project, handed over to the pop-out opening at its
   * place (TearOff.takeOver), or null.
   */
  takeTear?(root: string): Handover | null;
  /**
   * Moving tabs between projects' windows: the project window under a
   * screen point (the front one), with its root; whether this pop-out's tab may go to another project's window; and the
   * release over one, handed to the mover (this window closes once the tab moved).
   */
  windowAt?(p: Point): (ProjectWin & { root: string }) | null;
  canMove?(root: string, key: string, to: string): boolean;
  moveAcross?(wcId: number, r: DockRequest, to: string, at: Point): Promise<MoveResult>;
}

type Timer = { clear(): void };

interface Entry {
  win: PopoutWin;
  root: string;
  key: string;
  payload?: PopoutPayload;
  handoff?: EditorHandoff;
  /** Set when a close must go through: 'forced' (no answer to evPopoutClose, or no project window to dock into),
   *  'project' (the project window is closing; the saved entry stays). */
  closing?: 'forced' | 'project';
  /** Another project's window is deciding on its tab: no dock, close or drag. */
  held?: boolean;
  /**
   * Its close was under way when another window cancelled the project close: if that close still goes through, the
   * window comes back (the project stays open). A fresh close request or a kept page clears it.
   */
  reopen?: boolean;
  /**
   * The key ui-state.json remembers it under, or null (not restorable, or a file main couldn't read when it popped out).
   * An outside file: its real path (the page's spelling may be a link).
   */
  savedKey: string | null;
  saveTimer?: Timer;
  closeTimer?: Timer;
  /** closeForProject waiting on this window. */
  waiter?: { closed(): void; cancelled(): void };
}

interface Drag {
  start: Bounds;
  startCursor: Point;
  offset: Point;
  point: Point | null;
  moved: boolean;
  timer: Timer;
  /** The window the point is in (its own project's, or another project's that can take the tab), and that one's root. */
  over: ProjectWin | null;
  across: string | null;
}

const CLOSE_GRACE_MS = 2000;
const SAVE_DEBOUNCE_MS = 400;
const DRAG_TICK_MS = 16;
const DRAG_OPACITY = 0.55;

const samePoint = (a: Point | null, b: Point | null) => (a === null || b === null ? a === b : a.x === b.x && a.y === b.y);

export class PopoutManager {
  /** Set on before-quit: closes go through and saved entries stay (they come back on the next launch). */
  quitting = false;
  private readonly entries = new Map<number, Entry>();
  /** Saved terminals of an open project waiting for atelierd's first list (restore with alive === null). */
  private waiting: SavedPopout[] = [];
  private saved: SavedPopout[];
  private readonly drags = new Map<number, Drag>();
  /** closeForProject in flight per project: a second call gets the same answer. */
  private readonly projectCloses = new Map<string, Promise<boolean>>();

  constructor(private readonly deps: PopoutDeps) {
    this.saved = [...deps.loadSaved()];
  }

  isPopout(wcId: number): boolean {
    return this.entries.has(wcId);
  }

  entryOf(wcId: number): { root: string; key: string; payload?: PopoutPayload } | null {
    const e = this.entries.get(wcId);
    return e ? { root: e.root, key: e.key, payload: e.payload } : null;
  }

  /** The keys the project's main window must treat as popped out: live windows, then saved ones waiting to come back. */
  keys(root: string): string[] {
    return [...this.liveOf(root).map((e) => e.key), ...this.waiting.filter((s) => s.root === root).map((s) => s.key)];
  }

  /** Live pop-out windows of the project (the ones a project close has to close). */
  live(root: string): number {
    return this.liveOf(root).length;
  }

  /** A project close is waiting on the project's pop-outs (closeForProject in flight). */
  closingProject(root: string): boolean {
    return this.projectCloses.has(root);
  }

  windowFor(root: string, key: string): PopoutWin | null {
    return this.find(root, key)?.win ?? null;
  }

  open(root: string, r: PopoutOpenRequest): PopoutOpenResult {
    if (this.find(root, r.key)) {
      this.focus(root, r.key, r.payload ? { payload: r.payload } : undefined);
      return { ok: true };
    }
    const project = this.deps.projectWindow(root);
    if (!project) return { ok: false, reason: 'failed' };
    let cursor: Point | null = null;
    // Released outside during a tab drag: the ghost under the pointer gives its place, and goes once this one shows.
    const tear = r.at === 'cursor' ? this.deps.takeTear?.(root) ?? null : null;
    if (r.at === 'cursor') {
      cursor = this.deps.cursor();
      const b = project.getBounds();
      if (cursor.x >= b.x && cursor.x < b.x + b.width && cursor.y >= b.y && cursor.y < b.y + b.height) {
        tear?.done(null);
        return { ok: false, reason: 'inside' };
      }
    }
    const bounds = tear?.bounds ?? placeWindow({ cursor, size: r.size, main: project.getBounds(), areas: this.deps.displays(), cascade: this.live(root) });
    this.dropWaiting(root, r.key);
    const e = this.spawn(root, r.key, bounds, r.payload, r.handoff);
    tear?.done(e ? e.win.id : null);
    if (!e) return { ok: false, reason: 'failed' };
    this.persist();
    this.announce(root);
    return { ok: true };
  }

  /**
   * Save As of the untitled buffer a pop-out holds: its window holds the file now (`from` must be its own key). The
   * project window learns the new key, ui-state.json remembers the file like any other, a reload shows it.
   */
  rekey(wcId: number, from: string, to: string): boolean {
    const e = this.entries.get(wcId);
    if (!e || e.key !== from || !from.startsWith('f:') || !to.startsWith('f:')) return false;
    // Another pop-out holds that file already: one window per tab, as the main window merges two tabs of one file. This
    // one goes (its buffer was just written: nothing is lost, the other reads the file again) and that one comes forward.
    const other = this.find(e.root, to);
    if (other && other !== e) {
      this.forget(e);
      if (e.savedKey) this.unsave(e.root, e.savedKey);
      if (!e.win.isDestroyed()) e.win.destroy();
      this.deps.reveal(other.win);
      this.announce(e.root);
      return false;
    }
    if (e.savedKey) this.unsave(e.root, e.savedKey, false);
    e.key = to;
    e.payload = { kind: 'file', rel: this.relOf(e.root, to.slice(2)), mode: 'margin' };
    e.savedKey = this.savedKeyOf(e.root, to);
    if (e.savedKey) this.upsert(this.savedEntry(e.root, e.savedKey, e.win.getBounds()));
    this.persist();
    this.announce(e.root);
    return true;
  }

  takeHandoff(wcId: number): EditorHandoff | null {
    const e = this.entries.get(wcId);
    if (!e?.handoff) return null;
    const h = e.handoff;
    delete e.handoff;
    return h;
  }

  focus(root: string, key: string, reveal?: PopoutReveal): boolean {
    const e = this.find(root, key);
    if (!e) return false;
    // A search result walked with the keyboard staying in its list: the window shows it where it is, the keyboard stays.
    if (!reveal?.found?.keepFocus) this.deps.reveal(e.win);
    if (reveal && (reveal.line !== undefined || reveal.payload)) {
      if (reveal.payload) e.payload = reveal.payload;
      e.win.send(IPC.evPopoutReveal, reveal);
    }
    return true;
  }

  /** Move Back from the main window: the pop-out answers evPopoutClose with a dock (its handoff on board). */
  recall(root: string, key: string): void {
    const e = this.find(root, key);
    if (e) { e.win.send(IPC.evPopoutClose); return; }
    if (this.waiting.some((s) => s.root === root && s.key === key)) {
      this.dropWaiting(root, key);
      this.unsave(root, key);
      this.announce(root);
    }
  }

  dock(wcId: number, r: DockRequest, at?: Point): void {
    const e = this.entries.get(wcId);
    // Closing with its project: the window is already going (its unsaved guard asks), nothing to dock into. Held: its
    // tab may be going to another project's window right now.
    if (!e || e.closing === 'project' || e.held) return;
    this.endDragOf(e);
    const project = this.deps.projectWindow(e.root);
    if (!project) {
      // The project window is gone (closed meanwhile): nothing to dock into, the window closes with its unsaved guard.
      e.closing = 'forced';
      e.win.close();
      return;
    }
    const payload = r.payload ?? e.payload;
    const ev: DockEvent = { key: e.key, ...(payload ? { payload } : {}), ...(r.handoff ? { handoff: r.handoff } : {}), ...(at ? { at } : {}) };
    project.send(IPC.evDock, ev);
    project.reveal();
    this.forget(e);
    if (!this.quitting && e.savedKey) this.unsave(e.root, e.savedKey);
    if (!e.win.isDestroyed()) e.win.destroy();
    this.announce(e.root);
  }

  /**
   * Its tab went to another project's window: the window goes for good,
   * nothing docks home and nothing is asked (its buffer went along); the project window learns it is gone.
   */
  release(wcId: number): void {
    const e = this.entries.get(wcId);
    if (!e) return;
    this.forget(e);
    if (e.savedKey) this.unsave(e.root, e.savedKey);
    if (!e.win.isDestroyed()) e.win.destroy();
    this.announce(e.root);
  }

  /** A pop-out's 'close' (red light, ⌘W from the system): it docks instead, unless quitting or already closing. */
  closeRequested(wcId: number, ev: { preventDefault(): void }): void {
    const e = this.entries.get(wcId);
    if (!e || this.quitting || e.closing) return;
    ev.preventDefault();
    if (e.held) return;
    e.reopen = undefined;
    e.win.send(IPC.evPopoutClose);
    e.closeTimer?.clear();
    e.closeTimer = this.deps.setTimer(() => {
      e.closeTimer = undefined;
      if (this.entries.get(wcId) !== e || e.win.isDestroyed() || e.closing) return;
      e.closing = 'forced';
      e.win.close();
    }, CLOSE_GRACE_MS);
  }

  /** The project window is closing: close its pop-outs (each with its unsaved guard). False as soon as one cancels. */
  closeForProject(root: string): Promise<boolean> {
    const inFlight = this.projectCloses.get(root);
    if (inFlight) return inFlight;
    // Saved terminals still waiting for atelierd won't come back into a closed project (they stay saved).
    const waiting = this.waiting.filter((s) => s.root === root);
    this.waiting = this.waiting.filter((s) => s.root !== root);
    const list = this.liveOf(root);
    if (list.length === 0) return Promise.resolve(true);
    let settled = false;
    const done = new Promise<boolean>((resolve) => {
      const pending = new Set(list);
      const settle = (ok: boolean) => {
        if (settled) return;
        settled = true;
        this.projectCloses.delete(root);
        if (!ok) {
          // Cancelled: the survivors are ordinary pop-outs again, and the waiting terminals wait again.
          // Those whose own close is still under way come back if it goes through (closed()).
          for (const e of list) {
            if (this.entries.get(e.win.id) !== e) continue;
            if (e.closing === 'project') { e.closing = undefined; e.reopen = true; }
            e.waiter = undefined;
          }
          this.waiting.push(...waiting.filter((s) => !this.waiting.some((w) => w.root === s.root && w.key === s.key)));
        }
        resolve(ok);
      };
      for (const e of list) {
        e.closeTimer?.clear();
        e.closeTimer = undefined;
        e.closing = 'project';
        e.waiter = {
          closed: () => { pending.delete(e); if (pending.size === 0) settle(true); },
          cancelled: () => settle(false)
        };
      }
      for (const e of list) if (this.entries.get(e.win.id) === e && !e.win.isDestroyed()) e.win.close();
    });
    // A close that settled synchronously (every window closed at once) leaves nothing in flight.
    if (!settled) this.projectCloses.set(root, done);
    return done;
  }

  /**
   * An outside file the project may edit now (a gesture upgraded its read grant): a pop-out remembered
   * read-only for it is remembered editable at once (it may never move again before the app quits).
   */
  editable(root: string, real: string): void {
    const key = `f:${real}`;
    const i = this.saved.findIndex((s) => s.root === root && s.key === key && s.readOnly);
    if (i < 0) return;
    const { readOnly: _, ...rest } = this.saved[i]!;
    this.saved[i] = rest;
    this.persist();
  }

  /** The project window loaded: bring back its saved pop-outs (alive: atelierd's terminal ids, null before its list). */
  restore(root: string, aliveTerminals: string[] | null): void {
    let changed = false;
    for (const s of this.saved.filter((x) => x.root === root)) {
      // Live already (under its saved key, or the spelling it was popped out with), or waiting for atelierd.
      if (this.find(root, s.key) || this.liveOf(root).some((e) => e.savedKey === s.key) || this.waiting.some((w) => w.root === root && w.key === s.key)) continue;
      if (s.key.startsWith('f:')) {
        const path = s.key.slice(2);
        if (this.deps.restoreFile(root, path, s.readOnly === true)) this.spawnSaved(s);
        else this.unsave(root, s.key, false);
        changed = true;
      } else if (s.key.startsWith('t:')) {
        if (aliveTerminals === null) this.waiting.push(s);
        else if (aliveTerminals.includes(s.key.slice(2))) this.spawnSaved(s);
        else this.unsave(root, s.key, false);
        changed = true;
      }
    }
    if (changed) this.persist();
    this.announce(root);
  }

  /** atelierd's terminal list (always the full list): waiting terminals come back or go, ended ones close. */
  terminalsChanged(list: { id: string; projectRoot: string }[]): void {
    const alive = new Set(list.map((t) => t.id));
    const roots = new Set<string>();
    const waiting = this.waiting;
    this.waiting = [];
    for (const s of waiting) {
      if (alive.has(s.key.slice(2))) this.spawnSaved(s);
      else this.unsave(s.root, s.key, false);
      roots.add(s.root);
    }
    for (const e of [...this.entries.values()]) {
      if (!e.key.startsWith('t:') || alive.has(e.key.slice(2))) continue;
      this.forget(e);
      this.unsave(e.root, e.key, false);
      if (!e.win.isDestroyed()) e.win.destroy();
      roots.add(e.root);
    }
    if (roots.size === 0) return;
    this.persist();
    for (const root of roots) this.announce(root);
  }

  /** While another project's window decides on its tab: no dock, close (it stays open) or drag. */
  hold(wcId: number, on: boolean): void {
    const e = this.entries.get(wcId);
    if (e) e.held = on || undefined;
  }

  dragStart(wcId: number): void {
    const e = this.entries.get(wcId);
    if (!e || e.held) return;
    this.endDragOf(e);
    const start = e.win.getBounds();
    const c = this.deps.cursor();
    const drag: Drag = { start, startCursor: c, offset: { x: c.x - start.x, y: c.y - start.y }, point: null, moved: false, timer: { clear() {} }, over: null, across: null };
    drag.timer = this.deps.setInterval(() => this.dragTick(e, drag), DRAG_TICK_MS);
    this.drags.set(wcId, drag);
  }

  /** Released: docked over its project's window; over another project's, the mover's answer (null: no move tried). */
  dragEnd(wcId: number, r: DockRequest): Promise<MoveResult> | null {
    const e = this.entries.get(wcId);
    const drag = this.drags.get(wcId);
    if (!e || !drag) return null;
    const point = this.sample(e, drag);
    const across = drag.across;
    this.endDragOf(e);
    if (drag.moved && point && across && this.deps.moveAcross) {
      // Until the other window answers the pop-out stays where it was dropped (and stays there if it says no).
      this.scheduleSave(e);
      return this.deps.moveAcross(wcId, r, across, point);
    }
    if (drag.moved && point) this.dock(wcId, r, point);
    else this.scheduleSave(e); // left where it was dropped: setPosition fires no 'moved'
    return null;
  }

  dragCancel(wcId: number): void {
    const e = this.entries.get(wcId);
    const drag = this.drags.get(wcId);
    if (!e || !drag) return;
    this.endDragOf(e);
    if (!e.win.isDestroyed()) e.win.setPosition(drag.start.x, drag.start.y);
  }

  // ---- internals ----

  private liveOf(root: string): Entry[] {
    return [...this.entries.values()].filter((e) => e.root === root);
  }

  private find(root: string, key: string): Entry | undefined {
    return [...this.entries.values()].find((e) => e.root === root && e.key === key);
  }

  private spawn(root: string, key: string, bounds: Bounds, payload?: PopoutPayload, handoff?: EditorHandoff): Entry | null {
    let entry: Entry | null = null;
    let win: PopoutWin;
    try {
      win = this.deps.create(root, bounds, basename(root), () => { if (entry) this.unloadCancelled(entry); }, () => { if (entry) this.unloadKept(entry); });
    } catch {
      return null;
    }
    const savedKey = this.savedKeyOf(root, key);
    entry = { win, root, key, savedKey, ...(payload ? { payload } : {}), ...(handoff ? { handoff } : {}) };
    const e = entry;
    this.entries.set(win.id, e);
    win.on('close', (ev) => this.closeRequested(win.id, ev));
    win.on('closed', () => this.closed(e));
    win.on('moved', () => this.scheduleSave(e));
    win.on('resized', () => this.scheduleSave(e));
    // macOS says 'resized' only after a live resize: Zoom (a double click on the bar), Fill and tiling resize without one.
    win.on('resize', () => this.scheduleSave(e));
    // A page that crashes or reloads mid-drag never sends its drag end: the drag stops, the window goes back.
    win.on('page-gone', () => this.dragCancel(win.id));
    win.on('page-loading', () => this.dragCancel(win.id));
    if (savedKey) this.upsert(this.savedEntry(root, savedKey, bounds));
    return e;
  }

  /** What ui-state.json remembers: a file with the mode the project holds it in now. */
  private savedEntry(root: string, key: string, bounds: Bounds): SavedPopout {
    const ro = key.startsWith('f:') && !!this.deps.readOnly?.(root, key.slice(2));
    return { root, key, bounds, ...(ro ? { readOnly: true as const } : {}) };
  }

  /** The key ui-state.json remembers a pop-out of `key` under (see Entry.savedKey). */
  private savedKeyOf(root: string, key: string): string | null {
    if (!restorable(key)) return null;
    if (!key.startsWith('f:')) return key;
    const path = this.deps.remember(root, key.slice(2));
    return path ? `f:${path}` : null;
  }

  private spawnSaved(s: SavedPopout): void {
    const payload: PopoutPayload | undefined = s.key.startsWith('f:') ? { kind: 'file', rel: this.relOf(s.root, s.key.slice(2)), mode: 'margin' } : undefined;
    if (!this.spawn(s.root, s.key, restoreBounds(s.bounds, this.deps.displays()), payload)) this.unsave(s.root, s.key, false);
  }

  private relOf(root: string, path: string): string {
    const base = trimOneSep(root);
    return isBelow(base, path) ? path.slice(base.length + 1) : path;
  }

  /**
   * A page kept during a project close (Save All): the close can't wait on a save that may fail (its page then never
   * closes), so it is cancelled like a Cancel. Other closes ('forced') go on once the page closes itself.
   */
  private unloadKept(e: Entry): void {
    if (this.entries.get(e.win.id) !== e) return;
    e.reopen = undefined;
    if (e.closing === 'project') this.unloadCancelled(e);
  }

  private unloadCancelled(e: Entry): void {
    if (this.entries.get(e.win.id) !== e) return;
    e.closing = undefined;
    e.reopen = undefined;
    const w = e.waiter;
    e.waiter = undefined;
    w?.cancelled();
  }

  private closed(e: Entry): void {
    if (this.entries.get(e.win.id) !== e) return;
    const closing = e.closing;
    // Closed for a project close that was cancelled meanwhile: it comes back, as restore() brings back those closed
    // before the Cancel.
    const reopen = !!e.reopen && !closing && !this.quitting && this.deps.projectWindow(e.root) !== null;
    this.forget(e);
    if (reopen) {
      const s = e.savedKey ? this.saved.find((x) => x.root === e.root && x.key === e.savedKey) : undefined;
      if (s && (!s.key.startsWith('f:') || this.deps.restoreFile(s.root, s.key.slice(2), s.readOnly === true))) this.spawnSaved(s);
      else if (e.savedKey) this.unsave(e.root, e.savedKey, false);
      this.persist();
    } else if (!this.quitting && closing !== 'project' && e.savedKey) this.unsave(e.root, e.savedKey);
    this.announce(e.root);
  }

  /** Out of the registry (closed, docked or ended): timers and drag stopped, a project close waiting on it told. */
  private forget(e: Entry): void {
    this.endDragOf(e);
    e.saveTimer?.clear();
    e.closeTimer?.clear();
    e.saveTimer = e.closeTimer = undefined;
    this.entries.delete(e.win.id);
    const w = e.waiter;
    e.waiter = undefined;
    w?.closed();
  }

  private scheduleSave(e: Entry): void {
    if (!e.savedKey) return;
    e.saveTimer?.clear();
    e.saveTimer = this.deps.setTimer(() => {
      e.saveTimer = undefined;
      if (this.entries.get(e.win.id) !== e || e.win.isDestroyed() || !e.savedKey) return;
      // Full screen or in the Dock: the bounds to come back at are those it had before (saved already).
      if (e.win.isFullScreen() || e.win.isMinimized()) return;
      this.upsert(this.savedEntry(e.root, e.savedKey, e.win.getBounds()));
      this.persist();
    }, SAVE_DEBOUNCE_MS);
  }

  private dragTick(e: Entry, drag: Drag): void {
    if (this.entries.get(e.win.id) !== e || e.win.isDestroyed()) { this.stopDrag(e.win.id); return; }
    const was = drag.point;
    const wasOver = drag.over;
    const point = this.sample(e, drag);
    // The same window under the pointer is a new wrapper each time: windows compare by id.
    const sameWindow = wasOver?.id === drag.over?.id;
    // Into another window: the one it leaves loses its hint.
    if (wasOver && !sameWindow && was) wasOver.send(IPC.evDockHover, null);
    if (samePoint(was, point) && sameWindow) return;
    if (point && !was) e.win.setOpacity(DRAG_OPACITY);
    if (!point && was) e.win.setOpacity(1);
    // With its key over its own project window: that window shows where it lands, in its own space.
    if (drag.over) drag.over.send(IPC.evDockHover, point && drag.across ? { ...point, across: true } : point && { ...point, key: e.key });
    else if (!wasOver) this.deps.projectWindow(e.root)?.send(IPC.evDockHover, point && { ...point, key: e.key });
  }

  /**
   * Moves the window with the cursor; returns (and records) the client point over the window it would land in: its
   * project's, or another project's window in front under the pointer that can take its tab;
   * over another project's window that can't, none.
   */
  private sample(e: Entry, drag: Drag): Point | null {
    const c = this.deps.cursor();
    if (Math.hypot(c.x - drag.startCursor.x, c.y - drag.startCursor.y) >= DRAG_THRESHOLD) drag.moved = true;
    e.win.setPosition(c.x - drag.offset.x, c.y - drag.offset.y);
    const under = this.deps.windowAt?.(c) ?? null;
    let target: ProjectWin | null = this.deps.projectWindow(e.root);
    drag.across = null;
    if (under && under.root !== e.root) {
      const can = this.deps.canMove?.(e.root, e.key, under.root) ?? false;
      target = can ? under : null;
      if (can) drag.across = under.root;
    }
    drag.point = target ? dockPoint(c, target.getContentBounds(), target.zoom()) : null;
    drag.over = drag.point ? target : null;
    return drag.point;
  }

  /** Ends the window's drag, if any: the loop stops, the window is opaque again, the project window's hint goes. */
  private endDragOf(e: Entry): void {
    const drag = this.drags.get(e.win.id);
    if (!drag) return;
    this.stopDrag(e.win.id);
    if (!e.win.isDestroyed()) e.win.setOpacity(1);
    const own = this.deps.projectWindow(e.root);
    own?.send(IPC.evDockHover, null);
    if (drag.over && drag.over.id !== own?.id) drag.over.send(IPC.evDockHover, null);
  }

  private stopDrag(wcId: number): void {
    const d = this.drags.get(wcId);
    if (!d) return;
    d.timer.clear();
    this.drags.delete(wcId);
  }

  private dropWaiting(root: string, key: string): void {
    this.waiting = this.waiting.filter((s) => !(s.root === root && s.key === key));
  }

  private upsert(s: SavedPopout): void {
    const i = this.saved.findIndex((x) => x.root === s.root && x.key === s.key);
    if (i >= 0) this.saved[i] = s; else this.saved.push(s);
  }

  /** Drops a saved entry (and writes, unless the caller writes once for a batch). */
  private unsave(root: string, key: string, write = true): void {
    const before = this.saved.length;
    this.saved = this.saved.filter((x) => !(x.root === root && x.key === key));
    if (write && this.saved.length !== before) this.persist();
  }

  private persist(): void {
    this.deps.save(this.saved.map((s) => ({ ...s, bounds: { ...s.bounds } })));
  }

  private announce(root: string): void {
    this.deps.projectWindow(root)?.send(IPC.evPopouts, this.keys(root));
  }
}

export interface FileRulesDeps {
  /** The real path if inside the project's real root, else null. */
  inside(root: string, path: string): string | null;
  isFile(path: string): boolean;
  /** The real path (links resolved), null when there is nothing there. */
  real(path: string): string | null;
  /** GrantStore.check, and a grant as a tab restore makes it (restoreGrants: Claude temp files read-only). */
  check(root: string, path: string): string | null;
  /** GrantStore.mode: how the project holds a real path. */
  mode(root: string, real: string): 'edit' | 'read' | null;
  /** readOnly: remembered read-only, granted so again. */
  grant(root: string, path: string, readOnly: boolean): string | null;
  /** Watched for disk changes right away (OutsideFiles.opened). */
  opened(root: string, files: string[]): void;
}

/**
 * Which file pop-outs ui-state.json remembers, and how they come back. Grants
 * live in memory only, so a remembered outside file is granted again on restore: that is safe only because main saved
 * it while the file was granted — a key the page named alone (popout.open takes any `f:` key) is never remembered. An
 * outside file is saved by the real path its grant checked, and granted again only while that path is still real (no
 * link put or retargeted since can redirect the grant); a project file whose path now leads out of it is not granted.
 */
export function popoutFileRules(d: FileRulesDeps): Required<Pick<PopoutDeps, 'remember' | 'readOnly' | 'restoreFile'>> {
  return {
    remember: (root, path) => (d.inside(root, path) !== null ? path : d.check(root, path)),
    // The remembered path: an outside file's real one.
    readOnly: (root, path) => d.inside(root, path) === null && d.mode(root, path) === 'read',
    restoreFile: (root, path, readOnly = false) => {
      if (d.inside(root, path) !== null) return d.isFile(path);
      if (d.real(path) !== path) return false;
      const real = d.grant(root, path, readOnly);
      if (real) d.opened(root, [real]);
      return real !== null;
    }
  };
}
