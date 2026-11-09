import { BrowserWindow, dialog, session, type BrowserWindowConstructorOptions, type Rectangle } from 'electron';
import { IPC } from '@shared/api';
import { POPOUT_MIN } from '@shared/popout';
import { trafficLights, WINDOW_BAR, windowButtons } from '@shared/settings';
import { themeArg, type ThemeId } from '@shared/themes';
import { chromeOf } from './theme-chrome';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { hardenSession, hardenWebContents, secureWebPreferences } from './security';
import { devEnv } from './dev-env';
import { hiddenWebPreferences, presentNewWindow } from './hidden-windows';

let sessionHardened = false;

function rendererFile(): string {
  return join(__dirname, '../renderer/index.html');
}

/** URLs the interface may come from: Vite server in development, the app's file otherwise. Never the ghost's page. */
export function isAppUrl(url: string): boolean {
  const dev = devEnv('ELECTRON_RENDERER_URL');
  if (dev) return url.startsWith(dev) && !isGhostPath(url);
  return url.split('#')[0] === pathToFileURL(rendererFile()).href;
}

const ghostFile = () => join(__dirname, '../renderer/ghost.html');
const ghostDevUrl = (dev: string) => `${dev.replace(/\/$/, '')}/ghost.html`;

/** The ghost's page whatever its query or hash (in development every page of the Vite server shares the origin). */
function isGhostPath(url: string): boolean {
  try { return new URL(url).pathname.endsWith('/ghost.html'); } catch { return true; }
}

/** The tab tear-off ghost's page: its own static page, exactly. */
export function isGhostUrl(url: string): boolean {
  const dev = devEnv('ELECTRON_RENDERER_URL');
  return url === (dev ? ghostDevUrl(dev) : pathToFileURL(ghostFile()).href);
}

// Dictation opens the microphone (audio only, app pages only) when it is on: the main process decides.
let dictationGate: () => boolean = () => false;
export function setDictationGate(fn: () => boolean): void { dictationGate = fn; }

interface WindowHooks {
  /** The unsaved-changes dialog was answered Cancel: whatever was closing the window must not go on. */
  onUnloadCancel?: () => void;
  /** The dialog kept the page (Save All or Cancel): the close stops there, and so does a quit in progress. */
  onUnloadKept?: () => void;
  /**
   * The page's own question: whether it listens, and its answer — 'go' once it saved or let
   * the files go (the unload goes through now), 'cancel' (or null: it went meanwhile).
   */
  unsaved?: { canAsk(): boolean; ask(what: 'close' | 'quit' | 'reload'): Promise<'go' | 'cancel' | null> };
  /** A quit in progress (the page's question says Quit, and Save or Don't Save resumes it). */
  isQuitting?: () => boolean;
  resumeQuit?: () => void;
}

/**
 * A close asked this recently is what a page's unload guard stopped (a later one, without it: a reload). Wide: a page
 * busy with its terminals may take seconds to answer beforeunload.
 */
const CLOSE_ASKED_MS = 10_000;

/**
 * Windows signing out, restarting or shutting down (Windows Update too) with unsaved files:
 * each window that has some holds the session end ("Atelier is preventing shutdown"), and the app quits, once, so each
 * of those windows comes forward with its own question (Save or Don't Save resumes the quit). Pages say whether they
 * have unsaved files; a window gone has none.
 */
export class SessionEndGuard {
  private readonly unsaved = new Set<number>();
  private quitting = false;

  set(id: number, has: boolean): void {
    if (has) this.unsaved.add(id);
    else this.unsaved.delete(id);
  }

  drop(id: number): void { this.unsaved.delete(id); }

  /** A window's query-session-end: true when it must hold the session end. The quit runs after Windows' message. */
  query(id: number, quit: () => void): boolean {
    if (!this.unsaved.has(id)) return false;
    if (!this.quitting) {
      this.quitting = true;
      setImmediate(() => { this.quitting = false; quit(); });
    }
    return true;
  }
}

/**
 * The window's frame: macOS's traffic lights inset in the header; on Windows no title bar at all: the header runs to the top edge and the system draws only its caption buttons over it.
 */
