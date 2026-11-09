import { afterEach, describe, expect, test, vi } from 'vitest';

// A fake BrowserWindow: its webContents' listeners and messages recorded.
const made = vi.hoisted(() => [] as { listeners: Map<string, (e: { preventDefault(): void }) => void>; winListeners: Map<string, (e: { preventDefault(): void }) => void>; sent: unknown[][]; opts?: Record<string, unknown>; calls: string[] }[]);
vi.mock('electron', () => {
  class BrowserWindow {
    readonly rec = { listeners: new Map<string, (e: { preventDefault(): void }) => void>(), winListeners: new Map<string, (e: { preventDefault(): void }) => void>(), sent: [] as unknown[][], opts: undefined as Record<string, unknown> | undefined, calls: [] as string[] };
    readonly webContents = { on: (ev: string, fn: (e: { preventDefault(): void }) => void) => { this.rec.listeners.set(ev, fn); }, send: (...a: unknown[]) => { this.rec.sent.push(a); }, reload: () => { this.rec.calls.push('reload'); }, isDestroyed: () => false };
    on(ev: string, fn: (e: { preventDefault(): void }) => void) { this.rec.winListeners.set(ev, fn); }
    close() { this.rec.calls.push('close'); }
    isDestroyed() { return false; }
    constructor(opts?: Record<string, unknown>) { this.rec.opts = opts; made.push(this.rec); }
    once() {}
    loadFile(f: string) { this.rec.calls.push(`loadFile ${f}`); return Promise.resolve(); }
    loadURL() { return Promise.resolve(); }
    setIgnoreMouseEvents(v: boolean) { this.rec.calls.push(`ignoreMouse ${v}`); }
    setAlwaysOnTop(v: boolean, level: string) { this.rec.calls.push(`onTop ${v} ${level}`); }
    setOpacity(o: number) { this.rec.calls.push(`opacity ${o}`); }
    set excludedFromShownWindowsMenu(v: boolean) { this.rec.calls.push(`excluded ${v}`); }
  }
  return { BrowserWindow, dialog: { showMessageBoxSync: () => 2 }, session: { defaultSession: {} } };
});
vi.mock('./security', () => ({ hardenSession: () => {}, hardenWebContents: () => {}, secureWebPreferences: () => ({}) }));

import { IPC } from '@shared/api';
import { createGhostWindow, createPopoutWindow, createProjectWindow, frameOptions, isAppUrl, isGhostUrl, SessionEndGuard } from './windows';

test('the frame: traffic lights in the header on macOS; on Windows no title bar, the caption buttons over the header', () => {
  expect(frameOptions(1, 'darwin')).toEqual({ titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 16, y: 17 } });
  // One bar: the caption buttons as tall as the header, the Welcome window's and pop-outs' bars.
  expect(frameOptions(1.25, 'win32')).toEqual({ titleBarStyle: 'hidden', titleBarOverlay: { color: '#00000000', symbolColor: '#C9C7E6', height: 58 } });
  expect(frameOptions(1, 'win32')).toEqual({ titleBarStyle: 'hidden', titleBarOverlay: { color: '#00000000', symbolColor: '#C9C7E6', height: 46 } });
  // Themes: the caption symbols in the theme's --text-2.
  expect(frameOptions(1, 'win32', 46, '#3A3A3D')).toEqual({ titleBarStyle: 'hidden', titleBarOverlay: { color: '#00000000', symbolColor: '#3A3A3D', height: 46 } });
});

test('a window paints its theme\'s --bg-0 before the page loads (no flash of another color)', () => {
  createProjectWindow('/p', 1, undefined, {}, 'aurora');
  expect(made[made.length - 1]!.opts!.backgroundColor).toBe('#08080F');
  createPopoutWindow({ x: 0, y: 0, width: 600, height: 400 }, 1, 'p', {}, 'aurora');
  expect(made[made.length - 1]!.opts!.backgroundColor).toBe('#08080F');
  made.length = 0;
});

