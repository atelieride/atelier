import { ipcMain, type IpcMainInvokeEvent } from 'electron';
import { existsSync, lstatSync } from 'node:fs';
import { resolve } from './cpath';
import { IPC } from '@shared/api';
import type { FileContent, ImageContent } from '@shared/files';
import { insideProject, listDir, readLargeProjectFile, readProjectFile, readProjectImage, resolveCandidate, type Granted } from './fs/files';
import type { GrantStore } from './fs/grants';
import { createEntry, createFileWithContent, duplicateEntry, entryInfo, moveToTrash, renameEntry, saveFile, saveGrantedFile } from './fs/write';
import { BUNDLE_EXTENSIONS, openTerminalFolder, openUrl } from './links';
import { checkClaudeFolder, checkClaudeFile, claudeTempPath, claudeTempRoot } from './fs/claude-images';
import { checkOutsideFile } from './fs/outside-read';
import { filesClaudeTempSchema, filesOutsideSchema, filesCreateSchema, filesListSchema, filesPathSchema, filesReadSchema, filesRenameSchema, filesResolveSchema, filesSaveAsSchema, filesSaveSchema, urlSchema } from './ipc-schemas';
import { isBelow } from '@shared/paths';

/**
 * The files outside the project a project may read: granted ones, by the real path they resolve
 * to now; a granted file deleted on disk answers its own path (so its tab reads "missing" and a forced save recreates it).
 */
export function grantedOf(grants: GrantStore, root: string): Granted {
  return (p) => {
    const real = grants.check(root, p);
    if (real) return real;
    const abs = resolve(p);
    if (!grants.has(root, abs)) return null;
    try { lstatSync(abs); return null; } catch { return abs; }
  };
}

/**
 * Which writer a save goes to: the project's (which refuses anything outside the root) or the granted-file one; none
 * for a file granted read-only.
 */
export function saveRoute(root: string, p: string, granted: Granted, readOnly: (real: string) => boolean = () => false): { kind: 'project' } | { kind: 'granted'; real: string } | { kind: 'read-only' } {
  if (insideProject(root, p)) return { kind: 'project' };
  const real = granted(p);
  if (!real) return { kind: 'project' };
  return readOnly(real) ? { kind: 'read-only' } : { kind: 'granted', real };
}

/** Claude's temp root and the grants, for terminal links to the files in it. */
export interface ClaudeTempDeps {
  tmp: () => string;
  uid: number | null;
  grants: GrantStore;
  /** The temp folder exists but fails its check (owner, writable by others, a link): told once per folder. */
  onUntrusted?: (root: string) => void;
}

const reported = new WeakMap<(root: string) => void, Set<string>>();

/** On hover: the file's (or folder's) real path and label, or null. Never grants. */
export function claudeTempResolve(p: string, deps: ClaudeTempDeps): { path: string; rel: string; folder?: true } | null {
  const tmp = deps.tmp();
  if (p.endsWith('/')) {
    const f = checkClaudeFolder(tmp, p, deps.uid);
    return f ? { ...f, folder: true } : null;
  }
  const r = checkClaudeFile(tmp, p, deps.uid);
  const tell = deps.onUntrusted;
  if (!r && tell && !claudeTempRoot(tmp, deps.uid)) {
    // Otherwise every link into it silently never appears.
    const root = claudeTempPath(tmp);
    const seen = reported.get(tell) ?? new Set<string>();
    if (root && !seen.has(root) && existsSync(root)) {
      seen.add(root);
      reported.set(tell, seen);
      tell(root);
    }
  }
  return r;
}

/**
 * An outside file read for its tab, marked when it lies in Claude's temp folder (its tab says "Claude temp"). Checked
 * at every read: the folder may appear after the window opened (macOS empties /tmp at every restart).
 */
export function markClaudeTemp<C extends ImageContent | FileContent>(c: C, deps: ClaudeTempDeps | null): C {
  if (!deps || !c.external) return c;
  const root = claudeTempRoot(deps.tmp(), deps.uid);
  return root && isBelow(root, c.path) ? { ...c, claudeTemp: true } : c;
}

