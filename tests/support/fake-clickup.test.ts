import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { startFakeClickUp, type FakeClickUp, type FakeHierarchyNode } from '../fixtures/fake-clickup.mjs';
import { createRunTemp, removeRunTemp } from './temp-root';

// The fake ClickUp every connector test talks to: these tests pin the behaviors later tests rely on (PKCE, one-shot
// codes, the tools/call log, scenario switches), so a broken fake fails here and not as a puzzling connector failure.

let fake: FakeClickUp | undefined;
let temp: { dir: string; base: string } | undefined;
afterEach(async () => {
  await fake?.close(); fake = undefined;
  if (temp) { removeRunTemp(temp.dir, temp.base); temp = undefined; }
});

/** A private temp dir (atl-run-XXXXXX inside the run's root), removed in afterEach. TMPDIR is left as it was. */
function privateTemp(): string {
  const saved = process.env.TMPDIR;
  const base = tmpdir();
  const dir = createRunTemp(base);
  if (saved === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = saved;
  temp = { dir, base };
  return dir;
}

const MCP_HEADERS = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
const b64url = (b: Buffer): string => b.toString('base64url');

async function authorize(f: FakeClickUp, verifier: string): Promise<{ code: string; redirectUri: string; clientId: string; location: URL }> {
  const redirectUri = 'http://127.0.0.1:1/callback/abc';
  const reg = await fetch(`${f.url}/oauth/register`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_name: 'Atelier', redirect_uris: [redirectUri], token_endpoint_auth_method: 'none' })
  });
  expect(reg.status).toBe(200);
  const { client_id: clientId } = await reg.json() as { client_id: string };
  const q = new URLSearchParams({
    response_type: 'code', client_id: clientId, redirect_uri: redirectUri, scope: 'read', state: 'st-1',
    code_challenge: b64url(createHash('sha256').update(verifier).digest()), code_challenge_method: 'S256',
    resource: `${f.url}/mcp`
  });
  const res = await fetch(`${f.url}/oauth/authorize?${q}`, { redirect: 'manual' });
  expect(res.status).toBe(302);
  const location = new URL(res.headers.get('location')!);
  return { code: location.searchParams.get('code') ?? '', redirectUri, clientId, location };
}

function exchange(f: FakeClickUp, a: { code: string; redirectUri: string; clientId: string }, verifier: string): Promise<Response> {
  return fetch(`${f.url}/oauth/token`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code', code: a.code, redirect_uri: a.redirectUri, client_id: a.clientId,
      code_verifier: verifier, resource: `${f.url}/mcp`
    })
  });
}

function rpc(f: FakeClickUp, token: string, method: string, params?: unknown, id: number | null = 1): Promise<Response> {
  return fetch(`${f.url}/mcp`, {
    method: 'POST', headers: { ...MCP_HEADERS, authorization: `Bearer ${token}` },
    body: JSON.stringify(id === null ? { jsonrpc: '2.0', method, params } : { jsonrpc: '2.0', id, method, params })
  });
}

async function toolJson(res: Response): Promise<unknown> {
  const body = await res.json() as { result: { content: { type: string; text: string }[] } };
  return JSON.parse(body.result.content[0]!.text);
}

