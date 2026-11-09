import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { IpcMainInvokeEvent } from 'electron';
import { describe, expect, test, vi } from 'vitest';
import { IPC } from '@shared/api';
import { newThread } from '@shared/companion/thread';
import type { Binding, CompanionEvent } from '@shared/companion/types';
import type { TerminalInfo } from '@shared/protocol';
import type { SessionInfo } from '@shared/session';
import { DEFAULT_ACCOUNTS, type ClaudeAccounts } from '@shared/claude-accounts';
import { accountDirOf } from '../claude-accounts';
import { transcriptFile } from '../claude-history';
import { broadcastCompanion, installCompanionIpc, TERMINAL_UNAVAILABLE, transcriptExists, type CompanionIpcDeps, type CompanionIpcService } from './ipc';

// The Ask channels with a fake service and fake senders: who may call, what a binding may name, and that events reach
// every window. The project is a real folder (a cwd spelled through its real path is checked on disk); transcripts are
// faked by session id, except in transcriptExists' own test (a config dir under the run's temp root, never ~/.claude).

const SID = '0b5c8f0e-1111-4222-8333-944455556666';
const ENDED = '11111111-2222-4333-8444-555555555555';
const FOREIGN = '99999999-2222-4333-8444-555555555555';
const DEFAULT_DIR = '/Users/x/.claude';
const WORK = '/Users/x/.claude-work';
const ACCOUNTS: ClaudeAccounts = { ...DEFAULT_ACCOUNTS, list: [...DEFAULT_ACCOUNTS.list, { id: 'work', name: 'Work', dir: WORK, color: 2 }] };

type Handler = (e: IpcMainInvokeEvent, arg: unknown) => unknown;
// configDir: what the test's accountDir maps (as TerminalHub.accountDirOf does); the IPC's own terminal() never reads it.
type Term = Pick<TerminalInfo, 'projectRoot' | 'configDir' | 'session'> & { title?: string };

const live = (sessionId: string) => ({ sessionId, state: 'idle', title: null, activity: null, contextPct: null, unread: false, updatedAt: 0 }) as SessionInfo;

function setup(over: Partial<CompanionIpcDeps> = {}, terms: (project: string, other: string) => Record<string, Term> = (p, o) => ({
  t1: { projectRoot: p, session: live(SID) }, t2: { projectRoot: o, session: live(FOREIGN) }
})) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'atl-cipc-')));
  const project = join(base, 'acme');
  const other = join(base, 'other');
  mkdirSync(join(project, 'sub'), { recursive: true });
  mkdirSync(other);
  const handlers = new Map<string, Handler>();
  const thread = newThread(SID, '00000000-0000-4000-8000-000000000001', 1);
  const svc = {
    thread: vi.fn(() => thread),
    ask: vi.fn(() => ({ runId: 'r1' })),
    catchUp: vi.fn(() => ({ runId: 'r2' })),
    stop: vi.fn(),
    newThread: vi.fn(() => thread),
    seen: vi.fn()
  } satisfies CompanionIpcService;
  // Window 1: the project's window; 2: another project's; 3: the welcome window (no project); 4: a pop-out of the project.
  const projects = new Map<number, string | null>([[1, project], [2, other], [3, null], [4, project]]);
  const terminals = terms(project, other);
  // Sessions whose transcript is there (ended, or replaced by /clear in their terminal).
  const transcripts = new Set([ENDED]);
  const hasTranscript = vi.fn((o: { sessionId: string; cwd: string; configDir: string | null }) => transcripts.has(o.sessionId));
  installCompanionIpc(svc, {
    projectOf: (id) => projects.get(id) ?? null,
    isTrusted: (e) => (e.senderFrame?.url ?? '').startsWith('app://'),
    handle: (channel, fn) => { handlers.set(channel, fn); },
    // As TerminalHub.accountDirOf: the terminal's hook-reported dir through the configured accounts only.
    accountDir: (p, id) => accountDirOf(terminals[id]?.projectRoot === p ? terminals[id]?.configDir : undefined, ACCOUNTS, DEFAULT_DIR),
    terminal: (id) => terminals[id] ?? null,
    hasTranscript,
    ...over
  });
  const event = (wcId = 1, url = 'app://atelier/index.html') => ({ sender: { id: wcId }, senderFrame: { url } }) as unknown as IpcMainInvokeEvent;
  const call = (channel: string, arg: unknown, e = event()) => {
    const h = handlers.get(channel);
    if (!h) throw new Error(`no handler for ${channel}`);
    return h(e, arg);
  };
  const binding = (o: Partial<Binding> = {}): Binding => ({ terminalId: 't1', sessionId: SID, cwd: project, configDir: null, title: 'Fix the login', ...o });
  const asked = () => svc.ask.mock.calls.map((c) => (c as unknown as [Binding])[0]);
  return { svc, handlers, call, event, binding, project, other, base, thread, hasTranscript, asked };
}