test('the page learns its theme before its first paint (a launch argument the preload reads)', () => {
  createProjectWindow('/p', 1, undefined, {}, 'paper');
  expect((made[made.length - 1]!.opts!.webPreferences as { additionalArguments?: string[] }).additionalArguments).toEqual(['--atelier-theme=paper']);
  createPopoutWindow({ x: 0, y: 0, width: 600, height: 400 }, 1, 'p', {}, 'ink');
  expect((made[made.length - 1]!.opts!.webPreferences as { additionalArguments?: string[] }).additionalArguments).toEqual(['--atelier-theme=ink']);
  made.length = 0;
});
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Answers the unsaved-changes dialog of a new window; returns whether the close went through and the hooks fired. */
function answer(which: 'save' | 'discard' | 'cancel', kind: 'project' | 'popout') {
  process.env.ATELIER_TEST_UNSAVED_ANSWER = which;
  const fired: string[] = [];
  const hooks = { onUnloadCancel: () => fired.push('cancel'), onUnloadKept: () => fired.push('kept') };
  if (kind === 'project') createProjectWindow('/p', 1, undefined, hooks);
  else createPopoutWindow({ x: 0, y: 0, width: 600, height: 400 }, 1, 'p', hooks);
  const rec = made[made.length - 1]!;
  let prevented = false;
  rec.listeners.get('will-prevent-unload')!({ preventDefault: () => { prevented = true; } });
  return { closes: prevented, fired, sent: rec.sent };
}

describe('the unsaved-changes guard tells its window what happened', () => {
  afterEach(() => { delete process.env.ATELIER_TEST_UNSAVED_ANSWER; made.length = 0; });

  test.each(['project', 'popout'] as const)("%s window: Don't Save closes and fires nothing", (kind) => {
    expect(answer('discard', kind)).toEqual({ closes: true, fired: [], sent: [] });
  });

  test.each(['project', 'popout'] as const)('%s window: Save All keeps the page (a quit stops) and saves', (kind) => {
    expect(answer('save', kind)).toEqual({ closes: false, fired: ['kept'], sent: [[IPC.evCommand, 'save-all-and-close']] });
  });

  test.each(['project', 'popout'] as const)('%s window: Cancel keeps the page and reports the Cancel', (kind) => {
    expect(answer('cancel', kind)).toEqual({ closes: false, fired: ['kept', 'cancel'], sent: [] });
  });
});

