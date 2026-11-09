import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import type { RepoStatus } from '@shared/git';
import type { TerminalInfo } from '@shared/protocol';
import type { SessionInfo } from '@shared/session';
import type { ToolCallWindow } from '@shared/tool-calls';
import { BashAttributions } from './bash-attributions';
import { expectMode } from '../../tests/support/platform';

const tmp = () => mkdtempSync(join(tmpdir(), 'atl-bash-'));

/** A fake clock and fake mtimes: the class only reads files through `stat`. */
function setup(file: string | null = null, statOverride?: (p: string) => Promise<number | null>) {
  let now = 1_000_000;
  const mtimes = new Map<string, number | null>();
  const b = new BashAttributions(file, { now: () => now, stat: statOverride ?? (async (p) => mtimes.get(p) ?? null), realpath: (p) => p });
  let changes = 0;
  b.onChange = () => { changes++; };
  return {
    b, mtimes,
    at: (t: number) => { now = t; },
    changes: () => changes
  };
}

const session = (id: string, activity: string | null, updatedAt: number, state: SessionInfo['state'] = 'running'): SessionInfo =>
  ({ sessionId: id, state, title: null, activity, contextPct: null, unread: false, updatedAt });
const terminal = (id: string, s: SessionInfo | null, projectRoot = '/p'): TerminalInfo =>
  ({ id, projectRoot, cwd: projectRoot, title: `Session ${id}`, name: null, color: `#${id}`, foreground: 'claude', createdAt: 0, session: s });
const status = (checkedAt: number, paths: string[], over: Partial<RepoStatus> = {}): RepoStatus => ({
  root: '/p', name: 'p', branch: 'main', detached: false, ahead: 0, behind: 0, oid: 'a', checkedAt, truncated: 0,
  changes: paths.map((path) => ({ path, rel: path.slice(3), kind: 'M', stage: 'none', added: 1, removed: 0 })), ...over
});
const keep = { prune: false, exclude: [] };

