import { z } from 'zod';
import { afterEach, describe, expect, test } from 'vitest';
import { makeFixtures, startFakeClickUp, type FakeClickUp } from '../../../../tests/fixtures/fake-clickup.mjs';
import { fetchTransport } from '../../../../tests/support/fetch-transport';
import { Aborted, ConnectorError, Forbidden, InvalidArguments, NotAllowed, RateLimited, SchemaChanged, ToolError, TooLarge, Unauthorized, Unreachable } from '../errors';
import { originAllow, type HttpRequest, type HttpResponse, type Transport } from '../http';
import { clickupEndpoint } from '../clickup/config';
import { ALLOWED_TOOLS, CLICKUP_TOOLS } from '../clickup/tools';
import { MAX_RATE_LIMIT_WAIT_MS, MCP_PROTOCOL_VERSION, MIN_RATE_LIMIT_WAIT_MS, createMcpClient, rateLimitResetAt, type McpClient } from './client';
import { defineToolSet, missingTools as missingFrom } from './toolset';

type AllowedTool = (typeof CLICKUP_TOOLS)['names'][number];
const missingTools = (available: Iterable<string>) => missingFrom(CLICKUP_TOOLS, available);

// Six read tools since 2026-10-19: clickup_get_list (optional) gives the statuses' colors that compact replies lack.
const READ = ['clickup_resolve_assignees', 'clickup_filter_tasks', 'clickup_get_task', 'clickup_get_workspace_hierarchy', 'clickup_search', 'clickup_get_list'];

let fake: FakeClickUp | undefined;
afterEach(async () => { await fake?.close(); fake = undefined; });

/** A Node transport that records every request it opens (method of the JSON-RPC body, headers). */
function spied(): Transport & { seen: HttpRequest[]; methods(): string[] } {
  const inner = fetchTransport();
  const seen: HttpRequest[] = [];
  const t: Transport = (req, signal) => { seen.push({ ...req, headers: { ...req.headers } }); return inner(req, signal); };
  return Object.assign(t, { seen, methods: () => seen.map((r) => (JSON.parse(r.body ?? '{}') as { method?: string }).method ?? '?') });
}

async function connect(o: { timeoutMs?: number; maxBytes?: number; token?: string; now?: () => number } = {}) {
  fake = await startFakeClickUp();
  const transport = spied();
  const token = o.token ?? fake.issueToken();
  const endpoint = clickupEndpoint(fake.url);
  const client = createMcpClient({ mcpUrl: endpoint.mcpUrl, allow: endpoint.allow, transport, token, tools: CLICKUP_TOOLS, ...o });
  return { fake, transport, token, client };
}

const ARGS: Record<AllowedTool, Record<string, unknown>> = {
  clickup_resolve_assignees: { assignees: ['me'] },
  clickup_filter_tasks: { assignees: ['81000001'], order_by: 'updated' },
  clickup_get_task: { task_id: '86fk0001a' },
  clickup_get_workspace_hierarchy: { max_depth: '2' },
  clickup_search: { keywords: 'login' },
  clickup_get_list: { list_id: '901500000301' }
};
const call = (c: McpClient, name: string, args: Record<string, unknown> = {}) => c.callTool(name as AllowedTool, args as never);

