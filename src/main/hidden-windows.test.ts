import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

// e2e windows are never shown: the switches, options and the no-op reveal apply
// only with the devEnv test flag, never in normal runs or in the packaged app.
const packaged = vi.hoisted(() => ({ value: false }));
vi.mock('electron', () => ({ app: { get isPackaged() { return packaged.value; } } }));
const { applyHiddenWindowSwitches, hiddenWebPreferences, hiddenWindows, hideTestDockIcon, presentNewWindow, revealedAt, revealWindow, showGhost } = await import('./hidden-windows');

const fakeWin = () => ({ show: vi.fn(), focus: vi.fn(), showInactive: vi.fn(), maximize: vi.fn() });
const fakeCommandLine = () => ({ appendSwitch: vi.fn() });
const fakeDock = () => ({ hide: vi.fn() });

let saved: string | undefined;
beforeEach(() => { saved = process.env.ATELIER_TEST_BACKGROUND; packaged.value = false; });
afterEach(() => { if (saved === undefined) delete process.env.ATELIER_TEST_BACKGROUND; else process.env.ATELIER_TEST_BACKGROUND = saved; });

test('with the test flag windows stay hidden: no show, no focus, renderer never backgrounded', () => {
  process.env.ATELIER_TEST_BACKGROUND = '1';
  expect(hiddenWindows()).toBe(true);
  const cl = fakeCommandLine();
  applyHiddenWindowSwitches(cl);
  expect(cl.appendSwitch.mock.calls.map((c) => c[0]).sort()).toEqual(['disable-background-timer-throttling', 'disable-backgrounding-occluded-windows', 'disable-renderer-backgrounding']);
  expect(hiddenWebPreferences()).toEqual({ backgroundThrottling: false });
  const win = fakeWin();
  presentNewWindow(win);
  revealWindow(win);
  showGhost(win);
  expect([win.show, win.focus, win.showInactive].map((f) => f.mock.calls.length)).toEqual([0, 0, 0]);
  // No Dock tile either: a force quit of a test app from the Dock kills its whole process coalition, which (launched
  // from an Atelier terminal) is the user's atelierd and every live session.
  const dock = fakeDock();
  hideTestDockIcon(dock);
  expect(dock.hide).toHaveBeenCalledTimes(1);
  expect(() => hideTestDockIcon(undefined)).not.toThrow();
});

test('without the flag windows show and come to the front, and Chromium keeps its defaults', () => {
  delete process.env.ATELIER_TEST_BACKGROUND;
  expect(hiddenWindows()).toBe(false);
  const cl = fakeCommandLine();
  applyHiddenWindowSwitches(cl);
  expect(cl.appendSwitch).not.toHaveBeenCalled();
  expect(hiddenWebPreferences()).toEqual({});
  const created = fakeWin();
  presentNewWindow(created);
  expect([created.show.mock.calls.length, created.focus.mock.calls.length]).toEqual([1, 0]);
  const existing = fakeWin();
  revealWindow(existing);
  expect([existing.show.mock.calls.length, existing.focus.mock.calls.length]).toEqual([1, 1]);
  // The tear-off ghost appears without taking focus or activating anything.
  const ghost = fakeWin();
  showGhost(ghost);
  expect([ghost.show, ghost.focus, ghost.showInactive].map((f) => f.mock.calls.length)).toEqual([0, 0, 1]);
  const dock = fakeDock();
  hideTestDockIcon(dock);
  expect(dock.hide).not.toHaveBeenCalled();
});

test('every reveal is remembered with its time, in e2e too: the app comes back with the window it last brought forward', () => {
  vi.useFakeTimers();
  try {
    delete process.env.ATELIER_TEST_BACKGROUND;
    const x = fakeWin();
    const y = fakeWin();
    expect(revealedAt(x)).toBe(0);
    vi.setSystemTime(1000);
    revealWindow(x);
    process.env.ATELIER_TEST_BACKGROUND = '1';
    vi.setSystemTime(2000);
    revealWindow(y);
    expect([revealedAt(x), revealedAt(y)]).toEqual([1000, 2000]);
  } finally {
    vi.useRealTimers();
  }
});

test('in e2e a test may ask which windows were brought forward: their pages, a line each, never shown', () => {
  const log = join(mkdtempSync(join(tmpdir(), 'atl-reveal-')), 'reveals.log');
  const had = process.env.ATELIER_TEST_REVEAL_LOG;
  process.env.ATELIER_TEST_BACKGROUND = '1';
  process.env.ATELIER_TEST_REVEAL_LOG = log;
  try {
    const a = { ...fakeWin(), webContents: { id: 7 } };
    const b = { ...fakeWin(), webContents: { id: 9 } };
    revealWindow(a);
    revealWindow(b);
    revealWindow(a);
    expect(readFileSync(log, 'utf8')).toBe('7\n9\n7\n');
    expect([a.show, a.focus].map((f) => f.mock.calls.length)).toEqual([0, 0]);
    // Without the flag (a window really shown) nothing is written.
    delete process.env.ATELIER_TEST_BACKGROUND;
    revealWindow(b);
    expect(readFileSync(log, 'utf8')).toBe('7\n9\n7\n');
  } finally {
    if (had === undefined) delete process.env.ATELIER_TEST_REVEAL_LOG; else process.env.ATELIER_TEST_REVEAL_LOG = had;
  }
});

test('in the packaged app the flag is inert', () => {
  process.env.ATELIER_TEST_BACKGROUND = '1';
  packaged.value = true;
  expect(hiddenWindows()).toBe(false);
  const cl = fakeCommandLine();
  applyHiddenWindowSwitches(cl);
  expect(cl.appendSwitch).not.toHaveBeenCalled();
  expect(hiddenWebPreferences()).toEqual({});
  const win = fakeWin();
  presentNewWindow(win);
  expect(win.show).toHaveBeenCalledTimes(1);
  const dock = fakeDock();
  hideTestDockIcon(dock);
  expect(dock.hide).not.toHaveBeenCalled();
});

test('a window left maximized comes back maximized (zoomed on macOS), shown and in front; never in e2e', () => {
  delete process.env.ATELIER_TEST_BACKGROUND;
  const win = fakeWin();
  presentNewWindow(win, true);
  expect([win.maximize.mock.calls.length, win.show.mock.calls.length]).toEqual([1, 1]);
  const plain = fakeWin();
  presentNewWindow(plain);
  expect(plain.maximize).not.toHaveBeenCalled();
  // maximize() shows a window too: in e2e it is never called.
  process.env.ATELIER_TEST_BACKGROUND = '1';
  const hidden = fakeWin();
  presentNewWindow(hidden, true);
  expect([hidden.maximize, hidden.show].map((f) => f.mock.calls.length)).toEqual([0, 0]);
});
