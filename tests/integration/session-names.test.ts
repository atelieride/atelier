// Session name sync: atelierd hands a name given in Atelier to Claude in its reply to the hook.
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { runDaemon, type RunningDaemon } from '../../src/daemon/main';
import { installAtelierFiles } from '../../src/daemon/install';
import { connectControl, type TestClient } from './helpers';
import { daemonCapabilities, encode, type ServerMessage, type TerminalInfo } from '../../src/shared/protocol';

const running: RunningDaemon[] = [];
afterEach(async () => { for (const d of running.splice(0)) await d.stop(); });

const SID = '0b5c8f0e-1111-4222-8333-944455556666';

async function start(home = mkdtempSync(join(tmpdir(), 'atl-n-'))) {
  const d = await runDaemon({ home, version: 't', shellArgs: ['-f'], userClaudeSettings: join(home, 'x.json') });
  running.push(d);
  const c = await connectControl(d.paths.sock, d.info.token);
  const welcome = await c.next((m) => m.t === 'welcome');
  return { d, c, home, welcome };
}

async function create(c: TestClient, rid: number, extra: Record<string, unknown> = {}): Promise<TerminalInfo> {
  c.send({ t: 'create', rid, projectRoot: '/tmp', cwd: '/tmp', cols: 80, rows: 24, ...extra });
  return ((await c.next((m) => m.t === 'reply' && m.rid === rid)) as Extract<ServerMessage, { t: 'reply'; ok: true }>).result as TerminalInfo;
}

/** Sends a hook (or status) event the way the bridge does and returns everything atelierd wrote back. */
function send(d: RunningDaemon, term: string, payload: object, kind: 'hook' | 'status' = 'hook'): Promise<string> {
  return new Promise((resolve, reject) => {
    const s = net.createConnection(d.paths.sock);
    let out = '';
    s.setEncoding('utf8');
    s.on('data', (x: string) => { out += x; });
    s.on('error', reject);
    s.on('close', () => resolve(out));
    s.write(encode({ t: kind, token: d.hookToken, term }) + JSON.stringify(payload));
  });
}

const infoOf = (m: ServerMessage, id: string) => (m.t === 'terminals' ? m.list.find((x) => x.id === id) : undefined);
const prompt = (session_title?: string) => ({ hook_event_name: 'UserPromptSubmit', session_id: SID, prompt: 'go', ...(session_title ? { session_title } : {}) });

test('capability names', async () => {
  const { welcome } = await start();
  expect(daemonCapabilities(welcome)).toContain('names');
});

