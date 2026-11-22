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
    reset: vi.fn()
  };
  installRemoteIpc(hub, { isTrusted: () => trusted, handle: (channel, fn) => { handlers.set(channel, fn); } });
  const call = (channel: string, arg?: unknown) => handlers.get(channel)!({ sender: { id: 1 } } as Parameters<Handler>[0], arg);
  return { hub, call, handlers };
}

describe('window.atelier.remote in main', () => {
  test('every channel answers a trusted app page', async () => {
    const { hub, call, handlers } = setup();
    expect([...handlers.keys()].sort()).toEqual([IPC.remoteDecide, IPC.remoteRemoveDevice, IPC.remoteReset, IPC.remoteStartPairing, IPC.remoteStatus, IPC.remoteStopPairing].sort());
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
