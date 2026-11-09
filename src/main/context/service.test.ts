import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, toOut } from '../cpath';
import { describe, expect, test, vi } from 'vitest';
import type { TerminalInfo } from '@shared/protocol';
import { ContextService, type ContextDeps } from './service';
import type { runProbe } from './probe';
import { useMachinePlatform } from '../../../tests/support/platform';

// Real files: main checks them as the app does on this machine (native C:\ paths on Windows), and the expected
// paths are built the way main returns them (cpath).
useMachinePlatform();

const SID = '6f1c2a3b-0000-4000-8000-000000000001';
const usage = (memory: string[] = []) => ({
  categories: [{ id: 'messages', name: 'Messages', tokens: 100, kind: 'used' }, { id: 'mcp_instructions', name: 'MCP server instructions', tokens: 30, kind: 'used' }],
  totalTokens: 130, maxTokens: 1000,
  memoryFiles: memory.map((path) => ({ path, type: 'Project', tokens: 10 })),
  mcpInstructions: [{ serverName: 'docs', tokens: 10 }, { serverName: 'mine', tokens: 10 }, { serverName: 'claude.ai Tasks', tokens: 10 }]
});
const STATUS = [{ name: 'docs', status: 'connected', scope: 'project' }, { name: 'mine', status: 'connected', scope: 'user' }, { name: 'claude.ai Tasks', status: 'connected', scope: 'claudeai' }];

function setup(o: { transcript?: string | null; tailCwd?: string | null; session?: boolean; model?: string | null; run?: typeof runProbe; account?: string; bin?: string | null; configDir?: string; defaultDir?: string } = {}) {
  const base = toOut(realpathSync(mkdtempSync(join(tmpdir(), 'atl-ctx-svc-'))));
  const project = join(base, 'shop');
  const wt = join(project, '.claude', 'worktrees', 'x');
  mkdirSync(wt, { recursive: true });
  writeFileSync(join(project, 'CLAUDE.md'), '# shop');
  writeFileSync(join(project, '.mcp.json'), '{"mcpServers":{"docs":{}}}');
  writeFileSync(join(wt, '.mcp.json'), '{"mcpServers":{"docs":{}}}');
  const config = join(base, 'claude-home');
  mkdirSync(config, { recursive: true });
  writeFileSync(join(config, '.claude.json'), '{}');
  writeFileSync(join(config, 'CLAUDE.md'), '# me');
  const transcript = o.transcript === undefined ? join(config, 'conv.jsonl') : o.transcript;
  const term = {
    id: 't1', projectRoot: project, cwd: project, title: 'new sales', name: null, color: '#fff', foreground: 'claude', createdAt: 0,
    session: o.session === false ? null : { sessionId: SID, state: 'idle', title: null, activity: null, contextPct: 12, unread: false, updatedAt: 0, cwd: project, model: o.model === undefined ? 'Opus 5.5' : o.model },
    configDir: o.configDir ?? config
  } as TerminalInfo;
  const run = vi.fn(o.run ?? (async () => ({ ok: true as const, usage: usage([join(project, 'CLAUDE.md'), join(config, 'CLAUDE.md')]), status: STATUS })));
  const grant = vi.fn((_root: string, p: string): string | null => p);
  const deps: ContextDeps = {
    terminal: (id) => (id === 't1' ? term : null),
    accountDir: () => o.account,
    isDefaultDir: (dir) => dir === (o.defaultDir ?? config),
    claudeBin: () => (o.bin === undefined ? '/bin/claude' : o.bin),
    userEnv: async () => ({ PATH: '/usr/bin', HOME: '/h', CLAUDE_CONFIG_DIR: '/from/shell' }),
    globalFile: (dir) => join(dir ?? config, '.claude.json'),
    grant,
    home: base,
    now: () => 5_000,
    run,
    transcript: () => transcript,
    tail: async (f) => (f === transcript && transcript !== null ? { cwd: o.tailCwd === undefined ? wt : o.tailCwd, usage: 120 } : null)
  };
  return { svc: new ContextService(deps), run, grant, project, config, wt, base, term };
}

