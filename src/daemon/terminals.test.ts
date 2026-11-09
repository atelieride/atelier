import { afterEach, describe, expect, test, vi } from 'vitest';
import { initPlatform, resetPlatformForTests } from '@shared/platform';
import type { Resumable } from '@shared/protocol';
import type { Usage } from '@shared/session';
import type { PtyProcess } from './session-pty';
import { TerminalManager, type TerminalManagerOptions } from './terminals';

// A window closing stops its sessions with a resume entry (capability 'kill-resumable').

interface Fake { kills: (string | undefined)[]; exit(code?: number): void; out(data: string): void }

type Extra = Pick<TerminalManagerOptions, 'log' | 'usageFor' | 'autoContinue'>;

function manager(o: { hangUpThrows?: boolean; alive?: boolean; process?: string } & Extra = {}): { tm: TerminalManager; fakes: Fake[]; lost: Resumable[] } {
  const fakes: Fake[] = [];
  const tm = new TerminalManager({
    ...(o.log ? { log: o.log } : {}),
    ...(o.usageFor ? { usageFor: o.usageFor } : {}),
    ...(o.autoContinue ? { autoContinue: o.autoContinue } : {}),
    isAlive: () => o.alive ?? false,
    launch: () => ({ file: '/bin/zsh', args: ['-l'], env: {} }),
    spawnFor: () => () => {
      const kills: (string | undefined)[] = [];
      const exits: ((e: { exitCode: number }) => void)[] = [];
      const outs: ((data: string) => void)[] = [];
      const proc: PtyProcess = {
        pid: 4242, process: o.process ?? 'zsh',
        onData: (l) => { outs.push(l as (data: string) => void); return { dispose() {} }; },
        onExit: (l) => { exits.push(l as (e: { exitCode: number }) => void); return { dispose() {} }; },
        write() {}, resize() {},
        kill: (...a: [string?]) => { kills.push(...(a.length ? a : [undefined])); if (o.hangUpThrows) throw new Error('ESRCH'); }
      };
      fakes.push({ kills, exit: (code = 0) => { for (const l of [...exits]) l({ exitCode: code }); }, out: (data) => { for (const l of outs) l(data); } });
      return proc;
    }
  });
  const lost: Resumable[] = [];
  tm.on('lost', (r: Resumable) => lost.push(r));
  return { tm, fakes, lost };
}

afterEach(() => resetPlatformForTests());

const start = (tm: TerminalManager, id: string, sid = 's1', transcript?: string) => tm.applyHook(id, { hook_event_name: 'SessionStart', session_id: sid, cwd: '/tmp', source: 'startup', ...(transcript ? { transcript_path: transcript } : {}) });

test('a kill with resumable gives the session back as resumable, even after Claude’s SessionEnd cleared it', () => {
  initPlatform('darwin');
  const { tm, fakes, lost } = manager();
  const a = tm.create({ projectRoot: '/tmp', cwd: '/tmp', cols: 80, rows: 24, name: 'Fix it' });
  start(tm, a.id);
  tm.kill(a.id, { resumable: true });
  // zsh passes the hang-up on: Claude ends its session cleanly before the shell exits.
  tm.applyHook(a.id, { hook_event_name: 'SessionEnd', session_id: 's1', reason: 'other' });
  fakes[0]!.exit();
  expect(lost).toHaveLength(1);
  expect(lost[0]).toMatchObject({ id: a.id, projectRoot: '/tmp', sessionId: 's1', color: a.color });
});

test('a plain kill (the user closing a session) gives nothing back; a terminal without Claude neither', () => {
  initPlatform('darwin');
  const { tm, fakes, lost } = manager();
  const a = tm.create({ projectRoot: '/tmp', cwd: '/tmp', cols: 80, rows: 24 });
  const b = tm.create({ projectRoot: '/tmp', cwd: '/tmp', cols: 80, rows: 24 });
  start(tm, a.id);
  tm.kill(a.id);
  tm.kill(b.id, { resumable: true });
  fakes[0]!.exit();
  fakes[1]!.exit();
  expect(lost).toEqual([]);
});

test('a hang-up that fails with the shell still running drops the entry with the closing flag', () => {
  initPlatform('darwin');
  const { tm, fakes, lost } = manager({ hangUpThrows: true, alive: true });
  const a = tm.create({ projectRoot: '/tmp', cwd: '/tmp', cols: 80, rows: 24 });
  start(tm, a.id);
  tm.kill(a.id, { resumable: true });
  // Claude exits later on its own: the shell back at its prompt, closed by the user afterwards.
  tm.applyHook(a.id, { hook_event_name: 'SessionEnd', session_id: 's1', reason: 'exit' });
  fakes[0]!.exit();
  expect(lost).toEqual([]);
});

