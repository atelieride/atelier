import { describe, expect, test } from 'vitest';
import { CHECKLIST, actionFor, checklistContext, initialChecklist, reduceChecklist, segments, type ActionScreen, type ChecklistContext, type ChecklistSignal, type ChecklistState } from './checklist';

const ctx: ChecklistContext = {
  waiting: new Set(['t-auth']),
  stopped: new Set(['c-worker']),
  changed: new Set(['/p/src/auth.ts']),
  worker: 'c-worker',
  failedQueue: 'bullmq|bull|email-queue'
};
const run = (signals: ChecklistSignal[], s: ChecklistState = initialChecklist(ctx)) => signals.reduce((acc, sig) => reduceChecklist(acc, sig, ctx), s);
const ids = (s: ChecklistState) => [...s.done].sort();
const term = (id: string, state: string | null) => ({ id, session: state ? { state } : null });

describe('the checklist items', () => {
  test('thirteen, as the specs list them, with their keycaps', () => {
    expect(CHECKLIST.map((i) => i.id)).toEqual(['jump', 'approve', 'changes', 'ask', 'commit', 'search', 'split', 'workspaces', 'docker', 'redis', 'databases', 'background', 'json']);
    // Databases: right after Redis.
    expect(segments(CHECKLIST[10]!.text)).toEqual([
      { kind: 'text', text: 'Databases (' }, { kind: 'kbd', text: '⌃⇧B' }, { kind: 'text', text: '): open a JSON payload as a tree' }
    ]);
    // Workspaces: after the split, a way to keep fronts apart.
    expect(segments(CHECKLIST[7]!.text)).toEqual([{ kind: 'text', text: 'Turn on workspaces (View), then switch to ' }, { kind: 'code', text: 'Billing' }]);
    // Ask: right after "See what it changed".
    expect(segments(CHECKLIST[3]!.text)).toEqual([{ kind: 'kbd', text: '⌘I' }, { kind: 'text', text: ': ask a session where it is' }]);
    expect(segments(CHECKLIST[12]!.text)).toEqual([
      { kind: 'text', text: 'Open ' }, { kind: 'code', text: 'package.json' }, { kind: 'text', text: ' as a tree (' }, { kind: 'kbd', text: '⇧⌘V' }, { kind: 'text', text: ')' }
    ]);
    expect(segments(CHECKLIST[0]!.text)).toEqual([{ kind: 'kbd', text: '⌘J' }, { kind: 'text', text: ': jump to the session waiting for you' }]);
    expect(segments(CHECKLIST[4]!.text)).toEqual([{ kind: 'kbd', text: '⌥⌘K' }, { kind: 'text', text: ': stage a file, ✦ writes its commit' }]);
    expect(segments(CHECKLIST[8]!.text)).toEqual([
      { kind: 'text', text: 'Docker (' }, { kind: 'kbd', text: '⌃⇧D' }, { kind: 'text', text: '): see why ' }, { kind: 'code', text: 'worker' }, { kind: 'text', text: ' stopped' }
    ]);
    expect(CHECKLIST[9]!.text).toBe('Redis ({⌃⇧R}): ask Claude why a job failed');
    expect(segments(CHECKLIST[6]!.text)[0]).toEqual({ kind: 'kbd', text: '⌘\\' });
  });
});

