import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DoneTracker, FinishQueue, StateTracker, TurnClock, WORK_END_HOLD_MS, TriggerBanners, longFinishes, WaitingTracker, badgeText, centerEntries, groupNotes, newlyWaiting, notesFor, seenWhereViewed, settleFinishes, showBanner, waitingCount, type Finish } from './attention';
import { attachWork } from './work-hub';
import { WORK_CAP_MS, type WorkScan } from '@shared/background';
import type { BackgroundItem, SessionInfo } from '@shared/session';

// ---- "Finished" on the effective state ----
const bgItem = (id: string, since: number, kind: BackgroundItem['kind'] = 'shell'): BackgroundItem => ({ id, kind, label: id, ...(kind === 'agent' ? {} : { command: id }), since });
const bgTerm = (state: SessionInfo['state'], items: BackgroundItem[], extra: Partial<SessionInfo> = {}): TerminalInfo => ({
  id: 'a', projectRoot: '/p', cwd: '/p', title: 'a', name: null, color: '#fff', foreground: 'claude', createdAt: 0, pid: 100,
  session: { sessionId: 'a', state, title: null, activity: null, contextPct: null, unread: true, updatedAt: 0, background: { items, crons: [] }, ...extra }
});
/** What terminal-hub does on every recomputation: attach the work, then track. */
const finishes = (tr: DoneTracker, list: TerminalInfo[], now: number, scans: Record<string, WorkScan> = {}, count = true) =>
  tr.update(attachWork(list, scans, now, count).list, scans, now, count).map((x) => x.id);

test('intermediate turns while background work counts never finish; the final done without work finishes once', () => {
  const tr = new DoneTracker();
  const sh = bgItem('npm run e2e', 1000);
  expect(finishes(tr, [bgTerm('running', [])], 1000)).toEqual([]);
  expect(finishes(tr, [bgTerm('done', [sh])], 2000)).toEqual([]);
  // A <task-notification> turn, then its Stop with the shell still running.
  expect(finishes(tr, [bgTerm('running', [sh])], 3000)).toEqual([]);
  expect(finishes(tr, [bgTerm('done', [sh, bgItem('sub', 3000, 'agent')])], 4000)).toEqual([]);
  expect(finishes(tr, [bgTerm('done', [])], 5000)).toEqual(['a']);
  expect(finishes(tr, [bgTerm('done', [])], 6000)).toEqual([]);
  // Today's behavior for a turn without background work.
  expect(finishes(tr, [bgTerm('running', [])], 7000)).toEqual([]);
  expect(finishes(tr, [bgTerm('done', [])], 8000)).toEqual(['a']);
});

test('a cap expiry never finishes, even noticed on a recomputation for an unrelated session change', () => {
  const tr = new DoneTracker();
  const sh = bgItem('tail -f log', 0);
  expect(finishes(tr, [bgTerm('running', [sh])], 1000)).toEqual([]);
  expect(finishes(tr, [bgTerm('done', [sh])], 2000)).toEqual([]);
  expect(finishes(tr, [bgTerm('done', [sh])], WORK_CAP_MS + 1)).toEqual([]);
  // The next real turn finishes as usual.
  expect(finishes(tr, [bgTerm('running', [sh])], WORK_CAP_MS + 2000)).toEqual([]);
  expect(finishes(tr, [bgTerm('done', [sh])], WORK_CAP_MS + 3000)).toEqual(['a']);

  const tr2 = new DoneTracker();
  expect(finishes(tr2, [bgTerm('done', [sh])], 2000)).toEqual([]);
  expect(finishes(tr2, [bgTerm('done', [sh], { contextPct: 40, updatedAt: 9 })], WORK_CAP_MS + 5)).toEqual([]);
});

test('a subagent\'s 2-hour expiry never finishes: noticed by the app\'s timer or by atelierd dropping it', () => {
  const H = 60 * 60 * 1000;
  const sub: BackgroundItem = { ...bgItem('a1', 0, 'agent'), lastEvent: 0 };
  // Esc'd or lost: its SubagentStop never comes, the session sits in Working on it.
  const timer = new DoneTracker();
  expect(finishes(timer, [bgTerm('running', [sub], { subagents: 1 })], 1000)).toEqual([]);
  expect(finishes(timer, [bgTerm('done', [sub], { subagents: 1 })], 2000)).toEqual([]);
  expect(finishes(timer, [bgTerm('done', [sub], { subagents: 1 })], 2 * H + 1)).toEqual([]);
  // atelierd's sweep drops it (the app had not recomputed meanwhile): a baseline too.
  const sweep = new DoneTracker();
  expect(finishes(sweep, [bgTerm('done', [sub], { subagents: 1 })], 2000)).toEqual([]);
  expect(finishes(sweep, [bgTerm('done', [], { subagents: 0 })], 2 * H + 5000)).toEqual([]);
  // A subagent that really stops finishes as before.
  const real = new DoneTracker();
  expect(finishes(real, [bgTerm('done', [sub], { subagents: 1 })], 2000)).toEqual([]);
  expect(finishes(real, [bgTerm('done', [], { subagents: 0 })], 3000)).toEqual(['a']);
});

