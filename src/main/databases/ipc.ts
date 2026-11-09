// Databases view IPC: every handler checks the sender is a trusted app page of a project
// window before it reads its input, parses the input with a strict schema, and hands the hub the sender's webContents
// id first: the hub uses only the connections that window's project can see, and every reply is the hub's own.
import { ipcMain, type IpcMainInvokeEvent } from 'electron';
import { IPC } from '@shared/api';
import {
  dbDdlSchema, dbEditSchema, dbFilteredSchema, dbFullSchema, dbIdSchema, dbMaskSchema, dbPageSchema, dbPasswordSchema, dbPeekSchema, dbRefsSchema,
  dbSchemaPickSchema, dbSelectSchema, dbTableRefSchema, dbTestSchema
} from '../ipc-schemas';
import type { DbHub } from './hub';

/** What the IPC uses of the hub. */
export type DbIpcHub = Pick<DbHub,
  | 'snapshotFor' | 'select' | 'connect' | 'disconnect' | 'password' | 'test' | 'save' | 'duplicate' | 'remove' | 'setMask'
  | 'noteWrite' | 'setSchema' | 'refresh' | 'page' | 'estimate' | 'count' | 'peek' | 'refs' | 'full' | 'structure' | 'relations' | 'ddl'
  | 'overview' | 'readOnlySql'>;

export function installDbIpc(hub: DbIpcHub, projectOf: (wcId: number) => string | null, isTrusted: (e: IpcMainInvokeEvent) => boolean): void {
  /** The sender's webContents id, once it is a trusted page of a project window; else it throws before anything is read. */
  const sender = (e: IpcMainInvokeEvent): number => {
    if (!projectOf(e.sender.id) || !isTrusted(e)) throw new Error('unauthorized sender');
    return e.sender.id;
  };
  ipcMain.handle(IPC.dbSnapshot, (e) => hub.snapshotFor(sender(e)));
  ipcMain.handle(IPC.dbSelect, (e, id) => { const w = sender(e); return hub.select(w, dbSelectSchema.parse(id)); });
  ipcMain.handle(IPC.dbConnect, (e, id) => { const w = sender(e); return hub.connect(w, dbIdSchema.parse(id)); });
  ipcMain.handle(IPC.dbDisconnect, (e, id) => { const w = sender(e); return hub.disconnect(w, dbIdSchema.parse(id)); });
  ipcMain.handle(IPC.dbPassword, (e, a) => { const w = sender(e); return hub.password(w, dbPasswordSchema.parse(a)); });
  ipcMain.handle(IPC.dbTest, (e, a) => { const w = sender(e); return hub.test(w, dbTestSchema.parse(a)); });
  ipcMain.handle(IPC.dbSave, (e, a) => { const w = sender(e); return hub.save(w, dbEditSchema.parse(a)); });
  ipcMain.handle(IPC.dbDuplicate, (e, id) => { const w = sender(e); return hub.duplicate(w, dbIdSchema.parse(id)); });
  ipcMain.handle(IPC.dbRemove, (e, id) => { const w = sender(e); return hub.remove(w, dbIdSchema.parse(id)); });
  ipcMain.handle(IPC.dbSetMask, (e, a) => { const w = sender(e); const m = dbMaskSchema.parse(a); return hub.setMask(w, m.id, m.on); });
  ipcMain.handle(IPC.dbNoteWrite, (e, id) => { const w = sender(e); return hub.noteWrite(w, dbIdSchema.parse(id)); });
  ipcMain.handle(IPC.dbSetSchema, (e, a) => { const w = sender(e); const s = dbSchemaPickSchema.parse(a); return hub.setSchema(w, s.id, s.schema); });
  ipcMain.handle(IPC.dbRefresh, (e) => hub.refresh(sender(e)));
  ipcMain.handle(IPC.dbPage, (e, a) => { const w = sender(e); return hub.page(w, dbPageSchema.parse(a)); });
  ipcMain.handle(IPC.dbEstimate, (e, a) => { const w = sender(e); return hub.estimate(w, dbFilteredSchema.parse(a)); });
  ipcMain.handle(IPC.dbCount, (e, a) => { const w = sender(e); return hub.count(w, dbFilteredSchema.parse(a)); });
  ipcMain.handle(IPC.dbPeek, (e, a) => { const w = sender(e); return hub.peek(w, dbPeekSchema.parse(a)); });
  ipcMain.handle(IPC.dbRefs, (e, a) => { const w = sender(e); return hub.refs(w, dbRefsSchema.parse(a)); });
  ipcMain.handle(IPC.dbFull, (e, a) => { const w = sender(e); return hub.full(w, dbFullSchema.parse(a)); });
  ipcMain.handle(IPC.dbStructure, (e, ref) => { const w = sender(e); return hub.structure(w, dbTableRefSchema.parse(ref)); });
  ipcMain.handle(IPC.dbRelations, (e, ref) => { const w = sender(e); return hub.relations(w, dbTableRefSchema.parse(ref)); });
  // A table's DDL, or a function's definition by its identity arguments.
  ipcMain.handle(IPC.dbDdl, (e, ref) => { const w = sender(e); return hub.ddl(w, dbDdlSchema.parse(ref)); });
  ipcMain.handle(IPC.dbOverview, (e, id) => { const w = sender(e); return hub.overview(w, dbIdSchema.parse(id)); });
  ipcMain.handle(IPC.dbReadOnlySql, (e, id) => { const w = sender(e); return hub.readOnlySql(w, dbIdSchema.parse(id)); });
}
