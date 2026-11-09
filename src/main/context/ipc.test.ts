import { describe, expect, test, vi } from 'vitest';
import type { IpcMainInvokeEvent } from 'electron';
import { IPC } from '@shared/api';
import { installContextIpc, type ContextIpcService } from './ipc';

function setup(o: { project?: string | null; trusted?: boolean } = {}) {
  const handlers = new Map<string, (e: IpcMainInvokeEvent, arg: unknown) => unknown>();
  const svc = {
    analyze: vi.fn(async (_p: string, terminalId: string, onProgress?: (x: unknown) => void) => { onProgress?.({ terminalId, phase: 'start' }); return { ok: false as const, kind: 'exit' as const, message: 'x' }; }),
    live: vi.fn(async () => 7),
    open: vi.fn(() => ({ path: '/p/CLAUDE.md', rel: 'CLAUDE.md' }))
  } satisfies ContextIpcService;
  installContextIpc(svc, {
    projectOf: () => (o.project === undefined ? '/p' : o.project),
    isTrusted: () => o.trusted ?? true,
    handle: (ch, fn) => { handlers.set(ch, fn); }
  });
  const sent: unknown[] = [];
  const sender = { id: 3, isDestroyed: () => false, send: (ch: string, p: unknown) => sent.push([ch, p]) };
  const call = (ch: string, arg: unknown) => handlers.get(ch)!({ sender } as unknown as IpcMainInvokeEvent, arg);
  return { svc, call, sent };
}

describe('installContextIpc', () => {
  test('the sender\'s project and the parsed terminal go to the service; progress back to the sender only', async () => {
    const s = setup();
    await s.call(IPC.claudeContext, { terminalId: 't1' });
    expect(s.svc.analyze).toHaveBeenCalledWith('/p', 't1', expect.any(Function));
    expect(s.sent).toEqual([[IPC.evContextProgress, { terminalId: 't1', phase: 'start' }]]);
    expect(await s.call(IPC.claudeContextLive, { terminalId: 't1' })).toBe(7);
    expect(await s.call(IPC.claudeContextOpen, { terminalId: 't1', path: '/p/CLAUDE.md' })).toEqual({ path: '/p/CLAUDE.md', rel: 'CLAUDE.md' });
    expect(s.svc.open).toHaveBeenCalledWith('/p', 't1', '/p/CLAUDE.md');
  });

  test('an untrusted page or a window without a project is refused before parsing; bad input throws', async () => {
    for (const o of [{ trusted: false }, { project: null }]) {
      const s = setup(o);
      expect(() => s.call(IPC.claudeContext, { terminalId: 't1' })).toThrow('unauthorized sender');
      expect(s.svc.analyze).not.toHaveBeenCalled();
    }
    const s = setup();
    expect(() => s.call(IPC.claudeContext, { terminalId: 't1', cwd: '/etc' })).toThrow();
    expect(() => s.call(IPC.claudeContextOpen, { terminalId: 't1', path: 'relative' })).toThrow();
  });
});