describe('the read-only allowlist', () => {
  test('is exactly the six read tools, and nothing can widen it', async () => {
    expect([...ALLOWED_TOOLS].sort()).toEqual([...READ].sort());
    expect(Object.isFrozen(ALLOWED_TOOLS)).toBe(true);
    const widen = ALLOWED_TOOLS as unknown as Set<string>;
    expect(() => widen.add('clickup_update_task')).toThrow(TypeError);
    expect(() => widen.delete('clickup_get_task')).toThrow(TypeError);
    expect(() => widen.clear()).toThrow(TypeError);
    // Even past the guards, the exported set is a copy: the check uses its own private one.
    Set.prototype.add.call(widen, 'clickup_update_task');
    expect(CLICKUP_TOOLS.isAllowed('clickup_update_task')).toBe(false);
    const { client, transport, fake: f } = await connect();
    await expect(call(client, 'clickup_update_task', { task_id: '86fk0001a' })).rejects.toBeInstanceOf(NotAllowed);
    Set.prototype.delete.call(widen, 'clickup_update_task');
    expect(transport.seen).toEqual([]);
    expect(f.calls()).toEqual([]);
  });

  test.each(READ)('%s is allowed and answers', async (name) => {
    const { client, fake: f } = await connect();
    await expect(call(client, name, ARGS[name as AllowedTool])).resolves.toBeTruthy();
    expect(f.calls()).toEqual([name]);
  });

  test.each([
    ['a write tool', 'clickup_update_task'],
    ['another write tool', 'clickup_create_task'],
    ['the generic operator', 'clickup_execute_operator'],
    ['upper case', 'CLICKUP_GET_TASK'],
    ['a leading space', ' clickup_get_task'],
    ['a trailing space', 'clickup_get_task '],
    ['a trailing newline', 'clickup_get_task\n'],
    ['a Cyrillic homoglyph (с)', 'сlickup_get_task'],
    ['a zero-width space', 'clickup_get\u200b_task'],
    ['a zero-width joiner at the end', 'clickup_search\u200d'],
    ['a fullwidth letter', 'clickup_get_tａsk'],
    ['the empty string', ''],
    ['a prototype key', 'constructor'],
    ['a prototype key', '__proto__']
  ])('%s (%j) is refused before any request', async (_label, name) => {
    const { client, transport, fake: f } = await connect();
    const err = await call(client, name, { task_id: '86fk0001a' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NotAllowed);
    expect(transport.seen).toEqual([]); // not even initialize
    expect(f.calls()).toEqual([]);
  });

  test('a name that is not a string is refused before any request', async () => {
    const { client, transport } = await connect();
    for (const name of [undefined, null, 42, ['clickup_get_task'], { toString: () => 'clickup_get_task' }, new String('clickup_get_task')]) {
      await expect(client.callTool(name as unknown as AllowedTool, {} as never)).rejects.toBeInstanceOf(NotAllowed);
    }
    expect(transport.seen).toEqual([]);
  });

  test('arguments outside an allowed tool\'s strict schema are refused before any request', async () => {
    const { client, transport } = await connect();
    for (const [name, args] of [
      ['clickup_get_task', { task_id: '' }], ['clickup_get_task', { task_id: 'a', extra: 1 }], ['clickup_filter_tasks', { order_by: 'x' }],
      ['clickup_search', {}], ['clickup_resolve_assignees', { assignees: [] }], ['clickup_get_workspace_hierarchy', { max_depth: 3 }]
    ] as const) {
      const err = await call(client, name, args).catch((e: unknown) => e);
      expect(err, name).toBeInstanceOf(InvalidArguments);
      expect(err, name).toBeInstanceOf(ConnectorError);
      expect((err as ConnectorError).kind).toBe('invalid-arguments');
      expect((err as InvalidArguments).tool).toBe(name);
    }
    expect(transport.seen).toEqual([]);
  });

  test('a name outside the ToolSet throws NotAllowed before any request (transport never called)', async () => {
    // A second, test-only ToolSet: the client trusts the set it was given and nothing else, so a ClickUp name is foreign.
    const other = defineToolSet({ other_read: { args: z.strictObject({}), reply: z.object({}) } });
    const transport = spied();
    const client = createMcpClient({ mcpUrl: 'https://mcp.example.test/mcp', allow: originAllow('https://mcp.example.test'), transport, token: 't', tools: other });
    for (const name of ['clickup_get_task', 'clickup_update_task', ' other_read', 'OTHER_READ', '']) {
      await expect(client.callTool(name as 'other_read', {}), name).rejects.toBeInstanceOf(NotAllowed);
    }
    expect(transport.seen).toEqual([]);
  });

  test('missingTools lists the required allowlisted tools a tools/list lacks, never an optional one', () => {
    expect(missingTools(READ)).toEqual([]);
    expect(missingTools([...READ.filter((n) => n !== 'clickup_get_task'), 'clickup_update_task'])).toEqual(['clickup_get_task']);
    expect(missingTools(READ.filter((n) => n !== 'clickup_get_list'))).toEqual([]);
    expect(missingTools([])).toEqual(READ.filter((n) => n !== 'clickup_get_list'));
  });
});

describe('the MCP exchange (streamable HTTP, protocol 2025-06-18)', () => {
  test('initialize → notifications/initialized → tools/call, then only tools/call; headers as the spec wants', async () => {
    const { client, transport, token } = await connect();
    await client.callTool('clickup_resolve_assignees', { assignees: ['me'] });
    await client.callTool('clickup_get_task', { task_id: '86fk0001a' });
    expect(transport.methods()).toEqual(['initialize', 'notifications/initialized', 'tools/call', 'tools/call']);
    for (const r of transport.seen) {
      expect(r.method).toBe('POST');
      expect(r.url).toBe(`${fake!.url}/mcp`);
      expect(r.headers).toMatchObject({
        authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream',
        'mcp-protocol-version': MCP_PROTOCOL_VERSION
      });
    }
    const init = JSON.parse(transport.seen[0]!.body!) as { params: { protocolVersion: string; clientInfo: { name: string } } };
    expect(init.params.protocolVersion).toBe('2025-06-18');
    expect(init.params.clientInfo.name).toBe('Atelier');
    const callBody = JSON.parse(transport.seen[3]!.body!) as { params: unknown };
    expect(callBody.params).toEqual({ name: 'clickup_get_task', arguments: { task_id: '86fk0001a' } });
  });

  test.each([false, true])('replies parse the same as JSON and as SSE (sse=%s)', async (sse) => {
    const { client, fake: f } = await connect();
    f.setSse(sse);
    const me = await client.callTool('clickup_resolve_assignees', { assignees: ['me'] });
    expect(me.userIds).toEqual(['81000001']);
    const list = await client.callTool('clickup_filter_tasks', { assignees: me.userIds, order_by: 'updated' });
    expect(list.tasks.map((t) => t.id)).toEqual(['86fk0001a', '86fk0002b', '86fk0003c']);
    expect(list.tasks[0]).toMatchObject({ id: '86fk0001a', custom_id: 'ENG-101', name: 'Fix the login redirect loop', status: { status: 'in progress' } });
    const task = await client.callTool('clickup_get_task', { task_id: '86fk0001a' });
    expect(task).toMatchObject({ id: '86fk0001a', parent: null, counts: { subtasks: 1 } });
    expect(task.markdown_description).toContain('/login');
    const tree = await client.callTool('clickup_get_workspace_hierarchy', { max_depth: '2' });
    expect(tree.hierarchy.root).toMatchObject({ id: '9015000001', name: 'Fakeworks' });
    expect(tree.hierarchy.root.children?.map((s) => s.name)).toEqual(['Engineering', 'Design']);
    const found = await client.callTool('clickup_search', { keywords: 'login' });
    expect(found.results.map((r) => r.id)).toEqual(['86fk0001a']);
  });

  test('listTools returns the server\'s tool names (tool-missing: clickup_get_task is gone)', async () => {
    const { client, fake: f } = await connect();
    const all = await client.listTools();
    expect(missingTools(all)).toEqual([]);
    f.setScenario('tool-missing');
    expect(missingTools(await client.listTools())).toEqual(['clickup_get_task']);
    expect(f.calls()).toEqual([]); // listing is not calling
  });

  test('a failed initialize is retried by the next call', async () => {
    const { client, fake: f, transport } = await connect();
    f.setScenario('mcp-500');
    await expect(client.callTool('clickup_resolve_assignees', { assignees: ['me'] })).rejects.toBeInstanceOf(Unreachable);
    f.setScenario('normal');
    await expect(client.callTool('clickup_resolve_assignees', { assignees: ['me'] })).resolves.toEqual({ userIds: ['81000001'] });
    expect(transport.methods()).toEqual(['initialize', 'initialize', 'notifications/initialized', 'tools/call']);
  });
});

describe('errors, against the fake ClickUp', () => {
  test('401 → Unauthorized (scenario, and a revoked token)', async () => {
    const { client, fake: f } = await connect();
    f.setScenario('mcp-401');
    await expect(client.callTool('clickup_resolve_assignees', { assignees: ['me'] })).rejects.toBeInstanceOf(Unauthorized);
    f.setScenario('normal');
    await client.callTool('clickup_resolve_assignees', { assignees: ['me'] });
    f.revokeTokens();
    await expect(client.callTool('clickup_get_task', { task_id: '86fk0001a' })).rejects.toBeInstanceOf(Unauthorized);
  });

  test('403 → Forbidden (also a gone workspace answered with 403)', async () => {
    const { client, fake: f } = await connect();
    f.setScenario('mcp-403');
    await expect(client.callTool('clickup_resolve_assignees', { assignees: ['me'] })).rejects.toBeInstanceOf(Forbidden);
    f.setScenario('workspace-gone-403');
    await expect(client.callTool('clickup_resolve_assignees', { assignees: ['me'] })).resolves.toEqual({ userIds: ['81000001'] });
    await expect(client.callTool('clickup_filter_tasks', { assignees: ['81000001'] })).rejects.toBeInstanceOf(Forbidden);
  });

  test('a gone workspace answered as a tool error → ToolError with ClickUp\'s text', async () => {
    const { client, fake: f } = await connect();
    f.setScenario('workspace-gone');
    const err = await client.callTool('clickup_get_workspace_hierarchy', {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ToolError);
    expect((err as ToolError).tool).toBe('clickup_get_workspace_hierarchy');
    expect((err as ToolError).text).toBe('403 Forbidden: Team not authorized (OAUTH_027).');
  });

  test('a gone task → ToolError "Task not found"', async () => {
    const { client, fake: f } = await connect();
    const err = await client.callTool('clickup_get_task', { task_id: f.fixtures.ids.gone }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ToolError);
    expect((err as ToolError).text).toBe(`Task not found: ${f.fixtures.ids.gone}`);
  });

  test('429 → RateLimited with resetAt from x-ratelimit-reset (unix seconds), capped at 5 minutes', async () => {
    let now = Date.now();
    const { client, fake: f } = await connect({ now: () => now });
    f.setScenario('mcp-429', { resetInSeconds: 30 });
    let err = await client.callTool('clickup_resolve_assignees', { assignees: ['me'] }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RateLimited);
    const resetAt = (err as RateLimited).resetAt;
    expect(resetAt).toBeGreaterThanOrEqual(now + 28_000);
    expect(resetAt).toBeLessThanOrEqual(now + 31_000);
    f.setScenario('mcp-429', { resetInSeconds: 3600 });
    now = Date.now();
    err = await client.callTool('clickup_resolve_assignees', { assignees: ['me'] }).catch((e: unknown) => e);
    expect((err as RateLimited).resetAt).toBe(now + MAX_RATE_LIMIT_WAIT_MS);
  });

  test('5xx → Unreachable(server); a dropped socket → Unreachable(network); no answer → Unreachable(timeout)', async () => {
    const { client, fake: f } = await connect({ timeoutMs: 200 });
    f.setScenario('mcp-500');
    let err = await client.callTool('clickup_resolve_assignees', { assignees: ['me'] }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Unreachable);
    expect(err).toMatchObject({ reason: 'server', status: 500 });
    f.setScenario('mcp-network-error');
    err = await client.callTool('clickup_resolve_assignees', { assignees: ['me'] }).catch((e: unknown) => e);
    expect(err).toMatchObject({ reason: 'network' });
    f.setScenario('slow');
    err = await client.callTool('clickup_resolve_assignees', { assignees: ['me'] }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Unreachable);
    expect(err).toMatchObject({ reason: 'timeout' });
  });

  test('the caller\'s signal → Aborted', async () => {
    const { client, fake: f } = await connect();
    f.setScenario('slow');
    const ctl = new AbortController();
    const p = client.callTool('clickup_resolve_assignees', { assignees: ['me'] }, { signal: ctl.signal });
    setTimeout(() => ctl.abort(), 50);
    await expect(p).rejects.toBeInstanceOf(Aborted);
  });

  test('one caller aborting during the shared initialize rejects only that caller; a concurrent one still succeeds', async () => {
    const { client, fake: f, transport } = await connect();
    f.setScenario('slow', { delayMs: 300 });
    const first = new AbortController();
    const a = client.callTool('clickup_resolve_assignees', { assignees: ['me'] }, { signal: first.signal });
    const b = client.callTool('clickup_get_task', { task_id: '86fk0001a' });
    setTimeout(() => first.abort(), 50);
    await expect(a).rejects.toBeInstanceOf(Aborted);
    await expect(b).resolves.toMatchObject({ id: '86fk0001a' });
    // One shared initialize, and the aborted caller never sent its tools/call.
    expect(transport.methods()).toEqual(['initialize', 'notifications/initialized', 'tools/call']);
    expect(f.calls()).toEqual(['clickup_get_task']);
  });

  test('a reply over 4 MB → TooLarge', async () => {
    const { client, fake: f } = await connect();
    await client.listTools();
    f.setScenario('oversized');
    await expect(client.callTool('clickup_get_task', { task_id: '86fk0001a' })).rejects.toBeInstanceOf(TooLarge);
  });

  test('a reply missing core fields → SchemaChanged, for every confirmed-shape tool; search just finds nothing', async () => {
    const { client, fake: f } = await connect();
    f.setScenario('schema-changed');
    for (const name of ['clickup_filter_tasks', 'clickup_get_task', 'clickup_get_workspace_hierarchy']) {
      await expect(call(client, name, ARGS[name as AllowedTool]), name).rejects.toBeInstanceOf(SchemaChanged);
    }
    // search's shape is unconfirmed: malformed items are skipped, the call doesn't fail (no `unavailable` over it).
    await expect(client.callTool('clickup_search', { keywords: 'login' })).resolves.toMatchObject({ results: [] });
  });

  test('an allowlisted tool the server no longer has → SchemaChanged', async () => {
    const { client, fake: f } = await connect();
    f.setScenario('tool-missing');
    await expect(client.callTool('clickup_get_task', { task_id: '86fk0001a' })).rejects.toBeInstanceOf(SchemaChanged);
  });

  test('the token never appears in any error\'s message, stack, fields or cause', async () => {
    const token = 'fkat_TOKEN-MUST-NOT-LEAK-0123456789';
    const { client, fake: f } = await connect({ token, timeoutMs: 200 });
    // The fake doesn't know this token: every call is a 401 first.
    const errors: unknown[] = [await client.callTool('clickup_resolve_assignees', { assignees: ['me'] }).catch((e: unknown) => e)];
    const known = createMcpClient({ ...clickupEndpoint(f.url), transport: fetchTransport(), token: f.issueToken(), tools: CLICKUP_TOOLS, timeoutMs: 200 });
    const scenarios = ['mcp-403', 'mcp-500', 'mcp-429', 'mcp-network-error', 'slow', 'oversized', 'schema-changed', 'tool-missing', 'workspace-gone'] as const;
    // A transport that echoes the request headers back in a tool error and in a JSON-RPC error, as a hostile server could.
    const echo = scriptedClient(token, (req) => ({ isError: true, content: [{ type: 'text', text: `bad ${JSON.stringify(req.headers)} Bearer ${token}` }] }));
    errors.push(await echo.callTool('clickup_get_task', { task_id: 'x' }).catch((e: unknown) => e));
    for (const s of scenarios) {
      f.setScenario(s);
      errors.push(await createMcpClient({ ...clickupEndpoint(f.url), transport: fetchTransport(), token, tools: CLICKUP_TOOLS, timeoutMs: 200 })
        .callTool('clickup_get_task', { task_id: '86fk0001a' }).catch((e: unknown) => e));
      errors.push(await known.callTool('clickup_get_task', { task_id: '86fk0001a' }).catch((e: unknown) => e));
    }
    expect(errors.length).toBeGreaterThan(10);
    for (const e of errors) {
      expect(e).toBeInstanceOf(ConnectorError);
      const err = e as Error;
      const all = [err.message, err.stack ?? '', String(err), JSON.stringify(err), String(err.cause ?? '')].join('\n');
      expect(all).not.toContain(token);
      expect(all).not.toContain('TOKEN-MUST-NOT-LEAK');
      expect(err.cause).toBeUndefined();
    }
  });
});

// ── Replies a real server could send that the fake doesn't: a scripted transport ───────────────────────────────────

type RpcResult = Record<string, unknown>;
/** A client over a transport that plays initialize itself and answers tools/call (and tools/list) with `answer`. */
function scriptedClient(token: string, answer: (req: HttpRequest, body: { id: number; method: string }) => RpcResult | HttpResponse, o: { sse?: boolean } = {}) {
  const t: Transport = async (req) => {
    const body = JSON.parse(req.body ?? '{}') as { id: number; method: string };
    if (body.method === 'notifications/initialized') return res(202, '');
    if (body.method === 'initialize') return json({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, serverInfo: { name: 's', version: '1' } } });
    const a = answer(req, body);
    if ('status' in a && typeof a.status === 'number' && 'body' in a) return a as HttpResponse;
    const reply = { jsonrpc: '2.0', id: body.id, result: a };
    return o.sse ? sseOf(`event: message\ndata: ${JSON.stringify(reply)}\n\n`) : json(reply);
  };
  return createMcpClient({ mcpUrl: 'https://mcp.clickup.com/mcp', allow: originAllow('https://mcp.clickup.com'), transport: t, token, tools: CLICKUP_TOOLS });
}
const res = (status: number, text: string, headers: Record<string, string> = {}): HttpResponse => ({
  status, headers, location: null, close: () => undefined, body: (async function* () { yield new TextEncoder().encode(text); })()
});
const json = (v: unknown, status = 200) => res(status, JSON.stringify(v), { 'content-type': 'application/json' });
const sseOf = (text: string) => res(200, text, { 'content-type': 'text/event-stream' });
const text = (data: unknown): RpcResult => ({ content: [{ type: 'text', text: JSON.stringify(data) }] });

describe('protocol details', () => {
  test('SSE: other events (notifications, pings, comments, CRLF) are skipped; the reply with our id wins', async () => {
    const c = scriptedClient('t', (_r, b) => sseOf([
      ': keep-alive', '',
      'event: message', 'data: {"jsonrpc":"2.0","method":"notifications/progress","params":{}}', '',
      'event: message', `data: {"jsonrpc":"2.0","id":${b.id + 1000},"result":{}}`, '',
      'event: message', 'data: {"jsonrpc":"2.0",', `data: "id":${b.id},"result":${JSON.stringify(text({ userIds: ['1'] }))}}`, ''
    ].join('\r\n')));
    await expect(c.callTool('clickup_resolve_assignees', { assignees: ['me'] })).resolves.toEqual({ userIds: ['1'] });
  });

  test('a reply with another id, no reply in the stream, or a non-JSON body → SchemaChanged', async () => {
    for (const make of [
      (b: { id: number }) => json({ jsonrpc: '2.0', id: b.id + 1, result: text({ userIds: [] }) }),
      () => sseOf('event: message\ndata: {"jsonrpc":"2.0","method":"ping"}\n\n'),
      () => res(200, '<html>maintenance</html>', { 'content-type': 'text/html' }),
      () => json('not an object')
    ]) {
      const c = scriptedClient('t', (_r, b) => make(b));
      await expect(c.callTool('clickup_resolve_assignees', { assignees: ['me'] })).rejects.toBeInstanceOf(SchemaChanged);
    }
  });

  test('a JSON-RPC error → SchemaChanged (unknown tool, invalid params)', async () => {
    const c = scriptedClient('t', (_r, b) => json({ jsonrpc: '2.0', id: b.id, error: { code: -32602, message: 'Unknown tool' } }));
    await expect(c.callTool('clickup_get_task', { task_id: 'x' })).rejects.toBeInstanceOf(SchemaChanged);
  });

  test('a server that speaks another protocol version → SchemaChanged', async () => {
    const t: Transport = async (req) => {
      const b = JSON.parse(req.body ?? '{}') as { id: number };
      return json({ jsonrpc: '2.0', id: b.id, result: { protocolVersion: '2024-11-05', capabilities: {} } });
    };
    const c = createMcpClient({ mcpUrl: 'https://mcp.clickup.com/mcp', allow: originAllow('https://mcp.clickup.com'), transport: t, token: 't', tools: CLICKUP_TOOLS });
    await expect(c.callTool('clickup_resolve_assignees', { assignees: ['me'] })).rejects.toBeInstanceOf(SchemaChanged);
  });

  test('a session id from initialize is sent back on later requests', async () => {
    const seen: HttpRequest[] = [];
    const t: Transport = async (req) => {
      seen.push(req);
      const b = JSON.parse(req.body ?? '{}') as { id: number; method: string };
      if (b.method === 'notifications/initialized') return res(202, '');
      if (b.method === 'initialize') return res(200, JSON.stringify({ jsonrpc: '2.0', id: b.id, result: { protocolVersion: MCP_PROTOCOL_VERSION } }), { 'content-type': 'application/json', 'mcp-session-id': 'sess-1' });
      return json({ jsonrpc: '2.0', id: b.id, result: text({ userIds: ['7'] }) });
    };
    const c = createMcpClient({ mcpUrl: 'https://mcp.clickup.com/mcp', allow: originAllow('https://mcp.clickup.com'), transport: t, token: 't', tools: CLICKUP_TOOLS });
    await c.callTool('clickup_resolve_assignees', { assignees: ['me'] });
    expect(seen[0]!.headers?.['mcp-session-id']).toBeUndefined();
    expect(seen.slice(1).map((r) => r.headers?.['mcp-session-id'])).toEqual(['sess-1', 'sess-1']);
  });

  test('an ended session (404 to a request carrying its id) starts a new one and retries once', async () => {
    const seen: string[] = [];
    let sessions = 0;
    let expireNext = true;
    const t: Transport = async (req) => {
      const b = JSON.parse(req.body ?? '{}') as { id: number; method: string };
      seen.push(`${b.method} ${req.headers?.['mcp-session-id'] ?? '-'}`);
      if (b.method === 'initialize') {
        sessions++;
        return res(200, JSON.stringify({ jsonrpc: '2.0', id: b.id, result: { protocolVersion: MCP_PROTOCOL_VERSION } }), { 'content-type': 'application/json', 'mcp-session-id': `s${sessions}` });
      }
      if (b.method === 'notifications/initialized') return res(202, '');
      if (expireNext && req.headers?.['mcp-session-id'] === 's1' && seen.length > 3) { expireNext = false; return json({ error: 'session not found' }, 404); }
      return json({ jsonrpc: '2.0', id: b.id, result: text({ userIds: ['7'] }) });
    };
    const c = createMcpClient({ mcpUrl: 'https://mcp.clickup.com/mcp', allow: originAllow('https://mcp.clickup.com'), transport: t, token: 't', tools: CLICKUP_TOOLS });
    await c.callTool('clickup_resolve_assignees', { assignees: ['me'] });
    await expect(c.callTool('clickup_resolve_assignees', { assignees: ['me'] })).resolves.toEqual({ userIds: ['7'] });
    expect(seen).toEqual([
      'initialize -', 'notifications/initialized s1', 'tools/call s1',
      'tools/call s1', 'initialize -', 'notifications/initialized s2', 'tools/call s2'
    ]);
  });

  test('a session that ends again right away → SchemaChanged (no retry loop)', async () => {
    let requests = 0;
    const t: Transport = async (req) => {
      requests++;
      const b = JSON.parse(req.body ?? '{}') as { id: number; method: string };
      if (b.method === 'initialize') return res(200, JSON.stringify({ jsonrpc: '2.0', id: b.id, result: { protocolVersion: MCP_PROTOCOL_VERSION } }), { 'content-type': 'application/json', 'mcp-session-id': 's' });
      return json({ error: 'session not found' }, 404);
    };
    const c = createMcpClient({ mcpUrl: 'https://mcp.clickup.com/mcp', allow: originAllow('https://mcp.clickup.com'), transport: t, token: 't', tools: CLICKUP_TOOLS });
    await expect(c.callTool('clickup_search', { keywords: 'a' })).rejects.toBeInstanceOf(SchemaChanged);
    expect(requests).toBe(4); // initialize + notification, twice
  });

  test('ToolError text is ClickUp\'s, without control characters or credentials, clipped to 200 characters', async () => {
    const token = 'fkat_secret_9';
    const c = scriptedClient(token, () => ({ isError: true, content: [{ type: 'text', text: `Oops\u001b[31m Bearer abc.def ${token} access_token=zzz ${'x'.repeat(500)}` }] }));
    const err = (await c.callTool('clickup_search', { keywords: 'a' }).catch((e: unknown) => e)) as ToolError;
    expect(err).toBeInstanceOf(ToolError);
    expect(err.text.length).toBeLessThanOrEqual(200);
    expect(err.text).not.toMatch(/[\u0000-\u001f\u007f]/);
    for (const s of [token, 'abc.def', 'zzz']) expect(err.message + err.text).not.toContain(s);
    expect(err.text.startsWith('Oops[31m Bearer …')).toBe(true);
  });

  test('a tool result without text content but with structuredContent is read from structuredContent', async () => {
    const c = scriptedClient('t', () => ({ content: [], structuredContent: { userIds: [42] } }));
    await expect(c.callTool('clickup_resolve_assignees', { assignees: ['me'] })).resolves.toEqual({ userIds: ['42'] });
  });

  test('a non-401/403/429/5xx HTTP failure (400, 404, 406) → SchemaChanged', async () => {
    for (const status of [400, 404, 406]) {
      const c = scriptedClient('t', () => json({ error: 'x' }, status));
      await expect(c.callTool('clickup_search', { keywords: 'a' }), String(status)).rejects.toBeInstanceOf(SchemaChanged);
    }
  });
});

describe('rateLimitResetAt', () => {
  const now = 1_800_000_000_000;
  test.each([
    ['30 s ahead (unix seconds)', String(now / 1000 + 30), now + 30_000],
    ['an hour ahead: capped at 5 minutes', String(now / 1000 + 3600), now + MAX_RATE_LIMIT_WAIT_MS],
    // A reset already past (the Mac's clock ahead of the server's) would retry at once, again and again: 5 s at least.
    ['in the past: the 5 s floor', String(now / 1000 - 10), now + MIN_RATE_LIMIT_WAIT_MS],
    ['a small number is seconds from now (no epoch is that small)', '20', now + 20_000],
    ['zero: the 5 s floor', '0', now + MIN_RATE_LIMIT_WAIT_MS],
    ['missing: one minute', undefined, now + 60_000],
    ['garbage: one minute', 'soon', now + 60_000],
    ['fractional seconds', String(now / 1000 + 12.5), now + 12_500]
  ])('%s', (_l, header, expected) => {
    expect(rateLimitResetAt(header, now)).toBe(expected);
  });
});

describe('reply schemas (lenient: unknown fields ignored, unconfirmed fields optional)', () => {
  test('resolve_assignees: ids as strings (numbers accepted); no userIds → SchemaChanged', () => {
    expect(CLICKUP_TOOLS.parseReply('clickup_resolve_assignees', { userIds: ['81000001', 7], extra: true })).toEqual({ userIds: ['81000001', '7'] });
    expect(() => CLICKUP_TOOLS.parseReply('clickup_resolve_assignees', { assignees: [] })).toThrow(SchemaChanged);
  });

  test('filter_tasks: only id and name are core; a malformed optional field is dropped, not fatal', () => {
    const r = CLICKUP_TOOLS.parseReply('clickup_filter_tasks', {
      tasks: [
        { id: 86, name: 'Numeric id', status: 'weird', priority: 3, due_date: { at: 1 }, list: 'L', unknown: [1] },
        { id: 'a1', name: 'Full', custom_id: 'ENG-1', status: { status: 'open', color: '#abcdef', type: 'open' }, url: 'https://app.clickup.com/t/a1',
          priority: { priority: 'high' }, due_date: '1790000000000', date_updated: 1790000000001, list: { id: '9', name: 'Sprint' } }
      ],
      has_more: false
    });
    // A string status is no longer malformed: it is ClickUp's compact shape since October 2026 (the name alone).
    expect(r.tasks[0]).toEqual({ id: '86', name: 'Numeric id', status: { status: 'weird' } });
    expect(r.tasks[1]).toMatchObject({ id: 'a1', custom_id: 'ENG-1', status: { status: 'open', color: '#abcdef' }, priority: { priority: 'high' },
      due_date: '1790000000000', date_updated: 1790000000001, list: { name: 'Sprint' } });
    expect(r.has_more).toBe(false);
    expect(() => CLICKUP_TOOLS.parseReply('clickup_filter_tasks', { tasks: [{ name: 'no id' }] })).toThrow(SchemaChanged);
    expect(() => CLICKUP_TOOLS.parseReply('clickup_filter_tasks', { tasks: [{ id: '1' }] })).toThrow(SchemaChanged);
    expect(() => CLICKUP_TOOLS.parseReply('clickup_filter_tasks', { items: [] })).toThrow(SchemaChanged);
  });

  test('get_task: detail fields optional; counts and parent kept when present', () => {
    expect(CLICKUP_TOOLS.parseReply('clickup_get_task', { id: 'a', name: 'n' })).toEqual({ id: 'a', name: 'n' });
    expect(CLICKUP_TOOLS.parseReply('clickup_get_task', { id: 'a', name: 'n', markdown_description: '# x', text_content: 'x', parent: 'p', counts: { subtasks: 2, odd: 'y' } }))
      .toMatchObject({ markdown_description: '# x', text_content: 'x', parent: 'p', counts: { subtasks: 2 } });
    expect(() => CLICKUP_TOOLS.parseReply('clickup_get_task', { name: 'n' })).toThrow(SchemaChanged);
  });

  test('get_workspace_hierarchy: the confirmed shape; root id and name are core', () => {
    const r = CLICKUP_TOOLS.parseReply('clickup_get_workspace_hierarchy', {
      hierarchy: { root: { id: 9, name: 'Workspace', children: [{ id: '1', name: 'S', type: 'space', children: [{ id: '2', name: 'L', type: 'list', children: [] }] }] } },
      next_cursor: null, has_more: false, total_spaces: 1
    });
    expect(r.hierarchy.root).toMatchObject({ id: '9', name: 'Workspace' });
    expect(r.hierarchy.root.children?.[0]?.children?.[0]).toMatchObject({ id: '2', type: 'list' });
    expect(() => CLICKUP_TOOLS.parseReply('clickup_get_workspace_hierarchy', { hierarchy: { root: { name: 'x' } } })).toThrow(SchemaChanged);
    expect(() => CLICKUP_TOOLS.parseReply('clickup_get_workspace_hierarchy', { workspaces: [] })).toThrow(SchemaChanged);
  });

  test('search (shape assumed): non-task and malformed results are skipped, never fatal; only an unknown outer shape → SchemaChanged', () => {
    const r = CLICKUP_TOOLS.parseReply('clickup_search', { results: [{ type: 'doc', id: 'd', title: 'Doc' }, { type: 'task', id: 't', name: 'T', custom_id: 'E-1' }, { id: 'u', name: 'U' }, 'junk'], count: 4 });
    expect(r.results).toEqual([{ type: 'task', id: 't', name: 'T', custom_id: 'E-1' }, { id: 'u', name: 'U' }]);
    expect(CLICKUP_TOOLS.parseReply('clickup_search', { results: [{ type: 'task', id: 'x' }] }).results).toEqual([]);
    expect(CLICKUP_TOOLS.parseReply('clickup_search', { results: [{ name: 'no id' }, { id: 'bad\u0007id', name: 'B' }, { id: 'ok', name: 'OK' }] }).results)
      .toEqual([{ id: 'ok', name: 'OK' }]);
    expect(() => CLICKUP_TOOLS.parseReply('clickup_search', { hits: [] })).toThrow(SchemaChanged);
    expect(() => CLICKUP_TOOLS.parseReply('clickup_search', { results: 'none' })).toThrow(SchemaChanged);
  });

  describe('ids are plain [A-Za-z0-9_-]{1,64} (they reach the renderer, the session name and the prompt)', () => {
    const BAD = [['a control character', 'abc\u0007'], ['a newline', 'abc\ndef'], ['a bidi override', 'abc\u202edef'],
      ['a zero-width space', 'ab\u200bc'], ['a space', 'ab c'], ['a slash', 'a/b'], ['65 characters', 'a'.repeat(65)], ['empty', '']] as const;

    test('the fake\'s ids and custom ids, and ClickUp-like ones, pass', () => {
      for (const t of makeFixtures().tasks) {
        expect(CLICKUP_TOOLS.parseReply('clickup_get_task', t)).toMatchObject({ id: t.id, custom_id: t.custom_id });
        if (t.parent) expect(CLICKUP_TOOLS.parseReply('clickup_get_task', t).parent).toBe(t.parent);
      }
      for (const ok of ['86fk0001a', '901500000301', 'DEV-1234', 'a_b-C', 'a'.repeat(64)]) expect(CLICKUP_TOOLS.parseReply('clickup_get_task', { id: ok, name: 'n' }).id).toBe(ok);
      expect(CLICKUP_TOOLS.parseReply('clickup_get_task', { id: 81000001, name: 'n' }).id).toBe('81000001');
    });

    test.each(BAD)('get_task with %s in its id → SchemaChanged', (_l, bad) => {
      expect(() => CLICKUP_TOOLS.parseReply('clickup_get_task', { id: bad, name: 'n' })).toThrow(SchemaChanged);
    });

    test.each(BAD)('filter_tasks: a task with %s in its id is skipped, the others kept', (_l, bad) => {
      const r = CLICKUP_TOOLS.parseReply('clickup_filter_tasks', { tasks: [{ id: bad, name: 'Bad' }, { id: 'good1', name: 'Good' }] });
      expect(r.tasks.map((t) => t.id)).toEqual(['good1']);
    });

    test.each(BAD)('a parent with %s is dropped (the task stays)', (_l, bad) => {
      const t = CLICKUP_TOOLS.parseReply('clickup_get_task', { id: 'a', name: 'n', parent: bad });
      expect(t.id).toBe('a');
      expect(t.parent).toBeUndefined();
    });

    test('resolve_assignees and hierarchy ids follow the same rule', () => {
      expect(() => CLICKUP_TOOLS.parseReply('clickup_resolve_assignees', { userIds: ['1\u202e2'] })).toThrow(SchemaChanged);
      expect(() => CLICKUP_TOOLS.parseReply('clickup_get_workspace_hierarchy', { hierarchy: { root: { id: 'w\n1', name: 'W' } } })).toThrow(SchemaChanged);
      const tree = CLICKUP_TOOLS.parseReply('clickup_get_workspace_hierarchy', { hierarchy: { root: { id: 'w1', name: 'W', children: [{ id: 'x y', name: 'Bad' }, { id: 's1', name: 'S' }] } } });
      expect(tree.hierarchy.root.children?.map((c) => c.id)).toEqual(['s1']);
    });
  });
});
