import { EventEmitter, getEventListeners } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomBytes } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { expect, test } from 'vitest';
import { nodeOpener } from '../../tests/fixtures/update-fixture';
import { DownloadError, eventChunks, updateAllow, httpGet, httpGetBuffer, requestHeaders, type Opener, type RawResponse } from './update-download';

type Route = { status: number; location?: string; headers?: Record<string, string>; chunks?: string[]; hang?: boolean };

function opener(routes: Record<string, Route>, seen: string[] = []): Opener {
  return async (url, signal) => {
    seen.push(url);
    const r = routes[url];
    if (!r) throw new Error(`no route ${url}`);
    const body: AsyncIterable<Uint8Array> = {
      async *[Symbol.asyncIterator]() {
        for (const c of r.chunks ?? []) yield Buffer.from(c);
        if (r.hang) await new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted'))));
      }
    };
    const res: RawResponse = { status: r.status, location: r.location ?? null, headers: r.headers ?? {}, body, close: () => {} };
    return res;
  };
}

const allowAll = () => true;
const base = { allow: allowAll, maxBytes: 1000, idleMs: 1000, totalMs: 5000 };

test('useatelier.dev and the GitHub download hosts only, over HTTPS, without credentials or odd ports', () => {
  expect(updateAllow(new URL('https://useatelier.dev/updates/releases'))).toBe(true);
  expect(updateAllow(new URL('https://github.com/atelieride/atelier/releases/download/v0.2.0/latest-mac.yml'))).toBe(true);
  expect(updateAllow(new URL('https://objects.githubusercontent.com/x'))).toBe(true);
  expect(updateAllow(new URL('https://release-assets.githubusercontent.com/x'))).toBe(true);
  // The API is the endpoint's business now, never the app's.
  expect(updateAllow(new URL('https://api.github.com/repos/atelieride/atelier/releases'))).toBe(false);
  expect(updateAllow(new URL('http://useatelier.dev/updates/releases'))).toBe(false);
  expect(updateAllow(new URL('https://www.useatelier.dev/x'))).toBe(false);
  expect(updateAllow(new URL('https://useatelier.dev.evil.com/x'))).toBe(false);
  expect(updateAllow(new URL('https://evil-useatelier.dev/x'))).toBe(false);
  expect(updateAllow(new URL('http://github.com/x'))).toBe(false);
  expect(updateAllow(new URL('https://github.com.evil.com/x'))).toBe(false);
  expect(updateAllow(new URL('https://evilgithub.com/x'))).toBe(false);
  expect(updateAllow(new URL('https://user:pw@github.com/x'))).toBe(false);
  expect(updateAllow(new URL('https://useatelier.dev:8443/x'))).toBe(false);
});

test('redirects are followed only to allowed hosts, each hop checked', async () => {
  const seen: string[] = [];
  const open = opener({
    'https://github.com/a': { status: 302, location: 'https://objects.githubusercontent.com/b?sig=1' },
    'https://objects.githubusercontent.com/b?sig=1': { status: 200, chunks: ['hel', 'lo'] }
  }, seen);
  expect((await httpGetBuffer(open, 'https://github.com/a', { ...base, allow: updateAllow })).toString()).toBe('hello');
  expect(seen).toEqual(['https://github.com/a', 'https://objects.githubusercontent.com/b?sig=1']);

  // The production chain: useatelier.dev → github.com → the release CDN.
  const chain: string[] = [];
  const prod = opener({
    'https://useatelier.dev/updates/download/v1.0.0/Atelier-1.0.0-arm64.zip': { status: 302, location: 'https://github.com/atelieride/atelier/releases/download/v1.0.0/Atelier-1.0.0-arm64.zip' },
    'https://github.com/atelieride/atelier/releases/download/v1.0.0/Atelier-1.0.0-arm64.zip': { status: 302, location: 'https://release-assets.githubusercontent.com/z?sig=2' },
    'https://release-assets.githubusercontent.com/z?sig=2': { status: 200, chunks: ['zip'] }
  }, chain);
  expect((await httpGetBuffer(prod, 'https://useatelier.dev/updates/download/v1.0.0/Atelier-1.0.0-arm64.zip', { ...base, allow: updateAllow })).toString()).toBe('zip');
  expect(chain).toHaveLength(3);

  const evil = opener({ 'https://github.com/a': { status: 302, location: 'https://evil.example/b' } });
  await expect(httpGetBuffer(evil, 'https://github.com/a', { ...base, allow: updateAllow })).rejects.toMatchObject({ kind: 'host' });
  // The first URL too.
  await expect(httpGetBuffer(evil, 'http://github.com/a', { ...base, allow: updateAllow })).rejects.toMatchObject({ kind: 'host' });
  // A relative Location resolves against the current URL.
  const rel = opener({ 'https://github.com/a/b': { status: 301, location: '../c' }, 'https://github.com/c': { status: 200, chunks: ['ok'] } });
  expect((await httpGetBuffer(rel, 'https://github.com/a/b', { ...base, allow: updateAllow })).toString()).toBe('ok');
});

