import type { IpcMainInvokeEvent } from 'electron';
import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import type { Binding } from '@shared/companion/types';
import type { SessionInfo } from '@shared/session';

// Ask's channels on Windows (the Windows gate is lifted). ipc-schemas
// builds its path schemas at load for the running platform, so the modules are loaded fresh with win32 forced, as
// ipc-schemas.win32.test.ts does: a binding carries canonical C:/… paths there. Fakes only, no file is read.

let ipc: typeof import('./ipc');
let api: typeof import('@shared/api');
let platform: typeof import('@shared/platform');
beforeAll(async () => {
  vi.resetModules();
  platform = await import('@shared/platform');
  platform.initPlatform('win32');
  api = await import('@shared/api');
  ipc = await import('./ipc');
});
afterAll(() => { platform.resetPlatformForTests(); });

const SID = '0b5c8f0e-1111-4222-8333-944455556666';
const ROOT = 'C:/dev/proj [v2] (1)';
const live = { sessionId: SID, state: 'idle', title: null, activity: null, contextPct: null, unread: false, updatedAt: 0 } as SessionInfo;

function setup() {
  const handlers = new Map<string, (e: IpcMainInvokeEvent, arg: unknown) => unknown>();
  const svc = { thread: vi.fn(() => null), ask: vi.fn(() => ({ runId: 'r1' })), catchUp: vi.fn(() => ({ runId: 'r2' })), stop: vi.fn(), newThread: vi.fn(), seen: vi.fn() };
  ipc.installCompanionIpc(svc as unknown as Parameters<typeof ipc.installCompanionIpc>[0], {
    projectOf: (id) => (id === 1 ? ROOT : null),
    isTrusted: () => true,
    handle: (channel, fn) => { handlers.set(channel, fn); },
    accountDir: () => undefined,
    terminal: (id) => (id === 't1' ? { projectRoot: ROOT, session: live } : null),
    hasTranscript: () => false
  });
  const call = (channel: string, arg: unknown) => handlers.get(channel)!({ sender: { id: 1 }, senderFrame: { url: 'app://atelier/index.html' } } as unknown as IpcMainInvokeEvent, arg);
  const binding = (o: Partial<Binding> = {}): Binding => ({ terminalId: 't1', sessionId: SID, cwd: `${ROOT}/sub`, configDir: null, title: 'Fix the login', ...o });
  return { svc, call, binding };
}

test('every channel reaches the service with a canonical C:/… binding, as on macOS', () => {
  const { svc, call, binding } = setup();
  const { IPC } = api;
  call(IPC.companionThread, { sessionId: SID });
  call(IPC.companionAsk, { binding: binding(), text: 'Is it done?' });
  call(IPC.companionCatchUp, { binding: binding({ configDir: 'C:/Users/me/.claude-work' }), final: false });
  call(IPC.companionStop, { sessionId: SID });
  call(IPC.companionNew, { sessionId: SID });
  call(IPC.companionSeen, { sessionId: SID });
  for (const fn of Object.values(svc)) expect(fn).toHaveBeenCalledTimes(1);
  expect(svc.ask).toHaveBeenCalledWith(expect.objectContaining({ sessionId: SID, cwd: `${ROOT}/sub`, configDir: null }), { text: 'Is it done?' });
});

test('a binding is still checked: inside the sender\'s project (any case), canonical paths only', () => {
  const { svc, call, binding } = setup();
  const { IPC } = api;
  call(IPC.companionAsk, { binding: binding({ cwd: 'c:/DEV/proj [v2] (1)/sub' }), text: 'q' });
  expect(svc.ask).toHaveBeenCalledTimes(1);
  expect(() => call(IPC.companionAsk, { binding: binding({ cwd: 'C:/dev/other' }), text: 'q' })).toThrow(/outside the project/);
  for (const cwd of ['C:\\dev\\proj [v2] (1)\\sub', '\\\\server\\share\\proj', '/dev/proj', 'C:proj'])
    expect(() => call(IPC.companionAsk, { binding: binding({ cwd }), text: 'q' }), cwd).toThrow();
  expect(svc.ask).toHaveBeenCalledTimes(1);
});