describe('fake ClickUp: OAuth', () => {
  it('advertises S256, DCR and public clients with its own issuer', async () => {
    fake = await startFakeClickUp();
    const meta = await (await fetch(`${fake.url}/.well-known/oauth-authorization-server`)).json() as Record<string, unknown>;
    expect(meta.issuer).toBe(fake.url);
    expect(meta.registration_endpoint).toBe(`${fake.url}/oauth/register`);
    expect(meta.code_challenge_methods_supported).toEqual(['S256']);
    expect(meta.token_endpoint_auth_methods_supported).toEqual(['none']);
    fake.setScenario('discovery-no-dcr');
    const noDcr = await (await fetch(`${fake.url}/.well-known/oauth-authorization-server`)).json() as Record<string, unknown>;
    expect(noDcr.registration_endpoint).toBeUndefined();
    fake.setScenario('discovery-no-s256');
    const noS256 = await (await fetch(`${fake.url}/.well-known/oauth-authorization-server`)).json() as Record<string, unknown>;
    expect(noS256.code_challenge_methods_supported).not.toContain('S256');
  });

  it('auto-approves with code, state and iss, and issues a token for the right PKCE verifier', async () => {
    fake = await startFakeClickUp();
    const verifier = b64url(randomBytes(32));
    const a = await authorize(fake, verifier);
    expect(a.location.searchParams.get('state')).toBe('st-1');
    expect(a.location.searchParams.get('iss')).toBe(fake.url);
    const res = await exchange(fake, a, verifier);
    expect(res.status).toBe(200);
    const tok = await res.json() as Record<string, unknown>;
    expect(tok).toMatchObject({ token_type: 'Bearer', expires_in: 315360000, scope: 'read write' });
    expect(typeof tok.access_token).toBe('string');
    expect((await rpc(fake, tok.access_token as string, 'tools/list')).status).toBe(200);
  });

  it('refuses a wrong PKCE verifier', async () => {
    fake = await startFakeClickUp();
    const a = await authorize(fake, b64url(randomBytes(32)));
    const res = await exchange(fake, a, b64url(randomBytes(32)));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'invalid_grant' });
  });

  it('accepts a code only once', async () => {
    fake = await startFakeClickUp();
    const verifier = b64url(randomBytes(32));
    const a = await authorize(fake, verifier);
    expect((await exchange(fake, a, verifier)).status).toBe(200);
    const again = await exchange(fake, a, verifier);
    expect(again.status).toBe(400);
    expect(await again.json()).toMatchObject({ error: 'invalid_grant' });
  });

  it('redirects with error=access_denied in the authorize-denied scenario', async () => {
    fake = await startFakeClickUp({ scenario: 'authorize-denied' });
    const a = await authorize(fake, 'v'.repeat(43));
    expect(a.code).toBe('');
    expect(a.location.searchParams.get('error')).toBe('access_denied');
    expect(a.location.searchParams.get('state')).toBe('st-1');
  });
});

