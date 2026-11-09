import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, test, vi } from 'vitest';
import { runProbe, type ProbeSpawn } from './probe';

type Reply = (req: { id: string; subtype: string }, n: number) => object | null | 'silence' | 'slow';

/**
 * A fake `claude -p` speaking the control protocol: each request line gets `reply`'s answer (an object is the
 * control_response's `response`, null a control error, 'silence' nothing).
 */
function fakeClaude(reply: Reply, o: { exitOnEnd?: boolean; stderr?: string; exitCode?: number | null; slowMs?: number } = {}) {
  const child = new EventEmitter() as EventEmitter & { stdin: PassThrough; stdout: PassThrough; stderr: PassThrough; pid: number; exitCode: number | null; signalCode: string | null };
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.pid = 4242;
  child.exitCode = null;
  child.signalCode = null;
  const seen: string[] = [];
  let buf = '';
  let n = 0;
  child.stdin.on('data', (d: Buffer) => {
    buf += String(d);
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      const m = JSON.parse(line) as { request_id: string; request: { subtype: string } };
      seen.push(m.request.subtype);
      const r = reply({ id: m.request_id, subtype: m.request.subtype }, n++);
      if (r === 'silence') continue;
      if (r === 'slow') { setTimeout(() => child.stdout.write(`${JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id, response: {} } })}\n`), o.slowMs ?? 50); continue; }
      const response = r === null
        ? { subtype: 'error', request_id: m.request_id, error: `Unsupported control request subtype: ${m.request.subtype}` }
        : { subtype: 'success', request_id: m.request_id, response: r };
      setImmediate(() => child.stdout.write(`${JSON.stringify({ type: 'control_response', response })}\n`));
    }
  });
  if (o.stderr) setImmediate(() => child.stderr.write(o.stderr));
  if (o.exitOnEnd ?? true) child.stdin.on('finish', () => setImmediate(() => { child.exitCode = 0; child.emit('close', 0, null); }));
  if (o.exitCode !== undefined) setImmediate(() => { child.exitCode = o.exitCode ?? null; child.emit('close', o.exitCode, null); });
  const spawn = vi.fn(() => child) as unknown as ProbeSpawn & ReturnType<typeof vi.fn>;
  return { child, spawn, seen };
}

const USAGE = { categories: [{ id: 'messages', name: 'Messages', tokens: 10, kind: 'used' }], totalTokens: 10, maxTokens: 1000 };
const base = { claudeBin: '/bin/claude', args: ['-p'], cwd: '/p', env: { PATH: '/bin' }, pollMs: 1 };

