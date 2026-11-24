import { describe, expect, test } from 'vitest';
import { PhoneWindows, WINDOW_CLOSE_MS, type PhoneWindowsDeps } from './phone-windows';

// A paired phone opening a project's window, as opening a recent project does, or closing it, as its own close does:
// with the phone's user's answer about what is busy, never a question on this computer.

class FakeWin {
  closed = false;
  closes = 0;
  /** False: a close is held (something on this computer called it off or still asks). */
  goes = true;
  private readonly gone = new Set<() => void>();
  constructor(readonly root: string) {}
  close() {
    this.closes++;
    if (!this.goes) return;
    this.closed = true;
    for (const cb of [...this.gone]) cb();
  }
  whenClosed(cb: () => void) { this.gone.add(cb); return () => { this.gone.delete(cb); }; }
  listeners() { return this.gone.size; }
}

function setup(o: { deps?: Partial<PhoneWindowsDeps<FakeWin>>; dirs?: string[]; unsaved?: string[]; holds?: boolean } = {}) {
  const wins = new Map<string, FakeWin>();
  const decisions: [string, 'keep' | 'stop' | undefined][] = [];
  const undone: string[] = [];
  const opened: string[] = [];
  const w = new PhoneWindows<FakeWin>({
    windowOf: (root) => { const x = wins.get(root); return x && !x.closed ? x : null; },
    open: (root) => { opened.push(root); const x = wins.get(root) ?? new FakeWin(root); x.closed = false; wins.set(root, x); return x; },
    isDir: (root) => (o.dirs ?? ['/work/app', '/work/old']).includes(root),
    unsaved: (root) => (o.unsaved ?? []).includes(root),
    decide: async (root, sessions) => { decisions.push([root, sessions]); return o.holds ?? true; },
    undecide: (root) => { undone.push(root); },
    quitsOnClose: () => false,
    quitting: () => false,
    close: (x) => x.close(),
    whenClosed: (x, cb) => x.whenClosed(cb),
    timeoutMs: 40,
    ...o.deps
  });
  const openNow = (root: string) => { const x = new FakeWin(root); wins.set(root, x); return x; };
  return { w, wins, decisions, undone, opened, openNow };
}

describe('open', () => {
  test('a closed project opens; an open one comes to the front the same way; a folder that is gone does not', async () => {
    const { w, opened } = setup();
    expect(await w.open('/work/old')).toEqual({ ok: true });
    expect(await w.open('/work/old')).toEqual({ ok: true });
    expect(opened).toEqual(['/work/old', '/work/old']);
    expect(await w.open('/work/gone')).toEqual({ ok: false, code: 'failed', message: 'The project\'s folder isn\'t there any more.' });
    expect(opened).toHaveLength(2);
  });

  test('a window that can\'t be made: failed', async () => {
    const { w } = setup({ deps: { open: () => null } });
    expect(await w.open('/work/app')).toEqual({ ok: false, code: 'failed', message: 'The project\'s window could not be opened.' });
  });
});

describe('close', () => {
  test('decided with the phone\'s answer first, then closed; done once the window is gone', async () => {
    const { w, decisions, openNow } = setup();
    const win = openNow('/work/app');
    expect(await w.close('/work/app', 'keep')).toEqual({ ok: true });
    expect(decisions).toEqual([['/work/app', 'keep']]);
    expect([win.closes, win.closed, win.listeners()]).toEqual([1, true, 0]);
    openNow('/work/old');
    expect(await w.close('/work/old')).toEqual({ ok: true });
    expect(decisions.at(-1)).toEqual(['/work/old', undefined]);
  });

  test('a window already closed: done, nothing decided', async () => {
    const { w, decisions } = setup();
    expect(await w.close('/work/app', 'stop')).toEqual({ ok: true });
    expect(decisions).toEqual([]);
  });

  test('unsaved files in it or its pop-outs: refused in words, nothing decided or closed', async () => {
    const { w, decisions, openNow } = setup({ unsaved: ['/work/app'] });
    const win = openNow('/work/app');
    expect(await w.close('/work/app', 'stop')).toEqual({ ok: false, code: 'invalid', message: 'It has unsaved files: save or close them on this computer first.' });
    expect([decisions, win.closes]).toEqual([[], 0]);
  });

  test('a window that went while deciding: done; a decision that didn\'t hold, or a close held past the wait: failed', async () => {
    // Closed on this computer while the phone's close was decided: nothing left to do.
    let win: FakeWin | null = null;
    const gone = setup({ deps: { decide: async () => { win!.closed = true; return false; } } });
    win = gone.openNow('/work/app');
    expect(await gone.w.close('/work/app')).toEqual({ ok: true });
    expect(win.closes).toBe(0);
    const stale = setup({ holds: false });
    const kept = stale.openNow('/work/app');
    expect(await stale.w.close('/work/app')).toEqual({ ok: false, code: 'failed', message: 'The window didn\'t close.' });
    expect(kept.closes).toBe(0);
    const held = setup();
    const h = held.openNow('/work/app');
    h.goes = false;
    expect(await held.w.close('/work/app', 'keep')).toEqual({ ok: false, code: 'failed', message: 'The window didn\'t close.' });
    expect([h.closes, h.listeners()]).toEqual([1, 0]);
  });

  test('a close that didn\'t happen leaves no decision behind: a later close on this computer asks as usual', async () => {
    const held = setup();
    held.openNow('/work/app').goes = false;
    expect(await held.w.close('/work/app', 'stop')).toMatchObject({ ok: false });
    expect(held.undone).toEqual(['/work/app']);
    // Done: nothing to take back.
    const done = setup();
    done.openNow('/work/app');
    expect(await done.w.close('/work/app', 'stop')).toEqual({ ok: true });
    expect(done.undone).toEqual([]);
  });

  test('a file left unsaved while the close was decided: refused, the decision taken back, nothing closed', async () => {
    const dirty: string[] = [];
    const late = setup({ deps: { unsaved: (root) => dirty.includes(root), decide: async () => { dirty.push('/work/app'); return true; } } });
    const win = late.openNow('/work/app');
    expect(await late.w.close('/work/app', 'stop')).toEqual({ ok: false, code: 'invalid', message: 'It has unsaved files: save or close them on this computer first.' });
    expect([win.closes, late.undone]).toEqual([0, ['/work/app']]);
  });

  test('a close that would quit Atelier (Windows, its last window, no notification-area icon): refused, nothing decided', async () => {
    const last = setup({ deps: { quitsOnClose: (root) => root === '/work/app' } });
    const win = last.openNow('/work/app');
    expect(await last.w.close('/work/app', 'keep')).toEqual({ ok: false, code: 'invalid', message: 'It is Atelier\'s last window here: closing it would quit Atelier, and the phone could not reach it again.' });
    expect([win.closes, last.decisions]).toEqual([0, []]);
  });

  test('while Atelier quits, no window opens', async () => {
    const q = setup({ deps: { quitting: () => true } });
    expect(await q.w.open('/work/app')).toEqual({ ok: false, code: 'failed', message: 'Atelier is quitting.' });
    expect(q.opened).toEqual([]);
  });

  test('waits at most ten seconds by default', () => {
    expect(WINDOW_CLOSE_MS).toBe(10_000);
  });
});
