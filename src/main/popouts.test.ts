import { describe, expect, test } from 'vitest';
import { PopoutManager, popoutFileRules, type PopoutDeps, type PopoutWin, type ProjectWin } from './popouts';
import { IPC } from '@shared/api';
import { restoreBounds, type Bounds, type EditorHandoff, type Point, type SavedPopout } from '@shared/popout';

type Ev = 'close' | 'closed' | 'moved' | 'resized' | 'resize' | 'page-gone' | 'page-loading';
type Listener = (e: { preventDefault(): void }) => void;

class FakeWin implements PopoutWin {
  sent: { channel: string; payload?: unknown }[] = [];
  calls: string[] = [];
  listeners: Partial<Record<Ev, Listener[]>> = {};
  opacity = 1;
  destroyed = false;
  fullScreen = false;
  minimized = false;
  isFullScreen() { return this.fullScreen; }
  isMinimized() { return this.minimized; }
  /** close(): emit 'close' and, when nobody prevents it, 'closed' at once (false: the unsaved guard is still asking). */
  autoClose = true;
  constructor(public id: number, public bounds: Bounds) {}
  getBounds() { return { ...this.bounds }; }
  setPosition(x: number, y: number) { this.bounds = { ...this.bounds, x, y }; }
  setOpacity(o: number) { this.opacity = o; this.calls.push(`opacity:${o}`); }
  close() {
    this.calls.push('close');
    let prevented = false;
    this.emit('close', () => { prevented = true; });
    if (!prevented && this.autoClose) this.finish();
  }
  destroy() { this.calls.push('destroy'); this.finish(); }
  finish() { if (this.destroyed) return; this.destroyed = true; this.emit('closed'); }
  isDestroyed() { return this.destroyed; }
  send(channel: string, payload?: unknown) { this.sent.push({ channel, payload }); }
  on(event: Ev, fn: Listener) { (this.listeners[event] ??= []).push(fn); }
  emit(event: Ev, prevent: () => void = () => {}) { for (const fn of this.listeners[event] ?? []) fn({ preventDefault: prevent }); }
  of(channel: string) { return this.sent.filter((s) => s.channel === channel).map((s) => s.payload); }
}

class FakeProject implements ProjectWin {
  sent: { channel: string; payload?: unknown }[] = [];
  revealed = 0;
  z = 1;
  constructor(public id: number, public bounds: Bounds, public content: Bounds) {}
  getBounds() { return { ...this.bounds }; }
  getContentBounds() { return { ...this.content }; }
  zoom() { return this.z; }
  send(channel: string, payload?: unknown) { this.sent.push({ channel, payload }); }
  reveal() { this.revealed++; }
  of(channel: string) { return this.sent.filter((s) => s.channel === channel).map((s) => s.payload); }
  last(channel: string) { return this.of(channel).at(-1); }
}

class Clock {
  now = 0;
  private items: { at: number; every: number | null; fn: () => void; live: boolean }[] = [];
  timer(fn: () => void, ms: number, every = false) {
    const item = { at: this.now + ms, every: every ? ms : null, fn, live: true };
    this.items.push(item);
    return { clear: () => { item.live = false; } };
  }
  live() { return this.items.filter((i) => i.live).length; }
  tick(ms: number) {
    const end = this.now + ms;
    for (;;) {
      const next = this.items.filter((i) => i.live && i.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!next) break;
      this.now = next.at;
      if (next.every === null) next.live = false; else next.at += next.every;
      next.fn();
    }
    this.now = end;
  }
}

const ROOT = '/p/alpha';
const AREAS: Bounds[] = [{ x: 0, y: 25, width: 1920, height: 1055 }];
const MAIN: Bounds = { x: 100, y: 100, width: 1200, height: 700 };
const CONTENT: Bounds = { x: 100, y: 128, width: 1200, height: 672 };
const SIZE = { width: 600, height: 400 };
const handoff: EditorHandoff = { path: '/p/alpha/a.ts', state: { doc: 'x', selection: null }, saved: 'y', stamp: null, eol: 'lf', scrollTop: 0 };

function setup(o: { saved?: SavedPopout[]; files?: string[] } = {}) {
  const clock = new Clock();
  const wins: FakeWin[] = [];
  const created: { root: string; bounds: Bounds; title: string }[] = [];
  const cancels = new Map<number, () => void>();
  const kepts = new Map<number, () => void>();
  const revealed: number[] = [];
  const saves: SavedPopout[][] = [];
  const projects = new Map<string, FakeProject>([[ROOT, new FakeProject(1, MAIN, CONTENT)]]);
  const files = new Set(o.files ?? []);
  /** ungranted: files main can't read; real: the real path a remembered file is saved under (default: as named). */
  const env = { cursor: { x: 0, y: 0 } as Point, fail: false, ungranted: new Set<string>(), real: new Map<string, string>(), tear: null as { bounds: Bounds } | null, readOnly: new Set<string>() };
  /** What the tear-off was told: the pop-out's window id, null for a failed or inside open; 'taken' when asked. */
  const tears: (number | null | 'taken')[] = [];
  /** restoreFile calls, in order with the windows created (an outside file is granted again before its window loads). */
  const restored: string[] = [];
  let nextId = 100;
  const deps: PopoutDeps = {
    create: (root, bounds, title, onUnloadCancel, onUnloadKept) => {
      if (env.fail) throw new Error('no window');
      const w = new FakeWin(nextId++, bounds);
      wins.push(w);
      restored.push(`create ${w.id}`);
      created.push({ root, bounds, title });
      cancels.set(w.id, onUnloadCancel);
      kepts.set(w.id, onUnloadKept);
      return w;
    },
    projectWindow: (root) => projects.get(root) ?? null,
    reveal: (w) => { revealed.push(w.id); },
    cursor: () => ({ ...env.cursor }),
    displays: () => AREAS,
    remember: (_root, p) => (env.ungranted.has(p) ? null : env.real.get(p) ?? p),
    readOnly: (_root, p) => env.readOnly.has(p),
    restoreFile: (root, p, readOnly) => { restored.push(`restore ${root} ${p}${readOnly ? ' read-only' : ''}`); return files.has(p); },
    loadSaved: () => o.saved ?? [],
    save: (s) => { saves.push(s); },
    setTimer: (fn, ms) => clock.timer(fn, ms),
    setInterval: (fn, ms) => clock.timer(fn, ms, true),
    takeTear: () => {
      tears.push('taken');
      const t = env.tear;
      env.tear = null;
      return t ? { bounds: t.bounds, done: (id) => { tears.push(id); } } : null;
    }
  };
  const m = new PopoutManager(deps);
  const project = projects.get(ROOT)!;
  const lastSaved = () => saves.at(-1) ?? [];
  const nth = <T>(list: T[], i: number): T => { const x = list[i]; if (x === undefined) throw new Error(`no item ${i}`); return x; };
  const win = (i: number) => nth(wins, i);
  const made = (i: number) => nth(created, i);
  const open = (key: string, extra: Partial<Parameters<PopoutManager['open']>[1]> = {}) => m.open(ROOT, { key, size: SIZE, at: 'cascade', ...extra });
  return { m, clock, wins, win, created, made, cancels, kepts, revealed, saves, lastSaved, project, projects, env, open, restored, tears };
}

