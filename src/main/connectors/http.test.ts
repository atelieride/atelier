import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, test } from 'vitest';
import { fetchTransport } from '../../../tests/support/fetch-transport';
import { Aborted, HostNotAllowed, TooLarge, Unreachable } from './errors';
import { DEFAULT_TIMEOUT_MS, MAX_REPLY_BYTES, originAllow, requestText, type HttpRequest, type HttpResponse, type Transport } from './http';

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => { s.closeAllConnections(); s.close(() => r()); })));
});
async function serve(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<{ url: string; hits: string[] }> {
  const hits: string[] = [];
  const server = createServer((req, res) => { hits.push(`${req.method} ${req.url}`); handler(req, res); });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, hits };
}

const body = (text: string) => (async function* () { yield new TextEncoder().encode(text); })();
const reply = (status: number, text = '', extra: Partial<HttpResponse> = {}): HttpResponse =>
  ({ status, headers: {}, location: null, body: body(text), close: () => undefined, ...extra });
/** A transport that answers from a script and records every request it was asked to open. */
function scripted(...answers: HttpResponse[]): Transport & { seen: HttpRequest[] } {
  const seen: HttpRequest[] = [];
  const open: Transport = async (req) => { seen.push({ ...req, headers: { ...req.headers } }); const a = answers.shift(); if (!a) throw new Error('no answer'); return a; };
  return Object.assign(open, { seen });
}

const CLICKUP = 'https://mcp.clickup.com';

describe('originAllow: exactly the configured origin', () => {
  const allow = originAllow(CLICKUP);
  test.each([
    ['https://mcp.clickup.com/mcp', true],
    ['https://mcp.clickup.com/.well-known/oauth-authorization-server', true],
    ['https://mcp.clickup.com:443/mcp', true], // the default port, normalized away
    ['https://MCP.ClickUp.com/mcp', true], // hosts are case-insensitive (URL lowercases them)
    ['http://mcp.clickup.com/mcp', false],
    ['https://mcp.clickup.com:8443/mcp', false],
    ['https://app.clickup.com/t/1', false],
    ['https://clickup.com/', false],
    ['https://mcp.clickup.com.evil.test/mcp', false],
    ['https://evil.test/?https://mcp.clickup.com', false],
    ['https://user:pw@mcp.clickup.com/mcp', false],
    ['https://mcp.clіckup.com/mcp', false], // Cyrillic і: punycode, another host
    ['https://mcp.clickup.com./mcp', false] // trailing dot: a different host string
  ])('%s → %s', (url, ok) => {
    expect(allow(new URL(url))).toBe(ok);
  });

  test('http only for 127.0.0.1 and only when the loopback test base is enabled', () => {
    expect(() => originAllow('http://127.0.0.1:4567')).toThrow(TypeError);
    expect(() => originAllow('http://10.0.0.1:4567', { loopbackHttp: true })).toThrow(TypeError);
    expect(() => originAllow('http://localhost:4567', { loopbackHttp: true })).toThrow(TypeError);
    expect(() => originAllow('not a url')).toThrow(TypeError);
    const local = originAllow('http://127.0.0.1:4567', { loopbackHttp: true });
    expect(local(new URL('http://127.0.0.1:4567/mcp'))).toBe(true);
    expect(local(new URL('http://127.0.0.1:4568/mcp'))).toBe(false);
    expect(local(new URL('http://localhost:4567/mcp'))).toBe(false);
    expect(local(new URL('https://mcp.clickup.com/mcp'))).toBe(false);
  });
});