// In-app confirms: a page that listens is asked in its window; the hooks run once it answers, and Save or Don't
// Save does again what was stopped (the close, the quit, the reload).
describe('the unsaved-changes guard asks the page when it listens', () => {
  afterEach(() => { made.length = 0; });

  const open = (o: { listens?: boolean; quitting?: boolean } = {}) => {
    let quitting = !!o.quitting;
    const fired: string[] = [];
    const asked: string[] = [];
    let reply: (a: 'go' | 'cancel') => void = () => {};
    const hooks = {
      onUnloadCancel: () => fired.push('cancel'), onUnloadKept: () => fired.push('kept'),
      isQuitting: () => quitting, resumeQuit: () => fired.push('resume-quit'),
      unsaved: { canAsk: () => o.listens !== false, ask: (what: 'close' | 'quit' | 'reload') => { asked.push(what); return new Promise<'go' | 'cancel'>((r) => { reply = r; }); } }
    };
    createProjectWindow('/p', 1, undefined, hooks);
    const rec = made[made.length - 1]!;
    let prevented = false;
    const unload = () => rec.listeners.get('will-prevent-unload')!({ preventDefault: () => { prevented = true; } });
    return { rec, fired, asked, unload, setQuitting: (q: boolean) => { quitting = q; }, answer: async (a: 'go' | 'cancel') => { reply(a); await Promise.resolve(); await Promise.resolve(); }, prevented: () => prevented };
  };

  test('a close: asked as a close; the page kept meanwhile and nothing told yet; Cancel then reports kept + cancel', async () => {
    const w = open();
    w.rec.winListeners.get('close')!({ preventDefault: () => {} });
    w.unload();
    expect(w.prevented()).toBe(false);
    expect(w.asked).toEqual(['close']);
    expect(w.fired).toEqual([]);
    await w.answer('cancel');
    expect(w.fired).toEqual(['kept', 'cancel']);
    expect(w.rec.calls).not.toContain('close');
  });

  test('Save or Don\'t Save on a close: the window closes again (the page lets it through now)', async () => {
    const w = open();
    w.rec.winListeners.get('close')!({ preventDefault: () => {} });
    w.unload();
    await w.answer('go');
    expect(w.rec.calls).toContain('close');
    expect(w.fired).toEqual([]);
  });

  test('a quit: asked as a quit; the stopped quit is told at once (kept), and Save or Don\'t Save resumes it', async () => {
    const w = open({ quitting: true });
    w.rec.winListeners.get('close')!({ preventDefault: () => {} });
    w.unload();
    expect(w.asked).toEqual(['quit']);
    // Electron called the quit off: the app's quit state says so now, not once the page answers.
    expect(w.fired).toEqual(['kept']);
    await w.answer('go');
    expect(w.fired).toEqual(['kept', 'resume-quit']);
  });

  test('a quit\'s Cancel: the quit was told already, only the Cancel follows', async () => {
    const w = open({ quitting: true });
    w.unload();
    await w.answer('cancel');
    expect(w.fired).toEqual(['kept', 'cancel']);
  });

  test('stopped again while asked (⌘Q over the close question): one question, and its answer does the last thing asked', async () => {
    const w = open();
    w.rec.winListeners.get('close')!({ preventDefault: () => {} });
    w.unload();
    expect(w.asked).toEqual(['close']);
    // The quit comes now: same page, still asking.
    w.setQuitting(true);
    w.rec.winListeners.get('close')!({ preventDefault: () => {} });
    w.unload();
    expect(w.asked).toEqual(['close']);
    expect(w.fired).toEqual(['kept']);
    await w.answer('go');
    expect(w.fired).toEqual(['kept', 'resume-quit']);
    expect(w.rec.calls).not.toContain('close');
  });

  test('a page slow to answer its unload guard (seconds after the close): still a close, never a reload', async () => {
    vi.useFakeTimers();
    try {
      const w = open();
      w.rec.winListeners.get('close')!({ preventDefault: () => {} });
      vi.advanceTimersByTime(4000);
      w.unload();
      expect(w.asked).toEqual(['close']);
    } finally { vi.useRealTimers(); }
  });

  test('no close asked before it: a reload, done again after the answer', async () => {
    const w = open();
    w.unload();
    expect(w.asked).toEqual(['reload']);
    await w.answer('go');
    expect(w.rec.calls).toContain('reload');
  });

  test('two windows with unsaved files at a quit: the second is asked about the quit too, after the first called it off', async () => {
    // One app: the first window's question calls the quit off (quitStopped: quitting false) before the second is asked.
    let quitting = true;
    const make = () => {
      const asked: string[] = [];
      const fired: string[] = [];
      let reply: (a: 'go' | 'cancel') => void = () => {};
      createProjectWindow('/p', 1, undefined, {
        onUnloadKept: () => { fired.push('kept'); quitting = false; }, onUnloadCancel: () => fired.push('cancel'),
        isQuitting: () => quitting, resumeQuit: () => fired.push('resume-quit'),
        unsaved: { canAsk: () => true, ask: (what) => { asked.push(what); return new Promise((r) => { reply = r; }); } }
      });
      const rec = made[made.length - 1]!;
      return { rec, asked, fired, answer: async (x: 'go' | 'cancel') => { reply(x); await Promise.resolve(); await Promise.resolve(); } };
    };
    const a = make();
    const b = make();
    // Electron closes every window as the quit starts; their pages answer beforeunload afterwards.
    a.rec.winListeners.get('close')!({ preventDefault: () => {} });
    b.rec.winListeners.get('close')!({ preventDefault: () => {} });
    a.rec.listeners.get('will-prevent-unload')!({ preventDefault: () => {} });
    b.rec.listeners.get('will-prevent-unload')!({ preventDefault: () => {} });
    expect([a.asked, b.asked]).toEqual([['quit'], ['quit']]);
    await b.answer('go');
    expect(b.fired).toEqual(['kept', 'resume-quit']);
    expect(b.rec.calls).not.toContain('close');
  });

  test('a close another handler stopped (a project waiting on its pop-outs) is no close: a reload right after stays a reload', async () => {
    const w = open();
    // Main's own close handler prevented it: the page's guard never ran for it.
    w.rec.winListeners.get('close')!({ preventDefault: () => {}, defaultPrevented: true } as never);
    await new Promise((r) => setImmediate(r));
    w.unload();
    expect(w.asked).toEqual(['reload']);
    await w.answer('go');
    expect(w.rec.calls).toEqual(expect.arrayContaining(['reload']));
    expect(w.rec.calls).not.toContain('close');
  });

  test('a page that does not listen: the native dialog, as before (its Cancel here)', () => {
    const w = open({ listens: false });
    w.unload();
    expect(w.asked).toEqual([]);
    expect(w.fired).toEqual(['kept', 'cancel']);
  });
});

