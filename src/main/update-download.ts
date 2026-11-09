// HTTP GET for the updater, over any transport (Electron's net in the app, node:http in tests): redirects followed by
// hand so that every hop is checked against the allowed hosts, size caps (declared and streamed), an idle and a total
// timeout, progress. It never writes: the caller gets the bytes (auto-update.ts decides where they go).

export interface RawResponse {
  status: number;
  /** Location of a redirect (3xx), as sent. */
  location: string | null;
  headers: Record<string, string | undefined>;
  body: AsyncIterable<Uint8Array>;
  close(): void;
}
/** Opens one request without following redirects; aborting the signal ends the body. */
export type Opener = (url: string, signal: AbortSignal) => Promise<RawResponse>;

export type DownloadErrorKind = 'network' | 'http' | 'rate-limited' | 'too-large' | 'host' | 'timeout';

export class DownloadError extends Error {
  constructor(readonly kind: DownloadErrorKind, message: string, readonly status?: number) { super(message); }
}

export interface GetOptions {
  allow(url: URL): boolean;
  maxBytes: number;
  /** No data for this long: give up. */
  idleMs: number;
  /** The whole request, redirects included. */
  totalMs: number;
  maxRedirects?: number;
  onData(chunk: Buffer): void;
  onProgress?(received: number, total: number | null): void;
}

/**
 * The updater asks useatelier.dev, which redirects the files to where they are
 * stored: today GitHub Releases, i.e. github.com downloads and its release CDN.
 */
export const UPDATE_HOSTS = new Set(['useatelier.dev', 'github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com']);

export function updateAllow(u: URL): boolean {
  return u.protocol === 'https:' && UPDATE_HOSTS.has(u.hostname) && u.port === '' && u.username === '' && u.password === '';
}

/**
 * Headers of every updater request. `Accept-Encoding: identity`: the sizes we check (Content-Length, the signed ZIP
 * size) are those of the stored bytes; a compressed answer anyway is handled by httpGet (decoded by the transport).
 */
export function requestHeaders(url: string, userAgent: string): Record<string, string> {
  let list = false;
  try { list = new URL(url).pathname === '/updates/releases'; } catch { /* checked by the caller */ }
  return { 'User-Agent': userAgent, Accept: list ? 'application/json' : '*/*', 'Accept-Encoding': 'identity' };
}