describe('requestText', () => {
  test('defaults: 20 s timeout, 4 MB cap', () => {
    expect(DEFAULT_TIMEOUT_MS).toBe(20_000);
    expect(MAX_REPLY_BYTES).toBe(4 * 1024 * 1024);
  });

  test('a URL outside the allowlist is refused before the transport is called', async () => {
    const t = scripted(reply(200, 'x'));
    await expect(requestText(t, { method: 'GET', url: 'https://evil.test/x' }, { allow: originAllow(CLICKUP) })).rejects.toBeInstanceOf(HostNotAllowed);
    await expect(requestText(t, { method: 'GET', url: 'not a url' }, { allow: originAllow(CLICKUP) })).rejects.toBeInstanceOf(HostNotAllowed);
    expect(t.seen).toEqual([]);
  });

  test('a redirect to another host is refused before it is opened', async () => {
    const t = scripted(reply(302, '', { location: 'https://evil.test/steal' }), reply(200, 'never'));
    await expect(requestText(t, { method: 'GET', url: `${CLICKUP}/a` }, { allow: originAllow(CLICKUP) })).rejects.toBeInstanceOf(HostNotAllowed);
    expect(t.seen.map((r) => r.url)).toEqual([`${CLICKUP}/a`]);
  });

  test('same-origin redirects are followed by hand: 303 turns a POST into a body-less GET, 307 keeps it', async () => {
    const t = scripted(reply(303, '', { location: '/b' }), reply(200, 'ok'));
    const r = await requestText(t, { method: 'POST', url: `${CLICKUP}/a`, headers: { 'content-type': 'application/json', authorization: 'Bearer x' }, body: '{}' }, { allow: originAllow(CLICKUP) });
    expect(r).toMatchObject({ status: 200, text: 'ok', url: `${CLICKUP}/b` });
    expect(t.seen[1]).toEqual({ method: 'GET', url: `${CLICKUP}/b`, headers: { authorization: 'Bearer x' } });
    const k = scripted(reply(307, '', { location: `${CLICKUP}/c` }), reply(200, 'ok'));
    await requestText(k, { method: 'POST', url: `${CLICKUP}/a`, headers: { 'content-type': 'application/json' }, body: '{"a":1}' }, { allow: originAllow(CLICKUP) });
    expect(k.seen[1]).toEqual({ method: 'POST', url: `${CLICKUP}/c`, headers: { 'content-type': 'application/json' }, body: '{"a":1}' });
  });

  test('too many redirects → Unreachable', async () => {
    const loop = () => reply(302, '', { location: `${CLICKUP}/again` });
    const t = scripted(loop(), loop(), loop(), loop(), loop());
    await expect(requestText(t, { method: 'GET', url: `${CLICKUP}/a` }, { allow: originAllow(CLICKUP) })).rejects.toBeInstanceOf(Unreachable);
    expect(t.seen.length).toBe(4); // the request plus 3 redirects
  });

  test('over a real socket: a redirect to another local port is refused and that server never sees a request', async () => {
    const other = await serve((_q, s) => s.end('stolen'));
    const base = await serve((_q, s) => { s.writeHead(302, { location: `${other.url}/x` }); s.end(); });
    const allow = originAllow(base.url, { loopbackHttp: true });
    await expect(requestText(fetchTransport(), { method: 'GET', url: `${base.url}/a` }, { allow })).rejects.toBeInstanceOf(HostNotAllowed);
    expect(base.hits).toEqual(['GET /a']);
    expect(other.hits).toEqual([]);
  });

  test('a reply over the cap fails with TooLarge, declared or streamed', async () => {
    const big = await serve((q, s) => {
      if (q.url === '/declared') { s.writeHead(200, { 'content-length': '5000' }); s.end('y'.repeat(5000)); return; }
      s.writeHead(200); // chunked, no length
      s.write('y'.repeat(800));
      s.end('y'.repeat(800));
    });
    const allow = originAllow(big.url, { loopbackHttp: true });
    for (const path of ['/declared', '/streamed']) {
      await expect(requestText(fetchTransport(), { method: 'GET', url: big.url + path }, { allow, maxBytes: 1000 })).rejects.toBeInstanceOf(TooLarge);
    }
    expect((await requestText(fetchTransport(), { method: 'GET', url: `${big.url}/streamed` }, { allow, maxBytes: 2000 })).text).toHaveLength(1600);
  });

  test('a server that never answers → Unreachable(timeout) after the timeout', async () => {
    const slow = await serve(() => { /* never answers */ });
    const started = Date.now();
    const err = await requestText(fetchTransport(), { method: 'GET', url: `${slow.url}/x` }, { allow: originAllow(slow.url, { loopbackHttp: true }), timeoutMs: 150 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Unreachable);
    expect((err as Unreachable).reason).toBe('timeout');
    expect(Date.now() - started).toBeLessThan(2000);
  });

  test('a dropped connection → Unreachable(network), with none of the transport\'s text', async () => {
    const drop = await serve((q) => q.socket.destroy());
    const err = await requestText(fetchTransport(), { method: 'GET', url: `${drop.url}/x` }, { allow: originAllow(drop.url, { loopbackHttp: true }) }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Unreachable);
    expect((err as Unreachable).reason).toBe('network');
    expect((err as Error).cause).toBeUndefined();
  });

  test('the caller\'s signal aborts the request → Aborted', async () => {
    const slow = await serve(() => { /* never answers */ });
    const ctl = new AbortController();
    const p = requestText(fetchTransport(), { method: 'GET', url: `${slow.url}/x` }, { allow: originAllow(slow.url, { loopbackHttp: true }), signal: ctl.signal });
    setTimeout(() => ctl.abort(), 50);
    await expect(p).rejects.toBeInstanceOf(Aborted);
    const already = new AbortController();
    already.abort();
    const t = scripted(reply(200));
    await expect(requestText(t, { method: 'GET', url: `${CLICKUP}/x` }, { allow: originAllow(CLICKUP), signal: already.signal })).rejects.toBeInstanceOf(Aborted);
    expect(t.seen).toEqual([]);
  });

  test('a reply comes back with its status, lowercase headers and text', async () => {
    const ok = await serve((_q, s) => { s.writeHead(201, { 'X-Thing': 'v', 'content-type': 'application/json' }); s.end('{"a":"è"}'); });
    const r = await requestText(fetchTransport(), { method: 'POST', url: `${ok.url}/p`, body: '{}' }, { allow: originAllow(ok.url, { loopbackHttp: true }) });
    expect(r.status).toBe(201);
    expect(r.headers['x-thing']).toBe('v');
    expect(r.text).toBe('{"a":"è"}');
  });
});
