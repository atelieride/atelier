import { describe, expect, test } from 'vitest';
import type { Attribution } from './attribution';
import type { SessionInfo } from './session';
import {
  BASH_KEEP_MS, addBashAttributions, bashCulprit, changedFiles, inBash, mergeAttributions, relatedRoots, trackBashWindows,
  type BashWindow
} from './bash-attribution';

const session = (over: Partial<SessionInfo> = {}): SessionInfo => ({
  sessionId: 's1', state: 'running', title: null, activity: null, contextPct: null, unread: false, updatedAt: 0, ...over
});
const term = (id: string, s: SessionInfo | null) => ({ id, session: s });

describe('inBash', () => {
  test('a running Bash call, with or without a description', () => {
    expect(inBash(session({ activity: 'Bash: Run tests' }))).toBe(true);
    expect(inBash(session({ activity: 'Bash' }))).toBe(true);
  });
  test('a Bash call waiting for permission counts: once approved it runs before any other hook arrives', () => {
    expect(inBash(session({ state: 'waiting', activity: 'waiting: Bash npm test' }))).toBe(true);
    // After the approval PostToolUse turns the state back to running and keeps the activity.
    expect(inBash(session({ state: 'running', activity: 'waiting: Bash npm test' }))).toBe(true);
  });
  test('other tools, tools whose name only starts with Bash, finished or idle sessions do not', () => {
    expect(inBash(session({ activity: 'edit a.ts' }))).toBe(false);
    expect(inBash(session({ activity: 'BashOutput' }))).toBe(false);
    expect(inBash(session({ state: 'waiting', activity: 'waiting: Edit a.ts' }))).toBe(false);
    expect(inBash(session({ state: 'done', activity: 'Bash: x' }))).toBe(false);
    expect(inBash(session({ state: 'idle', activity: null }))).toBe(false);
    expect(inBash(null)).toBe(false);
  });
  test('running subagents count whatever the main agent shows: a background one runs Bash with no activity of its own', () => {
    // After the main Stop a background subagent's tool events leave the state and activity alone (mainRest).
    expect(inBash(session({ state: 'done', activity: null, subagents: 1 }))).toBe(true);
    expect(inBash(session({ state: 'idle', activity: null, subagents: 2 }))).toBe(true);
    expect(inBash(session({ state: 'running', activity: 'read a.ts', subagents: 1 }))).toBe(true);
    expect(inBash(session({ state: 'done', activity: null, subagents: 0 }))).toBe(false);
  });
});

describe('trackBashWindows', () => {
  test('opens a window when a session enters Bash, at its last hook time', () => {
    const w = trackBashWindows([], [term('t1', session({ activity: 'Bash: x', updatedAt: 900 })), term('t2', session({ activity: 'edit a', updatedAt: 950 }))], 1000);
    expect(w).toEqual([{ terminalId: 't1', sessionId: 's1', start: 900, end: null }]);
  });
  test('keeps it open while in Bash, closes it at the hook that left Bash', () => {
    let w = trackBashWindows([], [term('t1', session({ activity: 'Bash: x', updatedAt: 900 }))], 1000);
    w = trackBashWindows(w, [term('t1', session({ activity: 'Bash: x', updatedAt: 1500 }))], 1600);
    expect(w).toEqual([{ terminalId: 't1', sessionId: 's1', start: 900, end: null }]);
    w = trackBashWindows(w, [term('t1', session({ activity: 'read a.ts', updatedAt: 2000 }))], 2100);
    expect(w).toEqual([{ terminalId: 't1', sessionId: 's1', start: 900, end: 2000 }]);
  });
  test('a terminal gone or a different session closes it now', () => {
    const open = [{ terminalId: 't1', sessionId: 's1', start: 900, end: null }];
    expect(trackBashWindows(open, [], 3000)[0]!.end).toBe(3000);
    expect(trackBashWindows(open, [term('t1', null)], 3000)[0]!.end).toBe(3000);
    const w = trackBashWindows(open, [term('t1', session({ sessionId: 's2', activity: 'Bash: y', updatedAt: 2900 }))], 3000);
    expect(w).toEqual([{ terminalId: 't1', sessionId: 's1', start: 900, end: 3000 }, { terminalId: 't1', sessionId: 's2', start: 2900, end: null }]);
  });
  test('times never go backwards or into the future', () => {
    const w = trackBashWindows([], [term('t1', session({ activity: 'Bash', updatedAt: 5000 }))], 1000);
    expect(w[0]!.start).toBe(1000);
    const closed = trackBashWindows([{ terminalId: 't1', sessionId: 's1', start: 900, end: null }], [term('t1', session({ activity: null, updatedAt: 100 }))], 1000);
    expect(closed[0]!.end).toBe(900);
  });
  test('keeps only the last minutes and a bounded number of windows', () => {
    const old = { terminalId: 't1', sessionId: 's1', start: 0, end: 10 };
    expect(trackBashWindows([old], [], 10 + BASH_KEEP_MS + 1)).toEqual([]);
    expect(trackBashWindows([old], [], 10 + BASH_KEEP_MS - 1)).toEqual([old]);
    const many = Array.from({ length: 500 }, (_, i) => ({ terminalId: 't1', sessionId: 's1', start: i, end: i + 1 }));
    const kept = trackBashWindows(many, [], 600);
    expect(kept.length).toBeLessThanOrEqual(200);
    expect(kept.at(-1)!.start).toBe(499);
  });
});