describe('BashAttributions', () => {
  test('a file changed while one session runs Bash goes to that session, via Bash', async () => {
    const { b, mtimes, at, changes } = setup();
    await b.status(status(1_000_000, []), keep);
    at(1_001_000);
    b.setTerminals([terminal('t1', session('s1', 'Bash: Rewrite imports', 1_000_900)), terminal('t2', session('s2', 'read a.ts', 1_000_950))]);
    mtimes.set('/p/a.ts', 1_002_000);
    at(1_003_000);
    await b.status(status(1_003_000, ['/p/a.ts']), keep);
    expect(b.list()).toEqual([{ path: '/p/a.ts', terminalId: 't1', sessionId: 's1', color: '#t1', title: 'Session t1', at: 1_003_000, via: 'bash' }]);
    expect(changes()).toBe(1);
  });

  test('the first status of a repo is only a baseline: files already dirty are not attributed', async () => {
    const { b, mtimes } = setup();
    b.setTerminals([terminal('t1', session('s1', 'Bash', 999_000))]);
    mtimes.set('/p/a.ts', 999_500);
    await b.status(status(1_000_000, ['/p/a.ts']), keep);
    expect(b.list()).toEqual([]);
  });

  test('two sessions in Bash at that moment: unknown origin', async () => {
    const { b, mtimes, at } = setup();
    await b.status(status(1_000_000, []), keep);
    b.setTerminals([terminal('t1', session('s1', 'Bash: a', 1_000_100)), terminal('t2', session('s2', 'Bash: b', 1_000_200))]);
    mtimes.set('/p/a.ts', 1_002_000);
    at(1_003_000);
    await b.status(status(1_003_000, ['/p/a.ts']), keep);
    expect(b.list()).toEqual([]);
  });

  test('a session whose background subagent edits via Bash is a suspect too: never given to the other session in Bash', async () => {
    const { b, mtimes, at } = setup();
    await b.status(status(1_000_000, []), keep);
    // t2's main turn is over ('done', no activity) while its background subagent rewrites files with python3/cat.
    const busy = { ...session('s2', null, 1_000_050, 'done'), subagents: 1 };
    b.setTerminals([terminal('t1', session('s1', 'Bash: Read the update code', 1_000_100)), terminal('t2', busy)]);
    mtimes.set('/p/a.ts', 1_002_000);
    at(1_003_000);
    await b.status(status(1_003_000, ['/p/a.ts']), keep);
    expect(b.list()).toEqual([]);
    // Alone, the subagent's session gets its change.
    b.setTerminals([terminal('t1', session('s1', 'read x', 1_003_500)), terminal('t2', busy)]);
    mtimes.set('/p/b.ts', 1_005_000);
    at(1_006_000);
    await b.status(status(1_006_000, ['/p/a.ts', '/p/b.ts']), keep);
    expect(b.list().map((a) => [a.path, a.terminalId])).toEqual([['/p/b.ts', 't2']]);
  });

  test('the window ends at the hook that left Bash: a later change is not the session\'s', async () => {
    const { b, mtimes, at } = setup();
    await b.status(status(1_000_000, []), keep);
    b.setTerminals([terminal('t1', session('s1', 'Bash: a', 1_000_100))]);
    at(1_005_000);
    b.setTerminals([terminal('t1', session('s1', 'edit b.ts', 1_004_000))]);
    mtimes.set('/p/a.ts', 1_008_000);
    at(1_009_000);
    await b.status(status(1_009_000, ['/p/a.ts']), keep);
    expect(b.list()).toEqual([]);
  });

  test('a path with a daemon (Edit/Write) attribution is never attributed via Bash', async () => {
    const { b, mtimes, at } = setup();
    await b.status(status(1_000_000, []), keep);
    b.setTerminals([terminal('t1', session('s1', 'Bash: a', 1_000_100))]);
    b.setDaemonAttributions([{ path: '/p/a.ts', terminalId: 't2', sessionId: 's2', color: 'c', title: 'Edit', at: 1_001_000 }]);
    mtimes.set('/p/a.ts', 1_002_000);
    at(1_003_000);
    await b.status(status(1_003_000, ['/p/a.ts']), keep);
    expect(b.list()).toEqual([]);
  });

  test('a file saved from Atelier\'s editor meanwhile is the user\'s, not the session\'s', async () => {
    const { b, mtimes, at } = setup();
    await b.status(status(1_000_000, []), keep);
    b.setTerminals([terminal('t1', session('s1', 'Bash: a', 1_000_100))]);
    at(1_002_000);
    b.noteAppWrite('/p/a.ts');
    mtimes.set('/p/a.ts', 1_002_000);
    at(1_003_000);
    await b.status(status(1_003_000, ['/p/a.ts']), keep);
    expect(b.list()).toEqual([]);
  });

  test('only sessions of a project that contains the repo count', async () => {
    const { b, mtimes, at } = setup();
    await b.status(status(1_000_000, []), keep);
    b.setTerminals([terminal('t1', session('s1', 'Bash: a', 1_000_100)), terminal('t9', session('s9', 'Bash: b', 1_000_100), '/elsewhere')]);
    mtimes.set('/p/a.ts', 1_002_000);
    at(1_003_000);
    await b.status(status(1_003_000, ['/p/a.ts']), keep);
    expect(b.list().map((a) => a.terminalId)).toEqual(['t1']);
  });

  test('an incomplete status attributes nothing and the next one is a baseline again', async () => {
    const { b, mtimes, at } = setup();
    await b.status(status(1_000_000, []), keep);
    b.setTerminals([terminal('t1', session('s1', 'Bash: a', 1_000_100))]);
    mtimes.set('/p/a.ts', 1_002_000);
    at(1_003_000);
    await b.status(status(1_003_000, ['/p/a.ts'], { truncated: 5 }), keep);
    expect(b.list()).toEqual([]);
    mtimes.set('/p/b.ts', 1_003_500);
    at(1_004_000);
    await b.status(status(1_004_000, ['/p/a.ts', '/p/b.ts']), keep);
    expect(b.list()).toEqual([]);
  });

  test('pruned by the same rule as daemon attributions (HEAD moved: clean files lose them)', async () => {
    const { b, mtimes, at, changes } = setup();
    await b.status(status(1_000_000, []), keep);
    b.setTerminals([terminal('t1', session('s1', 'Bash: a', 1_000_100))]);
    mtimes.set('/p/a.ts', 1_002_000);
    at(1_003_000);
    await b.status(status(1_003_000, ['/p/a.ts']), keep);
    expect(b.list()).toHaveLength(1);
    at(1_010_000);
    await b.status(status(1_010_000, [], { oid: 'b' }), { prune: true, exclude: [] });
    expect(b.list()).toEqual([]);
    expect(changes()).toBe(2);
  });

  test('files in the keep set survive a prune as if dirty; pruned once no longer kept', async () => {
    const { b, mtimes, at } = setup();
    await b.status(status(1_000_000, []), keep);
    b.setTerminals([terminal('t1', session('s1', 'Bash: a', 1_000_100))]);
    mtimes.set('/p/a.ts', 1_002_000);
    mtimes.set('/p/b.ts', 1_002_000);
    at(1_003_000);
    await b.status(status(1_003_000, ['/p/a.ts', '/p/b.ts']), keep);
    expect(b.list().map((x) => x.path)).toEqual(['/p/a.ts', '/p/b.ts']);
    // Committed by Atelier with Undo offered: HEAD moved, both clean, a.ts held.
    at(1_010_000);
    await b.status(status(1_010_000, [], { oid: 'b' }), { prune: true, exclude: [], keep: ['/p/a.ts'] });
    expect(b.list().map((x) => x.path)).toEqual(['/p/a.ts']);
    // Undo no longer offered: the next prune drops it.
    at(1_020_000);
    await b.status(status(1_020_000, [], { oid: 'c' }), { prune: true, exclude: [], keep: [] });
    expect(b.list()).toEqual([]);
  });

  test('a session whose terminal closed after the interval started still counts: no attribution to the other one', async () => {
    const { b, mtimes, at } = setup();
    await b.status(status(1_000_000, []), keep);
    at(1_000_300);
    b.setTerminals([terminal('t1', session('s1', 'Bash: a', 1_000_100)), terminal('t2', session('s2', 'Bash: b', 1_000_200))]);
    mtimes.set('/p/a.ts', 1_000_500);
    at(1_001_000);
    b.setTerminals([terminal('t2', session('s2', 'Bash: b', 1_000_200))]); // t1 closed
    at(1_003_000);
    await b.status(status(1_003_000, ['/p/a.ts']), keep);
    expect(b.list()).toEqual([]);
  });

  test('a change made in Bash by a session whose terminal closed since goes to that session', async () => {
    const { b, mtimes, at } = setup();
    await b.status(status(1_000_000, []), keep);
    at(1_000_300);
    b.setTerminals([terminal('t1', session('s1', 'Bash: a', 1_000_100)), terminal('t2', session('s2', 'read x', 1_000_200))]);
    mtimes.set('/p/a.ts', 1_000_500);
    at(1_001_000);
    b.setTerminals([terminal('t2', session('s2', 'read x', 1_000_200))]); // t1 closed
    at(1_002_500);
    b.setTerminals([terminal('t2', session('s2', 'Bash: b', 1_002_400))]); // t2 in Bash only later
    at(1_003_000);
    await b.status(status(1_003_000, ['/p/a.ts']), keep);
    expect(b.list()).toEqual([{ path: '/p/a.ts', terminalId: 't1', sessionId: 's1', color: '#t1', title: 'Session t1', at: 1_003_000, via: 'bash' }]);
  });

  test('no Bash window in the interval: no stat at all; the next interval still attributes only what changed in it', async () => {
    let stats = 0;
    let now = 1_000_000;
    const mtimes = new Map<string, number | null>([['/p/a.ts', 500_000], ['/p/c.ts', 1_002_000], ['/p/d.ts', 900_000]]);
    const b = new BashAttributions(null, { now: () => now, stat: async (p) => { stats++; return mtimes.get(p) ?? null; }, realpath: (p) => p });
    await b.status(status(1_000_000, ['/p/a.ts']), keep);
    expect(stats).toBe(1); // the baseline
    b.setTerminals([terminal('t1', session('s1', 'read x', 1_000_500))]);
    now = 1_003_000;
    await b.status(status(1_003_000, ['/p/a.ts', '/p/c.ts', '/p/d.ts']), keep);
    expect(stats).toBe(1); // nobody in Bash since the last status: nothing to examine
    // Then a session runs Bash: only b.ts changed meanwhile; d.ts was deleted at some unknown time (no guess).
    now = 1_004_000;
    b.setTerminals([terminal('t1', session('s1', 'Bash: gen', 1_004_000))]);
    mtimes.set('/p/b.ts', 1_005_000);
    mtimes.set('/p/d.ts', null);
    now = 1_006_000;
    await b.status(status(1_006_000, ['/p/a.ts', '/p/b.ts', '/p/c.ts', '/p/d.ts']), keep);
    expect(stats).toBe(5);
    expect(b.list().map((x) => x.path)).toEqual(['/p/b.ts']);
  });

  test('the saved file is bounded in bytes (the newest kept); a big file from before still loads what parses', async () => {
    const dir = tmp();
    const file = join(dir, 'bash-attributions.json');
    const old = Array.from({ length: 1500 }, (_, i) => ({ path: `/p/${'x'.repeat(2000)}-${i}.ts`, terminalId: 't0', sessionId: 's0', color: '#t0', title: 'Old', at: 1000 + i, via: 'bash' }));
    writeFileSync(file, JSON.stringify({ v: 1, list: [...old, { path: 'relative' }] }));
    expect(statSync(file).size).toBeGreaterThan(2 * 1024 * 1024);
    const { b, mtimes, at } = setup(file);
    // The newest that fit the bound, not nothing.
    expect(b.list().length).toBeGreaterThan(500);
    expect(b.list().at(-1)!.at).toBe(1000 + 1499);
    await b.status(status(1_000_000, []), keep);
    b.setTerminals([terminal('t1', session('s1', 'Bash: a', 1_000_100))]);
    mtimes.set('/p/a.ts', 1_002_000);
    at(1_003_000);
    await b.status(status(1_003_000, ['/p/a.ts']), keep);
    expect(statSync(file).size).toBeLessThanOrEqual(2 * 1024 * 1024);
    const back = new BashAttributions(file).list();
    expect(back.length).toBeGreaterThan(500);
    expect(back.at(-1)).toMatchObject({ path: '/p/a.ts', terminalId: 't1' });
    expect(back.some((x) => x.at === 1000)).toBe(false); // the oldest went first
    expect(back.some((x) => x.at === 1000 + 1499)).toBe(true);
  });

  test('persisted in its own file (0600), bounded, read back; a broken file is ignored', async () => {
    const dir = tmp();
    const file = join(dir, 'bash-attributions.json');
    const { b, mtimes, at } = setup(file);
    await b.status(status(1_000_000, []), keep);
    b.setTerminals([terminal('t1', session('s1', 'Bash: a', 1_000_100))]);
    mtimes.set('/p/a.ts', 1_002_000);
    at(1_003_000);
    await b.status(status(1_003_000, ['/p/a.ts']), keep);
    expectMode(file, 0o600);
    expect(JSON.parse(readFileSync(file, 'utf8')).list).toHaveLength(1);
    expect(new BashAttributions(file).list()).toEqual(b.list());

    writeFileSync(file, '{"list":[{"path":"rel","terminalId":"t"}, 3]}');
    expect(new BashAttributions(file).list()).toEqual([]);
    writeFileSync(file, '{');
    expect(new BashAttributions(file).list()).toEqual([]);
  });
});