describe('runProbe', () => {
  test('initialize, mcp_status until nothing is pending, then get_context_usage; progress on the way; stdin closed and the group killed', async () => {
    let polls = 0;
    const { spawn, seen, child } = fakeClaude((r) => {
      if (r.subtype === 'initialize') return {};
      if (r.subtype === 'mcp_status') {
        polls++;
        return { mcpServers: [{ name: 'a', status: 'connected', scope: 'user' }, { name: 'b', status: polls < 3 ? 'pending' : 'connected', scope: 'project', config: { url: 'https://x' } }, { name: 'c', status: 'needs-auth', scope: 'claudeai' }] };
      }
      return USAGE;
    });
    const progress: unknown[] = [];
    const kill = vi.fn();
    const out = await runProbe({ ...base, spawn, kill, onProgress: (p) => progress.push(p) });
    expect(out).toEqual({ ok: true, usage: USAGE, status: [{ name: 'a', status: 'connected', scope: 'user' }, { name: 'b', status: 'connected', scope: 'project' }, { name: 'c', status: 'needs-auth', scope: 'claudeai' }] });
    expect(seen).toEqual(['initialize', 'mcp_status', 'mcp_status', 'mcp_status', 'get_context_usage']);
    expect(progress).toEqual([
      { phase: 'start' },
      { phase: 'mcp', connected: 1, total: 2 }, { phase: 'mcp', connected: 1, total: 2 }, { phase: 'mcp', connected: 2, total: 2 },
      { phase: 'count' }
    ]);
    expect(spawn).toHaveBeenCalledWith('/bin/claude', ['-p'], expect.objectContaining({ cwd: '/p', env: { PATH: '/bin' }, stdio: ['pipe', 'pipe', 'pipe'] }));
    expect(child.stdin.writableEnded).toBe(true);
    expect(kill).toHaveBeenCalledWith(child, 'SIGTERM');
  });

  test('servers still pending after the MCP wait: asked anyway, they stay pending (the view counts them as not connected)', async () => {
    const { spawn, seen } = fakeClaude((r) => (r.subtype === 'mcp_status' ? { mcpServers: [{ name: 'slow', status: 'pending' }] } : r.subtype === 'initialize' ? {} : USAGE));
    const out = await runProbe({ ...base, spawn, kill: () => {}, mcpWaitMs: 20 });
    expect(out).toMatchObject({ ok: true, status: [{ name: 'slow', status: 'pending', scope: null }] });
    expect(seen.at(-1)).toBe('get_context_usage');
  });

  test('a Claude Code without mcp_status still gets asked for the usage', async () => {
    const { spawn } = fakeClaude((r) => (r.subtype === 'mcp_status' ? null : r.subtype === 'initialize' ? {} : USAGE));
    expect(await runProbe({ ...base, spawn, kill: () => {} })).toMatchObject({ ok: true, status: [] });
  });

  test('get_context_usage refused: unsupported, with Claude Code\'s words', async () => {
    const { spawn } = fakeClaude((r) => (r.subtype === 'get_context_usage' ? null : r.subtype === 'initialize' ? {} : { mcpServers: [] }));
    expect(await runProbe({ ...base, spawn, kill: () => {} })).toEqual({ ok: false, kind: 'unsupported', message: 'Unsupported control request subtype: get_context_usage' });
  });

  test('claude ends first: its first stderr line', async () => {
    const { spawn } = fakeClaude(() => 'silence', { exitOnEnd: false, stderr: 'No conversation found with session ID: x\nmore\n', exitCode: 1 });
    // The stderr write and the close are both scheduled: give the stderr its turn first.
    const out = await runProbe({ ...base, spawn, kill: () => {} });
    expect(out).toMatchObject({ ok: false, kind: 'exit' });
    expect(['No conversation found with session ID: x', 'claude exited with 1']).toContain((out as { message: string }).message);
  });

  test('no answer in time: timeout, the group killed', async () => {
    const { spawn, child } = fakeClaude(() => 'silence', { exitOnEnd: false });
    const kill = vi.fn();
    expect(await runProbe({ ...base, spawn, kill, timeoutMs: 30 })).toEqual({ ok: false, kind: 'timeout', message: "Claude Code didn't answer in time" });
    expect(kill).toHaveBeenCalledWith(child, 'SIGKILL');
  });

  test('stopped (the app quits): killed, nothing more', async () => {
    const { spawn, child } = fakeClaude(() => 'silence', { exitOnEnd: false });
    const kill = vi.fn();
    const ac = new AbortController();
    const run = runProbe({ ...base, spawn, kill, signal: ac.signal });
    ac.abort();
    expect(await run).toEqual({ ok: false, kind: 'exit', message: 'Stopped' });
    expect(kill).toHaveBeenCalledWith(child, 'SIGKILL');
  });

  test('a line past the cap stops it', async () => {
    const { spawn, child } = fakeClaude(() => 'silence', { exitOnEnd: false });
    const kill = vi.fn();
    const run = runProbe({ ...base, spawn, kill, lineMax: 64 });
    child.stdout.write('x'.repeat(100));
    expect(await run).toEqual({ ok: false, kind: 'exit', message: 'Claude Code wrote too much' });
  });

  test('no claude binary: not-found', async () => {
    const spawn = (() => { const e = new Error('spawn ENOENT') as NodeJS.ErrnoException; e.code = 'ENOENT'; throw e; }) as unknown as ProbeSpawn;
    expect(await runProbe({ ...base, spawn, kill: () => {} })).toEqual({ ok: false, kind: 'not-found', message: 'Claude Code was not found' });
  });

  test('lines that are not control responses (or not JSON) are ignored', async () => {
    const { spawn, child } = fakeClaude((r) => (r.subtype === 'initialize' ? {} : r.subtype === 'mcp_status' ? { mcpServers: [] } : USAGE));
    setImmediate(() => child.stdout.write('not json\n{"type":"system","subtype":"init"}\n'));
    expect(await runProbe({ ...base, spawn, kill: () => {} })).toMatchObject({ ok: true });
  });
});

describe('runProbe: what it leaves behind, how long it waits', () => {
  test('after an answer the group gets SIGTERM, then SIGKILL after the grace even though claude itself exited (an MCP server may not)', async () => {
    const { spawn, child } = fakeClaude((r) => (r.subtype === 'initialize' ? {} : r.subtype === 'mcp_status' ? { mcpServers: [] } : USAGE));
    const kill = vi.fn();
    expect(await runProbe({ ...base, spawn, kill, graceMs: 5, platform: 'darwin' })).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(child.exitCode).toBe(0));
    await vi.waitFor(() => expect(kill.mock.calls.map((c) => c[1])).toEqual(['SIGTERM', 'SIGKILL']));
  });

  test('on Windows (taskkill /T /F already) no second kill once claude exited', async () => {
    const { spawn, child } = fakeClaude((r) => (r.subtype === 'initialize' ? {} : r.subtype === 'mcp_status' ? { mcpServers: [] } : USAGE));
    const kill = vi.fn();
    await runProbe({ ...base, spawn, kill, graceMs: 5, platform: 'win32' });
    await vi.waitFor(() => expect(child.exitCode).toBe(0));
    await new Promise((r) => setTimeout(r, 30));
    expect(kill.mock.calls.map((c) => c[1])).toEqual(['SIGTERM']);
  });

  test('the MCP wait starts when initialize answers (a slow start doesn\'t eat it)', async () => {
    let polls = 0;
    const { spawn } = fakeClaude((r) => {
      if (r.subtype === 'initialize') return 'slow';
      if (r.subtype === 'mcp_status') { polls++; return { mcpServers: [{ name: 'a', status: polls < 3 ? 'pending' : 'connected' }] }; }
      return USAGE;
    }, { slowMs: 80 });
    const out = await runProbe({ ...base, spawn, kill: () => {}, mcpWaitMs: 60, pollMs: 5 });
    expect(out).toMatchObject({ ok: true, status: [{ name: 'a', status: 'connected' }] });
  });
});
