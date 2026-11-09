import { BrowserWindow, dialog, ipcMain, type IpcMainInvokeEvent } from 'electron';
import { lstatSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, realOut, relative, sep, toOut } from './cpath';
import { IPC } from '@shared/api';
import { pathListSplit } from '@shared/env';
import { homeLabel, type OpenPathsEvent } from '@shared/files';
import { insideProject } from './fs/files';
import type { GrantStore } from './fs/grants';
import { createFileWithContent, createOutsideFile, MAX_BYTES, systemTrash, trashEntry, validName } from './fs/write';
import { holds, pickTarget, planOpen, type OpenDeps, type TargetWindow } from './open-paths';
import { filesOpenDroppedSchema, filesSaveAsOutsideSchema } from './ipc-schemas';
import { devEnv } from './dev-env';
import { isAbsPath, isGitDirName, isInside, splitPath } from '@shared/paths';

// Every way a path reaches Atelier: main turns paths into an ev:open-paths for a window,
// granting the outside files on the way; an outside folder opens as a project.

/** What the opener needs of a window. */
export interface OpenWin { isDestroyed(): boolean; webContents: { id: number; send(channel: string, ...args: unknown[]): void } }

export interface OpenHost<W extends OpenWin = BrowserWindow> {
  grants: GrantStore;
  projectOf(wcId: number): string | null;
  isTrusted(e: IpcMainInvokeEvent): boolean;
  /** Opens a folder as a project (an open one comes to the front); `replacing`: a Welcome window giving way to it. */
  openProject(root: string, replacing: W | null): W | null;
  /** Brings a window to the front. */
  reveal(win: W): void;
  /** Project windows (real roots) with when they were last focused; the recent projects. */
  windows(): TargetWindow[];
  recent(): string[];
  window(wcId: number): W | null;
  /** A Welcome window (made if none). */
  welcome(): W;
  /** Outside files just opened in a project's window: watched for disk changes right away. */
  opened?(root: string, files: string[]): void;
  /** A project file the app just wrote or trashed (Save As from the panel): never attributed to a session's Bash. */
  wrote?(path: string): void;
  /**
   * The window paths arriving at `win` open in: a pop-out's project window, null when there is
   * none; absent or the window itself, they open where they arrive.
   */
  targetOf?(win: W): W | null;
  kind?(p: string): ReturnType<OpenDeps['kind']>;
  home?: string;
}

/**
 * Save Outside the Project… as the page asks it: the name to suggest, the text, and its
 * files open with unsaved edits (never replaced).
 */
export interface SaveOutsideAsk { name: string; text: string; unsaved: readonly string[] }

export function kindOf(p: string): ReturnType<OpenDeps['kind']> {
  try {
    const st = statSync(p);
    return st.isFile() ? 'file' : st.isDirectory() ? 'dir' : 'other';
  } catch {
    return 'missing';
  }
}

export function realOf(p: string): string {
  try { return realOut(p); } catch { return p; }
}

/**
 * Tests only (ATELIER_TEST_DROP_PATHS, inert in the packaged app): a file listing, one per line, the paths a drop
 * carries — a synthetic File has no disk path. Read at every drop, so a test can change it between drops.
 */
function testDropPaths(): string[] | null {
  const list = devEnv('ATELIER_TEST_DROP_PATHS');
  if (list === undefined) return null;
  try { return readFileSync(list, 'utf8').split('\n').filter((l) => isAbsPath(l)); } catch { return []; }
}

/** How long macOS open-file events are gathered: one per file, in a burst, for a single toast and cap. */
export const OPEN_FILE_BATCH_MS = 60;

