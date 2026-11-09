import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }));
import type { TerminalInfo } from '@shared/protocol';
import type { RepoStatus } from '@shared/git';
import type { SessionInfo } from '@shared/session';
import type { PrInfo, PrsState } from '@shared/pr';
import type { GhResult } from './github/exec';
import { PrHub, type PrDeps, type PrWindow } from './pr-hub';

const session = (cwd?: string): SessionInfo => ({ sessionId: 's', state: 'idle', title: null, activity: null, contextPct: null, unread: false, updatedAt: 0, ...(cwd ? { cwd } : {}) });
const term = (id: string, o: { project?: string; cwd?: string; sessionCwd?: string; session?: boolean } = {}): TerminalInfo => ({
  id, projectRoot: o.project ?? '/p', cwd: o.cwd ?? o.project ?? '/p', title: id, name: null, color: '#fff', foreground: 'claude', createdAt: 0,
  session: o.session === false ? null : session(o.sessionCwd)
});
const status = (root: string, branch: string | null, detached = false): RepoStatus => ({ root, name: root, branch, detached, ahead: 0, behind: 0, changes: [], oid: 'x', checkedAt: 0, truncated: 0 });
const pr = (n: number, ci: PrInfo['ci']['state'] = 'passing'): PrInfo => ({
  number: n, title: `PR ${n}`, url: `https://github.com/o/r/pull/${n}`, state: 'OPEN', isDraft: false, reviewDecision: null,
  ci: { state: ci, passed: ci === 'passing' ? 1 : 0, failed: ci === 'failing' ? 1 : 0, pending: ci === 'pending' ? 1 : 0, failing: ci === 'failing' ? ['build'] : [] }
});

const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

