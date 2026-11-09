import { describe, expect, test } from 'vitest';
import { feedKey } from '../../shared/background-feed';
import type { SessionInfo } from '../../shared/session';
import type { BeatStep, CompiledBeat, SessionPatch } from '../engine/beats-types';
import { BEATS, BILLING_FEEDS, BILLING_WATCH } from '../world/beats';
import { compileDemoBeats, patchOf } from './beats';
import { DEMO_ROOT, T0, compileSessions } from './sessions';

// The beats through the app's own reducers: each run of hook events
// becomes the session fields atelierd would send, the background work main would attach; the payloads never ship.

const { sessions, raw } = compileSessions(DEMO_ROOT, T0);
const world = compileDemoBeats(DEMO_ROOT, T0, sessions, raw);
const id = (name: string) => sessions.find((s) => s.scenario === name)!.terminal.id;

/** The session patches of a segment, in order. */
const patches = (b: CompiledBeat, seg: string): SessionPatch[] => b.segments[seg]!.flatMap((s) => (s.k === 'session' ? [s.patch] : []));
const kinds = (b: CompiledBeat, seg: string) => b.segments[seg]!.map((s) => s.k);
const last = <T>(a: T[]) => a[a.length - 1]!;

describe('auth-refactor', () => {
  const b = world.beats['auth-refactor']!;

  test('starts on its permission: 1 and 2 run the tests, 3 and Esc decline', () => {
    expect(b.start).toBe('ask');
    expect(b.segments.ask).toEqual([{ k: 'ask', ask: { kind: 'permission', command: 'npm test -- auth', routes: ['run', 'run', 'reject'], cancel: 'reject' } }]);
  });

  test('yes: waiting until the run ends, then running, the edit, done (unread: the inbox and the chime follow)', () => {
    const p = patches(b, 'run');
    expect(p[0]!.set).toMatchObject({ state: 'running', waitingFor: null });
    expect(p.some((x) => x.set.activity?.includes('session.ts'))).toBe(true);
    expect(last(p).set).toMatchObject({ state: 'done', unread: true, activity: null });
    expect(last(p).stamp).toEqual(['updatedAt', 'lastMessageAt']);
    const writes = b.segments.run!.filter((s): s is Extract<BeatStep, { k: 'write' }> => s.k === 'write');
    expect(writes).toEqual([{ k: 'write', write: { file: 'src/auth/session.ts', replace: [['entry.expiresAt - SKEW_MS < now', 'entry.expiresAt + SKEW_MS < now']] } }]);
    expect(last(kinds(b, 'run'))).toBe('prompt');
  });

  test('no: done, nothing waits any more', () => {
    const p = patches(b, 'reject');
    expect(last(p).set).toMatchObject({ state: 'done', waitingFor: null });
    expect(b.segments.reject!.some((s) => s.k === 'write')).toBe(false);
  });
});

describe('db-migration', () => {
  const b = world.beats['db-migration']!;

  test('the question: three options, the third typed; every answer and Esc lead somewhere', () => {
    expect(b.segments.ask![0]).toEqual({ k: 'ask', ask: { kind: 'question', options: ['paid', 'pending', 'Type something'], routes: ['paid', 'pending', 'typed'], cancel: 'skip', typed: 2 } });
    for (const seg of ['paid', 'pending', 'typed', 'skip']) {
      expect(patches(b, seg)[0]!.set, seg).toMatchObject({ state: 'running', waitingFor: null });
      expect(last(patches(b, seg)).set, seg).toMatchObject({ state: 'done' });
    }
  });

  test('each branch writes its own migration', () => {
    const sql = (seg: string) => b.segments[seg]!.flatMap((s) => (s.k === 'write' && s.write.content ? [s.write.content] : []))[0]!;
    expect(sql('paid')).toContain(`UPDATE "Order" SET "status" = 'paid';`);
    expect(sql('pending')).not.toContain('UPDATE');
    expect(sql('typed')).toContain('-- TODO for existing orders: {answer}');
    expect(b.segments.skip!.some((s) => s.k === 'write')).toBe(false);
  });
});