test('a done with a fresh unscanned server shell does not finish until the scan proves it a server, then once', () => {
  const tr = new DoneTracker();
  const dev = bgItem('npm run dev', 1000);
  expect(finishes(tr, [bgTerm('running', [dev])], 1000)).toEqual([]);
  expect(finishes(tr, [bgTerm('done', [dev])], 1500)).toEqual([]);
  const scan: WorkScan = { at: 2000, matched: { 'npm run dev': 120 }, servers: ['npm run dev'], gone: [] };
  expect(finishes(tr, [bgTerm('done', [dev])], 2000, { a: scan })).toEqual(['a']);
  expect(finishes(tr, [bgTerm('done', [dev])], 5000, { a: { ...scan, at: 5000 } })).toEqual([]);
});

test('a batch of finishes goes out only for sessions still done: a background subagent\'s last stop, the report turn, then the final Stop give one "Finished"', () => {
  // The captured sequence: the subagent stops for good with the main agent at rest (done, nothing counts: a finish),
  // the main agent is woken with its report (running), then its last Stop (done: a finish), all within the batch.
  const tr = new DoneTracker();
  const sub = bgItem('a1', 1000, 'agent');
  const at = (state: SessionInfo['state'], items: BackgroundItem[], now: number) => attachWork([bgTerm(state, items)], {}, now, true).list;
  const batch: Finish[] = [];
  const step = (list: TerminalInfo[], now: number) => { for (const term of tr.update(list, {}, now, true)) batch.push({ term, kind: 'done', at: now }); return list; };
  step(at('running', [], 500), 500);
  step(at('done', [sub], 1000), 1000);
  step(at('done', [], 2000), 2000);
  step(at('running', [], 2400), 2400);
  const last = step(at('done', [], 2800), 2800);
  expect(batch.map((f) => f.at)).toEqual([2000, 2800]);
  // When the batch goes out: one finish per session, the latest.
  expect(settleFinishes(batch, last).map((f) => [f.term.id, f.at])).toEqual([['a', 2800]]);
  // Back at work by then (the report turn still running, or work counting again): no finish yet, its own comes later.
  expect(settleFinishes(batch.slice(0, 1), at('running', [], 2400))).toEqual([]);
  expect(settleFinishes(batch.slice(0, 1), at('done', [bgItem('npm test', 2300)], 2400))).toEqual([]);
  // Errors, other sessions and closed terminals are untouched.
  const other = { ...bgTerm('done', []), id: 'b' };
  const err: Finish = { term: bgTerm('error', []), kind: 'error', at: 2900 };
  expect(settleFinishes([...batch, err, { term: other, kind: 'done', at: 2950 }], at('running', [], 3000)).map((f) => [f.term.id, f.kind])).toEqual([['a', 'error'], ['b', 'done']]);
});

test('a finish is kept when the session ends right after its final Stop (terminal still listed, session gone)', () => {
  const done: Finish = { term: bgTerm('done', []), kind: 'done', at: 1000 };
  const ended = { ...bgTerm('done', []), session: null };
  expect(settleFinishes([done], [ended])).toEqual([done]);
  // Still a session, working again: stale as before.
  expect(settleFinishes([done], [bgTerm('running', [])])).toEqual([]);
});

test('a shell whose process is gone ends the work: one finish; the setting turned off is a baseline', () => {
  const tr = new DoneTracker();
  const sh = bgItem('npm test', 1000);
  expect(finishes(tr, [bgTerm('done', [sh])], 1500, { a: { at: 1200, matched: { 'npm test': 130 }, servers: [], gone: [] } })).toEqual([]);
  expect(finishes(tr, [bgTerm('done', [sh])], 1600, { a: { at: 1200, matched: { 'npm test': 130 }, servers: [], gone: [] } })).toEqual([]);
  expect(finishes(tr, [bgTerm('done', [sh])], 4500, { a: { at: 4200, matched: {}, servers: [], gone: ['npm test'] } })).toEqual(['a']);

  const off = new DoneTracker();
  expect(finishes(off, [bgTerm('running', [sh])], 1000)).toEqual([]);
  expect(finishes(off, [bgTerm('done', [sh])], 2000)).toEqual([]);
  expect(finishes(off, [bgTerm('done', [sh])], 2100, {}, false)).toEqual([]);
  // With the setting off, "Finished" follows the main agent as before.
  expect(finishes(off, [bgTerm('running', [sh])], 3000, {}, false)).toEqual([]);
  expect(finishes(off, [bgTerm('done', [sh])], 4000, {}, false)).toEqual(['a']);
});

test('done tracker: the first list after a reset is a baseline', () => {
  const tr = new DoneTracker();
  expect(finishes(tr, [bgTerm('done', [])], 1000)).toEqual([]);
  tr.reset();
  expect(finishes(tr, [bgTerm('running', [])], 2000)).toEqual([]);
  expect(finishes(tr, [bgTerm('done', [])], 3000)).toEqual(['a']);
  tr.reset();
  expect(finishes(tr, [bgTerm('done', [])], 4000)).toEqual([]);
});

