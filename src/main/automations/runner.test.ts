import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import { AUTOMATIONS_SETTINGS_DEFAULTS, normalizeAutomation, type Automation, type AutomationsSettings, type WatchedTask } from '@shared/automations';
import type { Run } from '@shared/automation-run';
import type { TerminalInfo } from '@shared/protocol';
import type { SessionInfo } from '@shared/session';
import type { TaskDetail } from '@shared/tasks';
import { manualClock } from '../../../tests/support/manual-clock';
import type { LaunchResult } from './launch';
import { AutomationRunner, type RunnerPorts } from './runner';
import { AutomationsStore } from './store';

// The runner's decisions against fake ports and a manual clock.

const MIN = 60_000;
const auto = (o: Record<string, unknown> = {}): Automation => normalizeAutomation({
  id: 'a1', name: 'Bug fixes', project: '/p/acme', enabled: false, source: { connector: 'clickup', scopes: ['l1'] },
  conditions: [{ field: 'status', values: ['Ready for AI'] }], ...o
})!;
const task = (id: string, o: Partial<WatchedTask> = {}): WatchedTask => ({
  id, scope: 'l1', displayId: id.toUpperCase(), title: `Task ${id}`, url: `https://app.clickup.com/t/${id}`, status: 'Ready for AI',
  assignees: ['me1'], tags: [], ...o
});
const session = (state: SessionInfo['state']): SessionInfo => ({ sessionId: 's', state, title: null, activity: null, contextPct: null, unread: false, updatedAt: 0 });
const term = (id: string, s: SessionInfo | null): TerminalInfo => ({ id, projectRoot: '/p/acme', cwd: '/p/acme', title: id, name: null, color: '#fff', foreground: 'claude', createdAt: 0, session: s });

function harness(o: { automations?: Automation[]; settings?: Partial<AutomationsSettings>; tasks?: WatchedTask[]; start?: number } = {}) {
  const clock = manualClock(o.start ?? new Date(2026, 9, 19, 9, 0, 0).getTime());
  const logs: string[] = [];
  const store = new AutomationsStore(join(mkdtempSync(join(tmpdir(), 'atl-runner-')), 'automations'), (m) => logs.push(m));
  if (o.automations) store.saveAutomations(o.automations);
  const state = {
    tasks: o.tasks ?? [] as WatchedTask[], status: 'connected', usage: null as number | null,
    settings: { ...AUTOMATIONS_SETTINGS_DEFAULTS, ...o.settings } as AutomationsSettings,
    terminals: [] as TerminalInfo[], creators: {} as Record<string, { id: string; name: string }>,
    launch: null as null | ((run: Run) => LaunchResult), watchFails: false, partial: false,
    removeAnswer: { outcome: 'ok' } as { outcome: string; message?: string },
    merged: new Set<string>(),
    /** Scopes that are Jira service projects. */
    service: [] as string[],
    people: [] as { id: string; name: string }[],
    defined: [] as { name: string; color?: string }[]
  };
  const listeners = new Set<() => void>();
  let ids = 0;
  const ports: RunnerPorts = {
    clock, store, newId: () => `r${++ids}`, log: (m) => logs.push(m),
    settings: () => state.settings,
    connector: {
      status: () => state.status as 'connected',
      userId: () => 'me1',
      watch: vi.fn(async (_c, scopes: readonly string[]) => {
        if (state.watchFails) throw new Error('offline');
        return { tasks: state.tasks.filter((t) => scopes.includes(t.scope)), complete: !state.partial, people: state.people };
      }),
      definedStatuses: vi.fn(async () => state.defined),
      creator: vi.fn(async (_c, id: string) => state.creators[id] ?? null),
      serviceScopes: (_c, scopes) => scopes.filter((s) => state.service.includes(s)),
      detail: vi.fn(async (_c, id: string): Promise<TaskDetail | null> => {
        const t = state.tasks.find((x) => x.id === id);
        return t ? { id: t.id, displayId: t.displayId, title: t.title, url: t.url, status: { name: t.status }, body: 'Body' } : null;
      })
    },
    launch: vi.fn(async (_a, run: Run): Promise<LaunchResult> => state.launch?.(run) ?? {
      ok: true, terminalId: `term-${run.id}`, branch: `auto/${run.task.id}`, worktree: `/p/acme/.claude/worktrees/auto-${run.task.id}`,
      base: 'refs/remotes/origin/main', baseOid: 'b'.repeat(40)
    }),
    sessions: {
      terminals: () => state.terminals,
      interrupt: vi.fn(),
      close: vi.fn(async () => {}),
      onChange: (cb) => { listeners.add(cb); return () => listeners.delete(cb); }
    },
    usage: () => state.usage,
    removeLaunchFiles: vi.fn(),
    changed: vi.fn(),
    notify: vi.fn(),
    decisions: vi.fn(async () => ['Round half-even.']),
    removeWorktree: vi.fn(async (): Promise<{ outcome: string; message?: string }> => state.removeAnswer),
    merged: vi.fn(async (_project: string, r: Run) => state.merged.has(r.id))
  };
  const runner = new AutomationRunner(ports);
  const setTerminals = (list: TerminalInfo[]) => { state.terminals = list; for (const l of listeners) l(); };
  const runs = (id = 'a1') => runner.view().automations.find((v) => v.automation.id === id)?.runs ?? [];
  const tick = async (ms: number) => { await clock.advance(ms); await runner.idle(); };
  return { clock, store, state, ports, runner, setTerminals, runs, tick, logs };
}

// Strangers write a service project's requests; without a Created by naming people, an
// automation on one never turns on and never reads.
describe('Jira service projects', () => {
  const onSup = (o: Record<string, unknown> = {}) => auto({ source: { connector: 'jira', scopes: ['10003'] }, conditions: [], ...o });

  test('Turn On is refused without Created by; nothing is read', async () => {
    const h = harness({ automations: [onSup()] });
    h.state.service = ['10003'];
    h.runner.start();
    await h.runner.turnOn('a1', { startMatching: false });
    await h.runner.idle();
    expect(h.runner.view().automations[0]!.automation.enabled).toBe(false);
    expect(h.ports.connector.watch).not.toHaveBeenCalled();
  });

  test('with Created by naming people it turns on and reads', async () => {
    const h = harness({ automations: [onSup({ conditions: [{ field: 'createdBy', values: ['acc-1'] }] })] });
    h.state.service = ['10003'];
    h.runner.start();
    await h.runner.turnOn('a1', { startMatching: false });
    await h.runner.idle();
    expect(h.runner.view().automations[0]!.automation.enabled).toBe(true);
    expect(h.ports.connector.watch).toHaveBeenCalledWith('jira', ['10003']);
  });

  test('one saved as on (older data) is paused with the reason and never read', async () => {
    const h = harness({ automations: [onSup({ enabled: true })] });
    h.state.service = ['10003'];
    h.runner.start();
    await h.runner.idle();
    expect(h.runner.view().automations[0]!.status).toMatchObject({ kind: 'paused', reason: 'A service project needs Created by set to people you trust' });
    expect(h.ports.connector.watch).not.toHaveBeenCalled();
  });

  test('a software project is not concerned', async () => {
    const h = harness({ automations: [auto({ source: { connector: 'jira', scopes: ['10001'] }, conditions: [] })] });
    h.state.service = ['10003'];
    h.runner.start();
    await h.runner.turnOn('a1', { startMatching: false });
    await h.runner.idle();
    expect(h.runner.view().automations[0]!.automation.enabled).toBe(true);
  });
});