describe('billing-tests (auto)', () => {
  const b = world.beats['billing-tests']!;
  const p = patches(b, 'run');

  test('the agents finish one after the other, the shell ends, it is done about 90 s in', () => {
    expect(p[0]!.set).toMatchObject({ subagents: 1 });
    expect(p[0]!.work).toMatchObject({ agents: 1, shells: 1 });
    expect(p[1]!.work).toMatchObject({ agents: 0, shells: 0 });
    expect(last(p).set).toMatchObject({ state: 'done', unread: true });
    const untils = b.segments.run!.flatMap((s) => (s.k === 'until' ? [s.ms] : []));
    expect(Math.max(...untils)).toBe(88_000);
  });

  test("the ended shell joins the session's recent items with its exit code, as main's work scan reports it", () => {
    expect(p[0]!.recent).toEqual([expect.objectContaining({ id: 'a2', kind: 'agent', label: 'currency formats' })]);
    expect(p[1]!.recent).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'b7k2m9q4x', kind: 'shell', exit: 1, label: 'Run billing tests' }), expect.objectContaining({ id: 'a1' })]));
  });

  test('the fix in invoice.ts is attributed (its PostToolUse is an attributed edit)', () => {
    expect(b.segments.run!.some((s) => s.k === 'write' && s.write.file === 'src/billing/invoice.ts')).toBe(true);
  });

  test('after the fix it leaves a test watcher running: a persistent Monitor, listed to the end, never counted as work', () => {
    const steps = b.segments.run!;
    const fix = steps.findIndex((s) => s.k === 'write' && s.write.file === 'src/billing/invoice.ts');
    const started = steps.findIndex((s) => s.k === 'session' && (s.patch.work?.entries ?? []).some((e) => e.id === BILLING_WATCH.id));
    expect(started).toBeGreaterThan(fix);
    expect(steps.slice(0, started).some((s) => s.k === 'until' && s.ms === BILLING_WATCH.at)).toBe(true);
    // From then on every patch keeps it (the Stop's background_tasks list it): Background is never empty.
    for (const s of steps.slice(started)) {
      if (s.k !== 'session' || s.patch.work === undefined) continue;
      expect(s.patch.work?.entries.find((e) => e.id === BILLING_WATCH.id)).toMatchObject({ kind: 'monitor', label: 'Watch billing tests', watcher: true, display: 'npx vitest --watch billing' });
    }
    // A watcher: the session is done all the same (⌘J, the chime), the monitor is not work.
    expect(last(p).set).toMatchObject({ state: 'done' });
    expect(last(p).work ?? p.findLast((x) => x.work)!.work).toMatchObject({ counting: false, monitors: 0 });
  });
});

describe('Esc while Claude works (an interruption)', () => {
  test('no Stop: the idle notice brings the session back to ready, as the app reads it; only the state fields', () => {
    for (const name of ['auth-refactor', 'db-migration', 'docs', 'generic-tokens', 'diagnose-worker'] as const) {
      const p = world.beats[name]!.interrupt;
      expect(p, name).toBeDefined();
      expect(p!.set, name).toMatchObject({ state: 'idle', activity: null, waitingFor: 'input', compacting: false });
      expect(Object.keys(p!.set).sort(), name).toEqual(['activity', 'compacting', 'errorReason', 'state', 'unread', 'waitingFor']);
      expect(p!.work, name).toBeUndefined();
    }
  });

  test('billing-tests runs background agents: Claude Code sends no idle notice while they run, so there is none', () => {
    expect(world.beats['billing-tests']!.interrupt).toBeUndefined();
  });
});

describe('docs (auto)', () => {
  test('keeps working: tools change its activity, no Stop', () => {
    const p = patches(world.beats.docs!, 'run');
    expect(p.map((x) => x.set.state)).not.toContain('done');
    expect(p.some((x) => x.set.activity?.includes('invoice.ts'))).toBe(true);
    expect(last(kinds(world.beats.docs!, 'run'))).not.toBe('prompt');
  });

  test('its cron: every 30 minutes', () => {
    expect(world.crons[id('docs')]).toEqual({ c1: 30 * 60_000 });
  });
});

describe('free prompts and diagnoses', () => {
  test.each(['generic-tokens', 'generic-invoice', 'generic-readme', 'diagnose-worker', 'diagnose-job'])('%s: prompt → running → waiting on an edit → running → done', (name) => {
    const b = world.beats[name]!;
    const look = patches(b, 'look');
    expect(look[0]!.set).toMatchObject({ state: 'running', waitingFor: null, unread: false });
    expect(look[0]!.stamp).toContain('lastMessageAt');
    expect(last(look).set).toMatchObject({ state: 'waiting', waitingFor: 'permission' });
    expect(last(kinds(b, 'look'))).toBe('ask');
    expect(patches(b, 'apply')[0]!.set).toMatchObject({ state: 'running', waitingFor: null });
    expect(last(patches(b, 'apply')).set).toMatchObject({ state: 'done' });
    expect(last(patches(b, 'decline')).set).toMatchObject({ state: 'done', waitingFor: null });
  });

  test('in turn, and the diagnoses named', () => {
    expect(world.generic).toEqual(['generic-tokens', 'generic-invoice', 'generic-readme']);
    expect(world.diagnose).toEqual({ worker: 'diagnose-worker', job: 'diagnose-job' });
  });

  test('no disclaimer in the answers (the demo says it is scripted in its own chrome)', () => {
    expect(JSON.stringify(world.beats)).not.toMatch(/demo|script/i);
  });
});

