// Videos in a tab. <video> needs range requests and a file can be gigabytes, so its
// bytes never travel as a data: URL: main issues an unguessable token for a file the window may read (inside its
// project, or granted), and the privileged atelier-media: scheme streams that file — read-only, one range at a time —
// checking at every request that the path still reaches a file the project may read. The pure parts are here; index.ts
// registers the scheme and hands the handler its file system.
import { randomBytes } from 'node:crypto';
import { statSync } from 'node:fs';
import { videoMime, type VideoContent } from '@shared/files';
import { reachFile, type Granted } from './fs/files';

export const MEDIA_SCHEME = 'atelier-media';
const HOST = 'v';
const TOKEN = /^[0-9a-f]{64}$/;

/** What a token opens: the path as the window asked for it (reached again at every request) and its project. */
export interface MediaEntry { wcId: number; root: string; path: string; mime: string }

/** The tokens main issued, per window: one per path, at most `max` (the oldest goes), all gone with the window. */
export class MediaTokens {
  private readonly byToken = new Map<string, MediaEntry>();
  constructor(private readonly max = 64, private readonly random: () => string = () => randomBytes(32).toString('hex')) {}

  issue(wcId: number, root: string, path: string, mime: string): string {
    for (const [t, e] of this.byToken) if (e.wcId === wcId && e.path === path) this.byToken.delete(t);
    const mine = [...this.byToken].filter(([, e]) => e.wcId === wcId);
    if (mine.length >= this.max) this.byToken.delete(mine[0]![0]);
    const token = this.random();
    this.byToken.set(token, { wcId, root, path, mime });
    return token;
  }

  get(token: string): MediaEntry | null {
    return this.byToken.get(token) ?? null;
  }

  dropWindow(wcId: number): void {
    for (const [t, e] of this.byToken) if (e.wcId === wcId) this.byToken.delete(t);
  }
}

export const mediaUrl = (token: string): string => `${MEDIA_SCHEME}://${HOST}/${token}`;

/** The token a request names, or null for anything else (another host, a longer path, not 64 hex characters). */
export function tokenOf(url: string): string | null {
  let u: URL;
  try { u = new URL(url); } catch { return null; }
  if (u.protocol !== `${MEDIA_SCHEME}:` || u.host !== HOST || u.search || u.hash) return null;
  const token = u.pathname.slice(1);
  return TOKEN.test(token) ? token : null;
}

export type ByteRange = { kind: 'full' } | { kind: 'part'; start: number; end: number } | { kind: 'bad' };

/**
 * One `bytes=` range of a file of `size` bytes: a range it can't parse, or several ranges, is ignored
 * (the whole file, 200); one past the end, a zero suffix or any range of an empty file can't be satisfied (416).
 */
export function parseRange(header: string | null, size: number): ByteRange {
  const m = header ? /^bytes=(\d*)-(\d*)$/.exec(header) : null;
  if (!m || (m[1] === '' && m[2] === '')) return { kind: 'full' };
  if (m[1] === '') {
    const n = Number(m[2]);
    if (n === 0 || size === 0) return { kind: 'bad' };
    return { kind: 'part', start: Math.max(0, size - n), end: size - 1 };
  }
  const start = Number(m[1]);
  const end = m[2] === '' ? null : Number(m[2]);
  if (end !== null && end < start) return { kind: 'full' };
  if (start >= size) return { kind: 'bad' };
  return { kind: 'part', start, end: Math.min(end ?? size - 1, size - 1) };
}

/** What the handler reads with: reach (null: no longer a file the project may read), stat, a byte range as a stream. */
export interface MediaDeps {
  tokens: MediaTokens;
  reach: (root: string, path: string) => string | null;
  stat: (f: string) => { size: number; isFile: boolean } | null;
  open: (f: string, start: number, end: number) => ReadableStream<Uint8Array>;
}

/** One atelier-media: request: GET or HEAD of a token's file, whole or one range; never a write, never another file. */
export function mediaResponse(req: { method: string; url: string; headers: Headers }, deps: MediaDeps): Response {
  if (req.method !== 'GET' && req.method !== 'HEAD') return new Response(null, { status: 405, headers: { Allow: 'GET, HEAD' } });
  const token = tokenOf(req.url);
  const entry = token ? deps.tokens.get(token) : null;
  const f = entry ? deps.reach(entry.root, entry.path) : null;
  const st = f ? deps.stat(f) : null;
  if (!entry || !f || !st?.isFile) return new Response(null, { status: 404 });
  const headers: Record<string, string> = {
    'Content-Type': entry.mime, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff'
  };
  const range = parseRange(req.headers.get('range'), st.size);
  if (range.kind === 'bad') return new Response(null, { status: 416, headers: { ...headers, 'Content-Range': `bytes */${st.size}` } });
  const [start, end, status] = range.kind === 'part' ? [range.start, range.end, 206] : [0, st.size - 1, 200];
  const length = st.size === 0 ? 0 : end - start + 1;
  const body = req.method === 'GET' && length > 0 ? deps.open(f, start, end) : null;
  return new Response(body, {
    status,
    headers: { ...headers, 'Content-Length': String(length), ...(range.kind === 'part' ? { 'Content-Range': `bytes ${start}-${end}/${st.size}` } : {}) }
  });
}

/**
 * A video for its tab: only files whose extension is a video type, inside the root or granted; `issue` hands out the
 * token (for the path as asked, so every request reaches it again) only once it is one.
 */
export function openVideo(root: string, p: string, granted: Granted, issue: (path: string, mime: string) => string): VideoContent {
  const at = reachFile(root, p, granted);
  if ('kind' in at) return at;
  const { f, rel, ext } = at;
  const mime = videoMime(f);
  try {
    const st = statSync(f);
    if (!st.isFile()) return { kind: 'missing', path: f, rel, ...ext };
    if (!mime) return { kind: 'unreadable', path: f, rel, ...ext };
    return { kind: 'video', path: f, rel, mime, url: mediaUrl(issue(p, mime)), size: st.size, mtimeMs: st.mtimeMs, ...ext };
  } catch {
    return { kind: 'unreadable', path: f, rel, ...ext };
  }
}
