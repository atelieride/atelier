import { describe, expect, test } from 'vitest';
import {
  SERVER_LISTEN_MS, WORK_CAP_MS, backgroundWork, cronNext, displayCommand, effectiveState, evalCommand, looksLikeTestRun, matchShells, watchServer, workCounts, workSummary, workTotal,
  type BackgroundWork, type WorkScan
} from './background';
import { COMMAND_CHARS, reduceHook, type BackgroundItem, type SessionInfo } from './session';

const REAL =
  "/bin/zsh -c source /Users/x/.claude/shell-snapshots/snapshot-zsh-1791709904915-ume447.sh 2>/dev/null || true && setopt NO_EXTENDED_GLOB NO_BARE_GLOB_QUAL 2>/dev/null || true && { \\builtin unalias -- 'unsetenv'; \\builtin unset -f -- 'unsetenv'; } >/dev/null 2>&1 || true && eval 'sleep 45; echo atl-probe-marker-7731' < /dev/null && pwd -P >| /tmp/claude-3592-cwd";

describe('evalCommand', () => {
  test('the real captured arguments: skips the quoted unalias, takes the eval text', () => {
    expect(evalCommand(REAL)).toBe('sleep 45; echo atl-probe-marker-7731');
  });
  test("unescapes '\\'' to a quote", () => {
    expect(evalCommand("zsh -c eval 'echo '\\''hi'\\'' there' < /dev/null")).toBe("echo 'hi' there");
  });
  test('keeps newlines', () => {
    expect(evalCommand("zsh -c eval 'a\nb' < /dev/null")).toBe('a\nb');
  });
  test('no eval, or an unterminated one: null', () => {
    expect(evalCommand('/bin/zsh -c ls')).toBeNull();
    expect(evalCommand("zsh -c eval 'never closed")).toBeNull();
  });
  test('two evals: the first', () => {
    expect(evalCommand("zsh -c eval 'one' && eval 'two'")).toBe('one');
  });
});

const sh = (id: string, command: string, since = 0, kind: BackgroundItem['kind'] = 'shell'): BackgroundItem => ({ id, kind, label: id, command, since });
const proc = (pid: number, cmd: string) => ({ pid, ppid: 1, args: `/bin/zsh -c source x && eval '${cmd}' < /dev/null && pwd -P >| /tmp/c` });

describe('matchShells', () => {
  test('exact match', () => {
    expect(matchShells([sh('a', 'npm test'), sh('b', 'sleep 9')], [proc(10, 'sleep 9'), proc(11, 'npm test')])).toEqual({ a: 11, b: 10 });
  });
  test('no match: absent', () => {
    expect(matchShells([sh('a', 'npm test')], [proc(10, 'npm run e2e'), { pid: 12, ppid: 1, args: 'node x.js' }])).toEqual({});
  });
  test('prefix when the command was clipped at 2048', () => {
    const full = 'x'.repeat(3000);
    const clipped = full.slice(0, 2048);
    expect(matchShells([sh('a', clipped)], [proc(10, full)])).toEqual({ a: 10 });
    const short = 'y'.repeat(100);
    expect(matchShells([sh('b', short)], [proc(10, short + 'z')])).toEqual({});
  });
  test('the clip length is atelierd\'s: a command clipped by reduceHook matches its shell by prefix', () => {
    expect(COMMAND_CHARS).toBe(2048);
    const full = `npm run e2e -- ${'--grep x '.repeat(400)}`;
    let s = reduceHook(null, { hook_event_name: 'SessionStart', session_id: 's', cwd: '/p' }, 0)!;
    s = reduceHook(s, { hook_event_name: 'PostToolUse', session_id: 's', cwd: '/p', tool_name: 'Bash', tool_input: { command: full, run_in_background: true }, tool_response: { backgroundTaskId: 't' } }, 0)!;
    const item = s.background!.items.find((i) => i.id === 't')!;
    expect(item.command).toHaveLength(COMMAND_CHARS);
    expect(matchShells([item], [proc(10, full)])).toEqual({ t: 10 });
  });
  test('duplicates: pids ascending to items by since; a pid is used once', () => {
    const items = [sh('late', 'same', 20), sh('early', 'same', 10)];
    expect(matchShells(items, [proc(31, 'same'), proc(30, 'same')])).toEqual({ early: 30, late: 31 });
    expect(matchShells(items, [proc(30, 'same')])).toEqual({ early: 30 });
  });
  test('items without a command or agents never match', () => {
    expect(matchShells([{ id: 'a', kind: 'agent', label: 'a', since: 0 }, { id: 'b', kind: 'shell', label: 'b', since: 0 }], [proc(1, 'x')])).toEqual({});
  });
});