test('banners: with the test log (e2e) they are recorded there and never shown; otherwise shown', () => {
  const log = join(mkdtempSync(join(tmpdir(), 'atl-notify-')), 'n.log');
  let shown = 0;
  showBanner({ title: 'Trigger: x', body: 'a · line', silent: true }, log, () => { shown++; });
  showBanner({ title: 'T2', body: 'b', silent: false }, log, () => { shown++; });
  expect(shown).toBe(0);
  expect(readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l))).toEqual([{ title: 'Trigger: x', body: 'a · line', silent: true }, { title: 'T2', body: 'b', silent: false }]);
  showBanner({ title: 'T', body: 'b', silent: false }, undefined, () => { shown++; });
  expect(shown).toBe(1);
});
import { DEFAULT_SETTINGS, type Settings } from '@shared/settings';
import type { TriggerRule } from '@shared/triggers';
import type { TerminalInfo } from '@shared/protocol';
import { addNotes } from '@shared/notifications';
const t = (id: string, state: 'running' | 'waiting' | 'done' | null): TerminalInfo => ({ id, projectRoot: '/p', cwd: '/p', title: id, name: null, color: '#fff', foreground: 'claude', createdAt: 0, session: state ? { sessionId: id, state, title: null, activity: null, contextPct: null, unread: false, updatedAt: 0 } : null });
test('only those that enter waiting right now', () => {
  expect(newlyWaiting([t('a', 'running'), t('b', 'waiting')], [t('a', 'waiting'), t('b', 'waiting'), t('c', 'waiting')]).map((x) => x.id)).toEqual(['a', 'c']);
  expect(newlyWaiting([t('a', 'waiting')], [t('a', 'waiting')])).toEqual([]);
});
test('enter, leave, enter again → two notifications in total', () => {
  const steps = [[t('a', 'running')], [t('a', 'waiting')], [t('a', 'waiting')], [t('a', 'running')], [t('a', 'waiting')]];
  let n = 0;
  for (let i = 1; i < steps.length; i++) n += newlyWaiting(steps[i - 1]!, steps[i]!).length;
  expect(n).toBe(2);
});
test('Dock count: all windows', () => {
  expect(waitingCount([[t('a', 'waiting'), t('b', 'running')], [t('c', 'waiting')]])).toBe(2);
});
test('first list after each connection: baseline, no notification for those already waiting', () => {
  const w = new WaitingTracker();
  expect(w.update([t('a', 'waiting')])).toEqual([]);
  expect(w.update([t('a', 'waiting')])).toEqual([]);
  expect(w.update([t('a', 'waiting'), t('b', 'waiting')]).map((x) => x.id)).toEqual(['b']);
  w.reset();
  expect(w.update([t('a', 'waiting'), t('c', 'waiting')])).toEqual([]);
});
test('session end: notified only on the transition to done, never for those already finished', () => {
  const d = new StateTracker('done');
  expect(d.update([t('a', 'done'), t('b', 'running')])).toEqual([]);
  expect(d.update([t('a', 'done'), t('b', 'done')]).map((x) => x.id)).toEqual(['b']);
  expect(d.update([t('a', 'running'), t('b', 'done')])).toEqual([]);
  expect(d.update([t('a', 'done'), t('b', 'done')]).map((x) => x.id)).toEqual(['a']);
});
test('notifications according to settings', () => {
  const w = [t('a', 'waiting')]; const d = [t('b', 'done')];
  expect(notesFor(DEFAULT_SETTINGS, w, d).map((n) => [n.term.id, n.kind])).toEqual([['a', 'waiting']]);
  expect(notesFor({ ...DEFAULT_SETTINGS, notifyDone: true }, w, d).map((n) => n.kind)).toEqual(['waiting', 'done']);
  expect(notesFor({ ...DEFAULT_SETTINGS, notifyWaiting: false, notifyDone: true }, w, d).map((n) => n.kind)).toEqual(['done']);
  expect(notesFor(DEFAULT_SETTINGS, w, d)[0]!.silent).toBe(false);
  expect(notesFor({ ...DEFAULT_SETTINGS, notifySound: false }, w, d)[0]!.silent).toBe(true);
  expect(notesFor({ ...DEFAULT_SETTINGS, notifyDone: true }, [], d)[0]!.body).toBe('Finished');
});
test('Dock badge: off via settings or with nothing waiting', () => {
  expect(badgeText(DEFAULT_SETTINGS, 2)).toBe('2');
  expect(badgeText(DEFAULT_SETTINGS, 0)).toBe('');
  expect(badgeText({ ...DEFAULT_SETTINGS, dockBadge: false }, 3)).toBe('');
});
const failed = (id: string, reason: string): TerminalInfo => ({ ...t(id, null), session: { sessionId: id, state: 'error', title: null, activity: reason, contextPct: null, unread: true, updatedAt: 0 } });

test('a turn that ended in error (rate limit, API) notifies with the setting for finishes, as a stop with the reason', () => {
  const notes = notesFor({ ...DEFAULT_SETTINGS, notifyDone: true }, [], [], [failed('c', 'rate_limit')]);
  expect(notes.map((n) => [n.term.id, n.kind, n.body])).toEqual([['c', 'error', 'Stopped with an error · Rate limit']]);
  expect(notesFor(DEFAULT_SETTINGS, [], [], [failed('c', 'rate_limit')])).toEqual([]);
});

test('banner body: what the session waits for, without saying "waiting" twice', () => {
  const w = { ...t('w', 'waiting'), session: { ...t('w', 'waiting').session!, activity: 'waiting: Bash npm test' } };
  expect(notesFor(DEFAULT_SETTINGS, [w], [])[0]!.body).toBe('Waiting for you · Bash npm test');
  expect(notesFor(DEFAULT_SETTINGS, [{ ...w, session: { ...w.session, activity: 'waiting for you' } }], [])[0]!.body).toBe('Waiting for you');
});