describe('ContextService.analyze', () => {
  test('a private copy of the session in its current folder, its model, the user\'s environment, the default account never named', async () => {
    const s = setup();
    const out = await s.svc.analyze(s.project, 't1');
    expect(out.ok).toBe(true);
    const call = s.run.mock.calls[0]![0];
    expect(call.args).toEqual(expect.arrayContaining(['--resume', SID, '--fork-session', '--model', 'opus', '--no-session-persistence']));
    expect(call.cwd).toBe(s.wt);
    expect(call.claudeBin).toBe('/bin/claude');
    // The shell's CLAUDE_CONFIG_DIR is never the default account's: dropped.
    expect(call.env.CLAUDE_CONFIG_DIR).toBeUndefined();
    expect(call.env.CLAUDE_CODE_ENTRYPOINT).toBe('atelier-context');
    expect(call.env.PATH).toContain('/usr/bin');
    expect(call.env.HOME).toBe('/h');
  });

  test('another account: its dir in the environment', async () => {
    const s = setup({ account: '/Users/dev/.claude-work' });
    await s.svc.analyze(s.project, 't1');
    expect(s.run.mock.calls[0]![0].env.CLAUDE_CONFIG_DIR).toBe('/Users/dev/.claude-work');
  });

  test('no transcript yet: no --resume; unknown model: no --model', async () => {
    const s = setup({ transcript: null, model: 'Mystery' });
    await s.svc.analyze(s.project, 't1');
    const args = s.run.mock.calls[0]![0].args;
    expect(args).not.toContain('--resume');
    expect(args).not.toContain('--model');
  });

  test('a transcript folder outside the project, or none: the session\'s start folder', async () => {
    for (const tailCwd of ['/somewhere/else', null]) {
      const s = setup({ tailCwd });
      await s.svc.analyze(s.project, 't1');
      expect(s.run.mock.calls[0]![0].cwd).toBe(s.project);
    }
  });

  test('another project\'s terminal, an unknown one or one without Claude: no-session, nothing run', async () => {
    const s = setup();
    expect(await s.svc.analyze('/other', 't1')).toMatchObject({ ok: false, kind: 'no-session' });
    expect(await s.svc.analyze(s.project, 'nope')).toMatchObject({ ok: false, kind: 'no-session' });
    const n = setup({ session: false });
    expect(await n.svc.analyze(n.project, 't1')).toMatchObject({ ok: false, kind: 'no-session' });
    expect(s.run).not.toHaveBeenCalled();
    expect(n.run).not.toHaveBeenCalled();
  });

  test('no claude binary: not-found', async () => {
    const s = setup({ bin: null });
    expect(await s.svc.analyze(s.project, 't1')).toMatchObject({ ok: false, kind: 'not-found' });
    expect(s.run).not.toHaveBeenCalled();
  });

  test('each server\'s config file: the session folder\'s .mcp.json (project), the account\'s .claude.json (user); none for claude.ai', async () => {
    const s = setup();
    const out = await s.svc.analyze(s.project, 't1');
    if (!out.ok) throw new Error('expected a report');
    expect(Object.fromEntries(out.report.servers.map((x) => [x.name, x.configFile]))).toEqual({
      docs: join(s.wt, '.mcp.json'), mine: join(s.config, '.claude.json'), 'claude.ai Tasks': null
    });
    // Shown with ~ for the home (main knows it; the page doesn't).
    expect(out.report.servers.map((x) => x.configShown)).toEqual(['~/shop/.claude/worktrees/x/.mcp.json', '~/claude-home/.claude.json', null]);
    expect(out.report.memory.map((m) => m.shown)).toEqual(['~/shop/CLAUDE.md', '~/claude-home/CLAUDE.md']);
  });

  test('a second request while one runs joins it; only the first asker gets the progress', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const s = setup({ run: async (o) => { o.onProgress?.({ phase: 'start' }); await gate; return { ok: true, usage: usage(), status: [] }; } });
    const a: unknown[] = [];
    const b: unknown[] = [];
    const one = s.svc.analyze(s.project, 't1', (p) => a.push(p));
    const two = s.svc.analyze(s.project, 't1', (p) => b.push(p));
    // Wait until the run started (the environment is read first).
    await vi.waitFor(() => expect(a).toHaveLength(1));
    release();
    const [x, y] = await Promise.all([one, two]);
    expect(x).toBe(y);
    expect(s.run).toHaveBeenCalledTimes(1);
    expect(a).toEqual([{ terminalId: 't1', phase: 'start' }]);
  });

  test('an answer that can\'t be read: unsupported', async () => {
    const s = setup({ run: async () => ({ ok: true, usage: { nothing: true }, status: [] }) });
    expect(await s.svc.analyze(s.project, 't1')).toMatchObject({ ok: false, kind: 'unsupported' });
  });

  test('dispose stops every run', async () => {
    let signal: AbortSignal | undefined;
    const s = setup({ run: (o) => { signal = o.signal; return new Promise(() => {}); } });
    void s.svc.analyze(s.project, 't1');
    await vi.waitFor(() => expect(signal).toBeDefined());
    s.svc.dispose();
    expect(signal?.aborted).toBe(true);
  });
});

describe('ContextService.live', () => {
  test('the transcript\'s last usage; none for another project or without a transcript', async () => {
    const s = setup();
    expect(await s.svc.live(s.project, 't1')).toBe(120);
    expect(await s.svc.live('/other', 't1')).toBeNull();
    const n = setup({ transcript: null });
    expect(await n.svc.live(n.project, 't1')).toBeNull();
  });
});