describe('companion IPC: who may call', () => {
  test('every channel is installed', () => {
    const { handlers } = setup();
    expect([...handlers.keys()].sort()).toEqual([IPC.companionAsk, IPC.companionCatchUp, IPC.companionNew, IPC.companionSeen, IPC.companionStop, IPC.companionThread].sort());
  });

  test('an untrusted sender (not an app page) is refused on every channel, before its input is read', () => {
    const { svc, call, event, binding } = setup();
    const bad = event(1, 'https://example.com/');
    const args: [string, unknown][] = [
      [IPC.companionThread, { sessionId: SID }], [IPC.companionAsk, { binding: binding(), text: 'Is it done?' }],
      [IPC.companionCatchUp, { binding: binding(), final: false }], [IPC.companionStop, { sessionId: SID }],
      [IPC.companionNew, { sessionId: SID }], [IPC.companionSeen, { sessionId: SID }]
    ];
    for (const [channel, arg] of args) expect(() => call(channel, arg, bad), channel).toThrow(/unauthorized sender/);
    // Not even parsed: a malformed input from an untrusted sender gets the same refusal.
    expect(() => call(IPC.companionAsk, 'garbage', bad)).toThrow(/unauthorized sender/);
    for (const fn of Object.values(svc)) expect(fn).not.toHaveBeenCalled();
  });

  test('a window without a project (the welcome window) is refused', () => {
    const { svc, call, event } = setup();
    expect(() => call(IPC.companionThread, { sessionId: SID }, event(3))).toThrow(/unauthorized sender/);
    expect(svc.thread).not.toHaveBeenCalled();
  });

  test('malformed input is refused (strict schemas)', () => {
    const { svc, call, binding } = setup();
    expect(() => call(IPC.companionThread, { sessionId: 'nope' })).toThrow();
    expect(() => call(IPC.companionThread, SID)).toThrow();
    expect(() => call(IPC.companionAsk, { binding: binding(), text: '' })).toThrow();
    expect(() => call(IPC.companionAsk, { binding: binding(), text: 'x', model: 'gpt' })).toThrow();
    expect(() => call(IPC.companionAsk, { binding: { ...binding(), extra: 1 }, text: 'x' })).toThrow();
    expect(() => call(IPC.companionCatchUp, { binding: binding() })).toThrow();
    expect(svc.thread).not.toHaveBeenCalled();
    expect(svc.ask).not.toHaveBeenCalled();
    expect(svc.catchUp).not.toHaveBeenCalled();
  });
});