test('a rename in Atelier shows at once, reaches Claude with the next prompt and is confirmed by the status line', async () => {
  const { d, c } = await start();
  const term = await create(c, 1);
  expect(await send(d, term.id, { hook_event_name: 'SessionStart', session_id: SID, source: 'startup' })).toBe('');
  c.send({ t: 'rename', rid: 2, id: term.id, name: 'Login bug' });
  await c.next((m) => infoOf(m, term.id)?.title === 'Login bug' && infoOf(m, term.id)?.nameSync === 'pending');
  // Events that can't carry a title get no reply at all.
  expect(await send(d, term.id, { hook_event_name: 'PreToolUse', session_id: SID, tool_name: 'Read', tool_input: { file_path: '/p/a.ts' } })).toBe('');
  const out = await send(d, term.id, prompt('Old name'));
  expect(JSON.parse(out)).toEqual({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', sessionTitle: 'Login bug' } });
  await send(d, term.id, { session_id: SID, session_name: 'Login bug' }, 'status');
  const m = await c.next((x) => infoOf(x, term.id)?.title === 'Login bug' && infoOf(x, term.id)?.nameSync === undefined);
  expect(infoOf(m, term.id)?.name).toBe('Login bug');
  // Synced: never sent again.
  expect(await send(d, term.id, prompt('Login bug'))).toBe('');
  expect(await send(d, term.id, { hook_event_name: 'SessionStart', session_id: SID, source: 'compact', session_title: 'Login bug' })).toBe('');
});

test('right after a send, the next title Claude reports is its verdict (a variant of the name is adopted)', async () => {
  const { d, c } = await start();
  const term = await create(c, 1, { name: 'Login bug' });
  expect(await send(d, term.id, prompt())).toContain('Login bug');
  expect(await send(d, term.id, prompt('Login bug 2'))).toBe('');
  await c.next((m) => infoOf(m, term.id)?.title === 'Login bug 2' && infoOf(m, term.id)?.name === 'Login bug 2' && infoOf(m, term.id)?.nameSync === undefined);
});

test('a rename inside Claude shows in Atelier and becomes the terminal\'s name', async () => {
  const { d, c } = await start();
  const term = await create(c, 1, { name: 'Login bug' });
  // claude --name=…: SessionStart already reports it, nothing to send.
  expect(await send(d, term.id, { hook_event_name: 'SessionStart', session_id: SID, source: 'startup', session_title: 'Login bug' })).toBe('');
  await c.next((m) => infoOf(m, term.id)?.session?.title === 'Login bug' && infoOf(m, term.id)?.nameSync === undefined);
  await send(d, term.id, { session_id: SID, session_name: 'Auth flow' }, 'status');
  await c.next((m) => infoOf(m, term.id)?.title === 'Auth flow');
  expect(await send(d, term.id, prompt('Auth flow'))).toBe('');
  await c.next((m) => infoOf(m, term.id)?.name === 'Auth flow');
});

test('an unnamed session shows Claude\'s AI title from the status line, which may arrive after the first prompt', async () => {
  const { d, c } = await start();
  const term = await create(c, 1);
  expect(await send(d, term.id, prompt())).toBe('');
  await c.next((m) => infoOf(m, term.id)?.title === 'go');
  await send(d, term.id, { session_id: SID, session_name: 'Fix the login flow' }, 'status');
  await c.next((m) => infoOf(m, term.id)?.title === 'Fix the login flow');
});

test('Claude not taking the name (no custom title after the send): it stays an Atelier-only name, never sent again', async () => {
  const { d, c } = await start();
  const term = await create(c, 1, { name: 'Login bug' });
  expect(await send(d, term.id, prompt())).toContain('Login bug');
  expect(await send(d, term.id, prompt())).toBe('');
  await c.next((m) => infoOf(m, term.id)?.nameSync === 'kept' && infoOf(m, term.id)?.title === 'Login bug');
  expect(await send(d, term.id, prompt())).toBe('');
});

test('create with a label: shown until Claude reports a name, never sent to Claude', async () => {
  const { d, c } = await start();
  const term = await create(c, 1, { label: 'From history', command: 'claude --resume x' });
  expect(term.title).toBe('From history');
  expect(term.name).toBeNull();
  expect(await send(d, term.id, { hook_event_name: 'SessionStart', session_id: SID, source: 'resume' })).toBe('');
  await c.next((m) => infoOf(m, term.id)?.session?.sessionId === SID && infoOf(m, term.id)?.title === 'From history');
  await send(d, term.id, { session_id: SID, session_name: 'AI title' }, 'status');
  await c.next((m) => infoOf(m, term.id)?.title === 'AI title');
});

test('the bridge prints the reply to Claude and nothing for other events', async () => {
  const { d, c, home } = await start();
  const user = join(home, 'user-settings.json');
  writeFileSync(user, '{}');
  installAtelierFiles(d.paths, user);
  const term = await create(c, 1, { name: 'Login bug' });
  const env = { PATH: '/usr/bin:/bin', ATELIER_HOME: home, ATELIER_SOCK: d.paths.sock, ATELIER_HOOK_TOKEN: d.hookToken, ATELIER_TERMINAL_ID: term.id };
  // Asynchronous: atelierd runs in this process and must answer while the bridge waits.
  const run = (payload: object) => new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
    const p = spawn(join(d.paths.bin, 'atelier-hook'), { env });
    let stdout = '';
    let stderr = '';
    p.stdout.setEncoding('utf8').on('data', (x: string) => { stdout += x; });
    p.stderr.setEncoding('utf8').on('data', (x: string) => { stderr += x; });
    p.on('close', (status) => resolve({ status, stdout, stderr }));
    p.stdin.end(JSON.stringify(payload));
  });
  const stop = await run({ hook_event_name: 'Stop', session_id: SID });
  expect(stop).toEqual({ status: 0, stdout: '', stderr: '' });
  const t0 = Date.now();
  const r = await run(prompt());
  expect(r.status).toBe(0);
  expect(JSON.parse(r.stdout)).toEqual({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', sessionTitle: 'Login bug' } });
  expect(r.stderr).toBe('');
  // The reply ends the connection: Claude never waits for nc's timeout.
  expect(Date.now() - t0).toBeLessThan(800);
});

test('restart: a lost session keeps its pending name and its title; resuming hands the name to Claude at SessionStart', async () => {
  const home = mkdtempSync(join(tmpdir(), 'atl-n-'));
  let { d, c } = await start(home);
  const term = await create(c, 1);
  await send(d, term.id, { hook_event_name: 'SessionStart', session_id: SID, source: 'startup' });
  await send(d, term.id, { session_id: SID, session_name: 'AI title' }, 'status');
  c.send({ t: 'rename', rid: 2, id: term.id, name: 'Given in Atelier' });
  await c.next((m) => infoOf(m, term.id)?.title === 'Given in Atelier');
  c.close();
  await d.stop();
  ({ d, c } = await start(home));
  const res = await c.next((m) => m.t === 'resumables' && m.list.length === 1) as Extract<ServerMessage, { t: 'resumables' }>;
  expect(res.list[0]).toMatchObject({ title: 'Given in Atelier', name: 'Given in Atelier', sessionId: SID });
  c.send({ t: 'resume', rid: 3, id: res.list[0]!.id, cols: 80, rows: 24 });
  const resumed = ((await c.next((m) => m.t === 'reply' && m.rid === 3)) as Extract<ServerMessage, { t: 'reply'; ok: true }>).result as TerminalInfo;
  expect(resumed.title).toBe('Given in Atelier');
  const out = await send(d, resumed.id, { hook_event_name: 'SessionStart', session_id: SID, source: 'resume', session_title: 'Old' });
  expect(JSON.parse(out)).toEqual({ hookSpecificOutput: { hookEventName: 'SessionStart', sessionTitle: 'Given in Atelier' } });
});

test('restart: a synced name is not sent again; the last title is only a label', async () => {
  const home = mkdtempSync(join(tmpdir(), 'atl-n-'));
  let { d, c } = await start(home);
  const term = await create(c, 1);
  await send(d, term.id, { hook_event_name: 'SessionStart', session_id: SID, source: 'startup' });
  await send(d, term.id, { session_id: SID, session_name: 'AI title' }, 'status');
  await c.next((m) => infoOf(m, term.id)?.title === 'AI title');
  c.close();
  await d.stop();
  ({ d, c } = await start(home));
  const res = await c.next((m) => m.t === 'resumables' && m.list.length === 1) as Extract<ServerMessage, { t: 'resumables' }>;
  expect(res.list[0]!.name ?? null).toBeNull();
  c.send({ t: 'resume', rid: 3, id: res.list[0]!.id, cols: 80, rows: 24 });
  const resumed = ((await c.next((m) => m.t === 'reply' && m.rid === 3)) as Extract<ServerMessage, { t: 'reply'; ok: true }>).result as TerminalInfo;
  expect(resumed).toMatchObject({ title: 'AI title', name: null });
  expect(await send(d, resumed.id, { hook_event_name: 'SessionStart', session_id: SID, source: 'resume' })).toBe('');
});

test('a registry from before name sync: old names stay Atelier-only (they may be history titles Atelier set itself), never sent', async () => {
  const home = mkdtempSync(join(tmpdir(), 'atl-n-'));
  const other = '0b5c8f0e-2222-4222-8333-944455556666';
  writeFileSync(join(home, 'registry.json'), JSON.stringify({ v: 1, attributions: [],
    terminals: [{ id: 'a', projectRoot: '/tmp', cwd: '/tmp', name: 'Old Atelier name', title: 'Old Atelier name', color: '#fff', sessionId: SID, state: 'idle', createdAt: 1 }],
    resumables: [{ id: 'b', projectRoot: '/tmp', cwd: '/tmp', title: 'Old resumable title', color: '#fff', sessionId: other, endedAt: 1 }] }));
  const { d, c } = await start(home);
  const res = await c.next((m) => m.t === 'resumables' && m.list.length === 2) as Extract<ServerMessage, { t: 'resumables' }>;
  expect(res.list.find((r) => r.id === 'a')).toMatchObject({ name: 'Old Atelier name', nameSync: 'kept' });
  expect(res.list.find((r) => r.id === 'b')).toMatchObject({ name: 'Old resumable title', nameSync: 'kept' });
  c.send({ t: 'resume', rid: 1, id: 'a', cols: 80, rows: 24 });
  const resumed = ((await c.next((m) => m.t === 'reply' && m.rid === 1)) as Extract<ServerMessage, { t: 'reply'; ok: true }>).result as TerminalInfo;
  expect(await send(d, resumed.id, { hook_event_name: 'SessionStart', session_id: SID, source: 'resume' })).toBe('');
  await send(d, resumed.id, { session_id: SID, session_name: 'AI title' }, 'status');
  // Shown as before (Atelier's name over Claude's AI title), and Claude is never renamed.
  await c.next((m) => infoOf(m, resumed.id)?.title === 'Old Atelier name' && infoOf(m, resumed.id)?.nameSync === 'kept');
  expect(await send(d, resumed.id, prompt())).toBe('');
});

test('a name adopted from Claude comes back exactly after a restart, and is not sent again', async () => {
  const home = mkdtempSync(join(tmpdir(), 'atl-n-'));
  let { d, c } = await start(home);
  const term = await create(c, 1, { name: 'Login bug' });
  await send(d, term.id, { hook_event_name: 'SessionStart', session_id: SID, source: 'startup', session_title: 'Login bug' });
  await send(d, term.id, prompt('Auth  flow\tv2'));
  await c.next((m) => infoOf(m, term.id)?.name === 'Auth  flow\tv2');
  c.close();
  await d.stop();
  ({ d, c } = await start(home));
  const res = await c.next((m) => m.t === 'resumables' && m.list.length === 1) as Extract<ServerMessage, { t: 'resumables' }>;
  c.send({ t: 'resume', rid: 2, id: res.list[0]!.id, cols: 80, rows: 24 });
  const resumed = ((await c.next((m) => m.t === 'reply' && m.rid === 2)) as Extract<ServerMessage, { t: 'reply'; ok: true }>).result as TerminalInfo;
  expect(resumed.name).toBe('Auth  flow\tv2');
  expect(await send(d, resumed.id, { hook_event_name: 'SessionStart', session_id: SID, source: 'resume', session_title: 'Auth  flow\tv2' })).toBe('');
});

test('a new conversation in the same terminal (/clear) drops a synced name: it never follows the new one', async () => {
  const home = mkdtempSync(join(tmpdir(), 'atl-n-'));
  let { d, c } = await start(home);
  const term = await create(c, 1, { name: 'Login bug' });
  await send(d, term.id, { hook_event_name: 'SessionStart', session_id: SID, source: 'startup', session_title: 'Login bug' });
  await c.next((m) => infoOf(m, term.id)?.session?.title === 'Login bug');
  const next = '0b5c8f0e-3333-4222-8333-944455556666';
  expect(await send(d, term.id, { hook_event_name: 'SessionStart', session_id: next, source: 'clear' })).toBe('');
  await c.next((m) => infoOf(m, term.id)?.name === null && infoOf(m, term.id)?.session?.sessionId === next);
  c.close();
  await d.stop();
  ({ d, c } = await start(home));
  const res = await c.next((m) => m.t === 'resumables' && m.list.length === 1) as Extract<ServerMessage, { t: 'resumables' }>;
  expect(res.list[0]!.name ?? null).toBeNull();
});

test('a status line of another session never confirms a sent name', async () => {
  const { d, c } = await start();
  const term = await create(c, 1, { name: 'Login bug' });
  expect(await send(d, term.id, prompt())).toContain('Login bug');
  await send(d, term.id, { session_id: 'someone-else', session_name: 'Login bug' }, 'status');
  await send(d, term.id, { session_id: SID, context_window: { used_percentage: 3 } }, 'status');
  const m = await c.next((x) => infoOf(x, term.id)?.session?.contextPct === 3);
  expect(infoOf(m, term.id)?.nameSync).toBe('pending');
});

test('a big prompt (a long paste, many chunks) still gets the reply at once', async () => {
  const { d, c } = await start();
  const term = await create(c, 1, { name: 'Login bug' });
  const out = await send(d, term.id, { hook_event_name: 'UserPromptSubmit', session_id: SID, prompt: 'x'.repeat(600_000) + '\n' });
  expect(JSON.parse(out)).toEqual({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', sessionTitle: 'Login bug' } });
});