/**
 * A file read for its editor tab: marked like an image, and `readGrant` when the project
 * holds it only through a read grant (a terminal link), whatever it reads as now (text, missing, binary), so the editor
 * never takes edits, nor offers a save or a recreate, it could not do.
 */
export function markTempRead(root: string, c: FileContent, deps: ClaudeTempDeps | null, readOnly: (real: string) => boolean = heldReadOnly(root, deps, null)): FileContent {
  const m = markClaudeTemp(c, deps);
  return m.external && readOnly(m.path) ? { ...m, readGrant: true } : m;
}

/** On click: checked again, then granted read-only to the project asking, so its tab can read it. */
export function claudeTempOpen(root: string, p: string, deps: ClaudeTempDeps): { path: string; rel: string } | null {
  const r = checkClaudeFile(deps.tmp(), p, deps.uid);
  return r && deps.grants.grant(root, r.path, 'read') === r.path ? r : null;
}

/** Any path outside the project and the temp folder: the grants and the user's home (`~/`). */
export interface OutsideReadDeps { grants: GrantStore; home: string }

/** At a ⌘-hover (the page asks only while ⌘ is held): the file's real path and label, or null. Never grants. */
export async function outsideResolve(root: string, p: string, deps: OutsideReadDeps): Promise<{ path: string; rel: string } | null> {
  const r = await checkOutsideFile(root, p, deps.home);
  return r && { path: r.path, rel: r.rel };
}

/**
 * At the ⌘-click: checked again, then granted read-only (one the project may edit already stays editable); a project
 * file reached through a link from outside opens as the project's, granted nothing.
 */
export async function outsideOpen(root: string, p: string, deps: OutsideReadDeps): Promise<{ path: string; rel: string } | null> {
  const r = await checkOutsideFile(root, p, deps.home);
  if (!r) return null;
  if (r.project) return { path: r.path, rel: r.rel };
  return deps.grants.grant(root, r.path, 'read') === r.path ? r : null;
}

/**
 * A file the project holds only through a read grant, never saved over:
 * from whichever deps carry the grants (in the app both carry the one GrantStore).
 */
export function heldReadOnly(root: string, claude: ClaudeTempDeps | null, outside: OutsideReadDeps | null): (real: string) => boolean {
  const grants = outside?.grants ?? claude?.grants;
  return (real) => grants?.mode(root, real) === 'read';
}

/** A folder link clicked: checked again, then opened in Finder (Atelier reads nothing in it). */
export async function claudeFolderReveal(p: string, deps: ClaudeTempDeps, open: (real: string) => Promise<void> = (real) => openTerminalFolder(real, { bundleName: BUNDLE_EXTENSIONS })): Promise<boolean> {
  const f = checkClaudeFolder(deps.tmp(), p, deps.uid);
  if (!f) return false;
  await open(f.path);
  return true;
}