describe('what ships', () => {
  test('no hook payload, no internal bookkeeping (only what main sends)', () => {
    const json = JSON.stringify(world);
    expect(json).not.toContain('hook_event_name');
    for (const k of ['agentWaits', 'agentRuns', 'mainRest', 'bgOwners', 'bgSeen', 'agentDescriptions', 'agentsWaiting']) expect(json).not.toContain(`"${k}"`);
    expect(json).not.toContain('"command":"npm test -- billing"');
  });

  test('every authored segment is compiled', () => {
    for (const [name, src] of Object.entries(BEATS)) expect(Object.keys(world.beats[name]!.segments).sort(), name).toEqual(Object.keys(src.segments).sort());
  });

  test('what each scripted session plays', () => {
    expect(world.sessions).toEqual({
      [id('auth-refactor')]: { beat: 'auth-refactor', auto: false }, [id('db-migration')]: { beat: 'db-migration', auto: false },
      [id('billing-tests')]: { beat: 'billing-tests', auto: true }, [id('docs')]: { beat: 'docs', auto: true }
    });
  });

  test('a new session: idle once Claude started, on Opus, nothing spent yet; the welcome names the project', () => {
    expect(world.fresh.session).toMatchObject({ state: 'idle', model: 'Opus 5.5', cost: { usd: 0, linesAdded: 0, linesRemoved: 0 }, cwd: DEMO_ROOT, unread: false });
    expect(world.fresh.transcript.join('\n')).toContain(`cwd: ${DEMO_ROOT}`);
  });
});

describe('feeds', () => {
  const billing = id('billing-tests');

  test("an agent's timeline grows a step at a time, as TranscriptReader reads its transcript", () => {
    const a1 = world.feeds[feedKey(billing, 'a1')]!;
    if (a1.kind !== 'timeline') throw new Error('timeline expected');
    expect(a1.times).toEqual([...BILLING_FEEDS.a1.times]);
    expect(a1.frames.map((f) => f.entries.length)).toEqual([3, 4, 5, 6]);
    expect(a1.frames[0]!.meta.task).toContain('Find where invoice totals are rounded');
    expect(last(a1.frames).entries[0]).toMatchObject({ kind: 'tool', tool: 'Grep', target: 'Math.round in src', result: 'ok' });
    expect(last(a1.frames).meta.tools).toBe(5);
  });

  test("the vitest shell: its first lines, then the rest until 50 s, exit 1", () => {
    const sh = world.feeds[feedKey(billing, 'b7k2m9q4x')]!;
    if (sh.kind !== 'output') throw new Error('output expected');
    expect(sh.shown).toBe(12);
    expect(sh.times.length).toBe(sh.lines.length - 12);
    expect(last(sh.times)).toBe(50_000);
    expect(sh.exit).toBe(1);
    expect(sh.lines).toContain('      Tests  1 failed | 15 passed (16)');
  });

  test('the test watcher: its first run once it starts (all green after the fix), then a rerun for each billing change', () => {
    const w = world.feeds[feedKey(billing, BILLING_WATCH.id)]!;
    if (w.kind !== 'output') throw new Error('output expected');
    expect(w.shown).toBe(0);
    expect(w.times[0]).toBeGreaterThan(BILLING_WATCH.at);
    expect(w.exit).toBeNull();
    expect(w.lines).toContain('      Tests  16 passed (16)');
    expect(w.rerun).toMatchObject({ after: BILLING_WATCH.at });
    expect(w.rerun!.lines.join('\n')).toContain(' RERUN  {file}');
    expect(new RegExp(w.rerun!.match).test('src/billing/invoice.ts')).toBe(true);
    expect(new RegExp(w.rerun!.match).test('README.md')).toBe(false);
  });
});

describe('patchOf', () => {
  const s = { sessionId: 'x', state: 'done', title: null, activity: null, contextPct: 3, unread: false, updatedAt: 1, lastMessageAt: 1, subagents: 2 } as SessionInfo;

  test('the state fields always, other fields when they change, never the identity or the stamped times', () => {
    expect(patchOf(s, { ...s, updatedAt: 9, contextPct: 50 })).toEqual({ set: { state: 'done', activity: null, unread: false }, stamp: ['updatedAt'] });
    expect(patchOf(s, { ...s, subagents: 1, lastMessageAt: 5 })).toEqual({ set: { state: 'done', activity: null, unread: false, subagents: 1 }, stamp: ['updatedAt', 'lastMessageAt'] });
    const { subagents: _gone, ...rest } = s;
    expect(patchOf(s, rest as SessionInfo).drop).toEqual(['subagents']);
  });
});
