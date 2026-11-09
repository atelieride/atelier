import { describe, expect, test } from 'vitest';
import { t } from './i18n/en';
import { loopRowId } from '@shared/loop';
import { backgroundSections, backgroundSummary, bgChipOpen, commandOf, exitedIds, firstItemId, formatElapsed, inspectorTarget, isFollowable } from './background-view';

describe('bgChipOpen', () => {
  const pop = { terminalId: 't1', anchor: { left: 0, top: 0, right: 1, bottom: 1 }, side: 'right' as const, section: 'all' as const };
  test('only the chip whose session, side and section opened the popover is open', () => {
    expect(bgChipOpen(pop, 't1', 'right', 'all')).toBe(true);
    expect(bgChipOpen(pop, 't1', 'below', 'all')).toBe(false);
    expect(bgChipOpen(pop, 't1', 'right', 'scheduled')).toBe(false);
    expect(bgChipOpen(pop, 't2', 'right', 'all')).toBe(false);
    expect(bgChipOpen(null, 't1', 'right', 'all')).toBe(false);
  });
});

const NOW = 1_000_000_000;
const entry = (id: string, kind: 'agent' | 'shell' | 'monitor' | 'other', over: object = {}) => ({ id, kind, label: id, since: NOW - 65_000, counted: true, ...over });
const term = (entries: object[], over: object = {}) => ({ work: { entries, crons: [], items: [] }, ...over }) as never;