describe('companion IPC: what a binding may name', () => {
  test("another project's terminal is refused as such; one atelierd doesn't list (now) says it isn't available", () => {
    const { svc, call, binding } = setup();
    expect(() => call(IPC.companionAsk, { binding: binding({ terminalId: 't2', sessionId: FOREIGN }), text: 'Is it done?' })).toThrow(/another project/);
    expect(() => call(IPC.companionCatchUp, { binding: binding({ terminalId: 'gone' }), final: true })).toThrow(TERMINAL_UNAVAILABLE);
    expect(() => call(IPC.companionAsk, { binding: binding({ terminalId: 'gone' }), text: 'Is it done?' })).toThrow(TERMINAL_UNAVAILABLE);
    expect(svc.ask).not.toHaveBeenCalled();
    expect(svc.catchUp).not.toHaveBeenCalled();
  });

  test("a cwd outside the sender's project is refused; the project itself, a folder below it and its real spelling pass", () => {
    const { svc, call, binding, project, other, base } = setup();
    expect(() => call(IPC.companionAsk, { binding: binding({ cwd: other }), text: 'Is it done?' })).toThrow(/outside the project/);
    expect(() => call(IPC.companionAsk, { binding: binding({ cwd: `${project}-evil` }), text: 'Is it done?' })).toThrow(/outside the project/);
    expect(() => call(IPC.companionAsk, { binding: binding({ cwd: '/etc' }), text: 'Is it done?' })).toThrow(/outside the project/);
    expect(svc.ask).not.toHaveBeenCalled();
    call(IPC.companionAsk, { binding: binding(), text: 'a' });
    call(IPC.companionAsk, { binding: binding({ cwd: join(project, 'sub') }), text: 'b' });
    expect(svc.ask).toHaveBeenCalledTimes(2);

    // A project opened through a link: Claude reports its real folder.
    const link = join(base, 'link');
    symlinkSync(project, link);
    const s2 = setup({ projectOf: () => link, terminal: () => ({ projectRoot: link, session: live(SID) }) });
    s2.call(IPC.companionAsk, { binding: s2.binding({ cwd: join(project, 'sub') }), text: 'c' });
    expect(s2.svc.ask).toHaveBeenCalledTimes(1);
  });

  test("the config dir: the terminal's through the configured accounts only (as ✦), never hook data alone nor the renderer's", () => {
    const run = (configDir: string | undefined, sent: string | null) => {
      const s = setup({}, (p) => ({ t1: { projectRoot: p, session: live(SID), ...(configDir !== undefined ? { configDir } : {}) } }));
      s.call(IPC.companionAsk, { binding: s.binding({ configDir: sent }), text: 'Is it done?' });
      s.call(IPC.companionCatchUp, { binding: s.binding({ configDir: sent }), final: false });
      const viaCatchUp = (s.svc.catchUp.mock.calls[0] as unknown as [Binding])[0].configDir;
      expect(viaCatchUp).toBe(s.asked()[0]!.configDir);
      return s.asked()[0]!.configDir;
    };
    // A configured account other than the default: its launch dir (the run's CLAUDE_CONFIG_DIR, its transcript's root).
    expect(run(WORK, null)).toBe(WORK);
    expect(run(WORK, '/Users/x/.ssh')).toBe(WORK);
    // Anything else is the default account (null: no CLAUDE_CONFIG_DIR, the default projects root): its own dir, a
    // removed account's, a dir only hook data names, none. Whatever the renderer sends changes nothing.
    expect(run(DEFAULT_DIR, WORK)).toBeNull();
    expect(run('/Users/x/.claude-removed', null)).toBeNull();
    expect(run('/Users/x/.claude-removed', '/Users/x/.claude-removed')).toBeNull();
    expect(run('/etc', WORK)).toBeNull();
    expect(run(undefined, WORK)).toBeNull();
  });

  test("the session: the terminal's current one, or one whose transcript is there under that cwd; any other is refused", () => {
    const { svc, call, binding, hasTranscript, project } = setup({}, (p) => ({
      t1: { projectRoot: p, session: live(SID), configDir: WORK },
      ended: { projectRoot: p, session: null, configDir: DEFAULT_DIR },
      forged: { projectRoot: p, session: null, configDir: '/Users/x/.forged' }
    }));
    // The current session: no transcript needed.
    call(IPC.companionAsk, { binding: binding(), text: 'a' });
    expect(hasTranscript).not.toHaveBeenCalled();
    // /clear replaced it, or Claude exited: its transcript (with main's config dir, the binding's cwd) vouches for it.
    call(IPC.companionAsk, { binding: binding({ sessionId: ENDED }), text: 'b' });
    call(IPC.companionCatchUp, { binding: binding({ terminalId: 'ended', sessionId: ENDED, configDir: '/Users/x/.ssh' }), final: true });
    // A dir only hook data names is never looked in: the default projects root is.
    call(IPC.companionCatchUp, { binding: binding({ terminalId: 'forged', sessionId: ENDED, configDir: '/Users/x/.forged' }), final: true });
    expect(hasTranscript).toHaveBeenNthCalledWith(1, expect.objectContaining({ sessionId: ENDED, cwd: project, configDir: WORK }), project);
    expect(hasTranscript).toHaveBeenNthCalledWith(2, expect.objectContaining({ sessionId: ENDED, cwd: project, configDir: null }), project);
    expect(hasTranscript).toHaveBeenNthCalledWith(3, expect.objectContaining({ sessionId: ENDED, cwd: project, configDir: null }), project);
    expect((svc.catchUp.mock.calls[1] as unknown as [Binding])[0].configDir).toBeNull();
    expect(svc.ask).toHaveBeenCalledTimes(2);
    expect(svc.catchUp).toHaveBeenCalledTimes(2);
    // Another session's id, with no transcript here: refused, whether the terminal runs a session or not.
    expect(() => call(IPC.companionAsk, { binding: binding({ sessionId: FOREIGN }), text: 'c' })).toThrow(/session of another terminal/);
    expect(() => call(IPC.companionCatchUp, { binding: binding({ terminalId: 'ended', sessionId: FOREIGN }), final: true })).toThrow(/session of another terminal/);
    expect(svc.ask).toHaveBeenCalledTimes(2);
    expect(svc.catchUp).toHaveBeenCalledTimes(2);
  });
});