describe('fake ClickUp: MCP', () => {
  it('requires a Bearer token it issued', async () => {
    fake = await startFakeClickUp();
    expect((await rpc(fake, 'nope', 'tools/list')).status).toBe(401);
    expect((await rpc(fake, fake.issueToken(), 'tools/list')).status).toBe(200);
  });

  it('lists the six read tools as read-only and write tools as not', async () => {
    fake = await startFakeClickUp();
    const body = await (await rpc(fake, fake.issueToken(), 'tools/list')).json() as
      { result: { tools: { name: string; annotations: { readOnlyHint: boolean } }[] } };
    const ro = body.result.tools.filter((t) => t.annotations.readOnlyHint).map((t) => t.name).sort();
    expect(ro).toEqual(['clickup_filter_tasks', 'clickup_get_list', 'clickup_get_task', 'clickup_get_workspace_hierarchy',
      'clickup_resolve_assignees', 'clickup_search']);
    expect(body.result.tools.map((t) => t.name)).toContain('clickup_update_task');
  });

  it('answers initialize and takes notifications with 202', async () => {
    fake = await startFakeClickUp();
    const token = fake.issueToken();
    const init = await (await rpc(fake, token, 'initialize', { protocolVersion: '2025-06-18', capabilities: {},
      clientInfo: { name: 't', version: '1' } })).json() as { result: { protocolVersion: string } };
    expect(init.result.protocolVersion).toBe('2025-06-18');
    const note = await rpc(fake, token, 'notifications/initialized', undefined, null);
    expect(note.status).toBe(202);
    expect(await note.text()).toBe('');
  });

  it('logs every tools/call name, write tools included, in memory and in the log file', async () => {
    const logFile = join(privateTemp(), 'calls.log');
    fake = await startFakeClickUp({ logFile });
    const token = fake.issueToken();
    const me = await toolJson(await rpc(fake, token, 'tools/call', { name: 'clickup_resolve_assignees', arguments: { assignees: ['me'] } }));
    // Confirmed real shape: ids only, as digit strings, no name or email.
    expect(me).toEqual({ userIds: [String(fake.fixtures.user.id)] });
    await rpc(fake, token, 'tools/call', { name: 'clickup_update_task', arguments: { task_id: 'x' } });
    expect(fake.calls()).toEqual(['clickup_resolve_assignees', 'clickup_update_task']);
    expect(readFileSync(logFile, 'utf8').trim().split('\n')).toEqual(['clickup_resolve_assignees', 'clickup_update_task']);
  });

  it('serves tasks shaped like the real replies, and an error for a task that is gone', async () => {
    fake = await startFakeClickUp();
    const token = fake.issueToken();
    const list = await toolJson(await rpc(fake, token, 'tools/call', { name: 'clickup_filter_tasks',
      arguments: { assignees: [fake.fixtures.user.id], order_by: 'updated' } })) as
      { tasks: Record<string, unknown>[]; count: number; page: number; has_more: boolean };
    expect(list.count).toBe(list.tasks.length);
    expect(list.has_more).toBe(false);
    expect(Object.keys(list.tasks[0]!)).toEqual(expect.arrayContaining(['id', 'custom_id', 'name', 'status', 'url',
      'priority', 'assignees', 'tags', 'due_date', 'date_updated', 'date_closed', 'list']));
    const detail = await toolJson(await rpc(fake, token, 'tools/call', { name: 'clickup_get_task',
      arguments: { task_id: fake.fixtures.ids.fenced } })) as { markdown_description: string };
    expect(detail.markdown_description).toContain('```');
    const gone = await (await rpc(fake, token, 'tools/call', { name: 'clickup_get_task',
      arguments: { task_id: fake.fixtures.ids.gone } })).json() as { result: { isError: boolean } };
    expect(gone.result.isError).toBe(true);
  });

  it('returns the workspace hierarchy in the confirmed root/children shape, honouring max_depth', async () => {
    fake = await startFakeClickUp();
    const token = fake.issueToken();
    type H = { hierarchy: { root: { id: string; name: string; children: FakeHierarchyNode[] } };
      next_cursor: null; has_more: boolean; total_spaces: number };
    const hier = async (args: object): Promise<H> =>
      await toolJson(await rpc(fake!, token, 'tools/call', { name: 'clickup_get_workspace_hierarchy', arguments: args })) as H;
    const full = await hier({});
    expect(Object.keys(full).sort()).toEqual(['has_more', 'hierarchy', 'next_cursor', 'total_spaces']);
    expect(full).toMatchObject({ next_cursor: null, has_more: false, total_spaces: full.hierarchy.root.children.length });
    expect(full.hierarchy.root).toMatchObject({ id: fake.fixtures.workspace.id, name: fake.fixtures.workspace.name });
    const space = full.hierarchy.root.children[0]!;
    expect(space.type).toBe('space');
    const folder = space.children.find((c) => c.type === 'folder')!;
    expect(folder.children.length).toBeGreaterThan(0);
    expect(folder.children.every((l) => l.type === 'list' && Array.isArray(l.children) && l.children.length === 0)).toBe(true);
    expect(space.children.some((c) => c.type === 'list')).toBe(true); // a folderless list hangs off the space
    expect(Object.keys(space).sort()).toEqual(['children', 'id', 'name', 'type']);
    expect(await hier({ max_depth: '2' })).toEqual(full);
    const one = await hier({ max_depth: '1' });
    expect(one.hierarchy.root.children[0]!.children.find((c) => c.type === 'folder')!.children).toEqual([]);
    const zero = await hier({ max_depth: '0' });
    expect(zero.hierarchy.root.children[0]!.children).toEqual([]);
    expect(zero.total_spaces).toBe(full.total_spaces);
  });

  it('replies as an SSE stream when asked', async () => {
    fake = await startFakeClickUp({ sse: true });
    const res = await rpc(fake, fake.issueToken(), 'tools/list');
    expect(res.headers.get('content-type')).toMatch(/^text\/event-stream/);
    const text = await res.text();
    const data = text.split('\n').find((l) => l.startsWith('data: '))!.slice(6);
    expect(JSON.parse(data)).toMatchObject({ jsonrpc: '2.0', id: 1 });
  });
});