// A test run opens ports too (briefly or for the whole run), so a listener alone never makes a server.
describe('servers', () => {
  test('a test run, by a word of its command, is never a server', () => {
    for (const c of ['npm test', 'npm run test:unit', 'npx vitest run', 'npm run e2e', 'jest --watch', 'npx playwright test tests/e2e/a.spec.ts',
      'pytest -q', 'mocha', 'npx cypress run', 'cd app && npm run tests', './run_tests.sh', 'make e2e']) {
      expect(looksLikeTestRun(c), c).toBe(true);
    }
    for (const c of ['npm run dev', 'vite --port 5173', 'python3 -m http.server 8000', 'node latest.js', 'cargo run --bin contest', 'attestation-server', 'testify-ui serve']) {
      expect(looksLikeTestRun(c), c).toBe(false);
    }
  });

  test('test-run words count only in the program and its script/subcommand words: not in cd paths, assignments, options or paths', () => {
    const table: [string, boolean][] = [
      // The cases that decide it.
      ['cd ~/tests/app && npm run dev', false],
      ['NODE_ENV=test vite', false],
      ['npm test', true],
      ['npm run e2e', true],
      ['npx playwright test', true],
      ['vitest', true],
      ['pytest -k x', true],
      // Leading setup is skipped: cd segments, env and VAR=value assignments.
      ['cd /src/e2e-app && pnpm dev', false],
      ['cd e2e && npm start', false],
      ['E2E=1 make', false],
      ['env NODE_ENV=test npm run dev', false],
      ['env -i TEST_DB=1 vite', false],
      ['CI=1 npm test', true],
      ['env NODE_ENV=test npx jest', true],
      ['cd app && npm run tests', true],
      // Paths, options and redirections are not the program's words; the program's own name is.
      ['vite --config tests/vite.config.ts', false],
      ['npm run dev > /tmp/tests.log 2>&1', false],
      ['npm run dev --test-only-flag', false],
      ['./run_tests.sh', true],
      ['node_modules/.bin/vitest run', true],
      ['python -m pytest', true],
      ['npx playwright test tests/e2e/a.spec.ts --reporter=line', true],
      // Pipelines and chains: a test run anywhere in them still counts (a test run read as a server would end the work).
      ['npm run e2e 2>&1 | tail -50', true],
      ['npm run build && npm run test:e2e', true],
      ['npm run e2e; echo "exit $?"', true]
    ];
    for (const [c, want] of table) expect(looksLikeTestRun(c), c).toBe(want);
  });

  test('a listener makes a server only once seen continuously for 15 s (time, not scans); a gap before restarts the clock', () => {
    expect(SERVER_LISTEN_MS).toBe(15_000);
    let w = watchServer(undefined, 120, true, 'npm run dev', 0);
    expect(w).toEqual({ pid: 120, listenSince: 0, server: false });
    w = watchServer(w, 120, true, 'npm run dev', 14_999);
    expect(w.server).toBe(false);
    // A gap before 15 s: the clock restarts at the next sighting.
    w = watchServer(w, 120, false, 'npm run dev', 16_000);
    expect(w).toEqual({ pid: 120, listenSince: null, server: false });
    w = watchServer(w, 120, true, 'npm run dev', 17_000);
    expect(watchServer(w, 120, true, 'npm run dev', 31_999).server).toBe(false);
    w = watchServer(w, 120, true, 'npm run dev', 32_000);
    expect(w).toEqual({ pid: 120, listenSince: 17_000, server: true });
  });

  test('a server is sticky through a listen gap, until its process changes; a test run never becomes one', () => {
    const server = { pid: 120, listenSince: 0, server: true };
    expect(watchServer(server, 120, false, 'npm run dev', 40_000)).toBe(server);
    // Another process for the same item (the old one is gone): starts over.
    expect(watchServer(server, 121, false, 'npm run dev', 40_000)).toEqual({ pid: 121, listenSince: null, server: false });
    let t = watchServer(undefined, 130, true, 'npm run e2e', 0);
    for (let at = 3000; at <= 600_000; at += 3000) t = watchServer(t, 130, true, 'npm run e2e', at);
    expect(t.server).toBe(false);
  });
});