describe('scheduling', () => {
  test('nothing enabled: no timer, no read', async () => {
    const h = harness({ automations: [auto()] });
    h.runner.start();
    await h.runner.idle();
    expect(h.clock.pending()).toBe(0);
    expect(h.ports.connector.watch).not.toHaveBeenCalled();
  });

  test('one read per connector per tick, for every enabled automation\'s scopes, at the smallest interval', async () => {
    const h = harness({ automations: [
      auto({ enabled: true, limits: { checkEveryMin: 5 } }),
      auto({ id: 'a2', enabled: true, source: { connector: 'clickup', scopes: ['l2'] }, limits: { checkEveryMin: 2 } })
    ] });
    h.runner.start();
    await h.runner.idle();
    expect(h.ports.connector.watch).toHaveBeenCalledTimes(1);
    expect(h.ports.connector.watch).toHaveBeenLastCalledWith('clickup', ['l1', 'l2']);
    await h.tick(2 * MIN);
    expect(h.ports.connector.watch).toHaveBeenCalledTimes(2);
    expect(h.ports.connector.watch).toHaveBeenLastCalledWith('clickup', ['l2']);
    await h.tick(3 * MIN);
    expect(h.ports.connector.watch).toHaveBeenLastCalledWith('clickup', ['l1', 'l2']);
  });

  test('Pause All stops the timer; resuming plans it again', async () => {
    const h = harness({ automations: [auto({ enabled: true })] });
    h.runner.start();
    await h.runner.idle();
    h.state.settings = { ...h.state.settings, paused: true };
    h.runner.settingsChanged();
    expect(h.clock.pending()).toBe(0);
    h.state.settings = { ...h.state.settings, paused: false };
    h.runner.settingsChanged();
    await h.runner.idle();
    expect(h.clock.pending()).toBe(1);
  });
});

describe('turning on: what matches now is baselined, unless the user asks to start it', () => {
  test('baseline: nothing starts; a task that starts matching afterwards runs', async () => {
    const h = harness({ automations: [auto()], tasks: [task('t1'), task('t2', { status: 'Backlog' })] });
    h.runner.start();
    await h.runner.turnOn('a1', { startMatching: false });
    expect(h.ports.launch).not.toHaveBeenCalled();
    h.state.tasks = [...h.state.tasks, task('t3')];
    await h.tick(2 * MIN);
    expect(h.runs().map((r) => [r.task.id, r.state])).toEqual([['t3', 'starting']]);
    expect(h.ports.launch).toHaveBeenCalledTimes(1);
    // t2 moves to the status: it starts matching now, so it runs too.
    h.state.tasks = h.state.tasks.map((t) => (t.id === 't2' ? { ...t, status: 'Ready for AI' } : t));
    await h.tick(2 * MIN);
    expect(h.runs().map((r) => r.task.id).sort()).toEqual(['t2', 't3']);
  });

  test('"also start the N that match now"', async () => {
    const h = harness({ automations: [auto()], tasks: [task('t1')] });
    h.runner.start();
    await h.runner.turnOn('a1', { startMatching: true });
    expect(h.runs().map((r) => [r.task.id, r.state])).toEqual([['t1', 'starting']]);
  });

  test('an enabled automation that was never read baselines on its first read (never a burst)', async () => {
    const h = harness({ automations: [auto({ enabled: true })], tasks: [task('t1')] });
    h.runner.start();
    await h.runner.idle();
    expect(h.ports.launch).not.toHaveBeenCalled();
  });
});

async function on(h: ReturnType<typeof harness>, id = 'a1') {
  h.runner.start();
  await h.runner.turnOn(id, { startMatching: false });
}