const win = (terminalId: string, start: number, end: number | null, over: Partial<ToolCallWindow> = {}): ToolCallWindow =>
  ({ id: `${terminalId}-${start}`, terminalId, sessionId: `s${terminalId.slice(1)}`, agent: 'main', tool: 'Bash', command: 'python3 x.py', start, end, ...over });

describe('BashAttributions with tool-call windows (capability toolcalls)', () => {
  test('the incident: a change inside the writer\'s call goes to it, not to the explorer that ran sed -n just before', async () => {
    const { b, mtimes, at } = setup();
    b.setTerminals([terminal('t1', session('s1', null, 1_000_000, 'done')), terminal('t2', session('s2', null, 1_000_000, 'done'))]);
    b.setToolCalls([], true);
    await b.status(status(1_000_000, []), keep);
    b.setToolCalls([win('t1', 1_000_100, 1_000_600, { command: 'sed -n 1,40p a.ts' }), win('t2', 1_002_000, 1_002_400, { agent: 'agent:x' })], false);
    mtimes.set('/p/a.ts', 1_002_150);
    at(1_003_000);
    await b.status(status(1_003_000, ['/p/a.ts']), keep);
    expect(b.list()).toEqual([{ path: '/p/a.ts', terminalId: 't2', sessionId: 's2', color: '#t2', title: 'Session t2', at: 1_003_000, via: 'bash', changedAt: 1_002_150, command: 'python3 x.py', callStart: 1_002_000, callEnd: 1_002_400 }]);
  });

  test('a full list ending the wait asks for a fresh baseline; deltas, null and legacy do not', () => {
    const { b } = setup();
    let n = 0;
    b.onBaselineNeeded = () => { n++; };
    b.awaitToolCalls(true);
    b.setToolCalls([win('t1', 1, null)], false);
    expect(n).toBe(0);
    b.setToolCalls([], true);
    expect(n).toBe(1);
    b.setToolCalls([], true);
    expect(n).toBe(1);
    b.setToolCalls(null);
    expect(n).toBe(1);
    // A downgrade while the full list is pending: an older atelierd answers with null, no baseline is asked for.
    b.setToolCalls([], true);
    b.awaitToolCalls(false);
    b.setToolCalls(null);
    expect(n).toBe(1);
  });

  test('the first change after connecting is attributed once the baseline status the hook asked for has run', async () => {
    const { b, mtimes, at } = setup();
    b.setTerminals([terminal('t1', session('s1', null, 0, 'done'))]);
    await b.status(status(1_000_000, []), keep); // before atelierd connected
    b.awaitToolCalls(true);
    // The full list arrives: the app asks for a status of every repo, which is the baseline.
    b.onBaselineNeeded = () => { void b.status(status(1_000_500, []), keep); };
    b.setToolCalls([win('t1', 1_001_000, null)], true);
    await Promise.resolve();
    mtimes.set('/p/a.ts', 1_002_000);
    at(1_003_000);
    await b.status(status(1_003_000, ['/p/a.ts']), keep);
    expect(b.list().map((x) => [x.terminalId, x.path])).toEqual([['t1', '/p/a.ts']]);
  });

  test('two writing calls at that moment: unclear, one entry per candidate', async () => {
    const { b, mtimes, at } = setup();
    b.setTerminals([terminal('t1', session('s1', null, 0, 'done')), terminal('t2', session('s2', null, 0, 'done'))]);
    b.setToolCalls([win('t1', 1_001_000, null), win('t2', 1_001_500, 1_002_500, { tool: 'mcp__fs__write_file', command: undefined })], true);
    await b.status(status(1_000_000, []), keep);
    mtimes.set('/p/a.ts', 1_002_000);
    at(1_003_000);
    await b.status(status(1_003_000, ['/p/a.ts']), keep);
    expect(b.list()).toEqual([
      { path: '/p/a.ts', terminalId: 't1', sessionId: 's1', color: '#t1', title: 'Session t1', at: 1_003_000, via: 'bash', unclear: ['t1', 't2'], changedAt: 1_002_000, command: 'python3 x.py', callStart: 1_001_000 },
      { path: '/p/a.ts', terminalId: 't2', sessionId: 's2', color: '#t2', title: 'Session t2', at: 1_003_000, via: 'tool', tool: 'mcp__fs__write_file', unclear: ['t1', 't2'], changedAt: 1_002_000, callStart: 1_001_500, callEnd: 1_002_500 }
    ]);
  });

  test('a terminal closed after its call still gets the change, with its last title and color', async () => {
    const { b, mtimes, at } = setup();
    b.setTerminals([terminal('t1', session('s1', null, 1_000_000, 'done'))]);
    b.setToolCalls([], true);
    await b.status(status(1_000_000, []), keep);
    b.setToolCalls([win('t1', 1_001_000, 1_001_400)], false);
    b.setTerminals([]); // t1 closed
    mtimes.set('/p/a.ts', 1_001_200);
    at(1_003_000);
    await b.status(status(1_003_000, ['/p/a.ts']), keep);
    expect(b.list().map((a) => [a.terminalId, a.title])).toEqual([['t1', 'Session t1']]);
  });

  test('no writing call since the last status: nothing is stat\'ed', async () => {
    let stats = 0;
    const { b, at } = setup(null, async () => { stats++; return 1; });
    b.setTerminals([terminal('t1', session('s1', null, 0, 'done'))]);
    b.setToolCalls([win('t1', 1_000_500, 1_000_700, { command: 'git status' })], true);
    await b.status(status(1_000_000, []), keep);
    at(1_003_000);
    await b.status(status(1_003_000, ['/p/a.ts']), keep);
    expect(stats).toBe(0);
    expect(b.list()).toEqual([]);
  });

  test('back to an older atelierd (null): the Bash-window heuristic again', async () => {
    const { b, mtimes, at } = setup();
    b.setToolCalls([], true);
    b.setToolCalls(null);
    await b.status(status(1_000_000, []), keep);
    b.setTerminals([terminal('t1', session('s1', 'Bash: Rewrite', 1_000_900))]);
    mtimes.set('/p/a.ts', 1_002_000);
    at(1_003_000);
    await b.status(status(1_003_000, ['/p/a.ts']), keep);
    expect(b.list().map((a) => a.terminalId)).toEqual(['t1']);
  });

  test('unclear and tool entries survive a reload of the saved file', async () => {
    const file = join(tmp(), 'bash-attributions.json');
    writeFileSync(file, JSON.stringify({ v: 1, list: [
      { path: '/p/a.ts', terminalId: 't1', sessionId: 's1', color: '#a', title: 'A', at: 1, via: 'tool', tool: 'mcp__fs__write_file', unclear: ['t1', 't2'] },
      { path: '/p/b.ts', terminalId: 't1', sessionId: 's1', color: '#a', title: 'A', at: 1, unclear: ['t1'] },
      { path: '/p/c.ts', terminalId: 't1', sessionId: 's1', color: '#a', title: 'A', at: 1 }
    ] }));
    const { b } = setup(file);
    expect(b.list()).toEqual([
      { path: '/p/a.ts', terminalId: 't1', sessionId: 's1', color: '#a', title: 'A', at: 1, via: 'tool', tool: 'mcp__fs__write_file', unclear: ['t1', 't2'] },
      { path: '/p/c.ts', terminalId: 't1', sessionId: 's1', color: '#a', title: 'A', at: 1, via: 'bash' }
    ]);
  });

  const idle = (id: string) => terminal(id, session(`s${id.slice(1)}`, null, 0, 'done'));

  test('an mtime 0.3-1 s before an unknown snapshot is the user\'s save: a later writing call does not get it', async () => {
    const { b, mtimes, at } = setup();
    b.setTerminals([idle('t1')]);
    b.setToolCalls([], true);
    mtimes.set('/p/a.ts', 900_000);
    await b.status(status(1_000_000, ['/p/a.ts']), keep);
    mtimes.set('/p/a.ts', 1_004_500); // the user saves
    at(1_005_000);
    await b.status(status(1_005_000, ['/p/a.ts']), keep); // no calls: unknown snapshot
    b.setToolCalls([win('t1', 1_006_000, 1_006_500)], false);
    at(1_007_000);
    await b.status(status(1_007_000, ['/p/a.ts']), keep);
    expect(b.list()).toEqual([]);
  });

  test('reconnect: the closed terminal\'s calls arrive after the terminal list, the change stays unclear', async () => {
    const { b, mtimes, at } = setup();
    b.setTerminals([idle('t1'), idle('t2')]);
    b.setToolCalls([], true);
    await b.status(status(1_000_000, []), keep);
    b.awaitToolCalls(false); // disconnected
    b.awaitToolCalls(true); // connected again, the full list is pending
    b.setTerminals([idle('t2')]); // t1 closed meanwhile
    b.setToolCalls([win('t1', 1_001_000, 1_002_000), win('t2', 1_001_500, 1_002_500)], true);
    at(1_000_500);
    await b.status(status(1_000_500, []), keep); // the first status after a reconnect is a baseline
    mtimes.set('/p/a.ts', 1_001_800);
    at(1_003_000);
    await b.status(status(1_003_000, ['/p/a.ts']), keep);
    expect(b.list().map((a) => [a.terminalId, a.unclear])).toEqual([['t1', ['t1', 't2']], ['t2', ['t1', 't2']]]);
  });

  test('a writing call of a terminal never seen: the change is attributed to nobody', async () => {
    const { b, mtimes, at } = setup();
    b.setTerminals([idle('t2')]);
    b.setToolCalls([], true);
    await b.status(status(1_000_000, []), keep);
    b.setToolCalls([win('t9', 1_001_000, 1_002_000), win('t2', 1_001_500, 1_002_500)], false);
    mtimes.set('/p/a.ts', 1_001_800);
    at(1_003_000);
    await b.status(status(1_003_000, ['/p/a.ts']), keep);
    expect(b.list()).toEqual([]);
  });

  test('statuses while the full list is pending are baselines', async () => {
    const { b, mtimes, at } = setup();
    b.setTerminals([idle('t1')]);
    b.setToolCalls([], true);
    await b.status(status(1_000_000, []), keep);
    b.awaitToolCalls(false);
    mtimes.set('/p/a.ts', 1_001_800);
    at(1_003_000);
    await b.status(status(1_003_000, ['/p/a.ts']), keep);
    b.setToolCalls([win('t1', 1_001_000, 1_002_000)], true);
    at(1_004_000);
    await b.status(status(1_004_000, ['/p/a.ts']), keep);
    expect(b.list()).toEqual([]);
  });

  test('a previous status older than the call retention is a new baseline: a still-open background shell does not get the change', async () => {
    const { b, mtimes, at } = setup();
    b.setTerminals([idle('t1')]);
    b.setToolCalls([win('t1', 1_000_100, null, { background: true, taskId: 'bg', command: 'npm run dev' })], true);
    await b.status(status(1_000_000, []), keep);
    const later = 1_000_000 + 15 * 60_000;
    mtimes.set('/p/a.ts', later - 1000);
    at(later);
    await b.status(status(later, ['/p/a.ts']), keep);
    expect(b.list()).toEqual([]);
  });

  test('more than 16 candidates: nobody', async () => {
    const { b, mtimes, at } = setup();
    const ids = Array.from({ length: 17 }, (_, i) => `t${i + 1}`);
    b.setTerminals(ids.map(idle));
    b.setToolCalls(ids.map((id) => win(id, 1_001_000, 1_002_000)), true);
    await b.status(status(1_000_000, []), keep);
    mtimes.set('/p/a.ts', 1_001_500);
    at(1_003_000);
    await b.status(status(1_003_000, ['/p/a.ts']), keep);
    expect(b.list()).toEqual([]);
  });

  test('a reconnect always makes the next status a baseline: a deleted file does not fall onto a new session\'s call', async () => {
    const { b, mtimes, at } = setup();
    b.setTerminals([idle('t1')]);
    b.setToolCalls([], true);
    mtimes.set('/p/a.ts', 900_000);
    await b.status(status(1_000_000, ['/p/a.ts']), keep);
    b.awaitToolCalls(false);
    b.awaitToolCalls(true); // atelierd restarted: the old windows are gone
    b.setToolCalls([win('t1', 1_005_000, 1_006_000)], true);
    mtimes.delete('/p/a.ts'); // deleted: no mtime
    at(1_007_000);
    await b.status(status(1_007_000, ['/p/a.ts']), keep);
    expect(b.list()).toEqual([]);
  });

  test('a disconnect during the stats: the stale windows do not decide', async () => {
    let n = 0;
    let bRef: BashAttributions | null = null;
    const { b, at } = setup(null, async () => { if (++n === 2) bRef?.awaitToolCalls(false); return n >= 2 ? 1_001_200 : 900_000; });
    bRef = b;
    b.setTerminals([idle('t1')]);
    b.setToolCalls([win('t1', 1_001_000, 1_001_500)], true);
    await b.status(status(1_000_000, ['/p/a.ts']), keep);
    at(1_003_000);
    await b.status(status(1_003_000, ['/p/a.ts']), keep);
    expect(b.list()).toEqual([]);
  });

  test('retention edge: the culprit lookup reaches 1.3 s before the previous status', async () => {
    const { b, mtimes, at } = setup();
    b.setTerminals([idle('t1')]);
    b.setToolCalls([win('t1', 1_000_100, null, { background: true, taskId: 'bg', command: 'npm run dev' })], true);
    await b.status(status(1_000_000, []), keep);
    const later = 1_000_000 + 10 * 60_000;
    mtimes.set('/p/a.ts', later - 1000);
    at(later);
    await b.status(status(later, ['/p/a.ts']), keep);
    expect(b.list()).toEqual([]);
  });

  const filler = (i: number) => win('t2', 1_100_000 + i * 10, 1_100_005 + i * 10);
  const writer = win('t1', 1_001_000, 1_001_500);
  const bg = win('t3', 1_000_100, null, { background: true, taskId: 'bg', command: 'npm run dev' });
  const crowded = async (full: boolean, fillers: number) => {
    const { b, mtimes, at } = setup();
    b.setTerminals([idle('t1'), idle('t2'), idle('t3')]);
    b.setToolCalls([], true);
    await b.status(status(1_000_000, []), keep);
    b.setToolCalls([writer, bg, ...Array.from({ length: fillers }, (_, i) => filler(i))], full);
    mtimes.set('/p/a.ts', 1_001_200);
    at(1_150_000);
    await b.status(status(1_150_000, ['/p/a.ts']), keep);
    return b.list();
  };

  test('count pruning dropped the real writer\'s call: the status is a baseline, the open background shell is not named', async () => {
    expect(await crowded(false, 1000)).toEqual([]);
  });

  test('a full list already at the count cap may have lost calls: same', async () => {
    expect(await crowded(true, 998)).toEqual([]);
  });

  test('a list under the cap still attributes (control)', async () => {
    expect(await crowded(false, 100)).toEqual([expect.objectContaining({ terminalId: 't1' })]);
  });

  test('disconnect then an older atelierd (null): the v1.7 heuristic attributes again', async () => {
    const { b, mtimes, at } = setup();
    b.setToolCalls([], true);
    b.awaitToolCalls(false);
    b.setToolCalls(null);
    await b.status(status(1_000_000, []), keep);
    b.setTerminals([terminal('t1', session('s1', 'Bash: Rewrite', 1_000_900))]);
    mtimes.set('/p/a.ts', 1_002_000);
    at(1_003_000);
    await b.status(status(1_003_000, ['/p/a.ts']), keep);
    expect(b.list().map((a) => a.terminalId)).toEqual(['t1']);
  });

  /** A stat that waits for `open()`: a status in flight while the connection changes. */
  const gated = () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    let value = 900_000;
    let blocking = false;
    let entered: () => void = () => {};
    const inStat = new Promise<void>((r) => { entered = r; });
    return { inStat, stat: async () => { if (blocking) { entered(); await gate; } return value; }, block: () => { blocking = true; }, open: (v: number) => { value = v; release(); } };
  };

  test('a status that started while pending and finishes after the full list does not write its gap-time baseline', async () => {
    const g = gated();
    const { b, at } = setup(null, g.stat);
    b.setTerminals([idle('t1')]);
    b.setToolCalls([], true);
    await b.status(status(1_000_000, ['/p/a.ts']), keep);
    b.awaitToolCalls(false);
    g.block();
    const inflight = b.status(status(1_000_500, ['/p/a.ts']), keep); // pending: no prev
    await g.inStat;
    b.awaitToolCalls(true);
    b.setToolCalls([win('t1', 1_001_000, 1_002_000)], true);
    g.open(900_000);
    await inflight;
    // The next status must be a baseline: nothing compares with the in-flight one.
    const g2 = { v: 1_001_800 };
    (b as unknown as { stat: (p: string) => Promise<number | null> }).stat = async () => g2.v;
    at(1_003_000);
    await b.status(status(1_003_000, ['/p/a.ts']), keep);
    expect(b.list()).toEqual([]);
  });

  test('a status whose stat loop spans disconnect, reconnect and the full list attributes nothing', async () => {
    const g = gated();
    const { b, at } = setup(null, g.stat);
    b.setTerminals([idle('t1')]);
    b.setToolCalls([], true);
    await b.status(status(1_000_000, ['/p/a.ts']), keep);
    b.setToolCalls([win('t1', 1_001_000, 1_002_000)], false); // so the status is examined (stat'ed)
    g.block();
    at(1_003_000);
    const inflight = b.status(status(1_003_000, ['/p/a.ts']), keep);
    await g.inStat;
    b.awaitToolCalls(false);
    b.awaitToolCalls(true);
    b.setToolCalls([win('t1', 1_001_000, 1_002_000)], true);
    g.open(1_001_800);
    await inflight;
    expect(b.list()).toEqual([]);
  });

  test('no cap in the app: a call open for 3 hours (a permission answered late) is still a candidate; atelierd sends its closure', async () => {
    const { b, mtimes, at } = setup();
    b.setTerminals([idle('t1')]);
    b.setToolCalls([win('t1', 1_000_000, null)], true);
    const later = 1_000_000 + 3 * 60 * 60_000;
    at(later);
    await b.status(status(later, []), keep);
    mtimes.set('/p/a.ts', later + 1000);
    at(later + 2000);
    await b.status(status(later + 2000, ['/p/a.ts']), keep);
    expect(b.list()).toEqual([expect.objectContaining({ terminalId: 't1', via: 'bash' })]);
    expect(b.list()[0]!.maybe).toBeUndefined();
  });

  test('a background shell alone at that moment: a maybe entry for its session, never a confident one', async () => {
    const { b, mtimes, at } = setup();
    b.setTerminals([idle('t1')]);
    b.setToolCalls([win('t1', 1_000_100, null, { background: true, taskId: 'bg', tool: 'Monitor', command: 'npm run dev > out.log' })], true);
    await b.status(status(1_000_000, []), keep);
    mtimes.set('/p/a.ts', 1_002_000);
    at(1_003_000);
    await b.status(status(1_003_000, ['/p/a.ts']), keep);
    expect(b.list()).toEqual([{ path: '/p/a.ts', terminalId: 't1', sessionId: 's1', color: '#t1', title: 'Session t1', at: 1_003_000, via: 'tool', tool: 'Monitor', maybe: true, changedAt: 1_002_000, command: 'npm run dev > out.log', callStart: 1_000_100 }]);
  });

  test('maybe entries survive a reload; a malformed maybe, or one also unclear, is dropped', () => {
    const file = join(tmp(), 'bash-attributions.json');
    const base = { terminalId: 't1', sessionId: 's1', color: '#a', title: 'A', at: 1, via: 'bash' };
    writeFileSync(file, JSON.stringify({ v: 1, list: [
      { ...base, path: '/p/a.ts', maybe: true },
      { ...base, path: '/p/b.ts', maybe: 'yes' },
      { ...base, path: '/p/c.ts', maybe: false },
      { ...base, path: '/p/d.ts', maybe: true, unclear: ['t1', 't2'] },
      { ...base, path: '/p/e.ts' }
    ] }));
    const { b } = setup(file);
    expect(b.list()).toEqual([{ ...base, path: '/p/a.ts', maybe: true }, { ...base, path: '/p/e.ts' }]);
  });

  test('a full list at the cap with no closed call does not disable exact attribution', async () => {
    const { b, mtimes, at } = setup();
    b.setTerminals([idle('t1')]);
    const open = Array.from({ length: 1000 }, (_, i) => win('t1', 1_000_100 + i, null, { background: true, taskId: `bg${i}`, command: 'npm run dev' }));
    b.setToolCalls(open, true);
    at(1_002_000);
    await b.status(status(1_002_000, []), keep);
    b.setToolCalls([win('t1', 1_003_000, 1_003_500)], true);
    mtimes.set('/p/a.ts', 1_003_200);
    at(1_005_000);
    await b.status(status(1_005_000, ['/p/a.ts']), keep);
    expect(b.list().map((a) => a.terminalId)).toEqual(['t1']);
  });
});