const NOW = 10_000_000;
const session = (over: Partial<SessionInfo> & { items?: BackgroundItem[]; crons?: { id: string; schedule: string; recurring: boolean; label: string }[] } = {}): SessionInfo => {
  const { items, crons, ...rest } = over;
  return { state: 'idle', background: { items: items ?? [], crons: crons ?? [] }, ...rest } as SessionInfo;
};
// A Monitor runs a command (one without is a watcher: see isWatcher).
const item = (id: string, kind: BackgroundItem['kind'], since = NOW - 1000, label = id): BackgroundItem =>
  ({ id, kind, label, since, ...(kind === 'monitor' ? { command: `watch ${id}` } : {}) });
const scan = (p: Partial<WorkScan> = {}): WorkScan => ({ at: NOW, matched: {}, servers: [], gone: [], ...p });
const on = { countAsWork: true };

describe('backgroundWork', () => {
  test('each kind counts; agents first, then monitors, shells, other', () => {
    const w = backgroundWork(
      session({ items: [item('s', 'shell'), item('o', 'other'), item('m', 'monitor'), item('a', 'agent')] }), null, NOW, on
    );
    expect(w).toMatchObject({ counting: true, agents: 1, shells: 1, monitors: 1, other: 1, idle: 0 });
    expect(w.items.map((i) => i.label)).toEqual(['a', 'm', 's', 'o']);
    expect(w.items.every((i) => i.counted)).toBe(true);
  });
  test('watchers are listed, never work: an artifact or MCP watch (a monitor with no command) and a persistent monitor', () => {
    const artifact: BackgroundItem = { ...item('w1', 'monitor', NOW - 1000, 'Watching artifact Atelier board'), command: undefined };
    const persistent: BackgroundItem = { ...item('w2', 'monitor'), command: 'tail -f app.log', persistent: true };
    const comments: BackgroundItem = { ...item('w3', 'other', NOW - 1000, 'Artifact comments') };
    const w = backgroundWork(session({ items: [artifact, persistent, comments] }), null, NOW, on);
    // Created with an artifact, they last the whole session: never "working", never "Running for 2 h" either.
    expect(w).toMatchObject({ counting: false, monitors: 0, other: 0, idle: 0, nextChange: null });
    expect(w.items.map((i) => [i.label, i.counted])).toEqual([['Watching artifact Atelier board', false], ['w2', false], ['Artifact comments', false]]);
    // A watcher beside real work: the work counts alone.
    const busy = backgroundWork(session({ items: [artifact, { ...item('m', 'monitor'), command: 'gh run watch 42' }] }), null, NOW, on);
    expect(busy).toMatchObject({ counting: true, monitors: 1 });
    expect(workSummary(busy)).toBe('1 monitor');
    // An "other" task that doesn't watch an artifact (a workflow, an MCP task, a build of artifacts) still is work.
    expect(backgroundWork(session({ items: [item('wf', 'other')] }), null, NOW, on)).toMatchObject({ counting: true, other: 1 });
    expect(backgroundWork(session({ items: [item('b', 'other', NOW - 1000, 'Build release artifacts')] }), null, NOW, on)).toMatchObject({ counting: true, other: 1 });
  });
  test('subagents beyond the agent items count (the larger wins)', () => {
    expect(backgroundWork(session({ subagents: 3, items: [item('a', 'agent')] }), null, NOW, on).agents).toBe(3);
    expect(backgroundWork(session({ subagents: 1, items: [item('a', 'agent'), item('b', 'agent')] }), null, NOW, on).agents).toBe(2);
    const w = backgroundWork(session({ subagents: 2 }), null, NOW, on);
    expect(w).toMatchObject({ counting: true, agents: 2 });
    expect(w.items).toHaveLength(2);
  });
  // Agents follow the work rules too.
  test('a waiting agent (kept only by its own work) counts only while one of its own items counts', () => {
    const agent: BackgroundItem = { ...item('a1', 'agent'), waiting: true };
    const own = (since = NOW - 1000): BackgroundItem => ({ ...item('s1', 'shell', since), owner: 'a1' });
    const other = item('s2', 'shell');
    expect(backgroundWork(session({ subagents: 1, items: [agent, own()] }), null, NOW, on)).toMatchObject({ counting: true, agents: 1, shells: 1 });
    // Its shell a server, gone or past the cap: the agent is not work any more, nor listed (another agent's work doesn't keep it).
    for (const [why, s, sc] of [
      ['server', session({ subagents: 1, items: [agent, own(), other] }), scan({ servers: ['s1'] })],
      ['gone', session({ subagents: 1, items: [agent, own(), other] }), scan({ gone: ['s1'] })],
      ['capped', session({ subagents: 1, items: [agent, own(NOW - WORK_CAP_MS - 1), other] }), null]
    ] as const) {
      const w = backgroundWork(s, sc, NOW, on);
      expect([w.agents, w.items.some((i) => i.kind === 'agent')], why).toEqual([0, false]);
      expect(w.shells, why).toBe(1);
    }
    expect(backgroundWork(session({ subagents: 1, items: [agent, own(NOW - WORK_CAP_MS - 1)] }), null, NOW, on)).toMatchObject({ counting: false, agents: 0, idle: 1 });
    // Not waiting (it works): counts whatever its items do; an older atelierd without the field: as before.
    expect(backgroundWork(session({ subagents: 1, items: [item('a1', 'agent'), own()] }), scan({ servers: ['s1'] }), NOW, on)).toMatchObject({ counting: true, agents: 1 });
  });

  test('an agent silent for 2 hours (lastEvent) stops counting at that time, a change only time brings; without lastEvent as before', () => {
    const H = 60 * 60 * 1000;
    const agent = (lastEvent: number): BackgroundItem => ({ ...item('a1', 'agent', lastEvent), lastEvent });
    const live = backgroundWork(session({ subagents: 1, items: [agent(NOW - 2 * H)] }), null, NOW, on);
    expect(live).toMatchObject({ counting: true, agents: 1, nextChange: NOW + 1 });
    const expired = backgroundWork(session({ subagents: 1, items: [agent(NOW - 2 * H - 1)] }), null, NOW, on);
    // Neither counted nor listed (it is taken as gone), and the subagent count does not bring it back as "Subagent".
    expect(expired).toMatchObject({ counting: false, agents: 0, items: [], nextChange: null });
    expect(backgroundWork(session({ subagents: 1, items: [item('a1', 'agent', NOW - 3 * H)] }), null, NOW, on)).toMatchObject({ counting: true, agents: 1, nextChange: null });
  });

  test('cap boundary: exactly 30 min counts, 1 ms more does not (listed as idle)', () => {
    const at = backgroundWork(session({ items: [item('s', 'shell', NOW - WORK_CAP_MS)] }), null, NOW, on);
    expect(at).toMatchObject({ counting: true, shells: 1, idle: 0 });
    const past = backgroundWork(session({ items: [item('s', 'shell', NOW - WORK_CAP_MS - 1)] }), null, NOW, on);
    expect(past).toMatchObject({ counting: false, shells: 0, idle: 1 });
    expect(past.items).toEqual([{ kind: 'shell', label: 's', counted: false }]);
  });
  test('idleSince: the oldest capped item\'s since (the chip says how long it runs); absent without idle items', () => {
    const w = backgroundWork(session({ items: [item('a', 'shell', NOW - WORK_CAP_MS - 10), item('b', 'monitor', NOW - WORK_CAP_MS - 99), item('c', 'shell')] }), null, NOW, on);
    expect(w.idleSince).toBe(NOW - WORK_CAP_MS - 99);
    expect('idleSince' in backgroundWork(session({ items: [item('c', 'shell')] }), null, NOW, on)).toBe(false);
  });
  test('capped monitors and other tasks are idle too; agents never expire here', () => {
    const old = NOW - WORK_CAP_MS - 5;
    const w = backgroundWork(session({ items: [item('m', 'monitor', old), item('o', 'other', old), item('a', 'agent', old)] }), null, NOW, on);
    expect(w).toMatchObject({ counting: true, agents: 1, monitors: 0, other: 0, idle: 2 });
  });
  test('a server (decided by a scan newer than since) is excluded from items and not counted', () => {
    const s = session({ items: [item('srv', 'shell', NOW - 5000)] });
    const w = backgroundWork(s, scan({ at: NOW - 1000, servers: ['srv'] }), NOW, on);
    expect(w).toMatchObject({ counting: false, shells: 0, idle: 0, items: [] });
  });
  test('a scan older than since says nothing about a server: it counts', () => {
    const s = session({ items: [item('srv', 'shell', NOW - 1000)] });
    expect(backgroundWork(s, scan({ at: NOW - 2000, servers: ['srv'] }), NOW, on)).toMatchObject({ counting: true, shells: 1 });
  });
  test('an over shell (matched once, now gone) is excluded; a never-matched one keeps counting', () => {
    const s = session({ items: [item('over', 'shell'), item('lost', 'shell')] });
    const w = backgroundWork(s, scan({ gone: ['over'] }), NOW, on);
    expect(w).toMatchObject({ counting: true, shells: 1 });
    expect(w.items.map((i) => i.label)).toEqual(['lost']);
  });
  test('unscanned (no scan) counts', () => {
    expect(backgroundWork(session({ items: [item('s', 'shell')] }), null, NOW, on).counting).toBe(true);
  });
  test('countAsWork false: not counting, items still listed', () => {
    const w = backgroundWork(session({ items: [item('s', 'shell'), item('a', 'agent')] }), null, NOW, { countAsWork: false });
    expect(w.counting).toBe(false);
    expect(w.items).toHaveLength(2);
    expect(w).toMatchObject({ agents: 1, shells: 1 });
  });
  test('done counts like idle; running, waiting and error win', () => {
    const items = [item('s', 'shell')];
    expect(backgroundWork(session({ state: 'done', items }), null, NOW, on).counting).toBe(true);
    for (const state of ['running', 'waiting', 'error'] as const) {
      const w = backgroundWork(session({ state, items }), null, NOW, on);
      expect(w.counting).toBe(false);
      expect(w.shells).toBe(1);
    }
  });
  test('nothing at all: not counting, empty', () => {
    expect(backgroundWork(session(), null, NOW, on)).toEqual({
      counting: false, agents: 0, shells: 0, monitors: 0, other: 0, idle: 0, items: [], crons: [], entries: [], nextChange: null
    });
    expect(backgroundWork({ state: 'idle' } as SessionInfo, null, NOW, on).items).toEqual([]);
  });
  test('nextChange: the earliest future cap expiry among counted items', () => {
    const s = session({ items: [item('a', 'shell', NOW - 1000), item('b', 'monitor', NOW - 5000), item('c', 'agent', NOW - 9000), item('old', 'shell', NOW - WORK_CAP_MS - 10)] });
    // an item counts while now - since <= cap, so it stops at since + cap + 1
    expect(backgroundWork(s, null, NOW, on).nextChange).toBe(NOW - 5000 + WORK_CAP_MS + 1);
  });
  test('crons: label and next time (null if unparsable)', () => {
    const w = backgroundWork(session({ crons: [{ id: 'c1', schedule: '*/5 * * * *', recurring: true, label: 'poll' }, { id: 'c2', schedule: 'bad', recurring: false, label: 'x' }] }), null, NOW, on);
    expect(w.crons.map((c) => ({ label: c.label, next: c.next }))).toEqual([{ label: 'poll', next: cronNext('*/5 * * * *', new Date(NOW))!.getTime() }, { label: 'x', next: null }]);
    expect(w.counting).toBe(false);
  });
  test('crons carry id, schedule and recurring for the inspector', () => {
    const w = backgroundWork(session({ crons: [{ id: 'c1', schedule: '*/5 * * * *', recurring: true, label: 'poll' }] }), null, NOW, on);
    expect(w.crons[0]).toMatchObject({ id: 'c1', schedule: '*/5 * * * *', recurring: true });
  });
  test('nextChange includes the soonest cron fire, so the chip never shows a past time', () => {
    const crons = [{ id: 'h', schedule: '0 * * * *', recurring: true, label: 'hourly' }, { id: 'q', schedule: '*/15 * * * *', recurring: true, label: 'q' }, { id: 'x', schedule: 'bad', recurring: false, label: 'x' }];
    const soonest = Math.min(cronNext('0 * * * *', new Date(NOW))!.getTime(), cronNext('*/15 * * * *', new Date(NOW))!.getTime());
    expect(backgroundWork(session({ crons }), null, NOW, on).nextChange).toBe(soonest);
    // With a counted shell: whichever comes first.
    const late = backgroundWork(session({ crons, items: [item('a', 'shell', NOW)] }), null, NOW, on);
    expect(late.nextChange).toBe(Math.min(soonest, NOW + WORK_CAP_MS + 1));
    const early = backgroundWork(session({ crons, items: [item('a', 'shell', NOW - WORK_CAP_MS + 10)] }), null, NOW, on);
    expect(early.nextChange).toBe(NOW + 11);
    // At the fire time itself, the next one (strictly after) is what the hub waits for.
    expect(backgroundWork(session({ crons: [crons[1]!] }), null, soonest, on).nextChange).toBeGreaterThan(soonest);
  });
  test('a self-paced loop wake-up that fired is not pending tomorrow, and wakes nothing', () => {
    const at = (h: number, m: number) => new Date(2026, 9, 17, h, m).getTime();
    const loop = { id: 'w1', schedule: '28 10 * * *', recurring: false, label: '/loop check the preview deploy' };
    const before = backgroundWork(session({ crons: [loop] }), null, at(10, 24), on);
    expect(before.crons[0]!.next).toBe(at(10, 28));
    expect(before.nextChange).toBe(at(10, 28));
    const after = backgroundWork(session({ crons: [loop] }), null, at(10, 29), on);
    expect(after.crons[0]!.next).toBeNull();
    expect(after.nextChange).toBeNull();
    // An ordinary dateless one-shot keeps its next match (nothing tells when it was made).
    const plain = backgroundWork(session({ crons: [{ ...loop, label: 'check the preview deploy' }] }), null, at(10, 29), on);
    expect(plain.crons[0]!.next).toBe(new Date(2026, 9, 18, 10, 28).getTime());
  });
});