describe('starting, queues and limits', () => {
  test('a run gets its task\'s detail, launches, and follows its session: working, needs you, review', async () => {
    const h = harness({ automations: [auto()] });
    await on(h);
    h.state.tasks = [task('t1')];
    await h.tick(2 * MIN);
    expect(h.ports.connector.detail).toHaveBeenCalledWith('clickup', 't1');
    const [r] = h.runs();
    expect(r).toMatchObject({ state: 'starting', terminalId: 'term-r1', branch: 'auto/t1', worktree: '/p/acme/.claude/worktrees/auto-t1' });
    h.setTerminals([term('term-r1', session('running'))]);
    await h.runner.idle();
    expect(h.runs()[0]!.state).toBe('working');
    expect(h.ports.removeLaunchFiles).toHaveBeenCalledWith('r1');
    h.setTerminals([term('term-r1', session('waiting'))]);
    expect(h.runs()[0]!.state).toBe('needsYou');
    h.setTerminals([term('term-r1', { ...session('done'), cost: { usd: 1.84 } as never })]);
    expect(h.runs()[0]).toMatchObject({ state: 'review', cost: 1.84 });
    expect(h.runs()[0]!.endedAt).toBe(h.clock.now());
  });

  test('deciding on its own: once in review, the decisions are read from its session, once', async () => {
    const h = harness({ automations: [auto({ claude: { decideAlone: true } })] });
    await on(h);
    h.state.tasks = [task('t1')];
    await h.tick(2 * MIN);
    h.setTerminals([term('term-r1', session('done'))]);
    await h.runner.idle();
    expect(h.runs()[0]!.decisions).toEqual(['Round half-even.']);
    h.setTerminals([term('term-r1', session('done'))]);
    await h.runner.idle();
    expect(h.ports.decisions).toHaveBeenCalledTimes(1);
    // Without "decide on its own", nothing is read.
    const plain = harness({ automations: [auto()] });
    await on(plain);
    plain.state.tasks = [task('t1')];
    await plain.tick(2 * MIN);
    plain.setTerminals([term('term-r1', session('done'))]);
    await plain.runner.idle();
    expect(plain.ports.decisions).not.toHaveBeenCalled();
  });

  test('the launch files go after 60 s even if the session never reports', async () => {
    const h = harness({ automations: [auto()] });
    await on(h);
    h.state.tasks = [task('t1')];
    await h.tick(2 * MIN);
    expect(h.ports.removeLaunchFiles).not.toHaveBeenCalled();
    await h.tick(60_000);
    expect(h.ports.removeLaunchFiles).toHaveBeenCalledWith('r1');
  });

  test('the automation\'s own limit queues the rest; when a run ends, the next one starts by itself', async () => {
    const h = harness({ automations: [auto({ limits: { concurrent: 2 } })] });
    await on(h);
    h.state.tasks = [task('t1'), task('t2'), task('t3')];
    await h.tick(2 * MIN);
    expect(h.runs().map((r) => [r.task.id, r.state, r.queued])).toEqual([['t1', 'starting', undefined], ['t2', 'starting', undefined], ['t3', 'queued', 'perAutomation']]);
    h.setTerminals([term('term-r1', session('done')), term('term-r2', session('running'))]);
    await h.runner.idle();
    expect(h.runs().find((r) => r.task.id === 't3')!.state).toBe('starting');
  });

  test('the global cap with "Ask me": held until Start (which ignores the cap) or Skip', async () => {
    const h = harness({ automations: [auto({ limits: { concurrent: 5 } })], settings: { cap: 1 } });
    await on(h);
    h.state.tasks = [task('t1'), task('t2'), task('t3')];
    await h.tick(2 * MIN);
    expect(h.runs().map((r) => [r.task.id, r.state, r.held])).toEqual([['t1', 'starting', undefined], ['t2', 'held', 'global'], ['t3', 'held', 'global']]);
    await h.runner.startRun('r2');
    expect(h.runs().find((r) => r.id === 'r2')!.state).toBe('starting');
    h.runner.skipRun('r3');
    expect(h.runs().find((r) => r.id === 'r3')).toMatchObject({ state: 'skipped' });
    // Held never starts by itself, even when room comes.
    h.setTerminals([term('term-r1', session('done')), term('term-r2', session('done'))]);
    await h.runner.idle();
    expect(h.runs().filter((r) => r.state === 'starting')).toEqual([]);
  });

  test('the global cap with "Wait in line": queued, and it starts when room comes', async () => {
    const h = harness({ automations: [auto({ limits: { concurrent: 5 } })], settings: { cap: 1, whenFull: 'queue' } });
    await on(h);
    h.state.tasks = [task('t1'), task('t2')];
    await h.tick(2 * MIN);
    expect(h.runs().map((r) => [r.state, r.queued])).toEqual([['starting', undefined], ['queued', 'global']]);
    h.setTerminals([term('term-r1', session('done'))]);
    await h.runner.idle();
    expect(h.runs()[1]!.state).toBe('starting');
  });

  test('Turn Off empties the queue: turned on again (baseline), the old backlog never starts by itself', async () => {
    const h = harness({ automations: [auto({ limits: { concurrent: 5 } })], settings: { cap: 1, whenFull: 'queue' } });
    await on(h);
    h.state.tasks = [task('t1'), task('t2')];
    await h.tick(2 * MIN);
    expect(h.runs()[1]).toMatchObject({ state: 'queued' });
    h.runner.turnOff('a1');
    expect(h.runs()[1]).toMatchObject({ state: 'skipped', reason: 'Left the queue: the automation was turned off' });
    await h.runner.turnOn('a1', { startMatching: false });
    h.setTerminals([term('term-r1', session('done'))]);
    await h.runner.idle();
    expect(h.runs()[1]!.state).toBe('skipped');
  });

  test('the day\'s count: queued for tomorrow, started after midnight', async () => {
    const h = harness({ automations: [auto({ limits: { perDay: 1, concurrent: 5 } })] });
    await on(h);
    h.state.tasks = [task('t1'), task('t2')];
    await h.tick(2 * MIN);
    expect(h.runs().map((r) => [r.state, r.queued])).toEqual([['starting', undefined], ['queued', 'perDay']]);
    await h.tick(16 * 60 * MIN);
    expect(h.runs()[1]!.state).toBe('starting');
  });

  test('usage at or above the pause: queued until it drops; unknown never blocks', async () => {
    const h = harness({ automations: [auto({ limits: { usagePause: 80 } })] });
    await on(h);
    h.state.usage = 86;
    h.state.tasks = [task('t1')];
    await h.tick(2 * MIN);
    expect(h.runs()[0]).toMatchObject({ state: 'queued', queued: 'usage' });
    h.state.usage = 40;
    await h.tick(2 * MIN);
    expect(h.runs()[0]!.state).toBe('starting');
  });

  test('a queued or held run whose task no longer matches leaves the queue', async () => {
    const h = harness({ automations: [auto({ limits: { concurrent: 1 } })] });
    await on(h);
    h.state.tasks = [task('t1'), task('t2')];
    await h.tick(2 * MIN);
    h.state.tasks = [task('t1'), task('t2', { status: 'Done' })];
    await h.tick(2 * MIN);
    expect(h.runs()[1]).toMatchObject({ state: 'skipped', reason: 'Left the queue: it no longer matches' });
  });

  test('a launch that fails: failed with its reason, and the slot is free again', async () => {
    const h = harness({ automations: [auto({ limits: { concurrent: 1 } })] });
    h.state.launch = (run) => (run.task.id === 't1' ? { ok: false, reason: 'acme isn\'t a git repository, so runs can\'t have their own worktree.' } : { ok: true, terminalId: `term-${run.id}` });
    await on(h);
    h.state.tasks = [task('t1'), task('t2')];
    await h.tick(2 * MIN);
    expect(h.runs().map((r) => [r.state, r.reason])).toEqual([['failed', 'acme isn\'t a git repository, so runs can\'t have their own worktree.'], ['starting', undefined]]);
  });

  test('a task gone from the source before it starts: skipped', async () => {
    const h = harness({ automations: [auto()] });
    await on(h);
    h.state.tasks = [task('t1')];
    (h.ports.connector.detail as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);
    await h.tick(2 * MIN);
    expect(h.runs()[0]).toMatchObject({ state: 'skipped', reason: 'The task is no longer available' });
  });

  test('a task that can\'t be read just now (offline, a 429): back in the queue, started on a later read, not counted today', async () => {
    const h = harness({ automations: [auto()] });
    await on(h);
    h.state.tasks = [task('t1')];
    const detail = h.ports.connector.detail as ReturnType<typeof vi.fn>;
    const read = detail.getMockImplementation()!;
    detail.mockImplementation(async () => { throw new Error('offline'); });
    await h.tick(2 * MIN);
    expect(h.runs()[0]).toMatchObject({ state: 'queued' });
    expect(h.runs()[0]!.startedAt).toBeUndefined();
    expect(h.ports.launch).not.toHaveBeenCalled();
    detail.mockImplementation(read);
    // Meanwhile it says why it waits.
    expect(h.runs()[0]!.reason).toBe('Atelier couldn\'t read the task just now: it tries again on the next read');
    await h.tick(10 * MIN);
    expect(h.runs()[0]).toMatchObject({ state: 'starting', terminalId: 'term-r1' });
    expect(h.runs()[0]!.reason).toBeUndefined();
  });

  test('Turned off while a queued run\'s task was being read, and the read failed: it leaves the queue too', async () => {
    const h = harness({ automations: [auto()] });
    await on(h);
    h.state.tasks = [task('t1')];
    let fail!: (e: Error) => void;
    (h.ports.connector.detail as ReturnType<typeof vi.fn>).mockImplementationOnce(() => new Promise((_res, rej) => { fail = rej; }));
    const tick = h.tick(2 * MIN);
    await vi.waitFor(() => expect(h.runs()[0]?.state).toBe('starting'));
    h.runner.turnOff('a1');
    fail(new Error('offline'));
    await tick;
    await h.runner.idle();
    expect(h.runs()[0]).toMatchObject({ state: 'skipped', reason: 'Left the queue: the automation was turned off' });
  });

  test('Start on a queued run whose task can\'t be read just now says why', async () => {
    const h = harness({ automations: [auto({ limits: { concurrent: 5 } })], settings: { cap: 1, whenFull: 'queue' } });
    await on(h);
    h.state.tasks = [task('t1'), task('t2')];
    await h.tick(2 * MIN);
    expect(h.runs()[1]).toMatchObject({ state: 'queued' });
    (h.ports.connector.detail as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('busy'));
    await h.runner.startRun('r2');
    expect(h.runs()[1]).toMatchObject({ state: 'queued', reason: 'Atelier couldn\'t read the task just now: try again in a moment' });
  });

  test('a retried run whose task can\'t be read just now stays as it was, and says why', async () => {
    const h = harness({ automations: [auto()] });
    h.state.launch = () => ({ ok: false, reason: 'boom' });
    await on(h);
    h.state.tasks = [task('t1')];
    await h.tick(2 * MIN);
    expect(h.runs()[0]!.state).toBe('failed');
    h.state.launch = null;
    (h.ports.connector.detail as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('busy'));
    await h.runner.startRun('r1');
    expect(h.runs()[0]).toMatchObject({ state: 'failed', reason: 'Atelier couldn\'t read the task just now: try again in a moment' });
  });

  test('an automation whose Claude account is gone: its usage reads as unknown, and reading goes on for all', async () => {
    const h = harness({ automations: [auto(), auto({ id: 'a2', name: 'Second' })] });
    h.ports.usage = () => { throw new Error('unknown Claude account'); };
    await on(h);
    h.state.tasks = [task('t1')];
    await h.tick(2 * MIN);
    expect(h.runs().map((r) => r.state)).toEqual(['starting']);
    expect(h.clock.pending()).toBeGreaterThan(0);
  });
});