describe('PrHub', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const setup = (o: Partial<PrDeps> = {}) => {
    const state = { enabled: true, focused: true, answers: new Map<string, GhResult>(), manual: false };
    const calls: string[] = [];
    const waiting: { key: string; resolve: (r: GhResult) => void }[] = [];
    const deps: PrDeps = {
      view: (root, branch) => {
        const key = `${root}@${branch}`;
        calls.push(key);
        if (state.manual) return new Promise((resolve) => waiting.push({ key, resolve }));
        return Promise.resolve(state.answers.get(key) ?? { kind: 'none' });
      },
      enabled: () => state.enabled,
      focused: () => state.focused,
      reposOf: (project) => (project === '/p' ? ['/p', '/p/sub'] : project === '/q' ? ['/q'] : []),
      realpath: (p) => p.replace(/^\/link/, '/p'),
      ...o
    };
    const hub = new PrHub(deps);
    const win = (id: number, project: string) => {
      const sent: PrsState[] = [];
      const w: PrWindow = { id, send: (_c, payload) => { sent.push(payload); }, isDestroyed: () => false, once: () => {} };
      hub.open(project, w);
      return sent;
    };
    return { hub, state, calls, waiting, win };
  };

  test('a session on a feature branch: gh once for its repo and branch, the window of its project gets the PR', async () => {
    const { hub, state, calls, win } = setup();
    state.answers.set('/p@feature/x', { kind: 'ok', pr: pr(7) });
    const p = win(1, '/p');
    const q = win(2, '/q');
    hub.repoStatus(status('/p', 'feature/x'));
    hub.setTerminals([term('a'), term('plain', { session: false })]);
    await flush();
    expect(calls).toEqual(['/p@feature/x']);
    expect(p.at(-1)).toEqual({ gh: 'ok', terminals: { a: { root: '/p', branch: 'feature/x', status: 'ok', pr: pr(7) } } });
    expect(q.at(-1)?.terminals ?? {}).toEqual({});
    expect(hub.stateOf('/p').terminals.a?.status).toBe('ok');
    hub.dispose();
  });

  test('the deepest repo containing the session cwd (real path), falling back to the terminal cwd', async () => {
    const { hub, calls } = setup();
    hub.repoStatus(status('/p', 'feature/x'));
    hub.repoStatus(status('/p/sub', 'feature/y'));
    hub.setTerminals([term('a', { sessionCwd: '/link/sub/src' }), term('b', { cwd: '/p/lib' })]);
    await flush();
    expect(calls.sort()).toEqual(['/p/sub@feature/y', '/p@feature/x']);
    hub.dispose();
  });

  test('nothing for main, master, detached HEAD, no branch, no repo, a branch gh would misread, or a terminal without a session', async () => {
    const { hub, calls } = setup();
    hub.repoStatus(status('/p', 'main'));
    hub.repoStatus(status('/p/sub', 'feature/y', true));
    hub.repoStatus(status('/q', 'master'));
    hub.setTerminals([term('a'), term('b', { cwd: '/p/sub' }), term('c', { project: '/q' }), term('d', { cwd: '/elsewhere' }), term('e', { session: false })]);
    await flush();
    hub.repoStatus(status('/p', null));
    hub.repoStatus(status('/q', '123'));
    await flush();
    expect(calls).toEqual([]);
    hub.dispose();
  });

  test('dedupe: two sessions on the same branch and repeated updates while gh runs give one call', async () => {
    const { hub, state, calls, waiting } = setup();
    state.manual = true;
    hub.repoStatus(status('/p', 'feature/x'));
    hub.setTerminals([term('a'), term('b')]);
    hub.setTerminals([term('a'), term('b')]);
    hub.repoStatus(status('/p', 'feature/x'));
    hub.refresh();
    await flush();
    expect(calls).toEqual(['/p@feature/x']);
    waiting[0]!.resolve({ kind: 'ok', pr: pr(1) });
    await flush();
    expect(hub.stateOf('/p').terminals).toMatchObject({ a: { status: 'ok' }, b: { status: 'ok' } });
    hub.dispose();
  });

  test('never more than two gh at once; the rest wait their turn', async () => {
    const { hub, state, calls, waiting } = setup({ reposOf: () => ['/r1', '/r2', '/r3'] });
    state.manual = true;
    for (const r of ['/r1', '/r2', '/r3']) hub.repoStatus(status(r, 'feature/x'));
    hub.setTerminals([term('a', { cwd: '/r1' }), term('b', { cwd: '/r2' }), term('c', { cwd: '/r3' })]);
    await flush();
    expect(calls).toHaveLength(2);
    waiting[0]!.resolve({ kind: 'none' });
    await flush();
    expect(calls).toHaveLength(3);
    hub.dispose();
  });

  test('cadence: every 60 s while focused, every 20 s while checks are pending, none while unfocused', async () => {
    const { hub, state, calls } = setup();
    state.answers.set('/p@feature/x', { kind: 'ok', pr: pr(7, 'passing') });
    hub.repoStatus(status('/p', 'feature/x'));
    hub.setTerminals([term('a')]);
    await flush();
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(40000);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(25000);
    expect(calls).toHaveLength(2);
    // Checks pending: back every 20 s.
    state.answers.set('/p@feature/x', { kind: 'ok', pr: pr(7, 'pending') });
    await vi.advanceTimersByTimeAsync(65000);
    const afterPending = calls.length;
    await vi.advanceTimersByTimeAsync(25000);
    expect(calls.length).toBe(afterPending + 1);
    // Unfocused: nothing, however long.
    state.focused = false;
    const before = calls.length;
    await vi.advanceTimersByTimeAsync(300000);
    expect(calls.length).toBe(before);
    hub.dispose();
  });

  test('back-off: after 3 checks with the same answer, every 5 minutes; a change (or pending checks) brings back 60 s', async () => {
    const { hub, state, calls } = setup();
    state.answers.set('/p@feature/x', { kind: 'ok', pr: pr(7, 'passing') });
    hub.repoStatus(status('/p', 'feature/x'));
    hub.setTerminals([term('a')]);
    await flush();
    // First answer, then three equal ones at 60 s each.
    await vi.advanceTimersByTimeAsync(3 * 65000);
    expect(calls).toHaveLength(4);
    // Same answer three times running: the next one only after 5 minutes.
    await vi.advanceTimersByTimeAsync(240000);
    expect(calls).toHaveLength(4);
    await vi.advanceTimersByTimeAsync(65000);
    expect(calls).toHaveLength(5);
    // The PR changed: back to 60 s.
    state.answers.set('/p@feature/x', { kind: 'ok', pr: pr(8, 'passing') });
    await vi.advanceTimersByTimeAsync(300000);
    const changed = calls.length;
    await vi.advanceTimersByTimeAsync(65000);
    expect(calls.length).toBe(changed + 1);
    hub.dispose();
  });

  test('back-off ends when the branch moves (a push, a new commit): the next check is back within 60 s', async () => {
    const { hub, state, calls } = setup();
    hub.repoStatus(status('/p', 'feature/x'));
    hub.setTerminals([term('a')]);
    await flush();
    await vi.advanceTimersByTimeAsync(3 * 65000);
    const rested = calls.length;
    // Pushed: the branch is no longer ahead (and its oid moved).
    hub.repoStatus({ ...status('/p', 'feature/x'), oid: 'y', ahead: 0 });
    await vi.advanceTimersByTimeAsync(65000);
    expect(calls.length).toBe(rested + 1);
    void state;
    hub.dispose();
  });

  test('pending checks win over the rest pace; gh errors (offline) do not count as the same answer', async () => {
    const { hub, state, calls } = setup();
    state.answers.set('/p@feature/x', { kind: 'error' });
    hub.repoStatus(status('/p', 'feature/x'));
    hub.setTerminals([term('a')]);
    await flush();
    await vi.advanceTimersByTimeAsync(4 * 65000);
    // Five errors in a row: still every 60 s.
    expect(calls).toHaveLength(5);
    state.answers.set('/p@feature/x', { kind: 'ok', pr: pr(7, 'passing') });
    await vi.advanceTimersByTimeAsync(4 * 65000);
    const rested = calls.length;
    state.answers.set('/p@feature/x', { kind: 'ok', pr: pr(7, 'pending') });
    // The rest pace's next check (5 min after the last one) brings the pending checks.
    await vi.advanceTimersByTimeAsync(265000);
    const afterPending = calls.length;
    expect(afterPending).toBe(rested + 1);
    await vi.advanceTimersByTimeAsync(25000);
    expect(calls.length).toBe(afterPending + 1);
    hub.dispose();
  });

  test('focus refreshes only results older than 30 s', async () => {
    const { hub, calls } = setup();
    hub.repoStatus(status('/p', 'feature/x'));
    hub.setTerminals([term('a')]);
    await flush();
    await vi.advanceTimersByTimeAsync(10000);
    hub.refresh();
    await flush();
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(25000);
    hub.refresh();
    await flush();
    expect(calls).toHaveLength(2);
    hub.dispose();
  });

  test('a branch change asks gh at once for the new branch', async () => {
    const { hub, calls } = setup();
    hub.repoStatus(status('/p', 'feature/x'));
    hub.setTerminals([term('a')]);
    await flush();
    hub.repoStatus(status('/p', 'feature/z'));
    await flush();
    expect(calls).toEqual(['/p@feature/x', '/p@feature/z']);
    hub.dispose();
  });

  test('statuses: no PR → none; gh missing / not logged in → that status for the entry and globally; other errors keep the last result', async () => {
    const { hub, state, win } = setup();
    const p = win(1, '/p');
    hub.repoStatus(status('/p', 'feature/x'));
    hub.setTerminals([term('a')]);
    await flush();
    expect(p.at(-1)).toEqual({ gh: 'ok', terminals: { a: { root: '/p', branch: 'feature/x', status: 'none' } } });

    state.answers.set('/p@feature/x', { kind: 'ok', pr: pr(7) });
    await vi.advanceTimersByTimeAsync(61000);
    expect(p.at(-1)!.terminals.a).toMatchObject({ status: 'ok', pr: { number: 7 } });

    state.answers.set('/p@feature/x', { kind: 'error' });
    await vi.advanceTimersByTimeAsync(61000);
    expect(hub.stateOf('/p')).toEqual({ gh: 'ok', terminals: { a: { root: '/p', branch: 'feature/x', status: 'ok', pr: pr(7) } } });

    state.answers.set('/p@feature/x', { kind: 'auth' });
    await vi.advanceTimersByTimeAsync(61000);
    expect(hub.stateOf('/p')).toEqual({ gh: 'auth', terminals: { a: { root: '/p', branch: 'feature/x', status: 'auth' } } });

    state.answers.set('/p@feature/x', { kind: 'missing' });
    await vi.advanceTimersByTimeAsync(61000);
    expect(hub.stateOf('/p').gh).toBe('missing');
    hub.dispose();
  });

  test('an error with no earlier result shows nothing', async () => {
    const { hub, state } = setup();
    state.answers.set('/p@feature/x', { kind: 'error' });
    hub.repoStatus(status('/p', 'feature/x'));
    hub.setTerminals([term('a')]);
    await flush();
    expect(hub.stateOf('/p')).toEqual({ gh: 'unknown', terminals: {} });
    hub.dispose();
  });

  test('setting off: gh never runs and every window is cleared; on again: asks at once', async () => {
    const { hub, state, calls, win } = setup();
    state.answers.set('/p@feature/x', { kind: 'ok', pr: pr(7) });
    const p = win(1, '/p');
    hub.repoStatus(status('/p', 'feature/x'));
    hub.setTerminals([term('a')]);
    await flush();
    state.enabled = false;
    hub.settingsChanged();
    expect(p.at(-1)!.terminals).toEqual({});
    await vi.advanceTimersByTimeAsync(300000);
    hub.refresh();
    hub.setTerminals([term('a'), term('b')]);
    hub.repoStatus(status('/p', 'feature/other'));
    await flush();
    expect(calls).toEqual(['/p@feature/x']);
    state.enabled = true;
    hub.settingsChanged();
    await flush();
    expect(calls).toEqual(['/p@feature/x', '/p@feature/other']);
    hub.dispose();
  });

  test('a result arriving after the setting went off is dropped', async () => {
    const { hub, state, waiting } = setup();
    state.manual = true;
    hub.repoStatus(status('/p', 'feature/x'));
    hub.setTerminals([term('a')]);
    await flush();
    state.enabled = false;
    hub.settingsChanged();
    waiting[0]!.resolve({ kind: 'ok', pr: pr(7) });
    await flush();
    expect(hub.stateOf('/p').terminals).toEqual({});
    hub.dispose();
  });

  test('minor 1: a reopened project window gets its PR chips back on focus / the next tick, without a branch change', async () => {
    let open = true;
    const { hub, state, calls, win } = setup({ reposOf: (project) => (project === '/p' && open ? ['/p'] : []) });
    state.answers.set('/p@feature/x', { kind: 'ok', pr: pr(7) });
    hub.repoStatus(status('/p', 'feature/x'));
    hub.setTerminals([term('a')]);
    await flush();
    expect(calls).toHaveLength(1);
    // The window closes (git-hub forgets its repos): the next list drops the entry.
    open = false;
    hub.setTerminals([term('a')]);
    expect(hub.stateOf('/p').terminals).toEqual({});
    // Reopened: the repo comes back on the same branch (repoStatus sees no change), the window gains focus.
    open = true;
    hub.repoStatus(status('/p', 'feature/x'));
    const p = win(1, '/p');
    hub.refresh();
    await flush();
    expect(calls).toHaveLength(2);
    expect(p.at(-1)!.terminals.a).toMatchObject({ status: 'ok', pr: { number: 7 } });
    hub.dispose();
  });

  test('minor 1: the tick alone also brings a reopened window\'s entries back', async () => {
    let open = true;
    const { hub, calls } = setup({ reposOf: (project) => (project === '/p' && open ? ['/p'] : []) });
    hub.repoStatus(status('/p', 'feature/x'));
    hub.setTerminals([term('a')]);
    await flush();
    open = false;
    hub.setTerminals([term('a')]);
    open = true;
    await vi.advanceTimersByTimeAsync(6000);
    expect(calls).toHaveLength(2);
    expect(hub.stateOf('/p').terminals.a?.status).toBe('none');
    hub.dispose();
  });

  test('open target: only an ok PR of a session of this project; checks → the checks page', async () => {
    const { hub, state } = setup();
    state.answers.set('/p@feature/x', { kind: 'ok', pr: pr(7) });
    hub.repoStatus(status('/p', 'feature/x'));
    hub.setTerminals([term('a')]);
    await flush();
    expect(hub.openTarget('/p', '/p', 'feature/x', false)).toBe('https://github.com/o/r/pull/7');
    expect(hub.openTarget('/p', '/p', 'feature/x', true)).toBe('https://github.com/o/r/pull/7/checks');
    expect(hub.openTarget('/q', '/p', 'feature/x', false)).toBeNull();
    expect(hub.openTarget('/p', '/p', 'feature/y', false)).toBeNull();
    hub.dispose();
  });
});
