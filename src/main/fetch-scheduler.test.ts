import { describe, expect, test } from 'vitest';
import type { FetchResult } from './git/fetch';
import type { ScmFetchState } from '@shared/scm';
import type { AutoFetch } from '@shared/settings';
import { FetchScheduler, VIEW_GATE_MS, type FetchRepo } from './fetch-scheduler';
import { WriteQueue } from './git/write-queue';

const MIN = 60_000;

/**
 * The write queue as the scheduler sees it, with a bound: a fetch that retakes its slot in a loop without waiting for
 * the writes would spin on microtasks (no timer ever fires, the test would hang), so past 1000 checks it fails instead.
 */
function guarded(q: WriteQueue): { busy(common: string): boolean; idle(common: string): Promise<void> } {
  let checks = 0;
  return {
    busy: (common) => {
      if (++checks > 1000) throw new Error('fetch scheduler spins on a busy common dir');
      return q.busy(common);
    },
    idle: (common) => q.idle(common)
  };
}

/** A fake world: a clock, fetches that finish when the test says, FETCH_HEAD times, remotes, the setting. */
function world(o: { setting?: AutoFetch; remotes?: string[]; repos?: FetchRepo[]; writes?: WriteQueue } = {}) {
  const w = {
    now: 100 * 24 * 60 * MIN,
    setting: (o.setting ?? 'viewing') as AutoFetch,
    online: true,
    fetched: new Map<string, number | null>(),
    remotes: new Set(o.remotes ?? ['/a', '/b', '/c', '/d']),
    unsafe: new Set<string>(),
    remoteChecks: 0,
    allowChecks: 0,
    repos: o.repos ?? [] as FetchRepo[],
    runs: [] as { root: string; finish: (r: FetchResult) => void }[],
    states: [] as ScmFetchState[]
  };
  const s = new FetchScheduler({
    now: () => w.now,
    run: (root, common) => {
      const fetch = () => new Promise<FetchResult>((finish) => { w.runs.push({ root, finish }); });
      // As ScmHub wires it: the fetch goes through the write queue of its common dir.
      return o.writes ? o.writes.run(common, fetch, 'fetch') : fetch();
    },
    ...(o.writes ? { writes: guarded(o.writes) } : {}),
    fetchedAt: async (common) => w.fetched.get(common) ?? null,
    hasRemote: async (root) => { w.remoteChecks++; return w.remotes.has(root); },
    autoAllowed: async (root) => { w.allowChecks++; return !w.unsafe.has(root); },
    setting: () => w.setting,
    online: () => w.online,
    repos: async () => w.repos,
    emit: (st) => { w.states.push(st); }
  });
  return { w, s };
}

const repo = (root: string, common = `${root}/.git`): FetchRepo => ({ root, common });
const flush = () => new Promise((r) => setTimeout(r, 0));
const A = repo('/a');

async function finishLast(w: ReturnType<typeof world>['w'], r: FetchResult) {
  await flush();
  w.runs.at(-1)!.finish(r);
  await flush();
}