test('the entry keeps the Claude account the session ran with, so it resumes with it', () => {
  initPlatform('darwin');
  const { tm, fakes, lost } = manager();
  const a = tm.create({ projectRoot: '/tmp', cwd: '/tmp', cols: 80, rows: 24 });
  start(tm, a.id, 's1', '/Users/u/.claude_work/projects/-tmp/s1.jsonl');
  tm.kill(a.id, { resumable: true });
  fakes[0]!.exit();
  expect(lost[0]?.configDir).toBe('/Users/u/.claude_work');
});

// A resume whose Claude has not started yet (no session) is not lost when its window closes with Stop.
// It comes back under the terminal's id: the app moved the session's task link and pin to it when the resume replied.
test('a resumed terminal stopped before its Claude starts gives its resume entry back, under its own id', () => {
  initPlatform('darwin');
  const { tm, fakes, lost } = manager();
  const entry: Resumable = { id: 'old', projectRoot: '/tmp', cwd: '/tmp', title: 'Beta', color: '#fff', sessionId: 's9', endedAt: 1 };
  const a = tm.create({ projectRoot: '/tmp', cwd: '/tmp', cols: 80, rows: 24, resumeOf: entry });
  tm.kill(a.id, { resumable: true });
  fakes[0]!.exit();
  expect(lost).toHaveLength(1);
  expect(lost[0]).toMatchObject({ id: a.id, sessionId: 's9', title: 'Beta' });
});

test('a resume whose shell dies at once, before Claude starts, gives its entry back under the terminal’s id', () => {
  initPlatform('darwin');
  const { tm, fakes, lost } = manager();
  const entry: Resumable = { id: 'old', projectRoot: '/tmp', cwd: '/tmp', title: 'Beta', color: '#fff', sessionId: 's9', endedAt: 1 };
  const a = tm.create({ projectRoot: '/tmp', cwd: '/tmp', cols: 80, rows: 24, resumeOf: entry });
  fakes[0]!.exit(1);
  expect(lost).toHaveLength(1);
  expect(lost[0]).toMatchObject({ id: a.id, sessionId: 's9', title: 'Beta' });
});

// 2026-10-29: the screen sent on attach (an app restart) kept full-screen Claude's mouse tracking but not its SGR encoding
// nor its hidden cursor: the wheel stopped reaching Claude until it set its modes again (snapshot-modes.ts).
test('the screen sent on attach keeps the mouse encoding and the hidden cursor', async () => {
  initPlatform('darwin');
  const { tm, fakes } = manager();
  const a = tm.create({ projectRoot: '/tmp', cwd: '/tmp', cols: 80, rows: 24 });
  fakes[0]!.out('\x1b[?1049h\x1b[?1002h\x1b[?1006h\x1b[?25lclaude');
  const snapshot = await new Promise<string>((done) => tm.attach(a.id, done, () => {}));
  expect(snapshot).toContain('\x1b[?1002h');
  expect(snapshot).toContain('\x1b[?1006h');
  expect(snapshot).toContain('\x1b[?25l');
  tm.kill(a.id);
  fakes[0]!.exit();
});

