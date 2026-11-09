import { mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { runDaemon, type RunningDaemon } from '../../src/daemon/main';
import { connectControl, connectRaw } from './helpers';
import { MAX_LINE_CHARS, daemonCapabilities, encode, type ServerMessage, type TerminalInfo } from '../../src/shared/protocol';

const running: RunningDaemon[] = [];
afterEach(async () => { for (const d of running.splice(0)) await d.stop(); });

async function start() {
  const home = mkdtempSync(join(tmpdir(), 'atl-s-'));
  const d = await runDaemon({ home, version: 't', shellArgs: ['-f'], userClaudeSettings: join(home, 'x.json'), extraEnv: NO_CLAUDE });
  running.push(d);
  const c = await connectControl(d.paths.sock, d.info.token);
  await c.next((m) => m.t === 'welcome');
  c.send({ t: 'create', rid: 1, projectRoot: '/tmp', cwd: '/tmp', cols: 80, rows: 24 });
  const r = await c.next((m) => m.t === 'reply' && m.rid === 1) as Extract<ServerMessage, { t: 'reply'; ok: true }>;
  return { d, c, term: r.result as TerminalInfo };
}

async function hook(d: RunningDaemon, term: string, payload: object, kind: 'hook' | 'status' = 'hook') {
  const h = await connectRaw(d.paths.sock, encode({ t: kind, token: d.hookToken, term }) + JSON.stringify(payload));
  await h.closed;
}

/** Polls `cond` until it holds or `ms` have passed: whether it held. */
async function within(ms: number, cond: () => boolean): Promise<boolean> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() >= end) return false;
    await new Promise((r) => setTimeout(r, 5));
  }
  return true;
}

const sessionOf = (m: ServerMessage, id: string) => (m.t === 'terminals' ? m.list.find((x) => x.id === id)?.session : undefined);

/**
 * Every daemon here: shells that find no `claude` at all. zsh -f types a resume's `claude --resume <id>` into the
 * shell, and the test process's PATH may hold the user's real Claude Code.
 */
const NO_CLAUDE = { PATH: '/usr/bin:/bin' };

/**
 * Columns for a terminal whose echoed command is read back: zsh -f's prompt is the host name, 62 characters on CI's
 * runners, and a line longer than the terminal wraps with redraw codes in the middle (once inside the session id).
 */
const WIDE = 1000;

/**
 * The resume command typed into a terminal (zsh -f: the initial command is typed), as the shell echoes it; the
 * terminal must be WIDE. atelierd types it once the shell has printed and gone quiet, or after 5 s at the latest
 * (writeWhenReady): the wait outlasts that.
 */
