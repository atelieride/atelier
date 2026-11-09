import type { IpcMainInvokeEvent } from 'electron';
import { IPC } from '@shared/api';
import { claudeContextOpenSchema, claudeContextSchema } from '../ipc-schemas';
import type { ContextService } from './service';

// Context usage's channels: a trusted app page of a project window only (pop-outs
// included), input parsed strictly; the service checks the terminal belongs to that project. Progress goes back to the
// asking page only.

export type ContextIpcService = Pick<ContextService, 'analyze' | 'live' | 'open'>;

export interface ContextIpcDeps {
  projectOf(wcId: number): string | null;
  isTrusted(e: IpcMainInvokeEvent): boolean;
  handle(channel: string, fn: (e: IpcMainInvokeEvent, arg: unknown) => unknown): void;
}

export function installContextIpc(svc: ContextIpcService, deps: ContextIpcDeps): void {
  // The sender first: an untrusted page's input is never even parsed.
  const project = (e: IpcMainInvokeEvent) => {
    const p = deps.projectOf(e.sender.id);
    if (!p || !deps.isTrusted(e)) throw new Error('unauthorized sender');
    return p;
  };
  deps.handle(IPC.claudeContext, (e, arg) => {
    const p = project(e);
    const { terminalId } = claudeContextSchema.parse(arg);
    const sender = e.sender;
    return svc.analyze(p, terminalId, (progress) => { if (!sender.isDestroyed()) sender.send(IPC.evContextProgress, progress); });
  });
  deps.handle(IPC.claudeContextLive, (e, arg) => {
    const p = project(e);
    return svc.live(p, claudeContextSchema.parse(arg).terminalId);
  });
  deps.handle(IPC.claudeContextOpen, (e, arg) => {
    const p = project(e);
    const o = claudeContextOpenSchema.parse(arg);
    return svc.open(p, o.terminalId, o.path);
  });
}