// Tab tear-off: the ghost is a page of its own, never an app page.
describe('the tear-off ghost window', () => {
  afterEach(() => { made.length = 0; });

  test('its URL is its own page; the app page is not a ghost and the ghost is not an app page', () => {
    const ghost = pathToFileURL(join(__dirname, '../renderer/ghost.html')).href;
    const app = pathToFileURL(join(__dirname, '../renderer/index.html')).href;
    expect(isGhostUrl(ghost)).toBe(true);
    expect(isAppUrl(ghost)).toBe(false);
    expect(isGhostUrl(app)).toBe(false);
    expect(isGhostUrl(`${ghost}?x`)).toBe(false);
  });

  test('in development too: the ghost page, with a query or a hash, is never an app page', () => {
    process.env.ELECTRON_RENDERER_URL = 'http://localhost:5173';
    try {
      expect(isAppUrl('http://localhost:5173/')).toBe(true);
      expect(isAppUrl('http://localhost:5173/#x')).toBe(true);
      for (const u of ['http://localhost:5173/ghost.html', 'http://localhost:5173/ghost.html#x', 'http://localhost:5173/ghost.html?x']) expect(isAppUrl(u)).toBe(false);
      expect(isGhostUrl('http://localhost:5173/ghost.html')).toBe(true);
    } finally {
      delete process.env.ELECTRON_RENDERER_URL;
    }
  });

  test('frameless, transparent, never focused, click-through, floating, out of the Window menu, no preload, starts invisible', () => {
    createGhostWindow({ x: 10, y: 20, width: 600, height: 400 }, 1.1);
    const rec = made[made.length - 1]!;
    expect(rec.opts).toMatchObject({ x: 10, y: 20, width: 600, height: 400, frame: false, transparent: true, focusable: false, show: false, resizable: false, hasShadow: true });
    // At the interface size, as the pop-out that takes its place.
    expect((rec.opts!.webPreferences as Record<string, unknown>).zoomFactor).toBe(1.1);
    expect((rec.opts!.webPreferences as Record<string, unknown>).preload).toBeUndefined();
    expect(rec.calls).toEqual(expect.arrayContaining(['ignoreMouse true', 'onTop true floating', 'opacity 0', 'excluded true']));
    expect(rec.calls.some((c) => c.startsWith('loadFile') && c.endsWith('ghost.html'))).toBe(true);
  });
});

// Windows signing out, restarting or shutting down (Windows Update included) with unsaved files: never silently lost.
describe('the session end guard (Windows)', () => {
  test('only a window with unsaved files holds the session end, and the app quits once so each asks its question', async () => {
    const guard = new SessionEndGuard();
    let quits = 0;
    const quit = () => { quits++; };
    expect(guard.query(1, quit)).toBe(false);
    guard.set(1, true);
    guard.set(2, true);
    guard.set(3, false);
    // Windows asks every window: the two with unsaved files hold it, the app quits once, out of Windows' message.
    expect([guard.query(1, quit), guard.query(2, quit), guard.query(3, quit)]).toEqual([true, true, false]);
    expect(quits).toBe(0);
    await new Promise((r) => setImmediate(r));
    expect(quits).toBe(1);
    // Saved meanwhile, or the window gone: nothing held any more.
    guard.set(1, false);
    guard.drop(2);
    expect([guard.query(1, quit), guard.query(2, quit)]).toEqual([false, false]);
  });

  test('a later session end (the first one cancelled, then another) quits again', async () => {
    const guard = new SessionEndGuard();
    let quits = 0;
    guard.set(1, true);
    guard.query(1, () => { quits++; });
    await new Promise((r) => setImmediate(r));
    guard.query(1, () => { quits++; });
    await new Promise((r) => setImmediate(r));
    expect(quits).toBe(2);
  });
});