const work = (p: Partial<BackgroundWork>): BackgroundWork => ({ counting: true, agents: 0, shells: 0, monitors: 0, other: 0, idle: 0, items: [], crons: [], entries: [], nextChange: null, ...p });
const counted = (kind: 'agent' | 'shell' | 'monitor' | 'other', n: number) => Array.from({ length: n }, (_, i) => ({ kind, label: `${kind}${i}`, counted: true }));

describe('work labels', () => {
  test('summary: order agents, shells, monitors, tasks; plurals', () => {
    const w = work({ agents: 1, shells: 2, monitors: 1, other: 1, items: [...counted('agent', 1), ...counted('shell', 2), ...counted('monitor', 1), ...counted('other', 1)] });
    expect(workSummary(w)).toBe('1 agent · 2 shells · 1 monitor · 1 task');
    expect(workSummary(work({ other: 2, monitors: 3, items: [...counted('monitor', 3), ...counted('other', 2)] }))).toBe('3 monitors · 2 tasks');
  });
  test('only idle items remain: summarize them', () => {
    const w = work({ counting: false, idle: 1, items: [{ kind: 'shell', label: 's', counted: false }] });
    expect(workSummary(w)).toBe('1 shell');
    expect(workCounts(w)).toEqual([['shell', 1]]);
    expect(workTotal(w)).toBe(1);
  });
  test('counted items summarize without the idle ones; total lists both', () => {
    const w = work({ agents: 1, idle: 1, items: [...counted('agent', 1), { kind: 'shell', label: 's', counted: false }] });
    expect(workSummary(w)).toBe('1 agent');
    expect(workTotal(w)).toBe(2);
  });
  test('counts per kind, chip order, for the compact chip\'s glyphs', () => {
    const w = work({ agents: 1, shells: 2, items: [...counted('monitor', 1).map((i) => ({ ...i, counted: false })), ...counted('shell', 2), ...counted('agent', 1)] });
    expect(workCounts(w)).toEqual([['agent', 1], ['shell', 2]]);
    expect(workCounts(work({ counting: false }))).toEqual([]);
  });
  test('nothing listed: null and 0', () => {
    expect(workSummary(work({ counting: false }))).toBeNull();
    expect(workTotal(work({ counting: false }))).toBe(0);
  });
});

