import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { TerminalInfo } from '../../shared/protocol';
import { jobPrompt, type JobInfo } from '../../shared/redis-queues';
import { crashPrompt, logsPrompt } from '../../renderer/docker/view';
import { compileWorld } from '../compile/index';
import type { BeatStep, CompiledBeat } from './beats-types';
import { applyCost, applyPatch, applyWrite, beatForPrompt, fill, play, sliceVisible, type BeatHost } from './beats';
import { createClock } from './clock';

// The beats' player and its helpers: compiled patches stamped on a terminal as plain copies, edits
// applied to whatever the file is now, text streamed on the engine's clock, and "send to session" texts recognised.

const world = compileWorld();
const term = world.sessions.find((s) => s.scenario === 'onboarding-copy')!.terminal;

describe('applyPatch', () => {
  test('sets the fields, drops, stamps the times with now, attaches the work and recent items', () => {
    const t = applyPatch(term, { set: { state: 'running', activity: 'read x' }, drop: ['permissionMode'], stamp: ['updatedAt', 'lastMessageAt'], work: null, recent: [] }, 42);
    expect(t.session).toMatchObject({ state: 'running', activity: 'read x', updatedAt: 42, lastMessageAt: 42, sessionId: term.session!.sessionId });
    expect(t.session).not.toHaveProperty('permissionMode');
    expect(t).not.toHaveProperty('work');
    expect(t.recent).toEqual([]);
    expect(term.session!.state).toBe('done'); // a copy
  });

  test('a terminal without a session is left alone', () => {
    const shell = { ...term, session: null } as TerminalInfo;
    expect(applyPatch(shell, { set: { state: 'running' }, stamp: ['updatedAt'] }, 1)).toBe(shell);
  });
});

test('applyCost: totals grow, the context is capped at 100 %', () => {
  const t = applyCost(term, { usd: 0.05, added: 3, removed: 1, context: 90 });
  expect(t.session!.cost).toEqual({ usd: 0.46, linesAdded: 6, linesRemoved: 3 });
  expect(t.session!.contextPct).toBe(100);
});

describe('applyWrite', () => {
  test('replaces in the file as it is now, appends once, creates a missing file from its content', () => {
    expect(applyWrite('a - b', { file: 'x', replace: [['- b', '+ b']] }, {})).toBe('a + b');
    expect(applyWrite('a', { file: 'x', append: '\nend\n' }, {})).toBe('a\nend\n');
    expect(applyWrite('a\nend\n', { file: 'x', append: '\nend\n' }, {})).toBeNull();
    expect(applyWrite(undefined, { file: 'x', content: 'new {answer}\n' }, { answer: 'paid' })).toBe('new paid\n');
  });

  test('changes nothing when the text it edits is gone (the visitor rewrote it)', () => {
    expect(applyWrite('rewritten', { file: 'x', replace: [['- b', '+ b']] }, {})).toBeNull();
    expect(applyWrite(undefined, { file: 'x', replace: [['a', 'b']] }, {})).toBeNull();
  });
});

test('fill and sliceVisible', () => {
  expect(fill('Noted: “{answer}” for {who}', { answer: 'refunded' })).toBe('Noted: “refunded” for {who}');
  const line = '\u001b[1m●\u001b[0m Hello world';
  expect(sliceVisible(line, 4)).toBe('\u001b[1m●\u001b[0m He\u001b[0m');
  expect(sliceVisible(line, 99)).toBe(line);
});