describe('companion IPC: the title rules.md and facts.md name', () => {
  test("main's own for the live session (the page's may lag behind a rename); the binding's once that session ended", () => {
    const { call, binding, asked, svc } = setup({}, (p) => ({
      t1: { projectRoot: p, session: live(SID), title: 'auth-refactor' },
      ended: { projectRoot: p, session: null, title: 'zsh' }
    }));
    call(IPC.companionAsk, { binding: binding({ title: 'Forged name' }), text: 'a' });
    expect(asked()[0]!.title).toBe('auth-refactor');
    call(IPC.companionCatchUp, { binding: binding({ title: 'Forged name' }), final: false });
    expect((svc.catchUp.mock.calls[0] as unknown as [Binding])[0].title).toBe('auth-refactor');
    // Claude exited (or /clear replaced it): the terminal's title is another program's now.
    call(IPC.companionAsk, { binding: binding({ terminalId: 'ended', sessionId: ENDED, title: 'Fix the login' }), text: 'b' });
    expect(asked()[1]!.title).toBe('Fix the login');
    call(IPC.companionAsk, { binding: binding({ sessionId: ENDED, title: 'Old chat' }), text: 'c' });
    expect(asked()[2]!.title).toBe('Old chat');
  });
});

describe('transcriptExists', () => {
  test('a regular file at the transcript path; none, a folder or a link there: no', () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'atl-cipc-tx-')));
    const configDir = join(base, 'claude');
    const cwd = join(base, 'acme');
    const at = (sessionId: string) => transcriptFile({ sessionId, cwd, configDir })!;
    mkdirSync(dirname(at(SID)), { recursive: true });
    writeFileSync(at(SID), '{}\n');
    mkdirSync(at(ENDED));
    symlinkSync(at(SID), at(FOREIGN));
    expect(transcriptExists({ sessionId: SID, cwd, configDir }, cwd)).toBe(true);
    expect(transcriptExists({ sessionId: ENDED, cwd, configDir }, cwd)).toBe(false);
    expect(transcriptExists({ sessionId: FOREIGN, cwd, configDir }, cwd)).toBe(false);
    expect(transcriptExists({ sessionId: '22222222-2222-4333-8444-555555555555', cwd, configDir }, cwd)).toBe(false);
    expect(transcriptExists({ sessionId: SID, cwd: join(base, 'other'), configDir }, join(base, 'other'))).toBe(false);
    expect(transcriptExists({ sessionId: 'not-a-uuid', cwd, configDir }, cwd)).toBe(false);
  });

  test('an ended session that entered a worktree of the project: its transcript moved there counts', () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'atl-cipc-tx-')));
    const configDir = join(base, 'claude');
    const cwd = join(base, 'acme');
    const moved = transcriptFile({ sessionId: ENDED, cwd: join(cwd, '.claude', 'worktrees', 'wt'), configDir })!;
    mkdirSync(dirname(moved), { recursive: true });
    writeFileSync(moved, '{}\n');
    expect(transcriptExists({ sessionId: ENDED, cwd, configDir }, cwd)).toBe(true);
    // Another project's folder never answers for this one.
    expect(transcriptExists({ sessionId: ENDED, cwd: join(base, 'other'), configDir }, join(base, 'other'))).toBe(false);
  });
});