describe('backgroundSections', () => {
  test('items an agent launched nest under it; empty sections are left out', () => {
    const s = backgroundSections(term([entry('a1', 'agent', { lastEvent: NOW - 2000 }), entry('s1', 'shell', { owner: 'a1', display: 'npm run typecheck' }), entry('s2', 'shell', { display: 'npm test' })]), NOW);
    expect(s.map((x) => x.key)).toEqual(['agents', 'shells']);
    expect(s[0]!.rows.map((r) => [r.id, r.depth])).toEqual([['a1', 0], ['s1', 1]]);
    expect(s[1]!.rows.map((r) => r.id)).toEqual(['s2']);
    expect(s[0]!.rows[0]!.sub).toBe('Last event 2 s ago');
    expect(s[1]!.rows[0]!).toMatchObject({ sub: 'npm test', elapsed: '1 min', state: 'running' });
  });
  test('a shell labelled by its own command (no description) does not repeat it on the second line', () => {
    const s = backgroundSections(term([entry('npm test -- auth', 'shell', { display: 'npm test -- auth' }), entry('s2', 'shell', { label: 'Run the tests', display: 'npm test' })]), NOW);
    expect(s[0]!.rows.map((r) => r.sub)).toEqual(['', 'npm test']);
  });
  test('servers, watchers, capped items, crons and recent ones', () => {
    const s = backgroundSections(term(
      [entry('srv', 'shell', { counted: false, server: { ports: [5173] } }), entry('w', 'monitor', { counted: false, watcher: true }), entry('c', 'other', { counted: false, since: NOW - 40 * 60_000 })],
      { work: { entries: [], items: [], crons: [{ id: 'k1', label: 'check the deploy', schedule: '*/10 * * * *', recurring: true, next: NOW + 6 * 60_000 }] }, recent: [{ id: 'r1', kind: 'shell', label: 'tests', since: 0, endedAt: NOW - 1000, exit: 1 }] }
    ), NOW);
    expect(s.map((x) => x.key)).toEqual(['scheduled', 'recent']);
    const s2 = backgroundSections(term([entry('srv', 'shell', { counted: false, server: { ports: [5173] } }), entry('w', 'monitor', { counted: false, watcher: true })]), NOW);
    expect(s2.flatMap((x) => x.rows).map((r) => [r.id, r.state])).toEqual([['srv', 'server'], ['w', 'watcher']]);
  });
  test('a watcher stays a watcher however old; a capped task is idle', () => {
    const s = backgroundSections(term([entry('w', 'monitor', { counted: false, watcher: true, since: NOW - 3 * 3600_000 }), entry('c', 'other', { counted: false, since: NOW - 40 * 60_000 }), entry('cs', 'shell', { counted: false, since: NOW - 40 * 60_000 })]), NOW);
    expect(s.flatMap((x) => x.rows).map((r) => [r.id, r.state])).toEqual([['cs', 'idle'], ['w', 'watcher'], ['c', 'idle']]);
  });
  test('an owner missing from the entries: the child falls back to its own section, once', () => {
    const s = backgroundSections(term([entry('s1', 'shell', { owner: 'gone' })]), NOW);
    expect(s.map((x) => x.key)).toEqual(['shells']);
    expect(s[0]!.rows.map((r) => [r.id, r.depth])).toEqual([['s1', 0]]);
  });
  test('zero and negative elapsed never print 0 s or a negative', () => {
    const s = backgroundSections(term([entry('a', 'shell', { since: NOW }), entry('b', 'shell', { since: NOW + 5000 })]), NOW);
    expect(s[0]!.rows.map((r) => r.elapsed)).toEqual(['1 s', '1 s']);
  });
  test('scheduled sub uses the in-time string', () => {
    const s = backgroundSections(term([], { work: { entries: [], items: [], crons: [{ id: 'k', label: 'x', schedule: '*/10 * * * *', recurring: true, next: NOW + 6 * 60_000 }] } }), NOW);
    expect(s[0]!.rows[0]!.sub).toBe('Every 10 minutes · in 6 min');
  });
  test('a self-paced loop: its row keyed by its label, titled by its task, said as a loop', () => {
    const loop = (next: number | null, id = 'w1') => ({ id, label: '/loop check the preview deploy', schedule: '28 10 * * *', recurring: false, next });
    const rows = (next: number | null, state = 'done', id?: string, waitingFor: string | null = null) =>
      backgroundSections(term([], { session: { state, waitingFor }, work: { entries: [], items: [], crons: [loop(next, id)] } }), NOW)[0]!.rows;
    const r = rows(NOW + 3 * 60_000)[0]!;
    expect(r).toMatchObject({ id: loopRowId('/loop check the preview deploy'), kind: 'loop', label: 'check the preview deploy', sub: 'Self-paced loop · in 3 min' });
    expect(rows(NOW + 3 * 60_000, 'done', 'w2')[0]!.id).toBe(r.id);
    expect(rows(null, 'running')[0]).toMatchObject({ sub: 'Self-paced loop · checking now', elapsed: '' });
    expect(rows(null, 'waiting', undefined, 'permission')[0]).toMatchObject({ sub: 'Self-paced loop · checking now' });
    // The idle notice (turn over, prompt free) is no wait: the wake-up passed.
    expect(rows(null, 'waiting', undefined, 'input')[0]).toMatchObject({ sub: 'Self-paced loop · wake-up passed' });
    expect(rows(null, 'done')[0]).toMatchObject({ sub: 'Self-paced loop · wake-up passed' });
    const auto = backgroundSections(term([], { work: { entries: [], items: [], crons: [{ ...loop(NOW + 60_000), label: '<<autonomous-loop-dynamic>>' }] } }), NOW)[0]!.rows[0]!;
    expect(auto).toMatchObject({ kind: 'loop', label: 'Autonomous loop' });
    expect(firstItemId(term([], { work: { entries: [], items: [], crons: [loop(NOW + 60_000)] } }))).toBe(r.id);
  });
  test('summary: running and scheduled', () => {
    expect(backgroundSummary(term([entry('a', 'agent'), entry('b', 'shell')], { work: { entries: [entry('a', 'agent'), entry('b', 'shell')], items: [], crons: [{ id: 'k', label: 'x', schedule: '* * * * *', recurring: true, next: null }] } }))).toBe('2 running · 1 scheduled');
    const srv = entry('srv', 'shell', { counted: false, server: { ports: [1] } });
    expect(backgroundSummary(term([], { work: { entries: [srv], items: [], crons: [] } }))).toBe('1 running');
    expect(backgroundSummary(term([]))).toBeNull();
  });
  test('summary: an item whose exit code is known no longer counts as running', () => {
    const t1 = term([entry('a', 'agent'), entry('b', 'shell')]);
    expect(backgroundSummary(t1, new Set(['b']))).toBe('1 running');
    expect(backgroundSummary(t1, new Set(['a', 'b']))).toBeNull();
  });
  test('exitedIds: the items of one terminal whose feed carries an exit code', () => {
    const f = (exit: number | null) => ({ kind: 'output' as const, lines: [], live: '', dropped: 0, exit, entries: [], meta: null });
    expect([...exitedIds({ 't1:b1': f(0), 't1:b2': f(null), 't2:b3': f(1), 't1:b4': f(2) }, 't1')]).toEqual([['b1', 0], ['b4', 2]]);
  });
  test('a listed shell or monitor whose exit is known shows "Exited N", is no longer running, and is not the inspector target', () => {
    const t1 = term([entry('b', 'shell', { display: 'npm test' }), entry('m', 'monitor'), entry('c', 'shell')]);
    const exited = new Map([['b', 3], ['m', 0]]);
    const rows = backgroundSections(t1, NOW, exited).flatMap((s) => s.rows);
    expect(rows.find((r) => r.id === 'b')).toMatchObject({ state: 'ended', sub: 'Exited 3', exit: 3 });
    expect(rows.find((r) => r.id === 'm')).toMatchObject({ state: 'ended', sub: 'Exited 0' });
    expect(rows.find((r) => r.id === 'c')).toMatchObject({ state: 'running' });
    expect(inspectorTarget(t1, exited)).toBe('c');
  });
  test('commandOf: the redacted command of a listed or recent shell, else nothing', () => {
    const t1 = term([entry('s1', 'shell', { display: 'npm test' }), entry('m1', 'monitor')], { recent: [{ id: 'r1', kind: 'shell', label: 'r1', since: 0, endedAt: 1, exit: 0, display: 'npm run lint' }] });
    expect(commandOf(t1, 's1')).toBe('npm test');
    expect(commandOf(t1, 'r1')).toBe('npm run lint');
    expect(commandOf(t1, 'm1')).toBeUndefined();
    expect(commandOf(t1, 'nope')).toBeUndefined();
  });
  test('inspectorTarget: the first running item (not a server or a watcher), else the first row', () => {
    const srv = entry('srv', 'shell', { counted: false, server: { ports: [1] } });
    const w = entry('w', 'monitor', { counted: false, watcher: true });
    expect(inspectorTarget(term([srv, w, entry('s', 'shell')]))).toBe('s');
    expect(inspectorTarget(term([srv, entry('a', 'agent')]))).toBe('a');
    expect(inspectorTarget(term([srv, w]))).toBe('srv');
    // An item that exited (its feed said so) is not running any more.
    expect(inspectorTarget(term([entry('s', 'shell'), entry('t', 'shell')]), new Set(['s']))).toBe('t');
    expect(inspectorTarget(term([], { recent: [{ id: 'r1', kind: 'shell', label: 'r1', since: 0, endedAt: 1, exit: 0 }] }))).toBe('r1');
    expect(inspectorTarget(term([]))).toBeNull();
  });
  test('formatElapsed', () => {
    expect([formatElapsed(42_000), formatElapsed(65_000), formatElapsed(2 * 3600_000), formatElapsed(59_500), formatElapsed(-5), formatElapsed(0)]).toEqual(['42 s', '1 min', '2 h', '1 min', '1 s', '1 s']);
    expect([t.bg.lines(1), t.bg.lines(2), t.bg.earlier(1), t.bg.earlier(3)]).toEqual(['1 line', '2 lines', '1 earlier line not shown', '3 earlier lines not shown']);
  });
});

describe('isFollowable', () => {
  test('agents and items with a command have something to follow; the rest is watched by Claude Code itself', () => {
    expect(isFollowable({ id: 'b1', kind: 'shell', display: 'npm test' })).toBe(true);
    expect(isFollowable({ id: 'm1', kind: 'monitor', display: 'tail -f log' })).toBe(true);
    expect(isFollowable({ id: 'm2', kind: 'monitor' })).toBe(false);
    expect(isFollowable({ id: 'o1', kind: 'other' })).toBe(false);
    expect(isFollowable({ id: 'a1', kind: 'agent' })).toBe(true);
    expect(isFollowable({ id: 'cron:c1', kind: 'other', display: 'x' })).toBe(false);
    expect(isFollowable({ id: 'subagent-a1', kind: 'agent' })).toBe(false);
  });
});
