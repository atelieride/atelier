// HTTP for connectors over any transport (Electron's net in the app, net.ts; Node's fetch in tests): one allowed
// origin checked before every hop, redirects followed by hand (so every Location is checked before it is opened), one
// deadline for the whole call, a size cap on the reply (declared and streamed), the caller's signal. Errors are the
// typed ones in errors.ts and never carry the transport's own message (it could quote the request).
import { Aborted, HostNotAllowed, TooLarge, Unreachable } from './errors';

export interface HttpRequest {
  method: 'GET' | 'POST';
  url: string;
  headers?: Record<string, string>;
  body?: string;
}

/** One hop's response: a 3xx is returned as is (with `location`), never followed by the transport. */
export interface HttpResponse {
  status: number;
  /** Lowercase names. */
  headers: Record<string, string | undefined>;
  location: string | null;
  body: AsyncIterable<Uint8Array>;
  close(): void;
}

/** Opens one request without following redirects; aborting the signal ends it (and its body). */
export type Transport = (req: HttpRequest, signal: AbortSignal) => Promise<HttpResponse>;

export interface RequestOptions {
  allow(url: URL): boolean;
  /** The whole call, redirects and body included. */
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  signal?: AbortSignal;
}

export interface TextResponse {
  status: number;
  headers: Record<string, string | undefined>;
  text: string;
  /** The URL that answered (after same-origin redirects). */
  url: string;
}

export const DEFAULT_TIMEOUT_MS = 20_000;
export const MAX_REPLY_BYTES = 4 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const REDIRECT = new Set([301, 302, 303, 307, 308]);

/**
 * Exactly one origin: same scheme, host and port as `base`, no credentials in the URL. `base` must be https, or
 * http://127.0.0.1:<port> when `loopbackHttp` is set (the local fake ClickUp in tests, ATELIER_TEST_CLICKUP_URL).
 */
export function originAllow(base: string, o: { loopbackHttp?: boolean } = {}): (u: URL) => boolean {
  let b: URL;
  try { b = new URL(base); } catch { throw new TypeError('invalid connector base URL'); }
  const ok = b.protocol === 'https:' || (o.loopbackHttp === true && b.protocol === 'http:' && b.hostname === '127.0.0.1');
  if (!ok || b.username !== '' || b.password !== '') throw new TypeError('connector base URL must be https (or http://127.0.0.1 in tests)');
  const protocol = b.protocol;
  const host = b.host;
  return (u: URL) => u.protocol === protocol && u.host === host && u.username === '' && u.password === '';
}

function checked(url: string, allow: (u: URL) => boolean, base?: URL): URL {
  let u: URL;
  try { u = base ? new URL(url, base) : new URL(url); } catch { throw new HostNotAllowed('(invalid URL)'); }
  let ok = false;
  try { ok = allow(u); } catch { ok = false; }
  if (!ok) throw new HostNotAllowed(`${u.protocol}//${u.host}`);
  return u;
}

export async function requestText(transport: Transport, req: HttpRequest, o: RequestOptions): Promise<TextResponse> {
  const maxBytes = o.maxBytes ?? MAX_REPLY_BYTES;
  const maxRedirects = o.maxRedirects ?? MAX_REDIRECTS;
  if (o.signal?.aborted) throw new Aborted();
  let url = checked(req.url, o.allow);
  // One controller per hop; the deadline and the caller's signal abort the current one.
  let ctl = new AbortController();
  let timedOut = false;
  let aborted = false;
  const timer = setTimeout(() => { timedOut = true; ctl.abort(); }, o.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const onAbort = () => { aborted = true; ctl.abort(); };
  o.signal?.addEventListener('abort', onAbort, { once: true });
  const failure = (): Error => (aborted ? new Aborted() : timedOut ? new Unreachable('timeout') : new Unreachable('network'));
  let current: HttpRequest = { ...req, url: url.href, headers: { ...req.headers } };
  const origin = url.origin;
  try {
    for (let hop = 0; ; hop++) {
      if (hop > 0) { ctl.abort(); ctl = new AbortController(); if (aborted || timedOut) throw failure(); }
      let res: HttpResponse;
      try { res = await transport(current, ctl.signal); } catch { throw failure(); }
      if (REDIRECT.has(res.status) && res.location) {
        res.close();
        if (hop >= maxRedirects) throw new Unreachable('server', res.status);
        url = checked(res.location, o.allow, url);
        const toGet = res.status === 303 || ((res.status === 301 || res.status === 302) && current.method === 'POST');
        const headers = { ...current.headers };
        if (toGet) for (const k of Object.keys(headers)) if (k.toLowerCase() === 'content-type') delete headers[k];
        // Never carry credentials to another origin (the allowlist already refuses one; this holds if it ever widens).
        if (url.origin !== origin) for (const k of Object.keys(headers)) if (k.toLowerCase() === 'authorization') delete headers[k];
        current = toGet ? { method: 'GET', url: url.href, headers } : { ...current, url: url.href, headers };
        continue;
      }
      const declared = Number(res.headers['content-length']);
      if (res.headers['content-length'] !== undefined && Number.isFinite(declared) && declared > maxBytes) {
        res.close();
        throw new TooLarge(maxBytes);
      }
      const parts: Uint8Array[] = [];
      let received = 0;
      try {
        for await (const chunk of res.body) {
          received += chunk.byteLength;
          if (received > maxBytes) throw new TooLarge(maxBytes);
          parts.push(chunk);
        }
      } catch (e) {
        res.close();
        if (e instanceof TooLarge) throw e;
        throw failure();
      }
      const text = Buffer.concat(parts).toString('utf8');
      return { status: res.status, headers: res.headers, text, url: url.href };
    }
  } finally {
    clearTimeout(timer);
    o.signal?.removeEventListener('abort', onAbort);
    if (!ctl.signal.aborted) ctl.abort();
  }
}