describe('view fetches', () => {
  test('a never-fetched repo fetches; the answer carries the outcome and the shown state', async () => {
    const { w, s } = world();
    const p = s.request(A, 'view');
    await finishLast(w, { outcome: 'ok' });
    const a = await p;
    expect(a.outcome).toBe('ok');
    expect(a.state).toMatchObject({ common: '/a/.git', running: false, last: { outcome: 'ok', at: w.now } });
    expect(w.states.map((x) => x.running)).toEqual([true, false]);
  });

  test('10 min gate on FETCH_HEAD: a fetch 9 min ago (in a terminal) skips, 10 min ago runs', async () => {
    const { w, s } = world();
    w.fetched.set('/a/.git', w.now - 9 * MIN);
    expect(await s.request(A, 'view')).toMatchObject({ outcome: null });
    expect(w.runs).toHaveLength(0);
    w.fetched.set('/a/.git', w.now - VIEW_GATE_MS);
    const p = s.request(A, 'view');
    await finishLast(w, { outcome: 'ok' });
    expect((await p).outcome).toBe('ok');
  });

  test('10 min gate on the last attempt: a failed attempt is not retried by every view', async () => {
    const { w, s } = world();
    const p = s.request(A, 'view');
    await finishLast(w, { outcome: 'network', message: 'Could not resolve host' });
    expect((await p).outcome).toBe('network');
    w.now += 5 * MIN;
    expect((await s.request(A, 'view')).outcome).toBeNull();
    w.now += 5 * MIN;
    const q = s.request(A, 'view');
    await finishLast(w, { outcome: 'ok' });
    expect((await q).outcome).toBe('ok');
  });

  test('no remote, setting off: nothing runs', async () => {
    const { w, s } = world({ remotes: [] });
    expect((await s.request(A, 'view')).outcome).toBeNull();
    w.remotes.add('/a');
    w.setting = 'off';
    expect((await s.request(A, 'view')).outcome).toBeNull();
    expect(w.runs).toHaveLength(0);
  });

  test('a repo and its worktrees share one fetch (same common dir)', async () => {
    const { w, s } = world({ remotes: ['/a', '/a/wt'] });
    const p1 = s.request(A, 'view');
    const p2 = s.request(repo('/a/wt', '/a/.git'), 'view');
    await flush();
    expect(w.runs).toHaveLength(1);
    expect((await p2).outcome).toBeNull();
    w.runs[0]!.finish({ outcome: 'ok' });
    expect((await p1).outcome).toBe('ok');
  });
});

describe('outcomes', () => {
  test('auth: shown, and blocks view fetches until a manual one succeeds', async () => {
    const { w, s } = world();
    const p = s.request(A, 'view');
    await finishLast(w, { outcome: 'auth', message: 'Authentication failed' });
    expect((await p).state?.last).toMatchObject({ outcome: 'auth', message: 'Authentication failed' });
    w.now += 24 * 60 * MIN;
    expect((await s.request(A, 'view')).outcome).toBeNull();
    expect(w.runs).toHaveLength(1);
    const m = s.request(A, 'manual');
    await finishLast(w, { outcome: 'ok' });
    expect((await m).outcome).toBe('ok');
    w.now += 11 * MIN;
    w.fetched.set('/a/.git', w.now - 11 * MIN);
    const v = s.request(A, 'view');
    await finishLast(w, { outcome: 'ok' });
    expect((await v).outcome).toBe('ok');
  });

  test('error: backoff doubles from 10 min up to 1 hour; ok resets it', async () => {
    const { w, s } = world();
    const fail = async () => { const p = s.request(A, 'view'); await finishLast(w, { outcome: 'error', message: 'boom' }); return p; };
    expect((await fail()).state?.last?.outcome).toBe('error');
    // After failure n the next attempt waits 10 min × 2^(n−1): 10, 20, 40, 60, 60.
    for (const wait of [10, 20, 40, 60, 60]) {
      w.now += (wait - 1) * MIN;
      expect((await s.request(A, 'view')).outcome, `before ${wait} min`).toBeNull();
      w.now += MIN;
      await fail();
    }
    w.now += 60 * MIN;
    const ok = s.request(A, 'view');
    await finishLast(w, { outcome: 'ok' });
    await ok;
    w.now += 10 * MIN;
    w.fetched.set('/a/.git', w.now - 10 * MIN);
    const again = s.request(A, 'view');
    await flush();
    expect(w.runs).toHaveLength(8);
    w.runs.at(-1)!.finish({ outcome: 'ok' });
    await again;
  });

  test('busy and network never replace the shown outcome; busy may retry after 60 s', async () => {
    const { w, s } = world();
    const p = s.request(A, 'view');
    await finishLast(w, { outcome: 'error', message: 'boom' });
    await p;
    w.now += 10 * MIN;
    const q = s.request(A, 'view');
    await finishLast(w, { outcome: 'busy', message: 'cannot lock ref' });
    expect((await q).state?.last).toMatchObject({ outcome: 'error', message: 'boom' });
    w.now += 59_000;
    expect((await s.request(A, 'view')).outcome).toBeNull();
    w.now += 1000;
    const r = s.request(A, 'view');
    await finishLast(w, { outcome: 'network' });
    expect((await r).state?.last).toMatchObject({ outcome: 'error' });
  });
});

