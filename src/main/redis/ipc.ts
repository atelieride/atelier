// Redis view IPC: every handler checks the sender is an app page of a project window and
// validates its input; queues and instances are looked up in what main found, never taken from the renderer.
import { ipcMain, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron';
import { IPC } from '@shared/api';
import {
  redisAuthSchema, redisCounterSchema, redisInstanceKeySchema, redisJobSchema, redisJobsSchema, redisPreviewSchema, redisQueueIdSchema, redisScanSchema,
  redisUndoSchema, redisValueSchema, redisWatchSchema, redisWriteSchema
} from '../ipc-schemas';
import type { RedisHub } from './hub';

export function installRedisIpc(hub: RedisHub, projectOf: (wcId: number) => string | null, isTrusted: (e: IpcMainInvokeEvent | IpcMainEvent) => boolean): void {
  const ok = (e: IpcMainInvokeEvent | IpcMainEvent) => !!projectOf(e.sender.id) && isTrusted(e);
  const guard = (e: IpcMainInvokeEvent) => { if (!ok(e)) throw new Error('unauthorized sender'); };
  ipcMain.handle(IPC.redisSnapshot, (e) => { guard(e); return hub.snapshotFor(e.sender.id); });
  ipcMain.handle(IPC.redisStatus, (e) => { guard(e); return hub.statusFor(e.sender.id); });
  ipcMain.handle(IPC.redisPick, (e, key) => { guard(e); hub.pick(e.sender.id, redisInstanceKeySchema.parse(key)); });
  ipcMain.handle(IPC.redisAuth, (e, a) => { guard(e); return hub.auth(e.sender.id, redisAuthSchema.parse(a)); });
  ipcMain.handle(IPC.redisForget, (e, key) => { guard(e); hub.forget(redisInstanceKeySchema.parse(key)); });
  ipcMain.handle(IPC.redisScan, (e, a) => { guard(e); return hub.scan(e.sender.id, redisScanSchema.parse(a)); });
  ipcMain.handle(IPC.redisValue, (e, a) => { guard(e); return hub.value(e.sender.id, redisValueSchema.parse(a)); });
  ipcMain.handle(IPC.redisCounter, (e, a) => { guard(e); return hub.counter(e.sender.id, redisCounterSchema.parse(a)); });
  ipcMain.handle(IPC.redisClients, (e) => { guard(e); return hub.clients(e.sender.id); });
  ipcMain.handle(IPC.redisSlowlog, (e) => { guard(e); return hub.slowlog(e.sender.id); });
  ipcMain.handle(IPC.redisJobs, (e, a) => { guard(e); return hub.jobs(e.sender.id, redisJobsSchema.parse(a)); });
  ipcMain.handle(IPC.redisJob, (e, a) => { guard(e); return hub.job(e.sender.id, redisJobSchema.parse(a)); });
  ipcMain.handle(IPC.redisPreview, (e, a) => { guard(e); return hub.preview(e.sender.id, redisPreviewSchema.parse(a)); });
  ipcMain.handle(IPC.redisWrite, (e, a) => { guard(e); return hub.write(e.sender.id, redisWriteSchema.parse(a)); });
  ipcMain.handle(IPC.redisUndo, (e, id) => { guard(e); return hub.undo(e.sender.id, redisUndoSchema.parse(id)); });
  ipcMain.on(IPC.redisWatch, (e, w) => { const r = redisWatchSchema.safeParse(w); if (ok(e) && r.success) hub.watch(e.sender.id, r.data); });
  ipcMain.on(IPC.redisSeen, (e, id) => { const r = redisQueueIdSchema.safeParse(id); if (ok(e) && r.success) hub.seen(e.sender.id, r.data); });
}