describe('PopoutManager', () => {
  test('tear-off: released outside, the window opens at the ghost\'s bounds and hands the ghost its id; inside or failed: none', () => {
    const t = setup();
    const ghost = { x: 1300, y: 40, width: 600, height: 400 };
    t.env.cursor = { x: 1400, y: 60 };
    t.env.tear = { bounds: ghost };
    expect(t.open('t:a', { at: 'cursor' })).toEqual({ ok: true });
    expect(t.made(0).bounds).toEqual(ghost);
    expect(t.tears).toEqual(['taken', t.win(0).id]);
    // Inside after all: the ghost goes, nothing opens.
    t.env.cursor = { x: 300, y: 300 };
    t.env.tear = { bounds: ghost };
    expect(t.open('t:b', { at: 'cursor' })).toEqual({ ok: false, reason: 'inside' });
    expect(t.tears.at(-1)).toBeNull();
    // A window that can't be made: the ghost goes too.
    t.env.cursor = { x: 1400, y: 60 };
    t.env.tear = { bounds: ghost };
    t.env.fail = true;
    expect(t.open('t:c', { at: 'cursor' })).toEqual({ ok: false, reason: 'failed' });
    expect(t.tears.at(-1)).toBeNull();
    // No ghost (never left the window): placed at the cursor as before; a cascade open never asks.
    t.env.fail = false;
    const asked = t.tears.length;
    expect(t.open('t:d', { at: 'cursor' })).toEqual({ ok: true });
    expect(t.created.at(-1)!.bounds).toEqual({ x: 1400 - 101, y: 60 - 22, width: 600, height: 400 });
    t.open('t:e');
    expect(t.tears.length).toBe(asked + 1);
  });

  test('1. open places the window (cascade or cursor), creates it, stores and saves it, tells the project window', () => {
    const t = setup();
    expect(t.open('t:a')).toEqual({ ok: true });
    // Centred over the main window (100,100 1200×700), then 32 px further for each pop-out already open.
    expect(t.made(0)).toEqual({ root: ROOT, title: 'alpha', bounds: { x: 400, y: 250, width: 600, height: 400 } });
    expect(t.open('f:/p/alpha/a.ts', { payload: { kind: 'file', rel: 'a.ts', mode: 'margin' } })).toEqual({ ok: true });
    expect(t.made(1).bounds).toEqual({ x: 432, y: 282, width: 600, height: 400 });
    expect(t.m.entryOf(t.win(1).id)).toEqual({ root: ROOT, key: 'f:/p/alpha/a.ts', payload: { kind: 'file', rel: 'a.ts', mode: 'margin' } });
    expect(t.m.isPopout(t.win(0).id)).toBe(true);
    expect(t.m.isPopout(t.project.id)).toBe(false);
    expect(t.lastSaved()).toEqual([
      { root: ROOT, key: 't:a', bounds: t.made(0).bounds },
      { root: ROOT, key: 'f:/p/alpha/a.ts', bounds: t.made(1).bounds }
    ]);
    expect(t.project.last(IPC.evPopouts)).toEqual(['t:a', 'f:/p/alpha/a.ts']);
    expect(t.m.live(ROOT)).toBe(2);
    expect(t.m.windowFor(ROOT, 't:a')).toBe(t.win(0));

    // Non-restorable keys are live but never saved.
    expect(t.open('services')).toEqual({ ok: true });
    expect(t.lastSaved().map((s) => s.key)).toEqual(['t:a', 'f:/p/alpha/a.ts']);
    expect(t.m.keys(ROOT)).toEqual(['t:a', 'f:/p/alpha/a.ts', 'services']);

    // At the cursor: inside the project window → refused, nothing created.
    t.env.cursor = { x: 600, y: 400 };
    expect(t.open('t:b', { at: 'cursor' })).toEqual({ ok: false, reason: 'inside' });
    expect(t.wins).toHaveLength(3);
    // Outside: placed under the cursor, the grip under the pointer (101, 22 px into the window).
    t.env.cursor = { x: 1350, y: 500 };
    expect(t.open('t:b', { at: 'cursor' })).toEqual({ ok: true });
    expect(t.made(3).bounds).toEqual({ x: 1249, y: 478, width: 600, height: 400 });

    // A window that can't be created.
    t.env.fail = true;
    expect(t.open('t:c')).toEqual({ ok: false, reason: 'failed' });
    expect(t.m.keys(ROOT)).not.toContain('t:c');
  });

  test('2. opening a key already popped out brings its window forward without creating another', () => {
    const t = setup();
    t.open('t:a');
    expect(t.open('t:a')).toEqual({ ok: true });
    expect(t.wins).toHaveLength(1);
    expect(t.revealed).toEqual([t.win(0).id]);
  });

  test('3. takeHandoff returns the stored handoff once', () => {
    const t = setup();
    t.open('f:/p/alpha/a.ts', { handoff });
    const id = t.win(0).id;
    expect(t.m.takeHandoff(id)).toEqual(handoff);
    expect(t.m.takeHandoff(id)).toBeNull();
    expect(t.m.takeHandoff(999)).toBeNull();
  });

  test('4. focus reveals the window and passes a line or payload along; unknown key → false', () => {
    const t = setup();
    t.open('f:/p/alpha/a.ts');
    const w = t.win(0);
    expect(t.m.focus(ROOT, 'f:/p/alpha/a.ts')).toBe(true);
    expect(t.revealed).toEqual([w.id]);
    expect(w.of(IPC.evPopoutReveal)).toEqual([]);
    expect(t.m.focus(ROOT, 'f:/p/alpha/a.ts', { line: 12 })).toBe(true);
    expect(w.of(IPC.evPopoutReveal)).toEqual([{ line: 12 }]);
    expect(t.m.focus(ROOT, 't:nope')).toBe(false);
    expect(t.m.focus('/p/other', 'f:/p/alpha/a.ts')).toBe(false);
  });

  test('5. dock sends the tab back to the project window, reveals it and forgets the pop-out', () => {
    const t = setup();
    t.open('f:/p/alpha/a.ts', { payload: { kind: 'file', rel: 'a.ts', mode: 'margin' } });
    t.open('t:a');
    const w = t.win(0);
    const w2 = t.win(1);
    t.m.dock(w.id, { handoff }, { x: 10, y: 20 });
    expect(t.project.last(IPC.evDock)).toEqual({ key: 'f:/p/alpha/a.ts', payload: { kind: 'file', rel: 'a.ts', mode: 'margin' }, handoff, at: { x: 10, y: 20 } });
    expect(t.project.revealed).toBe(1);
    expect(w.calls).toContain('destroy');
    expect(t.m.isPopout(w.id)).toBe(false);
    expect(t.lastSaved().map((s) => s.key)).toEqual(['t:a']);
    expect(t.project.last(IPC.evPopouts)).toEqual(['t:a']);

    // A newer payload from the request wins; no handoff, no point.
    t.m.dock(w2.id, { payload: { kind: 'file', rel: 'b.ts', mode: 'diff' } });
    expect(t.project.last(IPC.evDock)).toEqual({ key: 't:a', payload: { kind: 'file', rel: 'b.ts', mode: 'diff' } });
    expect(t.lastSaved()).toEqual([]);

    // No project window: the pop-out closes (its unsaved guard applies), nothing is intercepted.
    t.open('t:b');
    const w3 = t.win(2);
    t.projects.delete(ROOT);
    t.m.dock(w3.id, {});
    expect(w3.calls).toEqual(['close']);
    expect(w3.of(IPC.evPopoutClose)).toEqual([]);
    expect(w3.destroyed).toBe(true);
    expect(t.m.isPopout(w3.id)).toBe(false);
  });

  test('6. closing a pop-out asks it to dock, then forces the close after 2 s', () => {
    const t = setup();
    t.open('t:a');
    const w = t.win(0);
    w.close();
    expect(w.destroyed).toBe(false);
    expect(w.of(IPC.evPopoutClose)).toEqual([undefined]);
    t.clock.tick(1999);
    expect(w.calls).toEqual(['close']);
    t.clock.tick(1);
    expect(w.calls).toEqual(['close', 'close']);
    expect(w.destroyed).toBe(true);
    expect(w.of(IPC.evPopoutClose)).toHaveLength(1);

    // The renderer docks in time: the timer finds nothing to do.
    t.open('t:b');
    const w2 = t.win(1);
    w2.close();
    t.m.dock(w2.id, {});
    t.clock.tick(2000);
    expect(w2.calls).toEqual(['close', 'destroy']);

    // While quitting the close goes on.
    t.open('t:c');
    const w3 = t.win(2);
    t.m.quitting = true;
    w3.close();
    expect(w3.destroyed).toBe(true);
    expect(w3.of(IPC.evPopoutClose)).toEqual([]);
  });

  test('7. closeForProject closes every pop-out of the project; any Cancel answers false', async () => {
    const t = setup();
    await expect(t.m.closeForProject(ROOT)).resolves.toBe(true);

    t.open('t:a');
    t.open('f:/p/alpha/a.ts');
    for (const w of t.wins) w.autoClose = false;
    const done = t.m.closeForProject(ROOT);
    expect(t.wins.map((w) => w.calls)).toEqual([['close'], ['close']]);
    expect(t.wins.every((w) => w.of(IPC.evPopoutClose).length === 0)).toBe(true);
    t.win(0).finish();
    t.win(1).finish();
    await expect(done).resolves.toBe(true);
    expect(t.lastSaved().map((s) => s.key)).toEqual(['t:a', 'f:/p/alpha/a.ts']);

    // One window cancels its unsaved-files dialog.
    const u = setup();
    u.open('t:a');
    u.open('f:/p/alpha/a.ts');
    for (const w of u.wins) w.autoClose = false;
    const res = u.m.closeForProject(ROOT);
    u.win(0).finish();
    u.cancels.get(u.win(1).id)!();
    await expect(res).resolves.toBe(false);
    // It lost its closing mark: a later close is intercepted again.
    u.win(1).close();
    expect(u.win(1).of(IPC.evPopoutClose)).toHaveLength(1);
  });

  test('8. a closed window leaves the registry; its saved entry goes unless quitting or closing with the project', () => {
    const t = setup();
    t.open('t:a');
    t.open('t:b');
    t.win(0).finish();
    expect(t.m.isPopout(t.win(0).id)).toBe(false);
    expect(t.lastSaved().map((s) => s.key)).toEqual(['t:b']);
    expect(t.project.last(IPC.evPopouts)).toEqual(['t:b']);
    t.m.quitting = true;
    t.win(1).finish();
    expect(t.lastSaved().map((s) => s.key)).toEqual(['t:b']);
    expect(t.m.keys(ROOT)).toEqual([]);
  });

  test('9. restore brings back saved files that exist and terminals that are alive, waiting for the daemon when needed', () => {
    const far: Bounds = { x: 5000, y: 5000, width: 700, height: 500 };
    const near: Bounds = { x: 300, y: 300, width: 700, height: 500 };
    const saved: SavedPopout[] = [
      { root: ROOT, key: 'f:/p/alpha/src/a.ts', bounds: far },
      { root: ROOT, key: 'f:/p/alpha/gone.ts', bounds: near },
      { root: ROOT, key: 'f:/elsewhere/b.ts', bounds: near },
      { root: ROOT, key: 't:live', bounds: near },
      { root: ROOT, key: 't:dead', bounds: near },
      { root: '/p/beta', key: 't:x', bounds: near }
    ];
    const t = setup({ saved, files: ['/p/alpha/src/a.ts', '/elsewhere/b.ts'] });
    t.m.restore(ROOT, ['live']);
    expect(t.created.map((c) => c.bounds)).toEqual([restoreBounds(far, AREAS), restoreBounds(near, AREAS), restoreBounds(near, AREAS)]);
    expect(t.wins.map((w) => t.m.entryOf(w.id))).toEqual([
      { root: ROOT, key: 'f:/p/alpha/src/a.ts', payload: { kind: 'file', rel: 'src/a.ts', mode: 'margin' } },
      { root: ROOT, key: 'f:/elsewhere/b.ts', payload: { kind: 'file', rel: '/elsewhere/b.ts', mode: 'margin' } },
      { root: ROOT, key: 't:live', payload: undefined }
    ]);
    expect(t.lastSaved().map((s) => `${s.root} ${s.key}`)).toEqual([`${ROOT} f:/p/alpha/src/a.ts`, `${ROOT} f:/elsewhere/b.ts`, `${ROOT} t:live`, '/p/beta t:x']);
    expect(t.project.last(IPC.evPopouts)).toEqual(['f:/p/alpha/src/a.ts', 'f:/elsewhere/b.ts', 't:live']);
    // A second restore (the window reloaded) creates nothing new.
    t.m.restore(ROOT, ['live']);
    expect(t.wins).toHaveLength(3);

    // The daemon hasn't listed yet: terminals wait (and count as popped out) until the next list.
    const u = setup({ saved: saved.slice(3) });
    u.m.restore(ROOT, null);
    expect(u.wins).toHaveLength(0);
    expect(u.m.keys(ROOT)).toEqual(['t:live', 't:dead']);
    expect(u.m.live(ROOT)).toBe(0);
    u.m.terminalsChanged([{ id: 'live', projectRoot: ROOT }, { id: 'x', projectRoot: '/p/beta' }]);
    expect(u.wins).toHaveLength(1);
    expect(u.m.entryOf(u.win(0).id)?.key).toBe('t:live');
    expect(u.m.keys(ROOT)).toEqual(['t:live']);
    expect(u.lastSaved().map((s) => s.key)).toEqual(['t:live', 't:x']);
    expect(u.project.last(IPC.evPopouts)).toEqual(['t:live']);
  });

  test('10. a pop-out whose terminal is gone is destroyed and forgotten', () => {
    const t = setup();
    t.open('t:a');
    t.open('t:b');
    t.open('f:/p/alpha/a.ts');
    t.m.terminalsChanged([{ id: 'b', projectRoot: ROOT }]);
    expect(t.win(0).calls).toEqual(['destroy']);
    expect(t.win(1).calls).toEqual([]);
    expect(t.win(2).calls).toEqual([]);
    expect(t.lastSaved().map((s) => s.key)).toEqual(['t:b', 'f:/p/alpha/a.ts']);
    expect(t.project.last(IPC.evPopouts)).toEqual(['t:b', 'f:/p/alpha/a.ts']);
  });

  test('11. moves and resizes save the bounds, debounced 400 ms', () => {
    const t = setup();
    t.open('t:a');
    const w = t.win(0);
    const before = t.saves.length;
    w.bounds = { x: 10, y: 40, width: 800, height: 600 };
    w.emit('moved');
    t.clock.tick(300);
    w.bounds = { x: 20, y: 50, width: 900, height: 600 };
    w.emit('resized');
    t.clock.tick(399);
    expect(t.saves.length).toBe(before);
    t.clock.tick(1);
    expect(t.saves.length).toBe(before + 1);
    expect(t.lastSaved()).toEqual([{ root: ROOT, key: 't:a', bounds: { x: 20, y: 50, width: 900, height: 600 } }]);
  });

  test('11b. a resize without a live resize (Zoom, Fill, tiling: no "resized") is saved too', () => {
    const t = setup();
    t.open('t:a');
    const w = t.win(0);
    const before = t.saves.length;
    w.bounds = { ...w.bounds, width: 1000, height: 700 };
    w.emit('resize');
    t.clock.tick(400);
    expect(t.saves.length).toBe(before + 1);
    expect(t.lastSaved()[0]!.bounds).toEqual(w.bounds);
  });

  test('a file pop-out is remembered only when main may read it then (a project file or a granted one): never on a key the page named alone', () => {
    const t = setup();
    t.env.ungranted.add('/etc/passwd');
    t.open('f:/etc/passwd');
    t.open('f:/out/x.json');
    expect(t.lastSaved().map((s) => s.key)).toEqual(['f:/out/x.json']);
    // Moving it never saves it either.
    t.win(0).emit('moved');
    t.clock.tick(400);
    expect(t.lastSaved().map((s) => s.key)).toEqual(['f:/out/x.json']);
    // Live all the same (the page just can't read it): the main window treats it as popped out.
    expect(t.m.keys(ROOT)).toEqual(['f:/etc/passwd', 'f:/out/x.json']);
  });

  test('rekey: an untitled buffer saved as a file in its pop-out — the entry follows, is remembered, the project window told', () => {
    const t = setup();
    t.open('f:untitled:1', { payload: { kind: 'file', rel: 'Untitled-1', mode: 'margin' } });
    t.open('t:a');
    const w = t.win(0);
    expect(t.lastSaved().map((s) => s.key)).toEqual(['t:a']);
    // Only the sender's own key, never another window's.
    expect(t.m.rekey(t.win(1).id, 'f:untitled:1', 'f:/p/alpha/notes.md')).toBe(false);
    expect(t.m.rekey(w.id, 'f:untitled:2', 'f:/p/alpha/notes.md')).toBe(false);
    expect(t.m.rekey(w.id, 'f:untitled:1', 'f:/p/alpha/notes.md')).toBe(true);
    expect(t.m.entryOf(w.id)).toEqual({ root: ROOT, key: 'f:/p/alpha/notes.md', payload: { kind: 'file', rel: 'notes.md', mode: 'margin' } });
    expect(t.m.windowFor(ROOT, 'f:/p/alpha/notes.md')).toBe(w);
    expect(t.project.last(IPC.evPopouts)).toEqual(['f:/p/alpha/notes.md', 't:a']);
    expect(t.lastSaved()).toEqual([{ root: ROOT, key: 't:a', bounds: t.made(1).bounds }, { root: ROOT, key: 'f:/p/alpha/notes.md', bounds: w.bounds }]);
    // Its moves are saved now; Move Back docks the file.
    w.bounds = { ...w.bounds, x: 33 };
    w.emit('moved');
    t.clock.tick(400);
    expect(t.lastSaved().find((s) => s.key === 'f:/p/alpha/notes.md')!.bounds.x).toBe(33);
    t.m.dock(w.id, {});
    expect(t.project.last(IPC.evDock)).toEqual({ key: 'f:/p/alpha/notes.md', payload: { kind: 'file', rel: 'notes.md', mode: 'margin' } });
  });

  test('a file named through a link is remembered under its real path: moves update it, Move Back and a close drop it', () => {
    const t = setup();
    t.env.real.set('/out/link.json', '/out/real.json');
    t.open('f:/out/link.json');
    const w = t.win(0);
    expect(t.lastSaved()).toEqual([{ root: ROOT, key: 'f:/out/real.json', bounds: w.bounds }]);
    expect(t.m.keys(ROOT)).toEqual(['f:/out/link.json']);
    w.bounds = { ...w.bounds, x: 55 };
    w.emit('moved');
    t.clock.tick(400);
    expect(t.lastSaved()).toEqual([{ root: ROOT, key: 'f:/out/real.json', bounds: w.bounds }]);
    // The project window reloads: no second window for the saved entry of a live one.
    t.m.restore(ROOT, []);
    expect(t.wins).toHaveLength(1);
    t.m.dock(w.id, {});
    expect(t.lastSaved()).toEqual([]);
    t.open('f:/out/link.json');
    expect(t.lastSaved().map((s) => s.key)).toEqual(['f:/out/real.json']);
    t.win(1).finish();
    expect(t.lastSaved()).toEqual([]);
  });

  test('rekey onto a file another pop-out already holds: no second window for it — this one goes (its buffer is on disk), that one comes forward', () => {
    const t = setup();
    t.open('f:/p/alpha/notes.md');
    t.open('f:untitled:1');
    const [held, saving] = [t.win(0), t.win(1)];
    expect(t.m.rekey(saving.id, 'f:untitled:1', 'f:/p/alpha/notes.md')).toBe(false);
    expect(saving.calls).toContain('destroy');
    expect(t.revealed).toEqual([held.id]);
    expect(t.m.keys(ROOT)).toEqual(['f:/p/alpha/notes.md']);
    expect(t.project.last(IPC.evPopouts)).toEqual(['f:/p/alpha/notes.md']);
    expect(t.lastSaved().map((s) => s.key)).toEqual(['f:/p/alpha/notes.md']);
  });

  test('a file the project holds read-only (a terminal link) is remembered so and comes back so', () => {
    const t = setup({ files: ['/out/plan.md'] });
    t.env.readOnly.add('/out/plan.md');
    t.open('f:/out/plan.md');
    const w = t.win(0);
    expect(t.lastSaved()).toEqual([{ root: ROOT, key: 'f:/out/plan.md', bounds: w.bounds, readOnly: true }]);
    // Moved: still remembered read-only.
    w.bounds = { ...w.bounds, x: 55 };
    w.emit('moved');
    t.clock.tick(400);
    expect(t.lastSaved()).toEqual([{ root: ROOT, key: 'f:/out/plan.md', bounds: w.bounds, readOnly: true }]);
    // Made editable since (Open File…): the next save says so.
    t.env.readOnly.delete('/out/plan.md');
    w.bounds = { ...w.bounds, x: 66 };
    w.emit('moved');
    t.clock.tick(400);
    expect(t.lastSaved()).toEqual([{ root: ROOT, key: 'f:/out/plan.md', bounds: w.bounds }]);
    // Made editable by a gesture while it doesn't move: remembered so at once.
    t.env.readOnly.add('/out/plan.md');
    w.emit('moved');
    t.clock.tick(400);
    expect(t.lastSaved()[0]?.readOnly).toBe(true);
    t.env.readOnly.delete('/out/plan.md');
    t.m.editable(ROOT, '/out/plan.md');
    expect(t.lastSaved()).toEqual([{ root: ROOT, key: 'f:/out/plan.md', bounds: w.bounds }]);
    const writes = t.saves.length;
    t.m.editable(ROOT, '/out/other.md');
    expect(t.saves).toHaveLength(writes);
    const near: Bounds = { x: 300, y: 300, width: 700, height: 500 };
    const r = setup({ saved: [{ root: ROOT, key: 'f:/out/plan.md', bounds: near, readOnly: true }, { root: ROOT, key: 'f:/out/x.json', bounds: near }], files: ['/out/plan.md', '/out/x.json'] });
    r.m.restore(ROOT, []);
    expect(r.restored.filter((s) => s.startsWith('restore'))).toEqual([`restore ${ROOT} /out/plan.md read-only`, `restore ${ROOT} /out/x.json`]);
  });

  test('restore asks for every remembered file before its window loads (an outside one is granted again then)', () => {
    const near: Bounds = { x: 300, y: 300, width: 700, height: 500 };
    const t = setup({ saved: [{ root: ROOT, key: 'f:/out/x.json', bounds: near }, { root: ROOT, key: 'f:/out/gone.json', bounds: near }], files: ['/out/x.json'] });
    t.m.restore(ROOT, []);
    expect(t.restored).toEqual([`restore ${ROOT} /out/x.json`, `create ${t.win(0).id}`, `restore ${ROOT} /out/gone.json`]);
    expect(t.lastSaved().map((s) => s.key)).toEqual(['f:/out/x.json']);
  });

  test('12. drag back: the window follows the cursor, fades over the project window and docks where it is dropped', () => {
    const t = setup();
    t.open('t:a');
    const w = t.win(0);
    w.bounds = { x: 1400, y: 300, width: 600, height: 400 };
    t.env.cursor = { x: 1450, y: 320 };
    t.m.dragStart(w.id);
    t.env.cursor = { x: 1500, y: 340 };
    t.clock.tick(16);
    expect(w.bounds).toMatchObject({ x: 1450, y: 320 });
    expect(w.opacity).toBe(1);
    expect(t.project.of(IPC.evDockHover)).toEqual([]);

    // Over the project window's content (zoom 2): fade, and the client point to the project window.
    t.project.z = 2;
    t.env.cursor = { x: 700, y: 428 };
    t.clock.tick(16);
    expect(w.bounds).toMatchObject({ x: 650, y: 408 });
    expect(w.opacity).toBe(0.55);
    // With its key: the project window shows where it lands, in its own space.
    expect(t.project.of(IPC.evDockHover)).toEqual([{ x: 300, y: 150, key: 't:a' }]);
    t.clock.tick(16);
    expect(t.project.of(IPC.evDockHover)).toHaveLength(1);
    // Leaving: back to opaque, hover cleared.
    t.env.cursor = { x: 1600, y: 900 };
    t.clock.tick(16);
    expect(w.opacity).toBe(1);
    expect(t.project.of(IPC.evDockHover)).toEqual([{ x: 300, y: 150, key: 't:a' }, null]);
    // Back over it and released: docked at the point.
    t.env.cursor = { x: 300, y: 228 };
    t.clock.tick(16);
    t.m.dragEnd(w.id, { handoff });
    expect(t.clock.live()).toBe(0);
    expect(w.opacity).toBe(1);
    expect(t.project.last(IPC.evDockHover)).toBeNull();
    expect(t.project.last(IPC.evDock)).toEqual({ key: 't:a', handoff, at: { x: 100, y: 50 } });
    expect(w.destroyed).toBe(true);

    // A press without movement over the project window never docks (a click).
    t.open('t:b');
    const w2 = t.win(1);
    w2.bounds = { x: 200, y: 200, width: 600, height: 400 };
    t.env.cursor = { x: 300, y: 228 };
    t.m.dragStart(w2.id);
    t.env.cursor = { x: 302, y: 229 };
    t.clock.tick(16);
    t.m.dragEnd(w2.id, {});
    expect(w2.destroyed).toBe(false);
    expect(t.project.of(IPC.evDock)).toHaveLength(1);

    // Released elsewhere: stays where it is, its new place saved.
    w2.bounds = { x: 200, y: 200, width: 600, height: 400 };
    t.env.cursor = { x: 300, y: 228 };
    t.m.dragStart(w2.id);
    t.env.cursor = { x: 1700, y: 900 };
    t.clock.tick(16);
    t.m.dragEnd(w2.id, {});
    expect(w2.destroyed).toBe(false);
    expect(w2.bounds).toMatchObject({ x: 1600, y: 872 });
    t.clock.tick(400);
    expect(t.lastSaved()).toEqual([{ root: ROOT, key: 't:b', bounds: { x: 1600, y: 872, width: 600, height: 400 } }]);

    // Cancel: back to the start, opaque, hover cleared.
    t.env.cursor = { x: 1700, y: 900 };
    t.m.dragStart(w2.id);
    t.env.cursor = { x: 400, y: 300 };
    t.clock.tick(16);
    expect(w2.opacity).toBe(0.55);
    t.m.dragCancel(w2.id);
    expect(w2.bounds).toMatchObject({ x: 1600, y: 872 });
    expect(w2.opacity).toBe(1);
    expect(t.project.last(IPC.evDockHover)).toBeNull();
    expect(t.clock.live()).toBe(0);
  });

  // Over another project's window that can take the tab, the hint shows
  // there and the release hands the tab to the mover; one that can't take it gets neither.
  test('drag over another project\'s window: its hint, the release moves the tab there; one that can\'t take it: nothing', () => {
    const t = setup();
    const OTHER = '/p/beta';
    const beta = new FakeProject(2, { x: 1300, y: 100, width: 600, height: 600 }, { x: 1300, y: 128, width: 600, height: 572 });
    const moved: { wcId: number; to: string; at: Point; handoff?: unknown }[] = [];
    let can = true;
    const m = new PopoutManager({
      ...(t.m as unknown as { deps: PopoutDeps }).deps,
      windowAt: (c) => {
        const inside = (b: Bounds) => c.x >= b.x && c.x < b.x + b.width && c.y >= b.y && c.y < b.y + b.height;
        // A new wrapper on every call, as main makes one from the BrowserWindow each time.
        const wrap = (p: FakeProject, root: string) => ({ id: p.id, root, getBounds: () => p.getBounds(), getContentBounds: () => p.getContentBounds(), zoom: () => p.zoom(), send: (c: string, x?: unknown) => p.send(c, x), reveal: () => p.reveal() });
        return inside(beta.getBounds()) ? wrap(beta, OTHER) : inside(MAIN) ? wrap(t.project, ROOT) : null;
      },
      canMove: (from, key, to) => can && from === ROOT && key === 'f:/p/alpha/a.ts' && to === OTHER,
      moveAcross: (wcId, r, to, at) => { moved.push({ wcId, to, at, ...(r.handoff ? { handoff: r.handoff } : {}) }); return Promise.resolve({ ok: true }); }
    });
    m.open(ROOT, { key: 'f:/p/alpha/a.ts', size: SIZE, at: 'cascade' });
    const w = t.wins.at(-1)!;
    w.bounds = { x: 900, y: 850, width: 600, height: 200 };
    t.env.cursor = { x: 950, y: 870 };
    m.dragStart(w.id);
    // Over beta's content: faded, the hint in beta (none in the project's own window).
    t.env.cursor = { x: 1400, y: 228 };
    t.clock.tick(16);
    expect(w.opacity).toBe(0.55);
    expect(beta.of(IPC.evDockHover)).toEqual([{ x: 100, y: 100, across: true }]);
    expect(t.project.of(IPC.evDockHover)).toEqual([]);
    // Resting there: nothing more is sent (no flicker).
    t.clock.tick(16 * 5);
    expect(beta.of(IPC.evDockHover)).toEqual([{ x: 100, y: 100, across: true }]);
    // Back over the project's own window: beta's hint goes, the project's shows.
    t.env.cursor = { x: 300, y: 228 };
    t.clock.tick(16);
    expect(beta.of(IPC.evDockHover)).toEqual([{ x: 100, y: 100, across: true }, null]);
    expect(t.project.of(IPC.evDockHover)).toEqual([{ x: 200, y: 100, key: 'f:/p/alpha/a.ts' }]);
    // Released over beta: the mover gets it with the point; nothing docks home, the window waits for the mover.
    t.env.cursor = { x: 1400, y: 228 };
    t.clock.tick(16);
    m.dragEnd(w.id, { handoff });
    expect(moved).toEqual([{ wcId: w.id, to: OTHER, at: { x: 100, y: 100 }, handoff }]);
    expect(t.project.of(IPC.evDock)).toEqual([]);
    expect(beta.last(IPC.evDockHover)).toBeNull();
    expect(w.destroyed).toBe(false);
    // A tab beta can't take: no hint there, released there nothing moves.
    can = false;
    const hints = beta.of(IPC.evDockHover).filter((p) => p !== null).length;
    t.env.cursor = { x: 1400, y: 228 };
    m.dragStart(w.id);
    t.env.cursor = { x: 1450, y: 300 };
    t.clock.tick(16);
    expect(w.opacity).toBe(1);
    expect(beta.of(IPC.evDockHover).filter((p) => p !== null)).toHaveLength(hints);
    m.dragEnd(w.id, {});
    expect(moved).toHaveLength(1);
    expect(t.project.of(IPC.evDock)).toEqual([]);
  });

  test('release: its tab went to another project\'s window — the window goes, forgotten and unsaved, nothing docks home', () => {
    const t = setup();
    t.open('t:a');
    const w = t.win(0);
    expect(t.lastSaved().map((s) => s.key)).toEqual(['t:a']);
    t.m.release(w.id);
    expect(w.destroyed).toBe(true);
    expect(t.project.of(IPC.evDock)).toEqual([]);
    expect(t.lastSaved()).toEqual([]);
    expect(t.project.last(IPC.evPopouts)).toEqual([]);
    expect(t.m.isPopout(w.id)).toBe(false);
    t.m.release(w.id);
  });

  // While another project's window decides on its tab, the pop-out stays put — no Move Back, close
  // or new drag that would dock it home as well.
  test('hold: while held, dock, a close and a new drag do nothing; let go, they work again', () => {
    const t = setup();
    t.open('t:a');
    const w = t.win(0);
    t.m.hold(w.id, true);
    t.m.dock(w.id, {});
    let prevented = false;
    t.m.closeRequested(w.id, { preventDefault: () => { prevented = true; } });
    t.m.dragStart(w.id);
    expect(t.project.of(IPC.evDock)).toEqual([]);
    expect(prevented).toBe(true);
    expect(w.of(IPC.evPopoutClose)).toEqual([]);
    expect(t.clock.live()).toBe(0);
    t.m.hold(w.id, false);
    t.m.dock(w.id, {});
    expect(t.project.of(IPC.evDock)).toHaveLength(1);
  });

  test('recall asks a live pop-out to dock; a waiting one is simply forgotten', () => {
    const t = setup({ saved: [{ root: ROOT, key: 't:w', bounds: { x: 0, y: 25, width: 600, height: 400 } }] });
    t.open('t:a');
    t.m.recall(ROOT, 't:a');
    expect(t.win(0).of(IPC.evPopoutClose)).toEqual([undefined]);
    t.m.restore(ROOT, null);
    expect(t.m.keys(ROOT)).toEqual(['t:a', 't:w']);
    t.m.recall(ROOT, 't:w');
    expect(t.m.keys(ROOT)).toEqual(['t:a']);
    expect(t.lastSaved().map((s) => s.key)).toEqual(['t:a']);
    expect(t.project.last(IPC.evPopouts)).toEqual(['t:a']);
  });
});