describe('manual fetches', () => {
  test('run whatever the gates: setting off, fetched a minute ago, auth-blocked', async () => {
    const { w, s } = world();
    w.setting = 'off';
    w.fetched.set('/a/.git', w.now - MIN);
    const p = s.request(A, 'manual');
    await finishLast(w, { outcome: 'auth', message: 'x' });
    await p;
    const q = s.request(A, 'manual');
    await finishLast(w, { outcome: 'ok' });
    expect((await q).outcome).toBe('ok');
  });

  test('a manual request joins the fetch already running for that repo', async () => {
    const { w, s } = world();
    const v = s.request(A, 'view');
    await flush();
    const m = s.request(A, 'manual');
    await flush();
    expect(w.runs).toHaveLength(1);
    w.runs[0]!.finish({ outcome: 'ok' });
    expect((await m).outcome).toBe('ok');
    expect((await v).outcome).toBe('ok');
  });

  test('at most 2 at once app-wide; a manual request goes before waiting automatic ones', async () => {
    const { w, s } = world();
    const ps = ['/a', '/b', '/c'].map((r) => s.request(repo(r), 'view'));
    await flush();
    expect(w.runs.map((r) => r.root)).toEqual(['/a', '/b']);
    const d = s.request(repo('/d'), 'manual');
    await flush();
    expect(s.state('/d/.git').running).toBe(true);
    w.runs[0]!.finish({ outcome: 'ok' });
    await flush(); await flush();
    expect(w.runs.map((r) => r.root)).toEqual(['/a', '/b', '/d']);
    w.runs[1]!.finish({ outcome: 'ok' });
    await flush(); await flush();
    expect(w.runs.map((r) => r.root)).toEqual(['/a', '/b', '/d', '/c']);
    w.runs[2]!.finish({ outcome: 'ok' });
    w.runs[3]!.finish({ outcome: 'ok' });
    await Promise.all([...ps, d]);
  });

  test('fetchAll: every repo with a remote once (worktrees share), manual', async () => {
    const { w, s } = world({ remotes: ['/a', '/a/wt', '/b'] });
    w.setting = 'off';
    const p = s.fetchAll([A, repo('/a/wt', '/a/.git'), repo('/b'), repo('/c-no-remote')].map((r) => (r.root === '/c-no-remote' ? r : r)));
    await flush(); await flush();
    expect(w.runs.map((r) => r.root).sort()).toEqual(['/a', '/b']);
    for (const r of w.runs) r.finish({ outcome: 'ok' });
    expect((await p).sort()).toEqual(['ok', 'ok']);
  });
});

describe('periodic fetches', () => {
  test('every repo of the open projects, once per interval, only online', async () => {
    const { w, s } = world({ setting: '15m', repos: [A, repo('/a/wt', '/a/.git'), repo('/b')] });
    await s.tick();
    await flush();
    expect(w.runs.map((r) => r.root)).toEqual(['/a', '/b']);
    for (const r of w.runs) r.finish({ outcome: 'ok' });
    await flush();
    w.fetched.set('/a/.git', w.now);
    w.fetched.set('/b/.git', w.now);
    w.now += 14 * MIN;
    await s.tick(); await flush();
    expect(w.runs).toHaveLength(2);
    w.now += MIN;
    w.online = false;
    await s.tick(); await flush();
    expect(w.runs).toHaveLength(2);
    w.online = true;
    await s.tick(); await flush();
    expect(w.runs).toHaveLength(4);
    for (const r of w.runs.slice(2)) r.finish({ outcome: 'ok' });
  });

  test('"When viewing" and "Off" never fetch on their own', async () => {
    for (const setting of ['viewing', 'off'] as const) {
      const { w, s } = world({ setting, repos: [A] });
      await s.tick(); await flush();
      expect(w.runs).toHaveLength(0);
    }
  });

  test('switched off while automatic fetches wait for a slot: they never start; a manual one still does', async () => {
    const { w, s } = world();
    const ps = ['/a', '/b', '/c'].map((r) => s.request(repo(r), 'view'));
    await flush();
    const d = s.request(repo('/d'), 'manual');
    await flush();
    expect(w.runs.map((r) => r.root)).toEqual(['/a', '/b']);
    w.setting = 'off';
    s.settingsChanged();
    w.runs[0]!.finish({ outcome: 'ok' });
    w.runs[1]!.finish({ outcome: 'ok' });
    await flush(); await flush(); await flush();
    expect(w.runs.map((r) => r.root)).toEqual(['/a', '/b', '/d']);
    expect((await ps[2]!).outcome).toBeNull();
    expect(s.state('/c/.git').running).toBe(false);
    w.runs[2]!.finish({ outcome: 'ok' });
    expect((await d).outcome).toBe('ok');
  });
});