// Claude Code's usage-limit pause: atelierd opens it at a rate_limit stop,
// confirms it with the account's limits, ends it as unconfirmed or expired in the sweep.
describe('usage-limit pause', () => {
  const T0 = Date.UTC(2026, 9, 31, 10, 0, 0);
  const HOUR = 3_600_000;
  const DIR = '/u/.claude_work';
  const TRANSCRIPT = `${DIR}/projects/-tmp/s1.jsonl`;
  const UNCONFIRMED = (id: string) => `terminal ${id}: rate_limit stop without a usage limit in sight: shown as an error`;
  const at = (ms: number) => vi.setSystemTime(ms);
  /** The account at 100 % of its 5-hour window, reset in 2 hours. */
  const atLimit = (resetsAt = T0 + 2 * HOUR): Usage => ({ fiveHour: { pct: 100, resetsAt: resetsAt / 1000 }, sevenDay: null, updatedAt: T0 });
  const status = (limits?: Usage) => ({
    session_id: 's1', transcript_path: TRANSCRIPT, context_window: { used_percentage: 12 },
    ...(limits ? { rate_limits: { five_hour: { used_percentage: limits.fiveHour!.pct, resets_at: limits.fiveHour!.resetsAt } } } : {})
  });
  const stopFailure = (message = 'API Error: Request rejected (429)') => ({ hook_event_name: 'StopFailure', session_id: 's1', transcript_path: TRANSCRIPT, error: 'rate_limit', last_assistant_message: message });
  const pauseOf = (tm: TerminalManager) => tm.list()[0]!.session!.limitPause;
  const changes = (tm: TerminalManager) => { const c = { n: 0 }; tm.on('changed', () => { c.n += 1; }); return c; };

  afterEach(() => vi.useRealTimers());

  function setup(o: { process?: string } & Extra = {}) {
    initPlatform('darwin');
    vi.useFakeTimers({ toFake: ['Date'] });
    at(T0);
    const logs: string[] = [];
    const { tm } = manager({ log: (m) => logs.push(m), ...o });
    const a = tm.create({ projectRoot: '/tmp', cwd: '/tmp', cols: 80, rows: 24 });
    start(tm, a.id, 's1', TRANSCRIPT);
    return { tm, id: a.id, logs };
  }

  test('a rate_limit stop with the account at 100 % is a pause until the window resets', () => {
    const { tm, id } = setup();
    tm.applyStatus(id, status(atLimit()));
    at(T0 + 300);
    tm.applyHook(id, stopFailure());
    expect(tm.list()[0]!.session).toMatchObject({ state: 'error', errorReason: 'rate_limit', limitPause: { since: T0 + 300, resetsAt: T0 + 2 * HOUR } });
  });

  test('the account’s limits as atelierd merged them count too (another terminal of the same account)', () => {
    const asked: (string | null)[] = [];
    const { tm, id } = setup({ usageFor: (dir) => { asked.push(dir); return dir === DIR ? atLimit(T0 + HOUR) : null; } });
    tm.applyHook(id, stopFailure());
    expect(asked).toContain(DIR);
    expect(pauseOf(tm)).toEqual({ since: T0, resetsAt: T0 + HOUR });
  });

  test('a stop first, its status line within 5 s: checking at once, then paused (and the change is sent)', () => {
    const { tm, id } = setup();
    tm.applyStatus(id, status());
    tm.applyHook(id, stopFailure());
    expect(pauseOf(tm)).toEqual({ since: T0, resetsAt: null });
    const c = changes(tm);
    at(T0 + 1_000);
    tm.applyStatus(id, status(atLimit()));
    expect(pauseOf(tm)).toEqual({ since: T0, resetsAt: T0 + 2 * HOUR });
    expect(c.n).toBe(1);
  });

  test('late status line never arms: a limit seen 6 s after the stop leaves it an error, logged once', () => {
    // Another session of the same account reaches 100 % too, just as late.
    let account: Usage | null = null;
    const { tm, id, logs } = setup({ usageFor: () => account });
    tm.applyHook(id, stopFailure());
    expect(pauseOf(tm)).toEqual({ since: T0, resetsAt: null });
    at(T0 + 6_000);
    account = atLimit();
    tm.applyStatus(id, status(atLimit()));
    // Still checking: only the sweep ends it.
    expect(pauseOf(tm)).toEqual({ since: T0, resetsAt: null });
    expect(logs).toEqual([]);
    const c = changes(tm);
    tm.sweepSessions(T0 + 6_000);
    expect(tm.list()[0]!.session).toMatchObject({ state: 'error', unread: true, limitPause: { since: T0, resetsAt: null, over: 'unconfirmed' } });
    expect(c.n).toBe(1);
    tm.sweepSessions(T0 + 7_000);
    at(T0 + 8_000);
    tm.applyStatus(id, status(atLimit()));
    expect(c.n).toBe(1);
    expect(logs).toEqual([UNCONFIRMED(id)]);
  });

  test('a reset more than 24 hours away is not waited for: unconfirmed at once, logged once', () => {
    const { tm, id, logs } = setup();
    tm.applyStatus(id, status(atLimit(T0 + 30 * HOUR)));
    tm.applyHook(id, stopFailure());
    expect(pauseOf(tm)).toMatchObject({ over: 'unconfirmed' });
    tm.sweepSessions(T0 + 10_000);
    expect(logs).toEqual([UNCONFIRMED(id)]);
    // A new episode is a new decision, and a new line.
    at(T0 + 20_000);
    tm.applyHook(id, stopFailure());
    expect(logs).toEqual([UNCONFIRMED(id), UNCONFIRMED(id)]);
  });

  // Review fix (Task 3): the terminal's own limits belong to the account whose status line brought them.
  test('another account’s limits never open a pause: a Claude on account B after A hit its limit is only checking', () => {
    const { tm, id, logs } = setup();
    tm.applyStatus(id, status(atLimit()));
    // `CLAUDE_CONFIG_DIR=B claude` in the same terminal: B's status line has no limits yet (before its first response).
    const B = '/u/.claude_b';
    const transcriptB = `${B}/projects/-tmp/s2.jsonl`;
    at(T0 + 60_000);
    tm.applyHook(id, { hook_event_name: 'SessionStart', session_id: 's2', cwd: '/tmp', source: 'startup', transcript_path: transcriptB });
    tm.applyHook(id, { ...stopFailure(), session_id: 's2', transcript_path: transcriptB });
    expect(pauseOf(tm)).toEqual({ since: T0 + 60_000, resetsAt: null });
    at(T0 + 61_000);
    tm.applyStatus(id, { session_id: 's2', transcript_path: transcriptB, context_window: { used_percentage: 3 } });
    expect(pauseOf(tm)).toEqual({ since: T0 + 60_000, resetsAt: null });
    tm.sweepSessions(T0 + 66_000);
    expect(pauseOf(tm)).toMatchObject({ resetsAt: null, over: 'unconfirmed' });
    expect(logs).toEqual([UNCONFIRMED(id)]);
  });

  test('Claude Code’s auto-continue off: a rate_limit stop stays today’s error, the setting read from the hook’s own dir', () => {
    const asked: (string | null)[] = [];
    initPlatform('darwin');
    vi.useFakeTimers({ toFake: ['Date'] });
    at(T0);
    const { tm } = manager({ autoContinue: (dir) => { asked.push(dir); return false; } });
    const a = tm.create({ projectRoot: '/tmp', cwd: '/tmp', cols: 80, rows: 24 });
    // A start without a transcript: the terminal knows no config dir until the stop names it.
    start(tm, a.id);
    tm.applyHook(a.id, stopFailure());
    expect(asked).toEqual([DIR]);
    expect(tm.list()[0]!.session).toMatchObject({ state: 'error', errorReason: 'rate_limit' });
    expect('limitPause' in tm.list()[0]!.session!).toBe(false);
  });

  test('another error never reads the settings', () => {
    const asked: (string | null)[] = [];
    const { tm, id } = setup({ autoContinue: (dir) => { asked.push(dir); return true; } });
    tm.applyHook(id, { ...stopFailure(), error: 'overloaded' });
    expect(asked).toEqual([]);
    expect('limitPause' in tm.list()[0]!.session!).toBe(false);
  });

  test('a Claude Code older than 2.1.234 doesn’t wait at the limit: no pause', () => {
    const { tm, id } = setup({ process: '2.1.100' });
    tm.applyStatus(id, status(atLimit()));
    tm.applyHook(id, stopFailure());
    expect(tm.list()[0]!.session).toMatchObject({ state: 'error', errorReason: 'rate_limit' });
    expect('limitPause' in tm.list()[0]!.session!).toBe(false);
  });

  test('same object: a status line that changes nothing sends nothing, checking or paused', () => {
    const { tm, id } = setup();
    tm.applyStatus(id, status());
    tm.applyHook(id, stopFailure());
    const c = changes(tm);
    at(T0 + 500);
    tm.applyStatus(id, status());
    expect(c.n).toBe(0);
    tm.applyStatus(id, status(atLimit()));
    expect(c.n).toBe(1);
    at(T0 + 1_000);
    tm.applyStatus(id, status(atLimit()));
    expect(c.n).toBe(1);
  });

  test('same object: a sweep with nothing to expire sends nothing; past the reset by 10 minutes, the pause is over', () => {
    const { tm, id, logs } = setup();
    tm.applyHook(id, stopFailure());
    const c = changes(tm);
    // Checking, inside its 5 seconds.
    tm.sweepSessions(T0 + 4_000);
    expect(c.n).toBe(0);
    tm.applyStatus(id, status(atLimit()));
    expect(c.n).toBe(1);
    tm.sweepSessions(T0 + 2 * HOUR + 600_000);
    expect(c.n).toBe(1);
    tm.sweepSessions(T0 + 2 * HOUR + 600_001);
    expect(tm.list()[0]!.session).toMatchObject({ unread: true, limitPause: { since: T0, resetsAt: T0 + 2 * HOUR, over: 'expired' } });
    expect(c.n).toBe(2);
    expect(logs).toEqual([]);
  });

  test('foregroundOf: the process in front of a terminal, null for an unknown one', () => {
    const { tm, id } = setup({ process: '2.1.316' });
    expect(tm.foregroundOf(id)).toBe('2.1.316');
    expect(tm.foregroundOf('nope')).toBeNull();
  });
});