async function resumeCommandOf(d: RunningDaemon, id: string): Promise<string> {
  let out = '';
  d.terminals.attach(id, (s) => { out += s; }, (x) => { out += x; });
  const typed = () => /((?:CLAUDE_CONFIG_DIR='[^']*' )?claude --resume '[0-9a-f-]+')/.exec(out)?.[1];
  if (!await within(10000, () => typed() !== undefined)) throw new Error(`no resume command typed; the terminal shows ${JSON.stringify(out)}`);
  return typed()!;
}

test('hook → session state in the terminal, with title', async () => {
  const { d, c, term } = await start();
  expect(term.session).toBeNull();
  await hook(d, term.id, { hook_event_name: 'SessionStart', session_id: 's1', session_title: 'Interlocutori' });
  await c.next((m) => sessionOf(m, term.id)?.state === 'idle');
  await hook(d, term.id, { hook_event_name: 'PermissionRequest', session_id: 's1', tool_name: 'Edit', tool_input: { file_path: '/p/a.ts' } });
  const m = await c.next((x) => sessionOf(x, term.id)?.state === 'waiting');
  const t = (m as Extract<ServerMessage, { t: 'terminals' }>).list.find((x) => x.id === term.id)!;
  expect(t.title).toBe('Interlocutori');
  expect(t.session?.activity).toBe('waiting: Edit a.ts');
});

test('v2.0: welcome advertises states2; hooks fill the richer fields', async () => {
  const home = mkdtempSync(join(tmpdir(), 'atl-s-'));
  const d = await runDaemon({ home, version: 't', shellArgs: ['-f'], userClaudeSettings: join(home, 'x.json'), extraEnv: NO_CLAUDE });
  running.push(d);
  const c = await connectControl(d.paths.sock, d.info.token);
  const w = await c.next((m) => m.t === 'welcome');
  expect(daemonCapabilities(w)).toContain('states2');
  c.send({ t: 'create', rid: 1, projectRoot: '/tmp', cwd: '/tmp', cols: 80, rows: 24 });
  const term = ((await c.next((m) => m.t === 'reply' && m.rid === 1)) as Extract<ServerMessage, { t: 'reply'; ok: true }>).result as TerminalInfo;
  await hook(d, term.id, { hook_event_name: 'SessionStart', session_id: 's1', permission_mode: 'plan' });
  await hook(d, term.id, { hook_event_name: 'UserPromptSubmit', session_id: 's1', prompt: 'Add dark mode to the settings sheet' });
  await hook(d, term.id, { hook_event_name: 'SubagentStart', session_id: 's1', agent_id: 'a1', agent_type: 'Explore' });
  await hook(d, term.id, { hook_event_name: 'SubagentStart', session_id: 's1', agent_id: 'a2', agent_type: 'Plan' });
  await hook(d, term.id, { hook_event_name: 'PreCompact', session_id: 's1', trigger: 'auto', custom_instructions: null });
  const m = await c.next((x) => sessionOf(x, term.id)?.compacting === true);
  const t = (m as Extract<ServerMessage, { t: 'terminals' }>).list.find((x) => x.id === term.id)!;
  expect(t.session).toMatchObject({ state: 'running', subagents: 2, permissionMode: 'plan', autoTitle: 'Add dark mode to the settings sheet', waitingFor: null, errorReason: null });
  await hook(d, term.id, { hook_event_name: 'PermissionRequest', session_id: 's1', tool_name: 'AskUserQuestion', tool_input: { questions: [] } });
  const asked = await c.next((x) => sessionOf(x, term.id)?.waitingFor === 'question');
  // The per-agent waits are atelierd's own bookkeeping: they never reach the app.
  expect(sessionOf(asked, term.id)).not.toHaveProperty('agentWaits');
  await hook(d, term.id, { hook_event_name: 'StopFailure', session_id: 's1', error: 'rate_limit', error_details: '429' });
  // The subagents outlive the main turn (background work): still counted; the tracking never leaves atelierd.
  const failed = await c.next((x) => sessionOf(x, term.id)?.errorReason === 'rate_limit' && sessionOf(x, term.id)?.subagents === 2 && sessionOf(x, term.id)?.compacting === false);
  expect(sessionOf(failed, term.id)).not.toHaveProperty('agentRuns');
  expect(sessionOf(failed, term.id)).not.toHaveProperty('mainRest');
  await hook(d, term.id, { hook_event_name: 'SubagentStop', session_id: 's1', agent_id: 'a1', agent_type: 'Explore' });
  await c.next((x) => sessionOf(x, term.id)?.subagents === 1);
});

test('background: welcome advertises it; the work reaches the app, its owners never do', async () => {
  const home = mkdtempSync(join(tmpdir(), 'atl-s-'));
  const d = await runDaemon({ home, version: 't', shellArgs: ['-f'], userClaudeSettings: join(home, 'x.json'), extraEnv: NO_CLAUDE });
  running.push(d);
  const c = await connectControl(d.paths.sock, d.info.token);
  expect(daemonCapabilities(await c.next((m) => m.t === 'welcome'))).toContain('background');
  c.send({ t: 'create', rid: 1, projectRoot: '/tmp', cwd: '/tmp', cols: 80, rows: 24 });
  const term = ((await c.next((m) => m.t === 'reply' && m.rid === 1)) as Extract<ServerMessage, { t: 'reply'; ok: true }>).result as TerminalInfo;
  await hook(d, term.id, { hook_event_name: 'SessionStart', session_id: 's1' });
  await hook(d, term.id, { hook_event_name: 'UserPromptSubmit', session_id: 's1', prompt: 'run the suite' });
  await hook(d, term.id, { hook_event_name: 'PostToolUse', session_id: 's1', tool_name: 'Bash', tool_input: { command: 'npm test', description: 'Run the suite', run_in_background: true }, tool_response: { backgroundTaskId: 'b1' } });
  await hook(d, term.id, { hook_event_name: 'Stop', session_id: 's1', background_tasks: [{ id: 'b1', type: 'shell', status: 'running', description: 'Run the suite', command: 'npm test' }], session_crons: [] });
  const m = await c.next((x) => sessionOf(x, term.id)?.state === 'done');
  const s = sessionOf(m, term.id)!;
  expect(s.background).toEqual({ items: [{ id: 'b1', kind: 'shell', label: 'Run the suite', command: 'npm test', since: expect.any(Number) }], crons: [] });
  expect(s).not.toHaveProperty('bgOwners');
  expect(s).not.toHaveProperty('bgSeen');
  expect(s).not.toHaveProperty('agentDescriptions');
  expect(s).not.toHaveProperty('agentRuns');
});

test('v2.0: the first prompt titles the terminal when neither the user nor Claude named it, and is what a resumable keeps', async () => {
  const home = mkdtempSync(join(tmpdir(), 'atl-s-'));
  let d = await runDaemon({ home, version: 't', shellArgs: ['-f'], userClaudeSettings: join(home, 'x.json'), extraEnv: NO_CLAUDE });
  let c = await connectControl(d.paths.sock, d.info.token);
  await c.next((m) => m.t === 'welcome');
  const make = async (rid: number, name?: string) => {
    c.send({ t: 'create', rid, projectRoot: '/tmp', cwd: '/tmp', cols: 80, rows: 24, ...(name ? { name } : {}) });
    return ((await c.next((m) => m.t === 'reply' && m.rid === rid)) as Extract<ServerMessage, { t: 'reply'; ok: true }>).result as TerminalInfo;
  };
  const titleOf = (m: ServerMessage, id: string) => (m.t === 'terminals' ? m.list.find((x) => x.id === id)?.title : undefined);
  const auto = await make(1);
  const named = await make(2, 'My name');
  const claudeTitled = await make(3);
  const sid = '0b5c8f0e-1111-4222-8333-944455556666';
  await hook(d, auto.id, { hook_event_name: 'UserPromptSubmit', session_id: sid, prompt: 'Fix the flaky login test\nplease' });
  await hook(d, named.id, { hook_event_name: 'UserPromptSubmit', session_id: 's2', prompt: 'Something else' });
  await hook(d, claudeTitled.id, { hook_event_name: 'UserPromptSubmit', session_id: 's3', prompt: 'Something else', session_title: 'From Claude' });
  await c.next((m) => titleOf(m, auto.id) === 'Fix the flaky login test please' && titleOf(m, named.id) === 'My name' && titleOf(m, claudeTitled.id) === 'From Claude');
  // A later rename wins over the auto title.
  c.send({ t: 'rename', rid: 4, id: claudeTitled.id, name: 'Renamed' });
  await c.next((m) => titleOf(m, claudeTitled.id) === 'Renamed');
  // Registry: the auto title is the resumable's title after a restart.
  c.close();
  await d.stop();
  d = await runDaemon({ home, version: 't', shellArgs: ['-f'], userClaudeSettings: join(home, 'x.json'), extraEnv: NO_CLAUDE });
  running.push(d);
  c = await connectControl(d.paths.sock, d.info.token);
  const res = await c.next((m) => m.t === 'resumables' && m.list.some((r) => r.sessionId === sid)) as Extract<ServerMessage, { t: 'resumables' }>;
  expect(res.list.find((r) => r.sessionId === sid)).toMatchObject({ title: 'Fix the flaky login test please' });
});

test('status line → context and usage message', async () => {
  const { d, c, term } = await start();
  await hook(d, term.id, { hook_event_name: 'SessionStart', session_id: 's1' });
  const now = Math.floor(Date.now() / 1000);
  await hook(d, term.id, { session_id: 's1', context_window: { used_percentage: 31 }, rate_limits: { five_hour: { used_percentage: 42, resets_at: now + 3600 }, seven_day: { used_percentage: 18, resets_at: now + 86400 } } }, 'status');
  await c.next((m) => sessionOf(m, term.id)?.contextPct === 31);
  const u = await c.next((m) => m.t === 'usage' && m.usage !== null);
  expect(u).toMatchObject({ usage: { fiveHour: { pct: 42 }, sevenDay: { pct: 18 } } });
});

test('a limit reset mid-window: a fresh session\'s lower numbers beat an idle one repeating its old ones', async () => {
  const { d, c, term } = await start();
  c.send({ t: 'create', rid: 2, projectRoot: '/tmp', cwd: '/tmp', cols: 80, rows: 24 });
  const other = ((await c.next((m) => m.t === 'reply' && m.rid === 2)) as Extract<ServerMessage, { t: 'reply'; ok: true }>).result as TerminalInfo;
  await hook(d, term.id, { hook_event_name: 'SessionStart', session_id: 's1', transcript_path: '/u/.claude/projects/-tmp/s1.jsonl' });
  await hook(d, other.id, { hook_event_name: 'SessionStart', session_id: 's2', transcript_path: '/u/.claude/projects/-tmp/s2.jsonl' });
  const now = Math.floor(Date.now() / 1000);
  // The live case: the 7-day window was reset for free, its reset time unchanged.
  const limits = (pct: number) => ({ five_hour: { used_percentage: 2, resets_at: now + 17000 }, seven_day: { used_percentage: pct, resets_at: now + 86400 } });
  const sevenDay = (m: ServerMessage) => (m.t === 'usageByConfigDir' ? m.list[0]?.usage.sevenDay?.pct : undefined);
  await hook(d, term.id, { session_id: 's1', transcript_path: '/u/.claude/projects/-tmp/s1.jsonl', rate_limits: limits(99) }, 'status');
  await c.next((m) => sevenDay(m) === 99);
  await hook(d, other.id, { session_id: 's2', transcript_path: '/u/.claude/projects/-tmp/s2.jsonl', rate_limits: limits(1) }, 'status');
  await c.next((m) => sevenDay(m) === 1);
  await c.next((m) => m.t === 'usage' && m.usage?.sevenDay?.pct === 1);
  // The idle session repeats its old numbers: nothing moves back.
  await hook(d, term.id, { session_id: 's1', transcript_path: '/u/.claude/projects/-tmp/s1.jsonl', rate_limits: limits(99) }, 'status');
  await hook(d, other.id, { session_id: 's2', transcript_path: '/u/.claude/projects/-tmp/s2.jsonl', rate_limits: limits(1) }, 'status');
  const c2 = await connectControl(d.paths.sock, d.info.token);
  expect(await c2.next((m) => m.t === 'usage')).toMatchObject({ usage: { sevenDay: { pct: 1 } } });
  expect(sevenDay(await c2.next((m) => m.t === 'usageByConfigDir'))).toBe(1);
  c2.close();
});

test('usage per config dir: two accounts stay apart, each terminal knows its dir', async () => {
  const { d, c, term } = await start();
  c.send({ t: 'create', rid: 2, projectRoot: '/tmp', cwd: '/tmp', cols: 80, rows: 24 });
  const other = ((await c.next((m) => m.t === 'reply' && m.rid === 2)) as Extract<ServerMessage, { t: 'reply'; ok: true }>).result as TerminalInfo;
  const dirOf = (m: ServerMessage, id: string) => (m.t === 'terminals' ? m.list.find((x) => x.id === id)?.configDir : undefined);
  // SessionStart already tells the terminal's dir, before any status line.
  await hook(d, term.id, { hook_event_name: 'SessionStart', session_id: 's1', transcript_path: '/u/.claude/projects/-tmp/s1.jsonl' });
  await c.next((m) => dirOf(m, term.id) === '/u/.claude');
  await hook(d, other.id, { hook_event_name: 'SessionStart', session_id: 's2' });
  const now = Math.floor(Date.now() / 1000);
  // The live case: the default account resets later at 0%, the other one is at 22%.
  await hook(d, term.id, { session_id: 's1', transcript_path: '/u/.claude/projects/-tmp/s1.jsonl', rate_limits: { five_hour: { used_percentage: 0, resets_at: now + 17100 } } }, 'status');
  await hook(d, other.id, { session_id: 's2', transcript_path: '/u/.claude_ops/projects/-tmp/s2.jsonl', rate_limits: { five_hour: { used_percentage: 22, resets_at: now + 13500 } } }, 'status');
  const m = await c.next((x) => x.t === 'usageByConfigDir' && x.list.length === 2) as Extract<ServerMessage, { t: 'usageByConfigDir' }>;
  expect(m.list.map((e) => [e.configDir, e.usage.fiveHour?.pct])).toEqual([['/u/.claude', 0], ['/u/.claude_ops', 22]]);
  await c.next((x) => dirOf(x, other.id) === '/u/.claude_ops');
  // The app-wide message an older app reads is unchanged: the later reset wins.
  await c.next((x) => x.t === 'usage' && x.usage?.fiveHour?.pct === 0);
  // The dir stays after Claude ends; another Claude with another dir replaces it.
  await hook(d, term.id, { hook_event_name: 'SessionEnd', session_id: 's1' });
  await c.next((x) => x.t === 'terminals' && x.list.some((t) => t.id === term.id && t.session === null && t.configDir === '/u/.claude'));
  await hook(d, term.id, { hook_event_name: 'SessionStart', session_id: 's3', transcript_path: '/u/.claude_ops/projects/-tmp/s3.jsonl' });
  await c.next((x) => dirOf(x, term.id) === '/u/.claude_ops');
  // A status line without transcript_path counts for the dir the terminal already knows, not an unknown one.
  await hook(d, term.id, { session_id: 's3', rate_limits: { five_hour: { used_percentage: 23, resets_at: now + 13500 } } }, 'status');
  const kept = await c.next((x) => x.t === 'usageByConfigDir' && x.list.some((e) => e.usage.fiveHour?.pct === 23)) as Extract<ServerMessage, { t: 'usageByConfigDir' }>;
  expect(kept.list.map((e) => e.configDir)).toEqual(['/u/.claude', '/u/.claude_ops']);
  // A newly connected app gets the list at once.
  const c2 = await connectControl(d.paths.sock, d.info.token);
  const w = await c2.next((x) => x.t === 'welcome');
  expect(daemonCapabilities(w)).toContain('config-dirs');
  const first = await c2.next((x) => x.t === 'usageByConfigDir') as Extract<ServerMessage, { t: 'usageByConfigDir' }>;
  expect(first.list).toHaveLength(2);
  c2.close();
});

test('markSeen and rename', async () => {
  const { d, c, term } = await start();
  await hook(d, term.id, { hook_event_name: 'SessionStart', session_id: 's1' });
  await hook(d, term.id, { hook_event_name: 'Stop', session_id: 's1' });
  await c.next((m) => sessionOf(m, term.id)?.unread === true);
  c.send({ t: 'markSeen', rid: 5, id: term.id });
  await c.next((m) => sessionOf(m, term.id)?.unread === false && sessionOf(m, term.id)?.state === 'done');
  c.send({ t: 'rename', rid: 6, id: term.id, name: 'Mio nome' });
  await c.next((m) => m.t === 'terminals' && m.list.some((x) => x.id === term.id && x.title === 'Mio nome' && x.name === 'Mio nome'));
});

test('broken payloads and unknown terminals → ignored, the service stays alive', async () => {
  const { d, c, term } = await start();
  await hook(d, 'ffffffff-0000-4000-8000-000000000000', { hook_event_name: 'Stop', session_id: 's' });
  await hook(d, term.id, { qualcosa: true });
  await hook(d, term.id, [1, 2, 3]);
  c.send({ t: 'list', rid: 9 });
  const r = await c.next((m) => m.t === 'reply' && m.rid === 9) as Extract<ServerMessage, { t: 'reply'; ok: true }>;
  expect((r.result as TerminalInfo[])[0]?.session).toBeNull();
});

test('SessionEnd → the terminal goes back to plain, default title', async () => {
  const { d, c, term } = await start();
  await hook(d, term.id, { hook_event_name: 'SessionStart', session_id: 's1', session_title: 'X' });
  await c.next((m) => sessionOf(m, term.id)?.state === 'idle');
  await hook(d, term.id, { hook_event_name: 'SessionEnd', session_id: 's1', reason: 'other' });
  await c.next((m) => m.t === 'terminals' && m.list.some((x) => x.id === term.id && x.session === null && x.title === 'Terminal 1'));
});

test('dangling session: the shell returns to the foreground → session closed', async () => {
  const { d, c, term } = await start();
  await hook(d, term.id, { hook_event_name: 'UserPromptSubmit', session_id: 's1' });
  await c.next((m) => sessionOf(m, term.id)?.state === 'running');
  // The test shell is already in the foreground: two poll reads (1 s each) close the session.
  await c.next((m) => m.t === 'terminals' && m.list.some((x) => x.id === term.id && x.session === null), 5000);
});

test('PostToolUse Edit → attribution with color and name; pruning of clean files', async () => {
  const { d, c, term } = await start();
  await hook(d, term.id, { hook_event_name: 'SessionStart', session_id: 's1', session_title: 'Interlocutori' });
  await hook(d, term.id, { hook_event_name: 'PostToolUse', session_id: 's1', tool_name: 'Edit', tool_input: { file_path: '/tmp/prj/a.ts' } });
  const m = await c.next((x) => x.t === 'attributions' && x.list.length === 1) as Extract<ServerMessage, { t: 'attributions' }>;
  expect(m.list[0]).toMatchObject({ path: '/tmp/prj/a.ts', terminalId: term.id, title: 'Interlocutori', color: term.color });
  c.send({ t: 'attrPrune', rid: 7, root: '/tmp/prj', dirty: [] });
  await c.next((x) => x.t === 'attributions' && x.list.length === 0);
});

test('attribution with the real path: a file reached through a symlink matches the one from git', async () => {
  const { d, c, term } = await start();
  const realDir = realpathSync(mkdtempSync(join(tmpdir(), 'atl-real-')));
  writeFileSync(join(realDir, 'a.ts'), 'x');
  const link = join(mkdtempSync(join(tmpdir(), 'atl-link-')), 'progetto');
  symlinkSync(realDir, link);
  await hook(d, term.id, { hook_event_name: 'PostToolUse', session_id: 's1', tool_name: 'Write', tool_input: { file_path: join(link, 'a.ts') } });
  await hook(d, term.id, { hook_event_name: 'PostToolUse', session_id: 's1', tool_name: 'Write', tool_input: { file_path: join(link, 'cancellato.ts') } });
  const m = await c.next((x) => x.t === 'attributions' && x.list.length === 2) as Extract<ServerMessage, { t: 'attributions' }>;
  expect(m.list.map((a) => a.path).sort()).toEqual([join(realDir, 'a.ts'), join(realDir, 'cancellato.ts')]);
});
test('registry: service stop and restart → the session becomes resumable and is resumed only once', async () => {
  const home = mkdtempSync(join(tmpdir(), 'atl-r-'));
  let d = await runDaemon({ home, version: 't', shellArgs: ['-f'], userClaudeSettings: join(home, 'x.json'), extraEnv: NO_CLAUDE });
  let c = await connectControl(d.paths.sock, d.info.token);
  await c.next((m) => m.t === 'welcome');
  c.send({ t: 'create', rid: 1, projectRoot: '/tmp', cwd: '/tmp', cols: 80, rows: 24, name: 'Lavoro' });
  const r = await c.next((m) => m.t === 'reply' && m.rid === 1) as Extract<ServerMessage, { t: 'reply'; ok: true }>;
  const term = r.result as TerminalInfo;
  await hook(d, term.id, { hook_event_name: 'SessionStart', session_id: '0b5c8f0e-1111-4222-8333-944455556666', session_title: 'Lavoro' });
  await c.next((m) => m.t === 'terminals' && m.list.some((x) => x.session?.sessionId === '0b5c8f0e-1111-4222-8333-944455556666'));
  c.close();
  await d.stop();
  d = await runDaemon({ home, version: 't', shellArgs: ['-f'], userClaudeSettings: join(home, 'x.json'), extraEnv: NO_CLAUDE });
  running.push(d);
  c = await connectControl(d.paths.sock, d.info.token);
  const res = await c.next((m) => m.t === 'resumables' && m.list.length === 1) as Extract<ServerMessage, { t: 'resumables' }>;
  expect(res.list[0]).toMatchObject({ title: 'Lavoro', color: term.color, sessionId: '0b5c8f0e-1111-4222-8333-944455556666' });
  c.send({ t: 'resume', rid: 2, id: res.list[0]!.id, cols: 80, rows: 24 });
  c.send({ t: 'resume', rid: 3, id: res.list[0]!.id, cols: 80, rows: 24 });
  const ok = await c.next((m) => m.t === 'reply' && m.rid === 2);
  const second = await c.next((m) => m.t === 'reply' && m.rid === 3);
  expect(ok).toMatchObject({ ok: true });
  expect(second).toMatchObject({ ok: false });
  await c.next((m) => m.t === 'resumables' && m.list.length === 0);
});
// Claude accounts: the registry keeps each session's config dir; a resume runs with the dir main sends.
test('accounts: a resumable keeps its config dir; resume prefixes the dir from the message, never the stored one', async () => {
  const home = mkdtempSync(join(tmpdir(), 'atl-r-'));
  const sid = '0b5c8f0e-1111-4222-8333-944455558888';
  const ops = join(home, 'claude_ops');
  let d = await runDaemon({ home, version: 't', shellArgs: ['-f'], userClaudeSettings: join(home, 'x.json'), extraEnv: NO_CLAUDE });
  let c = await connectControl(d.paths.sock, d.info.token);
  expect(daemonCapabilities(await c.next((m) => m.t === 'welcome'))).toContain('resume-config-dir');
  c.send({ t: 'create', rid: 1, projectRoot: '/tmp', cwd: '/tmp', cols: 80, rows: 24 });
  const term = ((await c.next((m) => m.t === 'reply' && m.rid === 1)) as Extract<ServerMessage, { t: 'reply'; ok: true }>).result as TerminalInfo;
  await hook(d, term.id, { hook_event_name: 'SessionStart', session_id: sid, transcript_path: `${ops}/projects/-tmp/${sid}.jsonl` });
  await c.next((m) => m.t === 'terminals' && m.list.some((x) => x.configDir === ops));
  c.close();
  await d.stop();
  d = await runDaemon({ home, version: 't', shellArgs: ['-f'], userClaudeSettings: join(home, 'x.json'), extraEnv: NO_CLAUDE });
  running.push(d);
  c = await connectControl(d.paths.sock, d.info.token);
  const res = await c.next((m) => m.t === 'resumables' && m.list.length === 1) as Extract<ServerMessage, { t: 'resumables' }>;
  expect(res.list[0]!.configDir).toBe(ops);
  c.send({ t: 'resume', rid: 2, id: res.list[0]!.id, cols: WIDE, rows: 24, configDir: ops });
  const t = ((await c.next((m) => m.t === 'reply' && m.rid === 2)) as Extract<ServerMessage, { t: 'reply'; ok: true }>).result as TerminalInfo;
  expect(await resumeCommandOf(d, t.id)).toBe(`CLAUDE_CONFIG_DIR='${ops}' claude --resume '${sid}'`);
});

test('accounts: resume with configDir null, or without it, runs plain claude even when a dir was stored', async () => {
  const home = mkdtempSync(join(tmpdir(), 'atl-r-'));
  const sid = '0b5c8f0e-1111-4222-8333-944455559999';
  let d = await runDaemon({ home, version: 't', shellArgs: ['-f'], userClaudeSettings: join(home, 'x.json'), extraEnv: NO_CLAUDE });
  let c = await connectControl(d.paths.sock, d.info.token);
  await c.next((m) => m.t === 'welcome');
  for (const rid of [1, 2]) c.send({ t: 'create', rid, projectRoot: '/tmp', cwd: '/tmp', cols: 80, rows: 24 });
  const terms: TerminalInfo[] = [];
  for (const rid of [1, 2]) terms.push(((await c.next((m) => m.t === 'reply' && m.rid === rid)) as Extract<ServerMessage, { t: 'reply'; ok: true }>).result as TerminalInfo);
  for (const t of terms) await hook(d, t.id, { hook_event_name: 'SessionStart', session_id: sid, transcript_path: `${home}/claude_ops/projects/-tmp/${sid}.jsonl` });
  await c.next((m) => m.t === 'terminals' && m.list.filter((x) => x.configDir).length === 2);
  c.close();
  await d.stop();
  d = await runDaemon({ home, version: 't', shellArgs: ['-f'], userClaudeSettings: join(home, 'x.json'), extraEnv: NO_CLAUDE });
  running.push(d);
  c = await connectControl(d.paths.sock, d.info.token);
  const res = await c.next((m) => m.t === 'resumables' && m.list.length === 2) as Extract<ServerMessage, { t: 'resumables' }>;
  const cmds: string[] = [];
  for (const [i, extra] of [[0, { configDir: null }], [1, {}]] as const) {
    c.send({ t: 'resume', rid: 10 + i, id: res.list[i]!.id, cols: WIDE, rows: 24, ...extra });
    const t = ((await c.next((m) => m.t === 'reply' && m.rid === 10 + i)) as Extract<ServerMessage, { t: 'reply'; ok: true }>).result as TerminalInfo;
    cmds.push(await resumeCommandOf(d, t.id));
  }
  expect(cmds).toEqual([`claude --resume '${sid}'`, `claude --resume '${sid}'`]);
});

test('resumes in the folder where Claude started, not the terminal\'s', async () => {
  const home = mkdtempSync(join(tmpdir(), 'atl-r-'));
  const sub = mkdtempSync(join(tmpdir(), 'atl-sub-'));
  let d = await runDaemon({ home, version: 't', shellArgs: ['-f'], userClaudeSettings: join(home, 'x.json'), extraEnv: NO_CLAUDE });
  let c = await connectControl(d.paths.sock, d.info.token);
  await c.next((m) => m.t === 'welcome');
  c.send({ t: 'create', rid: 1, projectRoot: '/tmp', cwd: '/tmp', cols: 80, rows: 24 });
  const r = await c.next((m) => m.t === 'reply' && m.rid === 1) as Extract<ServerMessage, { t: 'reply'; ok: true }>;
  const term = r.result as TerminalInfo;
  await hook(d, term.id, { hook_event_name: 'SessionStart', session_id: '0b5c8f0e-1111-4222-8333-944455556666', cwd: sub });
  await c.next((m) => m.t === 'terminals' && m.list.some((x) => x.session?.sessionId === '0b5c8f0e-1111-4222-8333-944455556666'));
  c.close();
  await d.stop();
  d = await runDaemon({ home, version: 't', shellArgs: ['-f'], userClaudeSettings: join(home, 'x.json'), extraEnv: NO_CLAUDE });
  running.push(d);
  c = await connectControl(d.paths.sock, d.info.token);
  const res = await c.next((m) => m.t === 'resumables' && m.list.length === 1) as Extract<ServerMessage, { t: 'resumables' }>;
  expect(res.list[0]!.cwd).toBe(sub);
});
test('shell killed from outside with a Claude session open (e.g. Mac restart) → immediately resumable', async () => {
  const { d, c, term } = await start();
  await hook(d, term.id, { hook_event_name: 'SessionStart', session_id: '0b5c8f0e-1111-4222-8333-944455556666' });
  await c.next((m) => sessionOf(m, term.id)?.state === 'idle');
  c.send({ t: 'attach', rid: 2, id: term.id });
  await c.next((m) => m.t === 'reply' && m.rid === 2);
  c.send({ t: 'input', id: term.id, data: 'kill -9 $$\r' });
  await c.next((m) => m.t === 'exit' && m.id === term.id);
  const res = await c.next((m) => m.t === 'resumables' && m.list.length === 1) as Extract<ServerMessage, { t: 'resumables' }>;
  expect(res.list[0]).toMatchObject({ sessionId: '0b5c8f0e-1111-4222-8333-944455556666', projectRoot: '/tmp' });
});
test('terminal closed by the user with a session open → not resumable', async () => {
  const { d, c, term } = await start();
  await hook(d, term.id, { hook_event_name: 'SessionStart', session_id: '0b5c8f0e-1111-4222-8333-944455556666' });
  await c.next((m) => sessionOf(m, term.id)?.state === 'idle');
  c.send({ t: 'kill', rid: 2, id: term.id });
  await c.next((m) => m.t === 'exit' && m.id === term.id);
  await new Promise((r) => setTimeout(r, 300));
  expect(c.messages.some((m) => m.t === 'resumables' && m.list.length > 0)).toBe(false);
});

test('tool calls: atelierd streams a Bash window at once, closes it at PostToolUse, sends the full list on connect', async () => {
  const { d, c, term } = await start();
  await hook(d, term.id, { hook_event_name: 'SessionStart', session_id: 's1', source: 'startup' });
  await hook(d, term.id, { hook_event_name: 'PreToolUse', session_id: 's1', tool_name: 'Read', tool_use_id: 'r1', tool_input: { file_path: '/tmp/a' } });
  await hook(d, term.id, { hook_event_name: 'PreToolUse', session_id: 's1', tool_name: 'Bash', tool_use_id: 'b1', tool_input: { command: 'sed -i s/a/b/ x' } });
  const opened = await c.next((m) => m.t === 'toolCalls' && !m.full && m.list.some((x) => x.id === 'b1')) as Extract<ServerMessage, { t: 'toolCalls' }>;
  expect(opened.list.find((x) => x.id === 'b1')).toMatchObject({ terminalId: term.id, sessionId: 's1', agent: 'main', tool: 'Bash', command: 'sed -i s/a/b/ x', end: null });
  expect(opened.list.some((x) => x.id === 'r1')).toBe(false);

  // At once, not debounced like the attributions (200 ms): already received shortly after the hook returned.
  await hook(d, term.id, { hook_event_name: 'PreToolUse', session_id: 's1', tool_name: 'Bash', tool_use_id: 'b2', tool_input: { command: 'ls' } });
  expect(await within(150, () => c.messages.some((m) => m.t === 'toolCalls' && m.list.some((x) => x.id === 'b2')))).toBe(true);
  await hook(d, term.id, { hook_event_name: 'PostToolUse', session_id: 's1', tool_name: 'Bash', tool_use_id: 'b2', tool_input: {}, tool_response: {} });

  // A second app connection gets the whole list, flagged full, and the capability.
  const c2 = await connectControl(d.paths.sock, d.info.token);
  const welcome = await c2.next((m) => m.t === 'welcome');
  expect(daemonCapabilities(welcome)).toContain('toolcalls');
  const full = await c2.next((m) => m.t === 'toolCalls' && m.full) as Extract<ServerMessage, { t: 'toolCalls' }>;
  expect(full.list.filter((x) => x.end === null).map((x) => x.id)).toEqual(['b1']);

  await hook(d, term.id, { hook_event_name: 'PostToolUse', session_id: 's1', tool_name: 'Bash', tool_use_id: 'b1', tool_input: {}, tool_response: {} });
  const closed = await c.next((m) => m.t === 'toolCalls' && m.list.some((x) => x.id === 'b1' && x.end !== null)) as Extract<ServerMessage, { t: 'toolCalls' }>;
  const w = closed.list.find((x) => x.id === 'b1')!;
  expect(w.end! >= w.start).toBe(true);
  // The late connection gets the closure as an increment after its snapshot.
  const late = await c2.next((m) => m.t === 'toolCalls' && !m.full && m.list.some((x) => x.id === 'b1' && x.end !== null)) as Extract<ServerMessage, { t: 'toolCalls' }>;
  expect(late.full).toBe(false);
});

test('tool calls: a background Bash keeps its window open with the shell id once the session lists the shell', async () => {
  const { d, c, term } = await start();
  await hook(d, term.id, { hook_event_name: 'SessionStart', session_id: 's1' });
  await hook(d, term.id, { hook_event_name: 'UserPromptSubmit', session_id: 's1', prompt: 'start the server' });
  await hook(d, term.id, { hook_event_name: 'PreToolUse', session_id: 's1', tool_name: 'Bash', tool_use_id: 'bg-call', tool_input: { command: 'npm run dev', run_in_background: true } });
  await hook(d, term.id, { hook_event_name: 'PostToolUse', session_id: 's1', tool_name: 'Bash', tool_use_id: 'bg-call', tool_input: { command: 'npm run dev', description: 'Dev server', run_in_background: true }, tool_response: { backgroundTaskId: 'bg1' } });
  const m = await c.next((x) => x.t === 'toolCalls' && x.list.some((w) => w.id === 'bg-call' && w.taskId === 'bg1')) as Extract<ServerMessage, { t: 'toolCalls' }>;
  expect(m.list.find((w) => w.id === 'bg-call')).toMatchObject({ background: true, taskId: 'bg1', end: null });
  // Nothing closed it afterwards (the shell is in the session's background items).
  const c2 = await connectControl(d.paths.sock, d.info.token);
  await c2.next((x) => x.t === 'welcome');
  const full = await c2.next((x) => x.t === 'toolCalls' && x.full) as Extract<ServerMessage, { t: 'toolCalls' }>;
  expect(full.list.find((w) => w.id === 'bg-call')).toMatchObject({ background: true, taskId: 'bg1', end: null });
});

test('tool calls: the full list on connect stays well under the app\'s line cap (commands dropped as needed)', async () => {
  const { d, term } = await start();
  await hook(d, term.id, { hook_event_name: 'SessionStart', session_id: 's1', source: 'startup' });
  // A control character escapes to six chars: each window is ~12 KB of JSON, 250 of them ~3 MB.
  const command = '\u0001'.repeat(2048);
  for (let i = 0; i < 250; i++) await hook(d, term.id, { hook_event_name: 'PreToolUse', session_id: 's1', tool_name: 'Bash', tool_use_id: `w${i}`, tool_input: { command } });
  const c2 = await connectControl(d.paths.sock, d.info.token);
  await c2.next((m) => m.t === 'welcome');
  const full = await c2.next((m) => m.t === 'toolCalls' && m.full) as Extract<ServerMessage, { t: 'toolCalls' }>;
  expect(full.list).toHaveLength(250);
  expect(JSON.stringify(full).length).toBeLessThanOrEqual(MAX_LINE_CHARS / 2);
  expect(full.list.some((x) => x.command === command)).toBe(true);
}, 30_000);

test('last message time: welcome advertises it; a prompt and Stop set it; a create hint seeds the first session only', async () => {
  const home = mkdtempSync(join(tmpdir(), 'atl-s-'));
  const d = await runDaemon({ home, version: 't', shellArgs: ['-f'], userClaudeSettings: join(home, 'x.json'), extraEnv: NO_CLAUDE });
  running.push(d);
  const c = await connectControl(d.paths.sock, d.info.token);
  expect(daemonCapabilities(await c.next((m) => m.t === 'welcome'))).toContain('lastmessage');
  const seed = Date.now() - 3 * 3600_000;
  c.send({ t: 'create', rid: 1, projectRoot: '/tmp', cwd: '/tmp', cols: 80, rows: 24, lastMessageAt: seed });
  const term = ((await c.next((m) => m.t === 'reply' && m.rid === 1)) as Extract<ServerMessage, { t: 'reply'; ok: true }>).result as TerminalInfo;
  await hook(d, term.id, { hook_event_name: 'SessionStart', session_id: 's1', source: 'resume' });
  await c.next((m) => sessionOf(m, term.id)?.lastMessageAt === seed);
  const before = Date.now();
  await hook(d, term.id, { hook_event_name: 'UserPromptSubmit', session_id: 's1', prompt: 'go' });
  await c.next((m) => (sessionOf(m, term.id)?.lastMessageAt ?? 0) >= before);
  // /clear: a new conversation starts without a time, the seed is not used again.
  await hook(d, term.id, { hook_event_name: 'SessionStart', session_id: 's2', source: 'clear' });
  await c.next((m) => sessionOf(m, term.id)?.sessionId === 's2' && sessionOf(m, term.id)?.lastMessageAt === null);

  // A resume that never started (the user then ran a fresh claude in that shell): the seed is not that conversation's.
  c.send({ t: 'create', rid: 3, projectRoot: '/tmp', cwd: '/tmp', cols: 80, rows: 24, lastMessageAt: seed });
  const fresh = ((await c.next((m) => m.t === 'reply' && m.rid === 3)) as Extract<ServerMessage, { t: 'reply'; ok: true }>).result as TerminalInfo;
  await hook(d, fresh.id, { hook_event_name: 'SessionStart', session_id: 's4', source: 'startup' });
  await c.next((m) => sessionOf(m, fresh.id)?.sessionId === 's4' && sessionOf(m, fresh.id)?.lastMessageAt === null);

  // A hint from the future is ignored.
  c.send({ t: 'create', rid: 2, projectRoot: '/tmp', cwd: '/tmp', cols: 80, rows: 24, lastMessageAt: Date.now() + 3600_000 });
  const other = ((await c.next((m) => m.t === 'reply' && m.rid === 2)) as Extract<ServerMessage, { t: 'reply'; ok: true }>).result as TerminalInfo;
  await hook(d, other.id, { hook_event_name: 'SessionStart', session_id: 's3', source: 'resume' });
  await c.next((m) => sessionOf(m, other.id)?.sessionId === 's3' && sessionOf(m, other.id)?.lastMessageAt === null);
});

test('last message time: a resumable keeps it across a restart, and the resumed session starts with it', async () => {
  const home = mkdtempSync(join(tmpdir(), 'atl-r-'));
  const sid = '0b5c8f0e-1111-4222-8333-944455557777';
  let d = await runDaemon({ home, version: 't', shellArgs: ['-f'], userClaudeSettings: join(home, 'x.json'), extraEnv: NO_CLAUDE });
  let c = await connectControl(d.paths.sock, d.info.token);
  await c.next((m) => m.t === 'welcome');
  c.send({ t: 'create', rid: 1, projectRoot: '/tmp', cwd: '/tmp', cols: 80, rows: 24 });
  const term = ((await c.next((m) => m.t === 'reply' && m.rid === 1)) as Extract<ServerMessage, { t: 'reply'; ok: true }>).result as TerminalInfo;
  await hook(d, term.id, { hook_event_name: 'SessionStart', session_id: sid });
  await hook(d, term.id, { hook_event_name: 'UserPromptSubmit', session_id: sid, prompt: 'go' });
  await hook(d, term.id, { hook_event_name: 'Stop', session_id: sid });
  const m = await c.next((x) => sessionOf(x, term.id)?.state === 'done');
  const at = sessionOf(m, term.id)!.lastMessageAt!;
  expect(at).toBeGreaterThan(0);
  c.close();
  await d.stop();
  d = await runDaemon({ home, version: 't', shellArgs: ['-f'], userClaudeSettings: join(home, 'x.json'), extraEnv: NO_CLAUDE });
  running.push(d);
  c = await connectControl(d.paths.sock, d.info.token);
  const res = await c.next((x) => x.t === 'resumables' && x.list.length === 1) as Extract<ServerMessage, { t: 'resumables' }>;
  expect(res.list[0]!.lastMessageAt).toBe(at);
  c.send({ t: 'resume', rid: 2, id: res.list[0]!.id, cols: 80, rows: 24 });
  const resumed = ((await c.next((x) => x.t === 'reply' && x.rid === 2)) as Extract<ServerMessage, { t: 'reply'; ok: true }>).result as TerminalInfo;
  await hook(d, resumed.id, { hook_event_name: 'SessionStart', session_id: sid, source: 'resume' });
  await c.next((x) => sessionOf(x, resumed.id)?.lastMessageAt === at);
});
