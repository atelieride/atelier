import { beforeEach, describe, expect, test, vi } from 'vitest';

const handlers = vi.hoisted(() => new Map<string, (e: unknown, ...args: unknown[]) => unknown>());
vi.mock('electron', () => ({ ipcMain: { handle: (channel: string, fn: (e: unknown, ...args: unknown[]) => unknown) => handlers.set(channel, fn) } }));

import { IPC } from '@shared/api';
import { installPopoutIpc, type PopoutIpcHost } from './popout-ipc';
import type { WindowKind } from './popout-wiring';

// Windows: 1 = /a's project window, 2 = /a's pop-out, 5 = the welcome window; untrusted: any sender id ≥ 100.
const kinds = new Map<number, WindowKind>([[1, 'project'], [2, 'popout'], [5, 'project']]);
const roots = new Map<number, string | null>([[1, '/a'], [2, '/a'], [5, null]]);
const ev = (id: number) => ({ sender: { id } });

function setup() {
  handlers.clear();
  const calls: unknown[][] = [];
  const rec = (name: string) => (...args: unknown[]) => { calls.push([name, ...args]); };
  const host: PopoutIpcHost = {
    isTrusted: (e) => e.sender.id < 100,
    kindOf: (id) => kinds.get(id),
    projectOf: (id) => roots.get(id) ?? null,
    popouts: {
      open: (...a) => { calls.push(['open', ...a]); return { ok: true }; },
      // Only Docker's overview lives in a pop-out of /a here.
      dock: rec('dock'), focus: (...a) => { calls.push(['focus', ...a]); return a[1] === 'dk:overview'; }, recall: rec('recall'),
      keys: (root) => [`t:${root}`],
      takeHandoff: (id) => { calls.push(['takeHandoff', id]); return null; },
      dragStart: rec('dragStart'), dragEnd: (...a) => { calls.push(['dragEnd', ...a]); return null; }, dragCancel: rec('dragCancel'),
      rekey: (...a) => { calls.push(['rekey', ...a]); return true; }
    },
    tear: { start: rec('tearStart'), end: rec('tearEnd') },
    forward: rec('forward'),
    openInMain: rec('openInMain'),
    showInMain: rec('showInMain'),
    moveTo: (...a) => { calls.push(['moveTo', ...a]); return Promise.resolve({ ok: true }); },
    adopted: rec('adopted'),
    projectWindows: () => [{ root: '/a', name: 'a' }, { root: '/b', name: 'b' }],
    // Released over another project's window (only /b's, at the cursor): the move's answer, else not across.
    moveAtCursor: (root, wcId, r) => { calls.push(['moveAtCursor', root, wcId, r.key]); return Promise.resolve(r.key === 'f:/a/x.ts' ? { ok: false, reason: 'moved' } : null); }
  };
  installPopoutIpc(host);
  const call = (channel: string, id: number, ...args: unknown[]) => handlers.get(channel)!(ev(id) as never, ...args);
  return { calls, call };
}

const openReq = { key: 't:abc', size: { width: 600, height: 400 }, at: 'cascade' };