describe('reduceChecklist', () => {
  // The page tells main (here: the bridge) its workspaces as the menu needs them: on, with the first in front, is not
  // it yet; another one brought forward (its name in the sidebar, ⌘⌥2, Go, #) is.
  test('workspaces: switching to another one ticks it; turning them on alone does not', () => {
    const menu = (active: number | null) => ({ kind: 'call', name: 'menuState', args: [{ gitUndo: false, hasRepos: true, gitWrites: true, messages: true, ...(active === null ? {} : { workspaces: { names: ['Auth & sessions', 'Billing'], active } }) }] }) as ChecklistSignal;
    expect(ids(run([menu(null), menu(0)]))).toEqual([]);
    expect(ids(run([menu(0), menu(1)]))).toEqual(['workspaces']);
  });

  test('commands the visitor sends tick their item', () => {
    expect(ids(run([{ kind: 'command', command: 'next-attention' }]))).toEqual(['jump']);
    expect(ids(run([{ kind: 'command', command: 'open-palette' }, { kind: 'command', command: 'split-right' }]))).toEqual(['search', 'split']);
    expect(ids(run([{ kind: 'command', command: 'toggle-changes' }]))).toEqual(['changes']);
    // Opening Docker is not seeing why the worker stopped (below).
    expect(ids(run([{ kind: 'command', command: 'view-docker' }]))).toEqual([]);
    expect(ids(run([{ kind: 'command', command: 'show-background' }]))).toEqual(['background']);
    expect(ids(run([{ kind: 'command', command: 'view-sessions' }]))).toEqual([]);
  });

  test('approve: a session that was waiting starts working again', () => {
    expect(ids(run([{ kind: 'terminals', list: [term('t-auth', 'waiting')] }]))).toEqual([]);
    expect(ids(run([{ kind: 'terminals', list: [term('t-auth', 'running')] }]))).toEqual(['approve']);
    // Another session running proves nothing; one that started waiting later and then runs does.
    expect(ids(run([{ kind: 'terminals', list: [term('t-other', 'running')] }]))).toEqual([]);
    expect(ids(run([{ kind: 'terminals', list: [term('t-other', 'waiting')] }, { kind: 'terminals', list: [term('t-other', 'running')] }]))).toEqual(['approve']);
  });

  test('changes: a changed file opened with its diff counts, any other file does not', () => {
    expect(ids(run([{ kind: 'call', name: 'git.head', args: ['/p/README.md'] }]))).toEqual([]);
    expect(ids(run([{ kind: 'call', name: 'git.head', args: ['/p/src/auth.ts'] }]))).toEqual(['changes']);
    expect(ids(run([{ kind: 'command', command: 'review-session' }]))).toEqual(['changes']);
  });

  test('commit: ✦ writing a message (the drawer, ⌥⌘M, the menu); opening the drawer or staging is not it yet', () => {
    expect(ids(run([{ kind: 'command', command: 'git-commit' }]))).toEqual([]);
    expect(ids(run([{ kind: 'call', name: 'git.stage', args: ['/p', ['src/auth.ts']] }]))).toEqual([]);
    expect(ids(run([{ kind: 'call', name: 'git.message', args: [{ root: '/p' }] }]))).toEqual(['commit']);
  });

  test('docker: looking into the container that stopped', () => {
    expect(ids(run([{ kind: 'call', name: 'docker.logs', args: ['c-api'] }]))).toEqual([]);
    expect(ids(run([{ kind: 'call', name: 'docker.inspect', args: ['c-worker'] }]))).toEqual(['docker']);
    expect(ids(run([{ kind: 'call', name: 'docker.watchLogs', args: [['c-api', 'c-worker']] }]))).toEqual(['docker']);
  });

  test('docker: the worker that runs at startup counts once it has stopped, as the containers say', () => {
    const live = { ...ctx, stopped: new Set<string>() };
    const look: ChecklistSignal = { kind: 'call', name: 'docker.inspect', args: ['c-worker'] };
    const go = (signals: ChecklistSignal[]) => [...signals.reduce((acc, sig) => reduceChecklist(acc, sig, live), initialChecklist(live)).done];
    expect(go([look])).toEqual([]);
    // Restarting is not stopped yet; exited 1 is.
    const containers = (state: string, exitCode: number | null): ChecklistSignal => ({ kind: 'containers', list: [{ id: 'c-api', state: 'running', exitCode: null }, { id: 'c-worker', state, exitCode }] });
    expect(go([containers('restarting', null), look])).toEqual([]);
    expect(go([containers('exited', 1), look])).toEqual(['docker']);
    // A clean exit is no failure to look into.
    expect(go([containers('exited', 0), look])).toEqual([]);
  });

  test("redis: the failed job's prompt sent to a session", () => {
    expect(ids(run([{ kind: 'call', name: 'terminals.input', args: ['t', 'ls\r'] }]))).toEqual([]);
    expect(ids(run([{ kind: 'call', name: 'terminals.input', args: ['t', '\x1b[200~A BullMQ job failed in queue "emails" on my local redis. Find why'] }]))).toEqual(['redis']);
    expect(ids(run([{ kind: 'call', name: 'terminals.input', args: ['t', '3 failed jobs in BullMQ queue "emails" on my local redis.'] }]))).toEqual(['redis']);
  });

  test('ask: a Catch me up or a question asked of Ask (the pill, ⌘I, a chip, the menus); opening a thread alone is not it', () => {
    expect(ids(run([{ kind: 'call', name: 'companion.thread', args: ['s1'] }]))).toEqual([]);
    expect(ids(run([{ kind: 'call', name: 'companion.catchUp', args: [{ final: false }] }]))).toEqual(['ask']);
    expect(ids(run([{ kind: 'call', name: 'companion.ask', args: [{ text: "What's left?" }] }]))).toEqual(['ask']);
    expect(ids(run([{ kind: 'command', command: 'ask-session' }]))).toEqual([]);
  });

  test('databases: a JSON value open in the JSON view (seen on screen); opening the view or a table is not it yet', () => {
    expect(ids(run([{ kind: 'command', command: 'view-databases' }]))).toEqual([]);
    expect(ids(run([{ kind: 'call', name: 'databases.page', args: [{}] }]))).toEqual([]);
    expect(ids(run([{ kind: 'dom', what: 'db-json' }]))).toEqual(['databases']);
    // Not package.json's tree, and that one is not this.
    expect(ids(run([{ kind: 'dom', what: 'json-tree' }]))).toEqual(['json']);
  });

  test('the palette or a split seen on screen (opened by a click or F1) count too', () => {
    expect(ids(run([{ kind: 'dom', what: 'palette' }, { kind: 'dom', what: 'split' }]))).toEqual(['search', 'split']);
    expect(ids(run([{ kind: 'call', name: 'background.watch', args: ['t', 'b1'] }]))).toEqual(['background']);
  });

  test('a signal that changes nothing returns the same state (no re-render, no message)', () => {
    const s = run([{ kind: 'command', command: 'next-attention' }]);
    expect(reduceChecklist(s, { kind: 'command', command: 'next-attention' }, ctx)).toBe(s);
    expect(reduceChecklist(s, { kind: 'call', name: 'files.read', args: ['/p/x'] }, ctx)).toBe(s);
  });
});

