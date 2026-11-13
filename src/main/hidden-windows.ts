import { appendFileSync } from 'node:fs';
import type { CommandLine } from 'electron';
import { devEnv } from './dev-env';

/**
 * e2e windows are never shown: the tests run while the user works on the Mac (even inside Atelier), so a test window
 * must never appear on top of their work nor take focus. Every show/focus/raise of a window goes through here
 * (tests/integration/window-raise.test.ts) and is a no-op under the test flag, which is inert in the packaged app.
 * A hidden window still renders: Chromium is told not to background or throttle it, so animation frames, timers,
 * layout, input and screenshots work as in a visible window. (Under Playwright a never-shown window already reports
 * "visible" and runs animation frames; the switches are insurance against timer throttling in long tests.)
 */
export function hiddenWindows(): boolean {
  return !!devEnv('ATELIER_TEST_BACKGROUND');
}

const SWITCHES = ['disable-renderer-backgrounding', 'disable-backgrounding-occluded-windows', 'disable-background-timer-throttling'];

/** Before app ready: hidden test windows are not treated as background or occluded pages. */
export function applyHiddenWindowSwitches(commandLine: Pick<CommandLine, 'appendSwitch'>): void {
  if (!hiddenWindows()) return;
  for (const s of SWITCHES) commandLine.appendSwitch(s);
}

/** Extra webPreferences: a hidden test page stays "visible" to the Page Visibility API and is never throttled. */
export function hiddenWebPreferences(): { backgroundThrottling?: false } {
  return hiddenWindows() ? { backgroundThrottling: false } : {};
}

/**
 * At app ready: a test app has no Dock tile. Launched from an Atelier terminal, it shares the process coalition of the
 * user's atelierd and sessions; a Dock force quit (also of the ghost tile a finished test leaves behind) kills the whole
 * coalition, so a hidden tile keeps that trap out of reach.
 */
export function hideTestDockIcon(dock: { hide(): void } | undefined): void {
  if (hiddenWindows()) dock?.hide();
}

interface Showable { show(): void; focus(): void; webContents?: { id: number } }

/**
 * A window just created (ready-to-show): it appears, unless in e2e; maximized (zoomed on macOS) when it was left so.
 * maximize() shows the window too, so it never runs in e2e either; show() then makes it the active one.
 */
export function presentNewWindow(win: Showable & { maximize(): void }, maximized = false): void {
  if (hiddenWindows()) return;
  if (maximized) win.maximize();
  win.show();
}

const revealed = new WeakMap<object, number>();

/**
 * When a window was last brought to the front on purpose (0: never), e2e included: with when it last had the focus, the
 * window in use, which the app comes back with (openApp). A reveal from a banner click lands before the window gets the
 * focus: macOS may first launch another copy of the bundle, whose second-instance must not undo it.
 */
export function revealedAt(win: object): number {
  return revealed.get(win) ?? 0;
}

/**
 * An existing window brought to the front (notification click, New Window, second instance), unless in e2e: there a test
 * may ask which windows would have come forward (ATELIER_TEST_REVEAL_LOG: their pages' ids, a line each).
 */
export function revealWindow(win: Showable): void {
  revealed.set(win, Date.now());
  if (hiddenWindows()) {
    const log = devEnv('ATELIER_TEST_REVEAL_LOG');
    if (log && win.webContents) appendFileSync(log, `${win.webContents.id}\n`);
    return;
  }
  win.show();
  win.focus();
}

/** The tab tear-off's ghost: it appears without taking focus, unless in e2e. */
export function showGhost(win: { showInactive(): void }): void {
  if (!hiddenWindows()) win.showInactive();
}