describe('pop-out IPC', () => {
  beforeEach(() => handlers.clear());

  test('tear-off start and end: from a project window, its own project, a strict request', () => {
    const { calls, call } = setup();
    const req = { key: 't:abc', title: 'Alfa', icon: 'session', color: 'hsl(262 83% 76%)', size: { width: 600, height: 400 }, rect: { x: 300, y: 80, width: 600.5, height: 354 } };
    call(IPC.popoutTearStart, 1, req);
    call(IPC.popoutTearStart, 1, { key: 'f:/a/x.ts', title: 'x.ts', icon: 'file', size: { width: 600, height: 400 } });
    call(IPC.popoutTearEnd, 1);
    expect(calls).toEqual([['tearStart', '/a', req], ['tearStart', '/a', { key: 'f:/a/x.ts', title: 'x.ts', icon: 'file', size: { width: 600, height: 400 } }], ['tearEnd', '/a']]);
    // A pop-out, the welcome window, an untrusted page: nothing.
    for (const id of [2, 5, 100]) { call(IPC.popoutTearStart, id, req); call(IPC.popoutTearEnd, id); }
    // Malformed: an extra field, an unknown glyph, a colour that is not one, a huge title, a bad size.
    call(IPC.popoutTearStart, 1, { ...req, extra: 1 });
    call(IPC.popoutTearStart, 1, { ...req, icon: 'img' });
    call(IPC.popoutTearStart, 1, { ...req, color: 'red; background: url(x)' });
    call(IPC.popoutTearStart, 1, { ...req, title: 'x'.repeat(5000) });
    call(IPC.popoutTearStart, 1, { ...req, size: { width: -1, height: 400 } });
    call(IPC.popoutTearStart, 1, { ...req, rect: { x: 0, y: 0, width: Number.NaN, height: 1 } });
    call(IPC.popoutTearStart, 1, { ...req, rect: { x: 1e12, y: 0, width: 10, height: 10 } });
    call(IPC.popoutTearStart, 1, { ...req, reduced: 'yes' });
    expect(calls).toHaveLength(3);
    // Reduce motion on: passed along.
    call(IPC.popoutTearStart, 1, { ...req, reduced: true });
    expect(calls.at(-1)).toEqual(['tearStart', '/a', { ...req, reduced: true }]);
  });

  test('open: from a project window with a valid request only', async () => {
    const { calls, call } = setup();
    expect(await call(IPC.popoutOpen, 1, openReq)).toEqual({ ok: true });
    expect(calls).toEqual([['open', '/a', openReq]]);
    // From a pop-out, the welcome window, an untrusted page, or malformed: refused, nothing opened.
    expect(await call(IPC.popoutOpen, 2, openReq)).toEqual({ ok: false, reason: 'failed' });
    expect(await call(IPC.popoutOpen, 5, openReq)).toEqual({ ok: false, reason: 'failed' });
    expect(await call(IPC.popoutOpen, 100, openReq)).toEqual({ ok: false, reason: 'failed' });
    expect(await call(IPC.popoutOpen, 1, { ...openReq, extra: 1 })).toEqual({ ok: false, reason: 'failed' });
    expect(await call(IPC.popoutOpen, 1, { ...openReq, key: 'nope' })).toEqual({ ok: false, reason: 'failed' });
    expect(calls).toHaveLength(1);
  });

  test('recall and list: from a project window only', () => {
    const { calls, call } = setup();
    call(IPC.popoutRecall, 1, 't:abc');
    call(IPC.popoutRecall, 2, 't:abc');
    call(IPC.popoutRecall, 1, 42);
    expect(calls).toEqual([['recall', '/a', 't:abc']]);
    expect(call(IPC.popoutList, 1)).toEqual(['t:/a']);
    expect(call(IPC.popoutList, 2)).toEqual([]);
    expect(call(IPC.popoutList, 100)).toEqual([]);
  });

  test('focus: from any window of the project, validated', () => {
    const { calls, call } = setup();
    call(IPC.popoutFocus, 1, { key: 't:abc', reveal: { line: 3 } });
    call(IPC.popoutFocus, 2, { key: 'f:/a/x.ts' });
    call(IPC.popoutFocus, 5, { key: 't:abc' });
    call(IPC.popoutFocus, 100, { key: 't:abc' });
    call(IPC.popoutFocus, 1, { key: 't:abc', reveal: { line: -1 } });
    expect(calls).toEqual([['focus', '/a', 't:abc', { line: 3 }], ['focus', '/a', 'f:/a/x.ts', undefined]]);
  });

  test('dock, handoff and the drag: from a pop-out only, with its own id', () => {
    const { calls, call } = setup();
    call(IPC.popoutDock, 2, {});
    call(IPC.popoutDock, 1, {});
    call(IPC.popoutDock, 2, { junk: true });
    expect(call(IPC.popoutHandoff, 2)).toBeNull();
    expect(call(IPC.popoutHandoff, 1)).toBeNull();
    call(IPC.popoutDragStart, 2);
    call(IPC.popoutDragStart, 1);
    call(IPC.popoutDragEnd, 2, { payload: { kind: 'file', rel: 'x.ts', mode: 'margin' } });
    call(IPC.popoutDragEnd, 2, { payload: { kind: 'nope' } });
    call(IPC.popoutDragCancel, 2);
    call(IPC.popoutDragCancel, 100);
    expect(calls).toEqual([
      ['dock', 2, {}], ['takeHandoff', 2], ['dragStart', 2],
      ['dragEnd', 2, { payload: { kind: 'file', rel: 'x.ts', mode: 'margin' } }], ['dragCancel', 2]
    ]);
  });

  test('forward: a menu command from a pop-out goes to its project', () => {
    const { calls, call } = setup();
    call(IPC.popoutForward, 2, 'open-palette');
    call(IPC.popoutForward, 1, 'open-palette');
    call(IPC.popoutForward, 2, 'rm -rf');
    expect(calls).toEqual([['forward', '/a', 'open-palette']]);
  });

  test('open in main: a file a pop-out asks for opens in its project window, with the line', () => {
    const { calls, call } = setup();
    call(IPC.popoutOpenInMain, 2, { path: '/a/x.ts', line: 4 });
    call(IPC.popoutOpenInMain, 2, { path: '/a/y.ts' });
    // From the project window itself, an untrusted page, or malformed: nothing.
    call(IPC.popoutOpenInMain, 1, { path: '/a/x.ts' });
    call(IPC.popoutOpenInMain, 100, { path: '/a/x.ts' });
    call(IPC.popoutOpenInMain, 2, { path: 'untitled:1' });
    call(IPC.popoutOpenInMain, 2, { path: '/a/x.ts', line: -2 });
    expect(calls).toEqual([['openInMain', 2, '/a/x.ts', 4], ['openInMain', 2, '/a/y.ts', undefined]]);
  });

  test('rekey: from a pop-out only, for its own window, validated (an untitled buffer saved as a file)', () => {
    const { calls, call } = setup();
    call(IPC.popoutRekey, 2, { from: 'f:untitled:1', to: 'f:/a/notes.md' });
    // From the project window, an untrusted page, or malformed: nothing.
    call(IPC.popoutRekey, 1, { from: 'f:untitled:1', to: 'f:/a/notes.md' });
    call(IPC.popoutRekey, 100, { from: 'f:untitled:1', to: 'f:/a/notes.md' });
    call(IPC.popoutRekey, 2, { from: 't:abc', to: 'f:/a/notes.md' });
    call(IPC.popoutRekey, 2, { from: 'f:untitled:1', to: 'f:/a/notes.md', extra: 1 });
    expect(calls).toEqual([['rekey', 2, 'f:untitled:1', 'f:/a/notes.md']]);
  });

  test('show in main: a tab a pop-out asks for comes up in its project window, or in the pop-out that holds it', () => {
    const { calls, call } = setup();
    const payload = { kind: 'background', terminalId: 't1', itemId: null };
    call(IPC.popoutShowInMain, 2, { key: 'background', payload });
    call(IPC.popoutShowInMain, 2, { key: 't:abc' });
    // Popped out in another window: that one comes forward with the payload, the project window gets nothing.
    call(IPC.popoutShowInMain, 2, { key: 'dk:overview', payload: { kind: 'docker', target: { kind: 'overview' }, view: 'logs' } });
    // From the project window, an untrusted page, or malformed: nothing.
    call(IPC.popoutShowInMain, 1, { key: 't:abc' });
    call(IPC.popoutShowInMain, 100, { key: 't:abc' });
    call(IPC.popoutShowInMain, 2, { key: 'nope' });
    call(IPC.popoutShowInMain, 2, { key: 't:abc', extra: 1 });
    call(IPC.popoutShowInMain, 2, { key: 'review', payload: { kind: 'evil' } });
    expect(calls).toEqual([
      ['focus', '/a', 'background', { payload }], ['showInMain', '/a', { key: 'background', payload }],
      ['focus', '/a', 't:abc', undefined], ['showInMain', '/a', { key: 't:abc' }],
      ['focus', '/a', 'dk:overview', { payload: { kind: 'docker', target: { kind: 'overview' }, view: 'logs' } }]
    ]);
  });

  // A project window or a pop-out sends its tab to another project's window;
  // only the window asked answers; every app window may list the project windows.
  test('move to another window: from a project window or a pop-out, its own project as the source, a strict request', async () => {
    const { calls, call } = setup();
    const req = { to: '/b', key: 'f:/a/x.ts', payload: { kind: 'file', rel: 'x.ts', mode: 'margin' }, at: { x: 3, y: 4 } };
    expect(await call(IPC.windowsMoveTab, 1, req)).toEqual({ ok: true });
    expect(await call(IPC.windowsMoveTab, 2, { to: '/b', key: 't:abc' })).toEqual({ ok: true });
    // The welcome window, an untrusted page, malformed (relative target, an extra field, a bad key): refused.
    for (const [id, r] of [[5, req], [100, req], [1, { ...req, to: 'b' }], [1, { ...req, extra: 1 }], [1, { ...req, key: 'nope' }]] as const) {
      expect(await call(IPC.windowsMoveTab, id, r)).toEqual({ ok: false, reason: 'failed' });
    }
    expect(calls).toEqual([['moveTo', { wcId: 1, root: '/a', popout: false }, req], ['moveTo', { wcId: 2, root: '/a', popout: true }, { to: '/b', key: 't:abc' }]]);
  });
  test('adopted: from a project window only, strict; the window list for any app window', async () => {
    const { calls, call } = setup();
    call(IPC.windowsAdopted, 1, { id: 3, ok: true });
    call(IPC.windowsAdopted, 1, { id: 4, ok: false, reason: 'open-there' });
    for (const [id, a] of [[2, { id: 3, ok: true }], [100, { id: 3, ok: true }], [1, { id: 'x', ok: true }], [1, { id: 3, ok: true, extra: 1 }], [1, { id: 3, ok: false, reason: 'other' }]] as const) call(IPC.windowsAdopted, id, a);
    expect(calls).toEqual([['adopted', 1, { id: 3, ok: true }], ['adopted', 1, { id: 4, ok: false, reason: 'open-there' }]]);
    expect(await call(IPC.windowsList, 2)).toEqual([{ root: '/a', name: 'a' }, { root: '/b', name: 'b' }]);
    expect(await call(IPC.windowsList, 100)).toEqual([]);
  });
  test('a tab released outside over another project\'s window moves there instead of popping out', async () => {
    const { calls, call } = setup();
    expect(await call(IPC.popoutOpen, 1, { key: 'f:/a/x.ts', size: { width: 600, height: 400 }, at: 'cursor' })).toEqual({ ok: false, reason: 'moved' });
    expect(await call(IPC.popoutOpen, 1, { ...openReq, at: 'cursor' })).toEqual({ ok: true });
    // From the menu (cascade) it never asks.
    expect(await call(IPC.popoutOpen, 1, openReq)).toEqual({ ok: true });
    expect(calls.map((c) => c[0])).toEqual(['moveAtCursor', 'moveAtCursor', 'open', 'open']);
  });
});