describe('created by: the creator is read once per new candidate', () => {
  test('someone outside the list: not started, said why; never read again', async () => {
    const h = harness({ automations: [auto({ conditions: [{ field: 'status', values: ['Ready for AI'] }, { field: 'createdBy', values: ['me'] }] })] });
    await on(h);
    h.state.tasks = [task('t1'), task('t2')];
    h.state.creators = { t1: { id: 'me1', name: 'Me' }, t2: { id: 'u9', name: 'Bob Marley' } };
    await h.tick(2 * MIN);
    expect(h.runs().map((r) => [r.task.id, r.state, r.reason])).toEqual([
      ['t1', 'starting', undefined], ['t2', 'skipped', 'Created by Bob Marley, who isn\'t in "created by"']
    ]);
    await h.tick(2 * MIN);
    expect(h.ports.connector.creator).toHaveBeenCalledTimes(2);
  });
});

describe('catch-up: after a gap, new matches wait for the user', () => {
  test('held as catch-up; Start All starts them, Skip skips them', async () => {
    const h = harness({ automations: [auto({ limits: { concurrent: 5 } })] });
    await on(h);
    h.state.watchFails = true;
    await h.tick(10 * MIN);
    h.state.watchFails = false;
    h.state.tasks = [task('t1'), task('t2')];
    await h.tick(2 * MIN);
    expect(h.runs().map((r) => [r.state, r.held])).toEqual([['held', 'catchUp'], ['held', 'catchUp']]);
    await h.runner.catchUp('a1', 'start');
    expect(h.runs().map((r) => r.state)).toEqual(['starting', 'starting']);
  });

  test('after Atelier was closed: the runs on disk come back, the gap is a catch-up', async () => {
    const first = harness({ automations: [auto()] });
    await on(first);
    first.runner.dispose();
    // Six hours closed; a task started matching meanwhile.
    await first.clock.advance(6 * 60 * MIN);
    first.state.tasks = [task('t1')];
    const again = new AutomationRunner({ ...first.ports });
    again.start();
    await again.idle();
    expect(again.view().automations[0]!.runs.map((r) => [r.state, r.held])).toEqual([['held', 'catchUp']]);
    again.dispose();
  });
});

