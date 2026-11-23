import { describe, expect, test, vi } from 'vitest';
import { IPC } from '@shared/api';
import { installRemoteIpc, type RemoteIpcDeps, type RemoteIpcHub, type RemotePlacesIpc } from './ipc';

type Handler = Parameters<RemoteIpcDeps['handle']>[1];

function setup(trusted = true) {
  const handlers = new Map<string, Handler>();
  const hub: RemoteIpcHub = {
    status: vi.fn(() => ({ enabled: true, available: true, relay: { state: 'online' as const }, devices: [], sized: [] })),
    startPairing: vi.fn(async () => ({ ok: true as const, pairing: { code: '7K4Q-9MXD-2HTR', qr: 'atelier://pair?v=1', expiresAt: 1 } })),
    stopPairing: vi.fn(),
    decide: vi.fn(() => true),
    removeDevice: vi.fn(() => true),
    reset: vi.fn(),
    layoutChanged: vi.fn()
  };
  const order: string[] = [];
  vi.mocked(hub.layoutChanged).mockImplementation(() => { order.push('layout'); });
  const places: RemotePlacesIpc = {
    takeHeld: vi.fn(() => [{ id: 1, op: { kind: 'workspace' as const } }]),
    done: vi.fn(() => { order.push('done'); return true; })
  };
  // Window 1 is the project's main window, 2 a pop-out (no project for this), 3 the welcome window.
  const projectOf = (id: number) => (id === 1 ? '/work/app' : null);
  installRemoteIpc(hub, { isTrusted: () => trusted, handle: (channel, fn) => { handlers.set(channel, fn); }, projectOf, places });
  const call = (channel: string, arg?: unknown, sender = 1) => handlers.get(channel)!({ sender: { id: sender } } as Parameters<Handler>[0], arg);
  return { hub, call, handlers, places, order };
}

describe('window.atelier.remote in main', () => {
  test('every channel answers a trusted app page', async () => {
    const { hub, call, handlers } = setup();
    expect([...handlers.keys()].sort()).toEqual([IPC.remoteDecide, IPC.remoteRemoveDevice, IPC.remoteReset, IPC.remoteStartPairing, IPC.remoteStatus, IPC.remoteStopPairing, IPC.remoteLayout, IPC.remotePlacesReady, IPC.remotePlaceDone].sort());
    expect(await call(IPC.remoteStatus)).toMatchObject({ enabled: true });
    expect(await call(IPC.remoteStartPairing)).toMatchObject({ ok: true });
    await call(IPC.remoteStopPairing);
    expect(await call(IPC.remoteDecide, { requestId: '0123456789abcdef', allow: true })).toBe(true);
    expect(hub.decide).toHaveBeenCalledWith('0123456789abcdef', true);
    expect(await call(IPC.remoteRemoveDevice, { id: 'AbCdEfGhIjKlMn_-' })).toBe(true);
    expect(hub.removeDevice).toHaveBeenCalledWith('AbCdEfGhIjKlMn_-');
    await call(IPC.remoteReset);
    expect(hub.reset).toHaveBeenCalledTimes(1);
  });

  test('input is strict: extra fields, wrong shapes and arguments where none go are refused before the hub sees them', () => {
    const { hub, call } = setup();
    expect(() => call(IPC.remoteDecide, { requestId: '0123456789abcdef', allow: true, extra: 1 })).toThrow();
    expect(() => call(IPC.remoteDecide, { requestId: 'x', allow: true })).toThrow();
    expect(() => call(IPC.remoteDecide, { requestId: '0123456789abcdef', allow: 'yes' })).toThrow();
    expect(() => call(IPC.remoteRemoveDevice, { id: '../../etc' })).toThrow();
    expect(() => call(IPC.remoteReset, { all: true })).toThrow();
    expect(() => call(IPC.remoteStatus, 1)).toThrow();
    expect(hub.decide).not.toHaveBeenCalled();
    expect(hub.removeDevice).not.toHaveBeenCalled();
    expect(hub.reset).not.toHaveBeenCalled();
  });

  test('a page that is not the app\'s is refused, its input never parsed', () => {
    const { hub, call } = setup(false);
    for (const ch of [IPC.remoteStatus, IPC.remoteStartPairing, IPC.remoteStopPairing, IPC.remoteReset]) expect(() => call(ch)).toThrow(/unauthorized/);
    expect(() => call(IPC.remoteDecide, { requestId: '0123456789abcdef', allow: true })).toThrow(/unauthorized/);
    expect(hub.status).not.toHaveBeenCalled();
    expect(hub.decide).not.toHaveBeenCalled();
  });
});