describe('beatForPrompt: "send to session" from Docker and Redis', () => {
  const beats = world.beats;
  const worker = world.docker.snapshot.containers.find((c) => c.name === 'worker')!;
  const crashed = { ...worker, state: 'exited' as const, exitCode: 1, restarts: 3 };
  const detail = world.docker.details[worker.id]!;
  const crashLines = ['info: connecting to redis at 127.0.0.1:6379', 'Error: connect ECONNREFUSED 127.0.0.1:6379', '    at TCPConnectWrap.afterConnect [as oncomplete] (node:net:1607:16)'];
  const job: JobInfo = {
    id: '8812', name: 'send-receipt', reason: 'connect ECONNREFUSED 127.0.0.1:1025', attempts: 3, maxAttempts: 3, at: 1, queuedAt: 1, processedOn: 1, finishedOn: 1,
    stacks: [['Error: connect ECONNREFUSED 127.0.0.1:1025', '    at sendReceipt (/app/src/jobs/send-receipt.ts:31:9)', '    at Worker.processJob (/app/node_modules/bullmq/dist/cjs/classes/worker.js:802:22)']]
  } as JobInfo;

  test("the worker's crash, from Ask Claude Why It Crashed or from its log lines", () => {
    expect(beatForPrompt(crashPrompt(crashed, detail, crashLines, 'worker:\n  environment:\n    REDIS_URL: redis://127.0.0.1:6379'), beats, 0)).toBe('diagnose-worker');
    expect(beatForPrompt(logsPrompt(crashed, crashLines), beats, 0)).toBe('diagnose-worker');
    expect(beatForPrompt('why does the worker keep exiting?', beats, 0)).toBe('diagnose-worker');
  });

  test('a failed BullMQ job, one or several', () => {
    const ctx = { lib: 'bullmq' as const, queue: 'email-queue', instance: 'Docker · redis' };
    expect(beatForPrompt(jobPrompt(ctx, job), beats, 0)).toBe('diagnose-job');
    expect(beatForPrompt('the send-receipt jobs fail', beats, 0)).toBe('diagnose-job');
  });

  test('anything else: the free-prompt beats in turn', () => {
    expect(['add dark mode', 'hello', 'refactor', 'again'].map((t, i) => beatForPrompt(t, beats, i))).toEqual(['generic-tokens', 'generic-invoice', 'generic-readme', 'generic-tokens']);
    // The api's own errors are not the worker's.
    expect(beatForPrompt(logsPrompt(world.docker.snapshot.containers.find((c) => c.name === 'api')!, ['Error: mail send failed: connect ECONNREFUSED mailpit:1025']), beats, 1)).toBe('generic-invoice');
  });
});

describe('play', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  const host = () => {
    const log: string[] = [];
    const lines: string[] = [];
    const h: BeatHost = {
      clock: createClock(),
      line(text, replace) { if (replace) lines[lines.length - 1] = text; else lines.push(text); },
      spinner: (t) => log.push(`spinner ${t}`),
      prompt: () => log.push('prompt'),
      ask: (a) => log.push(`ask ${a.kind}`),
      session: (p) => log.push(`session ${p.set.state}`),
      cost: () => log.push('cost'),
      write: (w) => log.push(`write ${w.file}`),
      redraw: () => {}
    };
    return { h, log, lines };
  };
  const beat = (steps: BeatStep[]): CompiledBeat => ({ start: 'a', segments: { a: steps } });

  test('steps in order on the clock; text streams a chunk per frame; `until` counts from the start', () => {
    const { h, log, lines } = host();
    const long = 'x'.repeat(100);
    play(h, beat([
      { k: 'spinner', text: 'Thinking…' }, { k: 'session', patch: { set: { state: 'running' }, stamp: ['updatedAt'] } },
      { k: 'say', lines: ['', long] }, { k: 'until', ms: 1000 }, { k: 'write', write: { file: 'f' } },
      { k: 'out', lines: ['o1', 'o2'], every: 100 }, { k: 'prompt' }
    ]), 'a', {});
    expect(log).toEqual(['spinner Thinking…', 'session running']);
    expect(lines).toEqual(['', `${'x'.repeat(40)}\u001b[0m`]);
    vi.advanceTimersByTime(40);
    expect(lines[1]).toBe(`${'x'.repeat(80)}\u001b[0m`);
    vi.advanceTimersByTime(40);
    expect(lines[1]).toBe(long);
    vi.advanceTimersByTime(999 - 80);
    expect(log).not.toContain('write f');
    vi.advanceTimersByTime(1);
    expect(log).toContain('write f');
    expect(lines.slice(2)).toEqual(['o1']);
    vi.advanceTimersByTime(200);
    expect(lines.slice(2)).toEqual(['o1', 'o2']);
    expect(log.at(-1)).toBe('prompt');
  });

  test('an ask stops the segment; cancel stops a beat in the middle', () => {
    const { h, log } = host();
    play(h, beat([{ k: 'ask', ask: { kind: 'permission', command: 'x', routes: ['b'], cancel: 'b' } }, { k: 'prompt' }]), 'a', {});
    expect(log).toEqual(['ask permission']);
    const second = host();
    const p = play(second.h, beat([{ k: 'wait', ms: 100 }, { k: 'prompt' }]), 'a', {});
    p.cancel();
    vi.advanceTimersByTime(500);
    expect(second.log).toEqual([]);
  });
});