/** Files and links: every path is checked against the project root of the requesting window (or its grants). */
export function installFilesIpc(projectOf: (wcId: number) => string | null, isTrusted: (e: IpcMainInvokeEvent) => boolean, onWrote: (path: string) => void = () => {}, granted: (root: string) => Granted = () => () => null, claude: ClaudeTempDeps | null = null, outside: OutsideReadDeps | null = null): void {
  // What the user writes from Atelier is never attributed to a session running Bash meanwhile (onWrote).
  const created = <T extends object>(r: T): T => { if ('path' in r && typeof r.path === 'string') onWrote(r.path); return r; };
  const root = (e: IpcMainInvokeEvent) => {
    const r = projectOf(e.sender.id);
    if (!r || !isTrusted(e)) throw new Error('unauthorized sender');
    return r;
  };
  ipcMain.handle(IPC.filesList, (e, arg) => { const o = filesListSchema.parse(arg); return listDir(root(e), o.dir, o.showHidden); });
  ipcMain.handle(IPC.filesRead, (e, arg) => { const r = root(e); return markTempRead(r, readProjectFile(r, filesReadSchema.parse(arg), granted(r)), claude, heldReadOnly(r, claude, outside)); });
  ipcMain.handle(IPC.filesReadLarge, (e, arg) => { const r = root(e); return markTempRead(r, readLargeProjectFile(r, filesReadSchema.parse(arg), granted(r)), claude, heldReadOnly(r, claude, outside)); });
  ipcMain.handle(IPC.filesReadImage, (e, arg) => { const r = root(e); return markClaudeTemp(readProjectImage(r, filesReadSchema.parse(arg), granted(r)), claude); });
  ipcMain.handle(IPC.filesResolve, (e, arg) => { const o = filesResolveSchema.parse(arg); return resolveCandidate(root(e), o.cwd, o.candidate); });
  ipcMain.handle(IPC.filesClaudeTempResolve, (e, arg) => { root(e); const p = filesClaudeTempSchema.parse(arg); return claude ? claudeTempResolve(p, claude) : null; });
  ipcMain.handle(IPC.filesClaudeTempOpen, (e, arg) => { const r = root(e); const p = filesClaudeTempSchema.parse(arg); return claude ? claudeTempOpen(r, p, claude) : null; });
  ipcMain.handle(IPC.filesClaudeFolderReveal, (e, arg) => { root(e); const p = filesClaudeTempSchema.parse(arg); return claude ? claudeFolderReveal(p, claude) : false; });
  ipcMain.handle(IPC.filesOutsideResolve, (e, arg) => { const r = root(e); const p = filesOutsideSchema.parse(arg); return outside ? outsideResolve(r, p, outside) : null; });
  ipcMain.handle(IPC.filesOutsideOpen, (e, arg) => { const r = root(e); const p = filesOutsideSchema.parse(arg); return outside ? outsideOpen(r, p, outside) : null; });
  ipcMain.handle(IPC.openUrl, async (e, arg) => { if (!isTrusted(e)) return; await openUrl(urlSchema.parse(arg)); });

  // File editing: every write goes through fs/write.ts.
  ipcMain.handle(IPC.filesSave, (e, arg) => {
    const o = filesSaveSchema.parse(arg);
    const r0 = root(e);
    const route = saveRoute(r0, o.path, granted(r0), heldReadOnly(r0, claude, outside));
    if (route.kind === 'read-only') return { kind: 'error', reason: 'read-only' };
    // A file outside the project is in no repository: nothing to keep from Bash attribution.
    if (route.kind === 'granted') return saveGrantedFile(route.real, o.text, o.base, o.eol, o.create ?? false);
    const r = saveFile(r0, o.path, o.text, o.base, o.eol, o.create ?? false);
    if (r.kind === 'saved') onWrote(o.path);
    return r;
  });
  ipcMain.handle(IPC.filesCreate, (e, arg) => { const o = filesCreateSchema.parse(arg); return created(createEntry(root(e), o.dir, o.name, o.kind)); });
  ipcMain.handle(IPC.filesSaveAs, (e, arg) => { const o = filesSaveAsSchema.parse(arg); return created(createFileWithContent(root(e), o.rel, o.text)); });
  ipcMain.handle(IPC.filesRename, (e, arg) => {
    const o = filesRenameSchema.parse(arg);
    const r = created(renameEntry(root(e), o.path, o.name));
    if ('path' in r) onWrote(o.path);
    return r;
  });
  ipcMain.handle(IPC.filesDuplicate, (e, arg) => created(duplicateEntry(root(e), filesPathSchema.parse(arg))));
  // What Move to Trash would take: the page asks in the tree row with it.
  ipcMain.handle(IPC.filesTrashInfo, (e, arg) => entryInfo(root(e), filesPathSchema.parse(arg)));
  // The page asked already (its row's Move to Trash): moved to the Trash, never deleted.
  ipcMain.handle(IPC.filesTrash, async (e, arg) => {
    const r = root(e);
    const p = filesPathSchema.parse(arg);
    const out = await moveToTrash(r, p);
    if ('ok' in out) onWrote(p);
    return out;
  });
}
