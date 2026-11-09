// The updater's transport in the app: Electron's net (main process only, system proxy settings), one request per hop.
// Redirects are not followed here: update-download.ts checks every Location against the allowed hosts first.
import { net, session, type Session } from 'electron';
import { eventChunks, requestHeaders, type Opener } from './update-download';

/**
 * Requests go through their own in-memory session: the default one blocks every outside request (security.ts, no
 * network from the renderer), and this one lets through only the updater's hosts (checked again per hop by
 * update-download.ts) with no cookies, credentials or cache shared with anything else.
 */
export function electronOpener(userAgent: string, allow: (u: URL) => boolean): Opener {
  let ses: Session | null = null;
  const updaterSession = () => {
    if (ses) return ses;
    ses = session.fromPartition('atelier-updates', { cache: false });
    ses.webRequest.onBeforeRequest((d, cb) => { let ok = false; try { ok = allow(new URL(d.url)); } catch { ok = false; } cb({ cancel: !ok }); });
    ses.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
    return ses;
  };
  return (url, signal) => new Promise((resolve, reject) => {
    // No cookies or credentials, no cache: every check sees the current release list.
    const req = net.request({ url, method: 'GET', redirect: 'manual', credentials: 'omit', useSessionCookies: false, cache: 'no-store', session: updaterSession() });
    for (const [k, v] of Object.entries(requestHeaders(url, userAgent))) req.setHeader(k, v);
    let settled = false;
    // Until the response arrives the signal aborts the request; after that the body reader listens (eventChunks) and
    // close() aborts it. The listener is removed either way: one hop, one controller (update-download.ts).
    const onAbort = () => { req.abort(); settle(() => reject(new Error('aborted'))); };
    const settle = (f: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      f();
    };
    if (signal.aborted) { onAbort(); return; }
    signal.addEventListener('abort', onAbort, { once: true });
    req.on('redirect', (status, _method, location) => {
      // Not followed (manual mode cancels it): the caller checks the host and opens a new request.
      settle(() => resolve({ status, location, headers: {}, body: (async function* () { /* empty */ })(), close: () => req.abort() }));
    });
    req.on('response', (res) => {
      const headers: Record<string, string | undefined> = {};
      for (const [k, v] of Object.entries(res.headers)) headers[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : v;
      settle(() => resolve({ status: res.statusCode, location: null, headers, body: eventChunks(res, signal), close: () => req.abort() }));
    });
    req.on('error', (e: Error) => settle(() => reject(e)));
    req.end();
  });
}

/** Whether macOS reports a network (Source Control's periodic fetches skip their turn offline). No request. */
export function isOnline(): boolean {
  return net.isOnline();
}
