import { describe, expect, test } from 'vitest';
import type { TerminalInfo } from '@shared/protocol';
import type { SessionInfo } from '@shared/session';
import { McpWatch, READ_EVERY_MS, type McpPair } from './mcp-watch';

// New MCP servers: baselines when a session appears, a stat poll, additions only.

const session = (sessionId = 's1'): SessionInfo => ({ sessionId, state: 'idle', title: '', activity: null, contextPct: null, unread: false, updatedAt: 0, cwd: '/p' } as unknown as SessionInfo);
const term = (id: string, s: SessionInfo | null, projectRoot = '/p'): TerminalInfo => ({ id, projectRoot, cwd: '/p', title: id, color: '#fff', foreground: 'claude', createdAt: 0, session: s } as unknown as TerminalInfo);

/** One fake config per pair: its servers and a signature that changes with every write. */
function fakeFs() {
  const configs = new Map<string, { names: string[]; sig: number }>([['/p', { names: ['a'], sig: 1 }]]);
  let reads = 0;
  return {
    write(cwd: string, names: string[]) { const c = configs.get(cwd) ?? { names: [], sig: 0 }; configs.set(cwd, { names, sig: c.sig + 1 }); },
    touch(cwd: string) { const c = configs.get(cwd)!; c.sig += 1; },
    get reads() { return reads; },
    deps: {
      pairOf: (t: TerminalInfo): McpPair => ({ key: t.session?.cwd ?? t.cwd, files: [`${t.session?.cwd ?? t.cwd}/.mcp.json`], read: async () => { reads += 1; return [...(configs.get(t.session?.cwd ?? t.cwd)?.names ?? [])]; } }),
      stat: async (path: string) => String(configs.get(path.replace(/\/\.mcp\.json$/, ''))?.sig ?? 0)
    }
  };
}

async function setup() {
  const fs = fakeFs();
  let now = 1_000_000;
  const w = new McpWatch({ ...fs.deps, now: () => now });
  return { fs, w, advance: (ms: number) => { now += ms; } };
}

describe('McpWatch', () => {
  test('a session gets its baseline when it appears; a server added later shows as new for it', async () => {
    const { fs, w, advance } = await setup();
    await w.update([term('t1', session())]);
    expect(w.addedIn('/p')).toEqual({});
    fs.write('/p', ['a', 'posthog']);
    advance(READ_EVERY_MS);
    expect(await w.tick()).toBe(true);
    expect(w.addedIn('/p')).toEqual({ t1: ['posthog'] });
    // Nothing changed since: no news.
    advance(READ_EVERY_MS);
    expect(await w.tick()).toBe(false);
  });

  test('a session started after the server was added has it in its baseline', async () => {
    const { fs, w } = await setup();
    fs.write('/p', ['a', 'posthog']);
    await w.update([term('t1', session())]);
    await w.tick();
    expect(w.addedIn('/p')).toEqual({});
  });

  test('a /clear (new session id, same process) keeps the baseline; Claude starting again (restart) resets it', async () => {
    const { fs, w, advance } = await setup();
    await w.update([term('t1', session('s1'))]);
    fs.write('/p', ['a', 'posthog']);
    advance(READ_EVERY_MS);
    await w.tick();
    await w.update([term('t1', session('s2'))]);
    expect(w.addedIn('/p')).toEqual({ t1: ['posthog'] });
    // Claude quit (the terminal is a shell again), then the resume started it: its servers are loaded now.
    await w.update([term('t1', null)]);
    expect(w.addedIn('/p')).toEqual({});
    await w.update([term('t1', session('s2'))]);
    advance(READ_EVERY_MS);
    await w.tick();
    expect(w.addedIn('/p')).toEqual({});
  });

  test('removed servers never count', async () => {
    const { fs, w, advance } = await setup();
    fs.write('/p', ['a', 'b']);
    await w.update([term('t1', session())]);
    fs.write('/p', ['a']);
    advance(READ_EVERY_MS);
    await w.tick();
    expect(w.addedIn('/p')).toEqual({});
  });

  test('a changed file is read again at most once every 15 s (~/.claude.json changes often)', async () => {
    const { fs, w, advance } = await setup();
    await w.update([term('t1', session())]);
    const before = fs.reads;
    fs.write('/p', ['a', 'x']);
    advance(1_000);
    await w.tick();
    expect(fs.reads).toBe(before);
    expect(w.addedIn('/p')).toEqual({});
    advance(READ_EVERY_MS);
    await w.tick();
    expect(fs.reads).toBe(before + 1);
    expect(w.addedIn('/p')).toEqual({ t1: ['x'] });
    // Unchanged files are never read again.
    advance(READ_EVERY_MS);
    await w.tick();
    expect(fs.reads).toBe(before + 1);
  });

  test('by project; a terminal that left takes its news with it', async () => {
    const { fs, w, advance } = await setup();
    await w.update([term('t1', session()), term('t2', session(), '/q')]);
    fs.write('/p', ['a', 'n']);
    advance(READ_EVERY_MS);
    await w.tick();
    expect(w.addedIn('/p')).toEqual({ t1: ['n'] });
    expect(w.addedIn('/q')).toEqual({ t2: ['n'] });
    await w.update([term('t2', session(), '/q')]);
    expect(w.addedIn('/p')).toEqual({});
    expect(w.live()).toBe(true);
    await w.update([]);
    expect(w.live()).toBe(false);
  });

  test('sessions of one folder and account share one read; a later session reuses it while the files are unchanged (review 4)', async () => {
    const { fs, w } = await setup();
    await w.update([term('t1', session()), term('t2', session()), term('t3', session())]);
    expect(fs.reads).toBe(1);
    await w.update([term('t1', session()), term('t2', session()), term('t3', session()), term('t4', session())]);
    expect(fs.reads).toBe(1);
    // Changed since: the new session's baseline is read again.
    fs.write('/p', ['a', 'z']);
    await w.update([term('t1', session()), term('t5', session())]);
    expect(fs.reads).toBe(2);
    await w.tick();
    expect(w.addedIn('/p')).toEqual({ t1: ['z'] });
  });

  test('an unreadable config is no news (null read)', async () => {
    const fs = fakeFs();
    let now = 0;
    let broken = false;
    const w = new McpWatch({ ...fs.deps, pairOf: (t) => ({ ...fs.deps.pairOf(t), read: async () => (broken ? null : ['a']) }), now: () => now });
    await w.update([term('t1', session())]);
    broken = true;
    fs.touch('/p');
    now += READ_EVERY_MS;
    await w.tick();
    expect(w.addedIn('/p')).toEqual({});
  });
});
