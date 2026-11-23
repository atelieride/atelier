import { describe, expect, test, vi } from 'vitest';
import { IPC } from '@shared/api';
import { installRemoteIpc, type RemoteIpcDeps, type RemoteIpcHub } from './ipc';

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
  // Window 1 is the project's main window, 2 a pop-out (no project for this), 3 the welcome window.
  const projectOf = (id: number) => (id === 1 ? '/work/app' : null);
  installRemoteIpc(hub, { isTrusted: () => trusted, handle: (channel, fn) => { handlers.set(channel, fn); }, projectOf });
  const call = (channel: string, arg?: unknown, sender = 1) => handlers.get(channel)!({ sender: { id: sender } } as Parameters<Handler>[0], arg);
  return { hub, call, handlers };
}

describe('window.atelier.remote in main', () => {
  test('every channel answers a trusted app page', async () => {
    const { hub, call, handlers } = setup();
    expect([...handlers.keys()].sort()).toEqual([IPC.remoteDecide, IPC.remoteRemoveDevice, IPC.remoteReset, IPC.remoteStartPairing, IPC.remoteStatus, IPC.remoteStopPairing, IPC.remoteLayout].sort());
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
