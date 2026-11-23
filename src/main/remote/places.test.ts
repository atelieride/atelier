import { afterEach, describe, expect, test, vi } from 'vitest';
import type { RemotePlaceRequest } from '@shared/remote';
import { PLACES_TIMEOUT_MS, PlaceRequests } from './places';

/** Windows by project root (their webContents ids), what each was sent, and which roots were opened. */
function setup(o: { windows?: Record<string, number>; openAs?: number | null; timeoutMs?: number } = {}) {
  const windows = new Map(Object.entries(o.windows ?? {}));
  const sent: [number, RemotePlaceRequest][] = [];
  const opened: string[] = [];
  const places = new PlaceRequests({
    windowOf: (root) => windows.get(root) ?? null,
    open: (root) => {
      opened.push(root);
      const id = o.openAs === undefined ? 9 : o.openAs;
      if (id !== null) windows.set(root, id);
      return id;
    },
    send: (wcId, req) => sent.push([wcId, req]),
    ...(o.timeoutMs ? { timeoutMs: o.timeoutMs } : {})
  });
  return { places, sent, opened, windows };
}

afterEach(() => { vi.useRealTimers(); });

describe('changes to a project\'s places, through its main window', () => {
  test('an open window that listens gets the change at once; its answer is the answer', async () => {
    const t = setup({ windows: { '/work/app': 3 } });
    expect(t.places.takeHeld(3)).toEqual([]);
    const answer = t.places.apply('/work/app', { kind: 'workspace' });
    expect(t.sent).toEqual([[3, { id: 1, op: { kind: 'workspace' } }]]);
    expect(t.places.done(3, 1, { ok: true, place: 'w2' })).toBe(true);
    expect(await answer).toEqual({ ok: true, place: 'w2' });
    expect(t.opened).toEqual([]);
    // Answered once: a second answer finds nothing.
    expect(t.places.done(3, 1, { ok: true })).toBe(false);
  });

  test('a closed window is opened as a recent project is; the change waits until its page listens', async () => {
    const t = setup();
    const answer = t.places.apply('/work/app', { kind: 'rename', place: 'w1', name: 'Auth' });
    expect(t.opened).toEqual(['/work/app']);
    expect(t.sent).toEqual([]);
    // Its page is ready: what waited for it is handed over, and later changes are sent.
    expect(t.places.takeHeld(9)).toEqual([{ id: 1, op: { kind: 'rename', place: 'w1', name: 'Auth' } }]);
    const next = t.places.apply('/work/app', { kind: 'move', id: 't1', place: 'w1' });
    expect(t.sent).toEqual([[9, { id: 2, op: { kind: 'move', id: 't1', place: 'w1' } }]]);
    t.places.done(9, 2, { ok: true });
    t.places.done(9, 1, { ok: false, code: 'not-found', message: 'Gone.' });
    expect(await answer).toEqual({ ok: false, code: 'not-found', message: 'Gone.' });
    expect(await next).toEqual({ ok: true });
  });

  test('a window that can\'t be opened: failed at once', async () => {
    const t = setup({ openAs: null });
    expect(await t.places.apply('/gone', { kind: 'workspace' })).toMatchObject({ ok: false, code: 'failed' });
  });

  test('no answer within 10 s: failed, and what was still held for the page is dropped', async () => {
    vi.useFakeTimers();
    const t = setup();
    const answer = t.places.apply('/work/app', { kind: 'workspace' });
    vi.advanceTimersByTime(PLACES_TIMEOUT_MS - 1);
    let settled = false;
    void answer.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    vi.advanceTimersByTime(1);
    expect(await answer).toEqual({ ok: false, code: 'failed', message: 'The project\'s window did not answer in time.' });
    expect(t.places.takeHeld(9)).toEqual([]);
    expect(PLACES_TIMEOUT_MS).toBe(10_000);
  });

  test('only the window a change went to can answer it', async () => {
    const t = setup({ windows: { '/work/app': 3 } });
    t.places.takeHeld(3);
    const answer = t.places.apply('/work/app', { kind: 'workspace' });
    expect(t.places.done(4, 1, { ok: true, place: 'evil' })).toBe(false);
    t.places.done(3, 1, { ok: true, place: 'w2' });
    expect(await answer).toEqual({ ok: true, place: 'w2' });
  });

  test('the page reloads: a change it was given fails (its outcome is unknown); one not sent yet waits for the new page', async () => {
    const t = setup({ windows: { '/work/app': 3 } });
    t.places.takeHeld(3);
    const sentOne = t.places.apply('/work/app', { kind: 'workspace' });
    t.places.pageLoading(3);
    expect(await sentOne).toMatchObject({ ok: false, code: 'failed' });
    const waiting = t.places.apply('/work/app', { kind: 'workspace', name: 'B' });
    expect(t.sent).toHaveLength(1);
    expect(t.places.takeHeld(3)).toEqual([{ id: 2, op: { kind: 'workspace', name: 'B' } }]);
    t.places.done(3, 2, { ok: true, place: 'w3' });
    expect(await waiting).toEqual({ ok: true, place: 'w3' });
  });

  test('the window closes: everything it had or waited for fails now', async () => {
    const t = setup({ windows: { '/work/app': 3 } });
    t.places.takeHeld(3);
    const a = t.places.apply('/work/app', { kind: 'workspace' });
    t.places.pageLoading(3);
    const b = t.places.apply('/work/app', { kind: 'workspace' });
    t.places.closed(3);
    expect(await a).toMatchObject({ ok: false, code: 'failed' });
    expect(await b).toMatchObject({ ok: false, code: 'failed' });
    expect(t.places.takeHeld(3)).toEqual([]);
  });
});
