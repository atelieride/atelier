// Tab pop-out windows: the IPC. Every handler checks the sender is an app page of the right kind of
// window (open/recall/list/tear/front: a project window; dock/handoff/forward/drag/open-in-main/show-in-main/rekey: a pop-out; focus: either) and parses its input
// with a strict schema; the project is always the sender's own, never one the renderer names.
import { ipcMain, type IpcMainInvokeEvent } from 'electron';
import { IPC, type MenuCommand } from '@shared/api';
import type { AdoptAnswer, DockEvent, EditorHandoff, MoveRequest, MoveResult, PopoutOpenRequest, PopoutOpenResult, ProjectWindowInfo } from '@shared/popout';
import { adoptAnswerSchema, dockRequestSchema, moveRequestSchema, popoutFocusSchema, popoutForwardSchema, popoutKeySchema, popoutOpenInMainSchema, popoutOpenSchema, popoutRekeySchema, popoutShowInMainSchema, popoutTearStartSchema } from './ipc-schemas';
import type { MoveSource } from './tab-mover';
import type { TearOff } from './tear-off';
import type { PopoutManager } from './popouts';
import type { WindowKind } from './popout-wiring';

type Sender = Pick<IpcMainInvokeEvent, 'sender'>;

export interface PopoutIpcHost {
  isTrusted(e: Sender): boolean;
  kindOf(wcId: number): WindowKind | undefined;
  projectOf(wcId: number): string | null;
  popouts: Pick<PopoutManager, 'open' | 'dock' | 'focus' | 'recall' | 'keys' | 'takeHandoff' | 'dragStart' | 'dragEnd' | 'dragCancel' | 'rekey'>;
  /** Tab tear-off: a tab drag in a project window. */
  tear: Pick<TearOff, 'start' | 'end'>;
  /** A menu command a pop-out forwards: run in its project's main window, brought forward (popout-wiring's forwardCommand). */
  forward(root: string, cmd: MenuCommand): void;
  /** A project window asks to come forward: what a pop-out's forwarded F4 walked to opened in it. */
  front(wcId: number): void;
  /**
   * A file a pop-out opens (a link, a path): in its project window, brought forward, at that line. The page names the
   * path, so it never grants: only a project file or an outside file already granted (Opener.openLinked).
   */
  openInMain(wcId: number, path: string, line?: number): void;
  /** A tab a pop-out asks for (not in another pop-out): docked into its project window, which comes forward. */
  showInMain(root: string, ev: DockEvent): void;
  /** The mover (TabMover.move / adopted) and the open project windows. */
  moveTo(from: MoveSource, r: MoveRequest): Promise<MoveResult>;
  adopted(wcId: number, a: AdoptAnswer): void;
  projectWindows(): ProjectWindowInfo[];
  /** A tab released outside its window: over another project's window that takes it, the move's answer; else null. */
  moveAtCursor(root: string, wcId: number, r: PopoutOpenRequest): Promise<PopoutOpenResult | null>;
}

const FAILED: PopoutOpenResult = { ok: false, reason: 'failed' };
const MOVE_FAILED: MoveResult = { ok: false, reason: 'failed' };