/** A promise's value once the microtasks ran, or 'pending'. */
async function state<T>(p: Promise<T>): Promise<T | 'pending'> {
  let v: T | 'pending' = 'pending';
  void p.then((x) => { v = x; });
  for (let i = 0; i < 5; i++) await Promise.resolve();
  return v;
}

describe('PopoutManager close lifecycle', () => {
  test('a dock request arriving during a project close is ignored and the close still resolves true', async () => {
    const t = setup();
    t.open('t:a');
    t.open('t:b');
    for (const w of t.wins) w.autoClose = false;
    const done = t.m.closeForProject(ROOT);
    t.m.dock(t.win(0).id, {});
    expect(t.project.of(IPC.evDock)).toEqual([]);
    expect(t.win(0).calls).toEqual(['close']);
    t.win(0).finish();
    t.win(1).finish();
    expect(await state(done)).toBe(true);
    expect(t.lastSaved().map((s) => s.key)).toEqual(['t:a', 't:b']);
  });

  test('a terminal ending while a project close waits on its window still lets the close resolve true', async () => {
    const t = setup();
    t.open('t:a');
    t.open('f:/p/alpha/a.ts');
    for (const w of t.wins) w.autoClose = false;
    const done = t.m.closeForProject(ROOT);
    t.m.terminalsChanged([]);
    expect(t.win(0).destroyed).toBe(true);
    expect(await state(done)).toBe('pending');
    t.win(1).finish();
    expect(await state(done)).toBe(true);
  });

  test('the forced-close timer never overrides a project close', async () => {
    const t = setup();
    t.open('t:a');
    const w = t.win(0);
    w.autoClose = false;
    w.close(); // intercepted: asks to dock, arms the 2 s timer
    const done = t.m.closeForProject(ROOT);
    t.clock.tick(2000);
    expect(w.calls).toEqual(['close', 'close']);
    w.finish();
    expect(await state(done)).toBe(true);
    expect(t.lastSaved().map((s) => s.key)).toEqual(['t:a']);
  });

  test('two project closes in flight share one answer', async () => {
    const t = setup();
    t.open('t:a');
    t.win(0).autoClose = false;
    const a = t.m.closeForProject(ROOT);
    const b = t.m.closeForProject(ROOT);
    expect(t.win(0).calls).toEqual(['close']);
    t.win(0).finish();
    expect(await state(a)).toBe(true);
    expect(await state(b)).toBe(true);
  });

  test('after a Cancel the other pop-outs lose their project mark: a later close docks and the saved entry follows the usual rules', async () => {
    const t = setup();
    t.open('t:a');
    t.open('t:b');
    for (const w of t.wins) w.autoClose = false;
    const done = t.m.closeForProject(ROOT);
    t.cancels.get(t.win(1).id)!();
    expect(await state(done)).toBe(false);
    t.win(0).close();
    expect(t.win(0).of(IPC.evPopoutClose)).toHaveLength(1);
    t.win(0).finish();
    expect(t.lastSaved().map((s) => s.key)).toEqual(['t:b']);
  });

  test('a window whose close was under way when another cancelled the project close comes back once closed', async () => {
    const t = setup();
    t.open('t:a');
    t.open('f:/p/alpha/a.ts');
    for (const w of t.wins) w.autoClose = false;
    const done = t.m.closeForProject(ROOT);
    // The file's dialog answers Cancel before the session's page has finished closing.
    t.cancels.get(t.win(1).id)!();
    expect(await state(done)).toBe(false);
    const bounds = t.win(0).getBounds();
    t.win(0).finish();
    // The project stays open: the session's window comes back where it was, still remembered.
    expect(t.wins).toHaveLength(3);
    expect(t.m.entryOf(t.win(2).id)).toEqual({ root: ROOT, key: 't:a' });
    expect(t.made(2).bounds).toEqual(bounds);
    expect(t.lastSaved().map((s) => s.key).sort()).toEqual(['f:/p/alpha/a.ts', 't:a']);
    expect(t.project.last(IPC.evPopouts)).toEqual(['f:/p/alpha/a.ts', 't:a']);
    // Kept instead (its own dialog said Save All or Cancel): an ordinary pop-out, a later close docks.
    const u = setup();
    u.open('t:a');
    u.open('f:/p/alpha/a.ts');
    for (const w of u.wins) w.autoClose = false;
    const res = u.m.closeForProject(ROOT);
    u.cancels.get(u.win(1).id)!();
    expect(await state(res)).toBe(false);
    u.kepts.get(u.win(0).id)!();
    u.win(0).finish();
    expect(u.wins).toHaveLength(2);
    expect(u.lastSaved().map((s) => s.key)).toEqual(['f:/p/alpha/a.ts']);
  });

  test('a window still closing when a second project close starts closes with the project (no comeback); cancelled again, it comes back', async () => {
    const t = setup();
    t.open('t:a');
    t.open('f:/p/alpha/a.ts');
    for (const w of t.wins) w.autoClose = false;
    const first = t.m.closeForProject(ROOT);
    t.cancels.get(t.win(1).id)!();
    expect(await state(first)).toBe(false);
    // The session's page is still closing; the project window closes again: both are waited on.
    const second = t.m.closeForProject(ROOT);
    t.win(1).finish();
    expect(await state(second)).toBe('pending');
    t.win(0).finish();
    expect(await state(second)).toBe(true);
    // Closed with the project: nothing comes back, both stay remembered for the next open.
    expect(t.wins).toHaveLength(2);
    expect(t.lastSaved().map((s) => s.key).sort()).toEqual(['f:/p/alpha/a.ts', 't:a']);

    const u = setup();
    u.open('t:a');
    u.open('f:/p/alpha/a.ts');
    for (const w of u.wins) w.autoClose = false;
    const one = u.m.closeForProject(ROOT);
    u.cancels.get(u.win(1).id)!();
    expect(await state(one)).toBe(false);
    const two = u.m.closeForProject(ROOT);
    u.cancels.get(u.win(1).id)!();
    expect(await state(two)).toBe(false);
    // Cancelled again while the session's page was still closing: once closed, it comes back.
    u.win(0).finish();
    expect(u.wins).toHaveLength(3);
    expect(u.m.entryOf(u.win(2).id)).toEqual({ root: ROOT, key: 't:a' });
  });

  test('a project close drops its waiting terminals (they stay saved); a Cancel keeps them waiting', async () => {
    const saved: SavedPopout[] = [{ root: ROOT, key: 't:w', bounds: { x: 0, y: 25, width: 600, height: 400 } }];
    const t = setup({ saved });
    t.m.restore(ROOT, null);
    expect(t.m.keys(ROOT)).toEqual(['t:w']);
    expect(await state(t.m.closeForProject(ROOT))).toBe(true);
    expect(t.m.keys(ROOT)).toEqual([]);
    t.m.terminalsChanged([{ id: 'w', projectRoot: ROOT }]);
    expect(t.wins).toHaveLength(0);
    expect(t.lastSaved().map((s) => s.key)).toEqual(['t:w']);

    const u = setup({ saved });
    u.m.restore(ROOT, null);
    u.open('t:a');
    u.win(0).autoClose = false;
    const res = u.m.closeForProject(ROOT);
    u.cancels.get(u.win(0).id)!();
    expect(await state(res)).toBe(false);
    expect(u.m.keys(ROOT)).toEqual(['t:a', 't:w']);
  });

  test('a window leaving the registry or a second dragStart ends the drag: opaque again, hover cleared', () => {
    const t = setup();
    t.open('t:a');
    const w = t.win(0);
    w.bounds = { x: 1400, y: 300, width: 600, height: 400 };
    t.env.cursor = { x: 1450, y: 320 };
    t.m.dragStart(w.id);
    t.env.cursor = { x: 700, y: 428 };
    t.clock.tick(16);
    expect(w.opacity).toBe(0.55);
    t.m.dragStart(w.id);
    expect(w.opacity).toBe(1);
    expect(t.project.last(IPC.evDockHover)).toBeNull();
    t.clock.tick(16);
    expect(w.opacity).toBe(0.55);
    t.m.terminalsChanged([]);
    expect(t.project.last(IPC.evDockHover)).toBeNull();
    expect(t.clock.live()).toBe(0);
  });

  test('a page that crashes or reloads mid-drag ends the drag: back where it started, opaque, hover cleared', () => {
    for (const ev of ['page-gone', 'page-loading'] as const) {
      const t = setup();
      t.open('t:a');
      const w = t.win(0);
      w.bounds = { x: 1400, y: 300, width: 600, height: 400 };
      t.env.cursor = { x: 1450, y: 320 };
      t.m.dragStart(w.id);
      t.env.cursor = { x: 700, y: 428 };
      t.clock.tick(16);
      expect(w.opacity).toBe(0.55);
      w.emit(ev);
      expect(w.bounds).toMatchObject({ x: 1400, y: 300 });
      expect(w.opacity).toBe(1);
      expect(t.project.last(IPC.evDockHover)).toBeNull();
      expect(t.clock.live()).toBe(0);
      // Not dragging: nothing happens.
      w.emit(ev);
      expect(w.bounds).toMatchObject({ x: 1400, y: 300 });
    }
  });

  test('bounds are not saved while the window is full screen or minimized', () => {
    const t = setup();
    t.open('t:a');
    const w = t.win(0);
    const before = t.lastSaved()[0]!.bounds;
    for (const flag of ['fullScreen', 'minimized'] as const) {
      w[flag] = true;
      w.bounds = { x: 0, y: 25, width: 1920, height: 1055 };
      w.emit('resize');
      t.clock.tick(400);
      expect(t.lastSaved()[0]!.bounds).toEqual(before);
      w[flag] = false;
    }
    w.bounds = { x: 10, y: 40, width: 700, height: 500 };
    w.emit('resize');
    t.clock.tick(400);
    expect(t.lastSaved()[0]!.bounds).toEqual({ x: 10, y: 40, width: 700, height: 500 });
  });

  test('a dock while quitting keeps the saved entry', () => {
    const t = setup();
    t.open('t:a');
    t.m.quitting = true;
    t.m.dock(t.win(0).id, {});
    expect(t.project.of(IPC.evDock)).toHaveLength(1);
    expect(t.lastSaved().map((s) => s.key)).toEqual(['t:a']);
  });

  test('a page kept by Save All during a project close cancels it like a Cancel; a fresh close is answered again', async () => {
    const t = setup();
    t.open('t:a');
    t.open('f:/p/alpha/a.ts');
    for (const w of t.wins) w.autoClose = false;
    const done = t.m.closeForProject(ROOT);
    expect(t.m.closingProject(ROOT)).toBe(true);
    t.win(0).finish();
    // Save All: the page stays while it saves (the save may fail: nothing else would ever settle the close).
    t.kepts.get(t.win(1).id)!();
    expect(await state(done)).toBe(false);
    expect(t.m.closingProject(ROOT)).toBe(false);
    // The save went through and the page closes itself: an ordinary pop-out again, it docks.
    t.win(1).close();
    expect(t.win(1).of(IPC.evPopoutClose)).toHaveLength(1);
    // A new project close closes it again and settles.
    const again = t.m.closeForProject(ROOT);
    expect(t.m.closingProject(ROOT)).toBe(true);
    t.win(1).finish();
    expect(await state(again)).toBe(true);
    expect(t.m.closingProject(ROOT)).toBe(false);
  });

  test('a kept page outside a project close changes nothing: a forced close still goes through after its save', () => {
    const t = setup();
    t.open('t:a');
    const w = t.win(0);
    w.autoClose = false;
    w.close(); // intercepted: asks to dock, arms the 2 s timer
    t.clock.tick(2000); // no answer: closes for good, the guard asks
    t.kepts.get(w.id)!(); // Save All
    w.close(); // the save went through: the page closes itself
    expect(w.of(IPC.evPopoutClose)).toHaveLength(1);
  });
});