describe('companion IPC: valid calls reach the service', () => {
  test('ask: the binding and the question, model and account only when given', async () => {
    const { svc, call, binding } = setup();
    expect(await call(IPC.companionAsk, { binding: binding(), text: 'Is it done?' })).toEqual({ runId: 'r1' });
    expect(svc.ask).toHaveBeenLastCalledWith(binding(), { text: 'Is it done?' });
    call(IPC.companionAsk, { binding: binding(), text: 'Why?', model: 'opus', account: 'work' });
    expect(svc.ask).toHaveBeenLastCalledWith(binding(), { text: 'Why?', model: 'opus', account: 'work' });
  });

  test("catch-up: the binding and final, the thread's model and account only when given", async () => {
    const { svc, call, binding } = setup();
    call(IPC.companionCatchUp, { binding: binding(), final: false, model: 'haiku', account: 'work' });
    expect(svc.catchUp).toHaveBeenLastCalledWith(binding(), { final: false, model: 'haiku', account: 'work' });
    call(IPC.companionCatchUp, { binding: binding(), final: false, account: 'session' });
    expect(svc.catchUp).toHaveBeenLastCalledWith(binding(), { final: false, account: 'session' });
  });

  test('catch-up, thread, stop, new thread and seen', async () => {
    const { svc, call, binding, thread } = setup();
    expect(await call(IPC.companionCatchUp, { binding: binding(), final: true })).toEqual({ runId: 'r2' });
    expect(svc.catchUp).toHaveBeenCalledWith(binding(), { final: true });
    expect(await call(IPC.companionThread, { sessionId: SID })).toBe(thread);
    expect(svc.thread).toHaveBeenCalledWith(SID);
    call(IPC.companionStop, { sessionId: SID });
    expect(svc.stop).toHaveBeenCalledWith(SID);
    expect(await call(IPC.companionNew, { sessionId: SID })).toBe(thread);
    expect(svc.newThread).toHaveBeenCalledWith(SID);
    call(IPC.companionSeen, { sessionId: SID });
    expect(svc.seen).toHaveBeenCalledWith(SID);
  });

  test("another project's window can't name this project's terminal; this project's other windows (a pop-out) can", () => {
    const { svc, call, event, binding } = setup();
    expect(() => call(IPC.companionAsk, { binding: binding(), text: 'a' }, event(2))).toThrow(/another project/);
    expect(svc.ask).not.toHaveBeenCalled();
    call(IPC.companionAsk, { binding: binding(), text: 'a' }, event(4));
    expect(svc.ask).toHaveBeenCalledTimes(1);
  });
});

describe('companion events', () => {
  const ev: CompanionEvent = { sessionId: SID, kind: 'delta', runId: 'r1', text: 'Yes' };
  const win = (o: { destroyed?: boolean; throws?: boolean } = {}) => {
    const got: unknown[][] = [];
    return {
      got,
      send: (channel: string, payload: unknown) => { if (o.throws) throw new Error('gone'); got.push([channel, payload]); },
      isDestroyed: () => !!o.destroyed
    };
  };

  test('every window gets every event; a destroyed one is skipped, one that throws stops neither the others nor the caller', () => {
    const a = win(); const gone = win({ destroyed: true }); const broken = win({ throws: true }); const b = win();
    const emit = broadcastCompanion(() => [a, gone, broken, b]);
    expect(() => emit(ev)).not.toThrow();
    expect(a.got).toEqual([[IPC.evCompanion, ev]]);
    expect(b.got).toEqual([[IPC.evCompanion, ev]]);
    expect(gone.got).toEqual([]);
  });

  test('no windows, or a window list that fails: nothing sent, nothing thrown', () => {
    expect(() => broadcastCompanion(() => [])(ev)).not.toThrow();
    expect(() => broadcastCompanion(() => { throw new Error('quitting'); })(ev)).not.toThrow();
  });
});
