// window.atelier.remote's channels: any trusted app page (Settings is in the welcome window too), the sender checked
// before its input is parsed, every argument through a strict schema; the layout only from a project's main window.
// Status and pairing events go to every window.
import type { IpcMainInvokeEvent } from 'electron';
import { IPC } from '@shared/api';
import type { RemoteLayout } from '@shared/remote';
import { noArgsSchema, remoteDecideSchema, remoteDeviceSchema, remoteLayoutSchema } from '../ipc-schemas';
import type { RemoteHub } from './remote-hub';

export type RemoteIpcHub = Pick<RemoteHub, 'status' | 'startPairing' | 'stopPairing' | 'decide' | 'removeDevice' | 'reset' | 'layoutChanged'>;

export interface RemoteIpcDeps {
  isTrusted(e: IpcMainInvokeEvent): boolean;
  handle(channel: string, fn: (e: IpcMainInvokeEvent, arg: unknown) => unknown): void;
  /** A project's main window: its project root (null for a pop-out, the welcome window or any other page). */
  projectOf(wcId: number): string | null;
}

export function installRemoteIpc(hub: RemoteIpcHub, deps: RemoteIpcDeps): void {
  const handle = (channel: string, fn: (arg: unknown) => unknown) => deps.handle(channel, (e, arg) => {
    if (!deps.isTrusted(e)) throw new Error('unauthorized sender');
    return fn(arg);
  });
  handle(IPC.remoteStatus, (arg) => { noArgsSchema.parse(arg); return hub.status(); });
  handle(IPC.remoteStartPairing, (arg) => { noArgsSchema.parse(arg); return hub.startPairing(); });
  handle(IPC.remoteStopPairing, (arg) => { noArgsSchema.parse(arg); hub.stopPairing(); });
  handle(IPC.remoteDecide, (arg) => { const o = remoteDecideSchema.parse(arg); return hub.decide(o.requestId, o.allow); });
  handle(IPC.remoteRemoveDevice, (arg) => hub.removeDevice(remoteDeviceSchema.parse(arg).id));
  handle(IPC.remoteReset, (arg) => { noArgsSchema.parse(arg); hub.reset(); });
  // A project's main window's sidebar arrangement: for its own project only, the root main knows for that window.
  deps.handle(IPC.remoteLayout, (e, arg) => {
    const root = deps.isTrusted(e) ? deps.projectOf(e.sender.id) : null;
    if (!root) throw new Error('unauthorized sender');
    hub.layoutChanged(root, remoteLayoutSchema.parse(arg) as RemoteLayout);
  });
}