describe('cronNext', () => {
  const from = new Date(2026, 9, 11, 12, 0, 30); // Sun 11 Oct 2026 12:00:30 local
  const at = (d: Date | null) => d && [d.getFullYear(), d.getMonth() + 1, d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds()];
  test('every minute: the next minute, seconds zeroed', () => {
    expect(at(cronNext('* * * * *', from))).toEqual([2026, 10, 11, 12, 1, 0]);
  });
  test('strictly after from, even on an exact minute', () => {
    expect(at(cronNext('0 12 * * *', new Date(2026, 9, 11, 12, 0, 0)))).toEqual([2026, 10, 12, 12, 0, 0]);
    expect(at(cronNext('30 12 * * *', new Date(2026, 9, 11, 12, 0, 0)))).toEqual([2026, 10, 11, 12, 30, 0]);
  });
  test('a one-shot "10 12 11 10 *"', () => {
    expect(at(cronNext('10 12 11 10 *', from))).toEqual([2026, 10, 11, 12, 10, 0]);
    expect(at(cronNext('10 12 11 10 *', new Date(2026, 9, 11, 12, 10, 0)))).toEqual([2027, 10, 11, 12, 10, 0]);
  });
  test('steps, lists, ranges', () => {
    expect(at(cronNext('*/15 * * * *', from))).toEqual([2026, 10, 11, 12, 15, 0]);
    expect(at(cronNext('5,50 * * * *', from))).toEqual([2026, 10, 11, 12, 5, 0]);
    expect(at(cronNext('0 9-17 * * *', from))).toEqual([2026, 10, 11, 13, 0, 0]);
    expect(at(cronNext('0 8-18/5 * * *', from))).toEqual([2026, 10, 11, 13, 0, 0]);
    expect(at(cronNext('0 0 1 * *', from))).toEqual([2026, 11, 1, 0, 0, 0]);
  });
  test('Sunday is 0 and 7; weekdays', () => {
    // Sun 11 Oct 2026: next Sunday 09:00 is 18 Oct
    expect(at(cronNext('0 9 * * 0', from))).toEqual([2026, 10, 18, 9, 0, 0]);
    expect(at(cronNext('0 9 * * 7', from))).toEqual([2026, 10, 18, 9, 0, 0]);
    expect(at(cronNext('0 9 * * 1-5', from))).toEqual([2026, 10, 12, 9, 0, 0]);
  });
  test('day-of-month and day-of-week are OR-ed when both are restricted', () => {
    // 15th or Monday: Monday 12 Oct comes first
    expect(at(cronNext('0 9 15 * 1', from))).toEqual([2026, 10, 12, 9, 0, 0]);
  });
  test('unparsable or never matching: null', () => {
    for (const bad of ['', 'bad', '* * * *', '* * * * * *', '60 * * * *', '* 24 * * *', '* * 0 * *', '* * * 13 *', '* * * * 8', '*/0 * * * *', '5-1 * * * *', 'a * * * *', '1- * * * *'])
      expect(cronNext(bad, from)).toBeNull();
    expect(cronNext('0 0 31 2 *', from)).toBeNull();
  });
});

