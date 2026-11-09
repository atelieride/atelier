import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { describe, expect, test } from 'vitest';
import { join, toOut } from './cpath';
import { MediaTokens, mediaResponse, mediaUrl, openVideo, parseRange, tokenOf, type MediaDeps } from './media-protocol';
import { useMachinePlatform } from '../../tests/support/platform';

// Videos reach the page through atelier-media: tokens: read-only, ranges for <video>.

useMachinePlatform();

describe('parseRange', () => {
  test('no header, garbage, two ranges: the whole file', () => {
    expect(parseRange(null, 1000)).toEqual({ kind: 'full' });
    expect(parseRange('', 1000)).toEqual({ kind: 'full' });
    expect(parseRange('lines=0-9', 1000)).toEqual({ kind: 'full' });
    expect(parseRange('bytes=x-y', 1000)).toEqual({ kind: 'full' });
    expect(parseRange('bytes=0-1,4-5', 1000)).toEqual({ kind: 'full' });
    expect(parseRange('bytes=-', 1000)).toEqual({ kind: 'full' });
    expect(parseRange('bytes=9-5', 1000)).toEqual({ kind: 'full' });
  });
  test('one range: from-to (capped at the end), from, a suffix (whole file when longer)', () => {
    expect(parseRange('bytes=0-99', 1000)).toEqual({ kind: 'part', start: 0, end: 99 });
    expect(parseRange('bytes=900-5000', 1000)).toEqual({ kind: 'part', start: 900, end: 999 });
    expect(parseRange('bytes=100-', 1000)).toEqual({ kind: 'part', start: 100, end: 999 });
    expect(parseRange('bytes=-50', 1000)).toEqual({ kind: 'part', start: 950, end: 999 });
    expect(parseRange('bytes=-5000', 1000)).toEqual({ kind: 'part', start: 0, end: 999 });
    expect(parseRange(' bytes = 0 - 9 ', 1000)).toEqual({ kind: 'full' });
  });
  test('past the end, a zero suffix, any range of an empty file: not satisfiable', () => {
    expect(parseRange('bytes=1000-', 1000)).toEqual({ kind: 'bad' });
    expect(parseRange('bytes=1000-1001', 1000)).toEqual({ kind: 'bad' });
    expect(parseRange('bytes=-0', 1000)).toEqual({ kind: 'bad' });
    expect(parseRange('bytes=0-', 0)).toEqual({ kind: 'bad' });
    expect(parseRange('bytes=-10', 0)).toEqual({ kind: 'bad' });
  });
});

describe('MediaTokens', () => {
  let n = 0;
  const seq = () => (n++).toString(16).padStart(64, '0');
  test('a token is 64 hex characters; the URL carries only it, whatever the file is called', () => {
    const t = new MediaTokens();
    const token = t.issue(1, '/p', '/p/reel #1 è?.mp4', 'video/mp4');
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(mediaUrl(token)).toBe(`atelier-media://v/${token}`);
    expect(tokenOf(mediaUrl(token))).toBe(token);
    expect(tokenOf(`atelier-media://x/${token}`)).toBeNull();
    expect(tokenOf('atelier-media://v/../etc')).toBeNull();
    expect(tokenOf(`atelier-media://v/${token}/more`)).toBeNull();
    expect(t.get(token)).toEqual({ wcId: 1, root: '/p', path: '/p/reel #1 è?.mp4', mime: 'video/mp4' });
  });
  test('the same path in the same window replaces its token; another window keeps its own', () => {
    const t = new MediaTokens(64, seq);
    const a = t.issue(1, '/p', '/p/a.mp4', 'video/mp4');
    const b = t.issue(2, '/p', '/p/a.mp4', 'video/mp4');
    const a2 = t.issue(1, '/p', '/p/a.mp4', 'video/mp4');
    expect(t.get(a)).toBeNull();
    expect(t.get(a2)).not.toBeNull();
    expect(t.get(b)).not.toBeNull();
  });
  test('64 per window, the oldest dropped; dropWindow clears only that window', () => {
    const t = new MediaTokens(64, seq);
    const first = t.issue(1, '/p', '/p/0.mp4', 'video/mp4');
    const second = t.issue(1, '/p', '/p/1.mp4', 'video/mp4');
    for (let i = 2; i < 64; i++) t.issue(1, '/p', `/p/${i}.mp4`, 'video/mp4');
    const other = t.issue(2, '/p', '/p/x.mp4', 'video/mp4');
    expect(t.get(first)).not.toBeNull();
    t.issue(1, '/p', '/p/64.mp4', 'video/mp4');
    expect(t.get(first)).toBeNull();
    expect(t.get(second)).not.toBeNull();
    t.dropWindow(1);
    expect(t.get(second)).toBeNull();
    expect(t.get(other)).not.toBeNull();
  });
});

