// A connector Transport over Node's fetch, for vitest (the app uses Electron's net, src/main/connectors/net.ts). Like
// the app's, it never follows a redirect: requestText (src/main/connectors/http.ts) checks every hop itself.
import type { HttpResponse, Transport } from '../../src/main/connectors/http';

export function fetchTransport(onRequest?: (url: string) => void): Transport {
  return async (req, signal) => {
    onRequest?.(req.url);
    const res = await fetch(req.url, { method: req.method, headers: req.headers, body: req.body, redirect: 'manual', signal });
    const headers: Record<string, string | undefined> = {};
    res.headers.forEach((v, k) => { headers[k.toLowerCase()] = v; });
    const out: HttpResponse = {
      status: res.status,
      location: res.headers.get('location'),
      headers,
      body: res.body ?? (async function* () { /* empty */ })(),
      close: () => { void res.body?.cancel().catch(() => undefined); }
    };
    return out;
  };
}