describe('runs that must not start twice, stick or leak', () => {
  const caughtUp = async (n: number) => {
    const h = harness({ automations: [auto({ limits: { concurrent: 5 } })] });
    await on(h);
    h.state.watchFails = true;
    await h.tick(10 * MIN);
    h.state.watchFails = false;
    h.state.tasks = Array.from({ length: n }, (_, i) => task(`t${i + 1}`));
    await h.tick(2 * MIN);
    return h;
  };

  test('Start All twice (a double click, a second window): each held run starts once', async () => {
    const h = await caughtUp(3);
    await Promise.all([h.runner.catchUp('a1', 'start'), h.runner.catchUp('a1', 'start')]);
    expect(h.ports.launch).toHaveBeenCalledTimes(3);
    expect(h.runs().map((r) => r.state)).toEqual(['starting', 'starting', 'starting']);
  });

  test('Start All, then Skip before it is done: what was skipped stays skipped', async () => {
    const h = await caughtUp(3);
    const starting = h.runner.catchUp('a1', 'start');
    await h.runner.catchUp('a1', 'skip');
    await starting;
    await h.runner.idle();
    expect(h.ports.launch).toHaveBeenCalledTimes(1);
    expect(h.runs().map((r) => r.state)).toEqual(['starting', 'skipped', 'skipped']);
  });

  test('an edit that widens an automation that is on turns it off until Turn On: nothing starts meanwhile', async () => {
    const h = harness({ automations: [auto()], tasks: [task('t1', { status: 'Backlog' })] });
    await on(h);
    h.runner.save(auto({ enabled: true, conditions: [{ field: 'status', values: ['Ready for AI', 'Backlog'] }] }));
    expect(h.runner.view().automations[0]!.automation.enabled).toBe(false);
    await h.tick(5 * MIN);
    expect(h.ports.launch).not.toHaveBeenCalled();
    // Turn On again (the re-confirm sheet) baselines what the wider rule matches now.
    await h.runner.turnOn('a1', { startMatching: false });
    await h.tick(5 * MIN);
    expect(h.ports.launch).not.toHaveBeenCalled();
    // A new name, instructions or limits keep it on.
    h.runner.save(auto({ name: 'Renamed', conditions: [{ field: 'status', values: ['Ready for AI', 'Backlog'] }] }));
    expect(h.runner.view().automations[0]!.automation.enabled).toBe(true);
  });

  test('a run left starting with no session when Atelier quit: failed on start, says why, its slot is free', async () => {
    const h = harness({ automations: [auto({ enabled: true })] });
    h.store.saveRuns('a1', [{ id: 'x1', automationId: 'a1', createdAt: 1, startedAt: 1, state: 'starting', task: { source: 'clickup', id: 't1', displayId: 'T1', title: 'x', url: 'https://app.clickup.com/t/t1' } }]);
    h.runner.start();
    await h.runner.idle();
    expect(h.runs().map((r) => [r.state, r.reason])).toEqual([['failed', 'Atelier closed while it was starting']]);
    expect(h.ports.removeLaunchFiles).toHaveBeenCalledWith('x1');
  });

  test('Claude never reports in its session (it exited at once): failed after 2 minutes, the next run starts', async () => {
    const h = harness({ automations: [auto({ limits: { concurrent: 1 } })] });
    await on(h);
    h.state.tasks = [task('t1'), task('t2')];
    await h.tick(2 * MIN);
    h.setTerminals([term('term-r1', null)]);
    await h.tick(MIN);
    expect(h.runs().map((r) => r.state)).toEqual(['starting', 'queued']);
    await h.tick(MIN);
    expect(h.runs().map((r) => [r.state, r.reason])).toEqual([['failed', 'Claude didn\'t start in its session'], ['starting', undefined]]);
  });

  test('launch files left by a quit go on start: at once past 60 s, else when they would have', async () => {
    const h = harness({ automations: [auto({ enabled: true })] });
    const now = h.clock.now();
    const t = (id: string) => ({ source: 'clickup' as const, id, displayId: id.toUpperCase(), title: id, url: `https://app.clickup.com/t/${id}` });
    h.store.saveRuns('a1', [
      { id: 'x1', automationId: 'a1', createdAt: now - 5 * MIN, startedAt: now - 5 * MIN, state: 'review', terminalId: 'k1', task: t('t1') },
      { id: 'x2', automationId: 'a1', createdAt: now - 10_000, startedAt: now - 10_000, state: 'starting', terminalId: 'k2', task: t('t2') }
    ]);
    // x2's Claude hasn't reported yet: its files stay until their 60 s are over.
    h.state.terminals = [term('k1', session('done')), term('k2', null)];
    h.runner.start();
    await h.runner.idle();
    expect(h.ports.removeLaunchFiles).toHaveBeenCalledWith('x1');
    expect(h.ports.removeLaunchFiles).not.toHaveBeenCalledWith('x2');
    await h.tick(50_000);
    expect(h.ports.removeLaunchFiles).toHaveBeenCalledWith('x2');
    expect(h.runs().map((r) => r.state)).toEqual(['review', 'starting']);
    // Its look at Claude survived the restart too: two minutes after its start, still silent, it fails.
    await h.tick(60_000);
    expect(h.runs().map((r) => r.state)).toEqual(['review', 'failed']);
  });

  test('a creator that can\'t be read (a 429, a timeout) is read again next time, not skipped for good', async () => {
    const h = harness({ automations: [auto({ conditions: [{ field: 'status', values: ['Ready for AI'] }, { field: 'createdBy', values: ['me'] }] })] });
    await on(h);
    h.state.tasks = [task('t1')];
    (h.ports.connector.creator as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('429'));
    await h.tick(2 * MIN);
    expect(h.runs()).toEqual([]);
    h.state.creators = { t1: { id: 'me1', name: 'Me' } };
    await h.tick(2 * MIN);
    expect(h.runs().map((r) => [r.task.id, r.state])).toEqual([['t1', 'starting']]);
  });

  test('a read that wasn\'t whole (more pages, a database that failed) never drops a queued run as "no longer matches"', async () => {
    const h = harness({ automations: [auto({ limits: { concurrent: 1 } })] });
    await on(h);
    h.state.tasks = [task('t1'), task('t2')];
    await h.tick(2 * MIN);
    expect(h.runs().map((r) => r.state)).toEqual(['starting', 'queued']);
    h.state.tasks = [task('t1')];
    h.state.partial = true;
    await h.tick(2 * MIN);
    expect(h.runs().map((r) => r.state)).toEqual(['starting', 'queued']);
    h.state.partial = false;
    await h.tick(2 * MIN);
    expect(h.runs().map((r) => [r.state, r.reason])).toEqual([['starting', undefined], ['skipped', 'Left the queue: it no longer matches']]);
  });

  test('in memory too, an automation keeps at most its last 50 ended runs (each window gets them all)', async () => {
    const h = harness({ automations: [auto({ conditions: [{ field: 'status', values: ['Ready for AI'] }, { field: 'createdBy', values: ['me'] }] })] });
    await on(h);
    h.state.tasks = Array.from({ length: 55 }, (_, i) => task(`t${i + 1}`));
    await h.tick(2 * MIN);
    expect(h.runs()).toHaveLength(50);
  });

  test('Merged by you asks only for runs that ended in the last 30 days', async () => {
    const h = harness({ automations: [auto({ enabled: true })] });
    const now = h.clock.now();
    const run = (id: string, endedAt: number): Run => ({
      id, automationId: 'a1', createdAt: endedAt, startedAt: endedAt, endedAt, state: 'review', branch: `auto/${id}`, base: 'refs/remotes/origin/main', baseOid: 'b'.repeat(40),
      task: { source: 'clickup', id, displayId: id.toUpperCase(), title: id, url: `https://app.clickup.com/t/${id}` }
    });
    h.store.saveRuns('a1', [run('old', now - 31 * 24 * 60 * MIN), run('new', now - 24 * 60 * MIN)]);
    h.state.terminals = [];
    h.runner.start();
    await h.runner.idle();
    await h.runner.refreshMerged();
    expect((h.ports.merged as ReturnType<typeof vi.fn>).mock.calls.map((c) => (c[1] as Run).id)).toEqual(['new']);
  });

  test('projectOf: a saved automation\'s own project (the All view edits other projects\' automations); null for a draft', () => {
    const h = harness({ automations: [auto({ project: '/p/other' })] });
    h.runner.start();
    expect(h.runner.projectOf('a1')).toBe('/p/other');
    expect(h.runner.projectOf('draft')).toBeNull();
  });

  test('deleting an automation while a run is launching leaves nothing behind on disk', async () => {
    const h = harness({ automations: [auto()] });
    await on(h);
    let release: (r: LaunchResult) => void = () => {};
    (h.ports.launch as ReturnType<typeof vi.fn>).mockImplementationOnce(() => new Promise<LaunchResult>((r) => { release = r; }));
    h.state.tasks = [task('t1')];
    await h.clock.advance(2 * MIN);
    await Promise.resolve();
    h.runner.remove('a1');
    const saved = vi.spyOn(h.store, 'saveRuns');
    release({ ok: true, terminalId: 'term-r1' });
    await h.runner.idle();
    expect(saved).not.toHaveBeenCalled();
    expect(h.store.loadRuns('a1')).toEqual([]);
    expect(h.runner.view().automations).toEqual([]);
  });
});

