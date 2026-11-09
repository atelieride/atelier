// The atelier-media: scheme in Electron: registered before the app is ready, its
// handler and the IPC that issues tokens once it is. Everything it decides is in media-protocol.ts (tested there).
import { ipcMain, protocol, type IpcMainInvokeEvent } from 'electron';
import { createReadStream, statSync } from 'node:fs';
import { Readable } from 'node:stream';
import { IPC } from '@shared/api';
import { reachFile, type Granted } from './fs/files';
import { filesReadSchema } from './ipc-schemas';
import { MEDIA_SCHEME, MediaTokens, mediaResponse, openVideo } from './media-protocol';

/** Before `ready` (Electron's rule): standard (a host and a path), secure, streaming (ranges for <video>); no CSP bypass. */
export function registerMediaScheme(): void {
  protocol.registerSchemesAsPrivileged([{ scheme: MEDIA_SCHEME, privileges: { standard: true, secure: true, stream: true } }]);
}

/** The handler and files:open-video, for app pages only, each window's tokens gone with it. */
export function installMedia(projectOf: (wcId: number) => string | null, isTrusted: (e: IpcMainInvokeEvent) => boolean, granted: (root: string) => Granted): void {
  const tokens = new MediaTokens();
  protocol.handle(MEDIA_SCHEME, (req) => mediaResponse(req, {
    tokens,
    reach: (root, p) => { const at = reachFile(root, p, granted(root)); return 'kind' in at ? null : at.f; },
    stat: (f) => { try { const st = statSync(f); return { size: st.size, isFile: st.isFile() }; } catch { return null; } },
    open: (f, start, end) => Readable.toWeb(createReadStream(f, { start, end })) as ReadableStream<Uint8Array>
  }));
  const watched = new Set<number>();
  ipcMain.handle(IPC.filesOpenVideo, (e, arg) => {
    const root = projectOf(e.sender.id);
    if (!root || !isTrusted(e)) throw new Error('unauthorized sender');
    const p = filesReadSchema.parse(arg);
    const id = e.sender.id;
    if (!watched.has(id)) {
      watched.add(id);
      e.sender.once('destroyed', () => { tokens.dropWindow(id); watched.delete(id); });
    }
    return openVideo(root, p, granted(root), (path, mime) => tokens.issue(id, root, path, mime));
  });
}