describe('a project window\'s layout for the phones', () => {
  const layout = { groupByState: true, pins: ['t1'], order: { sessions: ['t1'], terminals: [] }, workspaces: { active: 'w1', activities: false, places: [{ id: 'w1', name: 'Main', color: 2, folder: 'api', open: true }], members: { t1: 'w1' } } };

  test('from the project\'s main window: kept for its own project, never a project the page names', async () => {
    const { hub, call } = setup();
    await call(IPC.remoteLayout, layout);
    expect(hub.layoutChanged).toHaveBeenCalledWith('/work/app', layout);
  });

  test('a pop-out, the welcome window or a page that isn\'t the app\'s: refused', () => {
    const { hub, call } = setup();
    expect(() => call(IPC.remoteLayout, layout, 2)).toThrow();
    expect(() => call(IPC.remoteLayout, layout, 3)).toThrow();
    expect(() => setup(false).call(IPC.remoteLayout, layout)).toThrow(/unauthorized/);
    expect(hub.layoutChanged).not.toHaveBeenCalled();
  });

  test('strict: paths, extra fields, control characters and oversized lists are refused', () => {
    const { hub, call } = setup();
    const ws = layout.workspaces;
    const bad = [
      { ...layout, root: '/work/app' },
      { ...layout, workspaces: { ...ws, places: [{ ...ws.places[0], folder: '/work/app/api' }] } },
      { ...layout, workspaces: { ...ws, places: [{ ...ws.places[0], folder: 'a\\b' }] } },
      { ...layout, workspaces: { ...ws, places: [{ ...ws.places[0], name: 'two\nlines' }] } },
      { ...layout, workspaces: { ...ws, places: [{ ...ws.places[0], color: 9 }] } },
      { ...layout, pins: ['../x'] },
      { ...layout, pins: Array.from({ length: 1001 }, (_, i) => `t${i}`) },
      { ...layout, order: { sessions: [], terminals: [], extra: [] } },
      { ...layout, workspaces: { ...ws, members: { t1: 'w 1' } } }
    ];
    for (const b of bad) expect(() => call(IPC.remoteLayout, b), JSON.stringify(b).slice(0, 120)).toThrow();
    expect(hub.layoutChanged).not.toHaveBeenCalled();
    // Without workspaces (off in that project): fine.
    const { workspaces: _w, ...plain } = layout;
    void call(IPC.remoteLayout, plain);
    expect(hub.layoutChanged).toHaveBeenCalledWith('/work/app', plain);
  });
});

describe('a phone\'s changes to the places, in the project\'s main window', () => {
  const layout = { groupByState: true, pins: [], order: { sessions: [], terminals: [] }, workspaces: { active: 'w1', activities: false, places: [{ id: 'w1', name: 'Workspace 1', color: 1, open: true }, { id: 'w2', name: 'Workspace 2', color: 2, open: false }], members: {} } };

  test('ready: the changes that waited for this very window; only its main window asks, with nothing', async () => {
    const { call, places } = setup();
    expect(await call(IPC.remotePlacesReady)).toEqual([{ id: 1, op: { kind: 'workspace' } }]);
    expect(places.takeHeld).toHaveBeenCalledWith(1);
    expect(() => call(IPC.remotePlacesReady, undefined, 2)).toThrow(/unauthorized/);
    expect(() => call(IPC.remotePlacesReady, undefined, 3)).toThrow(/unauthorized/);
    expect(() => call(IPC.remotePlacesReady, { root: '/work/other' })).toThrow();
    expect(() => setup(false).call(IPC.remotePlacesReady)).toThrow(/unauthorized/);
    expect(places.takeHeld).toHaveBeenCalledTimes(1);
  });

  test('done: the sidebar\'s arrangement after the change is kept first (the phone\'s next layout shows it), then the answer', async () => {
    const { hub, call, places, order } = setup();
    await call(IPC.remotePlaceDone, { id: 1, result: { ok: true, place: 'w2' }, layout });
    expect(hub.layoutChanged).toHaveBeenCalledWith('/work/app', layout);
    expect(places.done).toHaveBeenCalledWith(1, 1, { ok: true, place: 'w2' });
    expect(order).toEqual(['layout', 'done']);
    await call(IPC.remotePlaceDone, { id: 2, result: { ok: false, code: 'invalid', message: 'This project has 20 workspaces already.' }, layout });
    expect(places.done).toHaveBeenLastCalledWith(1, 2, { ok: false, code: 'invalid', message: 'This project has 20 workspaces already.' });
  });

  test('done: strict, and from the project\'s main window only', () => {
    const { hub, call, places } = setup();
    const bad = [
      { id: 1, result: { ok: true, place: '../w' }, layout },
      { id: 1, result: { ok: true }, layout, root: '/work/app' },
      { id: 0, result: { ok: true }, layout },
      { id: 1, result: { ok: false, code: 'busy', message: 'x' }, layout },
      { id: 1, result: { ok: false, code: 'failed', message: 'two\nlines' }, layout },
      { id: 1, result: { ok: false, code: 'failed', message: 'x'.repeat(201) }, layout },
      { id: 1, result: { ok: true, extra: 1 }, layout },
      { id: 1, result: { ok: true } }
    ];
    for (const b of bad) expect(() => call(IPC.remotePlaceDone, b), JSON.stringify(b).slice(0, 120)).toThrow();
    expect(() => call(IPC.remotePlaceDone, { id: 1, result: { ok: true }, layout }, 2)).toThrow(/unauthorized/);
    expect(hub.layoutChanged).not.toHaveBeenCalled();
    expect(places.done).not.toHaveBeenCalled();
  });
});