test('three or more sessions finished together: a single notification with the names; waiting ones stay one by one', () => {
  const s = { ...DEFAULT_SETTINGS, notifyDone: true };
  const notes = groupNotes(notesFor(s, [t('w1', 'waiting')], [t('alfa', 'done'), t('beta', 'done'), t('gamma', 'done')]));
  expect(notes.map((n) => [n.kind, n.title ?? n.term.title, n.body])).toEqual([
    ['waiting', 'w1', 'Waiting for you'],
    ['done', '3 sessions finished', 'alfa, beta, gamma']
  ]);
  // Just two stay separate.
  expect(groupNotes(notesFor(s, [], [t('a', 'done'), t('b', 'done')]))).toHaveLength(2);
});

test('errors are never folded into "finished": grouped per kind, "N sessions stopped" with the reason when shared', () => {
  const s = { ...DEFAULT_SETTINGS, notifyDone: true };
  const view = (notes: ReturnType<typeof groupNotes>) => notes.map((n) => [n.kind, n.title ?? n.term.title, n.body]);
  // Two finished and one stopped: three separate banners, the stop says so.
  expect(view(groupNotes(notesFor(s, [], [t('a', 'done'), t('b', 'done')], [failed('c', 'rate_limit')])))).toEqual([
    ['done', 'a', 'Finished'], ['done', 'b', 'Finished'], ['error', 'c', 'Stopped with an error · Rate limit']
  ]);
  // Three stopped for the same reason, three finished: one banner each.
  expect(view(groupNotes(notesFor(s, [], [t('a', 'done'), t('b', 'done'), t('c', 'done')], [failed('x', 'rate_limit'), failed('y', 'rate_limit'), failed('z', 'rate_limit')])))).toEqual([
    ['done', '3 sessions finished', 'a, b, c'], ['error', '3 sessions stopped', 'Rate limit · x, y, z']
  ]);
  // Different reasons: just the names.
  expect(view(groupNotes(notesFor(s, [], [], [failed('x', 'rate_limit'), failed('y', 'server_error'), failed('z', 'rate_limit')])))).toEqual([
    ['error', '3 sessions stopped', 'x, y, z']
  ]);
});

// Notification center: entries for every window, whatever the OS-notification settings.
const ids = () => { let n = 0; return () => `id${++n}`; };
const inProject = (x: TerminalInfo, root: string, activity: string | null = null): TerminalInfo => ({ ...x, projectRoot: root, session: x.session ? { ...x.session, activity } : null });

test('center: one entry per session that starts waiting, with its activity at that moment', () => {
  const out = centerEntries([inProject(t('w', 'waiting'), '/p', 'waiting: Bash npm test')], [], 1000, ids());
  expect(out).toEqual([{ project: '/p', entry: { id: 'id1', at: 1000, kind: 'waiting', sessions: [{ id: 'w', title: 'w', color: '#fff' }], activity: 'waiting: Bash npm test', unseen: ['w'] } }]);
});

test('center: a session shown in a focused pop-out arrives seen (its window chimes for nothing, its entry is read)', () => {
  const out = centerEntries([inProject(t('w', 'waiting'), '/p'), inProject(t('v', 'waiting'), '/p'), inProject(t('x', 'waiting'), '/q')], [], 1000, ids());
  const seen = seenWhereViewed(out, (project, id) => project === '/p' && id === 'v');
  expect(seen.map((x) => [x.project, x.entry.unseen, x.entry.quiet])).toEqual([['/p', ['w'], undefined], ['/p', [], ['v']], ['/q', ['x'], undefined]]);
  // Nothing viewed: the same entries.
  expect(seenWhereViewed(out, () => false)).toEqual(out);
});

test('center: finishes of a batch, per project and per kind; three or more of a kind in a project become one entry', () => {
  const fin = [
    { term: t('a', 'done'), kind: 'done' as const, at: 1 }, { term: t('b', 'done'), kind: 'done' as const, at: 2 },
    { term: t('d', 'done'), kind: 'done' as const, at: 3 },
    { term: inProject(t('c', 'done'), '/p', 'rate_limit'), kind: 'error' as const, at: 4 },
    { term: inProject(t('q', 'done'), '/q'), kind: 'done' as const, at: 5 }
  ];
  const out = centerEntries([], fin, 9, ids());
  // The error is never folded into "3 sessions finished".
  expect(out.map((x) => [x.project, x.entry.kind, x.entry.sessions.map((s) => s.id), x.entry.unseen])).toEqual([
    ['/p', 'done', ['a', 'b', 'd'], ['a', 'b', 'd']],
    ['/p', 'error', ['c'], ['c']],
    ['/q', 'done', ['q'], ['q']]
  ]);
  // Two stay separate; an error keeps its kind and its reason.
  const two = centerEntries([], [fin[0]!, fin[3]!], 9, ids());
  expect(two.map((x) => [x.entry.kind, x.entry.activity])).toEqual([['done', null], ['error', 'rate_limit']]);
  // Three stopped together: one "error" entry, with the reason when they share it.
  const stop = (id: string, reason: string) => ({ term: inProject(t(id, 'done'), '/p', reason), kind: 'error' as const, at: 1 });
  const same = centerEntries([], [stop('x', 'rate_limit'), stop('y', 'rate_limit'), stop('z', 'rate_limit')], 9, ids());
  expect(same.map((x) => [x.entry.kind, x.entry.sessions.length, x.entry.activity])).toEqual([['error', 3, 'rate_limit']]);
  const mixed = centerEntries([], [stop('x', 'rate_limit'), stop('y', 'server_error'), stop('z', 'rate_limit')], 9, ids());
  expect(mixed.map((x) => [x.entry.kind, x.entry.sessions.length, x.entry.activity])).toEqual([['error', 3, null]]);
});