describe('unsure attributions: details and resolving by hand (spec unsure attribution UX)', () => {
  const idle = (id: string) => terminal(id, session(`s${id.slice(1)}`, null, 0, 'done'));
  /** t1 runs `npm test` (still open), t2 `git merge wt`; a.ts and b.ts change while both run. */
  async function twoWriters(file: string | null = null) {
    const s = setup(file);
    s.b.setTerminals([idle('t1'), idle('t2')]);
    s.b.setToolCalls([win('t1', 1_001_000, null, { command: 'npm test' }), win('t2', 1_001_500, 1_002_500, { command: 'git merge wt' })], true);
    await s.b.status(status(1_000_000, []), keep);
    s.mtimes.set('/p/a.ts', 1_002_000);
    s.mtimes.set('/p/b.ts', 1_002_100);
    s.at(1_003_000);
    await s.b.status(status(1_003_000, ['/p/a.ts', '/p/b.ts']), keep);
    return s;
  }
  const base = (id: string, path = '/p/a.ts') => ({ path, terminalId: id, sessionId: `s${id.slice(1)}`, color: `#${id}`, title: `Session ${id}`, at: 1_003_000 });

  test('each candidate carries the change time, its command and its call window (no end: still running)', async () => {
    const { b } = await twoWriters();
    expect(b.list().filter((a) => a.path === '/p/a.ts')).toEqual([
      { ...base('t1'), via: 'bash', unclear: ['t1', 't2'], changedAt: 1_002_000, command: 'npm test', callStart: 1_001_000 },
      { ...base('t2'), via: 'bash', unclear: ['t1', 't2'], changedAt: 1_002_000, command: 'git merge wt', callStart: 1_001_500, callEnd: 1_002_500 }
    ]);
  });

  test('an unsure entry keeps the folder its call ran from: real path, clean; a sure one does not need it', async () => {
    const file = join(tmp(), 'bash-attributions.json');
    let now = 1_000_000;
    const mt = new Map<string, number>();
    const real = (p: string) => p.replace(/^\/var\//, '/private/var/');
    const b = new BashAttributions(file, { now: () => now, stat: async (p) => mt.get(p) ?? null, realpath: real });
    b.setTerminals([terminal('t1', session('s1', null, 0, 'done'), '/private/var/p'), terminal('t2', session('s2', null, 0, 'done'), '/private/var/p')]);
    b.setToolCalls([
      win('t1', 1_001_000, null, { cwd: '/var/p/.claude/worktrees/website' }),
      win('t2', 1_001_500, 1_002_500, { cwd: '/private/var/p/evil‮dir' })
    ], true);
    const st = (at: number, paths: string[]) => ({ ...status(at, paths), root: '/private/var/p' });
    await b.status(st(1_000_000, []), keep);
    mt.set('/private/var/p/a.ts', 1_002_000);
    mt.set('/private/var/p/b.ts', 1_002_900); // after t2's call and its 300 ms slack: t1 alone
    now = 1_003_000;
    await b.status(st(1_003_000, ['/private/var/p/a.ts', '/private/var/p/b.ts']), keep);
    const a = (path: string, id: string) => b.list().find((x) => x.path === path && x.terminalId === id)!;
    expect(a('/private/var/p/a.ts', 't1').cwd).toBe('/private/var/p/.claude/worktrees/website');
    expect(a('/private/var/p/a.ts', 't2').cwd).toBeUndefined(); // a bidi override: not shown at all
    expect(a('/private/var/p/b.ts', 't1').unclear).toBeUndefined();
    expect(a('/private/var/p/b.ts', 't1').cwd).toBeUndefined(); // sure: nothing to explain
    expect(new BashAttributions(file).list().find((x) => x.path.endsWith('a.ts') && x.terminalId === 't1')!.cwd).toBe('/private/var/p/.claude/worktrees/website');
    writeFileSync(file, JSON.stringify({ v: 1, list: [{ ...base('t1'), via: 'bash', unclear: ['t1', 't2'], cwd: 'rel' }, { ...base('t2'), via: 'bash', unclear: ['t1', 't2'], cwd: '/p/x y' }] }));
    expect(new BashAttributions(file).list().map((x) => x.cwd)).toEqual([undefined, undefined]);
  });

  test('no mtime inside the interval (a deleted file): no change time', async () => {
    const { b, mtimes, at } = setup();
    b.setTerminals([idle('t1')]);
    b.setToolCalls([win('t1', 1_001_000, null)], true);
    await b.status(status(1_000_000, []), keep);
    mtimes.set('/p/a.ts', null);
    at(1_003_000);
    await b.status(status(1_003_000, ['/p/a.ts']), keep);
    expect(b.list()).toHaveLength(1);
    expect(b.list()[0]!.changedAt).toBeUndefined();
  });

  test('resolve to a candidate: one sure entry marked resolved, saved; undo restores the unsure entries', async () => {
    const file = join(tmp(), 'bash-attributions.json');
    const { b, changes } = await twoWriters(file);
    const before = b.list();
    const n = changes();
    const r = b.resolve(['/p/a.ts', '/p/b.ts'], 't2');
    expect(r).toEqual({ token: expect.any(String), count: 2 });
    const token = r!.token;
    expect(changes()).toBe(n + 1);
    expect(b.list()).toEqual([
      { ...base('t2'), via: 'bash', changedAt: 1_002_000, command: 'git merge wt', callStart: 1_001_500, callEnd: 1_002_500, resolved: true },
      { ...base('t2', '/p/b.ts'), via: 'bash', changedAt: 1_002_100, command: 'git merge wt', callStart: 1_001_500, callEnd: 1_002_500, resolved: true }
    ]);
    expect(new BashAttributions(file).list()).toEqual(b.list());
    expect(b.undo(token)).toBe(true);
    expect([...b.list()].sort((x, y) => (x.path + x.terminalId).localeCompare(y.path + y.terminalId))).toEqual(before);
    expect(changes()).toBe(n + 2);
    expect(b.undo(token)).toBe(false);
  });

  test('resolve to nobody (outside Claude): the unsure entries go, a sure entry of the same file stays', async () => {
    const { b } = await twoWriters();
    const sure = { ...base('t3'), via: 'bash' as const };
    b.setDaemonAttributions([]);
    // A sure entry for a.ts from a third session (a later single-candidate change).
    (b as unknown as { items: unknown[] }).items = [...b.list(), sure];
    expect(b.resolve(['/p/a.ts'], null)).toEqual({ token: expect.any(String), count: 1 });
    expect(b.list().filter((a) => a.path === '/p/a.ts')).toEqual([sure]);
    expect(b.list().filter((a) => a.path === '/p/b.ts')).toHaveLength(2);
  });

  test('a session that is not a candidate leaves the file alone; nothing to change gives no token', async () => {
    const { b, changes } = await twoWriters();
    const before = b.list();
    const n = changes();
    expect(b.resolve(['/p/a.ts'], 't9')).toBeNull();
    expect(b.resolve(['/p/zzz.ts'], 't1')).toBeNull();
    expect(b.list()).toEqual(before);
    expect(changes()).toBe(n);
  });

  test('a status still stat\'ing while the user resolves never puts the old entries back', async () => {
    let release: () => void = () => {};
    let gate = false;
    const mt = new Map<string, number | null>();
    const s = setup(null, async (p) => { if (gate) await new Promise<void>((r) => { release = r; }); return mt.get(p) ?? null; });
    s.b.setTerminals([idle('t1'), idle('t2')]);
    s.b.setToolCalls([win('t1', 1_001_000, null, { command: 'npm test' }), win('t2', 1_001_500, 1_002_500, { command: 'git merge wt' })], true);
    await s.b.status(status(1_000_000, []), keep);
    mt.set('/p/a.ts', 1_002_000);
    s.at(1_003_000);
    await s.b.status(status(1_003_000, ['/p/a.ts']), keep);
    gate = true;
    s.at(1_004_000);
    const running = s.b.status(status(1_004_000, ['/p/a.ts']), keep);
    await Promise.resolve();
    expect(s.b.resolve(['/p/a.ts'], 't2')).toEqual(expect.any(Object));
    release();
    await running;
    expect(s.b.list().map((a) => [a.terminalId, a.resolved])).toEqual([['t2', true]]);
  });

  test('the command is cleaned before it is kept: secrets redacted, invisible characters gone', async () => {
    const { b, mtimes, at } = setup();
    b.setTerminals([idle('t1')]);
    b.setToolCalls([win('t1', 1_001_000, null, { command: 'curl -H "Authorization: Bearer sk-abcdefghijklmnopqrstuvwxyz123456" x‮\u0007' })], true);
    await b.status(status(1_000_000, []), keep);
    mtimes.set('/p/a.ts', 1_002_000);
    at(1_003_000);
    await b.status(status(1_003_000, ['/p/a.ts']), keep);
    const cmd = b.list()[0]!.command!;
    expect(cmd).not.toContain('sk-abcdefghijklmnopqrstuvwxyz123456');
    expect(cmd).not.toMatch(/[‮\u0007]/);
    expect(cmd.startsWith('curl -H')).toBe(true);
  });

  test('undo belongs to the project that resolved: another project cannot undo it', async () => {
    const { b } = await twoWriters();
    const r = b.resolve(['/p/a.ts'], 't1', '/p/')!;
    expect(r.count).toBe(1);
    expect(r.token).toMatch(/^[0-9a-f]{16,}$/);
    expect(b.undo(r.token, '/q/')).toBe(false);
    expect(b.undo(r.token, '/p/')).toBe(true);
  });

  test('a maybe (background command alone) can be confirmed too', async () => {
    const { b, mtimes, at } = setup();
    b.setTerminals([idle('t1')]);
    b.setToolCalls([win('t1', 1_001_000, null, { background: true, taskId: 'bg', command: 'npm run dev' })], true);
    await b.status(status(1_000_000, []), keep);
    mtimes.set('/p/a.ts', 1_002_000);
    at(1_003_000);
    await b.status(status(1_003_000, ['/p/a.ts']), keep);
    expect(b.list()[0]!.maybe).toBe(true);
    b.resolve(['/p/a.ts'], 't1');
    expect(b.list()).toEqual([{ ...base('t1'), via: 'bash', changedAt: 1_002_000, command: 'npm run dev', callStart: 1_001_000, resolved: true }]);
  });

  test('undo does nothing once the file was attributed again since', async () => {
    const { b, mtimes, at } = await twoWriters();
    const token = b.resolve(['/p/a.ts'], 't1')!.token;
    b.setToolCalls([win('t2', 1_003_500, 1_004_500, { command: 'sed -i s/a/b/ a.ts' })], false);
    mtimes.set('/p/a.ts', 1_004_000);
    at(1_005_000);
    await b.status(status(1_005_000, ['/p/a.ts', '/p/b.ts']), keep);
    const now = b.list();
    expect(b.undo(token)).toBe(false);
    expect(b.list()).toEqual(now);
  });

  test('at most 20 undo records: the oldest is forgotten', async () => {
    const { b, mtimes, at } = setup();
    b.setTerminals([idle('t1'), idle('t2')]);
    b.setToolCalls([win('t1', 1_001_000, null), win('t2', 1_001_500, null)], true);
    await b.status(status(1_000_000, []), keep);
    const files = Array.from({ length: 21 }, (_, i) => `/p/f${i}.ts`);
    for (const f of files) mtimes.set(f, 1_002_000);
    at(1_003_000);
    await b.status(status(1_003_000, files), keep);
    const tokens = files.map((f) => b.resolve([f], 't1')!.token);
    expect(b.undo(tokens[0]!)).toBe(false);
    expect(b.undo(tokens[1]!)).toBe(true);
    expect(b.undo(tokens[20]!)).toBe(true);
  });

  test('loading: the new fields are kept when valid and dropped when not; resolved with unclear or maybe drops the entry', () => {
    const file = join(tmp(), 'bash-attributions.json');
    const ok = { ...base('t1'), via: 'bash', changedAt: 5, command: 'npm test', callStart: 1, callEnd: 9, resolved: true };
    const badFields = { ...base('t2'), via: 'bash', changedAt: 'x', command: 'y'.repeat(3000), callStart: Infinity, callEnd: null };
    const resolvedUnclear = { ...base('t3'), via: 'bash', unclear: ['t3', 't4'], resolved: true };
    const resolvedMaybe = { ...base('t4'), via: 'bash', maybe: true, resolved: true };
    const notTrue = { ...base('t5'), via: 'bash', resolved: 'yes' };
    writeFileSync(file, JSON.stringify({ v: 1, list: [ok, badFields, resolvedUnclear, resolvedMaybe, notTrue] }));
    expect(new BashAttributions(file).list()).toEqual([ok, { ...base('t2'), via: 'bash' }]);
  });
});