describe('Windows: prompt.md is read when Claude needs it, so the files stay while the run works', () => {
  test('no 60 s timer; they go when the run ends (review) or is stopped', async () => {
    const h = harness({ automations: [auto({ limits: { concurrent: 3 } })] });
    h.ports.launchFilesUntilEnd = true;
    await on(h);
    h.state.tasks = [task('t1'), task('t2')];
    await h.tick(2 * MIN);
    h.setTerminals([term('term-r1', session('running')), term('term-r2', session('running'))]);
    await h.tick(5 * MIN);
    expect(h.ports.removeLaunchFiles).not.toHaveBeenCalled();
    h.setTerminals([term('term-r1', session('done')), term('term-r2', session('running'))]);
    expect(h.ports.removeLaunchFiles).toHaveBeenCalledWith('r1');
    h.runner.stopRun('r2');
    expect(h.ports.removeLaunchFiles).toHaveBeenCalledWith('r2');
  });

  test('deleting an automation takes its runs\' files with it (no timer would)', async () => {
    const h = harness({ automations: [auto()] });
    h.ports.launchFilesUntilEnd = true;
    await on(h);
    h.state.tasks = [task('t1')];
    await h.tick(2 * MIN);
    h.setTerminals([term('term-r1', session('running'))]);
    h.runner.remove('a1');
    expect(h.ports.removeLaunchFiles).toHaveBeenCalledWith('r1');
  });

  test('a run that failed on an error keeps its task file (the session may go on) until Close Run', async () => {
    const h = harness({ automations: [auto()] });
    h.ports.launchFilesUntilEnd = true;
    await on(h);
    h.state.tasks = [task('t1')];
    await h.tick(2 * MIN);
    h.setTerminals([term('term-r1', session('running'))]);
    h.setTerminals([term('term-r1', session('error'))]);
    expect(h.runs()[0]!.state).toBe('failed');
    expect(h.ports.removeLaunchFiles).not.toHaveBeenCalled();
    await h.runner.closeRun('r1', false);
    expect(h.ports.removeLaunchFiles).toHaveBeenCalledWith('r1');
  });

  test('after a quit: an ended run\'s files go at start, a working one\'s stay', async () => {
    const h = harness({ automations: [auto({ enabled: true })] });
    h.ports.launchFilesUntilEnd = true;
    const now = h.clock.now();
    const t = (id: string) => ({ source: 'clickup' as const, id, displayId: id.toUpperCase(), title: id, url: `https://app.clickup.com/t/${id}` });
    h.store.saveRuns('a1', [
      { id: 'x1', automationId: 'a1', createdAt: now - 5 * MIN, startedAt: now - 5 * MIN, state: 'review', terminalId: 'k1', task: t('t1') },
      { id: 'x2', automationId: 'a1', createdAt: now - 5 * MIN, startedAt: now - 5 * MIN, state: 'working', terminalId: 'k2', task: t('t2') }
    ]);
    h.state.terminals = [term('k1', session('done')), term('k2', session('running'))];
    h.runner.start();
    await h.runner.idle();
    await h.tick(2 * MIN);
    expect((h.ports.removeLaunchFiles as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0])).toEqual(['x1']);
  });
});

describe('notifications: what needs the user, once', () => {
  const notes = (h: ReturnType<typeof harness>) => (h.ports.notify as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0] as { title: string; body: string });

  test('runs held for the user: one banner per read, how many', async () => {
    const h = harness({ automations: [auto({ limits: { concurrent: 5 } })], settings: { cap: 1 } });
    await on(h);
    h.state.tasks = [task('t1'), task('t2'), task('t3')];
    await h.tick(2 * MIN);
    expect(notes(h)).toEqual([{ automationId: 'a1', project: '/p/acme', title: 'Bug fixes', body: '2 runs are waiting for you: 1 automated run is already going, your limit.' }]);
  });

  test('a catch-up: how many started matching while Atelier was closed', async () => {
    const h = harness({ automations: [auto({ limits: { concurrent: 5 } })] });
    await on(h);
    h.state.watchFails = true;
    await h.tick(10 * MIN);
    h.state.watchFails = false;
    h.state.tasks = [task('t1')];
    await h.tick(2 * MIN);
    expect(notes(h).map((n) => n.body)).toEqual(['1 task started matching while Atelier was closed. Start it, or skip it.']);
  });

  test('a run that couldn\'t start says why', async () => {
    const h = harness({ automations: [auto()] });
    h.state.launch = () => ({ ok: false, reason: 'acme isn\'t a git repository, so runs can\'t have their own worktree.' });
    await on(h);
    h.state.tasks = [task('t1')];
    await h.tick(2 * MIN);
    expect(notes(h).map((n) => n.body)).toEqual(['Couldn\'t start T1: acme isn\'t a git repository, so runs can\'t have their own worktree.']);
  });

  test('paused because the source signed out: once, until it is back', async () => {
    const h = harness({ automations: [auto()] });
    await on(h);
    h.state.status = 'reconnect';
    h.runner.connectorsChanged();
    h.runner.connectorsChanged();
    expect(notes(h).map((n) => n.body)).toEqual(['Paused: ClickUp signed you out']);
    h.state.status = 'connected';
    h.runner.connectorsChanged();
    h.state.status = 'reconnect';
    h.runner.connectorsChanged();
    expect(notes(h)).toHaveLength(2);
  });
});