test('center: finish entries carry the time of the finish, not of the batch going out', () => {
  // A finished at 1000, B started waiting at 2000 (immediate entry), the batch went out at 3500.
  const waitingEntry = centerEntries([t('b', 'waiting')], [], 2000, ids())[0]!.entry;
  const fin = centerEntries([], [{ term: t('a', 'done'), kind: 'done', at: 1000 }], 3500, () => 'f1');
  expect(fin[0]!.entry.at).toBe(1000);
  expect(addNotes([waitingEntry], fin.map((x) => x.entry)).map((x) => x.id)).toEqual(['id1', 'f1']);
  // A group: the time of its last finish.
  const group = centerEntries([], ['a', 'b', 'c'].map((id, i) => ({ term: t(id, 'done'), kind: 'done' as const, at: 1000 + i })), 3500, ids());
  expect(group[0]!.entry.at).toBe(1002);
});

test('center: a session already seen by the time the batch is out is not unread', () => {
  const out = centerEntries([], [{ term: t('a', 'done'), kind: 'done', at: 5 }], 5, ids(), new Set(['a']));
  expect(out[0]!.entry.unseen).toEqual([]);
});

describe('finish queue', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(0); });
  afterEach(() => vi.useRealTimers());
  /** A queue over a live list (`list[id]` is each terminal's current state), recording what goes out and when. */
  const setup = () => {
    const list = new Map<string, TerminalInfo>();
    const out: [number, string[]][] = [];
    const q = new FinishQueue(() => [...list.values()], (items) => out.push([Date.now(), items.map((f) => `${f.term.id}@${f.at}${f.kind === 'error' ? '!' : ''}`)]));
    const state = (id: string, s: 'running' | 'done') => list.set(id, t(id, s));
    const finish = (id: string, extra: Partial<Finish> = {}) => { state(id, 'done'); q.push([{ term: t(id, 'done'), kind: 'done', at: Date.now(), ...extra }]); };
    return { q, out, state, finish };
  };

  test('finishes within the window go out together, once; the next ones start a new window', async () => {
    const { q, out, finish } = setup();
    q.push([]);
    expect(vi.getTimerCount()).toBe(0);
    finish('a'); finish('b'); finish('c');
    await vi.advanceTimersByTimeAsync(2499);
    expect(out).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(out).toEqual([[2500, ['a@0', 'b@0', 'c@0']]]);
    finish('d');
    await vi.advanceTimersByTimeAsync(2500);
    expect(out.at(-1)).toEqual([5000, ['d@2500']]);
  });

  test("another session's earlier finish doesn't shorten this one's window: its wake-up still makes it one finish", async () => {
    const { out, state, finish } = setup();
    finish('b');
    await vi.advanceTimersByTimeAsync(2400);
    // A finishes 100 ms before the batch was due, then Claude Code wakes its main agent with the report: the batch
    // waits for A's own window instead of taking its finish along.
    finish('a');
    await vi.advanceTimersByTimeAsync(100);
    expect(out).toEqual([]);
    await vi.advanceTimersByTimeAsync(500);
    state('a', 'running');
    await vi.advanceTimersByTimeAsync(1000);
    finish('a');
    await vi.advanceTimersByTimeAsync(20_000);
    // The batch waits for a (up to 5 s from its start), finds a@4000 still young then: it goes with the next one.
    expect(out).toEqual([[5000, ['b@0']], [7500, ['a@4000']]]);
  });

  test('sessions finishing a moment apart still group: the batch waits for its youngest "done" (errors ride along)', async () => {
    const { q, out, finish } = setup();
    finish('a'); finish('b');
    await vi.advanceTimersByTimeAsync(700);
    finish('c');
    await vi.advanceTimersByTimeAsync(2499);
    expect(out).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(out).toEqual([[3200, ['a@0', 'b@0', 'c@700']]]);
    // Later ones, an error among them, in the next batch together.
    finish('d');
    await vi.advanceTimersByTimeAsync(2300);
    q.push([{ term: t('e', 'done'), kind: 'error', at: Date.now() }]);
    finish('f');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(out.at(-1)).toEqual([8000, ['d@3200', 'e@5500!', 'f@5500']]);
  });

  test('a batch waits for its young finishes at most 5 s from its start; those still young then move to the next one', async () => {
    const { out, finish } = setup();
    finish('a');
    await vi.advanceTimersByTimeAsync(2000);
    finish('b');
    await vi.advanceTimersByTimeAsync(2000);
    finish('c');
    await vi.advanceTimersByTimeAsync(20_000);
    expect(out).toEqual([[5000, ['a@0', 'b@2000']], [7500, ['c@4000']]]);
  });

  test("a work-end finish waits 8 s: a wake-up meanwhile leaves only the report turn's own finish", async () => {
    expect(WORK_END_HOLD_MS).toBe(8000);
    const { out, state, finish } = setup();
    finish('a', { workEnd: true });
    await vi.advanceTimersByTimeAsync(3000);
    expect(out).toEqual([]);
    state('a', 'running');
    await vi.advanceTimersByTimeAsync(2000);
    finish('a');
    await vi.advanceTimersByTimeAsync(20_000);
    expect(out).toEqual([[7500, ['a@5000']]]);
  });

  test('a work-end finish whose session is still working when it is due is dropped', async () => {
    const { out, state, finish } = setup();
    finish('a', { workEnd: true });
    await vi.advanceTimersByTimeAsync(6000);
    state('a', 'running');
    await vi.advanceTimersByTimeAsync(20_000);
    expect(out).toEqual([]);
  });

  test('a work-end finish with no wake-up goes out exactly once, after 8 s', async () => {
    const { out, finish } = setup();
    finish('a', { workEnd: true });
    await vi.advanceTimersByTimeAsync(7999);
    expect(out).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(out).toEqual([[8000, ['a@0']]]);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(out).toHaveLength(1);
  });

  test('a held work-end never delays another session\'s finish beyond its own window', async () => {
    const { out, finish } = setup();
    finish('a', { workEnd: true });
    await vi.advanceTimersByTimeAsync(3000);
    finish('b');
    await vi.advanceTimersByTimeAsync(20_000);
    expect(out).toEqual([[5500, ['b@3000']], [8000, ['a@0']]]);
  });
});