test('redirect loops stop', async () => {
  const loop = opener({ 'https://github.com/a': { status: 302, location: 'https://github.com/a' } });
  await expect(httpGetBuffer(loop, 'https://github.com/a', base)).rejects.toBeInstanceOf(DownloadError);
});

test('size caps: a declared length over the cap is refused before reading, a stream over the cap is cut', async () => {
  const declared = opener({ 'u:a': { status: 200, headers: { 'content-length': '5000' }, chunks: ['x'] } });
  await expect(httpGetBuffer(declared, 'u:a', base)).rejects.toMatchObject({ kind: 'too-large' });
  const streamed = opener({ 'u:a': { status: 200, chunks: ['x'.repeat(600), 'x'.repeat(600)] } });
  await expect(httpGetBuffer(streamed, 'u:a', base)).rejects.toMatchObject({ kind: 'too-large' });
});

test('HTTP errors: rate limit apart from the others', async () => {
  const limited = opener({ 'u:a': { status: 403, headers: { 'x-ratelimit-remaining': '0' } } });
  await expect(httpGetBuffer(limited, 'u:a', base)).rejects.toMatchObject({ kind: 'rate-limited' });
  const tooMany = opener({ 'u:a': { status: 429 } });
  await expect(httpGetBuffer(tooMany, 'u:a', base)).rejects.toMatchObject({ kind: 'rate-limited' });
  const missing = opener({ 'u:a': { status: 404 } });
  await expect(httpGetBuffer(missing, 'u:a', base)).rejects.toMatchObject({ kind: 'http', status: 404 });
  const broken: Opener = async () => { throw new Error('ENOTFOUND'); };
  await expect(httpGetBuffer(broken, 'u:a', base)).rejects.toMatchObject({ kind: 'network' });
});

test('a stalled body times out', async () => {
  const stalled = opener({ 'u:a': { status: 200, chunks: ['x'], hang: true } });
  await expect(httpGetBuffer(stalled, 'u:a', { ...base, idleMs: 50 })).rejects.toMatchObject({ kind: 'timeout' });
});

test('streaming with progress against the declared size', async () => {
  const open = opener({ 'u:a': { status: 200, headers: { 'content-length': '6' }, chunks: ['abc', 'def'] } });
  const progress: [number, number | null][] = [];
  const parts: string[] = [];
  const r = await httpGet(open, 'u:a', { ...base, onData: (c) => parts.push(c.toString()), onProgress: (n, t) => progress.push([n, t]) });
  expect(r.bytes).toBe(6);
  expect(parts.join('')).toBe('abcdef');
  expect(progress.at(-1)).toEqual([6, 6]);
});