describe('preview: the editor\'s "Matching now"', () => {
  test('what matches the draft now, and what its "created by" leaves out, with why; nothing is saved or started', async () => {
    const h = harness();
    h.runner.start();
    h.state.tasks = [task('t1'), task('t2'), task('t3', { status: 'Backlog' }), task('t4', { scope: 'other' })];
    h.state.creators = { t1: { id: 'me1', name: 'Me' }, t2: { id: 'u9', name: 'Bob Marley' } };
    const draft = auto({ conditions: [{ field: 'status', values: ['Ready for AI'] }, { field: 'createdBy', values: ['me'] }] });
    const p = await h.runner.preview(draft);
    expect(p.matching.map((t) => t.id)).toEqual(['t1']);
    expect(p.count).toBe(1);
    expect(p.leftOut).toEqual([{ task: expect.objectContaining({ id: 't2' }), reason: 'Created by Bob Marley' }]);
    expect(h.runner.view().automations).toEqual([]);
    expect(h.ports.launch).not.toHaveBeenCalled();
  });

  test('the chips\' suggestions ride on the same read: every task of the scopes, whatever the conditions; defined statuses too', async () => {
    const h = harness();
    h.runner.start();
    h.state.tasks = [task('t1', { tags: ['ux'] }), task('t2', { status: 'Backlog', assignees: ['u2'] }), task('t3', { scope: 'other', status: 'Elsewhere' })];
    h.state.people = [{ id: 'me1', name: 'Ada' }, { id: 'u2', name: 'Grace' }];
    h.state.defined = [{ name: 'Blocked', color: '#ff0000' }];
    const p = await h.runner.preview(auto({ conditions: [{ field: 'tag', values: ['ux'] }] }));
    expect(p.matching.map((t) => t.id)).toEqual(['t1']);
    expect(p.values).toEqual({
      status: [{ name: 'Backlog', count: 1 }, { name: 'Ready for AI', count: 1 }, { name: 'Blocked', color: '#ff0000', count: 0 }],
      tag: [{ name: 'ux', count: 1 }],
      people: [{ id: 'u2', name: 'Grace', count: 1 }]
    });
    expect(h.ports.connector.definedStatuses).toHaveBeenCalledWith('clickup', ['l1']);
  });

  test('people: the creators the preview read join the suggestions (ClickUp lists carry none); the connected user is Me, never a name', async () => {
    const h = harness();
    h.runner.start();
    h.state.tasks = [task('t1'), task('t2', { assignees: ['u2'] })];
    h.state.people = [{ id: 'me1', name: 'Ada' }, { id: 'u2', name: 'Grace' }];
    h.state.creators = { t1: { id: 'u9', name: 'Bob Marley' }, t2: { id: 'u2', name: 'Grace' } };
    const p = await h.runner.preview(auto({ conditions: [{ field: 'createdBy', values: ['me'] }] }));
    expect(p.values!.people).toEqual([{ id: 'u9', name: 'Bob Marley', count: 1 }, { id: 'u2', name: 'Grace', count: 1 }]);
  });

  test('defined statuses are read alongside the tasks, not after them', async () => {
    const h = harness();
    h.runner.start();
    h.state.tasks = [task('t1')];
    let asked = false;
    let overlapped = false;
    h.ports.connector.definedStatuses = vi.fn(async () => { asked = true; return []; });
    h.ports.connector.watch = vi.fn(async () => { await Promise.resolve(); overlapped = asked; return { tasks: h.state.tasks, complete: true }; });
    await h.runner.preview(auto());
    expect(overlapped).toBe(true);
  });

  test('a source that can\'t be read: the reason, no tasks', async () => {
    const h = harness();
    h.runner.start();
    h.state.watchFails = true;
    expect(await h.runner.preview(auto())).toEqual({ matching: [], count: 0, leftOut: [], error: 'Couldn\'t read ClickUp: offline' });
    h.state.status = 'disconnected';
    expect(await h.runner.preview(auto())).toEqual({ matching: [], count: 0, leftOut: [], error: 'ClickUp isn\'t connected' });
  });
});

