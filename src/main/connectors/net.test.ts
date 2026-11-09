// Electron's net only exists in a real main process: this checks how net.ts drives it (own in-memory session that
// cancels other hosts, no cookies or credentials, redirects never followed, permissions denied) against a stand-in.
import { EventEmitter } from 'node:events';
import { beforeEach, expect, test, vi } from 'vitest';

const h = vi.hoisted(() => ({
  partitions: [] as { name: string; opts: unknown }[],
  beforeRequest: null as null | ((d: { url: string }, cb: (r: { cancel: boolean }) => void) => void),
  permission: null as null | ((wc: unknown, perm: string, cb: (ok: boolean) => void) => void),
  permissionCheck: null as null | ((...a: unknown[]) => boolean),
  requests: [] as { opts: Record<string, unknown>; headers: Record<string, string>; written: string[]; req: EventEmitter & { aborted: boolean } }[]
}));

vi.mock('electron', () => {
  const session = {
    fromPartition(name: string, opts: unknown) {
      h.partitions.push({ name, opts });
      return {
        webRequest: { onBeforeRequest: (fn: typeof h.beforeRequest) => { h.beforeRequest = fn; } },
        setPermissionRequestHandler: (fn: typeof h.permission) => { h.permission = fn; },
        setPermissionCheckHandler: (fn: typeof h.permissionCheck) => { h.permissionCheck = fn; }
      };
    }
  };
  const net = {
    request(opts: Record<string, unknown>) {
      const req = Object.assign(new EventEmitter(), {
        aborted: false,
        setHeader(k: string, v: string) { entry.headers[k] = v; },
        write(s: string) { entry.written.push(s); },
        end(s?: string) { if (s) entry.written.push(s); },
        abort() { req.aborted = true; }
      });
      const entry = { opts, headers: {} as Record<string, string>, written: [] as string[], req };
      h.requests.push(entry);
      return req;
    }
  };
  return { net, session, default: { net, session } };
});

const { electronTransport } = await import('./net');
const { originAllow } = await import('./http');

beforeEach(() => { h.requests.length = 0; });

const allow = originAllow('https://mcp.clickup.com');

test('requests go through their own in-memory session that cancels every other host and denies permissions', async () => {
  const t = electronTransport(allow, 'Atelier/1.0');
  const p = t({ method: 'POST', url: 'https://mcp.clickup.com/mcp', headers: { 'content-type': 'application/json' }, body: '{"a":1}' }, new AbortController().signal);
  expect(h.partitions).toHaveLength(1);
  expect(h.partitions[0]!.name).not.toMatch(/^persist:/);
  expect(h.partitions[0]!.opts).toEqual({ cache: false });
  const decide = (url: string) => { let cancel: boolean | undefined; h.beforeRequest!({ url }, (r) => { cancel = r.cancel; }); return cancel; };
  expect(decide('https://mcp.clickup.com/mcp')).toBe(false);
  expect(decide('https://evil.test/x')).toBe(true);
  expect(decide('https://app.clickup.com/t/1')).toBe(true);
  expect(decide('garbage')).toBe(true);
  let granted: boolean | undefined;
  h.permission!(null, 'notifications', (ok) => { granted = ok; });
  expect(granted).toBe(false);
  expect(h.permissionCheck!(null, 'clipboard-read')).toBe(false);

  const r = h.requests[0]!;
  expect(r.opts).toMatchObject({ url: 'https://mcp.clickup.com/mcp', method: 'POST', redirect: 'manual', credentials: 'omit', useSessionCookies: false, cache: 'no-store' });
  expect(r.headers).toMatchObject({ 'content-type': 'application/json', 'User-Agent': 'Atelier/1.0' });
  expect(r.written.join('')).toBe('{"a":1}');
  const res = Object.assign(new EventEmitter(), { statusCode: 200, headers: { 'Content-Type': 'application/json', 'X-Multi': ['a', 'b'] } });
  r.req.emit('response', res);
  const out = await p;
  expect(out.status).toBe(200);
  expect(out.headers).toEqual({ 'content-type': 'application/json', 'x-multi': 'a, b' });
  const chunks: string[] = [];
  const reading = (async () => { for await (const c of out.body) chunks.push(Buffer.from(c).toString()); })();
  res.emit('data', Buffer.from('{"ok":'));
  res.emit('data', Buffer.from('true}'));
  res.emit('end');
  await reading;
  expect(chunks.join('')).toBe('{"ok":true}');
  // One session for every request.
  void t({ method: 'GET', url: 'https://mcp.clickup.com/x' }, new AbortController().signal);
  expect(h.partitions).toHaveLength(1);
});

test('a redirect is returned (with its location), never followed', async () => {
  const t = electronTransport(allow, 'Atelier/1.0');
  const p = t({ method: 'GET', url: 'https://mcp.clickup.com/a' }, new AbortController().signal);
  const r = h.requests[0]!;
  r.req.emit('redirect', 302, 'GET', 'https://evil.test/steal', {});
  const out = await p;
  expect(out).toMatchObject({ status: 302, location: 'https://evil.test/steal' });
  out.close();
  expect(r.req.aborted).toBe(true);
});

test('an aborted signal aborts the request; a transport error rejects', async () => {
  const t = electronTransport(allow, 'Atelier/1.0');
  const ctl = new AbortController();
  const p = t({ method: 'GET', url: 'https://mcp.clickup.com/a' }, ctl.signal);
  ctl.abort();
  await expect(p).rejects.toThrow();
  expect(h.requests[0]!.req.aborted).toBe(true);
  const q = t({ method: 'GET', url: 'https://mcp.clickup.com/b' }, new AbortController().signal);
  h.requests[1]!.req.emit('error', new Error('net::ERR_INTERNET_DISCONNECTED'));
  await expect(q).rejects.toThrow();
});