describe('review fixes', () => {
  test('I2: a repo whose config names a program is never fetched on its own, only by hand', async () => {
    const { w, s } = world({ setting: '15m', repos: [A] });
    w.unsafe.add('/a');
    expect((await s.request(A, 'view')).outcome).toBeNull();
    await s.tick(); await flush();
    expect(w.runs).toHaveLength(0);
    const m = s.request(A, 'manual');
    await finishLast(w, { outcome: 'ok' });
    expect((await m).outcome).toBe('ok');
  });

  test('M2: a manual request that joins an automatic one the gates turn down still fetches', async () => {
    const { w, s } = world();
    w.fetched.set('/a/.git', w.now - 5 * MIN);
    const v = s.request(A, 'view');
    const m = s.request(A, 'manual');
    await finishLast(w, { outcome: 'ok' });
    expect((await m).outcome).toBe('ok');
    expect((await v).outcome).toBeNull();
    expect(w.runs).toHaveLength(1);
  });

  test('M2: an automatic fetch a manual request joined is not dropped when auto-fetch goes off (first in line too)', async () => {
    const { w, s } = world();
    const ps = ['/a', '/b', '/c'].map((r) => s.request(repo(r), 'view'));
    await flush();
    const m = s.request(repo('/c'), 'manual');
    await flush();
    w.setting = 'off';
    s.settingsChanged();
    w.runs[0]!.finish({ outcome: 'ok' });
    await flush(); await flush();
    expect(w.runs.map((r) => r.root)).toEqual(['/a', '/b', '/c']);
    w.runs[1]!.finish({ outcome: 'ok' });
    w.runs[2]!.finish({ outcome: 'ok' });
    expect((await m).outcome).toBe('ok');
    await Promise.all(ps);
  });

  test('M4: a repo without a remote is asked about once per 10 minutes, not on every tick and view', async () => {
    const { w, s } = world({ setting: '15m', remotes: [], repos: [A] });
    for (let i = 0; i < 5; i++) { await s.request(A, 'view'); await s.tick(); await flush(); w.now += MIN; }
    expect(w.remoteChecks).toBe(1);
    w.now += 6 * MIN;
    await s.request(A, 'view');
    expect(w.remoteChecks).toBe(2);
  });

  // Changes asks for every repo on every window focus: a repo whose config names
  // a program would cost `git remote` and `git config` each time.
  test('a repo whose config names a program is checked once per 10 minutes, not on every view; by hand it still fetches', async () => {
    const { w, s } = world({ setting: '15m', repos: [A] });
    w.unsafe.add('/a');
    for (let i = 0; i < 5; i++) { expect((await s.request(A, 'view')).outcome).toBeNull(); await s.tick(); await flush(); w.now += MIN; }
    expect([w.remoteChecks, w.allowChecks]).toEqual([1, 1]);
    w.now += 6 * MIN;
    await s.request(A, 'view');
    expect([w.remoteChecks, w.allowChecks]).toEqual([2, 2]);
    expect(w.runs).toHaveLength(0);
    const m = s.request(A, 'manual');
    await finishLast(w, { outcome: 'ok' });
    expect((await m).outcome).toBe('ok');
  });

  test('M5: a fetch that worked elsewhere (a terminal) after an auth failure lifts the block', async () => {
    const { w, s } = world();
    const p = s.request(A, 'view');
    await finishLast(w, { outcome: 'auth', message: 'x' });
    await p;
    w.now += 11 * MIN;
    expect((await s.request(A, 'view')).outcome).toBeNull();
    w.fetched.set('/a/.git', w.now - 10 * MIN);
    w.now += 1;
    const q = s.request(A, 'view');
    await finishLast(w, { outcome: 'ok' });
    expect((await q).outcome).toBe('ok');
  });

  test('M6: busy never shortens an error backoff', async () => {
    const { w, s } = world();
    for (const wait of [0, 10, 20]) {
      w.now += wait * MIN;
      const p = s.request(A, 'view');
      await finishLast(w, { outcome: 'error', message: 'boom' });
      await p;
    }
    // Third failure: 40 minutes. A manual try now hits a lock.
    const m = s.request(A, 'manual');
    await finishLast(w, { outcome: 'busy' });
    await m;
    w.now += 15 * MIN;
    expect((await s.request(A, 'view')).outcome).toBeNull();
    w.now += 25 * MIN;
    const v = s.request(A, 'view');
    await finishLast(w, { outcome: 'ok' });
    expect((await v).outcome).toBe('ok');
  });

  test('a dependency that throws never leaks a slot', async () => {
    const { w, s } = world();
    (s as unknown as { deps: { fetchedAt: () => Promise<number> } }).deps.fetchedAt = async () => { throw new Error('stat'); };
    const ps = ['/a', '/b', '/c'].map((r) => s.request(repo(r), 'view'));
    await flush(); await flush();
    expect(w.runs.map((r) => r.root)).toEqual(['/a', '/b']);
    for (const r of w.runs) r.finish({ outcome: 'ok' });
    await flush(); await flush();
    w.runs[2]!.finish({ outcome: 'ok' });
    await Promise.all(ps);
  });
});