export class Opener<W extends OpenWin = BrowserWindow> {
  /** Windows whose page listens for ev:open-paths; the others get theirs when it starts listening. */
  private readonly ready = new Set<number>();
  private readonly pending = new Map<number, OpenPathsEvent[]>();
  private readonly lastDir = new Map<number, string>();
  private batch: string[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private appReady = false;

  constructor(private readonly host: OpenHost<W>) {}

  private kind(p: string) { return (this.host.kind ?? kindOf)(p); }

  /**
   * Opens `paths` in `win` (its project, its grants), or in the window it hands them to (a pop-out's project window,
   * brought forward). Only for paths from a gesture the page can't fake (a drop, the open panel, macOS): outside files
   * are granted. Returns whether anything was sent or opened.
   */
  openIn(from: W, paths: string[]): boolean {
    const win = this.host.targetOf ? this.host.targetOf(from) : from;
    if (!win) return false;
    const done = this.openHere(win, paths);
    if (done && win !== from) this.host.reveal(win);
    return done;
  }

  /**
   * A path a pop-out's page names (a link, a path in its terminal): it opens in the project window,
   * brought forward, at `line`. The page could name anything, so nothing is granted and no folder opens: a regular file
   * inside the project, or one already granted to it, else nothing.
   */
  openLinked(from: W, path: string, line?: number): boolean {
    const win = this.host.targetOf ? this.host.targetOf(from) : from;
    const root = win ? this.host.projectOf(win.webContents.id) : null;
    if (!win || !root || this.kind(path) !== 'file') return false;
    const inProject = insideProject(realOf(root), path);
    const granted = inProject ? null : this.host.grants.check(root, path);
    const home = this.host.home ?? toOut(homedir());
    const entry = inProject
      ? { path: inProject, rel: relative(realOf(root), inProject).split(sep).join('/'), external: false }
      : granted ? { path: granted, rel: homeLabel(granted, home), external: true } : null;
    if (!entry) return false;
    this.deliver(win, { files: [{ ...entry, ...(line !== undefined ? { line } : {}) }], reveal: null, skipped: 0, capped: null, needsProject: 0 });
    if (granted) this.host.opened?.(root, [granted]);
    if (win !== from) this.host.reveal(win);
    return true;
  }

  private openHere(win: W, paths: string[]): boolean {
    const root = this.host.projectOf(win.webContents.id);
    const plan = planOpen(root ? realOf(root) : null, paths, {
      kind: (p) => this.kind(p),
      inside: (r, p) => insideProject(r, p),
      grant: (_r, p) => (root ? this.host.grants.grant(root, p) : null),
      home: this.host.home ?? toOut(homedir())
    });
    const ev: OpenPathsEvent = { files: plan.files, reveal: plan.reveal, skipped: plan.skipped, capped: plan.capped, needsProject: plan.needsProject };
    const send = ev.files.length > 0 || ev.reveal !== null || ev.skipped > 0 || ev.needsProject > 0;
    if (send) this.deliver(win, ev);
    const outside = plan.files.filter((f) => f.external).map((f) => f.path);
    if (root && outside.length) this.host.opened?.(root, outside);
    // By its real path: a folder dropped through a link finds the window already open on it.
    if (plan.project) this.host.openProject(realOf(plan.project), root ? null : win);
    return send || plan.project !== null;
  }

  private deliver(win: W, ev: OpenPathsEvent): void {
    if (win.isDestroyed()) return;
    const id = win.webContents.id;
    if (this.ready.has(id)) { win.webContents.send(IPC.evOpenPaths, ev); return; }
    this.pending.set(id, [...(this.pending.get(id) ?? []), ev]);
  }

  /** The page listens now: what came before is handed over. */
  takePending(wcId: number): OpenPathsEvent[] {
    this.ready.add(wcId);
    const list = this.pending.get(wcId) ?? [];
    this.pending.delete(wcId);
    return list;
  }

  /** The page (re)loads: until it listens again what arrives is held for it, never lost. */
  pageLoading(wcId: number): void {
    this.ready.delete(wcId);
  }

  /** The window closed: nothing more for it. */
  forget(wcId: number): void {
    this.ready.delete(wcId);
    this.pending.delete(wcId);
    this.lastDir.delete(wcId);
  }

  /**
   * Save As at the path main's save panel returned — never a path the page names, so an
   * outside file may be granted. Inside the window's project: a project file (`rel` from its root). Outside: a new file
   * granted to the project for editing and watched at once (`rel` from the home, as Open File… labels it). A file
   * already there (the panel asked "Replace?") goes to the Trash first; never over a folder or a link, never in .git,
   * never over a file open with unsaved edits (`unsaved`, the page's dirty tabs: only ever a refusal). Whatever could
   * refuse the write is checked before the Trash.
   */
  async saveAsAt(wcId: number, chosen: string, text: string, trash: (p: string) => Promise<void>, unsaved: readonly string[] = []): Promise<{ path: string; rel: string } | { error: string }> {
    const root = this.host.projectOf(wcId);
    if (!root) return { error: 'failed' };
    const realRoot = realOf(root);
    let target: string;
    try { target = join(realOut(dirname(chosen)), basename(chosen)); } catch { return { error: 'missing-folder' }; }
    let there: 'file' | 'other' | null = null;
    try { const st = lstatSync(target); there = st.isFile() ? 'file' : 'other'; } catch { there = null; }
    if (there === 'other') return { error: 'not-a-file' };
    if (there === 'file' && unsaved.some((u) => u === target || realOf(u) === target)) return { error: 'unsaved' };
    if (Buffer.byteLength(text, 'utf8') > MAX_BYTES) return { error: 'too-large' };
    if (isInside(realRoot, target)) {
      const rel = relative(realRoot, target).split(sep).join('/');
      const parts = splitPath(rel);
      if (parts.some((c) => isGitDirName(c))) return { error: 'in-git' };
      if (!parts.every((c) => validName(c))) return { error: 'invalid-name' };
      // The app's own writes: never attributed to a session running Bash meanwhile.
      if (there === 'file') {
        if ('error' in await trashEntry(root, target, trash)) return { error: 'trash-failed' };
        this.host.wrote?.(target);
      }
      const r = createFileWithContent(root, rel, text);
      if ('error' in r) return r;
      this.host.wrote?.(r.path);
      return { path: r.path, rel };
    }
    const r = await createOutsideFile(target, text, trash);
    if ('error' in r) return r;
    const granted = this.host.grants.grant(root, r.path, 'edit');
    if (!granted) return { error: 'failed' };
    this.host.opened?.(root, [granted]);
    return { path: granted, rel: homeLabel(granted, this.host.home ?? toOut(homedir())) };
  }

  /**
   * Save Outside the Project…: the save panel (`pick`), opened on the window's last
   * folder (else the system's own last one) with the page's name — only a name — then the write where it was put.
   */
  async saveAsFromPanel(wcId: number, ask: SaveOutsideAsk, pick: (defaultPath: string) => Promise<string | null>, trash: (p: string) => Promise<void>): Promise<{ path: string; rel: string } | { error: string } | { canceled: true }> {
    const name = basename(ask.name.trim()) || 'Untitled';
    const last = this.lastDir.get(wcId);
    const chosen = await pick(last ? join(last, name) : name);
    if (chosen === null) return { canceled: true };
    // Drive paths only on Windows: a network share is said, not silently dropped.
    if (!isAbsPath(chosen)) return { error: 'unsupported-path' };
    this.lastDir.set(wcId, dirname(chosen));
    return this.saveAsAt(wcId, chosen, ask.text, trash, ask.unsaved);
  }

  /** macOS open-file (Finder Open With, `open -a`, the atelier command); held until the app has its windows. */
  openFromSystem(path: string): void {
    this.batch.push(path);
    if (!this.appReady) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), OPEN_FILE_BATCH_MS);
  }

  /** The restored windows exist: held open-file paths are routed now. */
  appStarted(): void {
    this.appReady = true;
    if (this.batch.length) this.flush();
  }

  private flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const files: string[] = [];
    for (const p of this.batch.splice(0)) {
      if (this.kind(p) === 'dir') this.openFolder(realOf(p));
      else files.push(p);
    }
    if (!files.length) return;
    // A burst goes where its first file goes (Finder sends a selection together).
    const target = pickTarget(realOf(files[0]!), this.host.windows(), this.host.recent());
    // A Welcome window alone (a cold launch with nothing to restore) gives way to the project, as with Open Folder….
    const welcome = this.host.windows().find((w) => w.root === null);
    const win = target.kind === 'window' ? this.host.window(target.id)
      : target.kind === 'open-project' ? this.host.openProject(target.root, welcome ? this.host.window(welcome.id) : null) : this.host.welcome();
    if (!win) return;
    this.openIn(win, files);
    this.host.reveal(win);
  }

  /** A folder from macOS: its own window if open; inside an open project, revealed in its tree; else a project. */
  private openFolder(dir: string): void {
    const wins = this.host.windows().filter((w): w is TargetWindow & { root: string } => w.root !== null);
    const own = wins.some((w) => w.root === dir);
    const holder = own ? undefined : wins.filter((w) => holds(w.root, dir)).sort((a, b) => b.root.length - a.root.length || b.focusedAt - a.focusedAt)[0];
    const win = holder ? this.host.window(holder.id) : null;
    if (win) { this.openIn(win, [dir]); this.host.reveal(win); return; }
    const opened = this.host.openProject(dir, null);
    if (opened) this.host.reveal(opened);
  }

  installIpc(this: Opener<BrowserWindow>): void {
    const windowOf = (e: IpcMainInvokeEvent) => (this.host.isTrusted(e) ? BrowserWindow.fromWebContents(e.sender) : null);

    ipcMain.handle(IPC.filesOpenReady, (e) => (this.host.isTrusted(e) ? this.takePending(e.sender.id) : []));

    ipcMain.handle(IPC.filesOpenDropped, (e, arg) => {
      const win = windowOf(e);
      if (!win) return;
      this.openIn(win, testDropPaths() ?? filesOpenDroppedSchema.parse(arg));
    });

    ipcMain.handle(IPC.filesOpenPicker, async (e) => {
      const win = windowOf(e);
      if (!win) return;
      const wcId = win.webContents.id;
      let paths: string[];
      // e2e: the paths the open panel would return (a PATH-like list), never a real panel.
      const fake = devEnv('ATELIER_TEST_PICK_FILES');
      if (fake !== undefined) paths = pathListSplit(fake).filter(Boolean);
      else {
        const root = this.host.projectOf(wcId);
        const r = await dialog.showOpenDialog(win, { defaultPath: this.lastDir.get(wcId) ?? root ?? homedir(), properties: ['openFile', 'multiSelections', 'showHiddenFiles'] });
        if (r.canceled) return;
        paths = r.filePaths.map(toOut);
      }
      if (paths[0]) this.lastDir.set(wcId, dirname(paths[0]));
      if (!win.isDestroyed()) this.openIn(win, paths);
    });

    // Save As outside the project: the page only suggests a name; the path is main's
    // save panel's, opened on this window's last outside folder (else the system's own last one).
    ipcMain.handle(IPC.filesSaveAsOutside, async (e, arg): Promise<{ path: string; rel: string } | { error: string } | { canceled: true }> => {
      const win = windowOf(e);
      if (!win) throw new Error('unauthorized sender');
      const ask = filesSaveAsOutsideSchema.parse(arg);
      // e2e: a file holding the path the panel would return (empty: Cancel), read at every save; never a real panel.
      const fake = devEnv('ATELIER_TEST_SAVE_PATH');
      const pick = fake !== undefined
        ? async () => { try { return readFileSync(fake, 'utf8').trim() || null; } catch { return null; } }
        : async (defaultPath: string) => {
          const r = await dialog.showSaveDialog(win, { defaultPath, properties: ['createDirectory', 'showHiddenFiles'] });
          return r.canceled || !r.filePath ? null : toOut(r.filePath);
        };
      return this.saveAsFromPanel(win.webContents.id, ask, pick, await systemTrash());
    });
  }
}