describe('ContextService.open', () => {
  test('only a path the last report listed: inside the project as it is, outside granted read-only', async () => {
    const s = setup();
    expect(s.svc.open(s.project, 't1', join(s.project, 'CLAUDE.md'))).toBeNull();
    await s.svc.analyze(s.project, 't1');
    expect(s.svc.open(s.project, 't1', join(s.project, 'CLAUDE.md'))).toEqual({ path: join(s.project, 'CLAUDE.md'), rel: 'CLAUDE.md' });
    expect(s.svc.open(s.project, 't1', join(s.wt, '.mcp.json'))).toEqual({ path: join(s.wt, '.mcp.json'), rel: '.claude/worktrees/x/.mcp.json' });
    expect(s.grant).not.toHaveBeenCalled();
    expect(s.svc.open(s.project, 't1', join(s.config, 'CLAUDE.md'))).toEqual({ path: join(s.config, 'CLAUDE.md'), rel: '~/claude-home/CLAUDE.md' });
    expect(s.grant).toHaveBeenCalledWith(s.project, join(s.config, 'CLAUDE.md'));
    expect(s.svc.open(s.project, 't1', join(s.config, '.claude.json'))).toMatchObject({ path: join(s.config, '.claude.json') });
    // Not listed: refused, whatever it is.
    expect(s.svc.open(s.project, 't1', join(s.project, '.mcp.json'))).toBeNull();
    expect(s.svc.open(s.project, 't1', '/etc/hosts')).toBeNull();
    expect(s.svc.open('/other', 't1', join(s.project, 'CLAUDE.md'))).toBeNull();
  });

  test('a listed path that is now a symlink, or gone, is refused; a refused grant is no file', async () => {
    const s = setup();
    await s.svc.analyze(s.project, 't1');
    const target = join(s.base, 'secret.txt');
    writeFileSync(target, 'x');
    const memory = join(s.config, 'CLAUDE.md');
    rmSync(memory);
    symlinkSync(target, memory);
    expect(s.svc.open(s.project, 't1', memory)).toBeNull();
    rmSync(join(s.config, '.claude.json'));
    expect(s.svc.open(s.project, 't1', join(s.config, '.claude.json'))).toBeNull();
  });

  test('a grant refused (the store full of open files): nothing opens', async () => {
    const s = setup();
    await s.svc.analyze(s.project, 't1');
    s.grant.mockReturnValue(null);
    expect(s.svc.open(s.project, 't1', join(s.config, 'CLAUDE.md'))).toBeNull();
  });
});

describe('ContextService: accounts, the conversation, runs replaced', () => {
  test('a session on a Claude account Atelier doesn\'t know is refused, never analysed as the default account\'s', async () => {
    const s = setup({ configDir: '/Users/dev/.claude-unknown' });
    expect(await s.svc.analyze(s.project, 't1')).toMatchObject({ ok: false, kind: 'account' });
    expect(s.run).not.toHaveBeenCalled();
    // A configured account, the default one, or no dir known (an older atelierd): analysed.
    for (const o of [{ configDir: '/Users/dev/.claude-work', account: '/Users/dev/.claude-work' }, {}]) {
      const ok = setup(o);
      expect((await ok.svc.analyze(ok.project, 't1')).ok).toBe(true);
    }
  });

  test('the report says whether the conversation was read', async () => {
    const s = setup();
    const out = await s.svc.analyze(s.project, 't1');
    expect(out.ok && out.report.resumed).toBe(true);
    const n = setup({ transcript: null });
    const none = await n.svc.analyze(n.project, 't1');
    expect(none.ok && none.report.resumed).toBe(false);
  });

  test('another session in the terminal stops the old run and starts its own', async () => {
    const signals: AbortSignal[] = [];
    const s = setup({ run: (o) => { signals.push(o.signal!); return new Promise((resolve) => o.signal!.addEventListener('abort', () => resolve({ ok: false, kind: 'exit', message: 'Stopped' }))); } });
    const first = s.svc.analyze(s.project, 't1');
    await vi.waitFor(() => expect(signals).toHaveLength(1));
    s.term.session = { ...s.term.session!, sessionId: '6f1c2a3b-0000-4000-8000-000000000002' };
    void s.svc.analyze(s.project, 't1');
    await vi.waitFor(() => expect(signals).toHaveLength(2));
    expect(signals[0]!.aborted).toBe(true);
    expect(await first).toEqual({ ok: false, kind: 'exit', message: 'Stopped' });
    expect(signals[1]!.aborted).toBe(false);
  });

  test('open() refuses once the terminal runs another session, and forgets terminals gone', async () => {
    const s = setup();
    await s.svc.analyze(s.project, 't1');
    const memory = join(s.project, 'CLAUDE.md');
    expect(s.svc.open(s.project, 't1', memory)).not.toBeNull();
    s.term.session = { ...s.term.session!, sessionId: '6f1c2a3b-0000-4000-8000-000000000003' };
    expect(s.svc.open(s.project, 't1', memory)).toBeNull();
    expect(s.svc.reports()).toBe(0);
  });
});