describe('actionFor: every item shows what it means ("show me")', () => {
  const screen: ActionScreen = { split: false, changes: false, selectedWaiting: false, jsonTree: false, dbJson: false, workspaces: false };
  const s0 = initialChecklist(ctx);
  const at = (id: Parameters<typeof actionFor>[0], over: Partial<ActionScreen> = {}, s: ChecklistState = s0, c: ChecklistContext = ctx) => actionFor(id, s, c, { ...screen, ...over });

  test('jump, search, background: the command their shortcut sends', () => {
    expect(at('jump')).toEqual({ kind: 'command', command: 'next-attention' });
    expect(at('search')).toEqual({ kind: 'command', command: 'open-palette' });
    expect(at('background')).toEqual({ kind: 'command', command: 'show-background' });
  });

  test('answer: jumps to the session waiting, then says which key answers it; already in front, only the key', () => {
    expect(at('approve')).toEqual({ kind: 'command', command: 'next-attention', hint: expect.stringMatching(/Press 1/) });
    expect(at('approve', { selectedWaiting: true })).toEqual({ kind: 'hint', hint: expect.stringMatching(/Press 1/) });
    // Nobody waits: the jump says so itself (the app's "nothing needs you").
    const none = reduceChecklist(s0, { kind: 'terminals', list: [{ id: 't-auth', session: { state: 'idle' } }] }, ctx);
    expect(at('approve', {}, none)).toEqual({ kind: 'command', command: 'next-attention' });
  });

  test('changes: the panel (⌘⇧M) when it is closed; open already, the review of every change (never toggled shut)', () => {
    expect(at('changes')).toEqual({ kind: 'command', command: 'toggle-changes' });
    expect(at('changes', { changes: true })).toEqual({ kind: 'command', command: 'review-all' });
  });

  test('ask: Ask opened on a session at work (the demo view), and what to try there: its empty state (Catch me up when opened is off by default)', () => {
    expect(at('ask')).toEqual({ kind: 'view', view: 'demo:ask', hint: expect.stringMatching(/Press Catch me up, or try a suggested question/) });
  });

  test('commit: the drawer (⌥⌘K), and what to do there', () => {
    expect(at('commit')).toEqual({ kind: 'command', command: 'git-commit', hint: expect.stringMatching(/stage.*✦/i) });
  });

  test('json: package.json opens with its tree beside it (the demo view); a tree on screen already, nothing', () => {
    expect(at('json')).toEqual({ kind: 'view', view: 'demo:json' });
    expect(at('json', { jsonTree: true })).toBeNull();
    // A JSON tree on screen ticks it, whoever opened it (⇧⌘V, the switch, the item).
    expect(ids(reduceChecklist(s0, { kind: 'dom', what: 'json-tree' }, ctx))).toEqual(['json']);
  });

  test('databases: the view (⌃⇧B), and where the payloads are; a JSON view on screen already, nothing', () => {
    expect(at('databases')).toEqual({ kind: 'command', command: 'view-databases', hint: expect.stringMatching(/webhook_events.*payload/) });
    expect(at('databases', { dbJson: true })).toBeNull();
  });

  test('split: from one pane only (split-right adds a pane each time)', () => {
    expect(at('split')).toEqual({ kind: 'command', command: 'split-right' });
    expect(at('split', { split: true })).toBeNull();
  });

  test('docker: the stopped worker\'s "Why it stopped"; still running, it stops now, with a word to watch it', () => {
    const live = { ...ctx, stopped: new Set<string>() };
    expect(at('docker', {}, initialChecklist(live), live)).toEqual({ kind: 'docker', id: 'c-worker', crash: true, hint: expect.stringMatching(/worker/) });
    const stopped = reduceChecklist(initialChecklist(live), { kind: 'containers', list: [{ id: 'c-worker', state: 'exited', exitCode: 1 }] }, live);
    expect(at('docker', {}, stopped, live)).toEqual({ kind: 'docker', id: 'c-worker', crash: false });
    // A world without the crash: Docker itself.
    expect(at('docker', {}, s0, { ...ctx, worker: null })).toEqual({ kind: 'command', command: 'view-docker' });
  });

  test('redis: the failed jobs of the queue that has them, and the step that ticks it; none, Redis itself', () => {
    expect(at('redis')).toEqual({ kind: 'redis', queue: 'bullmq|bull|email-queue', hint: expect.stringMatching(/Ask Claude Why It Failed/) });
    expect(at('redis', {}, s0, { ...ctx, failedQueue: null })).toEqual({ kind: 'command', command: 'view-redis' });
  });

  test('workspaces: off, they turn on (as View\u2019s toggle), and what to do next; on, only that', () => {
    expect(at('workspaces')).toEqual({ kind: 'command', command: 'toggle-workspaces', hint: expect.stringMatching(/Billing/) });
    expect(at('workspaces', { workspaces: true })).toEqual({ kind: 'hint', hint: expect.stringMatching(/Billing/) });
  });

  test('every item has an action from a fresh start', () => {
    for (const item of CHECKLIST) expect(at(item.id), item.id).not.toBeNull();
  });
});

