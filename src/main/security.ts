import type { Session, WebContents, WebPreferences } from 'electron';
import { devEnv } from './dev-env';

export function secureWebPreferences(preload: string): WebPreferences {
  return {
    preload,
    contextIsolation: true,
    sandbox: true,
    nodeIntegration: false,
    nodeIntegrationInWorker: false,
    nodeIntegrationInSubFrames: false,
    webSecurity: true,
    allowRunningInsecureContent: false,
    webviewTag: false,
    navigateOnDragDrop: false,
    spellcheck: false
  };
}

/** No navigation away from the app, no new windows, no webviews. */
export function hardenWebContents(wc: WebContents, allowedUrl: (url: string) => boolean): void {
  wc.on('will-navigate', (e, url) => { if (!allowedUrl(url)) e.preventDefault(); });
  wc.on('will-redirect', (e, url) => { if (!allowedUrl(url)) e.preventDefault(); });
  wc.on('will-attach-webview', (e) => e.preventDefault());
  wc.setWindowOpenHandler(() => ({ action: 'deny' }));
}

/** Allowed network requests: app files always; the local Vite server in development only; nothing else. */
export function allowedRequest(url: string, dev: boolean): boolean {
  if (url.startsWith('file://') || url.startsWith('devtools://') || url.startsWith('data:')) return true;
  // Videos, streamed by main through its tokens (media-protocol.ts).
  if (url.startsWith('atelier-media://v/')) return true;
  return dev && /^(http|ws):\/\/localhost(:\d+)?\//.test(url);
}

/** Permission requested by a page: microphone only (never the camera), from app pages, with dictation enabled. */
export function mediaRequestAllowed(permission: string, mediaTypes: readonly string[] | undefined, url: string, isApp: (u: string) => boolean, enabled: boolean): boolean {
  return enabled && permission === 'media' && !!mediaTypes && mediaTypes.length > 0 && mediaTypes.every((m) => m === 'audio') && isApp(url);
}

/** Permission check (same rules, one type at a time). */
export function mediaCheckAllowed(permission: string, mediaType: string | undefined, url: string, isApp: (u: string) => boolean, enabled: boolean): boolean {
  return enabled && permission === 'media' && mediaType === 'audio' && isApp(url);
}

/** The installed fonts' names (Local Font Access), for the terminal font pickers: app pages only. */
export function localFontsAllowed(permission: string, url: string, isApp: (u: string) => boolean): boolean {
  return permission === 'local-fonts' && isApp(url);
}

/** All permissions denied, except the microphone for dictation and the installed fonts' names (see above). */
export function hardenSession(s: Session, media: { isApp: (u: string) => boolean; enabled: () => boolean } = { isApp: () => false, enabled: () => false }): void {
  s.setPermissionRequestHandler((_wc, perm, cb, details) => {
    const d = details as { mediaTypes?: string[]; requestingUrl?: string };
    const url = d.requestingUrl ?? '';
    cb(localFontsAllowed(perm, url, media.isApp) || mediaRequestAllowed(perm, d.mediaTypes, url, media.isApp, media.enabled()));
  });
  s.setPermissionCheckHandler((_wc, perm, _origin, details) => {
    const d = details as { mediaType?: string; requestingUrl?: string };
    const url = d.requestingUrl ?? '';
    return localFontsAllowed(perm, url, media.isApp) || mediaCheckAllowed(perm, d.mediaType, url, media.isApp, media.enabled());
  });
  // No network requests to the outside: only app files and, in development, the local Vite server.
  const dev = !!devEnv('ELECTRON_RENDERER_URL');
  s.webRequest.onBeforeRequest((details, cb) => cb({ cancel: !allowedRequest(details.url, dev) }));
}