test('done tracker: a finish that only ends the background work after a Stop is a work-end; a Stop with nothing left is not', () => {
  const tr = new DoneTracker();
  const sh = bgItem('npm test', 1000);
  const ends = (list: TerminalInfo[], now: number, scans: Record<string, WorkScan> = {}) =>
    tr.finishes(attachWork(list, scans, now, true).list, scans, now, true).map((f) => [f.term.id, f.at, f.workEnd ?? false]);
  expect(ends([bgTerm('running', [sh])], 1000)).toEqual([]);
  expect(ends([bgTerm('done', [sh])], 2000)).toEqual([]);
  expect(ends([bgTerm('done', [sh])], 4500, { a: { at: 4200, matched: {}, servers: [], gone: ['npm test'] } })).toEqual([['a', 4500, true]]);
  expect(ends([bgTerm('running', [])], 5000)).toEqual([]);
  expect(ends([bgTerm('done', [])], 6000)).toEqual([['a', 6000, false]]);
});

test('done tracker: counting that drops only because shells became servers is a normal finish, not a held work-end', () => {
  const ends = (tr: DoneTracker, list: TerminalInfo[], now: number, scans: Record<string, WorkScan> = {}) =>
    tr.finishes(attachWork(list, scans, now, true).list, scans, now, true).map((f) => [f.term.id, f.at, f.workEnd ?? false]);
  const dev = bgItem('npm run dev', 1000);
  const scan = (at: number, servers: string[], matched: Record<string, number> = { 'npm run dev': 120 }, gone: string[] = []): Record<string, WorkScan> => ({ a: { at, matched, servers, gone } });
  // A Stop leaves only a dev server: it counts until the scans prove it one, then the finish needs no report turn.
  const tr = new DoneTracker();
  expect(ends(tr, [bgTerm('running', [dev])], 1000)).toEqual([]);
  expect(ends(tr, [bgTerm('done', [dev])], 1500, scan(1200, []))).toEqual([]);
  expect(ends(tr, [bgTerm('done', [dev])], 16_500, scan(16_200, ['npm run dev']))).toEqual([['a', 16_500, false]]);
  // Unscanned until the scan that already calls it a server: normal too.
  const fresh = new DoneTracker();
  expect(ends(fresh, [bgTerm('done', [dev])], 1500)).toEqual([]);
  expect(ends(fresh, [bgTerm('done', [dev])], 2000, scan(2000, ['npm run dev']))).toEqual([['a', 2000, false]]);
  // A test shell ending at the same moment still means a report turn: held.
  const sh = bgItem('npm test', 1000);
  const mixed = new DoneTracker();
  expect(ends(mixed, [bgTerm('done', [dev, sh])], 1500, scan(1200, [], { 'npm run dev': 120, 'npm test': 130 }))).toEqual([]);
  expect(ends(mixed, [bgTerm('done', [dev, sh])], 16_500, scan(16_200, ['npm run dev'], { 'npm run dev': 120 }, ['npm test']))).toEqual([['a', 16_500, true]]);
});

// With states2 the waiting notifications say what the session waits for, a permission first.
const w2 = (id: string, waitingFor: 'permission' | 'question' | 'input', state: 'waiting' | 'idle' = 'waiting', activity: string | null = null): TerminalInfo =>
  ({ ...t(id, 'waiting'), session: { ...t(id, 'waiting').session!, state, waitingFor, activity } });

test('states2: the idle notice (input) is not waiting for you — no notification, no badge', () => {
  const w = new WaitingTracker();
  w.update([t('a', 'running')]);
  expect(w.update([w2('a', 'input', 'idle')])).toEqual([]);
  expect(waitingCount([[w2('a', 'input', 'idle'), w2('b', 'question'), w2('c', 'input')]])).toBe(1);
  expect(w.update([w2('a', 'input')])).toEqual([]);
  expect(newlyWaiting([t('b', 'running')], [w2('b', 'question')]).map((x) => x.id)).toEqual(['b']);
});

