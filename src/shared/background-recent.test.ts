import { describe, expect, test } from 'vitest';
import { RECENT_MAX, RECENT_TTL_MS, RecentBook } from './background-recent';
import type { InspectorEntry } from './background';
import type { TerminalInfo } from './protocol';

const e = (id: string, kind: InspectorEntry['kind'] = 'shell'): InspectorEntry => ({ id, kind, label: id, since: 1, counted: true, display: `run ${id}` });
const term = (entries: InspectorEntry[], sessionId = 's1', id = 't1') =>
  ({ id, cwd: '/w/proj', session: { sessionId, cwd: '/w/proj/app' }, work: { entries } } as unknown as TerminalInfo);
/** The terminal once Claude Code ended (SessionEnd, or claude exited): no session, no work. */
const ended = (id = 't1') => ({ id, cwd: '/w/proj' } as unknown as TerminalInfo);

describe('RecentBook', () => {
  test('an entry that leaves becomes recent, newest first, and is reported once as ended', () => {
    const b = new RecentBook();
    b.apply([term([e('a'), e('b')])], 100);
    const r1 = b.apply([term([e('b')])], 200);
    expect(r1.ended).toEqual([{ terminalId: 't1', id: 'a', kind: 'shell' }]);
    expect(r1.list[0]!.recent).toEqual([{ id: 'a', kind: 'shell', label: 'a', since: 1, endedAt: 200, exit: null, display: 'run a', sessionId: 's1', cwd: '/w/proj/app' }]);
    const r2 = b.apply([term([])], 300);
    expect(r2.list[0]!.recent!.map((r) => r.id)).toEqual(['b', 'a']);
    expect(b.apply([term([])], 400).ended).toEqual([]);
  });
  test('exit codes attach to a recent item', () => {
    const b = new RecentBook();
    b.apply([term([e('a')])], 100);
    b.apply([term([])], 200);
    expect(b.setExit('t1', 'a', 1)).toBe(true);
    expect(b.setExit('t1', 'zz', 1)).toBe(false);
    expect(b.apply([term([])], 250).list[0]!.recent![0]!.exit).toBe(1);
  });
  test('setExit never mutates a snapshot already handed out; the next apply shows the exit', () => {
    const b = new RecentBook();
    b.apply([term([e('a')])], 100);
    b.apply([term([])], 200);
    const a = b.apply([term([])], 250).list[0]!.recent!;
    expect(b.setExit('t1', 'a', 1)).toBe(true);
    expect(a[0]!.exit).toBeNull();
    expect(b.apply([term([])], 260).list[0]!.recent![0]!.exit).toBe(1);
  });
  test('a terminal without work (older atelierd, or a momentary list) reports nothing as ended', () => {
    const b = new RecentBook();
    b.apply([term([e('a')])], 100);
    const noWork = { id: 't1', session: { sessionId: 's1' } } as unknown as TerminalInfo;
    const r1 = b.apply([noWork], 200);
    expect(r1.ended).toEqual([]);
    expect(r1.list[0]!.recent).toBeUndefined();
    expect(b.apply([term([])], 300).ended).toEqual([{ terminalId: 't1', id: 'a', kind: 'shell' }]);
  });
  test('an id that is live again leaves recent', () => {
    const b = new RecentBook();
    b.apply([term([e('a')])], 100);
    b.apply([term([])], 200);
    expect(b.apply([term([e('a')])], 300).list[0]!.recent).toBeUndefined();
  });
  test('two successive applies do not share the recent array', () => {
    const b = new RecentBook();
    b.apply([term([e('a')])], 100);
    b.apply([term([])], 200);
    const x = b.apply([term([])], 250).list[0]!.recent!;
    const y = b.apply([term([])], 260).list[0]!.recent!;
    expect(x).toEqual(y);
    expect(x).not.toBe(y);
  });
  test('at most RECENT_MAX, for RECENT_TTL_MS', () => {
    const b = new RecentBook();
    const ids = Array.from({ length: RECENT_MAX + 2 }, (_, i) => `x${i}`);
    b.apply([term(ids.map((id) => e(id)))], 0);
    expect(b.apply([term([])], 10).list[0]!.recent).toHaveLength(RECENT_MAX);
    expect(b.apply([term([])], 10 + RECENT_TTL_MS + 1).list[0]!.recent).toBeUndefined();
  });
  test('a new session in the terminal starts over; a terminal that leaves is forgotten', () => {
    const b = new RecentBook();
    b.apply([term([e('a')])], 0);
    expect(b.apply([term([], 's2')], 1).list[0]!.recent).toBeUndefined();
    b.apply([term([e('c')], 's2')], 2);
    b.apply([], 3);
    expect(b.apply([term([], 's2')], 4).list[0]!.recent).toBeUndefined();
  });
  test('session ends → entries become recent and stay (until a new session id)', () => {
    const b = new RecentBook();
    b.apply([term([e('a'), e('b', 'monitor'), e('subagent-1', 'agent')])], 100);
    const r1 = b.apply([ended()], 200);
    // Everything that was running ended with the session (placeholders aside): reported once, kept with its session.
    expect(r1.ended).toEqual([{ terminalId: 't1', id: 'a', kind: 'shell' }, { terminalId: 't1', id: 'b', kind: 'monitor' }]);
    expect(r1.list[0]!.recent!.map((r) => r.id)).toEqual(['b', 'a']);
    expect(r1.list[0]!.recent![0]).toMatchObject({ endedAt: 200, exit: null, sessionId: 's1', cwd: '/w/proj/app' });
    const r2 = b.apply([ended()], 300);
    expect(r2.ended).toEqual([]);
    expect(r2.list[0]!.recent!.map((r) => r.id)).toEqual(['b', 'a']);
    expect(b.setExit('t1', 'a', 0)).toBe(true);
    expect(b.apply([ended()], 400).list[0]!.recent![1]!.exit).toBe(0);
    // The same session back (a resume) keeps them; a different one starts over.
    expect(b.apply([term([], 's1')], 500).list[0]!.recent).toHaveLength(2);
    b.apply([ended()], 600);
    expect(b.apply([term([], 's2')], 700).list[0]!.recent).toBeUndefined();
  });
  test('recent items of an ended session still expire', () => {
    const b = new RecentBook();
    b.apply([term([e('a')])], 100);
    b.apply([ended()], 200);
    expect(b.nextExpiry()).toBe(200 + RECENT_TTL_MS);
    expect(b.apply([ended()], 200 + RECENT_TTL_MS + 1).list[0]!.recent).toBeUndefined();
  });
  test('a terminal that never had a session has nothing recent', () => {
    const b = new RecentBook();
    const r = b.apply([ended()], 100);
    expect(r.ended).toEqual([]);
    expect(r.list[0]!.recent).toBeUndefined();
  });
  test('nextExpiry: the earliest endedAt + TTL over all terminals, null with none', () => {
    const b = new RecentBook();
    expect(b.nextExpiry()).toBeNull();
    b.apply([term([e('a')])], 0);
    b.apply([term([])], 100);
    expect(b.nextExpiry()).toBe(100 + RECENT_TTL_MS);
    b.apply([term([e('c')], 's1')], 150);
    b.apply([term([], 's1')], 300);
    expect(b.nextExpiry()).toBe(100 + RECENT_TTL_MS);
    b.apply([term([], 's1')], 100 + RECENT_TTL_MS + 1);
    expect(b.nextExpiry()).toBe(300 + RECENT_TTL_MS);
  });
});