export function frameOptions(zoom: number, platform: NodeJS.Platform = process.platform, row = WINDOW_BAR, symbol = chromeOf('aurora').symbol): BrowserWindowConstructorOptions {
  if (platform === 'win32') return { titleBarStyle: 'hidden', titleBarOverlay: windowButtons(zoom, row, symbol) };
  return { titleBarStyle: 'hiddenInset', trafficLightPosition: trafficLights(zoom) };
}

/**
 * `place`: where it opens (the welcome window it replaces, or where it was last time), maximized when it was so; else
 * centered.
 */
export function createProjectWindow(projectRoot: string | null, zoomFactor = 1, place?: Rectangle & { maximized?: boolean }, hooks: WindowHooks = {}, theme: ThemeId = 'aurora'): BrowserWindow {
  const chrome = chromeOf(theme);
  const { maximized = false, ...bounds }: Partial<Rectangle> & { maximized?: boolean } = place ?? {};
  return createAppWindow({
    width: 1600, height: 980, ...bounds, minWidth: 960, minHeight: 600,
    title: projectRoot ? basename(projectRoot) : 'Atelier',
    ...frameOptions(zoomFactor, process.platform, WINDOW_BAR, chrome.symbol),
    backgroundColor: chrome.background, show: false,
    // The zoom from the settings applies from the very first paint (no jump, no double refit of the terminals).
    // The page sets its theme before its first paint: the preload reads this argument.
    webPreferences: { ...secureWebPreferences(join(__dirname, '../preload/index.js')), zoomFactor, ...hiddenWebPreferences(), additionalArguments: [themeArg(theme)] }
  }, hooks, maximized);
}

/** A pop-out's one bar (its caption buttons on Windows sit in it, as tall). */
export const POPOUT_BAR = WINDOW_BAR;

/** A tab in a window of its own: the same page and hardening, a bar as tall as the main header. */
export function createPopoutWindow(bounds: Rectangle, zoomFactor: number, title: string, hooks: WindowHooks = {}, theme: ThemeId = 'aurora'): BrowserWindow {
  const chrome = chromeOf(theme);
  return createAppWindow({
    ...bounds, minWidth: POPOUT_MIN.width, minHeight: POPOUT_MIN.height, title,
    ...frameOptions(zoomFactor, process.platform, POPOUT_BAR, chrome.symbol),
    backgroundColor: chrome.background, show: false,
    // The page sets its theme before its first paint: the preload reads this argument.
    webPreferences: { ...secureWebPreferences(join(__dirname, '../preload/index.js')), zoomFactor, ...hiddenWebPreferences(), additionalArguments: [themeArg(theme)] }
  }, hooks);
}

/**
 * The tab tear-off's ghost: frameless, transparent, never focused, clicks go
 * through it, above other windows, out of the Window menu; no preload and not an app page (no IPC). It starts
 * invisible (opacity 0): the tear-off fades it in, and showGhost puts it on screen (never in e2e).
 */
export function createGhostWindow(bounds: Rectangle, zoomFactor = 1): BrowserWindow {
  const { preload: _none, ...prefs } = secureWebPreferences('');
  const win = new BrowserWindow({
    ...bounds, frame: false, transparent: true, hasShadow: true, focusable: false, show: false, resizable: false,
    minimizable: false, maximizable: false, fullscreenable: false, skipTaskbar: true, roundedCorners: true, backgroundColor: '#00000000',
    // At the interface size, as the pop-out that takes its place.
    webPreferences: { ...prefs, zoomFactor, ...hiddenWebPreferences() }
  });
  hardenWebContents(win.webContents, isGhostUrl);
  win.setIgnoreMouseEvents(true);
  win.setAlwaysOnTop(true, 'floating');
  win.setOpacity(0);
  win.excludedFromShownWindowsMenu = true;
  const dev = devEnv('ELECTRON_RENDERER_URL');
  if (dev) void win.loadURL(ghostDevUrl(dev));
  else void win.loadFile(ghostFile());
  return win;
}