test('states2: banners say "Needs permission · target" or "Has a question", permission requests first', () => {
  const notes = notesFor(DEFAULT_SETTINGS, [w2('q', 'question', 'waiting', 'waiting: question'), w2('p', 'permission', 'waiting', 'waiting: Bash npm test'), t('o', 'waiting')], []);
  expect(notes.map((n) => [n.term.id, n.body])).toEqual([
    ['p', 'Needs permission · Bash npm test'], ['q', 'Has a question'], ['o', 'Waiting for you']
  ]);
});

test('states2: a center entry records what the session waited for (only when known)', () => {
  let n = 0;
  const out = centerEntries([w2('p', 'permission', 'waiting', 'waiting: Bash npm test'), t('o', 'waiting')], [], 5, () => `e${n++}`);
  expect(out.map((x) => x.entry.wait)).toEqual(['permission', undefined]);
  expect('wait' in out[1]!.entry).toBe(false);
});

const notifyRule = (pattern: string, over: Partial<TriggerRule> = {}): TriggerRule => ({ id: `r${pattern.length}${pattern.charCodeAt(0)}`, pattern, action: 'notify', scope: 'all', enabled: true, ...over });

test('trigger banners: only for a rule that is an enabled notify rule in the settings, in scope', () => {
  const banners = new TriggerBanners();
  const s = { ...DEFAULT_SETTINGS, notifyTriggers: true, triggers: [notifyRule('tests failed'), notifyRule('ERROR', { action: 'highlight' }), notifyRule('off', { enabled: false }), notifyRule('sess', { scope: 'sessions' })] };
  expect(banners.note(s, t('a', null), 'tests failed', 'x', false, 0)).not.toBeNull();
  // A renderer can't make up a rule, use a highlight or disabled one, or one out of scope.
  expect(banners.note(s, t('b', null), 'anything at all', 'x', false, 0)).toBeNull();
  expect(banners.note(s, t('b', null), 'ERROR', 'x', false, 0)).toBeNull();
  expect(banners.note(s, t('b', null), 'off', 'x', false, 0)).toBeNull();
  expect(banners.note(s, t('b', null), 'sess', 'x', false, 0)).toBeNull();
  expect(banners.note(s, t('b', 'running'), 'sess', 'x', false, 0)).not.toBeNull();
});

test('trigger banners: at most 6 a minute in total, whatever the terminals; the throttle memory stays bounded', () => {
  const banners = new TriggerBanners();
  const s = { ...DEFAULT_SETTINGS, notifyTriggers: true, triggers: [notifyRule('tests failed')] };
  const shown = Array.from({ length: 20 }, (_, i) => banners.note(s, t(`t${i}`, null), 'tests failed', 'x', false, i * 1000)).filter(Boolean);
  expect(shown).toHaveLength(6);
  expect(banners.note(s, t('late', null), 'tests failed', 'x', false, 61_000)).not.toBeNull();
  for (let i = 0; i < 5000; i++) banners.note(s, t(`m${i}`, null), 'tests failed', 'x', false, 100_000 + i * 11_000);
  expect(banners.size()).toBeLessThanOrEqual(1000);
});

test('trigger banners: only with the setting, never for the window in front, one per rule per terminal every 30 s', () => {
  const banners = new TriggerBanners();
  const term = t('a', null);
  const on = { ...DEFAULT_SETTINGS, notifyTriggers: true, triggers: ['tests failed', 'ERROR', 'r'].map((p) => notifyRule(p)) };
  expect(banners.note(on, term, 'tests failed', '3 tests failed', false, 0)).toEqual({ term, kind: 'trigger', title: 'Trigger: tests failed', body: 'a · 3 tests failed', silent: false });
  expect(banners.note(on, term, 'tests failed', 'again', false, 29_000)).toBeNull();
  expect(banners.note(on, term, 'ERROR', 'ERROR', false, 29_000)).not.toBeNull();
  expect(banners.note(on, t('b', null), 'tests failed', 'x', false, 29_000)).not.toBeNull();
  expect(banners.note(on, term, 'tests failed', 'later', false, 30_000)).not.toBeNull();
  // Setting off, or the window in front (the center has the entry): no banner, and nothing is used up.
  expect(banners.note({ ...on, notifyTriggers: false }, t('c', null), 'r', 'l', false, 0)).toBeNull();
  expect(banners.note(on, t('c', null), 'r', 'l', true, 0)).toBeNull();
  expect(banners.note(on, t('c', null), 'r', 'l', false, 1)).not.toBeNull();
  // Sound per setting; a long line is cut.
  const fresh = new TriggerBanners();
  expect(fresh.note({ ...on, notifySound: false }, t('d', null), 'r', 'l', false, 0)!.silent).toBe(true);
  expect(fresh.note(on, t('e', null), 'r', 'x'.repeat(500), false, 0)!.body.length).toBeLessThanOrEqual(120);
});

test('a banner plays its own sound only for a project with no window: an open window plays Atelier\'s chime', async () => {
  const { bannerSilent } = await import('./attention');
  expect(bannerSilent(false, false)).toBe(false);
  expect(bannerSilent(false, true)).toBe(true);
  expect(bannerSilent(true, false)).toBe(true);
});

