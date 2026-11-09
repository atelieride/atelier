import { describe, expect, test } from 'vitest';
import { z } from 'zod';
import { RateLimited, ToolError } from '../errors';
import type { HttpRequest, HttpResponse, Transport } from '../http';
import { createMcpClient, rateLimitResetAt, MAX_RATE_LIMIT_WAIT_MS } from './client';
import { defineToolSet } from './toolset';

// An API-token connection sends `Basic base64(user:secret)`, and nothing of the secret
// (raw or encoded) reaches an error; Atlassian's 429 carries Retry-After (seconds) and no x-ratelimit-reset.

const TOOLS = defineToolSet({ demo_get: { args: z.object({ id: z.string() }).strict(), reply: z.object({ id: z.string() }) } });

function server(reply: (req: HttpRequest, n: number) => { status: number; body: unknown; headers?: Record<string, string> }): { transport: Transport; seen: HttpRequest[] } {
  const seen: HttpRequest[] = [];
  const transport: Transport = async (req) => {
    seen.push(req);
    const out = reply(req, seen.length);
    const text = JSON.stringify(out.body);
    const res: HttpResponse = {
      status: out.status, headers: { 'content-type': 'application/json', ...out.headers }, location: null,
      body: (async function* () { yield Buffer.from(text); })(), close: () => undefined
    };
    return res;
  };
  return { transport, seen };
}

const rpc = (req: HttpRequest) => JSON.parse(req.body!) as { id?: number; method: string };
const ok = (req: HttpRequest) => {
  const m = rpc(req);
  if (m.method === 'initialize') return { status: 200, body: { jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'x' } } } };
  if (m.id === undefined) return { status: 202, body: {} };
  return { status: 200, body: { jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: '{"id":"1"}' }] } } };
};

const SECRET = 'ATATT3xFfGF0-secret-api-token-1234567890';
const USER = 'ada@example.com';
const B64 = Buffer.from(`${USER}:${SECRET}`).toString('base64');

describe('API-token (Basic) connections', () => {
  test('every request carries Basic base64(user:secret)', async () => {
    const s = server(ok);
    const c = createMcpClient({ mcpUrl: 'https://mcp.atlassian.com/v2/mcp?tools=all', allow: () => true, transport: s.transport, token: SECRET, basicUser: USER, tools: TOOLS });
    await c.callTool('demo_get', { id: '1' });
    expect(s.seen.length).toBeGreaterThan(0);
    for (const r of s.seen) expect(r.headers?.authorization).toBe(`Basic ${B64}`);
    expect(s.seen[0]!.url).toBe('https://mcp.atlassian.com/v2/mcp?tools=all');
  });

  test('a Bearer connection is unchanged', async () => {
    const s = server(ok);
    const c = createMcpClient({ mcpUrl: 'https://x.example/mcp', allow: () => true, transport: s.transport, token: 'tok', tools: TOOLS });
    await c.callTool('demo_get', { id: '1' });
    expect(s.seen[0]!.headers?.authorization).toBe('Bearer tok');
  });

  test('a tool error quoting the secret or its encoding never shows either', async () => {
    const s = server((req) => {
      const m = rpc(req);
      if (m.method !== 'tools/call') return ok(req);
      return { status: 200, body: { jsonrpc: '2.0', id: m.id, result: { isError: true, content: [{ type: 'text', text: `bad credentials ${SECRET} / Basic ${B64}` }] } } };
    });
    const c = createMcpClient({ mcpUrl: 'https://x.example/mcp', allow: () => true, transport: s.transport, token: SECRET, basicUser: USER, tools: TOOLS });
    const e = await c.callTool('demo_get', { id: '1' }).then(() => null, (x: unknown) => x);
    expect(e).toBeInstanceOf(ToolError);
    const text = JSON.stringify({ m: (e as Error).message, t: (e as ToolError).text, s: (e as Error).stack });
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain(B64);
  });
});

describe('tool error text', () => {
  test('cut to 200 for display; the scrubbed full text keeps a value past that (Jira names a gone project late)', async () => {
    const long = `${'Validation failed. '.repeat(20)}The value '10002' does not exist for the field 'project'. token ${SECRET}`;
    const s = server((req) => {
      const m = rpc(req);
      if (m.method !== 'tools/call') return ok(req);
      return { status: 200, body: { jsonrpc: '2.0', id: m.id, result: { isError: true, content: [{ type: 'text', text: long }] } } };
    });
    const c = createMcpClient({ mcpUrl: 'https://x.example/mcp', allow: () => true, transport: s.transport, token: SECRET, tools: TOOLS });
    const e = await c.callTool('demo_get', { id: '1' }).then(() => null, (x: unknown) => x) as ToolError;
    expect(e.text.length).toBeLessThanOrEqual(200);
    expect(e.text).not.toContain('10002');
    expect(e.fullText).toContain("The value '10002' does not exist for the field 'project'");
    expect(e.fullText).not.toContain(SECRET);
  });
});

describe('rate limits', () => {
  test('Retry-After (seconds) when there is no x-ratelimit-reset', () => {
    expect(rateLimitResetAt(undefined, 1_000_000, '30')).toBe(1_030_000);
    expect(rateLimitResetAt(undefined, 1_000_000, '999999')).toBe(1_000_000 + MAX_RATE_LIMIT_WAIT_MS);
    // x-ratelimit-reset wins when both are there (ClickUp's shape is unchanged).
    expect(rateLimitResetAt('1800000060', 1_800_000_000_000, '5')).toBe(1_800_000_060_000);
  });

  test('a 429 with only Retry-After waits that long', async () => {
    const s = server((req, n) => (n === 1 ? ok(req) : n === 2 ? { status: 202, body: {} } : { status: 429, body: {}, headers: { 'retry-after': '30' } }));
    const c = createMcpClient({ mcpUrl: 'https://x.example/mcp', allow: () => true, transport: s.transport, token: 't', tools: TOOLS, now: () => 1_000_000 });
    const e = await c.callTool('demo_get', { id: '1' }).then(() => null, (x: unknown) => x);
    expect(e).toBeInstanceOf(RateLimited);
    expect((e as RateLimited).resetAt).toBe(1_030_000);
  });
});
