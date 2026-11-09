// The connectors' transport in the app: Electron's net (main process only, system proxy settings), one request per hop.
// Redirects are not followed here: http.ts (requestText) checks every Location against the allowed origin first.
// Mirrors update-net.ts. Chosen at wiring time (Task 2); tests use a Node fetch transport against the fake ClickUp.
import { net, session, type Session } from 'electron';
import { eventChunks } from '../update-download';
import type { Transport } from './http';

/**
 * Requests go through their own in-memory session: the default one blocks every outside request (security.ts, no
 * network from the renderer), and this one lets through only the connector's origin (checked again per hop by
 * requestText) with no cookies, credentials or cache shared with anything else, and every permission denied. Each
 * connector passes its own partition: a session has one request filter, so two connectors sharing one would
 * overwrite each other's allowlist.
 */
export function electronTransport(allow: (u: URL) => boolean, userAgent: string, partition = 'atelier-connectors'): Transport {
  let ses: Session | null = null;
  const connectorSession = () => {
    if (ses) return ses;
    ses = session.fromPartition(partition, { cache: false });
    ses.webRequest.onBeforeRequest((d, cb) => { let ok = false; try { ok = allow(new URL(d.url)); } catch { ok = false; } cb({ cancel: !ok }); });
    ses.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
    ses.setPermissionCheckHandler(() => false);
    return ses;
  };
  return (r, signal) => new Promise((resolve, reject) => {
    const req = net.request({
      url: r.url, method: r.method, redirect: 'manual', credentials: 'omit', useSessionCookies: false, cache: 'no-store',
      session: connectorSession()
    });
    for (const [k, v] of Object.entries(r.headers ?? {})) req.setHeader(k, v);
    req.setHeader('User-Agent', userAgent);
    let settled = false;
    // Until the response arrives the signal aborts the request; after that the body reader listens (eventChunks).
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
      // Not followed (manual mode cancels it): requestText checks the origin and opens a new request.
      settle(() => resolve({ status, location, headers: {}, body: (async function* () { /* empty */ })(), close: () => req.abort() }));
    });
    req.on('response', (res) => {
      const headers: Record<string, string | undefined> = {};
      for (const [k, v] of Object.entries(res.headers)) headers[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : v;
      settle(() => resolve({ status: res.statusCode, location: null, headers, body: eventChunks(res, signal), close: () => req.abort() }));
    });
    req.on('error', () => settle(() => reject(new Error('network error'))));
    req.end(r.body);
  });
}
