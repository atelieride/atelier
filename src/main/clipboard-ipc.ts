import { app, clipboard, ClipboardItem, ipcMain, shell, type IpcMainInvokeEvent } from 'electron';
import { appendFileSync, readFileSync } from 'node:fs';
import { posix, win32 } from 'node:path';
import { currentPlatform } from '@shared/platform';
import { devEnv } from './dev-env';
import { IPC } from '@shared/api';
import { insideProject, type Granted } from './fs/files';
import { MAX_IMAGE_BYTES, saveClipboardImage } from './clipboard-image';

const MAX = 16 * 1024 * 1024;

/** Clipboard text: only strings up to 16 MB, with no NUL characters. */
export function sanitizeClipboard(v: unknown): string | null {
  if (typeof v !== 'string' || v.length > MAX) return null;
  return v.replace(/\0/g, '');
}

/** What a copy writes: its text, and an HTML flavour too for a formatted copy (Ask's). */
export interface ClipContent { text: string; html?: string }

/** A copy's flavours, each held to the clipboard rules (null: refused, nothing is written). */
export function clipboardContent(text: unknown, html: unknown): ClipContent | null {
  const t = sanitizeClipboard(text);
  if (t === null) return null;
  if (html === undefined) return { text: t };
  const h = sanitizeClipboard(html);
  return h === null ? null : { text: t, html: h };
}

/** Writes a copy to the system clipboard: its text alone, or one item with both flavours (Electron 44's async API). */
export function systemWrite(
  c: ClipContent,
  clip: { writeText(text: string): Promise<void>; write(items: never[]): Promise<void> },
  Item: new (parts: Record<string, string>) => unknown
): Promise<void> {
  return c.html === undefined ? clip.writeText(c.text) : clip.write([new Item({ 'text/plain': c.text, 'text/html': c.html })] as never[]);
}

/**
 * Copies a text (and its HTML flavour). Tests only (ATELIER_TEST_CLIPBOARD_LOG, inert in the packaged app): the copy is
 * recorded in the log, one JSON value per line (the text's string, or `{text, html}` for a formatted copy), and the
 * real clipboard is never touched.
 */
export function writeClipboard(c: ClipContent, testLog: string | undefined, write: (c: ClipContent) => void | Promise<void>): void | Promise<void> {
  if (testLog) { appendFileSync(testLog, JSON.stringify(c.html === undefined ? c.text : { text: c.text, html: c.html }) + '\n'); return; }
  return write(c);
}

/**
 * The clipboard's text. Tests only (ATELIER_TEST_CLIPBOARD_LOG): the last text copied in the log ('' before any), so a
 * test reads what it "copied" and the real clipboard is never read.
 */
export async function readClipboard(testLog: string | undefined, read: () => string | Promise<string>): Promise<string> {
  if (!testLog) return String(await read());
  let lines: string[];
  try { lines = readFileSync(testLog, 'utf8').split('\n').filter(Boolean); } catch { return ''; }
  const last = lines.at(-1);
  if (!last) return '';
  const v: unknown = JSON.parse(last);
  return typeof v === 'object' && v !== null && 'text' in v ? String(v.text) : String(v);
}

/** Clipboard text to paste: over the limit nothing (null), never a piece silently cut. */
export function readableClipboard(text: string): string | null {
  return text.length > MAX ? null : text;
}

/** The path to show in Finder, only if it exists and is inside the project, or is a file outside it the user opened. */
export function revealTarget(root: string, p: string, granted: Granted = () => null): string | null {
  return insideProject(root, p) ?? granted(p);
}

/**
 * Where pasted images go: the user's temp dir on macOS; on Windows ATELIER_HOME, since the
 * Store package's AppData writes land in its private copy and Claude, in a terminal, reads the file.
 */
export function clipboardImageDir(platform: string, home: string, temp: string): string {
  return platform === 'win32' ? win32.join(home, 'clipboard') : posix.join(temp, 'atelier-clipboard');
}

/** The png bytes of the image on the clipboard (Chromium exposes images as image/png), null if there is none. */
async function clipboardPng(): Promise<Buffer | null> {
  for (const item of await clipboard.read()) {
    if (!item.types.includes('image/png')) continue;
    const blob = await item.getType('image/png');
    return Buffer.from(await blob.arrayBuffer());
  }
  return null;
}

/** Clipboard and Finder for the right-click menus. Reading the clipboard is only needed for Paste in the terminal. */
export function installClipboardIpc(projectOf: (wcId: number) => string | null, isTrusted: (e: IpcMainInvokeEvent) => boolean, home: string, granted: (root: string) => Granted = () => () => null): void {
  ipcMain.handle(IPC.clipboardWrite, async (e, arg, html) => {
    if (!isTrusted(e)) return;
    const c = clipboardContent(arg, html);
    if (c === null) return false;
    try {
      await writeClipboard(c, devEnv('ATELIER_TEST_CLIPBOARD_LOG'), (x) => systemWrite(x, clipboard, ClipboardItem));
    } catch {
      return false;
    }
    return true;
  });
  ipcMain.handle(IPC.clipboardRead, async (e) => (isTrusted(e) ? readableClipboard(await readClipboard(devEnv('ATELIER_TEST_CLIPBOARD_LOG'), () => clipboard.readText())) : ''));
  // The main process picks the folder (clipboardImageDir), never the renderer.
  ipcMain.handle(IPC.clipboardImage, async (e) => {
    if (!isTrusted(e)) return null;
    try {
      const png = await clipboardPng();
      if (png && png.length > MAX_IMAGE_BYTES) return { tooLarge: true };
      const path = saveClipboardImage(png, clipboardImageDir(currentPlatform(), home, app.getPath('temp')));
      return path ? { path } : null;
    } catch {
      return null;
    }
  });
  ipcMain.handle(IPC.filesReveal, (e, arg) => {
    const root = projectOf(e.sender.id);
    if (!root || !isTrusted(e) || typeof arg !== 'string' || arg.length > 4096) return;
    const target = revealTarget(root, arg, granted(root));
    if (target) shell.showItemInFolder(target);
  });
}
