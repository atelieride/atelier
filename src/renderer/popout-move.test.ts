import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { DockRequest, EditorHandoff } from '@shared/popout';
import { registerSaver } from './editor/savers';
import { hasHandoff, isMoving, putHandoff, takeHandoff } from './editor/handoff';
import { useApp } from './store';
import { single } from './split';
import { tabMove } from './popout-move';
import { DRAG_THRESHOLD } from '@shared/popout';
import { HANDLE_THRESHOLD, dragBackEnd, moveBack, pastThreshold } from './popout-actions';

// Tab pop-out windows: a tab leaving a window takes its payload and, for a file, its editor's
// buffer, taken with the editor frozen until the other side answered (a keystroke meanwhile would stay behind).
const handoff = (path: string): EditorHandoff => ({ path, state: { doc: 'mine', selection: { ranges: [{ anchor: 0, head: 0 }], main: 0 } }, saved: 'disk', stamp: null, eol: 'lf', scrollTop: 0 });
const dock = vi.fn(async (_r: DockRequest) => {});
const dragEnd = vi.fn(async (_r: DockRequest) => {});
const g = globalThis as { window?: unknown };
const st = () => useApp.getState();

beforeEach(() => {
  g.window = { addEventListener: () => {}, atelier: { popout: { dock, dragEnd } } };
  dock.mockReset(); dock.mockImplementation(async () => {});
  dragEnd.mockReset(); dragEnd.mockImplementation(async () => {});
  useApp.setState({ project: null, openFiles: [], activeTab: 'term', tabOrder: [], terminals: [], selectedId: null, review: null, historyTab: null, backgroundTab: null, dockerTabs: [], redisTabs: [], revFiles: [], split: single(), popout: null, poppedOut: [] });
});
afterEach(() => { delete g.window; });

test('a file: its payload and buffer, the editor frozen while the other side answers, then released', async () => {
  st().openFile('/p/a.ts', 'a.ts', null, 'diff');
  const h = handoff('/p/a.ts');
  const off = registerSaver('/p/a.ts', async () => true, () => true, () => h);
  const during: boolean[] = [];
  const r = await tabMove(st(), 'f:/p/a.ts', async (req) => { during.push(isMoving('/p/a.ts')); return req; });
  expect(r).toEqual({ payload: { kind: 'file', rel: 'a.ts', mode: 'diff' }, handoff: h });
  expect(during).toEqual([true]);
  expect(isMoving('/p/a.ts')).toBe(false);
  off();
});

test('released when the other side fails, or the send throws before giving a promise', async () => {
  st().openFile('/p/a.ts', 'a.ts');
  const off = registerSaver('/p/a.ts', async () => true, () => true, () => handoff('/p/a.ts'));
  await expect(tabMove(st(), 'f:/p/a.ts', async () => { throw new Error('gone'); })).rejects.toThrow('gone');
  expect(isMoving('/p/a.ts')).toBe(false);
  await expect(tabMove(st(), 'f:/p/a.ts', (() => { throw new Error('no bridge'); }) as never)).rejects.toThrow('no bridge');
  expect(isMoving('/p/a.ts')).toBe(false);
  off();
});

test('a file whose editor isn\'t built yet (moved again right after it arrived): the buffer waiting for it goes along', async () => {
  st().openFile('/p/a.ts', 'a.ts');
  const h = handoff('/p/a.ts');
  expect(putHandoff(h)).toBe(true);
  const r = await tabMove(st(), 'f:/p/a.ts', async (req) => req);
  expect(r).toEqual({ payload: { kind: 'file', rel: 'a.ts', mode: 'margin' }, handoff: h });
  // Gone with the tab: an editor opened here later reads the file.
  expect(hasHandoff('/p/a.ts')).toBe(false);
});

test('a move that fails or throws leaves that waiting buffer for its editor', async () => {
  st().openFile('/p/a.ts', 'a.ts');
  const h = handoff('/p/a.ts');
  putHandoff(h);
  const r = await tabMove(st(), 'f:/p/a.ts', async () => ({ ok: false }), (x) => !x.ok);
  expect(r).toEqual({ ok: false });
  expect(hasHandoff('/p/a.ts')).toBe(true);
  await expect(tabMove(st(), 'f:/p/a.ts', async () => { throw new Error('gone'); })).rejects.toThrow('gone');
  expect(takeHandoff('/p/a.ts')).toBe(h);
});

test('a terminal: whether its Ask goes along, no buffer', async () => {
  const r = await tabMove(st(), 't:a', async (req) => req);
  expect(r).toEqual({ payload: { kind: 'terminal', ask: false } });
});

test('moveBack: a pop-out docks its tab with what it shows now; outside popout mode nothing is sent', async () => {
  await moveBack();
  expect(dock).not.toHaveBeenCalled();
  st().enterPopout({ key: 'f:/p/a.ts', payload: { kind: 'file', rel: 'a.ts', mode: 'margin' } });
  st().setFileMode('/p/a.ts', 'diff');
  const h = handoff('/p/a.ts');
  const off = registerSaver('/p/a.ts', async () => true, () => true, () => h);
  const during: boolean[] = [];
  dock.mockImplementation(async () => { during.push(isMoving('/p/a.ts')); });
  await moveBack();
  expect(dock).toHaveBeenLastCalledWith({ payload: { kind: 'file', rel: 'a.ts', mode: 'diff' }, handoff: h });
  expect(during).toEqual([true]);
  expect(isMoving('/p/a.ts')).toBe(false);
  // A dock that fails leaves the window as it was, the editor taking edits again.
  dock.mockImplementation(async () => { throw new Error('gone'); });
  await expect(moveBack()).resolves.toBeUndefined();
  expect(isMoving('/p/a.ts')).toBe(false);
  off();
});

test('dragBackEnd: a drag that moved ends with the tab (main docks only over the main window)', async () => {
  st().enterPopout({ key: 'review', payload: { kind: 'review', scope: 'all' } });
  await dragBackEnd(true);
  expect(dragEnd).toHaveBeenLastCalledWith({ payload: { kind: 'review', scope: 'all' } });
  expect(dock).not.toHaveBeenCalled();
});

test('dragBackEnd: a plain click on the handle ends the drag without taking the buffer', async () => {
  st().enterPopout({ key: 'f:/p/a.ts', payload: { kind: 'file', rel: 'a.ts', mode: 'margin' } });
  const asked = vi.fn(() => handoff('/p/a.ts'));
  const off = registerSaver('/p/a.ts', async () => true, () => true, asked);
  const during: boolean[] = [];
  dragEnd.mockImplementation(async () => { during.push(isMoving('/p/a.ts')); });
  await dragBackEnd(false);
  expect(dragEnd).toHaveBeenLastCalledWith({});
  expect(asked).not.toHaveBeenCalled();
  expect(during).toEqual([false]);
  off();
});

test('a press becomes a drag past the threshold, any direction (as main counts it)', () => {
  expect(pastThreshold({ x: 10, y: 10 }, { x: 13, y: 10 })).toBe(false);
  expect(pastThreshold({ x: 10, y: 10 }, { x: 10, y: 14 })).toBe(true);
  expect(pastThreshold({ x: 10, y: 10 }, { x: 7, y: 7 })).toBe(true);
  expect(pastThreshold({ x: 10, y: 10 }, { x: 12, y: 12 })).toBe(false);
  expect(HANDLE_THRESHOLD).toBe(DRAG_THRESHOLD);
});
