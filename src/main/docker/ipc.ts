// Docker view IPC: every handler checks the sender is an app page of a project window and
// validates its input; ids must be containers the hub knows.
import { ipcMain, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron';
import { IPC } from '@shared/api';
import { containerIdSchema, containerIdsSchema, dockerTailSchema } from '../ipc-schemas';
import type { DockerHub } from './hub';

export function installDockerIpc(hub: DockerHub, projectOf: (wcId: number) => string | null, isTrusted: (e: IpcMainInvokeEvent | IpcMainEvent) => boolean): void {
  const ok = (e: IpcMainInvokeEvent | IpcMainEvent) => !!projectOf(e.sender.id) && isTrusted(e);
  const guard = (e: IpcMainInvokeEvent) => { if (!ok(e)) throw new Error('unauthorized sender'); };
  ipcMain.handle(IPC.dockerSnapshot, (e) => { guard(e); return hub.snapshot(); });
  ipcMain.handle(IPC.dockerLogs, (e, id) => { guard(e); return hub.logsOf(containerIdSchema.parse(id)); });
  ipcMain.handle(IPC.dockerStats, (e, ids) => { guard(e); return hub.statsOf(containerIdsSchema.parse(ids)); });
  ipcMain.handle(IPC.dockerInspect, (e, id) => { guard(e); return hub.inspect(containerIdSchema.parse(id)); });
  ipcMain.handle(IPC.dockerDf, (e) => { guard(e); return hub.df(); });
  ipcMain.handle(IPC.dockerEvents, (e) => { guard(e); return hub.eventsList(); });
  ipcMain.handle(IPC.dockerTail, (e, arg) => { guard(e); const { id, n } = dockerTailSchema.parse(arg); return hub.tail(id, n); });
  ipcMain.on(IPC.dockerWatchLogs, (e, ids) => {
    const r = containerIdsSchema.safeParse(ids);
    if (ok(e) && r.success) hub.watchLogs(e.sender.id, r.data);
  });
  ipcMain.on(IPC.dockerWatchStats, (e, ids) => {
    const r = containerIdsSchema.safeParse(ids);
    if (ok(e) && r.success) hub.watchStats(e.sender.id, r.data);
  });
}