describe('checklistContext', () => {
  test('from the world: sessions waiting, containers that stopped with an error, files the sessions changed', () => {
    const c = checklistContext({
      project: { root: '/p' },
      head: { 'a.ts': 'x', 'b.ts': 'y' },
      files: { 'a.ts': 'x', 'b.ts': 'z', 'c.ts': 'new' },
      sessions: [{ terminal: { id: 't1', session: { state: 'waiting' } } }, { terminal: { id: 't2', session: { state: 'running' } } }],
      docker: {
        snapshot: { containers: [{ id: 'w', state: 'exited', exitCode: 1 }, { id: 'old', state: 'exited', exitCode: 0 }, { id: 'api', state: 'running', exitCode: null }] },
        crash: { container: { id: 'worker' } }
      },
      redis: { queues: { infos: [{ id: 'q-report', name: 'report-queue', counts: { failed: 0 } }, { id: 'q-email', name: 'email-queue', counts: { failed: 3 } }] } }
    });
    expect([...c.waiting]).toEqual(['t1']);
    expect([...c.stopped]).toEqual(['w']);
    expect([...c.changed].sort()).toEqual(['/p/b.ts', '/p/c.ts']);
    // The container the Docker beat stops, and the queue with failed jobs.
    expect(c.worker).toBe('worker');
    expect(c.failedQueue).toBe('q-email');
  });
});