test('every request asks for the bytes as stored (Accept-Encoding: identity)', () => {
  expect(requestHeaders('https://github.com/x', 'Atelier/1.0')).toEqual({ 'User-Agent': 'Atelier/1.0', Accept: '*/*', 'Accept-Encoding': 'identity' });
  // The release list is JSON (useatelier.dev, or the tests' local endpoint); every other answer is just bytes.
  expect(requestHeaders('https://useatelier.dev/updates/releases', 'Atelier/1.0')).toMatchObject({ Accept: 'application/json', 'Accept-Encoding': 'identity' });
  expect(requestHeaders('http://127.0.0.1:4000/updates/releases', 'Atelier/1.0')).toMatchObject({ Accept: 'application/json' });
  expect(requestHeaders('https://useatelier.dev/updates/download/v1.0.0/latest-mac.yml', 'Atelier/1.0')).toMatchObject({ Accept: '*/*' });
});

test('a gzip-encoded answer anyway (proxy, CDN): the decoded body counts, not the compressed Content-Length', async () => {
  const text = Buffer.from('release notes '.repeat(400));
  const noise = randomBytes(1000);
  const asked: (string | undefined)[] = [];
  const server = createServer((req, res) => {
    asked.push(req.headers['accept-encoding']);
    const gz = gzipSync(req.url === '/text' ? text : noise);
    res.writeHead(200, { 'Content-Encoding': 'gzip', 'Content-Length': gz.length }).end(gz);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const url = (p: string) => `http://127.0.0.1:${(server.address() as AddressInfo).port}${p}`;
  try {
    // Compressible: the compressed length is far below the decoded size (it used to fail as an "incomplete body").
    expect((await httpGetBuffer(nodeOpener, url('/text'), { ...base, maxBytes: 10_000 })).equals(text)).toBe(true);
    // Incompressible: the compressed length is above the cap, the decoded body is not: accepted.
    expect((await httpGetBuffer(nodeOpener, url('/noise'), { ...base, maxBytes: 1000 })).equals(noise)).toBe(true);
    // The streamed cap still applies to the decoded bytes.
    await expect(httpGetBuffer(nodeOpener, url('/noise'), { ...base, maxBytes: 999 })).rejects.toMatchObject({ kind: 'too-large' });
    expect(asked.every((a) => a === 'identity')).toBe(true);
  } finally {
    server.close();
  }
});

test('one controller per hop: a finished redirect hop is aborted before the next one opens, the last one at the end', async () => {
  const signals: AbortSignal[] = [];
  const abortedWhenNextOpened: boolean[] = [];
  const inner = opener({ 'u:a': { status: 302, location: 'u:b' }, 'u:b': { status: 200, chunks: ['ok'] } });
  const open: Opener = (url, signal) => {
    abortedWhenNextOpened.push(...signals.map((s) => s.aborted));
    signals.push(signal);
    return inner(url, signal);
  };
  expect((await httpGetBuffer(open, 'u:a', base)).toString()).toBe('ok');
  expect(signals).toHaveLength(2);
  expect(signals[0]).not.toBe(signals[1]);
  expect(abortedWhenNextOpened).toEqual([true]);
  expect(signals.every((s) => s.aborted)).toBe(true);
});

test('a body from an event emitter (Electron\'s IncomingMessage): listeners removed once read, ended or abandoned', async () => {
  const read = async (o: { end?: boolean; error?: boolean; stopEarly?: boolean }) => {
    const res = new EventEmitter();
    const ctl = new AbortController();
    const it = eventChunks(res, ctl.signal);
    const got: string[] = [];
    const loop = (async () => {
      try { for await (const c of it) { got.push(Buffer.from(c).toString()); if (o.stopEarly) break; } } catch { got.push('error'); }
    })();
    await Promise.resolve();
    res.emit('data', Buffer.from('a'));
    if (o.end) res.emit('end');
    if (o.error) res.emit('error', new Error('boom'));
    await loop;
    for (const ev of ['data', 'end', 'error', 'aborted']) expect(res.listenerCount(ev), ev).toBe(0);
    expect(getEventListeners(ctl.signal, 'abort')).toHaveLength(0);
    return got;
  };
  expect(await read({ end: true })).toEqual(['a']);
  expect(await read({ error: true })).toEqual(['a', 'error']);
  expect(await read({ stopEarly: true })).toEqual(['a']);
});