describe('popoutFileRules', () => {
  const setupRules = () => {
    const granted = new Set<string>(['/out/old.json']);
    const onDisk = new Set<string>(['/p/alpha/a.ts', '/out/old.json', '/out/new.json']);
    // Links: their real paths.
    const links = new Map<string, string>([['/out/link.json', '/out/old.json'], ['/p/alpha/away.ts', '/out/new.json']]);
    const real = (p: string) => links.get(p) ?? (onDisk.has(p) ? p : null);
    const grants: string[] = [];
    const watched: [string, string[]][] = [];
    const readOnly = new Set<string>();
    const rules = popoutFileRules({
      inside: (_root, p) => { const r = real(p); return r && r.startsWith('/p/alpha/') ? r : null; },
      isFile: (p) => real(p) !== null,
      real,
      check: (_root, p) => { const r = real(p); return r && granted.has(r) ? r : null; },
      mode: (_root, p) => (granted.has(p) ? (readOnly.has(p) ? 'read' : 'edit') : null),
      grant: (_root, p, ro) => { const r = real(p); if (!r) return null; grants.push(ro ? `${r} read-only` : r); granted.add(r); return r; },
      opened: (root, files) => { watched.push([root, files]); }
    });
    return { rules, grants, watched, links, readOnly };
  };

  test('read-only: an outside file the project holds only through a read grant; granted again so', () => {
    const { rules, grants, readOnly } = setupRules();
    expect(rules.readOnly(ROOT, '/out/old.json')).toBe(false);
    readOnly.add('/out/old.json');
    expect(rules.readOnly(ROOT, '/out/old.json')).toBe(true);
    expect(rules.readOnly(ROOT, '/out/new.json')).toBe(false);
    expect(rules.readOnly(ROOT, '/p/alpha/a.ts')).toBe(false);
    expect(rules.restoreFile(ROOT, '/out/new.json', true)).toBe(true);
    expect(grants).toEqual(['/out/new.json read-only']);
  });

  test('remembered: a project file as spelled, an outside granted file by its real path; never one the page named alone', () => {
    const { rules, grants } = setupRules();
    expect(rules.remember(ROOT, '/p/alpha/a.ts')).toBe('/p/alpha/a.ts');
    expect(rules.remember(ROOT, '/out/old.json')).toBe('/out/old.json');
    // Named through a link: saved under what the grant really is.
    expect(rules.remember(ROOT, '/out/link.json')).toBe('/out/old.json');
    expect(rules.remember(ROOT, '/out/new.json')).toBeNull();
    expect(rules.remember(ROOT, '/etc/passwd')).toBeNull();
    expect(grants).toEqual([]);
  });

  test('restored: a project file on disk; an outside file is granted again (main saved it from a grant) and watched', () => {
    const { rules, grants, watched } = setupRules();
    expect(rules.restoreFile(ROOT, '/p/alpha/a.ts')).toBe(true);
    expect(rules.restoreFile(ROOT, '/p/alpha/gone.ts')).toBe(false);
    expect(grants).toEqual([]);
    expect(rules.restoreFile(ROOT, '/out/new.json')).toBe(true);
    expect(grants).toEqual(['/out/new.json']);
    expect(watched).toEqual([[ROOT, ['/out/new.json']]]);
    expect(rules.restoreFile(ROOT, '/out/missing.json')).toBe(false);
    expect(watched).toHaveLength(1);
  });

  test('restored: a saved path that resolves elsewhere now (a link put or retargeted since) is never granted', () => {
    const { rules, grants, links } = setupRules();
    // A project file whose path became a link out of the project.
    expect(rules.restoreFile(ROOT, '/p/alpha/away.ts')).toBe(false);
    // An outside file saved by its real path, a link now.
    links.set('/out/old.json', '/out/new.json');
    expect(rules.restoreFile(ROOT, '/out/old.json')).toBe(false);
    expect(grants).toEqual([]);
  });
});
