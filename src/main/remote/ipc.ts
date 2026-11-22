// window.atelier.remote's channels: any trusted app page (Settings is in the welcome window too), the sender checked
// before its input is parsed, every argument through a strict schema. Status and pairing events go to every window.
import type { IpcMainInvokeEvent } from 'electron';
import { IPC } from '@shared/api';
import { noArgsSchema, remoteDecideSchema, remoteDeviceSchema } from '../ipc-schemas';
import type { RemoteHub } from './remote-hub';

export type RemoteIpcHub = Pick<RemoteHub, 'status' | 'startPairing' | 'stopPairing' | 'decide' | 'removeDevice' | 'reset'>;

export interface RemoteIpcDeps {
  isTrusted(e: IpcMainInvokeEvent): boolean;
  handle(channel: string, fn: (e: IpcMainInvokeEvent, arg: unknown) => unknown): void;
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
}