// ---- "Finished" only for long turns (Settings › Notifications › Finished: only after) ----
describe('TurnClock: how long a turn took', () => {
  const at = (state: SessionInfo['state'], extra: Partial<SessionInfo> = {}) => bgTerm(state, [], extra);

  test('a turn starts when the session starts working and ends with its finish', () => {
    const c = new TurnClock();
    c.update([at('idle')], 0);
    c.update([at('running')], 1000);
    expect(c.took('a', 61_000)).toBe(60_000);
    // Done: the next turn starts at its own "running".
    c.update([at('done')], 61_000);
    c.update([at('running')], 100_000);
    expect(c.took('a', 105_000)).toBe(5_000);
  });

  test('waiting for a permission or an answer belongs to the turn; the idle notice does not', () => {
    const c = new TurnClock();
    c.update([at('idle')], 0);
    c.update([at('running')], 1000);
    c.update([at('waiting', { waitingFor: 'permission' })], 2000);
    c.update([at('running')], 50_000);
    expect(c.took('a', 70_000)).toBe(69_000);
    c.update([at('done')], 70_000);
    c.update([at('waiting', { waitingFor: 'input' })], 130_000);
    c.update([at('running')], 200_000);
    expect(c.took('a', 203_000)).toBe(3_000);
  });

  test('background work keeps the turn going (effective state)', () => {
    const c = new TurnClock();
    c.update([at('idle')], 0);
    c.update([at('running')], 1000);
    c.update([{ ...at('done'), work: { counting: true, items: [], servers: [] } as unknown as TerminalInfo['work'] }], 5000);
    expect(c.took('a', 300_000)).toBe(299_000);
  });

  test('a terminal seen before its Claude session exists: the first turn is measured from when it starts', () => {
    const c = new TurnClock();
    c.update([{ ...at('idle'), session: null }], 0);
    c.update([at('waiting', { waitingFor: 'permission' })], 1000);
    expect(c.took('a', 4000)).toBe(3000);
  });

  test('a turn whose start was never seen (the app opened mid-turn) is unknown: null', () => {
    const c = new TurnClock();
    c.update([at('running')], 1000);
    expect(c.took('a', 2000)).toBeNull();
    expect(c.took('nobody', 2000)).toBeNull();
  });
});

test('finishes kept for the notification center: errors always, done only past the threshold or of unknown length', () => {
  const f = (id: string, kind: 'done' | 'error', took: number | null | undefined): Finish => ({ term: t(id, 'done'), kind, at: 0, took });
  const kept = (after: Settings['notifyDoneAfter']) => longFinishes([f('quick', 'done', 5_000), f('long', 'done', 90_000), f('unknown', 'done', null), f('err', 'error', 1_000)], after).map((x) => x.term.id);
  expect(kept('1m')).toEqual(['long', 'unknown', 'err']);
  expect(kept('always')).toEqual(['quick', 'long', 'unknown', 'err']);
  expect(kept('30s')).toEqual(['long', 'unknown', 'err']);
  expect(kept('3m')).toEqual(['unknown', 'err']);
});

describe('a woken report turn keeps the length of the work it reports on', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(0); });
  afterEach(() => { vi.useRealTimers(); });

  test('TurnClock: a turn starting right after one that ended on background work continues it', () => {
    const c = new TurnClock();
    const work = { counting: true } as unknown as TerminalInfo['work'];
    c.update([bgTerm('idle', [])], 0);
    c.update([bgTerm('running', [])], 1000);
    c.update([{ ...bgTerm('done', []), work }], 60_000);
    // The work ends (a finish), Claude wakes the main agent with the report 2 s later.
    c.update([bgTerm('done', [])], 600_000);
    c.update([bgTerm('running', [])], 602_000);
    expect(c.took('a', 606_000)).toBe(605_000);
    // A turn the user starts later (past the hold) is a turn of its own.
    c.update([bgTerm('done', [])], 606_000);
    c.update([bgTerm('running', [])], 700_000);
    expect(c.took('a', 704_000)).toBe(4_000);
  });

  test('FinishQueue: of two finishes of a session in a batch, the one kept takes the longest length (unknown wins)', async () => {
    const got: (number | null | undefined)[] = [];
    const list = [t('a', 'done')];
    const q = new FinishQueue(() => list, (items) => got.push(...items.map((f) => f.took)));
    q.push([{ term: t('a', 'done'), kind: 'done', at: 0, took: 300_000 }]);
    await vi.advanceTimersByTimeAsync(1000);
    q.push([{ term: t('a', 'done'), kind: 'done', at: 1000, took: 4_000 }]);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(got).toEqual([300_000]);
    q.push([{ term: t('a', 'done'), kind: 'done', at: Date.now(), took: null }]);
    await vi.advanceTimersByTimeAsync(500);
    q.push([{ term: t('a', 'done'), kind: 'done', at: Date.now(), took: 4_000 }]);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(got).toEqual([300_000, null]);
  });
});

test('the stopped tracker: a usage-limit pause gives no entry, its end gives one, a continuation none', () => {
  const lim = (limitPause: { since: number; resetsAt: number | null; over?: 'expired' }): TerminalInfo => {
    const x = failed('c', 'rate_limit');
    x.session = { ...x.session!, errorReason: 'rate_limit', limitPause };
    return x;
  };
  const running = t('c', 'running');
  const tr = new StateTracker('error');
  tr.update([running]);
  expect(tr.update([lim({ since: 1, resetsAt: 9 })])).toEqual([]);
  expect(tr.update([lim({ since: 1, resetsAt: 9, over: 'expired' })]).map((x) => x.id)).toEqual(['c']);
  const tr2 = new StateTracker('error');
  tr2.update([running]);
  tr2.update([lim({ since: 1, resetsAt: 9 })]);
  expect(tr2.update([running])).toEqual([]);
});