/** What a transport's response emits (Electron's IncomingMessage). */
export interface BodyEmitter {
  on(event: 'data', listener: (chunk: Buffer) => void): unknown;
  on(event: 'end' | 'aborted', listener: () => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
  removeListener(event: 'data', listener: (chunk: Buffer) => void): unknown;
  removeListener(event: 'end' | 'aborted', listener: () => void): unknown;
  removeListener(event: 'error', listener: (error: Error) => void): unknown;
}

/** The body as chunks; every listener (response and signal) is removed once it ends, fails or the reader stops. */
export async function* eventChunks(res: BodyEmitter, signal: AbortSignal): AsyncGenerator<Uint8Array> {
  const queue: Buffer[] = [];
  let done = false;
  let error: Error | null = null;
  let wake: (() => void) | null = null;
  const notify = () => { const w = wake; wake = null; w?.(); };
  const onData = (c: Buffer) => { queue.push(c); notify(); };
  const onEnd = () => { done = true; notify(); };
  const onError = (e: Error) => { error = e; notify(); };
  const onAborted = () => { error = new Error('aborted'); notify(); };
  res.on('data', onData);
  res.on('end', onEnd);
  res.on('error', onError);
  res.on('aborted', onAborted);
  signal.addEventListener('abort', onAborted, { once: true });
  try {
    if (signal.aborted) onAborted();
    for (;;) {
      const next = queue.shift();
      if (next) { yield next; continue; }
      if (error) throw error;
      if (done) return;
      await new Promise<void>((r) => { wake = r; });
    }
  } finally {
    res.removeListener('data', onData);
    res.removeListener('end', onEnd);
    res.removeListener('error', onError);
    res.removeListener('aborted', onAborted);
    signal.removeEventListener('abort', onAborted);
  }
}

const REDIRECT = new Set([301, 302, 303, 307, 308]);

export async function httpGet(open: Opener, url: string, o: GetOptions): Promise<{ bytes: number }> {
  // One controller per hop: a finished hop (a redirect) is aborted at once; timeouts abort the current one.
  let ctl = new AbortController();
  let timedOut = false;
  const fire = () => { timedOut = true; ctl.abort(); };
  const total = setTimeout(fire, o.totalMs);
  let idle = setTimeout(fire, o.idleMs);
  const touch = () => { clearTimeout(idle); idle = setTimeout(fire, o.idleMs); };
  try {
    let current = url;
    for (let hop = 0; ; hop++) {
      if (hop > 0) { ctl.abort(); ctl = new AbortController(); }
      let u: URL;
      try { u = new URL(current); } catch { throw new DownloadError('host', 'invalid URL'); }
      if (!o.allow(u)) throw new DownloadError('host', `host not allowed: ${u.protocol}//${u.host}`);
      let res: RawResponse;
      try { res = await open(u.href, ctl.signal); } catch (err) {
        if (timedOut) throw new DownloadError('timeout', 'timed out');
        throw new DownloadError('network', err instanceof Error ? err.message : String(err));
      }
      touch();
      if (REDIRECT.has(res.status)) {
        res.close();
        if (!res.location) throw new DownloadError('http', `redirect without a location (${res.status})`, res.status);
        if (hop >= (o.maxRedirects ?? 5)) throw new DownloadError('http', 'too many redirects', res.status);
        current = new URL(res.location, u).href;
        continue;
      }
      if (res.status === 429 || (res.status === 403 && res.headers['x-ratelimit-remaining'] === '0')) {
        res.close();
        throw new DownloadError('rate-limited', 'update server rate limit reached', res.status);
      }
      if (res.status < 200 || res.status > 299) { res.close(); throw new DownloadError('http', `HTTP ${res.status}`, res.status); }
      // A content-encoding (despite Accept-Encoding: identity) means the transport decodes the body: Content-Length is
      // the compressed size, neither a cap nor the expected count. The streamed cap below still holds, and the caller
      // checks the signed size and sha512.
      const encoding = (res.headers['content-encoding'] ?? '').trim().toLowerCase();
      const encoded = encoding !== '' && encoding !== 'identity';
      const declared = Number(res.headers['content-length']);
      const totalBytes = !encoded && Number.isFinite(declared) && declared >= 0 && res.headers['content-length'] !== undefined ? declared : null;
      if (totalBytes !== null && totalBytes > o.maxBytes) { res.close(); throw new DownloadError('too-large', `${totalBytes} bytes over the ${o.maxBytes} cap`); }
      let received = 0;
      try {
        for await (const chunk of res.body) {
          touch();
          received += chunk.byteLength;
          if (received > o.maxBytes) throw new DownloadError('too-large', `over the ${o.maxBytes} byte cap`);
          o.onData(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength));
          o.onProgress?.(received, totalBytes);
        }
      } catch (err) {
        res.close();
        if (err instanceof DownloadError) throw err;
        if (timedOut) throw new DownloadError('timeout', 'timed out');
        throw new DownloadError('network', err instanceof Error ? err.message : String(err));
      }
      if (totalBytes !== null && received !== totalBytes) throw new DownloadError('network', `incomplete body: ${received} of ${totalBytes} bytes`);
      return { bytes: received };
    }
  } finally {
    clearTimeout(total);
    clearTimeout(idle);
    if (!ctl.signal.aborted) ctl.abort();
  }
}

export async function httpGetBuffer(open: Opener, url: string, o: Omit<GetOptions, 'onData'>): Promise<Buffer> {
  const parts: Buffer[] = [];
  await httpGet(open, url, { ...o, onData: (c) => parts.push(Buffer.from(c)) });
  return Buffer.concat(parts);
}