function createAppWindow(options: BrowserWindowConstructorOptions, hooks: WindowHooks = {}, maximized = false): BrowserWindow {
  if (!sessionHardened) { hardenSession(session.defaultSession, { isApp: isAppUrl, enabled: () => dictationGate() }); sessionHardened = true; }
  const win = new BrowserWindow(options);
  hardenWebContents(win.webContents, isAppUrl);
  // Unsaved files: the page blocks closing (beforeunload) and here we ask what to do,
  // on window close, quit and reload. The sessions stay alive in atelierd either way.
  let closeAskedAt = -Infinity;
  // Whether that close was a quit's: Electron closes every window as a quit starts, and the first window whose page
  // stops it calls the quit off (quitting is false again) before another window's page has answered its guard.
  let closeForQuit = false;
  let asking: { want: 'close' | 'quit' | 'reload'; kept: boolean } | null = null;
  win.on('close', (e) => {
    closeAskedAt = Date.now();
    closeForQuit = hooks.isQuitting?.() ?? false;
    // Stopped by another handler (a project closing its pop-outs first): no unload guard ran for it, so a reload
    // afterwards must not be read as this close.
    setImmediate(() => { if (e.defaultPrevented) closeAskedAt = -Infinity; });
  });
  win.webContents.on('will-prevent-unload', (event) => {
    // A close asked just before is what this guard stopped, once (a later stop, without one: a reload).
    const closing = Date.now() - closeAskedAt < CLOSE_ASKED_MS;
    closeAskedAt = -Infinity;
    // Tests answer here (save / discard / cancel), or 'ask' for the page's own question.
    const given = devEnv('ATELIER_TEST_UNSAVED_ANSWER');
    const test = given === 'save' || given === 'discard' || given === 'cancel' ? given : undefined;
    // The page asks in its own window: kept meanwhile (Electron stops the close, the quit or
    // the reload), the hooks told once it answers, and what was stopped done again after Save or Don't Save.
    if (!test && hooks.unsaved?.canAsk()) {
      const what = hooks.isQuitting?.() || (closing && closeForQuit) ? 'quit' : closing ? 'close' : 'reload';
      // A quit Electron called off is told at once (the app's quit state, its pop-outs): not left "quitting" while the
      // page's question is open. A close or a reload is told when the page answers (a project close waits on it).
      const stopped = (q: { kept: boolean }) => { if (what === 'quit' && !q.kept) { q.kept = true; hooks.onUnloadKept?.(); } };
      // Stopped again while its question is open (⌘Q over the close question): the same question; its answer does the
      // last thing asked.
      if (asking) { asking.want = what; stopped(asking); return; }
      const q = { want: what as 'close' | 'quit' | 'reload', kept: false };
      asking = q;
      stopped(q);
      void hooks.unsaved.ask(what).then((a) => {
        asking = null;
        if (win.isDestroyed()) return;
        if (a !== 'go') { if (!q.kept) hooks.onUnloadKept?.(); hooks.onUnloadCancel?.(); return; }
        if (q.want === 'quit') hooks.resumeQuit?.();
        else if (q.want === 'close') win.close();
        else win.webContents.reload();
      });
      return;
    }
    const response = test ? ['save', 'discard', 'cancel'].indexOf(test) : dialog.showMessageBoxSync(win, {
      type: 'warning', buttons: ['Save All', "Don't Save", 'Cancel'], defaultId: 0, cancelId: 2,
      message: 'You have unsaved changes', detail: 'Save them before closing?'
    });
    if (response === 1) { event.preventDefault(); return; }
    // Not prevented: the page stays (Electron also cancels a quit in progress).
    hooks.onUnloadKept?.();
    if (response === 0) win.webContents.send(IPC.evCommand, 'save-all-and-close');
    else if (response === 2) hooks.onUnloadCancel?.();
  });
  // In e2e tests the window is never shown: the tests run while working on the Mac.
  win.once('ready-to-show', () => presentNewWindow(win, maximized));
  const devUrl = devEnv('ELECTRON_RENDERER_URL');
  if (devUrl) void win.loadURL(devUrl);
  else void win.loadFile(rendererFile());
  return win;
}