describe('effectiveState', () => {
  const s = (state: SessionInfo['state']) => ({ state }) as SessionInfo;
  test('null without a session', () => {
    expect(effectiveState({ session: null })).toBeNull();
    expect(effectiveState({ session: null, work: work({}) })).toBeNull();
  });
  test('running while work counts, else the main state', () => {
    expect(effectiveState({ session: s('done'), work: work({ counting: true }) })).toBe('running');
    expect(effectiveState({ session: s('done'), work: work({ counting: false }) })).toBe('done');
    expect(effectiveState({ session: s('waiting') })).toBe('waiting');
  });
  test('only idle and done turn into running: waiting, error and running keep their own state', () => {
    const w = work({ counting: true });
    expect(effectiveState({ session: s('idle'), work: w })).toBe('running');
    expect(effectiveState({ session: s('waiting'), work: w })).toBe('waiting');
    expect(effectiveState({ session: s('error'), work: w })).toBe('error');
    expect(effectiveState({ session: s('running'), work: w })).toBe('running');
  });
});

describe('inspector entries', () => {
  test('every listed item and every server, with ids, owners, pids, cap ends and redacted commands', () => {
    const shell: BackgroundItem = { ...item('s1', 'shell'), command: 'curl -H "Authorization: Bearer sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123" x', owner: 'a1' };
    const server: BackgroundItem = { ...item('srv', 'shell'), command: 'npm run dev' };
    const agent: BackgroundItem = { ...item('a1', 'agent'), lastEvent: NOW - 2000 };
    const w = backgroundWork(session({ subagents: 1, items: [shell, server, agent] }), scan({ matched: { s1: 4242, srv: 77 }, servers: ['srv'], ports: { srv: [5173] } }), NOW, on);
    const byId = Object.fromEntries(w.entries.map((e) => [e.id, e]));
    expect(byId.s1).toMatchObject({ kind: 'shell', counted: true, owner: 'a1', pid: 4242, capEndsAt: shell.since + WORK_CAP_MS });
    expect(byId.s1!.display).toContain('curl -H');
    expect(byId.s1!.display).not.toContain('sk-ant-api03');
    expect(byId.srv).toMatchObject({ counted: false, server: { ports: [5173] }, pid: 77, display: 'npm run dev' });
    expect(byId.a1).toMatchObject({ kind: 'agent', counted: true, lastEvent: NOW - 2000 });
    // The chips are untouched: the server is not in items, not counted.
    expect(w.items.map((i) => i.label)).toEqual(['a1', 's1']);
    expect(workSummary(w)).toBe('1 agent · 1 shell');
  });
  test('gone items leave the entries; watchers and capped items stay, not counted', () => {
    const watcher: BackgroundItem = { ...item('w', 'monitor'), command: undefined };
    const capped = item('c', 'other', NOW - WORK_CAP_MS - 5);
    const w = backgroundWork(session({ items: [{ ...item('g', 'shell'), command: 'sleep 9' }, watcher, capped] }), scan({ gone: ['g'] }), NOW, on);
    expect(w.entries.map((e) => [e.id, e.counted])).toEqual([['w', false], ['c', false]]);
  });
  test('watchers carry the watcher flag; capped and counted items do not', () => {
    const watcher: BackgroundItem = { ...item('w', 'monitor'), command: undefined };
    const persistent: BackgroundItem = { ...item('p', 'monitor', NOW - 3 * 3600_000), command: 'tail -f x', persistent: true };
    const capped = item('c', 'other', NOW - WORK_CAP_MS - 5);
    const w = backgroundWork(session({ items: [watcher, persistent, capped, { ...item('s', 'shell'), command: 'sleep 9' }] }), null, NOW, on);
    expect(Object.fromEntries(w.entries.map((e) => [e.id, e.watcher === true]))).toEqual({ w: true, p: true, c: false, s: false });
  });
  test('subagents beyond the agent items get placeholder entries', () => {
    const w = backgroundWork(session({ subagents: 2 }), null, NOW, on);
    expect(w.entries.map((e) => [e.kind, e.label])).toEqual([['agent', 'Subagent'], ['agent', 'Subagent']]);
    expect(new Set(w.entries.map((e) => e.id)).size).toBe(2);
  });
  test('displayCommand: one line, control characters gone, at most 400 chars', () => {
    expect(displayCommand('npm test\n\t-- auth')).toBe('npm test -- auth');
    expect(displayCommand('x'.repeat(1000))!.length).toBeLessThanOrEqual(400);
    expect(displayCommand(undefined)).toBeUndefined();
    expect(displayCommand('  \n ')).toBeUndefined();
  });
  test('displayCommand redacts before cutting: no fragment of a token straddling the cut survives', () => {
    const token = 'aB3dE5gH7jK9mN1pQ3sT5vW7yZ9bC2eF4hJ6kL8nP0rS2uV4xY6zA8cD0fG2iJ4lM6oP8qR0tU2';
    const out = displayCommand(`${'a '.repeat(190)}curl -H ${token} --next-option-here`)!;
    for (let i = 0; i + 8 <= token.length; i++) expect(out).not.toContain(token.slice(i, i + 8));
    expect(out.length).toBeLessThanOrEqual(400);
    const long = displayCommand('word '.repeat(200))!;
    expect(long.endsWith('…')).toBe(true);
    expect(Array.from(long).length).toBeLessThanOrEqual(400);
  });
  test('an agent entry never carries a display command', () => {
    const agent: BackgroundItem = { ...item('a1', 'agent'), command: 'secret-ish command' };
    const w = backgroundWork(session({ items: [agent] }), null, NOW, on);
    expect(w.entries[0]!.display).toBeUndefined();
  });
  test('watchServer keeps the ports it saw, sticky once a server', () => {
    const a = watchServer(undefined, 9, true, 'npm run dev', 0, [5173]);
    const b = watchServer(a, 9, true, 'npm run dev', SERVER_LISTEN_MS, [5173]);
    expect(b).toMatchObject({ server: true, ports: [5173] });
    expect(watchServer(b, 9, false, 'npm run dev', SERVER_LISTEN_MS * 2)).toBe(b);
  });
});