describe('changedFiles', () => {
  test('no previous status: nothing changed (baseline)', () => {
    expect(changedFiles(undefined, [{ path: '/r/a', mtime: 1 }])).toEqual([]);
  });
  test('newly dirty files and files whose mtime changed; untouched dirty files are not', () => {
    const prev = new Map<string, number | null>([['/r/a', 1], ['/r/b', 2], ['/r/gone', null]]);
    expect(changedFiles(prev, [{ path: '/r/a', mtime: 1 }, { path: '/r/b', mtime: 3 }, { path: '/r/c', mtime: 4 }, { path: '/r/gone', mtime: null }, { path: '/r/d', mtime: null }]))
      .toEqual([{ path: '/r/b', mtime: 3 }, { path: '/r/c', mtime: 4 }, { path: '/r/d', mtime: null }]);
  });
});

describe('bashCulprit', () => {
  const w = (terminalId: string, start: number, end: number | null, sessionId = 's-' + terminalId): BashWindow => ({ terminalId, sessionId, start, end });
  const any = () => true;
  test('the single session in Bash when the file changed (mtime)', () => {
    expect(bashCulprit({ path: '/r/a', mtime: 5000 }, 1000, 9000, [w('t1', 4000, 6000), w('t2', 7000, null)], any)).toEqual(w('t1', 4000, 6000));
  });
  test('two sessions in Bash at that moment: no guess', () => {
    expect(bashCulprit({ path: '/r/a', mtime: 5000 }, 1000, 9000, [w('t1', 4000, 6000), w('t2', 4500, null)], any)).toBeNull();
  });
  test('no session in Bash at that moment (the mtime says the change came after the window)', () => {
    expect(bashCulprit({ path: '/r/a', mtime: 8000 }, 1000, 9000, [w('t1', 4000, 6000)], any)).toBeNull();
  });
  test('two windows of the same terminal are one session: the latest one', () => {
    expect(bashCulprit({ path: '/r/a', mtime: null }, 1000, 9000, [w('t1', 2000, 3000, 'old'), w('t1', 4000, 6000, 'new')], any)?.sessionId).toBe('new');
  });
  test('without a usable mtime (deleted file, mtime kept by mv): the recent part of the interval between the statuses', () => {
    expect(bashCulprit({ path: '/r/a', mtime: null }, 1000, 9000, [w('t1', 4000, 8500)], any)?.terminalId).toBe('t1');
    expect(bashCulprit({ path: '/r/a', mtime: 10 }, 3000, 9000, [w('t1', 4000, 8500)], any)?.terminalId).toBe('t1');
    // An interval of minutes (no status in between) only looks at the last seconds before the status.
    expect(bashCulprit({ path: '/r/a', mtime: null }, 0, 300_000, [w('t1', 1000, 2000)], any)).toBeNull();
  });
  test('only the eligible terminals (sessions of a project containing the repo)', () => {
    const only1 = (id: string) => id === 't1';
    expect(bashCulprit({ path: '/r/a', mtime: 5000 }, 1000, 9000, [w('t1', 4000, 6000), w('t2', 4500, null)], only1)?.terminalId).toBe('t1');
  });
});

describe('relatedRoots', () => {
  test('same folder, one inside the other, never a sibling with a common prefix', () => {
    expect(relatedRoots('/p', '/p')).toBe(true);
    expect(relatedRoots('/p', '/p/app')).toBe(true);
    expect(relatedRoots('/p/app', '/p')).toBe(true);
    expect(relatedRoots('/p/app', '/p/app2')).toBe(false);
  });
});

const at = (path: string, terminalId: string, when = 1, via?: 'bash'): Attribution => ({ path, terminalId, sessionId: 's', color: 'c', title: terminalId, at: when, ...(via ? { via } : {}) });

describe('addBashAttributions', () => {
  test('one per file and terminal, marked via bash, bounded (newest kept)', () => {
    const l = addBashAttributions([at('/r/a', 't1', 1, 'bash')], [at('/r/a', 't1', 5), at('/r/b', 't1', 6)], 10);
    expect(l).toEqual([at('/r/a', 't1', 5, 'bash'), at('/r/b', 't1', 6, 'bash')]);
    const big = addBashAttributions([], Array.from({ length: 30 }, (_, i) => at(`/r/${i}`, 't1', i)), 10);
    expect(big.length).toBe(10);
    expect(big.map((x) => x.at)).toEqual([20, 21, 22, 23, 24, 25, 26, 27, 28, 29]);
  });
});

describe('mergeAttributions', () => {
  test('a daemon attribution (Edit/Write) for a path always wins over Bash ones', () => {
    const daemon = [at('/r/a', 't1')];
    const bash = [at('/r/a', 't2', 2, 'bash'), at('/r/b', 't2', 2, 'bash')];
    expect(mergeAttributions(daemon, bash)).toEqual([at('/r/a', 't1'), at('/r/b', 't2', 2, 'bash')]);
  });
});