describe('the source, and the runs\' sessions', () => {
  test('a connector that isn\'t connected pauses its automations, says why, and reads nothing', async () => {
    const h = harness({ automations: [auto()] });
    await on(h);
    h.state.status = 'reconnect';
    await h.tick(2 * MIN);
    expect(h.runner.view().automations[0]!.status).toMatchObject({ kind: 'paused', reason: 'ClickUp signed you out' });
    const calls = (h.ports.connector.watch as ReturnType<typeof vi.fn>).mock.calls.length;
    await h.tick(2 * MIN);
    expect((h.ports.connector.watch as ReturnType<typeof vi.fn>).mock.calls.length).toBe(calls);
    h.state.status = 'connected';
    h.runner.connectorsChanged();
    await h.runner.idle();
    expect(h.runner.view().automations[0]!.status.kind).toBe('on');
  });

  test('Stop Run interrupts the session and marks the run stopped', async () => {
    const h = harness({ automations: [auto()] });
    await on(h);
    h.state.tasks = [task('t1')];
    await h.tick(2 * MIN);
    h.setTerminals([term('term-r1', session('running'))]);
    h.runner.stopRun('r1');
    expect(h.ports.sessions.interrupt).toHaveBeenCalledWith('term-r1');
    expect(h.runs()[0]!.state).toBe('stopped');
    // Claude Code sends no hook for the Esc: the next list still says running, from before the stop. It stays stopped.
    h.setTerminals([term('term-r1', session('running'))]);
    expect(h.runs()[0]!.state).toBe('stopped');
    // A new prompt the user types later makes it work again: running, it has no end time.
    h.setTerminals([term('term-r1', { ...session('running'), updatedAt: h.clock.now() + 60_000 })]);
    expect(h.runs()[0]!.state).toBe('working');
    expect(h.runs()[0]!.endedAt).toBeUndefined();
  });

  describe('Close Run', () => {
    const ready = async () => {
      const h = harness({ automations: [auto()] });
      await on(h);
      h.state.tasks = [task('t1')];
      await h.tick(2 * MIN);
      h.setTerminals([term('term-r1', session('done'))]);
      expect(h.runs()[0]!.state).toBe('review');
      return h;
    };

    test('closes the session, removes the clean worktree, keeps the branch; the run is closed', async () => {
      const h = await ready();
      expect(await h.runner.closeRun('r1', true)).toEqual({ outcome: 'ok' });
      expect(h.ports.sessions.close).toHaveBeenCalledWith('term-r1');
      expect(h.ports.removeWorktree).toHaveBeenCalledWith('/p/acme', '/p/acme/.claude/worktrees/auto-t1');
      expect(h.runs()[0]).toMatchObject({ state: 'closed', branch: 'auto/t1', worktreeRemoved: true });
      expect(h.store.loadRuns('a1')[0]).toMatchObject({ state: 'closed', worktreeRemoved: true });
    });

    test('a worktree with changes stays, and the answer says why; without the box only the session closes', async () => {
      const h = await ready();
      h.state.removeAnswer = { outcome: 'conflict', message: "The worktree has changes that aren't committed, so it stays" };
      expect(await h.runner.closeRun('r1', true)).toEqual({ outcome: 'conflict', message: "The worktree has changes that aren't committed, so it stays" });
      expect(h.runs()[0]!.state).toBe('closed');
      expect(h.runs()[0]).not.toHaveProperty('worktreeRemoved');
      const g = await ready();
      expect(await g.runner.closeRun('r1', false)).toEqual({ outcome: 'ok' });
      expect(g.ports.sessions.close).toHaveBeenCalledWith('term-r1');
      expect(g.ports.removeWorktree).not.toHaveBeenCalled();
    });

    test('a closed run (its session gone) can still remove its worktree, once; a stopped one keeps its state', async () => {
      const h = await ready();
      h.setTerminals([]);
      expect(h.runs()[0]!.state).toBe('closed');
      expect(await h.runner.closeRun('r1', true)).toEqual({ outcome: 'ok' });
      expect(h.ports.sessions.close).not.toHaveBeenCalled();
      expect(await h.runner.closeRun('r1', true)).toMatchObject({ outcome: 'error' });
      expect(h.ports.removeWorktree).toHaveBeenCalledTimes(1);
      const s = harness({ automations: [auto()] });
      await on(s);
      s.state.tasks = [task('t1')];
      await s.tick(2 * MIN);
      s.setTerminals([term('term-r1', session('running'))]);
      s.runner.stopRun('r1');
      expect(await s.runner.closeRun('r1', true)).toEqual({ outcome: 'ok' });
      expect(s.runs()[0]).toMatchObject({ state: 'stopped', worktreeRemoved: true });
    });

    test('a run still working, queued or unknown: refused, nothing happens', async () => {
      const h = harness({ automations: [auto()] });
      await on(h);
      h.state.tasks = [task('t1')];
      await h.tick(2 * MIN);
      h.setTerminals([term('term-r1', session('running'))]);
      expect(await h.runner.closeRun('r1', true)).toMatchObject({ outcome: 'error' });
      expect(await h.runner.closeRun('nope', true)).toMatchObject({ outcome: 'error' });
      expect(h.ports.sessions.close).not.toHaveBeenCalled();
      expect(h.ports.removeWorktree).not.toHaveBeenCalled();
      expect(h.runs()[0]!.state).toBe('working');
    });
  });

  describe('Merged by you', () => {
    test('a run that no longer works whose branch the user merged becomes merged; working ones aren\'t asked', async () => {
      const h = harness({ automations: [auto()] });
      await on(h);
      h.state.tasks = [task('t1'), task('t2')];
      await h.tick(2 * MIN);
      expect(h.runs().map((r) => r.base)).toEqual(['refs/remotes/origin/main', 'refs/remotes/origin/main']);
      h.setTerminals([term('term-r1', session('done')), term('term-r2', session('running'))]);
      h.state.merged = new Set(['r1', 'r2']);
      await h.runner.refreshMerged();
      expect(h.runs().map((r) => [r.id, r.state])).toEqual([['r1', 'merged'], ['r2', 'working']]);
      expect((h.ports.merged as ReturnType<typeof vi.fn>).mock.calls.map((c) => (c[1] as Run).id)).toEqual(['r1']);
      expect(h.store.loadRuns('a1')[0]!.state).toBe('merged');
    });

    test('at most once every 30 s; runs without a base (no worktree, or from before) aren\'t asked', async () => {
      const h = harness({ automations: [auto()] });
      await on(h);
      h.state.launch = (run) => ({ ok: true, terminalId: `term-${run.id}`, branch: 'main' });
      h.state.tasks = [task('t1')];
      await h.tick(2 * MIN);
      h.setTerminals([term('term-r1', session('done'))]);
      await h.runner.refreshMerged();
      expect(h.ports.merged).not.toHaveBeenCalled();
      const g = harness({ automations: [auto()] });
      await on(g);
      g.state.tasks = [task('t1')];
      await g.tick(2 * MIN);
      g.setTerminals([term('term-r1', session('done'))]);
      await g.runner.refreshMerged();
      await g.runner.refreshMerged();
      expect(g.ports.merged).toHaveBeenCalledTimes(1);
      await g.clock.advance(31_000);
      await g.runner.refreshMerged();
      expect(g.ports.merged).toHaveBeenCalledTimes(2);
    });
  });

  test('on start, runs whose session is gone end: failed while working, closed once in review', async () => {
    const h = harness({ automations: [auto({ enabled: true })] });
    h.store.saveRuns('a1', [
      { id: 'x1', automationId: 'a1', createdAt: 1, state: 'working', terminalId: 'gone-1', task: { source: 'clickup', id: 't1', displayId: 'T1', title: 'x', url: 'https://app.clickup.com/t/t1' } },
      { id: 'x2', automationId: 'a1', createdAt: 2, state: 'review', terminalId: 'gone-2', task: { source: 'clickup', id: 't2', displayId: 'T2', title: 'y', url: 'https://app.clickup.com/t/t2' } }
    ]);
    h.runner.start();
    await h.runner.idle();
    expect(h.runs().map((r) => [r.id, r.state])).toEqual([['x1', 'failed'], ['x2', 'closed']]);
  });

  test('runs and ledgers are saved; deleting an automation removes them', async () => {
    const h = harness({ automations: [auto()] });
    await on(h);
    h.state.tasks = [task('t1')];
    await h.tick(2 * MIN);
    expect(h.store.loadRuns('a1').map((r) => r.task.id)).toEqual(['t1']);
    expect(Object.keys(h.store.loadSeen('a1').ledger)).toEqual(['t1']);
    h.runner.remove('a1');
    expect(h.store.loadAutomations()).toEqual([]);
    expect(h.store.loadRuns('a1')).toEqual([]);
    expect(h.clock.pending()).toBe(0);
  });
});