export function installPopoutIpc(h: PopoutIpcHost): void {
  /** The sender's project when it is a trusted window of that kind (any kind: undefined), else null. */
  const rootOf = (e: Sender, kind?: WindowKind): string | null => {
    if (!h.isTrusted(e)) return null;
    const k = h.kindOf(e.sender.id);
    if (!k || (kind && k !== kind)) return null;
    return h.projectOf(e.sender.id);
  };

  ipcMain.handle(IPC.popoutOpen, async (e, arg): Promise<PopoutOpenResult> => {
    const root = rootOf(e, 'project');
    const r = popoutOpenSchema.safeParse(arg);
    if (!root || !r.success) return FAILED;
    // Released over another project's window that takes the tab: moved there.
    if (r.data.at === 'cursor') {
      const moved = await h.moveAtCursor(root, e.sender.id, r.data);
      if (moved) return moved;
    }
    return h.popouts.open(root, r.data);
  });
  ipcMain.handle(IPC.windowsMoveTab, (e, arg): Promise<MoveResult> => {
    const root = rootOf(e);
    const r = moveRequestSchema.safeParse(arg);
    if (!root || !r.success) return Promise.resolve(MOVE_FAILED);
    return h.moveTo({ wcId: e.sender.id, root, popout: h.kindOf(e.sender.id) === 'popout' }, r.data);
  });
  ipcMain.handle(IPC.windowsAdopted, (e, arg) => {
    const r = adoptAnswerSchema.safeParse(arg);
    if (rootOf(e, 'project') && r.success) h.adopted(e.sender.id, r.data);
  });
  ipcMain.handle(IPC.windowsList, (e): ProjectWindowInfo[] => (h.isTrusted(e) && h.kindOf(e.sender.id) ? h.projectWindows() : []));
  ipcMain.handle(IPC.popoutTearStart, (e, arg) => {
    const root = rootOf(e, 'project');
    const r = popoutTearStartSchema.safeParse(arg);
    if (root && r.success) h.tear.start(root, r.data);
  });
  ipcMain.handle(IPC.popoutTearEnd, (e) => {
    const root = rootOf(e, 'project');
    if (root) h.tear.end(root);
  });
  ipcMain.handle(IPC.popoutRecall, (e, arg) => {
    const root = rootOf(e, 'project');
    const key = popoutKeySchema.safeParse(arg);
    if (root && key.success) h.popouts.recall(root, key.data);
  });
  ipcMain.handle(IPC.popoutList, (e): string[] => {
    const root = rootOf(e, 'project');
    return root ? h.popouts.keys(root) : [];
  });
  ipcMain.handle(IPC.popoutFocus, (e, arg) => {
    const root = rootOf(e);
    const r = popoutFocusSchema.safeParse(arg);
    if (root && r.success) h.popouts.focus(root, r.data.key, r.data.reveal);
  });
  ipcMain.handle(IPC.popoutDock, (e, arg) => {
    const r = dockRequestSchema.safeParse(arg);
    if (rootOf(e, 'popout') && r.success) h.popouts.dock(e.sender.id, r.data);
  });
  ipcMain.handle(IPC.popoutHandoff, (e): EditorHandoff | null => (rootOf(e, 'popout') ? h.popouts.takeHandoff(e.sender.id) : null));
  ipcMain.handle(IPC.popoutForward, (e, arg) => {
    const root = rootOf(e, 'popout');
    const cmd = popoutForwardSchema.safeParse(arg);
    if (root && cmd.success) h.forward(root, cmd.data as MenuCommand);
  });
  // No input: only the sender's own window comes forward, and only a project window's.
  ipcMain.handle(IPC.popoutFront, (e) => { if (rootOf(e, 'project')) h.front(e.sender.id); });
  ipcMain.handle(IPC.popoutOpenInMain, (e, arg) => {
    const r = popoutOpenInMainSchema.safeParse(arg);
    if (rootOf(e, 'popout') && r.success) h.openInMain(e.sender.id, r.data.path, r.data.line);
  });
  ipcMain.handle(IPC.popoutShowInMain, (e, arg) => {
    const root = rootOf(e, 'popout');
    const r = popoutShowInMainSchema.safeParse(arg);
    if (!root || !r.success) return;
    const { key, payload } = r.data;
    // Popped out in another window: that one comes forward (with the payload); else the project window shows it.
    if (h.popouts.focus(root, key, payload ? { payload } : undefined)) return;
    h.showInMain(root, { key, ...(payload ? { payload } : {}) });
  });
  ipcMain.handle(IPC.popoutDragStart, (e) => { if (rootOf(e, 'popout')) h.popouts.dragStart(e.sender.id); });
  // Released over another project's window: the move's answer (the pop-out says a refusal), else null.
  ipcMain.handle(IPC.popoutDragEnd, (e, arg) => {
    const r = dockRequestSchema.safeParse(arg);
    return rootOf(e, 'popout') && r.success ? h.popouts.dragEnd(e.sender.id, r.data) ?? null : null;
  });
  ipcMain.handle(IPC.popoutDragCancel, (e) => { if (rootOf(e, 'popout')) h.popouts.dragCancel(e.sender.id); });
  // Save As in a pop-out: only its own window's key, an untitled buffer, becoming a file on disk (the manager checks
  // `from` is the sender's key).
  ipcMain.handle(IPC.popoutRekey, (e, arg) => {
    const r = popoutRekeySchema.safeParse(arg);
    if (rootOf(e, 'popout') && r.success) h.popouts.rekey(e.sender.id, r.data.from, r.data.to);
  });
}