describe('fake ClickUp: scenarios', () => {
  it('switches through the control endpoint and in-process', async () => {
    fake = await startFakeClickUp();
    const token = fake.issueToken();
    const sw = await fetch(`${fake.url}/__scenario`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'mcp-401' }) });
    expect(sw.status).toBe(200);
    expect((await rpc(fake, token, 'tools/list')).status).toBe(401);
    fake.setScenario('mcp-500');
    expect((await rpc(fake, token, 'tools/list')).status).toBe(500);
    fake.setScenario('mcp-429', { resetInSeconds: 30 });
    const limited = await rpc(fake, token, 'tools/list');
    expect(limited.status).toBe(429);
    const reset = Number(limited.headers.get('x-ratelimit-reset'));
    expect(reset - Math.floor(Date.now() / 1000)).toBeGreaterThanOrEqual(29);
    fake.setScenario('normal');
    expect((await rpc(fake, token, 'tools/list')).status).toBe(200);
    expect(() => fake!.setScenario('no-such-scenario' as never)).toThrow();
  });

  it('answers workspace-scoped calls with a tool error when the workspace is gone, or a 403 in the -403 variant', async () => {
    fake = await startFakeClickUp({ scenario: 'workspace-gone' });
    const token = fake.issueToken();
    for (const name of ['clickup_get_workspace_hierarchy', 'clickup_filter_tasks', 'clickup_get_task']) {
      const r = await (await rpc(fake, token, 'tools/call', { name, arguments: { task_id: fake.fixtures.ids.fenced } })).json() as
        { result: { isError?: boolean } };
      expect(r.result.isError, name).toBe(true);
    }
    fake.setScenario('workspace-gone-403');
    expect((await rpc(fake, token, 'tools/list')).status).toBe(200);
    expect((await rpc(fake, token, 'tools/call', { name: 'clickup_get_workspace_hierarchy', arguments: {} })).status).toBe(403);
    expect(() => fake!.setScenario('two-workspaces' as never)).toThrow();
  });

  it('task-gone: the task is still listed, but getting it says "Task not found" (deleted after the list was fetched)', async () => {
    fake = await startFakeClickUp({ scenario: 'task-gone', scenarioOptions: { taskId: '86fk0001a' } });
    const token = fake.issueToken();
    const list = await toolJson(await rpc(fake, token, 'tools/call', { name: 'clickup_filter_tasks', arguments: {} })) as { tasks: { id: string }[] };
    expect(list.tasks.map((t) => t.id)).toContain('86fk0001a');
    const gone = await (await rpc(fake, token, 'tools/call', { name: 'clickup_get_task', arguments: { task_id: '86fk0001a' } })).json() as
      { result: { isError?: boolean; content: { text: string }[] } };
    expect(gone.result.isError).toBe(true);
    expect(gone.result.content[0]!.text).toBe('Task not found: 86fk0001a');
    // The custom id finds nothing either; other tasks still come.
    const byCustom = await (await rpc(fake, token, 'tools/call', { name: 'clickup_get_task', arguments: { task_id: 'ENG-101' } })).json() as { result: { isError?: boolean } };
    expect(byCustom.result.isError).toBe(true);
    const other = await toolJson(await rpc(fake, token, 'tools/call', { name: 'clickup_get_task', arguments: { task_id: '86fk0003c' } })) as { id: string };
    expect(other.id).toBe('86fk0003c');
  });

  it('drops clickup_get_task from tools/list in the tool-missing scenario', async () => {
    fake = await startFakeClickUp({ scenario: 'tool-missing' });
    const tools = await (await rpc(fake, fake.issueToken(), 'tools/list')).json() as { result: { tools: { name: string }[] } };
    expect(tools.result.tools.map((t) => t.name)).not.toContain('clickup_get_task');
  });

  it('strips ids and names from tool replies in the schema-changed scenario', async () => {
    fake = await startFakeClickUp({ scenario: 'schema-changed' });
    const list = await toolJson(await rpc(fake, fake.issueToken(), 'tools/call', { name: 'clickup_filter_tasks', arguments: {} })) as
      { tasks: Record<string, unknown>[] };
    expect(list.tasks.length).toBeGreaterThan(0);
    for (const t of list.tasks) { expect(t).not.toHaveProperty('id'); expect(t).not.toHaveProperty('name'); }
  });

  it('refuses every issued token after /__revoke, and accepts a new one', async () => {
    fake = await startFakeClickUp();
    const token = fake.issueToken();
    expect((await rpc(fake, token, 'tools/list')).status).toBe(200);
    expect((await fetch(`${fake.url}/__revoke`, { method: 'POST' })).status).toBe(200);
    expect((await rpc(fake, token, 'tools/list')).status).toBe(401);
    expect((await rpc(fake, fake.issueToken(), 'tools/list')).status).toBe(200);
  });

  it('sends a reply over 4 MB in the oversized scenario', async () => {
    fake = await startFakeClickUp({ scenario: 'oversized' });
    const res = await rpc(fake, fake.issueToken(), 'tools/call', { name: 'clickup_filter_tasks', arguments: {} });
    expect((await res.arrayBuffer()).byteLength).toBeGreaterThan(4 * 1024 * 1024);
  });

  it('never answers in the slow scenario, and close() still ends promptly', async () => {
    fake = await startFakeClickUp({ scenario: 'slow' });
    const pending = rpc(fake, fake.issueToken(), 'tools/list').then(() => 'answered', () => 'failed');
    const early = await Promise.race([pending, new Promise((r) => setTimeout(() => r('waiting'), 300))]);
    expect(early).toBe('waiting');
    const t0 = Date.now();
    await fake.close();
    fake = undefined;
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(await pending).toBe('failed');
  });
});