describe('mediaResponse', () => {
  const BYTES = new Uint8Array(Array.from({ length: 1000 }, (_, i) => i % 256));
  const setup = (o: { reach?: string | null; file?: boolean } = {}) => {
    const tokens = new MediaTokens();
    const token = tokens.issue(1, '/p', '/p/reel.mp4', 'video/mp4');
    const opened: [number, number][] = [];
    const deps: MediaDeps = {
      tokens,
      reach: () => (o.reach === undefined ? '/real/reel.mp4' : o.reach),
      stat: () => ({ size: BYTES.length, isFile: o.file ?? true }),
      open: (_f, start, end) => { opened.push([start, end]); return new Response(BYTES.slice(start, end + 1)).body!; }
    };
    const req = (method = 'GET', range?: string, url = mediaUrl(token)) => mediaResponse({ method, url, headers: new Headers(range ? { range } : {}) }, deps);
    return { req, opened, token };
  };

  test('the whole file: 200, its type, length, ranges accepted, never cached', async () => {
    const { req, opened } = setup();
    const r = await req();
    expect(r.status).toBe(200);
    expect(Object.fromEntries(r.headers)).toMatchObject({ 'content-type': 'video/mp4', 'content-length': '1000', 'accept-ranges': 'bytes', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
    expect(new Uint8Array(await r.arrayBuffer())).toEqual(BYTES);
    expect(opened).toEqual([[0, 999]]);
  });
  test('a range: 206 with Content-Range, only those bytes read', async () => {
    const { req, opened } = setup();
    const r = await req('GET', 'bytes=10-19');
    expect(r.status).toBe(206);
    expect(r.headers.get('content-range')).toBe('bytes 10-19/1000');
    expect(r.headers.get('content-length')).toBe('10');
    expect([...new Uint8Array(await r.arrayBuffer())]).toEqual([10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);
    expect(opened).toEqual([[10, 19]]);
  });
  test('past the end: 416 with the size, nothing read', async () => {
    const { req, opened } = setup();
    const r = await req('GET', 'bytes=5000-');
    expect(r.status).toBe(416);
    expect(r.headers.get('content-range')).toBe('bytes */1000');
    expect(opened).toEqual([]);
  });
  test('HEAD: the headers, no body read', async () => {
    const { req, opened } = setup();
    const r = await req('HEAD');
    expect(r.status).toBe(200);
    expect(r.headers.get('content-length')).toBe('1000');
    expect(await r.text()).toBe('');
    expect(opened).toEqual([]);
  });
  test('anything but GET or HEAD: 405', async () => {
    const { req } = setup();
    for (const m of ['POST', 'PUT', 'DELETE']) expect((await req(m)).status).toBe(405);
  });
  test('an unknown token, another host, a file no longer reachable or not a file: 404', async () => {
    expect((await setup().req('GET', undefined, mediaUrl('f'.repeat(64)))).status).toBe(404);
    expect((await setup().req('GET', undefined, 'atelier-media://x/abc')).status).toBe(404);
    expect((await setup({ reach: null }).req()).status).toBe(404);
    expect((await setup({ file: false }).req()).status).toBe(404);
  });
});

describe('openVideo', () => {
  const fixture = () => {
    const root = toOut(realpathSync(mkdtempSync(join(tmpdir(), 'atl-media-'))));
    const outside = toOut(realpathSync(mkdtempSync(join(tmpdir(), 'atl-media-out-'))));
    mkdirSync(join(root, 'media'));
    writeFileSync(join(root, 'media', 'reel #1.mp4'), Buffer.alloc(2048, 1));
    writeFileSync(join(root, 'notes.txt'), 'x');
    writeFileSync(join(outside, 'clip.mov'), Buffer.alloc(10, 1));
    symlinkSync(join(outside, 'clip.mov'), join(root, 'escape.mov'));
    const issued: [string, string][] = [];
    const issue = (path: string, mime: string) => { issued.push([path, mime]); return 'a'.repeat(64); };
    return { root, outside, issued, issue };
  };
  const none = () => null;

  test('a project video: its token URL, type, size; the requested path is what the token keeps', () => {
    const { root, issued, issue } = fixture();
    const p = join(root, 'media', 'reel #1.mp4');
    expect(openVideo(root, p, none, issue)).toMatchObject({ kind: 'video', path: p, rel: 'media/reel #1.mp4', mime: 'video/mp4', url: mediaUrl('a'.repeat(64)), size: 2048 });
    expect(issued).toEqual([[p, 'video/mp4']]);
  });
  test('outside the project: granted plays (external), not granted is refused with no token', () => {
    const { root, outside, issued, issue } = fixture();
    const f = join(outside, 'clip.mov');
    expect(openVideo(root, f, none, issue)).toMatchObject({ kind: 'outside' });
    expect(openVideo(root, join(root, 'escape.mov'), none, issue)).toMatchObject({ kind: 'outside' });
    expect(issued).toEqual([]);
    expect(openVideo(root, f, (x) => (x === f ? f : null), issue)).toMatchObject({ kind: 'video', mime: 'video/quicktime', external: true });
  });
  test('not a video, missing: no token', () => {
    const { root, issued, issue } = fixture();
    expect(openVideo(root, join(root, 'notes.txt'), none, issue)).toMatchObject({ kind: 'unreadable' });
    expect(openVideo(root, join(root, 'gone.mp4'), none, issue)).toMatchObject({ kind: 'missing' });
    expect(issued).toEqual([]);
  });
});
