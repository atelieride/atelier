import { ipcMain, type IpcMainInvokeEvent } from 'electron';
import { homedir } from 'node:os';
import { IPC } from '@shared/api';
import type { RestoredTabs, SavedTabs } from '@shared/tabs-state';
import { insideProject } from './fs/files';
import type { GrantStore } from './fs/grants';
import type { ClaudeTempDeps } from './files-ipc';
import { checkClaudeFile, underClaudeTemp } from './fs/claude-images';
import type { OutsideFiles } from './outside-files';
import { keepAllowed, restoreTabs, shelfKeep, type TabsStore } from './tabs-store';
import { tabsSaveSchema } from './ipc-schemas';
import { isAbsPath } from '@shared/paths';

export interface TabsHost {
  projectOf(wcId: number): string | null;
  isTrusted(e: IpcMainInvokeEvent): boolean;
  grants: GrantStore;
  store: TabsStore;
  outside: OutsideFiles;
  /** The files the project's pop-outs show: open in the project too, so watched and kept granted. */
  popoutFiles?(root: string): string[];
  /** Claude's temp folder: its files come back read-only. */
  claudeTempDeps?: ClaudeTempDeps;
}

/**
 * The project of the window asking. A window's last save (on pagehide) can arrive once its frame is gone and it has left
 * the windows' list: a webContents that proved to be an app page before keeps its project (ids are never reused).
 */
export class SenderRoots {
  private readonly known = new Map<number, string>();

  constructor(private readonly projectOf: (wcId: number) => string | null, private readonly isTrusted: (e: IpcMainInvokeEvent) => boolean) {}

  of(e: IpcMainInvokeEvent): string | null {
    const id = e.sender.id;
    if (e.senderFrame) {
      const root = this.isTrusted(e) ? this.projectOf(id) : null;
      if (root) this.known.set(id, root);
      return root;
    }
    return this.known.get(id) ?? null;
  }

  /** The window is still one of its project's: a save that arrives after it closed must not watch its files again. */
  stillOpen(e: IpcMainInvokeEvent): boolean {
    return this.projectOf(e.sender.id) !== null;
  }
}

/**
 * The outside files open in a project: those of its main window's tabs, and those its pop-outs show (only granted
 * ones, by their real path: a pop-out's key is whatever its page asked for).
 */
export function outsideOpenNow(tabFiles: string[], popoutFiles: string[], inside: (f: string) => boolean, granted: (f: string) => string | null): string[] {
  const out = tabFiles.filter((f) => !inside(f));
  for (const f of popoutFiles) {
    if (!isAbsPath(f) || inside(f)) continue;
    const real = granted(f);
    if (real && !out.includes(real)) out.push(real);
  }
  return out;
}

/**
 * The outside files of a save the project holds only through a read grant: main's word,
 * from its grants, so a restore can't make a terminal link's file editable.
 */
export function readOnlyOf(root: string, grants: GrantStore, files: string[]): string[] {
  return files.filter((f) => grants.mode(root, f) === 'read');
}

/**
 * How restored outside files are granted again: a file in Claude's temp folder read-only with its short label,
 * one main saved read-only (`readOnly`) read-only, anything
 * else as a gesture gave it. `readOnly` null: saved before main kept the mode.
 */
export function restoreGrants(root: string, grants: GrantStore, claude: ClaudeTempDeps | null = null, readOnly: readonly string[] | null = null): { grant(f: string): string | null; label(f: string): string | null } {
  // Files only: never a folder of the temp folder.
  const temp = (f: string) => (claude ? checkClaudeFile(claude.tmp(), f, claude.uid) : null);
  return {
    grant: (f) => {
      // Saves from before the mode was kept don't say whether a link (read) or a gesture (edit) opened a temp file:
      // never editable from a restore.
      if (temp(f)) return grants.grant(root, f, 'read');
      // A file there that fails its check now (root no longer trusted): dropped, never made editable.
      if (claude && underClaudeTemp(claude.tmp(), f)) return null;
      return grants.grant(root, f, readOnly?.includes(f) ? 'read' : 'edit');
    },
    label: (f) => temp(f)?.rel ?? null
  };
}

/** The files open in a project's main window: its file tabs and its Shelf's. */
export function openFilesOf(tabs: SavedTabs | RestoredTabs): string[] {
  return [...tabs.files, ...(tabs.shelf ?? [])].map((f) => (typeof f === 'string' ? f : f.path));
}

/** Tabs across restarts. */
export function installTabsIpc(host: TabsHost): void {
  const senders = new SenderRoots(host.projectOf, host.isTrusted);
  const report = (root: string, files: string[]) => host.outside.reported(root, outsideOpenNow(files, host.popoutFiles?.(root) ?? [], (f) => insideProject(root, f) !== null, (f) => host.grants.check(root, f)));

  ipcMain.handle(IPC.tabsSave, (e, arg) => {
    const root = senders.of(e);
    if (!root) return;
    const tabs = keepAllowed(root, tabsSaveSchema.parse(arg), (f) => host.grants.has(root, f), shelfKeep(host.grants, root, host.store.get(root)?.shelf ?? []));
    host.store.set(root, tabs, readOnlyOf(root, host.grants, openFilesOf(tabs)));
    // The Shelf's outside files count as open: watched, and never the grants given up first.
    if (senders.stillOpen(e)) report(root, openFilesOf(tabs));
  });

  ipcMain.handle(IPC.tabsRestore, (e): RestoredTabs | null => {
    const root = senders.of(e);
    const saved = root ? host.store.get(root) : null;
    if (!root || !saved) return null;
    const again = restoreGrants(root, host.grants, host.claudeTempDeps, host.store.readOnly(root));
    const restored = restoreTabs(root, saved, again.grant, homedir(), again.label);
    report(root, openFilesOf(restored));
    return restored;
  });
}