describe('behind writes', () => {
  /** A write on that common dir that runs until the test ends it. */
  function hold(q: WriteQueue, common: string): () => void {
    let done!: () => void;
    void q.run(common, () => new Promise<void>((r) => { done = r; }));
    return () => done();
  }

  test('a fetch waiting behind a write holds no slot: with writes on two common dirs, a third repo fetches at once', async () => {
    const q = new WriteQueue();
    const { w, s } = world({ writes: q });
    const endA = hold(q, '/a/.git');
    const endB = hold(q, '/b/.git');
    const pa = s.request(A, 'manual');
    const pb = s.request(repo('/b'), 'manual');
    const pc = s.request(repo('/c'), 'manual');
    await flush(); await flush();
    expect(w.runs.map((r) => r.root)).toEqual(['/c']);
    // Still shown as running: it is asked and waits for its turn.
    expect(s.state('/a/.git').running).toBe(true);
    endA();
    await flush(); await flush();
    expect(w.runs.map((r) => r.root)).toEqual(['/c', '/a']);
    endB();
    await flush(); await flush();
    // Two app-wide: /b waits for a slot now that its write is done.
    expect(w.runs.map((r) => r.root)).toEqual(['/c', '/a']);
    w.runs[0]!.finish({ outcome: 'ok' });
    await flush(); await flush();
    expect(w.runs.map((r) => r.root)).toEqual(['/c', '/a', '/b']);
    w.runs[1]!.finish({ outcome: 'ok' });
    w.runs[2]!.finish({ outcome: 'ok' });
    expect((await Promise.all([pa, pb, pc])).map((x) => x.outcome)).toEqual(['ok', 'ok', 'ok']);
  });

  test('a write asked while a fetch waits for a slot: the slot it gets goes to the next fetch until the write ends', async () => {
    const q = new WriteQueue();
    const { w, s } = world({ writes: q });
    const ps = ['/c', '/d', '/a'].map((r) => s.request(repo(r), 'manual'));
    await flush(); await flush();
    expect(w.runs.map((r) => r.root)).toEqual(['/c', '/d']);
    const endA = hold(q, '/a/.git');
    const pe = s.request(repo('/e'), 'manual');
    await flush();
    w.runs[0]!.finish({ outcome: 'ok' });
    await flush(); await flush();
    expect(w.runs.map((r) => r.root)).toEqual(['/c', '/d', '/e']);
    endA();
    await flush(); await flush();
    expect(w.runs.map((r) => r.root)).toEqual(['/c', '/d', '/e']);
    w.runs[1]!.finish({ outcome: 'ok' });
    await flush(); await flush();
    expect(w.runs.map((r) => r.root)).toEqual(['/c', '/d', '/e', '/a']);
    w.runs[2]!.finish({ outcome: 'ok' });
    w.runs[3]!.finish({ outcome: 'ok' });
    expect((await Promise.all([...ps, pe])).map((x) => x.outcome)).toEqual(['ok', 'ok', 'ok', 'ok']);
  });
});
